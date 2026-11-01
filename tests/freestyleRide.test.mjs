import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

import {
  FREESTYLE_WORKOUT_SELECTOR_ID,
  claimActiveSessionOwner,
  clearActiveSessionOwner,
  clearFreestyleAuthorityFault,
  clearSessionFinalization,
  collectProtectedFreestyleSessionIds,
  freestylePhaseState,
  freezeSessionFinalization,
  isFreestyleWorkoutSelector,
  markFreestyleAuthorityFault,
  readActiveSessionOwner,
  readFreestyleAuthorityFault,
  readSessionFinalization,
  writeSessionFinalization,
} from "../dist/freestyleRide.js";
import {
  beginWorkout,
  controlModeForUserFacingWorkout,
  freestyleStartBlocked,
  getPhase,
  actualElapsedSeconds,
  restoreBikeBridgeBindingForActiveSession,
  startWorkout,
} from "../dist/workoutLogic.js";
import {
  discardFreestyleRide,
  discardWorkoutSession,
  finishFreestyleRide,
  retryFreestyleSave,
  setFreestyleCleanupFailureInjectorForTests,
  validateFreestyleFinalizationOwnership,
} from "../dist/workoutLifecycle.js";
import {
  getSession,
  pauseSession,
  resumeSession,
  startSession,
  clearSession,
  totalPausedDurationSec,
  isSessionStale,
} from "../dist/sessionStore.js";
import {
  installStandaloneFreestyleWorkout,
  getPlan,
  getWorkoutMetadata,
} from "../dist/workoutData.js";
import {
  createBikeBridgeSession,
  setBikeBridgeSessionForTests,
} from "../dist/platform/bikeBridgeRuntime.js";
import {
  emitWorkoutSummary,
  generateWorkoutSummary,
  determinePrimaryZoneHonest,
  determineStressProfile,
} from "../dist/workoutSummary.js";
import { calculateZoneMinutes } from "../dist/zoneCalculator.js";
import {
  ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS,
  cleanupAbandonedOrdinaryBikeTelemetry,
  getAllWorkoutSummaries,
  getHrSamples,
  getOrdinaryBikeTelemetrySamples,
  queueOrdinaryBikeTelemetrySample,
  flushOrdinaryBikeTelemetryWrites,
  resetWorkoutStorageForTests,
  storeHrSample,
  storeOrdinaryBikeTelemetrySample,
  storeWorkoutSummary,
  clearHrSamples,
  getWorkoutSummaryBySessionId,
} from "../dist/workoutStorage.js";
import { buildOrdinaryBikeTelemetrySample } from "../dist/ordinaryWorkoutTelemetry.js";
import { buildSisuWorkoutPayload, prepareSisuWorkoutPayload } from "../dist/sisuSync.js";
import { FITNESS_STATE_STORAGE_KEY } from "../dist/fitnessState.js";
import { ATHLETE_PROFILE_STORAGE_KEY, migrateLegacyProfile } from "../dist/profile.js";
import { learnFromCompletedWorkout, listLearnedStarts } from "../dist/machines/learning/index.js";
import { clearFrozenSessionControlMode } from "../dist/sessionControlMode.js";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function metric(value) {
  return {
    value,
    observedAt: value === null ? null : "2026-11-01T12:00:00.000Z",
    current: value !== null,
  };
}

function createFakeBikeBridge(initial = {}) {
  const state = {
    connected: true,
    initialized: true,
    controlAvailable: true,
    requested: null,
    observed: 4,
    rpm: 80,
    watts: 150,
    posts: [],
    ...initial,
  };
  const transport = {
    async request(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method === "POST" && path === "/api/v1/resistance") {
        state.posts.push(req.jsonBody);
        state.requested = req.jsonBody?.value ?? req.jsonBody?.level ?? null;
        return { status: 200, text: JSON.stringify({ requested: state.requested }) };
      }
      if (req.method === "GET" && path === "/api/v1/status") {
        return {
          status: 200,
          text: JSON.stringify({
            status: "ok",
            bridgeVersion: "0.1.0-poc",
            connected: state.connected,
            initialized: state.initialized,
            resistanceControlAvailable: state.controlAvailable,
            resistance: {
              requested: state.requested,
              requestedAt: null,
              observed: state.observed,
              observedAt: "2026-11-01T12:00:00.000Z",
            },
          }),
        };
      }
      if (req.method === "GET" && path === "/api/v1/telemetry") {
        return {
          status: 200,
          text: JSON.stringify({
            connected: state.connected,
            initialized: state.initialized,
            snapshotAt: "2026-11-01T12:00:00.000Z",
            resistance: metric(state.observed),
            rpm: metric(state.rpm),
            watts: metric(state.watts),
            machine: null,
          }),
        };
      }
      return { status: 404, text: JSON.stringify({ error: "not found" }) };
    },
  };
  return { state, transport };
}

