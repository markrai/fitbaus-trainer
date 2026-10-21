import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  CURRENT_DB_NAME,
  CURRENT_DB_VERSION,
  CURRENT_STORE_NAMES,
  CURRENT_STORES,
} from "../dist/persistence/currentSchema.js";
import {
  DURABLE_LOCAL_STORAGE_KEYS,
  DURABLE_LOCAL_KEY_CONTRACTS,
  MIGRATION_LOCAL_STORAGE_KEYS,
  EPHEMERAL_LOCAL_STORAGE_KEYS,
  TRANSIENT_LOCAL_KEY_PATTERNS,
  classifyCurrentLocalStorageKey,
  isCurrentDurableLocalStorageKey,
} from "../dist/persistence/localStorageKeys.js";
import {
  DESTINATION_DB_NAME,
  DESTINATION_DB_VERSION,
  LEGACY_DB_NAME,
  LEGACY_KEY_RENAMES,
  LEGACY_PACKAGE_ID,
  MIGRATION_RECEIPT_KEY,
  MIGRATION_STORE_NAMES,
  UNCHANGED_DURABLE_KEYS,
  buildMigrationBundle,
  classifyLegacyLocalStorageKey,
  deriveStoreKey,
  importMigrationBundle,
} from "../dist/dataMigration.js";
import { getSisuSettings } from "../dist/workoutStorage.js";
import { sessionControlModeKey } from "../dist/sessionControlMode.js";
import { executionProvenanceKey } from "../dist/executionProvenance.js";
import {
  ATHLETE_IDENTITY_STORAGE_KEY,
  ATHLETE_PROFILE_STORAGE_KEY,
  LEGACY_PROFILE_STORAGE_KEY,
} from "../dist/profile.js";
import { FITNESS_STATE_STORAGE_KEY } from "../dist/fitnessState.js";
import { FORMAL_CALIBRATION_MACHINE_PROVENANCE_STORAGE_KEY } from "../dist/calibrationMachineProvenance.js";
import { EQUIPMENT_STORAGE_KEY } from "../dist/machines/selection.js";
import { BIKE_BRIDGE_STORAGE_KEY } from "../dist/platform/bikeBridgeConfig.js";
import { LEARNING_STORAGE_KEY } from "../dist/machines/learning/types.js";
import { DYNAMICS_STORAGE_KEY } from "../dist/machines/dynamics/types.js";
import { SHADOW_PREDICTION_STORAGE_KEY } from "../dist/machines/prediction/types.js";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
  keys() {
    return [...this.map.keys()];
  }
}

function normalizeKeyPath(keyPath) {
  return typeof keyPath === "string" ? keyPath : [...keyPath];
}

