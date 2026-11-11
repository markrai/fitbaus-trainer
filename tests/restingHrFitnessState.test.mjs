import assert from "node:assert/strict";
import test from "node:test";

import {
  FITNESS_STATE_STORAGE_KEY,
  applyRestingHeartRateSession,
  attachRestingHeartRateSession,
  inspectFitnessStateStorage,
  parseFitnessState,
  readFitnessState,
  storeFitnessState,
  storeRestingHeartRateSession,
} from "../dist/fitnessState.js";
import { ATHLETE_PROFILE_STORAGE_KEY, migrateLegacyProfile, storeAthleteProfile } from "../dist/profile.js";
import { bpmNotificationsAround, runRestingHrSession } from "../dist/restingHrAcquisition.js";
import { evaluatePersonalizedPrescription, PHASE_E1_SHADOW_POLICY } from "../dist/personalizedPrescription.js";
import { resolveWorkoutPrescription } from "../dist/workoutPrescription.js";
import { rebuildPassiveFitnessProjection, rebuildStoredPassiveFitnessProjection } from "../dist/fitnessRefinement.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function athlete(athleteId = "athlete-resting") {
  return migrateLegacyProfile(
    { age: 41, weight: 176.4, height: 68, sex: "female" },
    athleteId,
    "2026-09-01T12:00:00.000Z"
  );
}

function acceptedMetric(bpm = 58, extras = {}) {
  const { result } = runRestingHrSession(bpmNotificationsAround(bpm), {
    measurementId: extras.measurementId ?? "measurement-a",
    athleteId: extras.athleteId ?? "athlete-resting",
    observedAt: extras.observedAt ?? "2026-11-03T12:05:00.000Z",
  });
  assert.equal(result.outcome, "accepted");
  if (extras.quality) {
    return { ...result.metric, quality: extras.quality };
  }
  return result.metric;
}

function moderateMetric(measurementId = "measurement-moderate") {
  const events = [];
  for (let elapsedSec = 0; elapsedSec < 300; elapsedSec += 1) {
    if (elapsedSec < 90 || elapsedSec % 5 !== 0) {
      events.push({ type: "bpm", elapsedSec, bpm: 62 });
    }
  }
  const { result } = runRestingHrSession(events, {
    measurementId,
    athleteId: "athlete-resting",
    observedAt: "2026-11-04T12:05:00.000Z",
  });
  assert.equal(result.outcome, "accepted");
  assert.equal(result.metric.quality, "moderate");
  return result.metric;
}

function formalV3State(athleteId = "athlete-resting") {
  const metric = {
    source: "formal_assessment",
    quality: "high",
    observedAt: "2026-09-18T14:30:00.000Z",
    updatedAt: "2026-09-18T14:31:00.000Z",
    algorithm: { id: "bike-submax-linear-hr-workload", version: 2 },
    evidenceSessionIds: ["assessment-session"],
  };
  return {
    schemaVersion: 3,
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
        protocol: { id: "bike-submax-70rpm", version: 2 },
        predictedHrMaxBpm: 179.3,
        predictedHrMaxSource: "demographic_estimate",
        profileInputSnapshot: { ageYears: 41, bodyMassKg: 176.4 * 0.45359237 },
      },
      ...metric,
    },
    updatedAt: metric.updatedAt,
  };
}

test("accepted resting-session HR persists under the owning athlete and reloads", () => {
  const profile = athlete();
  const storage = memoryStorage();
  assert.equal(storeAthleteProfile(profile, storage), true);
  const metric = acceptedMetric();
  const stored = storeRestingHeartRateSession(metric, storage, { expectedAthleteId: profile.athleteId });
  assert.equal(stored.outcome, "applied");
  assert.equal(stored.state.schemaVersion, 4);
  assert.equal(stored.state.athleteId, profile.athleteId);
  assert.equal(stored.state.restingHeartRateSession.value.heartRateBpm, 58);
  assert.equal(stored.state.restingHeartRateSession.value.eligibleForPrescription, false);

  const reloaded = readFitnessState(profile.athleteId, storage);
  assert.deepEqual(reloaded, stored.state);
  assert.deepEqual(parseFitnessState(JSON.parse(storage.getItem(FITNESS_STATE_STORAGE_KEY))), stored.state);
});

