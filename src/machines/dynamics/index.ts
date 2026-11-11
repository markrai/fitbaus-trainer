import { getHrSamples } from "../../workoutStorage.js";
import type { WorkoutSummary } from "../../types.js";
import { learningKey, workDurationClass, type LearningKeyParts } from "../learning/types.js";
import {
  deriveHrDynamicsObservations,
  observationContributesToStore,
  observationDelayIsSane,
  observationHrDeltaIsSane,
} from "./derive.js";
import {
  appendBoundedRecentResponse,
  appendBoundedSample,
  cloneEntry,
  emptyDynamicsEntry,
  entryHasDynamicsSamples,
  getDynamicsEntry,
  loadDynamicsStore,
  putDynamicsEntry,
  toPublicDynamics,
  type DynamicsStorage,
} from "./storage.js";
import { derivePersonalizedMachineTiming } from "./timing.js";
import type { LearnedHrDynamics, MachineHrResponseObservation, StoredDynamicsEntry } from "./types.js";
import type { PersonalizedWorkTiming } from "../types.js";

export {
  DYNAMICS_SAMPLE_LIMIT,
  DYNAMICS_STORAGE_KEY,
  DYNAMICS_STORE_VERSION,
  MAX_ABS_HR_DELTA,
  MAX_ABS_HR_PER_LEVEL,
  MAX_RESISTANCE_STEP,
  MIN_OBSERVABLE_WINDOW_SECONDS,
  RECENT_OPPORTUNITY_LIMIT,
  RESPONSE_SEARCH_SECONDS,
  type LearnedHrDynamics,
  type LearnedHrDynamicsStore,
  type MachineHrResponseObservation,
  type RecentHrResponse,
  type StoredDynamicsEntry,
} from "./types.js";
export {
  deriveHrDynamicsObservations,
  observationContributesToStore,
  observationHasAggregatableMetric,
  observationPassesSanity,
  observationWindowIsObservable,
  responseDetectionRate,
  workoutEligibleForHrDynamics,
} from "./derive.js";
export {
  delayConcentrationNearMedian,
  recentDetectedCount,
  recentDetectedDelays,
  recentDetectionRate,
  recentObservationCount,
} from "./recent.js";
export {
  appendBoundedRecentResponse,
  appendBoundedSample,
  emptyDynamicsStore,
  getDynamicsEntry,
  listHrDynamics,
  loadDynamicsStore,
  putDynamicsEntry,
  resetHrDynamicsForMachine,
  saveDynamicsStore,
  sanitizeDynamicsStore,
} from "./storage.js";
export {
  DEFAULT_LONG_COOLDOWN_SECONDS,
  DEFAULT_LONG_INITIAL_SECONDS,
  DEFAULT_MEDIUM_INITIAL_SECONDS,
  delayMedianAbsoluteDeviation,
  deriveLongCooldownSeconds,
  deriveLongEarlyCooldownSeconds,
  deriveLongEarlyInitialEvaluationSeconds,
  deriveLongInitialEvaluationSeconds,
  deriveMediumEarlyEvaluationSeconds,
  deriveMediumInitialEvaluationSeconds,
  derivePersonalizedMachineTiming,
  EARLY_TIMING_CONCENTRATION_WINDOW_SECONDS,
  hasActiveTimingPersonalization,
  highConfidenceRecentDelayEstimate,
  MAX_DELAY_MAD_SECONDS,
  MAX_EARLY_TIMING_MAD_SECONDS,
  MIN_EARLY_TIMING_CONCENTRATION,
  MIN_EARLY_TIMING_DETECTED_RESPONSES,
  MIN_EARLY_TIMING_DETECTION_RATE,
  MIN_LONG_COOLDOWN_EARLY_SECONDS,
  MIN_LONG_INITIAL_EARLY_SECONDS,
  MIN_MEDIUM_EARLY_SECONDS,
  MIN_TRUSTED_DELAY_SAMPLES,
  timingModeForEntry,
  timingModeForPersonalizedTiming,
  trustedDelayMedian,
} from "./timing.js";
export type { HighConfidenceRecentDelayEstimate, TimingMode } from "./timing.js";
export type { PersonalizedWorkTiming } from "../types.js";

function perLevelDelta(observation: MachineHrResponseObservation): number | undefined {
  if (observation.hrDelta === undefined || observation.resistanceDelta === undefined) return undefined;
  if (observation.resistanceDelta === 0) return undefined;
  return Math.round(observation.hrDelta / Math.abs(observation.resistanceDelta));
}

