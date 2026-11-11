import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { readFileSync } from "node:fs";

import {
  PHASE_E1_SHADOW_POLICY,
  PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES,
  assessmentBasedWorkloadForPhase,
  evaluatePersonalizedPrescription,
  parsePersonalizedPrescriptionEvaluation,
} from "../dist/personalizedPrescription.js";
import {
  personalizationShadowPrescriptionEnabledForIntensity,
  personalizationShadowPrescriptionEnabledForIntent,
} from "../dist/personalizationCapability.js";
import {
  machineHeartRateTargetFromResolved,
  resolveWorkoutPrescription,
} from "../dist/workoutPrescription.js";
import { createMachineGuidanceState } from "../dist/machines/guidance.js";
import { getProFormSmartPower10Guidance } from "../dist/machines/proformSmartPower10.js";
import { getSession, startSession } from "../dist/sessionStore.js";
import { generateWorkoutSummary } from "../dist/workoutSummary.js";
import {
  getAllWorkoutSummaries,
  resetWorkoutStorageForTests,
  storeWorkoutSummary,
} from "../dist/workoutStorage.js";
import { captureWorkoutStartContext } from "../dist/workoutLogic.js";
import { parseWorkoutTemplateDocument } from "../dist/workoutTemplate.js";
import { transformWorkoutData } from "../dist/workoutData.js";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const KG_PER_LB = 0.45359237;
const RESOLVED_AT = "2026-06-01T12:00:00.000Z";
const rawWorkoutData = JSON.parse(readFileSync(new URL("../data.json", import.meta.url), "utf8"));

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function profile(overrides = {}) {
  return {
    schemaVersion: 1,
    athleteId: "athlete-e1",
    demographics: { ageYears: 40, bodyMassLbs: 80 / KG_PER_LB, heightInches: 70, sex: "female" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function calibrationState(overrides = {}) {
  const calibrationOverrides = overrides.calibration ?? {};
  const metricOverrides = overrides.metric ?? {};
  const stateOverrides = overrides.state ?? {};
  return {
    schemaVersion: 1,
    athleteId: "athlete-e1",
    hrWorkloadCalibration: {
      value: {
        slopeBpmPerWatt: 0.5,
        interceptBpm: 60,
        rSquared: 1,
        observedMinWatts: 100,
        observedMaxWatts: 200,
        points: [
          { stageId: "stage-1", watts: 100, heartRateBpm: 110, workloadSource: "measured_watts" },
          { stageId: "stage-2", watts: 150, heartRateBpm: 135, workloadSource: "measured_watts" },
          { stageId: "stage-3", watts: 200, heartRateBpm: 160, workloadSource: "measured_watts" },
        ],
        protocol: { id: "bike-submax-70rpm", version: 1 },
        predictedHrMaxBpm: 180,
        predictedHrMaxSource: "demographic_estimate",
        profileInputSnapshot: { ageYears: 40, bodyMassKg: 80 },
        ...calibrationOverrides,
      },
      source: "formal_assessment",
      quality: "high",
      observedAt: "2026-01-01T00:30:00.000Z",
      updatedAt: "2026-01-01T00:31:00.000Z",
      algorithm: { id: "bike-submax-linear-hr-workload", version: 1 },
      evidenceSessionIds: ["formal-e1"],
      ...metricOverrides,
    },
    updatedAt: "2026-01-01T00:31:00.000Z",
    ...stateOverrides,
  };
}

function calibrationStateV2(overrides = {}) {
  const state = calibrationState({
    state: { schemaVersion: 3 },
    metric: { algorithm: { id: "bike-submax-linear-hr-workload", version: 2 } },
    calibration: { protocol: { id: "bike-submax-70rpm", version: 2 } },
  });
  return {
    ...state,
    ...(overrides.state ?? {}),
    hrWorkloadCalibration: {
      ...state.hrWorkloadCalibration,
      ...(overrides.metric ?? {}),
      value: {
        ...state.hrWorkloadCalibration.value,
        ...(overrides.calibration ?? {}),
      },
    },
  };
}

function policy(expiryDays = 365) {
  return {
    assessmentExpiryDays: expiryDays,
    assessmentExpiryPolicy: "provisional_characterization",
    allowedIntensities: ["aerobic_base", "threshold"],
    roundingRule: "nearest_integer_watt",
    extrapolationPolicy: "none",
  };
}

function steadyPrescription({ target = "115–130", intensity = "aerobic_base", kind = "work", selector = "Tuesday" } = {}) {
  return resolveWorkoutPrescription({
    workoutSelector: selector,
    blocks: { warm: 0, sustain: 60, cool: 0 },
    hrTargets: {
      main_set: target,
      main_set_intensity_id: intensity,
      main_set_kind: kind,
      intervals: null,
    },
    resolvedAt: RESOLVED_AT,
  });
}

function input(overrides = {}) {
  return {
    legacyPrescription: steadyPrescription(),
    workoutIntent: "aerobic_base",
    activity: "bike",
    athleteId: "athlete-e1",
    profile: profile(),
    fitnessState: calibrationState(),
    policy: policy(),
    resolvedAt: RESOLVED_AT,
    ...overrides,
  };
}

function onlyPhase(evaluation) {
  assert.equal(evaluation.phases.length, 1);
  return evaluation.phases[0];
}

function fallbackReason(overrides = {}) {
  return onlyPhase(evaluatePersonalizedPrescription(input(overrides))).fallbackReason;
}

test("frozen E1 workload advice projects only exact candidate phases", () => {
  const evaluation = evaluatePersonalizedPrescription(input());
  evaluation.phases = [
    {
      ...evaluation.phases[0],
      phaseId: "sustain",
      outcome: "candidate",
      candidatePower: { minWatts: 138, maxWatts: 151 },
    },
    {
      ...evaluation.phases[0],
      phaseId: "cooldown",
      outcome: "fallback",
      fallbackReason: "unsupported_phase",
      candidatePower: undefined,
    },
  ];

  assert.deepEqual(
    assessmentBasedWorkloadForPhase(evaluation, "sustain"),
    { minWatts: 138, maxWatts: 151 }
  );
  assert.equal(assessmentBasedWorkloadForPhase(evaluation, "cooldown"), null);
  assert.equal(assessmentBasedWorkloadForPhase(evaluation, "warmup"), null);
  assert.equal(assessmentBasedWorkloadForPhase(null, "sustain"), null);
});

test("frozen E1 workload advice uses exact repeated-interval phase identity", () => {
  const evaluation = evaluatePersonalizedPrescription(input());
  evaluation.phases = [
    {
      ...evaluation.phases[0],
      phaseId: "cycle:0:0",
      candidatePower: { minWatts: 138, maxWatts: 151 },
      outcome: "candidate",
    },
    {
      ...evaluation.phases[0],
      phaseId: "cycle:1:0",
      candidatePower: { minWatts: 145, maxWatts: 159 },
      outcome: "candidate",
    },
  ];

  assert.deepEqual(
    assessmentBasedWorkloadForPhase(evaluation, "cycle:0:0"),
    { minWatts: 138, maxWatts: 151 }
  );
  assert.deepEqual(
    assessmentBasedWorkloadForPhase(evaluation, "cycle:1:0"),
    { minWatts: 145, maxWatts: 159 }
  );
});

test("frozen E1 workload advice never infers or accepts invalid candidate power", () => {
  const evaluation = evaluatePersonalizedPrescription(input());
  const noCandidate = structuredClone(evaluation);
  delete noCandidate.phases[0].candidatePower;
  assert.equal(assessmentBasedWorkloadForPhase(noCandidate, "sustain"), null);

  for (const candidatePower of [
    { minWatts: 0, maxWatts: 151 },
    { minWatts: 152, maxWatts: 151 },
    { minWatts: 138.5, maxWatts: 151 },
  ]) {
    const invalid = structuredClone(evaluation);
    invalid.phases[0].candidatePower = candidatePower;
    assert.equal(assessmentBasedWorkloadForPhase(invalid, "sustain"), null);
  }
});

test("pure E1 resolver deterministically interpolates aerobic-base power and freezes exact evidence", () => {
  const first = evaluatePersonalizedPrescription(input());
  assert.deepEqual(evaluatePersonalizedPrescription(input()), first);
  assert.equal(first.activationEligible, false);
  assert.deepEqual(first.policy, policy());
  assert.equal(first.profileInputSnapshot.bodyMassKg, 80);
  assert.deepEqual(first.fitnessEvidenceSnapshot.calibration.points, calibrationState().hrWorkloadCalibration.value.points);
  const phase = onlyPhase(first);
  assert.equal(phase.outcome, "candidate");
  assert.deepEqual(phase.activeHeartRate, { min: 115, max: 130 });
  assert.deepEqual(phase.candidatePower, { minWatts: 110, maxWatts: 140 });
  assert.equal(phase.safetyChecks.freshnessValid, true);
});

test("E1 admits approved v1 and v2 formal provenance in shadow mode and rejects cross-pairs", () => {
  const historical = evaluatePersonalizedPrescription(input({ fitnessState: calibrationState() }));
  const current = evaluatePersonalizedPrescription(input({ fitnessState: calibrationStateV2() }));
  for (const evaluation of [historical, current]) {
    assert.equal(evaluation.mode, "shadow");
    assert.equal(evaluation.activationEligible, false);
    assert.equal(onlyPhase(evaluation).outcome, "candidate");
    assert.deepEqual(parsePersonalizedPrescriptionEvaluation(structuredClone(evaluation)), evaluation);
  }
  assert.equal(historical.fitnessEvidenceSnapshot.algorithm.version, 1);
  assert.equal(historical.fitnessEvidenceSnapshot.calibration.protocol.version, 1);
  assert.equal(current.fitnessEvidenceSnapshot.algorithm.version, 2);
  assert.equal(current.fitnessEvidenceSnapshot.calibration.protocol.version, 2);

  const estimatorV2ProtocolV1 = calibrationStateV2({
    calibration: { protocol: { id: "bike-submax-70rpm", version: 1 } },
  });
  const estimatorV1ProtocolV2 = calibrationState({
    state: { schemaVersion: 3 },
    calibration: { protocol: { id: "bike-submax-70rpm", version: 2 } },
  });
  assert.equal(fallbackReason({ fitnessState: estimatorV2ProtocolV1 }), "unsupported_protocol");
  assert.equal(fallbackReason({ fitnessState: estimatorV1ProtocolV2 }), "unsupported_protocol");
});

test("pure resolver has no storage or current-time dependency", () => {
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("pure resolver touched storage"); },
  });
  try {
    assert.deepEqual(evaluatePersonalizedPrescription(input()), evaluatePersonalizedPrescription(input()));
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: previous });
  }
});

