import assert from "node:assert/strict";
import test from "node:test";
import {
  VO2_MIN_ELIGIBLE_STAGES,
  VO2_ESTIMATOR_MIN_HR_BPM,
  VO2_ESTIMATOR_SUBMAX_HRMAX_FRACTION,
  assessVo2,
  assessVo2V1,
  classifyVo2ProtocolStage,
  estimatorSubmaxHrCeilingBpm,
  isSupportedVo2EstimatorProtocolPair,
  predictedHrMaxBpm,
} from "../dist/vo2Estimator.js";
import {
  VO2_PROTOCOL_ID,
  VO2_PROTOCOL_VERSION,
  VO2_PROTOCOL_VERSION_V2,
  VO2_PROTOCOL_VERSION_V3,
  VO2_EVIDENCE_SCHEMA_VERSION,
} from "../dist/types.js";
import { LEGACY_VO2_PROTOCOL_VERSION_V1 } from "../dist/types.js";
import {
  buildVo2ProtocolPlan,
  createVo2ProtocolRuntime,
  advanceVo2Protocol,
  resolveProtocolWorkloads,
} from "../dist/vo2Protocol.js";
import {
  buildVo2ProtocolPlanV3,
  createVo2ProtocolRuntimeV3,
  advanceVo2ProtocolV3,
  buildVo2ProtocolEvidenceV3,
  isValidVo2ProtocolRuntimeV3,
} from "../dist/vo2ProtocolV3.js";
import {
  DEFAULT_VO2_ADAPTIVE_POLICY,
  VO2_ADAPTIVE_SAFETY_MARGIN_BPM,
  VO2_ADAPTIVE_MIN_WATT_SEPARATION,
  VO2_ADAPTIVE_MAX_WORK_STAGES,
  VO2_ADAPTIVE_MAX_RETRIES_AFTER_ABOVE_CEILING,
  planNextVo2Stage,
} from "../dist/vo2AdaptivePlanner.js";
import { measuredWorkloadForTests } from "../dist/vo2Workload.js";
import { vo2AssessmentPresentation } from "../dist/vo2AssessmentView.js";
import { getEstimatedWattsAt70Rpm } from "../dist/machines/proformSmartPower10.js";

// Sanitized deterministic fixture from the real age-46 session.
const FIXTURE_AGE = 46;
const FIXTURE_WEIGHT = 52.1631;
const FIXTURE_HRMAX = 175.8;
const FIXTURE_HARD = 149.43;
const FIXTURE_PROFILE = { age_years: FIXTURE_AGE, weight_kg: FIXTURE_WEIGHT };

function fixtureStage(id, calibratedWatts, measuredWatts, hr, resistance, start = 0) {
  return {
    stage_id: id,
    active_start_sec: start,
    active_end_sec: start + 180,
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
      final_two_window_delta_bpm: 1.5,
      steady_state_bpm: hr,
    },
    workload: measuredWorkloadForTests(measuredWatts, {
      calibrated_watts_at_70rpm: calibratedWatts,
      measured_watts_median: measuredWatts,
    }),
  };
}

function v1FixtureEvidence() {
  return {
    schema_version: 1,
    active_duration_sec: 960,
    paused_duration_sec: 0,
    work_end_active_sec: 960,
    cooldown_start_active_sec: 960,
    early_cooldown: false,
    phases: [],
    hr: { source: "ble_chest_strap", sample_count: 600 },
    protocol: {
      protocol_id: VO2_PROTOCOL_ID,
      protocol_version: LEGACY_VO2_PROTOCOL_VERSION_V1,
      prescribed_cadence_rpm: 70,
      stages: [
        fixtureStage("vo2-stage:1", 86, 85, 121.15, 6, 300),
        fixtureStage("vo2-stage:2", 108, 102, 132.25, 8, 480),
        fixtureStage("vo2-stage:3", 123, 119, 154.1167, 10, 720),
      ],
      termination: { reason: "protocol_complete" },
      automatic_submax_hr_ceiling_available: false,
    },
  };
}

function v2FixtureEvidence() {
  const evidence = v1FixtureEvidence();
  evidence.schema_version = VO2_EVIDENCE_SCHEMA_VERSION;
  evidence.protocol.protocol_version = VO2_PROTOCOL_VERSION;
  evidence.protocol.automatic_submax_hr_ceiling_available = true;
  return evidence;
}

