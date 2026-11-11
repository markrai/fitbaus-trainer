import assert from "node:assert/strict";
import test from "node:test";
import {
  createMachineGuidanceState,
} from "../dist/machines/guidance.js";
import {
  getProFormSmartPower10Guidance,
} from "../dist/machines/proformSmartPower10.js";
import {
  delayMedianAbsoluteDeviation,
  deriveLongCooldownSeconds,
  deriveLongEarlyCooldownSeconds,
  deriveLongEarlyInitialEvaluationSeconds,
  deriveLongInitialEvaluationSeconds,
  deriveMediumEarlyEvaluationSeconds,
  deriveMediumInitialEvaluationSeconds,
  derivePersonalizedMachineTiming,
  hasActiveTimingPersonalization,
  highConfidenceRecentDelayEstimate,
  listHrDynamics,
  lookupPersonalizedTiming,
  putDynamicsEntry,
  resetHrDynamicsForMachine,
  timingModeForEntry,
  trustedDelayMedian,
} from "../dist/machines/dynamics/index.js";
import { putLearnedStart } from "../dist/machines/learning/index.js";
import { setSelectedMachine } from "../dist/machines/selection.js";
import {
  recordMachineHeartRateSample,
  resetMachineGuidanceRuntime,
  updateMachineGuidanceRuntime,
} from "../dist/machines/runtime.js";

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

function recent(bpm, count = 11) {
  return Array.from({ length: count }, (_, index) => ({ elapsedSeconds: index, bpm }));
}

function context(overrides = {}) {
  return {
    machineId: "proform-smart-power-10",
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:1",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 60,
    workoutElapsedSeconds: 0,
    intervalIndex: 1,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
    recentHeartRates: [],
    ...overrides,
  };
}

function delayEntry(overrides = {}) {
  return {
    workStartDelays: [],
    workStartHrDeltas: [],
    increaseDelays: [],
    increaseHrPerLevel: [],
    decreaseDelays: [],
    decreaseHrPerLevel: [],
    updatedAt: "t",
    ...overrides,
  };
}

const mediumKey = {
  machineId: "proform-smart-power-10",
  machineProfileVersion: 1,
  activity: "bike",
  intent: "vo2_primer",
  durationClass: "medium",
};

const longKey = {
  ...mediumKey,
  durationClass: "long",
};

function runtimeInput(overrides = {}) {
  return {
    sessionId: "timing-session",
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:1",
    phaseDisplayName: "hard",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 120,
    workoutElapsedSeconds: 0,
    intervalIndex: 1,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
    intent: "vo2_primer",
    ...overrides,
  };
}

function seedHr(sessionId, bpm, at = 50) {
  for (let elapsed = at; elapsed <= at + 10; elapsed++) {
    recordMachineHeartRateSample(sessionId, elapsed, bpm);
  }
}

test("too few delay samples are untrusted", () => {
  assert.equal(trustedDelayMedian([50, 52, 53, 54]), undefined);
});

test("stable five delay samples are trusted", () => {
  assert.equal(trustedDelayMedian([48, 51, 52, 54, 55]), 52);
  assert.equal(delayMedianAbsoluteDeviation([48, 51, 52, 54, 55]) <= 10, true);
});

test("a single outlier still yields a robust trusted median", () => {
  assert.equal(trustedDelayMedian([48, 50, 51, 52, 88]), 51);
  assert.equal(trustedDelayMedian([27, 29, 30, 31, 60]), 30);
});

test("noisy delay samples fail the MAD trust test", () => {
  assert.equal(trustedDelayMedian([20, 40, 60, 80, 90]), undefined);
  assert.equal(trustedDelayMedian([20, 25, 50, 70, 85]), undefined);
});

test("timing uses actual delay arrays, not UI sample-count maxima", () => {
  const entry = delayEntry({
    workStartDelays: [50, 52, 53, 54],
    workStartHrDeltas: [17, 16, 18, 15, 19],
  });
  assert.equal(trustedDelayMedian(entry.workStartDelays), undefined);
  assert.equal(derivePersonalizedMachineTiming(entry, 120), undefined);
  assert.equal(hasActiveTimingPersonalization(entry, "medium"), false);
});

