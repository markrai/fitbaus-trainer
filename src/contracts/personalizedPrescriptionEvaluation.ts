/**
 * Personalized prescription shadow-evaluation contract (schema V1). Contract
 * shapes only; resolution logic lives in src/personalizedPrescription.ts.
 */

import type { ATHLETE_PROFILE_SCHEMA_VERSION_V1 } from "./athlete.js";
import type { FITNESS_STATE_SCHEMA_VERSION_V1, FITNESS_STATE_SCHEMA_VERSION_V2, FITNESS_STATE_SCHEMA_VERSION_V3, HrWorkloadCalibrationPoint } from "./fitnessState.js";
import type { Activity, PhaseIntensityId, ResolvedHeartRateTarget, WorkoutPhaseKind } from "./workoutPrescription.js";

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
