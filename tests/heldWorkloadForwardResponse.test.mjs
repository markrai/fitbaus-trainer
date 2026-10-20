import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

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
import {
  buildPersonalizationDiagnosticsModel,
  createHistoricalPersonalizationDiagnosticsExportV2,
  createPersonalizationDiagnosticsExport,
  extractTrustedPersonalizationAssessmentContexts,
  extractTrustedPersonalizationCharacterizations,
  extractTrustedPersonalizationWorkoutContexts,
  personalizationDiagnosticDetailHtml,
  personalizationDiagnosticsHtml,
} from "../dist/personalizationDiagnosticsView.js";
import {
  E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1,
  assessPersonalizedWorkloadEvidence,
  buildSubjectEvidence,
  discoverDiagnosticSubjects,
} from "../dist/personalizationScientificAssessment.js";
import {
  getAllWorkoutSummaries,
  resetWorkoutStorageForTests,
  storeWorkoutSummary,
} from "../dist/workoutStorage.js";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const RESOLVED_AT = "2026-09-20T12:00:00.000Z";
const CREATED_AT = "2026-09-20T12:10:00.000Z";
const SESSION = "held-session";
const ATHLETE = "athlete-held";
const KG_PER_LB = 0.45359237;
// Frozen calibration: predicted HR = 60 + 0.5 × watts over the observed 100–200 W domain.
const predicted = (watts) => 60 + 0.5 * watts;
const refactorFixtures = JSON.parse(readFileSync(
  new URL("./fixtures/e2-v3-forward-response-refactor.json", import.meta.url), "utf8"));

function profile() {
  return {
    schemaVersion: 1,
    athleteId: ATHLETE,
    demographics: { ageYears: 40, bodyMassLbs: 80 / KG_PER_LB },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fitness(calibrationSource = "measured_watts") {
  const points = [
    { stageId: "stage-1", watts: 100, heartRateBpm: 110, workloadSource: calibrationSource },
    { stageId: "stage-2", watts: 150, heartRateBpm: 135, workloadSource: calibrationSource },
    { stageId: "stage-3", watts: 200, heartRateBpm: 160, workloadSource: calibrationSource },
  ];
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
        points,
        protocol: { id: "bike-submax-70rpm", version: 1 },
        predictedHrMaxBpm: 180,
        predictedHrMaxSource: "demographic_estimate",
        profileInputSnapshot: { ageYears: 40, bodyMassKg: 80 },
      },
      source: "formal_assessment",
      quality: "high",
      observedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
      algorithm: { id: "bike-submax-linear-hr-workload", version: 1 },
      evidenceSessionIds: ["formal-held"],
    },
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
}

function prescription(warm, sustain) {
  return resolveWorkoutPrescription({
    workoutSelector: "Tuesday",
    blocks: { warm, sustain, cool: 0 },
    hrTargets: {
      main_set: "115-130",
      main_set_intensity_id: "aerobic_base",
      main_set_kind: "work",
      intervals: null,
    },
    resolvedAt: RESOLVED_AT,
  });
}

function bikeSample(second, options) {
  const availability = options.availabilityAt(second);
  const observedAt = new Date(Date.parse(RESOLVED_AT) + second * 1000 + options.wallOffsetMsAt(second)).toISOString();
  const base = {
    schemaVersion: 1,
    athleteId: ATHLETE,
    sessionId: SESSION,
    activeSec: second,
    observedAt,
    availability,
  };
  const desired = options.desiredAt(second);
  const commanded = options.commandedAt(second);
  if (desired !== undefined) base.desiredResistance = desired;
  if (commanded !== undefined) base.commandedResistance = commanded;
  if (availability === "stale") return { ...base, sourceSampleId: `sample-${second}`, freshnessMs: 5000 };
  const sample = { ...base, sourceSampleId: `sample-${second}`, freshnessMs: 0 };
  const watts = options.wattsAt(second);
  const cadence = options.cadenceAt(second);
  const resistance = options.resistanceAt(second);
  if (watts !== undefined) sample.watts = { value: watts, source: options.sourceAt(second), freshnessMs: 0 };
  if (cadence !== undefined) sample.cadenceRpm = { value: cadence, source: "measured", freshnessMs: 0 };
  if (resistance !== undefined) sample.observedResistance = { value: resistance, source: "observed", freshnessMs: 0 };
  return sample;
}

function run(overrides = {}) {
  const options = {
    warm: 0,
    sustain: 5,
    calibrationSource: "measured_watts",
    hrAt: () => 150,
    wattsAt: () => 125,
    sourceAt: () => "measured_watts",
    cadenceAt: () => 70,
    resistanceAt: () => 8,
    desiredAt: (second) => overrides.resistanceAt ? overrides.resistanceAt(second) : 8,
    commandedAt: (second) => overrides.resistanceAt ? overrides.resistanceAt(second) : 8,
    availabilityAt: () => "fresh",
    wallOffsetMsAt: () => 0,
    sessionId: SESSION,
    reverseInput: false,
    omitBikeAt: () => false,
    ...overrides,
  };
  const duration = (options.warm + options.sustain) * 60;
  const legacy = prescription(options.warm, options.sustain);
  const e1 = evaluatePersonalizedPrescription({
    legacyPrescription: legacy,
    workoutIntent: "aerobic_base",
    activity: "bike",
    athleteId: ATHLETE,
    profile: profile(),
    fitnessState: fitness(options.calibrationSource),
    policy: PHASE_E1_SHADOW_POLICY,
    resolvedAt: RESOLVED_AT,
  });
  const seconds = Array.from({ length: duration }, (_, second) => second);
  const hrSamples = seconds.flatMap((second) => {
    const hr = options.hrAt(second);
    return hr === undefined ? [] : [{ session_id: SESSION, timestamp_sec: second, hr }];
  });
  const bikeSamples = seconds.flatMap((second) => options.omitBikeAt(second) ? [] : [bikeSample(second, options)]);
  if (options.reverseInput) {
    hrSamples.reverse();
    bikeSamples.reverse();
  }
  const response = deriveWorkoutResponse({
    athleteId: ATHLETE,
    sessionId: SESSION,
    blocks: { warm: options.warm, sustain: options.sustain, cool: 0 },
    resolvedPrescription: legacy,
    completedActiveSec: duration,
    cancelled: false,
    hrSamples,
    bikeSamples,
  });
  const summary = { external_session_id: SESSION, athlete_id: ATHLETE, day: "Tuesday", intent: "aerobic_base", activity: "bike" };
  const input = {
    summary,
    shadowEvaluation: e1,
    workoutResponse: response,
    hrSamples,
    bikeSamples,
    machineDecisionAudit: [],
    policy: PHASE_E2_CHARACTERIZATION_POLICY_V1,
    heldWorkloadPolicy: PHASE_E2_HELD_WORKLOAD_POLICY_V1,
    createdAt: CREATED_AT,
  };
  const characterization = characterizePersonalizedPrescription(input);
  const phase = characterization.phases.find((item) => item.phaseId === "sustain");
  return { e1, response, characterization, phase, held: phase.heldWorkloadForwardResponse, input };
}

