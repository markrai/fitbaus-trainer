import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  clampAutomaticResistance,
  getEstimatedWattsAt70Rpm,
  getProFormSmartPower10Guidance,
  VO2_PRIORITY_INITIAL_EVALUATION_SECONDS,
} from "../dist/machines/proformSmartPower10.js";
import { createMachineGuidanceState, getMachineGuidance } from "../dist/machines/guidance.js";
import { getMachineDefinition, listMachinesForActivity } from "../dist/machines/registry.js";
import {
  EQUIPMENT_STORAGE_KEY,
  getEquipmentSelection,
  resolveSelectedMachine,
  setSelectedMachine,
} from "../dist/machines/selection.js";
import {
  getMachineUsageSnapshot,
  recordMachineHeartRateSample,
  resetMachineGuidanceRuntime,
  updateMachineGuidanceRuntime,
} from "../dist/machines/runtime.js";
import { formatMachineGuidanceSpeech, getMachineGuidanceVoiceKey } from "../dist/voice.js";
import { buildSisuWorkoutPayload } from "../dist/sisuSync.js";
import { applyMachineUsageToSummary, applyWorkoutActivityToSummary } from "../dist/workoutSummary.js";
import {
  getActiveWorkoutActivity,
  requireAllowedActivity,
} from "../dist/workoutActivity.js";
import { clearSession, getSession, startSession } from "../dist/sessionStore.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function recent(bpm, count = 11) {
  return Array.from({ length: count }, (_, index) => ({ elapsedSeconds: index, bpm }));
}

function samplesAt(bpm, elapsedSeconds) {
  return elapsedSeconds.map((elapsed) => ({ elapsedSeconds: elapsed, bpm }));
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

test("registry resolves only the supported ProForm bike", () => {
  const machine = getMachineDefinition("proform-smart-power-10");
  assert.equal(machine?.name, "ProForm SMART Power 10.0");
  assert.equal(machine?.activity, "bike");
  assert.deepEqual(listMachinesForActivity("bike").map((entry) => entry.id), ["proform-smart-power-10"]);
  assert.equal(getMachineDefinition("unknown-machine"), undefined);
});

test("empirical calibration is limited to resistance 1 through 15", () => {
  const expected = {
    1: 66, 2: 69, 3: 70, 4: 78, 5: 82, 6: 86, 7: 97,
    8: 108, 9: 114, 10: 123, 11: 134, 12: 147, 13: 156, 14: 180, 15: 201,
  };
  for (const [resistance, watts] of Object.entries(expected)) {
    assert.equal(getEstimatedWattsAt70Rpm(Number(resistance)), watts);
  }
  assert.equal(getEstimatedWattsAt70Rpm(16), undefined);
  assert.equal(getEstimatedWattsAt70Rpm(22), undefined);
  assert.equal(clampAutomaticResistance(16), 15);
  assert.equal(clampAutomaticResistance(0), 1);
});

test("recovery starts easy, never reacts upward to low HR, and can reduce to one", () => {
  let result = getProFormSmartPower10Guidance(
    context({ phaseKind: "recovery", phaseId: "recovery:1", phaseDurationSeconds: 60, targetHeartRateMin: 120, targetHeartRateMax: 135 }),
    createMachineGuidanceState()
  );
  assert.equal(result.guidance.resistance, 2);
  assert.equal(result.guidance.cadenceRpm, 63);
  assert.equal(result.guidance.estimatedWatts, undefined);
  result = getProFormSmartPower10Guidance(
    context({ phaseKind: "recovery", phaseId: "recovery:1", phaseElapsedSeconds: 40, phaseDurationSeconds: 60, targetHeartRateMin: 120, targetHeartRateMax: 135, recentHeartRates: recent(105) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 2);
  result = getProFormSmartPower10Guidance(
    context({ phaseKind: "recovery", phaseId: "recovery:1", phaseElapsedSeconds: 45, phaseDurationSeconds: 60, targetHeartRateMin: 120, targetHeartRateMax: 135, recentHeartRates: recent(140) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 1);
  result = getProFormSmartPower10Guidance(
    context({ phaseKind: "recovery", phaseId: "recovery:1", phaseElapsedSeconds: 50, phaseDurationSeconds: 60, targetHeartRateMin: 120, targetHeartRateMax: 135, recentHeartRates: recent(145) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 1);
});

test("short intervals hold during the rep and adapt only the next repetition", () => {
  let state = createMachineGuidanceState();
  let result = getProFormSmartPower10Guidance(context(), state);
  assert.equal(result.guidance.resistance, 11);
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 30, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  assert.equal(result.state.nextWorkResistance, 11);
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 45, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  assert.equal(result.state.nextWorkResistance, 11);
  assert.equal(result.state.shortIntervalEvaluated, false);
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 59, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  assert.equal(result.state.nextWorkResistance, 12);
  assert.equal(result.state.shortIntervalEvaluated, true);
  result = getProFormSmartPower10Guidance(
    context({ phaseId: "work:2", workoutElapsedSeconds: 120, intervalIndex: 2 }),
    result.state
  );
  assert.equal(result.guidance.resistance, 12);
});

test("short-interval final HR holds in range and reduces when high", () => {
  let result = getProFormSmartPower10Guidance(context(), createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 45, recentHeartRates: recent(165) }),
    result.state
  );
  assert.equal(result.state.nextWorkResistance, 11);
  assert.equal(result.state.shortIntervalEvaluated, false);
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 59, recentHeartRates: recent(165) }),
    result.state
  );
  assert.equal(result.state.nextWorkResistance, 11);
  assert.equal(result.state.shortIntervalEvaluated, true);

  result = getProFormSmartPower10Guidance(context(), createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 59, recentHeartRates: recent(175) }),
    result.state
  );
  assert.equal(result.state.nextWorkResistance, 10);
});

