import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

import {
  FITNESS_REFINEMENT_ALGORITHM_V1,
  qualifyWorkoutResponseForPassiveFitness,
  rebuildPassiveFitnessProjection,
  rebuildStoredPassiveFitnessProjection,
} from "../dist/fitnessRefinement.js";
import { parseFitnessState, readFitnessState, storeFitnessState } from "../dist/fitnessState.js";
import { ATHLETE_PROFILE_STORAGE_KEY, migrateLegacyProfile } from "../dist/profile.js";
import {
  deleteWorkoutSummary,
  getAllWorkoutSummaries,
  resetWorkoutStorageForTests,
  storeWorkoutSummary,
} from "../dist/workoutStorage.js";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function scalar(value, coverageRatio = 1, duration = 600, spread = 4) {
  return {
    sampleCount: Math.round(duration * coverageRatio), coverageRatio,
    mean: value, median: value, min: value - spread, max: value + spread, end: value,
  };
}

function ordinarySummary({
  sessionId = "session-1", athleteId = "athlete-a",
  endedAt = "2026-01-01T12:10:00.000Z", watts = 200, hr = 150,
  provenance = "measured_watts", intensityId = "threshold", activity = "bike",
  cancelled = false, completionFraction = 1, sessionHrCoverage = 1,
  freshBikeCoverage = 1, phaseHrCoverage = 1, phaseWattsCoverage = 1,
  phaseCadenceCoverage = 1, phaseDurationSec = 600,
  completedPhaseSec = phaseDurationSec, wattsSpread = 4, hrSpread = 8, cadenceSpread = 4,
  includeWatts = true, includeCadence = true, includeControllerResistance = false,
} = {}) {
  const plannedActiveSec = phaseDurationSec;
  const completedActiveSec = Math.round(plannedActiveSec * completionFraction);
  const phase = {
    phaseInstanceId: `${sessionId}:main`, phaseId: "main",
    kind: intensityId === "recovery" ? "recovery" : "work", intensityId,
    activeStartSec: 0, activeEndSec: plannedActiveSec, plannedDurationSec: plannedActiveSec,
    completedDurationSec: completedPhaseSec,
    hr: scalar(hr, phaseHrCoverage, completedPhaseSec, hrSpread),
    ...(includeWatts ? { watts: { ...scalar(watts, phaseWattsCoverage, completedPhaseSec, wattsSpread), provenance } } : {}),
    ...(includeCadence ? { cadenceRpm: scalar(72, phaseCadenceCoverage, completedPhaseSec, cadenceSpread) } : {}),
    ...(includeControllerResistance ? {
      desiredResistance: scalar(9, 1, completedPhaseSec, 1),
      commandedResistance: scalar(9, 1, completedPhaseSec, 1),
    } : {}),
  };
  return {
    external_session_id: sessionId, athlete_id: athleteId,
    startedAt: new Date(Date.parse(endedAt) - completedActiveSec * 1000).toISOString(), endedAt,
    category: "cardio", intent: "threshold calibration", duration_minutes: completedActiveSec / 60,
    primary_zone: 4, stress_profile: "high",
    zone_minutes: { z1: 0, z2: 0, z3: 0, z4: completedActiveSec / 60, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] }, activity, cancelled,
    workout_response: {
      schemaVersion: 1, athleteId, sessionId,
      completion: { plannedActiveSec, completedActiveSec, completionFraction, cancelled, earlyCooldown: false },
      evidence: {
        hr: {
          expectedDurationSec: completedActiveSec,
          validSampleCount: Math.round(completedActiveSec * sessionHrCoverage),
          coverageRatio: sessionHrCoverage,
          source: sessionHrCoverage > 0 ? "ble_chest_strap" : "unavailable",
        },
        bike: {
          expectedDurationSec: completedActiveSec, rowCount: completedActiveSec,
          freshSampleCount: Math.round(completedActiveSec * freshBikeCoverage),
          staleSampleCount: completedActiveSec - Math.round(completedActiveSec * freshBikeCoverage),
          unavailableSampleCount: 0, implicitMissingCount: 0,
          freshRowCoverageRatio: freshBikeCoverage,
          wattsProvenance: includeWatts ? provenance : "unavailable",
        },
        rawTelemetry: { store: "ordinary_bike_telemetry", schemaVersion: 1 },
      },
      phases: [phase],
    },
  };
}

function trajectory(watts, options = {}) {
  return watts.map((value, index) => ordinarySummary({
    sessionId: `session-${index + 1}`,
    endedAt: new Date(Date.parse("2026-01-01T12:10:00.000Z") + index * 24 * 60 * 60 * 1000).toISOString(),
    watts: value, ...options,
  }));
}

