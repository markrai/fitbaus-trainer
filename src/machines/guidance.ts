import { getMachineAdapter } from "./registry.js";
import type {
  MachineGuidance,
  MachineGuidanceContext,
  MachineGuidanceResult,
  MachineGuidanceState,
} from "./types.js";

export function createMachineGuidanceState(): MachineGuidanceState {
  return {
    shortIntervalEvaluated: false,
    mediumIntervalEvaluated: false,
  };
}

export function getMachineGuidance(
  context: MachineGuidanceContext,
  state: MachineGuidanceState
): MachineGuidanceResult | null {
  const adapter = getMachineAdapter(context.machineId);
  if (!adapter || adapter.definition.activity !== context.activity) return null;
  return adapter.getGuidance(context, state);
}

export function isSameMachineRecommendation(
  previous: MachineGuidance | undefined,
  next: MachineGuidance
): boolean {
  return previous?.machineId === next.machineId &&
    previous.resistance === next.resistance &&
    previous.cadenceRpm === next.cadenceRpm &&
    previous.estimatedWatts === next.estimatedWatts;
}
