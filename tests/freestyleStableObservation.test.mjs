import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

import {
  FREESTYLE_STABLE_OBSERVATION_POLICY,
  parseFreestyleStableObservation,
} from "../dist/contracts/freestyleStableObservation.js";
import { deriveFreestyleStableObservation } from "../dist/freestyleStableObservation.js";
import { buildOrdinaryBikeTelemetrySample } from "../dist/ordinaryWorkoutTelemetry.js";
import {
  storeOrdinaryBikeTelemetrySample,
  storeHrSample,
  storeWorkoutSummary,
  getWorkoutSummaryBySessionId,
  resetWorkoutStorageForTests,
} from "../dist/workoutStorage.js";
import { buildSisuWorkoutPayload } from "../dist/sisuSync.js";
import {
  generateWorkoutSummary,
  emitWorkoutSummary,
  attachFreestyleDerivedAnalytics,
} from "../dist/workoutSummary.js";
import { deriveFreestyleRideResponse } from "../dist/freestyleRideResponse.js";
import {
  buildFreestyleAnalyticsHtml,
  escapeHtml,
} from "../dist/freestyleRideAnalyticsView.js";
import { startSession } from "../dist/sessionStore.js";
import { installStandaloneFreestyleWorkout, getWorkoutMetadata } from "../dist/workoutData.js";
import { FITNESS_STATE_STORAGE_KEY } from "../dist/fitnessState.js";
import { ATHLETE_PROFILE_STORAGE_KEY, migrateLegacyProfile } from "../dist/profile.js";
import { learnFromCompletedWorkout, listLearnedStarts } from "../dist/machines/learning/index.js";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const ATHLETE = "athlete-f3";
const BASE_TIME = Date.parse("2026-11-01T12:00:00.000Z");
const POLICY = FREESTYLE_STABLE_OBSERVATION_POLICY;

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function withAthleteStorage() {
  const athlete = migrateLegacyProfile({ age: 40, weight: 176, vo2: "" }, ATHLETE, "2026-11-01T12:00:00.000Z");
  return memoryStorage({ [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(athlete) });
}

function makeSample(sessionId, activeSec, opts = {}) {
  const observedAtMs = opts.observedAtMs ?? BASE_TIME + activeSec * 1000;
  const unavailable = opts.unavailable === true;
  const stale = opts.stale === true;
  return buildOrdinaryBikeTelemetrySample({
    athleteId: opts.athleteId ?? ATHLETE,
    sessionId,
    activeSec,
    observedAtMs,
    telemetryStale: stale,
    telemetryReceivedAtMs: unavailable ? null : observedAtMs,
    telemetrySnapshotAt: unavailable ? null : `snap-${activeSec}-${opts.snap ?? "a"}`,
    watts: unavailable ? { value: null, current: false }
      : { value: opts.watts === null ? null : (opts.watts ?? 150), current: !stale },
    cadenceRpm: unavailable ? { value: null, current: false }
      : { value: opts.cadence === null ? null : (opts.cadence ?? 80), current: !stale },
    observedResistance: unavailable ? { value: null, current: false }
      : { value: opts.resistance === null ? null : (opts.resistance ?? 5), current: !stale },
    ...(opts.desiredResistance !== undefined ? { desiredResistance: opts.desiredResistance } : {}),
  });
}

function makeHr(sessionId, sec, hr) {
  return { session_id: sessionId, timestamp_sec: sec, hr };
}

function fillRide(sessionId, count, map = {}) {
  const bikeSamples = [];
  const hrSamples = [];
  for (let s = 0; s < count; s++) {
    const opts = typeof map === "function" ? map(s) : {};
    if (opts.skip) continue;
    const sample = makeSample(sessionId, s, opts);
    if (!sample) continue;
    if (opts.wattSource && sample.watts) sample.watts.source = opts.wattSource;
    if (opts.dropWatts) delete sample.watts;
    bikeSamples.push(sample);
    if (opts.hr !== undefined && opts.hr !== null) hrSamples.push(makeHr(sessionId, s, opts.hr));
    else if (map.hr !== false && typeof map !== "function") hrSamples.push(makeHr(sessionId, s, 140));
  }
  if (typeof map === "function") {
    return { bikeSamples, hrSamples };
  }
  if (map.hr === false) return { bikeSamples, hrSamples: [] };
  return { bikeSamples, hrSamples };
}

function baseInput(sessionId, count, overrides = {}) {
  return {
    athleteId: ATHLETE,
    sessionId,
    startedAtMs: BASE_TIME,
    endedAtMs: BASE_TIME + count * 1000,
    activeDurationSec: count,
    pausedDurationSec: 0,
    hrSamples: [],
    bikeSamples: [],
    ...overrides,
  };
}

function stableRide(sessionId, count = 180, map) {
  const filled = fillRide(sessionId, count, map ?? ((s) => ({ hr: 140 })));
  return deriveFreestyleStableObservation(baseInput(sessionId, count, filled));
}

test("long constant resistance with stable watts cadence and HR co-observes", () => {
  const result = stableRide("s-stable");
  assert.ok(result);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.policy.policyId, POLICY.policyId);
  assert.equal(result.analysisStatus, "observed");
  assert.equal(result.candidateWindowCount, 1);
  assert.equal(result.mechanicallyQualifiedCount, 1);
  assert.equal(result.hrCoObservedCount, 1);
  const window = result.windows[0];
  assert.equal(window.startActiveSec, 0);
  assert.equal(window.endActiveSec, 180);
  assert.equal(window.durationSec, 180);
  assert.equal(window.observedResistanceLevel, 5);
  assert.equal(window.qualification, "hr_co_observed");
  assert.equal(window.jointHrPowerSeconds, 180);
  assert.equal(window.freshPowerCoverageRatio, 1);
  assert.equal(result.scientificAuthority.eligibleForCalibration, false);
  assert.equal(result.scientificAuthority.eligibleForPrescription, false);
  assert.equal(result.scientificAuthority.interpretation, "descriptive_observation_only");
  assert.ok(parseFreestyleStableObservation(JSON.parse(JSON.stringify(result))));
});

