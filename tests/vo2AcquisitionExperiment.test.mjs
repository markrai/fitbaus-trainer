import assert from "node:assert/strict";
import test from "node:test";
import { startWorkout } from "../dist/workoutLogic.js";
import { getSession } from "../dist/sessionStore.js";
import { setSelectedMachine } from "../dist/machines/selection.js";
import { migrateLegacyProfile, storeAthleteProfile } from "../dist/profile.js";
import { installStandaloneVo2Workout } from "../dist/workoutData.js";
import { VO2_WORKOUT_SELECTOR_ID } from "../dist/vo2Protocol.js";
import {
  DEFAULT_VO2_ADAPTIVE_POLICY,
  VO2_ACQUISITION_EXPERIMENT_POLICY_OVERRIDE,
  planNextVo2Stage,
} from "../dist/vo2AdaptivePlanner.js";
import {
  VO2_ACQUISITION_EXPERIMENT_FLAG,
  buildVo2ProtocolPlanV3,
  isVo2AcquisitionExperimentEnabled,
  resolveVo2PreflightPolicyOverride,
} from "../dist/vo2ProtocolV3.js";
import {
  assessVo2,
  predictedHrMaxBpm,
} from "../dist/vo2Estimator.js";
import { measuredWorkloadForTests } from "../dist/vo2Workload.js";
import { getEstimatedWattsAt70Rpm } from "../dist/machines/proformSmartPower10.js";
import {
  VO2_EVIDENCE_SCHEMA_VERSION,
  VO2_PROTOCOL_VERSION_V3,
} from "../dist/types.js";

// TEMPORARY acquisition experiment (single real-bike session). Uses the real
// planner/estimator against the real ProForm table. Synthetic HR values for
// R5 are inference; R6/R7 match the observed failed session (age 46).
const AGE = 46;
const HRMAX = predictedHrMaxBpm(AGE);
const PROFILE = { age_years: AGE, weight_kg: 70 };
const EXPERIMENT = { ...VO2_ACQUISITION_EXPERIMENT_POLICY_OVERRIDE };

function plannerInput(overrides = {}) {
  return {
    eligible: [],
    predictedHrMax: HRMAX,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1]),
    calibration: getEstimatedWattsAt70Rpm,
    completedWorkStages: 0,
    retryCount: 0,
    policy: EXPERIMENT,
    ...overrides,
  };
}

function eligibleR5() {
  return {
    estimatorWatts: 82,
    steadyHrBpm: 114.1,
    calibratedWatts: 82,
    resistance: 5,
  };
}

function acceptedStage(id, resistance, calibratedWatts, estimatorWatts, hr) {
  return {
    stage_id: id,
    active_start_sec: 0,
    active_end_sec: 180,
    requested_watts: calibratedWatts,
    prescribed_resistance: resistance,
    calibrated_watts_at_70rpm: calibratedWatts,
    status: "accepted",
    nominal_duration_sec: 180,
    actual_duration_sec: 180,
    hr: {
      sample_count: 120,
      minute_2_mean_bpm: hr,
      minute_3_mean_bpm: hr,
      final_two_window_delta_bpm: 0,
      steady_state_bpm: hr,
    },
    workload: measuredWorkloadForTests(estimatorWatts, {
      calibrated_watts_at_70rpm: calibratedWatts,
    }),
  };
}

function evidenceV3(stages) {
  return {
    schema_version: VO2_EVIDENCE_SCHEMA_VERSION,
    active_duration_sec: 900,
    paused_duration_sec: 0,
    work_end_active_sec: 840,
    cooldown_start_active_sec: 840,
    early_cooldown: false,
    phases: [],
    hr: { source: "ble_chest_strap", sample_count: 200 },
    protocol: {
      protocol_id: "bike-submax-70rpm",
      protocol_version: VO2_PROTOCOL_VERSION_V3,
      prescribed_cadence_rpm: 70,
      stages,
      termination: { reason: "protocol_complete" },
      automatic_submax_hr_ceiling_available: false,
    },
  };
}

