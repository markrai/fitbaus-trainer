/**
 * The persisted WorkoutSummary shape.
 */

import type { MachineDecisionAuditEntry } from "../machines/audit/types.js";
import type { MachineGuidanceTraceEntry, MachineId } from "../machines/trace.js";
import type { WorkoutExecutionProvenanceV1 } from "./executionProvenance.js";
import type { AthleteFitnessSnapshot } from "./fitnessState.js";
import type { PersonalizedPrescriptionCharacterization } from "./personalizedPrescriptionCharacterization.js";
import type { PersonalizedPrescriptionEvaluationV1 } from "./personalizedPrescriptionEvaluation.js";
import type { Vo2AssessmentResult } from "./vo2Assessment.js";
import type { Vo2Evidence } from "./vo2Evidence.js";
import type { Activity, DayName, ResolvedWorkoutPrescription } from "./workoutPrescription.js";
import type { WorkoutResponse, ZoneMinutes } from "./workoutResponse.js";

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
