import assert from "node:assert/strict";
import test from "node:test";

import {
  RESTING_HR_SESSION_POLICY_V1,
  bpmNotificationsAround,
  cancelRestingHrAcquisition,
  createRestingHrAcquisition,
  evaluateRestingHrStartReadiness,
  finalizeRestingHrAcquisition,
  ingestRestingHrBpmNotification,
  refreshRestingHrAcquisitionUi,
  runRestingHrSession,
} from "../dist/restingHrAcquisition.js";

test("start readiness requires a connected strap and no active workout", () => {
  assert.deepEqual(
    evaluateRestingHrStartReadiness({ connected: true, workoutInProgress: false, measurementInProgress: false }),
    { ok: true }
  );
  assert.deepEqual(
    evaluateRestingHrStartReadiness({ connected: false, workoutInProgress: false, measurementInProgress: false }),
    { ok: false, reason: "not_connected" }
  );
  assert.deepEqual(
    evaluateRestingHrStartReadiness({ connected: true, workoutInProgress: true, measurementInProgress: false }),
    { ok: false, reason: "workout_in_progress" }
  );
});

test("stable valid measurement yields the integer median of the observation window", () => {
  const { result } = runRestingHrSession(bpmNotificationsAround(58));
  assert.equal(result.outcome, "accepted");
  assert.equal(result.metric.value.heartRateBpm, 58);
  assert.equal(result.metric.value.eligibleForPrescription, false);
  assert.equal(result.metric.source, "resting_session");
  assert.equal(result.metric.quality, "high");
  assert.equal(result.metric.value.acceptedSampleCount, 210);
  assert.equal(result.metric.value.coverageRatio, 1);
  assert.equal(result.metric.algorithm.id, RESTING_HR_SESSION_POLICY_V1.algorithmId);
});

test("settle-window samples are excluded from the stored statistic", () => {
  const map = {};
  for (let elapsedSec = 0; elapsedSec < 90; elapsedSec += 1) map[elapsedSec] = { bpm: 90 };
  const { result } = runRestingHrSession(bpmNotificationsAround(56, map));
  assert.equal(result.outcome, "accepted");
  assert.equal(result.metric.value.heartRateBpm, 56);
  assert.equal(result.metric.value.observedMinBpm, 56);
  assert.equal(result.metric.value.observedMaxBpm, 56);
});

test("one BLE notification followed by several UI timer ticks does not manufacture observations", () => {
  const state = createRestingHrAcquisition({
    startedAtMonoMs: 0,
    measurementId: "one-bpm",
    athleteId: "athlete-test",
  });
  ingestRestingHrBpmNotification(state, { monoMs: 100_000, bpm: 57, connected: true });
  assert.equal(state.observationSlots.size, 1);
  assert.equal(state.observationSlots.get(10)?.kind, "accepted");
  for (const offset of [200, 400, 800, 1200, 1600]) {
    refreshRestingHrAcquisitionUi(state, { monoMs: 100_000 + offset, connected: true });
  }
  assert.equal(state.observationSlots.size, 1);
  assert.equal(state.observationSlots.get(10)?.kind, "accepted");
  assert.equal(state.observationSlots.get(10).bpm, 57);
});

test("duplicate callbacks and multiple notifications in one second keep one bucket sample", () => {
  const state = createRestingHrAcquisition({
    startedAtMonoMs: 0,
    measurementId: "dupes",
    athleteId: "athlete-test",
  });
  ingestRestingHrBpmNotification(state, { monoMs: 95_000, bpm: 60, connected: true });
  ingestRestingHrBpmNotification(state, { monoMs: 95_100, bpm: 61, connected: true });
  ingestRestingHrBpmNotification(state, { monoMs: 95_400, bpm: 62, connected: true });
  assert.equal(state.observationSlots.size, 1);
  assert.deepEqual(state.observationSlots.get(5), { kind: "accepted", bpm: 60 });
  assert.equal(state.lastLiveBpm, 62);
});

