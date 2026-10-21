/**
 * Workout plan and prescription contracts: plan primitives (day, activity,
 * phase), the legacy HR-target resolver identity, resolved prescriptions, and
 * per-day HR target and metadata shapes.
 */

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
