import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

import {
  PHASE_E1_SHADOW_POLICY,
  evaluatePersonalizedPrescription,
} from "../dist/personalizedPrescription.js";
import { resolveWorkoutPrescription } from "../dist/workoutPrescription.js";
import { startSession, getSession, pauseSession, resumeSession, clearSession } from "../dist/sessionStore.js";
import { setSelectedMachine, EQUIPMENT_STORAGE_KEY } from "../dist/machines/selection.js";
import {
  classifyRecommendationOrigin,
  recordMachineHeartRateSample,
  resetMachineGuidanceRuntime,
  updateMachineGuidanceRuntime,
} from "../dist/machines/runtime.js";
import {
  ACTUATION_ORIGINS,
  createInProgressExecutionProvenance,
  derivePhaseActuationSummaries,
  executionProvenanceKey,
  finalizeExecutionProvenance,
  MAX_EXECUTION_PROVENANCE_EVENTS,
  appendActuationEvent,
  parseWorkoutExecutionProvenance,
  readInProgressExecutionProvenance,
  recordActuationRequest,
  writeInProgressExecutionProvenance,
} from "../dist/executionProvenance.js";
import {
  FORMAL_CALIBRATION_MACHINE_PROVENANCE_STORAGE_KEY,
  calibrationIdentityFromE1Snapshot,
  calibrationIdentityFromMetric,
  lookupCalibrationMachine,
  parseFormalCalibrationMachineProvenance,
  parseFormalCalibrationMachineProvenanceStore,
  readFormalCalibrationMachineProvenance,
  recordFormalCalibrationMachineProvenance,
  resolveWorkoutCalibrationMachine,
} from "../dist/calibrationMachineProvenance.js";
import { createActuationProvenanceObserver } from "../dist/actuationProvenanceObserver.js";
import { createBikeBridgeSession } from "../dist/platform/bikeBridgeRuntime.js";
import {
  applyFrozenMachineUsageToSummary,
  generateWorkoutSummary,
  recordPromotedFormalCalibrationMachine,
} from "../dist/workoutSummary.js";
import { parseFitnessState } from "../dist/fitnessState.js";
import { buildSisuWorkoutPayload } from "../dist/sisuSync.js";
import {
  getAllWorkoutSummaries,
  resetWorkoutStorageForTests,
  storeHrSample,
  storeOrdinaryBikeTelemetrySample,
  storeWorkoutSummary,
} from "../dist/workoutStorage.js";
import {
  buildPersonalizationDiagnosticsModel,
  createPersonalizationDiagnosticsExport,
  extractTrustedExecutionProvenanceContexts,
  extractTrustedPersonalizationAssessmentContexts,
  extractTrustedPersonalizationCharacterizations,
  extractTrustedPersonalizationWorkoutContexts,
  personalizationDiagnosticDetailHtml,
  personalizationDiagnosticsHtml,
} from "../dist/personalizationDiagnosticsView.js";
import { parseWorkoutTemplateDocument } from "../dist/workoutTemplate.js";
import { transformWorkoutData } from "../dist/workoutData.js";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const ATHLETE = "athlete-prov";
const SESSION = "prov-session";
const FORMAL_SESSION = "formal-prov";
const RESOLVED_AT = "2026-09-20T12:00:00.000Z";
const CREATED_AT = "2026-09-20T12:03:00.000Z";
const FORMAL_OBSERVED_AT = "2026-09-01T00:00:00.000Z";
const MACHINE = "proform-smart-power-10";
const KG_PER_LB = 0.45359237;
const START_MS = Date.parse(RESOLVED_AT);
const rawWorkoutData = JSON.parse(readFileSync(new URL("../data.json", import.meta.url), "utf8"));

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    keys() { return [...values.keys()]; },
  };
}

function profile() {
  return {
    schemaVersion: 1,
    athleteId: ATHLETE,
    demographics: { ageYears: 40, bodyMassLbs: 80 / KG_PER_LB },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fitness(overrides = {}) {
  return {
    schemaVersion: 1,
    athleteId: ATHLETE,
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
      },
      source: "formal_assessment",
      quality: "high",
      observedAt: FORMAL_OBSERVED_AT,
      updatedAt: "2026-09-01T00:01:00.000Z",
      algorithm: { id: "bike-submax-linear-hr-workload", version: 1 },
      evidenceSessionIds: [FORMAL_SESSION],
    },
    updatedAt: "2026-09-01T00:01:00.000Z",
    ...overrides,
  };
}

function prescription() {
  return resolveWorkoutPrescription({
    workoutSelector: "Tuesday",
    blocks: { warm: 0, sustain: 3, cool: 0 },
    hrTargets: { main_set: "115-130", main_set_intensity_id: "aerobic_base", main_set_kind: "work", intervals: null },
    resolvedAt: RESOLVED_AT,
  });
}

function e1() {
  return evaluatePersonalizedPrescription({
    legacyPrescription: prescription(),
    workoutIntent: "aerobic_base",
    activity: "bike",
    athleteId: ATHLETE,
    profile: profile(),
    fitnessState: fitness(),
    policy: PHASE_E1_SHADOW_POLICY,
    resolvedAt: RESOLVED_AT,
  });
}

function calibrationIdentity() {
  return {
    athleteId: ATHLETE,
    evidenceSessionIds: [FORMAL_SESSION],
    observedAt: FORMAL_OBSERVED_AT,
    algorithm: { id: "bike-submax-linear-hr-workload", version: 1 },
    protocol: { id: "bike-submax-70rpm", version: 1 },
    workloadProvenance: "measured_watts",
  };
}

function sidecar(machine = { machineId: MACHINE, machineProfileVersion: 1 }, calibration = calibrationIdentity()) {
  return {
    schemaVersion: 1,
    calibration,
    machine,
    sourceSessionId: calibration.evidenceSessionIds[0],
    recordedAt: "2026-09-01T00:02:00.000Z",
  };
}

function start(storage, options = {}) {
  startSession("Tuesday", START_MS, options.sessionId ?? SESSION, "bike", storage, {
    blocks: { warm: 0, sustain: 3, cool: 0 },
    hrTargets: null,
    resolvedPrescription: prescription(),
    shadowPrescriptionEvaluation: options.e1 ?? e1(),
  }, { athleteId: ATHLETE, profileSchemaVersion: 1, fitnessStateSchemaVersion: 1,
    fitnessUpdatedAt: "2026-09-01T00:01:00.000Z" }, options.machineOverride);
  return getSession("Tuesday", storage);
}

function request(origin, observedAtMs, extras = {}) {
  return { decisionId: "d-1", origin, trigger: "decision", requestedResistance: 8, observedAtMs,
    workout: { day: "Tuesday", sessionId: SESSION }, ...extras };
}

// ---------------------------------------------------------------- machine freeze

test("workout machine identity is frozen at start; changing selection later never rewrites it", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", MACHINE, storage);
  const session = start(storage);
  assert.deepEqual(session.executionProvenance.machine, {
    status: "selected", machineId: MACHINE, machineProfileVersion: 1, selectionChangedDuringWorkout: false,
  });
  setSelectedMachine("bike", undefined, storage);
  // Reload: a fresh read returns the frozen start identity, not today's (empty) selection.
  const reloaded = getSession("Tuesday", storage);
  assert.equal(reloaded.executionProvenance.machine.machineId, MACHINE);
  assert.equal(storage.getItem(EQUIPMENT_STORAGE_KEY), "{}");
});

