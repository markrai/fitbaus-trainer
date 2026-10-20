import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWorkResistanceAdjustment,
  getProFormSmartPower10Guidance,
  TARGET_HR_ADJUST_MARGIN_BPM,
} from "../dist/machines/proformSmartPower10.js";
import { createMachineGuidanceState } from "../dist/machines/guidance.js";
import {
  getMachineUsageSnapshot,
  recordMachineHeartRateSample,
  resetMachineGuidanceRuntime,
  updateMachineGuidanceRuntime,
} from "../dist/machines/runtime.js";
import { setSelectedMachine } from "../dist/machines/selection.js";
import {
  MACHINE_DECISION_AUDIT_VERSION,
  MAX_MACHINE_DECISION_AUDIT_ENTRIES,
  appendMachineDecisionAuditEntries,
} from "../dist/machines/audit/index.js";
import { formatMachineGuidanceSpeech } from "../dist/voice.js";
import { buildSisuWorkoutPayload } from "../dist/sisuSync.js";
import { applyMachineUsageToSummary } from "../dist/workoutSummary.js";

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

function longThresholdContext(overrides = {}) {
  return context({
    phaseId: "sustain",
    phaseDurationSeconds: 1200,
    targetHeartRateMin: 155,
    targetHeartRateMax: 162,
    intervalIndex: undefined,
    ...overrides,
  });
}

function bikeRuntime(sessionId) {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime(sessionId);
  return { storage, sessionId };
}

function seedHr(sessionId, atElapsed, bpm, span = 8) {
  for (let i = span; i >= 0; i--) {
    recordMachineHeartRateSample(sessionId, atElapsed - i, bpm);
  }
}

function workRuntimeTick(sessionId, storage, overrides = {}) {
  return updateMachineGuidanceRuntime({
    sessionId,
    activity: "bike",
    phaseKind: "work",
    phaseId: "sustain",
    phaseDisplayName: "Threshold",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 1200,
    workoutElapsedSeconds: 0,
    targetHeartRateMin: 155,
    targetHeartRateMax: 162,
    intent: "threshold",
    ...overrides,
  }, storage);
}

function thresholdAt(sessionId, storage, elapsed, bpm, extra = {}) {
  if (bpm !== undefined) seedHr(sessionId, elapsed, bpm);
  return workRuntimeTick(sessionId, storage, {
    workoutElapsedSeconds: elapsed,
    phaseElapsedSeconds: elapsed - 600,
    ...extra,
  });
}

function auditOf(sessionId) {
  return getMachineUsageSnapshot(sessionId)?.decisionAudit ?? [];
}

function evaluations(sessionId) {
  return auditOf(sessionId).filter((entry) => entry.kind === "evaluation");
}

function deferred(sessionId) {
  return auditOf(sessionId).filter((entry) => entry.kind === "evaluation_deferred");
}

