import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  PHASE_E1_SHADOW_POLICY,
  evaluatePersonalizedPrescription,
} from "../dist/personalizedPrescription.js";
import {
  PHASE_E2_CHARACTERIZATION_POLICY_V1,
  PHASE_E2_HELD_WORKLOAD_POLICY_V1,
  analyzeHeldWorkloadForwardResponseInternal,
  characterizePersonalizedPrescription,
  parsePersonalizedPrescriptionCharacterization,
} from "../dist/personalizedPrescriptionCharacterization.js";
import { deriveWorkoutResponse } from "../dist/workoutResponse.js";
import { resolveWorkoutPrescription } from "../dist/workoutPrescription.js";
import { calibrationIdentityFromE1Snapshot } from "../dist/calibrationMachineProvenance.js";
import {
  buildScientificSessionEvidenceV2,
  buildScientificSessionEvidenceV2Contexts,
  classifyHeldWindowActuation,
  compareSessionMachines,
  heldWindowActuationDetails,
} from "../dist/scientificSessionEvidence.js";
import {
  E4A_CURRENT_SCIENTIFIC_ASSESSMENT_POLICY,
  E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1,
  E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2,
  assessPersonalizedWorkloadEvidence,
  buildSubjectEvidence,
  discoverDiagnosticSubjects,
} from "../dist/personalizationScientificAssessment.js";
import {
  buildPersonalizationDiagnosticsModel,
  createPersonalizationDiagnosticsExport,
  extractTrustedPersonalizationAssessmentContexts,
  extractTrustedPersonalizationCharacterizations,
  extractTrustedPersonalizationWorkoutContexts,
  personalizationDiagnosticsHtml,
} from "../dist/personalizationDiagnosticsView.js";

const ATHLETE = "athlete-v2";
const RESOLVED_AT = "2026-09-20T12:00:00.000Z";
const MACHINE = "proform-smart-power-10";
const KG_PER_LB = 0.45359237;
const EVALUATED_AT = "2026-10-01T00:00:00.000Z";

