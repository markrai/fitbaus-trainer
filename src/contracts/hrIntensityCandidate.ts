/**
 * H2 shadow athlete-specific HR intensity candidate contracts.
 * Shapes and policy identity only; evaluation lives in src/hrIntensityCandidate.ts.
 *
 * Population %HRR guidance is not an individually measured physiological threshold
 * and never grants live prescription authority.
 */

import type { FitnessState } from "./fitnessState.js";
import type { FitnessStorageStatusForHr, HrReadinessPrescriptionProvenance } from "./hrPersonalizationReadiness.js";
import type {
  PhaseIntensityId,
  ResolvedHeartRateTarget,
  ResolvedWorkoutPhaseTarget,
  ResolvedWorkoutPrescription,
  WorkoutPhaseKind,
} from "./workoutPrescription.js";

/** Shadow HR intensity candidate algorithm (H2). */
export const HR_INTENSITY_CANDIDATE_ALGORITHM_ID = "hr-intensity-candidate-shadow" as const;
export const HR_INTENSITY_CANDIDATE_ALGORITHM_VERSION = 1 as const;

/**
 * Provisional aerobic-base policy: ACSM moderate-intensity %HRR / %VO₂R band.
 * Source: ACSM Guidelines for Exercise Testing and Prescription intensity
 * classification — moderate = 40%–59% HRR (population exercise-prescription
 * guidance, not an individually measured AeT/VT1/LT).
 */
export const HR_INTENSITY_AEROBIC_BASE_POLICY_ID =
  "hr-intensity-aerobic-base-hrr-acsm-moderate" as const;
export const HR_INTENSITY_AEROBIC_BASE_POLICY_VERSION = 1 as const;
export const HR_INTENSITY_AEROBIC_BASE_MIN_FRACTION_OF_HRR = 0.4 as const;
export const HR_INTENSITY_AEROBIC_BASE_MAX_FRACTION_OF_HRR = 0.59 as const;

export const HR_INTENSITY_CANDIDATE_AUTHORITY_NOTICE =
  "Exploratory athlete-specific HR candidates are not active. Workouts continue using their existing BPM targets." as const;

/**
 * Exploratory candidate generation freshness window (days). Separate from future
 * live-control eligibility; stale resting evidence withholds H2 candidates.
 */
export const HR_INTENSITY_CANDIDATE_EXPLORATORY_FRESHNESS_DAYS = 90 as const;

export type HrIntensityCandidateReasonCode =
  | "candidate_available"
  | "policy_aerobic_base_acsm_moderate_hrr"
  | "phase_intensity_unsupported"
  | "phase_kind_not_sustained_work"
  | "phase_intensity_missing"
  | "phase_aerobic_base_ambiguous"
  | "resting_session_missing"
  | "resting_session_storage_absent"
  | "resting_session_storage_unreadable"
  | "resting_session_athlete_mismatch"
  | "resting_session_corrupt"
  | "resting_session_quality_insufficient"
  | "resting_session_exploratory_stale"
  | "resting_session_age_unknown"
  | "hrmax_demographics_missing"
  | "hrmax_demographics_invalid"
  | "hrmax_prediction_out_of_range"
  | "hrmax_observed_unavailable"
  | "hrr_unavailable_missing_resting"
  | "hrr_unavailable_missing_hrmax"
  | "hrr_unavailable_nonpositive"
  | "hrr_unavailable_implausible"
  | "candidate_calculation_nonfinite"
  | "candidate_range_invalid"
  | "legacy_comparison_open_ended"
  | "legacy_comparison_unavailable"
  | "activation_ineligible_shadow_only";

export interface HrIntensityCandidatePolicyV1 {
  id: typeof HR_INTENSITY_AEROBIC_BASE_POLICY_ID;
  version: typeof HR_INTENSITY_AEROBIC_BASE_POLICY_VERSION;
  intensityId: "aerobic_base";
  requiredPhaseKind: "work";
  minFractionOfHrr: typeof HR_INTENSITY_AEROBIC_BASE_MIN_FRACTION_OF_HRR;
  maxFractionOfHrr: typeof HR_INTENSITY_AEROBIC_BASE_MAX_FRACTION_OF_HRR;
  sourceLabel: "ACSM GETP moderate-intensity %HRR (40–59%)";
  interpretation: "population_exercise_prescription_guidance_not_individual_threshold";
}