test("rounding is deterministic and observed-domain equality is allowed", () => {
  const roundedState = calibrationState({ calibration: {
    slopeBpmPerWatt: 0.6,
    interceptBpm: 50,
    points: [
      { stageId: "stage-1", watts: 100, heartRateBpm: 110, workloadSource: "measured_watts" },
      { stageId: "stage-2", watts: 150, heartRateBpm: 140, workloadSource: "measured_watts" },
      { stageId: "stage-3", watts: 200, heartRateBpm: 170, workloadSource: "measured_watts" },
    ],
  } });
  const rounded = onlyPhase(evaluatePersonalizedPrescription(input({ fitnessState: roundedState })));
  assert.deepEqual(rounded.candidatePower, { minWatts: 108, maxWatts: 133 });
  const boundary = onlyPhase(evaluatePersonalizedPrescription(input({
    legacyPrescription: steadyPrescription({ target: "110–160" }),
  })));
  assert.deepEqual(boundary.candidatePower, { minWatts: 100, maxWatts: 200 });
});

test("any HR or workload extrapolation fails closed instead of clamping", () => {
  assert.equal(fallbackReason({ legacyPrescription: steadyPrescription({ target: "109–130" }) }), "outside_observed_hr_range");
  assert.equal(fallbackReason({ legacyPrescription: steadyPrescription({ target: "115–161" }) }), "outside_observed_hr_range");
  assert.equal(fallbackReason({ fitnessState: calibrationState({ calibration: { slopeBpmPerWatt: 0.2, interceptBpm: 80 } }) }), "outside_observed_workload_range");
});

