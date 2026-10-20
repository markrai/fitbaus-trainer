import type { Activity, WorkoutPhaseKind } from "../types.js";
import type { MachineId } from "./trace.js";
import type {
  MachineDecision,
  MachineDecisionConstraint,
  MachineDecisionReason,
  MachineHeartRateAssessment,
  MachineWorkDurationBand,
} from "./audit/types.js";

export type { MachineId, MachineGuidanceTraceEntry } from "./trace.js";
export type {
  MachineDecision,
  MachineDecisionConstraint,
  MachineDecisionReason,
  MachineHeartRateAssessment,
  MachineWorkDurationBand,
} from "./audit/types.js";

export interface MachineDefinition {
  id: MachineId;
  name: string;
  activity: Activity;
  profileVersion: number;
}

export interface EquipmentSelection {
  bike?: MachineId;
  elliptical?: MachineId;
}

export interface MachineHeartRateSample {
  elapsedSeconds: number;
  bpm: number;
}

export interface CompletedShortWorkPhase {
  phaseId: string;
  phaseDurationSeconds: number;
  resistance: number;
  targetHeartRateMin?: number;
  targetHeartRateMax?: number;
  recentHeartRates: readonly MachineHeartRateSample[];
}

export interface MachineGuidanceContext {
  machineId: MachineId;
  activity: Activity;
  phaseKind: WorkoutPhaseKind;
  phaseId: string;
  phaseElapsedSeconds: number;
  phaseDurationSeconds: number;
  workoutElapsedSeconds: number;
  intervalIndex?: number;
  heartRateBpm?: number;
  targetHeartRateMin?: number;
  targetHeartRateMax?: number;
  /** Frozen legacy workout intent; never a personalization candidate or prediction. */
  intent?: string;
  recentHeartRates: readonly MachineHeartRateSample[];
  previousGuidance?: MachineGuidance;
  completedShortWork?: CompletedShortWorkPhase;
  learnedStartingResistance?: number;
  personalizedTiming?: PersonalizedWorkTiming;
  holdResistance?: number;
  holdCadenceRpm?: number;
}

export interface PersonalizedWorkTiming {
  initialEvaluationSeconds?: number;
  increaseCooldownSeconds?: number;
  decreaseCooldownSeconds?: number;
}

export interface WorkResistanceClassification {
  assessment: MachineHeartRateAssessment;
  decision: MachineDecision;
  constraint: MachineDecisionConstraint;
  decisionReason: MachineDecisionReason;
  resistanceBefore: number;
  resistanceAfter: number;
}

export interface WorkPhaseStartObservation {
  phaseKind: WorkoutPhaseKind;
  phaseId: string;
  intervalIndex?: number;
  phaseElapsedSeconds: number;
  phaseDurationSeconds: number;
  resistance: number;
  targetHeartRateMin?: number;
  targetHeartRateMax?: number;
  initialEvaluationWaitSeconds: number;
  nextEligiblePhaseElapsedSeconds: number;
  personalizedTiming?: PersonalizedWorkTiming;
}

export interface WorkEvaluationObservation {
  deferred: boolean;
  durationBand: MachineWorkDurationBand;
  phaseKind: WorkoutPhaseKind;
  phaseId: string;
  intervalIndex?: number;
  phaseElapsedSeconds: number;
  phaseDurationSeconds: number;
  targetHeartRateMin?: number;
  targetHeartRateMax?: number;
  representativeHeartRate?: number;
  representativeSampleCount?: number;
  representativeWindowSpanSeconds?: number;
  resistanceBefore: number;
  resistanceAfter: number;
  heartRateAssessment?: MachineHeartRateAssessment;
  decision?: MachineDecision;
  constraint?: MachineDecisionConstraint;
  decisionReason?: MachineDecisionReason;
  waitBeforeEvaluationSeconds?: number;
  nextEvaluationWaitSeconds?: number;
  nextEligiblePhaseElapsedSeconds?: number;
  eligibleSincePhaseElapsedSeconds?: number;
  personalizedTiming?: PersonalizedWorkTiming;
}

export interface MachineGuidance {
  machineId: MachineId;
  resistance?: number;
  cadenceRpm?: number;
  estimatedWatts?: number;
  action: "hold" | "increase" | "decrease" | "set";
  reason: string;
}

export interface MachineGuidanceState {
  currentPhaseId?: string;
  currentPhaseKind?: WorkoutPhaseKind;
  currentResistance?: number;
  currentCadenceRpm?: number;
  nextWorkResistance?: number;
  lastEvaluationPhaseElapsedSeconds?: number;
  shortIntervalEvaluated: boolean;
  mediumIntervalEvaluated: boolean;
  initialEvaluationSeconds?: number;
  increaseCooldownSeconds?: number;
  decreaseCooldownSeconds?: number;
  currentEvaluationCooldownSeconds?: number;
  lastWorkAdjustmentDirection?: "increase" | "decrease";
}

export interface MachineGuidanceResult {
  guidance: MachineGuidance;
  state: MachineGuidanceState;
  workPhaseStarted?: WorkPhaseStartObservation;
  workEvaluation?: WorkEvaluationObservation;
  priorWorkEvaluation?: WorkEvaluationObservation;
}

export interface MachineAdapter {
  definition: MachineDefinition;
  getGuidance(context: MachineGuidanceContext, state: MachineGuidanceState): MachineGuidanceResult;
}

export interface MachineGuidanceVoiceEvent {
  machineId: MachineId;
  phaseId: string;
  phaseKind: WorkoutPhaseKind;
  phaseDisplayName: string;
  intervalIndex?: number;
  phaseChanged: boolean;
  recommendationChanged: boolean;
  guidance: MachineGuidance;
}
