import { getMachineDefinition, isMachineId } from "../registry.js";
import { clampAutomaticResistance } from "../proformSmartPower10.js";
import type { EquipmentStorage } from "../selection.js";
import {
  LEARNING_STORAGE_KEY,
  LEARNING_STORE_VERSION,
  learningKey,
  parseLearningKey,
  type LearnedMachineStart,
  type LearnedMachineStore,
  type LearningKeyParts,
  type StoredLearnedEntry,
} from "./types.js";

export type LearningStorage = EquipmentStorage;

function storageOrBrowser(storage?: LearningStorage): LearningStorage {
  return storage ?? localStorage;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function sanitizeStoredEntry(value: unknown): StoredLearnedEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!isPositiveInteger(raw.resistance) || !isPositiveInteger(raw.sampleCount)) return undefined;
  if (typeof raw.updatedAt !== "string" || raw.updatedAt.trim() === "") return undefined;
  const resistance = clampAutomaticResistance(raw.resistance);
  if (resistance !== raw.resistance) return undefined;
  return {
    resistance,
    sampleCount: raw.sampleCount,
    updatedAt: raw.updatedAt,
  };
}

export function emptyLearnedStore(): LearnedMachineStore {
  return { version: LEARNING_STORE_VERSION, entries: {} };
}

export function sanitizeLearnedStore(value: unknown): LearnedMachineStore {
  if (!value || typeof value !== "object") return emptyLearnedStore();
  const raw = value as Record<string, unknown>;
  if (raw.version !== LEARNING_STORE_VERSION || !raw.entries || typeof raw.entries !== "object") {
    return emptyLearnedStore();
  }
  const entries: Record<string, StoredLearnedEntry> = {};
  for (const [key, entry] of Object.entries(raw.entries as Record<string, unknown>)) {
    const parsed = parseLearningKey(key);
    const clean = sanitizeStoredEntry(entry);
    if (!parsed || !clean) continue;
    if (!isMachineId(parsed.machineId)) continue;
    const definition = getMachineDefinition(parsed.machineId);
    if (!definition || definition.activity !== parsed.activity) continue;
    entries[key] = clean;
  }
  return { version: LEARNING_STORE_VERSION, entries };
}

export function loadLearnedStore(storage?: LearningStorage): LearnedMachineStore {
  try {
    const raw = storageOrBrowser(storage).getItem(LEARNING_STORAGE_KEY);
    return raw ? sanitizeLearnedStore(JSON.parse(raw)) : emptyLearnedStore();
  } catch {
    return emptyLearnedStore();
  }
}

export function saveLearnedStore(store: LearnedMachineStore, storage?: LearningStorage): LearnedMachineStore {
  const clean = sanitizeLearnedStore(store);
  storageOrBrowser(storage).setItem(LEARNING_STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function getLearnedStartingResistance(
  parts: LearningKeyParts,
  storage?: LearningStorage
): number | undefined {
  const entry = loadLearnedStore(storage).entries[learningKey(parts)];
  return entry?.resistance;
}

export function listLearnedStarts(machineId: string, storage?: LearningStorage): LearnedMachineStart[] {
  const store = loadLearnedStore(storage);
  const listed: LearnedMachineStart[] = [];
  for (const [key, entry] of Object.entries(store.entries)) {
    const parsed = parseLearningKey(key);
    if (!parsed || parsed.machineId !== machineId) continue;
    listed.push({ ...parsed, ...entry });
  }
  listed.sort((a, b) => {
    const intent = a.intent.localeCompare(b.intent);
    if (intent !== 0) return intent;
    return a.durationClass.localeCompare(b.durationClass);
  });
  return listed;
}

export function putLearnedStart(
  parts: LearningKeyParts,
  entry: StoredLearnedEntry,
  storage?: LearningStorage
): LearnedMachineStart | undefined {
  const store = loadLearnedStore(storage);
  const key = learningKey(parts);
  store.entries[key] = entry;
  const saved = saveLearnedStore(store, storage).entries[key];
  if (!saved) return undefined;
  return { ...parts, ...saved };
}

export function resetLearnedGuidanceForMachine(machineId: string, storage?: LearningStorage): LearnedMachineStore {
  const store = loadLearnedStore(storage);
  const entries: Record<string, StoredLearnedEntry> = {};
  for (const [key, entry] of Object.entries(store.entries)) {
    const parsed = parseLearningKey(key);
    if (!parsed || parsed.machineId === machineId) continue;
    entries[key] = entry;
  }
  return saveLearnedStore({ version: LEARNING_STORE_VERSION, entries }, storage);
}

export function applyConservativeUpdate(
  previous: StoredLearnedEntry | undefined,
  candidate: number,
  updatedAt: string
): StoredLearnedEntry {
  const nextResistance = previous
    ? clampAutomaticResistance(previous.resistance + Math.max(-1, Math.min(1, candidate - previous.resistance)))
    : clampAutomaticResistance(candidate);
  return {
    resistance: nextResistance,
    sampleCount: (previous?.sampleCount ?? 0) + 1,
    updatedAt,
  };
}
