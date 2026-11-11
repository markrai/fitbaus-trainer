import assert from "node:assert/strict";
import test from "node:test";

import {
  HR_PERSONALIZATION_AUTHORITY_NOTICE,
  HR_PERSONALIZATION_PROVISIONAL_FRESHNESS_DAYS,
  evaluateHrPersonalizationReadiness,
  exploratoryFractionOfHrr,
  isHrReadinessDiagnosticSessionActive,
  meaningfulHrTargetEndpoints,
  selectHrReadinessPrescription,
} from "../dist/hrPersonalizationReadiness.js";
import { bpmNotificationsAround, runRestingHrSession } from "../dist/restingHrAcquisition.js";
import { predictedHrMaxBpm } from "../dist/vo2Estimator.js";
import {
  machineHeartRateTargetFromResolved,
  parseLegacyHeartRateTarget,
  resolveWorkoutPrescription,
} from "../dist/workoutPrescription.js";
import { evaluatePersonalizedPrescription, PHASE_E1_SHADOW_POLICY } from "../dist/personalizedPrescription.js";
import { mapHrToZone } from "../dist/zoneCalculator.js";
import { LEGACY_HR_TARGET_RESOLVER_ID } from "../dist/types.js";
import { personalizationDiagnosticsHtml, buildPersonalizationDiagnosticsModel } from "../dist/personalizationDiagnosticsView.js";

function acceptedRestingMetric(bpm = 58, extras = {}) {
  const { result } = runRestingHrSession(bpmNotificationsAround(bpm), {
    measurementId: extras.measurementId ?? "measurement-readiness",
    athleteId: extras.athleteId ?? "athlete-a",
    observedAt: extras.observedAt ?? "2026-11-03T12:05:00.000Z",
  });
  assert.equal(result.outcome, "accepted");
  if (extras.quality) return { ...result.metric, quality: extras.quality };
  return result.metric;
}

function moderateRestingMetric() {
  const events = [];
  for (let elapsedSec = 0; elapsedSec < 300; elapsedSec += 1) {
    if (elapsedSec < 90 || elapsedSec % 5 !== 0) {
      events.push({ type: "bpm", elapsedSec, bpm: 62 });
    }
  }
  const { result } = runRestingHrSession(events, {
    measurementId: "measurement-moderate",
    athleteId: "athlete-a",
    observedAt: "2026-11-04T12:05:00.000Z",
  });
  assert.equal(result.outcome, "accepted");
  assert.equal(result.metric.quality, "moderate");
  return result.metric;
}

function fitnessStateWithResting(metric, athleteId = "athlete-a") {
  return {
    schemaVersion: 4,
    athleteId,
    restingHeartRateSession: metric,
    updatedAt: metric.updatedAt,
  };
}

function samplePrescription(selector = "Monday") {
  return resolveWorkoutPrescription({
    workoutSelector: selector,
    blocks: { warm: 10, sustain: 20, cool: 10 },
    hrTargets: {
      warmup: "100–120",
      warmup_intensity_id: "warmup_easy",
      main_set: "140–155",
      main_set_intensity_id: "threshold",
      main_set_kind: "work",
      cooldown: "90–110",
      cooldown_intensity_id: "cooldown",
      intervals: null,
    },
    resolvedAt: "2026-11-05T12:00:00.000Z",
  });
}

const NOW_MS = Date.parse("2026-11-05T15:00:00.000Z");

test("valid high-quality resting-session measurement is reported with provenance", () => {
  const metric = acceptedRestingMetric(56);
  assert.equal(metric.quality, "high");
  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(metric),
    resolvedPrescription: null,
    nowMs: NOW_MS,
  });
  assert.equal(evaluation.resting.available, true);
  assert.equal(evaluation.resting.heartRateBpm, 56);
  assert.equal(evaluation.resting.quality, "high");
  assert.equal(evaluation.resting.source, "resting_session");
  assert.equal(evaluation.resting.algorithmId, "resting-hr-session");
  assert.equal(evaluation.resting.eligibleForPrescription, false);
  assert.equal(evaluation.resting.interpretation, "resting_session_observation_only");
  assert.equal(evaluation.personalizedHrTargetsActive, false);
  assert.equal(evaluation.prescriptionAuthority, "legacy_bpm_only");
  assert.equal(evaluation.authorityNotice, HR_PERSONALIZATION_AUTHORITY_NOTICE);
});

test("moderate-quality measurement retains its actual quality", () => {
  const metric = moderateRestingMetric();
  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(metric),
    resolvedPrescription: null,
    nowMs: NOW_MS,
  });
  assert.equal(evaluation.resting.available, true);
  assert.equal(evaluation.resting.quality, "moderate");
  assert.equal(evaluation.resting.heartRateBpm, 62);
});

