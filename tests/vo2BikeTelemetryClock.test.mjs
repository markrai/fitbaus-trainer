import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  activeElapsedSeconds,
  recordVo2ActiveBikeTelemetry,
  workoutRelativeHrSample,
} from "../dist/workoutLogic.js";
import {
  getSession,
  pauseSession,
  resumeSession,
  startSession,
} from "../dist/sessionStore.js";
import {
  bikeTelemetryStorageKey,
  clearBikeTelemetrySamples,
  getBikeTelemetrySamples,
  recordBikeTelemetrySample,
} from "../dist/bikeTelemetryTrace.js";
import { summarizeVo2StageWorkload, VO2_WORKLOAD_MIN_SAMPLES } from "../dist/vo2Workload.js";
import {
  discardWorkoutSession,
  handleWorkoutCancellation,
  handleWorkoutCompletion,
  releaseTransientSessionTelemetry,
} from "../dist/workoutLifecycle.js";

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
    snapshot() {
      return Object.fromEntries(values);
    },
  };
}

const METRICS = { rpm: 70, watts: 140 };

test("no pause: wall time 100 s advances active telemetry timestamp 100 s", () => {
  const storage = memoryStorage();
  const start = 4_000_000_000_000;
  const sessionId = "tel-no-pause";
  startSession("Monday", start, sessionId, "bike", storage);
  const session = getSession("Monday", storage);
  const elapsed = recordVo2ActiveBikeTelemetry(session, METRICS, start + 100_000, storage);
  assert.equal(elapsed, 100);
  assert.equal(activeElapsedSeconds(session.startTime, false, 0, start + 100_000), 100);
  assert.deepEqual(workoutRelativeHrSample(session, start + 100_000), { elapsedSec: 100 });
  const samples = getBikeTelemetrySamples(sessionId, storage);
  assert.equal(samples[0].timestamp_sec, 100);
  clearBikeTelemetrySamples(sessionId, storage);
});

test("pause then resume: next telemetry timestamp stays on active clock, not wall clock", () => {
  const storage = memoryStorage();
  const start = 4_000_000_100_000;
  const sessionId = "tel-pause";
  startSession("Tuesday", start, sessionId, "bike", storage);
  const pauseNow = start + 400_000;
  const resumeNow = pauseNow + 300_000;
  pauseSession("Tuesday", 400, storage, pauseNow);
  assert.equal(recordVo2ActiveBikeTelemetry(getSession("Tuesday", storage), METRICS, pauseNow + 150_000, storage), null);
  resumeSession("Tuesday", storage, resumeNow);
  const session = getSession("Tuesday", storage);
  const atResume = recordVo2ActiveBikeTelemetry(session, METRICS, resumeNow, storage);
  const next = recordVo2ActiveBikeTelemetry(session, METRICS, resumeNow + 1000, storage);
  assert.equal(atResume, 400);
  assert.equal(next, 401);
  assert.equal(activeElapsedSeconds(session.startTime, false, 0, resumeNow), 400);
  const wallFromOriginalStart = Math.floor((resumeNow - start) / 1000);
  assert.equal(wallFromOriginalStart, 700);
  assert.notEqual(atResume, wallFromOriginalStart);
  assert.notEqual(next, 700);
  assert.notEqual(next, 701);
  const hr = workoutRelativeHrSample(session, resumeNow + 1000);
  assert.deepEqual(hr, { elapsedSec: 401 });
  const samples = getBikeTelemetrySamples(sessionId, storage);
  assert.deepEqual(
    samples.map((row) => row.timestamp_sec),
    [400, 401]
  );
  clearBikeTelemetrySamples(sessionId, storage);
});

test("reload after resume uses the same persisted active time", () => {
  const storage = memoryStorage();
  const start = 4_000_000_200_000;
  const sessionId = "tel-reload";
  startSession("Wednesday", start, sessionId, "bike", storage);
  const pauseNow = start + 400_000;
  const resumeNow = pauseNow + 300_000;
  pauseSession("Wednesday", 400, storage, pauseNow);
  resumeSession("Wednesday", storage, resumeNow);
  const reloaded = memoryStorage(storage.snapshot());
  const session = getSession("Wednesday", reloaded);
  const elapsed = recordVo2ActiveBikeTelemetry(session, METRICS, resumeNow + 1000, reloaded);
  assert.equal(elapsed, 401);
  assert.equal(activeElapsedSeconds(session.startTime, false, 0, resumeNow + 1000), 401);
  clearBikeTelemetrySamples(sessionId, reloaded);
  clearBikeTelemetrySamples(sessionId, storage);
});

test("stage workload window sees post-resume telemetry on the active clock", () => {
  const storage = memoryStorage();
  const start = 4_000_000_300_000;
  const sessionId = "tel-stage-pause";
  const day = "Thursday";
  startSession(day, start, sessionId, "bike", storage);
  const stageStart = 300;
  const stageEnd = 480;
  const pauseAt = 400;
  for (let t = 360; t <= pauseAt; t++) {
    const session = getSession(day, storage);
    const now = start + t * 1000;
    const elapsed = recordVo2ActiveBikeTelemetry(session, METRICS, now, storage);
    assert.equal(elapsed, t);
  }
  const pauseNow = start + pauseAt * 1000;
  pauseSession(day, pauseAt, storage, pauseNow);
  const resumeNow = pauseNow + 300_000;
  resumeSession(day, storage, resumeNow);
  for (let t = pauseAt + 1; t <= stageEnd; t++) {
    const session = getSession(day, storage);
    const now = resumeNow + (t - pauseAt) * 1000;
    const elapsed = recordVo2ActiveBikeTelemetry(session, METRICS, now, storage);
    assert.equal(elapsed, t);
    assert.ok(elapsed < 700);
  }
  const samples = getBikeTelemetrySamples(sessionId, storage);
  assert.equal(
    samples.some((row) => row.timestamp_sec >= 700),
    false
  );
  assert.ok(samples.some((row) => row.timestamp_sec > pauseAt && row.timestamp_sec <= stageEnd));
  const workload = summarizeVo2StageWorkload(
    { active_start_sec: stageStart, active_end_sec: stageEnd, calibrated_watts_at_70rpm: 125 },
    samples
  );
  assert.ok(workload.measured_watts_sample_count >= VO2_WORKLOAD_MIN_SAMPLES);
  assert.equal(workload.source, "measured_watts");
  assert.equal(workload.estimator_watts, 140);
  assert.equal(workload.cadence_measured, true);
  assert.equal(workload.cadence_in_band_ratio, 1);
  clearBikeTelemetrySamples(sessionId, storage);
});

