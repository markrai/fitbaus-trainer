import { integerMedian } from "../hrQuality.js";
import { getMachineDefinition, isMachineId } from "../registry.js";
import type { EquipmentStorage } from "../selection.js";
import { learningKey, parseLearningKey, type LearningKeyParts } from "../learning/types.js";
import { hasActiveTimingPersonalization, timingModeForEntry } from "./timing.js";
import {
  DYNAMICS_SAMPLE_LIMIT,
  DYNAMICS_STORAGE_KEY,
  DYNAMICS_STORE_VERSION,
  MAX_ABS_HR_DELTA,
  MAX_ABS_HR_PER_LEVEL,
  RECENT_OPPORTUNITY_LIMIT,
  RESPONSE_SEARCH_SECONDS,
  type LearnedHrDynamics,
  type LearnedHrDynamicsStore,
  type RecentHrResponse,
  type StoredDynamicsEntry,
} from "./types.js";
import { recentDetectedCount, recentObservationCount } from "./recent.js";

export type DynamicsStorage = EquipmentStorage;

function storageOrBrowser(storage?: DynamicsStorage): DynamicsStorage {
  return storage ?? localStorage;
}

function emptyEntry(updatedAt: string): StoredDynamicsEntry {
  return {
    workStartDelays: [],
    workStartHrDeltas: [],
    increaseDelays: [],
    increaseHrPerLevel: [],
    decreaseDelays: [],
    decreaseHrPerLevel: [],
    workStartObservationCount: 0,
    workStartDetectedResponseCount: 0,
    increaseObservationCount: 0,
    increaseDetectedResponseCount: 0,
    decreaseObservationCount: 0,
    decreaseDetectedResponseCount: 0,
    workStartRecentResponses: [],
    increaseRecentResponses: [],
    decreaseRecentResponses: [],
    updatedAt,
  };
}

export function emptyDynamicsStore(): LearnedHrDynamicsStore {
  return { version: DYNAMICS_STORE_VERSION, entries: {} };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizeNumberArray(value: unknown, allowed: (item: number) => boolean): number[] {
  if (!Array.isArray(value)) return [];
  const clean: number[] = [];
  for (const item of value) {
    if (!isFiniteNumber(item) || !allowed(item)) continue;
    clean.push(item);
  }
  return clean.slice(-DYNAMICS_SAMPLE_LIMIT);
}

function sanitizeCount(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) return 0;
  return value as number;
}

function sanitizeDetectedCount(detected: unknown, observed: number): number {
  return Math.min(sanitizeCount(detected), observed);
}

function sanitizeRecentResponses(value: unknown): RecentHrResponse[] {
  if (!Array.isArray(value)) return [];
  const clean: RecentHrResponse[] = [];
  for (const item of value) {
    if (item === null) {
      clean.push(null);
      continue;
    }
    if (isFiniteNumber(item) && delayAllowed(item)) clean.push(item);
  }
  return clean.slice(-RECENT_OPPORTUNITY_LIMIT);
}

function delayAllowed(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= RESPONSE_SEARCH_SECONDS;
}

function hrDeltaAllowed(value: number): boolean {
  return Number.isInteger(value) && Math.abs(value) <= MAX_ABS_HR_DELTA;
}

function perLevelAllowed(value: number): boolean {
  return Number.isInteger(value) && Math.abs(value) <= MAX_ABS_HR_PER_LEVEL;
}

function sanitizeStoredEntry(value: unknown): StoredDynamicsEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.updatedAt !== "string" || raw.updatedAt.trim() === "") return undefined;
  return {
    workStartDelays: sanitizeNumberArray(raw.workStartDelays, delayAllowed),
    workStartHrDeltas: sanitizeNumberArray(raw.workStartHrDeltas, hrDeltaAllowed),
    increaseDelays: sanitizeNumberArray(raw.increaseDelays, delayAllowed),
    increaseHrPerLevel: sanitizeNumberArray(raw.increaseHrPerLevel, perLevelAllowed),
    decreaseDelays: sanitizeNumberArray(raw.decreaseDelays, delayAllowed),
    decreaseHrPerLevel: sanitizeNumberArray(raw.decreaseHrPerLevel, perLevelAllowed),
    workStartObservationCount: sanitizeCount(raw.workStartObservationCount),
    workStartDetectedResponseCount: sanitizeDetectedCount(
      raw.workStartDetectedResponseCount,
      sanitizeCount(raw.workStartObservationCount)
    ),
    increaseObservationCount: sanitizeCount(raw.increaseObservationCount),
    increaseDetectedResponseCount: sanitizeDetectedCount(
      raw.increaseDetectedResponseCount,
      sanitizeCount(raw.increaseObservationCount)
    ),
    decreaseObservationCount: sanitizeCount(raw.decreaseObservationCount),
    decreaseDetectedResponseCount: sanitizeDetectedCount(
      raw.decreaseDetectedResponseCount,
      sanitizeCount(raw.decreaseObservationCount)
    ),
    workStartRecentResponses: sanitizeRecentResponses(raw.workStartRecentResponses),
    increaseRecentResponses: sanitizeRecentResponses(raw.increaseRecentResponses),
    decreaseRecentResponses: sanitizeRecentResponses(raw.decreaseRecentResponses),
    updatedAt: raw.updatedAt,
  };
}