test("missing resting-HR evidence fails closed", () => {
  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: { schemaVersion: 4, athleteId: "athlete-a", updatedAt: "2026-11-05T12:00:00.000Z" },
    resolvedPrescription: null,
    nowMs: NOW_MS,
  });
  assert.equal(evaluation.resting.available, false);
  assert.ok(evaluation.resting.reasonCodes.includes("resting_session_missing"));
  assert.equal(evaluation.exploratoryHrr.available, false);
});

test("stale measurement is labeled without inventing prescription eligibility", () => {
  const staleAt = new Date(NOW_MS - (HR_PERSONALIZATION_PROVISIONAL_FRESHNESS_DAYS + 5) * 86400000).toISOString();
  const metric = acceptedRestingMetric(55, { observedAt: staleAt });
  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(metric),
    resolvedPrescription: null,
    nowMs: NOW_MS,
  });
  assert.equal(evaluation.resting.available, true);
  assert.equal(evaluation.resting.provisionalFreshness, "stale");
  assert.ok(evaluation.resting.reasonCodes.includes("resting_session_provisional_stale"));
  assert.equal(evaluation.resting.eligibleForPrescription, false);
  assert.equal(evaluation.exploratoryHrr.available, true);
});

test("wrong-athlete FitnessState is rejected", () => {
  const metric = acceptedRestingMetric(58);
  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-other",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "athlete_mismatch",
    fitnessState: fitnessStateWithResting(metric, "athlete-other"),
    resolvedPrescription: null,
    nowMs: NOW_MS,
  });
  assert.equal(evaluation.resting.available, false);
  assert.ok(evaluation.resting.reasonCodes.includes("resting_session_athlete_mismatch"));
  assert.equal(evaluation.exploratoryHrr.available, false);
});

test("corrupt or unsupported persisted evidence fails closed", () => {
  const unreadable = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "unreadable",
    fitnessState: null,
    resolvedPrescription: null,
    nowMs: NOW_MS,
  });
  assert.equal(unreadable.resting.available, false);
  assert.ok(unreadable.resting.reasonCodes.includes("resting_session_storage_unreadable"));

  const absent = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "absent",
    fitnessState: null,
    resolvedPrescription: null,
    nowMs: NOW_MS,
  });
  assert.ok(absent.resting.reasonCodes.includes("resting_session_storage_absent"));
});

test("missing or invalid demographics block predicted HRmax", () => {
  const metric = acceptedRestingMetric(58);
  const missing = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: null,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(metric),
    resolvedPrescription: null,
    nowMs: NOW_MS,
  });
  assert.equal(missing.hrMax.available, false);
  assert.ok(missing.hrMax.reasonCodes.includes("hrmax_demographics_missing"));
  assert.ok(missing.hrMax.reasonCodes.includes("hrmax_observed_unavailable"));

  const invalid = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 9,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(metric),
    resolvedPrescription: null,
    nowMs: NOW_MS,
  });
  assert.ok(invalid.hrMax.reasonCodes.includes("hrmax_demographics_invalid"));
});

test("predicted versus observed HRmax provenance is explicit", () => {
  const metric = acceptedRestingMetric(58);
  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(metric),
    resolvedPrescription: null,
    nowMs: NOW_MS,
  });
  assert.equal(evaluation.hrMax.observedHrMaxBpm, null);
  assert.equal(evaluation.hrMax.predictedHrMaxBpm, predictedHrMaxBpm(40));
  assert.equal(evaluation.hrMax.predictedSource, "tanaka_age_predicted");
  assert.equal(evaluation.hrMax.predictedLabel, "age-predicted (Tanaka 2001)");
  assert.ok(evaluation.hrMax.reasonCodes.includes("hrmax_age_predicted_tanaka"));
  assert.ok(evaluation.hrMax.reasonCodes.includes("hrmax_observed_unavailable"));
  assert.equal(evaluation.thresholdHr.available, false);
  assert.ok(evaluation.thresholdHr.reasonCodes.includes("threshold_hr_evidence_absent"));
});

test("invalid or nonpositive HRR fails closed", () => {
  assert.equal(exploratoryFractionOfHrr(140, 60, 0), null);
  assert.equal(exploratoryFractionOfHrr(140, 60, -10), null);
  assert.equal(exploratoryFractionOfHrr(Number.NaN, 60, 100), null);

  const implausible = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting({
      ...acceptedRestingMetric(58),
      value: {
        ...acceptedRestingMetric(58).value,
        heartRateBpm: 200,
      },
    }),
    resolvedPrescription: null,
    nowMs: NOW_MS,
  });
  assert.equal(implausible.exploratoryHrr.available, false);
  assert.ok(
    implausible.exploratoryHrr.reasonCodes.includes("hrr_unavailable_implausible") ||
      implausible.exploratoryHrr.reasonCodes.includes("hrr_unavailable_nonpositive")
  );
});