/** Structural description of a real opened database. */
async function describeDatabase(factory) {
  const db = await new Promise((resolve, reject) => {
    const request = factory.open(CURRENT_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const stores = {};
    const names = [...db.objectStoreNames];
    const tx = db.transaction(names, "readonly");
    for (const name of names) {
      const store = tx.objectStore(name);
      const indexes = [...store.indexNames]
        .map((indexName) => {
          const index = store.index(indexName);
          return { name: index.name, keyPath: normalizeKeyPath(index.keyPath), unique: index.unique };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      stores[name] = { keyPath: normalizeKeyPath(store.keyPath), indexes };
    }
    return { name: db.name, version: db.version, stores };
  } finally {
    db.close();
  }
}

function describeContract() {
  const stores = {};
  for (const name of CURRENT_STORE_NAMES) {
    const definition = CURRENT_STORES[name];
    stores[name] = {
      keyPath: normalizeKeyPath(definition.keyPath),
      indexes: definition.indexes
        .map((index) => ({ name: index.name, keyPath: normalizeKeyPath(index.keyPath), unique: index.unique }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  return { name: CURRENT_DB_NAME, version: CURRENT_DB_VERSION, stores };
}

test("canonical schema: current identity and each of the four stores exactly once", () => {
  assert.equal(CURRENT_DB_NAME, "fitbaus_trainer_db");
  assert.equal(CURRENT_DB_VERSION, 3);
  assert.deepEqual([...CURRENT_STORE_NAMES], ["workouts", "hr_samples", "ordinary_bike_telemetry", "sisu_settings"]);
  assert.equal(new Set(CURRENT_STORE_NAMES).size, CURRENT_STORE_NAMES.length);
  assert.deepEqual(Object.keys(CURRENT_STORES).sort(), [...CURRENT_STORE_NAMES].sort());
  assert.ok(Object.isFrozen(CURRENT_STORES));
  for (const name of CURRENT_STORE_NAMES) assert.ok(Object.isFrozen(CURRENT_STORES[name]));
});

test("canonical schema: key paths and expected indexes", () => {
  const contract = describeContract();
  assert.equal(contract.stores.workouts.keyPath, "session_id");
  assert.deepEqual(contract.stores.hr_samples.keyPath, ["session_id", "timestamp_sec"]);
  assert.deepEqual(contract.stores.ordinary_bike_telemetry.keyPath, ["session_id", "active_sec"]);
  assert.equal(contract.stores.sisu_settings.keyPath, "key");
  assert.deepEqual(contract.stores.workouts.indexes.map((i) => i.name), ["day", "startedAt"]);
  assert.deepEqual(contract.stores.hr_samples.indexes.map((i) => i.name), ["session_id"]);
  assert.deepEqual(
    contract.stores.ordinary_bike_telemetry.indexes.map((i) => i.name),
    ["observed_at", "session_id", "session_source_id"]
  );
  assert.deepEqual(contract.stores.sisu_settings.indexes, []);
});

test("workoutStorage creates exactly the canonical schema", async () => {
  const previous = globalThis.indexedDB;
  const factory = new IDBFactory();
  globalThis.indexedDB = factory;
  try {
    await getSisuSettings();
    assert.deepEqual(await describeDatabase(factory), describeContract());
  } finally {
    globalThis.indexedDB = previous;
  }
});

test("migration destination creates the same schema as workoutStorage", async () => {
  assert.equal(DESTINATION_DB_NAME, CURRENT_DB_NAME);
  assert.equal(DESTINATION_DB_VERSION, CURRENT_DB_VERSION);
  const factory = new IDBFactory();
  const bundle = await buildMigrationBundle({ exportedAt: "2026-01-01T00:00:00.000Z", storeRows: {}, localEntries: [] });
  const result = await importMigrationBundle(bundle, { storage: new MemoryStorage(), indexedDBFactory: factory });
  assert.equal(result.status, "IMPORTED_VERIFIED");
  assert.deepEqual(await describeDatabase(factory), describeContract());
});

/** Historical migration bundle schema v1 store key paths. Frozen; never derived from the current schema. */
const MIGRATION_V1_KEY_PATHS = {
  workouts: "session_id",
  hr_samples: ["session_id", "timestamp_sec"],
  ordinary_bike_telemetry: ["session_id", "active_sec"],
  sisu_settings: "key",
};

test("migration v1 stores are a frozen subset of current stores (current schema may add stores)", () => {
  assert.deepEqual([...MIGRATION_STORE_NAMES], Object.keys(MIGRATION_V1_KEY_PATHS));
  // One-way: every v1 store must be a current destination store. Adding a new current
  // store is legal and does NOT require changing migration bundle schema v1.
  const current = new Set(CURRENT_STORE_NAMES);
  for (const name of MIGRATION_STORE_NAMES) assert.ok(current.has(name), name);
});

test("frozen migration v1 key paths stay compatible with their current destination stores", () => {
  for (const name of MIGRATION_STORE_NAMES) {
    const v1KeyPath = MIGRATION_V1_KEY_PATHS[name];
    const parts = typeof v1KeyPath === "string" ? [v1KeyPath] : v1KeyPath;
    const row = Object.fromEntries(parts.map((part, i) => [part, `${part}-${i}`]));
    const expected = typeof v1KeyPath === "string" ? row[v1KeyPath] : parts.map((part) => row[part]);
    // Migration's own (frozen) key derivation still follows v1.
    assert.deepEqual(deriveStoreKey(name, row), expected, name);
    // A current key-path change for a v1 destination store needs an explicit compatibility decision.
    assert.deepEqual(
      normalizeKeyPath(CURRENT_STORES[name].keyPath),
      v1KeyPath,
      `${name}: current destination key path diverged from migration v1; decide compatibility explicitly`
    );
  }
});

test("renamed legacy keys land on current durable keys", () => {
  const destinations = Object.values(LEGACY_KEY_RENAMES);
  assert.ok(destinations.length > 0);
  for (const destination of destinations) {
    assert.ok(isCurrentDurableLocalStorageKey(destination), destination);
  }
});

test("unchanged legacy durable keys are still recognized as current durable keys", () => {
  for (const key of UNCHANGED_DURABLE_KEYS) {
    assert.ok(isCurrentDurableLocalStorageKey(key), key);
    assert.match(classifyCurrentLocalStorageKey(key), /^(DURABLE|DERIVED_DURABLE)$/, key);
  }
});

test("legacy source identity stays frozen and independent of the current contract", () => {
  assert.equal(LEGACY_PACKAGE_ID, "com.markrai.sisutrainer");
  assert.equal(LEGACY_DB_NAME, "vo2_workout_db");
  assert.notEqual(LEGACY_DB_NAME, CURRENT_DB_NAME);
  for (const legacyKey of Object.keys(LEGACY_KEY_RENAMES)) {
    assert.ok(legacyKey.startsWith("sisu_trainer_"), legacyKey);
    assert.equal(classifyCurrentLocalStorageKey(legacyKey), null, legacyKey);
  }
});

test("registry categories are disjoint and durable keys never match transient patterns", () => {
  const durable = Object.values(DURABLE_LOCAL_STORAGE_KEYS);
  const all = [...durable, ...Object.values(MIGRATION_LOCAL_STORAGE_KEYS), ...Object.values(EPHEMERAL_LOCAL_STORAGE_KEYS)];
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(Object.keys(DURABLE_LOCAL_KEY_CONTRACTS).sort(), Object.keys(DURABLE_LOCAL_STORAGE_KEYS).sort());
  for (const key of all) {
    assert.ok(!TRANSIENT_LOCAL_KEY_PATTERNS.some((p) => key.startsWith(p.prefix)), key);
  }
  // Legacy policy may skip ephemeral keys, but must never treat a current durable key as transient.
  for (const key of durable) {
    assert.notEqual(classifyLegacyLocalStorageKey(key), "TRANSIENT_DO_NOT_MIGRATE", key);
  }
});

test("migration receipt is migration-only state, never durable user state", () => {
  assert.equal(MIGRATION_RECEIPT_KEY, "fitbaus_trainer_migration_receipt_v1");
  assert.equal(classifyCurrentLocalStorageKey(MIGRATION_RECEIPT_KEY), "MIGRATION_ONLY");
  assert.ok(!isCurrentDurableLocalStorageKey(MIGRATION_RECEIPT_KEY));
});

test("exported per-day key builders produce registered transient keys", () => {
  for (const key of [sessionControlModeKey("2026-01-01"), executionProvenanceKey("2026-01-01")]) {
    assert.equal(classifyCurrentLocalStorageKey(key), "TRANSIENT_SESSION", key);
    assert.ok(!isCurrentDurableLocalStorageKey(key), key);
  }
});

test("exported owner storage-key constants resolve to the canonical registry", () => {
  assert.deepEqual(
    {
      athleteIdentity: ATHLETE_IDENTITY_STORAGE_KEY,
      athleteProfile: ATHLETE_PROFILE_STORAGE_KEY,
      legacyProfileMirror: LEGACY_PROFILE_STORAGE_KEY,
      fitnessState: FITNESS_STATE_STORAGE_KEY,
      formalCalibrationMachineProvenance: FORMAL_CALIBRATION_MACHINE_PROVENANCE_STORAGE_KEY,
      equipmentSelection: EQUIPMENT_STORAGE_KEY,
      bikeBridge: BIKE_BRIDGE_STORAGE_KEY,
      machineLearning: LEARNING_STORAGE_KEY,
      hrDynamics: DYNAMICS_STORAGE_KEY,
      shadowResistancePredictions: SHADOW_PREDICTION_STORAGE_KEY,
    },
    {
      athleteIdentity: DURABLE_LOCAL_STORAGE_KEYS.athleteIdentity,
      athleteProfile: DURABLE_LOCAL_STORAGE_KEYS.athleteProfile,
      legacyProfileMirror: DURABLE_LOCAL_STORAGE_KEYS.legacyProfileMirror,
      fitnessState: DURABLE_LOCAL_STORAGE_KEYS.fitnessState,
      formalCalibrationMachineProvenance: DURABLE_LOCAL_STORAGE_KEYS.formalCalibrationMachineProvenance,
      equipmentSelection: DURABLE_LOCAL_STORAGE_KEYS.equipmentSelection,
      bikeBridge: DURABLE_LOCAL_STORAGE_KEYS.bikeBridge,
      machineLearning: DURABLE_LOCAL_STORAGE_KEYS.machineLearning,
      hrDynamics: DURABLE_LOCAL_STORAGE_KEYS.hrDynamics,
      shadowResistancePredictions: DURABLE_LOCAL_STORAGE_KEYS.shadowResistancePredictions,
    }
  );
});

test("every registered key classifies into exactly its own category", () => {
  for (const [name, key] of Object.entries(DURABLE_LOCAL_STORAGE_KEYS)) {
    assert.equal(classifyCurrentLocalStorageKey(key), DURABLE_LOCAL_KEY_CONTRACTS[name].persistence, key);
  }
  for (const key of Object.values(MIGRATION_LOCAL_STORAGE_KEYS)) {
    assert.equal(classifyCurrentLocalStorageKey(key), "MIGRATION_ONLY", key);
  }
  for (const key of Object.values(EPHEMERAL_LOCAL_STORAGE_KEYS)) {
    assert.equal(classifyCurrentLocalStorageKey(key), "CACHE_OR_EPHEMERAL", key);
  }
  for (const pattern of TRANSIENT_LOCAL_KEY_PATTERNS) {
    assert.equal(classifyCurrentLocalStorageKey(pattern.prefix + "2026-01-01"), "TRANSIENT_SESSION", pattern.prefix);
  }
});