test("short-interval automatic guidance never exceeds resistance 15", () => {
  const state = { ...createMachineGuidanceState(), nextWorkResistance: 15 };
  let result = getProFormSmartPower10Guidance(context(), state);
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 59, recentHeartRates: recent(140) }),
    result.state
  );
  assert.equal(result.state.nextWorkResistance, 15);
});

test("medium intervals wait 60 seconds and adjust at most once", () => {
  const medium = context({ phaseDurationSeconds: 120 });
  let result = getProFormSmartPower10Guidance(medium, createMachineGuidanceState());
  assert.equal(result.guidance.resistance, 10);
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
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 100, recentHeartRates: recent(145) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
});

test("long intervals stabilize for 90 seconds and enforce a 60-second cooldown", () => {
  let result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240 }),
    createMachineGuidanceState()
  );
  assert.equal(result.guidance.resistance, 8);
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
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 120, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 150, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 10);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 210, recentHeartRates: recent(175) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 270, recentHeartRates: recent(165) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
});

test("four-minute VO2-priority work evaluates at 60 seconds when HR is clearly low", () => {
  let result = getProFormSmartPower10Guidance(
    context({
      intent: "vo2_priority",
      phaseDurationSeconds: 240,
      personalizedTiming: { initialEvaluationSeconds: 100 },
    }),
    createMachineGuidanceState()
  );
  assert.equal(result.guidance.resistance, 8);
  assert.equal(result.workPhaseStarted.initialEvaluationWaitSeconds, VO2_PRIORITY_INITIAL_EVALUATION_SECONDS);
  result = getProFormSmartPower10Guidance(
    context({ intent: "vo2_priority", phaseDurationSeconds: 240, phaseElapsedSeconds: 59, recentHeartRates: recent(130) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 8);
  result = getProFormSmartPower10Guidance(
    context({ intent: "vo2_priority", phaseDurationSeconds: 240, phaseElapsedSeconds: 60, recentHeartRates: recent(130) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  assert.equal(result.guidance.action, "increase");

  result = getProFormSmartPower10Guidance(
    context({ intent: "vo2_priority", phaseDurationSeconds: 240, phaseElapsedSeconds: 119, recentHeartRates: recent(130) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  assert.equal(result.guidance.action, "hold");
});

test("longer aerobic work retains 90-second stabilization and learned start keeps precedence", () => {
  let aerobic = getProFormSmartPower10Guidance(
    context({ intent: "aerobic_volume", phaseDurationSeconds: 600 }),
    createMachineGuidanceState()
  );
  assert.equal(aerobic.workPhaseStarted.initialEvaluationWaitSeconds, 90);
  aerobic = getProFormSmartPower10Guidance(
    context({ intent: "aerobic_volume", phaseDurationSeconds: 600, phaseElapsedSeconds: 60, recentHeartRates: recent(130) }),
    aerobic.state
  );
  assert.equal(aerobic.guidance.resistance, 8);

  const learned = getProFormSmartPower10Guidance(
    context({ intent: "vo2_priority", phaseDurationSeconds: 240, learnedStartingResistance: 10 }),
    createMachineGuidanceState()
  );
  assert.equal(learned.guidance.resistance, 10);
  assert.match(learned.guidance.reason, /Learned starting resistance/);
  assert.equal(learned.workPhaseStarted.initialEvaluationWaitSeconds, 60);
});

test("shadow prescription and machine-prediction values have no controller input", async () => {
  const runtimeSource = await readFile(new URL("../src/machines/runtime.ts", import.meta.url), "utf8");
  assert.equal(runtimeSource.includes("candidatePower"), false);
  assert.equal(runtimeSource.includes("shadowSuggestedResistance"), false);
  assert.equal(runtimeSource.includes("shadowPrescription"), false);

  const baseline = getProFormSmartPower10Guidance(
    context({ intent: "vo2_priority", phaseDurationSeconds: 240 }),
    createMachineGuidanceState()
  );
  const forged = getProFormSmartPower10Guidance(
    context({
      intent: "vo2_priority",
      phaseDurationSeconds: 240,
      personalizationCandidateWatts: 999,
      shadowSuggestedResistance: 15,
    }),
    createMachineGuidanceState()
  );
  assert.deepEqual(forged.guidance, baseline.guidance);
});

test("missing HR or targets does not consume work evaluations", () => {
  let result = getProFormSmartPower10Guidance(context(), createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 59, recentHeartRates: [] }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  assert.equal(result.state.nextWorkResistance, 11);
  assert.equal(result.state.shortIntervalEvaluated, false);
  assert.match(result.guidance.reason, /held for the full repetition/i);
  result = getProFormSmartPower10Guidance(
    context({
      phaseElapsedSeconds: 59,
      recentHeartRates: recent(150),
      targetHeartRateMin: undefined,
      targetHeartRateMax: undefined,
    }),
    result.state
  );
  assert.equal(result.state.shortIntervalEvaluated, false);
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 59, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.state.shortIntervalEvaluated, true);
  assert.equal(result.state.nextWorkResistance, 12);

  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120 }),
    createMachineGuidanceState()
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 60, recentHeartRates: [] }),
    result.state
  );
  assert.equal(result.guidance.resistance, 10);
  assert.equal(result.state.mediumIntervalEvaluated, false);
  assert.match(result.guidance.reason, /Waiting 60 seconds/i);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 61, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  assert.equal(result.state.mediumIntervalEvaluated, true);

  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240 }),
    createMachineGuidanceState()
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 90, recentHeartRates: [] }),
    result.state
  );
  assert.equal(result.guidance.resistance, 8);
  assert.equal(result.state.lastEvaluationPhaseElapsedSeconds, undefined);
  assert.match(result.guidance.reason, /Waiting 90 seconds/i);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 91, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  assert.equal(result.state.lastEvaluationPhaseElapsedSeconds, 91);
});

