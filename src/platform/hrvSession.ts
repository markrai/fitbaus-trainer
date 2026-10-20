import { isHrvUnavailable } from "./hrvDisplay.js";
import { RollingHrvAccumulator, type HrvPushResult, type HrvSnapshot } from "./hrvAccumulator.js";

export type HrvDiagnosticSnapshot = HrvSnapshot & {
  lastOptionalFieldError: string | null;
  optionalFieldErrorTotalThisSession: number;
  connected: boolean;
  connectedDurationMs: number;
  cleanMeasurementCountThisSession: number;
  rrSeenThisSession: boolean;
};

function defaultNowMs(): number {
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
  private readonly accumulator: RollingHrvAccumulator;
  private readonly now: () => number;
  private lastOptionalFieldError: string | null = null;
  private optionalFieldErrorTotalThisSession = 0;
  private hrSessionActive = false;
  private sessionStartedAtMs: number | null = null;
  private cleanMeasurementCountThisSession = 0;
  private rrSeenThisSession = false;
  private unavailableNotifiedThisSession = false;

  constructor(options?: { now?: () => number; accumulator?: RollingHrvAccumulator }) {
    this.now = options?.now ?? defaultNowMs;
    this.accumulator = options?.accumulator ?? new RollingHrvAccumulator({ now: this.now });
  }

  getSnapshot(): HrvDiagnosticSnapshot {
    const connectedDurationMs =
      this.hrSessionActive && this.sessionStartedAtMs !== null
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
  prepareConnectAttempt(): HrvDiagnosticSnapshot {
    this.resetState();
    this.hrSessionActive = false;
    this.sessionStartedAtMs = null;
    return this.getSnapshot();
  }

  /** Activate only after BLE connectivity is established. */
  activateConnected(): HrvDiagnosticSnapshot {
    this.resetState();
    this.hrSessionActive = true;
    this.sessionStartedAtMs = this.now();
    return this.getSnapshot();
  }

  deactivate(): HrvDiagnosticSnapshot {
    this.resetState();
    this.hrSessionActive = false;
    this.sessionStartedAtMs = null;
    return this.getSnapshot();
  }

  noteOptionalFieldError(message: string): HrvDiagnosticSnapshot {
    this.lastOptionalFieldError = message;
    this.optionalFieldErrorTotalThisSession += 1;
    this.accumulator.markContinuityBreak("optional_field_error");
    return this.getSnapshot();
  }

  clearOptionalFieldErrorSilent(): void {
    this.lastOptionalFieldError = null;
  }

  /**
   * Clean BPM-only measurement. Notifies callers when a stale diagnostic was
   * cleared or the no-RR unavailable threshold is crossed.
   */
  noteOptionalFieldsOk(): { snapshot: HrvDiagnosticSnapshot; shouldNotify: boolean } {
    const hadError = this.lastOptionalFieldError !== null;
    this.lastOptionalFieldError = null;
    this.cleanMeasurementCountThisSession += 1;
    const crossedUnavailable = !this.unavailableNotifiedThisSession && this.shouldNotifyUnavailable();
    if (crossedUnavailable) this.unavailableNotifiedThisSession = true;
    const snapshot = this.getSnapshot();
    return { snapshot, shouldNotify: hadError || crossedUnavailable };
  }

  /**
   * Ingest decoded RR from one notification. `rrSeenThisSession` becomes true
   * only when the accumulator accepts at least one interval.
   */
  ingestRrPacket(rrIntervalsMs: readonly number[]): {
    results: HrvPushResult[];
    snapshot: HrvDiagnosticSnapshot;
  } {
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

  private shouldNotifyUnavailable(): boolean {
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

  private resetState(): void {
    this.accumulator.reset();
    this.lastOptionalFieldError = null;
    this.optionalFieldErrorTotalThisSession = 0;
    this.cleanMeasurementCountThisSession = 0;
    this.rrSeenThisSession = false;
    this.unavailableNotifiedThisSession = false;
  }
}
