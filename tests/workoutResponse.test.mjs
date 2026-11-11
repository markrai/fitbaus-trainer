import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

import {
  buildOrdinaryBikeTelemetrySample,
  parseOrdinaryBikeTelemetrySample,
} from "../dist/ordinaryWorkoutTelemetry.js";
import {
  deriveWorkoutResponse,
  parseWorkoutResponse,
} from "../dist/workoutResponse.js";
import {
  ordinaryActiveBikeTelemetrySample,
  releaseReplacedSessionTelemetry,
  restartWorkout,
} from "../dist/workoutLogic.js";
import { resolveWorkoutPrescription } from "../dist/workoutPrescription.js";
import {
  cleanupAbandonedOrdinaryBikeTelemetry,
  deleteWorkoutSummary,
  getAllWorkoutSummaries,
  getHrSamples,
  getOrdinaryBikeTelemetrySamples,
  initDB,
  queueOrdinaryBikeTelemetrySample,
  resetWorkoutStorageForTests,
  storeHrSample,
  storeOrdinaryBikeTelemetrySample,
  storeWorkoutSummary,
} from "../dist/workoutStorage.js";
import { emitWorkoutSummary, generateWorkoutSummary } from "../dist/workoutSummary.js";
import { buildSisuWorkoutPayload } from "../dist/sisuSync.js";
import { FITNESS_STATE_STORAGE_KEY } from "../dist/fitnessState.js";
import { ATHLETE_PROFILE_STORAGE_KEY, migrateLegacyProfile } from "../dist/profile.js";
import { startSession } from "../dist/sessionStore.js";
import { transformWorkoutData } from "../dist/workoutData.js";
import {
  ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
  WORKOUT_RESPONSE_SCHEMA_VERSION_V1,
} from "../dist/types.js";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function rawSample(overrides = {}) {
  return {
    schemaVersion: ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
    athleteId: "athlete-a",
    sessionId: "session-a",
    activeSec: 1,
    observedAt: "2026-09-21T12:00:01.000Z",
    availability: "fresh",
    sourceSampleId: "snapshot-1",
    freshnessMs: 10,
    watts: { value: 120, source: "measured_watts", freshnessMs: 10 },
    cadenceRpm: { value: 70, source: "measured", freshnessMs: 10 },
    observedResistance: { value: 5, source: "observed", freshnessMs: 10 },
    desiredResistance: 6,
    commandedResistance: 6,
    ...overrides,
  };
}

function bridgeInput(overrides = {}) {
  return {
    athleteId: "athlete-a",
    sessionId: "session-a",
    activeSec: 10,
    observedAtMs: Date.parse("2026-09-21T12:00:10.000Z"),
    telemetryStale: false,
    telemetryReceivedAtMs: Date.parse("2026-09-21T12:00:09.900Z"),
    telemetrySnapshotAt: "snapshot-10",
    watts: { value: 150, current: true },
    cadenceRpm: { value: 72, current: true },
    observedResistance: { value: 7, current: true },
    desiredResistance: 8,
    commandedResistance: 8,
    ...overrides,
  };
}

function intervalFixture() {
  const blocks = { warm: 0.1, sustain: 0.2, cool: 0.1 };
  const hrTargets = {
    warmup: "100-110",
    warmup_intensity_id: "warmup_easy",
    cooldown: "95-105",
    cooldown_intensity_id: "cooldown",
    intervals: {
      phases: [
        { phase: "Work", kind: "work", duration: 0.05, target_hr_bpm: "150-160", intensity_id: "vo2_short" },
        { phase: "Recovery", kind: "recovery", duration: 0.05, target_hr_bpm: "110-120", intensity_id: "recovery" },
      ],
      repetitions: 2,
      isSequence: false,
    },
  };
  return {
    blocks,
    prescription: resolveWorkoutPrescription({
      workoutSelector: "Tuesday",
      blocks,
      hrTargets,
      resolvedAt: "2026-09-21T12:00:00.000Z",
    }),
  };
}

