import type { MachineDecisionAuditEntry } from "./machines/audit/types.js";
import type { MachineGuidanceTraceEntry, MachineId } from "./machines/trace.js";

export type DayName =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday";

export interface PlanBlock {
  warm: number;
  sustain: number;
  cool: number;
}

export type Activity = "bike" | "elliptical" | "strength";

export type WorkoutPhaseKind = "warmup" | "work" | "recovery" | "cooldown";

export type PhaseIntensityId =
  | "warmup_easy"
  | "aerobic_base"
  | "threshold"
  | "vo2_short"
  | "vo2_long"
  | "recovery"
  | "cooldown"
  | "strength_support";

export const WORKOUT_PRESCRIPTION_SCHEMA_VERSION = 1 as const;
/** Permanent identity for the Phase A resolver; keep readable after newer resolvers ship. */
export const LEGACY_HR_TARGET_RESOLVER_ID = "legacy-hr-target-resolver" as const;
export const LEGACY_HR_TARGET_RESOLVER_VERSION = 1 as const;
/** Resolver used for new resolutions in this build. */
export const WORKOUT_PRESCRIPTION_RESOLVER_ID = LEGACY_HR_TARGET_RESOLVER_ID;
export const WORKOUT_PRESCRIPTION_RESOLVER_VERSION = LEGACY_HR_TARGET_RESOLVER_VERSION;

export interface ResolvedHeartRateTarget {
  min?: number;
  max?: number;
}

export type ResolvedTargetQuality = "unverified" | "low" | "moderate" | "high";

export interface ResolvedWorkoutPhaseTarget {
  phaseId: string;
  kind: WorkoutPhaseKind;
  intensityId?: PhaseIntensityId;
  detailName?: string;
  intervalIndex?: number;
  activeStartSec?: number;
  activeEndSec?: number;
  expectedHeartRate?: ResolvedHeartRateTarget;
  /** Original plan value, retained only so current UI wording remains exact. */
  displayTargetHrBpm?: string | number;
  source: "legacy_fallback" | "no_numeric_target";
  quality: ResolvedTargetQuality;
  explanationCode: "legacy_target_hr_bpm" | "no_numeric_target";
}

export interface ResolvedWorkoutPrescription {
  schemaVersion: typeof WORKOUT_PRESCRIPTION_SCHEMA_VERSION;
  resolver: {
    /** Data, not the currently compiled resolver literal; historical identities remain representable. */
    id: string;
    version: number;
  };
  workoutSelector: string;
  resolvedAt: string;
  phases: ResolvedWorkoutPhaseTarget[];
}

/**
 * Permanent Phase E1 shadow schema identity.
 * E1 is the canonical shadow athlete-relative mechanical workload prescription
 * derived from formal calibration for supported ordinary-workout phases.
 * It does not personalize the active heart-rate prescription and has no control authority.
 */
export const PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1 = 1 as const;
export const PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1 = "personalized-prescription-resolver" as const;
export const PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1 = 1 as const;

export type PersonalizedPrescriptionFallbackReasonV1 =
  | "unsupported_activity"
  | "unsupported_workout"
  | "unsupported_phase"
  | "missing_numeric_hr_target"
  | "missing_profile"
  | "missing_fitness_state"
  | "athlete_mismatch"
  | "unsupported_fitness_schema"
  | "missing_formal_calibration"
  | "unsupported_calibration_source"
  | "low_quality_calibration"
  | "unsupported_algorithm"
  | "unsupported_protocol"
  | "invalid_calibration"
  | "insufficient_calibration_points"
  | "profile_input_mismatch"
  | "assessment_stale"
  | "mixed_or_unknown_workload_provenance"
  | "outside_observed_hr_range"
  | "outside_observed_workload_range"
  | "invalid_candidate";

export type PersonalizedPrescriptionCheckV1 = boolean | null;

export interface PersonalizedPrescriptionSafetyChecksV1 {
  athleteOwnershipValid: PersonalizedPrescriptionCheckV1;
  evidenceSchemaValid: PersonalizedPrescriptionCheckV1;
  formalSourceValid: PersonalizedPrescriptionCheckV1;
  qualityValid: PersonalizedPrescriptionCheckV1;
  profileInputsMatch: PersonalizedPrescriptionCheckV1;
  freshnessValid: PersonalizedPrescriptionCheckV1;
  phaseSupported: PersonalizedPrescriptionCheckV1;
  boundedHeartRateAvailable: PersonalizedPrescriptionCheckV1;
  heartRateDomainValid: PersonalizedPrescriptionCheckV1;
  workloadDomainValid: PersonalizedPrescriptionCheckV1;
  candidateValid: PersonalizedPrescriptionCheckV1;
}

export interface PersonalizedPrescriptionProfileSnapshotV1 {
  profileSchemaVersion: typeof ATHLETE_PROFILE_SCHEMA_VERSION_V1;
  profileUpdatedAt: string;
  ageYears?: number;
  bodyMassKg?: number;
}

export type PersonalizedPrescriptionWorkloadProvenanceV1 =
  | "measured_watts"
  | "calibrated_at_verified_cadence"
  | "mixed";

export interface PersonalizedPrescriptionFitnessEvidenceSnapshotV1 {
  fitnessStateSchemaVersion:
    | typeof FITNESS_STATE_SCHEMA_VERSION_V1
    | typeof FITNESS_STATE_SCHEMA_VERSION_V2
    | typeof FITNESS_STATE_SCHEMA_VERSION_V3;
  fitnessUpdatedAt: string;
  metricObservedAt: string;
  metricUpdatedAt: string;
  quality: "low" | "moderate" | "high" | "unverified";
  algorithm: {
    id: string;
    version: number;
  };
  evidenceSessionIds: string[];
  calibration: {
    slopeBpmPerWatt: number;
    interceptBpm: number;
    rSquared: number;
    observedMinWatts: number;
    observedMaxWatts: number;
    points: HrWorkloadCalibrationPoint[];
    protocol: {
      id: string;
      version: number;
    };
    workloadProvenance: PersonalizedPrescriptionWorkloadProvenanceV1;
    /** Audit-only demographic estimate. The E1 calculation never consumes it. */
    predictedHrMaxBpm: number;
    predictedHrMaxSource: "demographic_estimate";
    profileInputSnapshot: {
      ageYears: number;
      bodyMassKg: number;
    };
  };
}

export interface PersonalizedPrescriptionPolicyV1 {
  /** Null means freshness is recorded as not evaluated; this remains shadow-only. */
  assessmentExpiryDays: number | null;
  assessmentExpiryPolicy: "not_configured" | "provisional_characterization";
  allowedIntensities: ["aerobic_base", "threshold"];
  roundingRule: "nearest_integer_watt";
  extrapolationPolicy: "none";
}

export interface PersonalizedPrescriptionPhaseEvaluationV1 {
  phaseId: string;
  kind: WorkoutPhaseKind;
  intensityId?: PhaseIntensityId;
  detailName?: string;
  intervalIndex?: number;
  activeStartSec?: number;
  activeEndSec?: number;
  /**
   * Exact authoritative legacy HR bounds used by UI/control, copied rather than recalculated.
   * This is the active physiological prescription, not a personalized HR band.
   */
  activeHeartRate?: ResolvedHeartRateTarget;
  /**
   * Shadow athlete-relative mechanical workload associated with the active HR region.
   * Descriptive interpolation candidate only; never a controller target.
   */
  candidatePower?: {
    minWatts: number;
    maxWatts: number;
  };
  outcome: "candidate" | "fallback";
  fallbackReason?: PersonalizedPrescriptionFallbackReasonV1;
  safetyChecks: PersonalizedPrescriptionSafetyChecksV1;
}

/**
 * Frozen start-time E1 record. The legacy heart-rate prescription remains active
 * control authority. E1 estimates the athlete-specific mechanical workload
 * associated with that physiological region and records it for shadow evaluation.
 */
