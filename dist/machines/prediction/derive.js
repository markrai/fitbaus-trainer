import { deriveHrDynamicsObservations, workoutEligibleForHrDynamics } from "../dynamics/derive.js";
import { learningKey } from "../learning/types.js";
import { directionMatched, predictedHrDeltaForActualStep, predictedHrDeltaForShadowSuggestion, shadowDecreaseSuggestion, shadowIncreaseSuggestion, trustedDirectionalHrPerLevelEstimate, } from "./estimate.js";
function validTarget(value) {
    return Number.isInteger(value) && Number.isFinite(value);
}
export function deriveShadowResistancePredictions(summary, hrSamples, preWorkoutDynamics) {
    var _a, _b;
    if (!workoutEligibleForHrDynamics(summary))
        return [];
    const observations = deriveHrDynamicsObservations(summary, hrSamples);
    const predictions = [];
    for (const observation of observations) {
        if (observation.kind !== "resistance_increase" && observation.kind !== "resistance_decrease")
            continue;
        if (observation.fromResistance === undefined || observation.resistanceDelta === undefined)
            continue;
        if (observation.baselineHr === undefined)
            continue;
        if (!validTarget(observation.targetHeartRateMin) || !validTarget(observation.targetHeartRateMax))
            continue;
        const direction = observation.kind === "resistance_increase" ? "increase" : "decrease";
        const parts = {
            machineId: observation.machineId,
            machineProfileVersion: observation.machineProfileVersion,
            activity: observation.activity,
            intent: observation.intent,
            durationClass: observation.durationClass,
        };
        const entry = preWorkoutDynamics[learningKey(parts)];
        const samples = direction === "increase" ? (_a = entry === null || entry === void 0 ? void 0 : entry.increaseHrPerLevel) !== null && _a !== void 0 ? _a : [] : (_b = entry === null || entry === void 0 ? void 0 : entry.decreaseHrPerLevel) !== null && _b !== void 0 ? _b : [];
        const estimate = trustedDirectionalHrPerLevelEstimate(samples, direction);
        if (!estimate)
            continue;
        const suggestion = direction === "increase"
            ? shadowIncreaseSuggestion({
                preChangeHr: observation.baselineHr,
                targetHeartRateMin: observation.targetHeartRateMin,
                fromResistance: observation.fromResistance,
                medianIncreaseHrPerLevel: estimate.medianHrPerLevel,
            })
            : shadowDecreaseSuggestion({
                preChangeHr: observation.baselineHr,
                targetHeartRateMax: observation.targetHeartRateMax,
                fromResistance: observation.fromResistance,
                medianDecreaseHrPerLevel: estimate.medianHrPerLevel,
            });
        if (!suggestion)
            continue;
        const actualDelta = observation.toResistance - observation.fromResistance;
        const predictedActual = predictedHrDeltaForActualStep(estimate.medianHrPerLevel, actualDelta);
        const predictedShadow = predictedHrDeltaForShadowSuggestion(estimate.medianHrPerLevel, suggestion.shadowEffectiveLevels);
        const prediction = {
            version: 1,
            sessionId: summary.external_session_id,
            machineId: observation.machineId,
            machineProfileVersion: observation.machineProfileVersion,
            activity: observation.activity,
            intent: observation.intent,
            durationClass: observation.durationClass,
            phaseId: observation.phaseId,
            intervalIndex: observation.intervalIndex,
            changeElapsedSeconds: observation.changeElapsedSeconds,
            direction,
            fromResistance: observation.fromResistance,
            actualToResistance: observation.toResistance,
            preChangeHr: observation.baselineHr,
            targetHeartRateMin: observation.targetHeartRateMin,
            targetHeartRateMax: observation.targetHeartRateMax,
            modelSampleCount: estimate.sampleCount,
            modelMedianHrPerLevel: estimate.medianHrPerLevel,
            modelMadBpm: estimate.madBpm,
            modelDirectionConsistency: estimate.signConsistency,
            estimatedLevelsNeeded: suggestion.estimatedLevelsNeeded,
            shadowCappedLevels: suggestion.shadowCappedLevels,
            shadowEffectiveLevels: suggestion.shadowEffectiveLevels,
            shadowSuggestedResistance: suggestion.shadowSuggestedResistance,
            predictedHrDeltaForActualStep: predictedActual,
            predictedSettledHrAfterActualStep: observation.baselineHr + predictedActual,
            predictedHrDeltaForShadowSuggestion: predictedShadow,
            predictedHrAtShadowSuggestion: observation.baselineHr + predictedShadow,
        };
        if (observation.hrDelta !== undefined) {
            prediction.observedHrDelta = observation.hrDelta;
            prediction.predictionErrorBpm = observation.hrDelta - predictedActual;
            prediction.absolutePredictionErrorBpm = Math.abs(prediction.predictionErrorBpm);
            prediction.directionMatched = directionMatched(direction, observation.hrDelta);
        }
        predictions.push(prediction);
    }
    return predictions;
}
