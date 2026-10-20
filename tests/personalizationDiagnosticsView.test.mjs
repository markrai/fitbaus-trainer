import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS,
  buildPersonalizationDiagnosticsModel,
  buildThresholdLongitudinalAnalysis,
  createPersonalizationDiagnosticsExport,
  extractTrustedPersonalizationAssessmentContexts,
  extractTrustedPersonalizationCharacterizations,
  extractTrustedPersonalizationPerformedLoadContexts,
  extractTrustedPersonalizationWorkoutContexts,
  personalizationDiagnosticDetailHtml,
  personalizationDiagnosticsExportJson,
  personalizationDiagnosticsHtml,
  summarizePersonalizationEvidenceCollection,
} from "../dist/personalizationDiagnosticsView.js";

function phase(overrides = {}) {
  return {
    phaseId: "sustain",
    kind: "work",
    intensityId: "aerobic_base",
    detailName: "Aerobic Base",
    activeStartSec: 0,
    activeEndSec: 180,
    shadowOutcome: "candidate",
    legacyHeartRate: { min: 115, max: 130 },
    candidatePower: { minWatts: 110, maxWatts: 140 },
    evidenceCoverage: {
      plannedDurationSec: 180, observedDurationSec: 180, hrCoveredSeconds: 180,
      powerCoveredSeconds: 180, jointCoveredSeconds: 180,
      hrCoverageRatio: 1, powerCoverageRatio: 1, jointCoverageRatio: 1,
    },
    observedHeartRate: {
      sampleCount: 180, meanBpm: 124, medianBpm: 124, minBpm: 112, maxBpm: 133,
      belowBandSeconds: 15, insideBandSeconds: 150, aboveBandSeconds: 15,
      insideBandRatio: 150 / 180, earlyWindowMedianBpm: 121, lateWindowMedianBpm: 128,
      heartRateChangeLateVsEarlyBpm: 7,
    },
    observedPowerProvenance: "measured_watts",
    observedPower: {
      provenance: "measured_watts", sampleCount: 180, medianWatts: 125,
      q1Watts: 120, q3Watts: 130, minWatts: 105, maxWatts: 145,
      belowCandidateSeconds: 10, insideCandidateSeconds: 160, aboveCandidateSeconds: 10,
      insideCandidateRatio: 160 / 180,
    },
    stableInBandWorkload: {
      sampleCount: 120, medianWatts: 125, q1Watts: 120, q3Watts: 130,
      minWatts: 115, maxWatts: 135,
    },
    controllerContext: {
      available: true,
      observed: { coveredSeconds: 180, lowerBoundSeconds: 0, upperBoundSeconds: 0 },
      desired: { coveredSeconds: 180, lowerBoundSeconds: 0, upperBoundSeconds: 0 },
      commanded: { coveredSeconds: 180, lowerBoundSeconds: 0, upperBoundSeconds: 0 },
      anyBoundarySaturationSeconds: 0, saturationRatio: 0,
      lowerBoundaryDecisionCount: 0, upperBoundaryDecisionCount: 0,
    },
    candidateDomainMargins: {
      heartRateToLowerBoundaryBpm: 2, heartRateToUpperBoundaryBpm: 8,
      wattsToLowerBoundary: 10, wattsToUpperBoundary: 10, bucket: "edge",
    },
    comparison: {
      candidateMidpointWatts: 125, observedInBandMedianWatts: 125,
      signedDifferenceWatts: 0, absoluteDifferenceWatts: 0, signedDifferencePercent: 0,
      candidateContainsObservedMedian: true, candidateObservedOverlapWatts: 10,
      candidateObservedOverlapRatio: 1, agreement: "inside_candidate",
    },
    characterizationOutcome: "characterized",
    ...overrides,
  };
}

function record(id = "session-a", overrides = {}) {
  return {
    schemaVersion: 1,
    characterizer: { id: "personalized-prescription-characterization", version: 1 },
    mode: "diagnostic",
    activationEligible: false,
    sourceShadow: {
      resolverId: "personalized-prescription-shadow", resolverVersion: 1,
      shadowSchemaVersion: 1, resolvedAt: "2026-09-20T12:00:00.000Z",
    },
    athleteId: "athlete-a",
    workoutSessionId: id,
    workoutSelector: "Monday",
    workoutIntent: "Aerobic Base",
    activity: "bike",
    formalAssessmentQuality: "high",
    calibrationWorkloadProvenance: "measured_watts",
    policy: {
      id: "e2-characterization-policy", version: 1, minObservedPhaseDurationSec: 60,
      minHrCoverageRatio: 0.75, minPowerCoverageRatio: 0.75, minJointCoverageRatio: 0.65,
      settlingSeconds: 30, minSettledInBandSeconds: 15, heartRateChangeWindowSeconds: 60,
      minHeartRateChangeWindowSamples: 30, domainEdgeFraction: 0.1,
    },
    phases: [phase()],
    createdAt: "2026-09-20T12:30:00.000Z",
    ...overrides,
  };
}

function evaluation(overrides = {}) {
  return { athleteId: "athlete-a", workoutSelector: "Monday", activity: "bike", activationEligible: false, ...overrides };
}

function historyRow(characterization = record(), overrides = {}) {
  return { summary: {
    athlete_id: "athlete-a", external_session_id: characterization.workoutSessionId,
    day: "Monday", activity: "bike", shadow_prescription_evaluation: evaluation(),
    shadow_prescription_characterization: characterization, ...overrides,
  } };
}

test("diagnostic extraction accepts only owner/session/selector-linked E1 plus E2 from trusted history", () => {
  const valid = record();
  const history = [
    historyRow(valid),
    historyRow(record("e1-only"), { shadow_prescription_characterization: undefined }),
    historyRow(record("wrong-owner", { athleteId: "athlete-b" })),
    historyRow(record("wrong-session"), { external_session_id: "different-session" }),
    historyRow(record("wrong-selector"), { day: "Tuesday" }),
    { summary: { athlete_id: "athlete-a", external_session_id: "legacy", day: "Monday", activity: "bike" } },
  ];
  assert.deepEqual(extractTrustedPersonalizationCharacterizations(history, "athlete-a"), [valid]);
});

