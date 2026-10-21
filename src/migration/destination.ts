/**
 * Current-destination mechanics: destination identity (from src/persistence/),
 * localStorage adapter, IndexedDB helpers, destination-empty preflight, and
 * post-import verification against a bundle.
 */

import { CURRENT_DB_NAME, CURRENT_DB_VERSION, applyCurrentSchemaUpgrade } from "../persistence/currentSchema.js";
import {
  DURABLE_LOCAL_STORAGE_KEYS,
  EPHEMERAL_LOCAL_STORAGE_KEYS,
  MIGRATION_LOCAL_STORAGE_KEYS,
} from "../persistence/localStorageKeys.js";
import {
  MIGRATION_STORE_NAMES,
  type MigrationBundle,
  type MigrationStoreEntry,
  type MigrationStoreName,
} from "./contracts.js";
import { canonicalKeyText, sortStoreEntries } from "./bundle.js";
import { sha256Hex } from "./integrity.js";
import { canonicalStringify, isRecord } from "./serialization.js";

export const DESTINATION_DB_NAME = CURRENT_DB_NAME;
export const DESTINATION_DB_VERSION = CURRENT_DB_VERSION;
export const MIGRATION_RECEIPT_KEY = MIGRATION_LOCAL_STORAGE_KEYS.migrationReceipt;

export interface MigrationLocalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

export function browserMigrationLocalStorage(): MigrationLocalStorage {
  return {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
    keys: () => {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) keys.push(key);
      }
      return keys;
    },
  };
}

export function openDestinationDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DESTINATION_DB_NAME, DESTINATION_DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Failed to open destination IndexedDB"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => applyCurrentSchemaUpgrade(request.result);
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function readAllStoreRows(db: IDBDatabase, store: MigrationStoreName): Promise<MigrationStoreEntry[]> {
  if (!db.objectStoreNames.contains(store)) return [];
  const tx = db.transaction([store], "readonly");
  // Observe completion before any request can finish, so the complete/abort
  // event cannot fire before handlers exist.
  const txPromise = txDone(tx);
  const objectStore = tx.objectStore(store);
  let values: unknown[];
  let keys: IDBValidKey[];
  try {
    [values, keys] = await Promise.all([
      idbRequest(objectStore.getAll()),
      idbRequest(objectStore.getAllKeys()),
    ]);
  } catch (error) {
    await txPromise.catch(() => undefined);
    throw error;
  }
  await txPromise;
  return sortStoreEntries(
    (values as Record<string, unknown>[]).map((value, index) => ({ key: keys[index], value }))
  );
}

export async function readAllDestinationStores(
  db: IDBDatabase
): Promise<Record<MigrationStoreName, MigrationStoreEntry[]>> {
  const result = {} as Record<MigrationStoreName, MigrationStoreEntry[]>;
  for (const name of MIGRATION_STORE_NAMES) result[name] = await readAllStoreRows(db, name);
  return result;
}

export type DestinationState = "EMPTY_BOOTSTRAP_STATE" | "MEANINGFUL_USER_DATA";

export interface DestinationPreflight {
  state: DestinationState;
  reasons: string[];
  bootstrapKeysPresent: string[];
}

// NOTE: MIGRATION_RECEIPT_KEY is deliberately NOT harmless. Any receipt is
// meaningful destination state and is handled explicitly in the importer.
const HARMLESS_DESTINATION_KEYS: ReadonlySet<string> = new Set([
  EPHEMERAL_LOCAL_STORAGE_KEYS.installPromptShown,
  EPHEMERAL_LOCAL_STORAGE_KEYS.enableServiceWorkerDev,
]);

function profileLooksLikeEmptyBootstrap(storage: MigrationLocalStorage): boolean {
  const raw = storage.getItem(DURABLE_LOCAL_STORAGE_KEYS.athleteProfile);
  if (raw === null) return true;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return false;
    if (parsed.userEnteredVo2 !== undefined && parsed.userEnteredVo2 !== null) return false;
    const demographics = parsed.demographics;
    if (demographics === undefined || demographics === null) return true;
    if (!isRecord(demographics)) return false;
    return Object.values(demographics).every((v) => v === undefined || v === null || v === "");
  } catch {
    return false;
  }
}