test("constant resistance with unstable watts remains a diagnostic candidate", () => {
  const result = stableRide("s-unstable-w", 180, (s) => ({ watts: s % 2 === 0 ? 50 : 250, hr: 140 }));
  assert.equal(result.windows[0].qualification, "candidate");
  assert.ok(result.windows[0].reasons.includes("workload_unstable"));
  assert.equal(result.analysisStatus, "diagnostic_only");
});

test("constant watts with changing observed resistance splits windows", () => {
  const result = stableRide("s-res-change", 180, (s) => ({
    watts: 150,
    resistance: s < 90 ? 5 : 8,
    hr: 140,
  }));
  assert.equal(result.candidateWindowCount, 2);
  assert.equal(result.windows[0].observedResistanceLevel, 5);
  assert.equal(result.windows[1].observedResistanceLevel, 8);
  assert.equal(result.windows[0].durationSec, 90);
  assert.equal(result.windows[1].durationSec, 90);
  assert.ok(result.windows.every((window) => window.reasons.includes("insufficient_duration")));
});

test("resistance changes split candidate windows and ignore desiredResistance", () => {
  const result = stableRide("s-desired", 200, (s) => ({
    watts: 150,
    resistance: 5,
    desiredResistance: s < 100 ? 5 : 12,
    hr: 140,
  }));
  assert.equal(result.candidateWindowCount, 1);
  assert.equal(result.windows[0].observedResistanceLevel, 5);
});

test("stale and unavailable observations split windows", () => {
  const result = stableRide("s-stale", 180, (s) => ({
    watts: 150,
    hr: 140,
    stale: s === 80,
    unavailable: s === 81,
  }));
  assert.ok(result.candidateWindowCount >= 2);
  assert.equal(result.windows.some((window) => window.endActiveSec <= 80), true);
});