test("detail context comes from the frozen trusted E1 snapshot, never current FitnessState", () => {
  const characterization = record();
  const frozenEvaluation = evaluation({
    fitnessEvidenceSnapshot: {
      metricObservedAt: "2026-09-18T14:30:00.000Z",
      quality: "high",
      calibration: {
        workloadProvenance: "measured_watts",
        observedMinWatts: 100,
        observedMaxWatts: 150,
        points: [
          { heartRateBpm: 120 },
          { heartRateBpm: 140 },
        ],
      },
    },
  });
  const history = [historyRow(characterization, { shadow_prescription_evaluation: frozenEvaluation })];
  const contexts = extractTrustedPersonalizationAssessmentContexts(history, "athlete-a");
  const model = buildPersonalizationDiagnosticsModel(
    [characterization],
    EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS,
    contexts
  );
  assert.deepEqual(model.rows[0].assessmentContext, {
    observedAt: "2026-09-18T14:30:00.000Z",
    quality: "high",
    calibrationProvenance: "measured_watts",
    observedMinHeartRateBpm: 120,
    observedMaxHeartRateBpm: 140,
    observedMinWatts: 100,
    observedMaxWatts: 150,
  });
  assert.match(personalizationDiagnosticDetailHtml(model.rows[0]), /100–150 W/);
});

test("diagnostics expose persisted machine, app, schema, and assessment identity without inventing missing values", () => {
  const characterization = record();
  const frozenEvaluation = evaluation({
    schemaVersion: 1,
    fitnessEvidenceSnapshot: {
      fitnessStateSchemaVersion: 3,
      metricObservedAt: "2026-09-18T14:30:00.000Z",
      quality: "high",
      algorithm: { id: "bike-submax-linear-hr-workload", version: 1 },
      evidenceSessionIds: ["formal-session-a"],
      calibration: {
        workloadProvenance: "measured_watts",
        observedMinWatts: 100,
        observedMaxWatts: 150,
        protocol: { id: "bike-submax-70rpm", version: 1 },
        points: [{ heartRateBpm: 120 }, { heartRateBpm: 140 }],
      },
    },
  });
  const history = [historyRow(characterization, {
    app_version: "0.9.11",
    machine_id: "proform-smart-power-10",
    machine_profile_version: 1,
    resolved_prescription: { schemaVersion: 1 },
    shadow_prescription_evaluation: frozenEvaluation,
  })];
  const assessmentContexts = extractTrustedPersonalizationAssessmentContexts(history, "athlete-a");
  const workoutContexts = extractTrustedPersonalizationWorkoutContexts(history, "athlete-a");
  const model = buildPersonalizationDiagnosticsModel(
    [characterization], EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS, assessmentContexts, workoutContexts
  );
  assert.deepEqual(workoutContexts["session-a"], {
    appVersion: "0.9.11",
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    activePrescriptionSchemaVersion: 1,
    shadowSchemaVersion: 1,
    characterizationSchemaVersion: 1,
  });
  assert.deepEqual(assessmentContexts["session-a"].evidenceSessionIds, ["formal-session-a"]);
  assert.match(personalizationDiagnosticDetailHtml(model.rows[0]), /bike-submax-linear-hr-workload@1/);
  assert.equal(createPersonalizationDiagnosticsExport(model).diagnosticRows[0].workoutContext.appVersion, "0.9.11");

  const historical = extractTrustedPersonalizationWorkoutContexts([historyRow(characterization)], "athlete-a");
  assert.equal(historical["session-a"].appVersion, null);
  assert.equal(historical["session-a"].machineId, null);
});

test("all-record evidence summary distinguishes readiness cohorts, intents, domains, exclusions, and determinate saturation", () => {
  const measured = record("measured", { workoutIntent: "aerobic_base" });
  const calibrated = record("calibrated", {
    workoutIntent: "aerobic_volume",
    calibrationWorkloadProvenance: "calibrated_at_verified_cadence",
    phases: [phase({
      observedPowerProvenance: "calibrated_watts",
      observedPower: { ...phase().observedPower, provenance: "calibrated_watts" },
      candidateDomainMargins: { ...phase().candidateDomainMargins, bucket: "interior" },
      controllerContext: {
        ...phase().controllerContext,
        anyBoundarySaturationSeconds: 10,
        saturationRatio: 10 / 180,
        upperBoundaryDecisionCount: 1,
      },
    })],
  });
  const excluded = record("excluded", {
    workoutIntent: "threshold",
    phases: [phase({
      shadowOutcome: "fallback",
      candidatePower: undefined,
      comparison: undefined,
      characterizationOutcome: "not_candidate",
      exclusionReason: "phase_evidence_unavailable",
    })],
  });
  const summary = summarizePersonalizationEvidenceCollection([measured, calibrated, excluded]);
  assert.deepEqual(summary, {
    completedWorkoutsWithE2: 3,
    candidatePhases: 2,
    evaluableCandidatePhases: 2,
    measuredToMeasuredObservations: 1,
    cadenceCalibratedObservations: 1,
    aerobicBaseCandidatePhases: 1,
    aerobicVolumeCandidatePhases: 1,
    interiorCandidatePhases: 1,
    edgeCandidatePhases: 1,
    saturatedCandidatePhases: 1,
    saturationDeterminateCandidatePhases: 2,
    saturationIncidence: 0.5,
    exclusionCounts: {
      phase_too_short: 0,
      missing_telemetry: 0,
      insufficient_hr_coverage: 0,
      insufficient_power_coverage: 0,
      insufficient_joint_coverage: 0,
      insufficient_settled_in_band_evidence: 0,
      unsupported_power_provenance: 0,
      phase_evidence_unavailable: 1,
    },
  });
  const html = personalizationDiagnosticsHtml(buildPersonalizationDiagnosticsModel([measured, calibrated, excluded]));
  assert.match(html, /All persisted E2 evidence/);
  assert.match(html, /Measured → measured observations/);
  assert.match(html, /Aerobic-volume candidate phases/);
  assert.match(html, /Saturated \/ saturation-determinate candidates/);
});