function clone(value) {
  return structuredClone(value);
}

function asHistoricalV2(record) {
  const value = clone(record);
  value.schemaVersion = 2;
  value.characterizer.version = 2;
  delete value.heldWorkloadPolicy;
  delete value.heldWorkloadForwardModel;
  for (const phase of value.phases) delete phase.heldWorkloadForwardResponse;
  return value;
}

function summaryFor(result, sessionId = SESSION, createdAt = CREATED_AT) {
  const characterization = { ...clone(result.characterization), workoutSessionId: sessionId, createdAt };
  return {
    external_session_id: sessionId,
    athlete_id: ATHLETE,
    startedAt: RESOLVED_AT,
    endedAt: createdAt,
    category: "cardio",
    intent: "aerobic_base",
    duration_minutes: 5,
    primary_zone: 2,
    stress_profile: "low",
    zone_minutes: { z1: 0, z2: 5, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Tuesday",
    activity: "bike",
    machine_id: "proform-smart-power-10",
    machine_profile_version: 1,
    shadow_prescription_evaluation: clone(result.e1),
    shadow_prescription_characterization: characterization,
    workout_response: { ...clone(result.response), sessionId },
  };
}

test("E2 v3 is current, keeps the closed-loop v2 fields, and records the frozen forward model and policy", () => {
  const { characterization, e1, phase } = run({ hrAt: () => 120 });
  assert.equal(characterization.schemaVersion, 3);
  assert.equal(characterization.characterizer.version, 3);
  assert.equal(characterization.activationEligible, false);
  assert.deepEqual(characterization.heldWorkloadPolicy, PHASE_E2_HELD_WORKLOAD_POLICY_V1);
  assert.deepEqual(characterization.heldWorkloadForwardModel, {
    interceptBpm: e1.fitnessEvidenceSnapshot.calibration.interceptBpm,
    slopeBpmPerWatt: e1.fitnessEvidenceSnapshot.calibration.slopeBpmPerWatt,
    observedMinWatts: 100,
    observedMaxWatts: 200,
  });
  assert.equal(phase.characterizationOutcome, "characterized", "closed-loop path is unchanged");
  assert.deepEqual(Object.keys(asHistoricalV2(characterization)).sort(),
    Object.keys(characterization).filter((key) => !key.startsWith("heldWorkload")).sort());
  assert.equal(PHASE_E2_HELD_WORKLOAD_POLICY_V1.settlingSeconds, 120);
});

test("shared-helper refactor preserves the complete measured-watts E2 v3 record", () => {
  const result = run({
    hrAt: (second) => 145 + (second % 4),
    wattsAt: (second) => 120 + (second % 3) * 10,
  });
  assert.deepEqual(result.characterization, refactorFixtures.measuredWatts);
});

test("shared-helper refactor preserves the complete calibrated-watts E2 v3 record", () => {
  const result = run({
    calibrationSource: "calibrated_at_verified_cadence",
    sourceAt: () => "calibrated_watts",
    hrAt: (second) => 140 + (second % 3),
    wattsAt: (second) => 130 + (second % 2) * 20,
    cadenceAt: (second) => 67 + (second % 7),
  });
  assert.deepEqual(result.characterization, refactorFixtures.calibratedWatts);
});

test("complex stable-window fixture pins boundaries, exclusions, and transient reconstruction", () => {
  const result = run({
    sustain: 10,
    calibrationSource: "calibrated_at_verified_cadence",
    sourceAt: () => "calibrated_watts",
    resistanceAt: (second) => second < 180 ? 8 : second < 360 ? 9 : 10,
    wallOffsetMsAt: (second) => second >= 340 ? 10_000 : 0,
    cadenceAt: (second) => second >= 370 && second < 375 ? 85 : 70,
    wattsAt: (second) => second >= 500 && second < 505 ? undefined : second >= 530 && second < 535 ? 250 : 150,
    hrAt: (second) => second >= 540 && second < 545 ? undefined : 140,
    omitBikeAt: (second) => second === 510,
  });
  const analysis = analyzeHeldWorkloadForwardResponseInternal(result.input);
  assert.deepEqual({ held: result.held, analysis: analysis.phases[0] }, refactorFixtures.complexStableWindows);

  const windows = analysis.phases[0].windows;
  assert.equal(windows.reduce((sum, window) => sum + window.qualifyingDurationSec, 0),
    result.held.stableResistance.qualifyingDurationSec);
  assert.equal(windows.filter((window) => window.qualifyingDurationSec > 0).length,
    result.held.stableResistance.qualifyingWindowCount);
  assert.deepEqual(analysis.record, result.characterization,
    "transient analysis must return the exact persisted E2 v3 aggregate");
});

test("unchanged fresh observed resistance forms one stable window with post-settling forward evidence", () => {
  const { held } = run();
  assert.equal(held.outcome, "characterized");
  assert.equal(held.observedPowerProvenance, "measured_watts");
  assert.deepEqual(held.stableResistance, {
    observedResistanceChangeCount: 0,
    stableWindowCount: 1,
    qualifyingWindowCount: 1,
    stableDurationSec: 300,
    postSettlingDurationSec: 180,
    qualifyingDurationSec: 180,
    excludedPostSettlingSeconds: {
      observationGap: 0, wattsUnavailable: 0, outsideCalibrationDomain: 0, heartRateUnavailable: 0,
    },
  });
  assert.equal(held.forwardHeartRate.predictedHeartRateMedianBpm, predicted(125));
  assert.equal(held.forwardHeartRate.observedHeartRateMedianBpm, 150);
});

test("an observed resistance change splits windows and is counted once", () => {
  const { held } = run({ resistanceAt: (second) => second < 150 ? 8 : 9 });
  assert.equal(held.stableResistance.stableWindowCount, 2);
  assert.equal(held.stableResistance.observedResistanceChangeCount, 1);
  assert.equal(held.stableResistance.stableDurationSec, 300);
  assert.equal(held.stableResistance.postSettlingDurationSec, 60);
  assert.equal(held.stableResistance.qualifyingWindowCount, 2);
});

test("R7 before a pause and R7 after it never become one physiological hold", () => {
  // The active clock stops while paused; only the wall clock reveals the 60 s pause.
  const paused = run({ resistanceAt: () => 7, wallOffsetMsAt: (second) => second >= 150 ? 60_000 : 0 }).held;
  const unpaused = run({ resistanceAt: () => 7 }).held;
  assert.equal(unpaused.stableResistance.stableWindowCount, 1);
  assert.equal(unpaused.stableResistance.postSettlingDurationSec, 180);
  assert.equal(paused.stableResistance.stableWindowCount, 2);
  assert.equal(paused.stableResistance.postSettlingDurationSec, 60);
  assert.equal(paused.stableResistance.observedResistanceChangeCount, 0);
  const shortJitter = run({ resistanceAt: () => 7, wallOffsetMsAt: (second) => second >= 150 ? 900 : 0 }).held;
  assert.equal(shortJitter.stableResistance.stableWindowCount, 1, "sub-policy wall jitter is not a pause");
});

test("wall-clock chronology: 1 Hz and positive jitter continue; pause and reversed or zero steps break", () => {
  const windows = (wallOffsetMsAt) => run({ wallOffsetMsAt }).held.stableResistance.stableWindowCount;
  assert.equal(windows(() => 0), 1, "normal 1 Hz progression");
  assert.equal(windows((second) => (second % 2 === 0 ? 400 : 0)), 1, "tolerated positive jitter");
  assert.equal(windows((second) => (second >= 150 ? 900 : 0)), 1, "tolerated positive jitter step");
  assert.equal(windows((second) => (second >= 150 ? 60_000 : 0)), 2, "pause jump");
  // observedAt at 150 s lies 1 s before 149 s: wall step −1 s for +1 s active (|excess| = 2 s, within tolerance).
  assert.equal(windows((second) => (second === 150 ? -2000 : 0)), 2, "reversed observedAt");
  // observedAt at 150 s equals 149 s: zero wall step for +1 s active.
  assert.equal(windows((second) => (second === 150 ? -1000 : 0)), 2, "zero wall step");
  const reversed = run({ resistanceAt: (second) => (second < 150 ? 8 : 9), wallOffsetMsAt: (second) => (second === 150 ? -2000 : 0) });
  assert.equal(reversed.held.stableResistance.observedResistanceChangeCount, 0,
    "a change across reversed chronology is not counted as one observed change");
});

test("a phase boundary splits a hold even when observed resistance never changes", () => {
  const { characterization, held } = run({ warm: 2, sustain: 5 });
  // The sustain window starts at the phase boundary (active 120 s), so settling restarts there.
  assert.equal(held.stableResistance.stableWindowCount, 1);
  assert.equal(held.stableResistance.stableDurationSec, 300);
  assert.equal(held.stableResistance.postSettlingDurationSec, 180);
  const warmup = characterization.phases.find((phase) => phase.phaseId === "warmup");
  assert.equal(warmup.heldWorkloadForwardResponse.outcome, "not_candidate");
  assert.equal(warmup.heldWorkloadForwardResponse.stableResistance, undefined);
});

test("stale or absent observed resistance cannot establish stability", () => {
  const allStale = run({ availabilityAt: () => "stale" }).held;
  assert.equal(allStale.outcome, "insufficient_evidence");
  assert.equal(allStale.exclusionReason, "no_stable_observed_resistance");
  assert.equal(allStale.stableResistance.stableWindowCount, 0);
  const staleGap = run({ availabilityAt: (second) => second >= 140 && second < 150 ? "stale" : "fresh" }).held;
  assert.equal(staleGap.stableResistance.stableWindowCount, 2);
  assert.equal(staleGap.stableResistance.stableDurationSec, 290);
});

test("desired and commanded resistance never substitute for observed resistance", () => {
  const desiredOnly = run({ resistanceAt: () => undefined, desiredAt: () => 8, commandedAt: () => undefined }).held;
  const commandedOnly = run({ resistanceAt: () => undefined, desiredAt: () => undefined, commandedAt: () => 8 }).held;
  for (const held of [desiredOnly, commandedOnly]) {
    assert.equal(held.stableResistance.stableWindowCount, 0);
    assert.equal(held.exclusionReason, "no_stable_observed_resistance");
    assert.equal(held.forwardHeartRate, undefined);
  }
  const steadyCommand = run({
    resistanceAt: (second) => second < 150 ? 8 : 9,
    desiredAt: () => 8,
    commandedAt: () => 8,
  }).held;
  assert.equal(steadyCommand.stableResistance.stableWindowCount, 2, "steady commands do not merge observed changes");
});

test("pre-settling HR never contributes forward error; post-settling HR does", () => {
  const { held } = run({ hrAt: (second) => second < PHASE_E2_HELD_WORKLOAD_POLICY_V1.settlingSeconds ? 200 : 150 });
  assert.equal(held.stableResistance.qualifyingDurationSec, 180);
  assert.equal(held.forwardHeartRate.signedErrorBpm.max, 150 - predicted(125));
  assert.equal(held.forwardHeartRate.signedErrorBpm.min, 150 - predicted(125));
});

test("HR clearly outside the legacy target is valid held-workload forward evidence", () => {
  const { phase, held } = run({ hrAt: () => 160 });
  // The closed-loop path finds no settled in-band evidence; the held path is not conditioned on it.
  assert.equal(phase.exclusionReason, "insufficient_settled_in_band_evidence");
  assert.equal(phase.comparison, undefined);
  assert.equal(held.outcome, "characterized");
  assert.equal(held.stableResistance.qualifyingDurationSec, 180);
  assert.equal(held.forwardHeartRate.signedErrorBpm.median, 160 - predicted(125));
  const inBand = run({ hrAt: () => 120 }).held;
  assert.deepEqual(inBand.stableResistance, held.stableResistance, "HR-band occupancy never changes qualification");
});

test("the held-workload reducer contains no HR-band, agreement, or controller-success filter", () => {
  const source = readFileSync(new URL("../src/personalizedPrescriptionCharacterization.ts", import.meta.url), "utf8");
  const shared = readFileSync(new URL("../src/workloadForwardResponse.ts", import.meta.url), "utf8");
  const start = source.indexOf("function characterizeHeldWorkload(");
  const end = source.indexOf("\nfunction ", start + 1);
  const body = source.slice(start, end);
  assert.ok(body.length > 500);
  assert.doesNotMatch(body, /activeHeartRate|insideBand|candidateContainsObservedMedian|agreement|inside_candidate|candidatePower|saturation/);
  for (const helper of ["stableObservedResistanceWindows", "heldObservationTrustworthy"]) {
    const helperStart = source.indexOf(`function ${helper}(`);
    const helperBody = source.slice(helperStart, source.indexOf("\nfunction ", helperStart + 1));
    assert.doesNotMatch(helperBody, /desiredResistance|commandedResistance|activeHeartRate/, helper);
  }
  assert.match(source, /from "\.\/workloadForwardResponse\.js"/);
  assert.doesNotMatch(shared,
    /PHASE_E2|PersonalizedPrescription|FitnessState|sessionStore|localStorage|indexedDB|diagnostic|E4A|document\./,
    "the shared mechanics must remain policy-neutral and portable");
});

test("measured-watts forward prediction follows the frozen calibration equation", () => {
  const wattsAt = (second) => 100 + (second % 3) * 50;
  const { held } = run({ wattsAt, hrAt: (second) => predicted(wattsAt(second)) + 5 });
  assert.equal(held.outcome, "characterized");
  assert.deepEqual(held.forwardHeartRate.signedErrorBpm, { median: 5, q1: 5, q3: 5, min: 5, max: 5 });
  assert.equal(held.forwardHeartRate.predictedHeartRateMedianBpm, predicted(150));
  assert.deepEqual(held.cadenceRpm, { observationCount: 180, median: 70, q1: 70, q3: 70 });
});

test("calibrated watts require the existing verified-cadence contract and stay a separate provenance", () => {
  const calibrated = run({ calibrationSource: "calibrated_at_verified_cadence", sourceAt: () => "calibrated_watts" });
  assert.equal(calibrated.characterization.calibrationWorkloadProvenance, "calibrated_at_verified_cadence");
  assert.equal(calibrated.held.observedPowerProvenance, "calibrated_watts");
  assert.equal(calibrated.held.outcome, "characterized");
  const offCadence = run({
    calibrationSource: "calibrated_at_verified_cadence",
    sourceAt: () => "calibrated_watts",
    cadenceAt: () => 85,
  }).held;
  assert.equal(offCadence.outcome, "insufficient_evidence");
  assert.equal(offCadence.stableResistance.stableWindowCount, 0, "an untrustworthy calibrated estimate fails closed");
  const noCadence = run({ sourceAt: () => "calibrated_watts", cadenceAt: () => undefined }).held;
  assert.equal(noCadence.stableResistance.stableWindowCount, 0);
  const measuredOffCadence = run({ cadenceAt: () => 95 }).held;
  assert.equal(measuredOffCadence.outcome, "characterized", "cadence is descriptive for measured watts");
  assert.equal(measuredOffCadence.cadenceRpm.median, 95);
});

test("calibrated-watts continuity requires verified cadence on every held sample", () => {
  const calibrated = { calibrationSource: "calibrated_at_verified_cadence", sourceAt: () => "calibrated_watts" };
  const gap = (second) => second >= 140 && second < 150;
  // calibrated watts → missing watts + missing cadence → calibrated watts: two windows.
  const bothMissing = run({ ...calibrated,
    wattsAt: (second) => (gap(second) ? undefined : 125),
    cadenceAt: (second) => (gap(second) ? undefined : 70) }).held;
  assert.equal(bothMissing.stableResistance.stableWindowCount, 2);
  assert.equal(bothMissing.stableResistance.stableDurationSec, 290);
  // Off-band cadence with or without a watt estimate breaks the window and restarts settling.
  const offBand = run({ ...calibrated,
    wattsAt: (second) => (gap(second) ? undefined : 125),
    cadenceAt: (second) => (gap(second) ? 90 : 70) }).held;
  assert.equal(offBand.stableResistance.stableWindowCount, 2);
  const offBandWithWatts = run({ ...calibrated, cadenceAt: (second) => (gap(second) ? 90 : 70) }).held;
  assert.equal(offBandWithWatts.stableResistance.stableWindowCount, 2);
  // Unverified cadence never advances settling: the post-140 s window settles from 150 s.
  assert.equal(offBand.stableResistance.postSettlingDurationSec, 20 + 30);
  // Decision: missing watts with verified in-band cadence keeps the contract workload, so the
  // hold continues; the second is counted as watts-unavailable and contributes no error.
  const missingWattsOnly = run({ ...calibrated, wattsAt: (second) => (second >= 200 && second < 210 ? undefined : 125) }).held;
  assert.equal(missingWattsOnly.stableResistance.stableWindowCount, 1);
  assert.equal(missingWattsOnly.stableResistance.excludedPostSettlingSeconds.wattsUnavailable, 10);
  assert.equal(missingWattsOnly.stableResistance.qualifyingDurationSec, 170);
  // Measured watts: missing cadence and missing watts do not break a resistance hold.
  const measured = run({ wattsAt: (second) => (gap(second) ? undefined : 125), cadenceAt: (second) => (gap(second) ? undefined : 70) }).held;
  assert.equal(measured.stableResistance.stableWindowCount, 1);
  // A provenance mismatch inside a hold breaks the window (and the phase fails closed as mixed).
  const mismatch = run({ ...calibrated, sourceAt: (second) => (second === 145 ? "measured_watts" : "calibrated_watts") }).held;
  assert.equal(mismatch.outcome, "unsupported_observed_provenance");
  assert.ok(mismatch.stableResistance.stableWindowCount >= 2);
  assert.equal(mismatch.forwardHeartRate, undefined);
});

test("mixed provenance applies the strict cadence rule and never yields forward evidence", () => {
  const mixed = run({
    sourceAt: (second) => (second < 150 ? "measured_watts" : "calibrated_watts"),
    cadenceAt: (second) => (second >= 50 && second < 60 ? undefined : 70),
  }).held;
  assert.equal(mixed.outcome, "unsupported_observed_provenance");
  assert.equal(mixed.stableResistance.stableWindowCount, 3, "missing cadence breaks even the measured-watts span of a mixed phase");
  assert.equal(mixed.forwardHeartRate, undefined);
  assert.equal(mixed.cadenceRpm, undefined);
});

test("mixed observed power provenance fails closed without forward statistics", () => {
  const { held } = run({ sourceAt: (second) => second < 150 ? "measured_watts" : "calibrated_watts" });
  assert.equal(held.observedPowerProvenance, "mixed");
  assert.equal(held.outcome, "unsupported_observed_provenance");
  assert.equal(held.exclusionReason, "unsupported_power_provenance");
  assert.equal(held.forwardHeartRate, undefined);
  assert.equal(held.stableResistance.stableWindowCount, 2, "a provenance change breaks the window");
});

test("watts outside the frozen calibration domain are excluded, never clamped or extrapolated", () => {
  const above = run({ wattsAt: () => 250 }).held;
  assert.equal(above.stableResistance.excludedPostSettlingSeconds.outsideCalibrationDomain, 180);
  assert.equal(above.stableResistance.qualifyingDurationSec, 0);
  assert.equal(above.exclusionReason, "insufficient_post_settling_evidence");
  assert.equal(above.forwardHeartRate, undefined);
  const below = run({ wattsAt: () => 50 }).held;
  assert.equal(below.stableResistance.excludedPostSettlingSeconds.outsideCalibrationDomain, 180);
  // Half in-domain: only in-domain seconds contribute, at their own predictions.
  const partial = run({ wattsAt: (second) => second % 2 === 0 ? 250 : 150, hrAt: () => 150 }).held;
  assert.equal(partial.stableResistance.excludedPostSettlingSeconds.outsideCalibrationDomain, 90);
  assert.equal(partial.stableResistance.qualifyingDurationSec, 90);
  const inDomainError = 150 - predicted(150);
  assert.deepEqual(partial.forwardHeartRate.signedErrorBpm,
    { median: inDomainError, q1: inDomainError, q3: inDomainError, min: inDomainError, max: inDomainError });
  assert.equal(partial.forwardHeartRate.predictedHeartRateMedianBpm, predicted(150));
  const edges = run({ wattsAt: (second) => second % 2 === 0 ? 100 : 200 }).held;
  assert.equal(edges.stableResistance.excludedPostSettlingSeconds.outsideCalibrationDomain, 0, "domain is inclusive");
});

test("missing, stale, or invalid HR is excluded rather than zero-filled or interpolated", () => {
  const { held } = run({ hrAt: (second) => second >= 200 && second < 230 ? undefined : second >= 230 && second < 240 ? 300 : 150 });
  assert.equal(held.stableResistance.excludedPostSettlingSeconds.heartRateUnavailable, 40);
  assert.equal(held.stableResistance.qualifyingDurationSec, 140);
  assert.equal(held.forwardHeartRate.signedErrorBpm.min, 150 - predicted(125));
  const missingWatts = run({ wattsAt: (second) => second >= 200 && second < 210 ? undefined : 125 }).held;
  assert.equal(missingWatts.stableResistance.excludedPostSettlingSeconds.wattsUnavailable, 10);
  assert.equal(missingWatts.stableResistance.stableWindowCount, 1, "missing watts do not break observed resistance");
});

test("aggregation across windows is pooled, deterministic, and independent of input order", () => {
  const options = {
    resistanceAt: (second) => second < 150 ? 8 : 9,
    wattsAt: (second) => second < 150 ? 125 : 175,
    hrAt: (second) => second < 150 ? 130 : 140,
  };
  const forward = run(options).held;
  const reversed = run({ ...options, reverseInput: true }).held;
  assert.deepEqual(reversed, forward);
  assert.equal(forward.stableResistance.qualifyingWindowCount, 2);
  assert.deepEqual(forward.forwardHeartRate.signedErrorBpm, {
    median: (130 - predicted(125) + 140 - predicted(175)) / 2,
    q1: 140 - predicted(175),
    q3: 130 - predicted(125),
    min: 140 - predicted(175),
    max: 130 - predicted(125),
  });
  assert.equal(forward.forwardHeartRate.absoluteErrorBpm.max, Math.abs(140 - predicted(175)));
});

test("signed forward error is observed HR minus predicted HR", () => {
  const higher = run({ hrAt: () => predicted(125) + 8 }).held;
  const lower = run({ hrAt: () => predicted(125) - 6 }).held;
  assert.equal(higher.forwardHeartRate.signedErrorBpm.median, 8);
  assert.equal(higher.forwardHeartRate.absoluteErrorBpm.median, 8);
  assert.equal(lower.forwardHeartRate.signedErrorBpm.median, -6);
  assert.equal(lower.forwardHeartRate.absoluteErrorBpm.median, 6);
});

test("permanent v1 and v2 readers are unchanged and cannot carry v3 evidence", () => {
  const { characterization, e1 } = run({ hrAt: () => 120 });
  const v2 = asHistoricalV2(characterization);
  assert.deepEqual(parsePersonalizedPrescriptionCharacterization(v2, e1), v2);
  const v1 = clone(v2);
  v1.schemaVersion = 1;
  v1.characterizer.version = 1;
  delete v1.formalAssessmentProvenance;
  assert.deepEqual(parsePersonalizedPrescriptionCharacterization(v1, e1), v1);
  for (const [label, historical] of [["v1", v1], ["v2", v2]]) {
    const withPolicy = { ...clone(historical), heldWorkloadPolicy: clone(PHASE_E2_HELD_WORKLOAD_POLICY_V1) };
    assert.equal(parsePersonalizedPrescriptionCharacterization(withPolicy, e1), null, label);
    const withModel = { ...clone(historical), heldWorkloadForwardModel: clone(characterization.heldWorkloadForwardModel) };
    assert.equal(parsePersonalizedPrescriptionCharacterization(withModel, e1), null, label);
    const withPhase = clone(historical);
    withPhase.phases[0].heldWorkloadForwardResponse = clone(characterization.phases[0].heldWorkloadForwardResponse);
    assert.equal(parsePersonalizedPrescriptionCharacterization(withPhase, e1), null, label);
  }
  const relabeled = clone(characterization);
  relabeled.schemaVersion = 2;
  relabeled.characterizer.version = 2;
  assert.equal(parsePersonalizedPrescriptionCharacterization(relabeled, e1), null, "v3 cannot be relabeled as v2");
});

test("strict v3 parsing round-trips and rejects future schemas and malformed held metrics", () => {
  const { characterization, e1, response } = run();
  const expected = { athleteId: ATHLETE, sessionId: SESSION, workoutSelector: "Tuesday", activity: "bike", workoutResponse: response };
  assert.deepEqual(parsePersonalizedPrescriptionCharacterization(characterization, e1, expected), characterization);
  const held = (value) => value.phases[0].heldWorkloadForwardResponse;
  for (const [label, mutate] of [
    ["future schema", (value) => { value.schemaVersion = 4; }],
    ["future characterizer", (value) => { value.characterizer.version = 4; }],
    ["missing held policy", (value) => { delete value.heldWorkloadPolicy; }],
    ["unknown held policy version", (value) => { value.heldWorkloadPolicy.version = 2; }],
    ["forged forward model", (value) => { value.heldWorkloadForwardModel.interceptBpm = 61; }],
    ["missing forward model", (value) => { delete value.heldWorkloadForwardModel; }],
    ["missing phase summary", (value) => { delete value.phases[0].heldWorkloadForwardResponse; }],
    ["unknown summary key", (value) => { held(value).passed = true; }],
    ["unknown outcome", (value) => { held(value).outcome = "validated"; }],
    ["provenance mismatch", (value) => { held(value).observedPowerProvenance = "calibrated_watts"; }],
    ["accounting mismatch", (value) => { held(value).stableResistance.qualifyingDurationSec -= 1; }],
    ["negative count", (value) => { held(value).stableResistance.excludedPostSettlingSeconds.observationGap = -1; }],
    ["fractional count", (value) => { held(value).stableResistance.stableWindowCount = 1.5; }],
    ["windows exceed duration", (value) => { held(value).stableResistance.stableDurationSec = 10_000; }],
    ["qualifying windows exceed windows", (value) => { held(value).stableResistance.qualifyingWindowCount = 2; }],
    ["unordered distribution", (value) => { held(value).forwardHeartRate.signedErrorBpm.q1 = 1_000; }],
    ["absolute max mismatch", (value) => { held(value).forwardHeartRate.absoluteErrorBpm.max += 1; }],
    ["negative absolute error", (value) => { held(value).forwardHeartRate.absoluteErrorBpm.min = -1; }],
    ["prediction outside calibration domain", (value) => { held(value).forwardHeartRate.predictedHeartRateMedianBpm = 200; }],
    ["non-finite error", (value) => { held(value).forwardHeartRate.signedErrorBpm.median = Number.NaN; }],
    ["characterized below policy minimum", (value) => {
      const stable = held(value).stableResistance;
      stable.excludedPostSettlingSeconds.heartRateUnavailable += stable.qualifyingDurationSec - 1;
      stable.qualifyingDurationSec = 1;
    }],
    ["forward stats without characterization", (value) => {
      held(value).outcome = "insufficient_evidence";
      held(value).exclusionReason = "insufficient_post_settling_evidence";
    }],
    ["candidate labeled not_candidate", (value) => {
      held(value).outcome = "not_candidate";
      delete held(value).stableResistance;
      delete held(value).forwardHeartRate;
      delete held(value).cadenceRpm;
    }],
    ["cadence count exceeds qualifying seconds", (value) => { held(value).cadenceRpm.observationCount = 10_000; }],
  ]) {
    const forged = clone(characterization);
    mutate(forged);
    assert.equal(parsePersonalizedPrescriptionCharacterization(forged, e1, expected), null, label);
  }
});

test("the durable v3 summary is read back and summarized with no raw telemetry present", async () => {
  await resetWorkoutStorageForTests();
  const result = run();
  // Only the immutable summary is stored: no HR samples and no ordinary bike telemetry.
  assert.equal(await storeWorkoutSummary(summaryFor(result)), true);
  const history = await getAllWorkoutSummaries();
  const records = extractTrustedPersonalizationCharacterizations(history, ATHLETE);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], result.characterization);
  const model = buildPersonalizationDiagnosticsModel(records);
  assert.equal(model.heldWorkloadForward.characterizedPhases, 1);
  assert.equal(model.heldWorkloadForward.qualifyingDurationSec, 180);
  assert.equal(model.heldWorkloadForward.medianPhaseSignedErrorBpm, 150 - predicted(125));
});

