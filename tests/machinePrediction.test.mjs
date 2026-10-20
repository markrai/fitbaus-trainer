import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCompletedWorkoutDynamics,
  DYNAMICS_STORAGE_KEY,
  getDynamicsEntry,
  putDynamicsEntry,
} from "../dist/machines/dynamics/index.js";
import {
  LEARNING_STORAGE_KEY,
  learningKey,
  loadLearnedStore,
  putLearnedStart,
} from "../dist/machines/learning/index.js";
import {
  appendBoundedPredictions,
  applyCompletedWorkoutShadowPredictions,
  deriveShadowResistancePredictions,
  directionMatched,
  getShadowPredictionEntry,
  listShadowPredictions,
  loadShadowPredictionStore,
  MAX_SHADOW_DOSE_MAD_BPM,
  MIN_SHADOW_DIRECTION_CONSISTENCY,
  MIN_SHADOW_DOSE_SAMPLES,
  predictedHrDeltaForActualStep,
  predictedHrDeltaForShadowSuggestion,
  resetShadowPredictionsForMachine,
  SHADOW_PREDICTION_LIMIT,
  SHADOW_PREDICTION_STORAGE_KEY,
  shadowDecreaseSuggestion,
  shadowIncreaseSuggestion,
  trustedDirectionalHrPerLevelEstimate,
} from "../dist/machines/prediction/index.js";
import { EQUIPMENT_STORAGE_KEY, setSelectedMachine } from "../dist/machines/selection.js";
import { buildSisuWorkoutPayload } from "../dist/sisuSync.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function fillRange(start, end, bpm) {
  const samples = [];
  for (let elapsed = start; elapsed < end; elapsed++) {
    samples.push({ elapsedSeconds: elapsed, bpm });
  }
  return samples;
}

