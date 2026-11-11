/**
 * Pure resting-session HR acquisition. Chest-strap BPM notifications are the
 * only observation source. UI timers may refresh elapsed/freshness/gap
 * diagnostics but must never manufacture or overwrite observation samples.
 * RR/HRV is not a substitute for resting HR.
 */

import {
  RESTING_HR_SESSION_ALGORITHM_ID,
  RESTING_HR_SESSION_ALGORITHM_VERSION,
  RESTING_HR_SESSION_MAX_BPM,
  RESTING_HR_SESSION_MIN_BPM,
  RESTING_HR_SESSION_OBSERVATION_DURATION_SEC,
  RESTING_HR_SESSION_SETTLE_DURATION_SEC,
  RESTING_HR_SESSION_TOTAL_DURATION_SEC,
  type RestingHeartRateSessionMetric,
} from "./types.js";
import { integerMedian, integerMedianAbsoluteDeviation } from "./machines/hrQuality.js";

export const RESTING_HR_SESSION_POLICY_V1 = {
  algorithmId: RESTING_HR_SESSION_ALGORITHM_ID,
  algorithmVersion: RESTING_HR_SESSION_ALGORITHM_VERSION,
  totalDurationSec: RESTING_HR_SESSION_TOTAL_DURATION_SEC,
  settleDurationSec: RESTING_HR_SESSION_SETTLE_DURATION_SEC,
  observationDurationSec: RESTING_HR_SESSION_OBSERVATION_DURATION_SEC,
  bpmFreshnessMs: 3000,
  minPlausibleBpm: RESTING_HR_SESSION_MIN_BPM,
  maxPlausibleBpm: RESTING_HR_SESSION_MAX_BPM,
  abruptChangeBpm: 20,
  minAcceptedObservationSamples: 60,
  minCoverageRatio: 0.8,
  maxMadBpm: 5,
  /**
   * Reject when any run of consecutive observation seconds lacks an accepted
   * sample, even if overall coverage still meets minCoverageRatio. Chosen as
   * ~10% of the 210 s observation window: long enough to catch disconnects or
   * sustained outages, short enough not to fail brief single-second dropouts.
   */
  maxContinuousUnacceptedSec: 20,
  highCoverageRatio: 0.9,
  highMaxMadBpm: 3,
} as const;

export type RestingHrAcquisitionStatus = "idle" | "measuring" | "completed" | "rejected" | "cancelled";
export type RestingHrAcquisitionPhase = "idle" | "settling" | "observing" | "completed" | "rejected" | "cancelled";

export type RestingHrRejectReason =
  | "incomplete"
  | "disconnected"
  | "insufficient_coverage"
  | "insufficient_samples"
  | "excessive_dispersion"
  | "excessive_continuous_gap"
  | "cancelled"
  | "interrupted";

export type RestingHrStartBlockReason =
  | "not_connected"
  | "workout_in_progress"
  | "measurement_in_progress";

export interface RestingHrNotificationInput {
  /** Monotonic milliseconds used only for elapsed timing. */
  monoMs: number;
  bpm: number;
  connected: boolean;
}

export interface RestingHrUiRefreshInput {
  /** Monotonic milliseconds used only for elapsed timing. */
  monoMs: number;
  connected: boolean;
}

export interface RestingHrStartReadiness {
  connected: boolean;
  workoutInProgress: boolean;
  measurementInProgress: boolean;
}

export interface RestingHrLiveStatus {
  status: RestingHrAcquisitionStatus;
  phase: RestingHrAcquisitionPhase;
  elapsedSec: number;
  liveBpm: number | null;
  liveBpmFresh: boolean;
  acceptedObservationCount: number;
  rejectedObservationCount: number;
  gapCount: number;
  longestContinuousUnacceptedSec: number;
  qualityLine: string;
  rejectReason?: RestingHrRejectReason;
}

export type RestingHrFinalizeResult =
  | { outcome: "accepted"; metric: RestingHeartRateSessionMetric }
  | { outcome: "rejected"; reason: RestingHrRejectReason }
  | { outcome: "cancelled" };

type ObservationSlot =
  | { kind: "accepted"; bpm: number }
  | { kind: "rejected" };