test("medium timing stays at 60 without dynamics, with 4 samples, or a fast response", () => {
  assert.equal(deriveMediumInitialEvaluationSeconds(undefined, 120), 60);
  assert.equal(derivePersonalizedMachineTiming(undefined, 120), undefined);
  assert.equal(derivePersonalizedMachineTiming(delayEntry({ workStartDelays: [50, 52, 53, 54] }), 120), undefined);
  assert.equal(deriveMediumInitialEvaluationSeconds(30, 120), 60);
  assert.equal(derivePersonalizedMachineTiming(delayEntry({ workStartDelays: [27, 29, 30, 31, 32] }), 120), undefined);
});

test("medium timing uses median delay plus 15 with a 90-second guardrail", () => {
  assert.equal(deriveMediumInitialEvaluationSeconds(52, 120), 67);
  assert.deepEqual(
    derivePersonalizedMachineTiming(delayEntry({ workStartDelays: [48, 51, 52, 54, 55] }), 120),
    { initialEvaluationSeconds: 67 }
  );
  assert.equal(deriveMediumInitialEvaluationSeconds(84, 120), 90);
  assert.equal(deriveMediumInitialEvaluationSeconds(84, 76), 66);
});

test("long initial timing stays at 90 unless the trusted delay plus 20 is later", () => {
  assert.equal(deriveLongInitialEvaluationSeconds(undefined), 90);
  assert.equal(deriveLongInitialEvaluationSeconds(50), 90);
  assert.equal(deriveLongInitialEvaluationSeconds(80), 100);
  assert.equal(deriveLongInitialEvaluationSeconds(115), 120);
  assert.deepEqual(
    derivePersonalizedMachineTiming(delayEntry({ workStartDelays: [76, 78, 80, 81, 82] }), 240),
    { initialEvaluationSeconds: 100 }
  );
});

test("long cooldowns are independent and later-only", () => {
  assert.equal(deriveLongCooldownSeconds(undefined), 60);
  assert.equal(deriveLongCooldownSeconds(24), 60);
  assert.equal(deriveLongCooldownSeconds(58), 73);
  assert.equal(deriveLongCooldownSeconds(80), 90);
  const timing = derivePersonalizedMachineTiming(
    delayEntry({
      workStartDelays: [28, 29, 30, 31, 32],
      increaseDelays: [56, 58, 60, 61, 62],
      decreaseDelays: [22, 24, 25, 26, 28],
    }),
    240
  );
  assert.deepEqual(timing, { increaseCooldownSeconds: 75 });
});

test("short intervals ignore personalized timing even with trusted delays", () => {
  const timing = { initialEvaluationSeconds: 70, increaseCooldownSeconds: 80 };
  let result = getProFormSmartPower10Guidance(context({ personalizedTiming: timing }), createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 30, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  assert.equal(result.state.shortIntervalEvaluated, false);
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 59, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  assert.equal(result.state.nextWorkResistance, 12);
  assert.equal(derivePersonalizedMachineTiming(delayEntry({ workStartDelays: [48, 51, 52, 54, 55] }), 60), undefined);
});

test("medium workouts without dynamics still evaluate at 60 seconds", () => {
  const medium = context({ phaseDurationSeconds: 120 });
  let result = getProFormSmartPower10Guidance(medium, createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 59, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 10);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 60, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
});

test("personalized medium evaluation waits until 67 seconds", () => {
  const timing = { initialEvaluationSeconds: 67 };
  let result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  assert.equal(result.state.initialEvaluationSeconds, 67);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 60, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 10);
  assert.equal(result.state.mediumIntervalEvaluated, false);
  assert.match(result.guidance.reason, /observed heart-rate response/i);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 66, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 10);
  assert.equal(result.state.mediumIntervalEvaluated, false);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 67, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  assert.equal(result.state.mediumIntervalEvaluated, true);
});

