import assert from "node:assert/strict";
import test from "node:test";
import {
  derivePersonalizedMachineTiming,
  getDynamicsEntry,
  putDynamicsEntry,
  resetHrDynamicsForMachine,
} from "../dist/machines/dynamics/index.js";
import {
  putLearnedStart,
  resetLearnedGuidanceForMachine,
} from "../dist/machines/learning/index.js";
import {
  persistShadowPredictions,
  markShadowSessionProcessed,
  MAX_SHADOW_VALIDATION_MEDIAN_ABSOLUTE_ERROR_BPM,
  MIN_SHADOW_VALIDATION_DISTINCT_SESSIONS,
  MIN_SHADOW_VALIDATION_REALIZED_PREDICTIONS,
  resetShadowPredictionsForMachine,
} from "../dist/machines/prediction/index.js";
import { setSelectedMachine } from "../dist/machines/selection.js";
import {
  buildMachineDiagnosticsSnapshot,
  MACHINE_DIAGNOSTICS_SNAPSHOT_VERSION,
  prepareMachineDiagnosticsExport,
  serializeMachineDiagnosticsSnapshot,
} from "../dist/machines/diagnostics/index.js";
import { APP_VERSION } from "../dist/version.js";

const GENERATED_AT = "2026-08-27T12:00:00.000Z";

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
    });
  });
}

function seedCoreState(storage) {
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putLearnedStart(vo2LongKey, { resistance: 12, sampleCount: 2, updatedAt: "t" }, storage);
  putDynamicsEntry(
    vo2LongKey,
    emptyDynamicsFields({
      workStartDelays: [40, 42, 41, 43, 40],
      increaseHrPerLevel: [3, 4, 4, 5, 4],
      workStartObservationCount: 12,
      workStartDetectedResponseCount: 10,
      workStartRecentResponses: [40, 41, 42, 40, 43, 41, 40, 42, 41, 40],
      increaseObservationCount: 8,
      increaseDetectedResponseCount: 7,
      increaseRecentResponses: [20, 21, 19, 22, 20, 21, 20, 18],
    }),
    storage
  );
}

function snapshotOf(storage, extras = {}) {
  return buildMachineDiagnosticsSnapshot({
    storage,
    generatedAt: GENERATED_AT,
    ...extras,
  });
}

