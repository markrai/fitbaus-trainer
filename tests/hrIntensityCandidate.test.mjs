import assert from "node:assert/strict";
import test from "node:test";

import {
  HR_INTENSITY_AEROBIC_BASE_MAX_FRACTION_OF_HRR,
  HR_INTENSITY_AEROBIC_BASE_MIN_FRACTION_OF_HRR,
  HR_INTENSITY_AEROBIC_BASE_POLICY_ID,
  HR_INTENSITY_AEROBIC_BASE_POLICY,
  HR_INTENSITY_CANDIDATE_AUTHORITY_NOTICE,
  HR_INTENSITY_CANDIDATE_EXPLORATORY_FRESHNESS_DAYS,
  evaluateHrIntensityCandidates,
  karvonenTargetBpm,
} from "../dist/hrIntensityCandidate.js";
import {
  isHrReadinessDiagnosticSessionActive,
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
import {
  buildPersonalizationDiagnosticsModel,
  personalizationDiagnosticsHtml,
} from "../dist/personalizationDiagnosticsView.js";

const NOW_MS = Date.parse("2026-11-05T15:00:00.000Z");

function acceptedRestingMetric(bpm = 58, extras = {}) {
  const { result } = runRestingHrSession(bpmNotificationsAround(bpm), {
    measurementId: extras.measurementId ?? "measurement-h2",
    athleteId: extras.athleteId ?? "athlete-a",
    observedAt: extras.observedAt ?? "2026-11-03T12:05:00.000Z",
  });
  assert.equal(result.outcome, "accepted");
  if (extras.quality) return { ...result.metric, quality: extras.quality };
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

function aerobicBasePrescription(selector = "Tuesday", legacyMain = "115–130") {
  return resolveWorkoutPrescription({
    workoutSelector: selector,
    blocks: { warm: 8, sustain: 60, cool: 5 },
    hrTargets: {
      warmup: "110–120",
      warmup_intensity_id: "warmup_easy",
      main_set: legacyMain,
      main_set_intensity_id: "aerobic_base",
      main_set_kind: "work",
      cooldown: "<115",
      cooldown_intensity_id: "cooldown",
      intervals: null,
    },
    resolvedAt: "2026-11-05T12:00:00.000Z",
  });
}

function multiIntensityPrescription() {
  return {
    schemaVersion: 1,
    resolver: { id: LEGACY_HR_TARGET_RESOLVER_ID, version: 1 },
    workoutSelector: "Mixed",
    resolvedAt: "2026-11-05T12:00:00.000Z",
    phases: [
      {
        phaseId: "warmup",
        kind: "warmup",
        intensityId: "warmup_easy",
        displayTargetHrBpm: "110–120",
        expectedHeartRate: { min: 110, max: 120 },
        source: "legacy_fallback",
        quality: "unverified",
        explanationCode: "legacy_target_hr_bpm",
      },
      {
        phaseId: "main",
        kind: "work",
        intensityId: "aerobic_base",
        displayTargetHrBpm: "115–130",
        expectedHeartRate: { min: 115, max: 130 },
        source: "legacy_fallback",
        quality: "unverified",
        explanationCode: "legacy_target_hr_bpm",
      },
      {
        phaseId: "threshold",
        kind: "work",
        intensityId: "threshold",
        displayTargetHrBpm: "155–162",
        expectedHeartRate: { min: 155, max: 162 },
        source: "legacy_fallback",
        quality: "unverified",
        explanationCode: "legacy_target_hr_bpm",
      },
      {
        phaseId: "vo2",
        kind: "work",
        intensityId: "vo2_short",
        displayTargetHrBpm: "160–170",
        expectedHeartRate: { min: 160, max: 170 },
        source: "legacy_fallback",
        quality: "unverified",
        explanationCode: "legacy_target_hr_bpm",
      },
      {
        phaseId: "recovery",
        kind: "recovery",
        intensityId: "recovery",
        displayTargetHrBpm: "120–135",
        expectedHeartRate: { min: 120, max: 135 },
        source: "legacy_fallback",
        quality: "unverified",
        explanationCode: "legacy_target_hr_bpm",
      },
      {
        phaseId: "cooldown",
        kind: "cooldown",
        intensityId: "cooldown",
        displayTargetHrBpm: "<115",
        expectedHeartRate: parseLegacyHeartRateTarget("<115"),
        source: "legacy_fallback",
        quality: "unverified",
        explanationCode: "legacy_target_hr_bpm",
      },
      {
        phaseId: "strength",
        kind: "work",
        intensityId: "strength_support",
        displayTargetHrBpm: "100–160",
        expectedHeartRate: { min: 100, max: 160 },
        source: "legacy_fallback",
        quality: "unverified",
        explanationCode: "legacy_target_hr_bpm",
      },
      {
        phaseId: "base-warmup-ambiguous",
        kind: "warmup",
        intensityId: "aerobic_base",
        displayTargetHrBpm: "130–140",
        expectedHeartRate: { min: 130, max: 140 },
        source: "legacy_fallback",
        quality: "unverified",
        explanationCode: "legacy_target_hr_bpm",
      },
    ],
  };
}

function evaluateFor(athlete) {
  return evaluateHrIntensityCandidates({
    athleteId: athlete.athleteId,
    expectedAthleteId: athlete.athleteId,
    ageYears: athlete.ageYears,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(
      acceptedRestingMetric(athlete.restingBpm, { athleteId: athlete.athleteId }),
      athlete.athleteId
    ),
    resolvedPrescription: athlete.prescription ?? aerobicBasePrescription(),
    resolvedPrescriptionProvenance: athlete.provenance ?? "inactive_template_preview",
    nowMs: NOW_MS,
  });
}

function expectedBand(restingBpm, ageYears) {
  const predicted = predictedHrMaxBpm(ageYears);
  const reserve = predicted - restingBpm;
  return {
    minBpm: karvonenTargetBpm(restingBpm, reserve, HR_INTENSITY_AEROBIC_BASE_MIN_FRACTION_OF_HRR),
    maxBpm: karvonenTargetBpm(restingBpm, reserve, HR_INTENSITY_AEROBIC_BASE_MAX_FRACTION_OF_HRR),
    reserve: Math.round(reserve * 1000) / 1000,
    predicted,
  };
}

test("two athletes with different resting HR receive different candidate bands under the same policy", () => {
  const a = evaluateFor({ athleteId: "athlete-a", ageYears: 40, restingBpm: 50 });
  const b = evaluateFor({ athleteId: "athlete-b", ageYears: 40, restingBpm: 70 });
  const mainA = a.phases.find((phase) => phase.intensityId === "aerobic_base" && phase.kind === "work");
  const mainB = b.phases.find((phase) => phase.intensityId === "aerobic_base" && phase.kind === "work");
  assert.equal(mainA.status, "candidate");
  assert.equal(mainB.status, "candidate");
  assert.notDeepEqual(mainA.candidateHeartRate, mainB.candidateHeartRate);
  const bandA = expectedBand(50, 40);
  assert.deepEqual(mainA.candidateHeartRate, {
    minBpm: bandA.minBpm,
    maxBpm: bandA.maxBpm,
    minFractionOfHrr: 0.4,
    maxFractionOfHrr: 0.59,
  });
});

test("different age-predicted HRmax values affect candidate calculation", () => {
  const younger = evaluateFor({ athleteId: "athlete-young", ageYears: 25, restingBpm: 60 });
  const older = evaluateFor({ athleteId: "athlete-older", ageYears: 55, restingBpm: 60 });
  const y = younger.phases.find((phase) => phase.status === "candidate");
  const o = older.phases.find((phase) => phase.status === "candidate");
  assert.ok(y && o);
  assert.notEqual(younger.predictedHrMaxBpm, older.predictedHrMaxBpm);
  assert.notDeepEqual(y.candidateHeartRate, o.candidateHeartRate);
});

test("changing the legacy BPM target does not change the independent candidate", () => {
  const lowLegacy = evaluateFor({
    athleteId: "athlete-a",
    ageYears: 40,
    restingBpm: 60,
    prescription: aerobicBasePrescription("Tuesday", "100–110"),
  });
  const highLegacy = evaluateFor({
    athleteId: "athlete-a",
    ageYears: 40,
    restingBpm: 60,
    prescription: aerobicBasePrescription("Tuesday", "140–155"),
  });
  const a = lowLegacy.phases.find((phase) => phase.status === "candidate");
  const b = highLegacy.phases.find((phase) => phase.status === "candidate");
  assert.deepEqual(a.candidateHeartRate, b.candidateHeartRate);
  assert.notDeepEqual(a.legacyComparison.expectedHeartRate, b.legacyComparison.expectedHeartRate);
});

test("missing resting-HR evidence withholds the candidate", () => {
  const evaluation = evaluateHrIntensityCandidates({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: { schemaVersion: 4, athleteId: "athlete-a", updatedAt: "2026-11-05T12:00:00.000Z" },
    resolvedPrescription: aerobicBasePrescription(),
    nowMs: NOW_MS,
  });
  const main = evaluation.phases.find((phase) => phase.intensityId === "aerobic_base" && phase.kind === "work");
  assert.equal(main.status, "withheld");
  assert.ok(main.reasonCodes.includes("resting_session_missing"));
  assert.equal(main.candidateHeartRate, null);
});

test("missing or invalid HRmax evidence withholds the candidate", () => {
  const missing = evaluateHrIntensityCandidates({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: null,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
    resolvedPrescription: aerobicBasePrescription(),
    nowMs: NOW_MS,
  });
  assert.equal(missing.phases.find((phase) => phase.kind === "work" && phase.intensityId === "aerobic_base").status, "withheld");
  assert.ok(missing.reasonCodes.includes("hrmax_demographics_missing"));

  const invalid = evaluateHrIntensityCandidates({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 9,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
    resolvedPrescription: aerobicBasePrescription(),
    nowMs: NOW_MS,
  });
  assert.ok(invalid.reasonCodes.includes("hrmax_demographics_invalid"));
});

test("wrong-athlete evidence is rejected", () => {
  const evaluation = evaluateHrIntensityCandidates({
    athleteId: "athlete-other",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "athlete_mismatch",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60), "athlete-other"),
    resolvedPrescription: aerobicBasePrescription(),
    nowMs: NOW_MS,
  });
  const main = evaluation.phases.find((phase) => phase.intensityId === "aerobic_base" && phase.kind === "work");
  assert.equal(main.status, "withheld");
  assert.ok(main.reasonCodes.includes("resting_session_athlete_mismatch"));
});

