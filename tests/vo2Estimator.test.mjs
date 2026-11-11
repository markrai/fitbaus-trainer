import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import {
  ACSM_CYCLE_VO2_RESTING_ML_KG_MIN,
  ACSM_CYCLE_VO2_WATTS_COEFFICIENT,
  TANAKA_HRMAX_AGE_COEFFICIENT,
  TANAKA_HRMAX_INTERCEPT,
  VO2_ESTIMATOR_ID,
  VO2_ESTIMATOR_MIN_HR_BPM,
  VO2_ESTIMATOR_SUBMAX_HRMAX_FRACTION,
  VO2_ESTIMATOR_VERSION,
  LEGACY_VO2_ESTIMATOR_VERSION_V1,
  VO2_MIN_ACCEPTED_STAGES,
  VO2_MIN_R_SQUARED,
  assessVo2,
  assessVo2V1,
  cycleVo2MlKgMin,
  estimatorSubmaxHrCeilingBpm,
  fitHrVsWatts,
  predictedHrMaxBpm,
  isSupportedVo2EstimatorProtocolPair,
} from "../dist/vo2Estimator.js";
import {
  VO2_ASSESSMENT_SCHEMA_VERSION,
  VO2_ASSESSMENT_SCHEMA_VERSION_V1,
  VO2_ASSESSMENT_SCHEMA_VERSION_V2,
  VO2_EVIDENCE_SCHEMA_VERSION,
} from "../dist/types.js";
import { VO2_PROTOCOL_VERSION, VO2_TARGET_WORK_STAGES, VO2_WORKOUT_SELECTOR_ID } from "../dist/vo2Protocol.js";
import { parseExplicitVo2ProfileInputs, PROFILE_WEIGHT_LBS_TO_KG, getProfile, BLANK_PROFILE } from "../dist/profile.js";
import { generateWorkoutSummary } from "../dist/workoutSummary.js";
import { installStandaloneVo2Workout, getWorkoutMetadata } from "../dist/workoutData.js";
import {
  persistVo2ProtocolRuntime,
  startSession,
} from "../dist/sessionStore.js";
import {
  clearHrSamples,
  getAllWorkoutSummaries,
  resetWorkoutStorageForTests,
  storeHrSample,
  storeWorkoutSummary,
} from "../dist/workoutStorage.js";
import { buildVo2ProtocolPlan, createVo2ProtocolRuntime, advanceVo2Protocol } from "../dist/vo2Protocol.js";
import { vo2PlanBlocks } from "../dist/vo2Protocol.js";
import { buildSisuWorkoutPayload } from "../dist/sisuSync.js";
import {
  measuredWorkloadForTests,
  prescribedOnlyWorkloadForTests,
  verifiedCadenceWorkloadForTests,
  summarizeVo2StageWorkload,
  VO2_CADENCE_TOLERANCE_RPM,
} from "../dist/vo2Workload.js";
import { recordBikeTelemetrySample, clearBikeTelemetrySamples } from "../dist/bikeTelemetryTrace.js";

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

function acceptedStage(id, watts, hr, workload) {
  return {
    stage_id: id,
    active_start_sec: 0,
    active_end_sec: 180,
    requested_watts: watts,
    prescribed_resistance: 2,
    calibrated_watts_at_70rpm: watts,
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
    workload: workload ?? measuredWorkloadForTests(watts),
  };
}

function incompleteStage(id, watts) {
  return {
    stage_id: id,
    active_start_sec: 540,
    active_end_sec: 600,
    requested_watts: watts,
    prescribed_resistance: 5,
    calibrated_watts_at_70rpm: watts,
    status: "incomplete",
    nominal_duration_sec: 180,
    actual_duration_sec: 60,
  };
}

function evidenceFromStages(stages, termination = "protocol_complete", extra = {}) {
  return {
    schema_version: VO2_EVIDENCE_SCHEMA_VERSION,
    active_duration_sec: extra.active_duration_sec ?? 900,
    paused_duration_sec: 0,
    work_end_active_sec: 840,
    cooldown_start_active_sec: 840,
    early_cooldown: false,
    phases: [],
    hr: { source: "ble_chest_strap", sample_count: 200 },
    protocol: {
      protocol_id: "bike-submax-70rpm",
      protocol_version: VO2_PROTOCOL_VERSION,
      prescribed_cadence_rpm: 70,
      stages,
      termination: { reason: termination },
      automatic_submax_hr_ceiling_available: false,
    },
  };
}