export interface PersonalizedPrescriptionEvaluationV1 {
  schemaVersion: typeof PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1;
  resolver: {
    id: typeof PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1;
    version: typeof PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1;
  };
  mode: "shadow";
  /** E1 candidates are characterized only and can never imply approval for active control. */
  activationEligible: false;
  resolvedAt: string;
  workoutSelector: string;
  workoutIntent: string;
  activity: Activity;
  athleteId: string;
  profileInputSnapshot: PersonalizedPrescriptionProfileSnapshotV1 | null;
  fitnessEvidenceSnapshot: PersonalizedPrescriptionFitnessEvidenceSnapshotV1 | null;
  policy: PersonalizedPrescriptionPolicyV1;
  phases: PersonalizedPrescriptionPhaseEvaluationV1[];
}

/** Permanent Phase E2 diagnostic schema. This record has no control authority. */
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V1 = 1 as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V2 = 2 as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3 = 3 as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION =
  PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1 =
  "personalized-prescription-characterization" as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V1 = 1 as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V2 = 2 as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V3 = 3 as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION =
  PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V3;

export type PersonalizedPrescriptionCharacterizationOutcomeV1 =
  | "characterized"
  | "insufficient_evidence"
  | "not_candidate"
  | "unsupported_observed_provenance"
  | "telemetry_unavailable";

export type PersonalizedPrescriptionCharacterizationExclusionReasonV1 =
  | "phase_too_short"
  | "missing_telemetry"
  | "insufficient_hr_coverage"
  | "insufficient_power_coverage"
  | "insufficient_joint_coverage"
  | "insufficient_settled_in_band_evidence"
  | "unsupported_power_provenance"
  | "phase_evidence_unavailable";

export interface PersonalizedPrescriptionCharacterizationPolicyV1 {
  id: "e2-characterization-policy";
  version: 1;
  minObservedPhaseDurationSec: number;
  minHrCoverageRatio: number;
  minPowerCoverageRatio: number;
  minJointCoverageRatio: number;
  settlingSeconds: number;
  minSettledInBandSeconds: number;
  heartRateChangeWindowSeconds: number;
  minHeartRateChangeWindowSamples: number;
  domainEdgeFraction: number;
}

export interface PersonalizedPrescriptionEvidenceCoverageV1 {
  plannedDurationSec: number;
  observedDurationSec: number;
  hrCoveredSeconds: number;
  powerCoveredSeconds: number;
  jointCoveredSeconds: number;
  hrCoverageRatio: number;
  powerCoverageRatio: number;
  jointCoverageRatio: number;
}

export interface PersonalizedPrescriptionObservedHeartRateV1 {
  sampleCount: number;
  meanBpm: number;
  medianBpm: number;
  minBpm: number;
  maxBpm: number;
  belowBandSeconds: number;
  insideBandSeconds: number;
  aboveBandSeconds: number;
  insideBandRatio: number;
  earlyWindowMedianBpm?: number;
  lateWindowMedianBpm?: number;
  heartRateChangeLateVsEarlyBpm?: number;
}

export interface PersonalizedPrescriptionObservedPowerV1 {
  provenance: "measured_watts" | "calibrated_watts";
  sampleCount: number;
  medianWatts: number;
  q1Watts: number;
  q3Watts: number;
  minWatts: number;
  maxWatts: number;
  belowCandidateSeconds: number;
  insideCandidateSeconds: number;
  aboveCandidateSeconds: number;
  insideCandidateRatio: number;
}

export interface PersonalizedPrescriptionStableInBandWorkloadV1 {
  sampleCount: number;
  medianWatts: number;
  q1Watts: number;
  q3Watts: number;
  minWatts: number;
  maxWatts: number;
}

export interface PersonalizedPrescriptionResistanceCoverageV1 {
  coveredSeconds: number;
  lowerBoundSeconds: number;
  upperBoundSeconds: number;
}

export interface PersonalizedPrescriptionControllerContextV1 {
  available: boolean;
  observed: PersonalizedPrescriptionResistanceCoverageV1;
  desired: PersonalizedPrescriptionResistanceCoverageV1;
  commanded: PersonalizedPrescriptionResistanceCoverageV1;
  anyBoundarySaturationSeconds: number;
  saturationRatio: number;
  lowerBoundaryDecisionCount: number;
  upperBoundaryDecisionCount: number;
}

export interface PersonalizedPrescriptionCandidateDomainMarginsV1 {
  heartRateToLowerBoundaryBpm: number;
  heartRateToUpperBoundaryBpm: number;
  wattsToLowerBoundary: number;
  wattsToUpperBoundary: number;
  bucket: "edge" | "interior";
}

export interface PersonalizedPrescriptionCandidateComparisonV1 {
  candidateMidpointWatts: number;
  observedInBandMedianWatts: number;
  signedDifferenceWatts: number;
  absoluteDifferenceWatts: number;
  signedDifferencePercent: number;
  candidateContainsObservedMedian: boolean;
  candidateObservedOverlapWatts: number;
  candidateObservedOverlapRatio: number;
  agreement: "inside_candidate" | "below_candidate" | "above_candidate";
}

export interface PersonalizedPrescriptionPhaseCharacterizationV1 {
  phaseId: string;
  kind: WorkoutPhaseKind;
  intensityId?: PhaseIntensityId;
  detailName?: string;
  intervalIndex?: number;
  activeStartSec?: number;
  activeEndSec?: number;
  shadowOutcome: "candidate" | "fallback";
  fallbackReason?: PersonalizedPrescriptionFallbackReasonV1;
  legacyHeartRate?: ResolvedHeartRateTarget;
  candidatePower?: { minWatts: number; maxWatts: number };
  evidenceCoverage: PersonalizedPrescriptionEvidenceCoverageV1;
  observedHeartRate?: PersonalizedPrescriptionObservedHeartRateV1;
  observedPowerProvenance: "measured_watts" | "calibrated_watts" | "mixed" | "unavailable";
  observedPower?: PersonalizedPrescriptionObservedPowerV1;
  stableInBandWorkload?: PersonalizedPrescriptionStableInBandWorkloadV1;
  controllerContext: PersonalizedPrescriptionControllerContextV1;
  candidateDomainMargins?: PersonalizedPrescriptionCandidateDomainMarginsV1;
  comparison?: PersonalizedPrescriptionCandidateComparisonV1;
  characterizationOutcome: PersonalizedPrescriptionCharacterizationOutcomeV1;
  exclusionReason?: PersonalizedPrescriptionCharacterizationExclusionReasonV1;
}

export interface PersonalizedPrescriptionCharacterizationV1 {
  schemaVersion: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V1;
  characterizer: {
    id: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1;
    version: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V1;
  };
  mode: "diagnostic";
  activationEligible: false;
  sourceShadow: {
    resolverId: typeof PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1;
    resolverVersion: typeof PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1;
    shadowSchemaVersion: typeof PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1;
    resolvedAt: string;
  };
  athleteId: string;
  workoutSessionId: string;
  workoutSelector: string;
  workoutIntent: string;
  activity: Activity;
  formalAssessmentQuality?: "low" | "moderate" | "high" | "unverified";
  calibrationWorkloadProvenance?: PersonalizedPrescriptionWorkloadProvenanceV1;
  policy: PersonalizedPrescriptionCharacterizationPolicyV1;
  phases: PersonalizedPrescriptionPhaseCharacterizationV1[];
  createdAt: string;
}

export interface PersonalizedPrescriptionFormalAssessmentProvenanceV2 {
  algorithm: {
    id: string;
    version: number;
  };
  protocol: {
    id: string;
    version: number;
  };
}

/** Current E2 record. Provenance is copied from and verified against its immutable E1 source. */
export interface PersonalizedPrescriptionCharacterizationV2
  extends Omit<PersonalizedPrescriptionCharacterizationV1, "schemaVersion" | "characterizer"> {
  schemaVersion: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V2;
  characterizer: {
    id: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1;
    version: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V2;
  };
  formalAssessmentProvenance?: PersonalizedPrescriptionFormalAssessmentProvenanceV2;
}