test("timer tick never overwrites an accepted BLE sample", () => {
  const state = createRestingHrAcquisition({
    startedAtMonoMs: 0,
    measurementId: "no-overwrite",
    athleteId: "athlete-test",
  });
  ingestRestingHrBpmNotification(state, { monoMs: 120_000, bpm: 55, connected: true });
  refreshRestingHrAcquisitionUi(state, { monoMs: 120_500, connected: true });
  refreshRestingHrAcquisitionUi(state, { monoMs: 121_000, connected: true });
  assert.deepEqual(state.observationSlots.get(30), { kind: "accepted", bpm: 55 });
  assert.equal(state.observationSlots.size, 1);
});

test("short disconnect then reconnection abandons the attempt", () => {
  const events = [];
  for (let elapsedSec = 0; elapsedSec < 150; elapsedSec += 1) {
    events.push({ type: "bpm", elapsedSec, bpm: 58 });
  }
  events.push({ type: "ui", elapsedSec: 150, connected: false });
  for (let elapsedSec = 151; elapsedSec < 300; elapsedSec += 1) {
    events.push({ type: "bpm", elapsedSec, bpm: 58, connected: true });
  }
  const { result, state } = runRestingHrSession(events);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "disconnected");
  assert.equal(state.status, "rejected");
  assert.equal(state.rejectReason, "disconnected");
  // Prior observation evidence is retained for diagnostics; nothing is finalized as accepted.
  assert.ok(state.observationSlots.size >= 50);
});

test("disconnect during settling abandons even if the strap reconnects", () => {
  const events = [];
  for (let elapsedSec = 0; elapsedSec < 40; elapsedSec += 1) {
    events.push({ type: "bpm", elapsedSec, bpm: 62 });
  }
  events.push({ type: "ui", elapsedSec: 40, connected: false });
  for (let elapsedSec = 41; elapsedSec < 300; elapsedSec += 1) {
    events.push({ type: "bpm", elapsedSec, bpm: 58, connected: true });
  }
  const { result, state } = runRestingHrSession(events);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "disconnected");
  assert.equal(state.status, "rejected");
  assert.equal(state.observationSlots.size, 0);
});

test("irregular BLE cadence still accepts with UI refreshes filling no samples", () => {
  const events = [];
  for (let elapsedSec = 0; elapsedSec < 300; elapsedSec += 1) {
    events.push({ type: "ui", elapsedSec });
    // Emit BPM on most observation seconds; skip every 6th to leave short gaps.
    if (elapsedSec < 90 || elapsedSec % 6 !== 0) {
      events.push({ type: "bpm", elapsedSec, bpm: 59 });
    }
  }
  const { result, state } = runRestingHrSession(events);
  assert.equal(result.outcome, "accepted");
  assert.ok(result.metric.value.acceptedSampleCount >= 170);
  assert.ok(result.metric.value.coverageRatio >= 0.8);
  assert.ok(state.observationSlots.size <= 210);
});

test("background timer throttling does not invent BPM buckets", () => {
  const events = [];
  for (let elapsedSec = 0; elapsedSec < 300; elapsedSec += 1) {
    events.push({ type: "bpm", elapsedSec, bpm: 58 });
  }
  // Simulate a long UI stall then a burst of timer ticks with no new BPM.
  for (const elapsedSec of [301, 302, 303, 304, 305]) {
    events.push({ type: "ui", elapsedSec });
  }
  const { result, state } = runRestingHrSession(events);
  assert.equal(result.outcome, "accepted");
  assert.equal(state.observationSlots.size, 210);
});

test("long continuous gap rejects even when overall coverage exceeds 80%", () => {
  const map = {};
  // Skip 25 consecutive observation seconds (elapsed 100..124 inclusive = 25 s).
  for (let elapsedSec = 100; elapsedSec <= 124; elapsedSec += 1) {
    map[elapsedSec] = { skip: true };
  }
  const events = bpmNotificationsAround(58, map);
  // Overall missing is 25/210 ≈ 11.9%, so coverage ≈ 88% > 80%.
  const { result, state } = runRestingHrSession(events);
  assert.ok(state.observationSlots.size / 210 > 0.8);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "excessive_continuous_gap");
  assert.equal(RESTING_HR_SESSION_POLICY_V1.maxContinuousUnacceptedSec, 20);
});