const linearThree = [
  acceptedStage("vo2-stage:1", 100, 120),
  acceptedStage("vo2-stage:2", 125, 130),
  acceptedStage("vo2-stage:3", 150, 140),
];

const profile40_80 = { age_years: 40, weight_kg: 80 };

test("minimum accepted stages matches protocol target", () => {
  assert.equal(VO2_MIN_ACCEPTED_STAGES, VO2_TARGET_WORK_STAGES);
  assert.equal(VO2_MIN_ACCEPTED_STAGES, 3);
});

test("formal assessment version pairings are explicit and cross-pairings fail closed", () => {
  assert.equal(isSupportedVo2EstimatorProtocolPair(
    "bike-submax-linear-hr-workload", 1, "bike-submax-70rpm", 1
  ), true);
  assert.equal(isSupportedVo2EstimatorProtocolPair(
    "bike-submax-linear-hr-workload", 2, "bike-submax-70rpm", 2
  ), true);
  assert.equal(isSupportedVo2EstimatorProtocolPair(
    "bike-submax-linear-hr-workload", 1, "bike-submax-70rpm", 2
  ), false);
  assert.equal(isSupportedVo2EstimatorProtocolPair(
    "bike-submax-linear-hr-workload", 2, "bike-submax-70rpm", 1
  ), false);
});

test("historical estimator v1 remains bound to protocol v1 and schema v1", () => {
  const historicalEvidence = evidenceFromStages(linearThree);
  historicalEvidence.schema_version = 1;
  historicalEvidence.protocol.protocol_version = 1;
  historicalEvidence.protocol.automatic_submax_hr_ceiling_available = false;
  const result = assessVo2V1(historicalEvidence, profile40_80);
  assert.equal(result.status, "estimated");
  assert.equal(result.schema_version, VO2_ASSESSMENT_SCHEMA_VERSION_V1);
  assert.equal(result.estimator_version, LEGACY_VO2_ESTIMATOR_VERSION_V1);
  assert.equal(result.input_snapshot.protocol_version, 1);
  assert.equal(result.diagnostics.expected_protocol_version, 1);
  assert.equal("stage_points" in result.diagnostics, false);

  const currentWriterResult = assessVo2(historicalEvidence, profile40_80);
  assert.equal(currentWriterResult.status, "insufficient_evidence");
  assert.equal(currentWriterResult.reason_codes.includes("unsupported_evidence_schema"), true);
  assert.equal(currentWriterResult.reason_codes.includes("unsupported_protocol_version"), true);
});

test("historical estimator v1 fails closed for protocol-v1 evidence labeled schema v2", () => {
  const hybridEvidence = evidenceFromStages(linearThree);
  hybridEvidence.schema_version = 2;
  hybridEvidence.protocol.protocol_version = 1;
  hybridEvidence.protocol.automatic_submax_hr_ceiling_available = false;
  const result = assessVo2V1(hybridEvidence, profile40_80);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.estimate_ml_kg_min, undefined);
  assert.equal(result.schema_version, VO2_ASSESSMENT_SCHEMA_VERSION_V1);
  assert.equal(result.estimator_version, LEGACY_VO2_ESTIMATOR_VERSION_V1);
  assert.equal(result.reason_codes.includes("unsupported_protocol_version"), true);
});