test("VO2 bike telemetry capture uses the canonical active clock helper", async () => {
  const src = await readFile(new URL("../src/uiControls.ts", import.meta.url), "utf8");
  assert.equal(src.includes("recordVo2ActiveBikeTelemetry"), true);
  assert.equal(src.includes("workoutRelativeHrSample"), true);
  const fn = src.slice(
    src.indexOf("function recordVo2BikeTelemetryIfActive"),
    src.indexOf("function renderBikeBridgeSettingsStatus")
  );
  assert.equal(fn.includes("Date.now() - parseInt(session.startTime"), false);
  assert.equal(fn.includes("recordVo2ActiveBikeTelemetry(session, metrics)"), true);
});

test("transient telemetry survives until assessment finalization, then is released", async () => {
  const previous = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  globalThis.window = { ...(previousWindow || {}) };
  const day = "Friday";
  const sessionId = "tel-finalize-order";
  try {
    startSession(day, Date.now() - 60_000, sessionId, "bike", storage);
    recordBikeTelemetrySample(sessionId, { timestamp_sec: 10, rpm: 70, watts: 140 }, storage);
    assert.ok(getBikeTelemetrySamples(sessionId, storage).length > 0);
    let generateSawSamples = false;
    globalThis.window.generateWorkoutSummary = async () => {
      assert.ok(getBikeTelemetrySamples(sessionId).length > 0);
      generateSawSamples = true;
      return { vo2_assessment: { status: "estimated" } };
    };
    globalThis.window.emitWorkoutSummary = async () => {};
    await handleWorkoutCompletion(day);
    assert.equal(generateSawSamples, true);
    assert.equal(getBikeTelemetrySamples(sessionId, storage).length, 0);
    assert.equal(storage.getItem(bikeTelemetryStorageKey(sessionId)), null);
  } finally {
    clearBikeTelemetrySamples(sessionId, storage);
    globalThis.localStorage = previous;
    globalThis.window = previousWindow;
  }
});

test("stale and discarded sessions do not leave orphaned telemetry keys", () => {
  const previous = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  globalThis.window = { ...(previousWindow || {}) };
  globalThis.window.generateWorkoutSummary = async () => {
    throw new Error("stale sessions must not generate a summary");
  };
  const day = "Saturday";
  const sessionId = "tel-stale-discard";
  try {
    startSession(day, Date.now() - 25 * 60 * 60 * 1000, sessionId, "bike", storage);
    recordBikeTelemetrySample(sessionId, { timestamp_sec: 20, rpm: 70, watts: 140 }, storage);
    assert.equal(storage.getItem(bikeTelemetryStorageKey(sessionId)) != null, true);
    handleWorkoutCompletion(day);
    assert.equal(getBikeTelemetrySamples(sessionId, storage).length, 0);
    assert.equal(storage.getItem(bikeTelemetryStorageKey(sessionId)), null);
    assert.equal(getSession(day, storage).sessionId, null);

    const replacedId = "tel-replaced";
    startSession("Sunday", Date.now(), replacedId, "bike", storage);
    recordBikeTelemetrySample(replacedId, { timestamp_sec: 5, rpm: 70, watts: 90 }, storage);
    discardWorkoutSession("Sunday", storage);
    startSession("Sunday", Date.now(), "tel-next", "bike", storage);
    assert.equal(getBikeTelemetrySamples(replacedId, storage).length, 0);
    assert.equal(storage.getItem(bikeTelemetryStorageKey(replacedId)), null);
  } finally {
    clearBikeTelemetrySamples(sessionId, storage);
    clearBikeTelemetrySamples("tel-replaced", storage);
    globalThis.localStorage = previous;
    globalThis.window = previousWindow;
  }
});

test("cancellation persists assessment before releasing telemetry", async () => {
  const previous = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  globalThis.window = { ...(previousWindow || {}) };
  const day = "Monday";
  const sessionId = "tel-cancel-order";
  try {
    startSession(day, Date.now() - 30_000, sessionId, "bike", storage);
    recordBikeTelemetrySample(sessionId, { timestamp_sec: 8, rpm: 70, watts: 140 }, storage);
    let generateSawSamples = false;
    globalThis.window.generateWorkoutSummary = async () => {
      assert.ok(getBikeTelemetrySamples(sessionId).length > 0);
      generateSawSamples = true;
      return { vo2_assessment: { status: "insufficient_evidence" } };
    };
    globalThis.window.emitWorkoutSummary = async () => {};
    await handleWorkoutCancellation(day);
    assert.equal(generateSawSamples, true);
    assert.equal(getBikeTelemetrySamples(sessionId, storage).length, 0);
    releaseTransientSessionTelemetry(sessionId, storage);
  } finally {
    clearBikeTelemetrySamples(sessionId, storage);
    globalThis.localStorage = previous;
    globalThis.window = previousWindow;
  }
});
