import { defaultBikeBridgeStorage, loadBikeBridgeSettings, parseBikeBridgeBaseUrl, saveBikeBridgeSettings, } from "./bikeBridgeConfig.js";
import { BIKE_BRIDGE_REQUEST_TIMEOUT_MS, createBikeBridgeClient, createDefaultBikeBridgeTransport, isBikeBridgeClientOk, isBikeBridgeUrlOk, toBridgeBrightness, toBridgeHeartRateBpm, toBridgeResistanceLevel, } from "./bikeBridgeClient.js";
import { getCurrentBpm } from "../hrMonitor.js";
export const BIKE_BRIDGE_POLL_INTERVAL_MS = 1000;
function classifyReadiness(configured, status, pollKind) {
    if (!configured)
        return "not_configured";
    if (pollKind === null)
        return "not_configured";
    if (pollKind === "malformed")
        return "invalid_response";
    if (!status)
        return "unreachable";
    if (!status.connected)
        return "reachable_disconnected";
    if (!status.initialized)
        return "reachable_not_initialized";
    if (status.resistanceControlAvailable)
        return "control_ready";
    return "telemetry_ready";
}
function formatMetric(value) {
    return value === undefined ? null : value;
}
export function createBikeBridgeSession(options = {}) {
    var _a, _b, _c, _d, _e, _f;
    const storage = (_a = options.storage) !== null && _a !== void 0 ? _a : defaultBikeBridgeStorage();
    const timeoutMs = (_b = options.requestTimeoutMs) !== null && _b !== void 0 ? _b : BIKE_BRIDGE_REQUEST_TIMEOUT_MS;
    const pollIntervalMs = (_c = options.pollIntervalMs) !== null && _c !== void 0 ? _c : BIKE_BRIDGE_POLL_INTERVAL_MS;
    const now = (_d = options.now) !== null && _d !== void 0 ? _d : Date.now;
    const readBpm = (_e = options.getCurrentBpm) !== null && _e !== void 0 ? _e : getCurrentBpm;
    const postedBodies = [];
    const baseTransport = (_f = options.transport) !== null && _f !== void 0 ? _f : createDefaultBikeBridgeTransport();
    const transport = {
        async request(request) {
            if (request.method === "POST" &&
                request.jsonBody !== undefined &&
                typeof request.url === "string" &&
                request.url.includes("/api/v1/resistance")) {
                postedBodies.push(JSON.stringify(request.jsonBody));
            }
            return baseTransport.request(request);
        },
    };
    const client = createBikeBridgeClient(() => loadBikeBridgeSettings(storage).baseUrl, transport, timeoutMs);
    let timer;
    let pollInFlight = false;
    let sendInFlight = false;
    let pendingLevel;
    // Logical decision identity: one per recommendation change; re-sends reuse it.
    const decisionEpoch = Math.max(0, Math.floor(now())).toString(36);
    let decisionSeq = 0;
    let desiredDecision;
    let pendingTrigger = "decision";
    let actuationObserver = null;
    let guidanceWorkout;
    let lastAccepted;
    let holdFailedLevel;
    let needsReconcile = false;
    let desiredResistance;
    let commandedResistance;
    let workoutActive = false;
    let paused = false;
    let lastStatus = null;
    let lastTelemetry = null;
    let lastTelemetryReceivedAtMs = null;
    let telemetryStale = false;
    let lastError = null;
    let lastPollKind = null;
    let lastCommandOutcome = null;
    let previousControlAvailable = false;
    const listeners = new Set();
    function notify() {
        listeners.forEach((listener) => listener());
    }
    function settings() {
        return loadBikeBridgeSettings(storage);
    }
    function configured() {
        return parseBikeBridgeBaseUrl(settings().baseUrl).ok;
    }
    function controlAvailable() {
        return (lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.resistanceControlAvailable) === true;
    }
    function canCommand() {
        return (configured() &&
            settings().automaticControlEnabled &&
            workoutActive &&
            !paused &&
            controlAvailable());
    }
    function requestedForView() {
        var _a;
        if (lastStatus && lastStatus.resistance.requested !== null)
            return lastStatus.resistance.requested;
        if (lastCommandOutcome === "accepted" && lastAccepted !== undefined)
            return lastAccepted;
        return (_a = lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.resistance.requested) !== null && _a !== void 0 ? _a : null;
    }
    function viewState() {
        var _a;
        const current = settings();
        const readiness = classifyReadiness(configured(), lastStatus, lastPollKind);
        return {
            readiness,
            configuredUrl: current.baseUrl,
            automaticControlEnabled: current.automaticControlEnabled,
            consoleBrightness: current.consoleBrightness,
            controlAvailable: controlAvailable(),
            desiredResistance,
            commandedResistance,
            requestedResistance: requestedForView(),
            observedResistance: formatMetric(lastTelemetry === null || lastTelemetry === void 0 ? void 0 : lastTelemetry.resistance.value),
            observedResistanceCurrent: (lastTelemetry === null || lastTelemetry === void 0 ? void 0 : lastTelemetry.resistance.current) === true,
            rpm: formatMetric(lastTelemetry === null || lastTelemetry === void 0 ? void 0 : lastTelemetry.rpm.value),
            rpmCurrent: (lastTelemetry === null || lastTelemetry === void 0 ? void 0 : lastTelemetry.rpm.current) === true,
            watts: formatMetric(lastTelemetry === null || lastTelemetry === void 0 ? void 0 : lastTelemetry.watts.value),
            wattsCurrent: (lastTelemetry === null || lastTelemetry === void 0 ? void 0 : lastTelemetry.watts.current) === true,
            telemetrySnapshotAt: (_a = lastTelemetry === null || lastTelemetry === void 0 ? void 0 : lastTelemetry.snapshotAt) !== null && _a !== void 0 ? _a : null,
            telemetryReceivedAtMs: lastTelemetryReceivedAtMs,
            telemetryStale,
            lastError,
            lastCommandOutcome,
        };
    }
    function scheduleSend(level, force = false, trigger = "reconciliation_resend") {
        const target = level === undefined ? undefined : toBridgeResistanceLevel(level);
        if (target === undefined || !canCommand())
            return;
        if (!force && lastAccepted === target)
            return;
        if (!force && holdFailedLevel === target)
            return;
        if (sendInFlight) {
            pendingLevel = target;
            pendingTrigger = trigger;
            return;
        }
        void sendTarget(target, trigger);
    }
    function observeRequest(target, trigger) {
        var _a, _b;
        if (!actuationObserver)
            return undefined;
        try {
            return actuationObserver.requested({
                decisionId: (_a = desiredDecision === null || desiredDecision === void 0 ? void 0 : desiredDecision.id) !== null && _a !== void 0 ? _a : decisionEpoch + "-0",
                origin: (_b = desiredDecision === null || desiredDecision === void 0 ? void 0 : desiredDecision.origin) !== null && _b !== void 0 ? _b : "unclassified",
                trigger,
                requestedResistance: target,
                observedAtMs: now(),
                ...(guidanceWorkout ? { workout: { ...guidanceWorkout } } : {}),
            });
        }
        catch {
            return undefined;
        }
    }
    function observeOutcome(token, outcome) {
        if (!actuationObserver || token === undefined)
            return;
        try {
            actuationObserver.resolved(token, outcome);
        }
        catch {
            // Provenance capture must never affect resistance commands.
        }
    }
    async function sendTarget(target, trigger) {
        if (sendInFlight) {
            pendingLevel = target;
            pendingTrigger = trigger;
            return;
        }
        sendInFlight = true;
        pendingLevel = undefined;
        commandedResistance = target;
        const token = observeRequest(target, trigger);
        let outcome = "failed";
        try {
            const result = await client.setResistance(target);
            if (isBikeBridgeClientOk(result)) {
                lastAccepted = result.value.requested;
                holdFailedLevel = undefined;
                lastCommandOutcome = "accepted";
                outcome = "accepted";
                lastError = null;
                if (lastStatus) {
                    lastStatus = {
                        ...lastStatus,
                        resistance: {
                            ...lastStatus.resistance,
                            requested: result.value.requested,
                        },
                    };
                }
            }
            else if (result.kind === "timeout") {
                lastCommandOutcome = "timeout";
                outcome = "timeout";
                lastError = "resistance command timed out";
                holdFailedLevel = target;
            }
            else if (result.status === 503 || result.kind === "unreachable") {
                lastCommandOutcome = "unavailable";
                outcome = "unavailable";
                lastError = result.message;
                holdFailedLevel = target;
            }
            else {
                lastCommandOutcome = "failed";
                lastError = result.message;
                holdFailedLevel = target;
            }
        }
        finally {
            sendInFlight = false;
            observeOutcome(token, outcome);
            notify();
            if (pendingLevel !== undefined) {
                const next = pendingLevel;
                pendingLevel = undefined;
                scheduleSend(next, false, pendingTrigger);
            }
        }
    }
    async function mirrorHeartRate() {
        // Presentation-only: never touches lastError, resistance, guidance, or poll kind.
        if (!configured())
            return;
        const raw = readBpm();
        if (raw === null || raw === undefined)
            return;
        const bpm = toBridgeHeartRateBpm(raw);
        if (bpm === undefined)
            return;
        try {
            await client.postHeartRate(bpm);
        }
        catch {
            // ignore
        }
    }
    async function pushConsoleBrightness(value) {
        const level = toBridgeBrightness(value !== null && value !== void 0 ? value : settings().consoleBrightness);
        if (level === undefined) {
            return { ok: false, kind: "malformed", message: "value must be an integer from 0 to 100" };
        }
        if (!configured()) {
            return { ok: false, kind: "not_configured", message: "missing url" };
        }
        try {
            return await client.setBrightness(level);
        }
        catch {
            return { ok: false, kind: "unreachable", message: "unreachable" };
        }
    }
    async function tick() {
        if (pollInFlight)
            return;
        if (!configured()) {
            lastPollKind = "not_configured";
            lastStatus = null;
            notify();
            return;
        }
        pollInFlight = true;
        try {
            const previousKind = lastPollKind;
            const statusResult = await client.getStatus();
            if (isBikeBridgeClientOk(statusResult)) {
                lastStatus = statusResult.value;
                lastPollKind = "ok";
                if (statusResult.value.resistanceControlAvailable && lastCommandOutcome === "accepted") {
                    lastError = null;
                }
            }
            else {
                lastPollKind = statusResult.kind === "not_configured" ? "not_configured" : statusResult.kind;
                lastStatus = null;
                lastError = statusResult.message;
            }
            const telemetryResult = await client.getTelemetry();
            if (isBikeBridgeClientOk(telemetryResult)) {
                lastTelemetry = telemetryResult.value;
                lastTelemetryReceivedAtMs = now();
                telemetryStale = false;
            }
            else if (lastTelemetry) {
                telemetryStale = true;
                if (!isBikeBridgeClientOk(statusResult))
                    lastError = telemetryResult.message;
            }
            else {
                telemetryStale = true;
                if (!isBikeBridgeClientOk(statusResult))
                    lastError = telemetryResult.message;
            }
            const available = controlAvailable();
            if (isBikeBridgeClientOk(statusResult) && available) {
                const recoveredFromLoss = previousKind === "unreachable" ||
                    previousKind === "timeout" ||
                    previousKind === "http_error" ||
                    previousKind === "malformed";
                const controlAppeared = !previousControlAvailable && previousKind === "ok";
                const target = desiredResistance === undefined ? undefined : toBridgeResistanceLevel(desiredResistance);
                if ((recoveredFromLoss || controlAppeared) && target !== undefined && lastAccepted !== target) {
                    needsReconcile = true;
                }
            }
            previousControlAvailable = available;
            if (needsReconcile && canCommand()) {
                needsReconcile = false;
                holdFailedLevel = undefined;
                scheduleSend(desiredResistance, true);
            }
        }
        finally {
            pollInFlight = false;
            void mirrorHeartRate();
            notify();
        }
    }
    return {
        start() {
            if (timer !== undefined)
                return;
            timer = setInterval(() => {
                void tick();
            }, pollIntervalMs);
            void tick();
        },
        stop() {
            if (timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
        },
        isPolling() {
            return timer !== undefined;
        },
        getViewState() {
            return viewState();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        configure(partial) {
            const current = settings();
            let baseUrl = current.baseUrl;
            const nextBrightness = partial.consoleBrightness !== undefined ? partial.consoleBrightness : current.consoleBrightness;
            if (partial.baseUrl !== undefined) {
                const trimmed = partial.baseUrl.trim();
                if (!trimmed) {
                    saveBikeBridgeSettings({
                        baseUrl: "",
                        automaticControlEnabled: partial.automaticControlEnabled !== undefined
                            ? partial.automaticControlEnabled
                            : current.automaticControlEnabled,
                        consoleBrightness: nextBrightness,
                    }, storage);
                    lastStatus = null;
                    lastTelemetry = null;
                    lastTelemetryReceivedAtMs = null;
                    lastPollKind = "not_configured";
                    lastError = null;
                    notify();
                    return { ok: true };
                }
                const parsed = parseBikeBridgeBaseUrl(partial.baseUrl);
                if (!isBikeBridgeUrlOk(parsed))
                    return { ok: false, error: parsed.error };
                baseUrl = parsed.normalized;
            }
            const nextEnabled = partial.automaticControlEnabled !== undefined
                ? partial.automaticControlEnabled
                : current.automaticControlEnabled;
            const enabledChanged = nextEnabled !== current.automaticControlEnabled;
            const urlChanged = baseUrl !== current.baseUrl;
            if (urlChanged) {
                lastStatus = null;
                lastTelemetry = null;
                lastTelemetryReceivedAtMs = null;
                lastAccepted = undefined;
                holdFailedLevel = undefined;
                telemetryStale = false;
                lastPollKind = null;
                lastError = null;
            }
            saveBikeBridgeSettings({
                baseUrl,
                automaticControlEnabled: nextEnabled,
                consoleBrightness: nextBrightness,
            }, storage);
            if (enabledChanged && !nextEnabled)
                pendingLevel = undefined;
            if (enabledChanged && nextEnabled) {
                holdFailedLevel = undefined;
                needsReconcile = true;
                scheduleSend(desiredResistance, true);
            }
            notify();
            return { ok: true };
        },
        async setConsoleBrightness(value) {
            const level = toBridgeBrightness(value);
            if (level === undefined) {
                return {
                    ok: false,
                    kind: "malformed",
                    message: "value must be an integer from 0 to 100",
                };
            }
            const current = settings();
            saveBikeBridgeSettings({
                baseUrl: current.baseUrl,
                automaticControlEnabled: current.automaticControlEnabled,
                consoleBrightness: level,
            }, storage);
            notify();
            return pushConsoleBrightness(level);
        },
        onGuidance(input) {
            var _a;
            const wasActive = workoutActive;
            const wasPaused = paused;
            workoutActive = input.workoutActive;
            paused = input.paused;
            desiredResistance = input.desiredResistance;
            if (input.workoutActive)
                guidanceWorkout = input.workout ? { ...input.workout } : undefined;
            if (input.workoutActive && input.recommendationChanged) {
                decisionSeq += 1;
                desiredDecision = { id: decisionEpoch + "-" + decisionSeq, origin: (_a = input.actuationOrigin) !== null && _a !== void 0 ? _a : "unclassified" };
            }
            if (!input.workoutActive) {
                pendingLevel = undefined;
                lastAccepted = undefined;
                holdFailedLevel = undefined;
                needsReconcile = false;
                commandedResistance = undefined;
                notify();
                return;
            }
            if (!wasActive) {
                lastAccepted = undefined;
                holdFailedLevel = undefined;
                needsReconcile = true;
            }
            if (input.paused) {
                pendingLevel = undefined;
                notify();
                return;
            }
            if (wasPaused) {
                holdFailedLevel = undefined;
                needsReconcile = false;
                scheduleSend(input.desiredResistance, true);
                notify();
                return;
            }
            if (input.recommendationChanged) {
                holdFailedLevel = undefined;
                needsReconcile = false;
                scheduleSend(input.desiredResistance, true, "decision");
            }
            else if (needsReconcile) {
                holdFailedLevel = undefined;
                needsReconcile = false;
                scheduleSend(input.desiredResistance, true);
            }
            notify();
        },
        postedResistanceBodies() {
            return [...postedBodies];
        },
        setActuationObserver(observer) {
            actuationObserver = observer;
        },
    };
}
let appSession;
export function getBikeBridgeSession() {
    if (!appSession)
        appSession = createBikeBridgeSession();
    return appSession;
}
export function startBikeBridgeRuntime() {
    getBikeBridgeSession().start();
}
export function formatBikeBridgeNumber(value) {
    return value === null || value === undefined ? "-" : String(value);
}
export function formatBikeBridgeReadiness(readiness) {
    switch (readiness) {
        case "not_configured":
            return "Not configured";
        case "unreachable":
            return "Unreachable";
        case "reachable_disconnected":
            return "Bike disconnected";
        case "reachable_not_initialized":
            return "Bike not initialized";
        case "telemetry_ready":
            return "Connected";
        case "control_ready":
            return "Connected";
        case "invalid_response":
            return "Invalid response";
        default:
            return "Unreachable";
    }
}
export function formatBikeBridgeControl(state) {
    if (!state.automaticControlEnabled)
        return "Disabled";
    return state.controlAvailable ? "Ready" : "Unavailable";
}