test("deterministic linear dataset produces expected estimate", () => {
  const result = assessVo2(evidenceFromStages(linearThree), profile40_80);
  assert.equal(result.status, "estimated");
  assert.equal(result.estimator_id, VO2_ESTIMATOR_ID);
  assert.equal(result.estimator_version, VO2_ESTIMATOR_VERSION);
  assert.equal(result.schema_version, VO2_ASSESSMENT_SCHEMA_VERSION);
  assert.equal(result.schema_version, VO2_ASSESSMENT_SCHEMA_VERSION_V2);
  assert.equal(result.estimator_version, 2);
  assert.equal(result.termination_reason, "protocol_complete");
  assert.equal(result.accepted_stage_count, 3);
  assert.deepEqual(result.stages_used, ["vo2-stage:1", "vo2-stage:2", "vo2-stage:3"]);
  assert.equal(result.highest_accepted_workload_watts, 150);
  assert.equal(result.diagnostics.slope, 0.4);
  assert.equal(result.diagnostics.intercept, 80);
  assert.equal(result.diagnostics.r_squared, 1);
  const hrMax = predictedHrMaxBpm(40);
  assert.equal(hrMax, TANAKA_HRMAX_INTERCEPT - TANAKA_HRMAX_AGE_COEFFICIENT * 40);
  assert.equal(hrMax, 180);
  assert.equal(result.diagnostics.predicted_max_watts, 250);
  const expected = cycleVo2MlKgMin(250, 80);
  assert.equal(expected, (ACSM_CYCLE_VO2_WATTS_COEFFICIENT * 250) / 80 + ACSM_CYCLE_VO2_RESTING_ML_KG_MIN);
  assert.equal(expected, 40.75);
  assert.equal(result.estimate_ml_kg_min, 40.75);
  assert.equal(result.input_snapshot.age_years, 40);
  assert.equal(result.input_snapshot.weight_kg, 80);
  assert.equal(result.input_snapshot.predicted_hr_max, 180);
  assert.equal(result.input_snapshot.protocol_id, "bike-submax-70rpm");
  assert.equal(result.input_snapshot.protocol_version, 2);
  assert.equal(result.reason_codes.length, 0);
  assert.equal(result.fit_quality, "high");
  assert.equal(result.confidence, undefined);
  assert.equal(result.eligible_stage_count, 3);
  assert.equal(result.diagnostics.expected_protocol_id, "bike-submax-70rpm");
  assert.equal(result.diagnostics.expected_protocol_version, 2);
  assert.equal(result.diagnostics.observed_protocol_id, "bike-submax-70rpm");
  assert.equal(result.diagnostics.observed_protocol_version, 2);
  assert.equal(result.diagnostics.estimator_min_hr_bpm, VO2_ESTIMATOR_MIN_HR_BPM);
  assert.equal(result.diagnostics.estimator_submax_hrmax_fraction, VO2_ESTIMATOR_SUBMAX_HRMAX_FRACTION);
  for (const point of result.diagnostics.eligible_points) {
    assert.equal(point.estimator_eligible, true);
    assert.equal(point.workload_source, "measured_watts");
    assert.equal(point.cadence_measured, true);
    assert.equal(point.watts_measured, true);
  }
});

test("estimator uses accepted stages only", () => {
  const stages = [
    ...linearThree,
    incompleteStage("vo2-stage:4", 175),
    {
      ...acceptedStage("vo2-stage:skip", 200, 160),
      status: "unstable_hr",
      hr: { sample_count: 120, minute_2_mean_bpm: 150, minute_3_mean_bpm: 160, final_two_window_delta_bpm: 10 },
    },
  ];
  delete stages[4].hr.steady_state_bpm;
  const result = assessVo2(evidenceFromStages(stages, "limit_reached"), profile40_80);
  assert.equal(result.status, "estimated");
  assert.equal(result.accepted_stage_count, 3);
  assert.equal(result.stages_used.includes("vo2-stage:4"), false);
  assert.equal(result.stages_used.includes("vo2-stage:skip"), false);
  assert.equal(result.termination_reason, "limit_reached");
});

test("exactly 3 valid accepted stages can estimate", () => {
  const result = assessVo2(evidenceFromStages(linearThree, "user_cancelled"), profile40_80);
  assert.equal(result.status, "estimated");
  assert.equal(result.termination_reason, "user_cancelled");
});

test("fewer than 3 accepted stages is insufficient", () => {
  const result = assessVo2(evidenceFromStages(linearThree.slice(0, 2), "user_cancelled"), profile40_80);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.estimate_ml_kg_min, undefined);
  assert.equal(result.reason_codes.includes("too_few_accepted_stages"), true);
  assert.equal(result.accepted_stage_count, 2);
});

