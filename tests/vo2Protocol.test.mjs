import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import "fake-indexeddb/auto";
import {
  VO2_PROTOCOL_ID,
  VO2_PROTOCOL_VERSION,
  VO2_WORKOUT_SELECTOR_ID,
  VO2_WORKOUT_LABEL,
  VO2_WORKOUT_INTENT,
  VO2_PRESCRIBED_CADENCE_RPM,
  VO2_WARMUP_DURATION_SEC,
  VO2_COOLDOWN_DURATION_SEC,
  VO2_NOMINAL_STAGE_DURATION_SEC,
  VO2_MAX_STAGE_DURATION_SEC,
  VO2_MIN_HR_SAMPLES_PER_WINDOW,
  VO2_STEADY_STATE_DELTA_BPM,
  VO2_MAX_WORK_STAGES,
  VO2_TARGET_WORK_STAGES,
  VO2_PROTOCOL_MAX_RESISTANCE,
  VO2_MAX_EXTENSION_MINUTES,
  advanceVo2Protocol,
  authoritativeHrMaxBpm,
  buildVo2ProtocolEvidence,
  buildVo2ProtocolPlan,
  createVo2ProtocolRuntime as createVo2ProtocolRuntimeV2,
  evaluateStageHr,
  evaluateVo2Preflight,
  getVo2ProtocolPhase,
  isVo2WorkoutSelector,
  listCalibrated70RpmWorkloads,
  resolveNearestCalibratedWorkload,
  resolveProtocolWorkloads,
  vo2PlanBlocks,
  vo2ProtocolDisplayName,
  vo2ProtocolHoldForPhase,
  vo2ProtocolUiTargets,
  vo2WorkoutMetadata,
  parseVo2ProtocolRuntime,
  readPersistedVo2ProtocolRuntime,
  isValidVo2ProtocolRuntime,
  isLegacyVo2ProtocolRuntimeV1,
  isValidVo2ProtocolPlan,
} from "../dist/vo2Protocol.js";
import { installStandaloneVo2Workout as installVo2Workout, getPlan, getWorkoutMetadata } from "../dist/workoutData.js";
import {
  getPhase,
  markVo2ProtocolCancelled,
  markVo2ProtocolLimitReached,
  parseHrTargetRange,
  requestEarlyCooldown,
  requestVo2LimitReached,
  tickVo2Protocol,
  tickVo2ProtocolWithCanonicalHr,
} from "../dist/workoutLogic.js";
import {
  getSession,
  persistVo2ProtocolRuntime,
  startSession,
} from "../dist/sessionStore.js";
import { getEstimatedWattsAt70Rpm, AUTOMATIC_RESISTANCE_MAX } from "../dist/machines/proformSmartPower10.js";
import { toBridgeResistanceLevel } from "../dist/platform/bikeBridgeClient.js";
import { createMachineGuidanceState, getMachineGuidance } from "../dist/machines/guidance.js";
import { updateMachineGuidanceRuntime, resetMachineGuidanceRuntime } from "../dist/machines/runtime.js";
import { setSelectedMachine } from "../dist/machines/selection.js";
import {
  LEGACY_VO2_PROTOCOL_VERSION_V1,
  VO2_EVIDENCE_SCHEMA_VERSION,
} from "../dist/types.js";
import { buildVo2Evidence } from "../dist/vo2Evidence.js";
import { assessVo2 } from "../dist/vo2Estimator.js";
import {
  getAllWorkoutSummaries,
  getHrSamples,
  resetWorkoutStorageForTests,
  storeHrSample,
  storeWorkoutSummary,
} from "../dist/workoutStorage.js";
import { buildSisuWorkoutPayload } from "../dist/sisuSync.js";

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

function samplesInRange(start, end, bpm) {
  const samples = [];
  for (let t = start; t <= end; t++) samples.push({ timestamp_sec: t, hr: bpm });
  return samples;
}

function stageHr(stageStart, minute2Bpm, minute3Bpm) {
  return [
    ...samplesInRange(stageStart + 60, stageStart + 119, minute2Bpm),
    ...samplesInRange(stageStart + 120, stageStart + 179, minute3Bpm),
  ];
}

function stageTelemetry(stageStart, durationSec, watts, rpm = 70) {
  const end = stageStart + durationSec;
  const samples = [];
  for (let t = end - 119; t <= end; t++) samples.push({ timestamp_sec: t, rpm, watts });
  return samples;
}

const assessmentProfile = { age_years: 40, weight_kg: 80 };
const createVo2ProtocolRuntime = (plan, profile = assessmentProfile) =>
  createVo2ProtocolRuntimeV2(plan, profile);

function completeStableStage(runtime, bpm, options = {}) {
  const open = runtime.stages.find((stage) => stage.status === "open");
  assert.ok(open);
  const planned = runtime.plan.workloads[open.workloadIndex];
  const telemetrySamples = options.telemetrySamples ?? stageTelemetry(
    open.active_start_sec,
    180,
    options.includeWatts === false ? undefined : planned.calibrated_watts_at_70rpm,
    options.rpm ?? 70
  );
  return advanceVo2Protocol(runtime, {
    elapsedSec: open.active_start_sec + 180,
    paused: false,
    samples: stageHr(open.active_start_sec, bpm, bpm),
    telemetrySamples,
  });
}

function assessmentFromRuntime(runtime) {
  const protocol = buildVo2ProtocolEvidence(runtime);
  return assessVo2(
    {
      schema_version: VO2_EVIDENCE_SCHEMA_VERSION,
      active_duration_sec: runtime.cooldown_start_sec ?? 0,
      paused_duration_sec: 0,
      work_end_active_sec: runtime.cooldown_start_sec,
      cooldown_start_active_sec: runtime.cooldown_start_sec,
      early_cooldown: false,
      phases: [],
      hr: { source: "ble_chest_strap", sample_count: 360 },
      protocol,
    },
    assessmentProfile
  );
}

function freshHrInput(overrides = {}) {
  const now = Date.now();
  return {
    hrDeviceConnected: true,
    liveBpm: 118,
    lastBpmUpdateTime: now,
    now,
    activityMachineId: "proform-smart-power-10",
    profile: { age_years: 40, weight_kg: 80 },
    ...overrides,
  };
}

test("protocol id and version are stable and not tied to app version", async () => {
  assert.equal(VO2_PROTOCOL_ID, "bike-submax-70rpm");
  assert.equal(VO2_PROTOCOL_VERSION, 2);
  assert.equal(LEGACY_VO2_PROTOCOL_VERSION_V1, 1);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.notEqual(String(VO2_PROTOCOL_VERSION), pkg.version);
  assert.equal(VO2_PRESCRIBED_CADENCE_RPM, 70);
  assert.equal(VO2_WARMUP_DURATION_SEC, 300);
  assert.equal(VO2_NOMINAL_STAGE_DURATION_SEC, 180);
  assert.equal(VO2_MAX_STAGE_DURATION_SEC, 300);
  assert.equal(VO2_MIN_HR_SAMPLES_PER_WINDOW, 45);
  assert.equal(VO2_STEADY_STATE_DELTA_BPM, 5);
  assert.equal(VO2_MAX_WORK_STAGES, 4);
  assert.equal(VO2_COOLDOWN_DURATION_SEC, 300);
  assert.equal(VO2_PROTOCOL_MAX_RESISTANCE, 10);
  assert.equal(VO2_MAX_EXTENSION_MINUTES, 2);
});