test("experiment override carries exactly the three pre-registered values", () => {
  assert.deepEqual({ ...EXPERIMENT }, {
    min_watt_increment: 1,
    min_watt_separation: 1,
    bootstrap_watt_step: 15,
  });
});

test("experiment disabled by default: resolver returns undefined without the flag", () => {
  assert.equal(isVo2AcquisitionExperimentEnabled(), false);
  assert.equal(resolveVo2PreflightPolicyOverride(), undefined);
});

test("experiment flag opt-in returns an isolated copy of the override", () => {
  const prevWindow = globalThis.window;
  globalThis.window = { [VO2_ACQUISITION_EXPERIMENT_FLAG]: true };
  try {
    assert.equal(isVo2AcquisitionExperimentEnabled(), true);
    const resolved = resolveVo2PreflightPolicyOverride();
    assert.deepEqual(resolved, {
      min_watt_increment: 1,
      min_watt_separation: 1,
      bootstrap_watt_step: 15,
    });
    assert.notEqual(resolved, VO2_ACQUISITION_EXPERIMENT_POLICY_OVERRIDE);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
  assert.equal(resolveVo2PreflightPolicyOverride(), undefined);
});

test("experimental plan persists the override in adaptive_policy for audit", () => {
  const plan = buildVo2ProtocolPlanV3(getEstimatedWattsAt70Rpm, EXPERIMENT);
  assert.ok(plan);
  assert.equal(plan.adaptive_policy.min_watt_increment, 1);
  assert.equal(plan.adaptive_policy.min_watt_separation, 1);
  assert.equal(plan.adaptive_policy.bootstrap_watt_step, 15);
  assert.equal(plan.adaptive_policy.safety_margin_bpm, DEFAULT_VO2_ADAPTIVE_POLICY.safety_margin_bpm);
  assert.equal(plan.adaptive_policy.max_work_stages, DEFAULT_VO2_ADAPTIVE_POLICY.max_work_stages);
  assert.equal(plan.adaptive_policy.policy_version, 1);
});

test("experiment selects the R5 region first on the ProForm table", () => {
  const decision = planNextVo2Stage(plannerInput());
  assert.equal(decision.decision, "next");
  assert.equal(decision.reason_code, "bootstrap_first_stage");
  assert.equal(decision.prescribed_resistance, 5);
  assert.equal(decision.calibrated_watts, 82);
});

test("experiment allows the 4 W R5->R6 calibrated step", () => {
  const r5 = eligibleR5();
  const decision = planNextVo2Stage(plannerInput({
    eligible: [r5],
    lastCompleted: {
      calibratedWatts: 82,
      estimatorWatts: 82,
      steadyHrBpm: 114.1,
      resistance: 5,
      aboveCeiling: false,
      eligible: true,
    },
    usedResistances: new Set([1, 5]),
    completedWorkStages: 1,
  }));
  assert.equal(decision.decision, "next");
  assert.equal(decision.prescribed_resistance, 6);
  assert.equal(decision.calibrated_watts, 86);
});

test("default policy does not take the R5->R6 step from the same state", () => {
  const r5 = eligibleR5();
  const decision = planNextVo2Stage(plannerInput({
    policy: { ...DEFAULT_VO2_ADAPTIVE_POLICY },
    eligible: [r5],
    lastCompleted: {
      calibratedWatts: 82,
      estimatorWatts: 82,
      steadyHrBpm: 114.1,
      resistance: 5,
      aboveCeiling: false,
      eligible: true,
    },
    usedResistances: new Set([1, 5]),
    completedWorkStages: 1,
  }));
  assert.equal(decision.decision, "next");
  assert.notEqual(decision.prescribed_resistance, 6);
});

test("estimator still rejects non-increasing measured watts", () => {
  const stages = [
    acceptedStage("vo2-stage:1", 5, 82, 82, 114.1),
    acceptedStage("vo2-stage:2", 6, 86, 82, 120.3),
    acceptedStage("vo2-stage:3", 7, 97, 97, 137.32),
  ];
  const result = assessVo2(evidenceV3(stages), PROFILE);
  assert.equal(result.status, "insufficient_evidence");
  assert.ok(result.reason_codes.includes("invalid_workload_progression"));
});

test("experiment still respects the planning ceiling after R6+R7", () => {
  const decision = planNextVo2Stage(plannerInput({
    eligible: [
      { estimatorWatts: 86, steadyHrBpm: 120.3, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 97, steadyHrBpm: 137.32, calibratedWatts: 97, resistance: 7 },
    ],
    lastCompleted: {
      calibratedWatts: 97,
      estimatorWatts: 97,
      steadyHrBpm: 137.32,
      resistance: 7,
      aboveCeiling: false,
      eligible: true,
    },
    usedResistances: new Set([1, 6, 7]),
    completedWorkStages: 2,
  }));
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "hr_safety_no_safe_target");
  assert.equal(decision.termination_reason, "submax_hr_ceiling");
});

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

