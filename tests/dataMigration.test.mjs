import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  MIGRATION_RECEIPT_KEY,
  assertMigrationJsonLossless,
  buildMigrationBundle,
  classifyLegacyLocalStorageKey,
  importMigrationBundle,
  isMigrationBundleImportable,
  parseMigrationBundleJson,
  summarizeMigrationBundle,
  verifyMigrationBundleIntegrity,
} from "../dist/dataMigration.js";
import { loadAthleteProfile } from "../dist/profile.js";

class MemoryStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
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

const ATHLETE_ID = "athlete-legacy-1";

function legacyWorkout(sessionId, overrides = {}) {
  return {
    session_id: sessionId,
    external_session_id: `ext-${sessionId}`,
    athlete_id: ATHLETE_ID,
    startedAt: "2026-08-01T10:00:00.000Z",
    endedAt: "2026-08-01T10:40:00.000Z",
    day: "Saturday",
    duration_minutes: 40,
    legacy_unknown_field: { preserved: [1, 2, 3] },
    vo2_evidence: {
      schema_version: 1,
      protocol: { id: "vo2-test-protocol", version: 1 },
      estimator: { id: "vo2-estimator", version: 2 },
      points: [{ watts: 120, heart_rate_bpm: 130 }],
    },
    vo2_assessment: {
      schema_version: 1,
      status: "estimated",
      estimate_ml_kg_min: 41.2,
      evidence_session_id: `ext-${sessionId}`,
    },
    workout_response: {
      schema_version: 1,
      kind: "ordinary_summary_response",
      zones: [1, 2, 3],
    },
    execution_provenance: {
      schema_version: 1,
      machine: { machine_id: "proform-smart-power-10", machine_profile_version: 3 },
      calibration_machine: { machine_id: "proform-smart-power-10", machine_profile_version: 3 },
      actuation_events: [],
    },
    personalized_prescription_evaluation: {
      schema_version: 1,
      shadow: { schema_version: 1, candidate_watts: 150, evidence_session_ids: [`ext-${sessionId}`] },
      workload_provenance: { source: "formal_calibration", calibration_session_id: `ext-${sessionId}` },
    },
    ...overrides,
  };
}

async function legacyFixtureBundle() {
  const fitnessState = {
    schemaVersion: 1,
    athleteId: ATHLETE_ID,
    vo2Max: {
      value: 41.2,
      algorithm: { id: "vo2-estimator", version: 2 },
      protocol: { id: "vo2-test-protocol", version: 1 },
      evidenceSessionIds: ["ext-workout-formal"],
    },
    hrWorkloadCalibration: {
      evidenceSessionIds: ["ext-workout-formal"],
      profileVersion: 7,
    },
  };
  const localEntries = [
    { key: "athlete_identity_v1", value: JSON.stringify({ schemaVersion: 1, athleteId: ATHLETE_ID, createdAt: "2026-01-01T00:00:00.000Z" }) },
    { key: "athlete_profile_v1", value: '{ "schemaVersion": 2,  "athleteId": "' + ATHLETE_ID + '", "demographics": {"ageYears": 44, "bodyMassLbs": 180}, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-02T00:00:00.000Z" }' },
    { key: "profile", value: JSON.stringify({ weight: "180", height: "70", age: "44", sex: "male", vo2: "" }) },
    { key: "fitness_state_v1", value: JSON.stringify(fitnessState) },
    { key: "formal_calibration_machine_provenance_v1", value: JSON.stringify([{ sessionId: "ext-workout-formal", machineId: "proform-smart-power-10", machineProfileVersion: 3, profileVersion: 7 }]) },
    { key: "sisu_trainer_equipment_selection", value: JSON.stringify({ bike: "proform-smart-power-10" }) },
    { key: "sisu_trainer_bike_bridge", value: JSON.stringify({ baseUrl: "http://192.168.1.10:8765", automaticControlEnabled: false }) },
    { key: "sisu_trainer_machine_learning", value: JSON.stringify({ schemaVersion: 1, starts: [{ resistance: 5, rpm: 80 }] }) },
    { key: "sisu_trainer_hr_dynamics", value: JSON.stringify({ schemaVersion: 1, tauOnSec: 42 }) },
    { key: "sisu_trainer_shadow_resistance_predictions", value: JSON.stringify({ schemaVersion: 1, predictions: [{ resistance: 6, watts: 140 }] }) },
    { key: "showSecondsCountdown", value: "true" },
    { key: "voicePromptsEnabled", value: "false" },
    { key: "downregulationSoundStyle", value: "rain" },
    // transient + unknown: must be excluded / reported, never migrated
    { key: "session_id_2026-08-01", value: "workout-active" },
    { key: "bike_telemetry_workout-active", value: "[]" },
    { key: "summary_emitted_2026-08-01", value: "false" },
  ];
  // Realistic unowned legacy row: athlete_id is ABSENT, not undefined (§5).
  const unowned = legacyWorkout("workout-legacy-unowned", { unowned: true });
  delete unowned.athlete_id;
  return buildMigrationBundle({
    exportedAt: "2026-10-20T12:00:00.000Z",
    appVersion: "0.10.13",
    sourceDbVersion: 3,
    localEntries,
    storeRows: {
      workouts: [
        unowned,
        legacyWorkout("workout-formal"),
        legacyWorkout("workout-owned"),
      ],
      hr_samples: [
        { session_id: "workout-formal", timestamp_sec: 0, bpm: 90 },
        { session_id: "workout-formal", timestamp_sec: 1, bpm: 92 },
        { session_id: "workout-owned", timestamp_sec: 0, bpm: 88 },
      ],
      ordinary_bike_telemetry: [
        { session_id: "workout-owned", active_sec: 0, athlete_id: ATHLETE_ID, sample: { watts: 100, rpm: 70 } },
        { session_id: "workout-owned", active_sec: 1, athlete_id: ATHLETE_ID, sample: { watts: 105, rpm: 72 } },
      ],
      sisu_settings: [
        { key: "sisu_host", value: "example.invalid" },
        { key: "sisu_protocol", value: "https" },
      ],
    },
  });
}