test("diagnostics preserve measured and cadence-calibrated cohorts rather than pooling them", () => {
  const calibrated = record("session-b", {
    calibrationWorkloadProvenance: "calibrated_at_verified_cadence",
    phases: [phase({ observedPowerProvenance: "calibrated_watts", observedPower: {
      ...phase().observedPower, provenance: "calibrated_watts",
    } })],
  });
  const model = buildPersonalizationDiagnosticsModel([record(), calibrated]);
  assert.equal(model.aggregate.workoutCount, 2);
  assert.equal(model.aggregate.groups.length, 2);
  assert.deepEqual(new Set(model.aggregate.groups.map((group) => group.calibrationWorkloadProvenance)),
    new Set(["measured_watts", "calibrated_at_verified_cadence"]));
  assert.deepEqual(new Set(model.aggregate.groups.map((group) => group.observedPowerProvenance)),
    new Set(["measured_watts", "calibrated_watts"]));
});

test("all six cohort filters affect only visible phases and visible aggregates", () => {
  const alternate = record("session-b", {
    workoutIntent: "Threshold", formalAssessmentQuality: "moderate",
    calibrationWorkloadProvenance: "calibrated_at_verified_cadence",
    phases: [phase({
      intensityId: "threshold", observedPowerProvenance: "calibrated_watts",
      candidateDomainMargins: { ...phase().candidateDomainMargins, bucket: "interior" },
    })],
  });
  const records = [record(), alternate];
  const before = structuredClone(records);
  const filters = [
    ["workoutIntent", "Threshold"], ["intensity", "threshold"],
    ["calibrationProvenance", "calibrated_at_verified_cadence"],
    ["observedPowerProvenance", "calibrated_watts"], ["assessmentQuality", "moderate"],
    ["domainBucket", "interior"],
  ];
  for (const [key, value] of filters) {
    const model = buildPersonalizationDiagnosticsModel(records, {
      ...EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS, [key]: value,
    });
    assert.equal(model.aggregate.workoutCount, 1, `${key} filter`);
    assert.equal(model.rows.length, 1, `${key} rows`);
    assert.equal(model.rows[0].record.workoutSessionId, "session-b", `${key} record`);
    assert.equal(model.evidenceCollectionSummary.completedWorkoutsWithE2, 2, `${key} all-evidence count`);
  }
  assert.deepEqual(records, before);
  const unfiltered = buildPersonalizationDiagnosticsModel(records);
  assert.equal(createPersonalizationDiagnosticsExport(unfiltered).characterizationRecords.length, 2);
});

test("insufficient evidence remains visible with its exclusion count and no invented comparison", () => {
  const excludedPhase = phase({
    evidenceCoverage: { ...phase().evidenceCoverage, powerCoveredSeconds: 72, jointCoveredSeconds: 72, powerCoverageRatio: 0.4, jointCoverageRatio: 0.4 },
    stableInBandWorkload: undefined, comparison: undefined,
    characterizationOutcome: "insufficient_evidence", exclusionReason: "insufficient_power_coverage",
  });
  const model = buildPersonalizationDiagnosticsModel([record("excluded", { phases: [excludedPhase] })]);
  assert.equal(model.aggregate.candidatePhases, 1);
  assert.equal(model.aggregate.evaluableCandidatePhases, 0);
  assert.equal(model.exclusionCounts.insufficient_power_coverage, 1);
  assert.equal(model.rows[0].deltaWatts, null);
  assert.match(personalizationDiagnosticsHtml(model), /Insufficient power coverage/);
});

test("presentation makes candidate non-control semantics, domain, saturation, and descriptive HR change explicit", () => {
  const model = buildPersonalizationDiagnosticsModel([record()]);
  const html = personalizationDiagnosticsHtml(model);
  const detail = personalizationDiagnosticDetailHtml(model.rows[0]);
  assert.match(html, /Candidate watts/);
  assert.match(html, /Observed in-band/);
  assert.match(html, /Active prescription is the legacy heart-rate band/);
  assert.match(html, /Bike work \+ threshold is the primary validated scope/);
  assert.match(html, /Threshold transfer series/);
  assert.match(html, /does not use inside-candidate rate as a success score/);
  assert.match(html, /No comparable bike threshold work sessions yet/);
  assert.match(detail, /Assessment domain/);
  assert.match(detail, /Edge/);
  assert.match(detail, /Late vs early HR/);
  assert.match(detail, /\+7 bpm/);
  assert.match(detail, /Controller saturation/);
  assert.doesNotMatch(`${html}${detail}`, /cardiovascular drift|fatigue|dehydration|ready to activate|personalization validated/i);
});

test("detail HTML distinguishes active legacy HR from shadow athlete-relative workload", () => {
  const characterization = record("threshold-session", {
    workoutIntent: "threshold",
    phases: [phase({
      intensityId: "threshold",
      detailName: "Threshold",
      legacyHeartRate: { min: 155, max: 162 },
      candidatePower: { minWatts: 104, maxWatts: 113 },
    })],
  });
  const model = buildPersonalizationDiagnosticsModel([characterization]);
  const detail = personalizationDiagnosticDetailHtml(model.rows[0]);
  assert.match(detail, /<h5>Active prescription<\/h5>/);
  assert.match(detail, /Heart rate<\/dt><dd>155–162 bpm/);
  assert.match(detail, /legacy-hr-target-resolver@1/);
  assert.match(detail, /Live authority<\/dt><dd>yes/);
  assert.match(detail, /<h5>Shadow athlete-relative prescription<\/h5>/);
  assert.match(detail, /Workload<\/dt><dd>104–113 W/);
  assert.match(detail, /formal VO₂ calibration/);
  assert.match(detail, /Mode<\/dt><dd>shadow/);
  assert.match(detail, /Live authority<\/dt><dd>no/);
  assert.match(detail, /<h5>Observed response<\/h5>/);
});