test("fixed target ranges translate correctly into exploratory %HRR", () => {
  const restingBpm = 60;
  const ageYears = 40;
  const predicted = predictedHrMaxBpm(ageYears);
  const reserve = predicted - restingBpm;
  const metric = acceptedRestingMetric(restingBpm);
  const prescription = samplePrescription();
  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(metric),
    resolvedPrescription: prescription,
    nowMs: NOW_MS,
  });
  assert.equal(evaluation.exploratoryHrr.available, true);
  assert.equal(evaluation.exploratoryHrr.heartRateReserveBpm, Math.round(reserve * 1000) / 1000);
  assert.ok(evaluation.exploratoryTargetInterpretations.length >= 3);

  const work = evaluation.exploratoryTargetInterpretations.find((row) => row.kind === "work");
  assert.ok(work);
  assert.equal(work.expectedHeartRate?.min, 140);
  assert.equal(work.expectedHeartRate?.max, 155);
  assert.equal(work.minFractionOfHrr, exploratoryFractionOfHrr(140, restingBpm, reserve));
  assert.equal(work.maxFractionOfHrr, exploratoryFractionOfHrr(155, restingBpm, reserve));
  assert.equal(work.minPercentOfHrr, Math.round(work.minFractionOfHrr * 100 * 1000) / 1000);
});

test("open-ended <115 from data.json preserves upper-bound interpretation only", () => {
  const restingBpm = 60;
  const ageYears = 40;
  const predicted = predictedHrMaxBpm(ageYears);
  const reserve = predicted - restingBpm;
  const display = "<115";
  const expected = parseLegacyHeartRateTarget(display);
  assert.deepEqual(expected, { min: 0, max: 114 });
  assert.deepEqual(meaningfulHrTargetEndpoints(expected, display), { interpretMin: false, interpretMax: true });

  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(restingBpm)),
    resolvedPrescription: {
      schemaVersion: 1,
      resolver: { id: LEGACY_HR_TARGET_RESOLVER_ID, version: 1 },
      workoutSelector: "Tuesday",
      resolvedAt: "2026-11-05T12:00:00.000Z",
      phases: [
        {
          phaseId: "cooldown",
          kind: "cooldown",
          displayTargetHrBpm: display,
          expectedHeartRate: expected,
          source: "legacy_fallback",
          quality: "unverified",
          explanationCode: "legacy_target_hr_bpm",
        },
      ],
    },
    resolvedPrescriptionProvenance: "inactive_template_preview",
    nowMs: NOW_MS,
  });
  const row = evaluation.exploratoryTargetInterpretations[0];
  assert.equal(row.displayTargetHrBpm, "<115");
  assert.equal(row.minFractionOfHrr, null);
  assert.equal(row.maxFractionOfHrr, exploratoryFractionOfHrr(114, restingBpm, reserve));
  assert.ok(row.reasonCodes.includes("target_interpretation_available"));
  assert.ok(!row.reasonCodes.includes("target_range_invalid"));
});

test("open-ended ≥160 (cap 170) from data.json preserves lower bound and explicit cap", () => {
  const restingBpm = 60;
  const ageYears = 40;
  const predicted = predictedHrMaxBpm(ageYears);
  const reserve = predicted - restingBpm;
  const display = "≥160 (cap 170)";
  const expected = parseLegacyHeartRateTarget(display);
  assert.deepEqual(expected, { min: 160, max: 170 });
  assert.deepEqual(meaningfulHrTargetEndpoints(expected, display), { interpretMin: true, interpretMax: true });

  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(restingBpm)),
    resolvedPrescription: {
      schemaVersion: 1,
      resolver: { id: LEGACY_HR_TARGET_RESOLVER_ID, version: 1 },
      workoutSelector: "Monday",
      resolvedAt: "2026-11-05T12:00:00.000Z",
      phases: [
        {
          phaseId: "interval-work",
          kind: "work",
          displayTargetHrBpm: display,
          expectedHeartRate: expected,
          source: "legacy_fallback",
          quality: "unverified",
          explanationCode: "legacy_target_hr_bpm",
        },
      ],
    },
    nowMs: NOW_MS,
  });
  const row = evaluation.exploratoryTargetInterpretations[0];
  assert.equal(row.displayTargetHrBpm, "≥160 (cap 170)");
  assert.equal(row.expectedHeartRate?.min, 160);
  assert.equal(row.expectedHeartRate?.max, 170);
  assert.equal(row.minFractionOfHrr, exploratoryFractionOfHrr(160, restingBpm, reserve));
  assert.equal(row.maxFractionOfHrr, exploratoryFractionOfHrr(170, restingBpm, reserve));
  assert.ok(row.minFractionOfHrr != null && row.maxFractionOfHrr != null);
});