test("diagnostics distinguish closed-loop transfer evidence from held-workload forward-response evidence", () => {
  const records = [run({ hrAt: () => 120 }).characterization];
  const model = buildPersonalizationDiagnosticsModel(records);
  const html = personalizationDiagnosticsHtml(model);
  const start = html.indexOf("id=\"personalizationHeldWorkloadForward\"");
  const section = html.slice(start, html.indexOf("</section>", start));
  assert.ok(start > 0);
  assert.match(section, /Held-workload forward-response evidence/);
  assert.match(section, /signed error = observed HR − predicted HR/);
  assert.match(section, /not filtered by legacy heart-rate target occupancy/);
  assert.match(section, /not independent open-loop evidence/);
  assert.match(section, /Qualifying \/ stable observed-resistance windows/);
  assert.match(section, /Excluded outside calibration watt domain/);
  assert.match(section, /Measured \/ calibrated watts characterized phases/);
  assert.doesNotMatch(section, /\b(validated|safe|approved|ready)\b|open-loop proven/i);
  const detail = personalizationDiagnosticDetailHtml(model.rows[0]);
  assert.match(detail, /<h5>Closed-loop transfer evidence<\/h5>/);
  assert.match(detail, /<h5>Held-workload forward-response evidence<\/h5>/);
  const heldDetail = detail.slice(detail.indexOf("<h5>Held-workload"));
  assert.match(heldDetail, /Forward HR signed error median/);
  assert.match(heldDetail, /Forward HR absolute error median/);
  assert.doesNotMatch(heldDetail, /\b(validated|safe|approved|ready)\b|open-loop proven/i);
  const historical = buildPersonalizationDiagnosticsModel([asHistoricalV2(records[0])]);
  assert.match(personalizationDiagnosticDetailHtml(historical.rows[0]), /not recorded \(pre-E2 v3 record\)/);
  assert.match(personalizationDiagnosticsHtml(historical), /No E2 v3 held-workload evidence yet/);
});

