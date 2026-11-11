import { integerMedian, integerMedianAbsoluteDeviation } from "../hrQuality.js";
import type { WorkDurationClass } from "../learning/types.js";
import type { PersonalizedWorkTiming } from "../types.js";
import {
  delayConcentrationNearMedian,
  recentDetectedCount,
  recentDetectedDelays,
  recentDetectionRate,
  recentObservationCount,
} from "./recent.js";
import type { RecentHrResponse, StoredDynamicsEntry } from "./types.js";

export const MIN_TRUSTED_DELAY_SAMPLES = 5;
export const MAX_DELAY_MAD_SECONDS = 10;
export const DEFAULT_MEDIUM_INITIAL_SECONDS = 60;
export const DEFAULT_LONG_INITIAL_SECONDS = 90;
export const DEFAULT_LONG_COOLDOWN_SECONDS = 60;
export const MEDIUM_DELAY_PADDING_SECONDS = 15;
export const LONG_INITIAL_PADDING_SECONDS = 20;
export const COOLDOWN_PADDING_SECONDS = 15;
export const MAX_MEDIUM_INITIAL_SECONDS = 90;
export const MAX_LONG_INITIAL_SECONDS = 120;
export const MAX_LONG_COOLDOWN_SECONDS = 90;
export const MEDIUM_EVALUATION_TAIL_SECONDS = 10;
export const MIN_MEDIUM_EARLY_SECONDS = 45;
export const MIN_LONG_INITIAL_EARLY_SECONDS = 60;
export const MIN_LONG_COOLDOWN_EARLY_SECONDS = 45;
export const MIN_EARLY_TIMING_DETECTED_RESPONSES = 10;
export const MIN_EARLY_TIMING_DETECTION_RATE = 0.8;
export const MAX_EARLY_TIMING_MAD_SECONDS = 5;
export const EARLY_TIMING_CONCENTRATION_WINDOW_SECONDS = 10;
export const MIN_EARLY_TIMING_CONCENTRATION = 0.7;

export type TimingMode = "earlier" | "extended" | "mixed";
export type { PersonalizedWorkTiming };

export interface HighConfidenceRecentDelayEstimate {
  medianSeconds: number;
  observationCount: number;
  detectedCount: number;
  detectionRate: number;
  madSeconds: number;
  concentration: number;
}

type TimingEntry = Pick<StoredDynamicsEntry, "workStartDelays" | "increaseDelays" | "decreaseDelays"> &
  Partial<Pick<StoredDynamicsEntry, "workStartRecentResponses" | "increaseRecentResponses" | "decreaseRecentResponses">>;

export function delayMedianAbsoluteDeviation(samples: readonly number[]): number | undefined {
  return integerMedianAbsoluteDeviation(samples);
}

export function trustedDelayMedian(samples: readonly number[]): number | undefined {
  const values = samples.filter((value) => Number.isInteger(value) && Number.isFinite(value));
  if (values.length < MIN_TRUSTED_DELAY_SAMPLES) return undefined;
  const median = integerMedian(values);
  if (median === undefined) return undefined;
  const mad = delayMedianAbsoluteDeviation(values);
  if (mad === undefined || mad > MAX_DELAY_MAD_SECONDS) return undefined;
  return median;
}

function laterOnly(value: number, floor: number, cap: number): number {
  return Math.min(cap, Math.max(floor, value));
}

export function deriveMediumInitialEvaluationSeconds(
  trustedMedian: number | undefined,
  phaseDurationSeconds: number
): number {
  if (trustedMedian === undefined) return DEFAULT_MEDIUM_INITIAL_SECONDS;
  const candidate = laterOnly(
    trustedMedian + MEDIUM_DELAY_PADDING_SECONDS,
    DEFAULT_MEDIUM_INITIAL_SECONDS,
    MAX_MEDIUM_INITIAL_SECONDS
  );
  const latestUseful = phaseDurationSeconds - MEDIUM_EVALUATION_TAIL_SECONDS;
  if (latestUseful < DEFAULT_MEDIUM_INITIAL_SECONDS) return DEFAULT_MEDIUM_INITIAL_SECONDS;
  return Math.min(candidate, latestUseful);
}

export function deriveLongInitialEvaluationSeconds(trustedMedian: number | undefined): number {
  if (trustedMedian === undefined) return DEFAULT_LONG_INITIAL_SECONDS;
  return laterOnly(
    trustedMedian + LONG_INITIAL_PADDING_SECONDS,
    DEFAULT_LONG_INITIAL_SECONDS,
    MAX_LONG_INITIAL_SECONDS
  );
}

export function deriveLongCooldownSeconds(trustedMedian: number | undefined): number {
  if (trustedMedian === undefined) return DEFAULT_LONG_COOLDOWN_SECONDS;
  return laterOnly(
    trustedMedian + COOLDOWN_PADDING_SECONDS,
    DEFAULT_LONG_COOLDOWN_SECONDS,
    MAX_LONG_COOLDOWN_SECONDS
  );
}