test("target below resting HR is unavailable with target_out_of_domain", () => {
  const restingBpm = 70;
  const ageYears = 40;
  const predicted = predictedHrMaxBpm(ageYears);
  const reserve = predicted - restingBpm;
  assert.equal(exploratoryFractionOfHrr(50, restingBpm, reserve), null);

  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(restingBpm)),
    resolvedPrescription: {
      schemaVersion: 1,
      resolver: { id: LEGACY_HR_TARGET_RESOLVER_ID, version: 1 },
      workoutSelector: "Monday",
      resolvedAt: "2026-11-05T12:00:00.000Z",
      phases: [
        {
          phaseId: "below-resting",
          kind: "cooldown",
          displayTargetHrBpm: "40–50",
          expectedHeartRate: { min: 40, max: 50 },
          source: "legacy_fallback",
          quality: "unverified",
          explanationCode: "legacy_target_hr_bpm",
        },
      ],
    },
    nowMs: NOW_MS,
  });
  const row = evaluation.exploratoryTargetInterpretations[0];
  assert.equal(row.minFractionOfHrr, null);
  assert.equal(row.maxFractionOfHrr, null);
  assert.ok(row.reasonCodes.includes("target_out_of_domain"));
});

test("target above predicted HRmax is unavailable with target_out_of_domain", () => {
  const restingBpm = 60;
  const ageYears = 40;
  const predicted = predictedHrMaxBpm(ageYears);
  const reserve = predicted - restingBpm;
  const aboveMax = Math.ceil(predicted) + 5;
  assert.equal(exploratoryFractionOfHrr(aboveMax, restingBpm, reserve), null);

  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(restingBpm)),
    resolvedPrescription: {
      schemaVersion: 1,
      resolver: { id: LEGACY_HR_TARGET_RESOLVER_ID, version: 1 },
      workoutSelector: "Monday",
      resolvedAt: "2026-11-05T12:00:00.000Z",
      phases: [
        {
          phaseId: "above-hrmax",
          kind: "work",
          displayTargetHrBpm: `${aboveMax}–${aboveMax + 10}`,
          expectedHeartRate: { min: aboveMax, max: aboveMax + 10 },
          source: "legacy_fallback",
          quality: "unverified",
          explanationCode: "legacy_target_hr_bpm",
        },
      ],
    },
    nowMs: NOW_MS,
  });
  const row = evaluation.exploratoryTargetInterpretations[0];
  assert.equal(row.minFractionOfHrr, null);
  assert.equal(row.maxFractionOfHrr, null);
  assert.ok(row.reasonCodes.includes("target_out_of_domain"));
});

test("fractions exactly 0 and 1 are accepted without clamping", () => {
  const restingBpm = 60;
  const ageYears = 40;
  const predicted = predictedHrMaxBpm(ageYears);
  const reserve = predicted - restingBpm;
  assert.equal(exploratoryFractionOfHrr(restingBpm, restingBpm, reserve), 0);
  assert.equal(exploratoryFractionOfHrr(predicted, restingBpm, reserve), 1);
  assert.equal(exploratoryFractionOfHrr(restingBpm - 1, restingBpm, reserve), null);
  assert.equal(exploratoryFractionOfHrr(predicted + 1, restingBpm, reserve), null);
});

test("open-ended target with one valid endpoint does not fail as an entire range", () => {
  const restingBpm = 60;
  const ageYears = 40;
  const predicted = predictedHrMaxBpm(ageYears);
  const reserve = predicted - restingBpm;
  // Upper bound in domain; synthetic min:0 is not interpreted as a %HRR lower end.
  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(restingBpm)),
    resolvedPrescription: {
      schemaVersion: 1,
      resolver: { id: LEGACY_HR_TARGET_RESOLVER_ID, version: 1 },
      workoutSelector: "Tuesday",
      resolvedAt: "2026-11-05T12:00:00.000Z",
      phases: [
        {
          phaseId: "cooldown-open",
          kind: "cooldown",
          displayTargetHrBpm: "<120",
          expectedHeartRate: parseLegacyHeartRateTarget("<120"),
          source: "legacy_fallback",
          quality: "unverified",
          explanationCode: "legacy_target_hr_bpm",
        },
        {
          phaseId: "partial-ood",
          kind: "work",
          displayTargetHrBpm: "50–140",
          expectedHeartRate: { min: 50, max: 140 },
          source: "legacy_fallback",
          quality: "unverified",
          explanationCode: "legacy_target_hr_bpm",
        },
      ],
    },
    nowMs: NOW_MS,
  });
  const open = evaluation.exploratoryTargetInterpretations[0];
  assert.equal(open.minFractionOfHrr, null);
  assert.equal(open.maxFractionOfHrr, exploratoryFractionOfHrr(119, restingBpm, reserve));
  assert.ok(open.reasonCodes.includes("target_interpretation_available"));

  const partial = evaluation.exploratoryTargetInterpretations[1];
  assert.equal(partial.minFractionOfHrr, null);
  assert.equal(partial.maxFractionOfHrr, exploratoryFractionOfHrr(140, restingBpm, reserve));
  assert.ok(partial.reasonCodes.includes("target_out_of_domain"));
  assert.ok(partial.reasonCodes.includes("target_interpretation_available"));
});

