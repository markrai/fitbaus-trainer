import assert from "node:assert/strict";
import test from "node:test";
import { getPhase, startWorkout, tickVo2Protocol, tickVo2ProtocolWithCanonicalHr } from "../dist/workoutLogic.js";
import { getSession, persistVo2ProtocolRuntime } from "../dist/sessionStore.js";
import { getPlan, installStandaloneVo2Workout } from "../dist/workoutData.js";
import {
  VO2_WORKOUT_SELECTOR_ID,
  buildVo2ProtocolPlan,
  createVo2ProtocolRuntime,
} from "../dist/vo2Protocol.js";
import {
  advanceVo2ProtocolRuntime,
  buildVo2ProtocolEvidenceForRuntime,
  vo2ProtocolUiTargetsForRuntime,
} from "../dist/vo2ProtocolV3.js";
import { VO2_PROTOCOL_VERSION_V3 } from "../dist/types.js";
import { setSelectedMachine } from "../dist/machines/selection.js";
import { migrateLegacyProfile, storeAthleteProfile } from "../dist/profile.js";
import { estimatorSubmaxHrCeilingBpm, predictedHrMaxBpm } from "../dist/vo2Estimator.js";

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

function installStartFakes() {
  const storage = memoryStorage();
  const prevStorage = globalThis.localStorage;
  const prevWindow = globalThis.window;
  globalThis.localStorage = storage;
  const now = Date.now();
  globalThis.window = {
    getSelectedDay: () => VO2_WORKOUT_SELECTOR_ID,
    generateUUID: () => "session-v3-start",
    hrDeviceName: "Test Strap",
    liveBpm: 80,
    lastBpmUpdateTime: now,
  };
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  const profile = migrateLegacyProfile({ age: 46, weight: 115 }, "athlete-v3", new Date(now).toISOString());
  assert.equal(storeAthleteProfile(profile, storage), true);
  installStandaloneVo2Workout();
  return () => {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  };
}

test("new athlete-started VO2 workout selects adaptive protocol v3", () => {
  const restore = installStartFakes();
  try {
    startWorkout();
    const session = getSession(VO2_WORKOUT_SELECTOR_ID);
    assert.ok(session.startTime);
    assert.equal(session.sessionId, "session-v3-start");
    const runtime = session.vo2ProtocolRuntime;
    assert.ok(runtime);
    assert.equal(runtime.plan.protocol_version, VO2_PROTOCOL_VERSION_V3);
    // Adaptive plan starts with no workloads; the planner appends them.
    assert.deepEqual(runtime.plan.workloads, []);
    assert.equal(runtime.segment, "warmup");
  } finally {
    restore();
  }
});

test("v3 session advances through the live tick and reports phase, guidance, and evidence", () => {
  const restore = installStartFakes();
  try {
    startWorkout();
    const tick = tickVo2Protocol(VO2_WORKOUT_SELECTOR_ID, 300, false);
    assert.ok(tick);
    assert.equal(tick.runtime.plan.protocol_version, VO2_PROTOCOL_VERSION_V3);
    // The persisted v3 runtime round-trips through the session store.
    const reloaded = getSession(VO2_WORKOUT_SELECTOR_ID).vo2ProtocolRuntime;
    assert.ok(reloaded);
    assert.equal(reloaded.plan.protocol_version, VO2_PROTOCOL_VERSION_V3);
    assert.equal(reloaded.plan.workloads.length, 1);
    // Bootstrap first stage: lowest calibrated level separated from warmup
    // (R4/78W above R1/66W) with adaptive provenance.
    const workload = reloaded.plan.workloads[0];
    assert.equal(workload.prescribed_resistance, 4);
    assert.equal(workload.calibrated_watts_at_70rpm, 78);
    assert.equal(reloaded.stages.length, 1);
    assert.equal(reloaded.stages[0].adaptive.selected_resistance, 4);
    assert.equal(reloaded.stages[0].adaptive.reason_code, "bootstrap_first_stage");
    // The live phase follows the v3 runtime.
    const phase = getPhase(300, getPlan()[VO2_WORKOUT_SELECTOR_ID], null, { day: VO2_WORKOUT_SELECTOR_ID });
    assert.equal(phase.phaseId, "vo2-stage:1");
    assert.equal(phase.kind, "work");
    // Machine guidance follows the adaptive selected resistance.
    const targets = vo2ProtocolUiTargetsForRuntime(reloaded, phase.phaseId);
    assert.equal(targets.holdResistance, 4);
    assert.equal(targets.holdCadenceRpm, 70);
    assert.equal(targets.holdResistance, reloaded.stages[0].adaptive.selected_resistance);
    // The resulting protocol evidence reports version 3.
    const evidence = buildVo2ProtocolEvidenceForRuntime(reloaded, []);
    assert.ok(evidence);
    assert.equal(evidence.protocol_version, VO2_PROTOCOL_VERSION_V3);
    assert.equal(evidence.stages.length, 1);
  } finally {
    restore();
  }
});

