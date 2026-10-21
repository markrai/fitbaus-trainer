/**
 * Personalization diagnostics data model: filters, presentation rows, summary
 * shapes, the diagnostics view model, frozen diagnostic contexts, and the E3
 * threshold longitudinal output shapes. Plain data; no DOM, no behavior.
 */

import type { PersonalizedPrescriptionCharacterizationAggregateV2 } from "../../personalizedPrescriptionCharacterization.js";
import type { PhasePerformedLoadView } from "../../performedLoad.js";
import type { ScientificAssessment } from "../../personalizationScientificAssessment.js";
import type { ScientificSessionEvidenceV2 } from "../../scientificSessionEvidence.js";
import type { PersonalizedPrescriptionCharacterization, PersonalizedPrescriptionCharacterizationExclusionReasonV1, PersonalizedPrescriptionFormalAssessmentProvenanceV2, PersonalizedPrescriptionPhaseCharacterizationV1, PersonalizedPrescriptionWorkloadProvenanceV1, WorkoutExecutionProvenanceV1, WorkoutSummary } from "../../types.js";

export const PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS: readonly PersonalizedPrescriptionCharacterizationExclusionReasonV1[] = [
  "phase_too_short",
  "missing_telemetry",
  "insufficient_hr_coverage",
  "insufficient_power_coverage",
  "insufficient_joint_coverage",
  "insufficient_settled_in_band_evidence",
  "unsupported_power_provenance",
  "phase_evidence_unavailable",
];

export interface PersonalizationDiagnosticsFilters {
  workoutIntent: string;
  intensity: string;
  calibrationProvenance: string;
  observedPowerProvenance: string;
  assessmentQuality: string;
  domainBucket: string;
}

export const EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS: PersonalizationDiagnosticsFilters = {
  workoutIntent: "all",
  intensity: "all",
  calibrationProvenance: "all",
  observedPowerProvenance: "all",
  assessmentQuality: "all",
  domainBucket: "all",
};
export interface PersonalizationDiagnosticsFilterOptions {
  workoutIntent: string[];
  intensity: string[];
  calibrationProvenance: string[];
  observedPowerProvenance: string[];
  assessmentQuality: string[];
  domainBucket: string[];
}

export interface PersonalizationDiagnosticPresentationRow {
  index: number;
  date: string;
  workout: string;
  phase: string;
  legacyHeartRate: string;
  candidateWatts: string;
  observedInBandWatts: number | null;
  deltaWatts: number | null;
  hrCoveragePercent: number;
  powerCoveragePercent: number;
  hrInsideTargetPercent: number | null;
  saturationPercent: number;
  calibrationProvenance: string;
  formalAssessmentProvenance: string;
  observedPowerProvenance: string;
  assessmentDomain: string;
  agreement: string;
  outcome: string;
  exclusion: string;
  assessmentContext: FrozenAssessmentDiagnosticContext | null;
  workoutContext: FrozenWorkoutDiagnosticContext | null;
  /** Durable WorkoutResponse observation only; never used to generate E1 candidates. */
  performedLoadPhase: PhasePerformedLoadView | null;
  /** Frozen execution provenance for the workout; runtime diagnostics only, never exported. */
  executionProvenance: WorkoutExecutionProvenanceV1 | null;
  record: PersonalizedPrescriptionCharacterization;
  phaseRecord: PersonalizedPrescriptionPhaseCharacterizationV1;
}

export interface PersonalizationEvidenceCollectionSummary {
  completedWorkoutsWithE2: number;
  candidatePhases: number;
  evaluableCandidatePhases: number;
  measuredToMeasuredObservations: number;
  cadenceCalibratedObservations: number;
  aerobicBaseCandidatePhases: number;
  aerobicVolumeCandidatePhases: number;
  interiorCandidatePhases: number;
  edgeCandidatePhases: number;
  saturatedCandidatePhases: number;
  saturationDeterminateCandidatePhases: number;
  saturationIncidence?: number;
  exclusionCounts: Record<PersonalizedPrescriptionCharacterizationExclusionReasonV1, number>;
}

/**
 * All-record E2 v3 held-workload forward-response counts. Phase medians are
 * summarized across phases; filters never affect this summary. Descriptive only.
 */
export interface PersonalizationHeldWorkloadForwardSummary {
  recordsWithHeldWorkloadEvidence: number;
  phasesWithHeldWorkloadSummary: number;
  characterizedPhases: number;
  measuredWattsCharacterizedPhases: number;
  calibratedWattsCharacterizedPhases: number;
  stableWindowCount: number;
  qualifyingWindowCount: number;
  qualifyingDurationSec: number;
  outsideCalibrationDomainSeconds: number;
  medianPhaseSignedErrorBpm?: number;
  medianPhaseAbsoluteErrorBpm?: number;
}

/** All-record execution-provenance counts. Descriptive only; filters never affect it. */
export interface PersonalizationExecutionProvenanceSummary {
  workoutsWithE2: number;
  workoutsWithProvenance: number;
  frozenMachineSelected: number;
  selectionChangedDuringWorkout: number;
  calibrationMachineAvailable: number;
  calibrationMachineUnavailable: number;
  calibrationMachineIntegrityFailures: number;
  sameMachineAndProfile: number;
  differentMachine: number;
  sameMachineDifferentProfile: number;
  incompleteActuationCapture: number;
}

