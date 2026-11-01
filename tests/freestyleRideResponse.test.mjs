import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

import {
  FREESTYLE_RIDE_RESPONSE_SCHEMA_VERSION_V1,
  parseFreestyleRideResponse,
} from "../dist/contracts/freestyleRideResponse.js";
import { deriveFreestyleRideResponse } from "../dist/freestyleRideResponse.js";
import { buildOrdinaryBikeTelemetrySample } from "../dist/ordinaryWorkoutTelemetry.js";
import {
  storeOrdinaryBikeTelemetrySample,
  storeHrSample,
  storeWorkoutSummary,
  getWorkoutSummaryBySessionId,
  getAllWorkoutSummaries,
  resetWorkoutStorageForTests,
  flushOrdinaryBikeTelemetryWrites,
  getOrdinaryBikeTelemetrySamples,
  queueOrdinaryBikeTelemetrySample,
} from "../dist/workoutStorage.js";
import { buildSisuWorkoutPayload, prepareSisuWorkoutPayload } from "../dist/sisuSync.js";
import {
  generateWorkoutSummary,
  emitWorkoutSummary,
} from "../dist/workoutSummary.js";
import {
  startSession,
  getSession,
  clearSession,
  totalPausedDurationSec,
} from "../dist/sessionStore.js";
import {
  installStandaloneFreestyleWorkout,
  getWorkoutMetadata,
} from "../dist/workoutData.js";
import { FITNESS_STATE_STORAGE_KEY } from "../dist/fitnessState.js";
import { ATHLETE_PROFILE_STORAGE_KEY, migrateLegacyProfile } from "../dist/profile.js";
import { learnFromCompletedWorkout, listLearnedStarts } from "../dist/machines/learning/index.js";

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