export function inspectDestinationLocalState(storage: MigrationLocalStorage): DestinationPreflight {
  const reasons: string[] = [];
  const bootstrapKeysPresent: string[] = [];
  for (const key of storage.keys()) {
    if (HARMLESS_DESTINATION_KEYS.has(key)) continue;
    if (key === DURABLE_LOCAL_STORAGE_KEYS.athleteIdentity) {
      bootstrapKeysPresent.push(key);
      continue;
    }
    if (key === DURABLE_LOCAL_STORAGE_KEYS.athleteProfile) {
      if (profileLooksLikeEmptyBootstrap(storage)) bootstrapKeysPresent.push(key);
      else reasons.push(`athlete_profile_v1 already contains entered profile data`);
      continue;
    }
    reasons.push(`existing destination key: ${key}`);
  }
  return {
    state: reasons.length === 0 ? "EMPTY_BOOTSTRAP_STATE" : "MEANINGFUL_USER_DATA",
    reasons,
    bootstrapKeysPresent,
  };
}

export interface MigrationVerificationReport {
  status: "VERIFIED_MATCH" | "MISMATCH";
  workouts: { expected: number; actual: number; sessionIdsMatch: boolean; digestMatch: boolean };
  hrSamples: { expected: number; actual: number; digestMatch: boolean };
  ordinaryBikeTelemetry: { expected: number; actual: number; digestMatch: boolean };
  sisuSettings: { expected: number; actual: number; digestMatch: boolean };
  storeDigests: Record<MigrationStoreName, { expected: string; actual: string; digestMatch: boolean }>;
  localStorage: { expectedKeys: number; actualKeysPresent: number; digestMatch: boolean };
  athleteIdentityPresent: boolean;
  profilePresent: boolean;
  fitnessStatePresent: boolean;
  formalCalibrationProvenancePresent: boolean;
  machineLearningPresent: boolean;
  hrDynamicsPresent: boolean;
  shadowPredictionsPresent: boolean;
  equipmentPresent: boolean;
  bikeBridgePresent: boolean;
  mismatches: string[];
}

/**
 * Order destination rows like the bundle's stored entries (by primary key) so
 * digest comparison does not depend on the comparator the exporter used.
 * Rows absent from the bundle are appended, so extra rows still mismatch.
 */
function alignStoresToBundleOrder(
  bundle: MigrationBundle,
  actualStores: Record<MigrationStoreName, MigrationStoreEntry[]>
): Record<MigrationStoreName, MigrationStoreEntry[]> {
  const aligned = {} as Record<MigrationStoreName, MigrationStoreEntry[]>;
  for (const name of MIGRATION_STORE_NAMES) {
    const remaining = new Map(actualStores[name].map((entry) => [canonicalKeyText(entry.key), entry]));
    const ordered: MigrationStoreEntry[] = [];
    for (const expected of bundle.indexeddb.stores[name]) {
      const keyText = canonicalKeyText(expected.key);
      const actual = remaining.get(keyText);
      if (actual === undefined) continue;
      ordered.push(actual);
      remaining.delete(keyText);
    }
    aligned[name] = [...ordered, ...remaining.values()];
  }
  return aligned;
}