test("characterization: 155-162 holds at 164 and decreases at 165", () => {
  let result = getProFormSmartPower10Guidance(longThresholdContext(), createMachineGuidanceState());
  assert.equal(result.guidance.resistance, 8);
  result = getProFormSmartPower10Guidance(
    longThresholdContext({ phaseElapsedSeconds: 90, recentHeartRates: recent(164) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 8);
  assert.equal(result.guidance.action, "hold");

  result = getProFormSmartPower10Guidance(longThresholdContext(), createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    longThresholdContext({ phaseElapsedSeconds: 90, recentHeartRates: recent(165) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 7);
  assert.equal(result.guidance.action, "decrease");
});

test("characterization: 155-162 increases at 152 and holds at 153", () => {
  let result = getProFormSmartPower10Guidance(longThresholdContext(), createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    longThresholdContext({ phaseElapsedSeconds: 90, recentHeartRates: recent(152) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  assert.equal(result.guidance.action, "increase");

  result = getProFormSmartPower10Guidance(longThresholdContext(), createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    longThresholdContext({ phaseElapsedSeconds: 90, recentHeartRates: recent(153) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 8);
  assert.equal(result.guidance.action, "hold");
});

test("characterization: high HR at R1 holds rather than decreasing below one", () => {
  let result = getProFormSmartPower10Guidance(
    longThresholdContext(),
    { ...createMachineGuidanceState(), nextWorkResistance: 1 }
  );
  assert.equal(result.guidance.resistance, 1);
  result = getProFormSmartPower10Guidance(
    longThresholdContext({ phaseElapsedSeconds: 90, recentHeartRates: recent(165) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 1);
  assert.equal(result.guidance.action, "hold");
});

test("characterization: R13+ needs a 5 bpm deficit; 3 bpm is not enough", () => {
  let result = getProFormSmartPower10Guidance(
    longThresholdContext({ targetHeartRateMin: 160, targetHeartRateMax: 170 }),
    { ...createMachineGuidanceState(), nextWorkResistance: 13 }
  );
  result = getProFormSmartPower10Guidance(
    longThresholdContext({
      phaseElapsedSeconds: 90,
      targetHeartRateMin: 160,
      targetHeartRateMax: 170,
      recentHeartRates: recent(157),
    }),
    result.state
  );
  assert.equal(result.guidance.resistance, 13);

  result = getProFormSmartPower10Guidance(
    longThresholdContext({ targetHeartRateMin: 160, targetHeartRateMax: 170 }),
    { ...createMachineGuidanceState(), nextWorkResistance: 13 }
  );
  result = getProFormSmartPower10Guidance(
    longThresholdContext({
      phaseElapsedSeconds: 90,
      targetHeartRateMin: 160,
      targetHeartRateMax: 170,
      recentHeartRates: recent(155),
    }),
    result.state
  );
  assert.equal(result.guidance.resistance, 14);
});

test("characterization: R15 never increases on low HR", () => {
  let result = getProFormSmartPower10Guidance(
    longThresholdContext(),
    { ...createMachineGuidanceState(), nextWorkResistance: 15 }
  );
  result = getProFormSmartPower10Guidance(
    longThresholdContext({ phaseElapsedSeconds: 90, recentHeartRates: recent(140) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 15);
});

test("extracted classifier matches the characterized 155-162 boundaries", () => {
  assert.equal(TARGET_HR_ADJUST_MARGIN_BPM, 3);
  assert.equal(classifyWorkResistanceAdjustment(164, 155, 162, 12).decision, "hold");
  assert.equal(classifyWorkResistanceAdjustment(164, 155, 162, 12).assessment, "target");
  assert.equal(classifyWorkResistanceAdjustment(165, 155, 162, 12).decision, "decrease");
  assert.equal(classifyWorkResistanceAdjustment(165, 155, 162, 12).assessment, "high");
  assert.equal(classifyWorkResistanceAdjustment(152, 155, 162, 8).decision, "increase");
  assert.equal(classifyWorkResistanceAdjustment(153, 155, 162, 8).decision, "hold");
  assert.equal(classifyWorkResistanceAdjustment(157, 160, 170, 13).constraint, "r13_plus_deficit_guard");
  assert.equal(classifyWorkResistanceAdjustment(155, 160, 170, 13).decision, "increase");
  assert.equal(classifyWorkResistanceAdjustment(140, 155, 162, 15).constraint, "r15_cap");
  assert.equal(classifyWorkResistanceAdjustment(165, 155, 162, 1).constraint, "r1_floor");
});

test("work phase start schedules the first evaluation", () => {
  const { storage, sessionId } = bikeRuntime("audit-start");
  workRuntimeTick(sessionId, storage, { workoutElapsedSeconds: 600, phaseElapsedSeconds: 0 });
  const started = auditOf(sessionId).find((entry) => entry.kind === "work_phase_started");
  assert.ok(started);
  assert.equal(started.version, MACHINE_DECISION_AUDIT_VERSION);
  assert.equal(started.elapsedSeconds, 600);
  assert.equal(started.phaseId, "sustain");
  assert.equal(started.resistance, 8);
  assert.equal(started.targetHeartRateMin, 155);
  assert.equal(started.targetHeartRateMax, 162);
  assert.equal(started.initialEvaluationWaitSeconds, 90);
  assert.equal(started.nextEligibleElapsedSeconds, 690);
  assert.equal(evaluations(sessionId).length, 0);
});

test("low representative HR records an increase audit", () => {
  const { storage, sessionId } = bikeRuntime("audit-low");
  workRuntimeTick(sessionId, storage, { workoutElapsedSeconds: 600, phaseElapsedSeconds: 0 });
  const update = thresholdAt(sessionId, storage, 690, 124);
  assert.equal(update?.guidance.resistance, 9);
  const entry = evaluations(sessionId).at(-1);
  assert.equal(entry.heartRateAssessment, "low");
  assert.equal(entry.decision, "increase");
  assert.equal(entry.resistanceBefore, 8);
  assert.equal(entry.resistanceAfter, 9);
  assert.equal(entry.representativeHeartRate, 124);
  assert.equal(entry.nextEligibleElapsedSeconds, 750);
  assert.equal(entry.evaluationKind, "initial");
});

test("target representative HR records a HOLD audit and next eligibility", () => {
  const { storage, sessionId } = bikeRuntime("audit-hold");
  workRuntimeTick(sessionId, storage, { workoutElapsedSeconds: 600, phaseElapsedSeconds: 0 });
  thresholdAt(sessionId, storage, 690, 157);
  const update = thresholdAt(sessionId, storage, 690, 157);
  assert.equal(update?.guidance.resistance, 8);
  const entry = evaluations(sessionId).at(-1);
  assert.equal(entry.heartRateAssessment, "target");
  assert.equal(entry.decision, "hold");
  assert.equal(entry.resistanceBefore, 8);
  assert.equal(entry.resistanceAfter, 8);
  assert.equal(entry.nextEvaluationWaitSeconds, 60);
  assert.equal(entry.nextEligibleElapsedSeconds, 750);
  assert.equal(update?.voiceEvent, null);
});

test("high representative HR at an eligible evaluation records a decrease", () => {
  const { storage, sessionId } = bikeRuntime("audit-high");
  workRuntimeTick(sessionId, storage, { workoutElapsedSeconds: 600, phaseElapsedSeconds: 0 });
  const update = thresholdAt(sessionId, storage, 690, 165);
  assert.equal(update?.guidance.resistance, 7);
  const entry = evaluations(sessionId).at(-1);
  assert.equal(entry.heartRateAssessment, "high");
  assert.equal(entry.decision, "decrease");
  assert.equal(entry.resistanceBefore, 8);
  assert.equal(entry.resistanceAfter, 7);
  assert.equal(entry.nextEligibleElapsedSeconds, 750);
});

test("high HR before eligibility does not evaluate or decrease", () => {
  const { storage, sessionId } = bikeRuntime("audit-early-high");
  workRuntimeTick(sessionId, storage, { workoutElapsedSeconds: 600, phaseElapsedSeconds: 0 });
  thresholdAt(sessionId, storage, 690, 157);
  const hold = evaluations(sessionId).at(-1);
  assert.equal(hold.nextEligibleElapsedSeconds, 750);
  const early = thresholdAt(sessionId, storage, 720, 170);
  assert.equal(early?.guidance.resistance, 8);
  assert.equal(evaluations(sessionId).length, 1);
  assert.equal(evaluations(sessionId)[0].nextEligibleElapsedSeconds, 750);
  const later = thresholdAt(sessionId, storage, 750, 165);
  assert.equal(later?.guidance.resistance, 7);
  assert.equal(evaluations(sessionId).at(-1).decision, "decrease");
});

function runThursdayIncreases(sessionId, storage) {
  workRuntimeTick(sessionId, storage, { workoutElapsedSeconds: 600, phaseElapsedSeconds: 0 });
  assert.equal(thresholdAt(sessionId, storage, 690, 124)?.guidance.resistance, 9);
  assert.equal(thresholdAt(sessionId, storage, 750, 136)?.guidance.resistance, 10);
  assert.equal(thresholdAt(sessionId, storage, 810, 144)?.guidance.resistance, 11);
  assert.equal(thresholdAt(sessionId, storage, 870, 148)?.guidance.resistance, 12);
}

test("Thursday-style HOLDs record next eligibility and cancel before 1050 does not decrease", () => {
  const { storage, sessionId } = bikeRuntime("audit-thursday");
  runThursdayIncreases(sessionId, storage);
  const hold930 = thresholdAt(sessionId, storage, 930, 157);
  assert.equal(hold930?.guidance.resistance, 12);
  assert.equal(hold930?.voiceEvent, null);
  const eval930 = evaluations(sessionId).at(-1);
  assert.equal(eval930.elapsedSeconds, 930);
  assert.equal(eval930.decision, "hold");
  assert.equal(eval930.resistanceBefore, 12);
  assert.equal(eval930.resistanceAfter, 12);
  assert.equal(eval930.representativeHeartRate, 157);
  assert.equal(eval930.heartRateAssessment, "target");
  assert.equal(eval930.nextEligibleElapsedSeconds, 990);

  const hold990 = thresholdAt(sessionId, storage, 990, 163);
  assert.equal(hold990?.guidance.resistance, 12);
  const eval990 = evaluations(sessionId).at(-1);
  assert.equal(eval990.elapsedSeconds, 990);
  assert.equal(eval990.decision, "hold");
  assert.equal(eval990.resistanceBefore, 12);
  assert.equal(eval990.resistanceAfter, 12);
  assert.equal(eval990.representativeHeartRate, 163);
  assert.equal(eval990.heartRateAssessment, "target");
  assert.equal(eval990.nextEligibleElapsedSeconds, 1050);

  const cancelTick = thresholdAt(sessionId, storage, 1048, 165);
  assert.equal(cancelTick?.guidance.resistance, 12);
  assert.equal(evaluations(sessionId).at(-1).elapsedSeconds, 990);
  assert.equal(evaluations(sessionId).at(-1).nextEligibleElapsedSeconds, 1050);
  assert.equal(evaluations(sessionId).filter((entry) => entry.decision === "decrease").length, 0);

  const snapshot = getMachineUsageSnapshot(sessionId);
  const summary = applyMachineUsageToSummary(
    { external_session_id: sessionId, cancelled: true },
    snapshot
  );
  assert.equal(summary.cancelled, true);
  assert.ok(summary.machine_decision_audit?.length > 0);
  assert.equal(summary.machine_guidance_trace.at(-1).resistance, 12);
  assert.equal(summary.machine_guidance_trace.at(-1).elapsedSeconds, 870);
});

test("continuing the Thursday scenario to the next eligible high HR decreases", () => {
  const { storage, sessionId } = bikeRuntime("audit-thursday-continue");
  runThursdayIncreases(sessionId, storage);
  thresholdAt(sessionId, storage, 930, 157);
  thresholdAt(sessionId, storage, 990, 163);
  const decrease = thresholdAt(sessionId, storage, 1050, 165);
  assert.equal(decrease?.guidance.resistance, 11);
  const entry = evaluations(sessionId).at(-1);
  assert.equal(entry.elapsedSeconds, 1050);
  assert.equal(entry.heartRateAssessment, "high");
  assert.equal(entry.decision, "decrease");
  assert.equal(entry.resistanceBefore, 12);
  assert.equal(entry.resistanceAfter, 11);
});

test("insufficient HR at the deadline records one deferred audit and does not consume cooldown", () => {
  const { storage, sessionId } = bikeRuntime("audit-deferred");
  workRuntimeTick(sessionId, storage, { workoutElapsedSeconds: 600, phaseElapsedSeconds: 0 });
  const first = thresholdAt(sessionId, storage, 690);
  assert.equal(first?.guidance.resistance, 8);
  assert.equal(evaluations(sessionId).length, 0);
  assert.equal(deferred(sessionId).length, 1);
  assert.equal(deferred(sessionId)[0].reason, "insufficient_hr");
  assert.equal(deferred(sessionId)[0].eligibleSinceElapsedSeconds, 690);
  thresholdAt(sessionId, storage, 691);
  thresholdAt(sessionId, storage, 700);
  assert.equal(deferred(sessionId).length, 1);
  const later = thresholdAt(sessionId, storage, 701, 124);
  assert.equal(later?.guidance.resistance, 9);
  const entry = evaluations(sessionId).at(-1);
  assert.equal(entry.decision, "increase");
  assert.equal(entry.elapsedSeconds, 701);
  assert.equal(entry.resistanceAfter, 9);
});

test("repeated runtime updates do not duplicate a logical evaluation", () => {
  const { storage, sessionId } = bikeRuntime("audit-dedupe");
  workRuntimeTick(sessionId, storage, { workoutElapsedSeconds: 600, phaseElapsedSeconds: 0 });
  thresholdAt(sessionId, storage, 690, 124);
  thresholdAt(sessionId, storage, 690, 124);
  workRuntimeTick(sessionId, storage, { workoutElapsedSeconds: 600, phaseElapsedSeconds: 0 });
  assert.equal(auditOf(sessionId).filter((entry) => entry.kind === "work_phase_started").length, 1);
  assert.equal(evaluations(sessionId).length, 1);
});

test("R1 floor audit distinguishes high HR from a hold", () => {
  const { storage, sessionId } = bikeRuntime("audit-r1");
  const started = workRuntimeTick(sessionId, storage, { workoutElapsedSeconds: 600, phaseElapsedSeconds: 0 });
  started.guidance.resistance = 1;
  let result = getProFormSmartPower10Guidance(
    longThresholdContext(),
    { ...createMachineGuidanceState(), nextWorkResistance: 1 }
  );
  result = getProFormSmartPower10Guidance(
    longThresholdContext({ phaseElapsedSeconds: 90, recentHeartRates: recent(165) }),
    result.state
  );
  assert.equal(result.workEvaluation.heartRateAssessment, "high");
  assert.equal(result.workEvaluation.decision, "hold");
  assert.equal(result.workEvaluation.constraint, "r1_floor");
  assert.equal(result.workEvaluation.decisionReason, "lower_resistance_bound");
  assert.equal(result.guidance.resistance, 1);
});

test("R15 cap and R13+ deficit guards keep low-HR holds diagnosable", () => {
  let r15 = getProFormSmartPower10Guidance(
    longThresholdContext(),
    { ...createMachineGuidanceState(), nextWorkResistance: 15 }
  );
  r15 = getProFormSmartPower10Guidance(
    longThresholdContext({ phaseElapsedSeconds: 90, recentHeartRates: recent(140) }),
    r15.state
  );
  assert.equal(r15.workEvaluation.heartRateAssessment, "low");
  assert.equal(r15.workEvaluation.decision, "hold");
  assert.equal(r15.workEvaluation.constraint, "r15_cap");
  assert.equal(r15.guidance.resistance, 15);

  let r13 = getProFormSmartPower10Guidance(
    longThresholdContext({ targetHeartRateMin: 160, targetHeartRateMax: 170 }),
    { ...createMachineGuidanceState(), nextWorkResistance: 13 }
  );
  r13 = getProFormSmartPower10Guidance(
    longThresholdContext({
      phaseElapsedSeconds: 90,
      targetHeartRateMin: 160,
      targetHeartRateMax: 170,
      recentHeartRates: recent(157),
    }),
    r13.state
  );
  assert.equal(r13.workEvaluation.heartRateAssessment, "low");
  assert.equal(r13.workEvaluation.decision, "hold");
  assert.equal(r13.workEvaluation.constraint, "r13_plus_deficit_guard");
  assert.equal(r13.guidance.resistance, 13);
});

test("short intervals audit the final-rep decision without changing short semantics", () => {
  const { storage, sessionId } = bikeRuntime("audit-short");
  const start = updateMachineGuidanceRuntime({
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
  }, storage);
  assert.equal(start?.guidance.resistance, 11);
  const mid = updateMachineGuidanceRuntime({
    sessionId,
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:1",
    phaseDisplayName: "hard",
    phaseElapsedSeconds: 30,
    phaseDurationSeconds: 60,
    workoutElapsedSeconds: 30,
    intervalIndex: 1,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
  }, storage);
  assert.equal(mid?.guidance.resistance, 11);
  assert.equal(evaluations(sessionId).length, 0);
  seedHr(sessionId, 59, 150);
  const finalTick = updateMachineGuidanceRuntime({
    sessionId,
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
  assert.equal(finalTick?.guidance.resistance, 11);
  const entry = evaluations(sessionId).at(-1);
  assert.equal(entry.evaluationKind, "short_interval_final");
  assert.equal(entry.decision, "increase");
  assert.equal(entry.resistanceBefore, 11);
  assert.equal(entry.resistanceAfter, 12);
  assert.equal(entry.nextEligibleElapsedSeconds, undefined);
  assert.equal(evaluations(sessionId).length, 1);
});

test("medium intervals audit the single in-interval decision only", () => {
  const { storage, sessionId } = bikeRuntime("audit-medium");
  const input = {
    sessionId,
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:1",
    phaseDisplayName: "medium",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 120,
    workoutElapsedSeconds: 0,
    intervalIndex: 1,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
  };
  updateMachineGuidanceRuntime(input, storage);
  seedHr(sessionId, 60, 150);
  const evaluated = updateMachineGuidanceRuntime({ ...input, phaseElapsedSeconds: 60, workoutElapsedSeconds: 60 }, storage);
  assert.equal(evaluated?.guidance.resistance, 11);
  seedHr(sessionId, 100, 145);
  const later = updateMachineGuidanceRuntime({ ...input, phaseElapsedSeconds: 100, workoutElapsedSeconds: 100 }, storage);
  assert.equal(later?.guidance.resistance, 11);
  assert.equal(evaluations(sessionId).length, 1);
  assert.equal(evaluations(sessionId)[0].decision, "increase");
  assert.equal(evaluations(sessionId)[0].evaluationKind, "initial");
  assert.equal(evaluations(sessionId)[0].nextEligibleElapsedSeconds, undefined);
});

test("HOLD evaluations leave machine_guidance_trace change-only", () => {
  const { storage, sessionId } = bikeRuntime("audit-trace");
  runThursdayIncreases(sessionId, storage);
  const afterIncreases = getMachineUsageSnapshot(sessionId).guidanceTrace.map((entry) => ({ ...entry }));
  thresholdAt(sessionId, storage, 930, 157);
  thresholdAt(sessionId, storage, 990, 163);
  const afterHolds = getMachineUsageSnapshot(sessionId).guidanceTrace;
  assert.deepEqual(afterHolds, afterIncreases);
  assert.ok(evaluations(sessionId).some((entry) => entry.decision === "hold"));
  assert.equal(afterHolds.at(-1).resistance, 12);
  assert.equal(afterHolds.at(-1).elapsedSeconds, 870);
});

test("cancelled summaries retain machine_decision_audit", () => {
  const { storage, sessionId } = bikeRuntime("audit-cancelled");
  workRuntimeTick(sessionId, storage, { workoutElapsedSeconds: 600, phaseElapsedSeconds: 0 });
  thresholdAt(sessionId, storage, 690, 124);
  const summary = applyMachineUsageToSummary(
    { external_session_id: sessionId, cancelled: true, intent: "threshold" },
    getMachineUsageSnapshot(sessionId)
  );
  assert.equal(summary.cancelled, true);
  assert.ok(Array.isArray(summary.machine_decision_audit));
  assert.ok(summary.machine_decision_audit.length >= 2);
  assert.ok(Array.isArray(summary.machine_guidance_trace));
});

test("SISU payload strips machine_decision_audit", () => {
  const payload = buildSisuWorkoutPayload({
    external_session_id: "audit-sisu",
    day: "Thursday",
    intent: "threshold",
    machine_id: "proform-smart-power-10",
    machine_profile_version: 1,
    machine_guidance_trace: [{ elapsedSeconds: 600, resistance: 8, cadenceRpm: 70, reason: "start" }],
    machine_decision_audit: [{ version: 1, kind: "evaluation", decision: "hold" }],
  });
  assert.equal("machine_decision_audit" in payload, false);
  assert.equal("machine_guidance_trace" in payload, false);
  assert.deepEqual(payload, {
    external_session_id: "audit-sisu",
    day: "Thursday",
    intent: "threshold",
  });
});

test("older summaries without an audit field still apply and parse", () => {
  const summary = applyMachineUsageToSummary(
    { external_session_id: "legacy" },
    {
      machineId: "proform-smart-power-10",
      profileVersion: 1,
      guidanceTrace: [{ elapsedSeconds: 0, resistance: 8, cadenceRpm: 70, reason: "start" }],
    }
  );
  assert.equal("machine_decision_audit" in summary, false);
  const payload = buildSisuWorkoutPayload(summary);
  assert.equal("machine_decision_audit" in payload, false);
});

test("decision audit retains only the newest MAX entries", () => {
  const extras = Array.from({ length: MAX_MACHINE_DECISION_AUDIT_ENTRIES + 5 }, (_, index) => ({
    version: MACHINE_DECISION_AUDIT_VERSION,
    kind: "evaluation_deferred",
    elapsedSeconds: index,
    phaseKind: "work",
    phaseId: "sustain",
    phaseElapsedSeconds: index,
    phaseDurationSeconds: 1200,
    resistance: 8,
    reason: "insufficient_hr",
    eligibleSinceElapsedSeconds: index,
  }));
  const bounded = appendMachineDecisionAuditEntries([], extras);
  assert.equal(bounded.length, MAX_MACHINE_DECISION_AUDIT_ENTRIES);
  assert.equal(bounded[0].elapsedSeconds, 5);
  assert.equal(bounded.at(-1).elapsedSeconds, MAX_MACHINE_DECISION_AUDIT_ENTRIES + 4);
});

test("HOLD audit events do not speak", () => {
  const { storage, sessionId } = bikeRuntime("audit-voice");
  workRuntimeTick(sessionId, storage, { workoutElapsedSeconds: 600, phaseElapsedSeconds: 0 });
  const hold = thresholdAt(sessionId, storage, 690, 157);
  assert.equal(hold?.voiceEvent, null);
  assert.equal(formatMachineGuidanceSpeech({
    recommendationChanged: false,
    phaseChanged: false,
    guidance: hold.guidance,
    machineId: "proform-smart-power-10",
    phaseId: "sustain",
    phaseKind: "work",
    phaseDisplayName: "Threshold",
  }), null);
});