test("malformed or reversed target range fails closed", () => {
  const metric = acceptedRestingMetric(58);
  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(metric),
    resolvedPrescription: {
      schemaVersion: 1,
      resolver: { id: LEGACY_HR_TARGET_RESOLVER_ID, version: 1 },
      workoutSelector: "Monday",
      resolvedAt: "2026-11-05T12:00:00.000Z",
      phases: [
        {
          phaseId: "bad-range",
          kind: "work",
          displayTargetHrBpm: "160–140",
          expectedHeartRate: { min: 160, max: 140 },
          source: "legacy_fallback",
          quality: "unverified",
          explanationCode: "legacy_target_hr_bpm",
        },
        {
          phaseId: "no-target",
          kind: "warmup",
          source: "no_numeric_target",
          quality: "unverified",
          explanationCode: "no_numeric_target",
        },
      ],
    },
    nowMs: NOW_MS,
  });
  assert.ok(evaluation.exploratoryTargetInterpretations[0].reasonCodes.includes("target_range_invalid"));
  assert.equal(evaluation.exploratoryTargetInterpretations[0].minFractionOfHrr, null);
  assert.equal(evaluation.exploratoryTargetInterpretations[0].maxFractionOfHrr, null);
  assert.ok(evaluation.exploratoryTargetInterpretations[1].reasonCodes.includes("target_interpretation_unavailable"));
});

test("valid frozen active-session prescription is reused without reconstruction", () => {
  const frozen = samplePrescription("Monday");
  const template = samplePrescription("Monday");
  template.resolvedAt = "diagnostics-should-not-win";
  const selected = selectHrReadinessPrescription({
    workoutSelector: "Monday",
    sessionActive: true,
    frozenPrescription: frozen,
    templatePrescription: template,
  });
  assert.equal(selected.provenance, "frozen_session");
  assert.equal(selected.prescription, frozen);
  assert.notEqual(selected.prescription?.resolvedAt, "diagnostics-should-not-win");
});

test("malformed or wrong-workout frozen prescription does not fall back to current template", () => {
  const template = samplePrescription("Monday");
  const malformed = selectHrReadinessPrescription({
    workoutSelector: "Monday",
    sessionActive: true,
    frozenPrescription: { schemaVersion: 1, resolver: { id: "not-legacy", version: 1 } },
    templatePrescription: template,
  });
  assert.equal(malformed.provenance, "none");
  assert.equal(malformed.prescription, null);

  const wrongWorkout = selectHrReadinessPrescription({
    workoutSelector: "Monday",
    sessionActive: true,
    frozenPrescription: samplePrescription("Wednesday"),
    templatePrescription: template,
  });
  assert.equal(wrongWorkout.provenance, "none");
  assert.equal(wrongWorkout.prescription, null);

  const missingFrozenActive = selectHrReadinessPrescription({
    workoutSelector: "Monday",
    sessionActive: true,
    frozenPrescription: null,
    templatePrescription: template,
  });
  assert.equal(missingFrozenActive.provenance, "none");
  assert.equal(missingFrozenActive.prescription, null);
});

test("inactive workout can display current-template diagnostic preview", () => {
  const template = samplePrescription("Tuesday");
  const selected = selectHrReadinessPrescription({
    workoutSelector: "Tuesday",
    sessionActive: false,
    frozenPrescription: null,
    templatePrescription: template,
  });
  assert.equal(selected.provenance, "inactive_template_preview");
  assert.equal(selected.prescription, template);

  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
    resolvedPrescription: selected.prescription,
    resolvedPrescriptionProvenance: selected.provenance,
    nowMs: NOW_MS,
  });
  assert.equal(evaluation.resolvedPrescriptionProvenance, "inactive_template_preview");
  assert.equal(evaluation.selectedWorkoutSelector, "Tuesday");
  assert.ok(evaluation.exploratoryTargetInterpretations.length >= 3);
});

test("different athletes produce different exploratory interpretations from the same legacy BPM target", () => {
  const prescription = samplePrescription();
  const younger = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-young",
    expectedAthleteId: "athlete-young",
    ageYears: 25,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(50, { athleteId: "athlete-young" }), "athlete-young"),
    resolvedPrescription: prescription,
    nowMs: NOW_MS,
  });
  const older = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-older",
    expectedAthleteId: "athlete-older",
    ageYears: 55,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(70, { athleteId: "athlete-older" }), "athlete-older"),
    resolvedPrescription: prescription,
    nowMs: NOW_MS,
  });
  const youngWork = younger.exploratoryTargetInterpretations.find((row) => row.expectedHeartRate?.min === 140);
  const olderWork = older.exploratoryTargetInterpretations.find((row) => row.expectedHeartRate?.min === 140);
  assert.ok(youngWork && olderWork);
  assert.notEqual(youngWork.minFractionOfHrr, olderWork.minFractionOfHrr);
  assert.notEqual(younger.exploratoryHrr.heartRateReserveBpm, older.exploratoryHrr.heartRateReserveBpm);
});