function responseFixture({ bikeSamples = [], completedActiveSec = 24 } = {}) {
  const { blocks, prescription } = intervalFixture();
  const hrSamples = Array.from({ length: completedActiveSec }, (_, second) => ({
    session_id: "session-a",
    timestamp_sec: second,
    hr: 100 + second,
  }));
  return deriveWorkoutResponse({
    athleteId: "athlete-a",
    sessionId: "session-a",
    blocks,
    resolvedPrescription: prescription,
    completedActiveSec,
    cancelled: false,
    hrSamples,
    bikeSamples,
  });
}

function summary(sessionId, extra = {}) {
  return {
    external_session_id: sessionId,
    startedAt: "2026-09-21T12:00:00.000Z",
    endedAt: "2026-09-21T12:10:00.000Z",
    category: "cardio",
    intent: "test",
    duration_minutes: 10,
    primary_zone: 2,
    stress_profile: "low",
    zone_minutes: { z1: 0, z2: 10, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Tuesday",
    ...extra,
  };
}

test("ordinary telemetry parser is versioned, strict, and keeps observed and controller fields separate", () => {
  const parsed = parseOrdinaryBikeTelemetrySample(rawSample());
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1);
  assert.equal(parsed.watts.source, "measured_watts");
  assert.equal(parsed.commandedResistance, 6);
  assert.equal(parseOrdinaryBikeTelemetrySample(rawSample({ schemaVersion: 2 })), null);
  assert.equal(parseOrdinaryBikeTelemetrySample(rawSample({ watts: { value: 120, source: "commanded", freshnessMs: 0 } })), null);
  assert.equal(parseOrdinaryBikeTelemetrySample(rawSample({ freshnessMs: 2501 })), null);
  assert.equal(parseOrdinaryBikeTelemetrySample(rawSample({ watts: { value: 120, source: "measured_watts", freshnessMs: 11 } })), null);
  assert.equal(parseOrdinaryBikeTelemetrySample(rawSample({ athleteId: "" })), null);

  const calibrated = parseOrdinaryBikeTelemetrySample(rawSample({
    watts: { value: 118, source: "calibrated_watts", freshnessMs: 10 },
  }));
  assert.equal(calibrated.watts.source, "calibrated_watts");
});

test("fresh bridge telemetry becomes measured evidence while unavailable watts remain absent", () => {
  const fresh = buildOrdinaryBikeTelemetrySample(bridgeInput());
  assert.ok(fresh);
  assert.equal(fresh.availability, "fresh");
  assert.equal(fresh.watts.source, "measured_watts");
  assert.equal(fresh.cadenceRpm.source, "measured");
  assert.equal(fresh.observedResistance.source, "observed");
  assert.equal(fresh.desiredResistance, 8);

  const noWatts = buildOrdinaryBikeTelemetrySample(bridgeInput({ watts: { value: null, current: false } }));
  assert.ok(noWatts);
  assert.equal(Object.prototype.hasOwnProperty.call(noWatts, "watts"), false);
  assert.equal(noWatts.desiredResistance, 8);
});

test("stale bridge values are retained only as missingness and never as observed workload", () => {
  const stale = buildOrdinaryBikeTelemetrySample(bridgeInput({ telemetryStale: true }));
  assert.ok(stale);
  assert.equal(stale.availability, "stale");
  assert.equal(stale.watts, undefined);
  assert.equal(stale.cadenceRpm, undefined);
  assert.equal(stale.observedResistance, undefined);
  assert.equal(stale.commandedResistance, 8);

  const aged = buildOrdinaryBikeTelemetrySample(bridgeInput({
    telemetryReceivedAtMs: Date.parse("2026-09-21T12:00:00.000Z"),
  }));
  assert.equal(aged.availability, "stale");
  assert.equal(aged.watts, undefined);
});