test("standalone selector maps to the versioned bike protocol", () => {
  const monday = getPlan().Monday;
  installVo2Workout();
  assert.equal(isVo2WorkoutSelector(VO2_WORKOUT_SELECTOR_ID), true);
  assert.equal(VO2_WORKOUT_LABEL, "VO2 Max Estimation");
  assert.equal(getWorkoutMetadata()[VO2_WORKOUT_SELECTOR_ID].intent, VO2_WORKOUT_INTENT);
  assert.deepEqual(getWorkoutMetadata()[VO2_WORKOUT_SELECTOR_ID].activities, ["bike"]);
  assert.equal(getWorkoutMetadata()[VO2_WORKOUT_SELECTOR_ID].type, VO2_WORKOUT_LABEL);
  assert.equal(vo2WorkoutMetadata().intent, "vo2_estimation");
  assert.equal(getPlan().Monday, monday);
});

test("preflight requires recent HR, explicit profile, calibrated bike profile, and three workloads", () => {
  const ok = evaluateVo2Preflight(freshHrInput());
  assert.equal(ok.ok, true);

  const noHr = evaluateVo2Preflight(freshHrInput({ hrDeviceConnected: false, liveBpm: null }));
  assert.equal(noHr.ok, false);
  assert.match(noHr.message, /Heart-rate strap required/);

  const stale = evaluateVo2Preflight(freshHrInput({ lastBpmUpdateTime: Date.now() - 4000 }));
  assert.equal(stale.ok, false);

  const noProfile = evaluateVo2Preflight(freshHrInput({ profile: undefined }));
  assert.equal(noProfile.ok, false);
  assert.match(noProfile.message, /Settings → Profile/);

  const noMachine = evaluateVo2Preflight(freshHrInput({ activityMachineId: undefined }));
  assert.equal(noMachine.ok, false);
  assert.match(noMachine.message, /No calibrated 70 RPM bike profile selected/);

  const fewWatts = evaluateVo2Preflight(
    freshHrInput({
      getWatts(resistance) {
        if (resistance === 1) return 66;
        if (resistance === 2) return 69;
        return undefined;
      },
    })
  );
  assert.equal(fewWatts.ok, false);
  assert.match(fewWatts.message, /Not enough calibrated workload levels/);
});

test("Bike Bridge disabled does not prevent preflight start", () => {
  const result = evaluateVo2Preflight(freshHrInput());
  assert.equal(result.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(freshHrInput(), "bikeBridge"), false);
});

test("nominal watts resolve through canonical calibration and strictly increase", () => {
  const plan = buildVo2ProtocolPlan();
  assert.ok(plan);
  const warmupWatts = plan.warmup_calibrated_watts_at_70rpm;
  assert.equal(plan.warmup_resistance, 1);
  assert.equal(warmupWatts, getEstimatedWattsAt70Rpm(1));
  assert.equal(plan.workloads[0].requested_watts, warmupWatts + 25);
  assert.ok(plan.workloads[0].calibrated_watts_at_70rpm > warmupWatts);

  const resolved = resolveProtocolWorkloads();
  assert.ok(resolved.length >= VO2_TARGET_WORK_STAGES);
  const resistances = new Set([plan.warmup_resistance]);
  let lastWatts = warmupWatts;
  const table = new Set(listCalibrated70RpmWorkloads().map((row) => row.calibrated_watts_at_70rpm));
  for (const row of resolved) {
    assert.ok(row.calibrated_watts_at_70rpm > lastWatts);
    assert.equal(resistances.has(row.prescribed_resistance), false);
    resistances.add(row.prescribed_resistance);
    assert.ok(table.has(row.calibrated_watts_at_70rpm));
    assert.equal(row.calibrated_watts_at_70rpm, getEstimatedWattsAt70Rpm(row.prescribed_resistance));
    lastWatts = row.calibrated_watts_at_70rpm;
  }
});

test("historical v1 runtime is identified and fails closed instead of resuming with v2 semantics", () => {
  const currentPlan = buildVo2ProtocolPlan();
  assert.deepEqual(currentPlan.workloads.map((workload) => workload.prescribed_resistance), [6, 8, 9, 10]);
  const historicalPlan = {
    ...structuredClone(currentPlan),
    protocol_version: 1,
    workloads: [
      currentPlan.workloads[0],
      currentPlan.workloads[1],
      {
        ...currentPlan.workloads[3],
        requested_watts: currentPlan.workloads[1].calibrated_watts_at_70rpm + 25,
      },
    ],
  };
  assert.deepEqual(historicalPlan.workloads.map((workload) => workload.prescribed_resistance), [6, 8, 10]);
  const historicalRuntime = {
    plan: historicalPlan,
    segment: "work",
    stages: [{
      stage_id: "vo2-stage:1",
      workloadIndex: 0,
      active_start_sec: 300,
      active_end_sec: null,
      extensions: 0,
      status: "open",
      last_eval_relative_sec: 0,
      upcoming_announced: false,
      extension_announced: false,
    }],
    cooldown_start_sec: null,
    start_announced: true,
    upcoming_warmup_announced: true,
  };
  assert.equal(isLegacyVo2ProtocolRuntimeV1(historicalRuntime), true);
  assert.deepEqual(readPersistedVo2ProtocolRuntime(historicalRuntime), {
    runtime: null,
    restartRequired: true,
    observedProtocolVersion: 1,
  });
  assert.equal(parseVo2ProtocolRuntime(historicalRuntime), null);

  const storage = memoryStorage();
  startSession(VO2_WORKOUT_SELECTOR_ID, Date.now(), "historical-v1-runtime", "bike", storage, {
    blocks: vo2PlanBlocks(),
    hrTargets: null,
  });
  const frozen = JSON.stringify(historicalRuntime);
  storage.setItem(`vo2_protocol_runtime_${VO2_WORKOUT_SELECTOR_ID}`, frozen);
  const session = getSession(VO2_WORKOUT_SELECTOR_ID, storage);
  assert.equal(session.vo2ProtocolRuntime, null);
  assert.equal(session.vo2ProtocolRestartRequired, true);
  assert.equal(session.blockedVo2ProtocolVersion, 1);
  assert.equal(tickVo2Protocol(VO2_WORKOUT_SELECTOR_ID, 480, false, storage, stageHr(300, 120, 120)), null);
  assert.equal(storage.getItem(`vo2_protocol_runtime_${VO2_WORKOUT_SELECTOR_ID}`), frozen);
});

test("three stable estimator-eligible stages complete collection and estimate", () => {
  const plan = buildVo2ProtocolPlan();
  assert.equal(plan.workloads.length, 4);
  assert.deepEqual(plan.workloads.map((stage) => stage.prescribed_resistance), [6, 8, 9, 10]);
  let runtime = createVo2ProtocolRuntime(plan, assessmentProfile);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  for (let i = 0; i < 3; i++) {
    const open = runtime.stages.find((stage) => stage.status === "open");
    const watts = runtime.plan.workloads[open.workloadIndex].calibrated_watts_at_70rpm;
    runtime = completeStableStage(runtime, 77 + 0.5 * watts);
  }
  assert.equal(runtime.segment, "cooldown");
  assert.equal(runtime.termination.reason, "protocol_complete");
  assert.equal(runtime.stages.filter((stage) => stage.status === "accepted").length, 3);
  const assessment = assessmentFromRuntime(runtime);
  assert.equal(assessment.status, "estimated");
  assert.equal(assessment.eligible_stage_count, 3);
});

