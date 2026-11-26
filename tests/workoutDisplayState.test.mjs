import assert from "node:assert/strict";
import test from "node:test";
import { BPM_TIMEOUT_MS, deriveWorkoutState } from "../dist/workoutDisplayState.js";
import { resolveWorkoutPrescription } from "../dist/workoutPrescription.js";
import { FREESTYLE_WORKOUT_SELECTOR_ID, FREESTYLE_WORKOUT_LABEL, freestylePlanBlocks } from "../dist/freestyleRide.js";
import { VO2_WORKOUT_SELECTOR_ID, vo2PlanBlocks, buildVo2ProtocolPlan, createVo2ProtocolRuntime, vo2ProtocolDisplayName } from "../dist/vo2Protocol.js";
import { LEGACY_VO2_PROTOCOL_ID, LEGACY_VO2_PROTOCOL_VERSION_V1 } from "../dist/types.js";

const day = "Monday";
const blocks = { warm: 2, sustain: 3, cool: 1 };
const hrTargets = {
  warmup: "130–140", warmup_intensity_id: "warmup_easy",
  main_set: "150–160", main_set_intensity_id: "threshold", main_set_kind: "work",
  cooldown: "<120", cooldown_intensity_id: "cooldown", intervals: null,
};
const resolvedPrescription = resolveWorkoutPrescription({
  workoutSelector: day, blocks, hrTargets, resolvedAt: "2026-01-01T00:00:00.000Z",
});
const phasePlan = { blocks, hrTargets, resolvedPrescription };
const now = 1_800_000_000_000;
const start = String(now - 90_000);

function withSession(t, selector, values = {}) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const map = new Map(Object.entries({
    ["start_" + selector]: start,
    ["session_id_" + selector]: "display-test",
    ["session_start_" + selector]: start,
    ["activity_" + selector]: "bike",
    ...values,
  }));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: key => map.get(key) ?? null,
      setItem: (key, value) => { map.set(key, String(value)); },
      removeItem: key => { map.delete(key); },
    },
  });
  t.after(() => {
    if (prior) Object.defineProperty(globalThis, "localStorage", prior);
    else delete globalThis.localStorage;
  });
  const originalNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  return map;
}

function display(selector = day, base = blocks, startTime = start, paused = true, elapsed = 90, bpm = 135, lastUpdate = now) {
  return deriveWorkoutState(selector, { [selector]: base }, { [selector]: { activities: ["bike"] } },
    base, startTime, paused, elapsed, bpm, lastUpdate);
}

test("rest and downregulation short circuit; idle preserves frozen plan blocks", t => {
  const map = withSession(t, day, { ["phase_plan_" + day]: JSON.stringify(phasePlan) });
  assert.equal(display("Sunday", null).screen, "rest");
  assert.equal(display("Downregulation", null).screen, "downregulation");
  const before = [...map];
  const state = display(day, { warm: 9, sustain: 8, cool: 7 }, null);
  assert.equal(state.screen, "idle");
  assert.deepEqual(state.blocks, blocks);
  assert.deepEqual([...map], before);
});

test("running workout projects frozen target rather than changed template", t => {
  const map = withSession(t, day, { ["phase_plan_" + day]: JSON.stringify(phasePlan) });
  const before = [...map];
  const state = display(day, { warm: 10, sustain: 20, cool: 30 }, start, true, 125);
  assert.equal(state.screen, "active");
  assert.equal(state.elapsedSec, 125);
  assert.equal(state.paused, true);
  assert.equal(state.phase.phaseId, "sustain");
  assert.equal(state.phaseDisplayName, "Workout");
  assert.deepEqual(state.resolvedPhaseTarget.expectedHeartRate, { min: 150, max: 160 });
  assert.equal(state.hrTargetTextValue, "150–160 bpm");
  assert.equal(state.activity, "bike");
  assert.deepEqual([...map], before);
});

test("unpaused clock and HR freshness boundaries retain existing semantics", t => {
  withSession(t, day, { ["phase_plan_" + day]: JSON.stringify(phasePlan) });
  const fresh = display(day, blocks, start, false, 1, 135, now - BPM_TIMEOUT_MS);
  assert.equal(fresh.elapsedSec, 90);
  assert.equal(fresh.phase.kind, "warmup");
  assert.equal(fresh.liveBpmStale, false);
  const stale = display(day, blocks, start, false, 1, 135, now - BPM_TIMEOUT_MS - 1);
  assert.equal(stale.liveBpmStale, true);
  assert.equal(display(day, blocks, start, false, 1, null, null).liveBpmStale, false);
});

test("completion and early cooldown use the canonical phase resolver", t => {
  const map = withSession(t, day, { ["phase_plan_" + day]: JSON.stringify(phasePlan) });
  assert.equal(display(day, blocks, start, true, 360).screen, "completed");
  map.set("early_cooldown_elapsed_" + day, "150");
  const state = display(day, blocks, start, true, 155);
  assert.equal(state.screen, "active");
  assert.equal(state.phase.kind, "cooldown");
  assert.equal(state.phase.timeLeft, 55);
  assert.equal(display(day, blocks, start, true, 210).screen, "completed");
});

test("freestyle stays active without finite target or shadow workload", t => {
  const selector = FREESTYLE_WORKOUT_SELECTOR_ID;
  withSession(t, selector);
  const state = display(selector, freestylePlanBlocks(), start, true, 7200);
  assert.equal(state.screen, "active");
  assert.equal(state.phase.phaseId, "freestyle_ride");
  assert.equal(state.phaseDisplayName, FREESTYLE_WORKOUT_LABEL);
  assert.equal(state.hrTargetTextValue, "");
  assert.equal(state.resolvedPhaseTarget, undefined);
  assert.equal(state.assessmentBasedWorkload, null);
});

test("legacy VO2 session requires restart without writing persisted runtime", t => {
  const selector = VO2_WORKOUT_SELECTOR_ID;
  const historical = JSON.stringify({ plan: {
    protocol_id: LEGACY_VO2_PROTOCOL_ID, protocol_version: LEGACY_VO2_PROTOCOL_VERSION_V1,
  }});
  const map = withSession(t, selector, { ["vo2_protocol_runtime_" + selector]: historical });
  assert.equal(display(selector, vo2PlanBlocks()).screen, "vo2_restart_required");
  assert.equal(map.get("vo2_protocol_runtime_" + selector), historical);
});

test("current VO2 runtime supplies protocol phase and never ordinary target advice", t => {
  const selector = VO2_WORKOUT_SELECTOR_ID;
  const plan = buildVo2ProtocolPlan();
  assert.ok(plan);
  const runtime = createVo2ProtocolRuntime(plan, { age_years: 40, weight_kg: 80 });
  const map = withSession(t, selector, { ["vo2_protocol_runtime_" + selector]: JSON.stringify(runtime) });
  const before = [...map];
  const state = display(selector, vo2PlanBlocks(), start, true, 90);
  assert.equal(state.screen, "active");
  assert.equal(state.phase.kind, "warmup");
  assert.equal(state.phaseDisplayName, vo2ProtocolDisplayName(state.phase));
  assert.equal(state.resolvedPhaseTarget, undefined);
  assert.equal(state.assessmentBasedWorkload, null);
  assert.deepEqual([...map], before);
});