test("invalid calibration math, insufficient points, algorithms, protocols, and quality use distinct fallbacks", () => {
  assert.equal(fallbackReason({ fitnessState: calibrationState({ calibration: { slopeBpmPerWatt: 0 } }) }), "invalid_calibration");
  assert.equal(fallbackReason({ fitnessState: calibrationState({ calibration: { slopeBpmPerWatt: -1 } }) }), "invalid_calibration");
  assert.equal(fallbackReason({ fitnessState: calibrationState({ calibration: { interceptBpm: Number.NaN } }) }), "invalid_calibration");
  assert.equal(fallbackReason({ fitnessState: calibrationState({ calibration: {
    observedMaxWatts: 150,
    points: [
      { stageId: "stage-1", watts: 100, heartRateBpm: 110, workloadSource: "measured_watts" },
      { stageId: "stage-2", watts: 150, heartRateBpm: 135, workloadSource: "measured_watts" },
    ],
  } }) }), "insufficient_calibration_points");
  assert.equal(fallbackReason({ fitnessState: calibrationState({ metric: { algorithm: { id: "future-estimator", version: 1 } } }) }), "unsupported_algorithm");
  assert.equal(fallbackReason({ fitnessState: calibrationState({ calibration: { protocol: { id: "future-protocol", version: 1 } } }) }), "unsupported_protocol");
  assert.equal(fallbackReason({ fitnessState: calibrationState({ metric: { quality: "low" } }) }), "low_quality_calibration");
});