function bikeSummary(overrides = {}) {
  return {
    external_session_id: "pred-1",
    startedAt: "2026-08-26T12:00:00.000Z",
    endedAt: "2026-08-26T12:40:00.000Z",
    category: "cardio",
    intent: "vo2_priority",
    duration_minutes: 40,
    primary_zone: 4,
    stress_profile: "high",
    zone_minutes: { z1: 5, z2: 5, z3: 5, z4: 20, z5: 5 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    activity: "bike",
    machine_id: "proform-smart-power-10",
    machine_profile_version: 1,
    machine_guidance_trace: [],
    ...overrides,
  };
}

function workEntry(elapsed, resistance, extras = {}) {
  return {
    elapsedSeconds: elapsed,
    resistance,
    cadenceRpm: extras.cadenceRpm ?? 70,
    estimatedWatts: extras.estimatedWatts ?? 134,
    phaseKind: "work",
    phaseId: extras.phaseId ?? "work:1",
    intervalIndex: extras.intervalIndex ?? 1,
    phaseDurationSeconds: extras.work ?? 240,
    phaseElapsedSeconds: extras.phaseElapsedSeconds ?? 0,
    targetHeartRateMin: extras.omitTargets ? undefined : extras.targetMin ?? 160,
    targetHeartRateMax: extras.omitTargets ? undefined : extras.targetMax ?? 170,
    reason: extras.reason ?? "work",
  };
}

function recoveryEntry(elapsed, extras = {}) {
  return {
    elapsedSeconds: elapsed,
    resistance: extras.resistance ?? 2,
    cadenceRpm: 63,
    phaseKind: "recovery",
    phaseId: extras.phaseId ?? "recovery:1",
    phaseDurationSeconds: extras.recovery ?? 60,
    phaseElapsedSeconds: 0,
    targetHeartRateMin: 120,
    targetHeartRateMax: 135,
    reason: "recovery",
  };
}

const vo2LongKey = {
  machineId: "proform-smart-power-10",
  machineProfileVersion: 1,
  activity: "bike",
  intent: "vo2_priority",
  durationClass: "long",
};

const thresholdLongKey = {
  machineId: "proform-smart-power-10",
  machineProfileVersion: 1,
  activity: "bike",
  intent: "threshold",
  durationClass: "long",
};

function emptyDynamicsFields(overrides = {}) {
  return {
    workStartDelays: [],
    workStartHrDeltas: [],
    increaseDelays: [],
    increaseHrPerLevel: [],
    decreaseDelays: [],
    decreaseHrPerLevel: [],
    workStartObservationCount: 0,
    workStartDetectedResponseCount: 0,
    increaseObservationCount: 0,
    increaseDetectedResponseCount: 0,
    decreaseObservationCount: 0,
    decreaseDetectedResponseCount: 0,
    workStartRecentResponses: [],
    increaseRecentResponses: [],
    decreaseRecentResponses: [],
    updatedAt: "t",
    ...overrides,
  };
}

function seedIncreaseModel(storage, samples, key = vo2LongKey) {
  putDynamicsEntry(key, emptyDynamicsFields({ increaseHrPerLevel: samples }), storage);
}

function seedDecreaseModel(storage, samples, key = thresholdLongKey) {
  putDynamicsEntry(key, emptyDynamicsFields({ decreaseHrPerLevel: samples }), storage);
}

function increaseWorkout(overrides = {}) {
  const from = overrides.fromResistance ?? 8;
  const to = overrides.toResistance ?? 9;
  const summaryOverrides = {
    external_session_id: overrides.sessionId ?? "pred-inc",
    intent: overrides.intent ?? "vo2_priority",
    machine_guidance_trace: [
      workEntry(0, from, {
        work: 240,
        phaseElapsedSeconds: 0,
        targetMin: overrides.startTargetMin,
        targetMax: overrides.startTargetMax,
        omitTargets: overrides.omitStartTargets,
      }),
      workEntry(100, to, {
        work: 240,
        phaseElapsedSeconds: 100,
        estimatedWatts: 114,
        targetMin: overrides.targetMin,
        targetMax: overrides.targetMax,
        omitTargets: overrides.omitTargets,
      }),
    ],
  };
  if (overrides.cancelled !== undefined) summaryOverrides.cancelled = overrides.cancelled;
  if (overrides.activity !== undefined) summaryOverrides.activity = overrides.activity;
  if (Object.prototype.hasOwnProperty.call(overrides, "machine_id")) summaryOverrides.machine_id = overrides.machine_id;
  if (overrides.machine_profile_version !== undefined) {
    summaryOverrides.machine_profile_version = overrides.machine_profile_version;
  }
  return {
    summary: bikeSummary(summaryOverrides),
    samples: [
      ...fillRange(90, 100, overrides.baselineHr ?? 150),
      ...fillRange(100, 120, (overrides.baselineHr ?? 150) + 1),
      { elapsedSeconds: 120, bpm: (overrides.baselineHr ?? 150) + 1 },
      { elapsedSeconds: 121, bpm: (overrides.baselineHr ?? 150) + 2 },
      { elapsedSeconds: 122, bpm: (overrides.baselineHr ?? 150) + 2 },
      { elapsedSeconds: 123, bpm: (overrides.baselineHr ?? 150) + 3 },
      { elapsedSeconds: 124, bpm: (overrides.baselineHr ?? 150) + 4 },
      ...fillRange(125, 175, (overrides.baselineHr ?? 150) + 5),
      ...fillRange(175, 190, overrides.settledHr ?? 160),
    ],
  };
}

function decreaseWorkout(overrides = {}) {
  const baseline = overrides.baselineHr ?? 160;
  const settled = overrides.settledHr ?? 155;
  return {
    summary: bikeSummary({
      external_session_id: overrides.sessionId ?? "pred-dec",
      intent: overrides.intent ?? "threshold",
      machine_guidance_trace: [
        workEntry(0, overrides.fromResistance ?? 10, { work: 240, phaseElapsedSeconds: 0 }),
        workEntry(100, overrides.toResistance ?? 9, {
          work: 240,
          phaseElapsedSeconds: 100,
          estimatedWatts: 114,
        }),
      ],
    }),
    samples: [
      ...fillRange(90, 100, baseline),
      ...fillRange(100, 120, baseline - 1),
      { elapsedSeconds: 120, bpm: baseline - 1 },
      { elapsedSeconds: 121, bpm: baseline - 2 },
      { elapsedSeconds: 122, bpm: baseline - 2 },
      { elapsedSeconds: 123, bpm: baseline - 3 },
      { elapsedSeconds: 124, bpm: baseline - 4 },
      ...fillRange(125, 190, settled),
    ],
  };
}

test("increase dose estimate is trusted for five consistent samples", () => {
  const estimate = trustedDirectionalHrPerLevelEstimate([3, 4, 4, 5, 4], "increase");
  assert.ok(estimate);
  assert.equal(estimate.medianHrPerLevel, 4);
  assert.equal(estimate.sampleCount, 5);
  assert.equal(estimate.medianHrPerLevel > 0, true);
  assert.equal(estimate.madBpm <= MAX_SHADOW_DOSE_MAD_BPM, true);
  assert.equal(estimate.signConsistency >= MIN_SHADOW_DIRECTION_CONSISTENCY, true);
});

test("four directional samples are not trusted", () => {
  assert.equal(trustedDirectionalHrPerLevelEstimate([3, 4, 4, 5], "increase"), undefined);
  assert.equal(MIN_SHADOW_DOSE_SAMPLES, 5);
});

test("high-spread dose samples are rejected by MAD", () => {
  assert.equal(trustedDirectionalHrPerLevelEstimate([1, 2, 8, 10, 15], "increase"), undefined);
});

test("wrong-direction majority is rejected for increase", () => {
  assert.equal(trustedDirectionalHrPerLevelEstimate([-2, -1, -3, 4, 5], "increase"), undefined);
});

test("decrease dose estimate is trusted for consistent negative samples", () => {
  const estimate = trustedDirectionalHrPerLevelEstimate([-2, -3, -3, -4, -3], "decrease");
  assert.ok(estimate);
  assert.equal(estimate.medianHrPerLevel, -3);
  assert.equal(estimate.medianHrPerLevel < 0, true);
});

test("zero median is rejected", () => {
  assert.equal(trustedDirectionalHrPerLevelEstimate([2, 1, 0, -1, -2], "increase"), undefined);
  assert.equal(trustedDirectionalHrPerLevelEstimate([2, 1, 0, -1, -2], "decrease"), undefined);
});

test("increase shadow suggestion uses ceil deficit and does not alter the controller step", () => {
  const suggestion = shadowIncreaseSuggestion({
    preChangeHr: 150,
    targetHeartRateMin: 160,
    fromResistance: 10,
    medianIncreaseHrPerLevel: 4,
  });
  assert.deepEqual(suggestion, {
    estimatedLevelsNeeded: 3,
    shadowCappedLevels: 3,
    shadowEffectiveLevels: 3,
    shadowSuggestedResistance: 13,
  });
});

test("increase shadow suggestion caps estimated steps at 3", () => {
  const suggestion = shadowIncreaseSuggestion({
    preChangeHr: 130,
    targetHeartRateMin: 160,
    fromResistance: 10,
    medianIncreaseHrPerLevel: 4,
  });
  assert.equal(suggestion.estimatedLevelsNeeded, 8);
  assert.equal(suggestion.shadowCappedLevels, 3);
  assert.equal(suggestion.shadowEffectiveLevels, 3);
  assert.equal(suggestion.shadowSuggestedResistance, 13);
});

test("increase shadow suggestion at R14 uses one effective level after the R15 bound", () => {
  const suggestion = shadowIncreaseSuggestion({
    preChangeHr: 130,
    targetHeartRateMin: 160,
    fromResistance: 14,
    medianIncreaseHrPerLevel: 4,
  });
  assert.equal(suggestion.estimatedLevelsNeeded >= 3, true);
  assert.equal(suggestion.shadowCappedLevels, 3);
  assert.equal(suggestion.shadowSuggestedResistance, 15);
  assert.equal(suggestion.shadowEffectiveLevels, 1);
  assert.equal(predictedHrDeltaForShadowSuggestion(4, suggestion.shadowEffectiveLevels), 4);
  assert.equal(130 + predictedHrDeltaForShadowSuggestion(4, suggestion.shadowEffectiveLevels), 134);
});

test("decrease shadow suggestion uses ceil excess and stays independent of the controller step", () => {
  const suggestion = shadowDecreaseSuggestion({
    preChangeHr: 178,
    targetHeartRateMax: 170,
    fromResistance: 10,
    medianDecreaseHrPerLevel: -3,
  });
  assert.deepEqual(suggestion, {
    estimatedLevelsNeeded: 3,
    shadowCappedLevels: 3,
    shadowEffectiveLevels: 3,
    shadowSuggestedResistance: 7,
  });
});

test("decrease shadow suggestion at R2 uses one effective level after the R1 bound", () => {
  const suggestion = shadowDecreaseSuggestion({
    preChangeHr: 178,
    targetHeartRateMax: 170,
    fromResistance: 2,
    medianDecreaseHrPerLevel: -3,
  });
  assert.equal(suggestion.estimatedLevelsNeeded >= 3, true);
  assert.equal(suggestion.shadowCappedLevels, 3);
  assert.equal(suggestion.shadowSuggestedResistance, 1);
  assert.equal(suggestion.shadowEffectiveLevels, 1);
  assert.equal(predictedHrDeltaForShadowSuggestion(-3, suggestion.shadowEffectiveLevels), -3);
});

test("non-boundary shadow suggestion keeps capped and effective levels equal", () => {
  const suggestion = shadowIncreaseSuggestion({
    preChangeHr: 150,
    targetHeartRateMin: 160,
    fromResistance: 10,
    medianIncreaseHrPerLevel: 4,
  });
  assert.equal(suggestion.shadowSuggestedResistance, 13);
  assert.equal(suggestion.shadowCappedLevels, 3);
  assert.equal(suggestion.shadowEffectiveLevels, 3);
  assert.equal(predictedHrDeltaForShadowSuggestion(4, suggestion.shadowEffectiveLevels), 12);
});

test("actual-step HR prediction and realized error for an increase", () => {
  const predicted = predictedHrDeltaForActualStep(4, 1);
  assert.equal(predicted, 4);
  assert.equal(150 + predicted, 154);
  const observed = 5;
  assert.equal(observed - predicted, 1);
  assert.equal(Math.abs(observed - predicted), 1);
  assert.equal(directionMatched("increase", observed), true);
});

test("decrease prediction error keeps contradictory responses visible", () => {
  const predicted = predictedHrDeltaForActualStep(-3, -1);
  assert.equal(predicted, -3);
  assert.equal(-5 - predicted, -2);
  assert.equal(Math.abs(-5 - predicted), 2);
  assert.equal(directionMatched("decrease", -5), true);
  assert.equal(directionMatched("decrease", 1), false);
  assert.equal(directionMatched("increase", 0), false);
});

test("current workout does not train its own shadow prediction", () => {
  const storage = memoryStorage();
  seedIncreaseModel(storage, [3, 4, 4, 5]);
  const { summary, samples } = increaseWorkout({ sessionId: "no-hindsight-1" });
  assert.equal(applyCompletedWorkoutShadowPredictions(summary, samples, storage).length, 0);
  const trained = applyCompletedWorkoutDynamics(summary, samples, storage);
  assert.equal(trained.length, 1);
  assert.deepEqual(getDynamicsEntry(vo2LongKey, storage).increaseHrPerLevel, [3, 4, 4, 5, 10]);
  assert.equal(
    deriveShadowResistancePredictions(summary, samples, {
      [learningKey(vo2LongKey)]: getDynamicsEntry(vo2LongKey, storage),
    }).length,
    1
  );
  const later = increaseWorkout({ sessionId: "no-hindsight-2" });
  const predictions = applyCompletedWorkoutShadowPredictions(later.summary, later.samples, storage);
  assert.equal(predictions.length, 1);
  assert.equal(predictions[0].modelSampleCount, 5);
  assert.equal(predictions[0].direction, "increase");
});

test("increase and decrease models are isolated", () => {
  const storage = memoryStorage();
  seedIncreaseModel(storage, [3, 4, 4, 5, 4], thresholdLongKey);
  const decrease = decreaseWorkout();
  assert.equal(applyCompletedWorkoutShadowPredictions(decrease.summary, decrease.samples, storage).length, 0);
  seedDecreaseModel(storage, [-2, -3, -3, -4, -3]);
  seedIncreaseModel(storage, [], vo2LongKey);
  const increase = increaseWorkout();
  assert.equal(applyCompletedWorkoutShadowPredictions(increase.summary, increase.samples, storage).length, 0);
  const laterDecrease = decreaseWorkout({ sessionId: "pred-dec-2" });
  const trustedDecrease = applyCompletedWorkoutShadowPredictions(laterDecrease.summary, laterDecrease.samples, storage);
  assert.equal(trustedDecrease.length, 1);
  assert.equal(trustedDecrease[0].direction, "decrease");
});

test("cancelled, elliptical, strength, no machine, wrong machine, wrong profile, and unsupported intent do not store shadow predictions", () => {
  const storage = memoryStorage();
  seedIncreaseModel(storage, [3, 4, 4, 5, 4]);
  const { summary, samples } = increaseWorkout();
  assert.equal(applyCompletedWorkoutShadowPredictions(summary, samples, storage).length, 1);
  const cases = [
    increaseWorkout({ cancelled: true, sessionId: "cancelled" }),
    increaseWorkout({ activity: "elliptical", sessionId: "elliptical" }),
    increaseWorkout({ activity: "strength", sessionId: "strength" }),
    {
      summary: bikeSummary({
        external_session_id: "no-machine",
        machine_id: undefined,
        machine_guidance_trace: increaseWorkout().summary.machine_guidance_trace,
      }),
      samples,
    },
    increaseWorkout({ machine_id: "unknown-bike", sessionId: "wrong-machine" }),
    increaseWorkout({ machine_profile_version: 2, sessionId: "wrong-profile" }),
    {
      summary: bikeSummary({
        external_session_id: "unknown-intent",
        intent: "unknown",
        machine_guidance_trace: increaseWorkout().summary.machine_guidance_trace,
      }),
      samples,
    },
  ];
  for (const item of cases) {
    assert.equal(applyCompletedWorkoutShadowPredictions(item.summary, item.samples, storage).length, 0);
  }
  assert.equal(getShadowPredictionEntry(vo2LongKey, storage).increase.length, 1);
});

test("shadow prediction events are bounded per key and direction", () => {
  const storage = memoryStorage();
  seedIncreaseModel(storage, [3, 4, 4, 5, 4]);
  seedDecreaseModel(storage, [-2, -3, -3, -4, -3]);
  const decrease = decreaseWorkout({ sessionId: "bound-dec" });
  assert.equal(applyCompletedWorkoutShadowPredictions(decrease.summary, decrease.samples, storage).length, 1);
  for (let i = 1; i <= 25; i++) {
    const workout = increaseWorkout({ sessionId: `bound-inc-${i}` });
    applyCompletedWorkoutShadowPredictions(workout.summary, workout.samples, storage);
  }
  const increaseEntry = getShadowPredictionEntry(vo2LongKey, storage);
  const decreaseEntry = getShadowPredictionEntry(thresholdLongKey, storage);
  assert.equal(increaseEntry.increase.length, SHADOW_PREDICTION_LIMIT);
  assert.equal(increaseEntry.increase[0].sessionId, "bound-inc-6");
  assert.equal(increaseEntry.increase[19].sessionId, "bound-inc-25");
  assert.equal(decreaseEntry.decrease.length, 1);
  assert.equal(decreaseEntry.decrease[0].sessionId, "bound-dec");
  const original = ["a", "b"];
  const next = appendBoundedPredictions(original, { sessionId: "c" });
  assert.deepEqual(original, ["a", "b"]);
  assert.equal(next.length, 3);
});

test("reset shadow prediction data leaves learned starts, dynamics, and equipment unchanged", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putLearnedStart(vo2LongKey, { resistance: 12, sampleCount: 2, updatedAt: "t" }, storage);
  putDynamicsEntry(
    vo2LongKey,
    emptyDynamicsFields({
      increaseHrPerLevel: [3, 4, 4, 5, 4],
      increaseRecentResponses: [20, 22, null],
      increaseObservationCount: 3,
      increaseDetectedResponseCount: 2,
    }),
    storage
  );
  const { summary, samples } = increaseWorkout();
  assert.equal(applyCompletedWorkoutShadowPredictions(summary, samples, storage).length, 1);
  const learnedBefore = storage.getItem(LEARNING_STORAGE_KEY);
  const dynamicsBefore = storage.getItem(DYNAMICS_STORAGE_KEY);
  const equipmentBefore = storage.getItem(EQUIPMENT_STORAGE_KEY);
  resetShadowPredictionsForMachine("proform-smart-power-10", storage);
  assert.deepEqual(loadShadowPredictionStore(storage), {
    version: 1,
    entries: {},
    processedSessions: ["pred-inc"],
  });
  assert.equal(storage.getItem(LEARNING_STORAGE_KEY), learnedBefore);
  assert.equal(storage.getItem(DYNAMICS_STORAGE_KEY), dynamicsBefore);
  assert.equal(storage.getItem(EQUIPMENT_STORAGE_KEY), equipmentBefore);
  assert.equal(loadLearnedStore(storage).entries[learningKey(vo2LongKey)].resistance, 12);
  assert.deepEqual(getDynamicsEntry(vo2LongKey, storage).increaseHrPerLevel, [3, 4, 4, 5, 4]);
  assert.deepEqual(getDynamicsEntry(vo2LongKey, storage).increaseRecentResponses, [20, 22, null]);
});

