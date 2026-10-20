import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCompletedWorkoutDynamics,
  putDynamicsEntry,
} from "../dist/machines/dynamics/index.js";
import {
  applyCompletedWorkoutShadowPredictions,
  getShadowPredictionEntry,
  hasProcessedShadowSession,
  listShadowPredictions,
  loadShadowPredictionStore,
  persistShadowPredictions,
  resetShadowPredictionsForMachine,
  SHADOW_PREDICTION_STORAGE_KEY,
  validateShadowDirection,
} from "../dist/machines/prediction/index.js";

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

const vo2LongKey = {
  machineId: "proform-smart-power-10",
  machineProfileVersion: 1,
  activity: "bike",
  intent: "vo2_priority",
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

function shadowEvent(overrides = {}) {
  const predicted = overrides.predictedHrDeltaForActualStep ?? 4;
  const observed = Object.prototype.hasOwnProperty.call(overrides, "observedHrDelta")
    ? overrides.observedHrDelta
    : predicted;
  const event = {
    version: 1,
    sessionId: "s1",
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    activity: "bike",
    intent: "vo2_priority",
    durationClass: "long",
    phaseId: "work:1",
    changeElapsedSeconds: 100,
    direction: "increase",
    fromResistance: 8,
    actualToResistance: 9,
    preChangeHr: 150,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
    modelSampleCount: 5,
    modelMedianHrPerLevel: 4,
    modelMadBpm: 0,
    modelDirectionConsistency: 1,
    estimatedLevelsNeeded: 3,
    shadowCappedLevels: 3,
    shadowEffectiveLevels: 3,
    shadowSuggestedResistance: 11,
    predictedHrDeltaForActualStep: predicted,
    predictedSettledHrAfterActualStep: 150 + predicted,
    predictedHrDeltaForShadowSuggestion: 12,
    predictedHrAtShadowSuggestion: 162,
    ...overrides,
  };
  if (observed === undefined) {
    delete event.observedHrDelta;
    delete event.predictionErrorBpm;
    delete event.absolutePredictionErrorBpm;
    delete event.directionMatched;
  } else {
    event.observedHrDelta = observed;
  }
  return event;
}

function eventsFromErrors(errors, extras = {}) {
  return errors.map((error, index) => {
    const predicted = extras.predicted ?? 4;
    const sessionCount = extras.sessions ?? 5;
    return shadowEvent({
      sessionId: extras.sessionId ?? `session-${(index % sessionCount) + 1}`,
      changeElapsedSeconds: 90 + index,
      predictedHrDeltaForActualStep: predicted,
      observedHrDelta: extras.omitObserved ? undefined : predicted + error,
      direction: extras.direction ?? "increase",
      fromResistance: extras.fromResistance ?? 8,
      actualToResistance: extras.actualToResistance ?? (extras.direction === "decrease" ? 7 : 9),
      ...extras.event,
    });
  });
}

function workEntry(elapsed, resistance, extras = {}) {
  return {
    elapsedSeconds: elapsed,
    resistance,
    cadenceRpm: 70,
    estimatedWatts: extras.estimatedWatts ?? 134,
    phaseKind: "work",
    phaseId: extras.phaseId ?? "work:1",
    intervalIndex: 1,
    phaseDurationSeconds: extras.work ?? 240,
    phaseElapsedSeconds: extras.phaseElapsedSeconds ?? 0,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
    reason: "work",
  };
}

function increaseWorkout(overrides = {}) {
  const from = overrides.fromResistance ?? 8;
  const to = overrides.toResistance ?? 9;
  return {
    summary: {
      external_session_id: overrides.sessionId ?? "pred-inc",
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
      machine_guidance_trace: [
        workEntry(0, from, { phaseElapsedSeconds: 0 }),
        workEntry(100, to, { phaseElapsedSeconds: 100, estimatedWatts: 114 }),
      ],
    },
    samples: [
      ...fillRange(90, 100, 150),
      ...fillRange(100, 120, 151),
      { elapsedSeconds: 120, bpm: 151 },
      { elapsedSeconds: 121, bpm: 152 },
      { elapsedSeconds: 122, bpm: 152 },
      { elapsedSeconds: 123, bpm: 153 },
      { elapsedSeconds: 124, bpm: 154 },
      ...fillRange(125, 175, 155),
      ...fillRange(175, 190, 160),
    ],
  };
}

test("strong ±1 increase population is high-confidence validated", () => {
  const realized = eventsFromErrors([0, 1, -1, 2, -2, 1, 0, 2, -1, 1], { sessions: 5 });
  const unrealized = [
    shadowEvent({ sessionId: "session-6", changeElapsedSeconds: 200, observedHrDelta: undefined }),
    shadowEvent({ sessionId: "session-7", changeElapsedSeconds: 210, observedHrDelta: undefined }),
  ];
  const result = validateShadowDirection([...realized, ...unrealized], "increase");
  assert.equal(result.predictionOpportunityCount, 12);
  assert.equal(result.realizedPredictionCount, 10);
  assert.equal(result.realizationRate, 10 / 12);
  assert.equal(result.distinctSessionCount, 5);
  assert.equal(result.medianAbsolutePredictionErrorBpm <= 3, true);
  assert.equal(Math.abs(result.medianSignedPredictionErrorBpm) <= 2, true);
  assert.equal(result.directionMatchRate >= 0.8, true);
  assert.equal(result.withinToleranceRate >= 0.8, true);
  assert.equal(result.highConfidence, true);
  assert.equal(result.status, "validated");
});

test("nine excellent realized events remain collecting", () => {
  const result = validateShadowDirection(eventsFromErrors([0, 0, 0, 0, 0, 0, 0, 0, 0], { sessions: 5 }), "increase");
  assert.equal(result.realizedPredictionCount, 9);
  assert.equal(result.distinctSessionCount, 5);
  assert.equal(result.highConfidence, false);
  assert.equal(result.status, "collecting");
});

test("ten perfect predictions from one session are not high confidence", () => {
  const result = validateShadowDirection(eventsFromErrors([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], { sessionId: "one-workout" }), "increase");
  assert.equal(result.realizedPredictionCount, 10);
  assert.equal(result.distinctSessionCount, 1);
  assert.equal(result.highConfidence, false);
  assert.equal(result.status, "collecting");
});

test("50 percent realization rate is not high confidence", () => {
  const realized = eventsFromErrors([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], { sessions: 5 });
  const missing = eventsFromErrors([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], {
    sessions: 5,
    omitObserved: true,
    event: { phaseId: "work:2" },
  });
  const result = validateShadowDirection([...realized, ...missing], "increase");
  assert.equal(result.predictionOpportunityCount, 20);
  assert.equal(result.realizedPredictionCount, 10);
  assert.equal(result.realizationRate, 0.5);
  assert.equal(result.highConfidence, false);
  assert.equal(result.status, "not_validated");
});

test("median absolute error above 3 bpm is not high confidence", () => {
  const result = validateShadowDirection(eventsFromErrors([4, 4, 4, 4, 4, 4, 4, 4, 4, 4], { sessions: 5 }), "increase");
  assert.equal(result.medianAbsolutePredictionErrorBpm, 4);
  assert.equal(result.highConfidence, false);
  assert.equal(result.status, "not_validated");
});

test("systematic +3 bpm bias fails high confidence even when MAE is 3", () => {
  const result = validateShadowDirection(eventsFromErrors([3, 3, 3, 3, 3, 3, 3, 3, 3, 3], { sessions: 5 }), "increase");
  assert.equal(result.medianAbsolutePredictionErrorBpm, 3);
  assert.equal(result.medianSignedPredictionErrorBpm, 3);
  assert.equal(result.highConfidence, false);
  assert.equal(result.status, "not_validated");
});

test("direction-match below 80 percent is not high confidence", () => {
  const matches = eventsFromErrors([0, 0, 0, 0, 0, 0, 0], { sessions: 5 });
  const misses = [7, 8, 9].map((index) =>
    shadowEvent({
      sessionId: `session-${(index % 5) + 1}`,
      changeElapsedSeconds: 90 + index,
      predictedHrDeltaForActualStep: 4,
      observedHrDelta: 0,
    })
  );
  const result = validateShadowDirection([...matches, ...misses], "increase");
  assert.equal(result.realizedPredictionCount, 10);
  assert.equal(result.directionMatchCount, 7);
  assert.equal(result.directionMatchRate, 0.7);
  assert.equal(result.highConfidence, false);
  assert.equal(result.status, "not_validated");
});

test("a small median can hide a tail that fails the 5 bpm tolerance gate", () => {
  const result = validateShadowDirection(
    eventsFromErrors([1, 1, 1, 1, 1, 1, 8, 9, 10, 12], { sessions: 5 }),
    "increase"
  );
  assert.equal(result.medianAbsolutePredictionErrorBpm, 1);
  assert.equal(result.withinToleranceCount, 6);
  assert.equal(result.withinToleranceRate, 0.6);
  assert.equal(result.highConfidence, false);
  assert.equal(result.status, "not_validated");
});

test("legacy ±2 events do not establish ±1 validation confidence", () => {
  const plusTwo = eventsFromErrors([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], {
    sessions: 5,
    actualToResistance: 10,
  });
  const onlyTwo = validateShadowDirection(plusTwo, "increase");
  assert.equal(onlyTwo.predictionOpportunityCount, 0);
  assert.equal(onlyTwo.highConfidence, false);
  const plusOne = eventsFromErrors([0, 1, -1, 2, -2, 1, 0, 2, -1, 1], { sessions: 5, event: { phaseId: "work:2" } });
  const mixed = validateShadowDirection([...plusTwo, ...plusOne], "increase");
  assert.equal(mixed.predictionOpportunityCount, 10);
  assert.equal(mixed.highConfidence, true);
});

test("malformed direction/step pairs are ignored by validation", () => {
  const wrongIncrease = shadowEvent({
    direction: "increase",
    fromResistance: 10,
    actualToResistance: 9,
    observedHrDelta: 4,
  });
  const wrongDecrease = shadowEvent({
    direction: "decrease",
    fromResistance: 9,
    actualToResistance: 10,
    observedHrDelta: -4,
  });
  assert.equal(validateShadowDirection([wrongIncrease], "increase").predictionOpportunityCount, 0);
  assert.equal(validateShadowDirection([wrongDecrease], "decrease").predictionOpportunityCount, 0);
});

test("missing session ids cannot establish high validation confidence", () => {
  const result = validateShadowDirection(
    eventsFromErrors([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], { event: { sessionId: undefined } }),
    "increase"
  );
  assert.equal(result.predictionOpportunityCount, 0);
  assert.equal(result.highConfidence, false);
  assert.equal(result.status, "collecting");
});

test("increase and decrease validation confidence stay isolated", () => {
  const increase = eventsFromErrors([0, 1, -1, 2, -2, 1, 0, 2, -1, 1], { sessions: 5 });
  const decrease = eventsFromErrors([0, 0, 0], {
    sessions: 3,
    direction: "decrease",
    fromResistance: 10,
    actualToResistance: 9,
    predicted: -3,
  });
  assert.equal(validateShadowDirection(increase, "increase").highConfidence, true);
  assert.equal(validateShadowDirection(decrease, "decrease").highConfidence, false);
  assert.equal(validateShadowDirection([...increase, ...decrease], "decrease").highConfidence, false);
  assert.equal(validateShadowDirection([...increase, ...decrease], "increase").highConfidence, true);
});

test("validation uses frozen predictedHrDeltaForActualStep, not the current model", () => {
  const stale = shadowEvent({
    sessionId: "frozen",
    modelMedianHrPerLevel: 4,
    predictedHrDeltaForActualStep: 4,
    observedHrDelta: 5,
  });
  stale.predictionErrorBpm = 99;
  stale.absolutePredictionErrorBpm = 99;
  stale.directionMatched = false;
  const result = validateShadowDirection([stale], "increase");
  assert.equal(result.medianSignedPredictionErrorBpm, 1);
  assert.equal(result.medianAbsolutePredictionErrorBpm, 1);
  assert.equal(result.directionMatchCount, 1);
});

test("duplicate completed-workout processing keeps the first frozen prediction", () => {
  const storage = memoryStorage();
  putDynamicsEntry(vo2LongKey, emptyDynamicsFields({ increaseHrPerLevel: [3, 4, 4, 5, 4] }), storage);
  const { summary, samples } = increaseWorkout({ sessionId: "dup-1" });
  const first = applyCompletedWorkoutShadowPredictions(summary, samples, storage);
  assert.equal(first.length, 1);
  const original = { ...first[0] };
  applyCompletedWorkoutDynamics(summary, samples, storage);
  const second = applyCompletedWorkoutShadowPredictions(summary, samples, storage);
  assert.equal(second.length, 0);
  const stored = getShadowPredictionEntry(vo2LongKey, storage).increase;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].modelSampleCount, original.modelSampleCount);
  assert.equal(stored[0].modelMedianHrPerLevel, original.modelMedianHrPerLevel);
  assert.equal(stored[0].predictedHrDeltaForActualStep, original.predictedHrDeltaForActualStep);
});