function sameIntensityPhaseSummary(phases, {
  sessionId = "multi-phase-session",
  endedAt = "2026-01-01T12:16:00.000Z",
} = {}) {
  const phaseDurationSec = 480;
  const totalDurationSec = phases.length * phaseDurationSec;
  const summary = ordinarySummary({
    sessionId,
    endedAt,
    phaseDurationSec,
    hr: phases[0].hr,
    watts: phases[0].watts,
  });
  summary.startedAt = new Date(Date.parse(endedAt) - totalDurationSec * 1000).toISOString();
  summary.duration_minutes = totalDurationSec / 60;
  summary.zone_minutes = { z1: 0, z2: 0, z3: 0, z4: totalDurationSec / 60, z5: 0 };
  const response = summary.workout_response;
  response.completion = {
    plannedActiveSec: totalDurationSec,
    completedActiveSec: totalDurationSec,
    completionFraction: 1,
    cancelled: false,
    earlyCooldown: false,
  };
  response.evidence.hr.expectedDurationSec = totalDurationSec;
  response.evidence.hr.validSampleCount = totalDurationSec;
  Object.assign(response.evidence.bike, {
    expectedDurationSec: totalDurationSec,
    rowCount: totalDurationSec,
    freshSampleCount: totalDurationSec,
  });
  const template = response.phases[0];
  response.phases = phases.map(({ hr, watts }, index) => ({
    ...template,
    phaseInstanceId: `${sessionId}:phase-${index + 1}`,
    phaseId: `phase-${index + 1}`,
    activeStartSec: index * phaseDurationSec,
    activeEndSec: (index + 1) * phaseDurationSec,
    hr: scalar(hr, 1, phaseDurationSec, 1),
    watts: { ...scalar(watts, 1, phaseDurationSec, 1), provenance: "measured_watts" },
  }));
  return summary;
}

function rebuild(summaries, currentState = null, athleteId = "athlete-a") {
  return rebuildPassiveFitnessProjection({ athleteId, currentState, workoutSummaries: summaries });
}

function formalState() {
  const metric = {
    source: "formal_assessment", quality: "high",
    observedAt: "2026-01-10T12:00:00.000Z", updatedAt: "2026-01-10T12:01:00.000Z",
    algorithm: { id: "bike-submax-linear-hr-workload", version: 1 },
    evidenceSessionIds: ["formal-1"],
  };
  return {
    schemaVersion: 1, athleteId: "athlete-a",
    vo2Max: { value: 40.75, ...metric },
    predictedMaxWatts: {
      value: 250, ...metric,
      derivation: "demographic_hrmax_extrapolation", predictedHrMaxSource: "demographic_estimate",
    },
    hrWorkloadCalibration: {
      value: {
        slopeBpmPerWatt: 0.4, interceptBpm: 80, rSquared: 1,
        observedMinWatts: 100, observedMaxWatts: 150,
        points: [
          { stageId: "stage-1", watts: 100, heartRateBpm: 120, workloadSource: "measured_watts" },
          { stageId: "stage-2", watts: 125, heartRateBpm: 130, workloadSource: "measured_watts" },
          { stageId: "stage-3", watts: 150, heartRateBpm: 140, workloadSource: "measured_watts" },
        ],
        protocol: { id: "bike-submax-70rpm", version: 1 },
        predictedHrMaxBpm: 180, predictedHrMaxSource: "demographic_estimate",
        profileInputSnapshot: { ageYears: 40, bodyMassKg: 80 },
      },
      ...metric,
    },
    updatedAt: metric.updatedAt,
  };
}

function historicalV1PassiveState() {
  const latest = "2026-01-04T12:10:00.000Z";
  return {
    schemaVersion: 2, athleteId: "athlete-a", updatedAt: latest,
    passiveAerobicTrend: {
      value: {
        metric: "workload_at_comparable_hr", intensityId: "threshold",
        referenceHeartRateBpm: 150, projectedComparableWorkloadWatts: 200,
        baselineComparableWorkloadWatts: 200, changeFromBaselinePercent: 0,
        qualifiedSessionCount: 4, observationCount: 4, distinctWorkoutDateCount: 4,
        workloadSourceClasses: ["measured_watts"],
        earliestEvidenceAt: "2026-01-01T12:10:00.000Z", latestEvidenceAt: latest,
        observedMinWatts: 198, observedMaxWatts: 202,
        observedMinHeartRateBpm: 149, observedMaxHeartRateBpm: 151,
        medianAbsoluteDeviationWatts: 1, comparisonBandBpm: 10,
      },
      source: "workout_observation", quality: "low", observedAt: latest, updatedAt: latest,
      algorithm: { id: "fitness-refinement-v1", version: 1 },
      evidenceSessionIds: ["session-1", "session-2", "session-3", "session-4"],
    },
  };
}

