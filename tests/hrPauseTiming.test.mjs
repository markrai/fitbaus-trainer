import assert from "node:assert/strict";
import test from "node:test";
import {
  actualElapsedSeconds,
  getPhase,
  lastPersistedElapsedFromHrSamples,
  requestEarlyCooldown,
  workoutRelativeHrSample,
} from "../dist/workoutLogic.js";
import {
  getEarlyCooldownElapsed,
  getSession,
  pauseSession,
  resumeSession,
  startSession,
} from "../dist/sessionStore.js";
import {
  recordMachineHeartRateSample,
  resetMachineGuidanceRuntime,
} from "../dist/machines/runtime.js";

const blocks = { warm: 5, sustain: 25, cool: 5 };

if (typeof globalThis.window === "undefined") {
  globalThis.window = {};
}

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

function storedTimestamps(store, sessionId) {
  return [...store.keys()]
    .filter((key) => key.startsWith(sessionId + ":"))
    .map((key) => Number(key.slice(sessionId.length + 1)))
    .sort((a, b) => a - b);
}

function lastStoredElapsed(store, sessionId) {
  const timestamps = storedTimestamps(store, sessionId);
  return timestamps.length ? timestamps[timestamps.length - 1] : null;
}

function ingest(store, session, now, bpm) {
  const sample = workoutRelativeHrSample(session, now, lastStoredElapsed(store, session.sessionId));
  if (!sample || !session.sessionId) return null;
  const key = `${session.sessionId}:${sample.elapsedSec}`;
  if (!store.has(key)) store.set(key, bpm);
  recordMachineHeartRateSample(session.sessionId, sample.elapsedSec, bpm);
  return sample.elapsedSec;
}

test("active workout stores HR at active elapsed", () => {
  const now = 1_700_000_000_000;
  const session = {
    startTime: String(now - 480 * 1000),
    sessionId: "session-active",
    paused: false,
    pausedElapsed: 0,
  };
  assert.deepEqual(workoutRelativeHrSample(session, now), { elapsedSec: 480 });
  const store = new Map();
  assert.equal(ingest(store, session, now, 152), 480);
  assert.equal(store.get("session-active:480"), 152);
});

test("paused workout does not persist workout-relative HR", () => {
  const pauseNow = 1_700_000_000_000;
  const session = {
    startTime: String(pauseNow - 480 * 1000),
    sessionId: "session-paused",
    paused: true,
    pausedElapsed: 480,
  };
  const store = new Map();
  store.set("session-paused:480", 151);
  for (let wall = 1; wall <= 30; wall++) {
    assert.equal(workoutRelativeHrSample(session, pauseNow + wall * 1000), null);
    assert.equal(ingest(store, session, pauseNow + wall * 1000, 150 - (wall % 5)), null);
  }
  assert.deepEqual(storedTimestamps(store, "session-paused"), [480]);
  assert.equal(store.get("session-paused:480"), 151);
  assert.equal(actualElapsedSeconds(session.startTime, true, 480, pauseNow + 30 * 1000), 480);
});

test("resume continues the active HR timeline from the freeze point", () => {
  const storage = memoryStorage();
  const start = 2_000_000_000_000;
  const pauseNow = start + 480 * 1000;
  const resumeNow = pauseNow + 30 * 1000;
  startSession("Monday", start, "session-resume", "bike", storage);
  const store = new Map();
  resetMachineGuidanceRuntime("session-resume");
  ingest(store, getSession("Monday", storage), pauseNow, 154);
  pauseSession("Monday", 480, storage);
  ingest(store, getSession("Monday", storage), pauseNow + 10 * 1000, 140);
  ingest(store, getSession("Monday", storage), resumeNow, 136);
  resumeSession("Monday", storage, resumeNow);
  const resumed = getSession("Monday", storage);
  assert.equal(resumed.paused, false);
  assert.equal(actualElapsedSeconds(resumed.startTime, false, 0, resumeNow), 480);
  assert.equal(ingest(store, resumed, resumeNow, 136), null);
  assert.equal(store.get("session-resume:480"), 154);
  assert.equal(ingest(store, resumed, resumeNow + 1000, 148), 481);
  assert.equal(ingest(store, resumed, resumeNow + 2000, 147), 482);
  assert.equal(ingest(store, resumed, resumeNow + 3000, 146), 483);
  assert.deepEqual(storedTimestamps(store, "session-resume"), [480, 481, 482, 483]);
  assert.equal(store.has("session-resume:510"), false);
  assert.equal(store.has("session-resume:511"), false);
});