test("long workouts without dynamics still evaluate at 90 then 60-second cooldown", () => {
  let result = getProFormSmartPower10Guidance(context({ phaseDurationSeconds: 240 }), createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 89, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 8);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 90, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 149, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 150, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 10);
});

test("personalized long initial evaluation waits until 100 seconds and does not consume state at 90", () => {
  const timing = { initialEvaluationSeconds: 100 };
  let result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 90, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 8);
  assert.equal(result.state.lastEvaluationPhaseElapsedSeconds, undefined);
  assert.match(result.guidance.reason, /observed heart-rate response/i);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 100, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  assert.equal(result.state.lastEvaluationPhaseElapsedSeconds, 100);
  assert.equal(result.state.lastWorkAdjustmentDirection, "increase");
});

test("personalized increase cooldown waits 75 seconds after R8 to R9", () => {
  const timing = { initialEvaluationSeconds: 100, increaseCooldownSeconds: 75 };
  let result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 100, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  assert.equal(result.state.currentEvaluationCooldownSeconds, 75);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 159, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 174, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  assert.match(result.guidance.reason, /observed heart-rate response/i);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 175, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 10);
});

test("increase and decrease cooldowns are isolated", () => {
  const timing = { increaseCooldownSeconds: 85 };
  let increased = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  increased = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 90, recentHeartRates: recent(150), personalizedTiming: timing }),
    increased.state
  );
  assert.equal(increased.guidance.resistance, 9);
  assert.equal(increased.state.lastWorkAdjustmentDirection, "increase");
  increased = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 150, recentHeartRates: recent(150), personalizedTiming: timing }),
    increased.state
  );
  assert.equal(increased.guidance.resistance, 9);
  increased = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 175, recentHeartRates: recent(150), personalizedTiming: timing }),
    increased.state
  );
  assert.equal(increased.guidance.resistance, 10);

  let decreased = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  decreased = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 90, recentHeartRates: recent(175), personalizedTiming: timing }),
    decreased.state
  );
  assert.equal(decreased.guidance.resistance, 7);
  assert.equal(decreased.state.lastWorkAdjustmentDirection, "decrease");
  assert.equal(decreased.state.currentEvaluationCooldownSeconds, 60);
  decreased = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 150, recentHeartRates: recent(175), personalizedTiming: timing }),
    decreased.state
  );
  assert.equal(decreased.guidance.resistance, 6);
});

test("work-start and in-work delay metrics personalize independently", () => {
  assert.deepEqual(
    derivePersonalizedMachineTiming(delayEntry({ workStartDelays: [76, 78, 80, 81, 82] }), 240),
    { initialEvaluationSeconds: 100 }
  );
  assert.deepEqual(
    derivePersonalizedMachineTiming(delayEntry({ increaseDelays: [56, 58, 60, 61, 62] }), 240),
    { increaseCooldownSeconds: 75 }
  );
});

test("runtime freezes medium timing for the phase and ignores later store changes", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putDynamicsEntry(mediumKey, delayEntry({ workStartDelays: [48, 51, 52, 54, 55] }), storage);
  resetMachineGuidanceRuntime("timing-session");
  let update = updateMachineGuidanceRuntime(runtimeInput(), storage);
  assert.equal(update?.guidance.resistance, 10);
  resetHrDynamicsForMachine("proform-smart-power-10", storage);
  seedHr("timing-session", 150, 50);
  update = updateMachineGuidanceRuntime(runtimeInput({ phaseElapsedSeconds: 60, workoutElapsedSeconds: 60 }), storage);
  assert.equal(update?.guidance.resistance, 10);
  update = updateMachineGuidanceRuntime(runtimeInput({ phaseElapsedSeconds: 67, workoutElapsedSeconds: 67 }), storage);
  assert.equal(update?.guidance.resistance, 11);
});