test("missing, unsupported, unowned, stale, mismatched, and mixed evidence fail closed", () => {
  assert.equal(fallbackReason({ profile: null }), "missing_profile");
  assert.equal(fallbackReason({ fitnessState: null }), "missing_fitness_state");
  assert.equal(fallbackReason({ fitnessState: { schemaVersion: 99, athleteId: "athlete-e1" } }), "unsupported_fitness_schema");
  assert.equal(fallbackReason({ fitnessState: calibrationState({ state: { athleteId: "athlete-other" } }) }), "athlete_mismatch");
  assert.equal(fallbackReason({ profile: profile({ athleteId: "athlete-other" }) }), "athlete_mismatch");
  assert.equal(fallbackReason({ profile: profile({ demographics: { ageYears: 41, bodyMassLbs: 80 / KG_PER_LB } }) }), "profile_input_mismatch");
  assert.equal(fallbackReason({ resolvedAt: "2028-01-02T00:00:00.000Z", policy: policy(365) }), "assessment_stale");
  const mixed = calibrationState({ calibration: { points: [
    { stageId: "stage-1", watts: 100, heartRateBpm: 110, workloadSource: "measured_watts" },
    { stageId: "stage-2", watts: 150, heartRateBpm: 135, workloadSource: "calibrated_at_verified_cadence" },
    { stageId: "stage-3", watts: 200, heartRateBpm: 160, workloadSource: "measured_watts" },
  ] } });
  assert.equal(fallbackReason({ fitnessState: mixed }), "mixed_or_unknown_workload_provenance");
  assert.equal(fallbackReason({ fitnessState: calibrationState({ metric: { source: "workout_observation" } }) }), "unsupported_calibration_source");
  assert.equal(fallbackReason({ legacyPrescription: resolveWorkoutPrescription({
    workoutSelector: "Tuesday", blocks: { warm: 0, sustain: 60, cool: 0 },
    hrTargets: { main_set_intensity_id: "aerobic_base", main_set_kind: "work", intervals: null },
    resolvedAt: RESOLVED_AT,
  }) }), "missing_numeric_hr_target");
});

test("uniform cadence-calibrated formal points retain distinct provenance in shadow mode", () => {
  const calibrated = calibrationState({ metric: { quality: "moderate" }, calibration: { points: [
    { stageId: "stage-1", watts: 100, heartRateBpm: 110, workloadSource: "calibrated_at_verified_cadence" },
    { stageId: "stage-2", watts: 150, heartRateBpm: 135, workloadSource: "calibrated_at_verified_cadence" },
    { stageId: "stage-3", watts: 200, heartRateBpm: 160, workloadSource: "calibrated_at_verified_cadence" },
  ] } });
  const evaluation = evaluatePersonalizedPrescription(input({ fitnessState: calibrated }));
  assert.equal(onlyPhase(evaluation).outcome, "candidate");
  assert.equal(
    evaluation.fitnessEvidenceSnapshot.calibration.workloadProvenance,
    "calibrated_at_verified_cadence"
  );
});

test("manual VO2, passive observation, and predicted-max-only state cannot create candidates", () => {
  const userVo2 = profile({ userEnteredVo2: {
    value: 70, source: "user_entered", quality: "unverified",
    observedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  } });
  assert.equal(fallbackReason({ profile: userVo2, fitnessState: null }), "missing_fitness_state");
  assert.equal(fallbackReason({ fitnessState: {
    schemaVersion: 3, athleteId: "athlete-e1",
    passiveAerobicObservation: { value: { eligibleForPrescription: false } },
    updatedAt: "2026-01-01T00:00:00.000Z",
  } }), "missing_formal_calibration");
  assert.equal(fallbackReason({ fitnessState: {
    schemaVersion: 1, athleteId: "athlete-e1", predictedMaxWatts: { value: 500 },
    updatedAt: "2026-01-01T00:00:00.000Z",
  } }), "missing_formal_calibration");
});