export function sanitizeDynamicsStore(value: unknown): LearnedHrDynamicsStore {
  if (!value || typeof value !== "object") return emptyDynamicsStore();
  const raw = value as Record<string, unknown>;
  if (raw.version !== DYNAMICS_STORE_VERSION || !raw.entries || typeof raw.entries !== "object") {
    return emptyDynamicsStore();
  }
  const entries: Record<string, StoredDynamicsEntry> = {};
  for (const [key, entry] of Object.entries(raw.entries as Record<string, unknown>)) {
    const parsed = parseLearningKey(key);
    const clean = sanitizeStoredEntry(entry);
    if (!parsed || !clean) continue;
    if (!isMachineId(parsed.machineId)) continue;
    const definition = getMachineDefinition(parsed.machineId);
    if (!definition || definition.activity !== parsed.activity) continue;
    entries[key] = clean;
  }
  return { version: DYNAMICS_STORE_VERSION, entries };
}

export function loadDynamicsStore(storage?: DynamicsStorage): LearnedHrDynamicsStore {
  try {
    const raw = storageOrBrowser(storage).getItem(DYNAMICS_STORAGE_KEY);
    return raw ? sanitizeDynamicsStore(JSON.parse(raw)) : emptyDynamicsStore();
  } catch {
    return emptyDynamicsStore();
  }
}

