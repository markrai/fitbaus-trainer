import assert from "node:assert/strict";
import test from "node:test";
import {
  formatVo2EstimateMlKgMin,
  genericWorkoutBlocksText,
  vo2AssessmentPresentation,
  vo2CancelModalTitle,
  vo2EndWorkoutButtonLabel,
  vo2HistoryOutcomeText,
  vo2InsufficientDetail,
  vo2LimitReachedButtonVisible,
  vo2SelectorOptionText,
  vo2WorkoutBlocksText,
} from "../dist/vo2AssessmentView.js";
import { assessVo2, assessVo2V1 } from "../dist/vo2Estimator.js";
import { VO2_PROTOCOL_VERSION, vo2PlanBlocks } from "../dist/vo2Protocol.js";
import { VO2_EVIDENCE_SCHEMA_VERSION } from "../dist/types.js";

function acceptedStage(id, watts, hr) {
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
    hr: { sample_count: 120, steady_state_bpm: hr },
    workload: {
      source: "measured_watts",
      estimator_watts: watts,
      calibrated_watts_at_70rpm: watts,
      measured_watts_median: watts,
      measured_watts_sample_count: 90,
      measured_cadence_median_rpm: 70,
      measured_cadence_sample_count: 90,
      cadence_in_band_ratio: 1,
      cadence_measured: true,
      watts_measured: true,
    },
  };
}