const EXPORT_KEYS = ["schemaVersion", "filters", "aggregate", "diagnosticRows", "characterizationRecords"];
const RUNTIME_ONLY = ["thresholdLongitudinal", "heldWorkloadForward", "scientificAssessments", "evidenceCollectionSummary"];

test("historical diagnostics export v2 keeps its exact shape and v1/v2 record contract", () => {
  const current = run({ hrAt: () => 120 }).characterization;
  const v2Record = { ...asHistoricalV2(current), workoutSessionId: "held-historical" };
  const v1Record = { ...clone(v2Record), workoutSessionId: "held-historical-v1", schemaVersion: 1,
    characterizer: { ...v2Record.characterizer, version: 1 } };
  delete v1Record.formalAssessmentProvenance;
  const model = buildPersonalizationDiagnosticsModel([v2Record, v1Record]);
  const exported = createHistoricalPersonalizationDiagnosticsExportV2(model);
  assert.equal(exported.schemaVersion, 2);
  assert.equal(exported.aggregate.schemaVersion, 2);
  assert.deepEqual(Object.keys(exported), EXPORT_KEYS);
  assert.deepEqual(exported.characterizationRecords.map((record) => record.schemaVersion).sort(), [1, 2]);
  assert.deepEqual(exported.characterizationRecords.find((record) => record.schemaVersion === 2), v2Record);
  const json = JSON.stringify(exported);
  for (const key of RUNTIME_ONLY) assert.equal(json.includes(`"${key}"`), false, key);
  assert.equal(json.includes("heldWorkload"), false);
  // Same durable body as the current writer for the same historical records; only the outer version differs.
  const currentExport = createPersonalizationDiagnosticsExport(model);
  assert.deepEqual({ ...currentExport, schemaVersion: 2 }, exported);
});