test("fixture constants pin the real session envelope", () => {
  assert.equal(predictedHrMaxBpm(FIXTURE_AGE), FIXTURE_HRMAX);
  assert.ok(Math.abs(estimatorSubmaxHrCeilingBpm(FIXTURE_HRMAX) - FIXTURE_HARD) < 0.01);
  assert.equal(VO2_ESTIMATOR_SUBMAX_HRMAX_FRACTION, 0.85);
  assert.equal(VO2_ESTIMATOR_MIN_HR_BPM, 110);
  assert.equal(VO2_MIN_ELIGIBLE_STAGES, 3);
});

test("1: historical protocol v1 preserves behavior; 2: v1 rejects the 154.1167bpm point", () => {
  const evidence = v1FixtureEvidence();
  const result = assessVo2V1(evidence, FIXTURE_PROFILE);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.accepted_stage_count, 3);
  assert.equal(result.eligible_stage_count, 2);
  assert.equal(result.reason_codes.includes("too_few_eligible_stages"), true);
  assert.equal(result.reason_codes.includes("hr_above_submax_ceiling"), true);
  assert.deepEqual(result.stages_used, ["vo2-stage:1", "vo2-stage:2"]);
  assert.equal(result.estimate_ml_kg_min, undefined);
  const third = result.diagnostics.eligible_points.find((point) => point.stage_id === "vo2-stage:3");
  assert.equal(third, undefined);
});

test("12: old serialized v1 evidence remains readable and is never reinterpreted as adaptive", () => {
  const evidence = v1FixtureEvidence();
  const frozen = JSON.parse(JSON.stringify(evidence));
  const v1Result = assessVo2V1(evidence, FIXTURE_PROFILE);
  assert.equal(v1Result.schema_version, 1);
  assert.equal(v1Result.input_snapshot.protocol_version, 1);
  assert.deepEqual(evidence, frozen);
  const v2Result = assessVo2(evidence, FIXTURE_PROFILE);
  assert.equal(v2Result.status, "insufficient_evidence");
  assert.equal(v2Result.reason_codes.includes("unsupported_evidence_schema"), true);
  assert.equal(v2Result.reason_codes.includes("unsupported_protocol_version"), true);
  assert.equal(evidence.protocol.protocol_version, 1);
});

test("estimator v2 accepts adaptive v3 protocol without a version bump", () => {
  assert.equal(
    isSupportedVo2EstimatorProtocolPair("bike-submax-linear-hr-workload", 2, "bike-submax-70rpm", 2),
    true
  );
  assert.equal(
    isSupportedVo2EstimatorProtocolPair("bike-submax-linear-hr-workload", 2, "bike-submax-70rpm", 3),
    true
  );
  assert.equal(
    isSupportedVo2EstimatorProtocolPair("bike-submax-linear-hr-workload", 2, "bike-submax-70rpm", 1),
    false
  );
});

function plannerInputForFixture(policy) {
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
    policy,
  };
}

test("3: adaptive does not blindly reproduce v1 102->119W; chooses lower safe R9", () => {
  const v1Workloads = resolveProtocolWorkloads(getEstimatedWattsAt70Rpm, 3);
  const v1ThirdCalibrated = v1Workloads[2].calibrated_watts_at_70rpm;
  assert.equal(v1ThirdCalibrated, 123);
  const decision = planNextVo2Stage(plannerInputForFixture(undefined));
  assert.equal(decision.decision, "next");
  assert.equal(decision.prescribed_resistance, 9);
  assert.equal(decision.calibrated_watts, 114);
  assert.ok(decision.calibrated_watts < v1ThirdCalibrated);
  assert.ok(decision.calibrated_watts < 119 + 4);
  assert.equal(decision.reason_code, "reduced_increment_near_ceiling");
  assert.ok(decision.predicted_hr_bpm < 149.43 - VO2_ADAPTIVE_SAFETY_MARGIN_BPM);
});

test("4: adaptive selection stays below machine/protocol bounds; 5: respects planning margin", () => {
  const decision = planNextVo2Stage(plannerInputForFixture(undefined));
  assert.equal(decision.decision, "next");
  assert.ok(decision.prescribed_resistance >= 1 && decision.prescribed_resistance <= 10);
  assert.equal(decision.calibrated_watts, getEstimatedWattsAt70Rpm(decision.prescribed_resistance));
  assert.equal([1, 6, 8].includes(decision.prescribed_resistance), false);
  const hard = estimatorSubmaxHrCeilingBpm(FIXTURE_HRMAX);
  const planning = hard - VO2_ADAPTIVE_SAFETY_MARGIN_BPM;
  assert.ok(decision.predicted_hr_bpm < planning);
  assert.ok(hard - decision.predicted_hr_bpm > VO2_ADAPTIVE_SAFETY_MARGIN_BPM);
});