/**
 * Versioned E2 v3 characterization policy for held-workload forward-response
 * evidence. Every value is a characterization policy value (how evidence is
 * segmented and counted), never a validated universal physiological constant,
 * an activation threshold, a safety threshold, or an E4 pass/fail criterion.
 */
export interface PersonalizedPrescriptionHeldWorkloadPolicyV1 {
  id: "e2-held-workload-forward-response-policy";
  version: 1;
  /**
   * Active seconds after a stable observed-resistance window begins before its
   * HR response contributes forward-prediction error.
   */
  settlingSeconds: number;
  /** Largest active-second step between consecutive fresh observations inside one window. */
  maxObservationGapSec: number;
  /**
   * Largest wall-clock excess over active-clock progress between consecutive
   * observations. The active clock does not advance while paused, so a larger
   * excess is a pause (or clock discontinuity) and breaks the window.
   */
  maxWallClockExcessSec: number;
  /** Qualifying post-settling seconds needed before forward-error statistics are summarized. */
  minQualifyingSeconds: number;
}

/** Frozen E1 forward model copied for durable evaluation: predicted HR = intercept + slope × watts. */
export interface PersonalizedPrescriptionHeldWorkloadForwardModelV1 {
  interceptBpm: number;
  slopeBpmPerWatt: number;
  /** Trustworthy observed watt domain of the frozen calibration. No extrapolation outside it. */
  observedMinWatts: number;
  observedMaxWatts: number;
}

export type PersonalizedPrescriptionHeldWorkloadOutcomeV1 =
  | "characterized"
  | "insufficient_evidence"
  | "not_candidate"
  | "calibration_unavailable"
  | "unsupported_observed_provenance";

export type PersonalizedPrescriptionHeldWorkloadExclusionReasonV1 =
  | "phase_evidence_unavailable"
  | "no_stable_observed_resistance"
  | "insufficient_post_settling_evidence"
  | "unsupported_power_provenance";

export interface PersonalizedPrescriptionDistributionV1 {
  median: number;
  q1: number;
  q3: number;
  min: number;
  max: number;
}

/**
 * Stable observed-resistance segmentation of one phase. Durations are spans on
 * the active clock. Every post-settling second is accounted for exactly once:
 * postSettlingDurationSec = qualifyingDurationSec + sum(excludedPostSettlingSeconds).
 */
export interface PersonalizedPrescriptionStableResistanceSummaryV1 {
  /** Value changes between consecutive continuous fresh observations; changes across gaps/pauses are not counted. */
  observedResistanceChangeCount: number;
  stableWindowCount: number;
  /** Windows contributing at least one qualifying post-settling second. */
  qualifyingWindowCount: number;
  stableDurationSec: number;
  postSettlingDurationSec: number;
  qualifyingDurationSec: number;
  excludedPostSettlingSeconds: {
    /** Tolerated missing active seconds inside a window; never interpolated. */
    observationGap: number;
    wattsUnavailable: number;
    /** Observed watts outside the frozen calibration domain; never clamped or extrapolated. */
    outsideCalibrationDomain: number;
    heartRateUnavailable: number;
  };
}

export interface PersonalizedPrescriptionForwardHeartRateSummaryV1 {
  observedHeartRateMedianBpm: number;
  predictedHeartRateMedianBpm: number;
  /** Signed error = observed HR − predicted HR. Positive: HR higher than the frozen calibration predicts. */
  signedErrorBpm: PersonalizedPrescriptionDistributionV1;
  absoluteErrorBpm: PersonalizedPrescriptionDistributionV1;
}

/**
 * Held-workload forward-response evidence for one phase: observed watts under
 * held observed resistance → frozen E1 calibration → predicted HR, compared
 * with observed HR. Never conditioned on legacy HR-band occupancy or
 * controller success. The controller may have selected the held resistance, so
 * this is not independent or randomized open-loop evidence.
 */
export interface PersonalizedPrescriptionHeldWorkloadForwardResponseV1 {
  outcome: PersonalizedPrescriptionHeldWorkloadOutcomeV1;
  exclusionReason?: PersonalizedPrescriptionHeldWorkloadExclusionReasonV1;
  observedPowerProvenance: "measured_watts" | "calibrated_watts" | "mixed" | "unavailable";
  /** Absent when segmentation was not attempted (no candidate, calibration, or phase evidence). */
  stableResistance?: PersonalizedPrescriptionStableResistanceSummaryV1;
  /** Pooled over every qualifying second of every qualifying window; present only when characterized. */
  forwardHeartRate?: PersonalizedPrescriptionForwardHeartRateSummaryV1;
  /** Descriptive cadence context over qualifying seconds with fresh measured cadence. */
  cadenceRpm?: { observationCount: number; median: number; q1: number; q3: number };
}

export interface PersonalizedPrescriptionPhaseCharacterizationV3 extends PersonalizedPrescriptionPhaseCharacterizationV1 {
  heldWorkloadForwardResponse: PersonalizedPrescriptionHeldWorkloadForwardResponseV1;
}

/**
 * Current E2 record. Closed-loop fields are identical to v2; the v3 delta is
 * held-workload forward-response evidence, its policy, and the frozen forward model.
 */
export interface PersonalizedPrescriptionCharacterizationV3
  extends Omit<PersonalizedPrescriptionCharacterizationV2, "schemaVersion" | "characterizer" | "phases"> {
  schemaVersion: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3;
  characterizer: {
    id: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1;
    version: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V3;
  };
  heldWorkloadPolicy: PersonalizedPrescriptionHeldWorkloadPolicyV1;
  /** Present exactly when the linked E1 record carries a frozen formal calibration. */
  heldWorkloadForwardModel?: PersonalizedPrescriptionHeldWorkloadForwardModelV1;
  phases: PersonalizedPrescriptionPhaseCharacterizationV3[];
}

export type PersonalizedPrescriptionCharacterization =
  | PersonalizedPrescriptionCharacterizationV1
  | PersonalizedPrescriptionCharacterizationV2
  | PersonalizedPrescriptionCharacterizationV3;
export type CurrentPersonalizedPrescriptionCharacterization = PersonalizedPrescriptionCharacterizationV3;

export interface WorkoutPhaseState {
  phase: "Warm-Up" | "Sustain" | "Cool-Down" | "Completed";
  kind: WorkoutPhaseKind | "completed";
  phaseId: string;
  phaseElapsedSeconds: number;
  phaseDurationSeconds: number;
  timeLeft: number;
  done: boolean;
  detailName?: string;
  intervalIndex?: number;
}

export interface WorkoutMetadata {
  type: string;
  intent: string;
  activities: Activity[];
}

export interface HrIntervalPhase {
  phase: string;
  kind: WorkoutPhaseKind;
  duration: number;
  target_hr_bpm?: string | number;
  intensity_id?: PhaseIntensityId;
}

export interface HrIntervalTargets {
  phases: HrIntervalPhase[];
  repetitions: number;
  isSequence: boolean;
}

export interface HrTargetsForDay {
  warmup?: string | number;
  warmup_intensity_id?: PhaseIntensityId;
  warmup_subsections?: Array<{
    name: string;
    start_min: number;
    end_min: number;
    target_hr_bpm: string | number;
    intensity_id?: PhaseIntensityId;
  }>;
  cooldown?: string | number;
  cooldown_intensity_id?: PhaseIntensityId;
  main_set?: string | number;
  main_set_intensity_id?: PhaseIntensityId;
  main_set_kind?: WorkoutPhaseKind;
  intervals: HrIntervalTargets | null;
}

export type Plan = Record<DayName | string, PlanBlock | null>;
export type MetadataByDay = Record<DayName | string, WorkoutMetadata | undefined>;
export type HrTargetsByDay = Record<DayName | string, HrTargetsForDay | undefined>;