/** Current aerobic-base shadow policy object (version field is pinned inside). */
export const HR_INTENSITY_AEROBIC_BASE_POLICY: HrIntensityCandidatePolicyV1 = {
  id: "hr-intensity-aerobic-base-hrr-acsm-moderate",
  version: 1,
  intensityId: "aerobic_base",
  requiredPhaseKind: "work",
  minFractionOfHrr: 0.4,
  maxFractionOfHrr: 0.59,
  sourceLabel: "ACSM GETP moderate-intensity %HRR (40–59%)",
  interpretation: "population_exercise_prescription_guidance_not_individual_threshold",
};

export interface HrIntensityCandidateInput {
  athleteId: string;
  expectedAthleteId: string;
  ageYears: number | null | undefined;
  fitnessStorageStatus: FitnessStorageStatusForHr;
  fitnessState: FitnessState | null;
  resolvedPrescription: ResolvedWorkoutPrescription | null;
  resolvedPrescriptionProvenance?: HrReadinessPrescriptionProvenance;
  nowMs: number;
  policy?: HrIntensityCandidatePolicyV1;
}

export interface HrIntensityCandidateBand {
  minBpm: number;
  maxBpm: number;
  minFractionOfHrr: number;
  maxFractionOfHrr: number;
}

export interface HrIntensityLegacyComparison {
  displayTargetHrBpm?: string | number;
  expectedHeartRate: ResolvedHeartRateTarget | null;
  /** Meaningful legacy endpoints only; synthetic open-ended bounds omitted. */
  comparedLegacyMinBpm: number | null;
  comparedLegacyMaxBpm: number | null;
  /** candidate − legacy for each comparable closed endpoint; never invents zeros. */
  minDeltaBpm: number | null;
  maxDeltaBpm: number | null;
  reasonCodes: HrIntensityCandidateReasonCode[];
}

export interface HrIntensityPhaseCandidate {
  phaseId: string;
  kind: WorkoutPhaseKind | string;
  intensityId?: PhaseIntensityId;
  detailName?: string;
  intervalIndex?: number;
  status: "candidate" | "withheld";
  reasonCodes: HrIntensityCandidateReasonCode[];
  candidateHeartRate: HrIntensityCandidateBand | null;
  legacyComparison: HrIntensityLegacyComparison;
  uncertaintyLabels: string[];
  qualificationLabels: string[];
}

export interface HrIntensityShadowEvaluation {
  algorithm: {
    id: typeof HR_INTENSITY_CANDIDATE_ALGORITHM_ID;
    version: typeof HR_INTENSITY_CANDIDATE_ALGORITHM_VERSION;
  };
  policy: HrIntensityCandidatePolicyV1;
  athleteId: string;
  evaluatedAtMs: number;
  selectedWorkoutSelector: string | null;
  resolvedPrescriptionProvenance: HrReadinessPrescriptionProvenance;
  restingHrBpm: number | null;
  restingQuality: "high" | "moderate" | null;
  restingAgeDays: number | null;
  restingProvisionalFreshness: "fresh" | "stale" | "unknown";
  predictedHrMaxBpm: number | null;
  predictedHrMaxSource: "tanaka_age_predicted" | null;
  heartRateReserveBpm: number | null;
  phases: HrIntensityPhaseCandidate[];
  mode: "shadow";
  activationEligible: false;
  authorityNotice: typeof HR_INTENSITY_CANDIDATE_AUTHORITY_NOTICE;
  reasonCodes: HrIntensityCandidateReasonCode[];
}

/** Convenience alias for diagnostics model wiring. */
export type { ResolvedWorkoutPhaseTarget };