test("transient spikes and abrupt drops are rejected as artifacts", () => {
  const map = {
    120: { bpm: 140 },
    121: { bpm: 38 },
    180: { bpm: 160 },
  };
  const { result } = runRestingHrSession(bpmNotificationsAround(60, map));
  assert.equal(result.outcome, "accepted");
  assert.equal(result.metric.value.heartRateBpm, 60);
  assert.equal(result.metric.value.rejectedSampleCount, 3);
  assert.equal(result.metric.value.acceptedSampleCount, 207);
});

test("stale and missing sensor readings count against coverage", () => {
  const map = {};
  for (let elapsedSec = 90; elapsedSec < 300; elapsedSec += 1) {
    if (elapsedSec % 2 === 0) map[elapsedSec] = { skip: true };
  }
  const { result } = runRestingHrSession(bpmNotificationsAround(55, map));
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "insufficient_coverage");
});

test("disconnected strap at finalize is rejected", () => {
  const events = bpmNotificationsAround(57);
  events.push({ type: "ui", elapsedSec: 300, connected: false });
  const { result } = runRestingHrSession(events);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "disconnected");
});

test("wall-clock jumps do not shorten monotonic five-minute elapsed timing", () => {
  const state = createRestingHrAcquisition({
    startedAtMonoMs: 5_000,
    measurementId: "mono",
    athleteId: "athlete-test",
  });
  for (let elapsedSec = 0; elapsedSec < 300; elapsedSec += 1) {
    ingestRestingHrBpmNotification(state, {
      monoMs: 5_000 + elapsedSec * 1000,
      bpm: 54,
      connected: true,
    });
  }
  // Wall clock would look complete early; monotonic clock still needs 300 s.
  const early = finalizeRestingHrAcquisition(state, 5_000 + 120_000, {
    observedAt: "2026-11-03T12:02:00.000Z",
    updatedAt: "2026-11-03T12:02:00.000Z",
  });
  assert.equal(early.outcome, "rejected");
  assert.equal(early.reason, "incomplete");
  const done = finalizeRestingHrAcquisition(state, 5_000 + 300_000, {
    observedAt: "2026-11-03T12:05:00.000Z",
    updatedAt: "2026-11-03T12:05:00.000Z",
  });
  assert.equal(done.outcome, "accepted");
});

test("cancellation does not produce an accepted metric", () => {
  const state = createRestingHrAcquisition({
    startedAtMonoMs: 1_000,
    measurementId: "cancel-1",
    athleteId: "athlete-test",
  });
  ingestRestingHrBpmNotification(state, { monoMs: 1_000 + 30_000, bpm: 52, connected: true });
  cancelRestingHrAcquisition(state, 1_000 + 31_000, "cancelled");
  const result = finalizeRestingHrAcquisition(state, 1_000 + 300_000, {
    observedAt: "2026-11-03T12:05:00.000Z",
    updatedAt: "2026-11-03T12:05:00.000Z",
  });
  assert.equal(result.outcome, "cancelled");
});

test("interruption marks cancelled without saving", () => {
  const state = createRestingHrAcquisition({
    startedAtMonoMs: 0,
    measurementId: "interrupt-1",
    athleteId: "athlete-test",
  });
  ingestRestingHrBpmNotification(state, { monoMs: 100_000, bpm: 50, connected: true });
  cancelRestingHrAcquisition(state, 101_000, "interrupted");
  const result = finalizeRestingHrAcquisition(state, 300_000, {
    observedAt: "2026-11-03T12:05:00.000Z",
    updatedAt: "2026-11-03T12:05:00.000Z",
  });
  assert.equal(result.outcome, "cancelled");
  assert.equal(state.rejectReason, "interrupted");
});
