import type { Activity } from "../../types.js";
import type { WorkDurationClass } from "../learning/types.js";
import type { TimingMode } from "../dynamics/timing.js";
import type { MachineId } from "../trace.js";
import type { MachineShadowResistancePrediction, ShadowValidationStatus } from "../prediction/types.js";

export const MACHINE_DIAGNOSTICS_SNAPSHOT_VERSION = 1 as const;

export interface MachineDiagnosticsIdentity {
  machineId: MachineId;
  machineName: string;
  activity: Activity;
  machineProfileVersion: number;
}

export interface MachineDiagnosticsSummary {
  learnedStartEntries: number;
  hrDynamicsEntries: number;
  shadowPredictionEntries: number;
  processedShadowSessions: number;
  validatedDirections: number;
}

export interface MachineDiagnosticsLearnedStart {
  machineId: MachineId;
  machineProfileVersion: number;
  activity: Activity;
  intent: string;
  durationClass: WorkDurationClass;
  resistance: number;
  sampleCount: number;
  updatedAt: string;
}

export interface MachineDiagnosticsTiming {
  durationClass: WorkDurationClass;
  timingMode?: TimingMode;
  defaultInitialEvaluationSeconds: number;
  defaultCooldownSeconds?: number;
  laterTimingEvidenceQualifies: boolean;
  earlyTimingEvidenceQualifies: boolean;
}

export interface MachineDiagnosticsHrDynamics {
  machineId: MachineId;
  machineProfileVersion: number;
  activity: Activity;
  intent: string;
  durationClass: WorkDurationClass;
  medianWorkStartDelaySeconds?: number;
  medianIncreaseDelaySeconds?: number;
  medianDecreaseDelaySeconds?: number;
  medianIncreaseHrDeltaPerStep?: number;
  medianDecreaseHrDeltaPerStep?: number;
  workStartObservationCount: number;
  workStartDetectedResponseCount: number;
  increaseObservationCount: number;
  increaseDetectedResponseCount: number;
  decreaseObservationCount: number;
  decreaseDetectedResponseCount: number;
  workStartRecentObservationCount: number;
  workStartRecentDetectedResponseCount: number;
  workStartRecentDetectionRate?: number;
  increaseRecentObservationCount: number;
  increaseRecentDetectedResponseCount: number;
  increaseRecentDetectionRate?: number;
  decreaseRecentObservationCount: number;
  decreaseRecentDetectedResponseCount: number;
  decreaseRecentDetectionRate?: number;
  timingPersonalized?: boolean;
  timing?: MachineDiagnosticsTiming;
  updatedAt: string;
}

export interface MachineDiagnosticsCountProgress {
  current: number;
  required: number;
}

export interface MachineDiagnosticsRateProgress {
  current?: number;
  required: number;
  passes: boolean;
}

export interface MachineDiagnosticsMaximumProgress {
  current?: number;
  maximum: number;
  passes: boolean;
}

export interface MachineDiagnosticsValidationProgress {
  realized: MachineDiagnosticsCountProgress;
  sessions: MachineDiagnosticsCountProgress;
  realizationRate: MachineDiagnosticsRateProgress;
  medianAbsoluteErrorBpm: MachineDiagnosticsMaximumProgress;
  absoluteMedianBiasBpm: MachineDiagnosticsMaximumProgress;
  directionMatchRate: MachineDiagnosticsRateProgress;
  withinToleranceRate: MachineDiagnosticsRateProgress;
}

export interface MachineDiagnosticsEvidence {
  status: ShadowValidationStatus;
  realizedNeeded: number;
  sessionsNeeded: number;
}

export interface MachineDiagnosticsShadowDirection {
  modelMedianHrPerLevel: number;
  predictionCount: number;
  validationStatus: ShadowValidationStatus;
  validationHighConfidence: boolean;
  validationOpportunityCount: number;
  realizedPredictionCount: number;
  realizationRate?: number;
  distinctSessionCount: number;
  medianAbsolutePredictionErrorBpm?: number;
  medianSignedPredictionErrorBpm?: number;
  directionMatchCount: number;
  directionEvaluatedCount: number;
  directionMatchRate?: number;
  withinToleranceCount: number;
  withinToleranceRate?: number;
  progress: MachineDiagnosticsValidationProgress;
  evidence: MachineDiagnosticsEvidence;
  events?: MachineShadowResistancePrediction[];
}

export interface MachineDiagnosticsShadowEntry {
  machineId: MachineId;
  machineProfileVersion: number;
  activity: Activity;
  intent: string;
  durationClass: WorkDurationClass;
  increase?: MachineDiagnosticsShadowDirection;
  decrease?: MachineDiagnosticsShadowDirection;
  updatedAt: string;
}

export interface MachineDiagnosticsShadowPrediction {
  processedSessionCount: number;
  predictionEventSessionCount: number;
  entries: MachineDiagnosticsShadowEntry[];
}

export interface MachineDiagnosticsSnapshot {
  version: typeof MACHINE_DIAGNOSTICS_SNAPSHOT_VERSION;
  generatedAt: string;
  appVersion: string;
  machine?: MachineDiagnosticsIdentity;
  summary: MachineDiagnosticsSummary;
  learnedStarts: MachineDiagnosticsLearnedStart[];
  hrDynamics: MachineDiagnosticsHrDynamics[];
  shadowPrediction: MachineDiagnosticsShadowPrediction;
}

export interface BuildMachineDiagnosticsSnapshotOptions {
  storage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  generatedAt?: string;
  includeRawShadowEvents?: boolean;
}

export interface MachineDiagnosticsExport {
  filename: string;
  mimeType: "application/json";
  body: string;
}