test("realized shadow event records actual-step prediction, not the hypothetical multi-level outcome", () => {
  const storage = memoryStorage();
  seedIncreaseModel(storage, [3, 4, 4, 5, 4]);
  const { summary, samples } = increaseWorkout({ fromResistance: 10, toResistance: 11, sessionId: "actual-step" });
  const predictions = applyCompletedWorkoutShadowPredictions(summary, samples, storage);
  assert.equal(predictions.length, 1);
  const event = predictions[0];
  assert.equal(event.fromResistance, 10);
  assert.equal(event.actualToResistance, 11);
  assert.equal(event.preChangeHr, 150);
  assert.equal(event.targetHeartRateMin, 160);
  assert.equal(event.modelMedianHrPerLevel, 4);
  assert.equal(event.estimatedLevelsNeeded, 3);
  assert.equal(event.shadowCappedLevels, 3);
  assert.equal(event.shadowEffectiveLevels, 3);
  assert.equal(event.shadowSuggestedResistance, 13);
  assert.equal(event.predictedHrDeltaForActualStep, 4);
  assert.equal(event.predictedSettledHrAfterActualStep, 154);
  assert.equal(event.predictedHrDeltaForShadowSuggestion, 12);
  assert.equal(event.predictedHrAtShadowSuggestion, 162);
  assert.equal(event.observedHrDelta, 10);
  assert.equal(event.predictionErrorBpm, 6);
  assert.equal(event.absolutePredictionErrorBpm, 6);
  assert.equal(event.directionMatched, true);
  const listed = listShadowPredictions("proform-smart-power-10", storage);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].increase.predictionCount, 1);
  assert.equal(listed[0].increase.medianAbsolutePredictionErrorBpm, 6);
  assert.equal(listed[0].increase.directionMatchCount, 1);
  assert.equal(listed[0].increase.directionEvaluatedCount, 1);
});