test("pause does not create overlapping or overwritten HR timestamps", () => {
  const storage = memoryStorage();
  const start = 2_100_000_000_000;
  const pauseNow = start + 480 * 1000;
  const resumeNow = pauseNow + 30 * 1000;
  startSession("Tuesday", start, "session-overlap", "bike", storage);
  const store = new Map();
  ingest(store, getSession("Tuesday", storage), start + 478 * 1000, 160);
  ingest(store, getSession("Tuesday", storage), start + 479 * 1000, 159);
  ingest(store, getSession("Tuesday", storage), pauseNow, 158);
  pauseSession("Tuesday", 480, storage);
  for (let wall = 1; wall <= 30; wall++) {
    ingest(store, getSession("Tuesday", storage), pauseNow + wall * 1000, 140);
  }
  resumeSession("Tuesday", storage, resumeNow);
  ingest(store, getSession("Tuesday", storage), resumeNow, 136);
  ingest(store, getSession("Tuesday", storage), resumeNow + 1000, 150);
  ingest(store, getSession("Tuesday", storage), resumeNow + 2000, 149);
  assert.equal(store.get("session-overlap:480"), 158);
  assert.deepEqual(storedTimestamps(store, "session-overlap"), [478, 479, 480, 481, 482]);
});

test("Early Cooldown modal delay does not persist pause-time HR", () => {
  const storage = memoryStorage();
  const start = 2_200_000_000_000;
  const pauseNow = start + 480 * 1000;
  const cooldownNow = pauseNow + 20 * 1000;
  startSession("Wednesday", start, "session-early", "bike", storage);
  const store = new Map();
  ingest(store, getSession("Wednesday", storage), pauseNow, 155);
  pauseSession("Wednesday", 480, storage);
  ingest(store, getSession("Wednesday", storage), pauseNow + 10 * 1000, 130);
  ingest(store, getSession("Wednesday", storage), cooldownNow, 128);
  const decision = requestEarlyCooldown("Wednesday", { storage, now: cooldownNow, blocks });
  assert.equal(decision.type, "enter-early-cooldown");
  const session = getSession("Wednesday", storage);
  assert.equal(getEarlyCooldownElapsed("Wednesday", storage), 480);
  assert.equal(session.paused, false);
  assert.equal(session.sessionId, "session-early");
  assert.equal(session.sessionStart, String(start));
  assert.equal(session.activity, "bike");
  const elapsed = actualElapsedSeconds(session.startTime, false, 0, cooldownNow);
  assert.equal(elapsed, 480);
  const phase = getPhase(elapsed, blocks, session.earlyCooldownElapsed);
  assert.equal(phase.kind, "cooldown");
  assert.equal(phase.phaseElapsedSeconds, 0);
  assert.equal(ingest(store, session, cooldownNow, 128), null);
  assert.equal(store.get("session-early:480"), 155);
  assert.equal(ingest(store, session, cooldownNow + 1000, 144), 481);
  assert.equal(ingest(store, session, cooldownNow + 2000, 142), 482);
  assert.deepEqual(storedTimestamps(store, "session-early"), [480, 481, 482]);
});

test("machine HR recording uses the same pause-safe elapsed as persisted workout HR", () => {
  const storage = memoryStorage();
  const start = 2_300_000_000_000;
  const pauseNow = start + 480 * 1000;
  const resumeNow = pauseNow + 30 * 1000;
  startSession("Friday", start, "session-machine", "bike", storage);
  const store = new Map();
  resetMachineGuidanceRuntime("session-machine");
  assert.equal(ingest(store, getSession("Friday", storage), pauseNow, 153), 480);
  pauseSession("Friday", 480, storage);
  assert.equal(ingest(store, getSession("Friday", storage), pauseNow + 15 * 1000, 140), null);
  resumeSession("Friday", storage, resumeNow);
  const resumed = getSession("Friday", storage);
  const joined = ingest(store, resumed, resumeNow + 1000, 148);
  assert.equal(joined, 481);
  assert.equal(joined, actualElapsedSeconds(resumed.startTime, false, 0, resumeNow + 1000));
  assert.deepEqual(storedTimestamps(store, "session-machine"), [480, 481]);
});

test("pausing does not alter session identity or prior HR history", () => {
  const storage = memoryStorage();
  const start = 2_400_000_000_000;
  const now = start + 480 * 1000;
  startSession("Thursday", start, "session-identity", "bike", storage);
  const store = new Map();
  ingest(store, getSession("Thursday", storage), now, 161);
  pauseSession("Thursday", 480, storage);
  ingest(store, getSession("Thursday", storage), now + 5000, 120);
  const session = getSession("Thursday", storage);
  assert.equal(session.sessionId, "session-identity");
  assert.equal(session.sessionStart, String(start));
  assert.equal(session.activity, "bike");
  assert.equal(session.earlyCooldownElapsed, null);
  assert.equal(store.get("session-identity:480"), 161);
  assert.deepEqual(storedTimestamps(store, "session-identity"), [480]);
});