test("stale resting evidence withholds exploratory candidates per documented policy", () => {
  const staleAt = new Date(NOW_MS - (HR_INTENSITY_CANDIDATE_EXPLORATORY_FRESHNESS_DAYS + 3) * 86400000).toISOString();
  const evaluation = evaluateHrIntensityCandidates({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60, { observedAt: staleAt })),
    resolvedPrescription: aerobicBasePrescription(),
    nowMs: NOW_MS,
  });
  const main = evaluation.phases.find((phase) => phase.intensityId === "aerobic_base" && phase.kind === "work");
  assert.equal(main.status, "withheld");
  assert.ok(main.reasonCodes.includes("resting_session_exploratory_stale"));
  assert.equal(evaluation.restingProvisionalFreshness, "stale");
});

test("invalid HRR or out-of-domain candidate calculation fails closed", () => {
  assert.equal(karvonenTargetBpm(60, 0, 0.4), null);
  assert.equal(karvonenTargetBpm(60, -10, 0.4), null);
  assert.equal(karvonenTargetBpm(60, 100, 1.2), null);
  assert.equal(karvonenTargetBpm(60, 100, -0.1), null);

  const implausible = evaluateHrIntensityCandidates({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting({
      ...acceptedRestingMetric(60),
      value: { ...acceptedRestingMetric(60).value, heartRateBpm: 200 },
    }),
    resolvedPrescription: aerobicBasePrescription(),
    nowMs: NOW_MS,
  });
  const main = implausible.phases.find((phase) => phase.intensityId === "aerobic_base" && phase.kind === "work");
  assert.equal(main.status, "withheld");
  assert.ok(
    main.reasonCodes.includes("hrr_unavailable_implausible") ||
      main.reasonCodes.includes("hrr_unavailable_nonpositive")
  );
});