export interface Profile {
  weight: number | string;
  height: number | string;
  age: number | string;
  sex: "male" | "female" | "" | string;
  vo2: number | string;
}

/** Permanent historical schema identities. Readers must not key old data to current aliases. */
export const ATHLETE_PROFILE_SCHEMA_VERSION_V1 = 1 as const;
export const FITNESS_STATE_SCHEMA_VERSION_V1 = 1 as const;
export const FITNESS_STATE_SCHEMA_VERSION_V2 = 2 as const;
export const FITNESS_STATE_SCHEMA_VERSION_V3 = 3 as const;
export const ATHLETE_PROFILE_SCHEMA_VERSION = ATHLETE_PROFILE_SCHEMA_VERSION_V1;
export const FITNESS_STATE_SCHEMA_VERSION = FITNESS_STATE_SCHEMA_VERSION_V3;

export type FitnessMetricSource =
  | "formal_assessment"
  | "user_entered"
  | "workout_observation"
  | "demographic_estimate";

export type FitnessMetricQuality = "high" | "moderate" | "low" | "unverified";

export interface FitnessMetric<T> {
  value: T;
  source: FitnessMetricSource;
  quality: FitnessMetricQuality;
  observedAt: string;
  updatedAt: string;
  algorithm?: {
    id: string;
    version: number;
  };
  evidenceSessionIds?: string[];
}

/**
 * Versioned internal identity for the current single local athlete.
 * Body mass and height intentionally retain the profile form's pounds/inches
 * so legacy migration is lossless and idempotent.
 */
export interface AthleteProfile {
  schemaVersion: typeof ATHLETE_PROFILE_SCHEMA_VERSION;
  athleteId: string;
  demographics: {
    ageYears?: number;
    bodyMassLbs?: number;
    heightInches?: number;
    sex?: "male" | "female";
  };
  userEnteredVo2?: FitnessMetric<number>;
  createdAt: string;
  updatedAt: string;
}

export interface AthleteIdentity {
  schemaVersion: 1;
  athleteId: string;
  createdAt: string;
}

export interface HrWorkloadCalibrationPoint {
  stageId: string;
  watts: number;
  heartRateBpm: number;
  workloadSource: Exclude<Vo2WorkloadSource, "prescribed_only">;
}

export interface HrWorkloadCalibration {
  slopeBpmPerWatt: number;
  interceptBpm: number;
  rSquared: number;
  observedMinWatts: number;
  observedMaxWatts: number;
  points: HrWorkloadCalibrationPoint[];
  protocol: {
    id: string;
    version: number;
  };
  /** Demographic extrapolation input retained for audit; never observed HRmax. */
  predictedHrMaxBpm: number;
  predictedHrMaxSource: "demographic_estimate";
  profileInputSnapshot: {
    ageYears: number;
    bodyMassKg: number;
  };
}

export interface PredictedMaxWattsMetric extends FitnessMetric<number> {
  derivation: "demographic_hrmax_extrapolation";
  predictedHrMaxSource: "demographic_estimate";
}

export type PassiveAerobicIntensityId = "aerobic_base" | "threshold";

/** Historical Phase D v1 shape. Reader-supported, but not effective current evidence. */
export interface PassiveAerobicTrend {
  metric: "workload_at_comparable_hr";
  intensityId: PassiveAerobicIntensityId;
  referenceHeartRateBpm: number;
  projectedComparableWorkloadWatts: number;
  baselineComparableWorkloadWatts: number;
  changeFromBaselinePercent: number;
  qualifiedSessionCount: number;
  observationCount: number;
  distinctWorkoutDateCount: number;
  workloadSourceClasses: BikeWattsProvenance[];
  earliestEvidenceAt: string;
  latestEvidenceAt: string;
  observedMinWatts: number;
  observedMaxWatts: number;
  observedMinHeartRateBpm: number;
  observedMaxHeartRateBpm: number;
  medianAbsoluteDeviationWatts: number;
  comparisonBandBpm: number;
  formalAnchorObservedAt?: string;
  formalAnchorSessionId?: string;
}

export interface PassiveEvidenceDigest {
  algorithm: "fnv1a32";
  value: string;
}

/** Bounded provenance for a rebuildable projection whose source of truth is workout history. */
export interface PassiveEvidenceSummary {
  sessionCount: number;
  observationCount: number;
  distinctWorkoutDateCount: number;
  earliestEvidenceAt: string;
  latestEvidenceAt: string;
  firstSessionId: string;
  latestSessionId: string;
  recentSessionIds: string[];
  digest: PassiveEvidenceDigest;
}

/**
 * Descriptive Phase D v2 output. It deliberately makes no HR normalization or
 * prescription-authority claim; Phase E must not consume it as a fitness target.
 */
export interface PassiveAerobicObservation {
  metric: "descriptive_workload_trend_in_fixed_hr_window";
  interpretation: "descriptive_observation_only";
  normalizedToReferenceHr: false;
  eligibleForPrescription: false;
  intensityId: PassiveAerobicIntensityId;
  heartRateWindowCenterBpm: number;
  heartRateWindowMinBpm: number;
  heartRateWindowMaxExclusiveBpm: number;
  guardedTrendWorkloadWatts: number;
  baselineWorkloadMedianWatts: number;
  guardedTrendChangeFromBaselinePercent: number;
  workloadSourceClasses: BikeWattsProvenance[];
  observedMinWatts: number;
  observedMaxWatts: number;
  observedMinHeartRateBpm: number;
  observedMaxHeartRateBpm: number;
  medianAbsoluteDeviationWatts: number;
  formalAnchorObservedAt?: string;
  formalAnchorSessionId?: string;
}

export interface PassiveAerobicObservationMetric {
  value: PassiveAerobicObservation;
  source: "workout_observation";
  quality: Exclude<FitnessMetricQuality, "unverified">;
  observedAt: string;
  updatedAt: string;
  algorithm: {
    id: "fitness-refinement-v2";
    version: 2;
  };
  evidence: PassiveEvidenceSummary;
}

export interface FitnessState {
  schemaVersion:
    | typeof FITNESS_STATE_SCHEMA_VERSION_V1
    | typeof FITNESS_STATE_SCHEMA_VERSION_V2
    | typeof FITNESS_STATE_SCHEMA_VERSION_V3;
  athleteId: string;
  vo2Max?: FitnessMetric<number>;
  /** Extrapolated by the named estimator; not directly measured maximal power. */
  predictedMaxWatts?: PredictedMaxWattsMetric;
  hrWorkloadCalibration?: FitnessMetric<HrWorkloadCalibration>;
  /** Historical Phase D v1 metric; retained only for storage compatibility. */
  passiveAerobicTrend?: FitnessMetric<PassiveAerobicTrend>;
  /** Current descriptive Phase D metric; explicitly unavailable to prescription resolution. */
  passiveAerobicObservation?: PassiveAerobicObservationMetric;
  updatedAt: string;
}

/** Minimal historical pointer for future prescription resolvers. Not consumed by Phase A. */
export interface AthleteFitnessSnapshot {
  athleteId: string;
  profileSchemaVersion: typeof ATHLETE_PROFILE_SCHEMA_VERSION;
  fitnessStateSchemaVersion?:
    | typeof FITNESS_STATE_SCHEMA_VERSION_V1
    | typeof FITNESS_STATE_SCHEMA_VERSION_V2
    | typeof FITNESS_STATE_SCHEMA_VERSION_V3;
  fitnessUpdatedAt?: string;
}

export interface HrSample {
  session_id: string;
  timestamp_sec: number;
  hr: number;
}

/** Permanent historical schema identities for Phase C evidence. */
export const ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1 = 1 as const;
export const ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION = ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1;
export const WORKOUT_RESPONSE_SCHEMA_VERSION_V1 = 1 as const;
export const WORKOUT_RESPONSE_SCHEMA_VERSION = WORKOUT_RESPONSE_SCHEMA_VERSION_V1;