test("missing age is insufficient", () => {
  const result = assessVo2(evidenceFromStages(linearThree), { weight_kg: 80 });
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.reason_codes.includes("missing_profile_age"), true);
});

test("missing weight is insufficient", () => {
  const result = assessVo2(evidenceFromStages(linearThree), { age_years: 40 });
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.reason_codes.includes("missing_profile_weight"), true);
});

test("zero or negative HR-vs-workload slope is insufficient", () => {
  const stages = [
    acceptedStage("vo2-stage:1", 100, 150),
    acceptedStage("vo2-stage:2", 125, 140),
    acceptedStage("vo2-stage:3", 150, 130),
  ];
  const result = assessVo2(evidenceFromStages(stages), profile40_80);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.reason_codes.includes("invalid_hr_progression"), true);
});

test("invalid or non-finite extrapolation is insufficient", () => {
  const stages = [
    acceptedStage("vo2-stage:1", 100, 120),
    acceptedStage("vo2-stage:2", 125, 121),
    acceptedStage("vo2-stage:3", 150, 122),
  ];
  const result = assessVo2(evidenceFromStages(stages), profile40_80);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.reason_codes.includes("invalid_extrapolation"), true);
});

test("poor unusable regression is insufficient", () => {
  const stages = [
    acceptedStage("vo2-stage:1", 100, 112),
    acceptedStage("vo2-stage:2", 125, 113),
    acceptedStage("vo2-stage:3", 150, 114),
    acceptedStage("vo2-stage:4", 175, 152),
  ];
  const fit = fitHrVsWatts(
    stages.map((stage) => ({
      stage_id: stage.stage_id,
      watts: stage.calibrated_watts_at_70rpm,
      calibrated_watts_at_70rpm: stage.calibrated_watts_at_70rpm,
      steady_state_bpm: stage.hr.steady_state_bpm,
      protocol_accepted: true,
      estimator_eligible: true,
      ineligibility_reasons: [],
    }))
  );
  assert.ok(fit);
  assert.equal(fit.slope > 0, true);
  assert.equal(fit.r_squared < VO2_MIN_R_SQUARED, true);
  const result = assessVo2(evidenceFromStages(stages), profile40_80);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.reason_codes.includes("unstable_regression"), true);
});

test("estimator snapshots inputs and is stable across serialize/deserialize", () => {
  const result = assessVo2(evidenceFromStages(linearThree, "early_cooldown", { active_duration_sec: 700 }), profile40_80);
  assert.equal(result.input_snapshot.age_years, 40);
  assert.equal(result.input_snapshot.weight_kg, 80);
  const roundTrip = JSON.parse(JSON.stringify(result));
  assert.deepEqual(roundTrip, result);
});

test("nominal duration is not an eligibility input", () => {
  const short = assessVo2(evidenceFromStages(linearThree, "user_cancelled", { active_duration_sec: 720 }), profile40_80);
  const long = assessVo2(evidenceFromStages(linearThree, "protocol_complete", { active_duration_sec: 1800 }), profile40_80);
  assert.equal(short.status, "estimated");
  assert.equal(long.status, "estimated");
  assert.equal(short.estimate_ml_kg_min, long.estimate_ml_kg_min);
});

test("completed protocol can still be insufficient", () => {
  const unstable = {
    ...acceptedStage("vo2-stage:1", 100, 120),
    status: "unstable_hr",
  };
  delete unstable.hr.steady_state_bpm;
  const result = assessVo2(
    evidenceFromStages(
      [unstable, { ...unstable, stage_id: "vo2-stage:2" }, { ...unstable, stage_id: "vo2-stage:3" }],
      "protocol_complete"
    ),
    profile40_80
  );
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.termination_reason, "protocol_complete");
  assert.equal(result.reason_codes.includes("too_few_accepted_stages"), true);
});

test("unsaved profile defaults are not inferred", () => {
  assert.deepEqual(parseExplicitVo2ProfileInputs(undefined), {});
  assert.deepEqual(parseExplicitVo2ProfileInputs({}), {});
  const parsed = parseExplicitVo2ProfileInputs({ age: "40", weight: "176.37" });
  assert.equal(parsed.age_years, 40);
  assert.ok(Math.abs(parsed.weight_kg - 176.37 * PROFILE_WEIGHT_LBS_TO_KG) < 1e-6);
});