export function mergeObservationIntoEntry(
  previous: StoredDynamicsEntry | undefined,
  observation: MachineHrResponseObservation,
  updatedAt: string
): StoredDynamicsEntry {
  const next = previous ? cloneEntry({ ...previous, updatedAt }) : emptyDynamicsEntry(updatedAt);
  const delaySane = observationDelayIsSane(observation);
  const deltaSane = observationHrDeltaIsSane(observation);
  const detected = observation.responseDetected === true && observation.responseDelaySeconds !== undefined && delaySane;
  const observable = observation.windowObservable === true;
  const delay = delaySane ? observation.responseDelaySeconds : undefined;
  const hrDelta = deltaSane ? observation.hrDelta : undefined;
  const perLevel = hrDelta === undefined ? undefined : perLevelDelta({ ...observation, hrDelta });
  if (observation.kind === "work_start") {
    if (observable) {
      next.workStartObservationCount += 1;
      if (detected) next.workStartDetectedResponseCount += 1;
      next.workStartRecentResponses = appendBoundedRecentResponse(
        next.workStartRecentResponses,
        detected && delay !== undefined ? delay : null
      );
    }
    if (delay !== undefined) next.workStartDelays = appendBoundedSample(next.workStartDelays, delay);
    if (hrDelta !== undefined) next.workStartHrDeltas = appendBoundedSample(next.workStartHrDeltas, hrDelta);
    return next;
  }
  if (observation.kind === "resistance_increase") {
    if (observable) {
      next.increaseObservationCount += 1;
      if (detected) next.increaseDetectedResponseCount += 1;
      next.increaseRecentResponses = appendBoundedRecentResponse(
        next.increaseRecentResponses,
        detected && delay !== undefined ? delay : null
      );
    }
    if (delay !== undefined) next.increaseDelays = appendBoundedSample(next.increaseDelays, delay);
    if (perLevel !== undefined) next.increaseHrPerLevel = appendBoundedSample(next.increaseHrPerLevel, perLevel);
    return next;
  }
  if (observable) {
    next.decreaseObservationCount += 1;
    if (detected) next.decreaseDetectedResponseCount += 1;
    next.decreaseRecentResponses = appendBoundedRecentResponse(
      next.decreaseRecentResponses,
      detected && delay !== undefined ? delay : null
    );
  }
  if (delay !== undefined) next.decreaseDelays = appendBoundedSample(next.decreaseDelays, delay);
  if (perLevel !== undefined) next.decreaseHrPerLevel = appendBoundedSample(next.decreaseHrPerLevel, perLevel);
  return next;
}

export function applyCompletedWorkoutDynamics(
  summary: WorkoutSummary,
  hrSamples: readonly { elapsedSeconds: number; bpm: number }[],
  storage?: DynamicsStorage,
  updatedAt = new Date().toISOString()
): LearnedHrDynamics[] {
  const observations = deriveHrDynamicsObservations(summary, hrSamples).filter(observationContributesToStore);
  if (observations.length === 0) return [];
  const store = loadDynamicsStore(storage);
  const grouped = new Map<string, { parts: LearningKeyParts; merged: StoredDynamicsEntry }>();
  for (const observation of observations) {
    const parts = {
      machineId: observation.machineId,
      machineProfileVersion: observation.machineProfileVersion,
      activity: observation.activity,
      intent: observation.intent,
      durationClass: observation.durationClass,
    };
    const key = learningKey(parts);
    const current = grouped.get(key)?.merged ?? store.entries[key];
    grouped.set(key, { parts, merged: mergeObservationIntoEntry(current, observation, updatedAt) });
  }
  const saved: LearnedHrDynamics[] = [];
  for (const { parts, merged } of grouped.values()) {
    if (!entryHasDynamicsSamples(merged)) continue;
    const result = putDynamicsEntry(parts, merged, storage);
    if (result) saved.push(result);
  }
  return saved;
}

export function learnHrDynamicsFromSamples(
  summary: WorkoutSummary,
  hrSamples: readonly { elapsedSeconds: number; bpm: number }[],
  storage?: DynamicsStorage,
  updatedAt = new Date().toISOString()
): LearnedHrDynamics[] {
  try {
    return applyCompletedWorkoutDynamics(summary, hrSamples, storage, updatedAt);
  } catch (error) {
    console.error("Machine HR-dynamics learning failed:", error);
    return [];
  }
}

export async function learnHrDynamicsFromCompletedWorkout(
  summary: WorkoutSummary,
  storage?: DynamicsStorage
) {
  if (summary.cancelled) return [];
  try {
    const samples = await getHrSamples(summary.external_session_id);
    return learnHrDynamicsFromSamples(
      summary,
      samples.map((sample) => ({ elapsedSeconds: sample.timestamp_sec, bpm: sample.hr })),
      storage
    );
  } catch (error) {
    console.error("Machine HR-dynamics learning failed:", error);
    return [];
  }
}

export function getPublicDynamics(
  parts: Parameters<typeof toPublicDynamics>[0],
  storage?: DynamicsStorage
): LearnedHrDynamics | undefined {
  const entry = loadDynamicsStore(storage).entries[learningKey(parts)];
  if (!entry) return undefined;
  return toPublicDynamics(parts, entry);
}

export function lookupPersonalizedTiming(
  parts: Omit<LearningKeyParts, "durationClass"> & { durationSeconds: number },
  storage?: DynamicsStorage
): PersonalizedWorkTiming | undefined {
  if (parts.durationSeconds <= 75) return undefined;
  const entry = getDynamicsEntry(
    {
      machineId: parts.machineId,
      machineProfileVersion: parts.machineProfileVersion,
      activity: parts.activity,
      intent: parts.intent,
      durationClass: workDurationClass(parts.durationSeconds),
    },
    storage
  );
  return derivePersonalizedMachineTiming(entry, parts.durationSeconds);
}
