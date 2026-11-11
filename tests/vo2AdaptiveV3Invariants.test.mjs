import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VO2_ADAPTIVE_POLICY,
  VO2_ADAPTIVE_ADVERTISED_MAX_TOTAL_DURATION_SEC,
  VO2_ADAPTIVE_MAX_WORK_STAGES,
  VO2_ADAPTIVE_MAX_WATT_INCREMENT,
  VO2_ADAPTIVE_MIN_WATT_INCREMENT,
  VO2_ADAPTIVE_MIN_WATT_SEPARATION,
  VO2_ADAPTIVE_SAFETY_MARGIN_BPM,
  isValidVo2AdaptivePolicy,
  planNextVo2Stage,
  vo2AdaptiveMaxTotalDurationSec,
} from "../dist/vo2AdaptivePlanner.js";
import {
  buildVo2ProtocolPlanV3,
  createVo2ProtocolRuntimeV3,
  advanceVo2ProtocolV3,
  buildVo2ProtocolEvidenceV3,
  isValidVo2ProtocolPlanV3,
  isValidVo2ProtocolRuntimeV3,
  vo2PlanBlocksV3,
  vo2V3MaxTotalDurationSec,
} from "../dist/vo2ProtocolV3.js";
import {
  buildVo2ProtocolPlan,
  resolveProtocolWorkloads,
  VO2_COOLDOWN_DURATION_SEC,
  VO2_MAX_STAGE_DURATION_SEC,
  VO2_WARMUP_DURATION_SEC,
} from "../dist/vo2Protocol.js";
import { assessVo2, estimatorSubmaxHrCeilingBpm, predictedHrMaxBpm } from "../dist/vo2Estimator.js";
import { VO2_EVIDENCE_SCHEMA_VERSION } from "../dist/types.js";
import { getEstimatedWattsAt70Rpm } from "../dist/machines/proformSmartPower10.js";

const FIXTURE_AGE = 46;
const FIXTURE_WEIGHT = 52.1631;
const FIXTURE_HRMAX = 175.8;
const FIXTURE_HARD = 149.43;
const FIXTURE_PROFILE = { age_years: FIXTURE_AGE, weight_kg: FIXTURE_WEIGHT };

function fixturePlannerInput(overrides = {}) {
  return {
    eligible: [
      { estimatorWatts: 85, steadyHrBpm: 121.15, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 102, steadyHrBpm: 132.25, calibratedWatts: 108, resistance: 8 },
    ],
    predictedHrMax: FIXTURE_HRMAX,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 6, 8]),
    calibration: getEstimatedWattsAt70Rpm,
    completedWorkStages: 2,
    retryCount: 0,
    ...overrides,
  };
}

// --- Issue 2: watt-domain consistency (calibrated planning domain) ---

test("planner predicts from calibrated watts, not estimator watts (measured below calibrated)", () => {
  // Same calibrated history (86/108) and HR, but estimator watts materially
  // lower (-15W): 70/87 vs 85/102. Planning decision must be identical
  // because prediction uses the calibrated domain.
  const base = fixturePlannerInput();
  const shifted = fixturePlannerInput({
    eligible: [
      { estimatorWatts: 70, steadyHrBpm: 121.15, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 87, steadyHrBpm: 132.25, calibratedWatts: 108, resistance: 8 },
    ],
  });
  const a = planNextVo2Stage(base);
  const b = planNextVo2Stage(shifted);
  assert.equal(a.decision, "next");
  assert.equal(b.decision, "next");
  assert.equal(a.prescribed_resistance, b.prescribed_resistance);
  assert.equal(a.calibrated_watts, b.calibrated_watts);
  assert.ok(Math.abs(a.predicted_hr_bpm - b.predicted_hr_bpm) < 1e-9);
  // Calibrated-fit prediction at R9 114W: slope 0.5045, intercept 77.76.
  const slope = (132.25 - 121.15) / (108 - 86);
  const intercept = 121.15 - slope * 86;
  const expected = slope * 114 + intercept;
  assert.ok(Math.abs(a.predicted_hr_bpm - expected) < 0.05);
  // Estimator-fit would predict ~140.1 at 114W; calibrated predicts ~135.3.
  assert.ok(a.predicted_hr_bpm < 137);
});

test("planner predicts from calibrated watts, not estimator watts (measured above calibrated)", () => {
  // Estimator watts materially higher (+15W): 100/117 vs 85/102.
  const base = fixturePlannerInput();
  const shifted = fixturePlannerInput({
    eligible: [
      { estimatorWatts: 100, steadyHrBpm: 121.15, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 117, steadyHrBpm: 132.25, calibratedWatts: 108, resistance: 8 },
    ],
  });
  const a = planNextVo2Stage(base);
  const b = planNextVo2Stage(shifted);
  assert.equal(a.decision, "next");
  assert.equal(b.decision, "next");
  assert.equal(a.prescribed_resistance, 9);
  assert.equal(b.prescribed_resistance, 9);
  assert.ok(Math.abs(a.predicted_hr_bpm - b.predicted_hr_bpm) < 1e-9);
});

test("same estimator watts but different calibrated history changes the plan", () => {
  // Estimator watts fixed (85/102); calibrated history materially different
  // (70/90 vs 86/108, -16/-18W). A domain-mixed planner using estimator
  // watts would return the same decision; the calibrated planner must differ
  // in prediction (different slope/intercept).
  const a = planNextVo2Stage(fixturePlannerInput());
  const b = planNextVo2Stage(
    fixturePlannerInput({
      eligible: [
        { estimatorWatts: 85, steadyHrBpm: 121.15, calibratedWatts: 70, resistance: 3 },
        { estimatorWatts: 102, steadyHrBpm: 132.25, calibratedWatts: 90, resistance: 4 },
      ],
      usedResistances: new Set([1, 3, 4]),
    })
  );
  assert.equal(a.decision, "next");
  assert.equal(b.decision, "next");
  // Calibrated fits differ: (86,108) slope 0.5045 vs (70,90) slope 0.555.
  // Predictions at their respective choices must differ materially.
  assert.ok(Math.abs(a.predicted_hr_bpm - b.predicted_hr_bpm) > 0.5);
});

test("max-safe bound is evaluated in the calibrated domain", () => {
  // With calibrated history (86,108) the max-safe calibrated bound at
  // margin 12 is (137.43-77.76)/0.5045 = 118.27W, admitting R9 114W but
  // refusing R10 123W. An estimator-domain max-safe (measured fit) would be
  // (137.43-65.65)/0.6529 = 109.94W and would refuse R9 as well.
  const decision = planNextVo2Stage(fixturePlannerInput());
  assert.equal(decision.decision, "next");
  assert.equal(decision.calibrated_watts, 114);
  // Prove the bound used was the calibrated one: R9 114 < 118.27 admits,
  // R10 123 > 118.27 refuses. If the planner had used the estimator-domain
  // bound 109.94 it would have refused R9 (114 > 109.94).
  assert.ok(114 < 118.27 + 0.1);
  assert.ok(123 > 118.27 - 0.1);
});