test("finalization attaches assessment and survives HR cleanup", async () => {
  installStandaloneVo2Workout();
  globalThis.window.getWorkoutMetadata = getWorkoutMetadata;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  await resetWorkoutStorageForTests();
  const sessionId = "vo2-finalize-hr";
  const startedAt = Date.now() - 900_000;
  const plan = buildVo2ProtocolPlan();
  let runtime = createVo2ProtocolRuntime(plan, profile40_80);
  runtime = advanceVo2Protocol(runtime, { elapsedSec: 300, paused: false, samples: [] });
  for (let i = 0; i < 3; i++) {
    const start = runtime.stages[i].active_start_sec;
    const watts = runtime.plan.workloads[runtime.stages[i].workloadIndex].calibrated_watts_at_70rpm;
    const bpm = 80 + 0.5 * watts;
    const samples = [];
    for (let t = start + 60; t <= start + 179; t++) {
      samples.push({ timestamp_sec: t, hr: bpm });
      await storeHrSample(sessionId, t, bpm);
    }
    const telemetrySamples = [];
    for (let t = start + 61; t <= start + 180; t++) {
      telemetrySamples.push({ timestamp_sec: t, rpm: 70, watts });
      recordBikeTelemetrySample(sessionId, { timestamp_sec: t, rpm: 70, watts });
    }
    runtime = advanceVo2Protocol(runtime, {
      elapsedSec: start + 180,
      paused: false,
      samples,
      telemetrySamples,
    });
  }
  startSession(VO2_WORKOUT_SELECTOR_ID, startedAt, sessionId, "bike", storage, {
    blocks: vo2PlanBlocks(),
    hrTargets: null,
  });
  persistVo2ProtocolRuntime(VO2_WORKOUT_SELECTOR_ID, runtime, storage);
  const summary = await generateWorkoutSummary(sessionId, startedAt, Date.now(), VO2_WORKOUT_SELECTOR_ID, {
    vo2Profile: profile40_80,
  });
  assert.ok(summary.vo2_assessment);
  assert.equal(typeof summary.athlete_id, "string");
  assert.equal(summary.athlete_fitness_snapshot.athleteId, summary.athlete_id);
  assert.equal(summary.athlete_fitness_snapshot.profileSchemaVersion, 1);
  assert.ok(summary.resolved_prescription);
  assert.equal(summary.resolved_prescription.workoutSelector, VO2_WORKOUT_SELECTOR_ID);
  assert.ok(summary.resolved_prescription.phases.every((phase) => phase.expectedHeartRate === undefined));
  assert.equal(summary.vo2_assessment.status, "estimated");
  assert.equal(summary.vo2_assessment.accepted_stage_count, 3);
  assert.equal(summary.vo2_assessment.fit_quality, "high");
  assert.equal(summary.vo2_assessment.confidence, undefined);
  for (const point of summary.vo2_assessment.diagnostics.eligible_points) {
    assert.equal(point.workload_source, "measured_watts");
    assert.equal(point.watts_measured, true);
  }
  for (const stage of summary.vo2_evidence.protocol.stages) {
    if (stage.status !== "accepted") continue;
    assert.equal(stage.workload.source, "measured_watts");
    assert.ok(stage.workload.estimator_watts > 0);
  }
  const frozen = JSON.parse(JSON.stringify(summary.vo2_assessment));
  await storeWorkoutSummary(summary);
  await clearHrSamples(sessionId);
  clearBikeTelemetrySamples(sessionId);
  const loaded = (await getAllWorkoutSummaries()).find((row) => row.summary?.external_session_id === sessionId);
  assert.ok(loaded);
  assert.deepEqual(loaded.summary.vo2_assessment, frozen);
  const payload = buildSisuWorkoutPayload(loaded.summary);
  assert.equal(payload.vo2_evidence, undefined);
  assert.equal(payload.vo2_assessment, undefined);
  assert.equal(payload.resolved_prescription, undefined);
  assert.equal(payload.athlete_id, undefined);
  assert.equal(payload.athlete_fitness_snapshot, undefined);
  assert.ok(loaded.summary.vo2_assessment);
  await resetWorkoutStorageForTests();
});