test("exploratory interpretation cannot change active resolved prescription, zones, or machine guidance", () => {
  const hrTargets = {
    warmup: "95–115",
    warmup_intensity_id: "warmup_easy",
    main_set: "130–145",
    main_set_intensity_id: "aerobic_base",
    main_set_kind: "work",
    cooldown: "85–100",
    cooldown_intensity_id: "cooldown",
    intervals: null,
  };
  const before = resolveWorkoutPrescription({
    workoutSelector: "Wednesday",
    blocks: { warm: 8, sustain: 25, cool: 7 },
    hrTargets,
    resolvedAt: "2026-11-05T12:00:00.000Z",
  });
  const beforeZones = {
    z100: mapHrToZone(100),
    z140: mapHrToZone(140),
    z170: mapHrToZone(170),
  };
  const workPhase = before.phases.find((phase) => phase.kind === "work");
  assert.ok(workPhase);
  const beforeMachine = machineHeartRateTargetFromResolved(workPhase);
  const beforeFrozen = structuredClone(before);

  const evaluation = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(58)),
    resolvedPrescription: before,
    resolvedPrescriptionProvenance: "frozen_session",
    nowMs: NOW_MS,
  });
  assert.equal(evaluation.personalizedHrTargetsActive, false);
  assert.equal(evaluation.prescriptionAuthority, "legacy_bpm_only");
  assert.deepEqual(before, beforeFrozen);

  const after = resolveWorkoutPrescription({
    workoutSelector: "Wednesday",
    blocks: { warm: 8, sustain: 25, cool: 7 },
    hrTargets,
    resolvedAt: "2026-11-05T12:00:00.000Z",
  });
  assert.deepEqual(after, before);
  assert.equal(after.resolver.id, LEGACY_HR_TARGET_RESOLVER_ID);
  assert.deepEqual(
    {
      z100: mapHrToZone(100),
      z140: mapHrToZone(140),
      z170: mapHrToZone(170),
    },
    beforeZones
  );
  assert.deepEqual(machineHeartRateTargetFromResolved(after.phases.find((phase) => phase.kind === "work")), beforeMachine);
});

test("E1 shadow behavior remains activationEligible false with resting evidence present", () => {
  const prescription = samplePrescription();
  const metric = acceptedRestingMetric(58);
  const evaluation = evaluatePersonalizedPrescription({
    legacyPrescription: prescription,
    workoutIntent: "threshold",
    activity: "bike",
    athleteId: "athlete-a",
    profile: {
      schemaVersion: 1,
      athleteId: "athlete-a",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      demographics: { ageYears: 40, bodyMassLbs: 170 },
    },
    fitnessState: fitnessStateWithResting(metric),
    resolvedAt: "2026-11-05T12:00:00.000Z",
    policy: PHASE_E1_SHADOW_POLICY,
  });
  assert.equal(evaluation.activationEligible, false);
  assert.equal(evaluation.mode, "shadow");
});

test("diagnostics HTML surfaces readiness authority notice and exploratory %HRR", () => {
  const metric = acceptedRestingMetric(60);
  const readiness = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(metric),
    resolvedPrescription: samplePrescription(),
    resolvedPrescriptionProvenance: "inactive_template_preview",
    nowMs: NOW_MS,
  });
  const html = personalizationDiagnosticsHtml(
    buildPersonalizationDiagnosticsModel([], undefined, {}, {}, {}, null, {}, {}, readiness)
  );
  assert.match(html, /Personalized HR targets are not active/);
  assert.match(html, /HR personalization readiness/);
  assert.match(html, /age-predicted \(Tanaka 2001\)/);
  assert.match(html, /Exploratory %HRR/);
  assert.match(html, /eligibleForPrescription false/);
  assert.match(html, /inactive template preview/);
});

function readinessHtml(readiness) {
  return personalizationDiagnosticsHtml(
    buildPersonalizationDiagnosticsModel([], undefined, {}, {}, {}, null, {}, {}, readiness)
  );
}

function prescriptionWithPhases(selector, phases) {
  return {
    schemaVersion: 1,
    resolver: { id: LEGACY_HR_TARGET_RESOLVER_ID, version: 1 },
    workoutSelector: selector,
    resolvedAt: "2026-11-05T12:00:00.000Z",
    phases,
  };
}