/** One workout's E4A v2 join, summarized for developer diagnostics. */
export interface PersonalizationHeldActuationContextRow {
  workoutSessionId: string;
  createdAt: string;
  machineComparison: ScientificSessionEvidenceV2["machineComparison"];
  actuationCapture: ScientificSessionEvidenceV2["actuationCapture"];
  phaseCount: number;
  qualifyingWindowCount: number;
  qualifyingDurationSec: number;
  timedJoin: string;
  contexts: Record<"automatic_selected" | "programmatic_selected" | "no_app_selector_observed" | "unknown",
    { windowCount: number; durationSec: number }> | null;
}

export interface PersonalizationDiagnosticsModel {
  filters: PersonalizationDiagnosticsFilters;
  filterOptions: PersonalizationDiagnosticsFilterOptions;
  sourceRecordCount: number;
  records: PersonalizedPrescriptionCharacterization[];
  aggregate: PersonalizedPrescriptionCharacterizationAggregateV2;
  rows: PersonalizationDiagnosticPresentationRow[];
  exclusionCounts: Record<PersonalizedPrescriptionCharacterizationExclusionReasonV1, number>;
  evidenceCollectionSummary: PersonalizationEvidenceCollectionSummary;
  thresholdLongitudinal: ThresholdLongitudinalAnalysis;
  /** Runtime-only; never exported. */
  heldWorkloadForward: PersonalizationHeldWorkloadForwardSummary;
  /** Runtime-only; never exported. */
  executionProvenance: PersonalizationExecutionProvenanceSummary;
  /** Runtime-only E4A v2 join rows (one per workout); never exported. */
  heldActuationContext: PersonalizationHeldActuationContextRow[];
  /**
   * Runtime-only E4A scientific assessments under the frozen production
   * policy. Developer diagnostics only: never exported, never persisted,
   * `runtimeAuthority: false`. Empty when no `evaluatedAt` was supplied.
   */
  scientificAssessments: ScientificAssessment[];
}

export interface TrustedWorkoutHistoryRow {
  summary: WorkoutSummary;
}

export interface FrozenAssessmentDiagnosticContext {
  observedAt: string;
  quality: string;
  calibrationProvenance: PersonalizedPrescriptionWorkloadProvenanceV1;
  observedMinHeartRateBpm: number;
  observedMaxHeartRateBpm: number;
  observedMinWatts: number;
  observedMaxWatts: number;
  fitnessStateSchemaVersion?: number;
  algorithm?: { id: string; version: number };
  protocol?: { id: string; version: number };
  evidenceSessionIds?: string[];
}

export interface FrozenWorkoutDiagnosticContext {
  appVersion: string | null;
  machineId: string | null;
  machineProfileVersion: number | null;
  activePrescriptionSchemaVersion: number | null;
  shadowSchemaVersion: number | null;
  characterizationSchemaVersion: number;
}
/**
 * Frozen formal-assessment identity used by the read-time E3 projection.
 * Regression coefficients plus FitnessState container schema/timestamps are
 * deliberately excluded: the evidence set plus versioned estimator/protocol
 * contract defines the deterministic calibration, while workload provenance
 * distinguishes its units.
 */
export interface ThresholdCalibrationIdentity {
  evidenceSessionIds: string[];
  estimator: PersonalizedPrescriptionFormalAssessmentProvenanceV2["algorithm"];
  protocol: PersonalizedPrescriptionFormalAssessmentProvenanceV2["protocol"];
  workloadProvenance: PersonalizedPrescriptionWorkloadProvenanceV1;
  observedAt: string;
}

export interface ThresholdLongitudinalCohortKey {
  athleteId: string;
  calibration: ThresholdCalibrationIdentity;
  observedPowerProvenance: PersonalizedPrescriptionPhaseCharacterizationV1["observedPowerProvenance"];
  machineId: string;
  machineProfileVersion: number;
}

export type ThresholdLongitudinalExclusionReason =
  | "multiple_threshold_phases"
  | "incomplete_calibration_identity"
  | "missing_machine_identity"
  | "missing_machine_profile_identity"
  | "invalid_longitudinal_metrics";

export interface ThresholdLongitudinalExclusion {
  workoutSessionId: string;
  createdAt: string;
  reason: ThresholdLongitudinalExclusionReason;
}

export interface ThresholdLongitudinalSession {
  workoutSessionId: string;
  createdAt: string;
  athleteId: string;
  calibrationIdentity: ThresholdCalibrationIdentity;
  observedPowerProvenance: PersonalizedPrescriptionPhaseCharacterizationV1["observedPowerProvenance"];
  machineId: string;
  machineProfileVersion: number;
  domainBucket: string;
  candidateMinWatts: number;
  candidateMaxWatts: number;
  candidateWidthWatts: number;
  candidateMidpointWatts: number;
  observedSettledWatts: number;
  signedDifferenceWatts: number;
  absoluteDifferenceWatts: number;
  signedDifferencePercent: number;
  widthNormalizedAbsoluteError: number | null;
  saturationRatio: number;
  assessmentAgeDays: number | null;
}

export interface ThresholdLongitudinalCohort {
  key: ThresholdLongitudinalCohortKey;
  sessionCount: number;
  sessions: ThresholdLongitudinalSession[];
  medianSignedDifferenceWatts?: number;
  medianAbsoluteDifferenceWatts?: number;
  medianCandidateWidthWatts?: number;
  medianWidthNormalizedAbsoluteError?: number;
  observedSettledWattsCv?: number;
  saturationIncidence?: number;
  medianAssessmentAgeDays?: number;
}

export interface ThresholdLongitudinalAnalysis {
  sessionCount: number;
  cohorts: ThresholdLongitudinalCohort[];
  exclusions: ThresholdLongitudinalExclusion[];
}