export type OrdinaryBikeTelemetryAvailability = "fresh" | "stale" | "unavailable";
export type BikeWattsProvenance = "measured_watts" | "calibrated_watts";

export interface OrdinaryBikeTelemetrySampleV1 {
  schemaVersion: typeof ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1;
  athleteId: string;
  sessionId: string;
  activeSec: number;
  observedAt: string;
  availability: OrdinaryBikeTelemetryAvailability;
  /** Stable identity from the successful Bike Bridge snapshot, used to reject duplicate observations. */
  sourceSampleId?: string;
  freshnessMs?: number;
  watts?: {
    value: number;
    source: BikeWattsProvenance;
    freshnessMs: number;
  };
  cadenceRpm?: {
    value: number;
    source: "measured";
    freshnessMs: number;
  };
  /**
   * Observed bike resistance from telemetry. Never copied from desired or commanded.
   * Absence means not observed, not zero.
   */
  observedResistance?: {
    value: number;
    source: "observed";
    freshnessMs: number;
  };
  /**
   * Controller recommendation / desired machine setting at this active second.
   * Recommendation is intent, not observation.
   */
  desiredResistance?: number;
  /**
   * Resistance posted to Bike Bridge when automatic actuation exists.
   * Command is not observation and is not required for observed evidence.
   */
  commandedResistance?: number;
}

/** Persisted/read union. Add historical members here without relabeling prior schemas. */
export type OrdinaryBikeTelemetrySample = OrdinaryBikeTelemetrySampleV1;
/** Writer alias. Advance this only when a new writer and matching parser are introduced. */
export type CurrentOrdinaryBikeTelemetrySample = OrdinaryBikeTelemetrySampleV1;

/** Compact phase-level scalar series. Absence of a summary means not recorded, not zero. */
export interface WorkoutResponseScalarSummary {
  sampleCount: number;
  coverageRatio: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  end: number;
}

/**
 * Per-phase durable evidence. Observed mechanical fields come from Bike Bridge
 * telemetry. Desired/commanded resistance retain recommendation and command
 * context and must never populate observed fields.
 */
export interface WorkoutPhaseResponse {
  phaseInstanceId: string;
  phaseId: string;
  kind: WorkoutPhaseKind;
  intensityId?: PhaseIntensityId;
  detailName?: string;
  intervalIndex?: number;
  activeStartSec: number;
  activeEndSec: number;
  plannedDurationSec: number;
  completedDurationSec: number;
  expectedHeartRate?: ResolvedHeartRateTarget;
  hr?: WorkoutResponseScalarSummary;
  watts?: WorkoutResponseScalarSummary & {
    provenance: "measured_watts" | "calibrated_watts" | "mixed";
  };
  cadenceRpm?: WorkoutResponseScalarSummary;
  /** Observed resistance from telemetry. */
  observedResistance?: WorkoutResponseScalarSummary;
  /** Recommendation / desired setting context. Not an observation. */
  desiredResistance?: WorkoutResponseScalarSummary;
  /** Commanded Bike Bridge setting when automatic control posted. Not an observation. */
  commandedResistance?: WorkoutResponseScalarSummary;
}

/**
 * WorkoutResponse is the durable phase-level summary of observed mechanical
 * workload and physiological response for ordinary workouts. It may also
 * retain recommendation and command context, but those fields are not
 * observations.
 *
 * prescription ≠ recommendation ≠ command ≠ observation ≠ physiological response
 *
 * Recommendation is intent. Observation is evidence of what physically happened.
 */
export interface WorkoutResponseV1 {
  schemaVersion: typeof WORKOUT_RESPONSE_SCHEMA_VERSION_V1;
  athleteId: string;
  sessionId: string;
  completion: {
    plannedActiveSec: number;
    completedActiveSec: number;
    completionFraction: number;
    cancelled: boolean;
    earlyCooldown: boolean;
  };
  evidence: {
    hr: {
      expectedDurationSec: number;
      validSampleCount: number;
      coverageRatio: number;
      source: "ble_chest_strap" | "unavailable";
    };
    bike: {
      expectedDurationSec: number;
      rowCount: number;
      freshSampleCount: number;
      staleSampleCount: number;
      unavailableSampleCount: number;
      implicitMissingCount: number;
      freshRowCoverageRatio: number;
      wattsProvenance: "measured_watts" | "calibrated_watts" | "mixed" | "unavailable";
    };
    rawTelemetry: {
      store: "ordinary_bike_telemetry";
      schemaVersion: typeof ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1;
    };
  };
  phases: WorkoutPhaseResponse[];
}

/** Persisted/read union. Add historical members here without relabeling prior schemas. */
export type WorkoutResponse = WorkoutResponseV1;
/** Writer alias. Advance this only when a new writer and matching parser are introduced. */
export type CurrentWorkoutResponse = WorkoutResponseV1;

export interface ZoneMinutes {
  z1: number;
  z2: number;
  z3: number;
  z4: number;
  z5: number;
}

/** Local evidence for the VO2 estimator. Not itself a VO2 result. */
export const VO2_EVIDENCE_SCHEMA_VERSION_V1 = 1 as const;
export const VO2_ASSESSMENT_SCHEMA_VERSION_V1 = 1 as const;
export const VO2_EVIDENCE_SCHEMA_VERSION_V2 = 2 as const;
export const VO2_ASSESSMENT_SCHEMA_VERSION_V2 = 2 as const;
/** Writer aliases. Historical readers must use the explicit V1 constants above. */
export const VO2_EVIDENCE_SCHEMA_VERSION = VO2_EVIDENCE_SCHEMA_VERSION_V2;
export const VO2_ASSESSMENT_SCHEMA_VERSION = VO2_ASSESSMENT_SCHEMA_VERSION_V2;

export interface Vo2EvidencePhasePrescription {
  /** Prescribed HR target text or number from the workout plan (not measured). */
  target_hr_bpm?: string | number;
  target_hr_min?: number;
  target_hr_max?: number;
}

export interface Vo2EvidencePhase {
  phase_id: string;
  kind: WorkoutPhaseKind;
  detail_name?: string;
  interval_index?: number;
  active_start_sec: number;
  active_end_sec: number;
  prescribed?: Vo2EvidencePhasePrescription;
}

export interface Vo2EvidenceHr {
  /** Chest-strap BLE is the only live HR source today. */
  source: "ble_chest_strap" | "absent";
  /** Count of active-workout HR samples (pause-era HR is not stored as workout samples). */
  sample_count: number;
  first_active_elapsed_sec?: number;
  last_active_elapsed_sec?: number;
}

export interface Vo2EvidenceMachine {
  machine_id?: MachineId;
  machine_profile_version?: number;
  guidance_trace_entry_count?: number;
}

/** Permanent historical identity for the v1 protocol; keep readable after newer protocols ship. */
export const LEGACY_VO2_PROTOCOL_ID = "bike-submax-70rpm" as const;
export const LEGACY_VO2_PROTOCOL_VERSION_V1 = 1 as const;
/** Backward-compatible name for the permanent historical protocol identity. */
export const LEGACY_VO2_PROTOCOL_VERSION = LEGACY_VO2_PROTOCOL_VERSION_V1;
export const VO2_PROTOCOL_VERSION_V2 = 2 as const;
export const VO2_PROTOCOL_VERSION_V3 = 3 as const;
/** Protocol identity shared by formal assessments. New athlete-started sessions write v3; v2 remains the reader for historical evidence. */
export const VO2_PROTOCOL_ID = LEGACY_VO2_PROTOCOL_ID;
/** v2 marker used by the v2 reader/validators. Do not point at v3: v2 validation depends on this staying 2. */
export const VO2_PROTOCOL_VERSION = VO2_PROTOCOL_VERSION_V2;
export type Vo2ProtocolId = typeof VO2_PROTOCOL_ID;
export type Vo2ProtocolVersion =
  | typeof LEGACY_VO2_PROTOCOL_VERSION_V1
  | typeof VO2_PROTOCOL_VERSION_V2
  | typeof VO2_PROTOCOL_VERSION_V3;