test("three stable stages with only two eligible continue to the reserved fourth workload", () => {
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan, assessmentProfile);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  runtime = completeStableStage(runtime, 120);
  runtime = completeStableStage(runtime, 125, { telemetrySamples: [] });
  runtime = completeStableStage(runtime, 134);
  assert.equal(runtime.segment, "work");
  assert.equal(runtime.stages.length, 4);
  assert.equal(runtime.stages[3].status, "open");
  assert.equal(plan.workloads[runtime.stages[3].workloadIndex].prescribed_resistance, 10);

  runtime = completeStableStage(runtime, 138.5);
  assert.equal(runtime.segment, "cooldown");
  assert.equal(runtime.termination.reason, "protocol_complete");
  const assessment = assessmentFromRuntime(runtime);
  assert.equal(assessment.eligible_stage_count, 3);
  assert.equal(assessment.diagnostics.stage_points[1].estimator_eligible, false);
  assert.equal(
    assessment.diagnostics.stage_points[1].ineligibility_reasons.includes("insufficient_workload_samples"),
    true
  );
});

test("collection terminates explicitly when four attempts still yield fewer than three eligible stages", () => {
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan, assessmentProfile);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  runtime = completeStableStage(runtime, 120);
  runtime = completeStableStage(runtime, 125, { telemetrySamples: [] });
  runtime = completeStableStage(runtime, 134);
  runtime = completeStableStage(runtime, 138.5, { telemetrySamples: [] });
  assert.equal(runtime.segment, "cooldown");
  assert.equal(runtime.termination.reason, "insufficient_eligible_stages");
  const assessment = assessmentFromRuntime(runtime);
  assert.equal(assessment.accepted_stage_count, 4);
  assert.equal(assessment.eligible_stage_count, 2);
  assert.equal(assessment.status, "insufficient_evidence");
});

test("stable stage at the predicted submaximal ceiling stops safely with its reason preserved", () => {
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan, assessmentProfile);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  runtime = completeStableStage(runtime, 120);
  runtime = completeStableStage(runtime, 131);
  runtime = completeStableStage(runtime, 153);
  assert.equal(runtime.segment, "cooldown");
  assert.equal(runtime.termination.reason, "submax_hr_ceiling");
  assert.equal(runtime.stages.length, 3);
  assert.equal(buildVo2ProtocolEvidence(runtime).automatic_submax_hr_ceiling_available, true);
  const assessment = assessmentFromRuntime(runtime);
  assert.equal(assessment.eligible_stage_count, 2);
  assert.equal(assessment.diagnostics.stage_points[2].hr_stability_passed, true);
  assert.equal(assessment.diagnostics.stage_points[2].submax_hr_eligible, false);
  assert.deepEqual(assessment.diagnostics.stage_points[2].ineligibility_reasons, ["hr_above_submax_ceiling"]);
});

test("cadence-qualified workload rejection is explicit and does not count as collection success", () => {
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan, assessmentProfile);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  runtime = completeStableStage(runtime, 120);
  runtime = completeStableStage(runtime, 131, { includeWatts: false, rpm: 90 });
  runtime = completeStableStage(runtime, 134);
  assert.equal(runtime.segment, "work");
  const attempted = assessmentFromRuntime({
    ...runtime,
    segment: "cooldown",
    cooldown_start_sec: runtime.stages[2].active_end_sec,
    termination: { reason: "insufficient_eligible_stages" },
  });
  const rejected = attempted.diagnostics.stage_points[1];
  assert.equal(rejected.hr_stability_passed, true);
  assert.equal(rejected.workload_evidence_passed, false);
  assert.equal(rejected.ineligibility_reasons.includes("cadence_outside_verified_range"), true);
});

test("protocol_complete always implies at least three stages under the estimator's shared eligibility policy", () => {
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan, assessmentProfile);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  runtime = completeStableStage(runtime, 120);
  runtime = completeStableStage(runtime, 131);
  runtime = completeStableStage(runtime, 134);
  assert.equal(runtime.termination.reason, "protocol_complete");
  assert.ok(assessmentFromRuntime(runtime).eligible_stage_count >= VO2_TARGET_WORK_STAGES);
});

test("duplicate calibrated resistance is not emitted twice and no extrapolation occurs", () => {
  const getWatts = (resistance) => {
    if (resistance === 1 || resistance === 2) return 66;
    if (resistance === 3) return 80;
    if (resistance === 4) return 100;
    return undefined;
  };
  const resolved = resolveProtocolWorkloads(getWatts);
  const resistances = resolved.map((row) => row.prescribed_resistance);
  assert.deepEqual(resistances, [...new Set(resistances)]);
  assert.ok(resolved.every((row) => row.prescribed_resistance >= 1 && row.prescribed_resistance <= 4));
  const far = resolveNearestCalibratedWorkload(900, { getWatts });
  assert.ok(far);
  assert.ok([66, 80, 100].includes(far.calibrated_watts_at_70rpm));
  assert.notEqual(far.calibrated_watts_at_70rpm, 900);
});

test("nominal stage lasts 180 active seconds; pause freezes; resume continues; transitions use active clock", () => {
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 299, paused: false, samples: [] });
  assert.equal(runtime.segment, "warmup");
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  assert.equal(runtime.segment, "work");
  assert.equal(runtime.stages[0].active_start_sec, 300);
  const phase = getVo2ProtocolPhase(300, runtime);
  assert.equal(phase.phaseDurationSeconds, 180);
  assert.equal(phase.phaseId, "vo2-stage:1");

  runtime = advanceVo2Protocol(runtime, { elapsedSec: 400, paused: true, samples: [] });
  assert.equal(runtime.stages[0].status, "open");
  assert.equal(runtime.stages[0].last_eval_relative_sec, 0);

  runtime = advanceVo2Protocol(runtime, { elapsedSec: 479, paused: false, samples: [] });
  assert.equal(runtime.stages[0].status, "open");
  runtime = advanceVo2Protocol(runtime, {
    elapsedSec: 480,
    paused: false,
    samples: stageHr(300, 120, 121),
  });
  assert.equal(runtime.stages[0].status, "accepted");
  assert.equal(runtime.stages[0].active_end_sec, 480);
  assert.equal(runtime.stages[1].active_start_sec, 480);
  const throughGetPhase = getPhase(480, vo2PlanBlocks(), null, { vo2Protocol: runtime });
  assert.equal(throughGetPhase.phaseId, "vo2-stage:2");
});