test("explicit missing-second gaps split windows", () => {
  const result = stableRide("s-gap", 180, (s) => (s >= 60 && s < 70 ? { skip: true } : { hr: 140 }));
  assert.equal(result.candidateWindowCount, 2);
  assert.equal(result.windows[0].endActiveSec, 60);
  assert.equal(result.windows[1].startActiveSec, 70);
});

test("paused sessions split on wall-clock discontinuity", () => {
  const sessionId = "s-pause";
  const bikeSamples = [];
  const hrSamples = [];
  for (let s = 0; s < 180; s++) {
    const observedAtMs = s < 90 ? BASE_TIME + s * 1000 : BASE_TIME + 3_600_000 + s * 1000;
    bikeSamples.push(makeSample(sessionId, s, { observedAtMs }));
    hrSamples.push(makeHr(sessionId, s, 140));
  }
  const result = deriveFreestyleStableObservation(baseInput(sessionId, 180, {
    endedAtMs: BASE_TIME + 3_600_000 + 180_000,
    pausedDurationSec: 3600,
    bikeSamples,
    hrSamples,
  }));
  assert.ok(result.candidateWindowCount >= 2);
  assert.ok(result.windows.every((window) => window.qualification === "candidate"));
});

test("overnight suspension splits windows when wall time advances", () => {
  const sessionId = "s-overnight";
  const bikeSamples = [];
  for (let s = 0; s < 180; s++) {
    const observedAtMs = s < 100 ? BASE_TIME + s * 1000 : BASE_TIME + 43_200_000 + s * 1000;
    bikeSamples.push(makeSample(sessionId, s, { observedAtMs }));
  }
  const result = deriveFreestyleStableObservation(baseInput(sessionId, 180, {
    endedAtMs: BASE_TIME + 43_200_000 + 180_000,
    pausedDurationSec: 43200,
    bikeSamples,
    hrSamples: [],
  }));
  assert.ok(result.candidateWindowCount >= 2);
});

test("duplicate active seconds prefer fresh and do not double-count", () => {
  const sessionId = "s-dup";
  const bikeSamples = [
    makeSample(sessionId, 0, { stale: true, watts: 10 }),
    makeSample(sessionId, 0, { watts: 150, snap: "b" }),
  ];
  for (let s = 1; s < 180; s++) bikeSamples.push(makeSample(sessionId, s, { watts: 150 }));
  const hrSamples = Array.from({ length: 180 }, (_, s) => makeHr(sessionId, s, 140));
  const result = deriveFreestyleStableObservation(baseInput(sessionId, 180, { bikeSamples, hrSamples }));
  assert.equal(result.windows[0].qualifyingObservedSeconds, 180);
  assert.equal(result.windows[0].powerMedianWatts, 150);
});

test("out-of-order observations are ordered before segmentation", () => {
  const sessionId = "s-ooo";
  const bikeSamples = [];
  for (let s = 90; s < 180; s++) bikeSamples.push(makeSample(sessionId, s));
  for (let s = 0; s < 90; s++) bikeSamples.push(makeSample(sessionId, s));
  const hrSamples = Array.from({ length: 180 }, (_, s) => makeHr(sessionId, s, 140));
  const result = deriveFreestyleStableObservation(baseInput(sessionId, 180, { bikeSamples, hrSamples }));
  assert.equal(result.candidateWindowCount, 1);
  assert.equal(result.windows[0].startActiveSec, 0);
  assert.equal(result.windows[0].endActiveSec, 180);
});