export interface RestingHrAcquisitionState {
  status: RestingHrAcquisitionStatus;
  /** Monotonic start used for elapsed duration. */
  startedAtMonoMs: number;
  measurementId: string;
  athleteId: string;
  lastAcceptedBpm: number | undefined;
  lastLiveBpm: number | null;
  /** Monotonic arrival time of the latest BPM notification. */
  lastBpmArrivalMonoMs: number | null;
  lastConnected: boolean;
  /** Observation-window slots keyed by 0..observationDurationSec-1. Written only by BPM notifications. */
  observationSlots: Map<number, ObservationSlot>;
  rejectReason?: RestingHrRejectReason;
}

export function evaluateRestingHrStartReadiness(
  input: RestingHrStartReadiness
): { ok: true } | { ok: false; reason: RestingHrStartBlockReason } {
  if (input.measurementInProgress) return { ok: false, reason: "measurement_in_progress" };
  if (input.workoutInProgress) return { ok: false, reason: "workout_in_progress" };
  if (!input.connected) return { ok: false, reason: "not_connected" };
  return { ok: true };
}

export function createRestingHrAcquisition(input: {
  startedAtMonoMs: number;
  measurementId: string;
  athleteId: string;
}): RestingHrAcquisitionState {
  return {
    status: "measuring",
    startedAtMonoMs: input.startedAtMonoMs,
    measurementId: input.measurementId,
    athleteId: input.athleteId,
    lastAcceptedBpm: undefined,
    lastLiveBpm: null,
    lastBpmArrivalMonoMs: null,
    lastConnected: true,
    observationSlots: new Map(),
  };
}

function elapsedSeconds(state: RestingHrAcquisitionState, monoMs: number): number {
  return Math.max(0, Math.floor((monoMs - state.startedAtMonoMs) / 1000));
}

function observationIndex(elapsedSec: number): number | null {
  if (elapsedSec < RESTING_HR_SESSION_POLICY_V1.settleDurationSec) return null;
  if (elapsedSec >= RESTING_HR_SESSION_POLICY_V1.totalDurationSec) return null;
  return elapsedSec - RESTING_HR_SESSION_POLICY_V1.settleDurationSec;
}

function classifyNotification(
  state: RestingHrAcquisitionState,
  bpmRaw: number
): ObservationSlot {
  const bpm = Math.round(bpmRaw);
  if (
    !Number.isFinite(bpmRaw) ||
    bpm < RESTING_HR_SESSION_POLICY_V1.minPlausibleBpm ||
    bpm > RESTING_HR_SESSION_POLICY_V1.maxPlausibleBpm
  ) {
    return { kind: "rejected" };
  }
  if (
    state.lastAcceptedBpm !== undefined &&
    Math.abs(bpm - state.lastAcceptedBpm) > RESTING_HR_SESSION_POLICY_V1.abruptChangeBpm
  ) {
    return { kind: "rejected" };
  }
  return { kind: "accepted", bpm };
}

function slotCounts(state: RestingHrAcquisitionState): {
  accepted: number;
  rejected: number;
  gap: number;
  acceptedBpms: number[];
  longestContinuousUnaccepted: number;
} {
  const expected = RESTING_HR_SESSION_POLICY_V1.observationDurationSec;
  const acceptedBpms: number[] = [];
  let accepted = 0;
  let rejected = 0;
  let longest = 0;
  let run = 0;
  for (let index = 0; index < expected; index += 1) {
    const slot = state.observationSlots.get(index);
    if (slot?.kind === "accepted") {
      accepted += 1;
      acceptedBpms.push(slot.bpm);
      run = 0;
    } else {
      if (slot?.kind === "rejected") rejected += 1;
      run += 1;
      if (run > longest) longest = run;
    }
  }
  return {
    accepted,
    rejected,
    gap: Math.max(0, expected - accepted - rejected),
    acceptedBpms,
    longestContinuousUnaccepted: longest,
  };
}

function phaseFor(state: RestingHrAcquisitionState, elapsedSec: number): RestingHrAcquisitionPhase {
  if (state.status === "cancelled") return "cancelled";
  if (state.status === "rejected") return "rejected";
  if (state.status === "completed") return "completed";
  if (state.status !== "measuring") return "idle";
  if (elapsedSec < RESTING_HR_SESSION_POLICY_V1.settleDurationSec) return "settling";
  return "observing";
}