test("qualification accepts steady owned bike work and exposes descriptive observed evidence", () => {
  const result = qualifyWorkoutResponseForPassiveFitness(ordinarySummary(), "athlete-a");
  assert.equal(result.qualified, true);
  assert.deepEqual(result.observations[0], {
    athleteId: "athlete-a", sessionId: "session-1", workoutDate: "2026-01-01",
    observedAt: "2026-01-01T12:10:00.000Z", intensityId: "threshold",
    heartRateBpm: 150, watts: 200, workloadSource: "measured_watts",
    phaseCount: 1, completedDurationSec: 600,
  });
});

test("cross-window phases cannot manufacture a synthetic session HR observation", () => {
  const result = qualifyWorkoutResponseForPassiveFitness(
    sameIntensityPhaseSummary([{ hr: 145, watts: 200 }, { hr: 155, watts: 210 }]),
    "athlete-a"
  );
  assert.equal(result.qualified, true);
  assert.deepEqual(
    result.observations.map(({ heartRateBpm, watts, phaseCount }) => ({ heartRateBpm, watts, phaseCount })),
    [
      { heartRateBpm: 145, watts: 200, phaseCount: 1 },
      { heartRateBpm: 155, watts: 210, phaseCount: 1 },
    ]
  );
  assert.equal(result.observations.some((observation) => observation.heartRateBpm === 150), false);

  const history = Array.from({ length: 4 }, (_, index) => sameIntensityPhaseSummary(
    [{ hr: 145, watts: 200 }, { hr: 155, watts: 210 }],
    {
      sessionId: `cross-window-${index + 1}`,
      endedAt: new Date(Date.parse("2026-01-01T12:16:00.000Z") + index * 24 * 60 * 60 * 1000).toISOString(),
    }
  ));
  const rebuilt = rebuild(history).state.passiveAerobicObservation;
  assert.equal(rebuilt.value.heartRateWindowMinBpm, 144);
  assert.equal(rebuilt.value.heartRateWindowMaxExclusiveBpm, 146);
  assert.equal(rebuilt.value.guardedTrendWorkloadWatts, 200);
  assert.equal(rebuilt.value.observedMaxWatts, 200);
  assert.equal(rebuilt.evidence.sessionCount, 4);
});

test("same-window phases aggregate once into supported session evidence", () => {
  const result = qualifyWorkoutResponseForPassiveFitness(
    sameIntensityPhaseSummary([{ hr: 145, watts: 200 }, { hr: 145.5, watts: 210 }]),
    "athlete-a"
  );
  assert.equal(result.qualified, true);
  assert.equal(result.observations.length, 1);
  assert.deepEqual(
    {
      heartRateBpm: result.observations[0].heartRateBpm,
      watts: result.observations[0].watts,
      phaseCount: result.observations[0].phaseCount,
      completedDurationSec: result.observations[0].completedDurationSec,
    },
    { heartRateBpm: 145.25, watts: 205, phaseCount: 2, completedDurationSec: 960 }
  );
});

test("qualification rejects ownership, completion, coverage, activity, phase, and stability failures", () => {
  const cases = [
    [ordinarySummary({ athleteId: "athlete-b" }), "ownership_mismatch"],
    [ordinarySummary({ activity: "strength" }), "activity_not_bike"],
    [ordinarySummary({ cancelled: true }), "cancelled"],
    [ordinarySummary({ completionFraction: 0.7, completedPhaseSec: 420 }), "low_completion"],
    [ordinarySummary({ sessionHrCoverage: 0.5 }), "low_session_hr_coverage"],
    [ordinarySummary({ freshBikeCoverage: 0.5 }), "low_fresh_workload_coverage"],
    [ordinarySummary({ intensityId: "vo2_short" }), "unsupported_phase_semantics"],
    [ordinarySummary({ intensityId: "recovery" }), "unsupported_phase_semantics"],
    [ordinarySummary({ phaseDurationSec: 300 }), "phase_too_short"],
    [ordinarySummary({ completionFraction: 0.85, completedPhaseSec: 510 }), "low_phase_completion"],
    [ordinarySummary({ phaseHrCoverage: 0.5 }), "low_phase_hr_coverage"],
    [ordinarySummary({ phaseWattsCoverage: 0.5 }), "low_phase_workload_coverage"],
    [ordinarySummary({ watts: 900 }), "implausible_watts"],
    [ordinarySummary({ hr: 220 }), "implausible_hr"],
    [ordinarySummary({ hrSpread: 30 }), "unstable_hr"],
    [ordinarySummary({ wattsSpread: 80 }), "unstable_workload"],
    [ordinarySummary({ provenance: "mixed" }), "unsupported_workload_provenance"],
    [ordinarySummary({ includeCadence: false }), "missing_or_unstable_cadence"],
    [ordinarySummary({ phaseCadenceCoverage: 0.5 }), "missing_or_unstable_cadence"],
    [ordinarySummary({ cadenceSpread: 20 }), "missing_or_unstable_cadence"],
  ];
  for (const [summary, expectedReason] of cases) {
    const result = qualifyWorkoutResponseForPassiveFitness(summary, "athlete-a");
    assert.equal(result.qualified, false, expectedReason);
    assert.ok(result.rejectionReasons.includes(expectedReason), expectedReason);
  }
});

