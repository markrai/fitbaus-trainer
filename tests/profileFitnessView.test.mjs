import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  buildProfileFitnessPresentation,
  readProfileFitnessData,
  renderProfileFitness,
} from "../dist/profileFitnessView.js";
import {
  ATHLETE_PROFILE_STORAGE_KEY,
  LEGACY_PROFILE_STORAGE_KEY,
  loadAthleteProfile,
  migrateLegacyProfile,
  storeAthleteProfile,
  updateAthleteProfileFromLegacy,
} from "../dist/profile.js";
import { FITNESS_STATE_STORAGE_KEY, storeFitnessState } from "../dist/fitnessState.js";
import { buildPersonalizationStatus } from "../dist/personalizationStatus.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function athlete(athleteId = "athlete-profile", values = {}) {
  return migrateLegacyProfile(
    { age: 41, weight: 176.4, height: 68, sex: "female", vo2: 43.2, ...values },
    athleteId,
    "2026-09-01T12:00:00.000Z"
  );
}

function formalState(athleteId = "athlete-profile", options = {}) {
  const formalVersion = options.formalVersion ?? 1;
  const metric = {
    source: "formal_assessment",
    quality: "high",
    observedAt: "2026-09-18T14:30:00.000Z",
    updatedAt: "2026-09-18T14:31:00.000Z",
    algorithm: { id: "bike-submax-linear-hr-workload", version: formalVersion },
    evidenceSessionIds: ["assessment-session"],
  };
  const state = {
    schemaVersion: formalVersion === 2 ? 3 : 1,
    athleteId,
    vo2Max: { value: 46.8, ...metric },
    predictedMaxWatts: {
      value: 241.2,
      ...metric,
      derivation: "demographic_hrmax_extrapolation",
      predictedHrMaxSource: "demographic_estimate",
    },
    hrWorkloadCalibration: {
      value: {
        slopeBpmPerWatt: 0.4,
        interceptBpm: 80,
        rSquared: 0.96,
        observedMinWatts: 100,
        observedMaxWatts: 150,
        points: [
          { stageId: "stage-1", watts: 100, heartRateBpm: 120, workloadSource: "measured_watts" },
          { stageId: "stage-2", watts: 125, heartRateBpm: 130, workloadSource: "measured_watts" },
          { stageId: "stage-3", watts: 150, heartRateBpm: 140, workloadSource: "measured_watts" },
        ],
        protocol: { id: "bike-submax-70rpm", version: formalVersion },
        predictedHrMaxBpm: 179.3,
        predictedHrMaxSource: "demographic_estimate",
        profileInputSnapshot: { ageYears: 41, bodyMassKg: 176.4 * 0.45359237 },
      },
      ...metric,
    },
    updatedAt: metric.updatedAt,
  };
  if (options.withoutPredictedPower) delete state.predictedMaxWatts;
  if (options.withoutCalibration) delete state.hrWorkloadCalibration;
  return state;
}

function passiveObservation() {
  return {
    value: {
      metric: "descriptive_workload_trend_in_fixed_hr_window",
      interpretation: "descriptive_observation_only",
      normalizedToReferenceHr: false,
      eligibleForPrescription: false,
      intensityId: "aerobic_base",
      heartRateWindowCenterBpm: 135,
      heartRateWindowMinBpm: 130,
      heartRateWindowMaxExclusiveBpm: 140,
      guardedTrendWorkloadWatts: 205,
      baselineWorkloadMedianWatts: 200,
      guardedTrendChangeFromBaselinePercent: 2.5,
      workloadSourceClasses: ["measured_watts"],
      observedMinWatts: 195,
      observedMaxWatts: 210,
      observedMinHeartRateBpm: 131,
      observedMaxHeartRateBpm: 139,
      medianAbsoluteDeviationWatts: 3,
    },
    source: "workout_observation",
    quality: "moderate",
    observedAt: "2026-09-20T16:00:00.000Z",
    updatedAt: "2026-09-20T16:00:00.000Z",
    algorithm: { id: "fitness-refinement-v2", version: 2 },
    evidence: {
      sessionCount: 6,
      observationCount: 6,
      distinctWorkoutDateCount: 5,
      earliestEvidenceAt: "2026-09-10T16:00:00.000Z",
      latestEvidenceAt: "2026-09-20T16:00:00.000Z",
      firstSessionId: "workout-1",
      latestSessionId: "workout-6",
      recentSessionIds: ["workout-1", "workout-2", "workout-3", "workout-4", "workout-5", "workout-6"],
      digest: { algorithm: "fnv1a32", value: "deadbeef" },
    },
  };
}