function liveBpmFresh(state: RestingHrAcquisitionState, monoMs: number): boolean {
  return (
    state.lastBpmArrivalMonoMs != null &&
    monoMs - state.lastBpmArrivalMonoMs <= RESTING_HR_SESSION_POLICY_V1.bpmFreshnessMs &&
    state.lastLiveBpm != null
  );
}

function qualityLine(
  state: RestingHrAcquisitionState,
  elapsedSec: number,
  connected: boolean,
  monoMs: number
): string {
  if (state.status === "cancelled") {
    return state.rejectReason === "interrupted"
      ? "Measurement interrupted because a workout became active."
      : "Measurement cancelled.";
  }
  if (state.status === "rejected") {
    return rejectReasonText(state.rejectReason ?? "insufficient_coverage");
  }
  if (state.status === "completed") return "Measurement complete.";
  if (!connected) return "Chest strap disconnected.";
  if (!liveBpmFresh(state, monoMs)) return "Waiting for a fresh heart-rate reading.";
  const counts = slotCounts(state);
  if (elapsedSec < RESTING_HR_SESSION_POLICY_V1.settleDurationSec) {
    return "Settling — stay seated and still.";
  }
  if (counts.rejected > 0) {
    return `Measuring — ${counts.accepted} stable samples, ${counts.rejected} artifacts ignored.`;
  }
  return `Measuring — ${counts.accepted} stable samples.`;
}

export function rejectReasonText(reason: RestingHrRejectReason): string {
  switch (reason) {
    case "incomplete":
      return "Measurement ended before five minutes.";
    case "disconnected":
      return "Chest strap disconnected during measurement. The attempt was abandoned.";
    case "insufficient_coverage":
      return "Too many missing or stale readings to accept a result.";
    case "insufficient_samples":
      return "Not enough stable readings to accept a result.";
    case "excessive_dispersion":
      return "Heart rate was too variable to accept a resting-session result.";
    case "excessive_continuous_gap":
      return "Heart-rate signal had a continuous outage that was too long to accept a result.";
    case "cancelled":
      return "Measurement cancelled.";
    case "interrupted":
      return "Measurement interrupted because a workout became active.";
  }
}

function liveStatus(
  state: RestingHrAcquisitionState,
  monoMs: number
): RestingHrLiveStatus {
  const elapsedSec = elapsedSeconds(state, monoMs);
  const counts = slotCounts(state);
  const fresh = liveBpmFresh(state, monoMs);
  return {
    status: state.status,
    phase: phaseFor(state, elapsedSec),
    elapsedSec: Math.min(elapsedSec, RESTING_HR_SESSION_POLICY_V1.totalDurationSec),
    liveBpm: fresh ? state.lastLiveBpm : null,
    liveBpmFresh: fresh,
    acceptedObservationCount: counts.accepted,
    rejectedObservationCount: counts.rejected,
    gapCount: counts.gap,
    longestContinuousUnacceptedSec: counts.longestContinuousUnaccepted,
    qualityLine: qualityLine(state, elapsedSec, state.lastConnected, monoMs),
    ...(state.rejectReason ? { rejectReason: state.rejectReason } : {}),
  };
}

/**
 * Abandon the active measurement when the chest strap disconnects.
 * Reconnection before five minutes does not resume the attempt. Previously
 * collected observation slots are left intact for diagnostics; nothing is saved.
 */
export function abandonRestingHrOnDisconnect(
  state: RestingHrAcquisitionState,
  monoMs: number
): RestingHrLiveStatus {
  if (state.status === "measuring") {
    state.status = "rejected";
    state.rejectReason = "disconnected";
    state.lastConnected = false;
  }
  return liveStatus(state, monoMs);
}

/**
 * Ingest one new hrMonitor BPM notification. This is the only path that may
 * create or fill an observation-second bucket. At most one classification is
 * kept per elapsed-second bucket; later notifications in the same second do
 * not replace an existing slot.
 */