test("eight-minute qualification means eight completed minutes, not only eight planned minutes", () => {
  const onlySevenMinutesTwelveSeconds = ordinarySummary({
    phaseDurationSec: 480, completedPhaseSec: 432, completionFraction: 0.9,
  });
  const rejected = qualifyWorkoutResponseForPassiveFitness(onlySevenMinutesTwelveSeconds, "athlete-a");
  assert.equal(rejected.qualified, false);
  assert.ok(rejected.rejectionReasons.includes("phase_too_short"));
  assert.equal(qualifyWorkoutResponseForPassiveFitness(ordinarySummary({ phaseDurationSec: 480 }), "athlete-a").qualified, true);
});

test("commanded resistance and unavailable watts never become passive workload", () => {
  const result = qualifyWorkoutResponseForPassiveFitness(
    ordinarySummary({ includeWatts: false, includeControllerResistance: true }), "athlete-a"
  );
  assert.equal(result.qualified, false);
  assert.ok(result.rejectionReasons.includes("unsupported_workload_provenance"));
});

test("one workout and repeated sessions on one date cannot promote passive fitness", () => {
  assert.equal(rebuild([ordinarySummary()]).state, null);
  const sameDate = trajectory([190, 195, 200, 205]).map((summary, index) => ({
    ...summary, endedAt: `2026-01-01T${String(12 + index).padStart(2, "0")}:10:00.000Z`,
  }));
  assert.equal(rebuild(sameDate).state, null);
});

test("four measured independent dates establish a low-quality fixed-HR-window observation", () => {
  const result = rebuild(trajectory([198, 200, 202, 200]));
  assert.equal(result.diagnostics.status, "eligible");
  assert.equal(result.state.schemaVersion, 3);
  assert.equal(result.state.passiveAerobicObservation.source, "workout_observation");
  assert.equal(result.state.passiveAerobicObservation.quality, "low");
  assert.equal(result.state.passiveAerobicObservation.value.guardedTrendWorkloadWatts, 200);
  assert.equal(result.state.passiveAerobicObservation.value.normalizedToReferenceHr, false);
  assert.equal(result.state.passiveAerobicObservation.value.eligibleForPrescription, false);
  assert.deepEqual(result.state.passiveAerobicObservation.value.workloadSourceClasses, ["measured_watts"]);
});

test("calibrated watts remain explicit and require an extra independent session", () => {
  assert.equal(rebuild(trajectory([180, 181, 182, 183], { provenance: "calibrated_watts" })).state, null);
  const five = rebuild(trajectory([180, 181, 182, 183, 184], { provenance: "calibrated_watts" }));
  assert.equal(five.state.passiveAerobicObservation.quality, "low");
  assert.deepEqual(five.state.passiveAerobicObservation.value.workloadSourceClasses, ["calibrated_watts"]);
});

test("stable, improving, anomalous-bad, and repeated-deterioration trajectories are conservative", () => {
  const stable = rebuild(trajectory([200, 200, 201, 199, 200, 200, 201, 199]));
  assert.equal(stable.state.passiveAerobicObservation.value.guardedTrendWorkloadWatts, 200);
  const improving = rebuild(trajectory([180, 182, 184, 186, 190, 194, 198, 202]));
  const improved = improving.state.passiveAerobicObservation.value.guardedTrendWorkloadWatts;
  assert.ok(improved > improving.state.passiveAerobicObservation.value.baselineWorkloadMedianWatts);
  assert.ok(improved < 196);
  const beforeBad = rebuild(trajectory([200, 200, 200, 200]));
  const oneBad = rebuild(trajectory([200, 200, 200, 200, 120]));
  assert.equal(oneBad.state.passiveAerobicObservation.value.guardedTrendWorkloadWatts,
    beforeBad.state.passiveAerobicObservation.value.guardedTrendWorkloadWatts);
  const declining = rebuild(trajectory([200, 200, 200, 200, 180, 178, 176]));
  assert.ok(declining.state.passiveAerobicObservation.value.guardedTrendWorkloadWatts < 200);
  assert.ok(declining.state.passiveAerobicObservation.value.guardedTrendWorkloadWatts >= 198.5);
});