test("qualified aerobic_base work phase produces a candidate under ACSM moderate policy", () => {
  const evaluation = evaluateFor({ athleteId: "athlete-a", ageYears: 40, restingBpm: 60 });
  assert.equal(evaluation.policy.id, HR_INTENSITY_AEROBIC_BASE_POLICY_ID);
  assert.equal(evaluation.mode, "shadow");
  assert.equal(evaluation.activationEligible, false);
  assert.equal(evaluation.authorityNotice, HR_INTENSITY_CANDIDATE_AUTHORITY_NOTICE);
  const main = evaluation.phases.find((phase) => phase.intensityId === "aerobic_base" && phase.kind === "work");
  assert.equal(main.status, "candidate");
  const band = expectedBand(60, 40);
  assert.deepEqual(main.candidateHeartRate, {
    minBpm: band.minBpm,
    maxBpm: band.maxBpm,
    minFractionOfHrr: HR_INTENSITY_AEROBIC_BASE_MIN_FRACTION_OF_HRR,
    maxFractionOfHrr: HR_INTENSITY_AEROBIC_BASE_MAX_FRACTION_OF_HRR,
  });
  assert.ok(main.qualificationLabels.includes("qualified_aerobic_base_sustained_work"));
});

test("threshold, VO2, recovery, warmup, cooldown, and strength phases are withheld", () => {
  const evaluation = evaluateHrIntensityCandidates({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
    resolvedPrescription: multiIntensityPrescription(),
    nowMs: NOW_MS,
  });
  const byId = Object.fromEntries(evaluation.phases.map((phase) => [phase.phaseId, phase]));
  assert.equal(byId.main.status, "candidate");
  for (const id of ["warmup", "threshold", "vo2", "recovery", "cooldown", "strength", "base-warmup-ambiguous"]) {
    assert.equal(byId[id].status, "withheld", id);
    assert.equal(byId[id].candidateHeartRate, null, id);
  }
  assert.ok(byId.threshold.reasonCodes.includes("phase_intensity_unsupported"));
  assert.ok(byId.vo2.reasonCodes.includes("phase_intensity_unsupported"));
  assert.ok(byId["base-warmup-ambiguous"].reasonCodes.includes("phase_kind_not_sustained_work"));
});

