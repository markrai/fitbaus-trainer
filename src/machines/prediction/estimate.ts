import { integerMedian, integerMedianAbsoluteDeviation } from "../hrQuality.js";
import {
  MAX_SHADOW_DOSE_MAD_BPM,
  MAX_SHADOW_RESISTANCE,
  MAX_SHADOW_SUGGESTED_LEVELS,
  MIN_SHADOW_DIRECTION_CONSISTENCY,
  MIN_SHADOW_DOSE_SAMPLES,
  MIN_SHADOW_RESISTANCE,
  type ShadowResistanceDirection,
} from "./types.js";

export interface TrustedDirectionalHrPerLevelEstimate {
  medianHrPerLevel: number;
  sampleCount: number;
  madBpm: number;
  signConsistency: number;
  direction: ShadowResistanceDirection;
}

export interface ShadowResistanceSuggestion {
  estimatedLevelsNeeded: number;
  shadowCappedLevels: number;
  shadowEffectiveLevels: number;
  shadowSuggestedResistance: number;
}

export function trustedDirectionalHrPerLevelEstimate(
  samples: readonly number[],
  direction: ShadowResistanceDirection
): TrustedDirectionalHrPerLevelEstimate | undefined {
  const values = samples.filter((value) => Number.isInteger(value) && Number.isFinite(value));
  if (values.length < MIN_SHADOW_DOSE_SAMPLES) return undefined;
  const medianHrPerLevel = integerMedian(values);
  if (medianHrPerLevel === undefined) return undefined;
  if (direction === "increase" && !(medianHrPerLevel > 0)) return undefined;
  if (direction === "decrease" && !(medianHrPerLevel < 0)) return undefined;
  const madBpm = integerMedianAbsoluteDeviation(values);
  if (madBpm === undefined || madBpm > MAX_SHADOW_DOSE_MAD_BPM) return undefined;
  const matching =
    direction === "increase" ? values.filter((value) => value > 0).length : values.filter((value) => value < 0).length;
  const signConsistency = matching / values.length;
  if (signConsistency < MIN_SHADOW_DIRECTION_CONSISTENCY) return undefined;
  return {
    medianHrPerLevel,
    sampleCount: values.length,
    madBpm,
    signConsistency,
    direction,
  };
}

function capSuggestedLevels(estimatedLevelsNeeded: number): number {
  if (estimatedLevelsNeeded <= 0) return 0;
  return Math.min(MAX_SHADOW_SUGGESTED_LEVELS, Math.max(1, estimatedLevelsNeeded));
}

function effectiveShadowLevels(fromResistance: number, suggestedResistance: number): number {
  return Math.abs(suggestedResistance - fromResistance);
}

function noChangeSuggestion(fromResistance: number): ShadowResistanceSuggestion {
  return {
    estimatedLevelsNeeded: 0,
    shadowCappedLevels: 0,
    shadowEffectiveLevels: 0,
    shadowSuggestedResistance: fromResistance,
  };
}

export function shadowIncreaseSuggestion(params: {
  preChangeHr: number;
  targetHeartRateMin: number;
  fromResistance: number;
  medianIncreaseHrPerLevel: number;
}): ShadowResistanceSuggestion | undefined {
  if (!(params.medianIncreaseHrPerLevel > 0)) return undefined;
  const deficit = params.targetHeartRateMin - params.preChangeHr;
  if (deficit <= 0) return noChangeSuggestion(params.fromResistance);
  const estimatedLevelsNeeded = Math.ceil(deficit / params.medianIncreaseHrPerLevel);
  const shadowCappedLevels = capSuggestedLevels(estimatedLevelsNeeded);
  const shadowSuggestedResistance = Math.min(MAX_SHADOW_RESISTANCE, params.fromResistance + shadowCappedLevels);
  return {
    estimatedLevelsNeeded,
    shadowCappedLevels,
    shadowEffectiveLevels: effectiveShadowLevels(params.fromResistance, shadowSuggestedResistance),
    shadowSuggestedResistance,
  };
}

export function shadowDecreaseSuggestion(params: {
  preChangeHr: number;
  targetHeartRateMax: number;
  fromResistance: number;
  medianDecreaseHrPerLevel: number;
}): ShadowResistanceSuggestion | undefined {
  if (!(params.medianDecreaseHrPerLevel < 0)) return undefined;
  const excess = params.preChangeHr - params.targetHeartRateMax;
  if (excess <= 0) return noChangeSuggestion(params.fromResistance);
  const estimatedLevelsNeeded = Math.ceil(excess / Math.abs(params.medianDecreaseHrPerLevel));
  const shadowCappedLevels = capSuggestedLevels(estimatedLevelsNeeded);
  const shadowSuggestedResistance = Math.max(MIN_SHADOW_RESISTANCE, params.fromResistance - shadowCappedLevels);
  return {
    estimatedLevelsNeeded,
    shadowCappedLevels,
    shadowEffectiveLevels: effectiveShadowLevels(params.fromResistance, shadowSuggestedResistance),
    shadowSuggestedResistance,
  };
}

export function predictedHrDeltaForActualStep(
  medianHrPerLevel: number,
  actualResistanceDelta: number
): number {
  return medianHrPerLevel * Math.abs(actualResistanceDelta);
}

export function predictedHrDeltaForShadowSuggestion(
  medianHrPerLevel: number,
  shadowEffectiveLevels: number
): number {
  return medianHrPerLevel * shadowEffectiveLevels;
}

export function directionMatched(
  direction: ShadowResistanceDirection,
  observedHrDelta: number
): boolean {
  return direction === "increase" ? observedHrDelta > 0 : observedHrDelta < 0;
}