test("a higher-HR group inside the old 10-BPM band cannot manufacture improvement", () => {
  const early = trajectory([200, 200, 200, 200], { hr: 145 });
  const later = trajectory([210, 210, 210, 210], { hr: 155 }).map((summary, index) => ({
    ...summary,
    external_session_id: `later-${index + 1}`,
    startedAt: new Date(Date.parse("2026-01-05T12:00:00.000Z") + index * 24 * 60 * 60 * 1000).toISOString(),
    endedAt: new Date(Date.parse("2026-01-05T12:10:00.000Z") + index * 24 * 60 * 60 * 1000).toISOString(),
    workout_response: { ...summary.workout_response, sessionId: `later-${index + 1}` },
  }));
  const result = rebuild([...early, ...later]);
  const observation = result.state.passiveAerobicObservation;
  assert.equal(observation.value.heartRateWindowMinBpm, 144);
  assert.equal(observation.value.heartRateWindowMaxExclusiveBpm, 146);
  assert.equal(observation.value.guardedTrendWorkloadWatts, 200);
  assert.equal(observation.value.observedMaxWatts, 200);
  assert.equal(observation.evidence.sessionCount, 4);
});

test("writer derives percentage from persisted rounded watts", () => {
  const result = rebuild(trajectory([30.031, 30.031, 30.031, 30.031, 40, 40]));
  const metric = result.state.passiveAerobicObservation;
  assert.equal(metric.value.baselineWorkloadMedianWatts, 30.031);
  assert.equal(metric.value.guardedTrendWorkloadWatts, 30.481);
  assert.equal(metric.value.guardedTrendChangeFromBaselinePercent, 1.498);
  assert.equal(result.diagnostics.baselineWorkloadMedianWatts, 30.031);
  assert.equal(result.diagnostics.rollingCandidateWorkloadWatts, 35.016);
  assert.equal(result.diagnostics.guardedTrendWorkloadWatts, 30.481);
  assert.deepEqual(parseFitnessState(structuredClone(result.state)), result.state);
});

test("writer canonicalizes stored watt extrema before reader range validation", () => {
  const uniform = rebuild(trajectory([30.4806, 30.4806, 30.4806, 30.4806])).state;
  const uniformValue = uniform.passiveAerobicObservation.value;
  assert.equal(uniformValue.observedMinWatts, 30.481);
  assert.equal(uniformValue.observedMaxWatts, 30.481);
  assert.equal(uniformValue.baselineWorkloadMedianWatts, 30.481);
  assert.equal(uniformValue.guardedTrendWorkloadWatts, 30.481);
  assert.deepEqual(parseFitnessState(structuredClone(uniform)), uniform);

  const baselineAtMinimum = rebuild(
    trajectory([30.4806, 30.4806, 30.4806, 30.4806, 40, 40])
  ).state;
  assert.equal(
    baselineAtMinimum.passiveAerobicObservation.value.baselineWorkloadMedianWatts,
    baselineAtMinimum.passiveAerobicObservation.value.observedMinWatts
  );
  assert.deepEqual(parseFitnessState(structuredClone(baselineAtMinimum)), baselineAtMinimum);

  const trendAtMaximum = rebuild(
    trajectory([30.4806, 30.4806, 30.4806, 30.4806, 30, 30])
  ).state;
  assert.equal(
    trendAtMaximum.passiveAerobicObservation.value.guardedTrendWorkloadWatts,
    trendAtMaximum.passiveAerobicObservation.value.observedMaxWatts
  );
  assert.deepEqual(parseFitnessState(structuredClone(trendAtMaximum)), trendAtMaximum);
});

test("duplicate processing and out-of-order replay are idempotent", () => {
  const evidence = trajectory([180, 182, 184, 186, 190, 194]);
  const chronological = rebuild(evidence);
  const replayed = rebuild([evidence[5], evidence[0], evidence[2], evidence[1], evidence[4], evidence[3], evidence[5]]);
  assert.deepEqual(replayed.state, chronological.state);
  assert.deepEqual(replayed.diagnostics.evidenceSessionIds, chronological.diagnostics.evidenceSessionIds);
});

test("athlete ownership is frozen and foreign or legacy-unowned responses cannot contribute", () => {
  const owned = trajectory([190, 192, 194, 196]);
  const foreign = trajectory([250, 252, 254, 256], { athleteId: "athlete-b" });
  const unowned = structuredClone(ordinarySummary());
  delete unowned.athlete_id;
  const result = rebuild([...owned, ...foreign, unowned]);
  assert.equal(result.state.passiveAerobicObservation.value.observedMaxWatts, 196);
  assert.ok(result.diagnostics.rejectionReasonCounts.ownership_mismatch >= 5);
});