test("mixed watt provenance splits rather than merging incompatible sources", () => {
  const result = stableRide("s-mixed", 360, (s) => ({
    wattSource: s < 180 ? "measured_watts" : "calibrated_watts",
    hr: 140,
  }));
  assert.equal(result.candidateWindowCount, 2);
  assert.equal(result.windows[0].wattsProvenance, "measured_watts");
  assert.equal(result.windows[1].wattsProvenance, "calibrated_watts");
  assert.equal(result.windows[0].qualification, "hr_co_observed");
  assert.equal(result.windows[1].qualification, "hr_co_observed");
});

test("no power data remains power_unavailable", () => {
  const result = stableRide("s-nopower", 180, (s) => ({ dropWatts: true, cadence: 80, hr: 140 }));
  assert.equal(result.windows[0].qualification, "candidate");
  assert.ok(result.windows[0].reasons.includes("power_unavailable"));
  assert.equal(result.windows[0].powerMedianWatts, undefined);
});

test("zero watts with zero cadence is not exercise-load evidence", () => {
  const result = stableRide("s-zero", 180, (s) => ({ watts: 0, cadence: 0, hr: 140 }));
  assert.equal(result.windows[0].qualification, "candidate");
  assert.ok(result.windows[0].reasons.includes("non_pedaling_zero_load"));
  assert.ok(result.windows[0].reasons.includes("coasting"));
});

test("no HR measurements can still be mechanically qualified", () => {
  const result = stableRide("s-nohr", 180, (s) => ({ watts: 150, cadence: 80 }));
  assert.equal(result.windows[0].qualification, "mechanically_qualified");
  assert.ok(result.windows[0].reasons.includes("insufficient_hr_coverage"));
  assert.equal(result.hrCoObservedCount, 0);
  assert.equal(result.mechanicallyQualifiedCount, 1);
});

test("partial HR coverage is mechanically qualified but not co-observed", () => {
  const result = stableRide("s-parthr", 180, (s) => ({
    watts: 150,
    cadence: 80,
    hr: s < 90 ? 140 : null,
  }));
  assert.equal(result.windows[0].qualification, "mechanically_qualified");
  assert.ok(result.windows[0].reasons.includes("insufficient_joint_hr_power_coverage"));
  assert.equal(result.windows[0].jointHrPowerSeconds, 90);
});

test("HR and power present on disjoint seconds are not co-observed", () => {
  const result = stableRide("s-disjoint", 180, (s) => ({
    watts: s % 2 === 0 ? 150 : null,
    dropWatts: s % 2 !== 0,
    cadence: 80,
    hr: s % 2 === 1 ? 140 : null,
  }));
  assert.equal(result.windows[0].jointHrPowerSeconds, 0);
  assert.equal(result.windows[0].powerOnlyObservedSeconds, 90);
  assert.equal(result.windows[0].hrOnlyObservedSeconds, 90);
  assert.notEqual(result.windows[0].qualification, "hr_co_observed");
});

test("brief HR spikes remain unmodified and do not prevent co-observation", () => {
  const result = stableRide("s-spike", 180, (s) => ({
    watts: 150,
    cadence: 80,
    hr: s === 90 ? 220 : 140,
  }));
  assert.equal(result.windows[0].qualification, "hr_co_observed");
  assert.equal(result.windows[0].hrMedianBpm, 140);
  assert.equal(result.windows[0].jointHrPowerSeconds, 180);
  assert.equal(result.windows[0].hrMadBpm, 0);
  assert.equal(result.scientificAuthority.hrArtifactFiltering, "none");
});

test("insufficient-duration windows stay candidates", () => {
  const result = stableRide("s-short", 60, (s) => ({ hr: 140 }));
  assert.equal(result.windows[0].durationSec, 60);
  assert.ok(result.windows[0].reasons.includes("insufficient_duration"));
  assert.equal(result.windows[0].qualification, "candidate");
});

test("duration boundary 179 fails and 180 qualifies", () => {
  const fail = stableRide("s-179", 179, (s) => ({ hr: 140 }));
  const pass = stableRide("s-180", 180, (s) => ({ hr: 140 }));
  assert.ok(fail.windows[0].reasons.includes("insufficient_duration"));
  assert.equal(pass.windows[0].qualification, "hr_co_observed");
});

