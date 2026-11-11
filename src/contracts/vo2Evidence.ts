/**
 * VO2 protocol identities (legacy and current, each version explicit), protocol
 * stage and adaptive provenance, and VO2 evidence schemas V1/V2.
 */

import type { MachineId } from "../machines/trace.js";
import type { Activity, DayName, WorkoutPhaseKind } from "./workoutPrescription.js";

/** Local evidence for the VO2 estimator. Not itself a VO2 result. */
export const VO2_EVIDENCE_SCHEMA_VERSION_V1 = 1 as const;
export const VO2_EVIDENCE_SCHEMA_VERSION_V2 = 2 as const;
/** Writer aliases. Historical readers must use the explicit V1 constants above. */
export const VO2_EVIDENCE_SCHEMA_VERSION = VO2_EVIDENCE_SCHEMA_VERSION_V2;
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