export type Vo2ProtocolStageStatus =
  | "accepted"
  | "unstable_hr"
  | "insufficient_hr"
  | "incomplete";

export type Vo2ProtocolTerminationReasonV1 =
  | "protocol_complete"
  | "submax_hr_ceiling"
  | "early_cooldown"
  | "limit_reached"
  | "user_cancelled"
  | "hr_lost"
  | "insufficient_calibrated_workloads"
  | "other";

export type Vo2ProtocolTerminationReasonV2 =
  | Vo2ProtocolTerminationReasonV1
  | "insufficient_eligible_stages";

/** Adaptive v3 reuses the v2 vocabulary; per-stage/termination provenance distinguishes subcases. */
export type Vo2ProtocolTerminationReasonV3 = Vo2ProtocolTerminationReasonV2;

export type Vo2ProtocolTerminationReason =
  | Vo2ProtocolTerminationReasonV1
  | Vo2ProtocolTerminationReasonV2
  | Vo2ProtocolTerminationReasonV3;

export interface Vo2ProtocolStageHrEvidence {
  sample_count: number;
  minute_2_mean_bpm?: number;
  minute_3_mean_bpm?: number;
  final_two_window_delta_bpm?: number;
  steady_state_bpm?: number;
}

/** Compact versioned reason codes for adaptive v3 planner decisions. Source of truth; no free-form strings. */
export type Vo2AdaptiveDecisionReasonCode =
  | "sufficient_evidence"
  | "bootstrap_first_stage"
  | "conservative_step_insufficient_evidence"
  | "safe_increment"
  | "reduced_increment_near_ceiling"
  | "retry_lower_after_above_ceiling"
  | "hr_safety_no_safe_target"
  /** Runtime-observed live-HR ceiling breach (v3 guard fired), not a planner prediction. */
  | "observed_hr_above_ceiling"
  | "below_floor_no_safe_target"
  | "workload_bounds_exhausted"
  | "stage_limit_reached"
  | "retry_limit_reached"
  | "insufficient_separation"
  | "nonpositive_slope";

/**
 * Per-stage provenance explaining why adaptive v3 chose this workload. Only v3 writes this.
 * Planning regression/prediction use the controllable calibrated-watt domain
 * (`selected_target_watts`/`selected_calibrated_watts`); `previous_measured_watts`
 * records the authoritative estimator watts for audit and is never a planning input.
 */
export interface Vo2AdaptiveStageProvenance {
  provenance_version: 1;
  prior_eligible_stage_count: number;
  previous_measured_watts?: number;
  previous_steady_hr_bpm?: number;
  hard_hr_ceiling_bpm: number;
  planning_hr_ceiling_bpm: number;
  planning_margin_bpm: number;
  predicted_next_hr_bpm?: number;
  selected_target_watts: number;
  selected_calibrated_watts: number;
  selected_resistance: number;
  decision: "next" | "retry";
  reason_code: Vo2AdaptiveDecisionReasonCode;
}

/**
 * Protocol-level provenance for a v3 planner refusal. Set when no safe/useful stage exists.
 * `last_measured_watts` records authoritative estimator watts for audit; planning
 * decisions are made in the calibrated-watt domain.
 */
export interface Vo2AdaptiveTerminationProvenance {
  provenance_version: 1;
  eligible_stage_count: number;
  completed_work_stage_count: number;
  retry_count: number;
  hard_hr_ceiling_bpm: number;
  planning_hr_ceiling_bpm: number;
  planning_margin_bpm: number;
  last_measured_watts?: number;
  last_steady_hr_bpm?: number;
  predicted_hr_bpm?: number;
  reason_code: Vo2AdaptiveDecisionReasonCode;
  termination_reason: Vo2ProtocolTerminationReasonV3;
}

export interface Vo2ProtocolStageEvidence {
  stage_id: string;
  active_start_sec: number;
  active_end_sec: number;
  requested_watts?: number;
  prescribed_resistance: number;
  calibrated_watts_at_70rpm: number;
  status: Vo2ProtocolStageStatus;
  nominal_duration_sec: number;
  actual_duration_sec: number;
  hr?: Vo2ProtocolStageHrEvidence;
  workload?: Vo2ProtocolStageWorkloadEvidence;
  /** Present only on adaptive v3 stages. V1/v2 readers ignore it. */
  adaptive?: Vo2AdaptiveStageProvenance;
}

interface Vo2ProtocolEvidenceBase {
  /** Observed protocol id. */
  protocol_id: string;
  /** Observed protocol version. */
  protocol_version: number;
  prescribed_cadence_rpm: number;
  stages: Vo2ProtocolStageEvidence[];
  /** Whether a predicted submaximal HR ceiling was available during collection. */
  automatic_submax_hr_ceiling_available: boolean;
}

/** Exact historical formal-protocol evidence contract. */
export interface Vo2ProtocolEvidenceV1 extends Omit<Vo2ProtocolEvidenceBase, "protocol_version"> {
  protocol_version: typeof LEGACY_VO2_PROTOCOL_VERSION_V1;
  termination: {
    reason: Vo2ProtocolTerminationReasonV1;
  };
}

/** Current corrected formal-protocol evidence contract. */
export interface Vo2ProtocolEvidenceV2 extends Omit<Vo2ProtocolEvidenceBase, "protocol_version"> {
  protocol_version: typeof VO2_PROTOCOL_VERSION_V2;
  termination: {
    reason: Vo2ProtocolTerminationReasonV2;
  };
}

/** Adaptive v3 protocol evidence. Reuses v2 termination vocabulary; provenance explains refusals. */
export interface Vo2ProtocolEvidenceV3 extends Omit<Vo2ProtocolEvidenceBase, "protocol_version"> {
  protocol_version: typeof VO2_PROTOCOL_VERSION_V3;
  termination: {
    reason: Vo2ProtocolTerminationReasonV3;
  };
  adaptive_termination?: Vo2AdaptiveTerminationProvenance;
}

export type Vo2ProtocolEvidence = Vo2ProtocolEvidenceV1 | Vo2ProtocolEvidenceV2 | Vo2ProtocolEvidenceV3;
export type CurrentVo2ProtocolEvidence = Vo2ProtocolEvidenceV2;
/** Explicit adaptive evidence; not the default writer. */
export type AdaptiveVo2ProtocolEvidence = Vo2ProtocolEvidenceV3;

interface Vo2EvidenceBase {
  activity?: Activity;
  intent?: string;
  day?: DayName | string;
  /** Active workout elapsed at completion (excludes paused time). */
  active_duration_sec: number;
  /** Cumulative paused wall time during the session. */
  paused_duration_sec: number;
  /** Active elapsed when meaningful work ended; null if work never ended. */
  work_end_active_sec: number | null;
  /** Active elapsed when cooldown started; null if cooldown never started. */
  cooldown_start_active_sec: number | null;
  early_cooldown: boolean;
  cancelled?: boolean;
  phases: Vo2EvidencePhase[];
  hr: Vo2EvidenceHr;
  machine?: Vo2EvidenceMachine;
  /** Present only for the standalone VO2 Max Estimation protocol. */
  protocol?: Vo2ProtocolEvidence;
}

/** Permanent historical evidence record. */
export interface Vo2EvidenceV1 extends Vo2EvidenceBase {
  schema_version: typeof VO2_EVIDENCE_SCHEMA_VERSION_V1;
  protocol?: Vo2ProtocolEvidenceV1;
}

/** Current evidence writer record. Outer envelope stays v2; protocol v2 or adaptive v3 may sit inside. */
export interface Vo2EvidenceV2 extends Vo2EvidenceBase {
  schema_version: typeof VO2_EVIDENCE_SCHEMA_VERSION_V2;
  protocol?: Vo2ProtocolEvidenceV2 | Vo2ProtocolEvidenceV3;
}