test("session-frozen ownership and pause-safe active time govern ordinary samples", () => {
  const wallStart = Date.parse("2026-09-21T12:00:00.000Z");
  const telemetry = {
    telemetryStale: false,
    telemetryReceivedAtMs: wallStart + 10_000,
    telemetrySnapshotAt: "snapshot-owner",
    watts: { value: 100, current: true },
    cadenceRpm: { value: 70, current: true },
    observedResistance: { value: 4, current: true },
  };
  const frozen = {
    startTime: String(wallStart),
    sessionId: "session-frozen",
    athleteId: "athlete-frozen-a",
    paused: false,
    pausedElapsed: 0,
  };
  const sample = ordinaryActiveBikeTelemetrySample(frozen, telemetry, wallStart + 10_000);
  assert.equal(sample.athleteId, "athlete-frozen-a");
  assert.equal(sample.activeSec, 10);

  const paused = { ...frozen, paused: true, pausedElapsed: 10 };
  assert.equal(ordinaryActiveBikeTelemetrySample(paused, telemetry, wallStart + 70_000), null);
  const resumed = { ...frozen, startTime: String(wallStart + 60_000) };
  const resumedSample = ordinaryActiveBikeTelemetrySample(
    resumed,
    { ...telemetry, telemetryReceivedAtMs: wallStart + 71_000, telemetrySnapshotAt: "snapshot-resume" },
    wallStart + 71_000
  );
  assert.equal(resumedSample.activeSec, 11);
  assert.equal(resumedSample.athleteId, "athlete-frozen-a");

  assert.equal(ordinaryActiveBikeTelemetrySample({ ...frozen, athleteId: undefined }, telemetry, wallStart + 10_000), null);
});

test("IndexedDB retains ordinary telemetry across reads and rejects duplicate active/source observations", async () => {
  await resetWorkoutStorageForTests();
  assert.equal(await storeOrdinaryBikeTelemetrySample(rawSample()), "stored");
  assert.equal(await storeOrdinaryBikeTelemetrySample(rawSample()), "duplicate");
  assert.equal(await storeOrdinaryBikeTelemetrySample(rawSample({ activeSec: 2 })), "duplicate");
  assert.equal(await storeOrdinaryBikeTelemetrySample(rawSample({
    activeSec: 2,
    sourceSampleId: "snapshot-2",
    observedAt: "2026-09-21T12:00:02.000Z",
  })), "stored");
  const reloaded = await getOrdinaryBikeTelemetrySamples("session-a");
  assert.deepEqual(reloaded.map((sample) => sample.activeSec), [1, 2]);
  assert.ok(reloaded.every((sample) => sample.athleteId === "athlete-a"));
  await resetWorkoutStorageForTests();
});