test("reset HR dynamics restores default timing on a new session", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putDynamicsEntry(mediumKey, delayEntry({ workStartDelays: [48, 51, 52, 54, 55] }), storage);
  assert.deepEqual(lookupPersonalizedTiming({ ...mediumKey, durationSeconds: 120 }, storage), {
    initialEvaluationSeconds: 67,
  });
  resetHrDynamicsForMachine("proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("timing-reset");
  seedHr("timing-reset", 150, 50);
  const update = updateMachineGuidanceRuntime(
    runtimeInput({ sessionId: "timing-reset", phaseElapsedSeconds: 60, workoutElapsedSeconds: 60 }),
    storage
  );
  assert.equal(update?.guidance.resistance, 11);
  assert.equal(lookupPersonalizedTiming({ ...mediumKey, durationSeconds: 120 }, storage), undefined);
});

test("learned starting resistance still applies when medium evaluation is delayed", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putLearnedStart(mediumKey, { resistance: 12, sampleCount: 1, updatedAt: "t" }, storage);
  putDynamicsEntry(mediumKey, delayEntry({ workStartDelays: [48, 51, 52, 54, 55] }), storage);
  resetMachineGuidanceRuntime("timing-learned");
  let update = updateMachineGuidanceRuntime(runtimeInput({ sessionId: "timing-learned" }), storage);
  assert.equal(update?.guidance.resistance, 12);
  seedHr("timing-learned", 150, 50);
  update = updateMachineGuidanceRuntime(
    runtimeInput({ sessionId: "timing-learned", phaseElapsedSeconds: 60, workoutElapsedSeconds: 60 }),
    storage
  );
  assert.equal(update?.guidance.resistance, 12);
  update = updateMachineGuidanceRuntime(
    runtimeInput({ sessionId: "timing-learned", phaseElapsedSeconds: 67, workoutElapsedSeconds: 67 }),
    storage
  );
  assert.equal(update?.guidance.resistance, 13);
});

test("later-only timing still personalizes when detection rate is only 50 percent", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putDynamicsEntry(
    mediumKey,
    delayEntry({
      workStartDelays: [48, 51, 52, 54, 55],
      workStartObservationCount: 20,
      workStartDetectedResponseCount: 10,
    }),
    storage
  );
  assert.deepEqual(lookupPersonalizedTiming({ ...mediumKey, durationSeconds: 120 }, storage), {
    initialEvaluationSeconds: 67,
  });
});

test("later-only timing still personalizes when recent detection rate is only 25 percent", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putDynamicsEntry(
    mediumKey,
    delayEntry({
      workStartDelays: [48, 51, 52, 54, 55],
      workStartObservationCount: 120,
      workStartDetectedResponseCount: 100,
      workStartRecentResponses: [...Array(15).fill(null), 48, 51, 52, 54, 55],
    }),
    storage
  );
  assert.deepEqual(lookupPersonalizedTiming({ ...mediumKey, durationSeconds: 120 }, storage), {
    initialEvaluationSeconds: 67,
  });
});

test("waiting for personalized timing does not append a trace or voice event", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putDynamicsEntry(mediumKey, delayEntry({ workStartDelays: [48, 51, 52, 54, 55] }), storage);
  resetMachineGuidanceRuntime("timing-quiet");
  const first = updateMachineGuidanceRuntime(runtimeInput({ sessionId: "timing-quiet" }), storage);
  seedHr("timing-quiet", 150, 50);
  const later = updateMachineGuidanceRuntime(
    runtimeInput({ sessionId: "timing-quiet", phaseElapsedSeconds: 60, workoutElapsedSeconds: 60 }),
    storage
  );
  assert.equal(later?.recommendationChanged, false);
  assert.equal(later?.voiceEvent, null);
  assert.equal(first?.guidance.resistance, later?.guidance.resistance);
});

function clusteredAround(center) {
  return [center - 2, center - 1, center, center, center, center + 1, center, center - 1, center + 1, center];
}