const formatOptions = { locale: "en-US", timeZone: "UTC" };

test("profile presentation reads canonical athlete fields and keeps entered VO2 distinct", () => {
  const presentation = buildProfileFitnessPresentation(athlete(), formalState(), formatOptions);
  assert.deepEqual(presentation.profileFields, {
    age: "41",
    weight: "176.4",
    height: "68",
    sex: "female",
    enteredVo2: "43.2",
  });
  assert.equal(presentation.assessment.vo2, "46.8 ml/kg/min");
  assert.notEqual(presentation.profileFields.enteredVo2, presentation.assessment.vo2);
  assert.match(presentation.assessment.assessedAt, /Sep 18, 2026/);
  assert.equal(presentation.assessment.evidence, "Strong heart-rate/workload fit");
});

test("blank profile and missing FitnessState produce safe empty presentation", () => {
  const blank = migrateLegacyProfile({}, "blank-athlete", "2026-09-01T12:00:00.000Z");
  const presentation = buildProfileFitnessPresentation(blank, null, formatOptions);
  assert.deepEqual(presentation.profileFields, { age: "", weight: "", height: "", sex: "", enteredVo2: "" });
  assert.equal(presentation.assessment, null);
  assert.equal(presentation.observation, null);
  assert.equal(presentation.personalization.kind, "assessment_missing");
  assert.equal(presentation.personalization.activePersonalizationEnabled, false);
  assert.equal(JSON.stringify(presentation).includes("undefined"), false);
  assert.equal(JSON.stringify(presentation).includes("NaN"), false);
});

test("personalization status stays unavailable without a usable formal calibration", () => {
  const profile = athlete();
  for (const state of [null, formalState("athlete-profile", { withoutCalibration: true })]) {
    const status = buildPersonalizationStatus(profile, state, formatOptions);
    assert.equal(status.title, "Personalized bike targets are not available yet.");
    assert.equal(status.body, "Complete a FitBaus VO₂ assessment to establish the calibration used for personalization research.");
    assert.equal(status.personalizationEvaluationAvailable, false);
    assert.equal(status.activePersonalizationEnabled, false);
    assert.equal(status.workoutPersonalization, "Inactive");
  }
});

test("self-reported VO2 never becomes personalization evaluation evidence", () => {
  const status = buildPersonalizationStatus(athlete(), null, formatOptions);
  assert.equal(status.assessmentAvailable, false);
  assert.equal(status.kind, "assessment_missing");
});

test("measured formal calibration is available for evaluation but never active control", () => {
  const status = buildPersonalizationStatus(athlete(), formalState(), formatOptions);
  assert.deepEqual(status, {
    kind: "evaluation_available",
    assessmentAvailable: true,
    personalizationEvaluationAvailable: true,
    activePersonalizationEnabled: false,
    title: "Personalization data available",
    body: "FitBaus can evaluate personalized bike workload targets from your assessment. These targets are currently being validated and do not control your workouts yet.",
    source: "FitBaus VO₂ assessment",
    assessedAt: "Sep 18, 2026",
    workloadCalibration: "Measured power",
    workoutPersonalization: "Validation in progress",
  });
});

test("protocol-v2 formal calibration is visible for shadow evaluation but remains inactive", () => {
  const status = buildPersonalizationStatus(
    athlete(),
    formalState("athlete-profile", { formalVersion: 2 }),
    formatOptions
  );
  assert.equal(status.kind, "evaluation_available");
  assert.equal(status.personalizationEvaluationAvailable, true);
  assert.equal(status.activePersonalizationEnabled, false);
  assert.equal(status.workoutPersonalization, "Validation in progress");
});