test("v3 FitnessState without resting fields still round-trips", () => {
  const parsed = parseFitnessState(formalV3State());
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(parsed.restingHeartRateSession, undefined);
  assert.deepEqual(parseFitnessState(JSON.parse(JSON.stringify(parsed))), parsed);
});

test("unreadable existing FitnessState refuses resting HR write", () => {
  const profile = athlete();
  const storage = memoryStorage({
    [FITNESS_STATE_STORAGE_KEY]: "{not-json",
  });
  assert.equal(storeAthleteProfile(profile, storage), true);
  assert.equal(inspectFitnessStateStorage(profile.athleteId, storage).status, "unreadable");
  const before = storage.getItem(FITNESS_STATE_STORAGE_KEY);
  const stored = storeRestingHeartRateSession(acceptedMetric(), storage, {
    expectedAthleteId: profile.athleteId,
  });
  assert.equal(stored.outcome, "storage_conflict");
  assert.equal(storage.getItem(FITNESS_STATE_STORAGE_KEY), before);
});

test("wrong-athlete existing FitnessState refuses resting HR write", () => {
  const profile = athlete("athlete-resting");
  const storage = memoryStorage();
  assert.equal(storeAthleteProfile(profile, storage), true);
  assert.equal(storeFitnessState(formalV3State("other-athlete"), storage), true);
  const before = storage.getItem(FITNESS_STATE_STORAGE_KEY);
  assert.equal(inspectFitnessStateStorage(profile.athleteId, storage).status, "athlete_mismatch");
  const stored = storeRestingHeartRateSession(acceptedMetric(), storage, {
    expectedAthleteId: profile.athleteId,
  });
  assert.equal(stored.outcome, "athlete_mismatch");
  assert.equal(storage.getItem(FITNESS_STATE_STORAGE_KEY), before);
});

test("expected athlete mismatch at save refuses write", () => {
  const profile = athlete("athlete-resting");
  const storage = memoryStorage();
  assert.equal(storeAthleteProfile(profile, storage), true);
  const stored = storeRestingHeartRateSession(acceptedMetric(), storage, {
    expectedAthleteId: "someone-else",
  });
  assert.equal(stored.outcome, "athlete_mismatch");
  assert.equal(storage.getItem(FITNESS_STATE_STORAGE_KEY), null);
});

test("athlete identity mismatch refuses to write resting HR", () => {
  const current = applyRestingHeartRateSession({
    currentState: null,
    athleteId: "athlete-resting",
    metric: acceptedMetric(),
  });
  assert.equal(current.outcome, "applied");
  const mismatched = applyRestingHeartRateSession({
    currentState: current.state,
    athleteId: "other-athlete",
    metric: acceptedMetric(60, { measurementId: "measurement-b" }),
  });
  assert.equal(mismatched.outcome, "athlete_mismatch");
});

test("lower-quality measurement does not replace a higher-quality current result", () => {
  const high = acceptedMetric(58, { measurementId: "high-1" });
  assert.equal(high.quality, "high");
  const first = applyRestingHeartRateSession({
    currentState: null,
    athleteId: "athlete-resting",
    metric: high,
  });
  const second = applyRestingHeartRateSession({
    currentState: first.state,
    athleteId: "athlete-resting",
    metric: moderateMetric("moderate-1"),
  });
  assert.equal(second.outcome, "retained_higher_quality");
  assert.equal(second.state.restingHeartRateSession.measurementId, "high-1");
});