function evidence(stages, termination = "protocol_complete") {
  return {
    schema_version: VO2_EVIDENCE_SCHEMA_VERSION,
    active_duration_sec: 900,
    paused_duration_sec: 0,
    work_end_active_sec: 840,
    cooldown_start_active_sec: 840,
    early_cooldown: false,
    phases: [],
    hr: { source: "ble_chest_strap", sample_count: 10 },
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

test("estimated result presentation uses one decimal and does not claim lab precision", () => {
  const result = assessVo2(evidence(linearThree), { age_years: 40, weight_kg: 80 });
  const view = vo2AssessmentPresentation(result);
  assert.equal(view.estimated, true);
  assert.equal(view.title, "VO₂ Max Estimate");
  assert.equal(view.valueText, formatVo2EstimateMlKgMin(40.75) + " ml/kg/min");
  assert.equal(view.valueText, "40.8 ml/kg/min");
  assert.match(view.body, /3 stable stages/);
  assert.match(view.body, /cycling heart-rate response/);
  assert.equal(view.detail, "Strong heart-rate/workload fit.");
  assert.equal(result.fit_quality, "high");
  assert.equal(result.confidence, undefined);
  assert.equal(vo2HistoryOutcomeText(result), "VO₂ 40.8 ml/kg/min");
});

test("insufficient result is explicit", () => {
  const result = assessVo2(evidence(linearThree.slice(0, 2), "user_cancelled"), {
    age_years: 40,
    weight_kg: 80,
  });
  const view = vo2AssessmentPresentation(result);
  assert.equal(view.estimated, false);
  assert.equal(view.title, "Not enough data to estimate VO₂ max");
  assert.equal(view.valueText, "");
  assert.match(view.body, /enough stable workload/i);
  assert.match(view.detail, /Only 2 stable work stages/);
  assert.equal(vo2HistoryOutcomeText(result), "VO₂ estimate unavailable");
});

test("too_few_accepted_stages describes accepted_stage_count", () => {
  const result = assessVo2(evidence(linearThree.slice(0, 2), "user_cancelled"), {
    age_years: 40,
    weight_kg: 80,
  });
  assert.equal(result.accepted_stage_count, 2);
  assert.equal(result.eligible_stage_count, 2);
  assert.equal(result.reason_codes.includes("too_few_accepted_stages"), true);
  const detail = vo2InsufficientDetail(result);
  assert.match(detail, /Only 2 stable work stages were completed/);
  assert.equal(detail.includes("usable heart-rate"), false);
});

test("too_few_eligible_stages describes eligible_stage_count not accepted_stage_count", () => {
  const stages = [
    acceptedStage("vo2-stage:1", 100, 109),
    acceptedStage("vo2-stage:2", 125, 120),
    acceptedStage("vo2-stage:3", 150, 130),
  ];
  const result = assessVo2(evidence(stages), { age_years: 40, weight_kg: 80 });
  assert.equal(result.accepted_stage_count, 3);
  assert.equal(result.eligible_stage_count, 2);
  assert.equal(result.reason_codes.includes("too_few_eligible_stages"), true);
  const detail = vo2InsufficientDetail({
    reason_codes: result.reason_codes,
    accepted_stage_count: result.accepted_stage_count,
    eligible_stage_count: result.eligible_stage_count,
  });
  assert.match(detail, /3 stages reached stable heart rate, but only 2 were valid for VO₂ estimation/);
  assert.match(detail, /At least 3 valid submaximal stages are required/);
  assert.equal(detail.includes("Only 3 stable work stages"), false);
  const view = vo2AssessmentPresentation(result);
  assert.match(view.body, /3 stages reached stable heart rate, but only 2 were valid/);
  assert.equal(view.stages.length, 3);
  assert.match(view.stages[0].detail, /HR stability: passed/);
  assert.match(view.stages[0].detail, /Workload evidence: passed/);
  assert.match(view.stages[0].detail, /Ineligible/);
  assert.match(view.stages[0].headline, /Stage 1.*resistance 2.*100 W/);
  assert.match(view.stages[0].detail, /measured watts/);
  assert.match(view.stages[0].detail, /109 bpm/);
  assert.match(view.stages[0].detail, /Ineligible.*below the 110 bpm usable floor/);
});

test("historical assessment-result v1 renders without fabricating v2 stage diagnostics", () => {
  const historicalEvidence = evidence(linearThree);
  historicalEvidence.schema_version = 1;
  historicalEvidence.protocol.protocol_version = 1;
  historicalEvidence.protocol.automatic_submax_hr_ceiling_available = false;
  const historical = assessVo2V1(historicalEvidence, { age_years: 40, weight_kg: 80 });
  const frozen = structuredClone(historical);
  const view = vo2AssessmentPresentation(historical);
  assert.equal(historical.schema_version, 1);
  assert.equal(view.estimated, true);
  assert.equal(view.valueText, "40.8 ml/kg/min");
  assert.equal(view.detail, "Strong heart-rate/workload fit.");
  assert.equal(view.stages.length, 3);
  assert.equal(view.stages[0].stageNumber, undefined);
  assert.equal(view.stages[0].stageId, "vo2-stage:1");
  assert.match(view.stages[0].headline, /Stage record vo2-stage:1/);
  assert.match(view.stages[0].headline, /resistance unavailable/);
  assert.match(view.stages[0].detail, /Workload evidence: not assessed/);
  assert.match(view.stages[0].detail, /Submaximal HR: not assessed/);
  assert.deepEqual(historical, frozen);
});

test("result diagnostics surface high-HR and cadence rejection reasons per stage", () => {
  const highStages = [
    acceptedStage("vo2-stage:1", 100, 120),
    acceptedStage("vo2-stage:2", 125, 130),
    acceptedStage("vo2-stage:3", 150, 153),
  ];
  const high = vo2AssessmentPresentation(assessVo2(evidence(highStages, "submax_hr_ceiling"), {
    age_years: 40,
    weight_kg: 80,
  }));
  assert.match(high.detail, /Stage 3 was excluded because steady heart rate reached 153 bpm/);
  assert.match(high.stages[2].detail, /Submaximal HR: failed/);
  assert.match(high.stages[2].detail, /at or above the 153 bpm submaximal ceiling/);

  const cadenceStages = linearThree.map((stage) => structuredClone(stage));
  cadenceStages[1].workload = {
    source: "prescribed_only",
    calibrated_watts_at_70rpm: 125,
    measured_watts_sample_count: 0,
    measured_cadence_median_rpm: 90,
    measured_cadence_sample_count: 90,
    cadence_in_band_ratio: 0,
    cadence_measured: true,
    watts_measured: false,
  };
  const cadence = vo2AssessmentPresentation(assessVo2(evidence(cadenceStages), {
    age_years: 40,
    weight_kg: 80,
  }));
  assert.match(cadence.stages[1].detail, /Workload evidence: failed/);
  assert.match(cadence.stages[1].detail, /cadence was outside the verified 70 ± 5 RPM range/);
});

test("adaptive no-safe-workload stop is not described as a ceiling crossing or unstable data", () => {
  // Real protocol-v3 session 4e4a6524 (age 46): two clean eligible stages,
  // then the planner refused stage 3 (hr_safety_no_safe_target). Steady HR
  // never approached the 149.43 bpm hard ceiling.
  const first = acceptedStage("vo2-stage:1", 86, 120.3);
  first.prescribed_resistance = 6;
  const second = acceptedStage("vo2-stage:2", 97, 137.3166666667);
  second.prescribed_resistance = 7;
  second.workload.estimator_watts = 92;
  second.workload.measured_watts_median = 92;
  const record = evidence([first, second], "submax_hr_ceiling");
  record.protocol.protocol_version = 3;
  const result = assessVo2(record, { age_years: 46, weight_kg: 52.16312255 });
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.termination_reason, "submax_hr_ceiling");
  assert.equal(result.reason_codes.includes("hr_above_submax_ceiling"), false);
  const view = vo2AssessmentPresentation(result);
  assert.equal(view.title, "Not enough submaximal stages to estimate VO₂ max");
  assert.match(view.body, /no higher workload could be selected safely while staying within the submaximal test range/);
  assert.doesNotMatch(view.body, /heart rate reached/);
  assert.doesNotMatch(view.body, /wasn't enough stable/);
  assert.equal(view.detail, "Only 2 stable work stages were completed. At least 3 are required.");

  // A live hard-ceiling breach leaves an incomplete stage: keep the generic
  // wording rather than claim a planner refusal.
  const breached = structuredClone(record);
  breached.protocol.stages.push({ ...acceptedStage("vo2-stage:3", 108, 150), status: "incomplete" });
  const breachView = vo2AssessmentPresentation(assessVo2(breached, { age_years: 46, weight_kg: 52.16312255 }));
  assert.doesNotMatch(breachView.body, /no higher workload could be selected safely/);

  // An observed above-ceiling stage keeps the existing ceiling wording.
  const observed = structuredClone(record);
  observed.protocol.stages.push(acceptedStage("vo2-stage:3", 108, 151));
  const observedView = vo2AssessmentPresentation(assessVo2(observed, { age_years: 46, weight_kg: 52.16312255 }));
  assert.match(observedView.body, /heart rate reached the test's submaximal limit/);
});

test("three accepted and eligible stages are not described as insufficient", () => {
  const result = assessVo2(evidence(linearThree), { age_years: 40, weight_kg: 80 });
  assert.equal(result.accepted_stage_count, 3);
  assert.equal(result.eligible_stage_count, 3);
  assert.equal(result.status, "estimated");
  assert.equal(result.reason_codes.includes("too_few_accepted_stages"), false);
  assert.equal(result.reason_codes.includes("too_few_eligible_stages"), false);
  const view = vo2AssessmentPresentation(result);
  assert.equal(view.estimated, true);
  assert.equal(view.detail.includes("Only"), false);
});

test("missing profile result tells the user where to add age and weight", () => {
  const result = assessVo2(evidence(linearThree), {});
  const detail = vo2InsufficientDetail(result);
  assert.match(detail, /age and body weight/i);
  assert.match(detail, /Settings → Profile/);
  const view = vo2AssessmentPresentation(result);
  assert.equal(view.estimated, false);
  assert.equal(view.detail, detail);
});

test("history has no VO2 line when assessment is absent", () => {
  assert.equal(vo2HistoryOutcomeText(undefined), null);
});

test("VO2 stop labels and limit-reached visibility", () => {
  assert.equal(vo2EndWorkoutButtonLabel(true), "End test");
  assert.equal(vo2EndWorkoutButtonLabel(false), "Yes, end and save");
  assert.equal(vo2CancelModalTitle(true), "End test?");
  assert.equal(vo2CancelModalTitle(false), "End workout?");
  assert.equal(vo2LimitReachedButtonVisible(true, true), true);
  assert.equal(vo2LimitReachedButtonVisible(true, false), false);
  assert.equal(vo2LimitReachedButtonVisible(false, true), false);
});

test("selector and blocks describe duration as an upper bound", () => {
  assert.equal(vo2SelectorOptionText(), "VO2 Max Estimation (up to 30 min)");
  const blocks = vo2PlanBlocks();
  assert.match(vo2WorkoutBlocksText(blocks), /up to 20 min/);
  assert.equal(genericWorkoutBlocksText(blocks).includes("up to"), false);
});