test("shadow workload falls back to the explicit E1 reason when candidate watts are absent", () => {
  const characterization = record("fallback-session", {
    workoutIntent: "threshold",
    phases: [phase({
      intensityId: "threshold",
      shadowOutcome: "fallback",
      candidatePower: undefined,
      comparison: undefined,
      fallbackReason: "outside_observed_hr_range",
      characterizationOutcome: "not_candidate",
      exclusionReason: "phase_evidence_unavailable",
    })],
  });
  const detail = personalizationDiagnosticDetailHtml(buildPersonalizationDiagnosticsModel([characterization]).rows[0]);
  assert.match(detail, /<h5>Active prescription<\/h5>/);
  assert.match(detail, /Live authority<\/dt><dd>yes/);
  assert.match(detail, /Workload<\/dt><dd>Outside Observed Hr Range/);
  assert.match(detail, /Live authority<\/dt><dd>no/);
  assert.doesNotMatch(detail, /Workload<\/dt><dd>\d+–\d+ W/);
});

test("performed-load observations join durable WorkoutResponse fields without inventing missing values", () => {
  const characterization = record();
  const history = [historyRow(characterization, {
    workout_response: {
      sessionId: "session-a",
      evidence: { bike: { freshRowCoverageRatio: 0.92, wattsProvenance: "measured_watts" } },
      phases: [{
        phaseInstanceId: "work-1",
        phaseId: "sustain",
        kind: "work",
        intensityId: "aerobic_base",
        activeStartSec: 0,
        activeEndSec: 180,
        plannedDurationSec: 180,
        completedDurationSec: 180,
        watts: {
          sampleCount: 180, coverageRatio: 0.92, mean: 124, median: 124,
          min: 100, max: 140, end: 125, provenance: "measured_watts",
        },
        cadenceRpm: {
          sampleCount: 180, coverageRatio: 0.9, mean: 70, median: 70,
          min: 68, max: 72, end: 70,
        },
        observedResistance: {
          sampleCount: 180, coverageRatio: 0.91, mean: 8, median: 8,
          min: 7, max: 9, end: 8,
        },
      }],
    },
  })];
  const performedLoad = extractTrustedPersonalizationPerformedLoadContexts(history, "athlete-a");
  assert.equal(performedLoad["session-a"][0].wattsMedian, 124);
  assert.equal(performedLoad["session-a"][0].observedResistanceMode, undefined);
  const model = buildPersonalizationDiagnosticsModel(
    [characterization],
    EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS,
    {},
    {},
    performedLoad
  );
  const detail = personalizationDiagnosticDetailHtml(model.rows[0]);
  assert.match(detail, /Observed watts \(response\)<\/dt><dd>124 W/);
  assert.match(detail, /Observed resistance \(response\)<\/dt><dd>8/);
  assert.match(detail, /Cadence \(response\)<\/dt><dd>70 rpm/);
  assert.match(detail, /Bike-row coverage \(response\)<\/dt><dd>91%/);
  assert.equal("performedLoadPhase" in createPersonalizationDiagnosticsExport(model).diagnosticRows[0], false);

  const withoutResponse = extractTrustedPersonalizationPerformedLoadContexts([historyRow(characterization)], "athlete-a");
  assert.deepEqual(withoutResponse, {});
  const unavailable = personalizationDiagnosticDetailHtml(buildPersonalizationDiagnosticsModel([characterization]).rows[0]);
  assert.match(unavailable, /Observed watts \(response\)<\/dt><dd>unavailable/);
});

test("empty history renders an explanatory no-data state and clean zero aggregate", () => {
  const model = buildPersonalizationDiagnosticsModel([]);
  assert.equal(model.aggregate.workoutCount, 0);
  assert.equal(model.rows.length, 0);
  assert.equal(model.thresholdLongitudinal.sessionCount, 0);
  assert.equal(model.thresholdLongitudinal.cohorts.length, 0);
  assert.equal(model.thresholdLongitudinal.exclusions.length, 0);
  assert.deepEqual(model.scientificAssessments, []);
  assert.match(personalizationDiagnosticsHtml(model), /No personalization characterization data yet/);
});

test("diagnostic export is deterministic, provenance-preserving, and excludes profile and raw telemetry", () => {
  const model = buildPersonalizationDiagnosticsModel([record()]);
  const before = structuredClone(model.records);
  const first = personalizationDiagnosticsExportJson(model);
  assert.equal(first, personalizationDiagnosticsExportJson(model));
  assert.deepEqual(model.records, before);
  const exported = createPersonalizationDiagnosticsExport(model);
  assert.equal(exported.schemaVersion, 3);
  assert.equal(exported.aggregate.schemaVersion, 2);
  assert.deepEqual(Object.keys(exported), [
    "schemaVersion", "filters", "aggregate", "diagnosticRows", "characterizationRecords",
  ]);
  assert.equal("thresholdLongitudinal" in exported, false);
  assert.equal(exported.characterizationRecords[0].calibrationWorkloadProvenance, "measured_watts");
  assert.equal(exported.characterizationRecords[0].phases[0].candidatePower.minWatts, 110);
  assert.equal(exported.characterizationRecords[0].phases[0].evidenceCoverage.jointCoverageRatio, 1);
  assert.equal(exported.characterizationRecords[0].phases[0].stableInBandWorkload.medianWatts, 125);
  assert.equal(exported.characterizationRecords[0].phases[0].comparison.absoluteDifferenceWatts, 0);
  assert.equal(exported.characterizationRecords[0].phases[0].candidateDomainMargins.bucket, "edge");
  assert.equal(exported.characterizationRecords[0].phases[0].controllerContext.saturationRatio, 0);
  assert.equal(first.includes("hr_trace"), false);
  assert.equal(first.includes("demographics"), false);
  assert.equal(first.includes("FitnessState"), false);
});