async function readDestStore(factory, store) {
  const db = await new Promise((resolve, reject) => {
    const req = factory.open("fitbaus_trainer_db", 3);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    if (!db.objectStoreNames.contains(store)) return [];
    return await new Promise((resolve, reject) => {
      const req = db.transaction([store], "readonly").objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

test("classification: renames, exact, transient, unknown", () => {
  assert.equal(classifyLegacyLocalStorageKey("sisu_trainer_bike_bridge"), "MIGRATE_WITH_KEY_RENAME");
  assert.equal(classifyLegacyLocalStorageKey("fitness_state_v1"), "MIGRATE_EXACTLY");
  assert.equal(classifyLegacyLocalStorageKey("bike_telemetry_abc"), "TRANSIENT_DO_NOT_MIGRATE");
  assert.equal(classifyLegacyLocalStorageKey("session_id_Monday"), "TRANSIENT_DO_NOT_MIGRATE");
  assert.equal(classifyLegacyLocalStorageKey("totally_new_key"), "UNKNOWN_REQUIRES_REVIEW");
  assert.equal(classifyLegacyLocalStorageKey("sisu_trainer_future_key"), "UNKNOWN_REQUIRES_REVIEW");
});

test("round trip: legacy fixture -> bundle -> import -> verified exact match", async () => {
  const bundle = await legacyFixtureBundle();
  assert.deepEqual(bundle.unknown_local_keys, []);
  assert.ok(bundle.manifest.store_digests.workouts);
  assert.ok(bundle.manifest.store_digests.hr_samples);
  assert.ok(bundle.manifest.store_digests.ordinary_bike_telemetry);
  assert.ok(bundle.manifest.store_digests.sisu_settings);
  assert.ok(bundle.excluded_local_keys.some((k) => k.key === "bike_telemetry_workout-active"));
  assert.ok(bundle.excluded_local_keys.some((k) => k.key === "session_id_2026-08-01"));

  // JSON transport round-trip must not drift
  const transported = parseMigrationBundleJson(JSON.stringify(bundle));
  await verifyMigrationBundleIntegrity(transported);

  const factory = new IDBFactory();
  const storage = new MemoryStorage();
  const result = await importMigrationBundle(transported, { storage, indexedDBFactory: factory });
  assert.equal(result.status, "IMPORTED_VERIFIED");
  assert.equal(result.verification.status, "VERIFIED_MATCH");
  assert.equal(result.verification.workouts.actual, 3);
  assert.equal(result.verification.hrSamples.actual, 3);
  assert.equal(result.verification.ordinaryBikeTelemetry.actual, 2);
  assert.equal(result.verification.sisuSettings.actual, 2);
  assert.ok(result.verification.fitnessStatePresent);
  assert.ok(result.verification.formalCalibrationProvenancePresent);
  assert.ok(result.verification.machineLearningPresent);
  assert.ok(result.verification.hrDynamicsPresent);
  assert.ok(result.verification.shadowPredictionsPresent);
  assert.ok(result.verification.equipmentPresent);
  assert.ok(result.verification.bikeBridgePresent);

  // Raw rows preserved exactly, including unknown historical fields
  const workouts = await readDestStore(factory, "workouts");
  const formal = workouts.find((w) => w.session_id === "workout-formal");
  assert.deepEqual(formal.legacy_unknown_field, { preserved: [1, 2, 3] });
  assert.equal(formal.external_session_id, "ext-workout-formal");

  // localStorage exact strings, renamed keys only at destination names
  const expectedProfileEntry = bundle.local_storage.find((e) => e.destination_key === "athlete_profile_v1");
  assert.equal(storage.getItem("athlete_profile_v1"), expectedProfileEntry.value);
  assert.ok(storage.getItem("fitbaus_trainer_bike_bridge"));
  assert.equal(storage.getItem("sisu_trainer_bike_bridge"), null);
  assert.equal(storage.getItem("mystery_unreviewed_key"), null);
  assert.equal(storage.getItem("bike_telemetry_workout-active"), null);
  assert.ok(storage.getItem(MIGRATION_RECEIPT_KEY));
});

test("provenance invariants survive import and a normal profile read", async () => {
  const bundle = await legacyFixtureBundle();
  const factory = new IDBFactory();
  const storage = new MemoryStorage();
  const fitnessBefore = bundle.local_storage.find((e) => e.destination_key === "fitness_state_v1").value;
  const result = await importMigrationBundle(bundle, { storage, indexedDBFactory: factory });
  assert.equal(result.status, "IMPORTED_VERIFIED");

  const workouts = await readDestStore(factory, "workouts");
  const formal = workouts.find((w) => w.session_id === "workout-formal");
  assert.equal(formal.athlete_id, ATHLETE_ID);
  assert.equal(formal.startedAt, "2026-08-01T10:00:00.000Z");
  assert.equal(formal.endedAt, "2026-08-01T10:40:00.000Z");
  assert.deepEqual(formal.vo2_evidence.protocol, { id: "vo2-test-protocol", version: 1 });
  assert.deepEqual(formal.vo2_evidence.estimator, { id: "vo2-estimator", version: 2 });
  assert.equal(formal.vo2_evidence.schema_version, 1);
  assert.equal(formal.vo2_assessment.schema_version, 1);
  assert.equal(formal.workout_response.schema_version, 1);
  assert.deepEqual(formal.execution_provenance.machine, { machine_id: "proform-smart-power-10", machine_profile_version: 3 });
  assert.equal(formal.personalized_prescription_evaluation.schema_version, 1);
  assert.equal(formal.personalized_prescription_evaluation.shadow.schema_version, 1);

  // Derived-state guard: a normal profile load must not substitute a new athlete
  // or rewrite imported FitnessState.
  const profile = loadAthleteProfile(storage);
  assert.equal(profile.athleteId, ATHLETE_ID);
  assert.equal(storage.getItem("fitness_state_v1"), fitnessBefore);
  const workoutsAfter = await readDestStore(factory, "workouts");
  assert.deepEqual(workoutsAfter.find((w) => w.session_id === "workout-formal"), formal);
});

test("empty bootstrap destination may be replaced; meaningful profile may not", async () => {
  const bundle = await legacyFixtureBundle();
  const bootstrap = new MemoryStorage({
    athlete_identity_v1: JSON.stringify({ schemaVersion: 1, athleteId: "bootstrap-generated", createdAt: "2026-10-20T00:00:00.000Z" }),
    athlete_profile_v1: JSON.stringify({ schemaVersion: 2, athleteId: "bootstrap-generated", demographics: {}, createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z" }),
  });
  const ok = await importMigrationBundle(bundle, { storage: bootstrap, indexedDBFactory: new IDBFactory() });
  assert.equal(ok.status, "IMPORTED_VERIFIED");
  assert.equal(JSON.parse(bootstrap.getItem("athlete_identity_v1")).athleteId, ATHLETE_ID);

  const meaningful = new MemoryStorage({
    athlete_profile_v1: JSON.stringify({ schemaVersion: 2, athleteId: "someone", demographics: { ageYears: 30 }, createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z" }),
  });
  const blocked = await importMigrationBundle(bundle, { storage: meaningful, indexedDBFactory: new IDBFactory() });
  assert.equal(blocked.status, "DESTINATION_NOT_EMPTY");
});

test("idempotence: same bundle twice, different bundle after import", async () => {
  const bundle = await legacyFixtureBundle();
  const factory = new IDBFactory();
  const storage = new MemoryStorage();
  const first = await importMigrationBundle(bundle, { storage, indexedDBFactory: factory });
  assert.equal(first.status, "IMPORTED_VERIFIED");
  const second = await importMigrationBundle(bundle, { storage, indexedDBFactory: factory });
  assert.equal(second.status, "ALREADY_IMPORTED");
  assert.equal((await readDestStore(factory, "workouts")).length, 3);

  const other = await buildMigrationBundle({
    exportedAt: "2026-10-21T12:00:00.000Z",
    localEntries: [{ key: "athlete_identity_v1", value: "{}" }],
    storeRows: { workouts: [legacyWorkout("other-workout")] },
  });
  const third = await importMigrationBundle(other, { storage, indexedDBFactory: factory });
  assert.equal(third.status, "PRIOR_MIGRATION_DIFFERENT_BUNDLE");
  assert.equal((await readDestStore(factory, "workouts")).length, 3);
});

test("negative bundles fail closed with zero destination writes", async () => {
  const bundle = await legacyFixtureBundle();
  const cases = [
    ["corrupted JSON", "{not json", "INVALID_JSON"],
    ["truncated", JSON.stringify(bundle).slice(0, 40), "INVALID_JSON"],
    ["wrong format", JSON.stringify({ ...bundle, format: "other" }), "WRONG_FORMAT"],
    ["future schema", JSON.stringify({ ...bundle, schema_version: 99 }), "UNSUPPORTED_SCHEMA_VERSION"],
    ["wrong package", JSON.stringify({ ...bundle, source: { ...bundle.source, package_id: "com.example.other" } }), "WRONG_SOURCE_PACKAGE"],
  ];
  for (const [name, text, code] of cases) {
    const storage = new MemoryStorage();
    const factory = new IDBFactory();
    await assert.rejects(
      async () => importMigrationBundle(parseMigrationBundleJson(text), { storage, indexedDBFactory: factory }),
      (err) => err.code === code,
      name
    );
    assert.equal(storage.keys().length, 0, name);
    assert.equal((await readDestStore(factory, "workouts")).length, 0, name);
  }

  // digest mismatch (tampered row, structure still valid)
  const tampered = parseMigrationBundleJson(JSON.stringify(bundle));
  tampered.indexeddb.stores.workouts[0].value.duration_minutes = 999;
  const storage = new MemoryStorage();
  const factory = new IDBFactory();
  await assert.rejects(
    () => importMigrationBundle(tampered, { storage, indexedDBFactory: factory }),
    (err) => err.code === "DIGEST_MISMATCH"
  );
  assert.equal(storage.keys().length, 0);
  assert.equal((await readDestStore(factory, "workouts")).length, 0);

  // malformed IndexedDB entry (key does not match row)
  const malformed = parseMigrationBundleJson(JSON.stringify(bundle));
  malformed.indexeddb.stores.workouts[0].key = "wrong-key";
  await assert.rejects(
    () => importMigrationBundle(malformed, { storage: new MemoryStorage(), indexedDBFactory: new IDBFactory() }),
    (err) => err.code === "MALFORMED_INDEXEDDB"
  );

  // malformed localStorage mapping
  const badLocal = parseMigrationBundleJson(JSON.stringify(bundle));
  badLocal.local_storage[0].destination_key = "wrong_destination";
  await assert.rejects(
    () => importMigrationBundle(badLocal, { storage: new MemoryStorage(), indexedDBFactory: new IDBFactory() }),
    (err) => err.code === "MALFORMED_LOCAL_STORAGE"
  );

  // duplicate primary keys inside bundle payload
  const dup = parseMigrationBundleJson(JSON.stringify(bundle));
  dup.indexeddb.stores.workouts.push(dup.indexeddb.stores.workouts[0]);
  dup.manifest.store_counts.workouts += 1;
  await assert.rejects(
    () => importMigrationBundle(dup, { storage: new MemoryStorage(), indexedDBFactory: new IDBFactory() }),
    (err) => err.code === "DUPLICATE_PRIMARY_KEY"
  );
});

test("fault injection: IndexedDB failure rolls back to bootstrap snapshot", async () => {
  const bundle = await legacyFixtureBundle();
  const factory = new IDBFactory();
  const bootstrapIdentity = JSON.stringify({ schemaVersion: 1, athleteId: "bootstrap-generated", createdAt: "2026-10-20T00:00:00.000Z" });
  const storage = new MemoryStorage({ athlete_identity_v1: bootstrapIdentity });
  const result = await importMigrationBundle(bundle, {
    storage,
    indexedDBFactory: factory,
    faultInjection: { failBeforeStoreWrite: "hr_samples" },
  });
  assert.equal(result.status, "FAILED_ROLLED_BACK");
  assert.equal(storage.getItem("athlete_identity_v1"), bootstrapIdentity);
  assert.equal(storage.getItem(MIGRATION_RECEIPT_KEY), null);
  assert.equal(storage.getItem("fitness_state_v1"), null);
  assert.equal((await readDestStore(factory, "workouts")).length, 0);
  assert.equal((await readDestStore(factory, "hr_samples")).length, 0);
});

test("fault injection: localStorage failure rolls back IndexedDB and keys", async () => {
  const bundle = await legacyFixtureBundle();
  const factory = new IDBFactory();
  const storage = new MemoryStorage();
  const result = await importMigrationBundle(bundle, {
    storage,
    indexedDBFactory: factory,
    faultInjection: { failOnLocalStorageKey: "fitness_state_v1" },
  });
  assert.equal(result.status, "FAILED_ROLLED_BACK");
  assert.equal(storage.keys().length, 0);
  assert.equal((await readDestStore(factory, "workouts")).length, 0);
  assert.equal((await readDestStore(factory, "ordinary_bike_telemetry")).length, 0);
});

// --- Slice 1.1 §1 receipt policy ---
test("receipt: same bundle + VERIFIED_MATCH -> ALREADY_IMPORTED", async () => {
  const bundle = await legacyFixtureBundle();
  const factory = new IDBFactory();
  const storage = new MemoryStorage();
  assert.equal((await importMigrationBundle(bundle, { storage, indexedDBFactory: factory })).status, "IMPORTED_VERIFIED");
  const again = await importMigrationBundle(bundle, { storage, indexedDBFactory: factory });
  assert.equal(again.status, "ALREADY_IMPORTED");
  assert.equal(again.verification.status, "VERIFIED_MATCH");
  assert.equal(again.verification.hrSamples.digestMatch, true);
  assert.equal(again.verification.storeDigests.hr_samples.digestMatch, true);
});

test("receipt: same bundle + MISMATCH -> EXISTING_IMPORT_MISMATCH, no writes", async () => {
  const bundle = await legacyFixtureBundle();
  const factory = new IDBFactory();
  const storage = new MemoryStorage();
  assert.equal((await importMigrationBundle(bundle, { storage, indexedDBFactory: factory })).status, "IMPORTED_VERIFIED");
  storage.setItem("fitness_state_v1", '{"tampered":true}');
  const keysBefore = storage.keys().slice().sort();
  const result = await importMigrationBundle(bundle, { storage, indexedDBFactory: factory });
  assert.equal(result.status, "EXISTING_IMPORT_MISMATCH");
  assert.equal(result.verification.status, "MISMATCH");
  assert.deepEqual(storage.keys().slice().sort(), keysBefore);
  assert.equal(storage.getItem("fitness_state_v1"), '{"tampered":true}');
  assert.equal((await readDestStore(factory, "workouts")).length, 3);
});

test("receipt: different bundle -> PRIOR_MIGRATION_DIFFERENT_BUNDLE, no writes", async () => {
  const bundle = await legacyFixtureBundle();
  const factory = new IDBFactory();
  const storage = new MemoryStorage();
  await importMigrationBundle(bundle, { storage, indexedDBFactory: factory });
  const other = await buildMigrationBundle({
    exportedAt: "2026-10-21T12:00:00.000Z",
    localEntries: [{ key: "athlete_identity_v1", value: "{}" }],
    storeRows: { workouts: [legacyWorkout("other-1")] },
  });
  const result = await importMigrationBundle(other, { storage, indexedDBFactory: factory });
  assert.equal(result.status, "PRIOR_MIGRATION_DIFFERENT_BUNDLE");
  assert.equal((await readDestStore(factory, "workouts")).length, 3);
});

test("receipt: malformed receipt blocks with no writes", async () => {
  const bundle = await legacyFixtureBundle();
  for (const raw of ["{not json", JSON.stringify({ nope: 1 }), JSON.stringify("x")]) {
    const factory = new IDBFactory();
    const storage = new MemoryStorage({ [MIGRATION_RECEIPT_KEY]: raw });
    const result = await importMigrationBundle(bundle, { storage, indexedDBFactory: factory });
    assert.equal(result.status, "DESTINATION_NOT_EMPTY");
    assert.equal(result.error.code, "MALFORMED_MIGRATION_RECEIPT");
    assert.deepEqual(storage.keys(), [MIGRATION_RECEIPT_KEY]);
    assert.equal((await readDestStore(factory, "workouts")).length, 0);
  }
});

// --- Slice 1.1 §2 unknown source state hard gate ---
test("unknown local key blocks import with zero writes and no confirm availability", async () => {
  const bundle = await buildMigrationBundle({
    exportedAt: "2026-10-20T12:00:00.000Z",
    localEntries: [
      { key: "athlete_identity_v1", value: "{}" },
      { key: "mystery_unreviewed_key", value: "secret-value-must-not-leak" },
    ],
    storeRows: { workouts: [legacyWorkout("w-unknown")] },
  });
  assert.equal(isMigrationBundleImportable(bundle), false);
  assert.deepEqual(summarizeMigrationBundle(bundle).unknownLocalKeys, ["mystery_unreviewed_key"]);
  const storage = new MemoryStorage();
  const factory = new IDBFactory();
  await assert.rejects(
    () => importMigrationBundle(bundle, { storage, indexedDBFactory: factory }),
    (err) => err.code === "UNREVIEWED_SOURCE_STATE" && err.message.includes("mystery_unreviewed_key") && !err.message.includes("secret-value")
  );
  assert.equal(storage.keys().length, 0);
  assert.equal((await readDestStore(factory, "workouts")).length, 0);
});

test("unknown IndexedDB store blocks import with zero writes", async () => {
  const bundle = await buildMigrationBundle({
    exportedAt: "2026-10-20T12:00:00.000Z",
    localEntries: [{ key: "athlete_identity_v1", value: "{}" }],
    storeRows: { workouts: [legacyWorkout("w-unknown-store")] },
    unknownStores: [{ name: "mystery_store", record_count: 7 }],
  });
  assert.equal(isMigrationBundleImportable(bundle), false);
  assert.deepEqual(summarizeMigrationBundle(bundle).unknownStores, [{ name: "mystery_store", record_count: 7 }]);
  const storage = new MemoryStorage();
  const factory = new IDBFactory();
  await assert.rejects(
    () => importMigrationBundle(bundle, { storage, indexedDBFactory: factory }),
    (err) => err.code === "UNREVIEWED_SOURCE_STATE" && err.message.includes("mystery_store") && err.message.includes("7")
  );
  assert.equal(storage.keys().length, 0);
  assert.equal((await readDestStore(factory, "workouts")).length, 0);
});

// --- Slice 1.1 §3 rollback truthfulness ---
for (const [name, fi] of [
  ["IndexedDB rollback failure", { failBeforeStoreWrite: "hr_samples", failIdbRollback: true }],
  ["localStorage rollback failure", { failOnLocalStorageKey: "fitness_state_v1", failLocalStorageRollback: true }],
  ["rollback verification mismatch", { failOnLocalStorageKey: "fitness_state_v1", corruptAfterRollback: true }],
]) {
  test(`rollback fault: ${name} never yields FAILED_ROLLED_BACK`, async () => {
    const bundle = await legacyFixtureBundle();
    const storage = new MemoryStorage();
    const result = await importMigrationBundle(bundle, { storage, indexedDBFactory: new IDBFactory(), faultInjection: fi });
    assert.equal(result.status, "ROLLBACK_UNVERIFIED");
  });
}

// --- Slice 1.1 §4/§5 lossless domain ---
test("lossless: undefined-valued property is explicitly normalized to absent and reported", async () => {
  // Real-device amendment: legacy writes optional fields as undefined
  // (e.g. summary.cancelled). Reading them yields undefined either way.
  const row = legacyWorkout("w-undef");
  row.athlete_id = undefined;
  assert.doesNotThrow(() => assertMigrationJsonLossless(row, "workouts[w-undef]"));
  const bundle = await buildMigrationBundle({
    exportedAt: "2026-10-20T12:00:00.000Z",
    localEntries: [],
    storeRows: { workouts: [row] },
  });
  assert.equal(bundle.undefined_properties_dropped, 1);
  const transported = parseMigrationBundleJson(JSON.stringify(bundle));
  assert.equal("athlete_id" in transported.indexeddb.stores.workouts[0].value, false);
  await verifyMigrationBundleIntegrity(transported);
});

test("lossless: undefined array element is still rejected", () => {
  const row = legacyWorkout("w-undef-arr");
  row.tags = ["a", undefined, "b"];
  assert.throws(() => assertMigrationJsonLossless(row, "workouts[w-undef-arr]"), (e) => e.code === "UNSUPPORTED_STORED_VALUE");
});

test("lossless: absent athlete_id (genuinely unowned) exports fine", async () => {
  const bundle = await legacyFixtureBundle();
  const unowned = bundle.indexeddb.stores.workouts.find((w) => w.value.session_id === "workout-legacy-unowned");
  assert.ok(unowned);
  assert.equal("athlete_id" in unowned.value, false);
});

for (const [kind, make] of [
  ["NaN", () => Object.assign(legacyWorkout("w-nan"), { bpm: NaN })],
  ["Date", () => Object.assign(legacyWorkout("w-date"), { when: new Date(0) })],
  ["typed array", () => Object.assign(legacyWorkout("w-ta"), { bytes: new Uint8Array([1, 2]) })],
  ["Map", () => Object.assign(legacyWorkout("w-map"), { m: new Map() })],
  ["bigint", () => Object.assign(legacyWorkout("w-big"), { n: 10n })],
]) {
  test(`lossless: ${kind} in a stored row blocks bundle creation`, async () => {
    await assert.rejects(
      () => buildMigrationBundle({ exportedAt: "2026-10-20T12:00:00.000Z", localEntries: [], storeRows: { workouts: [make()] } }),
      (e) => e.code === "UNSUPPORTED_STORED_VALUE"
    );
  });
}

test("lossless: handcrafted bundle with unsupported value cannot bypass importer validation", async () => {
  const bundle = await legacyFixtureBundle();
  const evil = structuredClone(bundle);
  // Simulate a direct-object (non-JSON) handcrafted bundle carrying a Date.
  evil.indexeddb.stores.workouts[0].value.injected_date = new Date(0);
  await assert.rejects(
    () => importMigrationBundle(evil, { storage: new MemoryStorage(), indexedDBFactory: new IDBFactory() }),
    (e) => e.code === "UNSUPPORTED_STORED_VALUE"
  );
});

test("lossless: cyclic reference is rejected", () => {
  const row = legacyWorkout("w-cyc");
  row.self = row;
  assert.throws(() => assertMigrationJsonLossless(row, "workouts[w-cyc]"), (e) => e.code === "UNSUPPORTED_STORED_VALUE");
});

test("nonempty IndexedDB destination fails closed without merging", async () => {
  const bundle = await legacyFixtureBundle();
  const factory = new IDBFactory();
  const storage = new MemoryStorage();
  const first = await importMigrationBundle(bundle, { storage, indexedDBFactory: factory });
  assert.equal(first.status, "IMPORTED_VERIFIED");
  // Simulate meaningful destination for a fresh import attempt with a clean profile:
  const storage2 = new MemoryStorage();
  const blocked = await importMigrationBundle(bundle, { storage: storage2, indexedDBFactory: factory });
  // Same bundle digest has no receipt in storage2, but IDB is populated -> not empty.
  assert.equal(blocked.status, "DESTINATION_NOT_EMPTY");
  assert.equal((await readDestStore(factory, "workouts")).length, 3);
});