export function ingestRestingHrBpmNotification(
  state: RestingHrAcquisitionState,
  input: RestingHrNotificationInput
): RestingHrLiveStatus {
  if (state.status !== "measuring") return liveStatus(state, input.monoMs);
  state.lastConnected = input.connected;
  if (!input.connected) {
    return abandonRestingHrOnDisconnect(state, input.monoMs);
  }
  if (!Number.isFinite(input.bpm)) {
    return liveStatus(state, input.monoMs);
  }
  const bpm = Math.round(input.bpm);
  state.lastLiveBpm = bpm;
  state.lastBpmArrivalMonoMs = input.monoMs;
  const elapsedSec = elapsedSeconds(state, input.monoMs);
  const index = observationIndex(elapsedSec);
  if (index != null && !state.observationSlots.has(index)) {
    const classified = classifyNotification(state, input.bpm);
    state.observationSlots.set(index, classified);
    if (classified.kind === "accepted") {
      state.lastAcceptedBpm = classified.bpm;
    }
  }
  return liveStatus(state, input.monoMs);
}

/**
 * UI / timer refresh only. Updates connection and elapsed presentation.
 * Never creates observation samples and never overwrites an accepted slot.
 * A disconnect here abandons the attempt immediately.
 */
export function refreshRestingHrAcquisitionUi(
  state: RestingHrAcquisitionState,
  input: RestingHrUiRefreshInput
): RestingHrLiveStatus {
  if (state.status !== "measuring") return liveStatus(state, input.monoMs);
  state.lastConnected = input.connected;
  if (!input.connected) {
    return abandonRestingHrOnDisconnect(state, input.monoMs);
  }
  return liveStatus(state, input.monoMs);
}

export function cancelRestingHrAcquisition(
  state: RestingHrAcquisitionState,
  monoMs: number,
  reason: "cancelled" | "interrupted" = "cancelled"
): RestingHrLiveStatus {
  if (state.status === "measuring") {
    state.status = "cancelled";
    state.rejectReason = reason;
  }
  return liveStatus(state, monoMs);
}

function coverageRatio(accepted: number): number {
  return Number((accepted / RESTING_HR_SESSION_POLICY_V1.observationDurationSec).toFixed(3));
}

export function finalizeRestingHrAcquisition(
  state: RestingHrAcquisitionState,
  monoMs: number,
  timestamps: { observedAt: string; updatedAt: string }
): RestingHrFinalizeResult {
  if (state.status === "cancelled") return { outcome: "cancelled" };
  // Disconnect abandon is terminal: reconnection / later finalize cannot accept.
  if (state.status === "rejected" && state.rejectReason === "disconnected") {
    return { outcome: "rejected", reason: "disconnected" };
  }
  if (state.status !== "measuring" && state.status !== "completed" && state.status !== "rejected") {
    return { outcome: "rejected", reason: "incomplete" };
  }
  const elapsedSec = elapsedSeconds(state, monoMs);
  if (elapsedSec < RESTING_HR_SESSION_POLICY_V1.totalDurationSec) {
    state.status = "rejected";
    state.rejectReason = "incomplete";
    return { outcome: "rejected", reason: "incomplete" };
  }
  if (!state.lastConnected) {
    state.status = "rejected";
    state.rejectReason = "disconnected";
    return { outcome: "rejected", reason: "disconnected" };
  }

  const counts = slotCounts(state);
  const coverage = coverageRatio(counts.accepted);
  if (counts.accepted < RESTING_HR_SESSION_POLICY_V1.minAcceptedObservationSamples) {
    state.status = "rejected";
    state.rejectReason = "insufficient_samples";
    return { outcome: "rejected", reason: "insufficient_samples" };
  }
  if (coverage < RESTING_HR_SESSION_POLICY_V1.minCoverageRatio) {
    state.status = "rejected";
    state.rejectReason = "insufficient_coverage";
    return { outcome: "rejected", reason: "insufficient_coverage" };
  }
  if (counts.longestContinuousUnaccepted > RESTING_HR_SESSION_POLICY_V1.maxContinuousUnacceptedSec) {
    state.status = "rejected";
    state.rejectReason = "excessive_continuous_gap";
    return { outcome: "rejected", reason: "excessive_continuous_gap" };
  }
  const mad = integerMedianAbsoluteDeviation(counts.acceptedBpms);
  const median = integerMedian(counts.acceptedBpms);
  if (median === undefined || mad === undefined || mad > RESTING_HR_SESSION_POLICY_V1.maxMadBpm) {
    state.status = "rejected";
    state.rejectReason = "excessive_dispersion";
    return { outcome: "rejected", reason: "excessive_dispersion" };
  }
  const quality: "high" | "moderate" =
    coverage >= RESTING_HR_SESSION_POLICY_V1.highCoverageRatio &&
    mad <= RESTING_HR_SESSION_POLICY_V1.highMaxMadBpm
      ? "high"
      : "moderate";
  state.status = "completed";
  return {
    outcome: "accepted",
    metric: {
      value: {
        metric: "resting_session_heart_rate",
        interpretation: "resting_session_observation_only",
        eligibleForPrescription: false,
        heartRateBpm: median,
        measurementDurationSec: RESTING_HR_SESSION_TOTAL_DURATION_SEC,
        settleDurationSec: RESTING_HR_SESSION_SETTLE_DURATION_SEC,
        observationDurationSec: RESTING_HR_SESSION_OBSERVATION_DURATION_SEC,
        acceptedSampleCount: counts.accepted,
        rejectedSampleCount: counts.rejected,
        expectedObservationSamples: RESTING_HR_SESSION_POLICY_V1.observationDurationSec,
        coverageRatio: coverage,
        medianAbsoluteDeviationBpm: mad,
        observedMinBpm: Math.min(...counts.acceptedBpms),
        observedMaxBpm: Math.max(...counts.acceptedBpms),
      },
      source: "resting_session",
      quality,
      observedAt: timestamps.observedAt,
      updatedAt: timestamps.updatedAt,
      algorithm: {
        id: RESTING_HR_SESSION_ALGORITHM_ID,
        version: RESTING_HR_SESSION_ALGORITHM_VERSION,
      },
      measurementId: state.measurementId,
    },
  };
}