export async function verifyDestinationAgainstBundle(
  bundle: MigrationBundle,
  storage: MigrationLocalStorage,
  db: IDBDatabase
): Promise<MigrationVerificationReport> {
  const mismatches: string[] = [];
  const actualStores = alignStoresToBundleOrder(bundle, await readAllDestinationStores(db));
  const expectedWorkouts = bundle.indexeddb.stores.workouts;
  const actualWorkoutIds = new Set(actualStores.workouts.map((e) => canonicalKeyText(e.key)));
  const sessionIdsMatch =
    actualWorkoutIds.size === expectedWorkouts.length &&
    expectedWorkouts.every((e) => actualWorkoutIds.has(canonicalKeyText(e.key)));
  if (!sessionIdsMatch) mismatches.push("workout session-ID set mismatch");

  const actualIndexeddbDigest = await sha256Hex(canonicalStringify(actualStores));
  const indexeddbDigestMatch = actualIndexeddbDigest === bundle.manifest.section_digests.indexeddb;
  if (!indexeddbDigestMatch) mismatches.push("destination IndexedDB digest mismatch");
  const storeDigests = {} as MigrationVerificationReport["storeDigests"];
  for (const name of MIGRATION_STORE_NAMES) {
    const actual = await sha256Hex(canonicalStringify(actualStores[name]));
    const expected = bundle.manifest.store_digests[name];
    storeDigests[name] = { expected, actual, digestMatch: actual === expected };
    if (actual !== expected) mismatches.push(`destination store ${name} digest mismatch`);
  }

  const actualLocalEntries = bundle.local_storage.map((entry) => ({
    ...entry,
    value: storage.getItem(entry.destination_key) ?? "\u0000MISSING",
  }));
  const localDigestMatch =
    (await sha256Hex(canonicalStringify(actualLocalEntries))) === bundle.manifest.section_digests.local_storage;
  if (!localDigestMatch) mismatches.push("destination localStorage digest mismatch");
  const actualKeysPresent = bundle.local_storage.filter(
    (entry) => storage.getItem(entry.destination_key) !== null
  ).length;

  const has = (key: string) => storage.getItem(key) !== null;
  const report: MigrationVerificationReport = {
    status: mismatches.length === 0 ? "VERIFIED_MATCH" : "MISMATCH",
    workouts: {
      expected: expectedWorkouts.length,
      actual: actualStores.workouts.length,
      sessionIdsMatch,
      digestMatch: storeDigests.workouts.digestMatch,
    },
    hrSamples: {
      expected: bundle.manifest.store_counts.hr_samples,
      actual: actualStores.hr_samples.length,
      digestMatch: storeDigests.hr_samples.digestMatch,
    },
    ordinaryBikeTelemetry: {
      expected: bundle.manifest.store_counts.ordinary_bike_telemetry,
      actual: actualStores.ordinary_bike_telemetry.length,
      digestMatch: storeDigests.ordinary_bike_telemetry.digestMatch,
    },
    sisuSettings: {
      expected: bundle.manifest.store_counts.sisu_settings,
      actual: actualStores.sisu_settings.length,
      digestMatch: storeDigests.sisu_settings.digestMatch,
    },
    storeDigests,
    localStorage: {
      expectedKeys: bundle.local_storage.length,
      actualKeysPresent,
      digestMatch: localDigestMatch,
    },
    athleteIdentityPresent: has(DURABLE_LOCAL_STORAGE_KEYS.athleteIdentity),
    profilePresent: has(DURABLE_LOCAL_STORAGE_KEYS.athleteProfile),
    fitnessStatePresent: has(DURABLE_LOCAL_STORAGE_KEYS.fitnessState),
    formalCalibrationProvenancePresent: has(DURABLE_LOCAL_STORAGE_KEYS.formalCalibrationMachineProvenance),
    machineLearningPresent: has(DURABLE_LOCAL_STORAGE_KEYS.machineLearning),
    hrDynamicsPresent: has(DURABLE_LOCAL_STORAGE_KEYS.hrDynamics),
    shadowPredictionsPresent: has(DURABLE_LOCAL_STORAGE_KEYS.shadowResistancePredictions),
    equipmentPresent: has(DURABLE_LOCAL_STORAGE_KEYS.equipmentSelection),
    bikeBridgePresent: has(DURABLE_LOCAL_STORAGE_KEYS.bikeBridge),
    mismatches,
  };
  return report;
}