test("a zero-prediction first pass is frozen and cannot be filled in by later dynamics", () => {
  const storage = memoryStorage();
  putDynamicsEntry(vo2LongKey, emptyDynamicsFields({ increaseHrPerLevel: [3, 4, 4, 5] }), storage);
  const workoutA = increaseWorkout({ sessionId: "zero-a" });
  assert.equal(applyCompletedWorkoutShadowPredictions(workoutA.summary, workoutA.samples, storage).length, 0);
  assert.equal(hasProcessedShadowSession("zero-a", storage), true);
  assert.equal(getShadowPredictionEntry(vo2LongKey, storage)?.increase.length ?? 0, 0);
  applyCompletedWorkoutDynamics(workoutA.summary, workoutA.samples, storage);
  assert.equal(applyCompletedWorkoutShadowPredictions(workoutA.summary, workoutA.samples, storage).length, 0);
  assert.equal(getShadowPredictionEntry(vo2LongKey, storage)?.increase.length ?? 0, 0);
  const workoutB = increaseWorkout({ sessionId: "zero-b" });
  const later = applyCompletedWorkoutShadowPredictions(workoutB.summary, workoutB.samples, storage);
  assert.equal(later.length, 1);
  assert.equal(later[0].sessionId, "zero-b");
  assert.equal(later[0].modelSampleCount, 5);
});