/** Test helper: drive a session from explicit BPM notifications and optional UI refreshes. */
export function runRestingHrSession(
  events: ReadonlyArray<
    | { type: "bpm"; elapsedSec: number; bpm: number; connected?: boolean }
    | { type: "ui"; elapsedSec: number; connected?: boolean }
  >,
  options: { startedAtMonoMs?: number; measurementId?: string; athleteId?: string; observedAt?: string } = {}
): {
  state: RestingHrAcquisitionState;
  result: RestingHrFinalizeResult;
} {
  const startedAtMonoMs = options.startedAtMonoMs ?? 1_000_000;
  const state = createRestingHrAcquisition({
    startedAtMonoMs,
    measurementId: options.measurementId ?? "measurement-test",
    athleteId: options.athleteId ?? "athlete-test",
  });
  let lastMono = startedAtMonoMs;
  for (const event of events) {
    lastMono = startedAtMonoMs + event.elapsedSec * 1000;
    if (event.type === "bpm") {
      ingestRestingHrBpmNotification(state, {
        monoMs: lastMono,
        bpm: event.bpm,
        connected: event.connected ?? true,
      });
    } else {
      refreshRestingHrAcquisitionUi(state, {
        monoMs: lastMono,
        connected: event.connected ?? true,
      });
    }
  }
  const finalizeAt = Math.max(lastMono, startedAtMonoMs + RESTING_HR_SESSION_POLICY_V1.totalDurationSec * 1000);
  const observedAt = options.observedAt ?? "2026-11-03T12:05:00.000Z";
  return {
    state,
    result: finalizeRestingHrAcquisition(state, finalizeAt, { observedAt, updatedAt: observedAt }),
  };
}

/** Convenience: one BPM notification per second for the full five minutes. */
export function bpmNotificationsAround(
  bpm: number,
  map: Record<number, { bpm?: number; connected?: boolean; skip?: boolean }> = {}
): Array<{ type: "bpm"; elapsedSec: number; bpm: number; connected?: boolean }> {
  const events: Array<{ type: "bpm"; elapsedSec: number; bpm: number; connected?: boolean }> = [];
  for (let elapsedSec = 0; elapsedSec < RESTING_HR_SESSION_POLICY_V1.totalDurationSec; elapsedSec += 1) {
    const override = map[elapsedSec] ?? {};
    if (override.skip) continue;
    events.push({
      type: "bpm",
      elapsedSec,
      bpm: override.bpm === undefined ? bpm : override.bpm,
      connected: override.connected,
    });
  }
  return events;
}