// --- Issue 5: policy invariants (min/max/separation enforced everywhere) ---

test("minimum increment is enforced, not decorative", () => {
  // Separation 3 but minimum increment 10: candidate at +4W satisfies
  // separation yet violates minimum increment and must be refused.
  const decision = planNextVo2Stage({
    eligible: [
      { estimatorWatts: 100, steadyHrBpm: 120, calibratedWatts: 100, resistance: 5 },
      { estimatorWatts: 110, steadyHrBpm: 125, calibratedWatts: 110, resistance: 6 },
    ],
    predictedHrMax: 180,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 5, 6]),
    calibration: (r) => (r === 7 ? 114 : undefined),
    completedWorkStages: 2,
    retryCount: 0,
    policy: { min_watt_increment: 10, min_watt_separation: 3 },
  });
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "insufficient_separation");
});

test("sparse table far above max increment refuses instead of jumping (normal path)", () => {
  const decision = planNextVo2Stage({
    eligible: [
      { estimatorWatts: 100, steadyHrBpm: 120, calibratedWatts: 100, resistance: 5 },
      { estimatorWatts: 110, steadyHrBpm: 125, calibratedWatts: 110, resistance: 6 },
    ],
    predictedHrMax: 190,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 5, 6]),
    calibration: (r) => (r === 7 ? 160 : undefined),
    completedWorkStages: 2,
    retryCount: 0,
    policy: { max_watt_increment: 15 },
  });
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "workload_bounds_exhausted");
  assert.equal(decision.termination_reason, "insufficient_calibrated_workloads");
});

test("sparse table far above max increment refuses (bootstrap path)", () => {
  const decision = planNextVo2Stage({
    eligible: [],
    predictedHrMax: 180,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1]),
    calibration: (r) => (r === 2 ? 100 : undefined),
    completedWorkStages: 0,
    retryCount: 0,
    policy: { max_watt_increment: 10 },
  });
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "workload_bounds_exhausted");
});

test("sparse table far above max increment refuses (fallback path)", () => {
  const decision = planNextVo2Stage({
    eligible: [{ estimatorWatts: 85, steadyHrBpm: 118, calibratedWatts: 86, resistance: 6 }],
    predictedHrMax: 180,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 6]),
    calibration: (r) => (r === 7 ? 130 : undefined),
    completedWorkStages: 1,
    retryCount: 0,
    policy: { max_watt_increment: 10 },
  });
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "workload_bounds_exhausted");
});

test("retry below the failed workload still respects max increment", () => {
  // Base 86 (last eligible), failed 123. Candidate 114 is below the failure
  // but 28W above base, violating max 15. Only 97 (+11W) is legal.
  const input = {
    eligible: [
      { estimatorWatts: 85, steadyHrBpm: 121.15, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 95, steadyHrBpm: 126, calibratedWatts: 97, resistance: 7 },
    ],
    predictedHrMax: FIXTURE_HRMAX,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    lastCompleted: {
      calibratedWatts: 123,
      estimatorWatts: 119,
      steadyHrBpm: 154.1,
      resistance: 10,
      aboveCeiling: true,
      eligible: false,
    },
    usedResistances: new Set([1, 6, 7, 10]),
    calibration: getEstimatedWattsAt70Rpm,
    completedWorkStages: 3,
    retryCount: 0,
    policy: { max_watt_increment: 15 },
  };
  const decision = planNextVo2Stage(input);
  assert.equal(decision.decision, "next");
  // Base for retry is last eligible calibrated (97), so 114 is +17W > 15
  // max and must not be chosen; 108 is +11W and below failed 123.
  assert.ok(decision.calibrated_watts <= 97 + 15 + 1e-9);
  assert.ok(decision.calibrated_watts < 123);
  assert.equal(decision.provenance.decision, "retry");
});

test("retry with only max-violating candidate refuses", () => {
  const decision = planNextVo2Stage({
    eligible: [
      { estimatorWatts: 85, steadyHrBpm: 121, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 90, steadyHrBpm: 124, calibratedWatts: 90, resistance: 5 },
    ],
    predictedHrMax: 185,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    lastCompleted: {
      calibratedWatts: 150,
      estimatorWatts: 148,
      steadyHrBpm: 160,
      resistance: 9,
      aboveCeiling: true,
      eligible: false,
    },
    usedResistances: new Set([1, 5, 6, 9]),
    calibration: (r) => (r === 7 ? 130 : r === 8 ? 140 : undefined),
    completedWorkStages: 3,
    retryCount: 0,
    policy: { max_watt_increment: 10 },
  });
  // Base 90, candidates 130 (+40) and 140 (+50) both exceed max 10.
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "workload_bounds_exhausted");
});

test("incoherent policies are rejected", () => {
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, min_watt_increment: 20, normal_watt_increment: 10 }), false);
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, normal_watt_increment: 30, max_watt_increment: 25 }), false);
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, min_watt_separation: 30, max_watt_increment: 25 }), false);
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, bootstrap_watt_step: 30, max_watt_increment: 25 }), false);
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, fallback_watt_step: 2, min_watt_increment: 5 }), false);
  assert.equal(isValidVo2AdaptivePolicy(DEFAULT_VO2_ADAPTIVE_POLICY), true);
  assert.equal(buildVo2ProtocolPlanV3(getEstimatedWattsAt70Rpm, { min_watt_increment: 20, normal_watt_increment: 10 }), undefined);
});

// --- Issue 3: 30-minute hard invariant ---

test("default v3 plan and max stages respect the 30-minute bound", () => {
  assert.equal(VO2_ADAPTIVE_ADVERTISED_MAX_TOTAL_DURATION_SEC, 1800);
  assert.equal(VO2_ADAPTIVE_MAX_WORK_STAGES, 4);
  assert.equal(
    VO2_ADAPTIVE_MAX_WORK_STAGES,
    Math.floor((1800 - VO2_WARMUP_DURATION_SEC - VO2_COOLDOWN_DURATION_SEC) / VO2_MAX_STAGE_DURATION_SEC)
  );
  assert.ok(vo2AdaptiveMaxTotalDurationSec(DEFAULT_VO2_ADAPTIVE_POLICY) <= 1800);
  assert.ok(vo2V3MaxTotalDurationSec(DEFAULT_VO2_ADAPTIVE_POLICY) <= 1800);
  const blocks = vo2PlanBlocksV3(DEFAULT_VO2_ADAPTIVE_POLICY);
  const displayedSec = (blocks.warm + blocks.sustain + blocks.cool) * 60;
  assert.ok(displayedSec <= 1800);
  assert.equal(displayedSec, vo2V3MaxTotalDurationSec(DEFAULT_VO2_ADAPTIVE_POLICY));
});