test("an E2 v3 characterization is never emitted inside export v2", () => {
  const current = run({ hrAt: () => 120 }).characterization;
  const historical = { ...asHistoricalV2(current), workoutSessionId: "held-historical" };
  assert.equal(createHistoricalPersonalizationDiagnosticsExportV2(buildPersonalizationDiagnosticsModel([current])), null);
  assert.equal(
    createHistoricalPersonalizationDiagnosticsExportV2(buildPersonalizationDiagnosticsModel([historical, current])),
    null,
    "a mixed history fails closed instead of silently dropping or relabeling the v3 record"
  );
});

test("current diagnostics export v3 round-trips E2 v3 records and exports no runtime projections", () => {
  const result = run({ hrAt: () => 120 });
  const historical = { ...asHistoricalV2(result.characterization), workoutSessionId: "held-historical" };
  const model = buildPersonalizationDiagnosticsModel([result.characterization, historical], undefined, {}, {}, {},
    "2026-09-21T00:00:00.000Z");
  assert.equal(model.heldWorkloadForward.characterizedPhases, 1, "runtime projection exists in the model");
  const exported = createPersonalizationDiagnosticsExport(model);
  assert.equal(exported.schemaVersion, 3);
  assert.equal(exported.aggregate.schemaVersion, 2);
  assert.deepEqual(Object.keys(exported), EXPORT_KEYS);
  const json = JSON.stringify(exported);
  for (const key of RUNTIME_ONLY) assert.equal(json.includes(`"${key}"`), false, key);
  const roundTripped = JSON.parse(json);
  const v3 = roundTripped.characterizationRecords.find((record) => record.schemaVersion === 3);
  assert.deepEqual(v3, result.characterization);
  assert.deepEqual(parsePersonalizedPrescriptionCharacterization(v3, result.e1), result.characterization);
  assert.deepEqual(roundTripped.characterizationRecords.find((record) => record.schemaVersion === 2), historical);
  assert.deepEqual(Object.keys(exported.diagnosticRows[0]), Object.keys(exported.diagnosticRows[1]),
    "row shape is the same for v2 and v3 records");
});