test("6: enough eligible points terminate successfully (planner complete)", () => {
  const decision = planNextVo2Stage({
    eligible: [
      { estimatorWatts: 85, steadyHrBpm: 121, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 95, steadyHrBpm: 128, calibratedWatts: 97, resistance: 7 },
      { estimatorWatts: 110, steadyHrBpm: 135, calibratedWatts: 114, resistance: 9 },
    ],
    predictedHrMax: 180,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 6, 7, 9]),
    calibration: getEstimatedWattsAt70Rpm,
    completedWorkStages: 3,
    retryCount: 0,
  });
  assert.equal(decision.decision, "complete");
  assert.equal(decision.reason_code, "sufficient_evidence");
});

test("7: two eligible points do not become a formal estimate", () => {
  const two = v2FixtureEvidence();
  two.protocol.stages = two.protocol.stages.slice(0, 2);
  const result = assessVo2(two, FIXTURE_PROFILE);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.eligible_stage_count, 2);
  assert.equal(result.estimate_ml_kg_min, undefined);
  const threeAcceptedTwoEligible = assessVo2(v2FixtureEvidence(), FIXTURE_PROFILE);
  assert.equal(threeAcceptedTwoEligible.status, "insufficient_evidence");
  assert.equal(threeAcceptedTwoEligible.eligible_stage_count, 2);
  assert.equal(threeAcceptedTwoEligible.reason_codes.includes("too_few_eligible_stages"), true);
  assert.equal(threeAcceptedTwoEligible.estimate_ml_kg_min, undefined);
});

test("8: above-ceiling point remains excluded from regression", () => {
  const result = assessVo2(v2FixtureEvidence(), FIXTURE_PROFILE);
  assert.equal(result.eligible_stage_count, 2);
  for (const point of result.diagnostics.eligible_points) {
    assert.notEqual(point.stage_id, "vo2-stage:3");
    assert.ok(point.watts !== 119);
    assert.ok(point.steady_state_bpm !== 154.1167);
  }
  assert.deepEqual(result.stages_used, ["vo2-stage:1", "vo2-stage:2"]);
});

test("9: above-ceiling observation cannot cause a subsequent workload increase", () => {
  const input = plannerInputForFixture(undefined);
  input.lastCompleted = {
    calibratedWatts: 123,
    estimatorWatts: 119,
    steadyHrBpm: 154.1167,
    resistance: 10,
    aboveCeiling: true,
    eligible: false,
  };
  input.usedResistances = new Set([1, 6, 8, 10]);
  input.completedWorkStages = 3;
  const decision = planNextVo2Stage(input);
  if (decision.decision === "next") {
    assert.ok(decision.calibrated_watts < 123);
    assert.equal(decision.provenance.decision, "retry");
  } else {
    assert.equal(decision.decision, "cannot");
  }
});

test("10: retry behavior is bounded; 11: refusal carries an explicit termination reason", () => {
  const input = plannerInputForFixture(undefined);
  input.lastCompleted = {
    calibratedWatts: 123,
    estimatorWatts: 119,
    steadyHrBpm: 154.1167,
    resistance: 10,
    aboveCeiling: true,
    eligible: false,
  };
  input.usedResistances = new Set([1, 6, 8, 10]);
  input.completedWorkStages = 3;
  input.retryCount = VO2_ADAPTIVE_MAX_RETRIES_AFTER_ABOVE_CEILING;
  const decision = planNextVo2Stage(input);
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "retry_limit_reached");
  assert.equal(decision.termination_reason, "submax_hr_ceiling");
  assert.ok(decision.provenance);
  assert.equal(decision.provenance.reason_code, "retry_limit_reached");
});

test("11: no safe/useful stage produces explicit HR-safety termination with provenance", () => {
  // Calibrated-domain planning with margin 15 refuses: R9 114W predicts
  // 135.27bpm which exceeds planning 134.43bpm (hard 149.43 - 15).
  const decision = planNextVo2Stage(plannerInputForFixture({ safety_margin_bpm: 15 }));
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "hr_safety_no_safe_target");
  assert.equal(decision.termination_reason, "submax_hr_ceiling");
  assert.equal(decision.provenance.hard_hr_ceiling_bpm > 0, true);
  assert.equal(decision.provenance.planning_margin_bpm, 15);
});