export function highConfidenceRecentDelayEstimate(
  responses: readonly RecentHrResponse[] | undefined
): HighConfidenceRecentDelayEstimate | undefined {
  const recent = responses ?? [];
  const delays = recentDetectedDelays(recent);
  const detectedCount = recentDetectedCount(recent);
  const observationCount = recentObservationCount(recent);
  const detectionRate = recentDetectionRate(recent);
  if (detectedCount < MIN_EARLY_TIMING_DETECTED_RESPONSES) return undefined;
  if (detectionRate === undefined || detectionRate < MIN_EARLY_TIMING_DETECTION_RATE) return undefined;
  const medianSeconds = integerMedian(delays);
  if (medianSeconds === undefined) return undefined;
  const madSeconds = delayMedianAbsoluteDeviation(delays);
  if (madSeconds === undefined || madSeconds > MAX_EARLY_TIMING_MAD_SECONDS) return undefined;
  const concentration = delayConcentrationNearMedian(delays, EARLY_TIMING_CONCENTRATION_WINDOW_SECONDS);
  if (concentration === undefined || concentration < MIN_EARLY_TIMING_CONCENTRATION) return undefined;
  return {
    medianSeconds,
    observationCount,
    detectedCount,
    detectionRate,
    madSeconds,
    concentration,
  };
}

function clampEarly(value: number, floor: number, cap: number): number {
  return Math.min(cap, Math.max(floor, value));
}

export function deriveMediumEarlyEvaluationSeconds(
  trustedMedian: number | undefined,
  phaseDurationSeconds: number
): number | undefined {
  if (trustedMedian === undefined) return undefined;
  let candidate = clampEarly(
    trustedMedian + MEDIUM_DELAY_PADDING_SECONDS,
    MIN_MEDIUM_EARLY_SECONDS,
    MAX_MEDIUM_INITIAL_SECONDS
  );
  const latestUseful = phaseDurationSeconds - MEDIUM_EVALUATION_TAIL_SECONDS;
  if (latestUseful < MIN_MEDIUM_EARLY_SECONDS) return undefined;
  candidate = Math.min(candidate, latestUseful);
  if (candidate < MIN_MEDIUM_EARLY_SECONDS) return undefined;
  if (candidate >= DEFAULT_MEDIUM_INITIAL_SECONDS) return undefined;
  return candidate;
}

export function deriveLongEarlyInitialEvaluationSeconds(
  trustedMedian: number | undefined
): number | undefined {
  if (trustedMedian === undefined) return undefined;
  const candidate = clampEarly(
    trustedMedian + LONG_INITIAL_PADDING_SECONDS,
    MIN_LONG_INITIAL_EARLY_SECONDS,
    MAX_LONG_INITIAL_SECONDS
  );
  if (candidate >= DEFAULT_LONG_INITIAL_SECONDS) return undefined;
  return candidate;
}

export function deriveLongEarlyCooldownSeconds(trustedMedian: number | undefined): number | undefined {
  if (trustedMedian === undefined) return undefined;
  const candidate = clampEarly(
    trustedMedian + COOLDOWN_PADDING_SECONDS,
    MIN_LONG_COOLDOWN_EARLY_SECONDS,
    MAX_LONG_COOLDOWN_SECONDS
  );
  if (candidate >= DEFAULT_LONG_COOLDOWN_SECONDS) return undefined;
  return candidate;
}

function preferEarlier(
  existing: number | undefined,
  early: number | undefined,
  originalDefault: number
): number | undefined {
  if (early !== undefined && early < originalDefault) return early;
  return existing;
}

function timingHasValues(timing: PersonalizedWorkTiming): boolean {
  return (
    timing.initialEvaluationSeconds !== undefined ||
    timing.increaseCooldownSeconds !== undefined ||
    timing.decreaseCooldownSeconds !== undefined
  );
}

function deriveLaterOnlyMachineTiming(
  entry: TimingEntry,
  phaseDurationSeconds: number
): PersonalizedWorkTiming | undefined {
  const workStartMedian = trustedDelayMedian(entry.workStartDelays);
  const timing: PersonalizedWorkTiming = {};
  if (phaseDurationSeconds <= 150) {
    const initial = deriveMediumInitialEvaluationSeconds(workStartMedian, phaseDurationSeconds);
    if (initial > DEFAULT_MEDIUM_INITIAL_SECONDS) timing.initialEvaluationSeconds = initial;
  } else {
    const initial = deriveLongInitialEvaluationSeconds(workStartMedian);
    if (initial > DEFAULT_LONG_INITIAL_SECONDS) timing.initialEvaluationSeconds = initial;
    const increase = deriveLongCooldownSeconds(trustedDelayMedian(entry.increaseDelays));
    if (increase > DEFAULT_LONG_COOLDOWN_SECONDS) timing.increaseCooldownSeconds = increase;
    const decrease = deriveLongCooldownSeconds(trustedDelayMedian(entry.decreaseDelays));
    if (decrease > DEFAULT_LONG_COOLDOWN_SECONDS) timing.decreaseCooldownSeconds = decrease;
  }
  return timingHasValues(timing) ? timing : undefined;
}