const stableTen = [28, 29, 30, 31, 30, 29, 32, 30, 31, 29];
const robustOutlierTen = [29, 30, 31, 30, 29, 31, 30, 32, 30, 70];
const splitTen = [30, 30, 30, 30, 30, 30, 60, 60, 60, 60];
const noisyTen = [20, 22, 24, 26, 28, 40, 42, 44, 46, 48];
const twentyFast = [...stableTen, 28, 30, 31, 29, 30, 32, 30, 29, 31, 30];

test("nine recent detections are not high confidence", () => {
  assert.equal(highConfidenceRecentDelayEstimate(stableTen.slice(0, 9)), undefined);
});

test("ten stable recent detections are high confidence", () => {
  const estimate = highConfidenceRecentDelayEstimate(stableTen);
  assert.ok(estimate);
  assert.equal(estimate.detectedCount, 10);
  assert.equal(estimate.observationCount, 10);
  assert.equal(estimate.detectionRate, 1);
  assert.equal(estimate.medianSeconds, 30);
  assert.equal(estimate.madSeconds <= 5, true);
  assert.equal(estimate.concentration >= 0.7, true);
});

test("a 50 percent recent detection rate is not high confidence", () => {
  assert.equal(highConfidenceRecentDelayEstimate([...stableTen, ...Array(10).fill(null)]), undefined);
});

test("ten detections and two nulls can still be high confidence", () => {
  const estimate = highConfidenceRecentDelayEstimate([...stableTen, null, null]);
  assert.ok(estimate);
  assert.equal(estimate.detectionRate, 10 / 12);
});

test("ten detections and three nulls fail the detection-rate gate", () => {
  assert.equal(highConfidenceRecentDelayEstimate([...stableTen, null, null, null]), undefined);
});

test("high MAD fails high-confidence recent timing", () => {
  assert.equal(highConfidenceRecentDelayEstimate(noisyTen), undefined);
});

test("low concentration fails even when MAD looks small", () => {
  const estimate = highConfidenceRecentDelayEstimate(splitTen);
  assert.equal(estimate, undefined);
  assert.equal(delayMedianAbsoluteDeviation(splitTen) <= 5, true);
});

test("a single recent outlier does not destroy a tight cluster", () => {
  const estimate = highConfidenceRecentDelayEstimate(robustOutlierTen);
  assert.ok(estimate);
  assert.equal(estimate.medianSeconds, 30);
  assert.equal(estimate.concentration, 0.9);
});

test("old delay arrays without recent opportunities cannot earn earlier timing", () => {
  const entry = delayEntry({
    workStartDelays: twentyFast,
    workStartObservationCount: 100,
    workStartDetectedResponseCount: 95,
    workStartRecentResponses: [],
  });
  assert.equal(highConfidenceRecentDelayEstimate(entry.workStartRecentResponses), undefined);
  assert.equal(derivePersonalizedMachineTiming(entry, 120), undefined);
  assert.equal(derivePersonalizedMachineTiming(entry, 240), undefined);
});

test("lifetime counts do not grant earlier timing", () => {
  assert.equal(
    derivePersonalizedMachineTiming(
      delayEntry({
        workStartDelays: twentyFast,
        workStartObservationCount: 100,
        workStartDetectedResponseCount: 95,
      }),
      120
    ),
    undefined
  );
});

test("medium early timing uses recent median plus 15 with a 45-second floor", () => {
  assert.equal(deriveMediumEarlyEvaluationSeconds(24, 120), 45);
  assert.equal(deriveMediumEarlyEvaluationSeconds(32, 120), 47);
  assert.equal(deriveMediumEarlyEvaluationSeconds(50, 120), undefined);
  assert.deepEqual(
    derivePersonalizedMachineTiming(delayEntry({ workStartRecentResponses: clusteredAround(24) }), 120),
    { initialEvaluationSeconds: 45 }
  );
  assert.deepEqual(
    derivePersonalizedMachineTiming(delayEntry({ workStartRecentResponses: clusteredAround(32) }), 120),
    { initialEvaluationSeconds: 47 }
  );
});