test("active legacy session without phasePlan does not fall back to template targets", () => {
  // phasePlan absence must not mark the session inactive when lifecycle markers exist.
  assert.equal(
    isHrReadinessDiagnosticSessionActive({
      workoutSelector: "Monday",
      sessionId: "session-active-legacy",
      startTime: "1730822400000",
      activeOwner: { selector: "Monday", sessionId: "session-active-legacy" },
    }),
    true
  );
  assert.equal(
    isHrReadinessDiagnosticSessionActive({
      workoutSelector: "Monday",
      sessionId: null,
      startTime: null,
      activeOwner: null,
    }),
    false
  );

  const template = samplePrescription("Monday");
  const selected = selectHrReadinessPrescription({
    workoutSelector: "Monday",
    sessionActive: true, // lifecycle active, no phasePlan / frozen prescription
    frozenPrescription: null,
    templatePrescription: template,
  });
  assert.equal(selected.provenance, "none");
  assert.equal(selected.prescription, null);

  const readiness = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
    resolvedPrescription: selected.prescription,
    resolvedPrescriptionProvenance: selected.provenance,
    nowMs: NOW_MS,
  });
  const html = readinessHtml(readiness);
  assert.match(html, />none</);
  assert.doesNotMatch(html, /inactive template preview/);
  assert.match(html, /No resolved legacy HR targets for the selected workout/);
});

test("active session with malformed frozen prescription stays fail-closed in HTML", () => {
  const template = samplePrescription("Monday");
  const selected = selectHrReadinessPrescription({
    workoutSelector: "Monday",
    sessionActive: isHrReadinessDiagnosticSessionActive({
      workoutSelector: "Monday",
      sessionId: "session-malformed",
      startTime: "1730822400000",
      activeOwner: { selector: "Monday", sessionId: "session-malformed" },
    }),
    frozenPrescription: { schemaVersion: 1, resolver: { id: "not-legacy", version: 1 } },
    templatePrescription: template,
  });
  assert.equal(selected.provenance, "none");
  assert.equal(selected.prescription, null);

  const html = readinessHtml(
    evaluateHrPersonalizationReadiness({
      athleteId: "athlete-a",
      expectedAthleteId: "athlete-a",
      ageYears: 40,
      fitnessStorageStatus: "readable",
      fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
      resolvedPrescription: null,
      resolvedPrescriptionProvenance: "none",
      nowMs: NOW_MS,
    })
  );
  assert.match(html, />none</);
  assert.doesNotMatch(html, /inactive template preview/);
  assert.doesNotMatch(html, /140–155/);
});

test("valid active frozen prescription provenance is shown in HTML", () => {
  const frozen = samplePrescription("Monday");
  const template = samplePrescription("Monday");
  template.resolvedAt = "diagnostics-should-not-win";
  const selected = selectHrReadinessPrescription({
    workoutSelector: "Monday",
    sessionActive: isHrReadinessDiagnosticSessionActive({
      workoutSelector: "Monday",
      sessionId: "session-frozen",
      startTime: "1730822400000",
      activeOwner: { selector: "Monday", sessionId: "session-frozen" },
    }),
    frozenPrescription: frozen,
    templatePrescription: template,
  });
  assert.equal(selected.provenance, "frozen_session");
  assert.equal(selected.prescription, frozen);

  const html = readinessHtml(
    evaluateHrPersonalizationReadiness({
      athleteId: "athlete-a",
      expectedAthleteId: "athlete-a",
      ageYears: 40,
      fitnessStorageStatus: "readable",
      fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
      resolvedPrescription: selected.prescription,
      resolvedPrescriptionProvenance: selected.provenance,
      nowMs: NOW_MS,
    })
  );
  assert.match(html, /frozen session prescription/);
  assert.match(html, /140–155 bpm/);
  assert.doesNotMatch(html, /inactive template preview/);
});

test("inactive template preview provenance is shown in HTML", () => {
  assert.equal(
    isHrReadinessDiagnosticSessionActive({
      workoutSelector: "Tuesday",
      sessionId: null,
      startTime: null,
      activeOwner: null,
    }),
    false
  );
  // Leftover phasePlan markers alone are not modeled here; inactive = no sessionId/startTime.
  const template = samplePrescription("Tuesday");
  const selected = selectHrReadinessPrescription({
    workoutSelector: "Tuesday",
    sessionActive: false,
    frozenPrescription: null,
    templatePrescription: template,
  });
  assert.equal(selected.provenance, "inactive_template_preview");

  const html = readinessHtml(
    evaluateHrPersonalizationReadiness({
      athleteId: "athlete-a",
      expectedAthleteId: "athlete-a",
      ageYears: 40,
      fitnessStorageStatus: "readable",
      fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
      resolvedPrescription: selected.prescription,
      resolvedPrescriptionProvenance: selected.provenance,
      nowMs: NOW_MS,
    })
  );
  assert.match(html, /inactive template preview/);
  assert.match(html, /140–155 bpm/);
});