test("formal anchor remains authoritative and excludes old ordinary evidence", () => {
  const formal = {
    schemaVersion: 1, athleteId: "athlete-a",
    vo2Max: {
      value: 45, source: "formal_assessment", quality: "moderate",
      observedAt: "2026-01-05T12:00:00.000Z", updatedAt: "2026-01-05T12:01:00.000Z",
      algorithm: { id: "bike-submax-linear-hr-workload", version: 1 }, evidenceSessionIds: ["formal-1"],
    },
    updatedAt: "2026-01-05T12:01:00.000Z",
  };
  assert.ok(parseFitnessState(formal));
  const old = trajectory([250, 252, 254, 256]);
  const recent = trajectory([190, 192, 194, 196]).map((summary, index) => ({
    ...summary, external_session_id: `recent-${index}`,
    endedAt: `2026-01-${String(index + 6).padStart(2, "0")}T12:10:00.000Z`,
    workout_response: { ...summary.workout_response, sessionId: `recent-${index}` },
  }));
  const result = rebuild([...old, ...recent], formal);
  assert.deepEqual(result.state.vo2Max, formal.vo2Max);
  assert.equal(result.state.passiveAerobicObservation.source, "workout_observation");
  assert.equal(result.state.passiveAerobicObservation.value.observedMaxWatts, 196);
  assert.equal(result.state.passiveAerobicObservation.value.formalAnchorSessionId, "formal-1");
});

test("Phase D corrected persistence is strict and historical readers stay independent", () => {
  const state = rebuild(trajectory([198, 200, 202, 200])).state;
  assert.deepEqual(parseFitnessState(structuredClone(state)), state);
  const unknownAlgorithm = structuredClone(state);
  unknownAlgorithm.passiveAerobicObservation.algorithm.version = 3;
  assert.equal(parseFitnessState(unknownAlgorithm), null);
  const malformed = structuredClone(state);
  malformed.passiveAerobicObservation.evidence.distinctWorkoutDateCount = 1;
  assert.equal(parseFitnessState(malformed), null);
  assert.equal(parseFitnessState({ ...state, schemaVersion: 4 }), null);
  assert.equal(parseFitnessState({ ...state, schemaVersion: 2 }), null);
  assert.equal(FITNESS_REFINEMENT_ALGORITHM_V1.id, "fitness-refinement-v1");
});

test("historical v1 reader enforces its session, HR-band, provenance, evidence, and quality contract", () => {
  const valid = historicalV1PassiveState();
  assert.deepEqual(parseFitnessState(structuredClone(valid)), valid);
  const awkwardWriterOutput = structuredClone(valid);
  Object.assign(awkwardWriterOutput.passiveAerobicTrend.value, {
    projectedComparableWorkloadWatts: 30.481,
    baselineComparableWorkloadWatts: 30.031,
    changeFromBaselinePercent: 1.5,
    observedMinWatts: 30.031,
    observedMaxWatts: 40,
    medianAbsoluteDeviationWatts: 0,
  });
  assert.deepEqual(parseFitnessState(awkwardWriterOutput), awkwardWriterOutput);
  const anchored = {
    ...formalState(),
    schemaVersion: 2,
    updatedAt: "2026-01-14T12:10:00.000Z",
    passiveAerobicTrend: structuredClone(valid.passiveAerobicTrend),
  };
  Object.assign(anchored.passiveAerobicTrend, {
    observedAt: anchored.updatedAt,
    updatedAt: anchored.updatedAt,
  });
  Object.assign(anchored.passiveAerobicTrend.value, {
    earliestEvidenceAt: "2026-01-11T12:10:00.000Z",
    latestEvidenceAt: anchored.updatedAt,
    formalAnchorObservedAt: formalState().vo2Max.observedAt,
    formalAnchorSessionId: "formal-1",
  });
  assert.deepEqual(parseFitnessState(structuredClone(anchored)), anchored);
  const forgedAnchor = structuredClone(anchored);
  forgedAnchor.passiveAerobicTrend.value.formalAnchorSessionId = "not-formal-1";
  assert.equal(parseFitnessState(forgedAnchor), null);
  const mutations = [
    (state) => {
      state.passiveAerobicTrend.value.qualifiedSessionCount = 3;
      state.passiveAerobicTrend.value.observationCount = 3;
      state.passiveAerobicTrend.value.distinctWorkoutDateCount = 3;
      state.passiveAerobicTrend.evidenceSessionIds.pop();
    },
    (state) => {
      state.passiveAerobicTrend.value.workloadSourceClasses = ["calibrated_watts"];
    },
    (state) => { state.passiveAerobicTrend.value.observedMaxHeartRateBpm = 160; },
    (state) => { state.passiveAerobicTrend.value.workloadSourceClasses = ["measured_watts", "calibrated_watts"]; },
    (state) => { state.passiveAerobicTrend.evidenceSessionIds.pop(); },
    (state) => { state.passiveAerobicTrend.value.changeFromBaselinePercent = 12; },
    (state) => { state.passiveAerobicTrend.quality = "high"; },
    (state) => {
      state.passiveAerobicTrend.value.workloadSourceClasses = ["calibrated_watts", "measured_watts"];
      state.passiveAerobicTrend.value.qualifiedSessionCount = 5;
      state.passiveAerobicTrend.value.observationCount = 5;
      state.passiveAerobicTrend.evidenceSessionIds.push("session-5");
      state.passiveAerobicTrend.quality = "high";
    },
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(valid);
    mutate(malformed);
    assert.equal(parseFitnessState(malformed), null);
  }
});