test("high-confidence recent evidence can supersede slower later-only medium timing", () => {
  assert.deepEqual(
    derivePersonalizedMachineTiming(
      delayEntry({
        workStartDelays: [48, 51, 52, 54, 55],
        workStartRecentResponses: [...stableTen, null, null],
      }),
      120
    ),
    { initialEvaluationSeconds: 45 }
  );
});

test("a 50 percent recent detection rate still does not shorten medium timing", () => {
  assert.deepEqual(
    derivePersonalizedMachineTiming(
      delayEntry({
        workStartRecentResponses: [...stableTen, ...Array(10).fill(null)],
      }),
      120
    ),
    undefined
  );
});

test("long early initial timing uses recent median plus 20 with a 60-second floor", () => {
  assert.equal(deriveLongEarlyInitialEvaluationSeconds(30), 60);
  assert.equal(deriveLongEarlyInitialEvaluationSeconds(45), 65);
  assert.equal(deriveLongEarlyInitialEvaluationSeconds(80), undefined);
  assert.deepEqual(
    derivePersonalizedMachineTiming(delayEntry({ workStartRecentResponses: clusteredAround(30) }), 240),
    { initialEvaluationSeconds: 60 }
  );
  assert.deepEqual(
    derivePersonalizedMachineTiming(delayEntry({ workStartRecentResponses: clusteredAround(45) }), 240),
    { initialEvaluationSeconds: 65 }
  );
});

test("long early cooldowns are independent and never share recent populations", () => {
  assert.equal(deriveLongEarlyCooldownSeconds(22), 45);
  assert.equal(deriveLongEarlyCooldownSeconds(38), 53);
  assert.equal(deriveLongEarlyCooldownSeconds(60), undefined);
  assert.deepEqual(
    derivePersonalizedMachineTiming(
      delayEntry({
        increaseRecentResponses: clusteredAround(22),
        decreaseRecentResponses: clusteredAround(38),
      }),
      240
    ),
    { increaseCooldownSeconds: 45, decreaseCooldownSeconds: 53 }
  );
  assert.deepEqual(
    derivePersonalizedMachineTiming(delayEntry({ increaseRecentResponses: clusteredAround(22) }), 240),
    { increaseCooldownSeconds: 45 }
  );
});

test("settings timing mode is earlier, extended, or mixed", () => {
  assert.equal(
    timingModeForEntry(delayEntry({ workStartRecentResponses: clusteredAround(32) }), "medium"),
    "earlier"
  );
  assert.equal(
    timingModeForEntry(delayEntry({ workStartDelays: [48, 51, 52, 54, 55] }), "medium"),
    "extended"
  );
  assert.equal(
    timingModeForEntry(
      delayEntry({
        workStartRecentResponses: clusteredAround(45),
        increaseDelays: [56, 58, 60, 61, 62],
      }),
      "long"
    ),
    "mixed"
  );
  const storage = memoryStorage();
  putDynamicsEntry(mediumKey, delayEntry({ workStartRecentResponses: clusteredAround(32) }), storage);
  assert.equal(listHrDynamics("proform-smart-power-10", storage)[0].timingMode, "earlier");
});

test("personalized medium evaluation can occur at 45 seconds", () => {
  const timing = { initialEvaluationSeconds: 45 };
  let result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  assert.match(result.guidance.reason, /observed heart-rate response/i);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 44, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 10);
  assert.equal(result.state.mediumIntervalEvaluated, false);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 45, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  assert.equal(result.state.mediumIntervalEvaluated, true);
});

test("personalized medium evaluation can occur at 47 seconds", () => {
  const timing = { initialEvaluationSeconds: 47 };
  let result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 46, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 10);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 47, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
});

