import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import {
  FITNESS_STATE_STORAGE_KEY,
  VO2_FITNESS_PROJECTION_V1,
  VO2_FITNESS_PROJECTION_V2,
  VO2_FITNESS_PROJECTION_V2_PROTOCOL_V3,
  captureAthleteFitnessSnapshot,
  isSupportedVo2FitnessEstimator,
  isSupportedVo2FitnessProtocol,
  parseFitnessState,
  promoteVo2AssessmentToFitnessState,
  promoteVo2SummaryToStoredFitnessState,
  readFitnessState,
  storeFitnessState,
} from "../dist/fitnessState.js";
import {
  FORMAL_CALIBRATION_MACHINE_PROVENANCE_STORAGE_KEY,
  calibrationIdentityFromE1Snapshot,
  calibrationIdentityFromMetric,
  recordPromotedCalibrationMachineProvenance,
  resolveWorkoutCalibrationMachine,
} from "../dist/calibrationMachineProvenance.js";
import { createInProgressExecutionProvenance } from "../dist/executionProvenance.js";
import {
  PHASE_E1_SHADOW_POLICY,
  evaluatePersonalizedPrescription,
} from "../dist/personalizedPrescription.js";
import {
  ATHLETE_PROFILE_STORAGE_KEY,
  PROFILE_WEIGHT_LBS_TO_KG,
  migrateLegacyProfile,
} from "../dist/profile.js";
import { assessVo2, assessVo2V1 } from "../dist/vo2Estimator.js";
import {
  FITNESS_STATE_SCHEMA_VERSION,
  VO2_EVIDENCE_SCHEMA_VERSION,
  VO2_PROTOCOL_VERSION,
  VO2_PROTOCOL_VERSION_V3,
} from "../dist/types.js";
import { resolveWorkoutPrescription } from "../dist/workoutPrescription.js";
import {
  emitWorkoutSummary,
} from "../dist/workoutSummary.js";
import { rebuildStoredPassiveFitnessProjection } from "../dist/fitnessRefinement.js";
import {
  getAllWorkoutSummaries,
  resetWorkoutStorageForTests,
  storeWorkoutSummary,
} from "../dist/workoutStorage.js";