test("corrected reader rejects forged window, counts, provenance, and quality", () => {
  const valid = rebuild(trajectory([198, 200, 202, 200, 201, 199])).state;
  const mutations = [
    (state) => { state.passiveAerobicObservation.value.observedMaxHeartRateBpm = 152; },
    (state) => { state.passiveAerobicObservation.evidence.sessionCount = 3; },
    (state) => { state.passiveAerobicObservation.evidence.recentSessionIds.pop(); },
    (state) => { state.passiveAerobicObservation.value.workloadSourceClasses = ["calibrated_watts"]; },
    (state) => { state.passiveAerobicObservation.quality = "high"; },
    (state) => { state.passiveAerobicObservation.evidence.digest.value = "not-a-digest"; },
    (state) => { state.passiveAerobicObservation.value.formalAnchorObservedAt = "2025-12-01T00:00:00.000Z"; },
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(valid);
    mutate(malformed);
    assert.equal(parseFitnessState(malformed), null);
  }
});

test("corrected reader enforces permanent v2 HR, window, and workload bounds", () => {
  const lowerBound = rebuild(trajectory([30, 30, 30, 30], { hr: 80 })).state;
  const upperBound = rebuild(trajectory([600, 600, 600, 600], { hr: 200 })).state;
  assert.deepEqual(parseFitnessState(structuredClone(lowerBound)), lowerBound);
  assert.deepEqual(parseFitnessState(structuredClone(upperBound)), upperBound);

  const malformedStates = [];
  const belowHr = structuredClone(lowerBound);
  Object.assign(belowHr.passiveAerobicObservation.value, {
    heartRateWindowMinBpm: 78,
    heartRateWindowMaxExclusiveBpm: 80,
    heartRateWindowCenterBpm: 79,
    observedMinHeartRateBpm: 79,
    observedMaxHeartRateBpm: 79,
  });
  malformedStates.push(belowHr);

  const aboveHr = structuredClone(upperBound);
  aboveHr.passiveAerobicObservation.value.observedMaxHeartRateBpm = 201;
  malformedStates.push(aboveHr);

  const belowWatts = structuredClone(lowerBound);
  belowWatts.passiveAerobicObservation.value.observedMinWatts = 29;
  malformedStates.push(belowWatts);

  const aboveWatts = structuredClone(upperBound);
  aboveWatts.passiveAerobicObservation.value.observedMaxWatts = 601;
  malformedStates.push(aboveWatts);

  const belowBaseline = structuredClone(lowerBound);
  Object.assign(belowBaseline.passiveAerobicObservation.value, {
    observedMinWatts: 29,
    baselineWorkloadMedianWatts: 29,
    guardedTrendChangeFromBaselinePercent: 3.448,
  });
  malformedStates.push(belowBaseline);

  const aboveTrend = structuredClone(upperBound);
  Object.assign(aboveTrend.passiveAerobicObservation.value, {
    observedMaxWatts: 601,
    guardedTrendWorkloadWatts: 601,
    guardedTrendChangeFromBaselinePercent: 0.167,
  });
  malformedStates.push(aboveTrend);

  for (const malformed of malformedStates) assert.equal(parseFitnessState(malformed), null);
});

test("large evidence histories persist bounded provenance and remain readable", () => {
  const summaries = trajectory(Array.from({ length: 1005 }, (_, index) => 200 + (index % 3) * 0.1));
  const state = rebuild(summaries).state;
  assert.equal(state.passiveAerobicObservation.evidence.sessionCount, 1005);
  assert.equal(state.passiveAerobicObservation.evidence.recentSessionIds.length, 16);
  assert.equal(state.passiveAerobicObservation.evidence.firstSessionId, "session-1");
  assert.equal(state.passiveAerobicObservation.evidence.latestSessionId, "session-1005");
  assert.deepEqual(parseFitnessState(structuredClone(state)), state);
  assert.ok(JSON.stringify(state.passiveAerobicObservation).length < 4000);
});

