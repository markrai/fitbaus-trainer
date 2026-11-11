import { integerMedian, integerMedianAbsoluteDeviation } from "../hrQuality.js";
import { MAX_SHADOW_DOSE_MAD_BPM, MAX_SHADOW_RESISTANCE, MAX_SHADOW_SUGGESTED_LEVELS, MIN_SHADOW_DIRECTION_CONSISTENCY, MIN_SHADOW_DOSE_SAMPLES, MIN_SHADOW_RESISTANCE, } from "./types.js";
export function trustedDirectionalHrPerLevelEstimate(samples, direction) {
    const values = samples.filter((value) => Number.isInteger(value) && Number.isFinite(value));
    if (values.length < MIN_SHADOW_DOSE_SAMPLES)
        return undefined;
    const medianHrPerLevel = integerMedian(values);
    if (medianHrPerLevel === undefined)
        return undefined;
    if (direction === "increase" && !(medianHrPerLevel > 0))
        return undefined;
    if (direction === "decrease" && !(medianHrPerLevel < 0))
        return undefined;
    const madBpm = integerMedianAbsoluteDeviation(values);
    if (madBpm === undefined || madBpm > MAX_SHADOW_DOSE_MAD_BPM)
        return undefined;
    const matching = direction === "increase" ? values.filter((value) => value > 0).length : values.filter((value) => value < 0).length;
    const signConsistency = matching / values.length;
    if (signConsistency < MIN_SHADOW_DIRECTION_CONSISTENCY)
        return undefined;
    return {
        medianHrPerLevel,
        sampleCount: values.length,
        madBpm,
        signConsistency,
        direction,
    };
}
function capSuggestedLevels(estimatedLevelsNeeded) {
    if (estimatedLevelsNeeded <= 0)
        return 0;
    return Math.min(MAX_SHADOW_SUGGESTED_LEVELS, Math.max(1, estimatedLevelsNeeded));
}
function effectiveShadowLevels(fromResistance, suggestedResistance) {
    return Math.abs(suggestedResistance - fromResistance);
}
function noChangeSuggestion(fromResistance) {
    return {
        estimatedLevelsNeeded: 0,
        shadowCappedLevels: 0,
        shadowEffectiveLevels: 0,
        shadowSuggestedResistance: fromResistance,
    };
}
export function shadowIncreaseSuggestion(params) {
    if (!(params.medianIncreaseHrPerLevel > 0))
        return undefined;
    const deficit = params.targetHeartRateMin - params.preChangeHr;
    if (deficit <= 0)
        return noChangeSuggestion(params.fromResistance);
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
export function shadowDecreaseSuggestion(params) {
    if (!(params.medianDecreaseHrPerLevel < 0))
        return undefined;
    const excess = params.preChangeHr - params.targetHeartRateMax;
    if (excess <= 0)
        return noChangeSuggestion(params.fromResistance);
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
export function predictedHrDeltaForActualStep(medianHrPerLevel, actualResistanceDelta) {
    return medianHrPerLevel * Math.abs(actualResistanceDelta);
}
export function predictedHrDeltaForShadowSuggestion(medianHrPerLevel, shadowEffectiveLevels) {
    return medianHrPerLevel * shadowEffectiveLevels;
}
export function directionMatched(direction, observedHrDelta) {
    return direction === "increase" ? observedHrDelta > 0 : observedHrDelta < 0;
}