test("cancelled early stop with 3 accepted stages still estimates", async () => {
  const result = assessVo2(evidenceFromStages(linearThree, "user_cancelled", { active_duration_sec: 840 }), profile40_80);
  assert.equal(result.status, "estimated");
  assert.equal(result.termination_reason, "user_cancelled");
});

test("correct protocol id and version 2 remains eligible", () => {
  const result = assessVo2(evidenceFromStages(linearThree), profile40_80);
  assert.equal(result.status, "estimated");
  assert.equal(result.reason_codes.includes("unsupported_protocol_version"), false);
  assert.equal(result.reason_codes.includes("unsupported_protocol_id"), false);
  assert.equal(result.reason_codes.includes("missing_protocol_evidence"), false);
});

test("future protocol version is insufficient", () => {
  const evidence = evidenceFromStages(linearThree);
  evidence.protocol.protocol_version = 99;
  const result = assessVo2(evidence, profile40_80);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.estimate_ml_kg_min, undefined);
  assert.equal(result.reason_codes.includes("unsupported_protocol_version"), true);
  assert.equal(result.reason_codes.includes("missing_protocol_evidence"), false);
  assert.equal(result.diagnostics.expected_protocol_id, "bike-submax-70rpm");
  assert.equal(result.diagnostics.expected_protocol_version, 2);
  assert.equal(result.diagnostics.observed_protocol_id, "bike-submax-70rpm");
  assert.equal(result.diagnostics.observed_protocol_version, 99);
});

test("adaptive protocol v3 remains eligible under estimator v2 (same stage semantics)", () => {
  const evidence = evidenceFromStages(linearThree);
  evidence.protocol.protocol_version = 3;
  const result = assessVo2(evidence, profile40_80);
  assert.equal(result.status, "estimated");
  assert.equal(result.reason_codes.includes("unsupported_protocol_version"), false);
  assert.equal(result.diagnostics.observed_protocol_version, 3);
});

test("wrong protocol id is insufficient", () => {
  const evidence = evidenceFromStages(linearThree);
  evidence.protocol.protocol_id = "some-other-protocol";
  const result = assessVo2(evidence, profile40_80);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.reason_codes.includes("unsupported_protocol_id"), true);
  assert.equal(result.reason_codes.includes("missing_protocol_evidence"), false);
  assert.equal(result.reason_codes.includes("unsupported_protocol_version"), false);
  assert.equal(result.diagnostics.observed_protocol_id, "some-other-protocol");
  assert.equal(result.diagnostics.observed_protocol_version, 2);
});

test("missing protocol is insufficient", () => {
  const evidence = evidenceFromStages(linearThree);
  delete evidence.protocol;
  const result = assessVo2(evidence, profile40_80);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.reason_codes.includes("missing_protocol_evidence"), true);
  assert.equal(result.reason_codes.includes("unsupported_protocol_version"), false);
  assert.equal(result.diagnostics.expected_protocol_id, "bike-submax-70rpm");
  assert.equal(result.diagnostics.expected_protocol_version, 2);
  assert.equal(result.diagnostics.observed_protocol_id, undefined);
});

test("HR below estimator range is rejected", () => {
  const stages = [
    acceptedStage("vo2-stage:1", 100, VO2_ESTIMATOR_MIN_HR_BPM - 1),
    acceptedStage("vo2-stage:2", 125, VO2_ESTIMATOR_MIN_HR_BPM),
    acceptedStage("vo2-stage:3", 150, VO2_ESTIMATOR_MIN_HR_BPM + 10),
  ];
  const result = assessVo2(evidenceFromStages(stages), profile40_80);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.reason_codes.includes("hr_below_estimator_range"), true);
  assert.equal(result.reason_codes.includes("too_few_eligible_stages"), true);
  assert.equal(result.estimate_ml_kg_min, undefined);
  assert.equal(result.diagnostics.accepted_points[0].estimator_eligible, false);
  assert.equal(result.diagnostics.accepted_points[1].estimator_eligible, true);
});