test("minute-2/minute-3 means use raw HR; <=5 bpm accepts; >5 extends; no interpolation", () => {
  const start = 300;
  const steady = evaluateStageHr(stageHr(start, 130, 134), start, start + 180);
  assert.equal(steady.coverage_ok, true);
  assert.equal(Math.round(steady.minute_2_mean_bpm), 130);
  assert.equal(Math.round(steady.minute_3_mean_bpm), 134);
  assert.equal(steady.steady, true);
  assert.equal(steady.steady_state_bpm, 134);

  const unstable = evaluateStageHr(stageHr(start, 120, 130), start, start + 180);
  assert.equal(unstable.steady, false);
  assert.ok(unstable.final_two_window_delta_bpm > 5);

  const sparse = evaluateStageHr(
    [
      { timestamp_sec: start + 60, hr: 120 },
      { timestamp_sec: start + 119, hr: 120 },
      { timestamp_sec: start + 120, hr: 125 },
      { timestamp_sec: start + 179, hr: 125 },
    ],
    start,
    start + 180
  );
  assert.equal(sparse.coverage_ok, false);
  assert.equal(sparse.steady, false);
  assert.equal(sparse.minute_2_mean_bpm, 120);
  assert.equal(sparse.minute_3_mean_bpm, 125);

  const reeval = evaluateStageHr(
    [
      ...stageHr(start, 110, 130),
      ...samplesInRange(start + 180, start + 239, 140),
    ],
    start,
    start + 240
  );
  assert.equal(Math.round(reeval.minute_2_mean_bpm), 130);
  assert.equal(Math.round(reeval.minute_3_mean_bpm), 140);
  assert.equal(reeval.steady, false);

  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  runtime = advanceVo2Protocol(runtime, {
    elapsedSec: 480,
    paused: false,
    samples: stageHr(300, 110, 130),
  });
  assert.equal(runtime.stages[0].status, "open");
  assert.equal(runtime.stages[0].extensions, 1);
  const extendedPhase = getVo2ProtocolPhase(480, runtime);
  assert.match(extendedPhase.detailName, /extension/);

  runtime = advanceVo2Protocol(runtime, {
    elapsedSec: 540,
    paused: false,
    samples: [
      ...stageHr(300, 110, 130),
      ...samplesInRange(480, 539, 140),
    ],
  });
  assert.equal(runtime.stages[0].extensions, 2);

  runtime = advanceVo2Protocol(runtime, {
    elapsedSec: 600,
    paused: false,
    samples: [
      ...stageHr(300, 110, 130),
      ...samplesInRange(480, 539, 140),
      ...samplesInRange(540, 599, 152),
    ],
  });
  assert.equal(runtime.stages[0].status, "unstable_hr");
  assert.equal(runtime.stages[0].active_end_sec - runtime.stages[0].active_start_sec, 300);
  assert.equal(runtime.stages[0].hr.steady_state_bpm, undefined);

  const insufficient = evaluateStageHr(samplesInRange(start + 60, start + 104, 120), start, start + 180);
  assert.equal(insufficient.coverage_ok, false);
  assert.equal(insufficient.steady, false);
});

test("protocol evidence stores prescribed resistance, calibrated watts, and prescribed 70 RPM", () => {
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  runtime = advanceVo2Protocol(runtime, {
    elapsedSec: 480,
    paused: false,
    samples: stageHr(300, 122, 123),
  });
  const evidence = buildVo2ProtocolEvidence(runtime);
  assert.ok(evidence);
  assert.equal(evidence.protocol_id, "bike-submax-70rpm");
  assert.equal(evidence.protocol_version, 2);
  assert.equal(evidence.prescribed_cadence_rpm, 70);
  const stage = evidence.stages[0];
  assert.equal(stage.prescribed_resistance, plan.workloads[0].prescribed_resistance);
  assert.equal(stage.calibrated_watts_at_70rpm, plan.workloads[0].calibrated_watts_at_70rpm);
  assert.equal(stage.status, "accepted");
  assert.equal(stage.hr.steady_state_bpm, 123);
  assert.equal(stage.hr.sample_count > 0, true);
  assert.equal(Object.prototype.hasOwnProperty.call(stage, "measured_cadence_rpm"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stage, "measured_watts"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(evidence, "measured_cadence_rpm"), false);
  assert.equal(VO2_EVIDENCE_SCHEMA_VERSION, 2);

  runtime = advanceVo2Protocol(runtime, { elapsedSec: 500, paused: false, samples: [], cancelled: true });
  const cancelled = buildVo2ProtocolEvidence(runtime);
  assert.ok(cancelled);
  assert.equal(cancelled.termination.reason, "user_cancelled");
  assert.ok(cancelled.stages.some((entry) => entry.status === "incomplete" || entry.status === "accepted"));
});

test("predicted ceiling is explicit without claiming authoritative HRmax; Early Cooldown and Cancel preserve termination", () => {
  assert.equal(authoritativeHrMaxBpm(), undefined);
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 400, paused: false, samples: [], earlyCooldownElapsed: 400 });
  assert.equal(runtime.termination.reason, "early_cooldown");
  assert.equal(runtime.segment, "cooldown");
  assert.equal(buildVo2ProtocolEvidence(runtime).automatic_submax_hr_ceiling_available, true);
  assert.notEqual(runtime.termination.reason, "submax_hr_ceiling");

  const storage = memoryStorage();
  const start = Date.now();
  startSession(VO2_WORKOUT_SELECTOR_ID, start, "vo2-cancel", "bike", storage, {
    blocks: vo2PlanBlocks(),
    hrTargets: null,
  });
  persistVo2ProtocolRuntime(VO2_WORKOUT_SELECTOR_ID, createVo2ProtocolRuntime(plan), storage);
  markVo2ProtocolCancelled(VO2_WORKOUT_SELECTOR_ID, 120, storage);
  assert.equal(getSession(VO2_WORKOUT_SELECTOR_ID, storage).vo2ProtocolRuntime.termination.reason, "user_cancelled");

  const ecdStorage = memoryStorage();
  startSession(VO2_WORKOUT_SELECTOR_ID, start, "vo2-ecd", "bike", ecdStorage, {
    blocks: vo2PlanBlocks(),
    hrTargets: null,
  });
  let live = createVo2ProtocolRuntime(plan);
  live = advanceVo2Protocol(live, { elapsedSec: 300, paused: false, samples: [] });
  persistVo2ProtocolRuntime(VO2_WORKOUT_SELECTOR_ID, live, ecdStorage);
  const previousDay = globalThis.window.getSelectedDay;
  globalThis.window.getSelectedDay = () => VO2_WORKOUT_SELECTOR_ID;
  const decision = requestEarlyCooldown(VO2_WORKOUT_SELECTOR_ID, {
    storage: ecdStorage,
    now: start + 400_000,
    blocks: vo2PlanBlocks(),
  });
  globalThis.window.getSelectedDay = previousDay;
  assert.equal(decision.type, "enter-early-cooldown");
  assert.equal(
    getSession(VO2_WORKOUT_SELECTOR_ID, ecdStorage).vo2ProtocolRuntime.termination.reason,
    "early_cooldown"
  );
});

test("hold resistance uses existing machine guidance; protocol does not talk to Bike Bridge", async () => {
  const src = await readFile(new URL("../src/vo2Protocol.ts", import.meta.url), "utf8");
  assert.equal(src.includes("bikeBridgeClient"), false);
  assert.equal(src.includes("createBikeBridgeSession"), false);
  assert.equal(src.includes("/api/v1/resistance"), false);
  assert.equal(/220\s*-\s*age/.test(src), false);
  assert.equal(/Astrand|YMCA|ml\/kg\/min/.test(src), false);

  const held = getMachineGuidance(
    {
      machineId: "proform-smart-power-10",
      activity: "bike",
      phaseKind: "work",
      phaseId: "vo2-stage:1",
      phaseElapsedSeconds: 90,
      phaseDurationSeconds: 180,
      workoutElapsedSeconds: 390,
      targetHeartRateMin: 90,
      targetHeartRateMax: 100,
      recentHeartRates: Array.from({ length: 20 }, (_, i) => ({ elapsedSeconds: 370 + i, bpm: 170 })),
      holdResistance: 4,
      holdCadenceRpm: 70,
    },
    createMachineGuidanceState()
  );
  assert.ok(held);
  assert.equal(held.guidance.resistance, 4);
  assert.equal(held.guidance.cadenceRpm, 70);
  assert.equal(held.guidance.estimatedWatts, getEstimatedWattsAt70Rpm(4));
  assert.equal(held.guidance.reason, "Fixed protocol resistance");

  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("hold-session");
  const update = updateMachineGuidanceRuntime(
    {
      sessionId: "hold-session",
      activity: "bike",
      phaseKind: "work",
      phaseId: "vo2-stage:1",
      phaseDisplayName: "VO2 stage 1",
      phaseElapsedSeconds: 10,
      phaseDurationSeconds: 180,
      workoutElapsedSeconds: 310,
      holdResistance: 6,
      holdCadenceRpm: 70,
      intent: "vo2_estimation",
    },
    storage
  );
  assert.ok(update);
  assert.equal(update.guidance.resistance, 6);
  assert.equal(update.guidance.cadenceRpm, 70);
});