test("work adaptation requires at least five distinct HR seconds spanning four seconds", () => {
  const oneSample = samplesAt(150, [59]);
  const sameSecond = Array.from({ length: 5 }, () => ({ elapsedSeconds: 59, bpm: 150 }));
  const tooShortSpan = samplesAt(150, [55, 56, 57, 58, 58]);
  const clustered = samplesAt(150, [55, 55.25, 55.5, 55.75, 56]);
  const sufficient = samplesAt(150, [54, 55, 56, 57, 58]);

  let result = getProFormSmartPower10Guidance(context(), createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 59, recentHeartRates: oneSample }),
    result.state
  );
  assert.equal(result.state.shortIntervalEvaluated, false);
  assert.equal(result.state.nextWorkResistance, 11);

  result = getProFormSmartPower10Guidance(
    context({
      phaseKind: "recovery",
      phaseId: "recovery:1",
      completedShortWork: {
        phaseId: "work:1",
        phaseDurationSeconds: 60,
        resistance: 11,
        targetHeartRateMin: 160,
        targetHeartRateMax: 170,
        recentHeartRates: sameSecond,
      },
    }),
    result.state
  );
  assert.equal(result.guidance.resistance, 2);
  assert.equal(result.state.nextWorkResistance, 11);

  result = getProFormSmartPower10Guidance(context(), createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 59, recentHeartRates: tooShortSpan }),
    result.state
  );
  assert.equal(result.state.shortIntervalEvaluated, false);
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 59, recentHeartRates: clustered }),
    result.state
  );
  assert.equal(result.state.shortIntervalEvaluated, false);

  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 59, recentHeartRates: sufficient }),
    result.state
  );
  assert.equal(result.state.shortIntervalEvaluated, true);
  assert.equal(result.state.nextWorkResistance, 12);

  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120 }),
    createMachineGuidanceState()
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 60, recentHeartRates: oneSample }),
    result.state
  );
  assert.equal(result.guidance.resistance, 10);
  assert.equal(result.state.mediumIntervalEvaluated, false);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 61, recentHeartRates: sufficient }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  assert.equal(result.state.mediumIntervalEvaluated, true);

  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240 }),
    createMachineGuidanceState()
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 90, recentHeartRates: sameSecond }),
    result.state
  );
  assert.equal(result.guidance.resistance, 8);
  assert.equal(result.state.lastEvaluationPhaseElapsedSeconds, undefined);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 91, recentHeartRates: sufficient }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  assert.equal(result.state.lastEvaluationPhaseElapsedSeconds, 91);
});

