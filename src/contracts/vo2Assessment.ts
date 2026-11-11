/**
 * VO2 assessment result contracts (schemas V1/V2), each version explicit.
 */

import type { Vo2ProtocolStageStatus, Vo2ProtocolTerminationReasonV1, Vo2ProtocolTerminationReasonV2, Vo2WorkloadSource } from "./vo2Evidence.js";

export const VO2_ASSESSMENT_SCHEMA_VERSION_V1 = 1 as const;
export const VO2_ASSESSMENT_SCHEMA_VERSION_V2 = 2 as const;
/** Writer alias. Historical readers must use the explicit V1 constant above. */
export const VO2_ASSESSMENT_SCHEMA_VERSION = VO2_ASSESSMENT_SCHEMA_VERSION_V2;

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
