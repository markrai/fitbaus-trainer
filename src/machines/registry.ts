import { proformSmartPower10Adapter } from "./proformSmartPower10.js";
import type { Activity } from "../types.js";
import type { MachineAdapter, MachineDefinition, MachineId } from "./types.js";

const adapters: readonly MachineAdapter[] = Object.freeze([proformSmartPower10Adapter]);

export const machineRegistry: readonly MachineDefinition[] = Object.freeze(
  adapters.map((adapter) => Object.freeze({ ...adapter.definition }))
);

export function getMachineAdapter(id: string): MachineAdapter | undefined {
  return adapters.find((adapter) => adapter.definition.id === id);
}

export function getMachineDefinition(id: string): MachineDefinition | undefined {
  return machineRegistry.find((machine) => machine.id === id);
}

export function isMachineId(id: unknown): id is MachineId {
  return typeof id === "string" && getMachineDefinition(id) !== undefined;
}

export function listMachinesForActivity(activity: Activity): readonly MachineDefinition[] {
  return machineRegistry.filter((machine) => machine.activity === activity);
}