test("13: new evidence records protocol v3 and adaptive provenance", () => {
  const plan = buildVo2ProtocolPlanV3();
  assert.ok(plan);
  assert.equal(plan.protocol_version, VO2_PROTOCOL_VERSION_V3);
  assert.equal(VO2_PROTOCOL_VERSION, VO2_PROTOCOL_VERSION_V2);
  let runtime = createVo2ProtocolRuntimeV3(plan, FIXTURE_PROFILE);
  assert.equal(isValidVo2ProtocolRuntimeV3(runtime), true);
  runtime = advanceVo2ProtocolV3(runtime, { elapsedSec: 300, paused: false, samples: [] });
  assert.equal(runtime.segment, "work");
  assert.equal(runtime.stages.length, 1);
  assert.ok(runtime.stages[0].adaptive);
  assert.equal(runtime.stages[0].adaptive.provenance_version, 1);
  assert.equal(runtime.stages[0].adaptive.reason_code, "bootstrap_first_stage");
  const evidence = buildVo2ProtocolEvidenceV3(runtime);
  assert.ok(evidence);
  assert.equal(evidence.protocol_version, 3);
  assert.equal(evidence.stages[0].adaptive.selected_resistance, runtime.stages[0].adaptive.selected_resistance);
});

test("14: assessment UI renders HR-boundary failure accurately", () => {
  const result = assessVo2(v2FixtureEvidence(), FIXTURE_PROFILE);
  const view = vo2AssessmentPresentation(result);
  assert.equal(view.estimated, false);
  assert.equal(view.title, "Not enough submaximal stages to estimate VO₂ max");
  assert.match(view.body, /submaximal limit/);
  assert.equal(view.body.includes("wasn't enough stable workload"), false);
  assert.match(view.detail, /2 were valid for VO₂ estimation/);
  assert.match(view.detail, /At least 3 valid submaximal stages are required/);
  assert.match(view.detail, /Stage 3 was excluded because/);
  assert.match(view.detail, /submaximal ceiling/);
});

test("boundary: exact hard ceiling is ineligible; just below is eligible", () => {
  const hard = estimatorSubmaxHrCeilingBpm(FIXTURE_HRMAX);
  const atCeiling = fixtureStage("vo2-stage:1", 100, 100, hard, 5);
  const atPoint = classifyVo2ProtocolStage(atCeiling, FIXTURE_HRMAX, 1);
  assert.equal(atPoint.estimator_eligible, false);
  assert.equal(atPoint.ineligibility_reasons.includes("hr_above_submax_ceiling"), true);
  const below = fixtureStage("vo2-stage:1", 100, 100, hard - 0.01, 5);
  const belowPoint = classifyVo2ProtocolStage(below, FIXTURE_HRMAX, 1);
  assert.equal(belowPoint.ineligibility_reasons.includes("hr_above_submax_ceiling"), false);
});

test("boundary: exact planning ceiling is not prescribed", () => {
  const slope = 0.5;
  const intercept = 70;
  const planning = 145;
  const exactWatts = (planning - intercept) / slope;
  assert.equal(exactWatts, 150);
  const decision = planNextVo2Stage({
    eligible: [
      { estimatorWatts: 100, steadyHrBpm: 120, calibratedWatts: 100, resistance: 5 },
      { estimatorWatts: 120, steadyHrBpm: 130, calibratedWatts: 120, resistance: 6 },
    ],
    predictedHrMax: 180,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 5, 6]),
    calibration: (resistance) => {
      if (resistance === 7) return exactWatts;
      if (resistance === 8) return exactWatts - 10;
      return undefined;
    },
    completedWorkStages: 2,
    retryCount: 0,
  });
  assert.equal(decision.decision, "next");
  assert.notEqual(decision.calibrated_watts, exactWatts);
  assert.ok(decision.predicted_hr_bpm < planning);
});

test("boundary: minimum HR 110 is eligible; below is not", () => {
  const atFloor = fixtureStage("vo2-stage:1", 100, 100, 110, 5);
  const atPoint = classifyVo2ProtocolStage(atFloor, FIXTURE_HRMAX, 1);
  assert.equal(atPoint.ineligibility_reasons.includes("hr_below_estimator_range"), false);
  const below = fixtureStage("vo2-stage:1", 100, 100, 109.9, 5);
  const belowPoint = classifyVo2ProtocolStage(below, FIXTURE_HRMAX, 1);
  assert.equal(belowPoint.ineligibility_reasons.includes("hr_below_estimator_range"), true);
});