test("HR at or above submax ceiling is rejected", () => {
  const hrMax = predictedHrMaxBpm(40);
  const ceiling = estimatorSubmaxHrCeilingBpm(hrMax);
  assert.equal(ceiling, VO2_ESTIMATOR_SUBMAX_HRMAX_FRACTION * 180);
  assert.equal(ceiling, 153);
  const stages = [
    acceptedStage("vo2-stage:1", 100, 120),
    acceptedStage("vo2-stage:2", 125, 130),
    acceptedStage("vo2-stage:3", 150, ceiling),
  ];
  const result = assessVo2(evidenceFromStages(stages), profile40_80);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.reason_codes.includes("hr_above_submax_ceiling"), true);
  assert.equal(result.estimate_ml_kg_min, undefined);
});

test("valid submax HR points remain eligible", () => {
  const result = assessVo2(evidenceFromStages(linearThree), profile40_80);
  assert.equal(result.status, "estimated");
  for (const point of result.diagnostics.eligible_points) {
    assert.ok(point.steady_state_bpm >= VO2_ESTIMATOR_MIN_HR_BPM);
    assert.ok(point.steady_state_bpm < estimatorSubmaxHrCeilingBpm(180));
  }
});

test("three linear but out-of-range HR points do not produce an estimate", () => {
  const stages = [
    acceptedStage("vo2-stage:1", 100, 80),
    acceptedStage("vo2-stage:2", 125, 90),
    acceptedStage("vo2-stage:3", 150, 100),
  ];
  const result = assessVo2(evidenceFromStages(stages), profile40_80);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.reason_codes.includes("hr_below_estimator_range"), true);
  assert.equal(result.estimate_ml_kg_min, undefined);
});

test("measured watts are used as estimator workload", () => {
  const stages = [
    acceptedStage("vo2-stage:1", 90, 120, measuredWorkloadForTests(100, { calibrated_watts_at_70rpm: 90 })),
    acceptedStage("vo2-stage:2", 110, 130, measuredWorkloadForTests(125, { calibrated_watts_at_70rpm: 110 })),
    acceptedStage("vo2-stage:3", 130, 140, measuredWorkloadForTests(150, { calibrated_watts_at_70rpm: 130 })),
  ];
  const result = assessVo2(evidenceFromStages(stages), profile40_80);
  assert.equal(result.status, "estimated");
  assert.equal(result.estimate_ml_kg_min, 40.75);
  assert.deepEqual(
    result.diagnostics.eligible_points.map((point) => point.watts),
    [100, 125, 150]
  );
  assert.deepEqual(
    result.diagnostics.eligible_points.map((point) => point.workload_source),
    ["measured_watts", "measured_watts", "measured_watts"]
  );
});

test("verified cadence may use calibrated 70-RPM watts", () => {
  const stages = [
    acceptedStage("vo2-stage:1", 100, 120, verifiedCadenceWorkloadForTests(100)),
    acceptedStage("vo2-stage:2", 125, 130, verifiedCadenceWorkloadForTests(125)),
    acceptedStage("vo2-stage:3", 150, 140, verifiedCadenceWorkloadForTests(150)),
  ];
  const result = assessVo2(evidenceFromStages(stages), profile40_80);
  assert.equal(result.status, "estimated");
  assert.equal(result.estimate_ml_kg_min, 40.75);
  for (const point of result.diagnostics.eligible_points) {
    assert.equal(point.workload_source, "calibrated_at_verified_cadence");
    assert.equal(point.cadence_measured, true);
    assert.equal(point.watts_measured, false);
  }
});

test("unverified prescribed cadence cannot masquerade as measured cadence", () => {
  const stages = [
    acceptedStage("vo2-stage:1", 100, 120, prescribedOnlyWorkloadForTests(100)),
    acceptedStage("vo2-stage:2", 125, 130, prescribedOnlyWorkloadForTests(125)),
    acceptedStage("vo2-stage:3", 150, 140, prescribedOnlyWorkloadForTests(150)),
  ];
  const result = assessVo2(evidenceFromStages(stages), profile40_80);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.reason_codes.includes("unverified_performed_workload"), true);
  for (const point of result.diagnostics.accepted_points) {
    assert.equal(point.workload_source, "prescribed_only");
    assert.equal(point.cadence_measured, false);
    assert.equal(point.estimator_eligible, false);
  }
});

