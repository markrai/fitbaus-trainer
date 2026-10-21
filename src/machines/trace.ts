import type { WorkoutPhaseKind } from "../contracts/workoutPrescription.js";

export type MachineId = "proform-smart-power-10";

export interface MachineGuidanceTraceEntry {
  elapsedSeconds: number;
  resistance: number;
  cadenceRpm: number;
  estimatedWatts?: number;
  phaseKind?: WorkoutPhaseKind;
  phaseId?: string;
  intervalIndex?: number;
  phaseDurationSeconds?: number;
  phaseElapsedSeconds?: number;
  targetHeartRateMin?: number;
  targetHeartRateMax?: number;
  reason: string;
}