function profile() {
  return {
    schemaVersion: 1,
    athleteId: ATHLETE,
    demographics: { ageYears: 40, bodyMassLbs: 80 / KG_PER_LB },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fitness() {
  const points = [
    { stageId: "stage-1", watts: 100, heartRateBpm: 110, workloadSource: "measured_watts" },
    { stageId: "stage-2", watts: 150, heartRateBpm: 135, workloadSource: "measured_watts" },
    { stageId: "stage-3", watts: 200, heartRateBpm: 160, workloadSource: "measured_watts" },
  ];
  return {
    schemaVersion: 1,
    athleteId: ATHLETE,
    hrWorkloadCalibration: {
      value: {
        slopeBpmPerWatt: 0.5, interceptBpm: 60, rSquared: 1, observedMinWatts: 100, observedMaxWatts: 200, points,
        protocol: { id: "bike-submax-70rpm", version: 1 },
        predictedHrMaxBpm: 180, predictedHrMaxSource: "demographic_estimate",
        profileInputSnapshot: { ageYears: 40, bodyMassKg: 80 },
      },
      source: "formal_assessment",
      quality: "high",
      observedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
      algorithm: { id: "bike-submax-linear-hr-workload", version: 1 },
      evidenceSessionIds: ["formal-v2"],
    },
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
}

function prescription(sustain, target = "115-130") {
  return resolveWorkoutPrescription({
    workoutSelector: "Tuesday",
    blocks: { warm: 0, sustain, cool: 0 },
    hrTargets: { main_set: target, main_set_intensity_id: "aerobic_base", main_set_kind: "work", intervals: null },
    resolvedAt: RESOLVED_AT,
  });
}

/**
 * One complete workout: E1, raw telemetry, response, canonical E2 v3 record, and
 * a frozen execution-provenance record with the supplied actuation events.
 */
function workout(options = {}) {
  const sessionId = options.sessionId ?? "v2-session";
  const sustain = options.sustain ?? 5;
  const createdAt = options.createdAt ?? "2026-09-20T12:10:00.000Z";
  const startMs = Date.parse(RESOLVED_AT);
  const hrAt = options.hrAt ?? (() => 120);
  const resistanceAt = options.resistanceAt ?? ((second) => (second < 60 ? 7 : 8));
  const legacy = prescription(sustain, options.target);
  const e1 = evaluatePersonalizedPrescription({
    legacyPrescription: legacy, workoutIntent: "aerobic_base", activity: "bike", athleteId: ATHLETE,
    profile: profile(), fitnessState: fitness(), policy: PHASE_E1_SHADOW_POLICY, resolvedAt: RESOLVED_AT,
  });
  const duration = sustain * 60;
  const hrSamples = Array.from({ length: duration }, (_, second) => ({ session_id: sessionId, timestamp_sec: second, hr: hrAt(second) }));
  const bikeSamples = Array.from({ length: duration }, (_, second) => ({
    schemaVersion: 1, athleteId: ATHLETE, sessionId, activeSec: second,
    observedAt: new Date(startMs + second * 1000).toISOString(), availability: "fresh",
    sourceSampleId: `${sessionId}-${second}`, freshnessMs: 0,
    watts: { value: options.watts ?? 125, source: "measured_watts", freshnessMs: 0 },
    cadenceRpm: { value: 70, source: "measured", freshnessMs: 0 },
    observedResistance: { value: resistanceAt(second), source: "observed", freshnessMs: 0 },
  }));
  const response = deriveWorkoutResponse({
    athleteId: ATHLETE, sessionId, blocks: { warm: 0, sustain, cool: 0 }, resolvedPrescription: legacy,
    completedActiveSec: duration, cancelled: false, hrSamples, bikeSamples,
  });
  const input = {
    summary: { external_session_id: sessionId, athlete_id: ATHLETE, day: "Tuesday", intent: "aerobic_base", activity: "bike" },
    shadowEvaluation: e1, workoutResponse: response, hrSamples, bikeSamples,
    policy: PHASE_E2_CHARACTERIZATION_POLICY_V1, heldWorkloadPolicy: PHASE_E2_HELD_WORKLOAD_POLICY_V1, createdAt,
  };
  const characterization = characterizePersonalizedPrescription(input);
  const calibration = calibrationIdentityFromE1Snapshot(ATHLETE, e1.fitnessEvidenceSnapshot);
  const events = (options.events ?? []).map(([activeSec, origin, requestedResistance, extras = {}], index) => ({
    commandId: index + 1,
    decisionId: extras.decisionId ?? `${sessionId}-d${index + 1}`,
    origin,
    trigger: extras.trigger ?? "decision",
    requestedResistance,
    activeSec,
    observedAt: new Date(startMs + activeSec * 1000).toISOString(),
    outcome: extras.outcome ?? "accepted",
  }));
  const provenance = {
    schemaVersion: 1,
    sessionId,
    machine: { status: "selected", machineId: MACHINE, machineProfileVersion: 1, selectionChangedDuringWorkout: false },
    calibrationMachine: { status: "available", calibration, machineId: MACHINE, machineProfileVersion: 1,
      ...(options.calibrationMachine ?? {}) },
    actuation: {
      captureScope: "app_resistance_commands",
      consoleResistanceChanges: "not_observable",
      coverage: options.coverage ?? "complete",
      incompleteReasons: options.coverage === "incomplete" ? ["persistence_failed"] : [],
      events,
    },
  };
  if (options.machine) provenance.machine = { ...provenance.machine, ...options.machine };
  const summary = {
    external_session_id: sessionId,
    athlete_id: ATHLETE,
    startedAt: RESOLVED_AT,
    endedAt: createdAt,
    day: "Tuesday",
    intent: "aerobic_base",
    activity: "bike",
    machine_id: MACHINE,
    machine_profile_version: 1,
    shadow_prescription_evaluation: e1,
    workout_response: response,
    shadow_prescription_characterization: characterization,
    ...(options.withoutProvenance ? {} : { execution_provenance: provenance }),
  };
  return { input, summary, raw: { hrSamples, bikeSamples }, characterization, e1, sessionId };
}

function window(first, last, resistance, qualifying = 60) {
  return { firstActiveSec: first, lastActiveSec: last, observedResistance: resistance, provenance: "measured_watts",
    settledFromActiveSec: first + 120, qualifyingDurationSec: qualifying };
}

function event(commandId, activeSec, origin, requestedResistance, extras = {}) {
  return { commandId, decisionId: extras.decisionId ?? `d${commandId}`, origin, trigger: extras.trigger ?? "decision",
    requestedResistance, activeSec, observedAt: new Date(Date.parse(RESOLVED_AT) + activeSec * 1000).toISOString(),
    outcome: extras.outcome ?? "accepted" };
}

const complete = (events) => ({ coverage: "complete", events });

// ---------------------------------------------------------------- canonical E2 windows

test("the transient analysis comes from the canonical E2 reducer and matches the durable aggregate", () => {
  const { input, characterization } = workout({ sustain: 10, resistanceAt: (second) => 6 + Math.floor(second / 150) });
  const analysis = analyzeHeldWorkloadForwardResponseInternal(input);
  assert.deepEqual(analysis.record, characterization, "identical record bytes");
  for (const [index, phase] of characterization.phases.entries()) {
    const stable = phase.heldWorkloadForwardResponse.stableResistance;
    const windows = analysis.phases[index].windows;
    assert.equal(analysis.phases[index].phaseId, phase.phaseId);
    assert.equal(windows.length, stable.stableWindowCount);
    assert.equal(windows.filter((item) => item.qualifyingDurationSec > 0).length, stable.qualifyingWindowCount);
    assert.equal(windows.reduce((sum, item) => sum + item.qualifyingDurationSec, 0), stable.qualifyingDurationSec);
    assert.equal(windows.reduce((sum, item) => sum + item.lastActiveSec - item.firstActiveSec + 1, 0), stable.stableDurationSec);
    for (const item of windows) assert.equal(item.settledFromActiveSec, item.firstActiveSec + PHASE_E2_HELD_WORKLOAD_POLICY_V1.settlingSeconds);
  }
  const persisted = JSON.stringify(characterization);
  for (const transient of ["firstActiveSec", "settledFromActiveSec", "qualifyingFirstActiveSec", "actuation"]) {
    assert.equal(persisted.includes(transient), false, `${transient} is never persisted`);
  }
  assert.equal(characterization.schemaVersion, 3);
  assert.deepEqual(parsePersonalizedPrescriptionCharacterization(characterization, input.shadowEvaluation), characterization);
});

test("E4A and the join contain no second held-window algorithm", () => {
  const join = readFileSync(new URL("../src/scientificSessionEvidence.ts", import.meta.url), "utf8");
  assert.match(join, /analyzeHeldWorkloadForwardResponseInternal/);
  assert.doesNotMatch(join, /settlingSeconds|maxObservationGapSec|observedResistance\?\.value|stableObservedResistanceWindows/);
  const e4a = readFileSync(new URL("../src/personalizationScientificAssessment.ts", import.meta.url), "utf8");
  assert.doesNotMatch(e4a, /from ["']\.\//, "E4A still imports nothing");
  assert.doesNotMatch(e4a, /settlingSeconds|stableObservedResistanceWindows/);
});

// ---------------------------------------------------------------- selector algorithm

test("an automatic R8 command before an R8 hold makes the window automatic-selected", () => {
  const detail = classifyHeldWindowActuation(window(60, 299, 8), complete([event(1, 55, "automatic_hr_control", 8)]));
  assert.equal(detail.context, "automatic_selected");
  assert.equal(detail.selectorOrigin, "automatic_hr_control");
  assert.equal(detail.selectorActiveSec, 55);
});

test("a programmatic R8 command before the hold is programmatic-selected and keeps its exact origin", () => {
  for (const origin of ["default_starting_resistance", "learned_starting_resistance", "controller_carryover", "scripted_phase_program"]) {
    const detail = classifyHeldWindowActuation(window(60, 299, 8), complete([event(1, 10, origin, 8)]));
    assert.equal(detail.context, "programmatic_selected", origin);
    assert.equal(detail.selectorOrigin, origin);
  }
});

test("no accepted app command before the hold is no_app_selector_observed, not manual", () => {
  const none = classifyHeldWindowActuation(window(60, 299, 8), complete([]));
  assert.equal(none.context, "no_app_selector_observed");
  const laterOnly = classifyHeldWindowActuation(window(60, 299, 8), complete([event(1, 400, "automatic_hr_control", 9)]));
  assert.equal(laterOnly.context, "no_app_selector_observed", "commands after the window are irrelevant");
});

test("a same-decision reconciliation re-send during the hold is counted but is not a new selector", () => {
  const detail = classifyHeldWindowActuation(window(60, 299, 8), complete([
    event(1, 55, "automatic_hr_control", 8, { decisionId: "x" }),
    event(2, 150, "automatic_hr_control", 8, { decisionId: "x", trigger: "reconciliation_resend" }),
  ]));
  assert.equal(detail.context, "automatic_selected");
  assert.equal(detail.sameDecisionResendsDuringHold, 1);
  assert.equal(detail.selectorDecisionId, "x");
});

test("a new decision during the hold is represented and fails closed", () => {
  const automatic = classifyHeldWindowActuation(window(60, 299, 8), complete([
    event(1, 55, "automatic_hr_control", 8), event(2, 200, "automatic_hr_control", 8),
  ]));
  assert.equal(automatic.context, "unknown");
  assert.equal(automatic.reason, "new_decision_during_hold");
  assert.deepEqual(automatic.newDecisionsDuringHold, { automatic: 1, programmatic: 0, other: 0 });
  const programmatic = classifyHeldWindowActuation(window(60, 299, 8), complete([
    event(1, 55, "default_starting_resistance", 8), event(2, 200, "scripted_phase_program", 7),
  ]));
  assert.deepEqual(programmatic.newDecisionsDuringHold, { automatic: 0, programmatic: 1, other: 0 });
  assert.equal(programmatic.context, "unknown");
});

test("an accepted command for a different resistance never claims the current hold", () => {
  const detail = classifyHeldWindowActuation(window(60, 299, 8), complete([event(1, 55, "automatic_hr_control", 9)]));
  assert.notEqual(detail.context, "automatic_selected");
  assert.equal(detail.context, "unknown");
  assert.equal(detail.reason, "app_request_differs_from_observed_hold");
});

test("incomplete capture, unresolved/rejected and unclassified commands make the window unknown", () => {
  assert.equal(classifyHeldWindowActuation(window(60, 299, 8),
    { coverage: "incomplete", events: [event(1, 55, "automatic_hr_control", 8)] }).context, "unknown");
  for (const outcome of ["failed", "unavailable", "pending", "timeout"]) {
    const detail = classifyHeldWindowActuation(window(60, 299, 8), complete([
      event(1, 55, "automatic_hr_control", 8), event(2, 100, "automatic_hr_control", 8, { outcome }),
    ]));
    assert.equal(detail.context, "unknown", outcome);
    assert.equal(detail.reason, "unresolved_or_rejected_command");
  }
  const failedBeforeNoSelector = classifyHeldWindowActuation(window(60, 299, 8),
    complete([event(1, 10, "automatic_hr_control", 8, { outcome: "failed" })]));
  assert.equal(failedBeforeNoSelector.context, "unknown", "a rejected command cannot become no_app_selector");
  const superseded = classifyHeldWindowActuation(window(60, 299, 8), complete([
    event(1, 10, "automatic_hr_control", 7, { outcome: "failed" }), event(2, 20, "automatic_hr_control", 8),
  ]));
  assert.equal(superseded.context, "automatic_selected", "a failure superseded by an accepted selector is irrelevant");
  const unclassified = classifyHeldWindowActuation(window(60, 299, 8), complete([event(1, 55, "unclassified", 8)]));
  assert.equal(unclassified.context, "unknown");
  assert.equal(unclassified.reason, "unclassified_command");
});

// ---------------------------------------------------------------- machine comparability

test("machine comparability is exact and every failure keeps a distinct reason", () => {
  const base = workout();
  assert.deepEqual(compareSessionMachines(base.summary), { comparable: true, reason: "same_machine_and_profile" });
  const variant = (mutate) => {
    const summary = structuredClone(base.summary);
    mutate(summary.execution_provenance, summary);
    return compareSessionMachines(summary).reason;
  };
  assert.equal(variant((p) => { p.calibrationMachine.machineId = "machine-b"; }), "different_machine");
  assert.equal(variant((p) => { p.calibrationMachine.machineProfileVersion = 2; }), "same_machine_different_profile");
  assert.equal(variant((p) => { p.calibrationMachine = { status: "unavailable", calibration: p.calibrationMachine.calibration }; }),
    "calibration_machine_unavailable");
  assert.equal(variant((p) => { p.calibrationMachine = { status: "integrity_failure", calibration: p.calibrationMachine.calibration }; }),
    "calibration_machine_integrity_failure");
  assert.equal(variant((p) => { p.machine.selectionChangedDuringWorkout = true; }), "workout_machine_selection_changed");
  assert.equal(variant((p) => { p.machine = { status: "none_selected", selectionChangedDuringWorkout: false }; }),
    "workout_machine_unavailable");
  assert.equal(variant((p) => { p.calibrationMachine.calibration.observedAt = "2026-08-01T00:00:00.000Z"; }),
    "calibration_identity_mismatch");
  assert.equal(variant((p) => { p.calibrationMachine = { status: "no_frozen_calibration" }; }), "calibration_identity_mismatch");
  assert.equal(variant((_p, summary) => { delete summary.execution_provenance; }), "execution_provenance_unavailable",
    "legacy workouts are unavailable, never guessed");
});

// ---------------------------------------------------------------- join integration

test("with retained raw telemetry the join classifies the real qualifying window", () => {
  const { summary, raw } = workout({ events: [[0, "default_starting_resistance", 7], [55, "automatic_hr_control", 8]] });
  const evidence = buildScientificSessionEvidenceV2(summary, raw);
  assert.equal(evidence.independentOpenLoopEvidence, false);
  const [phase] = evidence.phases;
  assert.equal(phase.heldWorkload.available, true);
  assert.equal(phase.heldWorkload.timedJoin, "available");
  assert.equal(phase.heldWorkload.qualifyingWindowCount, 1);
  assert.deepEqual(phase.heldWorkload.contexts.automatic_selected, { windowCount: 1, durationSec: 120 });
  const details = heldWindowActuationDetails(summary, raw);
  assert.equal(details[0].windows[0].firstActiveSec, 60);
  assert.equal(details[0].windows[0].selectorActiveSec, 55);
});

test("without raw telemetry the durable aggregate remains but the timed join is unavailable", () => {
  const { summary, raw } = workout({ events: [[55, "automatic_hr_control", 8]] });
  const absent = buildScientificSessionEvidenceV2(summary, null).phases[0].heldWorkload;
  assert.equal(absent.available, true);
  assert.equal(absent.timedJoin, "raw_telemetry_unavailable");
  assert.equal(absent.contexts, null, "no classification from the aggregate phase mode");
  assert.equal(absent.qualifyingDurationSec, 120);
  assert.equal(buildScientificSessionEvidenceV2(summary, { hrSamples: [], bikeSamples: [] }).phases[0].heldWorkload.timedJoin,
    "raw_telemetry_unavailable");
  const tampered = { hrSamples: raw.hrSamples, bikeSamples: raw.bikeSamples.slice(0, 200) };
  assert.equal(buildScientificSessionEvidenceV2(summary, tampered).phases[0].heldWorkload.timedJoin, "reconstruction_mismatch");
  const legacy = workout({ withoutProvenance: true });
  assert.equal(buildScientificSessionEvidenceV2(legacy.summary, legacy.raw).phases[0].heldWorkload.timedJoin,
    "execution_provenance_unavailable");
});

test("HR outside the legacy target is still valid held-forward evidence in the join", () => {
  const { summary, raw } = workout({ hrAt: () => 160, events: [[55, "automatic_hr_control", 8]] });
  assert.equal(summary.shadow_prescription_characterization.phases[0].characterizationOutcome, "insufficient_evidence");
  const held = buildScientificSessionEvidenceV2(summary, raw).phases[0].heldWorkload;
  assert.equal(held.available, true);
  assert.equal(held.contexts.automatic_selected.durationSec, 120);
});

// ---------------------------------------------------------------- E4A v2

function assessV2(workouts, policy = E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2) {
  const history = workouts.map((item) => ({ summary: item.summary }));
  const records = extractTrustedPersonalizationCharacterizations(history, ATHLETE);
  const assessmentContexts = extractTrustedPersonalizationAssessmentContexts(history, ATHLETE);
  const workoutContexts = extractTrustedPersonalizationWorkoutContexts(history, ATHLETE);
  const sessionEvidenceV2 = buildScientificSessionEvidenceV2Contexts(history, ATHLETE,
    Object.fromEntries(workouts.filter((item) => item.raw).map((item) => [item.sessionId, item.raw])));
  const [subject] = discoverDiagnosticSubjects(records, assessmentContexts, workoutContexts, ATHLETE);
  const evidence = buildSubjectEvidence({ subject, records, assessmentContexts, workoutContexts,
    currentCalibration: subject.calibration, sessionEvidenceV2 });
  return { assessment: assessPersonalizedWorkloadEvidence(evidence, subject, policy, EVALUATED_AT), evidence, records,
    assessmentContexts, workoutContexts, sessionEvidenceV2 };
}

const DATES = ["2026-09-03", "2026-09-07", "2026-09-11", "2026-09-15", "2026-09-19", "2026-09-23"];

function cohort(events, extra = {}) {
  return DATES.map((day, index) => workout({ sessionId: `v2-${index}`, createdAt: `${day}T12:10:00.000Z`, events, ...extra }));
}

test("known automatic provenance is reported truthfully, never as actuation_mode_unknown, and never as open-loop", () => {
  const { assessment } = assessV2(cohort([[55, "automatic_hr_control", 8]]));
  assert.deepEqual(assessment.policy, { id: "e4a-scientific-assessment-policy", version: 2 });
  assert.equal(assessment.runtimeAuthority, false);
  assert.notEqual(assessment.state, "eligible");
  assert.equal(assessment.reasonCodes.includes("actuation_mode_unknown"), false);
  assert.ok(assessment.reasonCodes.includes("controller_selected_evidence"));
  assert.ok(assessment.reasonCodes.includes("open_loop_evidence_unavailable"));
  assert.equal(assessment.gates.find((gate) => gate.id === "actuation_context").status, "pass");
  assert.equal(assessment.gates.find((gate) => gate.id === "open_loop_evidence").status, "fail");
  assert.equal(assessment.evidenceDigest.provenanceV2.independentOpenLoopEvidence, "unavailable");
  assert.equal(assessment.evidenceDigest.provenanceV2.transferComparableSessionCount, DATES.length);
  assert.equal(assessment.evidenceDigest.provenanceV2.heldComparableSessionCount, DATES.length);
  assert.equal(assessment.state, "collecting", "adequate, agreeing evidence still cannot become eligible");
});

test("programmatic and no-app-selector contexts also cannot satisfy open-loop evidence", () => {
  const programmatic = assessV2(cohort([[55, "default_starting_resistance", 8]])).assessment;
  assert.ok(programmatic.reasonCodes.includes("programmatic_selected_evidence"));
  assert.ok(programmatic.reasonCodes.includes("open_loop_evidence_unavailable"));
  assert.notEqual(programmatic.state, "eligible");
  const noSelector = assessV2(cohort([])).assessment;
  assert.ok(noSelector.reasonCodes.includes("no_app_selector_observed"));
  assert.ok(noSelector.reasonCodes.includes("open_loop_evidence_unavailable"));
  assert.notEqual(noSelector.state, "eligible");
  assert.equal(noSelector.gates.find((gate) => gate.id === "open_loop_evidence").status, "fail");
});

test("incomplete capture and missing raw telemetry are reported as distinct actuation reasons", () => {
  assert.ok(assessV2(cohort([[55, "automatic_hr_control", 8]], { coverage: "incomplete" })).assessment.reasonCodes
    .includes("actuation_capture_incomplete"));
  const noRaw = cohort([[55, "automatic_hr_control", 8]]).map((item) => ({ ...item, raw: null }));
  assert.ok(assessV2(noRaw).assessment.reasonCodes.includes("timed_actuation_join_unavailable"));
  const unknown = assessV2(cohort([[55, "automatic_hr_control", 9]])).assessment;
  assert.ok(unknown.reasonCodes.includes("actuation_context_unknown"));
});

test("machine mismatch excludes sessions and never produces contradiction", () => {
  // Interior candidate (130–160 W) with persistent +40 W bias: contradicted when admitted...
  const biased = { target: "125-140", hrAt: () => 130, watts: 200 };
  const admitted = assessV2(cohort([[55, "automatic_hr_control", 8]], biased)).assessment;
  assert.equal(admitted.state, "contradicted");
  assert.ok(admitted.reasonCodes.includes("persistent_signed_bias_positive"));
  // ...but on another machine the same evidence is simply not admissible, never contradiction.
  const mismatched = cohort([[55, "automatic_hr_control", 8]], { ...biased, calibrationMachine: { machineId: "machine-b" } });
  const { assessment } = assessV2(mismatched);
  assert.notEqual(assessment.state, "contradicted");
  assert.equal(assessment.evidenceDigest.sessionCount, 0);
  assert.deepEqual(assessment.evidenceDigest.provenanceV2.excludedTransferMachineIncomparableSessions,
    { different_machine: DATES.length });
  assert.deepEqual(assessment.evidenceDigest.provenanceV2.excludedHeldMachineIncomparableSessions,
    { different_machine: DATES.length });
  assert.ok(assessment.reasonCodes.includes("machine_comparability_unavailable"));
  assert.equal(assessment.reasonCodes.some((reason) => reason.startsWith("persistent_signed_bias")), false);
  const profile = assessV2(cohort([[55, "automatic_hr_control", 8]], { calibrationMachine: { machineProfileVersion: 2 } })).assessment;
  assert.deepEqual(profile.evidenceDigest.provenanceV2.excludedHeldMachineIncomparableSessions,
    { same_machine_different_profile: DATES.length });
});

test("five qualifying windows in one workout remain one longitudinal session", () => {
  const multi = workout({ sessionId: "v2-multi", sustain: 13, resistanceAt: (second) => 6 + Math.floor(second / 150),
    events: [[0, "default_starting_resistance", 6]] });
  assert.equal(multi.characterization.phases[0].heldWorkloadForwardResponse.stableResistance.qualifyingWindowCount, 5);
  const { assessment } = assessV2([multi]);
  assert.equal(assessment.evidenceDigest.sessionCount, 1);
  assert.equal(assessment.evidenceDigest.provenanceV2.transferComparableSessionCount, 1);
  assert.equal(assessment.evidenceDigest.provenanceV2.heldComparableSessionCount, 1);
  const contexts = assessment.evidenceDigest.provenanceV2.heldContexts;
  assert.equal(Object.values(contexts).reduce((sum, item) => sum + item.windows, 0), 5);
  assert.ok(Object.values(contexts).every((item) => item.sessions <= 1), "windows never inflate session counts");
});

test("multi-phase ambiguity remains excluded under policy v2", () => {
  const item = workout({ events: [[55, "automatic_hr_control", 8]] });
  const { evidence } = assessV2([item]);
  assert.equal(evidence.sessions.length, 1);
  const history = [{ summary: item.summary }];
  const records = extractTrustedPersonalizationCharacterizations(history, ATHLETE);
  records[0] = { ...records[0], phases: [...records[0].phases, { ...records[0].phases[0], phaseId: "sibling" }] };
  const assessmentContexts = extractTrustedPersonalizationAssessmentContexts(history, ATHLETE);
  const workoutContexts = extractTrustedPersonalizationWorkoutContexts(history, ATHLETE);
  const [subject] = discoverDiagnosticSubjects(records, assessmentContexts, workoutContexts, ATHLETE);
  const built = buildSubjectEvidence({ subject, records, assessmentContexts, workoutContexts, currentCalibration: null,
    sessionEvidenceV2: buildScientificSessionEvidenceV2Contexts(history, ATHLETE, { [item.sessionId]: item.raw }) });
  assert.equal(built.excludedMultiPhaseSessions, 1);
  assert.equal(built.sessions.length, 0);
});

test("supersession still requires the exact calibration instance", () => {
  const items = cohort([[55, "automatic_hr_control", 8]]);
  const history = items.map((item) => ({ summary: item.summary }));
  const records = extractTrustedPersonalizationCharacterizations(history, ATHLETE);
  const assessmentContexts = extractTrustedPersonalizationAssessmentContexts(history, ATHLETE);
  const workoutContexts = extractTrustedPersonalizationWorkoutContexts(history, ATHLETE);
  const [subject] = discoverDiagnosticSubjects(records, assessmentContexts, workoutContexts, ATHLETE);
  const evidence = buildSubjectEvidence({ subject, records, assessmentContexts, workoutContexts,
    currentCalibration: { ...subject.calibration, observedAt: "2026-09-25T00:00:00.000Z" },
    sessionEvidenceV2: buildScientificSessionEvidenceV2Contexts(history, ATHLETE,
      Object.fromEntries(items.map((item) => [item.sessionId, item.raw]))) });
  const assessment = assessPersonalizedWorkloadEvidence(evidence, subject, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2, EVALUATED_AT);
  assert.equal(assessment.state, "superseded");
});

// ---------------------------------------------------------------- policy versioning

test("policy v1 is frozen and unchanged; v2 is separate; the current policy is v2 deliberately", () => {
  assert.ok(Object.isFrozen(E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1));
  assert.ok(Object.isFrozen(E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2));
  assert.deepEqual({ ...E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1 }, {
    id: "e4a-scientific-assessment-policy", version: 1, minIndependentSessions: 4, minDistinctDates: 4,
    minCalendarSpanDays: 14, characterizationMinInteriorSessions: 1, characterizationMaxMedianAbsoluteBiasWatts: 10,
    characterizationMaxSettledWattsCv: 0.15, characterizationMaxSaturationIncidence: 0.5,
    openLoopEvidence: "required_but_unavailable", actuationModeEvidence: "required_but_unavailable", staleness: "not_configured",
  });
  assert.equal(E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2.version, 2);
  assert.equal("actuationModeEvidence" in E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2, false);
  assert.equal(E4A_CURRENT_SCIENTIFIC_ASSESSMENT_POLICY, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2);
  const diagnostics = readFileSync(new URL("../src/personalizationDiagnosticsView.ts", import.meta.url), "utf8");
  assert.match(diagnostics, /E4A_CURRENT_SCIENTIFIC_ASSESSMENT_POLICY/);
  assert.doesNotMatch(diagnostics, /E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1/);
});

test("policy v1 still treats provenance as unavailable, ignoring the v2 join entirely", () => {
  const items = cohort([[55, "automatic_hr_control", 8]]);
  const v1 = assessV2(items, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1).assessment;
  assert.deepEqual(v1.policy, { id: "e4a-scientific-assessment-policy", version: 1 });
  assert.ok(v1.reasonCodes.includes("actuation_mode_unknown"));
  assert.ok(v1.reasonCodes.includes("open_loop_evidence_unavailable"));
  assert.equal(v1.reasonCodes.includes("controller_selected_evidence"), false);
  assert.equal("provenanceV2" in v1.evidenceDigest, false, "v1 output shape is unchanged");
  assert.ok(v1.gates.some((gate) => gate.id === "actuation_mode_evidence"));
  assert.equal(v1.gates.some((gate) => gate.id === "machine_comparability"), false);
  // Supplying the join or not makes no difference to v1.
  const history = items.map((item) => ({ summary: item.summary }));
  const records = extractTrustedPersonalizationCharacterizations(history, ATHLETE);
  const assessmentContexts = extractTrustedPersonalizationAssessmentContexts(history, ATHLETE);
  const workoutContexts = extractTrustedPersonalizationWorkoutContexts(history, ATHLETE);
  const [subject] = discoverDiagnosticSubjects(records, assessmentContexts, workoutContexts, ATHLETE);
  const without = assessPersonalizedWorkloadEvidence(buildSubjectEvidence({ subject, records, assessmentContexts,
    workoutContexts, currentCalibration: subject.calibration }), subject, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1, EVALUATED_AT);
  assert.deepEqual(v1, without);
});

test("unknown or malformed policy versions fail closed", () => {
  const { evidence } = assessV2(cohort([[55, "automatic_hr_control", 8]]));
  const subjectFor = assessV2(cohort([[55, "automatic_hr_control", 8]])).assessment.subject;
  for (const [label, policy] of [
    ["version 3", { ...E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2, version: 3 }],
    ["v2 claiming open-loop required", { ...E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2, openLoopEvidence: "required" }],
    ["v2 without machine comparability", (() => {
      const { machineComparability: _omit, ...rest } = E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2;
      return rest;
    })()],
    ["v1 id with v2 shape", { ...E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2, version: 1 }],
  ]) {
    const assessment = assessPersonalizedWorkloadEvidence(evidence, subjectFor, policy, EVALUATED_AT);
    assert.equal(assessment.state, "not_applicable", label);
    assert.deepEqual(assessment.reasonCodes, ["unsupported_policy"], label);
    assert.equal(assessment.runtimeAuthority, false, label);
  }
});

// ---------------------------------------------------------------- diagnostics and export

test("diagnostics distinguish the contexts, keep independent evidence unavailable, and export v3 is unchanged", () => {
  const items = cohort([[55, "automatic_hr_control", 8]]);
  const { records, assessmentContexts, workoutContexts, sessionEvidenceV2 } = assessV2(items);
  const model = buildPersonalizationDiagnosticsModel(records, undefined, assessmentContexts, workoutContexts, {},
    EVALUATED_AT, {}, sessionEvidenceV2);
  assert.equal(model.heldActuationContext.length, DATES.length);
  assert.equal(model.heldActuationContext[0].machineComparison.reason, "same_machine_and_profile");
  assert.equal(model.heldActuationContext[0].contexts.automatic_selected.durationSec, 120);
  for (const assessment of model.scientificAssessments) {
    assert.equal(assessment.runtimeAuthority, false);
    assert.notEqual(assessment.state, "eligible");
    assert.ok(assessment.reasonCodes.includes("open_loop_evidence_unavailable"));
  }
  const html = personalizationDiagnosticsHtml(model);
  const section = html.slice(html.indexOf("id=\"personalizationHeldActuationContext\""));
  const held = section.slice(0, section.indexOf("</section>"));
  assert.match(held, /does not establish manual or open-loop resistance because console changes are not observable/);
  assert.match(held, /Independent open-loop evidence/);
  assert.match(held, /Same machine and profile/);
  assert.match(held, /controller \/ programmatic \/ no captured app selector \/ unknown/);
  assert.doesNotMatch(held, /\b(approved|safe|authorized)\b|validated for control/i);
  assert.match(html, /e4a-scientific-assessment-policy@2/);
  const exported = createPersonalizationDiagnosticsExport(model);
  assert.equal(exported.schemaVersion, 3);
  assert.deepEqual(Object.keys(exported), ["schemaVersion", "filters", "aggregate", "diagnosticRows", "characterizationRecords"]);
  const json = JSON.stringify(exported);
  for (const runtimeOnly of ["heldActuationContext", "machineComparison", "provenanceV2", "scientificAssessments",
    "automatic_selected", "timedJoin"]) {
    assert.equal(json.includes(runtimeOnly), false, runtimeOnly);
  }
});

// ---------------------------------------------------------------- authority firewall

test("no runtime, control, E1, E2-writer, or FitnessState path consumes the v2 join or E4A", () => {
  const walk = (dir) => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(`${dir}${entry.name}/`) : entry.name.endsWith(".ts") ? [`${dir}${entry.name}`] : []);
  const files = walk("../src/");
  const consumers = (pattern) => files.filter((file) =>
    pattern.test(readFileSync(new URL(file, import.meta.url), "utf8")) && !file.endsWith("/scientificSessionEvidence.ts"));
  assert.deepEqual(consumers(/scientificSessionEvidence/).sort(),
    ["../src/personalizationDiagnosticsView.ts", "../src/uiControls.ts"]);
  const e4aConsumers = files.filter((file) => !file.endsWith("/personalizationScientificAssessment.ts") &&
    /personalizationScientificAssessment/.test(readFileSync(new URL(file, import.meta.url), "utf8")));
  assert.deepEqual(e4aConsumers, ["../src/personalizationDiagnosticsView.ts"]);
  for (const file of ["workoutPrescription.ts", "workoutLogic.ts", "machines/guidance.ts", "machines/runtime.ts",
    "machines/proformSmartPower10.ts", "machines/learning/index.ts", "machines/dynamics/index.ts", "vo2Protocol.ts",
    "vo2ProtocolV3.ts", "fitnessState.ts", "fitnessRefinement.ts", "personalizedPrescription.ts",
    "personalizedPrescriptionCharacterization.ts", "workoutSummary.ts", "platform/bikeBridgeRuntime.ts"]) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /scientificSessionEvidence|personalizationScientificAssessment|E4A_CURRENT/, file);
  }
  const all = files.map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(all, /runtimeAuthority:\s*true/);
  assert.equal(files.some((file) => /e4b|e4c|authorization/i.test(file)), false, "no E4B/E4C module exists");
});

// ---------------------------------------------------------------- corrective pass: separate cohorts

test("a held-only workout enters the held-response cohort without any closed-loop value", () => {
  const heldOnly = workout({ sessionId: "held-only", hrAt: () => 160, events: [[55, "automatic_hr_control", 8]] });
  const record = heldOnly.characterization.phases[0];
  assert.equal(record.characterizationOutcome, "insufficient_evidence", "HR entirely outside the legacy target");
  assert.equal(record.heldWorkloadForwardResponse.outcome, "characterized");
  const { assessment, evidence } = assessV2([heldOnly]);
  assert.equal(evidence.sessions.length, 0, "no closed-loop transfer session");
  assert.equal(evidence.heldSessionsV2.length, 1, "one held-response session");
  for (const closedLoopField of ["signedDifferenceWatts", "observedSettledWatts", "candidateMidpointWatts",
    "saturationRatio", "domainBucket", "comparison"]) {
    assert.equal(closedLoopField in evidence.heldSessionsV2[0], false, closedLoopField);
  }
  const digest = assessment.evidenceDigest;
  assert.equal(digest.sessionCount, 0);
  assert.equal(digest.provenanceV2.transferComparableSessionCount, 0);
  assert.equal(digest.provenanceV2.heldComparableSessionCount, 1);
  assert.equal(digest.medianSignedDifferenceWatts, null, "no fabricated bias");
  assert.equal(digest.observedSettledWattsCv, null, "no fabricated variance");
  assert.equal(digest.saturationIncidence, null, "no fabricated saturation");
  const gate = (id) => assessment.gates.find((item) => item.id === id);
  assert.equal(gate("held_workload_evidence").status, "pass");
  assert.equal(gate("held_workload_evidence").measured.sessionsWithHeldEvidence, 1);
  assert.equal(gate("actuation_context").status, "pass");
  assert.equal(gate("actuation_context").measured.sessionsWithTimedJoin, 1);
  assert.equal(gate("controller_selected_context").measured.sessions, 1);
  assert.equal(gate("signed_bias").status, "not_applicable");
  assert.ok(assessment.reasonCodes.includes("open_loop_evidence_unavailable"));
  assert.ok(assessment.reasonCodes.includes("controller_selected_evidence"));
  assert.equal(assessment.runtimeAuthority, false);
  assert.notEqual(assessment.state, "eligible");
  assert.notEqual(assessment.state, "contradicted");
});

test("in a mixed cohort each evidence channel counts only the workouts it owns", () => {
  const a = workout({ sessionId: "mixed-a", createdAt: "2026-09-10T12:10:00.000Z", events: [[55, "automatic_hr_control", 8]] });
  const b = workout({ sessionId: "mixed-b", createdAt: "2026-09-12T12:10:00.000Z", hrAt: () => 160,
    events: [[55, "default_starting_resistance", 8]] });
  const c = workout({ sessionId: "mixed-c", createdAt: "2026-09-14T12:10:00.000Z", hrAt: () => 160,
    events: [[55, "automatic_hr_control", 8]], calibrationMachine: { machineId: "machine-b" } });
  const { assessment, evidence } = assessV2([a, b, c]);
  assert.deepEqual(evidence.sessions.map((session) => session.workoutSessionId), ["mixed-a"]);
  assert.deepEqual(evidence.heldSessionsV2.map((session) => session.workoutSessionId).sort(), ["mixed-a", "mixed-b", "mixed-c"]);
  const digest = assessment.evidenceDigest;
  assert.equal(digest.sessionCount, 1, "closed-loop transfer cohort: A only");
  assert.equal(digest.provenanceV2.transferComparableSessionCount, 1);
  assert.deepEqual(digest.provenanceV2.excludedTransferMachineIncomparableSessions, {});
  assert.equal(digest.provenanceV2.heldComparableSessionCount, 2, "held-response cohort: A and B");
  assert.deepEqual(digest.provenanceV2.excludedHeldMachineIncomparableSessions, { different_machine: 1 });
  assert.equal(digest.provenanceV2.heldContexts.automatic_selected.sessions, 1);
  assert.equal(digest.provenanceV2.heldContexts.programmatic_selected.sessions, 1);
  assert.equal(assessment.gates.find((gate) => gate.id === "machine_comparability").measured.heldExcludedSessions, 1);
});

test("the held-response cohort keeps exact subject matching and the multi-phase rule", () => {
  const otherBand = workout({ sessionId: "other-band", target: "125-140", hrAt: () => 160, events: [[55, "automatic_hr_control", 8]] });
  const subjectWorkout = workout({ sessionId: "subject", hrAt: () => 160, events: [[55, "automatic_hr_control", 8]] });
  const { evidence, assessment } = assessV2([subjectWorkout, otherBand]);
  assert.equal(assessment.subject.legacyHrBand.minBpm, 115);
  assert.equal(assessment.evidenceDigest.provenanceV2.heldComparableSessionCount, 1,
    "a different legacy band is a different subject");
  assert.ok(evidence.heldSessionsV2.every((session) => session.legacyHrBand.minBpm === 115));
});

// ---------------------------------------------------------------- corrective pass: strict trust boundary

test("malformed or contradictory v2 provenance fails closed in both cohorts", () => {
  const item = workout({ sessionId: "strict", events: [[55, "automatic_hr_control", 8]] });
  const { evidence, assessment } = assessV2([item]);
  assert.equal(assessment.evidenceDigest.provenanceV2.heldComparableSessionCount, 1);
  const reassess = (mutate) => {
    const forged = structuredClone(evidence);
    mutate(forged.heldSessionsV2[0].provenanceV2);
    return assessPersonalizedWorkloadEvidence(forged, assessment.subject, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2, EVALUATED_AT)
      .evidenceDigest.provenanceV2;
  };
  for (const [label, mutate] of [
    ["comparable true + different_machine", (p) => { p.machineComparison.reason = "different_machine"; }],
    ["comparable false + same_machine_and_profile", (p) => { p.machineComparison.comparable = false; }],
    ["unknown machine reason", (p) => { p.machineComparison = { comparable: false, reason: "similar_machine" }; }],
    ["unknown timed join", (p) => { p.heldWorkload.timedJoin = "probably_available"; }],
    ["unavailable join with contexts", (p) => { p.heldWorkload.timedJoin = "raw_telemetry_unavailable"; }],
    ["available join without contexts", (p) => { p.heldWorkload.contexts = null; }],
    ["missing context category", (p) => { delete p.heldWorkload.contexts.unknown; }],
    ["extra context category", (p) => { p.heldWorkload.contexts.manual_selected = { windowCount: 0, durationSec: 0 }; }],
    ["context totals mismatch", (p) => { p.heldWorkload.contexts.unknown.durationSec += 1; }],
    ["context window mismatch", (p) => { p.heldWorkload.contexts.unknown.windowCount += 1; }],
    ["fractional context duration", (p) => { p.heldWorkload.contexts.automatic_selected.durationSec = 119.5;
      p.heldWorkload.contexts.unknown.durationSec = 0.5; }],
    ["independent evidence claimed", (p) => { p.independentOpenLoopEvidence = true; }],
    ["extra provenance key", (p) => { p.manual = true; }],
    ["absent provenance with comparable machine", (p) => { p.actuationCapture = "unavailable"; }],
    ["held evidence missing", (p) => { p.heldWorkload = null; }],
  ]) {
    const digest = reassess(mutate);
    assert.equal(digest.ignoredInvalidHeldSessions, 1, label);
    assert.equal(digest.heldComparableSessionCount, 0, label);
  }
  // The transfer cohort rejects contradictory machine comparison too.
  const forged = structuredClone(evidence);
  forged.sessions[0].provenanceV2.machineComparison.reason = "different_machine";
  const transfer = assessPersonalizedWorkloadEvidence(forged, assessment.subject, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2,
    EVALUATED_AT);
  assert.equal(transfer.evidenceDigest.ignoredInvalidSessions, 1);
  assert.equal(transfer.evidenceDigest.provenanceV2.transferComparableSessionCount, 0);
});

test("the E4A trust-boundary vocabularies match the join's canonical vocabularies", async () => {
  const e4a = await import("../dist/personalizationScientificAssessment.js");
  const join = await import("../dist/scientificSessionEvidence.js");
  assert.deepEqual([...e4a.SCIENTIFIC_MACHINE_COMPARABILITY_REASONS_V2], [...join.MACHINE_COMPARABILITY_REASONS_V2]);
  assert.deepEqual([...e4a.SCIENTIFIC_TIMED_ACTUATION_JOINS_V2], [...join.TIMED_ACTUATION_JOINS_V2]);
});

// ---------------------------------------------------------------- corrective pass: resend trigger

test("only a reconciliation_resend of the selector's decision and resistance is a harmless re-send", () => {
  const resend = classifyHeldWindowActuation(window(60, 299, 8), complete([
    event(1, 55, "automatic_hr_control", 8, { decisionId: "x" }),
    event(2, 150, "automatic_hr_control", 8, { decisionId: "x", trigger: "reconciliation_resend" }),
  ]));
  assert.equal(resend.context, "automatic_selected");
  assert.equal(resend.sameDecisionResendsDuringHold, 1);
  const sameIdDecision = classifyHeldWindowActuation(window(60, 299, 8), complete([
    event(1, 55, "automatic_hr_control", 8, { decisionId: "x" }),
    event(2, 150, "automatic_hr_control", 8, { decisionId: "x", trigger: "decision" }),
  ]));
  assert.equal(sameIdDecision.context, "unknown");
  assert.equal(sameIdDecision.reason, "new_decision_during_hold");
  assert.equal(sameIdDecision.sameDecisionResendsDuringHold, 0);
  const differentResistance = classifyHeldWindowActuation(window(60, 299, 8), complete([
    event(1, 55, "automatic_hr_control", 8, { decisionId: "x" }),
    event(2, 150, "automatic_hr_control", 9, { decisionId: "x", trigger: "reconciliation_resend" }),
  ]));
  assert.equal(differentResistance.context, "unknown");
  assert.equal(differentResistance.sameDecisionResendsDuringHold, 0);
});

// ---------------------------------------------------------------- corrective pass: state semantics

test("held-only, incomparable, or unjoined evidence never contradicts; admitted closed-loop evidence still can", () => {
  const biased = { target: "125-140", watts: 200 };
  const heldOnly = assessV2(cohort([[55, "automatic_hr_control", 8]], { ...biased, hrAt: () => 160 })).assessment;
  assert.equal(heldOnly.evidenceDigest.sessionCount, 0);
  assert.notEqual(heldOnly.state, "contradicted", "held-only sessions own no closed-loop bias");
  const heldIncomparable = assessV2(cohort([[55, "automatic_hr_control", 8]],
    { ...biased, hrAt: () => 160, calibrationMachine: { machineId: "machine-b" } })).assessment;
  assert.notEqual(heldIncomparable.state, "contradicted");
  const unjoined = assessV2(cohort([[55, "automatic_hr_control", 8]]).map((item) => ({ ...item, raw: null }))).assessment;
  assert.ok(unjoined.reasonCodes.includes("timed_actuation_join_unavailable"));
  assert.notEqual(unjoined.state, "contradicted", "missing timed actuation evidence is not contradiction");
  const admitted = assessV2(cohort([[55, "automatic_hr_control", 8]], { ...biased, hrAt: () => 130 })).assessment;
  assert.equal(admitted.state, "contradicted", "genuine admitted closed-loop disagreement still contradicts");
});

test("no production-v2 scenario reaches eligible, and every valid assessment keeps open-loop unavailable", () => {
  assert.equal(E4A_CURRENT_SCIENTIFIC_ASSESSMENT_POLICY.version, 2);
  const scenarios = [
    cohort([[55, "automatic_hr_control", 8]]),
    cohort([[55, "default_starting_resistance", 8]]),
    cohort([]),
    cohort([[55, "automatic_hr_control", 8]], { hrAt: () => 160 }),
    cohort([[55, "automatic_hr_control", 8]], { coverage: "incomplete" }),
    cohort([[55, "automatic_hr_control", 8]], { calibrationMachine: { machineProfileVersion: 2 } }),
  ];
  for (const scenario of scenarios) {
    const { assessment } = assessV2(scenario);
    assert.notEqual(assessment.state, "eligible");
    assert.equal(assessment.runtimeAuthority, false);
    assert.ok(assessment.reasonCodes.includes("open_loop_evidence_unavailable"));
    assert.equal(assessment.reasonCodes.includes("actuation_mode_unknown"), false);
  }
  const reasons = (events, extra) => assessV2(cohort(events, extra)).assessment.reasonCodes;
  assert.ok(reasons([[55, "automatic_hr_control", 8]]).includes("controller_selected_evidence"));
  assert.ok(reasons([[55, "default_starting_resistance", 8]]).includes("programmatic_selected_evidence"));
  assert.ok(reasons([]).includes("no_app_selector_observed"));
});