export function saveDynamicsStore(
  store: LearnedHrDynamicsStore,
  storage?: DynamicsStorage
): LearnedHrDynamicsStore {
  const clean = sanitizeDynamicsStore(store);
  storageOrBrowser(storage).setItem(DYNAMICS_STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function appendBoundedSample(values: readonly number[], value: number): number[] {
  const next = [...values, value];
  return next.length > DYNAMICS_SAMPLE_LIMIT ? next.slice(-DYNAMICS_SAMPLE_LIMIT) : next;
}

export function appendBoundedRecentResponse(
  values: readonly RecentHrResponse[],
  value: RecentHrResponse
): RecentHrResponse[] {
  const next = [...values, value];
  return next.length > RECENT_OPPORTUNITY_LIMIT ? next.slice(-RECENT_OPPORTUNITY_LIMIT) : next;
}

export function toPublicDynamics(parts: LearningKeyParts, entry: StoredDynamicsEntry): LearnedHrDynamics {
  const listed: LearnedHrDynamics = {
    ...parts,
    workStartSampleCount: Math.max(entry.workStartDelays.length, entry.workStartHrDeltas.length),
    workStartDelaySampleCount: entry.workStartDelays.length,
    medianWorkStartDelaySeconds: integerMedian(entry.workStartDelays),
    medianWorkStartHrDelta: integerMedian(entry.workStartHrDeltas),
    increaseSampleCount: Math.max(entry.increaseDelays.length, entry.increaseHrPerLevel.length),
    increaseDelaySampleCount: entry.increaseDelays.length,
    medianIncreaseDelaySeconds: integerMedian(entry.increaseDelays),
    medianIncreaseHrDeltaPerStep: integerMedian(entry.increaseHrPerLevel),
    decreaseSampleCount: Math.max(entry.decreaseDelays.length, entry.decreaseHrPerLevel.length),
    decreaseDelaySampleCount: entry.decreaseDelays.length,
    medianDecreaseDelaySeconds: integerMedian(entry.decreaseDelays),
    medianDecreaseHrDeltaPerStep: integerMedian(entry.decreaseHrPerLevel),
    workStartObservationCount: entry.workStartObservationCount,
    workStartDetectedResponseCount: entry.workStartDetectedResponseCount,
    increaseObservationCount: entry.increaseObservationCount,
    increaseDetectedResponseCount: entry.increaseDetectedResponseCount,
    decreaseObservationCount: entry.decreaseObservationCount,
    decreaseDetectedResponseCount: entry.decreaseDetectedResponseCount,
    workStartRecentObservationCount: recentObservationCount(entry.workStartRecentResponses ?? []),
    workStartRecentDetectedResponseCount: recentDetectedCount(entry.workStartRecentResponses ?? []),
    increaseRecentObservationCount: recentObservationCount(entry.increaseRecentResponses ?? []),
    increaseRecentDetectedResponseCount: recentDetectedCount(entry.increaseRecentResponses ?? []),
    decreaseRecentObservationCount: recentObservationCount(entry.decreaseRecentResponses ?? []),
    decreaseRecentDetectedResponseCount: recentDetectedCount(entry.decreaseRecentResponses ?? []),
    updatedAt: entry.updatedAt,
  };
  if (hasActiveTimingPersonalization(entry, parts.durationClass)) listed.timingPersonalized = true;
  const timingMode = timingModeForEntry(entry, parts.durationClass);
  if (timingMode) listed.timingMode = timingMode;
  return listed;
}

export function getDynamicsEntry(
  parts: LearningKeyParts,
  storage?: DynamicsStorage
): StoredDynamicsEntry | undefined {
  return loadDynamicsStore(storage).entries[learningKey(parts)];
}

export function listHrDynamics(machineId: string, storage?: DynamicsStorage): LearnedHrDynamics[] {
  const store = loadDynamicsStore(storage);
  const listed: LearnedHrDynamics[] = [];
  for (const [key, entry] of Object.entries(store.entries)) {
    const parsed = parseLearningKey(key);
    if (!parsed || parsed.machineId !== machineId) continue;
    listed.push(toPublicDynamics(parsed, entry));
  }
  listed.sort((a, b) => {
    const intent = a.intent.localeCompare(b.intent);
    if (intent !== 0) return intent;
    return a.durationClass.localeCompare(b.durationClass);
  });
  return listed;
}

export function putDynamicsEntry(
  parts: LearningKeyParts,
  entry: StoredDynamicsEntry,
  storage?: DynamicsStorage
): LearnedHrDynamics | undefined {
  const store = loadDynamicsStore(storage);
  const key = learningKey(parts);
  store.entries[key] = entry;
  const saved = saveDynamicsStore(store, storage).entries[key];
  if (!saved) return undefined;
  return toPublicDynamics(parts, saved);
}

export function resetHrDynamicsForMachine(machineId: string, storage?: DynamicsStorage): LearnedHrDynamicsStore {
  const store = loadDynamicsStore(storage);
  const entries: Record<string, StoredDynamicsEntry> = {};
  for (const [key, entry] of Object.entries(store.entries)) {
    const parsed = parseLearningKey(key);
    if (!parsed || parsed.machineId === machineId) continue;
    entries[key] = entry;
  }
  return saveDynamicsStore({ version: DYNAMICS_STORE_VERSION, entries }, storage);
}

export function entryHasDynamicsSamples(entry: StoredDynamicsEntry): boolean {
  return (
    entry.workStartDelays.length > 0 ||
    entry.workStartHrDeltas.length > 0 ||
    entry.increaseDelays.length > 0 ||
    entry.increaseHrPerLevel.length > 0 ||
    entry.decreaseDelays.length > 0 ||
    entry.decreaseHrPerLevel.length > 0 ||
    entry.workStartObservationCount > 0 ||
    entry.increaseObservationCount > 0 ||
    entry.decreaseObservationCount > 0 ||
    (entry.workStartRecentResponses?.length ?? 0) > 0 ||
    (entry.increaseRecentResponses?.length ?? 0) > 0 ||
    (entry.decreaseRecentResponses?.length ?? 0) > 0
  );
}

export function cloneEntry(entry: StoredDynamicsEntry): StoredDynamicsEntry {
  return {
    workStartDelays: [...entry.workStartDelays],
    workStartHrDeltas: [...entry.workStartHrDeltas],
    increaseDelays: [...entry.increaseDelays],
    increaseHrPerLevel: [...entry.increaseHrPerLevel],
    decreaseDelays: [...entry.decreaseDelays],
    decreaseHrPerLevel: [...entry.decreaseHrPerLevel],
    workStartObservationCount: entry.workStartObservationCount ?? 0,
    workStartDetectedResponseCount: entry.workStartDetectedResponseCount ?? 0,
    increaseObservationCount: entry.increaseObservationCount ?? 0,
    increaseDetectedResponseCount: entry.increaseDetectedResponseCount ?? 0,
    decreaseObservationCount: entry.decreaseObservationCount ?? 0,
    decreaseDetectedResponseCount: entry.decreaseDetectedResponseCount ?? 0,
    workStartRecentResponses: [...(entry.workStartRecentResponses ?? [])],
    increaseRecentResponses: [...(entry.increaseRecentResponses ?? [])],
    decreaseRecentResponses: [...(entry.decreaseRecentResponses ?? [])],
    updatedAt: entry.updatedAt,
  };
}

export function emptyDynamicsEntry(updatedAt: string): StoredDynamicsEntry {
  return emptyEntry(updatedAt);
}