export function derivePersonalizedMachineTiming(
  entry: TimingEntry | undefined,
  phaseDurationSeconds: number
): PersonalizedWorkTiming | undefined {
  if (!entry || phaseDurationSeconds <= 75) return undefined;
  const later = deriveLaterOnlyMachineTiming(entry, phaseDurationSeconds) ?? {};
  const timing: PersonalizedWorkTiming = { ...later };
  if (phaseDurationSeconds <= 150) {
    const early = deriveMediumEarlyEvaluationSeconds(
      highConfidenceRecentDelayEstimate(entry.workStartRecentResponses)?.medianSeconds,
      phaseDurationSeconds
    );
    const chosen = preferEarlier(later.initialEvaluationSeconds, early, DEFAULT_MEDIUM_INITIAL_SECONDS);
    if (chosen !== undefined) timing.initialEvaluationSeconds = chosen;
  } else {
    const earlyInitial = deriveLongEarlyInitialEvaluationSeconds(
      highConfidenceRecentDelayEstimate(entry.workStartRecentResponses)?.medianSeconds
    );
    const initial = preferEarlier(later.initialEvaluationSeconds, earlyInitial, DEFAULT_LONG_INITIAL_SECONDS);
    if (initial !== undefined) timing.initialEvaluationSeconds = initial;
    const earlyIncrease = deriveLongEarlyCooldownSeconds(
      highConfidenceRecentDelayEstimate(entry.increaseRecentResponses)?.medianSeconds
    );
    const increase = preferEarlier(later.increaseCooldownSeconds, earlyIncrease, DEFAULT_LONG_COOLDOWN_SECONDS);
    if (increase !== undefined) timing.increaseCooldownSeconds = increase;
    const earlyDecrease = deriveLongEarlyCooldownSeconds(
      highConfidenceRecentDelayEstimate(entry.decreaseRecentResponses)?.medianSeconds
    );
    const decrease = preferEarlier(later.decreaseCooldownSeconds, earlyDecrease, DEFAULT_LONG_COOLDOWN_SECONDS);
    if (decrease !== undefined) timing.decreaseCooldownSeconds = decrease;
  }
  return timingHasValues(timing) ? timing : undefined;
}

export function hasActiveTimingPersonalization(entry: TimingEntry, durationClass: WorkDurationClass): boolean {
  if (durationClass === "short") return false;
  const representativeDuration = durationClass === "medium" ? 120 : 240;
  return derivePersonalizedMachineTiming(entry, representativeDuration) !== undefined;
}

function classifyTimingValue(value: number | undefined, originalDefault: number): "earlier" | "extended" | undefined {
  if (value === undefined) return undefined;
  if (value < originalDefault) return "earlier";
  if (value > originalDefault) return "extended";
  return undefined;
}

export function timingModeForPersonalizedTiming(
  timing: PersonalizedWorkTiming | undefined,
  durationClass: WorkDurationClass
): TimingMode | undefined {
  if (!timing || durationClass === "short") return undefined;
  const classes =
    durationClass === "medium"
      ? [classifyTimingValue(timing.initialEvaluationSeconds, DEFAULT_MEDIUM_INITIAL_SECONDS)]
      : [
          classifyTimingValue(timing.initialEvaluationSeconds, DEFAULT_LONG_INITIAL_SECONDS),
          classifyTimingValue(timing.increaseCooldownSeconds, DEFAULT_LONG_COOLDOWN_SECONDS),
          classifyTimingValue(timing.decreaseCooldownSeconds, DEFAULT_LONG_COOLDOWN_SECONDS),
        ];
  const active = classes.filter((value): value is "earlier" | "extended" => value !== undefined);
  if (active.length === 0) return undefined;
  const hasEarlier = active.includes("earlier");
  const hasExtended = active.includes("extended");
  if (hasEarlier && hasExtended) return "mixed";
  return hasEarlier ? "earlier" : "extended";
}

export function timingModeForEntry(entry: TimingEntry, durationClass: WorkDurationClass): TimingMode | undefined {
  if (durationClass === "short") return undefined;
  const representativeDuration = durationClass === "medium" ? 120 : 240;
  return timingModeForPersonalizedTiming(derivePersonalizedMachineTiming(entry, representativeDuration), durationClass);
}