function withAthleteStorage() {
  const athlete = migrateLegacyProfile(
    { age: 40, weight: 176, vo2: "" },
    "athlete-freestyle",
    "2026-11-01T12:00:00.000Z"
  );
  return memoryStorage({ [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(athlete) });
}

function freestyleFinalization(sessionId, startedAt, endedAt, activeDurationSec) {
  return {
    schemaVersion: 1,
    selector: "Freestyle",
    sessionId,
    startedAtMs: startedAt,
    endedAtMs: endedAt,
    activeDurationSec,
    pausedDurationSec: 0,
    status: "finalizing",
  };
}

test("freestyle selector identity and metadata install", () => {
  assert.equal(FREESTYLE_WORKOUT_SELECTOR_ID, "Freestyle");
  assert.equal(isFreestyleWorkoutSelector("Freestyle"), true);
  assert.equal(isFreestyleWorkoutSelector("Sunday"), false);
  installStandaloneFreestyleWorkout();
  assert.deepEqual(getPlan().Freestyle, { warm: 0, sustain: 0, cool: 0 });
  assert.equal(getWorkoutMetadata().Freestyle.intent, "freestyle");
  assert.deepEqual(getWorkoutMetadata().Freestyle.activities, ["bike"]);
});

test("control mode freezes manual_freestyle_ride and never falls back to legacy", () => {
  assert.equal(controlModeForUserFacingWorkout("Freestyle"), "manual_freestyle_ride");
  assert.equal(controlModeForUserFacingWorkout("Monday"), "legacy_hr_control");
  assert.equal(controlModeForUserFacingWorkout("VO2MaxEstimation"), "vo2_protocol");
});

test("freestyle phase never auto-completes", () => {
  const phase = getPhase(10_000, { warm: 0, sustain: 0, cool: 0 }, null, { day: "Freestyle" });
  assert.equal(phase.done, false);
  assert.equal(phase.phaseId, "freestyle_ride");
  assert.equal(phase.phase, "Freestyle");
  assert.equal(phase.timeLeft, 0);
  assert.equal(freestylePhaseState(42).phaseElapsedSeconds, 42);
});

test("beginWorkout binds freestyle authority before guidance and blocks resistance POSTs", async () => {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  globalThis.window = {
    generateUUID: () => "fs-session-1",
    getSelectedDay: () => "Freestyle",
    updateDisplay: () => {},
    initDB: async () => {},
  };
  installStandaloneFreestyleWorkout();
  const fake = createFakeBikeBridge();
  const bridge = createBikeBridgeSession({
    storage,
    transport: fake.transport,
    pollIntervalMs: 1000,
    requestTimeoutMs: 50,
  });
  assert.equal(bridge.configure({
    baseUrl: "http://127.0.0.1:8765",
    automaticControlEnabled: true,
  }).ok, true);
  setBikeBridgeSessionForTests(bridge);

  beginWorkout("bike");
  const session = getSession("Freestyle", storage);
  assert.equal(session.sessionId, "fs-session-1");
  assert.equal(session.controlAuthority?.mode, "manual_freestyle_ride");
  assert.equal(session.controlAuthority?.source, "frozen");
  assert.equal(session.activity, "bike");
  assert.equal(session.phasePlan, null);
  assert.deepEqual(bridge.getSessionBinding(), {
    sessionId: "fs-session-1",
    controlMode: "manual_freestyle_ride",
  });
  assert.deepEqual(readActiveSessionOwner(storage), {
    selector: "Freestyle",
    sessionId: "fs-session-1",
    athleteId: "athlete-freestyle",
  });

  bridge.onGuidance({
    desiredResistance: 9,
    recommendationChanged: true,
    workoutActive: true,
    paused: false,
    workout: { day: "Freestyle", sessionId: "fs-session-1" },
  });
  await delay(40);
  assert.equal(fake.state.posts.length, 0);

  bridge.stop();
  setBikeBridgeSessionForTests(null);
  clearSession("Freestyle", storage);
  clearActiveSessionOwner(undefined, storage);
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("pause and resume preserve active elapsed time", () => {
  const storage = memoryStorage();
  const start = 1_700_000_000_000;
  startSession("Freestyle", start, "fs-pause", "bike", storage, null, undefined, undefined, "manual_freestyle_ride");
  const pauseAt = start + 120_000;
  pauseSession("Freestyle", 120, storage, pauseAt);
  const duringPause = getSession("Freestyle", storage);
  assert.equal(actualElapsedSeconds(duringPause.startTime, true, duringPause.pausedElapsed, pauseAt + 60_000), 120);
  resumeSession("Freestyle", storage, pauseAt + 60_000);
  const after = getSession("Freestyle", storage);
  assert.equal(after.paused, false);
  assert.equal(actualElapsedSeconds(after.startTime, false, after.pausedElapsed, pauseAt + 60_000 + 30_000), 150);
  assert.equal(totalPausedDurationSec(after, pauseAt + 90_000), 60);
});

test("active session ownership blocks competing starts and survives selector drift", () => {
  const storage = memoryStorage();
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-own" }, storage);
  startSession("Freestyle", Date.now(), "fs-own", "bike", storage, null, undefined, undefined, "manual_freestyle_ride");
  const blocked = claimActiveSessionOwner({ selector: "Monday", sessionId: "other" }, storage);
  assert.equal(blocked.ok, false);
  assert.equal(readActiveSessionOwner(storage)?.sessionId, "fs-own");
  clearSession("Freestyle", storage);
  assert.equal(readActiveSessionOwner(storage), null);
});

test("finish persists summary once; retry does not advance end time or duplicate", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  const startedAt = Date.parse("2026-11-01T12:00:00.000Z");
  const endedAt = startedAt + 900_000;
  startSession(
    "Freestyle",
    startedAt,
    "fs-finish-1",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner(
    { selector: "Freestyle", sessionId: "fs-finish-1", athleteId: "athlete-freestyle" },
    storage
  );
  installStandaloneFreestyleWorkout();

  let emitCalls = 0;
  globalThis.window = {
    getWorkoutMetadata: () => getWorkoutMetadata(),
    generateWorkoutSummary: async (sessionId, startMs, endMs, day, options) =>
      generateWorkoutSummary(sessionId, startMs, endMs, day, options),
    emitWorkoutSummaryConfirmed: async (summary) => {
      emitCalls += 1;
      return storeWorkoutSummary(summary);
    },
  };

  const first = await finishFreestyleRide("Freestyle", storage, endedAt);
  assert.equal(first.ok, true);
  assert.equal(emitCalls, 1);
  assert.equal(first.summary.cancelled, false);
  assert.equal(first.summary.workout_response, undefined);
  assert.equal(first.summary.resolved_prescription, undefined);
  assert.equal(first.summary.open_ended_timing.active_sec, 900);
  assert.equal(readSessionFinalization("Freestyle", storage), null);
  assert.equal(getSession("Freestyle", storage).sessionId, null);

  const second = await finishFreestyleRide("Freestyle", storage, endedAt + 60_000);
  assert.equal(second.ok, false);
  assert.equal(emitCalls, 1);

  const rows = await getAllWorkoutSummaries();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].summary.external_session_id, "fs-finish-1");
  assert.equal(rows[0].summary.endedAt, new Date(endedAt).toISOString());

  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("failed save preserves finalization and retry succeeds without advancing end", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  const startedAt = Date.parse("2026-11-01T13:00:00.000Z");
  const endedAt = startedAt + 600_000;
  startSession(
    "Freestyle",
    startedAt,
    "fs-retry-1",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-retry-1" }, storage);
  installStandaloneFreestyleWorkout();

  let failOnce = true;
  globalThis.window = {
    getWorkoutMetadata: () => getWorkoutMetadata(),
    generateWorkoutSummary: async (sessionId, startMs, endMs, day, options) =>
      generateWorkoutSummary(sessionId, startMs, endMs, day, options),
    emitWorkoutSummaryConfirmed: async (summary) => {
      if (failOnce) {
        failOnce = false;
        return false;
      }
      return storeWorkoutSummary(summary);
    },
  };

  const failed = await finishFreestyleRide("Freestyle", storage, endedAt);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "save_failed");
  const frozen = readSessionFinalization("Freestyle", storage);
  assert.equal(frozen?.endedAtMs, endedAt);
  assert.equal(frozen?.sessionId, "fs-retry-1");
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-retry-1");

  const retried = await retryFreestyleSave("Freestyle", storage);
  assert.equal(retried.ok, true);
  assert.equal(retried.summary.endedAt, new Date(endedAt).toISOString());
  assert.equal(readSessionFinalization("Freestyle", storage), null);

  const rows = await getAllWorkoutSummaries();
  assert.equal(rows.length, 1);

  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("discard removes evidence and never saves a summary", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  globalThis.window = {
    updateDisplay: () => {},
    clearHrSamples: async (sessionId) => clearHrSamples(sessionId),
  };
  startSession(
    "Freestyle",
    Date.now(),
    "fs-discard-1",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-discard-1" }, storage);
  await storeHrSample("fs-discard-1", 1, 140);
  assert.equal((await getHrSamples("fs-discard-1")).length, 1);
  const result = await discardFreestyleRide("Freestyle", storage);
  assert.equal(result.ok, true);
  assert.equal(getSession("Freestyle", storage).sessionId, null);
  assert.equal(readActiveSessionOwner(storage), null);
  assert.equal((await getAllWorkoutSummaries()).length, 0);
  assert.equal((await getHrSamples("fs-discard-1")).length, 0);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("no HR and partial HR stay honest without zone padding", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  globalThis.window = { getWorkoutMetadata: () => getWorkoutMetadata() };

  const startedAt = Date.parse("2026-11-01T14:00:00.000Z");
  const endedAt = startedAt + 45 * 60 * 1000;
  startSession(
    "Freestyle",
    startedAt,
    "fs-nohr",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  const none = await generateWorkoutSummary("fs-nohr", startedAt, endedAt, "Freestyle", {
    cancelled: false,
    freestyleFinalization: freestyleFinalization("fs-nohr", startedAt, endedAt, 45 * 60),
  });
  assert.equal(none.primary_zone, 0);
  assert.equal(none.stress_profile, "unknown");
  assert.equal(determineStressProfile(0), "unknown");
  assert.deepEqual(none.zone_minutes, { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 });
  assert.equal(none.open_ended_timing.valid_hr_sec, 0);
  assert.equal(none.open_ended_timing.unknown_hr_sec, 45 * 60);
  assert.equal(none.duration_minutes, 45);
  const sisuBlocked = prepareSisuWorkoutPayload(none);
  assert.equal(sisuBlocked.ok, false);
  assert.equal(sisuBlocked.reason, "sisu_incompatible_hr_coverage");

  for (let i = 0; i < 15 * 60; i++) {
    await storeHrSample("fs-partial", i, 140);
  }
  startSession(
    "Freestyle",
    startedAt,
    "fs-partial",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  const partial = await generateWorkoutSummary("fs-partial", startedAt, endedAt, "Freestyle", {
    cancelled: false,
    freestyleFinalization: freestyleFinalization("fs-partial", startedAt, endedAt, 45 * 60),
  });
  const zoneSum =
    partial.zone_minutes.z1 +
    partial.zone_minutes.z2 +
    partial.zone_minutes.z3 +
    partial.zone_minutes.z4 +
    partial.zone_minutes.z5;
  assert.equal(zoneSum, 15);
  assert.equal(partial.open_ended_timing.valid_hr_sec, 15 * 60);
  assert.equal(partial.open_ended_timing.unknown_hr_sec, 30 * 60);
  assert.notEqual(partial.primary_zone, 0);
  assert.equal(determinePrimaryZoneHonest(calculateZoneMinutes([])), 0);
  const partialSisu = prepareSisuWorkoutPayload(partial);
  assert.equal(partialSisu.ok, false);
  assert.equal(partialSisu.reason, "sisu_incompatible_hr_coverage");

  const payload = buildSisuWorkoutPayload(partial);
  assert.equal(payload.open_ended_timing, undefined);
  assert.equal(payload.workout_response, undefined);

  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("freestyle finish does not ingest machine learning", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  const fitnessRaw = '{"keep":"untouched-by-freestyle"}';
  storage.setItem(FITNESS_STATE_STORAGE_KEY, fitnessRaw);
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  globalThis.window = { getWorkoutMetadata: () => getWorkoutMetadata() };

  const startedAt = Date.parse("2026-11-01T15:00:00.000Z");
  const endedAt = startedAt + 300_000;
  startSession(
    "Freestyle",
    startedAt,
    "fs-science",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  const summary = await generateWorkoutSummary("fs-science", startedAt, endedAt, "Freestyle", {
    cancelled: false,
    freestyleFinalization: freestyleFinalization("fs-science", startedAt, endedAt, 300),
  });
  assert.equal(summary.workout_response, undefined);
  await emitWorkoutSummary(summary);
  await learnFromCompletedWorkout(summary, storage);
  assert.equal(listLearnedStarts(storage).length, 0);
  assert.equal(storage.getItem(FITNESS_STATE_STORAGE_KEY), fitnessRaw);

  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("refresh recovery restores bridge binding for an active freestyle session", () => {
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  const fake = createFakeBikeBridge();
  const bridge = createBikeBridgeSession({ storage, transport: fake.transport });
  assert.equal(bridge.configure({
    baseUrl: "http://127.0.0.1:8765",
    automaticControlEnabled: true,
  }).ok, true);
  setBikeBridgeSessionForTests(bridge);
  startSession(
    "Freestyle",
    Date.now(),
    "fs-refresh",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-refresh" }, storage);
  assert.equal(restoreBikeBridgeBindingForActiveSession("Freestyle"), true);
  assert.deepEqual(bridge.getSessionBinding(), {
    sessionId: "fs-refresh",
    controlMode: "manual_freestyle_ride",
  });
  bridge.stop();
  setBikeBridgeSessionForTests(null);
  clearSession("Freestyle", storage);
  globalThis.localStorage = previousStorage;
});

test("corrupt freestyle authority fails closed on finish", async () => {
  const storage = withAthleteStorage();
  startSession(
    "Freestyle",
    Date.now(),
    "fs-bad-auth",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "legacy_hr_control"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-bad-auth" }, storage);
  const result = await finishFreestyleRide("Freestyle", storage);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "authority");
});

test("finalization freeze is idempotent across repeated finish requests", () => {
  const storage = memoryStorage();
  const first = freezeSessionFinalization({
    selector: "Freestyle",
    sessionId: "fs-idem",
    startedAtMs: 1000,
    endedAtMs: 2000,
    activeDurationSec: 10,
    pausedDurationSec: 1,
    storage,
  });
  const second = freezeSessionFinalization({
    selector: "Freestyle",
    sessionId: "fs-idem",
    startedAtMs: 1000,
    endedAtMs: 9999,
    activeDurationSec: 99,
    pausedDurationSec: 9,
    storage,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.record.endedAtMs, first.record.endedAtMs);
  assert.equal(second.record.activeDurationSec, first.record.activeDurationSec);
  clearSessionFinalization("Freestyle", storage);
});

test("invalid authority marks fault without discarding ride evidence", async () => {
  await resetWorkoutStorageForTests();
  const storage = withAthleteStorage();
  startSession(
    "Freestyle",
    Date.now() - 60_000,
    "fs-keep-evidence",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-keep-evidence" }, storage);
  await storeHrSample("fs-keep-evidence", 1, 150);
  clearFrozenSessionControlMode("Freestyle", storage);
  assert.equal(getSession("Freestyle", storage).controlAuthority?.mode, "legacy_hr_control");
  assert.equal(getSession("Freestyle", storage).controlAuthority?.source, "historical_compatibility");
  const newlyMarked = markFreestyleAuthorityFault("Freestyle", "fs-keep-evidence", storage);
  assert.equal(newlyMarked, true);
  assert.equal(markFreestyleAuthorityFault("Freestyle", "fs-keep-evidence", storage), false);
  assert.equal(readFreestyleAuthorityFault("Freestyle", storage), "fs-keep-evidence");
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-keep-evidence");
  assert.equal((await getHrSamples("fs-keep-evidence")).length, 1);
  const finish = await finishFreestyleRide("Freestyle", storage);
  assert.equal(finish.ok, false);
  assert.equal(finish.reason, "authority");
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-keep-evidence");
  assert.equal((await getHrSamples("fs-keep-evidence")).length, 1);
  assert.equal((await getAllWorkoutSummaries()).length, 0);
  clearFreestyleAuthorityFault("Freestyle", storage);
  await resetWorkoutStorageForTests();
});

test("finalization session mismatch fails closed without overwriting", () => {
  const storage = withAthleteStorage();
  startSession(
    "Freestyle",
    Date.now(),
    "fs-live-b",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-live-b" }, storage);
  writeSessionFinalization(
    {
      schemaVersion: 1,
      selector: "Freestyle",
      sessionId: "fs-other-a",
      startedAtMs: 1000,
      endedAtMs: 2000,
      activeDurationSec: 10,
      pausedDurationSec: 0,
      status: "save_failed",
    },
    storage
  );
  const ownership = validateFreestyleFinalizationOwnership(
    "Freestyle",
    readSessionFinalization("Freestyle", storage),
    storage
  );
  assert.equal(ownership.ok, false);
  assert.equal(ownership.reason, "ownership_mismatch");
  const freeze = freezeSessionFinalization({
    selector: "Freestyle",
    sessionId: "fs-live-b",
    startedAtMs: 3000,
    endedAtMs: 4000,
    activeDurationSec: 5,
    pausedDurationSec: 0,
    storage,
  });
  assert.equal(freeze.ok, false);
  assert.equal(freeze.reason, "session_conflict");
  assert.equal(readSessionFinalization("Freestyle", storage).sessionId, "fs-other-a");
});

test("recovery after successful storage with interrupted cleanup is idempotent", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  const startedAt = Date.parse("2026-11-01T16:00:00.000Z");
  const endedAt = startedAt + 120_000;
  startSession(
    "Freestyle",
    startedAt,
    "fs-interrupted",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-interrupted" }, storage);
  let emitCalls = 0;
  globalThis.window = {
    getWorkoutMetadata: () => getWorkoutMetadata(),
    generateWorkoutSummary: async () => {
      throw new Error("should not regenerate");
    },
    emitWorkoutSummaryConfirmed: async () => {
      emitCalls += 1;
      return true;
    },
  };
  const summary = await generateWorkoutSummary("fs-interrupted", startedAt, endedAt, "Freestyle", {
    cancelled: false,
    freestyleFinalization: {
      schemaVersion: 1,
      selector: "Freestyle",
      sessionId: "fs-interrupted",
      startedAtMs: startedAt,
      endedAtMs: endedAt,
      activeDurationSec: 120,
      pausedDurationSec: 0,
      status: "finalizing",
      athleteId: "athlete-freestyle",
    },
  });
  assert.equal(await storeWorkoutSummary(summary), true);
  writeSessionFinalization(
    {
      schemaVersion: 1,
      selector: "Freestyle",
      sessionId: "fs-interrupted",
      startedAtMs: startedAt,
      endedAtMs: endedAt,
      activeDurationSec: 120,
      pausedDurationSec: 0,
      status: "finalizing",
      athleteId: "athlete-freestyle",
    },
    storage
  );
  const recovered = await finishFreestyleRide("Freestyle", storage, endedAt);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.alreadyPersisted, true);
  assert.equal(emitCalls, 0);
  assert.equal(readSessionFinalization("Freestyle", storage), null);
  assert.equal(getSession("Freestyle", storage).sessionId, null);
  assert.equal((await getAllWorkoutSummaries()).length, 1);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("startup stale policy does not discard freestyle evidence after 24 hours", () => {
  const storage = withAthleteStorage();
  const startedAt = Date.now() - 30 * 60 * 60 * 1000;
  startSession(
    "Freestyle",
    startedAt,
    "fs-old",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-old" }, storage);
  assert.equal(isSessionStale("Freestyle", storage), true);
  assert.ok(collectProtectedFreestyleSessionIds(storage).includes("fs-old"));
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-old");
  assert.notEqual(isFreestyleWorkoutSelector("Monday"), true);
});

test("abandoned telemetry cleanup preserves protected freestyle session ids", async () => {
  await resetWorkoutStorageForTests();
  const oldIso = new Date(Date.now() - ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS - 60_000).toISOString();
  const sample = buildOrdinaryBikeTelemetrySample({
    athleteId: "athlete-freestyle",
    sessionId: "fs-protected-telem",
    activeSec: 1,
    observedAtMs: Date.parse(oldIso),
    telemetryStale: false,
    telemetryReceivedAtMs: Date.parse(oldIso),
    telemetrySnapshotAt: "snap-old",
    watts: { value: 100, current: true },
    cadenceRpm: { value: 70, current: true },
    observedResistance: { value: 5, current: true },
  });
  assert.equal(await storeOrdinaryBikeTelemetrySample(sample), "stored");
  const deleted = await cleanupAbandonedOrdinaryBikeTelemetry(
    Date.now(),
    ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS,
    ["fs-protected-telem"]
  );
  assert.equal(deleted, 0);
  assert.equal((await getOrdinaryBikeTelemetrySamples("fs-protected-telem")).length, 1);
  const deletedUnprotected = await cleanupAbandonedOrdinaryBikeTelemetry(
    Date.now(),
    ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS,
    []
  );
  assert.equal(deletedUnprotected, 1);
  assert.equal((await getOrdinaryBikeTelemetrySamples("fs-protected-telem")).length, 0);
  await resetWorkoutStorageForTests();
});

test("queued telemetry write failures are visible to flush", async () => {
  await resetWorkoutStorageForTests();
  const {
    setOrdinaryTelemetryWriteFailureInjectorForTests,
  } = await import("../dist/workoutStorage.js");
  setOrdinaryTelemetryWriteFailureInjectorForTests(() => true);
  const sample = buildOrdinaryBikeTelemetrySample({
    athleteId: "athlete-freestyle",
    sessionId: "fs-flush-fail",
    activeSec: 3,
    observedAtMs: Date.now(),
    telemetryStale: false,
    telemetryReceivedAtMs: Date.now(),
    telemetrySnapshotAt: "snap-fail",
    watts: { value: 110, current: true },
    cadenceRpm: { value: 72, current: true },
    observedResistance: { value: 6, current: true },
  });
  queueOrdinaryBikeTelemetrySample(sample);
  const failedFlush = await flushOrdinaryBikeTelemetryWrites("fs-flush-fail");
  assert.equal(failedFlush.ok, false);
  assert.ok(failedFlush.failedCount >= 1 || failedFlush.unresolvedFailures >= 1);
  setOrdinaryTelemetryWriteFailureInjectorForTests(null);
  await resetWorkoutStorageForTests();
});

test("finish marks save_failed when emit throws and retry remains available", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  const startedAt = Date.parse("2026-11-01T17:00:00.000Z");
  const endedAt = startedAt + 180_000;
  startSession(
    "Freestyle",
    startedAt,
    "fs-emit-throw",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-emit-throw" }, storage);
  let shouldThrow = true;
  globalThis.window = {
    getWorkoutMetadata: () => getWorkoutMetadata(),
    generateWorkoutSummary: async (sessionId, startMs, endMs, day, options) =>
      generateWorkoutSummary(sessionId, startMs, endMs, day, options),
    emitWorkoutSummaryConfirmed: async (summary) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("emitter exploded");
      }
      return storeWorkoutSummary(summary);
    },
  };
  const failed = await finishFreestyleRide("Freestyle", storage, endedAt);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "save_failed");
  assert.equal(readSessionFinalization("Freestyle", storage)?.status, "save_failed");
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-emit-throw");
  const retried = await retryFreestyleSave("Freestyle", storage);
  assert.equal(retried.ok, true);
  assert.equal(readSessionFinalization("Freestyle", storage), null);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("finish marks flush_failed when telemetry writes cannot persist", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  const {
    setOrdinaryTelemetryWriteFailureInjectorForTests,
  } = await import("../dist/workoutStorage.js");
  setOrdinaryTelemetryWriteFailureInjectorForTests(() => true);
  const startedAt = Date.parse("2026-11-01T18:00:00.000Z");
  const endedAt = startedAt + 120_000;
  startSession(
    "Freestyle",
    startedAt,
    "fs-finish-flush-fail",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-finish-flush-fail" }, storage);
  const sample = buildOrdinaryBikeTelemetrySample({
    athleteId: "athlete-freestyle",
    sessionId: "fs-finish-flush-fail",
    activeSec: 1,
    observedAtMs: startedAt + 1_000,
    telemetryStale: false,
    telemetryReceivedAtMs: startedAt + 1_000,
    telemetrySnapshotAt: "snap-finish-fail",
    watts: { value: 100, current: true },
    cadenceRpm: { value: 70, current: true },
    observedResistance: { value: 5, current: true },
  });
  queueOrdinaryBikeTelemetrySample(sample);
  globalThis.window = {
    getWorkoutMetadata: () => getWorkoutMetadata(),
    generateWorkoutSummary: async () => {
      throw new Error("should not generate after flush failure");
    },
    emitWorkoutSummaryConfirmed: async () => {
      throw new Error("should not emit after flush failure");
    },
  };
  const failed = await finishFreestyleRide("Freestyle", storage, endedAt);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "flush_failed");
  assert.equal(readSessionFinalization("Freestyle", storage)?.status, "save_failed");
  assert.equal(readSessionFinalization("Freestyle", storage)?.evidenceIncomplete, true);
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-finish-flush-fail");
  assert.equal((await getAllWorkoutSummaries()).length, 0);
  setOrdinaryTelemetryWriteFailureInjectorForTests(null);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("concurrent finish requests share one in-flight persistence attempt", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  const startedAt = Date.parse("2026-11-01T19:00:00.000Z");
  const endedAt = startedAt + 90_000;
  startSession(
    "Freestyle",
    startedAt,
    "fs-concurrent",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-concurrent" }, storage);
  let emitCalls = 0;
  let resolveEmit;
  const emitGate = new Promise((resolve) => {
    resolveEmit = resolve;
  });
  globalThis.window = {
    getWorkoutMetadata: () => getWorkoutMetadata(),
    generateWorkoutSummary: async (sessionId, startMs, endMs, day, options) =>
      generateWorkoutSummary(sessionId, startMs, endMs, day, options),
    emitWorkoutSummaryConfirmed: async (summary) => {
      emitCalls += 1;
      await emitGate;
      return storeWorkoutSummary(summary);
    },
  };
  const first = finishFreestyleRide("Freestyle", storage, endedAt);
  const second = finishFreestyleRide("Freestyle", storage, endedAt + 60_000);
  resolveEmit();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(emitCalls, 1);
  assert.equal((await getAllWorkoutSummaries()).length, 1);
  assert.equal(a.summary.endedAt, b.summary.endedAt);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("discard is blocked while finalizing and does not erase evidence", async () => {
  await resetWorkoutStorageForTests();
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  const startedAt = Date.parse("2026-11-01T20:00:00.000Z");
  startSession(
    "Freestyle",
    startedAt,
    "fs-discard-lock",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  await storeHrSample("fs-discard-lock", 1, 140);
  writeSessionFinalization(
    {
      schemaVersion: 1,
      selector: "Freestyle",
      sessionId: "fs-discard-lock",
      startedAtMs: startedAt,
      endedAtMs: startedAt + 60_000,
      activeDurationSec: 60,
      pausedDurationSec: 0,
      status: "finalizing",
      athleteId: "athlete-freestyle",
    },
    storage
  );
  const blocked = await discardFreestyleRide("Freestyle", storage);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "finalizing");
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-discard-lock");
  assert.equal((await getHrSamples("fs-discard-lock")).length, 1);
  assert.equal(readSessionFinalization("Freestyle", storage)?.status, "finalizing");
  await resetWorkoutStorageForTests();
  globalThis.localStorage = previousStorage;
});

test("persisted-summary recovery does not wipe a different live freestyle session", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  const startedA = Date.parse("2026-11-01T21:00:00.000Z");
  const endedA = startedA + 60_000;
  globalThis.window = {
    getWorkoutMetadata: () => getWorkoutMetadata(),
  };
  const summaryA = await generateWorkoutSummary("fs-old-persisted", startedA, endedA, "Freestyle", {
    cancelled: false,
    freestyleFinalization: {
      schemaVersion: 1,
      selector: "Freestyle",
      sessionId: "fs-old-persisted",
      startedAtMs: startedA,
      endedAtMs: endedA,
      activeDurationSec: 60,
      pausedDurationSec: 0,
      status: "finalizing",
      athleteId: "athlete-freestyle",
    },
  });
  assert.equal(await storeWorkoutSummary(summaryA), true);
  writeSessionFinalization(
    {
      schemaVersion: 1,
      selector: "Freestyle",
      sessionId: "fs-old-persisted",
      startedAtMs: startedA,
      endedAtMs: endedA,
      activeDurationSec: 60,
      pausedDurationSec: 0,
      status: "save_failed",
      athleteId: "athlete-freestyle",
    },
    storage
  );
  startSession(
    "Freestyle",
    Date.parse("2026-11-01T22:00:00.000Z"),
    "fs-live-other",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-live-other" }, storage);
  await storeHrSample("fs-live-other", 1, 150);
  const failed = await finishFreestyleRide("Freestyle", storage);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "ownership_mismatch");
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-live-other");
  assert.equal((await getHrSamples("fs-live-other")).length, 1);
  assert.equal(readSessionFinalization("Freestyle", storage)?.sessionId, "fs-old-persisted");
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("authority fault and recovery paths never POST resistance", async () => {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  globalThis.window = {
    generateUUID: () => "fs-no-post",
    getSelectedDay: () => "Freestyle",
    updateDisplay: () => {},
    initDB: async () => {},
  };
  installStandaloneFreestyleWorkout();
  const fake = createFakeBikeBridge();
  const bridge = createBikeBridgeSession({
    storage,
    transport: fake.transport,
    pollIntervalMs: 1000,
    requestTimeoutMs: 50,
  });
  assert.equal(
    bridge.configure({
      baseUrl: "http://127.0.0.1:8765",
      automaticControlEnabled: true,
    }).ok,
    true
  );
  setBikeBridgeSessionForTests(bridge);
  beginWorkout("bike");
  markFreestyleAuthorityFault("Freestyle", "fs-no-post", storage);
  bridge.bindSession(null);
  bridge.onGuidance({
    desiredResistance: 11,
    recommendationChanged: true,
    workoutActive: true,
    paused: false,
    workout: { day: "Freestyle", sessionId: "fs-no-post" },
  });
  await delay(40);
  assert.equal(fake.state.posts.length, 0);
  assert.equal(bridge.getSessionBinding(), null);
  clearFreestyleAuthorityFault("Freestyle", storage);
  assert.equal(restoreBikeBridgeBindingForActiveSession("Freestyle"), true);
  bridge.onGuidance({
    desiredResistance: 12,
    recommendationChanged: true,
    workoutActive: true,
    paused: false,
    workout: { day: "Freestyle", sessionId: "fs-no-post" },
  });
  await delay(40);
  assert.equal(fake.state.posts.length, 0);
  bridge.stop();
  setBikeBridgeSessionForTests(null);
  clearSession("Freestyle", storage);
  clearActiveSessionOwner(undefined, storage);
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("discardWorkoutSession is not used for freestyle stale cleanup path", () => {
  const storage = withAthleteStorage();
  const startedAt = Date.now() - 40 * 60 * 60 * 1000;
  startSession(
    "Freestyle",
    startedAt,
    "fs-no-auto-discard",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-no-auto-discard" }, storage);
  assert.equal(typeof discardWorkoutSession, "function");
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-no-auto-discard");
  assert.ok(
    collectProtectedFreestyleSessionIds(storage, "fs-no-auto-discard").includes("fs-no-auto-discard")
  );
  assert.equal(isSessionStale("Freestyle", storage), true);
});

test("missing owner still blocks freestyle start over a live session", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  startSession(
    "Freestyle",
    Date.now(),
    "fs-live-missing-owner",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  await storeHrSample("fs-live-missing-owner", 1, 140);
  clearActiveSessionOwner(undefined, storage);
  assert.equal(readActiveSessionOwner(storage), null);
  assert.equal(freestyleStartBlocked("Freestyle", storage), true);
  let uuidCalls = 0;
  globalThis.window = {
    generateUUID: () => {
      uuidCalls += 1;
      return "fs-should-not-start";
    },
    getSelectedDay: () => "Freestyle",
    updateDisplay: () => {},
    showToast: () => {},
  };
  beginWorkout("bike");
  startWorkout();
  assert.equal(uuidCalls, 0);
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-live-missing-owner");
  assert.equal((await getHrSamples("fs-live-missing-owner")).length, 1);
  assert.equal(readActiveSessionOwner(storage), null);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("inconsistent owner and outstanding finalization block freestyle starts", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  startSession(
    "Freestyle",
    Date.now(),
    "fs-live-a",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-owner-b" }, storage);
  await storeHrSample("fs-live-a", 2, 145);
  assert.equal(freestyleStartBlocked("Freestyle", storage), true);
  clearSession("Freestyle", storage);
  writeSessionFinalization(
    {
      schemaVersion: 1,
      selector: "Freestyle",
      sessionId: "fs-final-a",
      startedAtMs: Date.now() - 60_000,
      endedAtMs: Date.now(),
      activeDurationSec: 60,
      pausedDurationSec: 0,
      status: "save_failed",
      athleteId: "athlete-freestyle",
    },
    storage
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-final-a" }, storage);
  assert.equal(freestyleStartBlocked("Freestyle", storage), true);
  let uuidCalls = 0;
  globalThis.window = {
    generateUUID: () => {
      uuidCalls += 1;
      return "fs-blocked-by-finalization";
    },
    getSelectedDay: () => "Freestyle",
    updateDisplay: () => {},
    showToast: () => {},
  };
  beginWorkout("bike");
  startWorkout();
  assert.equal(uuidCalls, 0);
  assert.equal(readSessionFinalization("Freestyle", storage)?.sessionId, "fs-final-a");
  assert.equal((await getHrSamples("fs-live-a")).length, 1);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("failed ownership claim does not overwrite live freestyle evidence", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  startSession(
    "Monday",
    Date.now(),
    "monday-active",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "legacy_hr_control"
  );
  claimActiveSessionOwner({ selector: "Monday", sessionId: "monday-active" }, storage);
  await storeHrSample("fs-never-created", 1, 130);
  globalThis.window = {
    generateUUID: () => "fs-never-created",
    getSelectedDay: () => "Freestyle",
    updateDisplay: () => {},
    showToast: () => {},
  };
  installStandaloneFreestyleWorkout();
  beginWorkout("bike");
  assert.equal(getSession("Freestyle", storage).sessionId, null);
  assert.equal(readActiveSessionOwner(storage)?.sessionId, "monday-active");
  assert.equal(getSession("Monday", storage).sessionId, "monday-active");
  assert.equal((await getHrSamples("fs-never-created")).length, 1);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("failed bike bridge binding rolls back freestyle start without deleting unrelated evidence", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  await storeHrSample("unrelated-keep", 1, 120);
  const fake = createFakeBikeBridge();
  const bridge = createBikeBridgeSession({
    storage,
    transport: fake.transport,
    pollIntervalMs: 1000,
    requestTimeoutMs: 50,
  });
  setBikeBridgeSessionForTests(bridge);
  globalThis.window = {
    generateUUID: () => "fs-bind-fail",
    getSelectedDay: () => "Freestyle",
    updateDisplay: () => {},
    showToast: () => {},
    initDB: async () => {},
  };
  const originalBind = bridge.bindSession.bind(bridge);
  bridge.bindSession = () => {
    throw new Error("bind exploded");
  };
  beginWorkout("bike");
  assert.equal(getSession("Freestyle", storage).sessionId, null);
  assert.equal(readActiveSessionOwner(storage), null);
  assert.equal((await getHrSamples("unrelated-keep")).length, 1);
  assert.equal(fake.state.posts.length, 0);
  bridge.bindSession = originalBind;
  bridge.stop();
  setBikeBridgeSessionForTests(null);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("discard refuses conflicting live and finalization session identities", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  globalThis.window = { updateDisplay: () => {} };
  startSession(
    "Freestyle",
    Date.now(),
    "fs-live-b",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  await storeHrSample("fs-live-b", 1, 150);
  await storeHrSample("fs-final-a", 1, 140);
  writeSessionFinalization(
    {
      schemaVersion: 1,
      selector: "Freestyle",
      sessionId: "fs-final-a",
      startedAtMs: Date.now() - 120_000,
      endedAtMs: Date.now() - 60_000,
      activeDurationSec: 60,
      pausedDurationSec: 0,
      status: "save_failed",
      athleteId: "athlete-freestyle",
    },
    storage
  );
  const refused = await discardFreestyleRide("Freestyle", storage);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "ownership_conflict");
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-live-b");
  assert.equal(readSessionFinalization("Freestyle", storage)?.sessionId, "fs-final-a");
  assert.equal((await getHrSamples("fs-live-b")).length, 1);
  assert.equal((await getHrSamples("fs-final-a")).length, 1);
  const targeted = await discardFreestyleRide("Freestyle", storage, { sessionId: "fs-live-b" });
  assert.equal(targeted.ok, true);
  assert.equal(getSession("Freestyle", storage).sessionId, null);
  assert.equal(readSessionFinalization("Freestyle", storage)?.sessionId, "fs-final-a");
  assert.equal((await getHrSamples("fs-live-b")).length, 0);
  assert.equal((await getHrSamples("fs-final-a")).length, 1);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("discard works with missing live session, missing owner, or corrupted authority", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  globalThis.window = { updateDisplay: () => {} };
  writeSessionFinalization(
    {
      schemaVersion: 1,
      selector: "Freestyle",
      sessionId: "fs-final-only",
      startedAtMs: Date.now() - 90_000,
      endedAtMs: Date.now() - 30_000,
      activeDurationSec: 60,
      pausedDurationSec: 0,
      status: "save_failed",
    },
    storage
  );
  await storeHrSample("fs-final-only", 1, 133);
  const noLive = await discardFreestyleRide("Freestyle", storage, { sessionId: "fs-final-only" });
  assert.equal(noLive.ok, true);
  assert.equal(readSessionFinalization("Freestyle", storage), null);
  assert.equal((await getHrSamples("fs-final-only")).length, 0);

  startSession(
    "Freestyle",
    Date.now(),
    "fs-corrupt-auth",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  clearFrozenSessionControlMode("Freestyle", storage);
  clearActiveSessionOwner(undefined, storage);
  await storeHrSample("fs-corrupt-auth", 1, 144);
  const corrupted = await discardFreestyleRide("Freestyle", storage, { sessionId: "fs-corrupt-auth" });
  assert.equal(corrupted.ok, true);
  assert.equal(getSession("Freestyle", storage).sessionId, null);
  assert.equal((await getHrSamples("fs-corrupt-auth")).length, 0);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("discard delete failure preserves session markers", async () => {
  await resetWorkoutStorageForTests();
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  const {
    setFreestyleEvidenceDeleteFailureInjectorForTests,
  } = await import("../dist/workoutStorage.js");
  setFreestyleEvidenceDeleteFailureInjectorForTests(() => true);
  startSession(
    "Freestyle",
    Date.now(),
    "fs-delete-fail",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-delete-fail" }, storage);
  await storeHrSample("fs-delete-fail", 1, 140);
  await storeOrdinaryBikeTelemetrySample(
    buildOrdinaryBikeTelemetrySample({
      athleteId: "athlete-freestyle",
      sessionId: "fs-delete-fail",
      activeSec: 1,
      observedAtMs: Date.now(),
      telemetryStale: false,
      telemetryReceivedAtMs: Date.now(),
      telemetrySnapshotAt: "snap-delete-fail",
      watts: { value: 100, current: true },
      cadenceRpm: { value: 70, current: true },
      observedResistance: { value: 5, current: true },
    })
  );
  const failed = await discardFreestyleRide("Freestyle", storage, { sessionId: "fs-delete-fail" });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "delete_failed");
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-delete-fail");
  assert.equal(readActiveSessionOwner(storage)?.sessionId, "fs-delete-fail");
  assert.equal((await getHrSamples("fs-delete-fail")).length, 1);
  assert.equal((await getOrdinaryBikeTelemetrySamples("fs-delete-fail")).length, 1);
  setFreestyleEvidenceDeleteFailureInjectorForTests(null);
  await resetWorkoutStorageForTests();
  globalThis.localStorage = previousStorage;
});

test("owner-only finalization cannot generate a new summary", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  const startedAt = Date.parse("2026-11-01T23:00:00.000Z");
  const endedAt = startedAt + 60_000;
  writeSessionFinalization(
    {
      schemaVersion: 1,
      selector: "Freestyle",
      sessionId: "fs-owner-only",
      startedAtMs: startedAt,
      endedAtMs: endedAt,
      activeDurationSec: 60,
      pausedDurationSec: 0,
      status: "save_failed",
      athleteId: "athlete-freestyle",
    },
    storage
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-owner-only" }, storage);
  assert.equal(getSession("Freestyle", storage).sessionId, null);
  const ownership = validateFreestyleFinalizationOwnership(
    "Freestyle",
    readSessionFinalization("Freestyle", storage),
    storage
  );
  assert.equal(ownership.ok, false);
  assert.equal(ownership.reason, "no_session");
  let generateCalls = 0;
  globalThis.window = {
    getWorkoutMetadata: () => getWorkoutMetadata(),
    generateWorkoutSummary: async (...args) => {
      generateCalls += 1;
      return generateWorkoutSummary(...args);
    },
    emitWorkoutSummaryConfirmed: async () => true,
  };
  const result = await finishFreestyleRide("Freestyle", storage, endedAt);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_session");
  assert.equal(generateCalls, 0);
  assert.equal((await getAllWorkoutSummaries()).length, 0);
  assert.equal(readSessionFinalization("Freestyle", storage)?.sessionId, "fs-owner-only");
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("post-save cleanup failures remain retryable and session-scoped", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  const startedAt = Date.parse("2026-11-02T00:00:00.000Z");
  const endedAt = startedAt + 120_000;
  startSession(
    "Freestyle",
    startedAt,
    "fs-cleanup-retry",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-cleanup-retry" }, storage);
  globalThis.window = {
    getWorkoutMetadata: () => getWorkoutMetadata(),
    generateWorkoutSummary: async (sessionId, startMs, endMs, day, options) =>
      generateWorkoutSummary(sessionId, startMs, endMs, day, options),
    emitWorkoutSummaryConfirmed: async (summary) => storeWorkoutSummary(summary),
  };
  setFreestyleCleanupFailureInjectorForTests((step) => step === "before_clear_finalization");
  const first = await finishFreestyleRide("Freestyle", storage, endedAt);
  assert.equal(first.ok, true);
  assert.equal((await getAllWorkoutSummaries()).length, 1);
  assert.equal(readSessionFinalization("Freestyle", storage)?.sessionId, "fs-cleanup-retry");
  assert.equal(getSession("Freestyle", storage).sessionId, null);
  setFreestyleCleanupFailureInjectorForTests((step) => step === "after_clear_session");
  const second = await finishFreestyleRide("Freestyle", storage, endedAt);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyPersisted, true);
  assert.equal(readSessionFinalization("Freestyle", storage)?.sessionId, "fs-cleanup-retry");
  setFreestyleCleanupFailureInjectorForTests(null);
  const third = await finishFreestyleRide("Freestyle", storage, endedAt);
  assert.equal(third.ok, true);
  assert.equal(third.alreadyPersisted, true);
  assert.equal(readSessionFinalization("Freestyle", storage), null);
  assert.equal((await getAllWorkoutSummaries()).length, 1);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("SISU freestyle admission uses exact HR second coverage", () => {
  const base = {
    intent: "freestyle",
    primary_zone: 2,
    stress_profile: "low",
    duration_minutes: 1,
    zone_minutes: { z1: 0, z2: 1, z3: 0, z4: 0, z5: 0 },
  };
  const almost = prepareSisuWorkoutPayload({
    ...base,
    open_ended_timing: {
      wall_clock_sec: 60,
      active_sec: 60,
      paused_sec: 0,
      valid_hr_sec: 59,
      unknown_hr_sec: 1,
    },
  });
  assert.equal(almost.ok, false);
  const gaps = prepareSisuWorkoutPayload({
    ...base,
    open_ended_timing: {
      wall_clock_sec: 60,
      active_sec: 60,
      paused_sec: 0,
      valid_hr_sec: 55,
      unknown_hr_sec: 5,
    },
  });
  assert.equal(gaps.ok, false);
  const inconsistent = prepareSisuWorkoutPayload({
    ...base,
    open_ended_timing: {
      wall_clock_sec: 60,
      active_sec: 60,
      paused_sec: 0,
      valid_hr_sec: 60,
      unknown_hr_sec: 0,
    },
    duration_minutes: 2,
    zone_minutes: { z1: 0, z2: 1, z3: 0, z4: 0, z5: 0 },
  });
  assert.equal(inconsistent.ok, false);
  const badMath = prepareSisuWorkoutPayload({
    ...base,
    open_ended_timing: {
      wall_clock_sec: 60,
      active_sec: 60,
      paused_sec: 0,
      valid_hr_sec: 50,
      unknown_hr_sec: 5,
    },
  });
  assert.equal(badMath.ok, false);
  const complete = prepareSisuWorkoutPayload({
    ...base,
    open_ended_timing: {
      wall_clock_sec: 60,
      active_sec: 60,
      paused_sec: 0,
      valid_hr_sec: 60,
      unknown_hr_sec: 0,
    },
  });
  assert.equal(complete.ok, true);
});

test("flush awaits samples admitted while an earlier write is still in flight", async () => {
  await resetWorkoutStorageForTests();
  const {
    setOrdinaryTelemetryWriteGateForTests,
  } = await import("../dist/workoutStorage.js");
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  let gateHits = 0;
  setOrdinaryTelemetryWriteGateForTests(async () => {
    gateHits += 1;
    if (gateHits === 1) await gate;
  });
  const sample1 = buildOrdinaryBikeTelemetrySample({
    athleteId: "athlete-freestyle",
    sessionId: "fs-flush-race",
    activeSec: 1,
    observedAtMs: Date.now(),
    telemetryStale: false,
    telemetryReceivedAtMs: Date.now(),
    telemetrySnapshotAt: "snap-race-1",
    watts: { value: 100, current: true },
    cadenceRpm: { value: 70, current: true },
    observedResistance: { value: 5, current: true },
  });
  const sample2 = buildOrdinaryBikeTelemetrySample({
    athleteId: "athlete-freestyle",
    sessionId: "fs-flush-race",
    activeSec: 2,
    observedAtMs: Date.now() + 1000,
    telemetryStale: false,
    telemetryReceivedAtMs: Date.now() + 1000,
    telemetrySnapshotAt: "snap-race-2",
    watts: { value: 110, current: true },
    cadenceRpm: { value: 72, current: true },
    observedResistance: { value: 6, current: true },
  });
  queueOrdinaryBikeTelemetrySample(sample1);
  await delay(10);
  const flushPromise = flushOrdinaryBikeTelemetryWrites("fs-flush-race");
  await delay(10);
  queueOrdinaryBikeTelemetrySample(sample2);
  releaseGate();
  const flushed = await flushPromise;
  assert.equal(flushed.ok, true);
  const rows = await getOrdinaryBikeTelemetrySamples("fs-flush-race");
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.activeSec),
    [1, 2]
  );
  setOrdinaryTelemetryWriteGateForTests(null);
  await resetWorkoutStorageForTests();
});

test("short freestyle ride paused overnight remains saveable", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  const startedAt = Date.parse("2026-11-01T08:00:00.000Z");
  const pauseAt = startedAt + 30 * 60 * 1000;
  const finishAt = pauseAt + 30 * 60 * 60 * 1000;
  startSession(
    "Freestyle",
    startedAt,
    "fs-overnight-pause",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-overnight-pause" }, storage);
  pauseSession("Freestyle", 30 * 60, storage, pauseAt);
  globalThis.window = {
    getWorkoutMetadata: () => getWorkoutMetadata(),
    generateWorkoutSummary: async (sessionId, startMs, endMs, day, options) =>
      generateWorkoutSummary(sessionId, startMs, endMs, day, options),
    emitWorkoutSummaryConfirmed: async (summary) => storeWorkoutSummary(summary),
  };
  const saved = await finishFreestyleRide("Freestyle", storage, finishAt);
  assert.equal(saved.ok, true);
  assert.equal(saved.summary.duration_minutes, 30);
  assert.equal(saved.summary.open_ended_timing.active_sec, 30 * 60);
  assert.ok(saved.summary.open_ended_timing.paused_sec >= 30 * 60 * 60);
  assert.ok(saved.summary.open_ended_timing.wall_clock_sec >= 30 * 60 + 30 * 60 * 60);
  assert.equal(Date.parse(saved.summary.startedAt), startedAt);
  assert.equal(Date.parse(saved.summary.endedAt), finishAt);
  const again = await finishFreestyleRide("Freestyle", storage, finishAt);
  assert.equal(again.ok, false);
  assert.equal(again.reason, "no_session");
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("excessive freestyle active duration and invalid timestamps fail closed", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  const startedAt = Date.parse("2026-11-01T01:00:00.000Z");
  startSession(
    "Freestyle",
    startedAt,
    "fs-too-long-active",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-too-long-active" }, storage);
  globalThis.window = {
    getWorkoutMetadata: () => getWorkoutMetadata(),
    generateWorkoutSummary: async (sessionId, startMs, endMs, day, options) =>
      generateWorkoutSummary(sessionId, startMs, endMs, day, options),
    emitWorkoutSummaryConfirmed: async () => true,
  };
  const tooLong = await finishFreestyleRide(
    "Freestyle",
    storage,
    startedAt + 25 * 60 * 60 * 1000
  );
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, "stale");
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-too-long-active");

  await assert.rejects(
    () =>
      generateWorkoutSummary("fs-bad-time", startedAt + 60_000, startedAt, "Freestyle", {
        cancelled: false,
        freestyleFinalization: {
          schemaVersion: 1,
          selector: "Freestyle",
          sessionId: "fs-bad-time",
          startedAtMs: startedAt + 60_000,
          endedAtMs: startedAt,
          activeDurationSec: 60,
          pausedDurationSec: 0,
          status: "finalizing",
        },
      }),
    /Invalid workout timestamps/
  );
  await assert.rejects(
    () =>
      generateWorkoutSummary("fs-bad-active", startedAt, startedAt + 60_000, "Freestyle", {
        cancelled: false,
        freestyleFinalization: {
          schemaVersion: 1,
          selector: "Freestyle",
          sessionId: "fs-bad-active",
          startedAtMs: startedAt,
          endedAtMs: startedAt + 60_000,
          activeDurationSec: 120,
          pausedDurationSec: 0,
          status: "finalizing",
        },
      }),
    /Inconsistent Freestyle timing/
  );
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("atomic discard aborts without partial evidence loss", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  globalThis.window = { updateDisplay: () => {} };
  const {
    setFreestyleEvidenceDeleteFailureInjectorForTests,
  } = await import("../dist/workoutStorage.js");
  startSession(
    "Freestyle",
    Date.now(),
    "fs-atomic-discard",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-atomic-discard" }, storage);
  await storeHrSample("fs-atomic-discard", 1, 150);
  await storeOrdinaryBikeTelemetrySample(
    buildOrdinaryBikeTelemetrySample({
      athleteId: "athlete-freestyle",
      sessionId: "fs-atomic-discard",
      activeSec: 3,
      observedAtMs: Date.now(),
      telemetryStale: false,
      telemetryReceivedAtMs: Date.now(),
      telemetrySnapshotAt: "snap-atomic",
      watts: { value: 120, current: true },
      cadenceRpm: { value: 75, current: true },
      observedResistance: { value: 7, current: true },
    })
  );
  setFreestyleEvidenceDeleteFailureInjectorForTests(() => true);
  const failed = await discardFreestyleRide("Freestyle", storage, {
    sessionId: "fs-atomic-discard",
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "delete_failed");
  assert.equal((await getHrSamples("fs-atomic-discard")).length, 1);
  assert.equal((await getOrdinaryBikeTelemetrySamples("fs-atomic-discard")).length, 1);
  assert.equal(getSession("Freestyle", storage).sessionId, "fs-atomic-discard");
  setFreestyleEvidenceDeleteFailureInjectorForTests(null);
  const retried = await discardFreestyleRide("Freestyle", storage, {
    sessionId: "fs-atomic-discard",
  });
  assert.equal(retried.ok, true);
  assert.equal((await getHrSamples("fs-atomic-discard")).length, 0);
  assert.equal((await getOrdinaryBikeTelemetrySamples("fs-atomic-discard")).length, 0);
  assert.equal(getSession("Freestyle", storage).sessionId, null);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("rejected telemetry remains unresolved across successive flushes", async () => {
  await resetWorkoutStorageForTests();
  queueOrdinaryBikeTelemetrySample({
    schemaVersion: 1,
    athleteId: "athlete-freestyle",
    sessionId: "fs-reject-flush",
    activeSec: -1,
    observedAt: "not-a-timestamp",
    availability: "fresh",
  });
  const first = await flushOrdinaryBikeTelemetryWrites("fs-reject-flush");
  assert.equal(first.ok, false);
  assert.ok(first.rejectedCount >= 1);
  assert.equal(first.retryableFailures, 0);
  assert.ok(first.unresolvedFailures >= 1);
  const second = await flushOrdinaryBikeTelemetryWrites("fs-reject-flush");
  assert.equal(second.ok, false);
  assert.ok(second.rejectedCount >= 1);
  assert.equal(second.retryableFailures, 0);
  assert.ok(second.unresolvedFailures >= 1);
  await resetWorkoutStorageForTests();
});

test("irrecoverable telemetry rejection saves incomplete evidence and survives reload", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  const startedAt = Date.parse("2026-11-02T04:00:00.000Z");
  const endedAt = startedAt + 180_000;
  startSession(
    "Freestyle",
    startedAt,
    "fs-incomplete-save",
    "bike",
    storage,
    null,
    undefined,
    undefined,
    "manual_freestyle_ride"
  );
  claimActiveSessionOwner({ selector: "Freestyle", sessionId: "fs-incomplete-save" }, storage);
  queueOrdinaryBikeTelemetrySample({
    schemaVersion: 1,
    athleteId: "athlete-freestyle",
    sessionId: "fs-incomplete-save",
    activeSec: -5,
    observedAt: "bad",
    availability: "fresh",
  });
  globalThis.window = {
    getWorkoutMetadata: () => getWorkoutMetadata(),
    generateWorkoutSummary: async (sessionId, startMs, endMs, day, options) =>
      generateWorkoutSummary(sessionId, startMs, endMs, day, options),
    emitWorkoutSummaryConfirmed: async (summary) => storeWorkoutSummary(summary),
  };
  const firstFlush = await flushOrdinaryBikeTelemetryWrites("fs-incomplete-save");
  assert.equal(firstFlush.ok, false);
  assert.ok(firstFlush.rejectedCount >= 1);
  const saved = await finishFreestyleRide("Freestyle", storage, endedAt);
  assert.equal(saved.ok, true);
  assert.equal(saved.summary.evidence_incomplete, true);
  assert.equal(readSessionFinalization("Freestyle", storage), null);
  assert.equal(getSession("Freestyle", storage).sessionId, null);
  const reloaded = await getWorkoutSummaryBySessionId("fs-incomplete-save");
  assert.equal(reloaded?.evidence_incomplete, true);
  assert.equal(reloaded?.external_session_id, "fs-incomplete-save");
  const sisu = prepareSisuWorkoutPayload(reloaded);
  assert.equal(sisu.ok, false);
  const complete = await generateWorkoutSummary(
    "fs-complete-control",
    startedAt,
    endedAt,
    "Freestyle",
    {
      cancelled: false,
      freestyleFinalization: freestyleFinalization("fs-complete-control", startedAt, endedAt, 180),
    }
  );
  assert.equal(complete.evidence_incomplete, undefined);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