test("stored shadow HR prediction uses effective levels after the R15 bound", () => {
  const storage = memoryStorage();
  seedIncreaseModel(storage, [3, 4, 4, 5, 4]);
  const { summary, samples } = increaseWorkout({
    fromResistance: 14,
    toResistance: 15,
    baselineHr: 130,
    settledHr: 140,
    sessionId: "r15-bound",
  });
  const predictions = applyCompletedWorkoutShadowPredictions(summary, samples, storage);
  assert.equal(predictions.length, 1);
  const event = predictions[0];
  assert.equal(event.estimatedLevelsNeeded >= 3, true);
  assert.equal(event.shadowCappedLevels, 3);
  assert.equal(event.shadowSuggestedResistance, 15);
  assert.equal(event.shadowEffectiveLevels, 1);
  assert.equal(event.predictedHrDeltaForShadowSuggestion, 4);
  assert.equal(event.predictedHrAtShadowSuggestion, 134);
  assert.equal(event.predictedHrDeltaForActualStep, 4);
});

test("stored shadow HR prediction uses effective levels after the R1 bound", () => {
  const storage = memoryStorage();
  seedDecreaseModel(storage, [-2, -3, -3, -4, -3]);
  const { summary, samples } = decreaseWorkout({
    fromResistance: 2,
    toResistance: 1,
    baselineHr: 178,
    settledHr: 170,
    sessionId: "r1-bound",
  });
  const predictions = applyCompletedWorkoutShadowPredictions(summary, samples, storage);
  assert.equal(predictions.length, 1);
  const event = predictions[0];
  assert.equal(event.estimatedLevelsNeeded >= 3, true);
  assert.equal(event.shadowCappedLevels, 3);
  assert.equal(event.shadowSuggestedResistance, 1);
  assert.equal(event.shadowEffectiveLevels, 1);
  assert.equal(event.predictedHrDeltaForShadowSuggestion, -3);
  assert.equal(event.predictedHrAtShadowSuggestion, 175);
  assert.equal(event.predictedHrDeltaForActualStep, -3);
});

