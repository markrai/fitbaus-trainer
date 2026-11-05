import assert from "node:assert/strict";
import test from "node:test";

import {
  HR_PERSONALIZATION_AUTHORITY_NOTICE,
  HR_PERSONALIZATION_PROVISIONAL_FRESHNESS_DAYS,
  evaluateHrPersonalizationReadiness,
  exploratoryFractionOfHrr,
} from "../dist/hrPersonalizationReadiness.js";
import { bpmNotificationsAround, runRestingHrSession } from "../dist/restingHrAcquisition.js";
import { predictedHrMaxBpm } from "../dist/vo2Estimator.js";
import { resolveWorkoutPrescription } from "../dist/workoutPrescription.js";
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

test("invalid target ranges or out-of-domain calculations fail closed", () => {
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
  assert.ok(evaluation.exploratoryTargetInterpretations[1].reasonCodes.includes("target_interpretation_unavailable"));
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

test("frozen active HR prescriptions and zone classification remain unchanged", () => {
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
  evaluateHrPersonalizationReadiness({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(58)),
    resolvedPrescription: before,
    nowMs: NOW_MS,
  });
  const after = resolveWorkoutPrescription({
    workoutSelector: "Wednesday",
    blocks: { warm: 8, sustain: 25, cool: 7 },
    hrTargets,
    resolvedAt: "2026-11-05T12:00:00.000Z",
  });
  assert.deepEqual(after, before);
  assert.equal(after.resolver.id, LEGACY_HR_TARGET_RESOLVER_ID);
  assert.equal(mapHrToZone(140), mapHrToZone(140));
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
});
