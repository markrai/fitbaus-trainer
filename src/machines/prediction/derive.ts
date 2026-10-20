import type { WorkoutSummary } from "../../types.js";
import { deriveHrDynamicsObservations, workoutEligibleForHrDynamics } from "../dynamics/derive.js";
import type { StoredDynamicsEntry } from "../dynamics/types.js";
import { learningKey, type LearningHrSample, type LearningKeyParts } from "../learning/types.js";
import {
  directionMatched,
  predictedHrDeltaForActualStep,
  predictedHrDeltaForShadowSuggestion,
  shadowDecreaseSuggestion,
  shadowIncreaseSuggestion,
  trustedDirectionalHrPerLevelEstimate,
} from "./estimate.js";
import type { MachineShadowResistancePrediction, ShadowResistanceDirection } from "./types.js";

function validTarget(value: number | undefined): value is number {
  return Number.isInteger(value) && Number.isFinite(value);
}

export function deriveShadowResistancePredictions(
  summary: Pick<
    WorkoutSummary,
    | "cancelled"
    | "activity"
    | "machine_id"
    | "machine_profile_version"
    | "intent"
    | "machine_guidance_trace"
    | "external_session_id"
  >,
  hrSamples: readonly LearningHrSample[],
  preWorkoutDynamics: Readonly<Record<string, StoredDynamicsEntry>>
): MachineShadowResistancePrediction[] {
  if (!workoutEligibleForHrDynamics(summary)) return [];
  const observations = deriveHrDynamicsObservations(summary, hrSamples);
  const predictions: MachineShadowResistancePrediction[] = [];
  for (const observation of observations) {
    if (observation.kind !== "resistance_increase" && observation.kind !== "resistance_decrease") continue;
    if (observation.fromResistance === undefined || observation.resistanceDelta === undefined) continue;
    if (observation.baselineHr === undefined) continue;
    if (!validTarget(observation.targetHeartRateMin) || !validTarget(observation.targetHeartRateMax)) continue;
    const direction: ShadowResistanceDirection =
      observation.kind === "resistance_increase" ? "increase" : "decrease";
    const parts: LearningKeyParts = {
      machineId: observation.machineId,
      machineProfileVersion: observation.machineProfileVersion,
      activity: observation.activity,
      intent: observation.intent,
      durationClass: observation.durationClass,
    };
    const entry = preWorkoutDynamics[learningKey(parts)];
    const samples = direction === "increase" ? entry?.increaseHrPerLevel ?? [] : entry?.decreaseHrPerLevel ?? [];
    const estimate = trustedDirectionalHrPerLevelEstimate(samples, direction);
    if (!estimate) continue;
    const suggestion =
      direction === "increase"
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
    if (!suggestion) continue;
    const actualDelta = observation.toResistance - observation.fromResistance;
    const predictedActual = predictedHrDeltaForActualStep(estimate.medianHrPerLevel, actualDelta);
    const predictedShadow = predictedHrDeltaForShadowSuggestion(
      estimate.medianHrPerLevel,
      suggestion.shadowEffectiveLevels
    );
    const prediction: MachineShadowResistancePrediction = {
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