test("phase semantics, activity, and standalone workout gates are explicit", () => {
  assert.equal(fallbackReason({ activity: "elliptical" }), "unsupported_activity");
  assert.equal(fallbackReason({ legacyPrescription: steadyPrescription({ kind: "warmup", intensity: "aerobic_base" }) }), "unsupported_phase");
  assert.equal(fallbackReason({ legacyPrescription: steadyPrescription({ kind: "warmup", intensity: "threshold" }) }), "unsupported_phase");
  assert.equal(fallbackReason({ legacyPrescription: steadyPrescription({ kind: "recovery", intensity: "aerobic_base" }) }), "unsupported_phase");
  assert.equal(fallbackReason({ legacyPrescription: steadyPrescription({ kind: "cooldown", intensity: "threshold" }) }), "unsupported_phase");
  assert.equal(fallbackReason({ legacyPrescription: steadyPrescription({ intensity: "warmup_easy" }) }), "unsupported_phase");
  assert.equal(fallbackReason({ legacyPrescription: steadyPrescription({ intensity: "recovery" }) }), "unsupported_phase");
  assert.equal(fallbackReason({ legacyPrescription: steadyPrescription({ intensity: "cooldown" }) }), "unsupported_phase");
  assert.equal(fallbackReason({ legacyPrescription: steadyPrescription({ intensity: "strength_support" }) }), "unsupported_phase");
  assert.equal(fallbackReason({ legacyPrescription: steadyPrescription({ intensity: "vo2_short" }) }), "unsupported_phase");
  assert.equal(fallbackReason({ legacyPrescription: steadyPrescription({ intensity: "vo2_long" }) }), "unsupported_phase");
  assert.equal(fallbackReason({ legacyPrescription: steadyPrescription({ selector: "VO2MaxEstimation" }) }), "unsupported_workout");
});

test("E1 runtime intensity eligibility follows personalization shadow capabilities", () => {
  assert.deepEqual(PHASE_E1_SHADOW_POLICY.allowedIntensities, PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("aerobic_base"), true);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("threshold"), true);
  assert.equal(onlyPhase(evaluatePersonalizedPrescription(input())).outcome, "candidate");
  assert.equal(onlyPhase(evaluatePersonalizedPrescription(input({
    workoutIntent: "threshold",
    legacyPrescription: steadyPrescription({ target: "150–160", intensity: "threshold" }),
  }))).outcome, "candidate");
  assert.equal(fallbackReason({
    legacyPrescription: steadyPrescription({ intensity: "vo2_short" }),
  }), "unsupported_phase");
});

test("E1 runtime intent eligibility follows personalization intent capabilities", () => {
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("aerobic_base"), true);
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("aerobic_volume"), true);
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("threshold"), true);
  assert.equal(onlyPhase(evaluatePersonalizedPrescription(input({ workoutIntent: "aerobic_base" }))).outcome, "candidate");
  assert.equal(onlyPhase(evaluatePersonalizedPrescription(input({ workoutIntent: "aerobic_volume" }))).outcome, "candidate");
  assert.equal(onlyPhase(evaluatePersonalizedPrescription(input({
    workoutIntent: "threshold",
    legacyPrescription: steadyPrescription({ target: "150–160", intensity: "threshold" }),
  }))).outcome, "candidate");

  assert.equal(fallbackReason({ workoutIntent: "recovery" }), "unsupported_workout");
  assert.equal(fallbackReason({ workoutIntent: "vo2_primer" }), "unsupported_workout");
  assert.equal(fallbackReason({ workoutIntent: "vo2_priority" }), "unsupported_workout");
  assert.equal(fallbackReason({ workoutIntent: "support_strength" }), "unsupported_workout");
  assert.equal(fallbackReason({ workoutIntent: "" }), "unsupported_workout");
  assert.equal(fallbackReason({ workoutIntent: "unknown_intent" }), "unsupported_workout");

  // Intent and intensity are independent gates (intensity checked before intent).
  assert.equal(fallbackReason({
    workoutIntent: "aerobic_base",
    legacyPrescription: steadyPrescription({ intensity: "vo2_short" }),
  }), "unsupported_phase");
  assert.equal(fallbackReason({
    workoutIntent: "recovery",
    legacyPrescription: steadyPrescription({ intensity: "aerobic_base" }),
  }), "unsupported_workout");
  assert.equal(fallbackReason({
    workoutIntent: "aerobic_base",
    legacyPrescription: steadyPrescription({ selector: "VO2MaxEstimation" }),
  }), "unsupported_workout");
});