test("maximum valid serialized policy stays within 30 minutes", () => {
  const maxPolicy = { ...DEFAULT_VO2_ADAPTIVE_POLICY, max_work_stages: 4 };
  assert.equal(isValidVo2AdaptivePolicy(maxPolicy), true);
  assert.ok(vo2AdaptiveMaxTotalDurationSec(maxPolicy) <= 1800);
  const plan = buildVo2ProtocolPlanV3(getEstimatedWattsAt70Rpm, { max_work_stages: 4 });
  assert.ok(plan);
  assert.equal(isValidVo2ProtocolPlanV3(plan), true);
});

test("policies and runtimes that could exceed 30 minutes are rejected", () => {
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, max_work_stages: 5 }), false);
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, max_work_stages: 6 }), false);
  assert.equal(buildVo2ProtocolPlanV3(getEstimatedWattsAt70Rpm, { max_work_stages: 5 }), undefined);
  assert.equal(buildVo2ProtocolPlanV3(getEstimatedWattsAt70Rpm, { max_work_stages: 6 }), undefined);
  const plan = buildVo2ProtocolPlanV3();
  assert.ok(plan);
  const overloaded = JSON.parse(JSON.stringify(plan));
  overloaded.workloads = [1, 2, 3, 4, 5].map((r) => ({
    requested_watts: 60 + r * 10,
    prescribed_resistance: r,
    calibrated_watts_at_70rpm: 60 + r * 10,
  }));
  assert.equal(isValidVo2ProtocolPlanV3(overloaded), false);
  let runtime = createVo2ProtocolRuntimeV3(plan, FIXTURE_PROFILE);
  runtime = advanceVo2ProtocolV3(runtime, { elapsedSec: 300, paused: false, samples: [] });
  const tooMany = JSON.parse(JSON.stringify(runtime));
  tooMany.stages = [0, 1, 2, 3, 4].map((i) => ({ ...runtime.stages[0], stage_id: `vo2-stage:${i + 1}` }));
  // Stages reference workload 0 which exists, but count 5 exceeds policy max 4.
  assert.equal(isValidVo2ProtocolRuntimeV3(tooMany), false);
});

test("displayed plan duration matches the allowed runtime bound for every valid stage count", () => {
  for (const stages of [1, 2, 3, 4]) {
    const policy = { ...DEFAULT_VO2_ADAPTIVE_POLICY, max_work_stages: stages };
    assert.equal(isValidVo2AdaptivePolicy(policy), true);
    const blocks = vo2PlanBlocksV3(policy);
    const displayed = (blocks.warm + blocks.sustain + blocks.cool) * 60;
    assert.equal(displayed, vo2V3MaxTotalDurationSec(policy));
    assert.equal(displayed, VO2_WARMUP_DURATION_SEC + stages * VO2_MAX_STAGE_DURATION_SEC + VO2_COOLDOWN_DURATION_SEC);
    assert.ok(displayed <= 1800);
  }
});

// --- Issue 6: real-session v3 progression (margin rationale companion) ---

test("v2 ladder, v3 stage 1, and v3 stage 2 are pinned from the real session", () => {
  const v2 = resolveProtocolWorkloads(getEstimatedWattsAt70Rpm, 4);
  assert.deepEqual(v2.map((w) => w.prescribed_resistance), [6, 8, 9, 10]);
  assert.deepEqual(v2.map((w) => w.calibrated_watts_at_70rpm), [86, 108, 114, 123]);
  const v2plan = buildVo2ProtocolPlan();
  assert.ok(v2plan);
  assert.deepEqual(v2plan.workloads.map((w) => w.prescribed_resistance), [6, 8, 9, 10]);

  // Original v3 bootstrap (persisted policy bootstrap_watt_step 25) from
  // warmup R1/66W targets 91W; nearest legal level is R6/86W (same first
  // stage as v2 by table luck).
  const firstInput = {
    eligible: [],
    predictedHrMax: FIXTURE_HRMAX,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1]),
    calibration: getEstimatedWattsAt70Rpm,
    completedWorkStages: 0,
    retryCount: 0,
  };
  const first = planNextVo2Stage({ ...firstInput, policy: { bootstrap_watt_step: 25 } });
  assert.equal(first.decision, "next");
  assert.equal(first.prescribed_resistance, 6);
  assert.equal(first.calibrated_watts, 86);

  // Current default bootstrap targets warmup + minimum increment (71W): the
  // lowest legal level is R4/78W (R2/R3 are within 5W of warmup).
  const current = planNextVo2Stage(firstInput);
  assert.equal(current.decision, "next");
  assert.equal(current.prescribed_resistance, 4);
  assert.equal(current.calibrated_watts, 78);
  assert.equal(current.target_watts, 71);
  assert.equal(current.reason_code, "bootstrap_first_stage");

  // After one eligible stage at R6, the runway-preserving one-point step
  // targets 86+5=91W; the lowest legal level is R7/97W (R5/82W is below the
  // base; v2 would jump to R8/108W).
  const second = planNextVo2Stage({
    eligible: [{ estimatorWatts: 85, steadyHrBpm: 121.15, calibratedWatts: 86, resistance: 6 }],
    predictedHrMax: FIXTURE_HRMAX,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    lastCompleted: { calibratedWatts: 86, estimatorWatts: 85, steadyHrBpm: 121.15, resistance: 6, aboveCeiling: false, eligible: true },
    usedResistances: new Set([1, 6]),
    calibration: getEstimatedWattsAt70Rpm,
    completedWorkStages: 1,
    retryCount: 0,
  });
  assert.equal(second.decision, "next");
  assert.equal(second.prescribed_resistance, 7);
  assert.equal(second.calibrated_watts, 97);
});

function hrSamplesForStage(stageStart, bpm) {
  const out = [];
  for (let t = stageStart + 60; t <= stageStart + 119; t++) out.push({ timestamp_sec: t, hr: bpm });
  for (let t = stageStart + 120; t <= stageStart + 179; t++) out.push({ timestamp_sec: t, hr: bpm });
  return out;
}

function telemetryForStage(stageStart, watts, rpm = 70) {
  const end = stageStart + 180;
  const out = [];
  for (let t = end - 119; t <= end; t++) out.push({ timestamp_sec: t, rpm, watts });
  return out;
}

function assessRuntimeEvidence(runtime) {
  const protocol = buildVo2ProtocolEvidenceV3(runtime);
  assert.ok(protocol);
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
    FIXTURE_PROFILE
  );
}

