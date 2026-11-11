import { isHrvUnavailable } from "./hrvDisplay.js";
import { RollingHrvAccumulator } from "./hrvAccumulator.js";
function defaultNowMs() {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return performance.now();
    }
    return Date.now();
}
/**
 * HRV session lifecycle separate from BLE chooser / connect-attempt time.
 * A session is connected only after the sensor link is established.
 */
export class HrvSession {
    constructor(options) {
        var _a, _b;
        this.lastOptionalFieldError = null;
        this.optionalFieldErrorTotalThisSession = 0;
        this.hrSessionActive = false;
        this.sessionStartedAtMs = null;
        this.cleanMeasurementCountThisSession = 0;
        this.rrSeenThisSession = false;
        this.unavailableNotifiedThisSession = false;
        this.now = (_a = options === null || options === void 0 ? void 0 : options.now) !== null && _a !== void 0 ? _a : defaultNowMs;
        this.accumulator = (_b = options === null || options === void 0 ? void 0 : options.accumulator) !== null && _b !== void 0 ? _b : new RollingHrvAccumulator({ now: this.now });
    }
    getSnapshot() {
        const connectedDurationMs = this.hrSessionActive && this.sessionStartedAtMs !== null
            ? Math.max(0, this.now() - this.sessionStartedAtMs)
            : 0;
        return {
            ...this.accumulator.getSnapshot(),
            lastOptionalFieldError: this.lastOptionalFieldError,
            optionalFieldErrorTotalThisSession: this.optionalFieldErrorTotalThisSession,
            connected: this.hrSessionActive,
            connectedDurationMs,
            cleanMeasurementCountThisSession: this.cleanMeasurementCountThisSession,
            rrSeenThisSession: this.rrSeenThisSession,
        };
    }
    /**
     * Clear stale RMSSD immediately when a new connection attempt begins.
     * Remains disconnected until {@link activateConnected}.
     */
    prepareConnectAttempt() {
        this.resetState();
        this.hrSessionActive = false;
        this.sessionStartedAtMs = null;
        return this.getSnapshot();
    }
    /** Activate only after BLE connectivity is established. */
    activateConnected() {
        this.resetState();
        this.hrSessionActive = true;
        this.sessionStartedAtMs = this.now();
        return this.getSnapshot();
    }
    deactivate() {
        this.resetState();
        this.hrSessionActive = false;
        this.sessionStartedAtMs = null;
        return this.getSnapshot();
    }
    noteOptionalFieldError(message) {
        this.lastOptionalFieldError = message;
        this.optionalFieldErrorTotalThisSession += 1;
        this.accumulator.markContinuityBreak("optional_field_error");
        return this.getSnapshot();
    }
    clearOptionalFieldErrorSilent() {
        this.lastOptionalFieldError = null;
    }
    /**
     * Clean BPM-only measurement. Notifies callers when a stale diagnostic was
     * cleared or the no-RR unavailable threshold is crossed.
     */
    noteOptionalFieldsOk() {
        const hadError = this.lastOptionalFieldError !== null;
        this.lastOptionalFieldError = null;
        this.cleanMeasurementCountThisSession += 1;
        const crossedUnavailable = !this.unavailableNotifiedThisSession && this.shouldNotifyUnavailable();
        if (crossedUnavailable)
            this.unavailableNotifiedThisSession = true;
        const snapshot = this.getSnapshot();
        return { snapshot, shouldNotify: hadError || crossedUnavailable };
    }
    /**
     * Ingest decoded RR from one notification. `rrSeenThisSession` becomes true
     * only when the accumulator accepts at least one interval.
     */
    ingestRrPacket(rrIntervalsMs) {
        if (rrIntervalsMs.length === 0) {
            return { results: [], snapshot: this.getSnapshot() };
        }
        this.cleanMeasurementCountThisSession += 1;
        const results = this.accumulator.pushRrPacket(rrIntervalsMs);
        if (results.some((result) => result.accepted)) {
            this.rrSeenThisSession = true;
        }
        return { results, snapshot: this.getSnapshot() };
    }
    shouldNotifyUnavailable() {
        if (this.rrSeenThisSession || !this.hrSessionActive || this.sessionStartedAtMs === null) {
            return false;
        }
        return isHrvUnavailable({
            connected: true,
            connectedDurationMs: Math.max(0, this.now() - this.sessionStartedAtMs),
            cleanMeasurementCountThisSession: this.cleanMeasurementCountThisSession,
            rrSeenThisSession: this.rrSeenThisSession,
            readiness: "collecting",
            ready: false,
            reliable: false,
            rmssdMs: null,
            physiologicalDurationMs: 0,
        });
    }
    resetState() {
        this.accumulator.reset();
        this.lastOptionalFieldError = null;
        this.optionalFieldErrorTotalThisSession = 0;
        this.cleanMeasurementCountThisSession = 0;
        this.rrSeenThisSession = false;
        this.unavailableNotifiedThisSession = false;
    }
}