test("persisted v2 sessions keep v2 semantics on every routed path", () => {
  const storage = memoryStorage();
  const plan = buildVo2ProtocolPlan();
  assert.ok(plan);
  assert.equal(plan.protocol_version, 2);
  const runtime = createVo2ProtocolRuntime(plan, { age_years: 46, weight_kg: 52.1631 });
  persistVo2ProtocolRuntime(VO2_WORKOUT_SELECTOR_ID, runtime, storage);
  const reloaded = getSession(VO2_WORKOUT_SELECTOR_ID, storage).vo2ProtocolRuntime;
  assert.ok(reloaded);
  assert.equal(reloaded.plan.protocol_version, 2);
  const next = advanceVo2ProtocolRuntime(reloaded, { elapsedSec: 300, paused: false, samples: [] });
  assert.equal(next.plan.protocol_version, 2);
  assert.equal(next.stages.length, 1);
  const targets = vo2ProtocolUiTargetsForRuntime(next, "vo2-stage:1");
  assert.equal(targets.holdResistance, next.plan.workloads[0].prescribed_resistance);
  const evidence = buildVo2ProtocolEvidenceForRuntime(next, []);
  assert.ok(evidence);
  assert.equal(evidence.protocol_version, 2);
});

test("v3 live ceiling breach before the first checkpoint stops promptly with observed provenance", async () => {
  const restore = installStartFakes();
  try {
    startWorkout();
    const opened = tickVo2Protocol(VO2_WORKOUT_SELECTOR_ID, 300, false);
    assert.ok(opened);
    assert.equal(opened.runtime.segment, "work");
    globalThis.window.liveBpm = 150;
    globalThis.window.lastBpmUpdateTime = Date.now();
    const tick = await tickVo2ProtocolWithCanonicalHr(VO2_WORKOUT_SELECTOR_ID, 330, false);
    assert.ok(tick);
    const runtime = tick.runtime;
    assert.equal(runtime.segment, "cooldown");
    assert.equal(runtime.termination.reason, "submax_hr_ceiling");
    assert.ok(runtime.adaptive_termination);
    assert.equal(runtime.adaptive_termination.reason_code, "observed_hr_above_ceiling");
    assert.notEqual(runtime.adaptive_termination.reason_code, "hr_safety_no_safe_target");
    assert.equal(runtime.adaptive_termination.termination_reason, "submax_hr_ceiling");
    const hard = estimatorSubmaxHrCeilingBpm(predictedHrMaxBpm(46));
    assert.ok(Math.abs(runtime.adaptive_termination.hard_hr_ceiling_bpm - hard) < 1e-9);
    assert.ok(Math.abs(runtime.adaptive_termination.planning_hr_ceiling_bpm - (hard - 12)) < 1e-9);
    assert.equal(runtime.adaptive_termination.planning_margin_bpm, 12);
    assert.equal(runtime.stages.length, 1);
    assert.equal(runtime.plan.workloads.length, 1);
    const evidence = buildVo2ProtocolEvidenceForRuntime(runtime, []);
    assert.ok(evidence);
    assert.equal(evidence.automatic_submax_hr_ceiling_available, true);
  } finally {
    restore();
  }
});