function e4aInputs(results) {
  const history = results.map(({ result, sessionId, createdAt }) => ({ summary: summaryFor(result, sessionId, createdAt) }));
  const records = extractTrustedPersonalizationCharacterizations(history, ATHLETE);
  const assessmentContexts = extractTrustedPersonalizationAssessmentContexts(history, ATHLETE);
  const workoutContexts = extractTrustedPersonalizationWorkoutContexts(history, ATHLETE);
  const [subject] = discoverDiagnosticSubjects(records, assessmentContexts, workoutContexts, ATHLETE);
  return { records, assessmentContexts, workoutContexts, subject };
}

test("multiple held-load windows remain one workout-level longitudinal observation", () => {
  const multiWindow = run({ hrAt: () => 120, resistanceAt: (second) => (second < 150 ? 8 : 9) }).held;
  assert.equal(multiWindow.stableResistance.qualifyingWindowCount, 2);
  const result = run({ sustain: 10, hrAt: () => 120, resistanceAt: (second) => Math.floor(second / 200) + 6 });
  assert.equal(result.held.stableResistance.qualifyingWindowCount, 3);
  const inputs = e4aInputs([{ result, sessionId: "held-one", createdAt: CREATED_AT }]);
  const evidence = buildSubjectEvidence({ ...inputs, currentCalibration: null });
  assert.equal(evidence.heldWorkloadForwardSessions.length, 1);
  assert.equal(evidence.heldWorkloadForwardSessions[0].qualifyingWindowCount, 3);
  const assessment = assessPersonalizedWorkloadEvidence(evidence, inputs.subject, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1,
    "2026-09-21T00:00:00.000Z");
  assert.equal(assessment.evidenceDigest.heldWorkloadForwardSessionCount, 1);
  assert.equal(assessment.evidenceDigest.sessionCount, 1);
});