export type Vo2Evidence = Vo2EvidenceV1 | Vo2EvidenceV2;
export type CurrentVo2Evidence = Vo2EvidenceV2;

export type Vo2AssessmentStatus = "estimated" | "insufficient_evidence";

export type Vo2AssessmentReasonCodeV1 =
  | "missing_protocol_evidence"
  | "unsupported_protocol_id"
  | "unsupported_protocol_version"
  | "missing_profile_age"
  | "missing_profile_weight"
  | "invalid_profile_age"
  | "invalid_profile_weight"
  | "too_few_accepted_stages"
  | "too_few_eligible_stages"
  | "missing_stage_hr"
  | "invalid_workload"
  | "unverified_performed_workload"
  | "invalid_workload_progression"
  | "invalid_hr_progression"
  | "hr_below_estimator_range"
  | "hr_above_submax_ceiling"
  | "nonpositive_slope"
  | "unstable_regression"
  | "invalid_extrapolation"
  | "invalid_estimate";

export type Vo2AssessmentReasonCodeV2 =
  | Vo2AssessmentReasonCodeV1
  | "unsupported_evidence_schema"
  | "stage_unstable_hr"
  | "insufficient_stage_hr_samples"
  | "stage_incomplete"
  | "insufficient_workload_samples"
  | "cadence_outside_verified_range";

export type Vo2AssessmentReasonCode = Vo2AssessmentReasonCodeV1 | Vo2AssessmentReasonCodeV2;

export type Vo2AssessmentFitQuality = "high" | "moderate" | "low";

export type Vo2WorkloadSource =
  | "measured_watts"
  | "calibrated_at_verified_cadence"
  | "prescribed_only";

export interface Vo2ProtocolStageWorkloadEvidence {
  source: Vo2WorkloadSource;
  /** Watts the estimator may use when this stage is eligible. */
  estimator_watts?: number;
  calibrated_watts_at_70rpm: number;
  measured_watts_median?: number;
  measured_watts_sample_count: number;
  measured_cadence_median_rpm?: number;
  measured_cadence_sample_count: number;
  cadence_in_band_ratio?: number;
  cadence_measured: boolean;
  watts_measured: boolean;
}

/** Exact point shape written by assessment schema v1. */
export interface Vo2AssessmentPointV1 {
  stage_id: string;
  protocol_accepted: boolean;
  estimator_eligible: boolean;
  ineligibility_reasons: Vo2AssessmentReasonCodeV1[];
  workload_source?: Vo2WorkloadSource;
  watts?: number;
  calibrated_watts_at_70rpm?: number;
  steady_state_bpm?: number;
  cadence_measured?: boolean;
  watts_measured?: boolean;
  measured_cadence_median_rpm?: number;
  measured_watts_median?: number;
  measured_watts_sample_count?: number;
  measured_cadence_sample_count?: number;
  cadence_in_band_ratio?: number;
}

/** Current stage diagnostic shape written by assessment schema v2. */
export interface Vo2AssessmentPointV2 extends Omit<Vo2AssessmentPointV1, "ineligibility_reasons"> {
  stage_number: number;
  protocol_stage_status: Vo2ProtocolStageStatus;
  hr_stability_passed: boolean;
  workload_evidence_passed: boolean;
  submax_hr_eligible?: boolean;
  ineligibility_reasons: Vo2AssessmentReasonCodeV2[];
  prescribed_resistance: number;
  requested_watts?: number;
}

export type Vo2AssessmentPoint = Vo2AssessmentPointV1 | Vo2AssessmentPointV2;
export type CurrentVo2AssessmentPoint = Vo2AssessmentPointV2;

export interface Vo2AssessmentInputSnapshot {
  age_years?: number;
  weight_kg?: number;
  predicted_hr_max?: number;
  protocol_id?: string;
  protocol_version?: number;
}

interface Vo2AssessmentDiagnosticsBase {
  slope?: number;
  intercept?: number;
  r_squared?: number;
  predicted_hr_max?: number;
  predicted_max_watts?: number;
  min_r_squared: number;
  estimator_min_hr_bpm: number;
  estimator_submax_hrmax_fraction: number;
  expected_protocol_id: string;
  expected_protocol_version: number;
  observed_protocol_id?: string;
  observed_protocol_version?: number;
}

/** Exact diagnostics shape written by assessment schema v1. */
export interface Vo2AssessmentDiagnosticsV1 extends Vo2AssessmentDiagnosticsBase {
  accepted_points: Vo2AssessmentPointV1[];
  eligible_points: Vo2AssessmentPointV1[];
}

/** Current diagnostics shape, including every attempted stage. */
export interface Vo2AssessmentDiagnosticsV2 extends Vo2AssessmentDiagnosticsBase {
  stage_points: Vo2AssessmentPointV2[];
  accepted_points: Vo2AssessmentPointV2[];
  eligible_points: Vo2AssessmentPointV2[];
}

export type Vo2AssessmentDiagnostics = Vo2AssessmentDiagnosticsV1 | Vo2AssessmentDiagnosticsV2;
export type CurrentVo2AssessmentDiagnostics = Vo2AssessmentDiagnosticsV2;

interface Vo2AssessmentResultBase {
  estimator_id: string;
  estimator_version: number;
  status: Vo2AssessmentStatus;
  estimate_ml_kg_min?: number;
  fit_quality?: Vo2AssessmentFitQuality;
  accepted_stage_count: number;
  eligible_stage_count: number;
  stages_used: string[];
  highest_accepted_workload_watts?: number;
  input_snapshot: Vo2AssessmentInputSnapshot;
}

/** Permanent historical assessment result. */
export interface Vo2AssessmentResultV1 extends Vo2AssessmentResultBase {
  schema_version: typeof VO2_ASSESSMENT_SCHEMA_VERSION_V1;
  termination_reason: Vo2ProtocolTerminationReasonV1;
  reason_codes: Vo2AssessmentReasonCodeV1[];
  diagnostics: Vo2AssessmentDiagnosticsV1;
}

/** Current assessment result with stage-level eligibility diagnostics. */
export interface Vo2AssessmentResultV2 extends Vo2AssessmentResultBase {
  schema_version: typeof VO2_ASSESSMENT_SCHEMA_VERSION_V2;
  termination_reason: Vo2ProtocolTerminationReasonV2;
  reason_codes: Vo2AssessmentReasonCodeV2[];
  diagnostics: Vo2AssessmentDiagnosticsV2;
}

/** Persisted/read union. Historical v1 records are never relabeled. */
export type Vo2AssessmentResult = Vo2AssessmentResultV1 | Vo2AssessmentResultV2;
/** Writer alias for newly finalized formal assessments. */
export type CurrentVo2AssessmentResult = Vo2AssessmentResultV2;

