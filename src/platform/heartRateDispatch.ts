import { parseHeartRateMeasurement } from "./heartRateMeasurement.js";

/**
 * Shared post-parse fan-out for one 0x2A37 notification.
 * Ensures native BLE and Web Bluetooth apply identical BPM / RR / optional-error semantics.
 *
 * Clean RR and clean BPM-only are mutually exclusive so HRV subscribers see
 * one meaningful update per notification after RR ingest (when present).
 */
export interface HeartRateDispatchHandlers {
  onBpm: (bpm: number) => void;
  onRrIntervals?: (rrIntervalsMs: readonly number[]) => void;
  /** Optional EE/RR bytes malformed; BPM was still delivered. */
  onOptionalFieldError?: (message: string) => void;
  /** Clean BPM-only measurement (optional fields OK, no RR). */
  onOptionalFieldsOk?: () => void;
  /** Silent clear of a stale optional-field diagnostic before RR ingest. */
  onClearOptionalFieldError?: () => void;
}

export function dispatchHeartRateMeasurement(
  value: DataView,
  handlers: HeartRateDispatchHandlers
): void {
  const measurement = parseHeartRateMeasurement(value);
  handlers.onBpm(measurement.bpm);
  if (measurement.optionalFieldError) {
    handlers.onOptionalFieldError?.(measurement.optionalFieldError);
    return;
  }
  if (measurement.rrIntervalsMs.length > 0) {
    handlers.onClearOptionalFieldError?.();
    handlers.onRrIntervals?.(measurement.rrIntervalsMs);
    return;
  }
  handlers.onOptionalFieldsOk?.();
}