test("held-workload visibility in E4A is not conditioned on closed-loop HR-band success", () => {
  const outsideBand = run({ hrAt: () => 160 });
  assert.equal(outsideBand.phase.characterizationOutcome, "insufficient_evidence");
  const inputs = e4aInputs([{ result: outsideBand, sessionId: "held-outside", createdAt: CREATED_AT }]);
  const evidence = buildSubjectEvidence({ ...inputs, currentCalibration: null });
  assert.equal(evidence.sessions.length, 0, "closed-loop evidence rows are unchanged");
  assert.equal(evidence.heldWorkloadForwardSessions.length, 1);
  assert.equal(evidence.heldWorkloadForwardSessions[0].medianSignedErrorBpm, 160 - predicted(125));
});

test("production E4A stays non-eligible and reports both open-loop and actuation blockers despite excellent v3 evidence", () => {
  const days = ["2026-09-03", "2026-09-06", "2026-09-09", "2026-09-12", "2026-09-15", "2026-09-18", "2026-09-20"];
  const excellent = run({ hrAt: () => predicted(125) });
  assert.equal(excellent.held.forwardHeartRate.absoluteErrorBpm.max, 0);
  assert.equal(excellent.phase.characterizationOutcome, "characterized");
  const inputs = e4aInputs(days.map((day, index) => ({
    result: excellent,
    sessionId: `held-excellent-${index}`,
    createdAt: `${day}T12:10:00.000Z`,
  })));
  const evidence = buildSubjectEvidence({ ...inputs, currentCalibration: inputs.subject.calibration });
  assert.equal(evidence.heldWorkloadForwardSessions.length, days.length);
  assert.ok(evidence.sessions.every((session) => session.openLoop === null && session.actuationMode === "unknown"));
  const assessment = assessPersonalizedWorkloadEvidence(evidence, inputs.subject, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1,
    "2026-09-21T00:00:00.000Z");
  assert.equal(E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1.openLoopEvidence, "required_but_unavailable");
  assert.equal(E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1.actuationModeEvidence, "required_but_unavailable");
  assert.equal(assessment.runtimeAuthority, false);
  assert.notEqual(assessment.state, "eligible");
  assert.ok(assessment.reasonCodes.includes("open_loop_evidence_unavailable"));
  assert.ok(assessment.reasonCodes.includes("actuation_mode_unknown"));
  assert.equal(assessment.gates.find((gate) => gate.id === "open_loop_evidence").status, "fail");
  assert.equal(assessment.gates.find((gate) => gate.id === "actuation_mode_evidence").status, "fail");
  assert.equal(assessment.evidenceDigest.heldWorkloadForwardSessionCount, days.length);
  assert.equal(assessment.evidenceDigest.medianHeldWorkloadForwardAbsoluteErrorBpm, 0);
  // Diagnostics use production policy v2: open-loop stays unavailable and nothing becomes eligible.
  const model = buildPersonalizationDiagnosticsModel(inputs.records, undefined, inputs.assessmentContexts,
    inputs.workoutContexts, {}, "2026-09-21T00:00:00.000Z");
  assert.ok(model.scientificAssessments.length > 0);
  for (const item of model.scientificAssessments) {
    assert.notEqual(item.state, "eligible");
    assert.equal(item.runtimeAuthority, false);
    assert.ok(item.reasonCodes.includes("open_loop_evidence_unavailable"));
  }
});