test("resistance 13 and 14 require a five-bpm deficit and resistance 15 cannot increase", () => {
  for (const resistance of [13, 14]) {
    let result = getProFormSmartPower10Guidance(
      context(),
      { ...createMachineGuidanceState(), nextWorkResistance: resistance }
    );
    result = getProFormSmartPower10Guidance(
      context({ phaseElapsedSeconds: 59, recentHeartRates: recent(156) }),
      result.state
    );
    assert.equal(result.state.nextWorkResistance, resistance);

    result = getProFormSmartPower10Guidance(
      context(),
      { ...createMachineGuidanceState(), nextWorkResistance: resistance }
    );
    result = getProFormSmartPower10Guidance(
      context({ phaseElapsedSeconds: 59, recentHeartRates: recent(155) }),
      result.state
    );
    assert.equal(result.state.nextWorkResistance, resistance + 1);
  }

  let result = getProFormSmartPower10Guidance(
    context(),
    { ...createMachineGuidanceState(), nextWorkResistance: 15 }
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 59, recentHeartRates: recent(140) }),
    result.state
  );
  assert.equal(result.state.nextWorkResistance, 15);
});

test("generic guidance applies only to a matching selected activity", () => {
  assert.ok(getMachineGuidance(context(), createMachineGuidanceState()));
  assert.equal(
    getMachineGuidance(context({ activity: "elliptical" }), createMachineGuidanceState()),
    null
  );
  const empty = memoryStorage();
  assert.equal(resolveSelectedMachine("bike", empty), undefined);
  const selected = setSelectedMachine("bike", "proform-smart-power-10", empty);
  assert.equal(selected.bike, "proform-smart-power-10");
  assert.equal(resolveSelectedMachine("bike", empty)?.id, "proform-smart-power-10");
  assert.equal(resolveSelectedMachine("elliptical", empty), undefined);
});

test("equipment selection round-trips independently", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  assert.deepEqual(getEquipmentSelection(storage), { bike: "proform-smart-power-10" });
  assert.equal(storage.getItem(EQUIPMENT_STORAGE_KEY), '{"bike":"proform-smart-power-10"}');
  setSelectedMachine("bike", undefined, storage);
  assert.deepEqual(getEquipmentSelection(storage), {});
});

test("invalid equipment machine IDs are sanitized and profile storage is untouched", () => {
  const storage = memoryStorage({
    [EQUIPMENT_STORAGE_KEY]: JSON.stringify({ bike: "not-a-real-machine", elliptical: "proform-smart-power-10" }),
    profile: JSON.stringify({ maxHr: 190, restingHr: 55 }),
  });
  assert.deepEqual(getEquipmentSelection(storage), {});
  assert.equal(storage.getItem("profile"), JSON.stringify({ maxHr: 190, restingHr: 55 }));
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  assert.deepEqual(getEquipmentSelection(storage), { bike: "proform-smart-power-10" });
  assert.equal(storage.getItem("profile"), JSON.stringify({ maxHr: 190, restingHr: 55 }));
});

test("runtime emits one voice event and trace entry per changed recommendation", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("session-1");
  const input = {
    sessionId: "session-1",
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:1",
    phaseDisplayName: "hard",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 60,
    workoutElapsedSeconds: 720,
    intervalIndex: 1,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
  };
  const first = updateMachineGuidanceRuntime(input, storage);
  assert.ok(first?.voiceEvent);
  assert.match(formatMachineGuidanceSpeech(first.voiceEvent), /^Interval 1\. Resistance 11\. Hold 70 RPM\.$/);
  const firstKey = getMachineGuidanceVoiceKey(first.voiceEvent);
  assert.equal(firstKey, getMachineGuidanceVoiceKey(first.voiceEvent));
  const second = updateMachineGuidanceRuntime({ ...input, phaseElapsedSeconds: 1, workoutElapsedSeconds: 721 }, storage);
  assert.equal(second?.voiceEvent, null);
  let snapshot = getMachineUsageSnapshot("session-1");
  assert.equal(snapshot?.machineId, "proform-smart-power-10");
  assert.equal(snapshot?.profileVersion, 1);
  assert.equal(snapshot?.guidanceTrace.length, 1);
  assert.equal(snapshot?.guidanceTrace[0].phaseKind, "work");
  assert.equal(snapshot?.guidanceTrace[0].phaseId, "work:1");
  assert.equal(snapshot?.guidanceTrace[0].intervalIndex, 1);
  const warmup = updateMachineGuidanceRuntime({
    ...input,
    phaseKind: "warmup",
    phaseId: "warmup",
    phaseDisplayName: "Warm-Up",
    phaseDurationSeconds: 600,
    workoutElapsedSeconds: 10,
    intervalIndex: undefined,
  }, storage);
  assert.ok(warmup?.voiceEvent);
  snapshot = getMachineUsageSnapshot("session-1");
  assert.equal(snapshot?.guidanceTrace.length, 2);
});