test("IndexedDB v3 migration preserves existing workouts and HR samples", async () => {
  await resetWorkoutStorageForTests();
  const legacyDb = await new Promise((resolve, reject) => {
    const request = indexedDB.open("fitbaus_trainer_db", 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      const workouts = database.createObjectStore("workouts", { keyPath: "session_id" });
      workouts.createIndex("startedAt", "startedAt", { unique: false });
      workouts.createIndex("day", "day", { unique: false });
      const hr = database.createObjectStore("hr_samples", { keyPath: ["session_id", "timestamp_sec"] });
      hr.createIndex("session_id", "session_id", { unique: false });
      database.createObjectStore("sisu_settings", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const tx = legacyDb.transaction(["workouts", "hr_samples"], "readwrite");
  tx.objectStore("workouts").put({
    session_id: "legacy-session",
    startedAt: "2026-09-01T12:00:00.000Z",
    endedAt: "2026-09-01T12:10:00.000Z",
    day: "Tuesday",
    summary: summary("legacy-session"),
  });
  tx.objectStore("hr_samples").put({ session_id: "legacy-session", timestamp_sec: 1, hr: 120 });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  legacyDb.close();

  const upgraded = await initDB();
  assert.equal(upgraded.version, 3);
  assert.equal(upgraded.objectStoreNames.contains("ordinary_bike_telemetry"), true);
  assert.equal((await getAllWorkoutSummaries()).some((row) => row.summary.external_session_id === "legacy-session"), true);
  assert.equal((await getHrSamples("legacy-session")).length, 1);
  await resetWorkoutStorageForTests();
});

test("a fresh observation upgrades same-second missingness without overwriting a fresh sample", async () => {
  await resetWorkoutStorageForTests();
  const unavailable = rawSample({
    availability: "unavailable",
    sourceSampleId: undefined,
    freshnessMs: undefined,
    watts: undefined,
    cadenceRpm: undefined,
    observedResistance: undefined,
  });
  assert.equal(await storeOrdinaryBikeTelemetrySample(unavailable), "stored");
  assert.equal(await storeOrdinaryBikeTelemetrySample(rawSample()), "stored");
  assert.equal(await storeOrdinaryBikeTelemetrySample(rawSample({ watts: { value: 999, source: "measured_watts", freshnessMs: 10 } })), "duplicate");
  assert.equal(await storeOrdinaryBikeTelemetrySample({
    ...unavailable,
    activeSec: 2,
    observedAt: "2026-09-21T12:00:02.000Z",
  }), "stored");
  assert.equal(await storeOrdinaryBikeTelemetrySample(rawSample({
    activeSec: 2,
    observedAt: "2026-09-21T12:00:02.000Z",
    sourceSampleId: "snapshot-1",
  })), "duplicate");
  const [stored, duplicateUpgradeTarget] = await getOrdinaryBikeTelemetrySamples("session-a");
  assert.equal(stored.availability, "fresh");
  assert.equal(stored.watts.value, 120);
  assert.equal(duplicateUpgradeTarget.availability, "unavailable");
  await resetWorkoutStorageForTests();
});

test("WorkoutResponse segments repeated intervals from the frozen prescription", () => {
  const samples = Array.from({ length: 24 }, (_, second) => rawSample({
    activeSec: second,
    observedAt: new Date(Date.parse("2026-09-21T12:00:00.000Z") + second * 1000).toISOString(),
    sourceSampleId: `snapshot-${second}`,
    watts: { value: 100 + second, source: "measured_watts", freshnessMs: 10 },
  }));
  const response = responseFixture({ bikeSamples: samples });
  assert.ok(response);
  assert.equal(response.schemaVersion, WORKOUT_RESPONSE_SCHEMA_VERSION_V1);
  assert.deepEqual(response.phases.map((phase) => phase.phaseId), [
    "warmup",
    "cycle:0:0",
    "cycle:0:1",
    "cycle:1:0",
    "cycle:1:1",
    "cooldown",
  ]);
  assert.equal(new Set(response.phases.map((phase) => phase.phaseInstanceId)).size, 6);
  assert.equal(response.phases[1].intensityId, "vo2_short");
  assert.equal(response.phases[1].expectedHeartRate.min, 150);
  assert.equal(response.phases[1].watts.provenance, "measured_watts");
});

test("frozen warm-up subsections remain stable after mutable template input changes", () => {
  const blocks = { warm: 0.2, sustain: 0, cool: 0 };
  const targets = {
    warmup: "100-110",
    warmup_intensity_id: "warmup_easy",
    warmup_subsections: [
      { name: "Easy", start_min: 0, end_min: 0.1, target_hr_bpm: "100-105", intensity_id: "warmup_easy" },
      { name: "Build", start_min: 0.1, end_min: 0.2, target_hr_bpm: "110-120", intensity_id: "aerobic_base" },
    ],
    intervals: null,
  };
  const frozen = resolveWorkoutPrescription({
    workoutSelector: "Friday",
    blocks,
    hrTargets: targets,
    resolvedAt: "2026-09-21T12:00:00.000Z",
  });
  targets.warmup_subsections[1].name = "MUTATED LIVE PLAN";
  const response = deriveWorkoutResponse({
    athleteId: "athlete-a",
    sessionId: "session-a",
    blocks,
    resolvedPrescription: frozen,
    completedActiveSec: 12,
    cancelled: false,
    hrSamples: [],
    bikeSamples: [],
  });
  assert.deepEqual(response.phases.map((phase) => phase.detailName), ["Easy", "Build"]);
  assert.equal(response.phases.some((phase) => phase.detailName === "MUTATED LIVE PLAN"), false);
});

test("HR-only and mixed-provenance responses remain explicit and never manufacture zero watts", () => {
  const hrOnly = responseFixture();
  assert.ok(hrOnly);
  assert.equal(hrOnly.evidence.bike.wattsProvenance, "unavailable");
  assert.equal(hrOnly.evidence.bike.freshSampleCount, 0);
  assert.equal(hrOnly.evidence.bike.freshRowCoverageRatio, 0);
  assert.ok(hrOnly.phases.every((phase) => phase.watts === undefined));
  assert.ok(hrOnly.phases.some((phase) => phase.hr));

  const transportOnly = responseFixture({ bikeSamples: [
    rawSample({ watts: undefined }),
  ] });
  assert.equal(transportOnly.evidence.bike.freshRowCoverageRatio, 1 / 24);
  assert.equal(Object.prototype.hasOwnProperty.call(transportOnly.evidence.bike, "coverageRatio"), false);
  assert.equal(transportOnly.evidence.bike.wattsProvenance, "unavailable");

  const mixed = responseFixture({ bikeSamples: [
    rawSample({ activeSec: 1, sourceSampleId: "measured", watts: { value: 100, source: "measured_watts", freshnessMs: 10 } }),
    rawSample({ activeSec: 2, sourceSampleId: "calibrated", watts: { value: 105, source: "calibrated_watts", freshnessMs: 10 } }),
    rawSample({ activeSec: 3, sourceSampleId: "control-only", watts: undefined, desiredResistance: 15, commandedResistance: 15 }),
  ] });
  assert.equal(mixed.evidence.bike.wattsProvenance, "mixed");
  assert.equal(mixed.phases[0].watts.provenance, "mixed");
  assert.equal(mixed.phases[0].desiredResistance.max, 15);
});

test("WorkoutResponse parser reconstructs v1 and fails closed on malformed or future records", () => {
  const valid = responseFixture();
  assert.deepEqual(parseWorkoutResponse(structuredClone(valid)), valid);
  assert.equal(parseWorkoutResponse({ ...valid, schemaVersion: 2 }), null);
  assert.equal(parseWorkoutResponse({ ...valid, athleteId: "" }), null);
  const malformed = structuredClone(valid);
  malformed.completion.completionFraction = 42;
  assert.equal(parseWorkoutResponse(malformed), null);
});

test("malformed persisted WorkoutResponse is omitted while its workout history remains readable", async () => {
  await resetWorkoutStorageForTests();
  const malformed = structuredClone(responseFixture());
  malformed.evidence.bike.freshRowCoverageRatio = 5;
  await storeWorkoutSummary(summary("session-a", {
    athlete_id: "athlete-a",
    workout_response: malformed,
  }));
  const [stored] = await getAllWorkoutSummaries();
  assert.equal(stored.summary.external_session_id, "session-a");
  assert.equal(stored.summary.workout_response, undefined);
  await resetWorkoutStorageForTests();
});

test("persisted WorkoutResponse must match its containing session and athlete", async () => {
  await resetWorkoutStorageForTests();
  const valid = responseFixture();
  const foreignSession = structuredClone(valid);
  foreignSession.sessionId = "session-foreign";
  const missingOwner = structuredClone(valid);
  missingOwner.sessionId = "session-unowned";
  await storeWorkoutSummary(summary("session-a", {
    athlete_id: "athlete-a",
    workout_response: valid,
  }));
  await storeWorkoutSummary(summary("session-foreign", {
    athlete_id: "athlete-b",
    workout_response: foreignSession,
  }));
  await storeWorkoutSummary(summary("session-cross-linked", {
    athlete_id: "athlete-a",
    workout_response: valid,
  }));
  await storeWorkoutSummary(summary("session-unowned", {
    workout_response: missingOwner,
  }));
  const stored = new Map(
    (await getAllWorkoutSummaries()).map((row) => [row.summary.external_session_id, row.summary])
  );
  assert.equal(stored.get("session-a").workout_response.sessionId, "session-a");
  assert.equal(stored.get("session-foreign").workout_response, undefined);
  assert.equal(stored.get("session-cross-linked").workout_response, undefined);
  assert.equal(stored.get("session-unowned").workout_response, undefined);
  await resetWorkoutStorageForTests();
});

test("ordinary summary finalization derives WorkoutResponse from persisted raw data and the frozen plan", async () => {
  await resetWorkoutStorageForTests();
  const previousStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const athlete = migrateLegacyProfile(
    { age: 40, weight: 176, vo2: "" },
    "athlete-finalize",
    "2026-09-20T12:00:00.000Z"
  );
  const storage = memoryStorage({ [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(athlete) });
  globalThis.localStorage = storage;
  globalThis.window = {
    getWorkoutMetadata: () => ({ Tuesday: { intent: "frozen-finalization" } }),
  };
  const minuteSixth = 1 / 6;
  const originalTemplate = {
    weekly_plan: [{
      day: "Tuesday",
      type: "Intervals",
      intent: "frozen-finalization",
      activities: ["bike"],
      warmup: { duration_min: minuteSixth, target_hr_bpm: "100-110", intensity_id: "warmup_easy" },
      main_set: {
        repetitions: 2,
        intervals: [
          { phase: "Work", kind: "work", duration_min: minuteSixth, target_hr_bpm: "150-160", intensity_id: "vo2_short" },
          { phase: "Recovery", kind: "recovery", duration_min: minuteSixth, target_hr_bpm: "110-120", intensity_id: "recovery" },
        ],
      },
      cooldown: { duration_min: minuteSixth, target_hr_bpm: "95-105", intensity_id: "cooldown" },
    }],
  };
  transformWorkoutData(originalTemplate);
  const blocks = { warm: minuteSixth, sustain: 4 * minuteSixth, cool: minuteSixth };
  const frozenPrescription = resolveWorkoutPrescription({
    workoutSelector: "Tuesday",
    blocks,
    hrTargets: {
      warmup: "100-110",
      warmup_intensity_id: "warmup_easy",
      cooldown: "95-105",
      cooldown_intensity_id: "cooldown",
      intervals: {
        phases: [
          { phase: "Work", kind: "work", duration: minuteSixth, target_hr_bpm: "150-160", intensity_id: "vo2_short" },
          { phase: "Recovery", kind: "recovery", duration: minuteSixth, target_hr_bpm: "110-120", intensity_id: "recovery" },
        ],
        repetitions: 2,
        isSequence: false,
      },
    },
    resolvedAt: "2026-09-21T12:00:00.000Z",
  });
  const startedAt = Date.parse("2026-09-21T12:00:00.000Z");
  startSession("Tuesday", startedAt, "session-finalize", "bike", storage, {
    blocks,
    hrTargets: null,
    resolvedPrescription: frozenPrescription,
  });
  await storeHrSample("session-finalize", 5, 110);
  await storeHrSample("session-finalize", 15, 150);
  await storeOrdinaryBikeTelemetrySample(rawSample({
    athleteId: "athlete-finalize",
    sessionId: "session-finalize",
    activeSec: 15,
    observedAt: "2026-09-21T12:00:15.000Z",
    sourceSampleId: "finalize-snapshot",
  }));

  transformWorkoutData({
    weekly_plan: [{
      ...originalTemplate.weekly_plan[0],
      activities: ["elliptical"],
      warmup: { ...originalTemplate.weekly_plan[0].warmup, duration_min: 5 },
    }],
  });
  try {
    const completed = await generateWorkoutSummary(
      "session-finalize",
      startedAt,
      startedAt + 60_000,
      "Tuesday"
    );
    assert.ok(completed.workout_response);
    assert.equal(completed.workout_response.athleteId, "athlete-finalize");
    assert.equal(completed.workout_response.sessionId, "session-finalize");
    assert.deepEqual(completed.workout_response.phases.map((phase) => phase.phaseId), [
      "warmup",
      "cycle:0:0",
      "cycle:0:1",
      "cycle:1:0",
      "cycle:1:1",
      "cooldown",
    ]);
    assert.equal(completed.workout_response.phases[0].plannedDurationSec, 10);
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.window = previousWindow;
    await resetWorkoutStorageForTests();
  }
});

test("workout deletion removes only that session's HR and ordinary telemetry", async () => {
  await resetWorkoutStorageForTests();
  await storeWorkoutSummary(summary("session-a"));
  await storeWorkoutSummary(summary("session-b"));
  await storeHrSample("session-a", 1, 120);
  await storeHrSample("session-b", 1, 130);
  await storeOrdinaryBikeTelemetrySample(rawSample());
  await storeOrdinaryBikeTelemetrySample(rawSample({
    athleteId: "athlete-b",
    sessionId: "session-b",
    sourceSampleId: "snapshot-b",
  }));
  assert.equal(await deleteWorkoutSummary("session-a"), true);
  assert.deepEqual(await getHrSamples("session-a"), []);
  assert.deepEqual(await getOrdinaryBikeTelemetrySamples("session-a"), []);
  assert.equal((await getHrSamples("session-b")).length, 1);
  assert.equal((await getOrdinaryBikeTelemetrySamples("session-b")).length, 1);
  await resetWorkoutStorageForTests();
});

test("replacing session A clears only A's abandoned ordinary telemetry", async () => {
  await resetWorkoutStorageForTests();
  const previousStorage = globalThis.localStorage;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  try {
    await initDB();
    startSession("Tuesday", Date.parse("2026-09-21T12:00:00.000Z"), "session-a", "bike", storage);
    queueOrdinaryBikeTelemetrySample(rawSample());
    await storeOrdinaryBikeTelemetrySample(rawSample({
      athleteId: "athlete-b",
      sessionId: "session-b",
      sourceSampleId: "snapshot-b",
    }));
    await releaseReplacedSessionTelemetry("Tuesday", "session-b");
    assert.deepEqual(await getOrdinaryBikeTelemetrySamples("session-a"), []);
    assert.equal((await getOrdinaryBikeTelemetrySamples("session-b")).length, 1);
  } finally {
    globalThis.localStorage = previousStorage;
    await resetWorkoutStorageForTests();
  }
});

test("restart clears the old session's ordinary telemetry", async () => {
  await resetWorkoutStorageForTests();
  const previousStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  globalThis.window = {
    getSelectedDay: () => "Tuesday",
    updateDisplay: () => undefined,
  };
  try {
    await initDB();
    startSession("Tuesday", Date.now(), "session-restart", "bike", storage);
    queueOrdinaryBikeTelemetrySample(rawSample({
      sessionId: "session-restart",
      sourceSampleId: "snapshot-restart",
    }));
    await restartWorkout();
    assert.deepEqual(await getOrdinaryBikeTelemetrySamples("session-restart"), []);
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.window = previousWindow;
    await resetWorkoutStorageForTests();
  }
});

test("abandoned cleanup preserves raw evidence owned by an immutable summary", async () => {
  await resetWorkoutStorageForTests();
  const old = "2026-09-01T12:00:00.000Z";
  await storeOrdinaryBikeTelemetrySample(rawSample({ observedAt: old }));
  await storeOrdinaryBikeTelemetrySample(rawSample({
    athleteId: "athlete-b",
    sessionId: "session-b",
    sourceSampleId: "snapshot-b",
    observedAt: old,
  }));
  await storeWorkoutSummary(summary("session-b"));
  await storeOrdinaryBikeTelemetrySample(rawSample({
    athleteId: "athlete-c",
    sessionId: "session-c",
    sourceSampleId: "snapshot-c",
    observedAt: "2026-09-21T11:00:00.000Z",
  }));
  assert.equal(await cleanupAbandonedOrdinaryBikeTelemetry(Date.parse("2026-09-21T12:00:00.000Z")), 1);
  assert.deepEqual(await getOrdinaryBikeTelemetrySamples("session-a"), []);
  assert.equal((await getOrdinaryBikeTelemetrySamples("session-b")).length, 1);
  assert.equal((await getOrdinaryBikeTelemetrySamples("session-c")).length, 1);
  await resetWorkoutStorageForTests();
});

test("ordinary summary emission leaves FitnessState byte-for-byte unchanged", async () => {
  await resetWorkoutStorageForTests();
  const previousStorage = globalThis.localStorage;
  const fitnessJson = JSON.stringify({ sentinel: "formal-assessment-only" });
  const storage = memoryStorage({ [FITNESS_STATE_STORAGE_KEY]: fitnessJson });
  globalThis.localStorage = storage;
  try {
    await emitWorkoutSummary(summary("fitness-isolation", {
      athlete_id: "athlete-a",
      activity: "bike",
      workout_response: responseFixture(),
    }));
    assert.equal(storage.getItem(FITNESS_STATE_STORAGE_KEY), fitnessJson);
  } finally {
    globalThis.localStorage = previousStorage;
    await resetWorkoutStorageForTests();
  }
});

test("SISU payload strips WorkoutResponse while preserving the local summary", () => {
  const local = summary("sisu-local", {
    athlete_id: "athlete-a",
    activity: "bike",
    workout_response: responseFixture(),
  });
  const payload = buildSisuWorkoutPayload(local);
  assert.equal(payload.workout_response, undefined);
  assert.ok(local.workout_response);
  assert.equal(local.workout_response.schemaVersion, WORKOUT_RESPONSE_SCHEMA_VERSION_V1);
});