test("equal or higher quality demotes the previous accepted result into history", () => {
  const first = applyRestingHeartRateSession({
    currentState: null,
    athleteId: "athlete-resting",
    metric: acceptedMetric(58, { measurementId: "first", observedAt: "2026-11-03T12:05:00.000Z" }),
  });
  const second = applyRestingHeartRateSession({
    currentState: first.state,
    athleteId: "athlete-resting",
    metric: acceptedMetric(55, { measurementId: "second", observedAt: "2026-11-04T12:05:00.000Z" }),
  });
  assert.equal(second.outcome, "applied");
  assert.equal(second.state.restingHeartRateSession.measurementId, "second");
  assert.equal(second.state.restingHeartRateSessionHistory.length, 1);
  assert.equal(second.state.restingHeartRateSessionHistory[0].measurementId, "first");
});

test("history is capped at eight prior accepted measurements", () => {
  let state = null;
  for (let index = 0; index < 10; index += 1) {
    const applied = applyRestingHeartRateSession({
      currentState: state,
      athleteId: "athlete-resting",
      metric: acceptedMetric(50 + (index % 5), {
        measurementId: `measurement-${index}`,
        observedAt: `2026-11-${String(index + 1).padStart(2, "0")}T12:05:00.000Z`,
      }),
    });
    assert.equal(applied.outcome, "applied");
    state = applied.state;
  }
  assert.equal(state.restingHeartRateSession.measurementId, "measurement-9");
  assert.equal(state.restingHeartRateSessionHistory.length, 8);
});

test("VO2 promotion preserves resting-session v4 evidence", () => {
  const resting = applyRestingHeartRateSession({
    currentState: null,
    athleteId: "athlete-resting",
    metric: acceptedMetric(58, { measurementId: "keep-resting" }),
  });
  assert.equal(resting.outcome, "applied");
  const withFormal = attachRestingHeartRateSession(formalV3State(), resting.state);
  assert.equal(withFormal.schemaVersion, 4);
  assert.equal(withFormal.restingHeartRateSession.measurementId, "keep-resting");
  assert.equal(withFormal.vo2Max.value, 46.8);
  assert.deepEqual(parseFitnessState(JSON.parse(JSON.stringify(withFormal))), withFormal);
});

test("Phase D rebuild preserves resting evidence when passive projection is cleared", () => {
  const restingOnly = applyRestingHeartRateSession({
    currentState: null,
    athleteId: "athlete-resting",
    metric: acceptedMetric(58, { measurementId: "phase-d-keep" }),
  });
  assert.equal(restingOnly.outcome, "applied");
  const rebuilt = rebuildPassiveFitnessProjection({
    athleteId: "athlete-resting",
    currentState: restingOnly.state,
    workoutSummaries: [],
  });
  assert.ok(rebuilt.state);
  assert.equal(rebuilt.state.restingHeartRateSession.measurementId, "phase-d-keep");
  assert.equal(rebuilt.state.schemaVersion, 4);
  assert.equal(rebuilt.state.passiveAerobicObservation, undefined);
});

test("Phase D stored rebuild refuses unreadable FitnessState instead of treating it as empty", () => {
  const profile = athlete();
  const storage = memoryStorage({
    [FITNESS_STATE_STORAGE_KEY]: "{broken",
  });
  assert.equal(storeAthleteProfile(profile, storage), true);
  const before = storage.getItem(FITNESS_STATE_STORAGE_KEY);
  assert.equal(rebuildStoredPassiveFitnessProjection([], storage), "persistence_failed");
  assert.equal(storage.getItem(FITNESS_STATE_STORAGE_KEY), before);
});