test("runtime uses only the bounded recent HR window", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("session-2");
  recordMachineHeartRateSample("session-2", 1, 190);
  for (let elapsed = 44; elapsed <= 59; elapsed++) recordMachineHeartRateSample("session-2", elapsed, 150);
  const update = updateMachineGuidanceRuntime({
    sessionId: "session-2",
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:1",
    phaseDisplayName: "hard",
    phaseElapsedSeconds: 59,
    phaseDurationSeconds: 60,
    workoutElapsedSeconds: 59,
    intervalIndex: 1,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
  }, storage);
  assert.equal(update?.guidance.resistance, 11);
  const next = updateMachineGuidanceRuntime({
    sessionId: "session-2",
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:2",
    phaseDisplayName: "hard",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 60,
    workoutElapsedSeconds: 120,
    intervalIndex: 2,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
  }, storage);
  assert.equal(next?.guidance.resistance, 12);
});

test("SISU payload omits local-only machine metadata", () => {
  const payload = buildSisuWorkoutPayload({
    external_session_id: "session-3",
    day: "Monday",
    intent: "vo2_primer",
    machine_id: "proform-smart-power-10",
    machine_profile_version: 1,
    machine_guidance_trace: [{ elapsedSeconds: 0, resistance: 11, cadenceRpm: 70, reason: "start" }],
  });
  assert.deepEqual(payload, {
    external_session_id: "session-3",
    day: "Monday",
    intent: "vo2_primer",
  });
});

test("workout history receives machine identity, profile version, and change-only trace", () => {
  const summary = { external_session_id: "session-4" };
  const trace = [{ elapsedSeconds: 0, resistance: 11, cadenceRpm: 70, estimatedWatts: 134, reason: "start" }];
  applyMachineUsageToSummary(summary, {
    machineId: "proform-smart-power-10",
    profileVersion: 1,
    guidanceTrace: trace,
  });
  assert.equal(summary.machine_id, "proform-smart-power-10");
  assert.equal(summary.machine_profile_version, 1);
  assert.deepEqual(summary.machine_guidance_trace, trace);
});

function bikeSession(sessionId = "session-boundary") {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime(sessionId);
  return { storage, sessionId };
}

function recordHrWindow(sessionId, fromElapsed, toElapsed, bpm) {
  for (let elapsed = fromElapsed; elapsed <= toElapsed; elapsed++) {
    recordMachineHeartRateSample(sessionId, elapsed, bpm);
  }
}

function workTick(sessionId, storage, overrides = {}) {
  return updateMachineGuidanceRuntime({
    sessionId,
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:1",
    phaseDisplayName: "hard",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 60,
    workoutElapsedSeconds: 0,
    intervalIndex: 1,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
    ...overrides,
  }, storage);
}

function recoveryTick(sessionId, storage, overrides = {}) {
  return updateMachineGuidanceRuntime({
    sessionId,
    activity: "bike",
    phaseKind: "recovery",
    phaseId: "recovery:1",
    phaseDisplayName: "easy",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 60,
    workoutElapsedSeconds: 60,
    targetHeartRateMin: 120,
    targetHeartRateMax: 135,
    ...overrides,
  }, storage);
}

function runMissedFinalSecondWork(sessionId, storage, { workStart = 0, intervalIndex = 1, bpm, includeTargets = true } = {}) {
  const targetOverrides = includeTargets ? {} : { targetHeartRateMin: undefined, targetHeartRateMax: undefined };
  const started = workTick(sessionId, storage, {
    phaseId: `work:${intervalIndex}`,
    phaseElapsedSeconds: 0,
    workoutElapsedSeconds: workStart,
    intervalIndex,
    ...targetOverrides,
  });
  workTick(sessionId, storage, {
    phaseId: `work:${intervalIndex}`,
    phaseElapsedSeconds: 30,
    workoutElapsedSeconds: workStart + 30,
    intervalIndex,
    ...targetOverrides,
  });
  if (bpm !== undefined) recordHrWindow(sessionId, workStart + 43, workStart + 58, bpm);
  const lateWork = workTick(sessionId, storage, {
    phaseId: `work:${intervalIndex}`,
    phaseElapsedSeconds: 58,
    workoutElapsedSeconds: workStart + 58,
    intervalIndex,
    ...targetOverrides,
  });
  const recovery = recoveryTick(sessionId, storage, {
    phaseId: `recovery:${intervalIndex}`,
    workoutElapsedSeconds: workStart + 60,
  });
  return { started, lateWork, recovery };
}

test("short-interval missed final-second tick still adapts the next rep", () => {
  const { storage, sessionId } = bikeSession("session-a");
  const { started, lateWork, recovery } = runMissedFinalSecondWork(sessionId, storage, { bpm: 150 });
  assert.equal(started?.guidance.resistance, 11);
  assert.equal(lateWork?.guidance.resistance, 11);
  assert.equal(recovery?.guidance.resistance, 2);
  assert.equal(recovery?.guidance.cadenceRpm, 63);
  const next = workTick(sessionId, storage, {
    phaseId: "work:2",
    intervalIndex: 2,
    phaseElapsedSeconds: 0,
    workoutElapsedSeconds: 120,
  });
  assert.equal(next?.guidance.resistance, 12);
});