test("legacy v1 events backfill processedSessions and survive reset", () => {
  const event = shadowEvent({ sessionId: "legacy-a" });
  const storage = memoryStorage({
    [SHADOW_PREDICTION_STORAGE_KEY]: JSON.stringify({
      version: 1,
      entries: {
        "proform-smart-power-10|1|bike|vo2_priority|long": {
          increase: [event],
          decrease: [],
          updatedAt: "t",
        },
      },
    }),
  });
  const loaded = loadShadowPredictionStore(storage);
  assert.equal(loaded.processedSessions.includes("legacy-a"), true);
  assert.equal(loaded.entries["proform-smart-power-10|1|bike|vo2_priority|long"].increase[0].sessionId, "legacy-a");
  putDynamicsEntry(vo2LongKey, emptyDynamicsFields({ increaseHrPerLevel: [3, 4, 4, 5, 4] }), storage);
  resetShadowPredictionsForMachine("proform-smart-power-10", storage);
  assert.equal(getShadowPredictionEntry(vo2LongKey, storage), undefined);
  assert.equal(hasProcessedShadowSession("legacy-a", storage), true);
  const workoutA = increaseWorkout({ sessionId: "legacy-a" });
  assert.equal(applyCompletedWorkoutShadowPredictions(workoutA.summary, workoutA.samples, storage).length, 0);
  assert.equal(getShadowPredictionEntry(vo2LongKey, storage)?.increase.length ?? 0, 0);
});