test("HTML preserves open-ended ≤ and ≥ for genuine <115 and uncapped ≥160", () => {
  const restingBpm = 60;
  const ageYears = 40;
  const predicted = predictedHrMaxBpm(ageYears);
  const reserve = predicted - restingBpm;
  const lessThan = parseLegacyHeartRateTarget("<115");
  const atLeast = parseLegacyHeartRateTarget("≥160");
  assert.deepEqual(meaningfulHrTargetEndpoints(lessThan, "<115"), { interpretMin: false, interpretMax: true });
  assert.deepEqual(meaningfulHrTargetEndpoints(atLeast, "≥160"), { interpretMin: true, interpretMax: false });

  const readiness = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(restingBpm)),
    resolvedPrescription: prescriptionWithPhases("Monday", [
      {
        phaseId: "cooldown-open",
        kind: "cooldown",
        displayTargetHrBpm: "<115",
        expectedHeartRate: lessThan,
        source: "legacy_fallback",
        quality: "unverified",
        explanationCode: "legacy_target_hr_bpm",
      },
      {
        phaseId: "work-open",
        kind: "work",
        displayTargetHrBpm: "≥160",
        expectedHeartRate: atLeast,
        source: "legacy_fallback",
        quality: "unverified",
        explanationCode: "legacy_target_hr_bpm",
      },
    ]),
    resolvedPrescriptionProvenance: "inactive_template_preview",
    nowMs: NOW_MS,
  });
  const openUpper = readiness.exploratoryTargetInterpretations[0];
  const openLower = readiness.exploratoryTargetInterpretations[1];
  assert.equal(openUpper.minPercentOfHrr, null);
  assert.ok(openUpper.maxPercentOfHrr != null);
  assert.equal(openLower.maxPercentOfHrr, null);
  assert.ok(openLower.minPercentOfHrr != null);
  const upperPct = Math.round(openUpper.maxPercentOfHrr * 10) / 10;
  const lowerPct = Math.round(openLower.minPercentOfHrr * 10) / 10;
  const html = readinessHtml(readiness);
  assert.match(html, /&lt;115 bpm/);
  assert.match(html, new RegExp(`≤${upperPct}%`.replace(".", "\\.")));
  assert.match(html, /≥160 bpm/);
  assert.match(html, new RegExp(`≥${lowerPct}%`.replace(".", "\\.")));
  assert.doesNotMatch(html, /partial \/ out-of-domain/);
});

test("HTML marks bounded 50–140 with one out-of-domain endpoint as partial, not open-ended", () => {
  const restingBpm = 60;
  const ageYears = 40;
  const predicted = predictedHrMaxBpm(ageYears);
  const reserve = predicted - restingBpm;
  const readiness = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(restingBpm)),
    resolvedPrescription: prescriptionWithPhases("Monday", [
      {
        phaseId: "partial-ood",
        kind: "work",
        displayTargetHrBpm: "50–140",
        expectedHeartRate: { min: 50, max: 140 },
        source: "legacy_fallback",
        quality: "unverified",
        explanationCode: "legacy_target_hr_bpm",
      },
    ]),
    resolvedPrescriptionProvenance: "inactive_template_preview",
    nowMs: NOW_MS,
  });
  const row = readiness.exploratoryTargetInterpretations[0];
  assert.equal(row.minFractionOfHrr, null);
  assert.equal(row.maxFractionOfHrr, exploratoryFractionOfHrr(140, restingBpm, reserve));
  assert.ok(row.reasonCodes.includes("target_out_of_domain"));

  const upperPct = Math.round(row.maxPercentOfHrr * 10) / 10;
  const html = readinessHtml(readiness);
  assert.match(html, /50–140 bpm/);
  assert.match(html, new RegExp(`${String(upperPct).replace(".", "\\.")}% upper · partial / out-of-domain`));
  assert.doesNotMatch(html, new RegExp(`≤${String(upperPct).replace(".", "\\.")}%`));
  assert.doesNotMatch(html, new RegExp(`≥${String(upperPct).replace(".", "\\.")}%`));
});

test("HTML keeps both out-of-domain endpoints unavailable", () => {
  const restingBpm = 70;
  const ageYears = 40;
  const readiness = evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(restingBpm)),
    resolvedPrescription: prescriptionWithPhases("Monday", [
      {
        phaseId: "both-ood",
        kind: "cooldown",
        displayTargetHrBpm: "40–50",
        expectedHeartRate: { min: 40, max: 50 },
        source: "legacy_fallback",
        quality: "unverified",
        explanationCode: "legacy_target_hr_bpm",
      },
    ]),
    resolvedPrescriptionProvenance: "inactive_template_preview",
    nowMs: NOW_MS,
  });
  const row = readiness.exploratoryTargetInterpretations[0];
  assert.equal(row.minFractionOfHrr, null);
  assert.equal(row.maxFractionOfHrr, null);
  assert.ok(row.reasonCodes.includes("target_out_of_domain"));

  const html = readinessHtml(readiness);
  assert.match(html, /40–50 bpm/);
  assert.match(html, /target_out_of_domain/);
  assert.doesNotMatch(html, /≤\d/);
  assert.doesNotMatch(html, /≥\d/);
  assert.doesNotMatch(html, /\d+\.\d+% upper/);
  assert.doesNotMatch(html, /\d+\.\d+% lower/);
});