test("summary identity is the start identity even when the runtime machine or profile differs", () => {
  const provenance = createInProgressExecutionProvenance(SESSION,
    { status: "selected", machineId: "machine-a", machineProfileVersion: 3, selectionChangedDuringWorkout: false },
    { status: "no_frozen_calibration" });
  const trace = [{ elapsedSeconds: 0, resistance: 8, cadenceRpm: 70, reason: "start" }];
  const otherMachine = applyFrozenMachineUsageToSummary({ external_session_id: SESSION }, provenance,
    { machineId: "machine-b", profileVersion: 4, guidanceTrace: trace, machineSelectionChanged: true });
  assert.equal(otherMachine.machine_id, "machine-a");
  assert.equal(otherMachine.machine_profile_version, 3);
  assert.equal(otherMachine.machine_guidance_trace, undefined, "B's trace is never filed under A");
  const otherProfile = applyFrozenMachineUsageToSummary({ external_session_id: SESSION }, provenance,
    { machineId: "machine-a", profileVersion: 4, guidanceTrace: trace, machineSelectionChanged: false });
  assert.equal(otherProfile.machine_profile_version, 3);
  assert.equal(otherProfile.machine_guidance_trace, undefined);
  const same = applyFrozenMachineUsageToSummary({ external_session_id: SESSION }, provenance,
    { machineId: "machine-a", profileVersion: 3, guidanceTrace: trace, machineSelectionChanged: false });
  assert.deepEqual(same.machine_guidance_trace, trace);
  const finalized = finalizeExecutionProvenance(provenance, { selectionChangedDuringWorkout: true });
  assert.equal(finalized.machine.machineId, "machine-a");
  assert.equal(finalized.machine.selectionChangedDuringWorkout, true);
});

test("a legacy session without a start snapshot stays unavailable instead of taking the current selection", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", MACHINE, storage);
  start(storage);
  storage.removeItem(executionProvenanceKey("Tuesday"));
  const legacy = getSession("Tuesday", storage);
  assert.equal(legacy.executionProvenance, null);
  const summary = applyFrozenMachineUsageToSummary({ external_session_id: SESSION }, legacy.executionProvenance,
    { machineId: MACHINE, profileVersion: 1, guidanceTrace: [], machineSelectionChanged: false });
  assert.equal(summary.machine_id, undefined);
  assert.equal(summary.machine_profile_version, undefined);
  // An observer cannot create provenance for it either.
  const observer = createActuationProvenanceObserver(storage);
  assert.equal(observer.requested(request("automatic_hr_control", START_MS + 10_000)), undefined);
  assert.equal(getSession("Tuesday", storage).executionProvenance, null);
});

test("no selected machine at start is recorded as none_selected; clearing the session removes provenance", () => {
  const storage = memoryStorage();
  const session = start(storage);
  assert.deepEqual(session.executionProvenance.machine, { status: "none_selected", selectionChangedDuringWorkout: false });
  clearSession("Tuesday", storage);
  assert.equal(storage.getItem(executionProvenanceKey("Tuesday")), null);
});

// ---------------------------------------------------------------- calibration sidecar

test("calibration identity from FitnessState and from the frozen E1 snapshot match exactly", () => {
  const state = parseFitnessState(fitness());
  const evaluation = e1();
  assert.deepEqual(calibrationIdentityFromMetric(ATHLETE, state.hrWorkloadCalibration), calibrationIdentity());
  assert.deepEqual(calibrationIdentityFromE1Snapshot(ATHLETE, evaluation.fitnessEvidenceSnapshot), calibrationIdentity());
});

test("a promoted formal calibration records the machine frozen at assessment start, not later selection", () => {
  const storage = memoryStorage({
    athlete_profile_v1: JSON.stringify(profile()),
    fitness_state_v1: JSON.stringify(fitness()),
  });
  setSelectedMachine("bike", MACHINE, storage);
  startSession("VO2", Date.parse(FORMAL_OBSERVED_AT) - 1_800_000, FORMAL_SESSION, "bike", storage, null,
    { athleteId: ATHLETE, profileSchemaVersion: 1 });
  const assessmentProvenance = getSession("VO2", storage).executionProvenance;
  setSelectedMachine("bike", undefined, storage);
  const summary = {
    external_session_id: FORMAL_SESSION,
    athlete_id: ATHLETE,
    endedAt: FORMAL_OBSERVED_AT,
    execution_provenance: finalizeExecutionProvenance(assessmentProvenance, { selectionChangedDuringWorkout: false }),
  };
  assert.equal(recordPromotedFormalCalibrationMachine(summary, storage, "2026-09-01T00:02:00.000Z"), "recorded");
  assert.equal(recordPromotedFormalCalibrationMachine(summary, storage, "2026-09-01T00:03:00.000Z"), "already_recorded",
    "a retried promotion is idempotent");
  const records = readFormalCalibrationMachineProvenance(storage);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].machine, { machineId: MACHINE, machineProfileVersion: 1 });
  assert.deepEqual(records[0].calibration, calibrationIdentity());
  // An ambiguous assessment identity records nothing.
  const changed = { ...summary, execution_provenance: finalizeExecutionProvenance(assessmentProvenance,
    { selectionChangedDuringWorkout: true }) };
  assert.equal(recordPromotedFormalCalibrationMachine(changed, memoryStorage({
    athlete_profile_v1: JSON.stringify(profile()), fitness_state_v1: JSON.stringify(fitness()),
  })), "not_applicable");
  // A calibration from another assessment is never bound to this machine.
  assert.equal(recordPromotedFormalCalibrationMachine({ ...summary, external_session_id: "other-session" }, storage),
    "not_applicable");
});

test("sidecar provenance survives without the source summary and flows into a later workout start", () => {
  const storage = memoryStorage();
  assert.equal(recordFormalCalibrationMachineProvenance(sidecar(), storage), "recorded");
  // No workout summaries exist at all; the sidecar alone resolves the exact instance.
  setSelectedMachine("bike", MACHINE, storage);
  const session = start(storage);
  assert.deepEqual(session.executionProvenance.calibrationMachine, {
    status: "available", calibration: calibrationIdentity(), machineId: MACHINE, machineProfileVersion: 1,
  });
});

test("historical calibrations without a sidecar stay readable and are never backfilled from selection", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", MACHINE, storage);
  assert.ok(parseFitnessState(fitness()), "historical FitnessState unchanged and readable");
  const session = start(storage);
  assert.deepEqual(session.executionProvenance.calibrationMachine, { status: "unavailable", calibration: calibrationIdentity() });
  assert.equal(storage.getItem(FORMAL_CALIBRATION_MACHINE_PROVENANCE_STORAGE_KEY), null);
  // A near-miss identity (different observedAt) is not matched heuristically.
  recordFormalCalibrationMachineProvenance(sidecar(undefined, { ...calibrationIdentity(), observedAt: "2026-09-02T00:00:00.000Z" }), storage);
  assert.equal(resolveWorkoutCalibrationMachine(calibrationIdentity(), storage).status, "unavailable");
});