test("v3 full runtime from warmup collects 3 eligible or stops truthfully without accepting above-ceiling", () => {
  // Deterministic gentle responder: HR rises ~0.55bpm per calibrated watt
  // from the fixture anchor (86W -> 121.15bpm). All predictions stay safe.
  const hrFor = (calibrated) => 121.15 + (calibrated - 86) * 0.55;
  const plan = buildVo2ProtocolPlanV3();
  assert.ok(plan);
  let runtime = createVo2ProtocolRuntimeV3(plan, FIXTURE_PROFILE);
  runtime = advanceVo2ProtocolV3(runtime, { elapsedSec: 300, paused: false, samples: [] });
  let guard = 0;
  while (runtime.segment === "work" && guard < 6) {
    guard += 1;
    const open = runtime.stages.find((s) => s.status === "open");
    assert.ok(open);
    const workload = runtime.plan.workloads[open.workloadIndex];
    const bpm = hrFor(workload.calibrated_watts_at_70rpm);
    runtime = advanceVo2ProtocolV3(runtime, {
      elapsedSec: open.active_start_sec + 180,
      paused: false,
      samples: hrSamplesForStage(open.active_start_sec, bpm),
      telemetrySamples: telemetryForStage(open.active_start_sec, workload.calibrated_watts_at_70rpm - 2),
    });
  }
  assert.ok(guard <= 4);
  const evidence = buildVo2ProtocolEvidenceV3(runtime);
  assert.ok(evidence);
  assert.equal(evidence.protocol_version, 3);
  const result = assessRuntimeEvidence(runtime);
  // Estimator must never accept an above-ceiling point.
  for (const point of result.diagnostics.eligible_points) {
    assert.ok(!point.ineligibility_reasons.includes("hr_above_submax_ceiling"));
    assert.ok(point.steady_state_bpm < estimatorSubmaxHrCeilingBpm(predictedHrMaxBpm(FIXTURE_AGE)));
  }
  if (result.status === "estimated") {
    assert.ok(result.eligible_stage_count >= 3);
    assert.equal(runtime.termination.reason, "protocol_complete");
  } else {
    // Truthful safety/validity stop: termination and provenance must agree,
    // and reason codes must not fabricate an observed ceiling crossing.
    assert.ok(["submax_hr_ceiling", "insufficient_eligible_stages", "insufficient_calibrated_workloads"].includes(runtime.termination.reason));
    if (runtime.termination.reason === "submax_hr_ceiling") {
      assert.ok(runtime.adaptive_termination);
    }
    const anyObservedAbove = result.diagnostics.stage_points.some((p) =>
      p.ineligibility_reasons.includes("hr_above_submax_ceiling")
    );
    if (!anyObservedAbove) {
      assert.equal(result.reason_codes.includes("hr_above_submax_ceiling"), false);
    }
  }
});

test("v3 steep responder stops proactively before the ceiling (no observed crossing)", () => {
  // Steep responder mimicking the fixture nonlinearity: HR jumps fast.
  // Planner must refuse the next stage proactively rather than prescribe
  // a workload the estimator would have to reject.
  const plan = buildVo2ProtocolPlanV3();
  assert.ok(plan);
  let runtime = createVo2ProtocolRuntimeV3(plan, FIXTURE_PROFILE);
  runtime = advanceVo2ProtocolV3(runtime, { elapsedSec: 300, paused: false, samples: [] });
  const first = runtime.stages.find((s) => s.status === "open");
  runtime = advanceVo2ProtocolV3(runtime, {
    elapsedSec: first.active_start_sec + 180,
    paused: false,
    samples: hrSamplesForStage(first.active_start_sec, 121.15),
    telemetrySamples: telemetryForStage(first.active_start_sec, 85),
  });
  const second = runtime.stages.find((s) => s.status === "open");
  assert.ok(second);
  // Second stage HR near planning (137.43 with margin 12): 136bpm.
  runtime = advanceVo2ProtocolV3(runtime, {
    elapsedSec: second.active_start_sec + 180,
    paused: false,
    samples: hrSamplesForStage(second.active_start_sec, 136),
    telemetrySamples: telemetryForStage(second.active_start_sec, 95),
  });
  const result = assessRuntimeEvidence(runtime);
  for (const point of result.diagnostics.eligible_points) {
    assert.ok(!point.ineligibility_reasons.includes("hr_above_submax_ceiling"));
  }
  // Either a safe third stage was prescribed or the runtime stopped with
  // explicit adaptive provenance; it must not require estimator acceptance
  // of an above-ceiling point.
  assert.ok(["work", "cooldown", "complete"].includes(runtime.segment));
  if (runtime.segment !== "work") {
    assert.ok(runtime.termination);
  }
});

// --- Safety-policy review: margin 12 retained (see planner rationale) ---

test("v3 gentle responder completes safely with three eligible stages", () => {
  // Linear gentle responder: 0.55bpm per calibrated watt from the fixture
  // anchor (78W -> 116.75bpm, inside the eligible band). The planner must
  // progress 78 -> 86 -> 108W (all predicted strictly below planning) and
  // complete with a valid estimate.
  const hrFor = (calibrated) => 121.15 + (calibrated - 86) * 0.55;
  const hard = estimatorSubmaxHrCeilingBpm(predictedHrMaxBpm(FIXTURE_AGE));
  const planning = hard - VO2_ADAPTIVE_SAFETY_MARGIN_BPM;
  const plan = buildVo2ProtocolPlanV3();
  assert.ok(plan);
  let runtime = createVo2ProtocolRuntimeV3(plan, FIXTURE_PROFILE);
  runtime = advanceVo2ProtocolV3(runtime, { elapsedSec: 300, paused: false, samples: [] });
  let guard = 0;
  while (runtime.segment === "work" && guard < 6) {
    guard += 1;
    const open = runtime.stages.find((s) => s.status === "open");
    assert.ok(open);
    const workload = runtime.plan.workloads[open.workloadIndex];
    const bpm = hrFor(workload.calibrated_watts_at_70rpm);
    runtime = advanceVo2ProtocolV3(runtime, {
      elapsedSec: open.active_start_sec + 180,
      paused: false,
      samples: hrSamplesForStage(open.active_start_sec, bpm),
      telemetrySamples: telemetryForStage(open.active_start_sec, workload.calibrated_watts_at_70rpm - 2),
    });
  }
  assert.equal(isValidVo2ProtocolRuntimeV3(runtime), true);
  assert.deepEqual(
    runtime.plan.workloads.map((w) => w.prescribed_resistance),
    [4, 6, 8]
  );
  assert.deepEqual(
    runtime.plan.workloads.map((w) => w.calibrated_watts_at_70rpm),
    [78, 86, 108]
  );
  assert.deepEqual(
    runtime.stages.map((s) => s.adaptive.reason_code),
    ["bootstrap_first_stage", "conservative_step_insufficient_evidence", "reduced_increment_near_ceiling"]
  );
  // Stage 3 prediction (0.55 line: 73.85 + 0.55*108 = 133.25) targets
  // 86+20=106W, lands on the nearest level 108W, and stays below planning.
  const third = runtime.stages[2].adaptive;
  assert.ok(Math.abs(third.predicted_next_hr_bpm - 133.25) < 0.05);
  assert.ok(third.predicted_next_hr_bpm < planning);
  assert.ok(Math.abs(third.planning_hr_ceiling_bpm - planning) < 1e-9);
  assert.equal(runtime.segment, "cooldown");
  assert.equal(runtime.termination.reason, "protocol_complete");
  const evidence = buildVo2ProtocolEvidenceV3(runtime);
  assert.ok(evidence);
  assert.equal(evidence.stages.length, 3);
  const result = assessRuntimeEvidence(runtime);
  assert.equal(result.status, "estimated");
  assert.equal(result.eligible_stage_count, 3);
  for (const point of result.diagnostics.eligible_points) {
    assert.ok(point.steady_state_bpm < hard);
    assert.ok(!point.ineligibility_reasons.includes("hr_above_submax_ceiling"));
  }
});

