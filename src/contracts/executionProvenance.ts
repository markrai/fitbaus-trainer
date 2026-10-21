/**
 * Workout execution provenance: frozen machine identity, formal calibration
 * machine provenance, and resistance actuation records (schema V1).
 */

import type { WorkoutPhaseKind } from "./workoutPrescription.js";

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