test("short-interval evaluation at the final tick is not repeated on transition", () => {
  const { storage, sessionId } = bikeSession("session-b");
  workTick(sessionId, storage, { phaseElapsedSeconds: 58, workoutElapsedSeconds: 58 });
  recordHrWindow(sessionId, 44, 59, 150);
  const finalTick = workTick(sessionId, storage, { phaseElapsedSeconds: 59, workoutElapsedSeconds: 59 });
  assert.equal(finalTick?.guidance.resistance, 11);
  const recovery = recoveryTick(sessionId, storage);
  assert.equal(recovery?.guidance.resistance, 2);
  const next = workTick(sessionId, storage, {
    phaseId: "work:2",
    intervalIndex: 2,
    workoutElapsedSeconds: 120,
  });
  assert.equal(next?.guidance.resistance, 12);
});

test("missing HR at short-rep end carries resistance and ignores later recovery HR", () => {
  const { storage, sessionId } = bikeSession("session-c");
  const { lateWork, recovery } = runMissedFinalSecondWork(sessionId, storage, {});
  assert.equal(lateWork?.guidance.resistance, 11);
  assert.equal(recovery?.guidance.resistance, 2);
  recordHrWindow(sessionId, 60, 90, 180);
  recoveryTick(sessionId, storage, { phaseElapsedSeconds: 30, workoutElapsedSeconds: 90 });
  const next = workTick(sessionId, storage, {
    phaseId: "work:2",
    intervalIndex: 2,
    workoutElapsedSeconds: 120,
  });
  assert.equal(next?.guidance.resistance, 11);
});

test("missing HR targets at short-rep end do not adapt", () => {
  const { storage, sessionId } = bikeSession("session-d");
  const { recovery } = runMissedFinalSecondWork(sessionId, storage, { bpm: 150, includeTargets: false });
  assert.equal(recovery?.guidance.resistance, 2);
  const next = workTick(sessionId, storage, {
    phaseId: "work:2",
    intervalIndex: 2,
    workoutElapsedSeconds: 120,
  });
  assert.equal(next?.guidance.resistance, 11);
});

test("high final HR reduces the next short rep after a missed final-second tick", () => {
  const { storage, sessionId } = bikeSession("session-e");
  runMissedFinalSecondWork(sessionId, storage, { bpm: 175 });
  const next = workTick(sessionId, storage, {
    phaseId: "work:2",
    intervalIndex: 2,
    workoutElapsedSeconds: 120,
  });
  assert.equal(next?.guidance.resistance, 10);
});

test("in-range final HR holds the next short-rep resistance", () => {
  const { storage, sessionId } = bikeSession("session-f");
  runMissedFinalSecondWork(sessionId, storage, { bpm: 165 });
  const next = workTick(sessionId, storage, {
    phaseId: "work:2",
    intervalIndex: 2,
    workoutElapsedSeconds: 120,
  });
  assert.equal(next?.guidance.resistance, 11);
});

test("short-rep R15 stays capped after a missed final-second tick", () => {
  let result = getProFormSmartPower10Guidance(
    context(),
    { ...createMachineGuidanceState(), nextWorkResistance: 15 }
  );
  assert.equal(result.guidance.resistance, 15);
  result = getProFormSmartPower10Guidance(
    context({
      phaseKind: "recovery",
      phaseId: "recovery:1",
      phaseElapsedSeconds: 0,
      phaseDurationSeconds: 60,
      targetHeartRateMin: 120,
      targetHeartRateMax: 135,
      recentHeartRates: recent(180),
      completedShortWork: {
        phaseId: "work:1",
        phaseDurationSeconds: 60,
        resistance: 15,
        targetHeartRateMin: 160,
        targetHeartRateMax: 170,
        recentHeartRates: recent(140),
      },
    }),
    result.state
  );
  assert.equal(result.guidance.resistance, 2);
  assert.equal(result.state.nextWorkResistance, 15);
  result = getProFormSmartPower10Guidance(
    context({ phaseId: "work:2", intervalIndex: 2, workoutElapsedSeconds: 120 }),
    result.state
  );
  assert.equal(result.guidance.resistance, 15);
});

test("recovery HR samples do not change a completed short work rep", () => {
  const { storage, sessionId } = bikeSession("session-h");
  workTick(sessionId, storage, { phaseElapsedSeconds: 0, workoutElapsedSeconds: 0 });
  recordHrWindow(sessionId, 43, 58, 150);
  workTick(sessionId, storage, { phaseElapsedSeconds: 58, workoutElapsedSeconds: 58 });
  recordHrWindow(sessionId, 60, 60, 180);
  const recovery = recoveryTick(sessionId, storage);
  assert.equal(recovery?.guidance.resistance, 2);
  recordHrWindow(sessionId, 61, 90, 185);
  recoveryTick(sessionId, storage, { phaseElapsedSeconds: 30, workoutElapsedSeconds: 90 });
  const next = workTick(sessionId, storage, {
    phaseId: "work:2",
    intervalIndex: 2,
    workoutElapsedSeconds: 120,
  });
  assert.equal(next?.guidance.resistance, 12);
});