test("aerobic-volume and fully interpolated threshold work can produce shadow candidates", () => {
  assert.equal(onlyPhase(evaluatePersonalizedPrescription(input({ workoutIntent: "aerobic_volume" }))).outcome, "candidate");
  const threshold = onlyPhase(evaluatePersonalizedPrescription(input({
    workoutIntent: "threshold",
    legacyPrescription: steadyPrescription({ target: "150–160", intensity: "threshold" }),
  })));
  assert.deepEqual(threshold.candidatePower, { minWatts: 180, maxWatts: 200 });
  assert.equal(fallbackReason({
    workoutIntent: "threshold",
    legacyPrescription: steadyPrescription({ target: "155–162", intensity: "threshold" }),
  }), "outside_observed_hr_range");
});

test("unapproved production policy records freshness as not evaluated but remains shadow-only", () => {
  const evaluation = evaluatePersonalizedPrescription(input({ policy: PHASE_E1_SHADOW_POLICY }));
  assert.equal(onlyPhase(evaluation).outcome, "candidate");
  assert.equal(onlyPhase(evaluation).safetyChecks.freshnessValid, null);
  assert.equal(evaluation.activationEligible, false);
});

test("permanent reader round-trips valid E1 and rejects malformed or future records", () => {
  const evaluation = evaluatePersonalizedPrescription(input());
  assert.deepEqual(parsePersonalizedPrescriptionEvaluation(structuredClone(evaluation)), evaluation);
  assert.deepEqual(evaluation.policy.allowedIntensities, PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES);
  const future = structuredClone(evaluation);
  future.schemaVersion = 2;
  assert.equal(parsePersonalizedPrescriptionEvaluation(future), null);
  const forgedPower = structuredClone(evaluation);
  forgedPower.phases[0].candidatePower.minWatts += 20;
  assert.equal(parsePersonalizedPrescriptionEvaluation(forgedPower), null);
  const active = structuredClone(evaluation);
  active.activationEligible = true;
  assert.equal(parsePersonalizedPrescriptionEvaluation(active), null);
  const malformedPolicy = structuredClone(evaluation);
  malformedPolicy.policy.extrapolationPolicy = "clamp";
  assert.equal(parsePersonalizedPrescriptionEvaluation(malformedPolicy), null);
});

test("permanent reader validates schema-v1 allowedIntensities against immutable v1 contract", () => {
  assert.deepEqual(PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES, ["aerobic_base", "threshold"]);
  const evaluation = evaluatePersonalizedPrescription(input());
  assert.deepEqual(parsePersonalizedPrescriptionEvaluation(structuredClone(evaluation)), evaluation);

  for (const allowedIntensities of [
    ["threshold", "aerobic_base"],
    ["aerobic_base"],
    ["aerobic_base", "threshold", "vo2_short"],
    ["aerobic_base", "vo2_short"],
    [],
    undefined,
  ]) {
    const malformed = structuredClone(evaluation);
    malformed.policy.allowedIntensities = allowedIntensities;
    assert.equal(parsePersonalizedPrescriptionEvaluation(malformed), null);
  }
});

test("E1 v1 allowedIntensities schema is frozen and not aliased by policy or parser", () => {
  assert.ok(Object.isFrozen(PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES));
  assert.deepEqual(PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES, ["aerobic_base", "threshold"]);
  assert.throws(() => {
    PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES[0] = "vo2_short";
  }, TypeError);
  assert.deepEqual(PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES, ["aerobic_base", "threshold"]);

  assert.deepEqual(PHASE_E1_SHADOW_POLICY.allowedIntensities, PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES);
  assert.notEqual(PHASE_E1_SHADOW_POLICY.allowedIntensities, PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES);

  const parsed = parsePersonalizedPrescriptionEvaluation(
    structuredClone(evaluatePersonalizedPrescription(input()))
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.policy.allowedIntensities, PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES);
  assert.notEqual(parsed.policy.allowedIntensities, PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES);
  assert.notEqual(parsed.policy.allowedIntensities, PHASE_E1_SHADOW_POLICY.allowedIntensities);
});