test("cadence outside tolerance does not unlock calibrated watts", () => {
  const stage = {
    active_start_sec: 0,
    active_end_sec: 180,
    calibrated_watts_at_70rpm: 125,
  };
  const samples = [];
  for (let t = 60; t <= 180; t++) {
    samples.push({ timestamp_sec: t, rpm: 70 + VO2_CADENCE_TOLERANCE_RPM + 1 });
  }
  const workload = summarizeVo2StageWorkload(stage, samples);
  assert.equal(workload.source, "prescribed_only");
  assert.equal(workload.cadence_measured, true);
  assert.equal(workload.estimator_watts, undefined);
});

test("fit classification is named fit_quality not confidence", () => {
  const result = assessVo2(evidenceFromStages(linearThree), profile40_80);
  assert.equal(result.fit_quality, "high");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "confidence"), false);
});

test("profile placeholders cannot silently become explicit VO2 inputs", () => {
  const wouldLeak = parseExplicitVo2ProfileInputs({ age: 25, weight: 150, sex: "male", height: 70, vo2: "" });
  assert.equal(wouldLeak.age_years, 25);
  assert.ok(wouldLeak.weight_kg > 0);
  globalThis.localStorage = memoryStorage();
  const unset = getProfile();
  assert.equal(unset.age, BLANK_PROFILE.age);
  assert.equal(unset.weight, BLANK_PROFILE.weight);
  assert.equal(unset.age, "");
  assert.equal(unset.weight, "");
  assert.deepEqual(parseExplicitVo2ProfileInputs(unset), {});
  assert.deepEqual(parseExplicitVo2ProfileInputs({ age: "", weight: "", sex: "female", height: "70", vo2: "" }), {});
});

test("historical assessment retains workload provenance", () => {
  const result = assessVo2(evidenceFromStages(linearThree, "limit_reached"), profile40_80);
  const frozen = JSON.parse(JSON.stringify(result));
  assert.equal(frozen.estimator_id, VO2_ESTIMATOR_ID);
  assert.equal(frozen.estimator_version, VO2_ESTIMATOR_VERSION);
  assert.equal(frozen.input_snapshot.protocol_id, "bike-submax-70rpm");
  assert.equal(frozen.input_snapshot.protocol_version, 2);
  assert.equal(frozen.input_snapshot.age_years, 40);
  assert.equal(frozen.input_snapshot.weight_kg, 80);
  assert.equal(frozen.input_snapshot.predicted_hr_max, 180);
  assert.equal(frozen.diagnostics.accepted_points.length, 3);
  assert.equal(frozen.diagnostics.eligible_points.length, 3);
  assert.equal(frozen.diagnostics.slope, 0.4);
  for (const point of frozen.diagnostics.eligible_points) {
    assert.equal(point.protocol_accepted, true);
    assert.equal(point.estimator_eligible, true);
    assert.equal(point.workload_source, "measured_watts");
    assert.ok(point.watts > 0);
    assert.ok(point.steady_state_bpm > 0);
    assert.equal(point.cadence_measured, true);
  }
});

test("existing sufficient early-stop case still estimates", () => {
  const result = assessVo2(evidenceFromStages(linearThree, "limit_reached", { active_duration_sec: 720 }), profile40_80);
  assert.equal(result.status, "estimated");
  assert.equal(result.termination_reason, "limit_reached");
  assert.equal(result.estimate_ml_kg_min, 40.75);
});

test("existing insufficient early-stop case remains explicit", () => {
  const result = assessVo2(evidenceFromStages(linearThree.slice(0, 2), "user_cancelled"), profile40_80);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.termination_reason, "user_cancelled");
  assert.equal(result.reason_codes.includes("too_few_accepted_stages"), true);
  assert.equal(result.estimate_ml_kg_min, undefined);
});

test("estimator source stays free of UI and workout lifecycle math hosts", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/vo2Estimator.ts", import.meta.url), "utf8");
  assert.equal(src.includes("document"), false);
  assert.equal(src.includes("uiControls"), false);
  assert.equal(src.includes("handleWorkoutCompletion"), false);
  assert.equal(src.includes("active_duration_sec"), false);
});