test("observed breach during stage 1 reports zero completed work stages", async () => {
  const restore = installStartFakes();
  try {
    startWorkout();
    tickVo2Protocol(VO2_WORKOUT_SELECTOR_ID, 300, false);
    globalThis.window.liveBpm = 150;
    globalThis.window.lastBpmUpdateTime = Date.now();
    const tick = await tickVo2ProtocolWithCanonicalHr(VO2_WORKOUT_SELECTOR_ID, 330, false);
    assert.ok(tick);
    assert.equal(tick.runtime.segment, "cooldown");
    const provenance = tick.runtime.adaptive_termination;
    assert.ok(provenance);
    assert.equal(provenance.reason_code, "observed_hr_above_ceiling");
    // The open stage is still open when the breach fires: nothing completed.
    assert.equal(provenance.completed_work_stage_count, 0);
    assert.equal(provenance.eligible_stage_count, 0);
  } finally {
    restore();
  }
});

test("v3 live ceiling reached exactly still stops (matches estimator >= rule)", async () => {
  const restore = installStartFakes();
  try {
    startWorkout();
    tickVo2Protocol(VO2_WORKOUT_SELECTOR_ID, 300, false);
    globalThis.window.liveBpm = estimatorSubmaxHrCeilingBpm(predictedHrMaxBpm(46));
    globalThis.window.lastBpmUpdateTime = Date.now();
    const tick = await tickVo2ProtocolWithCanonicalHr(VO2_WORKOUT_SELECTOR_ID, 330, false);
    assert.ok(tick);
    assert.equal(tick.runtime.segment, "cooldown");
    assert.equal(tick.runtime.adaptive_termination.reason_code, "observed_hr_above_ceiling");
  } finally {
    restore();
  }
});

test("below-ceiling fresh HR does not stop v3 and arms the guard", async () => {
  const restore = installStartFakes();
  try {
    startWorkout();
    tickVo2Protocol(VO2_WORKOUT_SELECTOR_ID, 300, false);
    globalThis.window.liveBpm = 130;
    globalThis.window.lastBpmUpdateTime = Date.now();
    const tick = await tickVo2ProtocolWithCanonicalHr(VO2_WORKOUT_SELECTOR_ID, 330, false);
    assert.ok(tick);
    assert.equal(tick.runtime.segment, "work");
    assert.equal(tick.runtime.termination, undefined);
    assert.equal(tick.runtime.stages.length, 1);
    const evidence = buildVo2ProtocolEvidenceForRuntime(tick.runtime, []);
    assert.ok(evidence);
    assert.equal(evidence.automatic_submax_hr_ceiling_available, true);
  } finally {
    restore();
  }
});

test("stale or invalid live HR does not trigger the v3 guard", async () => {
  const restore = installStartFakes();
  try {
    startWorkout();
    tickVo2Protocol(VO2_WORKOUT_SELECTOR_ID, 300, false);
    const w = globalThis.window;
    const cases = [
      { name: "stale", liveBpm: 150, lastBpmUpdateTime: Date.now() - 10000, hrDeviceName: "Test Strap" },
      { name: "future", liveBpm: 150, lastBpmUpdateTime: Date.now() + 60000, hrDeviceName: "Test Strap" },
      { name: "zero", liveBpm: 0, lastBpmUpdateTime: Date.now(), hrDeviceName: "Test Strap" },
      { name: "null", liveBpm: null, lastBpmUpdateTime: Date.now(), hrDeviceName: "Test Strap" },
      { name: "no-device", liveBpm: 150, lastBpmUpdateTime: Date.now(), hrDeviceName: undefined },
      { name: "nan", liveBpm: NaN, lastBpmUpdateTime: Date.now(), hrDeviceName: "Test Strap" },
      { name: "string", liveBpm: "150", lastBpmUpdateTime: Date.now(), hrDeviceName: "Test Strap" },
    ];
    let elapsed = 330;
    for (const c of cases) {
      w.liveBpm = c.liveBpm;
      w.lastBpmUpdateTime = c.lastBpmUpdateTime;
      w.hrDeviceName = c.hrDeviceName;
      const tick = await tickVo2ProtocolWithCanonicalHr(VO2_WORKOUT_SELECTOR_ID, elapsed, false);
      assert.ok(tick, c.name);
      assert.equal(tick.runtime.segment, "work", c.name);
      assert.equal(tick.runtime.termination, undefined, c.name);
      assert.equal(tick.runtime.stages.length, 1, c.name);
      elapsed += 5;
    }
    // Never armed: no trustworthy reading ever reached the guard.
    const runtime = getSession(VO2_WORKOUT_SELECTOR_ID).vo2ProtocolRuntime;
    const evidence = buildVo2ProtocolEvidenceForRuntime(runtime, []);
    assert.ok(evidence);
    assert.equal(evidence.automatic_submax_hr_ceiling_available, false);
  } finally {
    restore();
  }
});

