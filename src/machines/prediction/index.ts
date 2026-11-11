import { getHrSamples } from "../../workoutStorage.js";
import type { WorkoutSummary } from "../../types.js";
import { loadDynamicsStore, type DynamicsStorage } from "../dynamics/storage.js";
import type { LearningHrSample } from "../learning/types.js";
import { deriveShadowResistancePredictions } from "./derive.js";
import {
  persistShadowPredictions,
  hasProcessedShadowSession,
  type ShadowPredictionStorage,
} from "./storage.js";
import type { MachineShadowResistancePrediction } from "./types.js";

export {
  MAX_SHADOW_DOSE_MAD_BPM,
  MAX_SHADOW_RESISTANCE,
  MAX_SHADOW_SUGGESTED_LEVELS,
  MIN_SHADOW_DIRECTION_CONSISTENCY,
  MIN_SHADOW_DOSE_SAMPLES,
  MIN_SHADOW_RESISTANCE,
  SHADOW_PREDICTION_LIMIT,
  SHADOW_PREDICTION_STORAGE_KEY,
  SHADOW_PREDICTION_STORE_VERSION,
  type MachineShadowResistancePrediction,
  type ShadowDirectionDiagnostics,
  type ShadowPredictionStore,
  type ShadowResistanceDiagnostics,
  type ShadowResistanceDirection,
  type ShadowValidationStatus,
  type StoredShadowPredictionEntry,
} from "./types.js";
export {
  deriveShadowResistancePredictions,
} from "./derive.js";
export {
  directionMatched,
  predictedHrDeltaForActualStep,
  predictedHrDeltaForShadowSuggestion,
  shadowDecreaseSuggestion,
  shadowIncreaseSuggestion,
  trustedDirectionalHrPerLevelEstimate,
  type ShadowResistanceSuggestion,
  type TrustedDirectionalHrPerLevelEstimate,
} from "./estimate.js";
export {
  appendBoundedPredictions,
  emptyShadowPredictionStore,
  getShadowPredictionEntry,
  hasProcessedShadowSession,
  listShadowPredictions,
  loadShadowPredictionStore,
  markShadowSessionProcessed,
  persistShadowPredictions,
  resetShadowPredictionsForMachine,
  saveShadowPredictionStore,
  sanitizeShadowPredictionStore,
} from "./storage.js";
export {
  isOneLevelValidationOpportunity,
  MAX_SHADOW_VALIDATION_ABS_MEDIAN_BIAS_BPM,
  MAX_SHADOW_VALIDATION_MEDIAN_ABSOLUTE_ERROR_BPM,
  MIN_SHADOW_VALIDATION_DIRECTION_MATCH_RATE,
  MIN_SHADOW_VALIDATION_DISTINCT_SESSIONS,
  MIN_SHADOW_VALIDATION_REALIZATION_RATE,
  MIN_SHADOW_VALIDATION_REALIZED_PREDICTIONS,
  MIN_SHADOW_VALIDATION_WITHIN_TOLERANCE_RATE,
  realizedShadowValidation,
  SHADOW_VALIDATION_ERROR_TOLERANCE_BPM,
  shadowPredictionEventKey,
  shadowValidationStatusLabel,
  usableShadowSessionId,
  validateShadowDirection,
  type RealizedShadowValidation,
  type ShadowDirectionValidation,
} from "./validation.js";

export function applyCompletedWorkoutShadowPredictions(
  summary: WorkoutSummary,
  hrSamples: readonly LearningHrSample[],
  storage?: ShadowPredictionStorage & DynamicsStorage,
  updatedAt = new Date().toISOString()
): MachineShadowResistancePrediction[] {
  const sessionId = summary.external_session_id;
  if (hasProcessedShadowSession(sessionId, storage)) return [];
  const preWorkoutDynamics = loadDynamicsStore(storage);
  const predictions = deriveShadowResistancePredictions(summary, hrSamples, preWorkoutDynamics.entries);
  return persistShadowPredictions(predictions, storage, updatedAt, sessionId);
}

export function learnShadowPredictionsFromSamples(
  summary: WorkoutSummary,
  hrSamples: readonly LearningHrSample[],
  storage?: ShadowPredictionStorage & DynamicsStorage,
  updatedAt = new Date().toISOString()
): MachineShadowResistancePrediction[] {
  try {
    return applyCompletedWorkoutShadowPredictions(summary, hrSamples, storage, updatedAt);
  } catch (error) {
    console.error("Machine shadow-resistance prediction failed:", error);
    return [];
  }
}

export async function learnShadowPredictionsFromCompletedWorkout(
  summary: WorkoutSummary,
  storage?: ShadowPredictionStorage & DynamicsStorage
) {
  if (summary.cancelled) return [];
  try {
    const samples = await getHrSamples(summary.external_session_id);
    return learnShadowPredictionsFromSamples(
      summary,
      samples.map((sample) => ({ elapsedSeconds: sample.timestamp_sec, bpm: sample.hr })),
      storage
    );
  } catch (error) {
    console.error("Machine shadow-resistance prediction failed:", error);
    return [];
  }
}