test("removing passive evidence recomputes state updatedAt from retained formal metrics", () => {
  const formal = formalState();
  const recent = trajectory([190, 192, 194, 196]).map((summary, index) => ({
    ...summary,
    external_session_id: `post-formal-${index + 1}`,
    startedAt: new Date(Date.parse("2026-01-11T12:00:00.000Z") + index * 24 * 60 * 60 * 1000).toISOString(),
    endedAt: new Date(Date.parse("2026-01-11T12:10:00.000Z") + index * 24 * 60 * 60 * 1000).toISOString(),
    workout_response: { ...summary.workout_response, sessionId: `post-formal-${index + 1}` },
  }));
  const combined = rebuild(recent, formal).state;
  assert.ok(combined.passiveAerobicObservation);
  assert.equal(combined.updatedAt, recent[3].endedAt);
  const rebuilt = rebuild(recent.slice(0, 3), combined).state;
  assert.deepEqual(rebuilt.vo2Max, formal.vo2Max);
  assert.deepEqual(rebuilt.predictedMaxWatts, formal.predictedMaxWatts);
  assert.deepEqual(rebuilt.hrWorkloadCalibration, formal.hrWorkloadCalibration);
  assert.equal(rebuilt.passiveAerobicObservation, undefined);
  assert.equal(rebuilt.updatedAt, formal.updatedAt);
  assert.ok(parseFitnessState(rebuilt));
});

test("deleting contributing history rebuilds and removes its passive projection", async () => {
  await resetWorkoutStorageForTests();
  const previousStorage = globalThis.localStorage;
  const athlete = migrateLegacyProfile({}, "athlete-a", "2025-12-01T00:00:00.000Z");
  const storage = memoryStorage({ [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(athlete) });
  globalThis.localStorage = storage;
  try {
    const summaries = trajectory([190, 192, 194, 196]);
    for (const summary of summaries) assert.equal(await storeWorkoutSummary(summary), true);
    const rows = await getAllWorkoutSummaries();
    assert.equal(rebuildStoredPassiveFitnessProjection(rows.map((row) => row.summary), storage), "refined");
    assert.ok(readFitnessState("athlete-a", storage)?.passiveAerobicObservation);
    assert.equal(await deleteWorkoutSummary("session-2"), true);
    assert.equal(readFitnessState("athlete-a", storage), null);
  } finally {
    globalThis.localStorage = previousStorage;
    await resetWorkoutStorageForTests();
  }
});

test("deleting ordinary evidence removes passive state but never destroys formal fitness", async () => {
  await resetWorkoutStorageForTests();
  const previousStorage = globalThis.localStorage;
  const athlete = migrateLegacyProfile({}, "athlete-a", "2025-12-01T00:00:00.000Z");
  const storage = memoryStorage({ [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(athlete) });
  globalThis.localStorage = storage;
  try {
    const formal = formalState();
    const summaries = trajectory([190, 192, 194, 196]).map((summary, index) => ({
      ...summary,
      external_session_id: `delete-post-formal-${index + 1}`,
      startedAt: new Date(Date.parse("2026-01-11T12:00:00.000Z") + index * 24 * 60 * 60 * 1000).toISOString(),
      endedAt: new Date(Date.parse("2026-01-11T12:10:00.000Z") + index * 24 * 60 * 60 * 1000).toISOString(),
      workout_response: { ...summary.workout_response, sessionId: `delete-post-formal-${index + 1}` },
    }));
    for (const summary of summaries) assert.equal(await storeWorkoutSummary(summary), true);
    const combined = rebuild(summaries, formal).state;
    assert.ok(combined.passiveAerobicObservation);
    assert.equal(storeFitnessState(combined, storage), true);
    assert.equal(await deleteWorkoutSummary("delete-post-formal-2"), true);
    const retained = readFitnessState("athlete-a", storage);
    assert.ok(retained);
    assert.deepEqual(retained.vo2Max, formal.vo2Max);
    assert.deepEqual(retained.predictedMaxWatts, formal.predictedMaxWatts);
    assert.deepEqual(retained.hrWorkloadCalibration, formal.hrWorkloadCalibration);
    assert.equal(retained.passiveAerobicObservation, undefined);
    assert.equal(retained.updatedAt, formal.updatedAt);
  } finally {
    globalThis.localStorage = previousStorage;
    await resetWorkoutStorageForTests();
  }
});