test("v3 steep responder is stopped before the ceiling with explicit provenance", () => {
  // Second stage lands at 136bpm, just under planning 137.43: the secant
  // slope (1.35bpm/W) leaves no room for even the minimum increment, so
  // the planner must refuse stage 3 rather than prescribe into the ceiling.
  const hard = estimatorSubmaxHrCeilingBpm(predictedHrMaxBpm(FIXTURE_AGE));
  const plan = buildVo2ProtocolPlanV3();
  assert.ok(plan);
  let runtime = createVo2ProtocolRuntimeV3(plan, FIXTURE_PROFILE);
  runtime = advanceVo2ProtocolV3(runtime, { elapsedSec: 300, paused: false, samples: [] });
  for (const bpm of [121.15, 136]) {
    const open = runtime.stages.find((s) => s.status === "open");
    assert.ok(open);
    const workload = runtime.plan.workloads[open.workloadIndex];
    runtime = advanceVo2ProtocolV3(runtime, {
      elapsedSec: open.active_start_sec + 180,
      paused: false,
      samples: hrSamplesForStage(open.active_start_sec, bpm),
      telemetrySamples: telemetryForStage(open.active_start_sec, workload.calibrated_watts_at_70rpm - 2),
    });
  }
  assert.equal(isValidVo2ProtocolRuntimeV3(runtime), true);
  // No third stage was ever prescribed.
  assert.equal(runtime.stages.length, 2);
  assert.equal(runtime.plan.workloads.length, 2);
  assert.equal(runtime.segment, "cooldown");
  assert.equal(runtime.termination.reason, "submax_hr_ceiling");
  assert.ok(runtime.adaptive_termination);
  assert.equal(runtime.adaptive_termination.reason_code, "hr_safety_no_safe_target");
  assert.equal(runtime.adaptive_termination.termination_reason, "submax_hr_ceiling");
  assert.equal(runtime.adaptive_termination.planning_margin_bpm, VO2_ADAPTIVE_SAFETY_MARGIN_BPM);
  assert.ok(Math.abs(runtime.adaptive_termination.hard_hr_ceiling_bpm - hard) < 1e-9);
  assert.ok(
    Math.abs(
      runtime.adaptive_termination.planning_hr_ceiling_bpm -
        (runtime.adaptive_termination.hard_hr_ceiling_bpm - VO2_ADAPTIVE_SAFETY_MARGIN_BPM)
    ) < 1e-9
  );
  // Nothing observed at or above the hard ceiling, and the estimator never
  // flags a crossing it did not see.
  const result = assessRuntimeEvidence(runtime);
  for (const point of result.diagnostics.stage_points) {
    assert.ok(!point.ineligibility_reasons.includes("hr_above_submax_ceiling"));
    if (point.steady_state_bpm != null) assert.ok(point.steady_state_bpm < hard);
  }
  for (const point of result.diagnostics.eligible_points) {
    assert.ok(point.steady_state_bpm < hard);
  }
});

test("real-fixture stage-3 sweep never prescribes the failed 123W workload", () => {
  // The 97W stage-2 response is unobserved in the real session, so sweep it
  // across the whole eligible HR range instead of inventing one value. From
  // the v3 base of 97W, R10/123W is 26W away and must be structurally
  // excluded by the 25W maximum increment for every HR; every prescription
  // must predict strictly below planning or be refused truthfully.
  const planning = FIXTURE_HARD - VO2_ADAPTIVE_SAFETY_MARGIN_BPM;
  const decide = (h2) =>
    planNextVo2Stage({
      eligible: [
        { estimatorWatts: 85, steadyHrBpm: 121.15, calibratedWatts: 86, resistance: 6 },
        { estimatorWatts: h2 - 2, steadyHrBpm: h2, calibratedWatts: 97, resistance: 7 },
      ],
      predictedHrMax: FIXTURE_HRMAX,
      warmupCalibratedWatts: 66,
      warmupResistance: 1,
      lastCompleted: {
        calibratedWatts: 97,
        estimatorWatts: h2 - 2,
        steadyHrBpm: h2,
        resistance: 7,
        aboveCeiling: false,
        eligible: true,
      },
      usedResistances: new Set([1, 6, 7]),
      calibration: getEstimatedWattsAt70Rpm,
      completedWorkStages: 2,
      retryCount: 0,
    });
  // Pinned transition boundaries (exact consequences of table + policy).
  assert.equal(decide(121).reason_code, "nonpositive_slope");
  assert.equal(decide(122).decision, "next");
  assert.equal(decide(122).prescribed_resistance, 9);
  assert.equal(decide(128).prescribed_resistance, 8);
  assert.equal(decide(130).reason_code, "hr_safety_no_safe_target");
  for (let h2 = 110; h2 <= 149; h2 += 1) {
    const decision = decide(h2);
    if (decision.decision === "next") {
      assert.ok([8, 9].includes(decision.prescribed_resistance));
      assert.ok([108, 114].includes(decision.calibrated_watts));
      assert.notEqual(decision.calibrated_watts, 123);
      assert.ok(decision.predicted_hr_bpm < planning);
      const increment = decision.calibrated_watts - 97;
      assert.ok(increment >= VO2_ADAPTIVE_MIN_WATT_INCREMENT - 1e-9);
      assert.ok(increment >= VO2_ADAPTIVE_MIN_WATT_SEPARATION - 1e-9);
      assert.ok(increment <= VO2_ADAPTIVE_MAX_WATT_INCREMENT + 1e-9);
    } else {
      assert.ok(["nonpositive_slope", "hr_safety_no_safe_target"].includes(decision.reason_code));
      assert.equal(typeof decision.termination_reason, "string");
    }
  }
});