test("seeded snapshot reports identity, learned state, timing, shadow progress, and counts", () => {
  const storage = memoryStorage();
  seedCoreState(storage);
  persistShadowPredictions(eventsFromErrors([0, 1, 0], { sessions: 3 }), storage);
  markShadowSessionProcessed("ledger-only-1", storage);
  markShadowSessionProcessed("ledger-only-2", storage);
  const snapshot = snapshotOf(storage);
  assert.equal(snapshot.version, MACHINE_DIAGNOSTICS_SNAPSHOT_VERSION);
  assert.equal(snapshot.generatedAt, GENERATED_AT);
  assert.equal(snapshot.appVersion, APP_VERSION);
  assert.equal(snapshot.machine.machineId, "proform-smart-power-10");
  assert.equal(snapshot.machine.machineName, "ProForm SMART Power 10.0");
  assert.equal(snapshot.machine.activity, "bike");
  assert.equal(snapshot.machine.machineProfileVersion, 1);
  assert.equal(snapshot.learnedStarts.length, 1);
  assert.equal(snapshot.learnedStarts[0].resistance, 12);
  assert.equal(snapshot.learnedStarts[0].sampleCount, 2);
  assert.equal(snapshot.learnedStarts[0].intent, "vo2_priority");
  assert.equal(snapshot.learnedStarts[0].durationClass, "long");
  assert.equal(snapshot.hrDynamics.length, 1);
  assert.equal(snapshot.hrDynamics[0].medianWorkStartDelaySeconds, 41);
  assert.equal(snapshot.hrDynamics[0].medianIncreaseHrDeltaPerStep, 4);
  assert.equal(snapshot.hrDynamics[0].workStartRecentObservationCount, 10);
  assert.equal(snapshot.hrDynamics[0].workStartRecentDetectedResponseCount, 10);
  assert.equal(snapshot.hrDynamics[0].workStartRecentDetectionRate, 1);
  assert.equal(snapshot.hrDynamics[0].timing.durationClass, "long");
  assert.equal(snapshot.hrDynamics[0].timing.defaultInitialEvaluationSeconds, 90);
  assert.equal(snapshot.hrDynamics[0].timing.defaultCooldownSeconds, 60);
  assert.equal(snapshot.hrDynamics[0].timing.laterTimingEvidenceQualifies, true);
  assert.equal(snapshot.hrDynamics[0].timing.earlyTimingEvidenceQualifies, true);
  assert.equal(snapshot.hrDynamics[0].timing.initialEvaluationSeconds, undefined);
  assert.equal(snapshot.shadowPrediction.entries.length, 1);
  const increase = snapshot.shadowPrediction.entries[0].increase;
  assert.equal(increase.predictionCount, 3);
  assert.equal(increase.validationStatus, "collecting");
  assert.equal(increase.validationHighConfidence, false);
  assert.equal(increase.progress.realized.current, 3);
  assert.equal(increase.progress.realized.required, MIN_SHADOW_VALIDATION_REALIZED_PREDICTIONS);
  assert.equal(snapshot.shadowPrediction.processedSessionCount, 5);
  assert.equal(snapshot.shadowPrediction.predictionEventSessionCount, 3);
  assert.deepEqual(snapshot.summary, {
    learnedStartEntries: 1,
    hrDynamicsEntries: 1,
    shadowPredictionEntries: 1,
    processedShadowSessions: 5,
    validatedDirections: 0,
  });
  const json = serializeMachineDiagnosticsSnapshot(snapshot);
  assert.equal(json.includes("hr_trace"), false);
  assert.equal(json.includes("timestamp_sec"), false);
  assert.equal(json.includes("processedSessions"), false);
  assert.equal(json.includes("ledger-only-1"), false);
  assert.equal(increase.events, undefined);
});

test("medium diagnostics do not invent a representative phase duration", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  const mediumKey = { ...vo2LongKey, durationClass: "medium" };
  putDynamicsEntry(mediumKey, emptyDynamicsFields({ workStartDelays: [75, 75, 75, 75, 75] }), storage);
  const stored = getDynamicsEntry(mediumKey, storage);
  assert.equal(derivePersonalizedMachineTiming(stored, 120).initialEvaluationSeconds, 90);
  const snapshot = snapshotOf(storage);
  const timing = snapshot.hrDynamics[0].timing;
  assert.equal(timing.durationClass, "medium");
  assert.equal(timing.defaultInitialEvaluationSeconds, 60);
  assert.equal(timing.laterTimingEvidenceQualifies, true);
  assert.equal(timing.earlyTimingEvidenceQualifies, false);
  assert.equal(timing.initialEvaluationSeconds, undefined);
  assert.equal(timing.increaseCooldownSeconds, undefined);
  assert.equal(timing.decreaseCooldownSeconds, undefined);
  const json = serializeMachineDiagnosticsSnapshot(snapshot);
  assert.equal(json.includes('"initialEvaluationSeconds": 90'), false);
  assert.equal(json.includes("phaseDurationSeconds"), false);
});

test("empty snapshot is valid when no machine is selected", () => {
  const snapshot = snapshotOf(memoryStorage());
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.generatedAt, GENERATED_AT);
  assert.equal(snapshot.machine, undefined);
  assert.deepEqual(snapshot.learnedStarts, []);
  assert.deepEqual(snapshot.hrDynamics, []);
  assert.deepEqual(snapshot.shadowPrediction.entries, []);
  assert.equal(snapshot.shadowPrediction.processedSessionCount, 0);
  assert.deepEqual(snapshot.summary, {
    learnedStartEntries: 0,
    hrDynamicsEntries: 0,
    shadowPredictionEntries: 0,
    processedShadowSessions: 0,
    validatedDirections: 0,
  });
  assert.equal(JSON.stringify(snapshot).includes("proform-smart-power-10"), false);
});