export interface WorkoutSummary {
  external_session_id: string;
  /** App build that finalized this local workout. Absent on historical summaries. */
  app_version?: string;
  /** Stable owner for new local evidence. Absent on legacy summaries. */
  athlete_id?: string;
  /** Future prescription input pointer. Phase A resolution does not consume it. */
  athlete_fitness_snapshot?: AthleteFitnessSnapshot;
  startedAt: string;
  endedAt: string;
  category: "cardio";
  intent: string;
  duration_minutes: number;
  primary_zone: number;
  stress_profile: "low" | "moderate" | "high";
  zone_minutes: ZoneMinutes;
  hr_trace: {
    sampling_interval_seconds: number;
    samples: Array<{ t: number; hr: number }>;
  };
  day?: DayName | string;
  /** True when the user ended the workout early (cancel). Still saved in history. */
  cancelled?: boolean;
  activity?: Activity;
  machine_id?: MachineId;
  machine_profile_version?: number;
  machine_guidance_trace?: MachineGuidanceTraceEntry[];
  machine_decision_audit?: MachineDecisionAuditEntry[];
  /** Frozen prescription provenance used by this workout. Absent on historical summaries. */
  resolved_prescription?: ResolvedWorkoutPrescription;
  /** Frozen Phase E1 diagnostic only. It never represents the executed prescription. */
  shadow_prescription_evaluation?: PersonalizedPrescriptionEvaluationV1;
  /** Frozen Phase E2 diagnostic only. It is never read by prescription or control code. */
  shadow_prescription_characterization?: PersonalizedPrescriptionCharacterization;
  /**
   * Pause-safe stage-aware physiological evidence for the VO2 estimator.
   * Absent on historical workouts that predate this format.
   */
  vo2_evidence?: Vo2Evidence;
  /**
   * Versioned VO2 assessment for the standalone VO2 Max Estimation workout.
   * Local-only; stripped from SISU ingest. Absent on ordinary workouts.
   */
  vo2_assessment?: Vo2AssessmentResult;
  /** Athlete-owned ordinary-workout response. Local-only and absent on legacy/VO2 summaries. */
  workout_response?: WorkoutResponse;
  /**
   * Frozen execution provenance (start-time machine identity, calibration machine
   * provenance, explicit resistance-actuation events). Local-only; absent on
   * historical summaries, which therefore have unknown provenance. Never read by
   * prescription, guidance, or control.
   */
  execution_provenance?: WorkoutExecutionProvenanceV1;
}

/** Permanent execution-provenance schema identity. */
export const WORKOUT_EXECUTION_PROVENANCE_SCHEMA_VERSION_V1 = 1 as const;

/** Canonical machine identity: registry machine ID plus adapter profile version. */
export interface FrozenMachineIdentityV1 {
  machineId: string;
  machineProfileVersion: number;
}

/**
 * Machine identity frozen at workout start from the equipment selection.
 * `none_selected` means no machine was selected for the activity at start.
 * `selectionChangedDuringWorkout` records that the live guidance runtime saw a
 * different selected machine later; the frozen start identity is never rewritten.
 * Physical-machine changes are not detectable from Bike Bridge telemetry.
 */
export type WorkoutMachineProvenanceV1 =
  | ({ status: "selected"; selectionChangedDuringWorkout: boolean } & FrozenMachineIdentityV1)
  | { status: "none_selected"; selectionChangedDuringWorkout: boolean };

/**
 * Exact formal-calibration instance identity, using the same dimensions E3/E4A
 * use to separate calibration instances: athlete × evidence session IDs (set) ×
 * observedAt × estimator id/version × protocol id/version × workload provenance.
 */
export interface FormalCalibrationInstanceIdentityV1 {
  athleteId: string;
  /** Sorted, unique. */
  evidenceSessionIds: string[];
  observedAt: string;
  algorithm: { id: string; version: number };
  protocol: { id: string; version: number };
  workloadProvenance: "measured_watts" | "calibrated_at_verified_cadence" | "mixed";
}

export const FORMAL_CALIBRATION_MACHINE_PROVENANCE_SCHEMA_VERSION_V1 = 1 as const;

/** Sidecar binding one exact promoted formal calibration instance to the machine it was measured on. */
export interface FormalCalibrationMachineProvenanceV1 {
  schemaVersion: typeof FORMAL_CALIBRATION_MACHINE_PROVENANCE_SCHEMA_VERSION_V1;
  calibration: FormalCalibrationInstanceIdentityV1;
  /** Frozen at formal-assessment start; never read from selection at promotion. */
  machine: FrozenMachineIdentityV1;
  /** Source assessment workout session; informational, the record outlives that summary. */
  sourceSessionId: string;
  recordedAt: string;
}

/** Calibration machine provenance copied into a workout at start from an exact sidecar match. */
export type WorkoutCalibrationMachineProvenanceV1 =
  | ({ status: "available"; calibration: FormalCalibrationInstanceIdentityV1 } & FrozenMachineIdentityV1)
  | { status: "no_frozen_calibration" }
  | { status: "unavailable"; calibration: FormalCalibrationInstanceIdentityV1 }
  | { status: "integrity_failure"; calibration: FormalCalibrationInstanceIdentityV1 };

/**
 * Who/what chose the requested resistance. Captured at the guidance source;
 * never inferred from commanded/desired/observed resistance. There is no in-app
 * manual resistance control, so no manual origin exists in v1.
 */
export type ResistanceActuationOriginV1 =
  /** Live HR-guidance evaluation changed resistance (work or recovery). */
  | "automatic_hr_control"
  /** Work-phase start from the learned starting-resistance table. */
  | "learned_starting_resistance"
  /** Work-phase start from the conservative default starting resistance. */
  | "default_starting_resistance"
  /** Work-phase start re-applying the controller's carried work resistance. */
  | "controller_carryover"
  /** Fixed warm-up progression or recovery/cooldown phase-start resistance. */
  | "scripted_phase_program"
  /** Fixed VO2 protocol stage resistance. */
  | "vo2_protocol_fixed_resistance"
  /** Command sent without a classified guidance decision. */
  | "unclassified";

export type ResistanceActuationTriggerV1 =
  /** First command for a new guidance decision. */
  | "decision"
  /** Re-send of the current decision (resume, bridge recovery, control re-enabled). Not a new decision. */
  | "reconciliation_resend";

export type ResistanceActuationOutcomeV1 = "accepted" | "failed" | "unavailable" | "timeout" | "pending";

/** One Bike Bridge resistance command. Sparse: one row per posted command, never per second. */
export interface ResistanceActuationEventV1 {
  /** 1-based, append order within the session; stable across reload. */
  commandId: number;
  /** Logical decision identity; reconciliation re-sends share their decision's ID. */
  decisionId: string;
  origin: ResistanceActuationOriginV1;
  trigger: ResistanceActuationTriggerV1;
  requestedResistance: number;
  /** Canonical active clock at send time. */
  activeSec: number;
  observedAt: string;
  outcome: ResistanceActuationOutcomeV1;
}

/**
 * Phase-level actuation mode derived from explicit events:
 * automatic    — ≥1 accepted automatic_hr_control command;
 * programmatic — accepted app commands, none automatic_hr_control;
 * none         — zero app resistance-command events in the phase and app-command capture complete;
 * unknown      — incomplete capture, ambiguous (timeout/pending), unclassified, or failed/unavailable commands.
 * Console-knob changes are not observable, so `none` never means the athlete held resistance.
 */
export type PhaseActuationModeV1 = "automatic" | "programmatic" | "none" | "unknown";

export interface PhaseActuationSummaryV1 {
  phaseId: string;
  kind: WorkoutPhaseKind;
  intervalIndex?: number;
  activeStartSec: number;
  activeEndSec: number;
  mode: PhaseActuationModeV1;
  automaticAcceptedCount: number;
  programmaticAcceptedCount: number;
  rejectedCount: number;
  ambiguousCount: number;
  decisionCount: number;
}

export interface WorkoutActuationProvenanceV1 {
  captureScope: "app_resistance_commands";
  consoleResistanceChanges: "not_observable";
  coverage: "complete" | "incomplete";
  /**
   * `persistence_failed`: additional evidence could not be persisted, including
   * storage errors and v1 capacity exhaustion (the 5,000-event reader bound).
   */
  incompleteReasons: Array<"active_clock_unavailable" | "persistence_failed">;
  events: ResistanceActuationEventV1[];
  /** Present only when frozen phase boundaries exist (ordinary workout response). */
  phases?: PhaseActuationSummaryV1[];
}

export interface WorkoutExecutionProvenanceV1 {
  schemaVersion: typeof WORKOUT_EXECUTION_PROVENANCE_SCHEMA_VERSION_V1;
  sessionId: string;
  machine: WorkoutMachineProvenanceV1;
  calibrationMachine: WorkoutCalibrationMachineProvenanceV1;
  actuation: WorkoutActuationProvenanceV1;
}

export interface SisuSettings {
  key: "config";
  host: string;
  port: number;
  protocol?: "https" | "http";
  last_connected: string;
  last_sync: string | null;
}