test("active frozen and inactive preview prescriptions retain provenance", () => {
  const frozen = aerobicBasePrescription("Tuesday");
  const template = aerobicBasePrescription("Tuesday");
  template.resolvedAt = "preview";
  const active = selectHrReadinessPrescription({
    workoutSelector: "Tuesday",
    sessionActive: isHrReadinessDiagnosticSessionActive({
      workoutSelector: "Tuesday",
      sessionId: "s1",
      startTime: "1",
      activeOwner: { selector: "Tuesday", sessionId: "s1" },
    }),
    frozenPrescription: frozen,
    templatePrescription: template,
  });
  assert.equal(active.provenance, "frozen_session");
  const inactive = selectHrReadinessPrescription({
    workoutSelector: "Tuesday",
    sessionActive: false,
    frozenPrescription: null,
    templatePrescription: template,
  });
  assert.equal(inactive.provenance, "inactive_template_preview");

  const evalFrozen = evaluateHrIntensityCandidates({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
    resolvedPrescription: active.prescription,
    resolvedPrescriptionProvenance: active.provenance,
    nowMs: NOW_MS,
  });
  assert.equal(evalFrozen.resolvedPrescriptionProvenance, "frozen_session");

  const evalPreview = evaluateHrIntensityCandidates({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
    resolvedPrescription: inactive.prescription,
    resolvedPrescriptionProvenance: inactive.provenance,
    nowMs: NOW_MS,
  });
  assert.equal(evalPreview.resolvedPrescriptionProvenance, "inactive_template_preview");
});

test("malformed active-session prescriptions do not fall back to templates", () => {
  const template = aerobicBasePrescription("Tuesday");
  const selected = selectHrReadinessPrescription({
    workoutSelector: "Tuesday",
    sessionActive: true,
    frozenPrescription: { schemaVersion: 1, resolver: { id: "not-legacy", version: 1 } },
    templatePrescription: template,
  });
  assert.equal(selected.provenance, "none");
  assert.equal(selected.prescription, null);
  const evaluation = evaluateHrIntensityCandidates({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
    resolvedPrescription: null,
    resolvedPrescriptionProvenance: "none",
    nowMs: NOW_MS,
  });
  assert.equal(evaluation.phases.length, 0);
  assert.equal(evaluation.resolvedPrescriptionProvenance, "none");
});