test("E2 v3 has no runtime, control, E1, or FitnessState feedback path", () => {
  const e2 = readFileSync(new URL("../src/personalizedPrescriptionCharacterization.ts", import.meta.url), "utf8");
  assert.doesNotMatch(e2, /from ["']\.\/(fitnessState|fitnessRefinement|profile|workoutPrescription|workoutLogic|uiControls)/);
  // Only the pre-existing type-only audit import may reference machines; nothing reaches platform/runtime code.
  const machineImports = e2.split(/\r?\n/).filter((line) => /from ["']\.\/(machines|platform)\//.test(line));
  assert.deepEqual(machineImports, ['import type { MachineDecisionAuditEntry } from "./machines/audit/types.js";']);
  assert.doesNotMatch(e2, /localStorage|indexedDB|Date\.now\(/);
  const writers = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`);
      else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(new URL(`${dir}${entry.name}`, import.meta.url), "utf8");
        if (/PHASE_E2_HELD_WORKLOAD_POLICY_V1|heldWorkloadForward/.test(source)) writers.push(`${dir}${entry.name}`);
      }
    }
  };
  walk("../src/");
  assert.deepEqual(writers.sort(), [
    "../src/personalizationDiagnosticsView.ts",
    "../src/personalizationScientificAssessment.ts",
    "../src/personalizedPrescriptionCharacterization.ts",
    "../src/scientificSessionEvidence.ts",
    "../src/steadyStateSettledWorkload.ts",
    "../src/types.ts",
    "../src/workoutSummary.ts",
  ]);
  const summary = readFileSync(new URL("../src/workoutSummary.ts", import.meta.url), "utf8");
  assert.match(summary, /summary\.shadow_prescription_characterization = characterization/);
});

test("strict v3 reader requires complete verified cadence evidence for calibrated-watts characterization", () => {
  const calibrated = run({ calibrationSource: "calibrated_at_verified_cadence", sourceAt: () => "calibrated_watts" });
  const { characterization, e1 } = calibrated;
  const held = (value) => value.phases[0].heldWorkloadForwardResponse;
  assert.equal(held(characterization).observedPowerProvenance, "calibrated_watts");
  assert.equal(held(characterization).cadenceRpm.observationCount, held(characterization).stableResistance.qualifyingDurationSec);
  assert.deepEqual(parsePersonalizedPrescriptionCharacterization(characterization, e1), characterization);
  for (const [label, mutate] of [
    ["cadence deleted", (value) => { delete held(value).cadenceRpm; }],
    ["cadence count below qualifying duration", (value) => { held(value).cadenceRpm.observationCount -= 1; }],
    ["median above verified band", (value) => { Object.assign(held(value).cadenceRpm, { q1: 80, median: 80, q3: 80 }); }],
    ["median below verified band", (value) => { Object.assign(held(value).cadenceRpm, { q1: 60, median: 60, q3: 60 }); }],
    ["q1 below verified band", (value) => { held(value).cadenceRpm.q1 = 64; }],
    ["q3 above verified band", (value) => { held(value).cadenceRpm.q3 = 76; }],
  ]) {
    const forged = clone(characterization);
    mutate(forged);
    assert.equal(parsePersonalizedPrescriptionCharacterization(forged, e1), null, label);
  }
  // Measured-watts cadence remains descriptive and optional.
  const measured = run();
  const withoutCadence = clone(measured.characterization);
  delete held(withoutCadence).cadenceRpm;
  assert.deepEqual(parsePersonalizedPrescriptionCharacterization(withoutCadence, measured.e1), withoutCadence);
  const partialCadence = clone(measured.characterization);
  held(partialCadence).cadenceRpm.observationCount = 10;
  Object.assign(held(partialCadence).cadenceRpm, { q1: 90, median: 95, q3: 100 });
  assert.deepEqual(parsePersonalizedPrescriptionCharacterization(partialCadence, measured.e1), partialCadence);
});

test("a multi-phase subject workout contributes no held-forward observation", () => {
  const result = run({ hrAt: () => 120 });
  assert.equal(result.phase.characterizationOutcome, "characterized");
  const assess = (inputs) => {
    const evidence = buildSubjectEvidence({ ...inputs, currentCalibration: null });
    const assessment = assessPersonalizedWorkloadEvidence(evidence, inputs.subject, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1,
      "2026-09-21T00:00:00.000Z");
    return { evidence, assessment };
  };
  const sibling = (phase, heldOutcome) => {
    const copy = clone(phase);
    copy.phaseId = "sustain-sibling";
    copy.heldWorkloadForwardResponse = heldOutcome;
    return copy;
  };
  const insufficientHeld = {
    outcome: "insufficient_evidence",
    exclusionReason: "no_stable_observed_resistance",
    observedPowerProvenance: "measured_watts",
  };

  // Both phases closed-loop characterized, only one held-characterized: existing multi-phase exclusion.
  const multi = e4aInputs([{ result, sessionId: "held-multi", createdAt: CREATED_AT }]);
  multi.records[0].phases.push(sibling(multi.records[0].phases[0], insufficientHeld));
  const excluded = assess(multi);
  assert.equal(excluded.evidence.excludedMultiPhaseSessions, 1);
  assert.equal(excluded.evidence.sessions.length, 0);
  assert.equal(excluded.evidence.heldWorkloadForwardSessions.length, 0);
  assert.equal(excluded.assessment.evidenceDigest.heldWorkloadForwardSessionCount, 0);

  // Two relevant subject phases but only one closed-loop characterized: not multi-phase excluded,
  // yet still ambiguous for the held-forward longitudinal observation.
  const ambiguous = e4aInputs([{ result, sessionId: "held-ambiguous", createdAt: CREATED_AT }]);
  const uncharacterized = sibling(ambiguous.records[0].phases[0], insufficientHeld);
  uncharacterized.characterizationOutcome = "insufficient_evidence";
  uncharacterized.exclusionReason = "insufficient_settled_in_band_evidence";
  delete uncharacterized.comparison;
  delete uncharacterized.stableInBandWorkload;
  ambiguous.records[0].phases.push(uncharacterized);
  const ambiguousResult = assess(ambiguous);
  assert.equal(ambiguousResult.evidence.excludedMultiPhaseSessions, 0);
  assert.equal(ambiguousResult.evidence.sessions.length, 1);
  assert.equal(ambiguousResult.evidence.heldWorkloadForwardSessions.length, 0);
  assert.equal(ambiguousResult.assessment.evidenceDigest.heldWorkloadForwardSessionCount, 0);

  // The single-phase case is preserved.
  const single = assess(e4aInputs([{ result, sessionId: "held-single", createdAt: CREATED_AT }]));
  assert.equal(single.evidence.heldWorkloadForwardSessions.length, 1);
  assert.equal(single.assessment.evidenceDigest.heldWorkloadForwardSessionCount, 1);
  assert.equal(single.assessment.runtimeAuthority, false);
  assert.ok(single.assessment.reasonCodes.includes("open_loop_evidence_unavailable"));
  assert.ok(single.assessment.reasonCodes.includes("actuation_mode_unknown"));
});