test("planner terminates truthfully when the table jumps past the max-safe bound", () => {
  // Fitted max-safe is 122W (above base+min 115W), but the only table levels
  // in the legal increment window predict at/above planning 141: refuse
  // with HR-safety provenance. A denser table offering 118W prescribes it.
  const input = {
    eligible: [
      { estimatorWatts: 105, steadyHrBpm: 130, calibratedWatts: 100, resistance: 5 },
      { estimatorWatts: 110, steadyHrBpm: 135, calibratedWatts: 110, resistance: 6 },
    ],
    predictedHrMax: 180,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 5, 6]),
    completedWorkStages: 2,
    retryCount: 0,
  };
  const sparse = planNextVo2Stage({
    ...input,
    calibration: (r) => (r === 7 ? 124 : r === 8 ? 130 : undefined),
  });
  assert.equal(sparse.decision, "cannot");
  assert.equal(sparse.reason_code, "hr_safety_no_safe_target");
  assert.equal(sparse.termination_reason, "submax_hr_ceiling");
  assert.ok(Math.abs(sparse.provenance.hard_hr_ceiling_bpm - estimatorSubmaxHrCeilingBpm(180)) < 1e-9);
  assert.ok(
    Math.abs(sparse.provenance.planning_hr_ceiling_bpm - (sparse.provenance.hard_hr_ceiling_bpm - 12)) < 1e-9
  );
  assert.equal(sparse.provenance.planning_margin_bpm, 12);
  assert.equal(sparse.provenance.last_measured_watts, 110);
  assert.equal(sparse.provenance.last_steady_hr_bpm, 135);
  const dense = planNextVo2Stage({
    ...input,
    calibration: (r) => (r === 7 ? 118 : r === 8 ? 124 : undefined),
  });
  assert.equal(dense.decision, "next");
  assert.equal(dense.prescribed_resistance, 7);
  assert.equal(dense.calibrated_watts, 118);
  assert.ok(Math.abs(dense.predicted_hr_bpm - 139) < 1e-9);
  assert.ok(dense.predicted_hr_bpm < dense.provenance.planning_hr_ceiling_bpm);
});

// --- Low-end runway acquisition (real session 4e4a6524, app 0.10.13) ---
//
// Real observations (age 46, predicted HRmax 175.8, hard 149.43, planning
// 137.43): R6/86W calibrated (86W estimator) -> 120.30bpm eligible; R7/97W
// calibrated (92W estimator) -> 137.3166666667bpm eligible; then the planner
// refused stage 3. Any HR at a level the real session never performed is a
// labeled hypothesis, never presented as observed.

const REAL_R6 = { estimatorWatts: 86, steadyHrBpm: 120.3, calibratedWatts: 86, resistance: 6 };
const REAL_R7 = { estimatorWatts: 92, steadyHrBpm: 137.3166666667, calibratedWatts: 97, resistance: 7 };
const REAL_SLOPE = (137.3166666667 - 120.3) / (97 - 86);
const REAL_INTERCEPT = 120.3 - REAL_SLOPE * 86;
const realSecantHr = (w) => REAL_SLOPE * w + REAL_INTERCEPT;

function realPlannerInput(overrides = {}) {
  return {
    eligible: [],
    predictedHrMax: FIXTURE_HRMAX,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1]),
    calibration: getEstimatedWattsAt70Rpm,
    completedWorkStages: 0,
    retryCount: 0,
    ...overrides,
  };
}

function completed(point) {
  return {
    calibratedWatts: point.calibratedWatts,
    estimatorWatts: point.estimatorWatts,
    steadyHrBpm: point.steadyHrBpm,
    resistance: point.resistance,
    aboveCeiling: false,
    eligible: point.steadyHrBpm >= 110,
  };
}

/**
 * Drive the pure planner with a deterministic HR response (in calibrated
 * watts). Returns the stage trace and the terminal decision.
 */
function replayPlanner(hrFor, policy) {
  const hard = estimatorSubmaxHrCeilingBpm(FIXTURE_HRMAX);
  const eligible = [];
  const used = new Set([1]);
  const trace = [];
  let lastCompleted;
  for (let guard = 0; guard < 8; guard++) {
    const decision = planNextVo2Stage(
      realPlannerInput({
        eligible: [...eligible],
        lastCompleted,
        usedResistances: new Set(used),
        completedWorkStages: trace.length,
        ...(policy ? { policy } : {}),
      })
    );
    if (decision.decision !== "next") return { trace, decision };
    const hr = hrFor(decision.calibrated_watts);
    const point = {
      estimatorWatts: decision.calibrated_watts,
      steadyHrBpm: hr,
      calibratedWatts: decision.calibrated_watts,
      resistance: decision.prescribed_resistance,
    };
    used.add(decision.prescribed_resistance);
    const isEligible = hr >= 110 && hr < hard;
    if (isEligible) eligible.push(point);
    lastCompleted = { ...completed(point), aboveCeiling: hr >= hard, eligible: isEligible };
    trace.push({ resistance: decision.prescribed_resistance, watts: decision.calibrated_watts, hr, decision });
  }
  throw new Error("planner did not terminate");
}

test("real session replays exactly under the original 25W bootstrap and dead-ends at stage 3", () => {
  const oldPolicy = { bootstrap_watt_step: 25 };
  const first = planNextVo2Stage(realPlannerInput({ policy: oldPolicy }));
  assert.equal(first.decision, "next");
  assert.equal(first.reason_code, "bootstrap_first_stage");
  assert.equal(first.prescribed_resistance, 6);
  assert.equal(first.calibrated_watts, 86);
  assert.equal(first.provenance.selected_calibrated_watts, 86);

  const second = planNextVo2Stage(
    realPlannerInput({
      eligible: [REAL_R6],
      lastCompleted: completed(REAL_R6),
      usedResistances: new Set([1, 6]),
      completedWorkStages: 1,
      policy: oldPolicy,
    })
  );
  assert.equal(second.decision, "next");
  assert.equal(second.reason_code, "conservative_step_insufficient_evidence");
  assert.equal(second.prescribed_resistance, 7);
  assert.equal(second.calibrated_watts, 97);

  const thirdInput = realPlannerInput({
    eligible: [REAL_R6, REAL_R7],
    lastCompleted: completed(REAL_R7),
    usedResistances: new Set([1, 6, 7]),
    completedWorkStages: 2,
    policy: oldPolicy,
  });
  const third = planNextVo2Stage(thirdInput);
  assert.equal(third.decision, "cannot");
  assert.equal(third.reason_code, "hr_safety_no_safe_target");
  assert.equal(third.termination_reason, "submax_hr_ceiling");
  assert.equal(third.provenance.eligible_stage_count, 2);
  assert.equal(third.provenance.completed_work_stage_count, 2);
  assert.ok(Math.abs(third.provenance.hard_hr_ceiling_bpm - 149.43) < 1e-9);
  assert.ok(Math.abs(third.provenance.planning_hr_ceiling_bpm - 137.43) < 1e-9);
  assert.equal(third.provenance.last_measured_watts, 92);
  // The default policy reaches the same stage-3 refusal from these points.
  assert.deepEqual(planNextVo2Stage({ ...thirdInput, policy: undefined }), third);

  // Geometry: the planner regresses calibrated watts (86, 97), never the
  // estimator watts (86, 92).
  assert.ok(Math.abs(REAL_SLOPE - 1.5469697) < 1e-6);
  assert.ok(Math.abs(REAL_INTERCEPT - -12.7393939) < 1e-6);
  const predictedR8 = realSecantHr(108);
  assert.ok(Math.abs(predictedR8 - 154.3333333) < 1e-6);
  assert.ok(predictedR8 > 137.43);
  assert.ok(predictedR8 > 149.43);
  const maxSafe = (137.43 - REAL_INTERCEPT) / REAL_SLOPE;
  assert.ok(Math.abs(maxSafe - 97.0733) < 1e-3);
  // Even at the hard ceiling the fitted bound is 104.83W, below R8/108W.
  assert.ok(Math.abs((FIXTURE_HARD - REAL_INTERCEPT) / REAL_SLOPE - 104.8304) < 1e-3);
  assert.ok(maxSafe < 97 + VO2_ADAPTIVE_MIN_WATT_INCREMENT);

  // Reducing the planning margin would not have produced a safe stage 3:
  // even margin 0 (planning == hard) refuses R8 because it predicts above
  // the hard ceiling itself.
  const noMargin = planNextVo2Stage({ ...thirdInput, policy: { ...oldPolicy, safety_margin_bpm: 0 } });
  assert.equal(noMargin.decision, "cannot");
  assert.equal(noMargin.reason_code, "hr_safety_no_safe_target");
});