test("validated direction progress reports every existing gate as passing", () => {
  const storage = memoryStorage();
  seedCoreState(storage);
  persistShadowPredictions(eventsFromErrors([0, 1, -1, 2, -2, 1, 0, 2, -1, 1], { sessions: 5 }), storage);
  const increase = snapshotOf(storage).shadowPrediction.entries[0].increase;
  assert.equal(increase.validationStatus, "validated");
  assert.equal(increase.validationHighConfidence, true);
  assert.equal(increase.evidence.status, "validated");
  const progress = increase.progress;
  assert.equal(progress.realized.current >= progress.realized.required, true);
  assert.equal(progress.sessions.current >= progress.sessions.required, true);
  assert.equal(progress.realizationRate.passes, true);
  assert.equal(progress.medianAbsoluteErrorBpm.passes, true);
  assert.equal(progress.absoluteMedianBiasBpm.passes, true);
  assert.equal(progress.directionMatchRate.passes, true);
  assert.equal(progress.withinToleranceRate.passes, true);
  assert.equal(snapshotOf(storage).summary.validatedDirections, 1);
});

test("collecting direction keeps volume shortfalls distinct from failed quality", () => {
  const storage = memoryStorage();
  seedCoreState(storage);
  persistShadowPredictions(eventsFromErrors([0, 0, 0, 0, 0, 0, 0], { sessions: 4 }), storage);
  const increase = snapshotOf(storage).shadowPrediction.entries[0].increase;
  assert.equal(increase.validationStatus, "collecting");
  assert.equal(increase.validationHighConfidence, false);
  assert.equal(increase.progress.realized.current, 7);
  assert.equal(increase.progress.realized.required, 10);
  assert.equal(increase.progress.sessions.current, 4);
  assert.equal(increase.progress.sessions.required, 5);
  assert.equal(increase.evidence.realizedNeeded, 3);
  assert.equal(increase.evidence.sessionsNeeded, 1);
  assert.equal(increase.progress.medianAbsoluteErrorBpm.passes, true);
  assert.equal(increase.progress.absoluteMedianBiasBpm.passes, true);
  assert.equal(increase.progress.directionMatchRate.passes, true);
  assert.equal(increase.progress.withinToleranceRate.passes, true);
});

test("not-validated direction shows volume passing and error failing", () => {
  const storage = memoryStorage();
  seedCoreState(storage);
  persistShadowPredictions(eventsFromErrors([8, 8, 8, 8, 8, 8, 8, 8, 8, 8], { sessions: 5 }), storage);
  const increase = snapshotOf(storage).shadowPrediction.entries[0].increase;
  assert.equal(increase.validationStatus, "not_validated");
  assert.equal(increase.validationHighConfidence, false);
  assert.equal(increase.progress.realized.current >= MIN_SHADOW_VALIDATION_REALIZED_PREDICTIONS, true);
  assert.equal(increase.progress.sessions.current >= MIN_SHADOW_VALIDATION_DISTINCT_SESSIONS, true);
  assert.equal(increase.progress.medianAbsoluteErrorBpm.current > MAX_SHADOW_VALIDATION_MEDIAN_ABSOLUTE_ERROR_BPM, true);
  assert.equal(increase.progress.medianAbsoluteErrorBpm.passes, false);
});

test("normal snapshot exposes processedSessionCount without ledger IDs", () => {
  const storage = memoryStorage();
  seedCoreState(storage);
  persistShadowPredictions([shadowEvent({ sessionId: "visible-event" })], storage);
  markShadowSessionProcessed("session-private-1", storage);
  markShadowSessionProcessed("session-private-2", storage);
  const snapshot = snapshotOf(storage);
  assert.equal(snapshot.shadowPrediction.processedSessionCount, 3);
  assert.equal(snapshot.summary.processedShadowSessions, 3);
  const json = serializeMachineDiagnosticsSnapshot(snapshot);
  assert.equal(json.includes("session-private-1"), false);
  assert.equal(json.includes("session-private-2"), false);
  assert.equal(json.includes("processedSessions"), false);
});