test("shadow prediction uses the change event target range and skips missing targets", () => {
  const storage = memoryStorage();
  seedIncreaseModel(storage, [3, 4, 4, 5, 4]);
  const mismatched = increaseWorkout({
    startTargetMin: 140,
    startTargetMax: 150,
    targetMin: 160,
    targetMax: 170,
    sessionId: "phase-target",
  });
  const predictions = applyCompletedWorkoutShadowPredictions(mismatched.summary, mismatched.samples, storage);
  assert.equal(predictions[0].targetHeartRateMin, 160);
  assert.equal(predictions[0].estimatedLevelsNeeded, 3);
  const omitted = increaseWorkout({ omitTargets: true, sessionId: "no-targets" });
  assert.equal(applyCompletedWorkoutShadowPredictions(omitted.summary, omitted.samples, storage).length, 0);
});

test("work-start and recovery-to-work transitions are not shadow dose events", () => {
  const storage = memoryStorage();
  seedIncreaseModel(storage, [3, 4, 4, 5, 4], {
    ...vo2LongKey,
    intent: "vo2_primer",
    durationClass: "short",
  });
  const summary = bikeSummary({
    intent: "vo2_primer",
    machine_guidance_trace: [recoveryEntry(40, { phaseId: "recovery:0" }), workEntry(100, 11, { work: 60 }), recoveryEntry(160)],
  });
  const samples = [
    ...fillRange(85, 100, 130),
    ...fillRange(100, 120, 131),
    { elapsedSeconds: 120, bpm: 131 },
    { elapsedSeconds: 121, bpm: 132 },
    { elapsedSeconds: 122, bpm: 132 },
    { elapsedSeconds: 123, bpm: 133 },
    { elapsedSeconds: 124, bpm: 134 },
    ...fillRange(125, 145, 135),
    ...fillRange(145, 160, 147),
    ...fillRange(160, 180, 180),
  ];
  assert.equal(applyCompletedWorkoutShadowPredictions(summary, samples, storage).length, 0);
});

test("SISU payload omits shadow prediction fields", () => {
  const payload = buildSisuWorkoutPayload({
    external_session_id: "session-shadow",
    day: "Monday",
    intent: "vo2_primer",
    machine_id: "proform-smart-power-10",
    machine_profile_version: 1,
    machine_guidance_trace: [{ elapsedSeconds: 0, resistance: 11, cadenceRpm: 70, reason: "start" }],
    activity: "bike",
    shadow_predictions: [{ direction: "increase" }],
    shadow_resistance_predictions: [{ direction: "decrease" }],
  });
  assert.deepEqual(payload, {
    external_session_id: "session-shadow",
    day: "Monday",
    intent: "vo2_primer",
  });
  assert.equal("shadow_predictions" in payload, false);
  assert.equal("shadow_resistance_predictions" in payload, false);
  assert.equal("machine_guidance_trace" in payload, false);
});