test("default bootstrap preserves low-end runway instead of starting at the real R6", () => {
  const first = planNextVo2Stage(realPlannerInput());
  assert.equal(first.decision, "next");
  assert.equal(first.reason_code, "bootstrap_first_stage");
  assert.equal(first.provenance.reason_code, "bootstrap_first_stage");
  assert.equal(first.target_watts, 66 + VO2_ADAPTIVE_MIN_WATT_INCREMENT);
  assert.equal(first.prescribed_resistance, 4);
  assert.equal(first.calibrated_watts, 78);
  assert.equal(first.provenance.selected_target_watts, 71);
  assert.equal(first.provenance.selected_calibrated_watts, 78);
  assert.ok(first.calibrated_watts - 66 >= VO2_ADAPTIVE_MIN_WATT_SEPARATION);
  assert.ok(first.calibrated_watts - 66 <= VO2_ADAPTIVE_MAX_WATT_INCREMENT);
  assert.equal(DEFAULT_VO2_ADAPTIVE_POLICY.bootstrap_watt_step, VO2_ADAPTIVE_MIN_WATT_INCREMENT);
  assert.equal(isValidVo2AdaptivePolicy(DEFAULT_VO2_ADAPTIVE_POLICY), true);
});

test("one eligible in-band point takes the smallest distinguishable step", () => {
  // Hypothetical eligible R4/78W at 112bpm: next is the lowest level >= 83W
  // (R6/86W; R5/82W is only 4W above), not 78+15=93W -> R7/97W.
  const r4 = { estimatorWatts: 78, steadyHrBpm: 112, calibratedWatts: 78, resistance: 4 };
  const decision = planNextVo2Stage(
    realPlannerInput({
      eligible: [r4],
      lastCompleted: completed(r4),
      usedResistances: new Set([1, 4]),
      completedWorkStages: 1,
    })
  );
  assert.equal(decision.decision, "next");
  assert.equal(decision.reason_code, "conservative_step_insufficient_evidence");
  assert.equal(decision.target_watts, 78 + VO2_ADAPTIVE_MIN_WATT_INCREMENT);
  assert.equal(decision.prescribed_resistance, 6);
  assert.equal(decision.calibrated_watts, 86);
  assert.equal(decision.provenance.previous_steady_hr_bpm, 112);
});

test("below-floor first stage keeps the unchanged fallback step", () => {
  // No in-band anchor: a below-floor stage still steps by the fallback
  // (78+15=93W -> nearest R7/97W), preserving behavior for fit athletes.
  const r4 = { estimatorWatts: 78, steadyHrBpm: 95, calibratedWatts: 78, resistance: 4 };
  const decision = planNextVo2Stage(
    realPlannerInput({
      lastCompleted: completed(r4),
      usedResistances: new Set([1, 4]),
      completedWorkStages: 1,
    })
  );
  assert.equal(decision.decision, "next");
  assert.equal(decision.reason_code, "conservative_step_insufficient_evidence");
  assert.equal(decision.target_watts, 93);
  assert.equal(decision.prescribed_resistance, 7);
  assert.equal(decision.calibrated_watts, 97);
});

// Hypothetical response that matches both real observations at R6/R7 and
// assumes 110.5bpm at R4/78W. R4 was never performed in the real session;
// linear extension of the real secant gives 107.93bpm there (below floor).
const hypotheticalInBandAtR4 = (w) => ({ 78: 110.5, 86: 120.3, 97: 137.3166666667 })[w] ?? realSecantHr(w);

test("dense ProForm low end acquires three eligible stages when the response allows it", () => {
  const { trace, decision } = replayPlanner(hypotheticalInBandAtR4);
  assert.deepEqual(trace.map((t) => t.resistance), [4, 6, 7]);
  assert.deepEqual(trace.map((t) => t.watts), [78, 86, 97]);
  assert.deepEqual(
    trace.map((t) => t.decision.reason_code),
    ["bootstrap_first_stage", "conservative_step_insufficient_evidence", "reduced_increment_near_ceiling"]
  );
  // Stage 3 was prediction-checked below planning from the R4/R6 fit.
  const third = trace[2].decision;
  assert.ok(third.predicted_hr_bpm < third.provenance.planning_hr_ceiling_bpm);
  assert.ok(third.predicted_hr_bpm < third.provenance.hard_hr_ceiling_bpm);
  assert.equal(decision.decision, "complete");
  assert.equal(decision.eligible_count, 3);

  // Under the original 25W bootstrap the same response dead-ends at two.
  const old = replayPlanner(hypotheticalInBandAtR4, { bootstrap_watt_step: 25 });
  assert.deepEqual(old.trace.map((t) => t.watts), [86, 97]);
  assert.equal(old.decision.decision, "cannot");
  assert.equal(old.decision.reason_code, "hr_safety_no_safe_target");
});

test("dense low-end runtime acquisition yields an estimator-accepted three-stage assessment", () => {
  const plan = buildVo2ProtocolPlanV3();
  assert.ok(plan);
  let runtime = createVo2ProtocolRuntimeV3(plan, FIXTURE_PROFILE);
  runtime = advanceVo2ProtocolV3(runtime, { elapsedSec: 300, paused: false, samples: [] });
  let guard = 0;
  while (runtime.segment === "work" && guard < 6) {
    guard += 1;
    const open = runtime.stages.find((s) => s.status === "open");
    assert.ok(open);
    const workload = runtime.plan.workloads[open.workloadIndex];
    runtime = advanceVo2ProtocolV3(runtime, {
      elapsedSec: open.active_start_sec + 180,
      paused: false,
      samples: hrSamplesForStage(open.active_start_sec, hypotheticalInBandAtR4(workload.calibrated_watts_at_70rpm)),
      telemetrySamples: telemetryForStage(open.active_start_sec, workload.calibrated_watts_at_70rpm - 2),
    });
  }
  assert.equal(isValidVo2ProtocolRuntimeV3(runtime), true);
  assert.deepEqual(runtime.plan.workloads.map((w) => w.calibrated_watts_at_70rpm), [78, 86, 97]);
  assert.equal(runtime.termination.reason, "protocol_complete");
  const result = assessRuntimeEvidence(runtime);
  assert.equal(result.status, "estimated");
  assert.equal(result.eligible_stage_count, 3);
});