test("low recent detection rate keeps medium evaluation at 60 seconds", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putDynamicsEntry(
    mediumKey,
    delayEntry({ workStartRecentResponses: [...stableTen, ...Array(10).fill(null)] }),
    storage
  );
  assert.equal(lookupPersonalizedTiming({ ...mediumKey, durationSeconds: 120 }, storage), undefined);
  resetMachineGuidanceRuntime("timing-low-recent");
  seedHr("timing-low-recent", 150, 50);
  const update = updateMachineGuidanceRuntime(
    runtimeInput({ sessionId: "timing-low-recent", phaseElapsedSeconds: 60, workoutElapsedSeconds: 60 }),
    storage
  );
  assert.equal(update?.guidance.resistance, 11);
});

test("short intervals ignore high-confidence recent timing", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putDynamicsEntry(mediumKey, delayEntry({ workStartRecentResponses: twentyFast }), storage);
  assert.equal(lookupPersonalizedTiming({ ...mediumKey, durationSeconds: 60 }, storage), undefined);
  const timing = { initialEvaluationSeconds: 45 };
  let result = getProFormSmartPower10Guidance(context({ personalizedTiming: timing }), createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 45, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  assert.equal(result.state.shortIntervalEvaluated, false);
});

test("personalized long initial evaluation can occur at 60 seconds", () => {
  const timing = { initialEvaluationSeconds: 60 };
  let result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 59, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 8);
  assert.equal(result.state.lastEvaluationPhaseElapsedSeconds, undefined);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 60, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  assert.equal(result.state.lastEvaluationPhaseElapsedSeconds, 60);
});

test("personalized long initial evaluation can occur at 65 seconds", () => {
  const timing = { initialEvaluationSeconds: 65 };
  let result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 64, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 8);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 65, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
});

test("missing HR at an earlier long deadline does not consume evaluation state", () => {
  const timing = { initialEvaluationSeconds: 60 };
  let result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 60, personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 8);
  assert.equal(result.state.lastEvaluationPhaseElapsedSeconds, undefined);
});

test("personalized increase cooldown can occur 45 seconds after R8 to R9", () => {
  const timing = { increaseCooldownSeconds: 45 };
  let result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 90, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  assert.equal(result.state.currentEvaluationCooldownSeconds, 45);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 134, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 135, recentHeartRates: recent(150), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.resistance, 10);
});

test("personalized decrease cooldown can occur 53 seconds after R10 to R9", () => {
  const timing = { decreaseCooldownSeconds: 53 };
  let result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, personalizedTiming: timing, learnedStartingResistance: 10 }),
    createMachineGuidanceState()
  );
  assert.equal(result.guidance.resistance, 10);
  result = getProFormSmartPower10Guidance(
    context({
      phaseDurationSeconds: 240,
      phaseElapsedSeconds: 90,
      recentHeartRates: recent(175),
      personalizedTiming: timing,
      learnedStartingResistance: 10,
    }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  assert.equal(result.state.currentEvaluationCooldownSeconds, 53);
  result = getProFormSmartPower10Guidance(
    context({
      phaseDurationSeconds: 240,
      phaseElapsedSeconds: 142,
      recentHeartRates: recent(175),
      personalizedTiming: timing,
    }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  result = getProFormSmartPower10Guidance(
    context({
      phaseDurationSeconds: 240,
      phaseElapsedSeconds: 143,
      recentHeartRates: recent(175),
      personalizedTiming: timing,
    }),
    result.state
  );
  assert.equal(result.guidance.resistance, 8);
});

test("increase and decrease early cooldowns stay isolated", () => {
  const timing = { increaseCooldownSeconds: 45 };
  let increased = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  increased = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 90, recentHeartRates: recent(150), personalizedTiming: timing }),
    increased.state
  );
  assert.equal(increased.state.currentEvaluationCooldownSeconds, 45);
  let decreased = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  decreased = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 90, recentHeartRates: recent(175), personalizedTiming: timing }),
    decreased.state
  );
  assert.equal(decreased.guidance.resistance, 7);
  assert.equal(decreased.state.currentEvaluationCooldownSeconds, 60);
});

