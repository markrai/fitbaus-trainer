import assert from "node:assert/strict";
import test from "node:test";
import { createWorkoutTelemetryIngestion } from "../dist/workoutTelemetryIngestion.js";
import { VO2_WORKOUT_SELECTOR_ID } from "../dist/vo2Protocol.js";

function fixture() {
  const start = 100000;
  let now = start + 5000;
  let day = "Monday";
  let session = { sessionId: "ride-1", startTime: String(start), athleteId: "athlete-1", activity: "bike", paused: false, pausedElapsed: 0 };
  let finalization = null;
  let fault = null;
  const events = [];
  const state = {
    telemetryStale: false, telemetryReceivedAtMs: now, telemetrySnapshotAt: new Date(now).toISOString(),
    watts: 120, wattsCurrent: true, rpm: 70, rpmCurrent: true,
    observedResistance: 4, observedResistanceCurrent: true, desiredResistance: 5, commandedResistance: 6,
  };
  let load = async () => [];
  const ingestion = createWorkoutTelemetryIngestion(() => day, {
    getSession: () => session,
    getHrSamples: (id) => load(id),
    getBikeBridgeSession: () => ({ getViewState: () => state }),
    readSessionFinalization: () => finalization,
    readFreestyleAuthorityFault: () => fault,
    recordVo2ActiveBikeTelemetry: (s, metrics) => events.push(["vo2", s.sessionId, metrics]),
    ordinaryActiveBikeTelemetrySample: (s, metrics) => {
      events.push(["ordinary", s.sessionId, metrics]);
      return { sessionId: s.sessionId };
    },
    queueOrdinaryBikeTelemetrySample: (sample) => events.push(["queue", sample.sessionId]),
    recordMachineHeartRateSample: (...args) => events.push(["machine", ...args]),
    storeHrSample: (...args) => events.push(["store", ...args]),
    now: () => now,
  });
  return { ingestion, events, state, setDay: (v) => { day = v; }, setSession: (v) => { session = { ...session, ...v }; },
    setNow: (v) => { now = v; }, setFinalization: (v) => { finalization = v; }, setFault: (v) => { fault = v; },
    setLoad: (v) => { load = v; } };
}

test("ordinary telemetry retains observed and requested provenance independently", () => {
  const f = fixture();
  f.state.watts = 0;
  f.state.rpmCurrent = false;
  f.ingestion.recordBikeTelemetry();
  assert.deepEqual(f.events, [
    ["ordinary", "ride-1", {
      telemetryStale: false, telemetryReceivedAtMs: 105000, telemetrySnapshotAt: new Date(105000).toISOString(),
      watts: { value: 0, current: true }, cadenceRpm: { value: 70, current: false },
      observedResistance: { value: 4, current: true }, desiredResistance: 5, commandedResistance: 6,
    }],
    ["queue", "ride-1"],
  ]);
});

test("VO2 routes only positive finite non-stale observed metrics to its active clock", () => {
  const f = fixture();
  f.setDay(VO2_WORKOUT_SELECTOR_ID);
  f.state.watts = 0;
  f.state.observedResistance = NaN;
  f.ingestion.recordBikeTelemetry();
  assert.deepEqual(f.events, [["vo2", "ride-1", { rpm: 70 }]]);
  f.state.telemetryStale = true;
  f.ingestion.recordBikeTelemetry();
  assert.equal(f.events.length, 1);
});

test("ordinary telemetry refuses missing identity, non-bike, finalization and authority fault", () => {
  const f = fixture();
  f.setSession({ athleteId: undefined });
  f.ingestion.recordBikeTelemetry();
  f.setSession({ athleteId: "athlete-1", activity: "run" });
  f.ingestion.recordBikeTelemetry();
  f.setSession({ activity: "bike" });
  f.setFinalization({});
  f.ingestion.recordBikeTelemetry();
  f.setFinalization(null);
  f.setFault({});
  f.ingestion.recordBikeTelemetry();
  assert.deepEqual(f.events, []);
});

test("ordinary stale snapshots reach the canonical evidence builder unchanged", () => {
  const f = fixture();
  f.state.telemetryStale = true;
  f.ingestion.recordBikeTelemetry();
  assert.equal(f.events[0][2].telemetryStale, true);
});

test("HR hydration deduplicates persisted seconds and concurrent samples; machine precedes storage", async () => {
  const f = fixture();
  let reads = 0;
  f.setLoad(async () => { reads++; return [{ timestamp_sec: 5 }]; });
  await f.ingestion.persistWorkoutRelativeHr(140);
  assert.deepEqual(f.events, []);
  f.setNow(106000);
  await Promise.all([f.ingestion.persistWorkoutRelativeHr(145), f.ingestion.persistWorkoutRelativeHr(146)]);
  assert.equal(reads, 1);
  assert.deepEqual(f.events, [["machine", "ride-1", 6, 145], ["store", "ride-1", 6, 145]]);
});

test("HR rechecks session identity and finalization after asynchronous hydration", async () => {
  for (const invalidate of [f => f.setSession({ sessionId: "ride-2" }), f => f.setFinalization({}), f => f.setSession({ paused: true })]) {
    const f = fixture();
    let release;
    f.setLoad(() => new Promise(resolve => { release = resolve; }));
    const pending = f.ingestion.persistWorkoutRelativeHr(150);
    invalidate(f);
    release([]);
    await pending;
    assert.deepEqual(f.events, []);
  }
});

test("HR hydration state is scoped to ingestion owner and new session", async () => {
  const f = fixture();
  await f.ingestion.persistWorkoutRelativeHr(140);
  f.setSession({ sessionId: "ride-2" });
  await f.ingestion.persistWorkoutRelativeHr(141);
  assert.deepEqual(f.events.map(e => e.slice(0, 3)), [
    ["machine", "ride-1", 5], ["store", "ride-1", 5], ["machine", "ride-2", 5], ["store", "ride-2", 5],
  ]);
});