test("reprocessing an evicted session does not reintroduce a newer-model prediction", () => {
  const storage = memoryStorage();
  putDynamicsEntry(vo2LongKey, emptyDynamicsFields({ increaseHrPerLevel: [3, 4, 4, 5, 4] }), storage);
  const workoutA = increaseWorkout({ sessionId: "evict-a" });
  assert.equal(applyCompletedWorkoutShadowPredictions(workoutA.summary, workoutA.samples, storage).length, 1);
  for (let i = 1; i <= 20; i++) {
    const newer = increaseWorkout({ sessionId: `evict-new-${i}` });
    applyCompletedWorkoutShadowPredictions(newer.summary, newer.samples, storage);
  }
  const stored = getShadowPredictionEntry(vo2LongKey, storage).increase;
  assert.equal(stored.length, 20);
  assert.equal(stored.some((event) => event.sessionId === "evict-a"), false);
  const before = JSON.stringify(stored);
  assert.equal(applyCompletedWorkoutShadowPredictions(workoutA.summary, workoutA.samples, storage).length, 0);
  const after = getShadowPredictionEntry(vo2LongKey, storage).increase;
  assert.equal(JSON.stringify(after), before);
  assert.equal(after.some((event) => event.sessionId === "evict-a"), false);
});

test("different events in the same session are stored separately", () => {
  const storage = memoryStorage();
  const first = shadowEvent({ sessionId: "same", changeElapsedSeconds: 90, fromResistance: 8, actualToResistance: 9 });
  const second = shadowEvent({ sessionId: "same", changeElapsedSeconds: 150, fromResistance: 9, actualToResistance: 10 });
  assert.equal(persistShadowPredictions([first, second], storage).length, 2);
  assert.equal(persistShadowPredictions([first, second], storage).length, 0);
  const stored = getShadowPredictionEntry(vo2LongKey, storage).increase;
  assert.equal(stored.length, 2);
  assert.equal(stored[0].changeElapsedSeconds, 90);
  assert.equal(stored[1].changeElapsedSeconds, 150);
});