function memoryStorage(initial = {}, failKey) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (key === failKey) throw new Error(`write failed: ${key}`);
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function captureConsoleDiagnostics(action) {
  const warnings = [];
  const errors = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => warnings.push(args);
  console.error = (...args) => errors.push(args);
  try {
    await action();
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
  return { warnings, errors };
}

function athleteProfile(athleteId = "athlete-fitness") {
  return migrateLegacyProfile(
    { age: 40, weight: 80 / PROFILE_WEIGHT_LBS_TO_KG, height: 70, sex: "female", vo2: 55 },
    athleteId,
    "2026-09-01T12:00:00.000Z"
  );
}

function protocolEvidence({
  heartRates = [120, 130, 140],
  workloadSources = ["measured_watts", "measured_watts", "measured_watts"],
  includeRejected = true,
  schemaVersion = VO2_EVIDENCE_SCHEMA_VERSION,
  protocolVersion = VO2_PROTOCOL_VERSION,
} = {}) {
  const watts = [100, 125, 150];
  const stages = watts.map((stageWatts, index) => {
    const source = workloadSources[index];
    return {
      stage_id: `stage-${index + 1}`,
      active_start_sec: 300 + index * 180,
      active_end_sec: 480 + index * 180,
      requested_watts: stageWatts,
      prescribed_resistance: 3 + index,
      calibrated_watts_at_70rpm: stageWatts,
      status: "accepted",
      nominal_duration_sec: 180,
      actual_duration_sec: 180,
      hr: {
        sample_count: 120,
        minute_2_mean_bpm: heartRates[index],
        minute_3_mean_bpm: heartRates[index],
        final_two_window_delta_bpm: 0,
        steady_state_bpm: heartRates[index],
      },
      workload: {
        source,
        estimator_watts: stageWatts,
        calibrated_watts_at_70rpm: stageWatts,
        measured_watts_median: source === "measured_watts" ? stageWatts : undefined,
        measured_watts_sample_count: source === "measured_watts" ? 100 : 0,
        measured_cadence_median_rpm: 70,
        measured_cadence_sample_count: 100,
        cadence_in_band_ratio: 1,
        cadence_measured: true,
        watts_measured: source === "measured_watts",
      },
    };
  });
  if (includeRejected) {
    stages.push({
      stage_id: "stage-rejected",
      active_start_sec: 840,
      active_end_sec: 1020,
      requested_watts: 175,
      prescribed_resistance: 6,
      calibrated_watts_at_70rpm: 175,
      status: "unstable_hr",
      nominal_duration_sec: 180,
      actual_duration_sec: 180,
      hr: { sample_count: 120, steady_state_bpm: 150 },
      workload: {
        source: "measured_watts",
        estimator_watts: 175,
        calibrated_watts_at_70rpm: 175,
        measured_watts_median: 175,
        measured_watts_sample_count: 100,
        measured_cadence_median_rpm: 70,
        measured_cadence_sample_count: 100,
        cadence_in_band_ratio: 1,
        cadence_measured: true,
        watts_measured: true,
      },
    });
  }
  return {
    schema_version: schemaVersion,
    activity: "bike",
    intent: "vo2_estimation",
    day: "VO2MaxEstimation",
    active_duration_sec: 1200,
    paused_duration_sec: 0,
    work_end_active_sec: 1020,
    cooldown_start_active_sec: 1020,
    early_cooldown: false,
    phases: [],
    hr: { source: "ble_chest_strap", sample_count: 360 },
    protocol: {
      protocol_id: "bike-submax-70rpm",
      protocol_version: protocolVersion,
      prescribed_cadence_rpm: 70,
      stages,
      termination: { reason: "protocol_complete" },
      automatic_submax_hr_ceiling_available: false,
    },
  };
}

function assessmentFixture(options = {}) {
  const athlete = athleteProfile(options.athleteId);
  const historicalV1 = options.contract === "v1";
  const vo2Evidence = protocolEvidence({
    ...options,
    ...(historicalV1 ? { schemaVersion: 1, protocolVersion: 1 } : {}),
  });
  const assessment = (historicalV1 ? assessVo2V1 : assessVo2)(
    vo2Evidence,
    { age_years: 40, weight_kg: 80 }
  );
  const endedAt = options.endedAt ?? "2026-09-21T12:30:00.000Z";
  const startedAt = new Date(Date.parse(endedAt) - 30 * 60 * 1000).toISOString();
  const summary = {
    external_session_id: options.sessionId ?? "fitness-session",
    athlete_id: athlete.athleteId,
    athlete_fitness_snapshot: {
      athleteId: athlete.athleteId,
      profileSchemaVersion: 1,
    },
    startedAt,
    endedAt,
    category: "cardio",
    intent: "vo2_estimation",
    duration_minutes: 30,
    primary_zone: 3,
    stress_profile: "moderate",
    zone_minutes: { z1: 0, z2: 0, z3: 30, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "VO2MaxEstimation",
    vo2_evidence: vo2Evidence,
    vo2_assessment: assessment,
  };
  return { athlete, assessment, summary };
}

function ordinaryFitnessSummary(sessionId, endedAt, watts = 200, hr = 150) {
  const duration = 600;
  const scalar = (value, spread) => ({
    sampleCount: duration, coverageRatio: 1, mean: value, median: value,
    min: value - spread, max: value + spread, end: value,
  });
  return {
    external_session_id: sessionId,
    athlete_id: "athlete-fitness",
    startedAt: new Date(Date.parse(endedAt) - duration * 1000).toISOString(),
    endedAt,
    category: "cardio",
    intent: "threshold calibration",
    duration_minutes: 10,
    primary_zone: 4,
    stress_profile: "high",
    zone_minutes: { z1: 0, z2: 0, z3: 0, z4: 10, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    activity: "bike",
    workout_response: {
      schemaVersion: 1,
      athleteId: "athlete-fitness",
      sessionId,
      completion: {
        plannedActiveSec: duration, completedActiveSec: duration,
        completionFraction: 1, cancelled: false, earlyCooldown: false,
      },
      evidence: {
        hr: { expectedDurationSec: duration, validSampleCount: duration, coverageRatio: 1, source: "ble_chest_strap" },
        bike: {
          expectedDurationSec: duration, rowCount: duration, freshSampleCount: duration,
          staleSampleCount: 0, unavailableSampleCount: 0, implicitMissingCount: 0,
          freshRowCoverageRatio: 1, wattsProvenance: "measured_watts",
        },
        rawTelemetry: { store: "ordinary_bike_telemetry", schemaVersion: 1 },
      },
      phases: [{
        phaseInstanceId: `${sessionId}:main`, phaseId: "main", kind: "work", intensityId: "threshold",
        activeStartSec: 0, activeEndSec: duration, plannedDurationSec: duration, completedDurationSec: duration,
        hr: scalar(hr, 8),
        watts: { ...scalar(watts, 4), provenance: "measured_watts" },
        cadenceRpm: scalar(72, 4),
      }],
    },
  };
}

function promote(fixture, currentState = null, updatedAt = "2026-09-21T12:31:00.000Z") {
  return promoteVo2AssessmentToFitnessState({
    currentState,
    athleteProfile: fixture.athlete,
    workoutSummary: fixture.summary,
    assessment: fixture.assessment,
    updatedAt,
  });
}

test("fitness state parser and local persistence reconstruct strict versioned records", () => {
  const fixture = assessmentFixture();
  const promoted = promote(fixture);
  assert.ok(promoted);
  const parsed = parseFitnessState(deepClone(promoted));
  assert.deepEqual(parsed, promoted);
  assert.equal(parsed.athleteId, fixture.athlete.athleteId);
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(parsed.vo2Max.algorithm.version, VO2_FITNESS_PROJECTION_V2.estimatorVersion);
  assert.equal(parsed.hrWorkloadCalibration.value.protocol.version, VO2_FITNESS_PROJECTION_V2.protocolVersion);
  assert.equal(parsed.updatedAt, "2026-09-21T12:31:00.000Z");

  const storage = memoryStorage();
  assert.equal(storeFitnessState(promoted, storage), true);
  assert.deepEqual(readFitnessState(fixture.athlete.athleteId, storage), promoted);
  assert.equal(readFitnessState("different-athlete", storage), null);
  assert.equal(parseFitnessState({ ...promoted, schemaVersion: 4 }), null);
  assert.equal(parseFitnessState({ ...promoted, athleteId: "" }), null);
  assert.equal(parseFitnessState({ ...promoted, vo2Max: { ...promoted.vo2Max, value: "bad" } }), null);
  assert.equal(parseFitnessState({ ...promoted, updatedAt: "not-a-date" }), null);
});

test("persisted v1 fitness state uses permanent supported identities and rejects unknown versions", () => {
  const fixture = assessmentFixture({ contract: "v1" });
  const persistedV1 = deepClone(promote(fixture));
  assert.ok(persistedV1);

  const v1EstimatorId = "bike-submax-linear-hr-workload";
  const v1ProtocolId = "bike-submax-70rpm";
  assert.equal(VO2_FITNESS_PROJECTION_V1.estimatorId, v1EstimatorId);
  assert.equal(VO2_FITNESS_PROJECTION_V1.protocolId, v1ProtocolId);
  assert.equal(VO2_FITNESS_PROJECTION_V1.estimatorVersion, 1);
  assert.equal(VO2_FITNESS_PROJECTION_V1.protocolVersion, 1);
  assert.equal(isSupportedVo2FitnessEstimator(v1EstimatorId, 1), true);
  assert.equal(isSupportedVo2FitnessEstimator(v1EstimatorId, 2), true);
  assert.equal(isSupportedVo2FitnessProtocol(v1ProtocolId, 1), true);
  assert.equal(isSupportedVo2FitnessProtocol(v1ProtocolId, 2), true);
  assert.deepEqual(parseFitnessState(persistedV1), persistedV1);

  const futureEstimator = deepClone(persistedV1);
  futureEstimator.vo2Max.algorithm.version = 2;
  assert.equal(parseFitnessState(futureEstimator), null);

  const futureProtocol = deepClone(persistedV1);
  futureProtocol.hrWorkloadCalibration.value.protocol.version = 2;
  assert.equal(parseFitnessState(futureProtocol), null);

  const unknownEstimator = deepClone(persistedV1);
  unknownEstimator.vo2Max.algorithm.id = "unknown-estimator";
  assert.equal(parseFitnessState(unknownEstimator), null);
});

test("qualified formal assessment promotes exact VO2, extrapolated watts, and eligible calibration only", () => {
  const fixture = assessmentFixture();
  const originalSummary = deepClone(fixture.summary);
  const state = promote(fixture);
  assert.ok(state);
  assert.equal(state.schemaVersion, VO2_FITNESS_PROJECTION_V2.fitnessStateSchemaVersion);
  assert.equal(VO2_FITNESS_PROJECTION_V2.assessmentSchemaVersion, 2);
  assert.equal(VO2_FITNESS_PROJECTION_V2.evidenceSchemaVersion, 2);
  assert.equal(state.vo2Max.value, fixture.assessment.estimate_ml_kg_min);
  assert.equal(state.vo2Max.source, "formal_assessment");
  assert.equal(state.vo2Max.quality, "high");
  assert.deepEqual(state.vo2Max.algorithm, {
    id: "bike-submax-linear-hr-workload",
    version: 2,
  });
  assert.deepEqual(state.vo2Max.evidenceSessionIds, [fixture.summary.external_session_id]);
  assert.equal(state.predictedMaxWatts.value, fixture.assessment.diagnostics.predicted_max_watts);
  assert.equal(state.predictedMaxWatts.source, "formal_assessment");
  assert.equal(state.predictedMaxWatts.derivation, "demographic_hrmax_extrapolation");
  assert.equal(state.predictedMaxWatts.predictedHrMaxSource, "demographic_estimate");
  assert.equal(state.hrWorkloadCalibration.value.slopeBpmPerWatt, fixture.assessment.diagnostics.slope);
  assert.equal(state.hrWorkloadCalibration.value.interceptBpm, fixture.assessment.diagnostics.intercept);
  assert.equal(state.hrWorkloadCalibration.value.rSquared, fixture.assessment.diagnostics.r_squared);
  assert.equal(state.hrWorkloadCalibration.value.points.length, 3);
  assert.equal(state.hrWorkloadCalibration.value.points.some((point) => point.stageId === "stage-rejected"), false);
  assert.deepEqual(state.hrWorkloadCalibration.value.protocol, {
    id: "bike-submax-70rpm",
    version: 2,
  });
  assert.equal(state.hrWorkloadCalibration.value.predictedHrMaxSource, "demographic_estimate");
  assert.equal("observedHrMax" in state, false);
  assert.deepEqual(fixture.summary, originalSummary);
});

test("current protocol-v3 assessment promotes exact formal state, round-trips, and is consumable by E1", () => {
  const fixture = assessmentFixture({
    protocolVersion: VO2_PROTOCOL_VERSION_V3,
    sessionId: "fitness-session-v3",
  });
  assert.equal(fixture.assessment.status, "estimated");
  assert.equal(fixture.assessment.estimator_version, 2);
  assert.equal(fixture.assessment.input_snapshot.protocol_version, VO2_PROTOCOL_VERSION_V3);
  assert.equal(fixture.assessment.diagnostics.expected_protocol_version, VO2_PROTOCOL_VERSION);
  assert.equal(fixture.assessment.diagnostics.observed_protocol_version, VO2_PROTOCOL_VERSION_V3);

  assert.equal(VO2_FITNESS_PROJECTION_V2_PROTOCOL_V3.fitnessStateSchemaVersion, FITNESS_STATE_SCHEMA_VERSION);
  assert.equal(VO2_FITNESS_PROJECTION_V2_PROTOCOL_V3.assessmentSchemaVersion, 2);
  assert.equal(VO2_FITNESS_PROJECTION_V2_PROTOCOL_V3.evidenceSchemaVersion, 2);
  assert.equal(VO2_FITNESS_PROJECTION_V2_PROTOCOL_V3.estimatorVersion, 2);
  assert.equal(VO2_FITNESS_PROJECTION_V2_PROTOCOL_V3.protocolVersion, VO2_PROTOCOL_VERSION_V3);
  assert.equal(VO2_FITNESS_PROJECTION_V2_PROTOCOL_V3.diagnosticsExpectedProtocolVersion, VO2_PROTOCOL_VERSION);

  const state = promote(fixture);
  assert.ok(state, "current protocol-v3 assessment should promote");
  assert.equal(state.schemaVersion, FITNESS_STATE_SCHEMA_VERSION);
  assert.equal(state.vo2Max.source, "formal_assessment");
  assert.equal(state.predictedMaxWatts.source, "formal_assessment");
  assert.equal(state.hrWorkloadCalibration.source, "formal_assessment");
  assert.deepEqual(state.vo2Max.algorithm, {
    id: fixture.assessment.estimator_id,
    version: 2,
  });
  assert.deepEqual(state.vo2Max.evidenceSessionIds, [fixture.summary.external_session_id]);
  assert.equal(state.vo2Max.observedAt, fixture.summary.endedAt);
  assert.deepEqual(state.hrWorkloadCalibration.value.profileInputSnapshot, {
    ageYears: fixture.assessment.input_snapshot.age_years,
    bodyMassKg: fixture.assessment.input_snapshot.weight_kg,
  });
  assert.deepEqual(
    state.hrWorkloadCalibration.value.points,
    fixture.assessment.diagnostics.eligible_points.map((point) => ({
      stageId: point.stage_id,
      watts: point.watts,
      heartRateBpm: point.steady_state_bpm,
      workloadSource: point.workload_source,
    }))
  );
  assert.equal(state.hrWorkloadCalibration.value.slopeBpmPerWatt, fixture.assessment.diagnostics.slope);
  assert.equal(state.hrWorkloadCalibration.value.interceptBpm, fixture.assessment.diagnostics.intercept);
  assert.equal(state.hrWorkloadCalibration.value.rSquared, fixture.assessment.diagnostics.r_squared);
  assert.deepEqual(state.hrWorkloadCalibration.value.protocol, {
    id: "bike-submax-70rpm",
    version: VO2_PROTOCOL_VERSION_V3,
  });

  const parsed = parseFitnessState(deepClone(state));
  assert.deepEqual(parsed, state);
  assert.equal(parsed.hrWorkloadCalibration.value.protocol.version, VO2_PROTOCOL_VERSION_V3);

  const calibrationIdentity = calibrationIdentityFromMetric(state.athleteId, state.hrWorkloadCalibration);
  assert.ok(calibrationIdentity);
  assert.equal(calibrationIdentity.protocol.version, VO2_PROTOCOL_VERSION_V3);
  assert.equal(calibrationIdentity.algorithm.version, 2);
  assert.deepEqual(calibrationIdentity.evidenceSessionIds, [fixture.summary.external_session_id]);
  const provenanceStorage = memoryStorage();
  assert.equal(recordPromotedCalibrationMachineProvenance({
    athleteId: state.athleteId,
    sessionId: fixture.summary.external_session_id,
    endedAt: fixture.summary.endedAt,
    machine: { machineId: "proform-smart-power-10", machineProfileVersion: 1 },
    calibrationMetric: state.hrWorkloadCalibration,
  }, provenanceStorage, "2026-09-21T12:32:00.000Z"), "recorded");
  assert.deepEqual(resolveWorkoutCalibrationMachine(calibrationIdentity, provenanceStorage), {
    status: "available",
    calibration: calibrationIdentity,
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
  });

  const prescription = resolveWorkoutPrescription({
    workoutSelector: "Thursday",
    blocks: { warm: 0, sustain: 60, cool: 0 },
    hrTargets: {
      main_set: "120–130",
      main_set_intensity_id: "threshold",
      main_set_kind: "work",
      intervals: null,
    },
    resolvedAt: "2026-09-22T12:00:00.000Z",
  });
  const evaluation = evaluatePersonalizedPrescription({
    legacyPrescription: prescription,
    workoutIntent: "threshold",
    activity: "bike",
    athleteId: fixture.athlete.athleteId,
    profile: fixture.athlete,
    fitnessState: state,
    policy: PHASE_E1_SHADOW_POLICY,
    resolvedAt: "2026-09-22T12:00:00.000Z",
  });
  assert.equal(evaluation.fitnessEvidenceSnapshot.algorithm.version, 2);
  assert.equal(evaluation.fitnessEvidenceSnapshot.calibration.protocol.version, VO2_PROTOCOL_VERSION_V3);
  assert.deepEqual(
    calibrationIdentityFromE1Snapshot(evaluation.athleteId, evaluation.fitnessEvidenceSnapshot),
    calibrationIdentity
  );
  assert.equal(evaluation.phases.length, 1);
  assert.notEqual(evaluation.phases[0].fallbackReason, "missing_fitness_state");
  assert.notEqual(evaluation.phases[0].fallbackReason, "unsupported_protocol");
  assert.equal(evaluation.phases[0].outcome, "candidate");
});

test("promotion fails closed for insufficient, unsupported, malformed, or foreign evidence", () => {
  const fixture = assessmentFixture();
  const insufficient = deepClone(fixture);
  insufficient.assessment.status = "insufficient_evidence";
  assert.equal(promote(insufficient), null);

  const unsupportedEstimator = deepClone(fixture);
  unsupportedEstimator.assessment.estimator_version = 99;
  assert.equal(promote(unsupportedEstimator), null);

  const unsupportedProtocol = deepClone(fixture);
  unsupportedProtocol.assessment.input_snapshot.protocol_version = 99;
  assert.equal(promote(unsupportedProtocol), null);

  const malformedRegression = deepClone(fixture);
  malformedRegression.assessment.diagnostics.slope = "bad";
  assert.equal(promote(malformedRegression), null);

  const malformedHistorical = deepClone(fixture);
  delete malformedHistorical.assessment.diagnostics;
  assert.doesNotThrow(() => promote(malformedHistorical));
  assert.equal(promote(malformedHistorical), null);

  const rejectedPoint = deepClone(fixture);
  rejectedPoint.assessment.diagnostics.eligible_points[0].estimator_eligible = false;
  assert.equal(promote(rejectedPoint), null);

  const foreign = deepClone(fixture);
  foreign.summary.athlete_id = "different-athlete";
  assert.equal(promote(foreign), null);
});

test("fit quality maps directly and cadence-calibrated workload can only downgrade it", () => {
  const high = assessmentFixture({ heartRates: [120, 130, 140] });
  assert.equal(high.assessment.fit_quality, "high");
  assert.equal(promote(high).vo2Max.quality, "high");

  const moderate = assessmentFixture({ heartRates: [120, 135, 140] });
  assert.equal(moderate.assessment.fit_quality, "moderate");
  assert.equal(promote(moderate).vo2Max.quality, "moderate");

  const low = assessmentFixture({ heartRates: [120, 142, 145] });
  assert.equal(low.assessment.fit_quality, "low");
  assert.equal(promote(low).vo2Max.quality, "low");

  const calibrated = assessmentFixture({
    workloadSources: [
      "calibrated_at_verified_cadence",
      "calibrated_at_verified_cadence",
      "calibrated_at_verified_cadence",
    ],
  });
  assert.equal(calibrated.assessment.fit_quality, "high");
  const calibratedState = promote(calibrated);
  assert.equal(calibratedState.vo2Max.quality, "moderate");
  assert.equal(calibratedState.hrWorkloadCalibration.quality, "moderate");
});

test("formal assessment precedence follows evidence time and invalid updates preserve prior state", () => {
  const first = assessmentFixture({
    sessionId: "assessment-first",
    endedAt: "2026-09-20T12:30:00.000Z",
  });
  const firstState = promote(first, null, "2026-09-20T12:31:00.000Z");
  assert.ok(firstState);
  assert.equal(first.athlete.userEnteredVo2.quality, "unverified");
  assert.equal(firstState.vo2Max.source, "formal_assessment");
  assert.notEqual(firstState.vo2Max.value, first.athlete.userEnteredVo2.value);

  const newer = assessmentFixture({
    sessionId: "assessment-newer",
    endedAt: "2026-09-21T12:30:00.000Z",
    heartRates: [120, 135, 140],
  });
  const newerState = promote(newer, firstState, "2026-09-21T12:31:00.000Z");
  assert.ok(newerState);
  assert.deepEqual(newerState.vo2Max.evidenceSessionIds, ["assessment-newer"]);

  const olderProcessedLater = assessmentFixture({
    sessionId: "assessment-older",
    endedAt: "2026-09-19T12:30:00.000Z",
  });
  assert.equal(
    promote(olderProcessedLater, newerState, "2026-09-22T12:31:00.000Z"),
    null
  );

  const invalidNewer = assessmentFixture({
    sessionId: "assessment-invalid",
    endedAt: "2026-09-22T12:30:00.000Z",
  });
  invalidNewer.assessment.status = "insufficient_evidence";
  const frozen = deepClone(newerState);
  assert.equal(promote(invalidNewer, newerState, "2026-09-22T12:31:00.000Z"), null);
  assert.deepEqual(newerState, frozen);
});

test("athlete fitness snapshot identifies state without copying the full model", () => {
  const fixture = assessmentFixture();
  const state = promote(fixture);
  const storage = memoryStorage({
    [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(fixture.athlete),
    [FITNESS_STATE_STORAGE_KEY]: JSON.stringify(state),
  });
  assert.deepEqual(captureAthleteFitnessSnapshot(storage), {
    athleteId: fixture.athlete.athleteId,
    profileSchemaVersion: 1,
    fitnessStateSchemaVersion: 3,
    fitnessUpdatedAt: state.updatedAt,
  });
});

test("qualified stored promotion persists the athlete-owned current projection", () => {
  const fixture = assessmentFixture({ endedAt: "2026-09-20T12:30:00.000Z" });
  const storage = memoryStorage({
    [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(fixture.athlete),
  });
  assert.equal(
    promoteVo2SummaryToStoredFitnessState(
      fixture.summary,
      storage,
      "2026-09-20T12:31:00.000Z"
    ),
    "promoted"
  );
  const stored = readFitnessState(fixture.athlete.athleteId, storage);
  assert.ok(stored);
  assert.equal(stored.vo2Max.value, fixture.assessment.estimate_ml_kg_min);
  assert.equal(stored.vo2Max.algorithm.version, 2);
  assert.equal(stored.hrWorkloadCalibration.value.protocol.version, 2);
  assert.deepEqual(parseFitnessState(deepClone(stored)), stored);
  assert.deepEqual(stored.vo2Max.evidenceSessionIds, [fixture.summary.external_session_id]);
});

test("workout finalization promotes and persists a current protocol-v3 assessment", async () => {
  const previousIndexedDb = globalThis.indexedDB;
  const previousKeyRange = globalThis.IDBKeyRange;
  const previousStorage = globalThis.localStorage;
  globalThis.indexedDB = indexedDB;
  globalThis.IDBKeyRange = IDBKeyRange;
  const fixture = assessmentFixture({
    protocolVersion: VO2_PROTOCOL_VERSION_V3,
    sessionId: "fitness-finalization-v3",
    endedAt: "2026-09-20T12:30:00.000Z",
  });
  const storage = memoryStorage({
    [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(fixture.athlete),
  });
  fixture.summary.execution_provenance = createInProgressExecutionProvenance(
    fixture.summary.external_session_id,
    {
      status: "selected",
      machineId: "proform-smart-power-10",
      machineProfileVersion: 1,
      selectionChangedDuringWorkout: false,
    },
    { status: "no_frozen_calibration" }
  );
  globalThis.localStorage = storage;
  try {
    await resetWorkoutStorageForTests();
    const diagnostics = await captureConsoleDiagnostics(() => emitWorkoutSummary(fixture.summary));
    assert.deepEqual(diagnostics, { warnings: [], errors: [] });
    const stored = readFitnessState(fixture.athlete.athleteId, storage);
    assert.ok(stored);
    assert.equal(stored.schemaVersion, FITNESS_STATE_SCHEMA_VERSION);
    assert.equal(stored.vo2Max.algorithm.version, 2);
    assert.equal(stored.hrWorkloadCalibration.value.protocol.version, VO2_PROTOCOL_VERSION_V3);
    assert.deepEqual(stored.hrWorkloadCalibration.evidenceSessionIds, [fixture.summary.external_session_id]);
    assert.deepEqual(parseFitnessState(deepClone(stored)), stored);
    const persistedSummary = (await getAllWorkoutSummaries()).find(
      (row) => row.summary.external_session_id === fixture.summary.external_session_id
    );
    assert.ok(persistedSummary);
    assert.equal(persistedSummary.summary.vo2_assessment.status, "estimated");
    assert.notEqual(storage.getItem(FORMAL_CALIBRATION_MACHINE_PROVENANCE_STORAGE_KEY), null);
  } finally {
    await resetWorkoutStorageForTests();
    globalThis.indexedDB = previousIndexedDb;
    globalThis.IDBKeyRange = previousKeyRange;
    globalThis.localStorage = previousStorage;
  }
});

test("ineligible promotion warns after saving the workout summary without creating FitnessState", async () => {
  const previousIndexedDb = globalThis.indexedDB;
  const previousKeyRange = globalThis.IDBKeyRange;
  const previousStorage = globalThis.localStorage;
  globalThis.indexedDB = indexedDB;
  globalThis.IDBKeyRange = IDBKeyRange;
  const fixture = assessmentFixture({
    sessionId: "fitness-not-eligible",
    endedAt: "2026-09-20T12:30:00.000Z",
  });
  fixture.summary.vo2_assessment.status = "insufficient_evidence";
  const storage = memoryStorage({
    [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(fixture.athlete),
  });
  globalThis.localStorage = storage;
  try {
    await resetWorkoutStorageForTests();
    const diagnostics = await captureConsoleDiagnostics(() => emitWorkoutSummary(fixture.summary));
    const storedSummary = (await getAllWorkoutSummaries()).find(
      (row) => row.summary.external_session_id === fixture.summary.external_session_id
    );
    assert.ok(storedSummary);
    assert.equal(storage.getItem(FITNESS_STATE_STORAGE_KEY), null);
    assert.equal(diagnostics.errors.length, 0);
    assert.deepEqual(diagnostics.warnings, [[
      "VO2 workout summary was saved, but formal FitnessState promotion was not eligible.",
      {
        external_session_id: fixture.summary.external_session_id,
        promotion_result: "not_eligible",
        assessment_estimator: {
          id: fixture.assessment.estimator_id,
          version: fixture.assessment.estimator_version,
        },
        assessment_protocol: {
          id: fixture.assessment.input_snapshot.protocol_id,
          version: fixture.assessment.input_snapshot.protocol_version,
        },
      },
    ]]);
  } finally {
    await resetWorkoutStorageForTests();
    globalThis.indexedDB = previousIndexedDb;
    globalThis.IDBKeyRange = previousKeyRange;
    globalThis.localStorage = previousStorage;
  }
});

test("ineligible promotion diagnostics tolerate a null assessment input snapshot", async () => {
  const previousIndexedDb = globalThis.indexedDB;
  const previousKeyRange = globalThis.IDBKeyRange;
  const previousStorage = globalThis.localStorage;
  globalThis.indexedDB = indexedDB;
  globalThis.IDBKeyRange = IDBKeyRange;
  const fixture = assessmentFixture({
    sessionId: "fitness-not-eligible-null-input-snapshot",
    endedAt: "2026-09-20T12:30:00.000Z",
  });
  fixture.summary.vo2_assessment.input_snapshot = null;
  const original = deepClone(fixture.summary);
  const storage = memoryStorage({
    [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(fixture.athlete),
  });
  globalThis.localStorage = storage;
  try {
    await resetWorkoutStorageForTests();
    let diagnostics;
    await assert.doesNotReject(async () => {
      diagnostics = await captureConsoleDiagnostics(() => emitWorkoutSummary(fixture.summary));
    });
    const storedSummary = (await getAllWorkoutSummaries()).find(
      (row) => row.summary.external_session_id === fixture.summary.external_session_id
    );
    assert.ok(storedSummary);
    assert.deepEqual(storedSummary.summary, original);
    assert.equal(storage.getItem(FITNESS_STATE_STORAGE_KEY), null);
    assert.deepEqual(diagnostics.errors, []);
    assert.deepEqual(diagnostics.warnings, [[
      "VO2 workout summary was saved, but formal FitnessState promotion was not eligible.",
      {
        external_session_id: fixture.summary.external_session_id,
        promotion_result: "not_eligible",
        assessment_estimator: {
          id: fixture.assessment.estimator_id,
          version: fixture.assessment.estimator_version,
        },
        assessment_protocol: {
          id: null,
          version: null,
        },
      },
    ]]);
  } finally {
    await resetWorkoutStorageForTests();
    globalThis.indexedDB = previousIndexedDb;
    globalThis.IDBKeyRange = previousKeyRange;
    globalThis.localStorage = previousStorage;
  }
});

test("real finalization promotes a new formal anchor and forces post-anchor passive requalification", async () => {
  const previousIndexedDb = globalThis.indexedDB;
  const previousKeyRange = globalThis.IDBKeyRange;
  globalThis.indexedDB = indexedDB;
  globalThis.IDBKeyRange = IDBKeyRange;
  await resetWorkoutStorageForTests();
  const previousStorage = globalThis.localStorage;
  const fixture = assessmentFixture({
    athleteId: "athlete-fitness",
    sessionId: "formal-anchor-session",
    endedAt: "2026-01-10T12:30:00.000Z",
  });
  const storage = memoryStorage({
    [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(fixture.athlete),
  });
  globalThis.localStorage = storage;
  try {
    const preAnchor = [1, 2, 3, 4].map((day) =>
      ordinaryFitnessSummary(`pre-anchor-${day}`, `2026-01-0${day}T12:10:00.000Z`, 195 + day)
    );
    for (const summary of preAnchor) assert.equal(await storeWorkoutSummary(summary), true);
    let history = await getAllWorkoutSummaries();
    assert.equal(rebuildStoredPassiveFitnessProjection(history.map((row) => row.summary), storage), "refined");
    assert.ok(readFitnessState("athlete-fitness", storage)?.passiveAerobicObservation);

    await emitWorkoutSummary(fixture.summary);
    const anchored = readFitnessState("athlete-fitness", storage);
    assert.ok(anchored);
    assert.equal(anchored.vo2Max.source, "formal_assessment");
    assert.equal(anchored.predictedMaxWatts.source, "formal_assessment");
    assert.equal(anchored.hrWorkloadCalibration.source, "formal_assessment");
    assert.equal(anchored.vo2Max.value, fixture.assessment.estimate_ml_kg_min);
    assert.equal(anchored.passiveAerobicObservation, undefined);
    assert.equal(anchored.passiveAerobicTrend, undefined);

    const postAnchor = [11, 12, 13, 14].map((day, index) =>
      ordinaryFitnessSummary(`post-anchor-${index + 1}`, `2026-01-${day}T12:10:00.000Z`, 205 + index)
    );
    assert.equal(await storeWorkoutSummary(postAnchor[0]), true);
    history = await getAllWorkoutSummaries();
    rebuildStoredPassiveFitnessProjection(history.map((row) => row.summary), storage);
    assert.equal(readFitnessState("athlete-fitness", storage).passiveAerobicObservation, undefined);

    for (const summary of postAnchor.slice(1)) assert.equal(await storeWorkoutSummary(summary), true);
    history = await getAllWorkoutSummaries();
    assert.equal(rebuildStoredPassiveFitnessProjection(history.map((row) => row.summary), storage), "refined");
    const rebuilt = readFitnessState("athlete-fitness", storage);
    assert.deepEqual(rebuilt.vo2Max, anchored.vo2Max);
    assert.deepEqual(rebuilt.predictedMaxWatts, anchored.predictedMaxWatts);
    assert.deepEqual(rebuilt.hrWorkloadCalibration, anchored.hrWorkloadCalibration);
    assert.equal(rebuilt.passiveAerobicObservation.source, "workout_observation");
    assert.equal(rebuilt.passiveAerobicObservation.value.formalAnchorSessionId, "formal-anchor-session");
    assert.equal(rebuilt.passiveAerobicObservation.evidence.sessionCount, 4);
  } finally {
    globalThis.localStorage = previousStorage;
    await resetWorkoutStorageForTests();
    globalThis.indexedDB = previousIndexedDb;
    globalThis.IDBKeyRange = previousKeyRange;
  }
});

test("stored promotion failure leaves an already-saved immutable workout summary intact", async () => {
  const previousIndexedDb = globalThis.indexedDB;
  const previousKeyRange = globalThis.IDBKeyRange;
  const previousStorage = globalThis.localStorage;
  globalThis.indexedDB = indexedDB;
  globalThis.IDBKeyRange = IDBKeyRange;
  const fixture = assessmentFixture({
    sessionId: "fitness-write-failure",
    endedAt: "2026-09-20T12:30:00.000Z",
  });
  const storage = memoryStorage(
    { [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(fixture.athlete) },
    FITNESS_STATE_STORAGE_KEY
  );
  globalThis.localStorage = storage;
  try {
    await resetWorkoutStorageForTests();
    const original = deepClone(fixture.summary);
    const diagnostics = await captureConsoleDiagnostics(() => emitWorkoutSummary(fixture.summary));
    const stored = (await getAllWorkoutSummaries()).find(
      (row) => row.summary.external_session_id === fixture.summary.external_session_id
    );
    assert.ok(stored);
    assert.deepEqual(stored.summary, original);
    assert.equal(storage.getItem(FITNESS_STATE_STORAGE_KEY), null);
    assert.equal(diagnostics.warnings.length, 0);
    assert.deepEqual(diagnostics.errors, [[
      "VO2 workout summary was saved, but formal FitnessState promotion could not be persisted.",
      {
        external_session_id: fixture.summary.external_session_id,
        promotion_result: "persistence_failed",
        assessment_estimator: {
          id: fixture.assessment.estimator_id,
          version: fixture.assessment.estimator_version,
        },
        assessment_protocol: {
          id: fixture.assessment.input_snapshot.protocol_id,
          version: fixture.assessment.input_snapshot.protocol_version,
        },
      },
    ]]);
    assert.equal(
      promoteVo2SummaryToStoredFitnessState(
        fixture.summary,
        storage,
        "2026-09-20T12:31:00.000Z"
      ),
      "persistence_failed"
    );
  } finally {
    await resetWorkoutStorageForTests();
    globalThis.indexedDB = previousIndexedDb;
    globalThis.IDBKeyRange = previousKeyRange;
    globalThis.localStorage = previousStorage;
  }
});

test("historical v1 assessments are re-verified with version-bound v1 semantics", () => {
  const v1Fixture = assessmentFixture({ contract: "v1" });
  const promoted = promote(v1Fixture);
  assert.ok(promoted, "v1 assessment should still promote");
  assert.equal(promoted.vo2Max.algorithm.version, 1);
  assert.equal(promoted.hrWorkloadCalibration.value.protocol.version, 1);
});

test("demographic changes after assessment do not invalidate historical evidence", () => {
  // Regression for: assessment @ weight A, age Y
  // Later: athlete changes to weight B, age Y+1
  // Same athleteId → assessment still promotes (immutable snapshot)
  const fixture = assessmentFixture();
  const assessedProfile = deepClone(fixture.athlete);
  assert.equal(assessedProfile.demographics.ageYears, 40);
  assert.equal(assessedProfile.demographics.bodyMassLbs, 80 / PROFILE_WEIGHT_LBS_TO_KG);

  // Promote with original profile - should succeed
  const originalState = promote(fixture, null, "2026-09-21T12:31:00.000Z");
  assert.ok(originalState, "assessment should promote with original demographics");

  // Simulate athlete's profile changes over time
  const updatedProfile = deepClone(fixture.athlete);
  updatedProfile.demographics.ageYears = 41; // aged a year
  updatedProfile.demographics.bodyMassLbs = 85 / PROFILE_WEIGHT_LBS_TO_KG; // gained weight
  updatedProfile.updatedAt = "2026-09-25T12:31:00.000Z";

  // Try to promote the same assessment with the new profile
  const laterState = promoteVo2AssessmentToFitnessState({
    currentState: originalState,
    athleteProfile: updatedProfile,
    workoutSummary: fixture.summary,
    assessment: fixture.assessment,
    updatedAt: "2026-09-25T12:35:00.000Z",
  });

  // Should still fail because it's not newer than the original
  assert.equal(laterState, null, "cannot promote same assessment twice");

  // But test that the assessment WOULD promote if not for the timing issue
  const hypotheticalPromotion = promoteVo2AssessmentToFitnessState({
    currentState: null,
    athleteProfile: updatedProfile,
    workoutSummary: fixture.summary,
    assessment: fixture.assessment,
    updatedAt: "2026-09-25T12:35:00.000Z",
  });

  assert.ok(
    hypotheticalPromotion,
    "assessment snapshot is immutable and independent of current demographic changes"
  );
  assert.equal(hypotheticalPromotion.vo2Max.value, fixture.assessment.estimate_ml_kg_min);
  assert.deepEqual(hypotheticalPromotion.hrWorkloadCalibration.value.profileInputSnapshot, {
    ageYears: 40,
    bodyMassKg: 80,
  });
});

test("unsupported estimator and protocol versions are rejected", () => {
  const fixture = assessmentFixture();

  // Unsupported estimator version
  const unsupportedEstimator = deepClone(fixture);
  unsupportedEstimator.assessment.estimator_version = 99;
  assert.equal(promote(unsupportedEstimator), null, "unknown estimator should be rejected");

  // Cross-paired historical protocol in input snapshot
  const unsupportedProtocolSnapshot = deepClone(fixture);
  unsupportedProtocolSnapshot.assessment.input_snapshot.protocol_version = 1;
  assert.equal(promote(unsupportedProtocolSnapshot), null, "v2 estimator plus v1 protocol should be rejected");

  // Cross-paired historical protocol in observed evidence
  const unsupportedProtocolObserved = deepClone(fixture);
  unsupportedProtocolObserved.summary.vo2_evidence.protocol.protocol_version = 1;
  assert.equal(promote(unsupportedProtocolObserved), null, "v1 protocol in v2 evidence should be rejected");

  // Cross-paired historical protocol in diagnostics expected
  const unsupportedExpected = deepClone(fixture);
  unsupportedExpected.assessment.diagnostics.expected_protocol_version = 1;
  assert.equal(promote(unsupportedExpected), null, "v1 protocol in v2 diagnostics should be rejected");

  // Cross-paired historical protocol in diagnostics observed
  const unsupportedObservedDiagnostics = deepClone(fixture);
  unsupportedObservedDiagnostics.assessment.diagnostics.observed_protocol_version = 1;
  assert.equal(promote(unsupportedObservedDiagnostics), null, "v1 observed protocol should be rejected");

  const estimatorV1ProtocolV3 = assessmentFixture({ protocolVersion: VO2_PROTOCOL_VERSION_V3 });
  estimatorV1ProtocolV3.assessment.estimator_version = 1;
  assert.equal(promote(estimatorV1ProtocolV3), null, "v1 estimator plus v3 protocol should be rejected");

  const unknownEstimatorProtocolV3 = assessmentFixture({ protocolVersion: VO2_PROTOCOL_VERSION_V3 });
  unknownEstimatorProtocolV3.assessment.estimator_id = "unknown-estimator";
  assert.equal(promote(unknownEstimatorProtocolV3), null, "unknown estimator plus v3 protocol should be rejected");

  const protocolV3State = promote(assessmentFixture({ protocolVersion: VO2_PROTOCOL_VERSION_V3 }));
  assert.ok(protocolV3State);
  const futureProtocolState = deepClone(protocolV3State);
  futureProtocolState.hrWorkloadCalibration.value.protocol.version = 999;
  assert.equal(parseFitnessState(futureProtocolState), null, "future formal protocols should fail closed on readback");
});