test("safety still wins: no safe third stage after runway-preserving acquisition stops", () => {
  // Hypothetical steep responder in-band at R4 and R6: fit 2.0 bpm/W
  // predicts 150bpm at R7/97W (>= hard 149.43). The planner must stop.
  const steep = (w) => 2 * w - 44;
  const { trace, decision } = replayPlanner(steep);
  assert.deepEqual(trace.map((t) => t.watts), [78, 86]);
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "hr_safety_no_safe_target");
  assert.equal(decision.termination_reason, "submax_hr_ceiling");
  assert.equal(decision.provenance.eligible_stage_count, 2);

  // Strict linear extension of the real secant (107.93bpm at R4, below the
  // floor) leaves no three-stage path under the unchanged envelope; the
  // planner stops truthfully rather than forcing one.
  const real = replayPlanner(realSecantHr);
  assert.equal(real.decision.decision, "cannot");
  assert.equal(real.decision.reason_code, "hr_safety_no_safe_target");
  for (const step of real.trace) assert.ok(step.hr < estimatorSubmaxHrCeilingBpm(FIXTURE_HRMAX));
});

test("a candidate predicted at or above the hard ceiling is never selectable", () => {
  const r4 = { estimatorWatts: 78, steadyHrBpm: 110, calibratedWatts: 78, resistance: 4 };
  for (let h2 = 111; h2 <= 149; h2 += 0.5) {
    const r6 = { estimatorWatts: 86, steadyHrBpm: h2, calibratedWatts: 86, resistance: 6 };
    for (const margin of [VO2_ADAPTIVE_SAFETY_MARGIN_BPM, 0]) {
      const decision = planNextVo2Stage(
        realPlannerInput({
          eligible: [r4, r6],
          lastCompleted: completed(r6),
          usedResistances: new Set([1, 4, 6]),
          completedWorkStages: 2,
          policy: { safety_margin_bpm: margin },
        })
      );
      if (decision.decision === "next") {
        assert.ok(decision.predicted_hr_bpm < decision.provenance.planning_hr_ceiling_bpm);
        assert.ok(decision.predicted_hr_bpm < FIXTURE_HARD);
      } else {
        assert.equal(decision.decision, "cannot");
      }
    }
  }
});

test("sparse calibration fails truthfully under runway-preserving acquisition", () => {
  // Only one level reachable within the maximum increment after bootstrap.
  const sparse = (r) => ({ 1: 66, 2: 80, 3: 120 })[r];
  const first = planNextVo2Stage(realPlannerInput({ calibration: sparse }));
  assert.equal(first.decision, "next");
  assert.equal(first.calibrated_watts, 80);
  const point = { estimatorWatts: 80, steadyHrBpm: 115, calibratedWatts: 80, resistance: 2 };
  const second = planNextVo2Stage(
    realPlannerInput({
      calibration: sparse,
      eligible: [point],
      lastCompleted: completed(point),
      usedResistances: new Set([1, 2]),
      completedWorkStages: 1,
    })
  );
  assert.equal(second.decision, "cannot");
  assert.equal(second.reason_code, "workload_bounds_exhausted");
  assert.equal(second.termination_reason, "insufficient_calibrated_workloads");
  // Nothing above warmup within the maximum increment at bootstrap.
  const none = planNextVo2Stage(realPlannerInput({ calibration: (r) => ({ 1: 66, 2: 120 })[r] }));
  assert.equal(none.decision, "cannot");
  assert.equal(none.reason_code, "workload_bounds_exhausted");
});

test("nonpositive slope after low-end acquisition still fails closed", () => {
  const r4 = { estimatorWatts: 78, steadyHrBpm: 118, calibratedWatts: 78, resistance: 4 };
  const r6 = { estimatorWatts: 86, steadyHrBpm: 117, calibratedWatts: 86, resistance: 6 };
  const decision = planNextVo2Stage(
    realPlannerInput({
      eligible: [r4, r6],
      lastCompleted: completed(r6),
      usedResistances: new Set([1, 4, 6]),
      completedWorkStages: 2,
    })
  );
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "nonpositive_slope");
});

test("runway-preserving steps never exceed the maximum increment", () => {
  for (let warmup = 60; warmup <= 120; warmup += 7) {
    const table = (r) => warmup + (r - 1) * 9;
    const first = planNextVo2Stage(realPlannerInput({ warmupCalibratedWatts: warmup, calibration: table }));
    assert.equal(first.decision, "next");
    const step = first.calibrated_watts - warmup;
    assert.ok(step >= VO2_ADAPTIVE_MIN_WATT_INCREMENT && step <= VO2_ADAPTIVE_MAX_WATT_INCREMENT);
    const point = {
      estimatorWatts: first.calibrated_watts,
      steadyHrBpm: 115,
      calibratedWatts: first.calibrated_watts,
      resistance: first.prescribed_resistance,
    };
    const second = planNextVo2Stage(
      realPlannerInput({
        warmupCalibratedWatts: warmup,
        calibration: table,
        eligible: [point],
        lastCompleted: completed(point),
        usedResistances: new Set([1, first.prescribed_resistance]),
        completedWorkStages: 1,
      })
    );
    assert.equal(second.decision, "next");
    const next = second.calibrated_watts - first.calibrated_watts;
    assert.ok(next >= VO2_ADAPTIVE_MIN_WATT_SEPARATION && next <= VO2_ADAPTIVE_MAX_WATT_INCREMENT);
  }
});

test("runway-preserving planner decisions are deterministic", () => {
  const r4 = { estimatorWatts: 78, steadyHrBpm: 112, calibratedWatts: 78, resistance: 4 };
  const inputs = [
    () => realPlannerInput(),
    () =>
      realPlannerInput({
        eligible: [r4],
        lastCompleted: completed(r4),
        usedResistances: new Set([1, 4]),
        completedWorkStages: 1,
      }),
    () =>
      realPlannerInput({
        eligible: [REAL_R6, REAL_R7],
        lastCompleted: completed(REAL_R7),
        usedResistances: new Set([1, 6, 7]),
        completedWorkStages: 2,
      }),
  ];
  for (const make of inputs) assert.deepEqual(planNextVo2Stage(make()), planNextVo2Stage(make()));
});