test("boundary: minimum useful separation is enforced", () => {
  const base = 100;
  const decision = planNextVo2Stage({
    eligible: [
      { estimatorWatts: 90, steadyHrBpm: 120, calibratedWatts: base, resistance: 5 },
      { estimatorWatts: 95, steadyHrBpm: 125, calibratedWatts: base + 2, resistance: 6 },
    ],
    predictedHrMax: 180,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 5, 6]),
    calibration: (resistance) => {
      if (resistance === 7) return base + VO2_ADAPTIVE_MIN_WATT_SEPARATION;
      if (resistance === 8) return base + VO2_ADAPTIVE_MIN_WATT_SEPARATION - 0.5;
      return undefined;
    },
    completedWorkStages: 2,
    retryCount: 0,
  });
  if (decision.decision === "next") {
    assert.ok(decision.calibrated_watts >= base + VO2_ADAPTIVE_MIN_WATT_SEPARATION - 1e-9);
  }
});

test("boundary: maximum workload and exhausted table fail closed explicitly", () => {
  const used = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const decision = planNextVo2Stage({
    eligible: [{ estimatorWatts: 85, steadyHrBpm: 121, calibratedWatts: 86, resistance: 6 }],
    predictedHrMax: 180,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: used,
    calibration: getEstimatedWattsAt70Rpm,
    completedWorkStages: 1,
    retryCount: 0,
  });
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "workload_bounds_exhausted");
  assert.equal(decision.termination_reason, "insufficient_calibrated_workloads");
});

test("boundary: maximum stage count fails closed explicitly", () => {
  const decision = planNextVo2Stage({
    eligible: [
      { estimatorWatts: 85, steadyHrBpm: 121, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 102, steadyHrBpm: 132, calibratedWatts: 108, resistance: 8 },
    ],
    predictedHrMax: 180,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 6, 8]),
    calibration: getEstimatedWattsAt70Rpm,
    completedWorkStages: VO2_ADAPTIVE_MAX_WORK_STAGES,
    retryCount: 0,
  });
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "stage_limit_reached");
  assert.equal(decision.termination_reason, "insufficient_eligible_stages");
});

test("v3 full executor: two eligible then HR-safety refusal preserves 30-minute bound", () => {
  function samplesInRange(start, end, bpm) {
    const samples = [];
    for (let t = start; t <= end; t++) samples.push({ timestamp_sec: t, hr: bpm });
    return samples;
  }
  function stageHr(stageStart, bpm) {
    return [
      ...samplesInRange(stageStart + 60, stageStart + 119, bpm),
      ...samplesInRange(stageStart + 120, stageStart + 179, bpm),
    ];
  }
  function stageTelemetry(stageStart, watts, rpm = 70) {
    const end = stageStart + 180;
    const samples = [];
    for (let t = end - 119; t <= end; t++) samples.push({ timestamp_sec: t, rpm, watts });
    return samples;
  }
  const plan = buildVo2ProtocolPlanV3(getEstimatedWattsAt70Rpm, { safety_margin_bpm: 15 });
  assert.ok(plan);
  let runtime = createVo2ProtocolRuntimeV3(plan, FIXTURE_PROFILE);
  runtime = advanceVo2ProtocolV3(runtime, { elapsedSec: 300, paused: false, samples: [] });
  const first = runtime.stages[0];
  runtime = advanceVo2ProtocolV3(runtime, {
    elapsedSec: first.active_start_sec + 180,
    paused: false,
    samples: stageHr(first.active_start_sec, 121.15),
    telemetrySamples: stageTelemetry(first.active_start_sec, 85),
  });
  const second = runtime.stages.find((stage) => stage.status === "open");
  assert.ok(second);
  runtime = advanceVo2ProtocolV3(runtime, {
    elapsedSec: second.active_start_sec + 180,
    paused: false,
    samples: stageHr(second.active_start_sec, 132.25),
    telemetrySamples: stageTelemetry(second.active_start_sec, 102),
  });
  assert.equal(runtime.segment, "cooldown");
  assert.equal(runtime.termination.reason, "submax_hr_ceiling");
  assert.ok(runtime.adaptive_termination);
  assert.equal(runtime.adaptive_termination.reason_code, "hr_safety_no_safe_target");
  const evidence = buildVo2ProtocolEvidenceV3(runtime);
  assert.ok(evidence);
  assert.equal(evidence.protocol_version, 3);
  assert.ok(evidence.adaptive_termination);
  const totalBound = 300 + VO2_ADAPTIVE_MAX_WORK_STAGES * 300 + 300;
  assert.ok(totalBound <= 1800);
});