test("protocol evidence survives IndexedDB; historical and ordinary vo2_evidence still load; SISU still strips evidence", async () => {
  await resetWorkoutStorageForTests();
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  runtime = advanceVo2Protocol(runtime, {
    elapsedSec: 480,
    paused: false,
    samples: stageHr(300, 118, 119),
  });
  const protocol = buildVo2ProtocolEvidence(runtime);
  const evidence = buildVo2Evidence({
    day: VO2_WORKOUT_SELECTOR_ID,
    activity: "bike",
    intent: "vo2_estimation",
    blocks: vo2PlanBlocks(),
    activeDurationSec: 480,
    pausedDurationSec: 0,
    hrSamples: stageHr(300, 118, 119).map((sample) => ({ ...sample, session_id: "vo2-idb" })),
    vo2Protocol: runtime,
    protocol,
  });
  assert.equal(evidence.schema_version, 2);
  assert.equal(evidence.protocol.protocol_id, "bike-submax-70rpm");
  const summary = {
    external_session_id: "vo2-idb",
    startedAt: "2026-08-28T00:00:00.000Z",
    endedAt: "2026-08-28T00:08:00.000Z",
    category: "cardio",
    intent: "vo2_estimation",
    duration_minutes: 8,
    primary_zone: 2,
    stress_profile: "low",
    zone_minutes: { z1: 0, z2: 8, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: VO2_WORKOUT_SELECTOR_ID,
    vo2_evidence: evidence,
    vo2_assessment: {
      schema_version: 1,
      estimator_id: "bike-submax-linear-hr-workload",
      estimator_version: 1,
      status: "estimated",
      termination_reason: "protocol_complete",
      estimate_ml_kg_min: 40.75,
      reason_codes: [],
      accepted_stage_count: 1,
      stages_used: ["vo2-stage:1"],
      input_snapshot: { age_years: 40, weight_kg: 80 },
      diagnostics: { accepted_points: [], min_r_squared: 0.7 },
    },
  };
  await storeWorkoutSummary(summary);
  const loadedRows = await getAllWorkoutSummaries();
  const loaded = loadedRows.find((row) => row.summary?.external_session_id === "vo2-idb");
  assert.ok(loaded);
  assert.deepEqual(loaded.summary.vo2_evidence.protocol, protocol);
  assert.equal(loaded.summary.vo2_assessment.status, "estimated");
  assert.equal(loaded.summary.vo2_assessment.estimate_ml_kg_min, 40.75);

  const ordinary = buildVo2Evidence({
    day: "Monday",
    blocks: { warm: 5, sustain: 25, cool: 5 },
    activeDurationSec: 600,
    pausedDurationSec: 0,
    hrSamples: [{ session_id: "ordinary", timestamp_sec: 10, hr: 110 }],
  });
  assert.equal(ordinary.protocol, undefined);
  await storeWorkoutSummary({
    ...summary,
    external_session_id: "ordinary-idb",
    day: "Monday",
    intent: "endurance",
    vo2_evidence: ordinary,
  });
  const ordinaryLoaded = (await getAllWorkoutSummaries()).find(
    (row) => row.summary?.external_session_id === "ordinary-idb"
  );
  assert.equal(ordinaryLoaded.summary.vo2_evidence.protocol, undefined);

  await storeWorkoutSummary({
    external_session_id: "historical-idb",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:30:00.000Z",
    category: "cardio",
    intent: "legacy",
    duration_minutes: 30,
    primary_zone: 2,
    stress_profile: "low",
    zone_minutes: { z1: 0, z2: 30, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Tuesday",
  });
  const historical = (await getAllWorkoutSummaries()).find(
    (row) => row.summary?.external_session_id === "historical-idb"
  );
  assert.equal(historical.summary.vo2_evidence, undefined);

  const payload = buildSisuWorkoutPayload(summary);
  assert.equal(payload.vo2_evidence, undefined);
  assert.equal(payload.vo2_assessment, undefined);
  assert.ok(summary.vo2_evidence.protocol);
  assert.ok(summary.vo2_assessment);
  await resetWorkoutStorageForTests();
});

test("frozen protocol plan keeps calibration A after calibration B changes", () => {
  const calibrationA = (resistance) => {
    if (resistance === 1) return 66;
    if (resistance === 2) return 91;
    if (resistance === 3) return 116;
    if (resistance === 4) return 141;
    return undefined;
  };
  const plan = buildVo2ProtocolPlan(calibrationA);
  assert.ok(plan);
  let runtime = createVo2ProtocolRuntime(plan);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  assert.equal(runtime.stages.length, 1);
  const frozenResistance = runtime.plan.workloads[0].prescribed_resistance;
  const frozenWatts = runtime.plan.workloads[0].calibrated_watts_at_70rpm;
  const restored = parseVo2ProtocolRuntime(JSON.parse(JSON.stringify(runtime)));
  assert.ok(restored);
  const calibrationB = (resistance) => {
    if (resistance === 1) return 200;
    if (resistance === 2) return 250;
    if (resistance === 3) return 300;
    if (resistance === 4) return 350;
    return undefined;
  };
  const laterPlan = buildVo2ProtocolPlan(calibrationB);
  assert.ok(laterPlan);
  assert.notEqual(laterPlan.workloads[0].calibrated_watts_at_70rpm, frozenWatts);
  restored.stages[0].status = "accepted";
  restored.stages[0].active_end_sec = 480;
  const evidence = buildVo2ProtocolEvidence(restored);
  assert.ok(evidence);
  assert.equal(evidence.stages.length, 1);
  assert.equal(evidence.stages[0].prescribed_resistance, frozenResistance);
  assert.equal(evidence.stages[0].calibrated_watts_at_70rpm, frozenWatts);
  assert.notEqual(evidence.stages[0].calibrated_watts_at_70rpm, laterPlan.workloads[0].calibrated_watts_at_70rpm);
});

test("weekly workout phase planner is unchanged without protocol runtime", () => {
  const blocks = { warm: 5, sustain: 25, cool: 5 };
  const warmup = getPhase(10, blocks, null, { day: "Monday", vo2Protocol: null });
  assert.equal(warmup.phase, "Warm-Up");
  const sustain = getPhase(400, blocks, null, { day: "Monday", vo2Protocol: null });
  assert.equal(sustain.phase, "Sustain");
  const cool = getPhase(1900, blocks, null, { day: "Monday", vo2Protocol: null });
  assert.equal(cool.phase, "Cool-Down");
});

async function persistRange(sessionId, start, end, bpm) {
  for (let t = start; t <= end; t++) await storeHrSample(sessionId, t, bpm);
}

test("canonical HR survives protocol reload and protocol owns no second raw-HR recorder", async () => {
  const src = await readFile(new URL("../src/vo2Protocol.ts", import.meta.url), "utf8");
  const ui = await readFile(new URL("../src/uiControls.ts", import.meta.url), "utf8");
  assert.equal(src.includes("hrBuffers"), false);
  assert.equal(src.includes("recordVo2ProtocolHeartRate"), false);
  assert.equal(src.includes("vo2ProtocolHrSamples"), false);
  assert.equal(ui.includes("recordVo2ProtocolHeartRate"), false);

  await resetWorkoutStorageForTests();
  const sessionId = "vo2-reload-hr";
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  await persistRange(sessionId, 360, 419, 122);
  const restored = parseVo2ProtocolRuntime(JSON.parse(JSON.stringify(runtime)));
  assert.ok(restored);
  await persistRange(sessionId, 420, 479, 123);
  const canonical = await getHrSamples(sessionId);
  const afterReload = advanceVo2Protocol(restored, {
    elapsedSec: 480,
    paused: false,
    samples: canonical,
  });
  let uninterrupted = createVo2ProtocolRuntime(plan);
  uninterrupted = advanceVo2Protocol(uninterrupted, { elapsedSec: 300, paused: false, samples: [] });
  uninterrupted = advanceVo2Protocol(uninterrupted, {
    elapsedSec: 480,
    paused: false,
    samples: canonical,
  });
  assert.equal(afterReload.stages[0].status, "accepted");
  assert.equal(afterReload.stages[0].status, uninterrupted.stages[0].status);
  assert.equal(afterReload.stages[0].hr.steady_state_bpm, 123);
  assert.equal(afterReload.stages[0].hr.steady_state_bpm, uninterrupted.stages[0].hr.steady_state_bpm);

  const storage = memoryStorage();
  startSession(VO2_WORKOUT_SELECTOR_ID, Date.now(), sessionId, "bike", storage, {
    blocks: vo2PlanBlocks(),
    hrTargets: null,
  });
  persistVo2ProtocolRuntime(VO2_WORKOUT_SELECTOR_ID, restored, storage);
  const ticked = await tickVo2ProtocolWithCanonicalHr(VO2_WORKOUT_SELECTOR_ID, 480, false, storage);
  assert.equal(ticked.runtime.stages[0].status, "accepted");
  await resetWorkoutStorageForTests();
});

test("late tick and reload/background gap do not backdate the next workload", () => {
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  runtime = advanceVo2Protocol(runtime, {
    elapsedSec: 497,
    paused: false,
    samples: stageHr(300, 120, 121),
  });
  assert.equal(runtime.stages[0].status, "accepted");
  assert.equal(runtime.stages[0].active_end_sec, 497);
  assert.equal(runtime.stages[1].active_start_sec, 497);
  assert.notEqual(runtime.stages[1].active_start_sec, 480);

  let gapped = createVo2ProtocolRuntime(plan);
  gapped = advanceVo2Protocol(gapped, { elapsedSec: 300, paused: false, samples: [] });
  const restored = parseVo2ProtocolRuntime(JSON.parse(JSON.stringify(gapped)));
  const afterGap = advanceVo2Protocol(restored, {
    elapsedSec: 510,
    paused: false,
    samples: stageHr(300, 118, 119),
  });
  assert.equal(afterGap.stages[0].active_end_sec, 510);
  assert.equal(afterGap.stages[1].active_start_sec, 510);
  assert.ok(afterGap.stages[1].active_start_sec > 480);
});

test("stage 1 exceeds warmup and later targets anchor to prior resolved watts + 25", () => {
  const plan = buildVo2ProtocolPlan();
  assert.ok(plan);
  let previous = plan.warmup_calibrated_watts_at_70rpm;
  assert.ok(plan.workloads[0].calibrated_watts_at_70rpm > previous);
  const gaps = [];
  for (const row of plan.workloads) {
    assert.equal(row.requested_watts, previous + 25);
    assert.ok(row.calibrated_watts_at_70rpm > previous);
    gaps.push(row.calibrated_watts_at_70rpm - previous);
    previous = row.calibrated_watts_at_70rpm;
  }
  assert.ok(gaps.some((gap) => gap >= 10));
});

test("wrong bike profile cannot use ProForm calibration", () => {
  const ok = evaluateVo2Preflight(freshHrInput());
  assert.equal(ok.ok, true);
  const other = evaluateVo2Preflight(
    freshHrInput({
      activityMachineId: "other-bike",
      getWatts: getEstimatedWattsAt70Rpm,
    })
  );
  assert.equal(other.ok, false);
  assert.match(other.message, /No calibrated 70 RPM bike profile selected/);
});

test("malformed workload index cannot produce 0 resistance/watts", () => {
  const plan = buildVo2ProtocolPlan();
  const runtime = createVo2ProtocolRuntime(plan);
  runtime.stages.push({
    stage_id: "vo2-stage:9",
    workloadIndex: 99,
    active_start_sec: 300,
    active_end_sec: 480,
    extensions: 0,
    status: "accepted",
    last_eval_relative_sec: 180,
    upcoming_announced: false,
    extension_announced: false,
  });
  assert.equal(isValidVo2ProtocolRuntime(runtime), false);
  assert.equal(parseVo2ProtocolRuntime(runtime), null);
  assert.equal(buildVo2ProtocolEvidence(runtime), undefined);
  const storage = memoryStorage();
  persistVo2ProtocolRuntime(VO2_WORKOUT_SELECTOR_ID, runtime, storage);
  assert.equal(getSession(VO2_WORKOUT_SELECTOR_ID, storage).vo2ProtocolRuntime, null);
});

test("VO2 stage name reaches UI/display projection", () => {
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan);
  assert.equal(vo2ProtocolDisplayName(getVo2ProtocolPhase(10, runtime)), "VO2 warmup");
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  assert.equal(vo2ProtocolDisplayName(getVo2ProtocolPhase(400, runtime)), "VO2 stage 1");
  runtime = advanceVo2Protocol(runtime, {
    elapsedSec: 480,
    paused: false,
    samples: stageHr(300, 110, 130),
  });
  assert.equal(vo2ProtocolDisplayName(getVo2ProtocolPhase(500, runtime)), "VO2 stage 1 extension");
  runtime.segment = "cooldown";
  runtime.cooldown_start_sec = 600;
  assert.equal(vo2ProtocolDisplayName(getVo2ProtocolPhase(620, runtime)), "VO2 cooldown");
});

test("changelog headings are preserved", async () => {
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  assert.match(changelog, /^# Changelog\r?\n/);
  assert.match(changelog, /## \[0\.10\.12\] - 2026-08-31/);
  assert.match(changelog, /## \[0\.10\.11\] - 2026-08-28/);
  assert.match(changelog, /## \[0\.10\.10\] - 2026-08-28/);
});

test("session stores one frozen protocol plan on the runtime", () => {
  const storage = memoryStorage();
  const plan = buildVo2ProtocolPlan();
  startSession(VO2_WORKOUT_SELECTOR_ID, Date.now(), "one-plan", "bike", storage, {
    blocks: vo2PlanBlocks(),
    hrTargets: null,
  });
  persistVo2ProtocolRuntime(VO2_WORKOUT_SELECTOR_ID, createVo2ProtocolRuntime(plan), storage);
  const session = getSession(VO2_WORKOUT_SELECTOR_ID, storage);
  assert.equal(Object.prototype.hasOwnProperty.call(session, "vo2ProtocolPlan"), false);
  assert.ok(session.vo2ProtocolRuntime.plan);
  assert.equal(session.vo2ProtocolRuntime.plan.protocol_id, "bike-submax-70rpm");
});

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

test("protocol workloads never exceed resistance 10 and current calibration still has 15", () => {
  assert.equal(AUTOMATIC_RESISTANCE_MAX, 15);
  assert.equal(getEstimatedWattsAt70Rpm(11), 134);
  assert.equal(getEstimatedWattsAt70Rpm(15), 201);
  const plan = buildVo2ProtocolPlan();
  assert.ok(plan);
  assert.ok(plan.workloads.length >= VO2_TARGET_WORK_STAGES);
  assert.ok(plan.workloads.length <= VO2_MAX_WORK_STAGES);
  assert.ok(plan.warmup_resistance <= VO2_PROTOCOL_MAX_RESISTANCE);
  assert.ok(plan.workloads[0].calibrated_watts_at_70rpm > plan.warmup_calibrated_watts_at_70rpm);
  const rows = [plan.warmup_resistance, ...plan.workloads.map((row) => row.prescribed_resistance)];
  assert.ok(rows.every((resistance) => resistance <= VO2_PROTOCOL_MAX_RESISTANCE));
  let lastWatts = plan.warmup_calibrated_watts_at_70rpm;
  for (const row of plan.workloads) {
    assert.ok(row.calibrated_watts_at_70rpm > lastWatts);
    lastWatts = row.calibrated_watts_at_70rpm;
  }
  assert.equal(plan.workloads.some((row) => row.prescribed_resistance >= 11), false);
  const evidenceRuntime = createVo2ProtocolRuntime(plan);
  const started = advanceVo2Protocol(evidenceRuntime, { elapsedSec: 300, paused: false, samples: [] });
  const evidence = buildVo2ProtocolEvidence(started);
  assert.ok(evidence);
  assert.equal(evidence.stages.some((stage) => stage.prescribed_resistance >= 11), false);
});

test("each resolved protocol resistance survives Bike Bridge conversion unchanged", async () => {
  const src = await readFile(new URL("../src/vo2Protocol.ts", import.meta.url), "utf8");
  assert.equal(src.includes("bikeBridgeClient"), false);
  assert.equal(src.includes("toBridgeResistanceLevel"), false);
  const plan = buildVo2ProtocolPlan();
  assert.ok(plan);
  const resistances = [plan.warmup_resistance, ...plan.workloads.map((row) => row.prescribed_resistance)];
  for (const resistance of resistances) {
    assert.equal(toBridgeResistanceLevel(resistance), resistance);
  }
});

test("VO2 cadence text does not become an HR target", async () => {
  const parsedTrap = parseHrTargetRange("70 RPM prescribed");
  assert.ok(parsedTrap);
  assert.equal(parsedTrap.min, 65);
  assert.equal(parsedTrap.max, 75);

  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  const projected = vo2ProtocolUiTargets(runtime, "vo2-stage:1");
  assert.equal(projected.hrTargetTextValue, "");
  assert.equal(projected.targetHeartRateMin, undefined);
  assert.equal(projected.targetHeartRateMax, undefined);
  assert.equal(projected.holdCadenceRpm, 70);
  assert.equal(parseHrTargetRange(projected.hrTargetTextValue), null);

  const hold = vo2ProtocolHoldForPhase(runtime, "vo2-stage:1");
  assert.equal(hold.cadenceRpm, 70);
  assert.equal(hold.resistance, plan.workloads[0].prescribed_resistance);

  const ui = await readFile(new URL("../src/uiControls.ts", import.meta.url), "utf8");
  assert.equal(ui.includes("70 RPM prescribed"), false);
  const voice = await readFile(new URL("../src/vo2Protocol.ts", import.meta.url), "utf8");
  assert.match(voice, /Maintain 70 RPM/);

  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("vo2-no-fake-hr");
  const update = updateMachineGuidanceRuntime(
    {
      sessionId: "vo2-no-fake-hr",
      activity: "bike",
      phaseKind: "work",
      phaseId: "vo2-stage:1",
      phaseDisplayName: "VO2 stage 1",
      phaseElapsedSeconds: 20,
      phaseDurationSeconds: 180,
      workoutElapsedSeconds: 320,
      targetHeartRateMin: projected.targetHeartRateMin,
      targetHeartRateMax: projected.targetHeartRateMax,
      holdResistance: projected.holdResistance,
      holdCadenceRpm: projected.holdCadenceRpm,
      intent: "vo2_estimation",
    },
    storage
  );
  assert.ok(update);
  assert.equal(update.guidance.cadenceRpm, 70);
  assert.equal(update.guidance.resistance, projected.holdResistance);
});

test("malformed protocol semantic fields and v1 constants are rejected", () => {
  const plan = buildVo2ProtocolPlan();
  assert.ok(isValidVo2ProtocolPlan(plan));
  let runtime = createVo2ProtocolRuntime(plan);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  assert.equal(isValidVo2ProtocolRuntime(runtime), true);

  const badExtensions = cloneJson(runtime);
  badExtensions.stages[0].extensions = 3;
  assert.equal(isValidVo2ProtocolRuntime(badExtensions), false);

  const badEval = cloneJson(runtime);
  badEval.stages[0].last_eval_relative_sec = 90;
  assert.equal(isValidVo2ProtocolRuntime(badEval), false);

  const badFlag = cloneJson(runtime);
  badFlag.start_announced = 1;
  assert.equal(isValidVo2ProtocolRuntime(badFlag), false);
  badFlag.start_announced = true;
  badFlag.stages[0].upcoming_announced = "true";
  assert.equal(isValidVo2ProtocolRuntime(badFlag), false);

  const badReason = cloneJson(runtime);
  badReason.termination = { reason: "not-a-reason" };
  assert.equal(isValidVo2ProtocolRuntime(badReason), false);

  const badDuration = cloneJson(runtime);
  badDuration.plan.warmup_duration_sec = 299;
  assert.equal(isValidVo2ProtocolPlan(badDuration.plan), false);
  assert.equal(isValidVo2ProtocolRuntime(badDuration), false);
  assert.equal(parseVo2ProtocolRuntime(badDuration), null);

  const r11 = cloneJson(runtime);
  r11.plan.workloads[0].prescribed_resistance = 11;
  assert.equal(isValidVo2ProtocolRuntime(r11), false);
  assert.equal(buildVo2ProtocolEvidence(r11), undefined);
});

test("frozen old calibration still restores successfully", () => {
  const calibrationA = (resistance) => {
    if (resistance === 1) return 70;
    if (resistance === 2) return 95;
    if (resistance === 3) return 120;
    if (resistance === 4) return 145;
    return undefined;
  };
  const plan = buildVo2ProtocolPlan(calibrationA);
  assert.ok(plan);
  assert.notEqual(plan.workloads[0].calibrated_watts_at_70rpm, getEstimatedWattsAt70Rpm(plan.workloads[0].prescribed_resistance));
  let runtime = createVo2ProtocolRuntime(plan);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  const restored = parseVo2ProtocolRuntime(cloneJson(runtime));
  assert.ok(restored);
  assert.equal(isValidVo2ProtocolRuntime(restored), true);
  assert.equal(restored.plan.workloads[0].calibrated_watts_at_70rpm, plan.workloads[0].calibrated_watts_at_70rpm);
  assert.equal(restored.plan.workloads[0].requested_watts, plan.warmup_calibrated_watts_at_70rpm + 25);
});

test("overlapping evaluation does not duplicate a stage or rewind a newer runtime", async () => {
  const plan = buildVo2ProtocolPlan();
  let later = createVo2ProtocolRuntime(plan);
  later = advanceVo2Protocol(later, { elapsedSec: 300, paused: false, samples: [] });
  later = advanceVo2Protocol(later, {
    elapsedSec: 497,
    paused: false,
    samples: stageHr(300, 120, 121),
  });
  assert.equal(later.stages[1].active_start_sec, 497);
  const storage = memoryStorage();
  startSession(VO2_WORKOUT_SELECTOR_ID, Date.now(), "vo2-overlap", "bike", storage, {
    blocks: vo2PlanBlocks(),
    hrTargets: null,
  });
  persistVo2ProtocolRuntime(VO2_WORKOUT_SELECTOR_ID, later, storage);
  const earlier = tickVo2Protocol(VO2_WORKOUT_SELECTOR_ID, 480, false, storage, []);
  assert.equal(earlier.runtime.stages.length, 2);
  assert.equal(earlier.runtime.stages.filter((stage) => stage.stage_id === "vo2-stage:1").length, 1);
  assert.equal(earlier.runtime.stages[1].active_start_sec, 497);
  const asyncEarlier = await tickVo2ProtocolWithCanonicalHr(VO2_WORKOUT_SELECTOR_ID, 480, false, storage);
  assert.equal(asyncEarlier.runtime.stages[1].active_start_sec, 497);

  await resetWorkoutStorageForTests();
  const sessionId = "vo2-double-eval";
  const doubleStorage = memoryStorage();
  startSession(VO2_WORKOUT_SELECTOR_ID, Date.now(), sessionId, "bike", doubleStorage, {
    blocks: vo2PlanBlocks(),
    hrTargets: null,
  });
  let open = createVo2ProtocolRuntime(plan);
  open = advanceVo2Protocol(open, { elapsedSec: 300, paused: false, samples: [] });
  persistVo2ProtocolRuntime(VO2_WORKOUT_SELECTOR_ID, open, doubleStorage);
  await persistRange(sessionId, 360, 479, 122);
  const first = await tickVo2ProtocolWithCanonicalHr(VO2_WORKOUT_SELECTOR_ID, 480, false, doubleStorage);
  const second = await tickVo2ProtocolWithCanonicalHr(VO2_WORKOUT_SELECTOR_ID, 480, false, doubleStorage);
  assert.equal(first.runtime.stages[0].status, "accepted");
  assert.equal(second.runtime.stages[0].status, "accepted");
  assert.equal(second.runtime.stages.filter((stage) => stage.stage_id === "vo2-stage:1").length, 1);
  assert.equal(second.runtime.stages.length, 2);
  await resetWorkoutStorageForTests();
});

test("limit_reached closes the open stage as incomplete and enters cooldown", () => {
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  runtime = advanceVo2Protocol(runtime, {
    elapsedSec: 480,
    paused: false,
    samples: stageHr(300, 118, 119),
  });
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 520, paused: false, samples: [], limitReached: true });
  assert.equal(runtime.termination.reason, "limit_reached");
  assert.equal(runtime.segment, "cooldown");
  assert.equal(runtime.stages[0].status, "accepted");
  assert.equal(runtime.stages[1].status, "incomplete");
  const evidence = buildVo2ProtocolEvidence(runtime);
  assert.equal(evidence.stages[1].status, "incomplete");
  assert.equal(evidence.termination.reason, "limit_reached");
});

test("cancel during cooldown does not overwrite limit_reached or early_cooldown", () => {
  const plan = buildVo2ProtocolPlan();
  let limited = createVo2ProtocolRuntime(plan);
  limited = advanceVo2Protocol(limited, { elapsedSec: 300, paused: false, samples: [] });
  limited = advanceVo2Protocol(limited, { elapsedSec: 400, paused: false, samples: [], limitReached: true });
  limited = advanceVo2Protocol(limited, { elapsedSec: 450, paused: false, samples: [], cancelled: true });
  assert.equal(limited.termination.reason, "limit_reached");
  assert.equal(limited.segment, "cooldown");

  let early = createVo2ProtocolRuntime(plan);
  early = advanceVo2Protocol(early, { elapsedSec: 300, paused: false, samples: [] });
  early = advanceVo2Protocol(early, { elapsedSec: 400, paused: false, samples: [], earlyCooldownElapsed: 400 });
  early = advanceVo2Protocol(early, { elapsedSec: 450, paused: false, samples: [], cancelled: true });
  assert.equal(early.termination.reason, "early_cooldown");
  assert.equal(early.segment, "cooldown");
});

test("ordinary early end records user_cancelled and does not promote incomplete stages", () => {
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 360, paused: false, samples: [], cancelled: true });
  assert.equal(runtime.termination.reason, "user_cancelled");
  assert.equal(runtime.segment, "complete");
  assert.equal(runtime.stages[0].status, "incomplete");
  const evidence = buildVo2ProtocolEvidence(runtime);
  assert.equal(evidence.stages[0].status, "incomplete");
  assert.equal(evidence.stages.every((stage) => stage.status !== "accepted"), true);
});

test("requestVo2LimitReached is VO2-only and does not set early_cooldown elapsed", () => {
  const plan = buildVo2ProtocolPlan();
  const storage = memoryStorage();
  const start = Date.now();
  startSession("Monday", start, "not-vo2", "bike", storage, {
    blocks: vo2PlanBlocks(),
    hrTargets: null,
  });
  const previousDay = globalThis.window.getSelectedDay;
  globalThis.window.getSelectedDay = () => "Monday";
  assert.equal(requestVo2LimitReached("Monday", { storage, now: start + 400_000, blocks: vo2PlanBlocks() }).type, "unavailable");

  startSession(VO2_WORKOUT_SELECTOR_ID, start, "vo2-limit", "bike", storage, {
    blocks: vo2PlanBlocks(),
    hrTargets: null,
  });
  let live = createVo2ProtocolRuntime(plan);
  live = advanceVo2Protocol(live, { elapsedSec: 300, paused: false, samples: [] });
  persistVo2ProtocolRuntime(VO2_WORKOUT_SELECTOR_ID, live, storage);
  globalThis.window.getSelectedDay = () => VO2_WORKOUT_SELECTOR_ID;
  const decision = requestVo2LimitReached(VO2_WORKOUT_SELECTOR_ID, {
    storage,
    now: start + 400_000,
    blocks: vo2PlanBlocks(),
  });
  globalThis.window.getSelectedDay = previousDay;
  assert.equal(decision.type, "enter-limit-reached");
  const session = getSession(VO2_WORKOUT_SELECTOR_ID, storage);
  assert.equal(session.vo2ProtocolRuntime.termination.reason, "limit_reached");
  assert.equal(session.earlyCooldownElapsed, null);

  markVo2ProtocolLimitReached(VO2_WORKOUT_SELECTOR_ID, 400, storage);
  assert.equal(getSession(VO2_WORKOUT_SELECTOR_ID, storage).vo2ProtocolRuntime.termination.reason, "limit_reached");
});
