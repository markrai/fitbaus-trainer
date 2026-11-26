import assert from "node:assert/strict";
import test from "node:test";
import { createWorkoutSessionCoordinator, recoverActiveOrFinalizingSession, cleanupStaleWorkoutSessions } from "../dist/workoutSessionCoordinator.js";
import { FREESTYLE_WORKOUT_SELECTOR_ID } from "../dist/freestyleRide.js";
import { VO2_WORKOUT_SELECTOR_ID } from "../dist/vo2Protocol.js";

function fixture() {
  const events = [];
  let owner = null;
  let finalization = null;
  let fault = null;
  let startTime = null;
  let tick = async () => null;
  const sessions = {};
  const dependencies = {
    todayName: () => "Monday",
    getSession: day => sessions[day] ?? {},
    readActiveSessionOwner: () => owner,
    readSessionFinalization: () => finalization,
    readFreestyleAuthorityFault: () => fault,
    markFreestyleAuthorityFault: (day, id) => { events.push(["mark", day, id]); fault = id; return true; },
    clearFreestyleAuthorityFault: day => { events.push(["clear", day]); fault = null; },
    getBikeBridgeSession: () => ({ bindSession: value => events.push(["bind", value]) }),
    getPlan: () => ({}), getWorkoutMetadata: () => ({}),
    getStartTime: () => startTime, isPaused: () => false, getPausedElapsed: () => 0,
    vo2TickSessionKey: s => s.sessionId,
    tickVo2ProtocolWithCanonicalHr: (...args) => tick(...args),
    deriveWorkoutState: day => ({ screen: "idle", day }),
    startWorkout: () => events.push(["start"]),
    beginWorkout: activity => events.push(["begin", activity]),
    restartWorkout: () => events.push(["restart"]),
    requestEarlyCooldown: () => ({ type: "enter-early-cooldown" }),
    requestVo2LimitReached: () => ({ type: "enter-limit-reached" }),
    pauseWorkout: (...args) => events.push(["pause", ...args]),
    resumeWorkout: (...args) => events.push(["resume", ...args]),
    handleWorkoutCompletion: day => events.push(["complete", day]),
    finishFreestyleRide: async day => { events.push(["finish", day]); return { ok: true }; },
    retryFreestyleSave: async day => { events.push(["retry", day]); return { ok: true }; },
    discardFreestyleRide: async (...args) => { events.push(["discard", ...args]); return { ok: true }; },
    restoreBikeBridgeBindingForActiveSession: day => events.push(["restore", day]),
    isSessionStale: day => day === "Monday" || day === FREESTYLE_WORKOUT_SELECTOR_ID,
    discardWorkoutSession: day => events.push(["discardStale", day]),
  };
  const coordinator = createWorkoutSessionCoordinator({
    readLiveHeartRate: () => ({ liveBpm: 150, lastBpmUpdateTime: 1000 }),
    setVo2Cues: cues => events.push(["cues", cues]),
    render: (state, bpm) => events.push(["render", state.day, bpm]),
    onRefreshError: error => { throw error; },
    requestWakeLock: () => events.push(["requestWake"]),
    releaseWakeLock: () => events.push(["releaseWake"]),
    updateDisplay: () => events.push(["refresh"]),
  }, dependencies);
  return { coordinator, dependencies, events, sessions,
    setOwner: v => { owner = v; }, setFinalization: v => { finalization = v; },
    setStartTime: v => { startTime = v; }, setTick: v => { tick = v; } };
}

test("active owner blocks selector changes, but a stale owner does not", () => {
  const f = fixture();
  assert.equal(f.coordinator.getSelectedDay(), "Monday");
  f.sessions.Tuesday = { sessionId: "ride", startTime: "1" };
  f.setOwner({ selector: "Tuesday", sessionId: "ride" });
  assert.equal(f.coordinator.resolveOwnedWorkoutDay(), "Tuesday");
  assert.deepEqual(f.coordinator.selectWorkoutDay("Friday"), { day: "Tuesday", blocked: true });
  f.sessions.Tuesday.sessionId = "replacement";
  assert.deepEqual(f.coordinator.selectWorkoutDay("Friday"), { day: "Friday", blocked: false });
  f.setFinalization({ sessionId: "ride" });
  assert.equal(f.coordinator.resolveOwnedWorkoutDay(), FREESTYLE_WORKOUT_SELECTOR_ID);
});

test("VO2 refresh supersedes pending intent without a stale render or cues", async () => {
  const f = fixture();
  f.coordinator.setSelectedDay(VO2_WORKOUT_SELECTOR_ID);
  f.sessions[VO2_WORKOUT_SELECTOR_ID] = { sessionId: "vo2", startTime: "1" };
  f.setStartTime(String(Date.now() - 1000));
  const pending = [];
  f.setTick((day, elapsed, paused, unused, guard) => new Promise(resolve => pending.push({ resolve, guard })));
  const first = f.coordinator.refresh();
  const second = f.coordinator.refresh();
  assert.equal(pending[0].guard.isCurrent(), false);
  assert.equal(pending[1].guard.isCurrent(), true);
  pending[1].resolve({ cues: ["new"] });
  await second;
  pending[0].resolve({ cues: ["old"] });
  await first;
  assert.deepEqual(f.events, [["cues", ["new"]], ["render", VO2_WORKOUT_SELECTOR_ID, 150]]);
});