test("fresh power coverage 0.95 qualifies and just below does not", () => {
  const qualify = stableRide("s-cov-pass", 180, (s) => ({
    dropWatts: s < 9,
    cadence: 80,
    hr: 140,
  }));
  const reject = stableRide("s-cov-fail", 180, (s) => ({
    dropWatts: s < 10,
    cadence: 80,
    hr: 140,
  }));
  assert.equal(qualify.windows[0].freshPowerCoverageRatio, 0.95);
  assert.notEqual(qualify.windows[0].qualification, "candidate");
  assert.ok(reject.windows[0].reasons.includes("insufficient_power_coverage"));
});

test("F1 evidence_incomplete keeps surviving windows diagnostic-only", () => {
  const filled = fillRide("s-incomplete", 180, (s) => ({ hr: 140 }));
  const result = deriveFreestyleStableObservation(baseInput("s-incomplete", 180, {
    ...filled,
    evidenceIncomplete: true,
  }));
  assert.equal(result.f1EvidenceIncomplete, true);
  assert.equal(result.analysisStatus, "diagnostic_only");
  assert.equal(result.mechanicallyQualifiedCount, 0);
  assert.ok(result.windows[0].reasons.includes("f1_evidence_incomplete"));
  assert.equal(result.windows[0].qualification, "candidate");
});

test("wrong athlete and wrong session observations are excluded", () => {
  const sessionId = "s-owner";
  const bikeSamples = [
    ...Array.from({ length: 180 }, (_, s) => makeSample("other-session", s)),
    ...Array.from({ length: 180 }, (_, s) => makeSample(sessionId, s, { athleteId: "other-athlete" })),
  ];
  const result = deriveFreestyleStableObservation(baseInput(sessionId, 180, {
    bikeSamples,
    hrSamples: [makeHr("other-session", 0, 140)],
  }));
  assert.equal(result.candidateWindowCount, 0);
  assert.equal(result.analysisStatus, "unavailable");
});

test("parser rejects malformed window bounds and contradictory counts", () => {
  const valid = stableRide("s-parse", 180, (s) => ({ hr: 140 }));
  const asJson = JSON.parse(JSON.stringify(valid));
  assert.ok(parseFreestyleStableObservation(asJson));
  assert.equal(parseFreestyleStableObservation(null), null);
  assert.equal(parseFreestyleStableObservation({ ...asJson, schemaVersion: 2 }), null);
  const badBounds = JSON.parse(JSON.stringify(asJson));
  badBounds.windows[0].endActiveSec = badBounds.windows[0].startActiveSec;
  badBounds.windows[0].durationSec = 0;
  assert.equal(parseFreestyleStableObservation(badBounds), null);
  const badCount = JSON.parse(JSON.stringify(asJson));
  badCount.candidateWindowCount = 9;
  assert.equal(parseFreestyleStableObservation(badCount), null);
  const badJoint = JSON.parse(JSON.stringify(asJson));
  badJoint.windows[0].jointHrPowerSeconds = 10;
  assert.equal(parseFreestyleStableObservation(badJoint), null);
  const badStatus = JSON.parse(JSON.stringify(asJson));
  badStatus.scientificAuthority.eligibleForCalibration = true;
  assert.equal(parseFreestyleStableObservation(badStatus), null);
});

