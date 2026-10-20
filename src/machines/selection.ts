import type { Activity } from "../types.js";
import { getMachineDefinition, isMachineId } from "./registry.js";
import type { EquipmentSelection, MachineDefinition, MachineId } from "./types.js";

export const EQUIPMENT_STORAGE_KEY = "fitbaus_trainer_equipment_selection";

export interface EquipmentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storageOrBrowser(storage?: EquipmentStorage): EquipmentStorage {
  return storage ?? localStorage;
}

function sanitizeSelection(value: unknown): EquipmentSelection {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const selection: EquipmentSelection = {};
  if (isMachineId(raw.bike) && getMachineDefinition(raw.bike)?.activity === "bike") selection.bike = raw.bike;
  if (isMachineId(raw.elliptical) && getMachineDefinition(raw.elliptical)?.activity === "elliptical") {
    selection.elliptical = raw.elliptical;
  }
  return selection;
}

export function getEquipmentSelection(storage?: EquipmentStorage): EquipmentSelection {
  try {
    const raw = storageOrBrowser(storage).getItem(EQUIPMENT_STORAGE_KEY);
    return raw ? sanitizeSelection(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function saveEquipmentSelection(selection: EquipmentSelection, storage?: EquipmentStorage): EquipmentSelection {
  const clean = sanitizeSelection(selection);
  storageOrBrowser(storage).setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function setSelectedMachine(
  activity: "bike" | "elliptical",
  machineId: MachineId | undefined,
  storage?: EquipmentStorage
): EquipmentSelection {
  const selection = getEquipmentSelection(storage);
  if (machineId === undefined) delete selection[activity];
  else {
    const definition = getMachineDefinition(machineId);
    if (!definition || definition.activity !== activity) throw new Error(`Machine ${machineId} does not support ${activity}`);
    selection[activity] = machineId;
  }
  return saveEquipmentSelection(selection, storage);
}

export function getSelectedMachineId(activity: Activity, storage?: EquipmentStorage): MachineId | undefined {
  const selection = getEquipmentSelection(storage);
  if (activity === "bike" || activity === "elliptical") return selection[activity];
  return undefined;
}

export function resolveSelectedMachine(activity: Activity, storage?: EquipmentStorage): MachineDefinition | undefined {
  const id = getSelectedMachineId(activity, storage);
  return id ? getMachineDefinition(id) : undefined;
}