test("E1 output is byte-identical with or without calibration machine provenance", () => {
  const before = JSON.stringify(e1());
  const storage = memoryStorage();
  recordFormalCalibrationMachineProvenance(sidecar(), storage);
  start(storage);
  assert.equal(JSON.stringify(e1()), before);
  assert.equal(JSON.stringify(e1()).includes("machine"), false, "E1 carries no machine field");
});

test("conflicting sidecar records are an integrity failure, never last-write-wins", () => {
  const storage = memoryStorage();
  assert.equal(recordFormalCalibrationMachineProvenance(sidecar(), storage), "recorded");
  assert.equal(recordFormalCalibrationMachineProvenance(sidecar({ machineId: MACHINE, machineProfileVersion: 2 }), storage),
    "conflict_recorded");
  assert.deepEqual(lookupCalibrationMachine(readFormalCalibrationMachineProvenance(storage), calibrationIdentity()),
    { status: "integrity_failure" });
  setSelectedMachine("bike", MACHINE, storage);
  assert.equal(start(storage).executionProvenance.calibrationMachine.status, "integrity_failure");
});

test("the sidecar parser fails closed on malformed identity, machine, schema, or store", () => {
  assert.ok(parseFormalCalibrationMachineProvenance(sidecar()));
  for (const [label, mutate] of [
    ["future schema", (value) => { value.schemaVersion = 2; }],
    ["malformed machine id", (value) => { value.machine.machineId = "Bad Machine!"; }],
    ["malformed profile version", (value) => { value.machine.machineProfileVersion = 1.5; }],
    ["zero profile version", (value) => { value.machine.machineProfileVersion = 0; }],
    ["missing evidence sessions", (value) => { value.calibration.evidenceSessionIds = []; }],
    ["unsorted evidence sessions", (value) => { value.calibration.evidenceSessionIds = ["z", "a"]; value.sourceSessionId = "a"; }],
    ["missing observedAt", (value) => { delete value.calibration.observedAt; }],
    ["missing protocol", (value) => { delete value.calibration.protocol; }],
    ["unknown key", (value) => { value.machine.serial = "x"; }],
    ["source not in calibration", (value) => { value.sourceSessionId = "elsewhere"; }],
    ["recorded before calibration", (value) => { value.recordedAt = "2026-08-01T00:00:00.000Z"; }],
  ]) {
    const value = structuredClone(sidecar());
    mutate(value);
    assert.equal(parseFormalCalibrationMachineProvenance(value), null, label);
  }
  assert.equal(parseFormalCalibrationMachineProvenanceStore(JSON.stringify([sidecar(), { schemaVersion: 9 }])), null);
  assert.equal(parseFormalCalibrationMachineProvenanceStore("not json"), null);
  const storage = memoryStorage({ [FORMAL_CALIBRATION_MACHINE_PROVENANCE_STORAGE_KEY]: "[{\"schemaVersion\":9}]" });
  assert.equal(recordFormalCalibrationMachineProvenance(sidecar(), storage), "store_untrustworthy");
  assert.equal(storage.getItem(FORMAL_CALIBRATION_MACHINE_PROVENANCE_STORAGE_KEY), "[{\"schemaVersion\":9}]");
  assert.equal(resolveWorkoutCalibrationMachine(calibrationIdentity(), storage).status, "integrity_failure");
});

// ---------------------------------------------------------------- explicit actuation origin

test("recommendation origin comes from the structured guidance branch", () => {
  const work = { phaseKind: "work", guidancePhaseChanged: true };
  assert.equal(classifyRecommendationOrigin({ ...work, holdResistance: 9 }), "vo2_protocol_fixed_resistance");
  assert.equal(classifyRecommendationOrigin({ phaseKind: "warmup", guidancePhaseChanged: false }), "scripted_phase_program");
  assert.equal(classifyRecommendationOrigin({ phaseKind: "cooldown", guidancePhaseChanged: true }), "scripted_phase_program");
  assert.equal(classifyRecommendationOrigin({ phaseKind: "recovery", guidancePhaseChanged: true }), "scripted_phase_program");
  assert.equal(classifyRecommendationOrigin({ phaseKind: "recovery", guidancePhaseChanged: false }), "automatic_hr_control");
  assert.equal(classifyRecommendationOrigin(work), "default_starting_resistance");
  assert.equal(classifyRecommendationOrigin({ ...work, learnedStartingResistance: 9 }), "learned_starting_resistance");
  assert.equal(classifyRecommendationOrigin({ ...work, learnedStartingResistance: 9, priorNextWorkResistance: 10 }),
    "controller_carryover");
  assert.equal(classifyRecommendationOrigin({ phaseKind: "work", guidancePhaseChanged: false }), "automatic_hr_control");
  assert.equal(ACTUATION_ORIGINS.includes("manual_user"), false, "no manual origin without a manual input path");
});

test("live runtime: phase start is initialization, HR-driven adjustments are automatic", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", MACHINE, storage);
  resetMachineGuidanceRuntime("origin-session");
  const base = { sessionId: "origin-session", activity: "bike", phaseKind: "work", phaseId: "sustain",
    phaseDisplayName: "Sustain", phaseDurationSeconds: 600, targetHeartRateMin: 120, targetHeartRateMax: 130,
    intent: "aerobic_base" };
  const changes = [];
  for (let second = 0; second <= 100; second += 1) {
    recordMachineHeartRateSample("origin-session", second, 160);
    const update = updateMachineGuidanceRuntime({ ...base, phaseElapsedSeconds: second, workoutElapsedSeconds: second }, storage);
    if (update.recommendationChanged) changes.push([second, update.actuationOrigin]);
  }
  assert.deepEqual(changes, [[0, "default_starting_resistance"], [90, "automatic_hr_control"]]);
});

function fakeBridge() {
  const state = { posts: [], failNextPost: null };
  const transport = {
    async request(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/api/v1/status") {
        return { status: 200, text: JSON.stringify({ status: "ok", bridgeVersion: "0.1.0", connected: true,
          initialized: true, resistanceControlAvailable: true,
          resistance: { requested: null, requestedAt: null, observed: 3, observedAt: "2026-09-20T12:00:00.000Z" } }) };
      }
      if (req.method === "GET" && path === "/api/v1/telemetry") {
        const metric = (value) => ({ value, observedAt: "2026-09-20T12:00:00.000Z", current: true });
        return { status: 200, text: JSON.stringify({ connected: true, initialized: true,
          snapshotAt: "2026-09-20T12:00:00.000Z", resistance: metric(3), rpm: metric(70), watts: metric(120), machine: null }) };
      }
      if (req.method === "POST" && path === "/api/v1/resistance") {
        state.posts.push(req.jsonBody.value);
        if (state.failNextPost) {
          const status = state.failNextPost;
          state.failNextPost = null;
          return { status, text: JSON.stringify({ error: "failed" }) };
        }
        return { status: 200, text: JSON.stringify({ requested: req.jsonBody.value }) };
      }
      return { status: 200, text: JSON.stringify({ requested: req.jsonBody?.value ?? 0 }) };
    },
  };
  return { state, transport };
}

async function waitUntil(predicate, ms = 500) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}