test("bounded store validation uses the newest 20 events", () => {
  const storage = memoryStorage();
  const oldest = shadowEvent({
    sessionId: "old",
    changeElapsedSeconds: 1,
    predictedHrDeltaForActualStep: 4,
    observedHrDelta: 24,
  });
  const newest = Array.from({ length: 20 }, (_, index) =>
    shadowEvent({
      sessionId: `new-${index + 1}`,
      changeElapsedSeconds: 10 + index,
      predictedHrDeltaForActualStep: 4,
      observedHrDelta: 4,
    })
  );
  persistShadowPredictions([oldest, ...newest], storage);
  const stored = getShadowPredictionEntry(vo2LongKey, storage).increase;
  assert.equal(stored.length, 20);
  assert.equal(stored.some((event) => event.sessionId === "old"), false);
  const result = validateShadowDirection(stored, "increase");
  assert.equal(result.predictionOpportunityCount, 20);
  assert.equal(result.medianAbsolutePredictionErrorBpm, 0);
  assert.equal(result.highConfidence, true);
});

test("public diagnostics expose derived validation status without a second store", () => {
  const storage = memoryStorage();
  persistShadowPredictions(eventsFromErrors([0, 1, -1, 2, -2, 1, 0, 2, -1, 1], { sessions: 5 }), storage);
  const listed = listShadowPredictions("proform-smart-power-10", storage);
  assert.equal(listed[0].increase.validationStatus, "validated");
  assert.equal(listed[0].increase.validationHighConfidence, true);
  assert.equal(listed[0].increase.validationOpportunityCount, 10);
  assert.equal(listed[0].increase.realizedPredictionCount, 10);
  assert.equal(listed[0].increase.distinctSessionCount, 5);
});
