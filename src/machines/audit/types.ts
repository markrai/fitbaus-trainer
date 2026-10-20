export const MACHINE_DECISION_AUDIT_VERSION = 1 as const;
export const MAX_MACHINE_DECISION_AUDIT_ENTRIES = 256;

export type MachineHeartRateAssessment = "low" | "target" | "high";
export type MachineDecision = "increase" | "hold" | "decrease";
export type MachineDecisionConstraint =
  | "none"
  | "target_hold"
  | "r13_plus_deficit_guard"
  | "r15_cap"
  | "r1_floor";
export type MachineDecisionReason =
  | "below_target"
  | "within_target_policy"
  | "above_target"
  | "increase_guarded"
  | "upper_resistance_bound"
  | "lower_resistance_bound";
export type MachineEvaluationKind =
  | "initial"
  | "after_hold"
  | "after_increase"
  | "after_decrease"
  | "short_interval_final";
export type MachineWorkDurationBand = "short" | "medium" | "long";
export type MachineDecisionAuditTimingMode = "earlier" | "extended" | "mixed";
export type MachineDecisionAuditPhaseKind = "warmup" | "work" | "recovery" | "cooldown";

interface MachineDecisionAuditBase {
  version: typeof MACHINE_DECISION_AUDIT_VERSION;
  elapsedSeconds: number;
  phaseKind: MachineDecisionAuditPhaseKind;
  phaseId: string;
  intervalIndex?: number;
  phaseElapsedSeconds: number;
  phaseDurationSeconds: number;
  targetHeartRateMin?: number;
  targetHeartRateMax?: number;
}

export interface MachineWorkPhaseStartedAuditEntry extends MachineDecisionAuditBase {
  kind: "work_phase_started";
  resistance: number;
  timingMode?: MachineDecisionAuditTimingMode;
  initialEvaluationWaitSeconds: number;
  nextEligibleElapsedSeconds: number;
}

export interface MachineEvaluationAuditEntry extends MachineDecisionAuditBase {
  kind: "evaluation";
  representativeHeartRate: number;
  representativeSampleCount?: number;
  representativeWindowSpanSeconds?: number;
  resistanceBefore: number;
  resistanceAfter: number;
  heartRateAssessment: MachineHeartRateAssessment;
  decision: MachineDecision;
  constraint?: MachineDecisionConstraint;
  decisionReason: MachineDecisionReason;
  evaluationKind: MachineEvaluationKind;
  waitBeforeEvaluationSeconds?: number;
  nextEvaluationWaitSeconds?: number;
  nextEligibleElapsedSeconds?: number;
  timingMode?: MachineDecisionAuditTimingMode;
}

export interface MachineEvaluationDeferredAuditEntry extends MachineDecisionAuditBase {
  kind: "evaluation_deferred";
  resistance: number;
  reason: "insufficient_hr";
  eligibleSinceElapsedSeconds: number;
}

export type MachineDecisionAuditEntry =
  | MachineWorkPhaseStartedAuditEntry
  | MachineEvaluationAuditEntry
  | MachineEvaluationDeferredAuditEntry;

export type MachineDecisionAuditKind = MachineDecisionAuditEntry["kind"];