test("immediate post-resume HR does not overwrite the pre-pause sample", () => {
  const storage = memoryStorage();
  const start = 2_600_000_000_000;
  const pauseNow = start + 480 * 1000;
  const resumeNow = pauseNow + 30 * 1000;
  startSession("Saturday", start, "session-resume-collision", "bike", storage);
  const store = new Map();
  ingest(store, getSession("Saturday", storage), start + 478 * 1000, 160);
  ingest(store, getSession("Saturday", storage), start + 479 * 1000, 159);
  ingest(store, getSession("Saturday", storage), pauseNow, 158);
  pauseSession("Saturday", 480, storage);
  for (let wall = 1; wall <= 30; wall++) {
    ingest(store, getSession("Saturday", storage), pauseNow + wall * 1000, 140);
  }
  resumeSession("Saturday", storage, resumeNow);
  const resumed = getSession("Saturday", storage);
  assert.equal(actualElapsedSeconds(resumed.startTime, false, 0, resumeNow), 480);
  assert.deepEqual(workoutRelativeHrSample(resumed, resumeNow), { elapsedSec: 480 });
  assert.equal(workoutRelativeHrSample(resumed, resumeNow, 480), null);
  assert.equal(ingest(store, resumed, resumeNow, 136), null);
  assert.equal(store.get("session-resume-collision:480"), 158);
  assert.equal(ingest(store, resumed, resumeNow + 1000, 148), 481);
  assert.equal(ingest(store, resumed, resumeNow + 2000, 147), 482);
  assert.equal(ingest(store, resumed, resumeNow + 3000, 146), 483);
  assert.deepEqual(storedTimestamps(store, "session-resume-collision"), [478, 479, 480, 481, 482, 483]);
});

test("immediate Early Cooldown HR does not overwrite the pre-pause work sample", () => {
  const storage = memoryStorage();
  const start = 2_700_000_000_000;
  const pauseNow = start + 480 * 1000;
  const cooldownNow = pauseNow + 20 * 1000;
  startSession("Sunday", start, "session-early-collision", "bike", storage);
  const store = new Map();
  ingest(store, getSession("Sunday", storage), pauseNow, 158);
  pauseSession("Sunday", 480, storage);
  ingest(store, getSession("Sunday", storage), pauseNow + 10 * 1000, 140);
  ingest(store, getSession("Sunday", storage), cooldownNow, 136);
  const decision = requestEarlyCooldown("Sunday", { storage, now: cooldownNow, blocks });
  assert.equal(decision.type, "enter-early-cooldown");
  const session = getSession("Sunday", storage);
  assert.equal(getEarlyCooldownElapsed("Sunday", storage), 480);
  assert.equal(actualElapsedSeconds(session.startTime, false, 0, cooldownNow), 480);
  assert.equal(ingest(store, session, cooldownNow, 136), null);
  assert.equal(store.get("session-early-collision:480"), 158);
  assert.equal(ingest(store, session, cooldownNow + 1000, 144), 481);
  assert.deepEqual(storedTimestamps(store, "session-early-collision"), [480, 481]);
});

test("reload hydrates last persisted elapsed so machine HR cannot replace the stored second", () => {
  const resumeNow = 2_800_000_000_000;
  const session = {
    startTime: String(resumeNow - 480 * 1000),
    sessionId: "session-reload",
    paused: false,
    pausedElapsed: 0,
  };
  const durable = lastPersistedElapsedFromHrSamples([
    { timestamp_sec: 478 },
    { timestamp_sec: 479 },
    { timestamp_sec: 480 },
  ]);
  assert.equal(durable, 480);
  assert.equal(actualElapsedSeconds(session.startTime, false, 0, resumeNow), 480);
  assert.equal(workoutRelativeHrSample(session, resumeNow, durable), null);
  resetMachineGuidanceRuntime("session-reload");
  assert.equal(recordMachineHeartRateSample("session-reload", 480, 158), true);
  assert.equal(recordMachineHeartRateSample("session-reload", 480, 136), false);
  assert.equal(recordMachineHeartRateSample("session-reload", 481, 148), true);
});

test("uninterrupted active workouts keep storing HR every second", () => {
  const start = 2_500_000_000_000;
  const session = {
    startTime: String(start),
    sessionId: "session-uninterrupted",
    paused: false,
    pausedElapsed: 0,
  };
  const store = new Map();
  for (let elapsed = 0; elapsed <= 10; elapsed++) {
    assert.equal(ingest(store, session, start + elapsed * 1000, 140 + elapsed), elapsed);
  }
  assert.deepEqual(storedTimestamps(store, "session-uninterrupted"), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