// Full join: window flag -> beginWorkout -> preflight -> v3 runtime.
// Mirrors tests/vo2ProtocolV3Start.test.mjs; the flag is the only addition.
function installJoinFakes(withFlag) {
  const storage = memoryStorage();
  const prevStorage = globalThis.localStorage;
  const prevWindow = globalThis.window;
  globalThis.localStorage = storage;
  const now = Date.now();
  globalThis.window = {
    getSelectedDay: () => VO2_WORKOUT_SELECTOR_ID,
    generateUUID: () => "session-acquisition-experiment",
    hrDeviceName: "Test Strap",
    liveBpm: 80,
    lastBpmUpdateTime: now,
    ...(withFlag ? { [VO2_ACQUISITION_EXPERIMENT_FLAG]: true } : {}),
  };
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  const profile = migrateLegacyProfile({ age: 46, weight: 154 }, "athlete-acquisition", new Date(now).toISOString());
  assert.equal(storeAthleteProfile(profile, storage), true);
  installStandaloneVo2Workout();
  return () => {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  };
}

test("join: enabled flag produces a v3 runtime carrying 1 / 1 / 15", () => {
  const restore = installJoinFakes(true);
  try {
    startWorkout();
    const runtime = getSession(VO2_WORKOUT_SELECTOR_ID).vo2ProtocolRuntime;
    assert.ok(runtime);
    assert.equal(runtime.plan.protocol_version, VO2_PROTOCOL_VERSION_V3);
    assert.equal(runtime.plan.adaptive_policy.min_watt_increment, 1);
    assert.equal(runtime.plan.adaptive_policy.min_watt_separation, 1);
    assert.equal(runtime.plan.adaptive_policy.bootstrap_watt_step, 15);
    assert.equal(runtime.plan.adaptive_policy.safety_margin_bpm, 12);
    assert.equal(runtime.plan.adaptive_policy.max_work_stages, 4);
  } finally {
    restore();
  }
});

test("join: flag off produces the currently staged defaults, not the experiment", () => {
  // DEFAULT here is the staged worktree default (5 W bootstrap/runway),
  // not the main-branch 25 W rule that produced the original R6->R7 session.
  const restore = installJoinFakes(false);
  try {
    startWorkout();
    const runtime = getSession(VO2_WORKOUT_SELECTOR_ID).vo2ProtocolRuntime;
    assert.ok(runtime);
    assert.deepEqual({ ...runtime.plan.adaptive_policy }, { ...DEFAULT_VO2_ADAPTIVE_POLICY });
    assert.equal(runtime.plan.adaptive_policy.bootstrap_watt_step, 5);
  } finally {
    restore();
  }
});

test("experiment still refuses an unsafe higher stage after a hot R7", () => {
  const decision = planNextVo2Stage(plannerInput({
    eligible: [
      { estimatorWatts: 86, steadyHrBpm: 120.3, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 97, steadyHrBpm: 140, calibratedWatts: 97, resistance: 7 },
    ],
    lastCompleted: {
      calibratedWatts: 97,
      estimatorWatts: 97,
      steadyHrBpm: 140,
      resistance: 7,
      aboveCeiling: false,
      eligible: true,
    },
    usedResistances: new Set([1, 6, 7]),
    completedWorkStages: 2,
  }));
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "hr_safety_no_safe_target");
});
