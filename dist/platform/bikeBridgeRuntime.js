import { defaultBikeBridgeStorage, loadBikeBridgeSettings, NATIVE_PROFORM_BRIDGE_ORIGIN, parseBikeBridgeBaseUrl, parseBikeBridgePairingToken, saveBikeBridgeSettings, } from "./bikeBridgeConfig.js";
import { isSessionControlMode } from "../sessionControlMode.js";
import { BIKE_BRIDGE_PAIRING_REQUIRED_MESSAGE, BIKE_BRIDGE_REQUEST_TIMEOUT_MS, createBikeBridgeClient, createDefaultBikeBridgeTransport, isBikeBridgeClientOk, isBikeBridgeUrlOk, toBridgeBrightness, toBridgeHeartRateBpm, toBridgeResistanceLevel, } from "./bikeBridgeClient.js";
import { getCurrentBpm, onBpm } from "../hrMonitor.js";
export const BIKE_BRIDGE_POLL_INTERVAL_MS = 1000;
/** Matches Native `HeartRateStore.FRESH_WINDOW_MS`. Trainer-side inferred freshness only; not observed console blanking. */
export const BRIDGE_HEART_RATE_DISPLAY_FRESH_MS = 3000;
export const FREESTYLE_RESISTANCE_LATCH_DEBOUNCE_MS = 2000;
export const FREESTYLE_HOLD_MISMATCH_CONFIRM_POLLS = 2;
export const FREESTYLE_HOLD_MIN_CORRECTION_SPACING_MS = 3000;
export const FREESTYLE_HOLD_MAX_CORRECTION_ATTEMPTS = 3;
export const FREESTYLE_HOLD_BACKOFF_MS = 5000;
export const FREESTYLE_HOLD_ACTIVE_PEDAL_RPM_MIN = 1;
export const FREESTYLE_HOLD_FAILURE_WINDOW_MS = 60000;
export const FREESTYLE_HOLD_STABLE_CLEAR_MS = 20000;
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
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
    const storage = (_a = options.storage) !== null && _a !== void 0 ? _a : defaultBikeBridgeStorage();
    const timeoutMs = (_b = options.requestTimeoutMs) !== null && _b !== void 0 ? _b : BIKE_BRIDGE_REQUEST_TIMEOUT_MS;
    const pollIntervalMs = (_c = options.pollIntervalMs) !== null && _c !== void 0 ? _c : BIKE_BRIDGE_POLL_INTERVAL_MS;
    const freestyleLatchDebounceMs = Math.max(0, (_d = options.freestyleLatchDebounceMs) !== null && _d !== void 0 ? _d : FREESTYLE_RESISTANCE_LATCH_DEBOUNCE_MS);
    const freestyleHoldMismatchConfirmPolls = Math.max(1, Math.floor((_e = options.freestyleHoldMismatchConfirmPolls) !== null && _e !== void 0 ? _e : FREESTYLE_HOLD_MISMATCH_CONFIRM_POLLS));
    const freestyleHoldMinCorrectionSpacingMs = Math.max(0, (_f = options.freestyleHoldMinCorrectionSpacingMs) !== null && _f !== void 0 ? _f : FREESTYLE_HOLD_MIN_CORRECTION_SPACING_MS);
    const freestyleHoldMaxCorrectionAttempts = Math.max(1, Math.floor((_g = options.freestyleHoldMaxCorrectionAttempts) !== null && _g !== void 0 ? _g : FREESTYLE_HOLD_MAX_CORRECTION_ATTEMPTS));
    const freestyleHoldBackoffMs = Math.max(0, (_h = options.freestyleHoldBackoffMs) !== null && _h !== void 0 ? _h : FREESTYLE_HOLD_BACKOFF_MS);
    const freestyleHoldActivePedalRpmMin = Math.max(0, (_j = options.freestyleHoldActivePedalRpmMin) !== null && _j !== void 0 ? _j : FREESTYLE_HOLD_ACTIVE_PEDAL_RPM_MIN);
    const freestyleHoldFailureWindowMs = Math.max(0, (_k = options.freestyleHoldFailureWindowMs) !== null && _k !== void 0 ? _k : FREESTYLE_HOLD_FAILURE_WINDOW_MS);
    const freestyleHoldStableClearMs = Math.max(0, (_l = options.freestyleHoldStableClearMs) !== null && _l !== void 0 ? _l : FREESTYLE_HOLD_STABLE_CLEAR_MS);
    const now = (_m = options.now) !== null && _m !== void 0 ? _m : Date.now;
    const readBpm = (_o = options.getCurrentBpm) !== null && _o !== void 0 ? _o : getCurrentBpm;
    const subscribeBpm = (_p = options.subscribeBpm) !== null && _p !== void 0 ? _p : ((listener) => onBpm(listener));
    const postedBodies = [];
    const baseTransport = (_q = options.transport) !== null && _q !== void 0 ? _q : createDefaultBikeBridgeTransport();
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
    const client = createBikeBridgeClient(() => loadBikeBridgeSettings(storage).baseUrl, transport, timeoutMs, () => loadBikeBridgeSettings(storage).pairingToken);
    let timer;
    let unsubBpm;
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
    let heartRateDelivery = "idle";
    let heartRateLastAcceptedAtMs = null;
    let heartRateLastHttpStatus = null;
    let heartRateInFlight = false;
    let pendingHeartRateBpm;
    let loggedHeartRateFailure = null;
    let previousControlAvailable = false;
    const listeners = new Set();
    let bindingState = { type: "initial_unbound" };
    // Authority generation, bumped on every effective bindSession change.
    // sendTarget captures it at dispatch; a stale completion still releases
    // the transport lock but must not touch the new session's bookkeeping.
    let bindingGeneration = 0;
    let freestyleLatchBaselineReady = false;
    let freestyleLatchBaselineLevel = null;
    let freestyleLatchCandidate;
    let freestyleLatchTimer;
    let freestyleQueued;
    let freestyleLastDispatchedLatch;
    let freestyleHoldTarget;
    let freestyleHoldReleased = false;
    let freestyleHoldSuspended = false;
    let freestyleHoldMismatchPolls = 0;
    let freestyleHoldAwaitingLevel;
    let freestyleHoldAwaitingMissPolls = 0;
    let freestyleHoldLastCorrectionAtMs;
    let freestyleHoldFailureAtMs = [];
    let freestyleHoldStableSinceMs;
    // Bumped when hold identity changes (clear/adopt/release). sendTarget captures it so a
    // deferred freestyle_hold response cannot mutate a newer hold's awaiting/failure state.
    let freestyleHoldRevision = 0;
    function notify() {
        listeners.forEach((listener) => listener());
    }
    function isFreestyleBound() {
        return bindingState.type === "bound" && bindingState.controlMode === "manual_freestyle_ride";
    }
    function clearFreestyleHoldCorrectionState() {
        freestyleHoldMismatchPolls = 0;
        freestyleHoldAwaitingLevel = undefined;
        freestyleHoldAwaitingMissPolls = 0;
        if ((freestyleQueued === null || freestyleQueued === void 0 ? void 0 : freestyleQueued.authority) === "freestyle_hold") {
            freestyleQueued = undefined;
        }
    }
    function clearFreestyleHoldFailureBudget() {
        freestyleHoldFailureAtMs = [];
        freestyleHoldStableSinceMs = undefined;
    }
    function pruneFreestyleHoldFailures(atMs) {
        if (freestyleHoldFailureWindowMs <= 0) {
            freestyleHoldFailureAtMs = [];
            return;
        }
        const cutoff = atMs - freestyleHoldFailureWindowMs;
        freestyleHoldFailureAtMs = freestyleHoldFailureAtMs.filter((stamp) => stamp >= cutoff);
    }
    function freestyleHoldFailureCount(atMs = now()) {
        pruneFreestyleHoldFailures(atMs);
        return freestyleHoldFailureAtMs.length;
    }
    function recordFreestyleHoldFailure() {
        const atMs = now();
        freestyleHoldStableSinceMs = undefined;
        freestyleHoldFailureAtMs.push(atMs);
        pruneFreestyleHoldFailures(atMs);
        if (freestyleHoldFailureAtMs.length >= freestyleHoldMaxCorrectionAttempts) {
            freestyleHoldSuspended = true;
            clearFreestyleHoldCorrectionState();
        }
    }
    function clearFreestyleHoldTarget() {
        const hadHold = freestyleHoldTarget !== undefined ||
            freestyleHoldSuspended ||
            freestyleHoldAwaitingLevel !== undefined;
        freestyleHoldTarget = undefined;
        freestyleHoldSuspended = false;
        freestyleHoldLastCorrectionAtMs = undefined;
        clearFreestyleHoldFailureBudget();
        clearFreestyleHoldCorrectionState();
        if (hadHold)
            freestyleHoldRevision += 1;
    }
    function resetFreestyleLatchState() {
        if (freestyleLatchTimer !== undefined) {
            clearTimeout(freestyleLatchTimer);
            freestyleLatchTimer = undefined;
        }
        freestyleLatchBaselineReady = false;
        freestyleLatchBaselineLevel = null;
        freestyleLatchCandidate = undefined;
        freestyleQueued = undefined;
        freestyleLastDispatchedLatch = undefined;
        freestyleHoldReleased = false;
        clearFreestyleHoldTarget();
    }
    function cancelFreestyleLatchPending() {
        if (freestyleLatchTimer !== undefined) {
            clearTimeout(freestyleLatchTimer);
            freestyleLatchTimer = undefined;
        }
        freestyleLatchCandidate = undefined;
        if ((freestyleQueued === null || freestyleQueued === void 0 ? void 0 : freestyleQueued.authority) === "freestyle_latch") {
            freestyleQueued = undefined;
        }
    }
    function canFreestyleAuthorityCommand() {
        if (!isFreestyleBound())
            return false;
        if (!configured())
            return false;
        if (!workoutActive || paused)
            return false;
        if (telemetryStale)
            return false;
        if (!(lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.connected) || !(lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.initialized))
            return false;
        if (!controlAvailable())
            return false;
        return true;
    }
    function isActivelyPedaling() {
        const rpm = lastTelemetry === null || lastTelemetry === void 0 ? void 0 : lastTelemetry.rpm;
        if (!rpm || rpm.current !== true || rpm.value === null || rpm.value === undefined)
            return false;
        return rpm.value >= freestyleHoldActivePedalRpmMin;
    }
    function freestyleHoldStatusForView() {
        if (!isFreestyleBound() || !workoutActive)
            return "inactive";
        if (freestyleHoldReleased)
            return "released";
        if (freestyleHoldSuspended)
            return "suspended";
        if (freestyleHoldTarget === undefined)
            return "inactive";
        if (paused ||
            telemetryStale ||
            !(lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.connected) ||
            !(lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.initialized) ||
            !controlAvailable()) {
            return "unavailable";
        }
        return "holding";
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
        // Explicit disarm permanently blocks until a new session is bound.
        if (bindingState.type === "disarmed")
            return false;
        // Freestyle blocks the structured guidance/reconcile command path.
        // Observed-change latching and hold restore use canFreestyleAuthorityCommand().
        if (bindingState.type === "bound" && bindingState.controlMode === "manual_freestyle_ride")
            return false;
        return configured() && workoutActive && !paused && controlAvailable();
    }
    // True when only a transient Bridge condition (not configured yet, no status yet, control not
    // yet available) blocks an otherwise authorized structured workout; a later poll may reconcile.
    function structuredAuthorityPending() {
        if (bindingState.type === "disarmed")
            return false;
        if (bindingState.type === "bound" && bindingState.controlMode === "manual_freestyle_ride")
            return false;
        return workoutActive && !paused;
    }
    function authorizationForView() {
        if (bindingState.type === "disarmed")
            return "disarmed";
        if (bindingState.type === "bound" && bindingState.controlMode === "manual_freestyle_ride")
            return "freestyle_policy";
        if (!workoutActive)
            return "no_active_workout";
        if (paused)
            return "paused";
        if (!configured())
            return "not_configured";
        if (!(lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.connected) || !(lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.initialized))
            return "bridge_unavailable";
        if (!controlAvailable())
            return "control_unavailable";
        return "authorized";
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
            consoleBrightness: current.consoleBrightness,
            pairingConfigured: current.pairingToken.length > 0,
            controlAvailable: controlAvailable(),
            desiredResistance,
            commandedResistance,
            bridgeAcceptedResistance: lastAccepted !== null && lastAccepted !== void 0 ? lastAccepted : null,
            commandAuthorization: authorizationForView(),
            commandInFlight: sendInFlight,
            pairingRequired: lastError === BIKE_BRIDGE_PAIRING_REQUIRED_MESSAGE,
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
            freestyleHoldStatus: freestyleHoldStatusForView(),
            freestyleHoldTarget: freestyleHoldTarget !== null && freestyleHoldTarget !== void 0 ? freestyleHoldTarget : null,
            heartRateDelivery,
            heartRateLastAcceptedAtMs,
            heartRateLastHttpStatus,
        };
    }
    function scheduleSend(level, force = false, trigger = "reconciliation_resend") {
        const target = level === undefined ? undefined : toBridgeResistanceLevel(level);
        if (target === undefined)
            return;
        if (!canCommand()) {
            // Remember the unsent target so the next poll that makes control available sends it once.
            if (structuredAuthorityPending())
                needsReconcile = true;
            return;
        }
        if (!force && lastAccepted === target)
            return;
        if (!force && holdFailedLevel === target)
            return;
        if (sendInFlight) {
            pendingLevel = target;
            pendingTrigger = trigger;
            return;
        }
        void sendTarget(target, trigger, "structured");
    }
    function observeRequest(target, trigger, origin, decisionId) {
        if (!actuationObserver)
            return undefined;
        try {
            return actuationObserver.requested({
                decisionId,
                origin,
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
    async function sendTarget(target, trigger, authority) {
        var _a, _b;
        if (sendInFlight) {
            if (authority === "structured") {
                pendingLevel = target;
                pendingTrigger = trigger;
            }
            else if (authority === "freestyle_latch") {
                freestyleQueued = { level: target, trigger, authority };
            }
            else if (!freestyleQueued || freestyleQueued.authority !== "freestyle_latch") {
                freestyleQueued = { level: target, trigger, authority };
            }
            return;
        }
        if (authority === "structured") {
            if (!canCommand()) {
                pendingLevel = undefined;
                return;
            }
        }
        else if (!canFreestyleAuthorityCommand()) {
            freestyleQueued = undefined;
            return;
        }
        else if (authority === "freestyle_hold") {
            if (freestyleHoldReleased || freestyleHoldSuspended || freestyleHoldTarget !== target) {
                if ((freestyleQueued === null || freestyleQueued === void 0 ? void 0 : freestyleQueued.authority) === "freestyle_hold")
                    freestyleQueued = undefined;
                return;
            }
        }
        const generation = bindingGeneration;
        const holdRevision = freestyleHoldRevision;
        const origin = authority === "freestyle_latch"
            ? "freestyle_observed_resistance_latch"
            : authority === "freestyle_hold"
                ? "freestyle_resistance_hold_restore"
                : (_a = desiredDecision === null || desiredDecision === void 0 ? void 0 : desiredDecision.origin) !== null && _a !== void 0 ? _a : "unclassified";
        const decisionId = authority === "freestyle_latch"
            ? decisionEpoch + "-fl-" + (++decisionSeq)
            : authority === "freestyle_hold"
                ? decisionEpoch + "-fh-" + (++decisionSeq)
                : (_b = desiredDecision === null || desiredDecision === void 0 ? void 0 : desiredDecision.id) !== null && _b !== void 0 ? _b : decisionEpoch + "-0";
        sendInFlight = true;
        pendingLevel = undefined;
        freestyleQueued = undefined;
        commandedResistance = target;
        if (authority === "freestyle_hold") {
            freestyleHoldLastCorrectionAtMs = now();
            freestyleHoldStableSinceMs = undefined;
        }
        const token = observeRequest(target, trigger, origin, decisionId);
        let outcome = "failed";
        try {
            const result = await client.setResistance(target);
            const holdStale = authority === "freestyle_hold" && holdRevision !== freestyleHoldRevision;
            if (generation !== bindingGeneration || holdStale) {
                if (isBikeBridgeClientOk(result))
                    outcome = "accepted";
                else if (result.kind === "timeout")
                    outcome = "timeout";
                else if (result.status === 503 || result.kind === "unreachable")
                    outcome = "unavailable";
            }
            else if (isBikeBridgeClientOk(result)) {
                lastAccepted = result.value.requested;
                holdFailedLevel = undefined;
                lastCommandOutcome = "accepted";
                outcome = "accepted";
                lastError = null;
                if (authority === "freestyle_hold") {
                    freestyleHoldAwaitingLevel = target;
                    freestyleHoldAwaitingMissPolls = 0;
                }
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
                if (authority === "freestyle_hold") {
                    freestyleHoldAwaitingLevel = undefined;
                    recordFreestyleHoldFailure();
                }
            }
            else if (result.status === 503 || result.kind === "unreachable") {
                lastCommandOutcome = "unavailable";
                outcome = "unavailable";
                lastError = result.message;
                holdFailedLevel = target;
                if (authority === "freestyle_hold") {
                    freestyleHoldAwaitingLevel = undefined;
                    recordFreestyleHoldFailure();
                }
            }
            else {
                lastCommandOutcome = "failed";
                lastError = result.message;
                holdFailedLevel = target;
                if (authority === "freestyle_hold") {
                    freestyleHoldAwaitingLevel = undefined;
                    recordFreestyleHoldFailure();
                }
            }
        }
        finally {
            sendInFlight = false;
            observeOutcome(token, outcome);
            notify();
            if (pendingLevel !== undefined && canCommand()) {
                const next = pendingLevel;
                pendingLevel = undefined;
                scheduleSend(next, false, pendingTrigger);
            }
            else {
                pendingLevel = undefined;
                if (freestyleQueued && canFreestyleAuthorityCommand()) {
                    const next = freestyleQueued;
                    freestyleQueued = undefined;
                    void sendTarget(next.level, next.trigger, next.authority);
                }
                else {
                    freestyleQueued = undefined;
                }
            }
        }
    }
    function armFreestyleLatch(level) {
        if (freestyleHoldReleased)
            return;
        clearFreestyleHoldCorrectionState();
        if (freestyleLatchTimer !== undefined) {
            clearTimeout(freestyleLatchTimer);
            freestyleLatchTimer = undefined;
        }
        freestyleLatchCandidate = level;
        freestyleLatchTimer = setTimeout(() => {
            freestyleLatchTimer = undefined;
            void dispatchFreestyleLatch(level);
        }, freestyleLatchDebounceMs);
    }
    function adoptFreestyleHoldTarget(target) {
        freestyleHoldRevision += 1;
        freestyleHoldTarget = target;
        freestyleHoldReleased = false;
        freestyleHoldSuspended = false;
        freestyleHoldLastCorrectionAtMs = undefined;
        clearFreestyleHoldFailureBudget();
        clearFreestyleHoldCorrectionState();
        freestyleLastDispatchedLatch = target;
        freestyleLatchBaselineLevel = target;
    }
    async function dispatchFreestyleLatch(level) {
        if (freestyleLatchCandidate !== level)
            return;
        freestyleLatchCandidate = undefined;
        if (freestyleHoldReleased)
            return;
        if (!canFreestyleAuthorityCommand())
            return;
        const observed = lastTelemetry === null || lastTelemetry === void 0 ? void 0 : lastTelemetry.resistance;
        if (!observed ||
            observed.current !== true ||
            observed.value === null ||
            observed.value === undefined ||
            observed.value !== level) {
            return;
        }
        const target = toBridgeResistanceLevel(level);
        if (target === undefined)
            return;
        if (freestyleLastDispatchedLatch === target && freestyleHoldTarget === target) {
            freestyleLatchBaselineLevel = target;
            return;
        }
        adoptFreestyleHoldTarget(target);
        await sendTarget(target, "observed_change_latch", "freestyle_latch");
    }
    function spacingElapsedForHoldCorrection() {
        if (freestyleHoldLastCorrectionAtMs === undefined)
            return true;
        const elapsed = now() - freestyleHoldLastCorrectionAtMs;
        const needBackoff = freestyleHoldFailureCount() > 0 && freestyleHoldAwaitingLevel === undefined;
        const required = needBackoff
            ? Math.max(freestyleHoldMinCorrectionSpacingMs, freestyleHoldBackoffMs)
            : freestyleHoldMinCorrectionSpacingMs;
        return elapsed >= required;
    }
    function maybeRestoreFreestyleHold() {
        freestyleHoldStableSinceMs = undefined;
        if (!canFreestyleAuthorityCommand())
            return;
        if (freestyleHoldReleased || freestyleHoldSuspended)
            return;
        if (freestyleHoldTarget === undefined)
            return;
        if (freestyleLatchCandidate !== undefined)
            return;
        if (!isActivelyPedaling()) {
            freestyleHoldMismatchPolls = 0;
            return;
        }
        if (freestyleHoldAwaitingLevel !== undefined) {
            freestyleHoldAwaitingMissPolls += 1;
            if (freestyleHoldAwaitingMissPolls >= freestyleHoldMismatchConfirmPolls &&
                spacingElapsedForHoldCorrection()) {
                freestyleHoldAwaitingLevel = undefined;
                freestyleHoldAwaitingMissPolls = 0;
                recordFreestyleHoldFailure();
                if (freestyleHoldSuspended)
                    return;
            }
            else {
                return;
            }
        }
        freestyleHoldMismatchPolls += 1;
        if (freestyleHoldMismatchPolls < freestyleHoldMismatchConfirmPolls)
            return;
        if (!spacingElapsedForHoldCorrection())
            return;
        if (freestyleHoldFailureCount() >= freestyleHoldMaxCorrectionAttempts) {
            freestyleHoldSuspended = true;
            clearFreestyleHoldCorrectionState();
            return;
        }
        freestyleHoldMismatchPolls = 0;
        void sendTarget(freestyleHoldTarget, "unexpected_zero_restore", "freestyle_hold");
    }
    function noteFreestyleHoldObservation(value) {
        if (freestyleHoldTarget === undefined)
            return;
        if (value !== freestyleHoldTarget) {
            freestyleHoldStableSinceMs = undefined;
            return;
        }
        freestyleHoldMismatchPolls = 0;
        if (freestyleHoldAwaitingLevel === value) {
            freestyleHoldAwaitingLevel = undefined;
            freestyleHoldAwaitingMissPolls = 0;
        }
        const atMs = now();
        if (freestyleHoldStableSinceMs === undefined) {
            freestyleHoldStableSinceMs = atMs;
            return;
        }
        if (freestyleHoldFailureAtMs.length > 0 &&
            atMs - freestyleHoldStableSinceMs >= freestyleHoldStableClearMs) {
            freestyleHoldFailureAtMs = [];
        }
    }
    function updateFreestyleLatchFromTelemetry() {
        if (!isFreestyleBound())
            return;
        if (!workoutActive || paused) {
            cancelFreestyleLatchPending();
            clearFreestyleHoldTarget();
            return;
        }
        if (!(lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.connected) || !(lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.initialized) || !controlAvailable()) {
            cancelFreestyleLatchPending();
            clearFreestyleHoldTarget();
            return;
        }
        if (telemetryStale || !lastTelemetry) {
            cancelFreestyleLatchPending();
            clearFreestyleHoldCorrectionState();
            return;
        }
        const observed = lastTelemetry.resistance;
        if (!observed || observed.current !== true || observed.value === null || observed.value === undefined) {
            cancelFreestyleLatchPending();
            clearFreestyleHoldCorrectionState();
            return;
        }
        const value = observed.value;
        if (!freestyleLatchBaselineReady) {
            freestyleLatchBaselineReady = true;
            freestyleLatchBaselineLevel = value;
            return;
        }
        if (freestyleHoldReleased) {
            cancelFreestyleLatchPending();
            if (value === 0) {
                freestyleLatchBaselineLevel = 0;
                return;
            }
            if (Number.isInteger(value) && value >= 1 && value <= 15) {
                freestyleLatchBaselineLevel = value;
            }
            return;
        }
        if (value === 0) {
            cancelFreestyleLatchPending();
            freestyleLatchBaselineLevel = 0;
            maybeRestoreFreestyleHold();
            return;
        }
        if (!Number.isInteger(value) || value < 1 || value > 15) {
            cancelFreestyleLatchPending();
            clearFreestyleHoldCorrectionState();
            return;
        }
        noteFreestyleHoldObservation(value);
        if (value === freestyleLatchBaselineLevel) {
            if (freestyleLatchCandidate === value) {
                cancelFreestyleLatchPending();
            }
            return;
        }
        if (value === freestyleHoldTarget || value === freestyleLastDispatchedLatch) {
            freestyleLatchBaselineLevel = value;
            cancelFreestyleLatchPending();
            clearFreestyleHoldCorrectionState();
            return;
        }
        if (freestyleLatchCandidate === value)
            return;
        armFreestyleLatch(value);
    }
    function noteHeartRateDelivery(next, httpStatus) {
        heartRateDelivery = next;
        heartRateLastHttpStatus = httpStatus;
        if (next === "accepted") {
            heartRateLastAcceptedAtMs = now();
            return;
        }
        if (next === "no_bpm" || next === "out_of_range" || next === "idle")
            return;
        const fingerprint = next + ":" + (httpStatus !== null && httpStatus !== void 0 ? httpStatus : "");
        if (loggedHeartRateFailure === fingerprint)
            return;
        loggedHeartRateFailure = fingerprint;
        console.warn("[bike-bridge] console heart-rate not delivered:", next, httpStatus !== null && httpStatus !== void 0 ? httpStatus : "");
    }
    async function mirrorHeartRate(sample) {
        var _a, _b, _c, _d;
        // Presentation-only: never touches lastError, resistance, guidance, or poll kind.
        if (!configured())
            return;
        const raw = sample !== undefined ? sample : readBpm();
        if (raw === null || raw === undefined) {
            noteHeartRateDelivery("no_bpm", null);
            notify();
            return;
        }
        const bpm = toBridgeHeartRateBpm(raw);
        if (bpm === undefined) {
            noteHeartRateDelivery("out_of_range", null);
            notify();
            return;
        }
        if (heartRateInFlight) {
            if (sample !== undefined)
                pendingHeartRateBpm = bpm;
            return;
        }
        heartRateInFlight = true;
        try {
            const result = await client.postHeartRate(bpm);
            if (isBikeBridgeClientOk(result)) {
                noteHeartRateDelivery("accepted", 200);
            }
            else if (result.kind === "http_error" && result.status === 401) {
                noteHeartRateDelivery("pairing_required", 401);
            }
            else if (result.kind === "http_error") {
                noteHeartRateDelivery("http_error", (_a = result.status) !== null && _a !== void 0 ? _a : null);
            }
            else if (result.kind === "timeout") {
                noteHeartRateDelivery("timeout", (_b = result.status) !== null && _b !== void 0 ? _b : null);
            }
            else if (result.kind === "malformed") {
                noteHeartRateDelivery("malformed", (_c = result.status) !== null && _c !== void 0 ? _c : null);
            }
            else {
                noteHeartRateDelivery("unreachable", (_d = result.status) !== null && _d !== void 0 ? _d : null);
            }
            notify();
        }
        catch {
            noteHeartRateDelivery("unreachable", null);
            notify();
        }
        finally {
            heartRateInFlight = false;
            const queued = pendingHeartRateBpm;
            pendingHeartRateBpm = undefined;
            if (queued !== undefined)
                void mirrorHeartRate(queued);
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
        if (!configured()) {
            lastPollKind = "not_configured";
            lastStatus = null;
            notify();
            return;
        }
        // 1 Hz HR is fire-and-forget and must not wait for sequential status/telemetry.
        void mirrorHeartRate();
        if (pollInFlight)
            return;
        pollInFlight = true;
        try {
            const previousKind = lastPollKind;
            const statusResult = await client.getStatus();
            if (isBikeBridgeClientOk(statusResult)) {
                lastStatus = statusResult.value;
                const recoveredFromPollFailure = previousKind === "unreachable" ||
                    previousKind === "timeout" ||
                    previousKind === "http_error" ||
                    previousKind === "malformed";
                lastPollKind = "ok";
                if (recoveredFromPollFailure ||
                    !statusResult.value.resistanceControlAvailable ||
                    lastCommandOutcome === "accepted") {
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
            updateFreestyleLatchFromTelemetry();
        }
        finally {
            pollInFlight = false;
            notify();
        }
    }
    return {
        start() {
            if (timer !== undefined)
                return;
            unsubBpm = subscribeBpm((bpm) => {
                void mirrorHeartRate(bpm);
            });
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
            unsubBpm === null || unsubBpm === void 0 ? void 0 : unsubBpm();
            unsubBpm = undefined;
            pendingHeartRateBpm = undefined;
            cancelFreestyleLatchPending();
            clearFreestyleHoldCorrectionState();
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
            let nextPairingToken = current.pairingToken;
            if (partial.pairingToken !== undefined) {
                const parsedToken = parseBikeBridgePairingToken(partial.pairingToken);
                if (!parsedToken.ok)
                    return { ok: false, error: parsedToken.error };
                nextPairingToken = parsedToken.token;
            }
            const pairingChanged = nextPairingToken !== current.pairingToken;
            if (partial.baseUrl !== undefined) {
                const trimmed = partial.baseUrl.trim();
                if (!trimmed) {
                    saveBikeBridgeSettings({
                        baseUrl: "",
                        consoleBrightness: nextBrightness,
                        pairingToken: nextPairingToken,
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
                consoleBrightness: nextBrightness,
                pairingToken: nextPairingToken,
            }, storage);
            if (pairingChanged) {
                lastError = null;
                if (nextPairingToken)
                    needsReconcile = true;
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
                consoleBrightness: level,
                pairingToken: current.pairingToken,
            }, storage);
            notify();
            return pushConsoleBrightness(level);
        },
        onGuidance(input) {
            var _a;
            // --- Session authority guards ---
            // Disarmed: no commands, but allow workoutActive/paused flags to update
            // for correct view-state rendering. Resistance-setting paths are blocked by canCommand().
            if (bindingState.type === "disarmed") {
                workoutActive = input.workoutActive;
                paused = input.paused;
                pendingLevel = undefined;
                notify();
                return;
            }
            // Bound sessions require matching identity. Missing or foreign
            // workout identity never authorizes commands or touches live state.
            if (bindingState.type === "bound") {
                if (input.workout === undefined || input.workout.sessionId !== bindingState.sessionId)
                    return;
            }
            // Freestyle binding: observation + latch/hold only.
            // Structured guidance/reconcile command paths stay suppressed.
            if (bindingState.type === "bound" && bindingState.controlMode === "manual_freestyle_ride") {
                workoutActive = input.workoutActive;
                paused = input.paused;
                desiredResistance = undefined;
                pendingLevel = undefined;
                needsReconcile = false;
                if (input.workoutActive) {
                    guidanceWorkout = input.workout ? { ...input.workout } : guidanceWorkout;
                }
                if (input.paused) {
                    cancelFreestyleLatchPending();
                    clearFreestyleHoldTarget();
                    // Preserve freestyleHoldReleased across pause/resume. Only Enable hold may clear it.
                }
                if (!input.workoutActive) {
                    resetFreestyleLatchState();
                    commandedResistance = undefined;
                }
                notify();
                return;
            }
            // --- Existing structured workout logic (unchanged) ---
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
        bindSession(binding) {
            if (binding === null) {
                if (bindingState.type === "disarmed")
                    return;
                bindingGeneration += 1;
                bindingState = { type: "disarmed" };
                desiredResistance = undefined;
                pendingLevel = undefined;
                needsReconcile = false;
                commandedResistance = undefined;
                guidanceWorkout = undefined;
                holdFailedLevel = undefined;
                resetFreestyleLatchState();
                notify();
                return;
            }
            if (typeof binding.sessionId !== "string" ||
                binding.sessionId.length === 0 ||
                !isSessionControlMode(binding.controlMode)) {
                throw new Error("Invalid session binding");
            }
            if (bindingState.type === "bound" && bindingState.sessionId === binding.sessionId) {
                if (bindingState.controlMode !== binding.controlMode) {
                    throw new Error("Session binding is already frozen with a conflicting control mode");
                }
                return;
            }
            bindingGeneration += 1;
            bindingState = { type: "bound", sessionId: binding.sessionId, controlMode: binding.controlMode };
            desiredResistance = undefined;
            pendingLevel = undefined;
            needsReconcile = false;
            commandedResistance = undefined;
            holdFailedLevel = undefined;
            lastAccepted = undefined;
            guidanceWorkout = { day: "", sessionId: binding.sessionId };
            resetFreestyleLatchState();
            notify();
        },
        getSessionBinding() {
            if (bindingState.type === "bound") {
                return { sessionId: bindingState.sessionId, controlMode: bindingState.controlMode };
            }
            return null;
        },
        isDisarmed() {
            return bindingState.type === "disarmed";
        },
        releaseFreestyleHold() {
            cancelFreestyleLatchPending();
            clearFreestyleHoldTarget();
            freestyleHoldReleased = true;
            freestyleQueued = undefined;
            freestyleLastDispatchedLatch = undefined;
            notify();
        },
        enableFreestyleHold() {
            if (!isFreestyleBound()) {
                return { ok: false, error: "Freestyle hold is unavailable" };
            }
            if (!workoutActive || paused) {
                return { ok: false, error: "Start or resume Freestyle to enable hold" };
            }
            if (telemetryStale ||
                !lastTelemetry ||
                !(lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.connected) ||
                !(lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.initialized) ||
                !controlAvailable()) {
                return { ok: false, error: "Fresh bike telemetry is required to enable hold" };
            }
            const observed = lastTelemetry.resistance;
            if (!observed || observed.current !== true || observed.value === null || observed.value === undefined) {
                return { ok: false, error: "Fresh bike telemetry is required to enable hold" };
            }
            if (observed.value === 0) {
                return {
                    ok: false,
                    error: "Enable hold requires a rider-selectable resistance (R1–R15)",
                };
            }
            const target = toBridgeResistanceLevel(observed.value);
            if (target === undefined) {
                return {
                    ok: false,
                    error: "Enable hold requires a rider-selectable resistance (R1–R15)",
                };
            }
            if (!canFreestyleAuthorityCommand()) {
                return { ok: false, error: "Freestyle hold is unavailable" };
            }
            adoptFreestyleHoldTarget(target);
            void sendTarget(target, "observed_change_latch", "freestyle_latch");
            notify();
            return { ok: true };
        },
    };
}
let appSession;
export function getBikeBridgeSession() {
    if (!appSession)
        appSession = createBikeBridgeSession();
    return appSession;
}
/** Test-only seam so F1 lifecycle can assert against a mocked bridge transport. */
export function setBikeBridgeSessionForTests(session) {
    appSession = session !== null && session !== void 0 ? session : undefined;
}
export function startBikeBridgeRuntime() {
    const session = getBikeBridgeSession();
    if (!session.getViewState().configuredUrl.trim()) {
        session.configure({ baseUrl: NATIVE_PROFORM_BRIDGE_ORIGIN });
    }
    session.start();
}
export function formatBikeBridgeNumber(value) {
    return value === null || value === undefined ? "-" : String(value);
}
export function formatBikeBridgeHeartRateDelivery(state, nowMs = Date.now()) {
    var _a;
    switch (state.heartRateDelivery) {
        case "idle":
            return "Console HR: waiting";
        case "no_bpm":
            return "Console HR: no live BPM";
        case "out_of_range":
            return "Console HR: BPM out of range";
        case "accepted": {
            const acceptedAt = state.heartRateLastAcceptedAtMs;
            if (acceptedAt !== null && nowMs - acceptedAt > BRIDGE_HEART_RATE_DISPLAY_FRESH_MS) {
                return "Console HR: HTTP accepted; last accept older than 3s console window";
            }
            return "Console HR: HTTP accepted";
        }
        case "pairing_required":
            return "Console HR: pairing rejected";
        case "timeout":
            return "Console HR: timeout";
        case "unreachable":
            return "Console HR: unreachable";
        case "http_error":
            return "Console HR: HTTP " + ((_a = state.heartRateLastHttpStatus) !== null && _a !== void 0 ? _a : "error");
        case "malformed":
            return "Console HR: malformed response";
        default:
            return "Console HR: waiting";
    }
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
            return "Telemetry only";
        case "control_ready":
            return "Control ready";
        case "invalid_response":
            return "Invalid response";
        default:
            return "Unreachable";
    }
}
export function formatBikeBridgeControl(state) {
    return state.controlAvailable ? "Ready" : "Unavailable";
}
export function formatBikeBridgeAuthorization(authorization) {
    switch (authorization) {
        case "authorized":
            return "Authorized workout";
        case "no_active_workout":
            return "No active workout";
        case "paused":
            return "Paused";
        case "disarmed":
            return "Disarmed";
        case "freestyle_policy":
            return "Freestyle (rider-set resistance)";
        case "not_configured":
            return "Bridge not configured";
        case "bridge_unavailable":
            return "Bridge not connected";
        case "control_unavailable":
            return "Bridge control unavailable";
        default:
            return "Unavailable";
    }
}
/**
 * One-line explanation of where structured resistance control stands. Bridge HTTP acceptance is
 * reported separately from the physically observed resistance and never claimed as confirmation.
 */
export function describeBikeBridgeCommandStatus(state) {
    var _a;
    if (state.commandAuthorization !== "authorized") {
        if (state.commandAuthorization === "no_active_workout")
            return "No active workout - no commands";
        if (state.commandAuthorization === "paused")
            return "Paused - no new commands";
        return formatBikeBridgeAuthorization(state.commandAuthorization);
    }
    if (state.pairingRequired)
        return state.pairingConfigured ? "Pairing rejected - re-enter the pairing code" : "Pairing required";
    if (state.desiredResistance === undefined)
        return "No resistance recommendation";
    if (state.commandInFlight)
        return "Sending R" + ((_a = state.commandedResistance) !== null && _a !== void 0 ? _a : state.desiredResistance);
    if (state.lastCommandOutcome === "timeout")
        return "Command timed out - outcome uncertain";
    if (state.lastCommandOutcome === "failed" || state.lastCommandOutcome === "unavailable") {
        return "Command failed" + (state.lastError ? ": " + state.lastError : "");
    }
    if (state.bridgeAcceptedResistance === null) {
        return state.pairingConfigured ? "Waiting to send" : "Waiting to send - no pairing code entered";
    }
    if (state.observedResistanceCurrent && state.observedResistance === state.bridgeAcceptedResistance) {
        return "Confirmed by bike telemetry";
    }
    return "Bridge accepted R" + state.bridgeAcceptedResistance + " - awaiting physical confirmation";
}