async function readyBridge(fake, observer) {
  const session = createBikeBridgeSession({ storage: memoryStorage(), transport: fake.transport,
    pollIntervalMs: 1000, requestTimeoutMs: 50 });
  session.configure({ baseUrl: "http://192.168.1.10:8765", automaticControlEnabled: true });
  if (observer) session.setActuationObserver(observer);
  session.start();
  await waitUntil(() => session.getViewState().readiness === "control_ready");
  return session;
}

test("Bike Bridge reports each posted command with explicit origin; re-sends reuse the decision", async () => {
  const fake = fakeBridge();
  const requests = [];
  const outcomes = [];
  const session = await readyBridge(fake, {
    requested(value) { requests.push(value); return requests.length; },
    resolved(token, outcome) { outcomes.push([token, outcome]); },
  });
  try {
    session.onGuidance({ desiredResistance: 8, recommendationChanged: true, workoutActive: true, paused: false,
      actuationOrigin: "default_starting_resistance" });
    await waitUntil(() => outcomes.length === 1);
    session.onGuidance({ desiredResistance: 8, recommendationChanged: false, workoutActive: true, paused: true });
    session.onGuidance({ desiredResistance: 8, recommendationChanged: false, workoutActive: true, paused: false });
    await waitUntil(() => outcomes.length === 2);
    session.onGuidance({ desiredResistance: 7, recommendationChanged: true, workoutActive: true, paused: false,
      actuationOrigin: "automatic_hr_control" });
    await waitUntil(() => outcomes.length === 3);
    // Desired/commanded state without a recommendation change never invents a new decision.
    session.onGuidance({ desiredResistance: 7, recommendationChanged: false, workoutActive: true, paused: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((item) => [item.origin, item.trigger, item.requestedResistance]), [
      ["default_starting_resistance", "decision", 8],
      ["default_starting_resistance", "reconciliation_resend", 8],
      ["automatic_hr_control", "decision", 7],
    ]);
    assert.equal(requests[0].decisionId, requests[1].decisionId, "a re-send is the same logical decision");
    assert.notEqual(requests[2].decisionId, requests[0].decisionId);
    assert.deepEqual(outcomes.map(([, outcome]) => outcome), ["accepted", "accepted", "accepted"]);
  } finally {
    session.stop();
  }
});

test("prospective fixed-load reconciliation keeps its scripted origin and decision identity", async () => {
  const fake = fakeBridge();
  const requests = [];
  const outcomes = [];
  const session = await readyBridge(fake, {
    requested(value) { requests.push(value); return requests.length; },
    resolved(token, outcome) { outcomes.push([token, outcome]); },
  });
  try {
    session.onGuidance({
      desiredResistance: 8,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
      actuationOrigin: "scripted_phase_program",
    });
    await waitUntil(() => outcomes.length === 1);
    session.onGuidance({
      desiredResistance: 8,
      recommendationChanged: false,
      workoutActive: true,
      paused: true,
    });
    session.onGuidance({
      desiredResistance: 8,
      recommendationChanged: false,
      workoutActive: true,
      paused: false,
    });
    await waitUntil(() => outcomes.length === 2);
    assert.deepEqual(requests.map((item) => [item.origin, item.trigger, item.requestedResistance]), [
      ["scripted_phase_program", "decision", 8],
      ["scripted_phase_program", "reconciliation_resend", 8],
    ]);
    assert.equal(requests[0].decisionId, requests[1].decisionId);
  } finally {
    session.stop();
  }
});

test("provenance capture never changes posted commands, and observer failures are contained", async () => {
  const sequence = async (observer) => {
    const fake = fakeBridge();
    const session = await readyBridge(fake, observer);
    try {
      session.onGuidance({ desiredResistance: 8, recommendationChanged: true, workoutActive: true, paused: false,
        actuationOrigin: observer ? "default_starting_resistance" : undefined });
      await waitUntil(() => fake.state.posts.length === 1);
      session.onGuidance({ desiredResistance: 6, recommendationChanged: true, workoutActive: true, paused: false });
      await waitUntil(() => fake.state.posts.length === 2);
      return fake.state.posts;
    } finally {
      session.stop();
    }
  };
  const plain = await sequence(null);
  const throwing = await sequence({ requested() { throw new Error("boom"); }, resolved() { throw new Error("boom"); } });
  assert.deepEqual(throwing, plain);
  assert.deepEqual(plain, [8, 6]);
});

// ---------------------------------------------------------------- session capture, timing, phases

test("observer events persist on the active clock, survive reload, and pause never shifts phase time", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", MACHINE, storage);
  start(storage);
  const observer = createActuationProvenanceObserver(storage);
  const first = observer.requested(request("default_starting_resistance", START_MS + 500, { decisionId: "e-1" }));
  observer.resolved(first, "accepted");
  // Pause at active 60 s for 5 minutes, then resume: active time continues from 60 s.
  pauseSession("Tuesday", 60, storage, START_MS + 60_000);
  assert.equal(observer.requested(request("automatic_hr_control", START_MS + 120_000, { decisionId: "e-2" })), undefined,
    "a paused session cannot place an event");
  resumeSession("Tuesday", storage, START_MS + 360_000);
  const second = observer.requested(request("automatic_hr_control", START_MS + 390_000, { decisionId: "e-3", requestedResistance: 7 }));
  observer.resolved(second, "accepted");
  const reloaded = readInProgressExecutionProvenance("Tuesday", storage);
  assert.deepEqual(reloaded.actuation.events.map((event) => [event.commandId, event.activeSec, event.origin, event.outcome]), [
    [1, 0, "default_starting_resistance", "accepted"],
    [2, 90, "automatic_hr_control", "accepted"],
  ]);
  assert.equal(reloaded.actuation.coverage, "incomplete", "the unplaceable paused request is visible");
  assert.deepEqual(reloaded.actuation.incompleteReasons, ["active_clock_unavailable"]);
});

function phases(boundaries) {
  return boundaries.map(([phaseId, activeStartSec, activeEndSec]) => ({ phaseId, kind: "work", activeStartSec, activeEndSec }));
}

function provenanceWith(events, coverage = "complete") {
  const record = createInProgressExecutionProvenance(SESSION,
    { status: "selected", machineId: MACHINE, machineProfileVersion: 1, selectionChangedDuringWorkout: false },
    { status: "no_frozen_calibration" });
  record.actuation.events = events.map(([activeSec, origin, outcome = "accepted", decisionId], index) => ({
    commandId: index + 1,
    decisionId: decisionId ?? `d-${index + 1}`,
    origin,
    trigger: "decision",
    requestedResistance: 8,
    activeSec,
    observedAt: new Date(START_MS + activeSec * 1000).toISOString(),
    outcome,
  }));
  if (coverage === "incomplete") {
    record.actuation.coverage = "incomplete";
    record.actuation.incompleteReasons = ["persistence_failed"];
  }
  return record;
}