test("comparison diagnostics represent missing and open-ended bounds without inventing zeros", () => {
  const evaluation = evaluateHrIntensityCandidates({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
    resolvedPrescription: multiIntensityPrescription(),
    nowMs: NOW_MS,
  });
  const cooldown = evaluation.phases.find((phase) => phase.phaseId === "cooldown");
  assert.equal(cooldown.legacyComparison.comparedLegacyMinBpm, null);
  assert.equal(cooldown.legacyComparison.comparedLegacyMaxBpm, 114);
  assert.ok(cooldown.legacyComparison.reasonCodes.includes("legacy_comparison_open_ended"));
  assert.equal(cooldown.legacyComparison.minDeltaBpm, null);

  const main = evaluation.phases.find((phase) => phase.phaseId === "main");
  assert.equal(main.legacyComparison.comparedLegacyMinBpm, 115);
  assert.equal(main.legacyComparison.comparedLegacyMaxBpm, 130);
  assert.equal(typeof main.legacyComparison.minDeltaBpm, "number");
  assert.equal(typeof main.legacyComparison.maxDeltaBpm, "number");
});

test("same athlete evidence and policy produce deterministic output", () => {
  const input = {
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60, { measurementId: "det" })),
    resolvedPrescription: aerobicBasePrescription(),
    resolvedPrescriptionProvenance: "inactive_template_preview",
    nowMs: NOW_MS,
    policy: HR_INTENSITY_AEROBIC_BASE_POLICY,
  };
  assert.deepEqual(evaluateHrIntensityCandidates(input), evaluateHrIntensityCandidates(input));
});

test("existing E1 candidate watts remain unchanged with resting evidence present", () => {
  const prescription = aerobicBasePrescription("Tuesday");
  const metric = acceptedRestingMetric(58);
  const evaluation = evaluatePersonalizedPrescription({
    legacyPrescription: prescription,
    workoutIntent: "aerobic_base",
    activity: "elliptical",
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

test("H2 evaluator cannot change live BPM targets, zones, or machine guidance", () => {
  const before = aerobicBasePrescription("Tuesday");
  const beforeZones = { z120: mapHrToZone(120), z140: mapHrToZone(140) };
  const work = before.phases.find((phase) => phase.kind === "work");
  const beforeMachine = machineHeartRateTargetFromResolved(work);
  const beforeClone = structuredClone(before);

  evaluateHrIntensityCandidates({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
    resolvedPrescription: before,
    nowMs: NOW_MS,
  });

  assert.deepEqual(before, beforeClone);
  const after = aerobicBasePrescription("Tuesday");
  assert.deepEqual(after, before);
  assert.equal(after.resolver.id, LEGACY_HR_TARGET_RESOLVER_ID);
  assert.deepEqual({ z120: mapHrToZone(120), z140: mapHrToZone(140) }, beforeZones);
  assert.deepEqual(machineHeartRateTargetFromResolved(after.phases.find((phase) => phase.kind === "work")), beforeMachine);
});

test("rendered diagnostic HTML labels provisional candidates and withheld results", () => {
  const evaluation = evaluateHrIntensityCandidates({
    athleteId: "athlete-a",
    expectedAthleteId: "athlete-a",
    ageYears: 40,
    fitnessStorageStatus: "readable",
    fitnessState: fitnessStateWithResting(acceptedRestingMetric(60)),
    resolvedPrescription: multiIntensityPrescription(),
    resolvedPrescriptionProvenance: "inactive_template_preview",
    nowMs: NOW_MS,
  });
  const band = expectedBand(60, 40);
  const html = personalizationDiagnosticsHtml(
    buildPersonalizationDiagnosticsModel([], undefined, {}, {}, {}, null, {}, {}, null, evaluation)
  );
  assert.match(html, /Shadow HR intensity candidates \(H2\)/);
  assert.match(html, /Exploratory athlete-specific HR candidates are not active/);
  assert.match(html, /ACSM GETP moderate-intensity %HRR/);
  assert.match(html, /inactive template preview/);
  assert.match(html, /activationEligible=false/);
  assert.match(html, new RegExp(`${band.minBpm}–${band.maxBpm} bpm`));
  assert.match(html, />candidate</);
  assert.match(html, /withheld \(phase_intensity_unsupported/);
  assert.match(html, /&lt;115 bpm/);
  assert.match(html, /open-ended legacy · endpoint deltas n\/a/);
});