test("internal next-work adaptation does not append a trace entry during recovery", () => {
  const { storage, sessionId } = bikeSession("session-i");
  const { recovery } = runMissedFinalSecondWork(sessionId, storage, { bpm: 150 });
  assert.equal(recovery?.guidance.resistance, 2);
  const afterRecovery = getMachineUsageSnapshot(sessionId);
  assert.deepEqual(afterRecovery?.guidanceTrace.map((entry) => entry.resistance), [11, 2]);
  const next = workTick(sessionId, storage, {
    phaseId: "work:2",
    intervalIndex: 2,
    workoutElapsedSeconds: 120,
  });
  assert.equal(next?.guidance.resistance, 12);
  const afterNext = getMachineUsageSnapshot(sessionId);
  assert.deepEqual(afterNext?.guidanceTrace.map((entry) => entry.resistance), [11, 2, 12]);
});

test("short-rep boundary finalization does not emit an extra machine voice event", () => {
  const { storage, sessionId } = bikeSession("session-j");
  const { started, lateWork, recovery } = runMissedFinalSecondWork(sessionId, storage, { bpm: 150 });
  assert.ok(started?.voiceEvent);
  assert.match(formatMachineGuidanceSpeech(started.voiceEvent), /Resistance 11/);
  assert.equal(lateWork?.voiceEvent, null);
  assert.ok(recovery?.voiceEvent);
  const recoverySpeech = formatMachineGuidanceSpeech(recovery.voiceEvent);
  assert.match(recoverySpeech, /Resistance 2/);
  assert.match(recoverySpeech, /63 RPM/);
  assert.doesNotMatch(recoverySpeech, /previous repetition/i);
  const next = workTick(sessionId, storage, {
    phaseId: "work:2",
    intervalIndex: 2,
    workoutElapsedSeconds: 120,
  });
  assert.ok(next?.voiceEvent);
  assert.match(formatMachineGuidanceSpeech(next.voiceEvent), /Resistance 12/);
});

test("workout definitions use activities and structured interval kinds", async () => {
  const data = JSON.parse(await readFile(new URL("../data.json", import.meta.url), "utf8"));
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes('"machine"'), false);
  assert.equal(serialized.includes("Bike or Elliptical"), false);
  assert.equal(serialized.includes("Combo Machine"), false);
  assert.deepEqual(data.weekly_plan[0].activities, ["bike"]);
  assert.equal(data.weekly_plan[0].main_set.intervals[0].kind, "work");
  assert.equal(data.weekly_plan[0].main_set.intervals[1].kind, "recovery");
  const sunday = data.weekly_plan.find((day) => day.day === "Sunday");
  assert.deepEqual(sunday?.activities, ["bike", "elliptical"]);
});

test("single-activity workouts resolve automatically without an explicit selection", () => {
  assert.equal(getActiveWorkoutActivity(["bike"]), "bike");
  assert.equal(getActiveWorkoutActivity(["elliptical"]), "elliptical");
  assert.equal(getActiveWorkoutActivity(["strength"]), "strength");
  assert.equal(getActiveWorkoutActivity(["bike"], "elliptical"), "bike");
});

test("multi-activity workouts have no active activity before an explicit selection", () => {
  const allowed = ["bike", "elliptical"];
  assert.equal(getActiveWorkoutActivity(allowed), undefined);
  assert.equal(getActiveWorkoutActivity(allowed, undefined), undefined);
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("session-unselected");
  const activity = getActiveWorkoutActivity(allowed);
  assert.equal(activity, undefined);
  assert.equal(
    activity
      ? updateMachineGuidanceRuntime({
          sessionId: "session-unselected",
          activity,
          phaseKind: "warmup",
          phaseId: "warmup",
          phaseDisplayName: "Warm-Up",
          phaseElapsedSeconds: 0,
          phaseDurationSeconds: 180,
          workoutElapsedSeconds: 0,
        }, storage)
      : null,
    null
  );
});

test("selecting bike on a multi-activity workout enables ProForm guidance", () => {
  const allowed = ["bike", "elliptical"];
  const activity = requireAllowedActivity(allowed, "bike");
  assert.equal(getActiveWorkoutActivity(allowed, activity), "bike");
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("session-sunday-bike");
  const update = updateMachineGuidanceRuntime({
    sessionId: "session-sunday-bike",
    activity,
    phaseKind: "warmup",
    phaseId: "warmup",
    phaseDisplayName: "Warm-Up",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 180,
    workoutElapsedSeconds: 0,
  }, storage);
  assert.equal(update?.machine.id, "proform-smart-power-10");
  assert.equal(update?.guidance.resistance, 3);
  assert.equal(update?.guidance.cadenceRpm, 60);
});