test("cadence-calibrated formal evidence is labeled accurately", () => {
  const state = formalState();
  state.hrWorkloadCalibration.value.points = state.hrWorkloadCalibration.value.points.map((point) => ({
    ...point,
    workloadSource: "calibrated_at_verified_cadence",
  }));
  const status = buildPersonalizationStatus(athlete(), state, formatOptions);
  assert.equal(status.workloadCalibration, "Estimated from verified cadence");
  assert.equal(status.activePersonalizationEnabled, false);
});

test("profile edits that no longer match the assessment snapshot fail closed", () => {
  const status = buildPersonalizationStatus(
    athlete("athlete-profile", { age: 42 }),
    formalState(),
    formatOptions
  );
  assert.equal(status.personalizationEvaluationAvailable, false);
  assert.equal(status.activePersonalizationEnabled, false);
});

test("user-entered VO2 alone never appears as a formal assessment", () => {
  const presentation = buildProfileFitnessPresentation(athlete(), null, formatOptions);
  assert.equal(presentation.profileFields.enteredVo2, "43.2");
  assert.equal(presentation.assessment, null);
});

test("age and weight without VO2 still show a no-assessment state", () => {
  const presentation = buildProfileFitnessPresentation(
    athlete("athlete-profile", { vo2: "", height: "", sex: "" }),
    null,
    formatOptions
  );
  assert.equal(presentation.profileFields.age, "41");
  assert.equal(presentation.profileFields.weight, "176.4");
  assert.equal(presentation.profileFields.enteredVo2, "");
  assert.equal(presentation.assessment, null);
});

test("formal VO2 can render without any self-reported VO2", () => {
  const presentation = buildProfileFitnessPresentation(
    athlete("athlete-profile", { vo2: "" }),
    formalState(),
    formatOptions
  );
  assert.equal(presentation.profileFields.enteredVo2, "");
  assert.equal(presentation.assessment.vo2, "46.8 ml/kg/min");
});

test("predicted max watts and calibration render only when present", () => {
  const complete = buildProfileFitnessPresentation(athlete(), formalState(), formatOptions);
  assert.equal(complete.assessment.predictedMaxPower, "241 W");
  assert.equal(complete.assessment.calibration, "3 protocol stages · 100–150 W · measured bike power");

  const vo2Only = buildProfileFitnessPresentation(
    athlete(),
    formalState("athlete-profile", { withoutPredictedPower: true, withoutCalibration: true }),
    formatOptions
  );
  assert.equal(vo2Only.assessment.predictedMaxPower, null);
  assert.equal(vo2Only.assessment.calibration, null);
});

test("passive aerobic evidence is presented as a descriptive workout observation", () => {
  const state = { ...formalState(), schemaVersion: 3, passiveAerobicObservation: passiveObservation() };
  const presentation = buildProfileFitnessPresentation(athlete(), state, formatOptions);
  assert.deepEqual(presentation.observation, {
    context: "Aerobic-base workouts",
    workload: "205 W in the 130–139 bpm window",
    trend: "+2.5% vs. the observed baseline",
    evidence: "6 workouts across 5 days · Adequate consistency · measured bike power",
    observedAt: "Sep 20, 2026, 4:00 PM",
  });
  assert.equal(state.passiveAerobicObservation.value.eligibleForPrescription, false);
});