test("per-phase actuation mode is derived deterministically from explicit events and frozen boundaries", () => {
  const record = provenanceWith([
    [0, "default_starting_resistance"],
    [65, "automatic_hr_control"],
    [90, "automatic_hr_control"],
    [120, "scripted_phase_program"],
    [240, "unclassified"],
  ]);
  const summaries = derivePhaseActuationSummaries(record.actuation,
    phases([["a", 0, 120], ["b", 120, 180], ["c", 180, 240], ["d", 240, 300]]));
  assert.deepEqual(summaries.map((phase) => [phase.phaseId, phase.mode, phase.automaticAcceptedCount,
    phase.programmaticAcceptedCount, phase.ambiguousCount]), [
    ["a", "automatic", 2, 1, 0],
    ["b", "programmatic", 0, 1, 0],
    ["c", "none", 0, 0, 0],
    ["d", "unknown", 0, 0, 1],
  ]);
  assert.equal(summaries[1].activeStartSec, 120, "an event exactly at a boundary belongs to the later phase");
  const ambiguous = derivePhaseActuationSummaries(provenanceWith([[10, "automatic_hr_control", "timeout"]]).actuation,
    phases([["a", 0, 120]]));
  assert.equal(ambiguous[0].mode, "unknown");
  const failed = derivePhaseActuationSummaries(provenanceWith([[10, "automatic_hr_control", "failed"]]).actuation,
    phases([["a", 0, 120]]));
  assert.deepEqual([failed[0].mode, failed[0].rejectedCount], ["unknown", 1], "a failed app command is not none");
  const unavailable = derivePhaseActuationSummaries(provenanceWith([[10, "scripted_phase_program", "unavailable"]]).actuation,
    phases([["a", 0, 120]]));
  assert.deepEqual([unavailable[0].mode, unavailable[0].rejectedCount], ["unknown", 1]);
  const rejectedBesideAccepted = derivePhaseActuationSummaries(provenanceWith([
    [10, "automatic_hr_control"], [20, "automatic_hr_control", "failed"],
  ]).actuation, phases([["a", 0, 120]]));
  assert.deepEqual([rejectedBesideAccepted[0].mode, rejectedBesideAccepted[0].automaticAcceptedCount,
    rejectedBesideAccepted[0].rejectedCount], ["unknown", 1, 1], "counts are preserved");
  const empty = derivePhaseActuationSummaries(provenanceWith([]).actuation, phases([["a", 0, 120]]));
  assert.equal(empty[0].mode, "none", "zero events under complete capture stays none");
  const incomplete = derivePhaseActuationSummaries(provenanceWith([], "incomplete").actuation, phases([["a", 0, 120]]));
  assert.equal(incomplete[0].mode, "unknown", "no events under incomplete capture is never none");
  const resend = provenanceWith([[10, "automatic_hr_control", "accepted", "x"], [70, "automatic_hr_control", "accepted", "x"]]);
  resend.actuation.events[1].trigger = "reconciliation_resend";
  const resendSummary = derivePhaseActuationSummaries(resend.actuation, phases([["a", 0, 120]]));
  assert.equal(resendSummary[0].decisionCount, 1, "a re-send is not a second decision");
});