test("selecting elliptical on a multi-activity workout does not enable ProForm guidance", () => {
  const allowed = ["bike", "elliptical"];
  const activity = requireAllowedActivity(allowed, "elliptical");
  assert.equal(getActiveWorkoutActivity(allowed, activity), "elliptical");
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("session-sunday-elliptical");
  const update = updateMachineGuidanceRuntime({
    sessionId: "session-sunday-elliptical",
    activity,
    phaseKind: "warmup",
    phaseId: "warmup",
    phaseDisplayName: "Warm-Up",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 180,
    workoutElapsedSeconds: 0,
  }, storage);
  assert.equal(update, null);
});

test("invalid activities cannot be selected for a workout", () => {
  assert.throws(
    () => requireAllowedActivity(["bike", "elliptical"], "strength"),
    /not allowed for this workout/
  );
  assert.throws(
    () => requireAllowedActivity(["bike", "elliptical"], "treadmill"),
    /not allowed for this workout/
  );
  assert.equal(getActiveWorkoutActivity(["bike", "elliptical"], "strength"), undefined);
});

test("session activity choice does not leak into another session", () => {
  const storage = memoryStorage();
  startSession("Sunday", 1, "session-sunday", "bike", storage);
  startSession("Monday", 1, "session-monday", "bike", storage);
  assert.equal(getSession("Sunday", storage).activity, "bike");
  assert.equal(getSession("Monday", storage).activity, "bike");
  clearSession("Sunday", storage);
  assert.equal(getSession("Sunday", storage).activity, undefined);
  assert.equal(getSession("Sunday", storage).sessionId, null);
  assert.equal(getSession("Monday", storage).activity, "bike");
  assert.equal(getSession("Monday", storage).sessionId, "session-monday");
  startSession("Sunday", 2, "session-sunday-2", "elliptical", storage);
  assert.equal(getSession("Sunday", storage).activity, "elliptical");
  assert.equal(getSession("Monday", storage).activity, "bike");
});

test("completed summaries record the actual session activity", () => {
  const sundayBike = applyWorkoutActivityToSummary(
    { external_session_id: "sunday-bike" },
    getActiveWorkoutActivity(["bike", "elliptical"], "bike")
  );
  assert.equal(sundayBike.activity, "bike");
  const sundayElliptical = applyWorkoutActivityToSummary(
    { external_session_id: "sunday-elliptical" },
    getActiveWorkoutActivity(["bike", "elliptical"], "elliptical")
  );
  assert.equal(sundayElliptical.activity, "elliptical");
  const monday = applyWorkoutActivityToSummary(
    { external_session_id: "monday" },
    getActiveWorkoutActivity(["bike"])
  );
  assert.equal(monday.activity, "bike");
});

test("Sunday bike summaries can include ProForm usage while elliptical summaries do not", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("session-history-bike");
  updateMachineGuidanceRuntime({
    sessionId: "session-history-bike",
    activity: "bike",
    phaseKind: "warmup",
    phaseId: "warmup",
    phaseDisplayName: "Warm-Up",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 180,
    workoutElapsedSeconds: 0,
  }, storage);
  const bikeSummary = applyWorkoutActivityToSummary({ external_session_id: "session-history-bike" }, "bike");
  applyMachineUsageToSummary(bikeSummary, getMachineUsageSnapshot("session-history-bike"));
  assert.equal(bikeSummary.activity, "bike");
  assert.equal(bikeSummary.machine_id, "proform-smart-power-10");
  assert.equal(bikeSummary.machine_profile_version, 1);

  resetMachineGuidanceRuntime("session-history-elliptical");
  updateMachineGuidanceRuntime({
    sessionId: "session-history-elliptical",
    activity: "elliptical",
    phaseKind: "warmup",
    phaseId: "warmup",
    phaseDisplayName: "Warm-Up",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 180,
    workoutElapsedSeconds: 0,
  }, storage);
  const ellipticalSummary = applyWorkoutActivityToSummary({ external_session_id: "session-history-elliptical" }, "elliptical");
  applyMachineUsageToSummary(ellipticalSummary, getMachineUsageSnapshot("session-history-elliptical"));
  assert.equal(ellipticalSummary.activity, "elliptical");
  assert.equal(ellipticalSummary.machine_id, undefined);
  assert.equal(ellipticalSummary.machine_profile_version, undefined);
  assert.equal(ellipticalSummary.machine_guidance_trace, undefined);
});

test("SISU payload omits local-only activity field", () => {
  const payload = buildSisuWorkoutPayload({
    external_session_id: "session-activity",
    day: "Sunday",
    intent: "recovery",
    activity: "bike",
    machine_id: "proform-smart-power-10",
    machine_profile_version: 1,
    machine_guidance_trace: [{ elapsedSeconds: 0, resistance: 3, cadenceRpm: 60, reason: "warmup" }],
  });
  assert.deepEqual(payload, {
    external_session_id: "session-activity",
    day: "Sunday",
    intent: "recovery",
  });
  assert.equal("activity" in payload, false);
});