test("a HOLD evaluation keeps a 60-second cooldown despite early directional evidence", () => {
  const timing = { increaseCooldownSeconds: 45, decreaseCooldownSeconds: 53 };
  let result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, personalizedTiming: timing }),
    createMachineGuidanceState()
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 90, recentHeartRates: recent(165), personalizedTiming: timing }),
    result.state
  );
  assert.equal(result.guidance.action, "hold");
  assert.equal(result.state.currentEvaluationCooldownSeconds, 60);
});

test("runtime freezes earlier medium timing for the phase and restores default after reset", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putDynamicsEntry(mediumKey, delayEntry({ workStartRecentResponses: clusteredAround(32) }), storage);
  resetMachineGuidanceRuntime("timing-early-freeze");
  let update = updateMachineGuidanceRuntime(runtimeInput({ sessionId: "timing-early-freeze" }), storage);
  assert.equal(update?.guidance.resistance, 10);
  resetHrDynamicsForMachine("proform-smart-power-10", storage);
  seedHr("timing-early-freeze", 150, 40);
  update = updateMachineGuidanceRuntime(
    runtimeInput({ sessionId: "timing-early-freeze", phaseElapsedSeconds: 46, workoutElapsedSeconds: 46 }),
    storage
  );
  assert.equal(update?.guidance.resistance, 10);
  update = updateMachineGuidanceRuntime(
    runtimeInput({ sessionId: "timing-early-freeze", phaseElapsedSeconds: 47, workoutElapsedSeconds: 47 }),
    storage
  );
  assert.equal(update?.guidance.resistance, 11);
  resetMachineGuidanceRuntime("timing-early-next");
  seedHr("timing-early-next", 150, 50);
  update = updateMachineGuidanceRuntime(
    runtimeInput({ sessionId: "timing-early-next", phaseElapsedSeconds: 60, workoutElapsedSeconds: 60 }),
    storage
  );
  assert.equal(update?.guidance.resistance, 11);
});

test("learned starting resistance still applies when medium evaluation is earlier", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putLearnedStart(mediumKey, { resistance: 12, sampleCount: 1, updatedAt: "t" }, storage);
  putDynamicsEntry(mediumKey, delayEntry({ workStartRecentResponses: clusteredAround(32) }), storage);
  resetMachineGuidanceRuntime("timing-learned-early");
  let update = updateMachineGuidanceRuntime(runtimeInput({ sessionId: "timing-learned-early" }), storage);
  assert.equal(update?.guidance.resistance, 12);
  seedHr("timing-learned-early", 150, 40);
  update = updateMachineGuidanceRuntime(
    runtimeInput({ sessionId: "timing-learned-early", phaseElapsedSeconds: 46, workoutElapsedSeconds: 46 }),
    storage
  );
  assert.equal(update?.guidance.resistance, 12);
  update = updateMachineGuidanceRuntime(
    runtimeInput({ sessionId: "timing-learned-early", phaseElapsedSeconds: 47, workoutElapsedSeconds: 47 }),
    storage
  );
  assert.equal(update?.guidance.resistance, 13);
});

test("waiting for earlier timing does not append a trace or voice event", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putDynamicsEntry(mediumKey, delayEntry({ workStartRecentResponses: clusteredAround(32) }), storage);
  resetMachineGuidanceRuntime("timing-early-quiet");
  const first = updateMachineGuidanceRuntime(runtimeInput({ sessionId: "timing-early-quiet" }), storage);
  seedHr("timing-early-quiet", 150, 40);
  const later = updateMachineGuidanceRuntime(
    runtimeInput({ sessionId: "timing-early-quiet", phaseElapsedSeconds: 46, workoutElapsedSeconds: 46 }),
    storage
  );
  assert.equal(later?.recommendationChanged, false);
  assert.equal(later?.voiceEvent, null);
  assert.equal(first?.guidance.resistance, later?.guidance.resistance);
  assert.match(later?.guidance.reason ?? "", /observed heart-rate response/i);
});