test("commanded or observed resistance alone never creates an actuation event", () => {
  const record = provenanceWith([]);
  // Phase boundaries exist and telemetry may show commanded/observed changes elsewhere; only explicit events count.
  const finalized = finalizeExecutionProvenance(record, { selectionChangedDuringWorkout: false, phases: phases([["a", 0, 180]]) });
  assert.equal(finalized.actuation.events.length, 0);
  assert.equal(finalized.actuation.phases[0].mode, "none");
  const source = readFileSync(new URL("../src/executionProvenance.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /commandedResistance|desiredResistance|observedResistance/);
});

test("the strict provenance parser round-trips and fails closed on malformed data and future schemas", () => {
  const record = finalizeExecutionProvenance(provenanceWith([[0, "default_starting_resistance"], [90, "automatic_hr_control"]]),
    { selectionChangedDuringWorkout: false, phases: phases([["a", 0, 180]]) });
  assert.deepEqual(parseWorkoutExecutionProvenance(structuredClone(record)), record);
  for (const [label, mutate] of [
    ["future schema", (value) => { value.schemaVersion = 2; }],
    ["unknown origin", (value) => { value.actuation.events[0].origin = "manual_user"; }],
    ["unknown trigger", (value) => { value.actuation.events[0].trigger = "retry"; }],
    ["negative active time", (value) => { value.actuation.events[0].activeSec = -1; }],
    ["fractional active time", (value) => { value.actuation.events[0].activeSec = 1.5; }],
    ["time reversal", (value) => { value.actuation.events[1].activeSec = 0; value.actuation.events[0].activeSec = 5; }],
    ["bad observedAt", (value) => { value.actuation.events[0].observedAt = "yesterday"; }],
    ["command id gap", (value) => { value.actuation.events[1].commandId = 5; }],
    ["decision origin conflict", (value) => { value.actuation.events[1].decisionId = value.actuation.events[0].decisionId; }],
    ["forged phase mode", (value) => { value.actuation.phases[0].mode = "none"; }],
    ["forged phase count", (value) => { value.actuation.phases[0].automaticAcceptedCount = 0; }],
    ["malformed machine", (value) => { value.machine.machineId = ""; }],
    ["coverage without reasons", (value) => { value.actuation.coverage = "incomplete"; }],
    ["console claimed observable", (value) => { value.actuation.consoleResistanceChanges = "observed"; }],
    ["unknown key", (value) => { value.actuationMode = "manual"; }],
  ]) {
    const value = structuredClone(record);
    mutate(value);
    assert.equal(parseWorkoutExecutionProvenance(value), null, label);
  }
});

// ---------------------------------------------------------------- end-to-end finalization and persistence

async function finishWorkout(storage, configure) {
  await resetWorkoutStorageForTests();
  const bikeWorkoutData = structuredClone(rawWorkoutData);
  bikeWorkoutData.weekly_plan.find((workout) => workout.day === "Tuesday").activities = ["bike"];
  transformWorkoutData(parseWorkoutTemplateDocument(bikeWorkoutData), START_MS);
  globalThis.localStorage = storage;
  globalThis.window = { getWorkoutMetadata: () => ({ Tuesday: { intent: "aerobic_base", activities: ["bike"] } }) };
  start(storage);
  if (configure) configure();
  for (let second = 0; second < 180; second += 1) {
    await storeHrSample(SESSION, second, second < 30 ? 105 : 120);
    await storeOrdinaryBikeTelemetrySample({
      schemaVersion: 1, athleteId: ATHLETE, sessionId: SESSION, activeSec: second,
      observedAt: new Date(START_MS + second * 1000).toISOString(), availability: "fresh",
      sourceSampleId: `s-${second}`, freshnessMs: 0,
      watts: { value: 125, source: "measured_watts", freshnessMs: 0 },
      cadenceRpm: { value: 70, source: "measured", freshnessMs: 0 },
      observedResistance: { value: second < 90 ? 8 : 9, source: "observed", freshnessMs: 0 },
      desiredResistance: 8, commandedResistance: 8,
    });
  }
  return generateWorkoutSummary(SESSION, START_MS, Date.parse(CREATED_AT), "Tuesday");
}

test("finalization writes the frozen identity and durable provenance; history reload keeps sparse timing", async () => {
  const storage = memoryStorage({ athlete_profile_v1: JSON.stringify(profile()) });
  setSelectedMachine("bike", MACHINE, storage);
  recordFormalCalibrationMachineProvenance(sidecar(), storage);
  const summary = await finishWorkout(storage, () => {
    const observer = createActuationProvenanceObserver(storage);
    observer.resolved(observer.requested(request("default_starting_resistance", START_MS + 1_000, { decisionId: "f-1" })), "accepted");
    observer.resolved(observer.requested(request("automatic_hr_control", START_MS + 95_000,
      { decisionId: "f-2", requestedResistance: 9 })), "accepted");
    setSelectedMachine("bike", undefined, storage);
  });
  assert.equal(summary.machine_id, MACHINE, "start identity survives a later selection change");
  assert.equal(summary.machine_profile_version, 1);
  const provenance = summary.execution_provenance;
  assert.equal(provenance.calibrationMachine.status, "available");
  assert.deepEqual(provenance.actuation.events.map((event) => [event.activeSec, event.origin]),
    [[1, "default_starting_resistance"], [95, "automatic_hr_control"]]);
  assert.equal(provenance.actuation.phases.length, 1);
  assert.equal(provenance.actuation.phases[0].mode, "automatic");
  assert.ok(summary.shadow_prescription_characterization, "E2 is still produced");
  assert.equal(summary.shadow_prescription_characterization.schemaVersion, 3, "E2 v3 unchanged");
  assert.equal(JSON.stringify(summary.shadow_prescription_characterization).includes("actuation"), false);
  assert.equal("execution_provenance" in buildSisuWorkoutPayload(summary), false);

  assert.equal(await storeWorkoutSummary(summary), true);
  const history = await getAllWorkoutSummaries();
  const stored = history.find((row) => row.summary.external_session_id === SESSION).summary;
  assert.deepEqual(stored.execution_provenance, provenance, "sparse timing survives persistence");
  const forged = { ...summary, external_session_id: "forged-session" };
  forged.execution_provenance = { ...structuredClone(provenance), sessionId: "forged-session" };
  forged.execution_provenance.actuation.phases[0].mode = "none";
  const linked = { ...summary, external_session_id: "linked-session",
    execution_provenance: { ...structuredClone(provenance), sessionId: "linked-session" } };
  assert.equal(await storeWorkoutSummary(linked), true);
  assert.equal(await storeWorkoutSummary(forged), true);
  const reloaded = await getAllWorkoutSummaries();
  assert.equal(reloaded.find((row) => row.summary.external_session_id === "forged-session").summary.execution_provenance,
    undefined, "a forged phase summary is dropped on read");
  assert.equal(reloaded.find((row) => row.summary.external_session_id === "linked-session").summary
    .execution_provenance.sessionId, "linked-session", "the same provenance correctly linked is kept");

  const records = extractTrustedPersonalizationCharacterizations(reloaded, ATHLETE);
  const contexts = extractTrustedExecutionProvenanceContexts(reloaded, ATHLETE);
  const model = buildPersonalizationDiagnosticsModel(records, undefined,
    extractTrustedPersonalizationAssessmentContexts(reloaded, ATHLETE),
    extractTrustedPersonalizationWorkoutContexts(reloaded, ATHLETE), {}, "2026-09-21T00:00:00.000Z", contexts);
  // Production E4A (policy v2) without a v2 join: open-loop stays unavailable, no runtime authority,
  // and provenance absence is reported truthfully instead of the v1 generic actuation_mode_unknown.
  assert.ok(model.scientificAssessments.length > 0);
  for (const assessment of model.scientificAssessments) {
    assert.equal(assessment.runtimeAuthority, false);
    assert.notEqual(assessment.state, "eligible");
    assert.deepEqual(assessment.policy, { id: "e4a-scientific-assessment-policy", version: 2 });
    assert.ok(assessment.reasonCodes.includes("open_loop_evidence_unavailable"));
    assert.equal(assessment.reasonCodes.includes("actuation_mode_unknown"), false);
  }
  const html = personalizationDiagnosticsHtml(model);
  const section = html.slice(html.indexOf("id=\"personalizationExecutionProvenance\""));
  assert.match(section, /Machine and actuation provenance/);
  assert.match(section, /Calibration vs workout: same \/ other machine \/ other profile/);
  const row = model.rows.find((item) => item.record.workoutSessionId === SESSION);
  const detail = personalizationDiagnosticDetailHtml(row);
  assert.match(detail, /<h5>Machine provenance<\/h5>/);
  assert.match(detail, /<h5>Actuation provenance<\/h5>/);
  assert.match(detail, /proform-smart-power-10 \/ profile 1/);
  assert.match(detail, /Same machine and profile/);
  assert.match(detail, /Automatic HR control/);
  const provenanceText = detail.slice(detail.indexOf("<h5>Machine provenance"));
  assert.doesNotMatch(provenanceText, /open-loop|validated|approved|\bsafe\b|authorized/i);
  const exported = JSON.stringify(createPersonalizationDiagnosticsExport(model));
  assert.equal(exported.includes("execution_provenance") || exported.includes("executionProvenance"), false,
    "export v3 is unchanged");
});

test("calibration and workout machine mismatches stay observable, including profile-only differences", async () => {
  const { calibrationWorkoutMachineComparison } = await import("../dist/personalizationDiagnosticsView.js");
  const record = (calibration) => ({
    ...provenanceWith([]),
    calibrationMachine: { status: "available", calibration: calibrationIdentity(), ...calibration },
  });
  assert.equal(calibrationWorkoutMachineComparison(record({ machineId: "machine-b", machineProfileVersion: 1 })), "different_machine");
  assert.equal(calibrationWorkoutMachineComparison(record({ machineId: MACHINE, machineProfileVersion: 2 })),
    "same_machine_different_profile");
  assert.equal(calibrationWorkoutMachineComparison(record({ machineId: MACHINE, machineProfileVersion: 1 })),
    "same_machine_and_profile");
  assert.equal(calibrationWorkoutMachineComparison(null), "unavailable");
});

test("historical summaries without provenance stay readable with unknown provenance", async () => {
  const storage = memoryStorage({ athlete_profile_v1: JSON.stringify(profile()) });
  const summary = await finishWorkout(storage);
  const historical = {
    ...summary,
    external_session_id: "historical",
    workout_response: { ...summary.workout_response, sessionId: "historical" },
    shadow_prescription_characterization: { ...summary.shadow_prescription_characterization, workoutSessionId: "historical" },
  };
  delete historical.execution_provenance;
  assert.equal(await storeWorkoutSummary(historical), true);
  const history = await getAllWorkoutSummaries();
  const stored = history.find((row) => row.summary.external_session_id === "historical").summary;
  assert.equal(stored.execution_provenance, undefined);
  assert.deepEqual(extractTrustedExecutionProvenanceContexts(history, ATHLETE).historical, undefined);
  const model = buildPersonalizationDiagnosticsModel(extractTrustedPersonalizationCharacterizations(history, ATHLETE));
  const row = model.rows.find((item) => item.record.workoutSessionId === "historical");
  assert.match(personalizationDiagnosticDetailHtml(row), /not recorded \(historical workout\)/);
});

test("provenance has no path into prescription, guidance, control, E1, E2, or FitnessState", () => {
  const forbidden = /executionProvenance|calibrationMachineProvenance|actuationProvenanceObserver|execution_provenance/;
  // E4A v2 consumes only structural provenance-derived evidence handed to it; it still imports nothing.
  for (const file of ["workoutPrescription.ts", "personalizedPrescription.ts", "personalizedPrescriptionCharacterization.ts",
    "fitnessState.ts", "fitnessRefinement.ts", "machines/guidance.ts",
    "machines/proformSmartPower10.ts", "machines/learning/index.ts", "machines/dynamics/index.ts", "workoutLogic.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), forbidden, file);
  }
  const bridge = readFileSync(new URL("../src/platform/bikeBridgeRuntime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(bridge, forbidden, "the bridge only exposes an observer seam");
  const e4a = readFileSync(new URL("../src/personalizationScientificAssessment.ts", import.meta.url), "utf8");
  assert.doesNotMatch(e4a, /from ["']\.\//, "E4A imports nothing");
  assert.match(e4a, /openLoopEvidence: "required_but_unavailable"/);
  assert.match(e4a, /actuationModeEvidence: "required_but_unavailable"/);
});

test("sidecar promotion uses the assessment's frozen athlete, never the currently loaded profile", () => {
  const ATHLETE_B = "athlete-other";
  const storage = memoryStorage({
    // The UI has since switched to athlete B; A's promoted FitnessState is what promotion wrote.
    athlete_profile_v1: JSON.stringify({ ...profile(), athleteId: ATHLETE_B }),
    fitness_state_v1: JSON.stringify(fitness()),
  });
  setSelectedMachine("bike", MACHINE, storage);
  startSession("VO2", Date.parse(FORMAL_OBSERVED_AT) - 1_800_000, FORMAL_SESSION, "bike", storage, null,
    { athleteId: ATHLETE, profileSchemaVersion: 1 });
  const provenance = finalizeExecutionProvenance(getSession("VO2", storage).executionProvenance,
    { selectionChangedDuringWorkout: false });
  const summary = { external_session_id: FORMAL_SESSION, athlete_id: ATHLETE, endedAt: FORMAL_OBSERVED_AT,
    execution_provenance: provenance };
  assert.equal(recordPromotedFormalCalibrationMachine(summary, storage, "2026-09-01T00:02:00.000Z"), "recorded");
  const records = readFormalCalibrationMachineProvenance(storage);
  assert.equal(records.length, 1);
  assert.equal(records[0].calibration.athleteId, ATHLETE);
  assert.equal(lookupCalibrationMachine(records, calibrationIdentity()).status, "available");
  assert.equal(lookupCalibrationMachine(records, { ...calibrationIdentity(), athleteId: ATHLETE_B }).status, "unavailable",
    "no cross-athlete lookup succeeds");
  // Without a trustworthy frozen athlete nothing is written, even though a profile is loaded.
  const anonymous = memoryStorage({ athlete_profile_v1: JSON.stringify(profile()), fitness_state_v1: JSON.stringify(fitness()) });
  const { athlete_id: _omitted, ...withoutAthlete } = summary;
  assert.equal(recordPromotedFormalCalibrationMachine(withoutAthlete, anonymous), "not_applicable");
  assert.equal(anonymous.getItem(FORMAL_CALIBRATION_MACHINE_PROVENANCE_STORAGE_KEY), null);
  // A summary claiming athlete B cannot bind A's stored calibration.
  const claimsB = memoryStorage({ fitness_state_v1: JSON.stringify(fitness()) });
  assert.equal(recordPromotedFormalCalibrationMachine({ ...summary, athlete_id: ATHLETE_B }, claimsB), "not_applicable");
  assert.equal(claimsB.getItem(FORMAL_CALIBRATION_MACHINE_PROVENANCE_STORAGE_KEY), null);
});

test("commands are routed by the workout session that produced them, never the UI's selected day", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", MACHINE, storage);
  start(storage);
  // Another day's session also exists with its own provenance record.
  startSession("Wednesday", START_MS, "wednesday-session", "bike", storage, null,
    { athleteId: ATHLETE, profileSchemaVersion: 1 });
  const observer = createActuationProvenanceObserver(storage);
  // The UI now shows Wednesday; the Tuesday workout's command still carries Tuesday's session.
  const token = observer.requested(request("automatic_hr_control", START_MS + 30_000));
  observer.resolved(token, "accepted");
  assert.equal(readInProgressExecutionProvenance("Tuesday", storage).actuation.events.length, 1);
  assert.equal(readInProgressExecutionProvenance("Wednesday", storage).actuation.events.length, 0);
  // A command for a replaced or ended session is never written into another session's record.
  assert.equal(observer.requested(request("automatic_hr_control", START_MS + 40_000,
    { workout: { day: "Wednesday", sessionId: SESSION } })), undefined);
  assert.equal(observer.requested(request("automatic_hr_control", START_MS + 40_000, { workout: undefined })), undefined);
  assert.equal(readInProgressExecutionProvenance("Wednesday", storage).actuation.events.length, 0);
  const source = readFileSync(new URL("../src/uiControls.ts", import.meta.url), "utf8");
  assert.match(source, /createActuationProvenanceObserver\(\)/);
  assert.doesNotMatch(source, /createActuationProvenanceObserver\(getSelectedDay\)/);
});

test("the Bike Bridge carries the guidance session context onto each posted command", async () => {
  const fake = fakeBridge();
  const requests = [];
  const session = await readyBridge(fake, { requested(value) { requests.push(value); return requests.length; }, resolved() {} });
  try {
    session.onGuidance({ desiredResistance: 8, recommendationChanged: true, workoutActive: true, paused: false,
      actuationOrigin: "default_starting_resistance", workout: { day: "Tuesday", sessionId: SESSION } });
    await waitUntil(() => requests.length === 1);
    assert.deepEqual(requests[0].workout, { day: "Tuesday", sessionId: SESSION });
  } finally {
    session.stop();
  }
});

// ---------------------------------------------------------------- v1 capacity

function cappedRecord(count) {
  const record = provenanceWith([]);
  record.actuation.events = Array.from({ length: count }, (_, index) => ({
    commandId: index + 1,
    decisionId: `cap-${index + 1}`,
    origin: "automatic_hr_control",
    trigger: "decision",
    requestedResistance: 8,
    activeSec: index,
    observedAt: new Date(START_MS + index * 1000).toISOString(),
    outcome: "accepted",
  }));
  return record;
}

test("the writer never persists event 5,001; capacity exhaustion is persistence_failed within v1", () => {
  assert.equal(MAX_EXECUTION_PROVENANCE_EVENTS, 5000);
  const at4999 = cappedRecord(4999);
  assert.ok(parseWorkoutExecutionProvenance(structuredClone(at4999)), "4,999 events are valid");
  const fifth = appendActuationEvent(at4999, request("automatic_hr_control", START_MS + 5_000_000,
    { decisionId: "cap-5000" }), 5000);
  assert.equal(fifth.commandId, 5000);
  assert.equal(fifth.record.actuation.events.length, 5000);
  assert.equal(fifth.record.actuation.coverage, "complete");
  assert.ok(parseWorkoutExecutionProvenance(structuredClone(fifth.record)), "5,000 events round-trip");
  const eventsBefore = structuredClone(fifth.record.actuation.events);
  const overflow = appendActuationEvent(fifth.record, request("automatic_hr_control", START_MS + 5_001_000,
    { decisionId: "cap-5001" }), 5001);
  assert.equal(overflow.commandId, null, "no provenance token for an unpersisted command");
  assert.deepEqual(overflow.record.actuation.events, eventsBefore, "existing events unchanged; nothing evicted");
  assert.equal(overflow.record.actuation.coverage, "incomplete");
  assert.deepEqual(overflow.record.actuation.incompleteReasons, ["persistence_failed"]);
  assert.ok(parseWorkoutExecutionProvenance(structuredClone(overflow.record)), "strict v1 parsing still succeeds");
  let later = overflow.record;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    later = appendActuationEvent(later, request("automatic_hr_control", START_MS + 5_002_000 + attempt,
      { decisionId: `later-${attempt}` }), 5002 + attempt).record;
  }
  assert.equal(later.actuation.events.length, 5000);
  assert.deepEqual(later.actuation.incompleteReasons, ["persistence_failed"], "the reason appears exactly once");
  assert.ok(parseWorkoutExecutionProvenance(structuredClone(later)));
  const finalized = finalizeExecutionProvenance(later, { selectionChangedDuringWorkout: false,
    phases: phases([["after", 6000, 7000]]) });
  assert.ok(finalized);
  assert.equal(finalized.actuation.phases[0].mode, "unknown", "a phase after the cap cannot claim none");
});

test("the persisted in-progress record stays bounded and readable after the cap", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", MACHINE, storage);
  start(storage);
  writeInProgressExecutionProvenance("Tuesday", { ...cappedRecord(5000), sessionId: SESSION }, storage);
  const session = getSession("Tuesday", storage);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(recordActuationRequest("Tuesday", session, request("automatic_hr_control", START_MS + 5_100_000 + attempt,
      { decisionId: `stored-${attempt}` }), storage), null);
  }
  const stored = readInProgressExecutionProvenance("Tuesday", storage);
  assert.equal(stored.actuation.events.length, 5000);
  assert.equal(stored.actuation.coverage, "incomplete");
  assert.deepEqual(stored.actuation.incompleteReasons, ["persistence_failed"]);
});

// ---------------------------------------------------------------- published v1 writer compatibility

/** Independent reproduction of the published b7fef00 phase-mode rule (failed/unavailable ignored). */
function publishedB7fef00Summaries(record, boundaries) {
  return derivePhaseActuationSummaries(record.actuation, boundaries).map((summary) => {
    let mode;
    if (record.actuation.coverage !== "complete" || summary.ambiguousCount > 0) mode = "unknown";
    else if (summary.automaticAcceptedCount > 0) mode = "automatic";
    else if (summary.programmaticAcceptedCount > 0) mode = "programmatic";
    else mode = "none";
    return { ...summary, mode };
  });
}

function historicalRecord(events, boundaries) {
  const record = provenanceWith(events);
  record.actuation.phases = publishedB7fef00Summaries(record, boundaries);
  return record;
}

test("genuine b7fef00 records are preserved and returned with canonical phase modes", () => {
  const boundaries = phases([["a", 0, 120]]);
  for (const [label, events, historicalMode] of [
    ["failed-only", [[10, "automatic_hr_control", "failed"]], "none"],
    ["unavailable-only", [[10, "scripted_phase_program", "unavailable"]], "none"],
    ["automatic + failed", [[10, "automatic_hr_control"], [20, "automatic_hr_control", "failed"]], "automatic"],
    ["programmatic + unavailable", [[10, "default_starting_resistance"], [20, "scripted_phase_program", "unavailable"]],
      "programmatic"],
  ]) {
    const record = historicalRecord(events, boundaries);
    assert.equal(record.actuation.phases[0].mode, historicalMode, `${label}: matches the published derivation`);
    assert.notDeepEqual(record.actuation.phases, derivePhaseActuationSummaries(record.actuation, boundaries),
      `${label}: differs from canonical`);
    const parsed = parseWorkoutExecutionProvenance(structuredClone(record));
    assert.ok(parsed, `${label}: accepted through published-writer compatibility`);
    assert.equal(parsed.actuation.phases[0].mode, "unknown", `${label}: canonical mode returned`);
    assert.deepEqual(parsed.actuation.events, record.actuation.events, `${label}: sparse events unchanged`);
    const { mode: _historical, ...historicalCounts } = record.actuation.phases[0];
    const { mode: _canonical, ...canonicalCounts } = parsed.actuation.phases[0];
    assert.deepEqual(canonicalCounts, historicalCounts, `${label}: counts and boundaries unchanged`);
  }
});

test("mismatches not explainable by the published writer still fail closed", () => {
  const boundaries = phases([["a", 0, 120]]);
  const forged = (events, mutate) => {
    const record = historicalRecord(events, boundaries);
    mutate(record.actuation.phases[0]);
    return parseWorkoutExecutionProvenance(record);
  };
  assert.equal(forged([[10, "automatic_hr_control"]], (phase) => { phase.mode = "none"; }), null,
    "forged none with an accepted automatic command and nothing rejected");
  assert.equal(forged([[10, "automatic_hr_control"], [20, "automatic_hr_control", "failed"]],
    (phase) => { phase.mode = "programmatic"; }), null, "arbitrary mode mismatch");
  assert.equal(forged([[10, "automatic_hr_control", "failed"]], (phase) => { phase.rejectedCount = 0; }), null,
    "forged rejected count");
  assert.equal(forged([[10, "automatic_hr_control"], [20, "automatic_hr_control", "failed"]],
    (phase) => { phase.automaticAcceptedCount = 2; }), null, "forged automatic count");
  assert.equal(forged([[10, "default_starting_resistance"], [20, "scripted_phase_program", "unavailable"]],
    (phase) => { phase.programmaticAcceptedCount = 0; }), null, "forged programmatic count");
  assert.equal(forged([[10, "automatic_hr_control", "failed"]], (phase) => { phase.ambiguousCount = 1; }), null,
    "forged ambiguous count");
  assert.equal(forged([[10, "automatic_hr_control", "failed"]], (phase) => { phase.decisionCount = 2; }), null,
    "forged decisionCount");
  assert.equal(forged([[100, "automatic_hr_control", "failed"]], (phase) => { phase.activeEndSec = 90; }), null,
    "forged phase boundary");
  assert.equal(forged([[10, "automatic_hr_control", "failed"]], (phase) => { phase.kind = "bogus"; }), null,
    "forged phase identity");
});

test("newly written records always use the canonical phase semantics", () => {
  const finalized = finalizeExecutionProvenance(provenanceWith([[10, "automatic_hr_control"], [20, "automatic_hr_control", "failed"]]),
    { selectionChangedDuringWorkout: false, phases: phases([["a", 0, 120]]) });
  assert.equal(finalized.actuation.phases[0].mode, "unknown");
  const source = readFileSync(new URL("../src/executionProvenance.ts", import.meta.url), "utf8");
  assert.match(source, /Published WorkoutExecutionProvenance v1 writer compatibility/);
  assert.equal((source.match(/"published_b7fef00"\)/g) ?? []).length, 1, "the published rule is used only by the reader");
});
