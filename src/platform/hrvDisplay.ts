import type { HrvReadiness } from "./hrvAccumulator.js";

export const HRV_UNAVAILABLE_MIN_CONNECTED_MS = 20_000;
export const HRV_UNAVAILABLE_MIN_CLEAN_MEASUREMENTS = 15;

export type HrvDisplayState =
  | "disconnected"
  | "collecting"
  | "live"
  | "stable"
  | "noisy"
  | "unavailable";

export interface HrvDisplayModel {
  primary: string;
  secondary: string;
  state: HrvDisplayState;
}

export interface HrvDisplayInput {
  connected: boolean;
  connectedDurationMs: number;
  cleanMeasurementCountThisSession: number;
  rrSeenThisSession: boolean;
  readiness: HrvReadiness;
  ready: boolean;
  reliable: boolean;
  rmssdMs: number | null;
  physiologicalDurationMs: number;
}

function formatWholeMs(rmssdMs: number): string {
  return String(Math.round(rmssdMs));
}

function formatDurationSeconds(physiologicalDurationMs: number): number {
  return Math.max(0, Math.floor(physiologicalDurationMs / 1000));
}

/**
 * No-RR sensor rule: while connected, after ≥20s connected and ≥15 clean
 * BPM-bearing measurements with zero accepted RR this session, treat HRV as
 * unavailable. Any later RR evidence leaves this path.
 */
export function isHrvUnavailable(input: HrvDisplayInput): boolean {
  return (
    input.connected &&
    !input.rrSeenThisSession &&
    input.connectedDurationMs >= HRV_UNAVAILABLE_MIN_CONNECTED_MS &&
    input.cleanMeasurementCountThisSession >= HRV_UNAVAILABLE_MIN_CLEAN_MEASUREMENTS
  );
}

export function formatHrvDisplay(input: HrvDisplayInput): HrvDisplayModel {
  if (!input.connected) {
    return { primary: "HRV —", secondary: "", state: "disconnected" };
  }

  if (isHrvUnavailable(input)) {
    return { primary: "HRV —", secondary: "Not provided by sensor", state: "unavailable" };
  }

  const durationSec = formatDurationSeconds(input.physiologicalDurationMs);

  if (input.ready && input.rmssdMs !== null && !input.reliable) {
    return {
      primary: `HRV ${formatWholeMs(input.rmssdMs)} ms`,
      secondary: "Signal noisy",
      state: "noisy",
    };
  }

  if (input.readiness === "stable" && input.ready && input.reliable && input.rmssdMs !== null) {
    return {
      primary: `HRV ${formatWholeMs(input.rmssdMs)} ms`,
      secondary: "60s RMSSD",
      state: "stable",
    };
  }

  if (input.readiness === "live" && input.ready && input.reliable && input.rmssdMs !== null) {
    return {
      primary: `HRV ${formatWholeMs(input.rmssdMs)} ms`,
      secondary: `Live · ${durationSec}s`,
      state: "live",
    };
  }

  return {
    primary: "HRV —",
    secondary: `Collecting · ${durationSec}s`,
    state: "collecting",
  };
}