test("JSON and IndexedDB round-trip retain the entire F3 record", async () => {
  await resetWorkoutStorageForTests();
  const result = stableRide("s-persist", 180, (s) => ({ hr: 140 }));
  const parsed = parseFreestyleStableObservation(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(parsed, result);
  await storeWorkoutSummary({
    external_session_id: "s-persist",
    athlete_id: ATHLETE,
    app_version: "test",
    startedAt: result.timing.startedAt,
    endedAt: result.timing.endedAt,
    category: "cardio",
    intent: "freestyle",
    duration_minutes: 3,
    primary_zone: 0,
    stress_profile: "unknown",
    zone_minutes: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Freestyle",
    freestyle_stable_observation: result,
  });
  const reloaded = await getWorkoutSummaryBySessionId("s-persist");
  assert.deepEqual(reloaded.freestyle_stable_observation, result);
  await resetWorkoutStorageForTests();
});

test("save retry of frozen evidence is idempotent and recovery does not invent F3", async () => {
  await resetWorkoutStorageForTests();
  const first = stableRide("s-retry", 180, (s) => ({ hr: 140 }));
  const second = stableRide("s-retry", 180, (s) => ({ hr: 140 }));
  assert.deepEqual(first, second);
  await storeWorkoutSummary({
    external_session_id: "s-retry",
    athlete_id: ATHLETE,
    startedAt: first.timing.startedAt,
    endedAt: first.timing.endedAt,
    category: "cardio",
    intent: "freestyle",
    duration_minutes: 3,
    primary_zone: 0,
    stress_profile: "unknown",
    zone_minutes: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Freestyle",
  });
  const historical = await getWorkoutSummaryBySessionId("s-retry");
  assert.equal(historical.freestyle_stable_observation, undefined);
  await resetWorkoutStorageForTests();
});

test("SISU payload strips freestyle_stable_observation", () => {
  const result = stableRide("s-sisu", 180, (s) => ({ hr: 140 }));
  const payload = buildSisuWorkoutPayload({
    external_session_id: "s-sisu",
    intent: "freestyle",
    freestyle_stable_observation: result,
    evidence_incomplete: true,
  });
  assert.equal(payload.freestyle_stable_observation, undefined);
});

test("F3 derivation does not mutate fitness state or learned starts", async () => {
  await resetWorkoutStorageForTests();
  const storage = withAthleteStorage();
  const fitnessRaw = '{"keep":"untouched-f3"}';
  storage.setItem(FITNESS_STATE_STORAGE_KEY, fitnessRaw);
  const result = stableRide("s-nolearn", 180, (s) => ({ hr: 140 }));
  const summary = {
    external_session_id: "s-nolearn",
    athlete_id: ATHLETE,
    intent: "freestyle",
    startedAt: result.timing.startedAt,
    endedAt: result.timing.endedAt,
    category: "cardio",
    duration_minutes: 3,
    primary_zone: 0,
    stress_profile: "unknown",
    zone_minutes: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Freestyle",
    open_ended_timing: { wall_clock_sec: 180, active_sec: 180, paused_sec: 0, valid_hr_sec: 180, unknown_hr_sec: 0 },
    freestyle_stable_observation: result,
  };
  await storeWorkoutSummary(summary);
  await emitWorkoutSummary(summary);
  await learnFromCompletedWorkout(summary, storage);
  assert.equal(listLearnedStarts(storage).length, 0);
  assert.equal(storage.getItem(FITNESS_STATE_STORAGE_KEY), fitnessRaw);
  await resetWorkoutStorageForTests();
});

test("F3 modules do not dispatch Bike Bridge resistance commands", async () => {
  const engine = await readFile(new URL("../src/freestyleStableObservation.ts", import.meta.url), "utf8");
  const contract = await readFile(new URL("../src/contracts/freestyleStableObservation.ts", import.meta.url), "utf8");
  for (const source of [engine, contract]) {
    assert.doesNotMatch(source, /scheduleSend|bikeBridge|canCommand|commandedResistance|desiredResistance/);
  }
});

test("generateWorkoutSummary attaches F3 sidecar without workout_response", async () => {
  await resetWorkoutStorageForTests();
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const storage = withAthleteStorage();
  globalThis.localStorage = storage;
  installStandaloneFreestyleWorkout();
  globalThis.window = { getWorkoutMetadata: () => getWorkoutMetadata() };
  const startedAt = BASE_TIME;
  const endedAt = BASE_TIME + 180_000;
  startSession("Freestyle", startedAt, "fs-gen-f3", "bike", storage, null, undefined, undefined, "manual_freestyle_ride");
  for (let s = 0; s < 180; s++) {
    await storeOrdinaryBikeTelemetrySample(makeSample("fs-gen-f3", s));
    await storeHrSample("fs-gen-f3", s, 140);
  }
  const summary = await generateWorkoutSummary("fs-gen-f3", startedAt, endedAt, "Freestyle", {
    cancelled: false,
    freestyleFinalization: {
      schemaVersion: 1,
      selector: "Freestyle",
      sessionId: "fs-gen-f3",
      startedAtMs: startedAt,
      endedAtMs: endedAt,
      activeDurationSec: 180,
      pausedDurationSec: 0,
      status: "finalizing",
    },
  });
  assert.ok(summary.freestyle_stable_observation);
  assert.equal(summary.freestyle_stable_observation.sessionId, "fs-gen-f3");
  assert.equal(summary.freestyle_stable_observation.windows[0].qualification, "hr_co_observed");
  assert.equal(summary.workout_response, undefined);
  assert.equal(summary.resolved_prescription, undefined);
  await resetWorkoutStorageForTests();
  globalThis.window = previousWindow;
  globalThis.localStorage = previousStorage;
});

test("malformed F3 sidecar is dropped without deleting the workout", async () => {
  await resetWorkoutStorageForTests();
  await storeWorkoutSummary({
    external_session_id: "s-drop-f3",
    athlete_id: ATHLETE,
    startedAt: new Date(BASE_TIME).toISOString(),
    endedAt: new Date(BASE_TIME + 180_000).toISOString(),
    category: "cardio",
    intent: "freestyle",
    duration_minutes: 3,
    primary_zone: 0,
    stress_profile: "unknown",
    zone_minutes: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Freestyle",
    freestyle_stable_observation: { schemaVersion: 1, athleteId: "wrong" },
  });
  const reloaded = await getWorkoutSummaryBySessionId("s-drop-f3");
  assert.equal(reloaded.external_session_id, "s-drop-f3");
  assert.equal(reloaded.freestyle_stable_observation, undefined);
  await resetWorkoutStorageForTests();
});

test("returns null for invalid identity or timestamps", () => {
  assert.equal(deriveFreestyleStableObservation(baseInput("", 180)), null);
  assert.equal(deriveFreestyleStableObservation(baseInput("s-bad", 180, {
    startedAtMs: BASE_TIME,
    endedAtMs: BASE_TIME,
  })), null);
});

test("repeated derivation of the same dense window is identical", () => {
  const first = stableRide("s-ident", 180, (s) => ({ hr: 140 }));
  const second = stableRide("s-ident", 180, (s) => ({ hr: 140 }));
  assert.deepEqual(first, second);
  assert.ok(parseFreestyleStableObservation(JSON.parse(JSON.stringify(first))));
});

test("3-hour dense window completes without pathological pairing", () => {
  const count = 10_800;
  const sessionId = "s-3h";
  const filled = fillRide(sessionId, count, (s) => ({ hr: 140 }));
  const started = Date.now();
  const result = deriveFreestyleStableObservation(baseInput(sessionId, count, filled));
  const elapsedMs = Date.now() - started;
  assert.ok(result);
  assert.equal(result.candidateWindowCount, 1);
  assert.equal(result.windows[0].durationSec, count);
  assert.equal(result.windows[0].jointHrPowerSeconds, count);
  assert.equal(result.windows[0].qualification, "hr_co_observed");
  assert.ok(elapsedMs < 5000, `3-hour window took ${elapsedMs}ms`);
});

test("parser rejects unknown or malformed reason codes", () => {
  const valid = JSON.parse(JSON.stringify(stableRide("s-reason", 60, (s) => ({ hr: 140 }))));
  assert.ok(parseFreestyleStableObservation(valid));
  valid.windows[0].reasons = ["<img src=x onerror=alert(1)>"];
  assert.equal(parseFreestyleStableObservation(valid), null);
  const duplicate = JSON.parse(JSON.stringify(stableRide("s-reason-dup", 60, (s) => ({ hr: 140 }))));
  duplicate.windows[0].reasons.push("insufficient_duration");
  assert.equal(parseFreestyleStableObservation(duplicate), null);
});

test("malicious HTML in a reason cannot create executable markup", () => {
  const payload = "<img src=x onerror=alert(1)>";
  assert.equal(escapeHtml(payload), "&lt;img src=x onerror=alert(1)&gt;");
  const html = buildFreestyleAnalyticsHtml({
    intent: "freestyle",
    day: "Freestyle",
    freestyle_ride_response: { workload: { workStatus: "unavailable", powerCoverageRatio: 0 } },
    freestyle_stable_observation: {
      candidateWindowCount: 1,
      mechanicallyQualifiedCount: 0,
      hrCoObservedCount: 0,
      windows: [{
        observedResistanceLevel: 5,
        durationSec: 60,
        qualification: "candidate",
        jointHrPowerCoverageRatio: 0,
        reasons: [payload, "insufficient_duration"],
      }],
    },
  });
  assert.match(html, /insufficient_duration/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("parser rejects qualified windows that contradict mechanical policy", () => {
  const qualified = JSON.parse(JSON.stringify(stableRide("s-contradict", 180, (s) => ({ hr: 140 }))));
  assert.equal(qualified.windows[0].qualification, "hr_co_observed");
  const mad = JSON.parse(JSON.stringify(qualified));
  mad.windows[0].powerMadWatts = 80;
  assert.equal(parseFreestyleStableObservation(mad), null);
  const mixed = JSON.parse(JSON.stringify(qualified));
  mixed.windows[0].wattsProvenance = "mixed";
  assert.equal(parseFreestyleStableObservation(mixed), null);
  const zeroLoad = JSON.parse(JSON.stringify(qualified));
  zeroLoad.windows[0].powerMedianWatts = 0;
  assert.equal(parseFreestyleStableObservation(zeroLoad), null);
  const reason = JSON.parse(JSON.stringify(qualified));
  reason.windows[0].reasons = ["workload_unstable"];
  assert.equal(parseFreestyleStableObservation(reason), null);
  const demote = JSON.parse(JSON.stringify(qualified));
  demote.windows[0].qualification = "mechanically_qualified";
  demote.mechanicallyQualifiedCount = 1;
  demote.hrCoObservedCount = 0;
  assert.equal(parseFreestyleStableObservation(demote), null);
});

test("F2 derivation exceptions do not suppress F3, and F3 exceptions do not suppress F2", () => {
  const sessionId = "s-indep";
  const filled = fillRide(sessionId, 180, (s) => ({ hr: 140 }));
  const input = {
    athleteId: ATHLETE,
    sessionId,
    startedAtMs: BASE_TIME,
    endedAtMs: BASE_TIME + 180_000,
    activeDurationSec: 180,
    pausedDurationSec: 0,
    cancelled: false,
    evidenceIncomplete: false,
    ...filled,
  };
  const f3Only = {};
  attachFreestyleDerivedAnalytics(f3Only, input, () => { throw new Error("injected f2 failure"); });
  assert.equal(f3Only.freestyle_ride_response, undefined);
  assert.ok(f3Only.freestyle_stable_observation);
  assert.equal(f3Only.freestyle_stable_observation.windows[0].qualification, "hr_co_observed");
  const f2Only = {};
  attachFreestyleDerivedAnalytics(
    f2Only,
    input,
    deriveFreestyleRideResponse,
    () => { throw new Error("injected f3 failure"); }
  );
  assert.ok(f2Only.freestyle_ride_response);
  assert.equal(f2Only.freestyle_stable_observation, undefined);
});