test("Phase D stored rebuild clears passive while preserving resting-session evidence", () => {
  const profile = athlete();
  const storage = memoryStorage();
  assert.equal(storeAthleteProfile(profile, storage), true);
  const resting = applyRestingHeartRateSession({
    currentState: null,
    athleteId: profile.athleteId,
    metric: acceptedMetric(58, { measurementId: "keep-on-passive-clear" }),
  });
  assert.equal(resting.outcome, "applied");
  // Simulate a previously stored passive observation that no longer qualifies.
  const withPassive = {
    ...resting.state,
    schemaVersion: 4,
    passiveAerobicObservation: {
      value: {
        metric: "descriptive_workload_trend_in_fixed_hr_window",
        interpretation: "descriptive_observation_only",
        normalizedToReferenceHr: false,
        eligibleForPrescription: false,
        intensityId: "threshold",
        heartRateWindowCenterBpm: 151,
        heartRateWindowMinBpm: 150,
        heartRateWindowMaxExclusiveBpm: 152,
        guardedTrendWorkloadWatts: 200,
        baselineWorkloadMedianWatts: 200,
        guardedTrendChangeFromBaselinePercent: 0,
        workloadSourceClasses: ["measured_watts"],
        observedMinWatts: 198,
        observedMaxWatts: 202,
        observedMinHeartRateBpm: 150,
        observedMaxHeartRateBpm: 150,
        medianAbsoluteDeviationWatts: 1,
      },
      source: "workout_observation",
      quality: "low",
      observedAt: "2026-01-04T12:10:00.000Z",
      updatedAt: "2026-01-04T12:10:00.000Z",
      algorithm: { id: "fitness-refinement-v2", version: 2 },
      evidence: {
        sessionCount: 4,
        observationCount: 4,
        distinctWorkoutDateCount: 4,
        earliestEvidenceAt: "2026-01-01T12:10:00.000Z",
        latestEvidenceAt: "2026-01-04T12:10:00.000Z",
        firstSessionId: "session-1",
        latestSessionId: "session-4",
        recentSessionIds: ["session-1", "session-2", "session-3", "session-4"],
        digest: { algorithm: "fnv1a32", value: "deadbeef" },
      },
    },
    updatedAt: "2026-11-03T12:05:00.000Z",
  };
  assert.equal(storeFitnessState(withPassive, storage), true);
  assert.equal(rebuildStoredPassiveFitnessProjection([], storage), "refined");
  const after = readFitnessState(profile.athleteId, storage);
  assert.ok(after);
  assert.equal(after.restingHeartRateSession.measurementId, "keep-on-passive-clear");
  assert.equal(after.passiveAerobicObservation, undefined);
  assert.equal(after.schemaVersion, 4);
});

test("resting HR persistence does not change ordinary workout HR targets or E1 authority", () => {
  const hrTargets = {
    warmup: "135–145",
    warmup_intensity_id: "warmup_easy",
    main_set: "155–162",
    main_set_intensity_id: "threshold",
    main_set_kind: "work",
    cooldown: "<120",
    cooldown_intensity_id: "cooldown",
    intervals: null,
  };
  const prescription = resolveWorkoutPrescription({
    workoutSelector: "Thursday",
    blocks: { warm: 10, sustain: 20, cool: 5 },
    hrTargets,
    resolvedAt: "2026-11-03T12:00:00.000Z",
  });
  const applied = applyRestingHeartRateSession({
    currentState: null,
    athleteId: "athlete-resting",
    metric: acceptedMetric(),
  });
  assert.equal(applied.outcome, "applied");
  const after = resolveWorkoutPrescription({
    workoutSelector: "Thursday",
    blocks: { warm: 10, sustain: 20, cool: 5 },
    hrTargets,
    resolvedAt: "2026-11-03T12:00:00.000Z",
  });
  assert.deepEqual(after, prescription);
  assert.equal(prescription.resolver.id, "legacy-hr-target-resolver");
  const work = prescription.phases.find((phase) => phase.kind === "work");
  assert.deepEqual(work.expectedHeartRate, { min: 155, max: 162 });
  const evaluation = evaluatePersonalizedPrescription({
    legacyPrescription: prescription,
    workoutIntent: "threshold",
    activity: "bike",
    athleteId: "athlete-resting",
    profile: athlete(),
    fitnessState: applied.state,
    resolvedAt: "2026-11-03T12:00:00.000Z",
    policy: PHASE_E1_SHADOW_POLICY,
  });
  assert.equal(evaluation.activationEligible, false);
  assert.equal(evaluation.mode, "shadow");
});