test("session parsing drops malformed/future shadow records without invalidating legacy prescription", () => {
  const legacy = steadyPrescription();
  const shadow = evaluatePersonalizedPrescription(input({ legacyPrescription: legacy }));
  const snapshot = { blocks: { warm: 0, sustain: 60, cool: 0 }, hrTargets: null, resolvedPrescription: legacy, shadowPrescriptionEvaluation: shadow };
  const storage = memoryStorage();
  startSession("Tuesday", 1000, "e1-roundtrip", "bike", storage, snapshot, {
    athleteId: "athlete-e1", profileSchemaVersion: 1, fitnessStateSchemaVersion: 1, fitnessUpdatedAt: calibrationState().updatedAt,
  });
  assert.deepEqual(getSession("Tuesday", storage).phasePlan.shadowPrescriptionEvaluation, shadow);
  for (const mutation of [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.phases[0].candidatePower.maxWatts = Number.NaN; },
  ]) {
    const invalid = structuredClone(shadow);
    mutation(invalid);
    const invalidStorage = memoryStorage({ phase_plan_Tuesday: JSON.stringify({ ...snapshot, shadowPrescriptionEvaluation: invalid }) });
    const restored = getSession("Tuesday", invalidStorage);
    assert.deepEqual(restored.phasePlan.resolvedPrescription, legacy);
    assert.equal(restored.phasePlan.shadowPrescriptionEvaluation, undefined);
  }
});

test("summary copies the frozen shadow record and does not recompute current evidence", async () => {
  await resetWorkoutStorageForTests();
  const legacy = steadyPrescription();
  const shadow = evaluatePersonalizedPrescription(input({ legacyPrescription: legacy }));
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  globalThis.window = { getWorkoutMetadata: () => ({ Tuesday: { intent: "aerobic_base", activities: ["bike"] } }) };
  const startedAt = Date.now() - 10_000;
  startSession("Tuesday", startedAt, "e1-summary", "bike", storage, {
    blocks: { warm: 0, sustain: 60, cool: 0 }, hrTargets: null,
    resolvedPrescription: legacy, shadowPrescriptionEvaluation: shadow,
  }, { athleteId: "athlete-e1", profileSchemaVersion: 1, fitnessStateSchemaVersion: 1, fitnessUpdatedAt: calibrationState().updatedAt });
  storage.setItem("fitness_state_v1", JSON.stringify(calibrationState({ calibration: { interceptBpm: 5 } })));
  const summary = await generateWorkoutSummary("e1-summary", startedAt, Date.now(), "Tuesday");
  assert.deepEqual(summary.shadow_prescription_evaluation, shadow);
  assert.deepEqual(summary.resolved_prescription, legacy);
});