function withAthleteStorage() {
  const athlete = migrateLegacyProfile(
    { age: 40, weight: 176, vo2: "" },
    "athlete-f2",
    "2026-11-01T12:00:00.000Z"
  );
  return memoryStorage({ [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(athlete) });
}

const BASE_TIME = Date.parse("2026-11-01T12:00:00.000Z");

function makeSample(sessionId, athleteId, activeSec, opts = {}) {
  const observedAtMs = BASE_TIME + activeSec * 1000;
  return buildOrdinaryBikeTelemetrySample({
    athleteId,
    sessionId,
    activeSec,
    observedAtMs,
    telemetryStale: opts.stale || false,
    telemetryReceivedAtMs: opts.unavailable ? null : observedAtMs,
    telemetrySnapshotAt: opts.unavailable ? null : `snap-${activeSec}`,
    watts: opts.unavailable ? { value: null, current: false }
      : { value: opts.watts ?? 100, current: !(opts.stale || false) },
    cadenceRpm: opts.unavailable ? { value: null, current: false }
      : { value: opts.cadence ?? 80, current: !(opts.stale || false) },
    observedResistance: opts.unavailable ? { value: null, current: false }
      : { value: opts.resistance ?? 5, current: !(opts.stale || false) },
    ...(opts.desiredResistance !== undefined ? { desiredResistance: opts.desiredResistance } : {}),
  });
}

function makeHrSample(sessionId, sec, hr) {
  return { session_id: sessionId, timestamp_sec: sec, hr };
}

function baseInput(overrides = {}) {
  return {
    athleteId: "athlete-f2",
    sessionId: "session-f2",
    startedAtMs: BASE_TIME,
    endedAtMs: BASE_TIME + 300_000,
    activeDurationSec: 300,
    pausedDurationSec: 0,
    hrSamples: [],
    bikeSamples: [],
    ...overrides,
  };
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

// ─── Complete 1 Hz work calculation ───
test("complete 1 Hz coverage produces exact joule sum and complete status", () => {
  const bikeSamples = [];
  for (let s = 0; s < 300; s++) {
    bikeSamples.push(makeSample("session-f2", "athlete-f2", s, { watts: 150 }));
  }
  const result = deriveFreestyleRideResponse(baseInput({ bikeSamples }));
  assert.ok(result);
  assert.equal(result.schemaVersion, FREESTYLE_RIDE_RESPONSE_SCHEMA_VERSION_V1);
  assert.equal(result.workload.workStatus, "complete");
  assert.equal(result.workload.observedWorkJoules, 150 * 300);
  assert.equal(result.workload.observedWorkKj, (150 * 300) / 1000);
  assert.ok(result.workload.powerCoverageRatio >= 0.95);
  assert.equal(result.workload.watts.mean, 150);
  assert.equal(result.workload.watts.median, 150);
  assert.equal(result.workload.watts.min, 150);
  assert.equal(result.workload.watts.max, 150);
  assert.equal(result.workload.watts.provenance, "measured_watts");
  assert.equal(result.evidence.bike.freshSampleCount, 300);
  assert.equal(result.evidence.bike.implicitMissingCount, 0);
  assert.equal(result.evidence.bike.freshRowCoverageRatio, 1);
});

// ─── 50% partial — no extrapolation ───
test("50% coverage is partial with no extrapolation", () => {
  const bikeSamples = [];
  for (let s = 0; s < 150; s++) {
    bikeSamples.push(makeSample("session-f2", "athlete-f2", s, { watts: 200 }));
  }
  const result = deriveFreestyleRideResponse(baseInput({ bikeSamples }));
  assert.ok(result);
  assert.equal(result.workload.workStatus, "partial");
  assert.equal(result.workload.observedWorkJoules, 200 * 150);
  assert.equal(result.workload.observedWorkKj, (200 * 150) / 1000);
  assert.ok(result.workload.powerCoverageRatio >= 0.49);
  assert.ok(result.workload.powerCoverageRatio <= 0.51);
  assert.equal(result.evidence.bike.implicitMissingCount, 150);
});

// ─── Fresh rows without watts defined ───
test("fresh rows without watts produce no work joules but still count for coverage", () => {
  const bikeSamples = [];
  for (let s = 0; s < 300; s++) {
    const sample = buildOrdinaryBikeTelemetrySample({
      athleteId: "athlete-f2",
      sessionId: "session-f2",
      activeSec: s,
      observedAtMs: BASE_TIME + s * 1000,
      telemetryStale: false,
      telemetryReceivedAtMs: BASE_TIME + s * 1000,
      telemetrySnapshotAt: `snap-${s}`,
      watts: { value: null, current: false },
      cadenceRpm: { value: 80, current: true },
      observedResistance: { value: 5, current: true },
    });
    bikeSamples.push(sample);
  }
  const result = deriveFreestyleRideResponse(baseInput({ bikeSamples }));
  assert.ok(result);
  assert.equal(result.workload.workStatus, "unavailable");
  assert.equal(result.workload.powerCoverageRatio, 0);
  assert.equal(result.workload.observedWorkJoules, undefined);
  assert.ok(result.workload.cadenceRpm);
  assert.equal(result.workload.cadenceRpm.sampleCount, 300);
});

// ─── Zero watts vs missing watts ───
test("zero watts is valid work; missing watts is not included", () => {
  const bikeSamples = [];
  for (let s = 0; s < 10; s++) {
    bikeSamples.push(makeSample("session-f2", "athlete-f2", s, { watts: 0 }));
  }
  const zeroResult = deriveFreestyleRideResponse(baseInput({
    activeDurationSec: 10,
    endedAtMs: BASE_TIME + 10_000,
    bikeSamples,
  }));
  assert.ok(zeroResult);
  assert.equal(zeroResult.workload.observedWorkJoules, 0);
  assert.equal(zeroResult.workload.observedWorkKj, 0);
  assert.equal(zeroResult.workload.workStatus, "complete");
  assert.equal(zeroResult.workload.watts.mean, 0);
  assert.equal(zeroResult.workload.watts.min, 0);
});

// ─── No bike data with valid HR ───
test("no bike data with valid HR produces unavailable workload and ble_chest_strap source", () => {
  const hrSamples = [];
  for (let s = 0; s < 300; s++) {
    hrSamples.push(makeHrSample("session-f2", s, 140));
  }
  const result = deriveFreestyleRideResponse(baseInput({ hrSamples }));
  assert.ok(result);
  assert.equal(result.workload.workStatus, "unavailable");
  assert.equal(result.evidence.hr.source, "ble_chest_strap");
  assert.equal(result.evidence.hr.validSampleCount, 300);
  assert.ok(result.evidence.hr.coverageRatio >= 0.99);
  assert.ok(result.evidence.hr.meanBpm > 0);
  assert.equal(result.evidence.hr.minBpm, 140);
  assert.equal(result.evidence.hr.maxBpm, 140);
  assert.equal(result.evidence.bike.rowCount, 0);
  assert.equal(result.evidence.bike.wattsProvenance, "unavailable");
});

// ─── Fresh / stale / unavailable classification ───
test("fresh stale unavailable samples are classified correctly", () => {
  const bikeSamples = [
    makeSample("session-f2", "athlete-f2", 0, { watts: 100 }),
    makeSample("session-f2", "athlete-f2", 1, { stale: true }),
    makeSample("session-f2", "athlete-f2", 2, { unavailable: true }),
  ];
  const result = deriveFreestyleRideResponse(baseInput({
    activeDurationSec: 10,
    endedAtMs: BASE_TIME + 10_000,
    bikeSamples,
  }));
  assert.ok(result);
  assert.equal(result.evidence.bike.freshSampleCount, 1);
  assert.equal(result.evidence.bike.staleSampleCount, 1);
  assert.equal(result.evidence.bike.unavailableSampleCount, 1);
  assert.equal(result.evidence.bike.rowCount, 3);
  assert.equal(result.evidence.bike.implicitMissingCount, 7);
});

// ─── Duplicate, out-of-order, and out-of-window ───
test("duplicate activeSec prefers fresh over stale; out-of-window is excluded", () => {
  const bikeSamples = [
    makeSample("session-f2", "athlete-f2", 5, { stale: true }),
    makeSample("session-f2", "athlete-f2", 5, { watts: 200 }),
    makeSample("session-f2", "athlete-f2", 300, { watts: 999 }),
    null,
    makeSample("session-f2", "athlete-f2", 3, { watts: 120 }),
  ].filter(Boolean);
  const result = deriveFreestyleRideResponse(baseInput({ bikeSamples }));
  assert.ok(result);
  // activeSec 300 is >= activeDurationSec (300) so excluded; only 3 and 5 remain
  assert.equal(result.evidence.bike.rowCount, 2);
  assert.equal(result.evidence.bike.freshSampleCount, 2);
  assert.equal(result.workload.watts.sampleCount, 2);
});

// ─── Pause timing ───
test("paused duration is reflected correctly in response timing", () => {
  const result = deriveFreestyleRideResponse(baseInput({
    activeDurationSec: 240,
    pausedDurationSec: 60,
    endedAtMs: BASE_TIME + 360_000,
  }));
  assert.ok(result);
  assert.equal(result.timing.activeDurationSec, 240);
  assert.equal(result.timing.pausedDurationSec, 60);
  assert.equal(result.timing.completedNaturally, true);
});

// ─── Mixed provenance ───
test("mixed watt provenance when both measured and calibrated appear", () => {
  const sample1 = buildOrdinaryBikeTelemetrySample({
    athleteId: "athlete-f2",
    sessionId: "session-f2",
    activeSec: 0,
    observedAtMs: BASE_TIME,
    telemetryStale: false,
    telemetryReceivedAtMs: BASE_TIME,
    telemetrySnapshotAt: "snap-0",
    watts: { value: 100, current: true },
    cadenceRpm: { value: 80, current: true },
    observedResistance: { value: 5, current: true },
  });
  // Manually craft a calibrated_watts sample by tweaking the parsed sample
  const sample2Raw = {
    schemaVersion: 1,
    athleteId: "athlete-f2",
    sessionId: "session-f2",
    activeSec: 1,
    observedAt: new Date(BASE_TIME + 1000).toISOString(),
    availability: "fresh",
    sourceSampleId: "snap-1",
    freshnessMs: 100,
    watts: { value: 110, source: "calibrated_watts", freshnessMs: 100 },
    cadenceRpm: { value: 82, source: "measured", freshnessMs: 100 },
    observedResistance: { value: 5, source: "observed", freshnessMs: 100 },
  };
  const result = deriveFreestyleRideResponse(baseInput({
    activeDurationSec: 10,
    endedAtMs: BASE_TIME + 10_000,
    bikeSamples: [sample1, sample2Raw],
  }));
  assert.ok(result);
  assert.equal(result.evidence.bike.wattsProvenance, "mixed");
  assert.equal(result.workload.watts.provenance, "mixed");
});

// ─── Percentiles (IQR) ───
test("percentile distribution is computed correctly", () => {
  const bikeSamples = [];
  const wattsValues = [50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
  for (let s = 0; s < wattsValues.length; s++) {
    bikeSamples.push(makeSample("session-f2", "athlete-f2", s, { watts: wattsValues[s] }));
  }
  const result = deriveFreestyleRideResponse(baseInput({
    activeDurationSec: 10,
    endedAtMs: BASE_TIME + 10_000,
    bikeSamples,
  }));
  assert.ok(result);
  assert.equal(result.workload.watts.min, 50);
  assert.equal(result.workload.watts.max, 500);
  const dist = result.workload.watts.distribution;
  assert.ok(dist.q1 <= dist.q3);
  assert.equal(dist.iqr, +(dist.q3 - dist.q1).toFixed(2));
});

// ─── Resistance changes + gaps (no forward-fill) ───
test("resistance distribution tracks level changes without forward-filling gaps", () => {
  const bikeSamples = [
    makeSample("session-f2", "athlete-f2", 0, { watts: 100, resistance: 5 }),
    makeSample("session-f2", "athlete-f2", 1, { watts: 100, resistance: 5 }),
    makeSample("session-f2", "athlete-f2", 2, { watts: 100, resistance: 5 }),
    makeSample("session-f2", "athlete-f2", 5, { watts: 100, resistance: 8 }),
    makeSample("session-f2", "athlete-f2", 6, { watts: 100, resistance: 8 }),
  ];
  const result = deriveFreestyleRideResponse(baseInput({
    activeDurationSec: 10,
    endedAtMs: BASE_TIME + 10_000,
    bikeSamples,
  }));
  assert.ok(result);
  const levels = result.workload.observedResistance.levelsUsed;
  assert.equal(levels.length, 2);
  const l5 = levels.find((l) => l.level === 5);
  const l8 = levels.find((l) => l.level === 8);
  assert.equal(l5.activeSeconds, 3);
  assert.equal(l8.activeSeconds, 2);
  // Fractions don't sum to 1 because of gaps (seconds 3,4 and 7-9 missing)
  const fractionSum = levels.reduce((s, l) => s + l.fraction, 0);
  assert.ok(fractionSum < 1);
});

// ─── No HR and partial HR ───
test("no HR produces unavailable source with zero coverage", () => {
  const result = deriveFreestyleRideResponse(baseInput());
  assert.ok(result);
  assert.equal(result.evidence.hr.source, "unavailable");
  assert.equal(result.evidence.hr.validSampleCount, 0);
  assert.equal(result.evidence.hr.coverageRatio, 0);
  assert.equal(result.evidence.hr.meanBpm, undefined);
});

test("partial HR reports correct coverage ratio", () => {
  const hrSamples = [];
  for (let s = 0; s < 150; s++) {
    hrSamples.push(makeHrSample("session-f2", s, 130 + (s % 20)));
  }
  const result = deriveFreestyleRideResponse(baseInput({ hrSamples }));
  assert.ok(result);
  assert.equal(result.evidence.hr.source, "ble_chest_strap");
  assert.equal(result.evidence.hr.validSampleCount, 150);
  assert.ok(result.evidence.hr.coverageRatio >= 0.49);
  assert.ok(result.evidence.hr.coverageRatio <= 0.51);
  assert.ok(result.evidence.hr.meanBpm > 0);
  assert.ok(result.evidence.hr.minBpm <= result.evidence.hr.maxBpm);
});

// ─── evidence_incomplete flag ───
test("evidenceIncomplete flag is propagated to f1EvidenceIncomplete", () => {
  const result = deriveFreestyleRideResponse(baseInput({ evidenceIncomplete: true }));
  assert.ok(result);
  assert.equal(result.evidence.f1EvidenceIncomplete, true);
});

test("evidenceIncomplete false or absent means no f1EvidenceIncomplete", () => {
  const result = deriveFreestyleRideResponse(baseInput());
  assert.ok(result);
  assert.equal(result.evidence.f1EvidenceIncomplete, undefined);
});

// ─── Parser rejects malformed ───
test("parser rejects missing schemaVersion", () => {
  assert.equal(parseFreestyleRideResponse(null), null);
  assert.equal(parseFreestyleRideResponse(undefined), null);
  assert.equal(parseFreestyleRideResponse({}), null);
  assert.equal(parseFreestyleRideResponse({ schemaVersion: 2 }), null);
});

test("parser rejects invalid identity", () => {
  const valid = deriveFreestyleRideResponse(baseInput());
  assert.ok(valid);
  const asJson = JSON.parse(JSON.stringify(valid));
  assert.ok(parseFreestyleRideResponse(asJson));
  assert.equal(parseFreestyleRideResponse({ ...asJson, athleteId: "" }), null);
  assert.equal(parseFreestyleRideResponse({ ...asJson, sessionId: "" }), null);
});

test("parser rejects invalid timing", () => {
  const valid = deriveFreestyleRideResponse(baseInput());
  const asJson = JSON.parse(JSON.stringify(valid));
  assert.equal(parseFreestyleRideResponse({
    ...asJson,
    timing: { ...asJson.timing, activeDurationSec: -1 },
  }), null);
  assert.equal(parseFreestyleRideResponse({
    ...asJson,
    timing: { ...asJson.timing, endedAt: asJson.timing.startedAt },
  }), null);
});

test("parser rejects inconsistent bike row counts", () => {
  const valid = deriveFreestyleRideResponse(baseInput());
  const asJson = JSON.parse(JSON.stringify(valid));
  assert.equal(parseFreestyleRideResponse({
    ...asJson,
    evidence: {
      ...asJson.evidence,
      bike: { ...asJson.evidence.bike, freshSampleCount: 999 },
    },
  }), null);
});

test("parser rejects ratio out of range", () => {
  const valid = deriveFreestyleRideResponse(baseInput());
  const asJson = JSON.parse(JSON.stringify(valid));
  assert.equal(parseFreestyleRideResponse({
    ...asJson,
    evidence: {
      ...asJson.evidence,
      hr: { ...asJson.evidence.hr, coverageRatio: 1.5 },
    },
  }), null);
});

test("parser roundtrip: derive then parse produces identical result", () => {
  const bikeSamples = [];
  for (let s = 0; s < 100; s++) {
    bikeSamples.push(makeSample("session-f2", "athlete-f2", s, { watts: 100 + s }));
  }
  const hrSamples = [];
  for (let s = 0; s < 100; s++) {
    hrSamples.push(makeHrSample("session-f2", s, 120 + (s % 30)));
  }
  const result = deriveFreestyleRideResponse(baseInput({
    activeDurationSec: 100,
    endedAtMs: BASE_TIME + 100_000,
    bikeSamples,
    hrSamples,
  }));
  assert.ok(result);
  const parsed = parseFreestyleRideResponse(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(parsed, result);
});

// ─── Write / Read / Reload through storage ───
test("freestyle_ride_response survives write/read/reload through IndexedDB", async () => {
  await resetWorkoutStorageForTests();
  const bikeSamples = [];
  for (let s = 0; s < 60; s++) {
    bikeSamples.push(makeSample("session-persist", "athlete-f2", s, { watts: 200 }));
  }
  const hrSamples = [];
  for (let s = 0; s < 60; s++) {
    hrSamples.push(makeHrSample("session-persist", s, 150));
  }
  const response = deriveFreestyleRideResponse({
    athleteId: "athlete-f2",
    sessionId: "session-persist",
    startedAtMs: BASE_TIME,
    endedAtMs: BASE_TIME + 60_000,
    activeDurationSec: 60,
    pausedDurationSec: 0,
    hrSamples,
    bikeSamples,
  });
  assert.ok(response);
  const summary = {
    external_session_id: "session-persist",
    athlete_id: "athlete-f2",
    app_version: "test",
    startedAt: new Date(BASE_TIME).toISOString(),
    endedAt: new Date(BASE_TIME + 60_000).toISOString(),
    category: "cardio",
    intent: "freestyle",
    duration_minutes: 1,
    primary_zone: 0,
    stress_profile: "unknown",
    zone_minutes: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Freestyle",
    open_ended_timing: {
      wall_clock_sec: 60,
      active_sec: 60,
      paused_sec: 0,
      valid_hr_sec: 60,
      unknown_hr_sec: 0,
    },
    freestyle_ride_response: response,
  };
  assert.equal(await storeWorkoutSummary(summary), true);
  const reloaded = await getWorkoutSummaryBySessionId("session-persist");
  assert.ok(reloaded);
  assert.ok(reloaded.freestyle_ride_response);
  assert.equal(reloaded.freestyle_ride_response.sessionId, "session-persist");
  assert.equal(reloaded.freestyle_ride_response.athleteId, "athlete-f2");
  assert.equal(reloaded.freestyle_ride_response.workload.workStatus, "complete");
  assert.deepEqual(reloaded.freestyle_ride_response.timing, response.timing);
  await resetWorkoutStorageForTests();
});

// ─── SISU strips freestyle_ride_response ───
test("buildSisuWorkoutPayload strips freestyle_ride_response", () => {
  const response = deriveFreestyleRideResponse(baseInput());
  const summary = {
    external_session_id: "session-f2",
    intent: "freestyle",
    freestyle_ride_response: response,
    open_ended_timing: { wall_clock_sec: 300, active_sec: 300, paused_sec: 0, valid_hr_sec: 0, unknown_hr_sec: 300 },
  };
  const payload = buildSisuWorkoutPayload(summary);
  assert.equal(payload.freestyle_ride_response, undefined);
  assert.equal(payload.open_ended_timing, undefined);
});

// ─── Save idempotent — already persisted returns existing ───
test("freestyle_ride_response is generated on summary and idempotent across reads", async () => {
  await resetWorkoutStorageForTests();
  const bikeSamples = [];
  for (let s = 0; s < 30; s++) {
    bikeSamples.push(makeSample("session-idem", "athlete-f2", s, { watts: 180 }));
  }
  const response = deriveFreestyleRideResponse({
    athleteId: "athlete-f2",
    sessionId: "session-idem",
    startedAtMs: BASE_TIME,
    endedAtMs: BASE_TIME + 30_000,
    activeDurationSec: 30,
    pausedDurationSec: 0,
    hrSamples: [],
    bikeSamples,
  });
  assert.ok(response);
  const summary = {
    external_session_id: "session-idem",
    athlete_id: "athlete-f2",
    app_version: "test",
    startedAt: new Date(BASE_TIME).toISOString(),
    endedAt: new Date(BASE_TIME + 30_000).toISOString(),
    category: "cardio",
    intent: "freestyle",
    duration_minutes: 1,
    primary_zone: 0,
    stress_profile: "unknown",
    zone_minutes: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Freestyle",
    freestyle_ride_response: response,
  };
  await storeWorkoutSummary(summary);
  const first = await getWorkoutSummaryBySessionId("session-idem");
  const second = await getWorkoutSummaryBySessionId("session-idem");
  assert.deepEqual(first.freestyle_ride_response, second.freestyle_ride_response);
  await resetWorkoutStorageForTests();
});

// ─── No fitness/learning mutation ───
test("freestyle response derivation does not mutate fitness state or machine learning", async () => {
  await resetWorkoutStorageForTests();
  const storage = withAthleteStorage();
  const fitnessRaw = '{"keep":"untouched-f2"}';
  storage.setItem(FITNESS_STATE_STORAGE_KEY, fitnessRaw);
  const bikeSamples = [];
  for (let s = 0; s < 60; s++) {
    bikeSamples.push(makeSample("session-no-learn", "athlete-f2", s, { watts: 150 }));
  }
  const response = deriveFreestyleRideResponse({
    athleteId: "athlete-f2",
    sessionId: "session-no-learn",
    startedAtMs: BASE_TIME,
    endedAtMs: BASE_TIME + 60_000,
    activeDurationSec: 60,
    pausedDurationSec: 0,
    hrSamples: [],
    bikeSamples,
  });
  assert.ok(response);
  const summary = {
    external_session_id: "session-no-learn",
    athlete_id: "athlete-f2",
    intent: "freestyle",
    startedAt: new Date(BASE_TIME).toISOString(),
    endedAt: new Date(BASE_TIME + 60_000).toISOString(),
    category: "cardio",
    duration_minutes: 1,
    primary_zone: 0,
    stress_profile: "unknown",
    zone_minutes: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Freestyle",
    open_ended_timing: { wall_clock_sec: 60, active_sec: 60, paused_sec: 0, valid_hr_sec: 0, unknown_hr_sec: 60 },
    freestyle_ride_response: response,
  };
  await storeWorkoutSummary(summary);
  await emitWorkoutSummary(summary);
  await learnFromCompletedWorkout(summary, storage);
  assert.equal(listLearnedStarts(storage).length, 0);
  assert.equal(storage.getItem(FITNESS_STATE_STORAGE_KEY), fitnessRaw);
  await resetWorkoutStorageForTests();
});

// ─── Cancelled ride sets completedNaturally false ───
test("cancelled ride sets completedNaturally to false", () => {
  const result = deriveFreestyleRideResponse(baseInput({ cancelled: true }));
  assert.ok(result);
  assert.equal(result.timing.completedNaturally, false);
});

// ─── Identity validation: null on invalid identity ───
test("returns null for empty athleteId or sessionId", () => {
  assert.equal(deriveFreestyleRideResponse(baseInput({ athleteId: "" })), null);
  assert.equal(deriveFreestyleRideResponse(baseInput({ sessionId: "" })), null);
});

test("returns null for invalid timestamps", () => {
  assert.equal(deriveFreestyleRideResponse(baseInput({ startedAtMs: NaN })), null);
  assert.equal(deriveFreestyleRideResponse(baseInput({ endedAtMs: BASE_TIME - 1 })), null);
  assert.equal(deriveFreestyleRideResponse(baseInput({ activeDurationSec: -1 })), null);
  assert.equal(deriveFreestyleRideResponse(baseInput({ activeDurationSec: 1.5 })), null);
});

// ─── HR samples: invalid hr<=0 excluded ───
test("hr samples with hr <= 0 are excluded from valid count", () => {
  const hrSamples = [
    makeHrSample("session-f2", 0, 0),
    makeHrSample("session-f2", 1, -10),
    makeHrSample("session-f2", 2, 140),
    makeHrSample("session-f2", 3, 142),
  ];
  const result = deriveFreestyleRideResponse(baseInput({
    activeDurationSec: 10,
    endedAtMs: BASE_TIME + 10_000,
    hrSamples,
  }));
  assert.ok(result);
  assert.equal(result.evidence.hr.validSampleCount, 2);
  assert.equal(result.evidence.hr.source, "ble_chest_strap");
  assert.ok(result.evidence.hr.meanBpm >= 140 && result.evidence.hr.meanBpm <= 142);
});

// ─── Session ID filtering ───
test("samples from other sessions are excluded", () => {
  const bikeSamples = [
    makeSample("session-f2", "athlete-f2", 0, { watts: 100 }),
    makeSample("other-session", "athlete-f2", 1, { watts: 999 }),
  ];
  const hrSamples = [
    makeHrSample("session-f2", 0, 140),
    makeHrSample("other-session", 1, 200),
  ];
  const result = deriveFreestyleRideResponse(baseInput({
    activeDurationSec: 10,
    endedAtMs: BASE_TIME + 10_000,
    bikeSamples,
    hrSamples,
  }));
  assert.ok(result);
  assert.equal(result.evidence.bike.freshSampleCount, 1);
  assert.equal(result.evidence.hr.validSampleCount, 1);
  assert.equal(result.workload.watts.mean, 100);
});

// ─── Athlete ID filtering on bike samples ───
test("bike samples from other athletes are excluded", () => {
  const bikeSamples = [
    makeSample("session-f2", "athlete-f2", 0, { watts: 100 }),
    makeSample("session-f2", "other-athlete", 1, { watts: 999 }),
  ];
  const result = deriveFreestyleRideResponse(baseInput({
    activeDurationSec: 10,
    endedAtMs: BASE_TIME + 10_000,
    bikeSamples,
  }));
  assert.ok(result);
  assert.equal(result.evidence.bike.freshSampleCount, 1);
});

// ─── Integration: generateWorkoutSummary attaches freestyle_ride_response ───
test("generateWorkoutSummary attaches freestyle_ride_response for freestyle with bike telemetry", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  globalThis.window = { getWorkoutMetadata: () => getWorkoutMetadata() };
  const startedAt = BASE_TIME;
  const endedAt = BASE_TIME + 60_000;
  startSession(
    "Freestyle", startedAt, "fs-gen-f2", "bike", storage,
    null, undefined, undefined, "manual_freestyle_ride"
  );
  for (let s = 0; s < 60; s++) {
    const sample = makeSample("fs-gen-f2", "athlete-f2", s, { watts: 100 + s });
    if (sample) await storeOrdinaryBikeTelemetrySample(sample);
  }
  for (let s = 0; s < 60; s++) {
    await storeHrSample("fs-gen-f2", s, 130);
  }
  const summary = await generateWorkoutSummary("fs-gen-f2", startedAt, endedAt, "Freestyle", {
    cancelled: false,
    freestyleFinalization: freestyleFinalization("fs-gen-f2", startedAt, endedAt, 60),
  });
  assert.ok(summary.freestyle_ride_response);
  assert.equal(summary.freestyle_ride_response.sessionId, "fs-gen-f2");
  assert.equal(summary.freestyle_ride_response.athleteId, "athlete-f2");
  assert.equal(summary.freestyle_ride_response.workload.workStatus, "complete");
  assert.ok(summary.freestyle_ride_response.workload.observedWorkKj > 0);
  assert.ok(summary.freestyle_ride_response.evidence.hr.source === "ble_chest_strap");
  assert.equal(summary.workout_response, undefined);
  assert.equal(summary.resolved_prescription, undefined);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

// ─── Evidence incomplete through generateWorkoutSummary ───
test("evidence_incomplete is propagated through generateWorkoutSummary to freestyle_ride_response", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  globalThis.window = { getWorkoutMetadata: () => getWorkoutMetadata() };
  const startedAt = BASE_TIME;
  const endedAt = BASE_TIME + 60_000;
  startSession(
    "Freestyle", startedAt, "fs-incomplete-f2", "bike", storage,
    null, undefined, undefined, "manual_freestyle_ride"
  );
  const summary = await generateWorkoutSummary("fs-incomplete-f2", startedAt, endedAt, "Freestyle", {
    cancelled: false,
    freestyleFinalization: {
      ...freestyleFinalization("fs-incomplete-f2", startedAt, endedAt, 60),
      evidenceIncomplete: true,
    },
  });
  assert.ok(summary.freestyle_ride_response);
  assert.equal(summary.freestyle_ride_response.evidence.f1EvidenceIncomplete, true);
  assert.equal(summary.evidence_incomplete, true);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

// ─── Parser rejects inconsistent kJ/J ───
test("parser rejects inconsistent observedWorkKj and observedWorkJoules", () => {
  const valid = deriveFreestyleRideResponse(baseInput({
    bikeSamples: Array.from({ length: 300 }, (_, s) =>
      makeSample("session-f2", "athlete-f2", s, { watts: 100 })
    ),
  }));
  assert.ok(valid);
  const asJson = JSON.parse(JSON.stringify(valid));
  // Tamper with kJ
  asJson.workload.observedWorkKj = 999;
  assert.equal(parseFreestyleRideResponse(asJson), null);
});

// ─── Parser validates IQR consistency ───
test("parser rejects inconsistent IQR", () => {
  const valid = deriveFreestyleRideResponse(baseInput({
    bikeSamples: Array.from({ length: 100 }, (_, s) =>
      makeSample("session-f2", "athlete-f2", s, { watts: 100 + s })
    ),
    activeDurationSec: 100,
    endedAtMs: BASE_TIME + 100_000,
  }));
  assert.ok(valid);
  const asJson = JSON.parse(JSON.stringify(valid));
  asJson.workload.watts.distribution.iqr = 999;
  assert.equal(parseFreestyleRideResponse(asJson), null);
});

// ─── Cadence 0 rpm is valid ───
test("cadence 0 rpm is valid and included in summary", () => {
  const bikeSamples = [];
  for (let s = 0; s < 10; s++) {
    bikeSamples.push(makeSample("session-f2", "athlete-f2", s, { watts: 100, cadence: 0 }));
  }
  const result = deriveFreestyleRideResponse(baseInput({
    activeDurationSec: 10,
    endedAtMs: BASE_TIME + 10_000,
    bikeSamples,
  }));
  assert.ok(result);
  assert.ok(result.workload.cadenceRpm);
  assert.equal(result.workload.cadenceRpm.min, 0);
  assert.equal(result.workload.cadenceRpm.mean, 0);
});

// ─── ReconstructWorkoutRow drops invalid freestyle_ride_response ───
test("reconstructWorkoutRow drops freestyle_ride_response with mismatched identity", async () => {
  await resetWorkoutStorageForTests();
  const response = deriveFreestyleRideResponse(baseInput());
  const summary = {
    external_session_id: "session-f2",
    athlete_id: "athlete-f2",
    startedAt: new Date(BASE_TIME).toISOString(),
    endedAt: new Date(BASE_TIME + 300_000).toISOString(),
    category: "cardio",
    intent: "freestyle",
    duration_minutes: 5,
    primary_zone: 0,
    stress_profile: "unknown",
    zone_minutes: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Freestyle",
    freestyle_ride_response: {
      ...response,
      athleteId: "wrong-athlete",
    },
  };
  await storeWorkoutSummary(summary);
  const reloaded = await getWorkoutSummaryBySessionId("session-f2");
  assert.equal(reloaded.freestyle_ride_response, undefined);
  await resetWorkoutStorageForTests();
});