test("paused v3 workout does not trigger on over-ceiling live HR", async () => {
  const restore = installStartFakes();
  try {
    startWorkout();
    tickVo2Protocol(VO2_WORKOUT_SELECTOR_ID, 300, false);
    globalThis.window.liveBpm = 150;
    globalThis.window.lastBpmUpdateTime = Date.now();
    const tick = await tickVo2ProtocolWithCanonicalHr(VO2_WORKOUT_SELECTOR_ID, 330, true);
    assert.ok(tick);
    assert.equal(tick.runtime.segment, "work");
    assert.equal(tick.runtime.termination, undefined);
    assert.equal(tick.runtime.stages.length, 1);
    const evidence = buildVo2ProtocolEvidenceForRuntime(tick.runtime, []);
    assert.ok(evidence);
    assert.equal(evidence.automatic_submax_hr_ceiling_available, false);
  } finally {
    restore();
  }
});

test("every pre-checkpoint tick evaluates the guard independently", async () => {
  // Pins the production wiring contract from the tick side: with the 1 Hz
  // display timer calling the canonical tick unconditionally, a breach is
  // detected within ~1s at any elapsed -- no checkpoint gating inside.
  const restore = installStartFakes();
  try {
    startWorkout();
    tickVo2Protocol(VO2_WORKOUT_SELECTOR_ID, 300, false);
    globalThis.window.liveBpm = 130;
    globalThis.window.lastBpmUpdateTime = Date.now();
    const first = await tickVo2ProtocolWithCanonicalHr(VO2_WORKOUT_SELECTOR_ID, 330, false);
    assert.ok(first);
    assert.equal(first.runtime.segment, "work");
    // One second later, still far from any checkpoint, a breach stops promptly.
    globalThis.window.liveBpm = 150;
    globalThis.window.lastBpmUpdateTime = Date.now();
    const second = await tickVo2ProtocolWithCanonicalHr(VO2_WORKOUT_SELECTOR_ID, 331, false);
    assert.ok(second);
    assert.equal(second.runtime.segment, "cooldown");
    assert.equal(second.runtime.adaptive_termination.reason_code, "observed_hr_above_ceiling");
  } finally {
    restore();
  }
});

test("v2 sessions ignore over-ceiling live HR (guard is v3-only)", async () => {
  const restore = installStartFakes();
  try {
    const plan = buildVo2ProtocolPlan();
    assert.ok(plan);
    persistVo2ProtocolRuntime(
      VO2_WORKOUT_SELECTOR_ID,
      createVo2ProtocolRuntime(plan, { age_years: 46, weight_kg: 52.1631 })
    );
    tickVo2Protocol(VO2_WORKOUT_SELECTOR_ID, 300, false);
    globalThis.window.liveBpm = 150;
    globalThis.window.lastBpmUpdateTime = Date.now();
    const tick = await tickVo2ProtocolWithCanonicalHr(VO2_WORKOUT_SELECTOR_ID, 330, false);
    assert.ok(tick);
    assert.equal(tick.runtime.plan.protocol_version, 2);
    assert.equal(tick.runtime.segment, "work");
    assert.equal(tick.runtime.termination, undefined);
    assert.equal(tick.runtime.stages.length, 1);
  } finally {
    restore();
  }
});