test("renderer selects empty and populated states without placeholder measurements", () => {
  const ids = [
    "fitnessAssessmentEmpty", "fitnessAssessmentContent", "assessedVo2", "fitnessAssessedAt",
    "fitnessAssessmentEvidence", "predictedMaxPowerRow", "predictedMaxPower", "fitnessCalibrationRow",
    "fitnessCalibration", "trainingObservationEmpty", "trainingObservationContent", "trainingObservationContext",
    "trainingObservationWorkload", "trainingObservationTrend", "trainingObservationEvidence", "trainingObservationAt",
    "personalizationStatusTitle", "personalizationStatusBody", "personalizationEvidence", "personalizationSource",
    "personalizationAssessedAt", "personalizationCalibration", "personalizationActivation",
  ];
  const elements = new Map(ids.map((id) => [id, { id, hidden: false, textContent: "" }]));
  const documentRef = { getElementById: (id) => elements.get(id) ?? null };
  renderProfileFitness(
    { athleteProfile: athlete(), fitnessState: formalState() },
    documentRef,
    formatOptions
  );
  assert.equal(elements.get("fitnessAssessmentEmpty").hidden, true);
  assert.equal(elements.get("fitnessAssessmentContent").hidden, false);
  assert.equal(elements.get("assessedVo2").textContent, "46.8 ml/kg/min");
  assert.equal(elements.get("trainingObservationEmpty").hidden, false);
  assert.equal(elements.get("trainingObservationContent").hidden, true);
  assert.equal(elements.get("personalizationStatusTitle").textContent, "Personalization data available");
  assert.equal(elements.get("personalizationCalibration").textContent, "Measured power");
  assert.equal(elements.get("personalizationActivation").textContent, "Validation in progress");
});

test("ownership-safe reader never returns FitnessState for a different athlete", () => {
  const storage = memoryStorage();
  assert.equal(storeAthleteProfile(athlete("athlete-current"), storage), true);
  assert.equal(storeFitnessState(formalState("athlete-previous"), storage), true);
  const data = readProfileFitnessData(storage);
  assert.equal(data.athleteProfile.athleteId, "athlete-current");
  assert.equal(data.fitnessState, null);
});

test("profile edits leave formal FitnessState byte-for-byte unchanged", () => {
  const storage = memoryStorage();
  const original = athlete();
  const fitness = formalState();
  assert.equal(storeAthleteProfile(original, storage), true);
  assert.equal(storeFitnessState(fitness, storage), true);
  const before = storage.getItem(FITNESS_STATE_STORAGE_KEY);
  const edited = updateAthleteProfileFromLegacy(
    { age: 42, weight: 175, height: 69, sex: "female", vo2: 44.1 },
    original,
    "2026-09-22T12:00:00.000Z"
  );
  assert.equal(storeAthleteProfile(edited, storage), true);
  assert.equal(storage.getItem(FITNESS_STATE_STORAGE_KEY), before);
  assert.equal(readProfileFitnessData(storage).fitnessState.vo2Max.value, 46.8);
});

test("existing legacy profiles migrate into the same profile presentation", () => {
  const storage = memoryStorage({
    [LEGACY_PROFILE_STORAGE_KEY]: JSON.stringify({ age: "39", weight: "170", height: "70", sex: "male", vo2: "45.5" }),
  });
  const migrated = loadAthleteProfile(storage, {
    now: "2026-09-22T12:00:00.000Z",
    generateAthleteId: () => "migrated-athlete",
  });
  assert.ok(storage.getItem(ATHLETE_PROFILE_STORAGE_KEY));
  const presentation = buildProfileFitnessPresentation(migrated, null, formatOptions);
  assert.deepEqual(presentation.profileFields, {
    age: "39", weight: "170", height: "70", sex: "male", enteredVo2: "45.5",
  });
  assert.equal(presentation.assessment, null);
});

test("Profile markup labels provenance, empty states, and the non-prescription boundary", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Self-reported fitness/);
  assert.match(html, /Entered VO₂ max/);
  assert.match(html, /FitBaus assessments/);
  assert.match(html, /No FitBaus VO₂ assessment yet/);
  assert.match(html, /Informational only\. Not currently used to change workout targets\./);
  assert.match(html, /Workout personalization/);
  assert.match(html, /Personalized workout control is not active\./);
  assert.doesNotMatch(html, /personalized targets enabled|adaptive workouts enabled|personalized resistance enabled|your workouts are personalized/i);
  assert.doesNotMatch(html, /sync workouts and HRV baseline/i);
});
