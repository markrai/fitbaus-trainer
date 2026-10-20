import type { Activity } from "../../types.js";
import type { MachineId } from "../trace.js";
import type { WorkDurationClass } from "../learning/types.js";

export type { WorkDurationClass };

export const SHADOW_PREDICTION_STORAGE_KEY = "fitbaus_trainer_shadow_resistance_predictions";
export const SHADOW_PREDICTION_STORE_VERSION = 1 as const;
export const SHADOW_PREDICTION_LIMIT = 20;
export const MIN_SHADOW_DOSE_SAMPLES = 5;
export const MAX_SHADOW_DOSE_MAD_BPM = 5;
export const MIN_SHADOW_DIRECTION_CONSISTENCY = 0.7;
export const MAX_SHADOW_SUGGESTED_LEVELS = 3;
export const MIN_SHADOW_RESISTANCE = 1;
export const MAX_SHADOW_RESISTANCE = 15;

export type ShadowResistanceDirection = "increase" | "decrease";

export interface MachineShadowResistancePrediction {
  version: 1;
  sessionId?: string;
  machineId: MachineId;
  machineProfileVersion: number;
  activity: Activity;
  intent: string;
  durationClass: WorkDurationClass;
  phaseId: string;
  intervalIndex?: number;
  changeElapsedSeconds: number;
  direction: ShadowResistanceDirection;
  fromResistance: number;
  actualToResistance: number;
  preChangeHr: number;
  targetHeartRateMin: number;
  targetHeartRateMax: number;
  modelSampleCount: number;
  modelMedianHrPerLevel: number;
  modelMadBpm: number;
  modelDirectionConsistency: number;
  estimatedLevelsNeeded: number;
  shadowCappedLevels: number;
  shadowEffectiveLevels: number;
  shadowSuggestedResistance: number;
  predictedHrDeltaForActualStep: number;
  predictedSettledHrAfterActualStep: number;
  predictedHrDeltaForShadowSuggestion: number;
  predictedHrAtShadowSuggestion: number;
  observedHrDelta?: number;
  predictionErrorBpm?: number;
  absolutePredictionErrorBpm?: number;
  directionMatched?: boolean;
}

export interface StoredShadowPredictionEntry {
  increase: MachineShadowResistancePrediction[];
  decrease: MachineShadowResistancePrediction[];
  updatedAt: string;
}

export interface ShadowPredictionStore {
  version: 1;
  entries: Record<string, StoredShadowPredictionEntry>;
  processedSessions: string[];
}

export type ShadowValidationStatus = "collecting" | "not_validated" | "validated";

export interface ShadowDirectionDiagnostics {
  modelMedianHrPerLevel: number;
  predictionCount: number;
  medianAbsolutePredictionErrorBpm?: number;
  medianSignedPredictionErrorBpm?: number;
  directionMatchCount: number;
  directionEvaluatedCount: number;
  directionMatchRate?: number;
  validationStatus: ShadowValidationStatus;
  validationHighConfidence: boolean;
  validationOpportunityCount: number;
  realizedPredictionCount: number;
  realizationRate?: number;
  distinctSessionCount: number;
  withinToleranceCount: number;
  withinToleranceRate?: number;
}

export interface ShadowResistanceDiagnostics {
  machineId: MachineId;
  machineProfileVersion: number;
  activity: Activity;
  intent: string;
  durationClass: WorkDurationClass;
  increase?: ShadowDirectionDiagnostics;
  decrease?: ShadowDirectionDiagnostics;
  updatedAt: string;
}
