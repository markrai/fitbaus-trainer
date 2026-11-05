/**
 * Diagnostic-only HR personalization readiness / exploratory %HRR contracts.
 * Shapes only; evaluation lives in src/hrPersonalizationReadiness.ts.
 */

import type { FitnessState } from "./fitnessState.js";
import type {
  ResolvedHeartRateTarget,
  ResolvedWorkoutPhaseTarget,
  ResolvedWorkoutPrescription,
} from "./workoutPrescription.js";

/**
 * Provisional engineering freshness window for exploratory reporting only.
 * Measurements older than this are labeled stale for exploration; the label
 * does not grant or deny prescription eligibility (always ineligible today).
 */
export const HR_PERSONALIZATION_PROVISIONAL_FRESHNESS_DAYS = 90 as const;

export const HR_PERSONALIZATION_READINESS_ALGORITHM_ID = "hr-personalization-readiness" as const;
export const HR_PERSONALIZATION_READINESS_ALGORITHM_VERSION = 1 as const;

export const HR_PERSONALIZATION_AUTHORITY_NOTICE =
  "Personalized HR targets are not active. Current workouts still use their existing BPM prescriptions." as const;

export type HrPersonalizationReasonCode =
  | "resting_session_present"
  | "resting_session_missing"
  | "resting_session_storage_absent"
  | "resting_session_storage_unreadable"
  | "resting_session_athlete_mismatch"
  | "resting_session_corrupt"
  | "resting_session_ineligible_for_prescription"
  | "resting_session_provisional_fresh"
  | "resting_session_provisional_stale"
  | "hrmax_age_predicted_tanaka"
  | "hrmax_observed_unavailable"
  | "hrmax_demographics_missing"
  | "hrmax_demographics_invalid"
  | "hrmax_prediction_out_of_range"
  | "threshold_hr_evidence_absent"
  | "hrr_available_exploratory"
  | "hrr_unavailable_missing_resting"
  | "hrr_unavailable_missing_hrmax"
  | "hrr_unavailable_nonpositive"
  | "hrr_unavailable_implausible"
  | "target_interpretation_available"
  | "target_interpretation_unavailable"
  | "target_out_of_domain"
  | "target_range_invalid"
  | "prescription_authority_legacy_only";

export type FitnessStorageStatusForHr =
  | "absent"
  | "readable"
  | "unreadable"
  | "athlete_mismatch";

export interface HrPersonalizationReadinessInput {
  athleteId: string;
  expectedAthleteId: string;
  ageYears: number | null | undefined;
  fitnessStorageStatus: FitnessStorageStatusForHr;
  fitnessState: FitnessState | null;
  /** Selected workout's resolved legacy prescription; null when none/rest/special. */
  resolvedPrescription: ResolvedWorkoutPrescription | null;
  /** Evaluation clock for measurement age (epoch ms). */
  nowMs: number;
}

export interface RestingHrReadinessView {
  available: boolean;
  reasonCodes: HrPersonalizationReasonCode[];
  heartRateBpm: number | null;
  quality: "high" | "moderate" | null;
  source: "resting_session" | null;
  algorithmId: string | null;
  algorithmVersion: number | null;
  observedAt: string | null;
  ageDays: number | null;
  /** Provisional freshness label only; never prescription eligibility. */
  provisionalFreshness: "fresh" | "stale" | "unknown";
  interpretation: "resting_session_observation_only" | null;
  eligibleForPrescription: false;
}

export interface HrMaxReadinessView {
  available: boolean;
  reasonCodes: HrPersonalizationReasonCode[];
  /** Always null in this slice — observed HRmax is not collected. */
  observedHrMaxBpm: number | null;
  predictedHrMaxBpm: number | null;
  predictedSource: "tanaka_age_predicted" | null;
  predictedLabel: "age-predicted (Tanaka 2001)" | null;
  ageYearsUsed: number | null;
}

export interface ThresholdHrReadinessView {
  available: false;
  reasonCodes: HrPersonalizationReasonCode[];
  note: string;
}

export interface ExploratoryHrrView {
  available: boolean;
  reasonCodes: HrPersonalizationReasonCode[];
  /** estimated HRmax − resting-session HR; exploratory only. */
  heartRateReserveBpm: number | null;
  restingHrBpm: number | null;
  estimatedHrMaxBpm: number | null;
  estimatedHrMaxSource: "tanaka_age_predicted" | null;
  interpretation: "exploratory_provisional_only";
  eligibleForPrescription: false;
}

export interface ExploratoryTargetHrInterpretation {
  phaseId: string;
  kind: string;
  intensityId?: string;
  detailName?: string;
  displayTargetHrBpm?: string | number;
  source: ResolvedWorkoutPhaseTarget["source"];
  expectedHeartRate: ResolvedHeartRateTarget | null;
  /** Null when that endpoint cannot be interpreted. */
  minFractionOfHrr: number | null;
  maxFractionOfHrr: number | null;
  minPercentOfHrr: number | null;
  maxPercentOfHrr: number | null;
  reasonCodes: HrPersonalizationReasonCode[];
}

export interface HrPersonalizationReadinessEvaluation {
  algorithm: {
    id: typeof HR_PERSONALIZATION_READINESS_ALGORITHM_ID;
    version: typeof HR_PERSONALIZATION_READINESS_ALGORITHM_VERSION;
  };
  athleteId: string;
  evaluatedAtMs: number;
  resting: RestingHrReadinessView;
  hrMax: HrMaxReadinessView;
  thresholdHr: ThresholdHrReadinessView;
  exploratoryHrr: ExploratoryHrrView;
  selectedWorkoutSelector: string | null;
  exploratoryTargetInterpretations: ExploratoryTargetHrInterpretation[];
  /** Always false — this slice cannot activate personalized HR. */
  personalizedHrTargetsActive: false;
  prescriptionAuthority: "legacy_bpm_only";
  authorityNotice: string;
  reasonCodes: HrPersonalizationReasonCode[];
}