test("summary history accepts missing shadow data and drops malformed or future shadow data independently", async () => {
  await resetWorkoutStorageForTests();
  const base = {
    athlete_id: "athlete-e1",
    startedAt: "2026-06-01T12:00:00.000Z",
    endedAt: "2026-06-01T13:00:00.000Z",
    category: "cardio",
    intent: "aerobic_base",
    duration_minutes: 60,
    primary_zone: 2,
    stress_profile: "low",
    zone_minutes: { z1: 0, z2: 60, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Tuesday",
  };
  assert.equal(await storeWorkoutSummary({ ...base, external_session_id: "old-no-shadow" }), true);
  const future = evaluatePersonalizedPrescription(input());
  future.schemaVersion = 2;
  assert.equal(await storeWorkoutSummary({
    ...base,
    external_session_id: "future-shadow",
    shadow_prescription_evaluation: future,
  }), true);
  const history = await getAllWorkoutSummaries();
  assert.equal(history.find((row) => row.summary.external_session_id === "old-no-shadow").summary.shadow_prescription_evaluation, undefined);
  assert.equal(history.find((row) => row.summary.external_session_id === "future-shadow").summary.shadow_prescription_evaluation, undefined);
});

test("workout-start capture freezes shadow once; resume keeps it and a new start can capture newer evidence", () => {
  transformWorkoutData(parseWorkoutTemplateDocument(rawWorkoutData), new Date("2026-06-01T12:00:00.000Z").getTime());
  const storage = memoryStorage({
    athlete_profile_v1: JSON.stringify(profile()),
    athlete_identity_v1: JSON.stringify({
      schemaVersion: 1,
      athleteId: "athlete-e1",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    fitness_state_v1: JSON.stringify(calibrationState()),
  });
  const captured = captureWorkoutStartContext("Tuesday", "bike", RESOLVED_AT, storage);
  const capturedWork = captured.phasePlan.shadowPrescriptionEvaluation.phases.find((phase) => phase.phaseId === "sustain");
  assert.deepEqual(capturedWork.candidatePower, { minWatts: 110, maxWatts: 140 });
  startSession("Tuesday", Date.parse(RESOLVED_AT), "e1-start-capture", "bike", storage,
    captured.phasePlan, captured.athleteFitnessSnapshot);

  const newer = calibrationState({ calibration: {
    slopeBpmPerWatt: 0.25, interceptBpm: 85, observedMinWatts: 100, observedMaxWatts: 300,
    points: [
      { stageId: "stage-1", watts: 100, heartRateBpm: 110, workloadSource: "measured_watts" },
      { stageId: "stage-2", watts: 200, heartRateBpm: 135, workloadSource: "measured_watts" },
      { stageId: "stage-3", watts: 300, heartRateBpm: 160, workloadSource: "measured_watts" },
    ],
  } });
  storage.setItem("fitness_state_v1", JSON.stringify(newer));
  const resumed = getSession("Tuesday", storage);
  assert.deepEqual(
    resumed.phasePlan.shadowPrescriptionEvaluation,
    captured.phasePlan.shadowPrescriptionEvaluation
  );
  const nextStart = captureWorkoutStartContext("Tuesday", "bike", "2026-06-02T12:00:00.000Z", storage);
  const nextWork = nextStart.phasePlan.shadowPrescriptionEvaluation.phases.find((phase) => phase.phaseId === "sustain");
  assert.deepEqual(nextWork.candidatePower, { minWatts: 120, maxWatts: 180 });
  assert.deepEqual(
    nextStart.phasePlan.resolvedPrescription.phases.find((phase) => phase.phaseId === "sustain").expectedHeartRate,
    { min: 115, max: 130 }
  );
});

test("different shadow calibration has zero authority over active HR or ProForm resistance behavior", () => {
  const legacy = steadyPrescription();
  const first = evaluatePersonalizedPrescription(input({ legacyPrescription: legacy }));
  const secondState = calibrationState({ calibration: {
    slopeBpmPerWatt: 0.25, interceptBpm: 85, observedMinWatts: 100, observedMaxWatts: 300,
    points: [
      { stageId: "stage-1", watts: 100, heartRateBpm: 110, workloadSource: "measured_watts" },
      { stageId: "stage-2", watts: 200, heartRateBpm: 135, workloadSource: "measured_watts" },
      { stageId: "stage-3", watts: 300, heartRateBpm: 160, workloadSource: "measured_watts" },
    ],
  } });
  const second = evaluatePersonalizedPrescription(input({ legacyPrescription: legacy, fitnessState: secondState }));
  assert.notDeepEqual(onlyPhase(first).candidatePower, onlyPhase(second).candidatePower);
  assert.deepEqual(first.phases[0].activeHeartRate, second.phases[0].activeHeartRate);
  assert.deepEqual(legacy, steadyPrescription());
  const machineTarget = machineHeartRateTargetFromResolved(legacy.phases[0]);
  assert.deepEqual(machineTarget, { targetHeartRateMin: 115, targetHeartRateMax: 130 });
  const controllerInput = {
    machineId: "proform-smart-power-10", activity: "bike", phaseKind: "work", phaseId: "sustain",
    phaseElapsedSeconds: 90, phaseDurationSeconds: 3600, workoutElapsedSeconds: 90,
    recentHeartRates: Array.from({ length: 11 }, (_, index) => ({ elapsedSeconds: index, bpm: 110 })),
    ...machineTarget,
  };
  assert.deepEqual(
    getProFormSmartPower10Guidance(controllerInput, createMachineGuidanceState()),
    getProFormSmartPower10Guidance(controllerInput, createMachineGuidanceState())
  );
});

test("unrelated profile and fitness fields cannot change phase outcome or candidate math", () => {
  const baseline = evaluatePersonalizedPrescription(input());
  const changedProfile = profile({
    demographics: { ...profile().demographics, heightInches: 78, sex: "male" },
    userEnteredVo2: {
      value: 90, source: "user_entered", quality: "unverified",
      observedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  const changedState = calibrationState({ calibration: { predictedHrMaxBpm: 210 }, state: {
    predictedMaxWatts: {
      value: 500, source: "formal_assessment", quality: "high",
      observedAt: "2026-01-01T00:30:00.000Z", updatedAt: "2026-01-01T00:31:00.000Z",
      algorithm: { id: "bike-submax-linear-hr-workload", version: 1 }, evidenceSessionIds: ["formal-e1"],
      derivation: "demographic_hrmax_extrapolation", predictedHrMaxSource: "demographic_estimate",
    },
  } });
  const changed = evaluatePersonalizedPrescription(input({ profile: changedProfile, fitnessState: changedState }));
  assert.equal(onlyPhase(changed).outcome, onlyPhase(baseline).outcome);
  assert.deepEqual(onlyPhase(changed).candidatePower, onlyPhase(baseline).candidatePower);
  assert.deepEqual(onlyPhase(changed).activeHeartRate, onlyPhase(baseline).activeHeartRate);
});
