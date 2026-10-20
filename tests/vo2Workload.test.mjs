import assert from "node:assert/strict";
import test from "node:test";
import {
  cadenceInBand,
  median,
  prescribedOnlyWorkloadForTests,
  summarizeVo2StageWorkload,
  VO2_CADENCE_MIN_IN_BAND_RATIO,
  VO2_CADENCE_TOLERANCE_RPM,
  VO2_PRESCRIBED_CADENCE_RPM,
  VO2_WORKLOAD_MIN_SAMPLES,
} from "../dist/vo2Workload.js";
import { VO2_PRESCRIBED_CADENCE_RPM as PROTOCOL_CADENCE } from "../dist/vo2Protocol.js";

function windowSamples(end, values) {
  const start = end - 119;
  const samples = [];
  for (let t = start; t <= end; t++) {
    const value = typeof values === "function" ? values(t - start) : values;
    samples.push({ timestamp_sec: t, ...value });
  }
  return samples;
}

const stage = { active_start_sec: 0, active_end_sec: 180, calibrated_watts_at_70rpm: 125 };

test("prescribed cadence constant matches protocol", () => {
  assert.equal(VO2_PRESCRIBED_CADENCE_RPM, PROTOCOL_CADENCE);
  assert.equal(VO2_PRESCRIBED_CADENCE_RPM, 70);
});

test("median is robust to a single spike", () => {
  assert.equal(median([100, 101, 500, 99, 100]), 100);
});

test("measured watts win even when cadence is off prescription", () => {
  const samples = windowSamples(180, { rpm: 90, watts: 140 });
  assert.ok(samples.length >= VO2_WORKLOAD_MIN_SAMPLES);
  const workload = summarizeVo2StageWorkload(stage, samples);
  assert.equal(workload.source, "measured_watts");
  assert.equal(workload.estimator_watts, 140);
  assert.equal(workload.watts_measured, true);
  assert.equal(workload.cadence_measured, true);
  assert.ok(workload.cadence_in_band_ratio < VO2_CADENCE_MIN_IN_BAND_RATIO);
});

test("verified cadence uses calibrated watts when measured watts are missing", () => {
  const samples = windowSamples(180, { rpm: 70 });
  const workload = summarizeVo2StageWorkload(stage, samples);
  assert.equal(workload.source, "calibrated_at_verified_cadence");
  assert.equal(workload.estimator_watts, 125);
  assert.equal(workload.watts_measured, false);
  assert.equal(workload.cadence_measured, true);
  assert.equal(workload.measured_cadence_median_rpm, 70);
});

test("cadence at inclusive tolerance still verifies", () => {
  const samples = windowSamples(180, { rpm: 70 + VO2_CADENCE_TOLERANCE_RPM });
  assert.equal(cadenceInBand(70 + VO2_CADENCE_TOLERANCE_RPM), true);
  const workload = summarizeVo2StageWorkload(stage, samples);
  assert.equal(workload.source, "calibrated_at_verified_cadence");
});

test("sparse cadence coverage stays prescribed-only", () => {
  const samples = [];
  for (let t = 170; t <= 180; t++) samples.push({ timestamp_sec: t, rpm: 70 });
  const workload = summarizeVo2StageWorkload(stage, samples);
  assert.ok(samples.length < VO2_WORKLOAD_MIN_SAMPLES);
  assert.equal(workload.source, "prescribed_only");
  assert.equal(workload.cadence_measured, false);
  assert.equal(workload.estimator_watts, undefined);
});

test("no telemetry is prescribed-only and not measured cadence", () => {
  const workload = summarizeVo2StageWorkload(stage, []);
  assert.equal(workload.source, "prescribed_only");
  assert.equal(workload.cadence_measured, false);
  assert.equal(workload.watts_measured, false);
  assert.equal(workload.estimator_watts, undefined);
  const helper = prescribedOnlyWorkloadForTests(125);
  assert.equal(helper.source, "prescribed_only");
  assert.equal(helper.cadence_measured, false);
});