test("VO2 refresh rejects replacement identity even with current selector", async () => {
  const f = fixture();
  f.coordinator.setSelectedDay(VO2_WORKOUT_SELECTOR_ID);
  f.sessions[VO2_WORKOUT_SELECTOR_ID] = { sessionId: "old" };
  f.setStartTime(String(Date.now() - 1000));
  let release;
  f.setTick(() => new Promise(resolve => { release = resolve; }));
  const pending = f.coordinator.refresh();
  f.sessions[VO2_WORKOUT_SELECTOR_ID] = { sessionId: "new" };
  release({ cues: ["old"] });
  await pending;
  assert.deepEqual(f.events, []);
});

test("workout actions delegate to canonical owners and preserve wake-lock order", () => {
  const f = fixture();
  f.coordinator.startWorkout();
  f.coordinator.beginWorkout("bike");
  f.coordinator.pause("Monday", 42);
  f.coordinator.resume("Monday");
  f.coordinator.complete("Monday");
  f.coordinator.restartWorkout();
  assert.deepEqual(f.events, [["start"], ["begin", "bike"], ["pause", "Monday", 42], ["releaseWake"], ["refresh"],
    ["resume", "Monday"], ["requestWake"], ["refresh"], ["releaseWake"], ["complete", "Monday"], ["restart"]]);
  assert.equal(f.coordinator.requestEarlyCooldown().type, "enter-early-cooldown");
  assert.equal(f.coordinator.requestVo2LimitReached().type, "enter-limit-reached");
});

test("Freestyle discard passes matching identity and never guesses a conflicting target", async () => {
  const f = fixture();
  const day = FREESTYLE_WORKOUT_SELECTOR_ID;
  f.coordinator.setSelectedDay(day);
  f.sessions[day] = { sessionId: "ride", startTime: "1" };
  f.setFinalization({ sessionId: "ride" });
  await f.coordinator.discardOwnedFreestyleRide();
  f.setFinalization({ sessionId: "conflict" });
  await f.coordinator.discardOwnedFreestyleRide();
  await f.coordinator.finishOwnedFreestyleRide();
  await f.coordinator.retryOwnedFreestyleSave();
  assert.deepEqual(f.events, [["discard", day, undefined, { sessionId: "ride" }], ["discard", day, undefined, undefined], ["finish", day], ["retry", day]]);
});

test("bootstrap recovery prioritizes pending finalization over the active owner", async () => {
  const f = fixture();
  const day = FREESTYLE_WORKOUT_SELECTOR_ID;
  const select = d => f.events.push(["select", d]);
  f.setOwner({ selector: "Tuesday", sessionId: "other" });
  f.sessions.Tuesday = { sessionId: "other", startTime: "1" };
  f.setFinalization({ sessionId: "ride", status: "save_failed" });
  await recoverActiveOrFinalizingSession(select, f.dependencies);
  assert.deepEqual(f.events, [["select", day], ["finish", day]]);
  f.events.length = 0;
  f.setFinalization(null);
  f.sessions[day] = { sessionId: "ride", startTime: "1" };
  await recoverActiveOrFinalizingSession(select, f.dependencies);
  assert.deepEqual(f.events, [["select", day], ["restore", day]]);
  f.events.length = 0;
  delete f.sessions[day];
  await recoverActiveOrFinalizingSession(select, f.dependencies);
  assert.deepEqual(f.events, [["select", "Tuesday"]]);
});

test("stale cleanup deliberately excludes Freestyle evidence", () => {
  const f = fixture();
  f.sessions.Monday = { sessionStart: "1" };
  f.sessions[FREESTYLE_WORKOUT_SELECTOR_ID] = { sessionStart: "1" };
  cleanupStaleWorkoutSessions(f.dependencies);
  assert.deepEqual(f.events, [["discardStale", "Monday"]]);
});

test("invalid Freestyle authority disarms before marking and valid authority clears the fault", () => {
  const f = fixture();
  const day = FREESTYLE_WORKOUT_SELECTOR_ID;
  const session = { sessionId: "ride" };
  assert.deepEqual(f.coordinator.checkFreestyleAuthority(day, session), { status: "invalid", newlyMarked: true });
  assert.deepEqual(f.events, [["bind", null], ["mark", day, "ride"]]);
  session.controlAuthority = { source: "frozen", mode: "manual_freestyle_ride", sessionId: "ride" };
  assert.deepEqual(f.coordinator.checkFreestyleAuthority(day, session), { status: "restored" });
  assert.deepEqual(f.events.at(-1), ["clear", day]);
});