test("E3 presentation has no import path into prescription, machine control, fitness, passive refinement, or SISU", async () => {
  const diagnosticsSource = await readFile(new URL("../src/personalizationDiagnosticsView.ts", import.meta.url), "utf8");
  const statusSource = await readFile(new URL("../src/personalizationStatus.ts", import.meta.url), "utf8");
  const uiSource = await readFile(new URL("../src/uiControls.ts", import.meta.url), "utf8");
  assert.doesNotMatch(diagnosticsSource, /from ["']\.\/(?:workoutPrescription|bikeBridge|fitnessState|fitnessRefinement|sisuSync)|indexedDB|parsePersonalizedPrescription/);
  assert.match(diagnosticsSource, /from ["']\.\/performedLoad\.js["']/);
  assert.doesNotMatch(diagnosticsSource, /evaluatePersonalizedPrescription|candidatePower\s*=/);
  assert.doesNotMatch(statusSource, /personalizedPrescription|workoutPrescription|bikeBridge|fitnessRefinement|sisuSync/);
  assert.match(uiSource, /getAllWorkoutSummaries\(\)[\s\S]*extractTrustedPersonalizationCharacterizations/);
  assert.match(uiSource, /exportPersonalizationDiagnostics\(\)[\s\S]*EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS/);
  assert.doesNotMatch(uiSource, /parsePersonalizedPrescriptionCharacterization/);
});

test("UI markup identifies diagnostics as developer-only and keeps normal history wording restrained", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const uiSource = await readFile(new URL("../src/uiControls.ts", import.meta.url), "utf8");
  const statusSource = await readFile(new URL("../src/personalizationStatus.ts", import.meta.url), "utf8");
  assert.match(html, /Personalization diagnostics/);
  assert.match(html, /Candidate watts are experimental predictions[^<]+They did not control the workout/);
  assert.match(html, /Active prescription remains the legacy heart-rate band/);
  assert.match(html, /Observed in-band watts represent settled workload while heart rate was within the legacy target range/);
  assert.match(html, /it is not an authorization score/);
  assert.match(uiSource, /buildPersonalizationHistoryDetail/);
  assert.match(statusSource, /Personalization evaluation recorded/);
  assert.match(statusSource, /This workout contributed data toward validating individualized bike targets/);
  assert.match(statusSource, /No individualized workload target was available for this workout/);
  assert.doesNotMatch(uiSource, /Your personalized target was/);
});

function thresholdComparison(overrides = {}) {
  return {
    candidateMidpointWatts: 125, observedInBandMedianWatts: 125,
    signedDifferenceWatts: 0, absoluteDifferenceWatts: 0, signedDifferencePercent: 0,
    candidateContainsObservedMedian: true, candidateObservedOverlapWatts: 10,
    candidateObservedOverlapRatio: 1, agreement: "inside_candidate",
    ...overrides,
  };
}

function thresholdRecord(id, overrides = {}) {
  const { phases, ...rest } = overrides;
  return record(id, {
    workoutIntent: "threshold",
    workoutSelector: "Thursday",
    phases: phases ?? [phase({ intensityId: "threshold", detailName: "Threshold" })],
    ...rest,
  });
}

function thresholdAssessmentContext(overrides = {}) {
  return {
    observedAt: "2026-09-18T14:30:00.000Z",
    quality: "high",
    calibrationProvenance: "measured_watts",
    observedMinHeartRateBpm: 150,
    observedMaxHeartRateBpm: 165,
    observedMinWatts: 90,
    observedMaxWatts: 180,
    algorithm: { id: "bike-submax-linear-hr-workload", version: 1 },
    protocol: { id: "bike-submax-70rpm", version: 1 },
    evidenceSessionIds: ["formal-a"],
    ...overrides,
  };
}

function thresholdWorkoutContext(overrides = {}) {
  return {
    appVersion: "0.10.13",
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    activePrescriptionSchemaVersion: 1,
    shadowSchemaVersion: 1,
    characterizationSchemaVersion: 2,
    ...overrides,
  };
}

test("threshold transfer series is session-level, grouped by calibration instance, and never pools provenance", () => {
  const sameInstance = ["formal-a"];
  const first = thresholdRecord("thu-1", {
    createdAt: "2026-09-25T14:30:00.000Z",
    phases: [phase({
      intensityId: "threshold",
      candidateDomainMargins: { ...phase().candidateDomainMargins, bucket: "interior" },
      comparison: thresholdComparison(),
    })],
  });
  const second = thresholdRecord("thu-2", {
    createdAt: "2026-10-02T14:30:00.000Z",
    phases: [phase({
      intensityId: "threshold",
      candidateDomainMargins: { ...phase().candidateDomainMargins, bucket: "interior" },
      comparison: thresholdComparison({
        observedInBandMedianWatts: 131, signedDifferenceWatts: 6, absoluteDifferenceWatts: 6,
        signedDifferencePercent: 6 / 125,
      }),
      controllerContext: { ...phase().controllerContext, saturationRatio: 0.2, anyBoundarySaturationSeconds: 36 },
    })],
  });
  const calibrated = thresholdRecord("thu-calibrated", {
    createdAt: "2026-10-02T14:30:00.000Z",
    calibrationWorkloadProvenance: "calibrated_at_verified_cadence",
    phases: [phase({
      intensityId: "threshold",
      observedPowerProvenance: "calibrated_watts",
      observedPower: { ...phase().observedPower, provenance: "calibrated_watts" },
      comparison: thresholdComparison({
        observedInBandMedianWatts: 140, signedDifferenceWatts: 15, absoluteDifferenceWatts: 15,
        signedDifferencePercent: 15 / 125, candidateContainsObservedMedian: true, agreement: "inside_candidate",
      }),
    })],
  });
  const otherCalibration = thresholdRecord("thu-other", {
    createdAt: "2026-10-09T14:30:00.000Z",
    phases: [phase({
      intensityId: "threshold",
      comparison: thresholdComparison({
        observedInBandMedianWatts: 118, signedDifferenceWatts: -7, absoluteDifferenceWatts: 7,
        signedDifferencePercent: -7 / 125,
      }),
    })],
  });
  const aerobic = record("monday");
  const analysis = buildThresholdLongitudinalAnalysis(
    [otherCalibration, second, aerobic, calibrated, first],
    {
      "thu-1": thresholdAssessmentContext({ evidenceSessionIds: sameInstance }),
      "thu-2": thresholdAssessmentContext({ evidenceSessionIds: sameInstance }),
      "thu-calibrated": thresholdAssessmentContext({
        evidenceSessionIds: sameInstance,
        calibrationProvenance: "calibrated_at_verified_cadence",
      }),
      "thu-other": thresholdAssessmentContext({ evidenceSessionIds: ["formal-b"] }),
    },
    {
      "thu-1": thresholdWorkoutContext(),
      "thu-2": thresholdWorkoutContext(),
      "thu-calibrated": thresholdWorkoutContext(),
      "thu-other": thresholdWorkoutContext(),
    }
  );
  assert.equal(analysis.sessionCount, 4);
  assert.equal(analysis.cohorts.length, 3);
  const measuredSame = analysis.cohorts.find((cohort) =>
    cohort.key.calibration.evidenceSessionIds[0] === "formal-a" &&
    cohort.key.observedPowerProvenance === "measured_watts" &&
    cohort.key.calibration.workloadProvenance === "measured_watts");
  const calibratedSame = analysis.cohorts.find((cohort) =>
    cohort.key.calibration.evidenceSessionIds[0] === "formal-a" &&
    cohort.key.observedPowerProvenance === "calibrated_watts");
  const other = analysis.cohorts.find((cohort) => cohort.key.calibration.evidenceSessionIds[0] === "formal-b");
  assert.equal(measuredSame.sessionCount, 2);
  assert.equal(calibratedSame.sessionCount, 1);
  assert.equal(other.sessionCount, 1);
  assert.equal(measuredSame.medianSignedDifferenceWatts, 3);
  assert.equal(measuredSame.medianAbsoluteDifferenceWatts, 3);
  assert.equal(measuredSame.medianCandidateWidthWatts, 30);
  assert.equal(measuredSame.medianWidthNormalizedAbsoluteError, 0.1);
  assert.equal(measuredSame.saturationIncidence, 0.5);
  assert.equal(measuredSame.medianAssessmentAgeDays, 10.5);
  assert.equal(measuredSame.observedSettledWattsCv, 3 / 128);
  assert.deepEqual(measuredSame.sessions.map((session) => session.workoutSessionId), ["thu-1", "thu-2"]);
  assert.equal(measuredSame.sessions[0].assessmentAgeDays, 7);
  assert.equal(measuredSame.sessions[1].assessmentAgeDays, 14);
  assert.equal(measuredSame.sessions[0].machineId, "proform-smart-power-10");
  assert.equal(measuredSame.sessions[0].domainBucket, "interior");
  assert.equal(measuredSame.sessions[1].widthNormalizedAbsoluteError, 6 / 30);
  assert.equal(calibratedSame.key.calibration.workloadProvenance, "calibrated_at_verified_cadence");
  assert.equal(analysis.exclusions.length, 0);
});

test("threshold cohort identity includes evidence, estimator, protocol, and athlete with stable evidence ordering", () => {
  const sameA = thresholdRecord("same-a", { createdAt: "2026-09-22T14:30:00.000Z" });
  const sameB = thresholdRecord("same-b", { createdAt: "2026-09-23T14:30:00.000Z" });
  const evidence = thresholdRecord("different-evidence");
  const estimator = thresholdRecord("different-estimator");
  const protocol = thresholdRecord("different-protocol");
  const athlete = thresholdRecord("different-athlete", { athleteId: "athlete-b" });
  const records = [protocol, sameB, athlete, evidence, sameA, estimator];
  const contexts = {
    "same-a": thresholdAssessmentContext({ evidenceSessionIds: ["formal-b", "formal-a"] }),
    "same-b": thresholdAssessmentContext({ evidenceSessionIds: ["formal-a", "formal-b"] }),
    "different-evidence": thresholdAssessmentContext({ evidenceSessionIds: ["formal-c"] }),
    "different-estimator": thresholdAssessmentContext({
      evidenceSessionIds: ["formal-a", "formal-b"],
      algorithm: { id: "bike-submax-linear-hr-workload", version: 2 },
    }),
    "different-protocol": thresholdAssessmentContext({
      evidenceSessionIds: ["formal-a", "formal-b"],
      protocol: { id: "bike-submax-70rpm", version: 2 },
    }),
    "different-athlete": thresholdAssessmentContext({ evidenceSessionIds: ["formal-a", "formal-b"] }),
  };
  const workouts = Object.fromEntries(records.map((value) => [value.workoutSessionId, thresholdWorkoutContext()]));
  const analysis = buildThresholdLongitudinalAnalysis(records, contexts, workouts);
  assert.equal(analysis.sessionCount, 6);
  assert.equal(analysis.cohorts.length, 5);
  const shared = analysis.cohorts.find((cohort) => cohort.sessionCount === 2);
  assert.deepEqual(shared.key.calibration.evidenceSessionIds, ["formal-a", "formal-b"]);
  assert.deepEqual(shared.sessions.map((session) => session.workoutSessionId), ["same-a", "same-b"]);
  assert.equal(analysis.cohorts.some((cohort) => cohort.key.calibration.estimator.version === 2), true);
  assert.equal(analysis.cohorts.some((cohort) => cohort.key.calibration.protocol.version === 2), true);
  assert.equal(analysis.cohorts.some((cohort) => cohort.key.athleteId === "athlete-b"), true);
});

test("incomplete calibration identities fail closed instead of pooling under an unavailable key", () => {
  const missingEvidence = thresholdRecord("missing-evidence");
  const missingEstimator = thresholdRecord("missing-estimator");
  const analysis = buildThresholdLongitudinalAnalysis(
    [missingEstimator, missingEvidence],
    {
      "missing-evidence": thresholdAssessmentContext({ evidenceSessionIds: [] }),
      "missing-estimator": thresholdAssessmentContext({ algorithm: undefined }),
    },
    {
      "missing-evidence": thresholdWorkoutContext(),
      "missing-estimator": thresholdWorkoutContext(),
    }
  );
  assert.equal(analysis.sessionCount, 0);
  assert.equal(analysis.cohorts.length, 0);
  assert.deepEqual(analysis.exclusions.map((value) => value.reason), [
    "incomplete_calibration_identity", "incomplete_calibration_identity",
  ]);
  assert.equal(JSON.stringify(analysis).includes("unavailable"), false);
});

test("machine, machine profile, and both power-provenance dimensions define separate cohorts", () => {
  const base = thresholdRecord("base");
  const otherMachine = thresholdRecord("other-machine");
  const otherProfile = thresholdRecord("other-profile");
  const observedCalibrated = thresholdRecord("observed-calibrated", {
    phases: [phase({
      intensityId: "threshold",
      observedPowerProvenance: "calibrated_watts",
      observedPower: { ...phase().observedPower, provenance: "calibrated_watts" },
    })],
  });
  const formalCalibrated = thresholdRecord("formal-calibrated", {
    calibrationWorkloadProvenance: "calibrated_at_verified_cadence",
  });
  const missingMachine = thresholdRecord("missing-machine");
  const missingProfile = thresholdRecord("missing-profile");
  const records = [missingProfile, observedCalibrated, otherMachine, base, formalCalibrated, missingMachine, otherProfile];
  const contexts = Object.fromEntries(records.map((value) => [value.workoutSessionId,
    thresholdAssessmentContext(value.workoutSessionId === "formal-calibrated"
      ? { calibrationProvenance: "calibrated_at_verified_cadence" } : {})]));
  const workouts = {
    base: thresholdWorkoutContext(),
    "other-machine": thresholdWorkoutContext({ machineId: "bike-b" }),
    "other-profile": thresholdWorkoutContext({ machineProfileVersion: 2 }),
    "observed-calibrated": thresholdWorkoutContext(),
    "formal-calibrated": thresholdWorkoutContext(),
    "missing-machine": thresholdWorkoutContext({ machineId: null }),
    "missing-profile": thresholdWorkoutContext({ machineProfileVersion: null }),
  };
  const analysis = buildThresholdLongitudinalAnalysis(records, contexts, workouts);
  assert.equal(analysis.sessionCount, 5);
  assert.equal(analysis.cohorts.length, 5);
  assert.equal(analysis.cohorts.some((cohort) => cohort.key.machineId === "bike-b"), true);
  assert.equal(analysis.cohorts.some((cohort) => cohort.key.machineProfileVersion === 2), true);
  assert.equal(analysis.cohorts.some((cohort) =>
    cohort.key.observedPowerProvenance === "calibrated_watts"), true);
  assert.equal(analysis.cohorts.some((cohort) =>
    cohort.key.calibration.workloadProvenance === "calibrated_at_verified_cadence"), true);
  assert.deepEqual(analysis.exclusions.map((value) => [value.workoutSessionId, value.reason]), [
    ["missing-machine", "missing_machine_identity"],
    ["missing-profile", "missing_machine_profile_identity"],
  ]);
});

test("threshold cohorts and sessions are deterministic for scrambled inputs", () => {
  const laterB = thresholdRecord("b-later", { createdAt: "2026-09-24T14:30:00.000Z" });
  const earlierB = thresholdRecord("b-earlier", { createdAt: "2026-09-21T14:30:00.000Z" });
  const onlyA = thresholdRecord("a-only", { createdAt: "2026-09-25T14:30:00.000Z" });
  const records = [laterB, onlyA, earlierB];
  const contexts = {
    "b-later": thresholdAssessmentContext({ evidenceSessionIds: ["formal-b"] }),
    "b-earlier": thresholdAssessmentContext({ evidenceSessionIds: ["formal-b"] }),
    "a-only": thresholdAssessmentContext({ evidenceSessionIds: ["formal-a"] }),
  };
  const workouts = Object.fromEntries(records.map((value) => [value.workoutSessionId, thresholdWorkoutContext()]));
  const analysis = buildThresholdLongitudinalAnalysis(records, contexts, workouts);
  assert.deepEqual(analysis.cohorts.map((cohort) => cohort.key.calibration.evidenceSessionIds[0]),
    ["formal-a", "formal-b"]);
  assert.deepEqual(analysis.cohorts[1].sessions.map((session) => session.workoutSessionId),
    ["b-earlier", "b-later"]);
  assert.deepEqual(analysis, buildThresholdLongitudinalAnalysis([...records].reverse(), contexts, workouts));
});

test("threshold metric edge cases remain descriptive and fail safely", () => {
  const zeroWidth = thresholdRecord("zero-width", {
    phases: [phase({
      intensityId: "threshold",
      candidatePower: { minWatts: 125, maxWatts: 125 },
      comparison: thresholdComparison(),
    })],
  });
  const positiveWidth = thresholdRecord("positive-width", {
    createdAt: "2026-09-21T12:30:00.000Z",
    phases: [phase({
      intensityId: "threshold",
      candidatePower: { minWatts: 120, maxWatts: 140 },
      comparison: thresholdComparison({
        candidateMidpointWatts: 130,
        observedInBandMedianWatts: 135,
        signedDifferenceWatts: 5,
        absoluteDifferenceWatts: 5,
        signedDifferencePercent: 5 / 130,
      }),
      controllerContext: { ...phase().controllerContext, saturationRatio: 0.2 },
    })],
  });
  const futureAssessment = thresholdRecord("future-assessment");
  const nonFinite = thresholdRecord("non-finite", {
    phases: [phase({
      intensityId: "threshold",
      comparison: thresholdComparison({ observedInBandMedianWatts: Number.NaN }),
    })],
  });
  const reversed = thresholdRecord("reversed", {
    phases: [phase({
      intensityId: "threshold",
      candidatePower: { minWatts: 140, maxWatts: 120 },
    })],
  });
  const records = [positiveWidth, futureAssessment, reversed, zeroWidth, nonFinite];
  const contexts = Object.fromEntries(records.map((value) => [value.workoutSessionId,
    thresholdAssessmentContext(value.workoutSessionId === "future-assessment"
      ? { observedAt: "2026-09-21T12:30:00.000Z" } : {})]));
  const workouts = Object.fromEntries(records.map((value) => [value.workoutSessionId,
    thresholdWorkoutContext(value.workoutSessionId === "future-assessment" ? { machineId: "bike-b" } : {})]));
  const analysis = buildThresholdLongitudinalAnalysis(records, contexts, workouts);
  assert.equal(analysis.sessionCount, 3);
  assert.equal(analysis.cohorts.length, 2);
  const paired = analysis.cohorts.find((cohort) => cohort.sessionCount === 2);
  assert.equal(paired.sessions[0].widthNormalizedAbsoluteError, null);
  assert.equal(paired.sessions[1].widthNormalizedAbsoluteError, 0.25);
  assert.equal(paired.medianWidthNormalizedAbsoluteError, 0.25);
  assert.equal(paired.observedSettledWattsCv, 5 / 130);
  assert.equal(paired.saturationIncidence, 0.5);
  const single = analysis.cohorts.find((cohort) => cohort.sessionCount === 1);
  assert.equal(single.observedSettledWattsCv, undefined);
  assert.equal(single.sessions[0].assessmentAgeDays, null);
  assert.deepEqual(analysis.exclusions.map((value) => value.reason),
    ["invalid_longitudinal_metrics", "invalid_longitudinal_metrics"]);
});

test("threshold transfer requires exactly one characterized threshold phase per workout", () => {
  const later = phase({
    phaseId: "later",
    intensityId: "threshold",
    activeStartSec: 600,
    comparison: thresholdComparison({
      observedInBandMedianWatts: 145, signedDifferenceWatts: 20, absoluteDifferenceWatts: 20,
      signedDifferencePercent: 20 / 125,
    }),
  });
  const earlier = phase({
    phaseId: "earlier",
    intensityId: "threshold",
    activeStartSec: 180,
    comparison: thresholdComparison({
      observedInBandMedianWatts: 127, signedDifferenceWatts: 2, absoluteDifferenceWatts: 2,
      signedDifferencePercent: 2 / 125,
    }),
  });
  const dual = thresholdRecord("dual", { phases: [later, earlier] });
  const zero = thresholdRecord("zero", {
    phases: [phase({
      intensityId: "threshold",
      characterizationOutcome: "insufficient_evidence",
      exclusionReason: "insufficient_settled_in_band_evidence",
      comparison: undefined,
      stableInBandWorkload: undefined,
    })],
  });
  const single = thresholdRecord("single");
  const analysis = buildThresholdLongitudinalAnalysis(
    [dual, zero, single],
    {
      dual: thresholdAssessmentContext(),
      zero: thresholdAssessmentContext(),
      single: thresholdAssessmentContext(),
    },
    {
      dual: thresholdWorkoutContext(),
      zero: thresholdWorkoutContext(),
      single: thresholdWorkoutContext(),
    }
  );
  assert.equal(analysis.sessionCount, 1);
  assert.equal(analysis.cohorts[0].sessions[0].workoutSessionId, "single");
  assert.deepEqual(analysis.exclusions, [{
    workoutSessionId: "dual",
    createdAt: dual.createdAt,
    reason: "multiple_threshold_phases",
  }]);
  assert.equal(dual.phases.length, 2);
  assert.equal(zero.phases.length, 1);
});

test("threshold transfer HTML reports error under HR control and does not score inside-candidate", () => {
  const characterization = thresholdRecord("thu-html", {
    phases: [phase({
      intensityId: "threshold",
      comparison: thresholdComparison({
        observedInBandMedianWatts: 131, signedDifferenceWatts: 6, absoluteDifferenceWatts: 6,
        signedDifferencePercent: 6 / 125, agreement: "inside_candidate",
      }),
    })],
  });
  const model = buildPersonalizationDiagnosticsModel(
    [characterization],
    EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS,
    { "thu-html": thresholdAssessmentContext() },
    { "thu-html": thresholdWorkoutContext() }
  );
  const html = personalizationDiagnosticsHtml(model);
  const start = html.indexOf("id=\"personalizationThresholdLongitudinal\"");
  const end = html.indexOf("class=\"personalization-filter-grid\"");
  const series = html.slice(start, end);
  assert.match(series, /Threshold transfer series/);
  assert.match(series, /transfer error under legacy heart-rate control/);
  assert.match(series, /does not use inside-candidate rate as a success score/);
  assert.match(series, /does not authorize control/);
  assert.match(series, /Median signed error/);
  assert.match(series, /Width-norm error/);
  assert.doesNotMatch(series, /Inside candidate|Observed median inside candidate/);
  assert.equal(model.thresholdLongitudinal.sessionCount, 1);
  assert.deepEqual(model.scientificAssessments, []);
  const exported = createPersonalizationDiagnosticsExport(model);
  assert.equal(exported.schemaVersion, 3);
  assert.equal("thresholdLongitudinal" in exported, false);
  assert.equal("scientificAssessments" in exported, false);
});

test("E3 longitudinal analysis and E2 v3 capture no actuation mode and never enable activation", async () => {
  const characterizationSource = await readFile(new URL("../src/personalizedPrescriptionCharacterization.ts", import.meta.url), "utf8");
  const typesSource = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");
  // E2 v3 is the explicit held-workload bump; actuation-mode capture remains out of scope.
  assert.match(characterizationSource, /Closed-loop settling timestamps only/);
  assert.doesNotMatch(characterizationSource, /actuationMode|automaticControlEnabled/);
  assert.doesNotMatch(typesSource, /actuationMode/);
  assert.match(typesSource, /activationEligible: false/);
  assert.doesNotMatch(typesSource, /activationEligible: true/);
});