test("raw shadow events are omitted by default and included only when requested", () => {
  const storage = memoryStorage();
  seedCoreState(storage);
  persistShadowPredictions([shadowEvent({ sessionId: "raw-event-a" })], storage);
  markShadowSessionProcessed("session-private-1", storage);
  const defaultSnapshot = snapshotOf(storage);
  assert.equal(defaultSnapshot.shadowPrediction.entries[0].increase.events, undefined);
  const raw = snapshotOf(storage, { includeRawShadowEvents: true });
  assert.equal(raw.shadowPrediction.entries[0].increase.events.length, 1);
  assert.equal(raw.shadowPrediction.entries[0].increase.events[0].sessionId, "raw-event-a");
  const json = serializeMachineDiagnosticsSnapshot(raw);
  assert.equal(json.includes("processedSessions"), false);
  assert.equal(json.includes("session-private-1"), false);
  assert.equal(json.includes("hr_trace"), false);
  assert.equal(json.includes("timestamp_sec"), false);
});

test("export preparation is pretty JSON with a deterministic filename and JSON MIME type", () => {
  const storage = memoryStorage();
  seedCoreState(storage);
  const snapshot = snapshotOf(storage);
  const prepared = prepareMachineDiagnosticsExport(snapshot);
  assert.equal(prepared.mimeType, "application/json");
  assert.equal(prepared.filename, "fitbaus-proform-smart-power-10-diagnostics-2026-08-27.json");
  assert.equal(prepared.body, JSON.stringify(snapshot, null, 2));
  assert.equal(JSON.parse(prepared.body).generatedAt, GENERATED_AT);
  const empty = prepareMachineDiagnosticsExport(snapshotOf(memoryStorage()));
  assert.equal(empty.filename, "fitbaus-machine-diagnostics-2026-08-27.json");
});

test("resetting shadow prediction data clears evidence but keeps processedSessionCount", () => {
  const storage = memoryStorage();
  seedCoreState(storage);
  persistShadowPredictions(eventsFromErrors([0, 1, -1, 2, -2, 1, 0, 2, -1, 1], { sessions: 5 }), storage);
  const before = snapshotOf(storage);
  assert.equal(before.shadowPrediction.entries[0].increase.validationStatus, "validated");
  const processed = before.shadowPrediction.processedSessionCount;
  resetShadowPredictionsForMachine("proform-smart-power-10", storage);
  const after = snapshotOf(storage);
  assert.equal(after.shadowPrediction.entries.length, 0);
  assert.equal(after.summary.shadowPredictionEntries, 0);
  assert.equal(after.summary.validatedDirections, 0);
  assert.equal(after.shadowPrediction.processedSessionCount, processed);
  assert.equal(after.learnedStarts.length, 1);
  assert.equal(after.hrDynamics.length, 1);
});

test("resetting learned guidance removes starts and leaves dynamics and shadow state", () => {
  const storage = memoryStorage();
  seedCoreState(storage);
  persistShadowPredictions(eventsFromErrors([0, 1, -1, 2, -2, 1, 0, 2, -1, 1], { sessions: 5 }), storage);
  const processed = snapshotOf(storage).shadowPrediction.processedSessionCount;
  resetLearnedGuidanceForMachine("proform-smart-power-10", storage);
  const after = snapshotOf(storage);
  assert.equal(after.learnedStarts.length, 0);
  assert.equal(after.summary.learnedStartEntries, 0);
  assert.equal(after.hrDynamics.length, 1);
  assert.equal(after.shadowPrediction.entries[0].increase.validationStatus, "validated");
  assert.equal(after.shadowPrediction.processedSessionCount, processed);
});

test("resetting HR dynamics removes timing evidence and leaves learned starts and shadow state", () => {
  const storage = memoryStorage();
  seedCoreState(storage);
  persistShadowPredictions(eventsFromErrors([0, 1, -1, 2, -2, 1, 0, 2, -1, 1], { sessions: 5 }), storage);
  const processed = snapshotOf(storage).shadowPrediction.processedSessionCount;
  resetHrDynamicsForMachine("proform-smart-power-10", storage);
  const after = snapshotOf(storage);
  assert.equal(after.hrDynamics.length, 0);
  assert.equal(after.summary.hrDynamicsEntries, 0);
  assert.equal(after.learnedStarts.length, 1);
  assert.equal(after.shadowPrediction.entries[0].increase.validationStatus, "validated");
  assert.equal(after.shadowPrediction.processedSessionCount, processed);
});
