import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1,
  SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1,
  SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1,
  SCIENTIFIC_ASSESSMENT_POLICY_ID_V1,
  SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V1,
  SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1,
  SCIENTIFIC_ASSESSMENT_STATES,
  assessPersonalizedWorkloadEvidence,
  buildSubjectEvidence,
  discoverDiagnosticSubjects,
} from "../dist/personalizationScientificAssessment.js";
import {
  PHASE_E1_SHADOW_POLICY,
  evaluatePersonalizedPrescription,
} from "../dist/personalizedPrescription.js";
import { resolveWorkoutPrescription } from "../dist/workoutPrescription.js";
import {
  buildPersonalizationDiagnosticsModel,
  createPersonalizationDiagnosticsExport,
  personalizationDiagnosticsHtml,
} from "../dist/personalizationDiagnosticsView.js";

const EVALUATED_AT = "2026-10-06T12:00:00.000Z";
const KG_PER_LB = 0.45359237;

function calibration(overrides = {}) {
  return {
    evidenceSessionIds: ["formal-a"],
    estimatorId: "bike-submax-linear-hr-workload",
    estimatorVersion: 1,
    protocolId: "bike-submax-70rpm",
    protocolVersion: 1,
    observedAt: "2026-09-01T00:30:00.000Z",
    workloadProvenance: "measured_watts",
    ...overrides,
  };
}

function subject(overrides = {}) {
  return {
    athleteId: "athlete-a",
    activity: "bike",
    phaseKind: "work",
    intensityId: "threshold",
    modality: "legacy_hr_region_workload",
    phaseStructureClass: null,
    calibration: calibration(),
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    observedPowerProvenance: "measured_watts",
    legacyHrBand: { minBpm: 155, maxBpm: 162 },
    ...overrides,
  };
}

function session(id, createdAt, signed, overrides = {}) {
  // Derived comparison values follow the exact E2 invariants, so width
  // overrides stay semantically valid unless a test overrides them directly.
  const width = overrides.candidateWidthWatts ?? 30;
  return {
    workoutSessionId: id,
    createdAt,
    athleteId: "athlete-a",
    activity: "bike",
    phaseKind: "work",
    intensityId: "threshold",
    calibration: calibration(),
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    observedPowerProvenance: "measured_watts",
    legacyHrBand: { minBpm: 155, maxBpm: 162 },
    candidateWidthWatts: 30,
    candidateMidpointWatts: 125,
    observedSettledWatts: 125 + signed,
    signedDifferenceWatts: signed,
    absoluteDifferenceWatts: Math.abs(signed),
    widthNormalizedAbsoluteError: Math.abs(signed) / width,
    saturationRatio: 0,
    domainBucket: "interior",
    assessmentAgeDays: 10,
    openLoop: null,
    actuationMode: "unknown",
    ...overrides,
  };
}

/** Healthy current-shape evidence: adequate volume/spread/domain, tiny bias. */
function healthySessions() {
  return [
    session("thu-1", "2026-09-08T14:30:00.000Z", 1),
    session("thu-2", "2026-09-16T14:30:00.000Z", -1),
    session("thu-3", "2026-09-24T14:30:00.000Z", 2),
    session("thu-4", "2026-10-02T14:30:00.000Z", -2),
  ];
}

function evidence(sessions, overrides = {}) {
  return {
    athleteId: "athlete-a",
    candidateStatus: sessions.length > 0 ? "available" : "unavailable",
    sessions,
    currentCalibration: calibration(),
    excludedIncompleteIdentitySessions: 0,
    excludedMultiPhaseSessions: 0,
    ...overrides,
  };
}

function assess(sessions, overrides = {}, policy = E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1) {
  return assessPersonalizedWorkloadEvidence(
    evidence(sessions, overrides.evidence),
    subject(overrides.subject),
    policy,
    overrides.evaluatedAt ?? EVALUATED_AT
  );
}

function gateOf(assessment, id) {
  const gate = assessment.gates.find((entry) => entry.id === id);
  assert.ok(gate, `expected gate ${id}`);
  return gate;
}

test("E4A uses exactly the six-state scientific vocabulary", () => {
  assert.deepEqual([...SCIENTIFIC_ASSESSMENT_STATES], [
    "not_applicable",
    "collecting",
    "eligible",
    "contradicted",
    "stale",
    "superseded",
  ]);
});

test("same inputs, policy, and evaluatedAt produce identical output", () => {
  const first = assess(healthySessions());
  assert.equal(first.schemaVersion, SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1);
  assert.deepEqual(assess(healthySessions()), first);
  assert.equal(first.state, "collecting");
  assert.deepEqual(first.reasonCodes, ["open_loop_evidence_unavailable", "actuation_mode_unknown"]);
});

test("the pure E4A evaluator has no storage or clock dependency", () => {
  const priorStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("E4A touched storage"); },
  });
  try {
    assert.deepEqual(assess(healthySessions()), assess(healthySessions()));
  } finally {
    if (priorStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: priorStorage });
  }
  const source = readFileSync(new URL("../src/personalizationScientificAssessment.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Date\.now/);
  assert.doesNotMatch(source, /new Date\(/);
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /indexedDB/);
  assert.doesNotMatch(source, /globalThis/);
  assert.doesNotMatch(source, /^import /m);
});

test("E4A output always carries runtimeAuthority false with no true path", () => {
  for (const sessions of [[], healthySessions(), healthySessions().slice(0, 1)]) {
    const assessment = assess(sessions);
    assert.equal(assessment.mode, "scientific_assessment");
    assert.equal(assessment.runtimeAuthority, false);
  }
  const source = readFileSync(new URL("../src/personalizationScientificAssessment.ts", import.meta.url), "utf8");
  assert.match(source, /runtimeAuthority: false/);
  assert.doesNotMatch(source, /runtimeAuthority:\s*true/);
  assert.doesNotMatch(source, /activationEligible/);
  assert.doesNotMatch(source, /enablePersonalization/);
  assert.doesNotMatch(source, /approvedForControl/);
  assert.doesNotMatch(source, /activePersonalization/);
});

test("E4A has zero imports into control, E1, E2, fitness, or UI, and none import E4A", () => {
  const e4aSource = readFileSync(new URL("../src/personalizationScientificAssessment.ts", import.meta.url), "utf8");
  assert.doesNotMatch(e4aSource, /from ["']\.\//);
  assert.doesNotMatch(e4aSource, /personalizedPrescription/);
  assert.doesNotMatch(e4aSource, /workoutPrescription|workoutLogic|fitnessState|fitnessRefinement/);
  assert.doesNotMatch(e4aSource, /machines\/|bikeBridge|uiControls|sisuSync/);
  const runtimeFiles = [
    "../src/workoutPrescription.ts",
    "../src/workoutLogic.ts",
    "../src/machines/guidance.ts",
    "../src/machines/runtime.ts",
    "../src/machines/proformSmartPower10.ts",
    "../src/platform/bikeBridgeRuntime.ts",
    "../src/personalizedPrescription.ts",
    "../src/personalizedPrescriptionCharacterization.ts",
    "../src/fitnessState.ts",
    ...readdirSync(new URL("../src/machines/learning/", import.meta.url)).map(
      (file) => `../src/machines/learning/${file}`),
    ...readdirSync(new URL("../src/machines/dynamics/", import.meta.url)).map(
      (file) => `../src/machines/dynamics/${file}`),
  ];
  for (const file of runtimeFiles) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /personalizationScientificAssessment/, file);
  }
});

test("not_applicable covers incomplete identity, unsupported modality, and missing candidates", () => {
  const cases = [
    {
      name: "missing calibration identity",
      subject: { calibration: calibration({ evidenceSessionIds: [] }) },
      sessions: [],
      evidence: { candidateStatus: "unavailable" },
      reasons: ["identity_incomplete_calibration"],
    },
    {
      name: "missing machine identity",
      subject: { machineId: "" },
      sessions: [],
      evidence: { candidateStatus: "unavailable" },
      reasons: ["identity_incomplete_machine"],
    },
    {
      name: "unsupported modality",
      subject: { modality: "personal_threshold_workload" },
      sessions: [],
      evidence: { candidateStatus: "unavailable" },
      reasons: ["unsupported_modality"],
    },
    {
      name: "unsupported activity",
      subject: { activity: "elliptical" },
      sessions: [],
      evidence: { candidateStatus: "unavailable" },
      reasons: ["unsupported_modality"],
    },
    {
      name: "E1 fallback with no candidate",
      subject: {},
      sessions: [],
      evidence: { candidateStatus: "unavailable" },
      reasons: ["candidate_unavailable"],
    },
    {
      name: "candidate outside the calibration domain",
      subject: {},
      sessions: [],
      evidence: { candidateStatus: "outside_domain" },
      reasons: ["candidate_outside_domain"],
    },
  ];
  for (const { name, subject: subjectOverrides, sessions, evidence: evidenceOverrides, reasons } of cases) {
    const assessment = assess(sessions, { subject: subjectOverrides, evidence: evidenceOverrides });
    assert.equal(assessment.state, "not_applicable", name);
    assert.deepEqual(assessment.reasonCodes, reasons, name);
    assert.equal(assessment.runtimeAuthority, false, name);
  }
});

test("healthy current evidence collects with only the open-loop and actuation reasons", () => {
  const assessment = assess(healthySessions());
  assert.equal(assessment.state, "collecting");
  assert.deepEqual(assessment.reasonCodes, ["open_loop_evidence_unavailable", "actuation_mode_unknown"]);
  assert.equal(gateOf(assessment, "independent_session_volume").status, "pass");
  assert.equal(gateOf(assessment, "calendar_spread").status, "pass");
  assert.equal(gateOf(assessment, "domain_support").status, "pass");
  assert.equal(gateOf(assessment, "signed_bias").status, "pass");
  assert.equal(gateOf(assessment, "repeatability").status, "pass");
  assert.equal(gateOf(assessment, "controller_saturation").status, "pass");
  assert.equal(assessment.evidenceDigest.sessionCount, 4);
  assert.equal(assessment.evidenceDigest.distinctDateCount, 4);
  assert.equal(assessment.policy.id, "e4a-scientific-assessment-policy");
  assert.equal(assessment.policy.version, 1);
  assert.equal(assessment.assessor.id, "personalization-scientific-assessor");
  assert.equal(assessment.assessor.version, 1);
});

test("current production policy can never reach eligible on today-shaped evidence", () => {
  const perfect = [
    session("thu-1", "2026-09-08T14:30:00.000Z", 0),
    session("thu-2", "2026-09-16T14:30:00.000Z", 0),
    session("thu-3", "2026-09-24T14:30:00.000Z", 0),
    session("thu-4", "2026-10-02T14:30:00.000Z", 0),
  ];
  for (const sessions of [perfect, healthySessions(), healthySessions().slice(0, 2), []]) {
    const assessment = assess(sessions, sessions.length === 0
      ? { evidence: { candidateStatus: "unavailable" } }
      : {});
    assert.notEqual(assessment.state, "eligible");
  }
  const assessment = assess(perfect);
  assert.equal(assessment.state, "collecting");
  assert.deepEqual(assessment.reasonCodes, ["open_loop_evidence_unavailable", "actuation_mode_unknown"]);
});

test("no weak closed-loop metric can authorize itself, even when perfect", () => {
  const variants = {
    "zero median signed error": [0, 0, 0, 0],
    "zero absolute error": [0, 0, 0, 0],
    "tiny symmetric error": [1, -1, 1, -1],
    "narrow candidate width": [0, 0, 0, 0],
  };
  const dates = ["2026-09-08T14:30:00.000Z", "2026-09-16T14:30:00.000Z",
    "2026-09-24T14:30:00.000Z", "2026-10-02T14:30:00.000Z"];
  for (const [name, signed] of Object.entries(variants)) {
    const sessions = signed.map((value, index) =>
      session(`thu-${index + 1}`, dates[index], value, { candidateWidthWatts: 10 }));
    const assessment = assess(sessions);
    assert.equal(assessment.state, "collecting", name);
    assert.ok(assessment.reasonCodes.includes("open_loop_evidence_unavailable"), name);
    assert.ok(assessment.reasonCodes.includes("actuation_mode_unknown"), name);
  }
});

function futureCompleteSessions(signed) {
  const dates = ["2026-09-08T14:30:00.000Z", "2026-09-16T14:30:00.000Z",
    "2026-09-24T14:30:00.000Z", "2026-10-02T14:30:00.000Z"];
  return signed.map((value, index) => session(`thu-${index + 1}`, dates[index], value, {
    openLoop: { stableResistanceWindowCount: 2 },
    actuationMode: index % 2 === 0 ? "automatic" : "manual",
  }));
}

/**
 * Test-only future policy: the open-loop and actuation-mode dimensions are
 * gated on session evidence instead of being structurally unavailable. It
 * carries its own id so it can never be mistaken for the production policy.
 */
const SYNTHETIC_FUTURE_POLICY = {
  ...E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1,
  id: "e4a-synthetic-future-test-policy",
  openLoopEvidence: "required",
  actuationModeEvidence: "required",
};

test("the production policy object is frozen and pins both evidence gaps", () => {
  assert.ok(Object.isFrozen(E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1));
  assert.equal(E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1.openLoopEvidence, "required_but_unavailable");
  assert.equal(E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1.actuationModeEvidence, "required_but_unavailable");
  assert.equal(E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1.staleness, "not_configured");
});

test("the production policy cannot reach eligible even on synthetic future-complete evidence", () => {
  const assessment = assess(futureCompleteSessions([0, 0, 0, 0]));
  assert.equal(assessment.state, "collecting");
  assert.deepEqual(assessment.reasonCodes, ["open_loop_evidence_unavailable", "actuation_mode_unknown"]);
  assert.equal(gateOf(assessment, "open_loop_evidence").measured.policy, "required_but_unavailable");
  assert.equal(gateOf(assessment, "open_loop_evidence").measured.sessionsWithOpenLoop, 4);
});

test("synthetic future-complete evidence can reach eligible under a synthetic future policy", () => {
  const assessment = assess(futureCompleteSessions([1, -1, 2, -2]), {}, SYNTHETIC_FUTURE_POLICY);
  assert.equal(assessment.state, "eligible");
  assert.equal(assessment.policy.id, "e4a-synthetic-future-test-policy");
  assert.deepEqual(assessment.reasonCodes, []);
  assert.ok(assessment.gates.every((gate) => gate.status === "pass" || gate.id === "recency" || gate.id === "candidate_precision" || gate.id === "supersession"));
  assert.equal(gateOf(assessment, "open_loop_evidence").status, "pass");
  assert.equal(gateOf(assessment, "actuation_mode_evidence").status, "pass");
  assert.equal(assessment.runtimeAuthority, false);
});

test("adequate future-complete evidence with persistent bias reports contradicted", () => {
  const positive = assess(futureCompleteSessions([12, 13, 12, 13]), {}, SYNTHETIC_FUTURE_POLICY);
  assert.equal(positive.state, "contradicted");
  assert.deepEqual(positive.reasonCodes, ["persistent_signed_bias_positive"]);
  const negative = assess(futureCompleteSessions([-12, -13, -12, -13]), {}, SYNTHETIC_FUTURE_POLICY);
  assert.equal(negative.state, "contradicted");
  assert.deepEqual(negative.reasonCodes, ["persistent_signed_bias_negative"]);
});

test("adequate future-complete evidence with excess variability reports contradicted", () => {
  const assessment = assess(futureCompleteSessions([-25, 25, -25, 25]), {}, SYNTHETIC_FUTURE_POLICY);
  assert.equal(assessment.state, "contradicted");
  assert.deepEqual(assessment.reasonCodes, ["variance_exceeds_policy"]);
});

const ADEQUATE_DATES = ["2026-09-08T14:30:00.000Z", "2026-09-16T14:30:00.000Z",
  "2026-09-24T14:30:00.000Z", "2026-10-02T14:30:00.000Z"];

test("contradiction on adequate production evidence is not masked by the open-loop gap", () => {
  const biased = assess([12, 13, 12, 13].map((value, index) =>
    session(`thu-${index + 1}`, ADEQUATE_DATES[index], value)));
  assert.equal(biased.state, "contradicted");
  assert.deepEqual(biased.reasonCodes,
    ["persistent_signed_bias_positive", "open_loop_evidence_unavailable", "actuation_mode_unknown"]);
  const noisy = assess([-25, 25, -25, 25].map((value, index) =>
    session(`thu-${index + 1}`, ADEQUATE_DATES[index], value)));
  assert.equal(noisy.state, "contradicted");
  assert.ok(noisy.reasonCodes.includes("variance_exceeds_policy"));
});

test("bias on inadequate or uninformative evidence stays collecting", () => {
  const thin = assess([20, 20].map((value, index) =>
    session(`thu-${index + 1}`, ADEQUATE_DATES[index], value)), {}, SYNTHETIC_FUTURE_POLICY);
  assert.equal(thin.state, "collecting");
  assert.ok(thin.reasonCodes.includes("insufficient_independent_sessions"));
  const edge = assess(futureCompleteSessions([20, 20, 20, 20])
    .map((entry) => ({ ...entry, domainBucket: "edge" })), {}, SYNTHETIC_FUTURE_POLICY);
  assert.equal(edge.state, "collecting");
  assert.ok(edge.reasonCodes.includes("edge_domain_only"));
  const saturated = assess(futureCompleteSessions([20, 20, 20, 20])
    .map((entry) => ({ ...entry, saturationRatio: 0.4 })), {}, SYNTHETIC_FUTURE_POLICY);
  assert.equal(saturated.state, "collecting");
  assert.ok(saturated.reasonCodes.includes("controller_saturation_dominant"));
});

test("state precedence: not_applicable > superseded > stale > contradicted", () => {
  const biased = futureCompleteSessions([12, 13, 12, 13]);
  const newer = { currentCalibration: calibration({ evidenceSessionIds: ["formal-b"] }) };
  const superseded = assess(biased, { evidence: newer }, SYNTHETIC_FUTURE_POLICY);
  assert.equal(superseded.state, "superseded");
  const stalePolicy = { ...SYNTHETIC_FUTURE_POLICY, staleness: { maxDaysSinceNewestSession: 30 } };
  const stale = assess(biased, { evaluatedAt: "2027-01-01T00:00:00.000Z" }, stalePolicy);
  assert.equal(stale.state, "stale");
  assert.ok(stale.reasonCodes.includes("evidence_stale"));
  const staleAndSuperseded = assess(biased,
    { evidence: newer, evaluatedAt: "2027-01-01T00:00:00.000Z" }, stalePolicy);
  assert.equal(staleAndSuperseded.state, "superseded");
  const unsupported = assess(biased, {
    subject: { modality: "personal_threshold_workload" },
    evidence: newer,
  }, SYNTHETIC_FUTURE_POLICY);
  assert.equal(unsupported.state, "not_applicable");
  assert.deepEqual(unsupported.reasonCodes, ["unsupported_modality"]);
});

test("eligible fails closed when currency or a configured recency cannot be established", () => {
  const healthy = futureCompleteSessions([1, -1, 2, -2]);
  const unknownCurrent = assess(healthy, { evidence: { currentCalibration: null } }, SYNTHETIC_FUTURE_POLICY);
  assert.equal(unknownCurrent.state, "collecting");
  assert.equal(gateOf(unknownCurrent, "supersession").status, "unavailable");
  const badClock = assess(healthy, { evaluatedAt: "not-a-timestamp" },
    { ...SYNTHETIC_FUTURE_POLICY, staleness: { maxDaysSinceNewestSession: 30 } });
  assert.equal(badClock.state, "collecting");
  assert.equal(gateOf(badClock, "recency").status, "unavailable");
  const reorderedIds = assess(healthy.map((entry) => ({
    ...entry,
    calibration: calibration({ evidenceSessionIds: ["formal-a", "formal-z"] }),
  })), {
    subject: { calibration: calibration({ evidenceSessionIds: ["formal-a", "formal-z"] }) },
    evidence: { currentCalibration: calibration({ evidenceSessionIds: ["formal-z", "formal-a"] }) },
  }, SYNTHETIC_FUTURE_POLICY);
  assert.equal(gateOf(reorderedIds, "supersession").status, "pass");
  assert.equal(reorderedIds.state, "eligible");
});

test("unknown candidate status and malformed or duplicated sessions fail closed", () => {
  const unknownStatus = assess(healthySessions(), { evidence: { candidateStatus: "maybe" } });
  assert.equal(unknownStatus.state, "not_applicable");
  assert.deepEqual(unknownStatus.reasonCodes, ["candidate_unavailable"]);
  const malformed = assess([
    ...futureCompleteSessions([1, -1, 2, -2]),
    session("thu-nan", "2026-09-20T14:30:00.000Z", 0, { saturationRatio: Number.NaN }),
    session("thu-bad-date", "garbage", 0),
  ], {}, SYNTHETIC_FUTURE_POLICY);
  assert.equal(malformed.evidenceDigest.sessionCount, 4);
  assert.equal(malformed.evidenceDigest.ignoredInvalidSessions, 2);
  assert.equal(malformed.state, "eligible");
  const duplicated = assess([
    ...futureCompleteSessions([1, -1, 2, -2]),
    { ...futureCompleteSessions([1])[0], createdAt: "2026-10-04T14:30:00.000Z" },
  ], {}, SYNTHETIC_FUTURE_POLICY);
  assert.equal(duplicated.evidenceDigest.sessionCount, 3);
  assert.equal(duplicated.evidenceDigest.ignoredInvalidSessions, 2);
  assert.equal(duplicated.state, "collecting");
  const malformedSubject = assessPersonalizedWorkloadEvidence(
    evidence(healthySessions()), subject({ calibration: null, legacyHrBand: null }),
    E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1, EVALUATED_AT);
  assert.equal(malformedSubject.state, "not_applicable");
  assert.equal(malformedSubject.evidenceDigest.sessionCount, 0);
});

test("stale requires an explicitly configured test policy, never production age alone", () => {
  // Sessions stay after the calibration they were prescribed from; age comes
  // from a later evaluation time instead.
  const old = healthySessions();
  const later = { evaluatedAt: "2026-12-15T00:00:00.000Z" };
  const stalePolicy = {
    ...E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1,
    staleness: { maxDaysSinceNewestSession: 30 },
  };
  const stale = assess(old, later, stalePolicy);
  assert.equal(stale.state, "stale");
  assert.deepEqual(stale.reasonCodes,
    ["open_loop_evidence_unavailable", "actuation_mode_unknown", "evidence_stale"]);
  const production = assess(old, later);
  assert.equal(production.state, "collecting");
  assert.ok(!production.reasonCodes.includes("evidence_stale"));
  assert.equal(gateOf(production, "recency").status, "unavailable");
});

test("a newer formal calibration supersedes the subject without transferring evidence", () => {
  const superseded = assess(healthySessions(), {
    evidence: { currentCalibration: calibration({ evidenceSessionIds: ["formal-b"] }) },
  });
  assert.equal(superseded.state, "superseded");
  assert.deepEqual(superseded.reasonCodes,
    ["open_loop_evidence_unavailable", "actuation_mode_unknown", "calibration_superseded"]);
  const unknown = assess(healthySessions(), { evidence: { currentCalibration: null } });
  assert.equal(unknown.state, "collecting");
  assert.equal(gateOf(unknown, "supersession").status, "unavailable");
});

test("scientific assessment never combines evidence across incompatible cohorts", () => {
  const base = session("thu-match", "2026-09-16T14:30:00.000Z", 1);
  const variants = [
    session("thu-athlete", "2026-09-16T14:30:00.000Z", 1, { athleteId: "athlete-b" }),
    session("thu-instance", "2026-09-16T14:30:00.000Z", 1,
      { calibration: calibration({ evidenceSessionIds: ["formal-b"] }) }),
    session("thu-estimator", "2026-09-16T14:30:00.000Z", 1,
      { calibration: calibration({ estimatorVersion: 2 }) }),
    session("thu-protocol", "2026-09-16T14:30:00.000Z", 1,
      { calibration: calibration({ protocolVersion: 2 }) }),
    session("thu-observed-at", "2026-09-16T14:30:00.000Z", 1,
      { calibration: calibration({ observedAt: "2026-09-02T00:30:00.000Z" }) }),
    session("thu-calib-prov", "2026-09-16T14:30:00.000Z", 1,
      { calibration: calibration({ workloadProvenance: "calibrated_at_verified_cadence" }) }),
    session("thu-observed-prov", "2026-09-16T14:30:00.000Z", 1,
      { observedPowerProvenance: "calibrated_watts" }),
    session("thu-machine", "2026-09-16T14:30:00.000Z", 1, { machineId: "other-bike" }),
    session("thu-profile", "2026-09-16T14:30:00.000Z", 1, { machineProfileVersion: 2 }),
    session("thu-band", "2026-09-16T14:30:00.000Z", 1,
      { legacyHrBand: { minBpm: 115, maxBpm: 130 } }),
  ];
  const assessment = assess([base, ...variants]);
  assert.equal(assessment.evidenceDigest.sessionCount, 1);
  assert.deepEqual(assessment.evidenceDigest.sessionIds, ["thu-match"]);
  assert.equal(assessment.evidenceDigest.ignoredCrossCohortSessions, variants.length);
});

test("reason codes and gate results are deterministic under scrambled input order", () => {
  const expected = assess(healthySessions());
  const reversed = assess([...healthySessions()].reverse());
  assert.deepEqual(reversed.reasonCodes, expected.reasonCodes);
  assert.deepEqual(reversed.gates, expected.gates);
  assert.deepEqual(reversed.evidenceDigest, expected.evidenceDigest);
  assert.deepEqual(reversed, expected);
  const rotated = healthySessions();
  rotated.push(rotated.shift());
  assert.deepEqual(assess(rotated), expected);
});

const E1_RESOLVED_AT = "2026-06-01T12:00:00.000Z";

function e1Profile() {
  return {
    schemaVersion: 1,
    athleteId: "athlete-e4a",
    demographics: { ageYears: 40, bodyMassLbs: 80 / KG_PER_LB, heightInches: 70, sex: "female" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Formal calibration whose eligible HR range (110-140 BPM) structurally
 * excludes the Thursday threshold band (155-162 BPM): the real domain
 * limitation from the architecture investigation, not an invented fixture.
 */
function e1NarrowFitness() {
  return {
    schemaVersion: 1,
    athleteId: "athlete-e4a",
    hrWorkloadCalibration: {
      value: {
        slopeBpmPerWatt: 0.3,
        interceptBpm: 80,
        rSquared: 1,
        observedMinWatts: 100,
        observedMaxWatts: 200,
        points: [
          { stageId: "stage-1", watts: 100, heartRateBpm: 110, workloadSource: "measured_watts" },
          { stageId: "stage-2", watts: 150, heartRateBpm: 125, workloadSource: "measured_watts" },
          { stageId: "stage-3", watts: 200, heartRateBpm: 140, workloadSource: "measured_watts" },
        ],
        protocol: { id: "bike-submax-70rpm", version: 1 },
        predictedHrMaxBpm: 180,
        predictedHrMaxSource: "demographic_estimate",
        profileInputSnapshot: { ageYears: 40, bodyMassKg: 80 },
      },
      source: "formal_assessment",
      quality: "high",
      observedAt: "2026-01-01T00:30:00.000Z",
      updatedAt: "2026-01-01T00:31:00.000Z",
      algorithm: { id: "bike-submax-linear-hr-workload", version: 1 },
      evidenceSessionIds: ["formal-e4a"],
    },
    updatedAt: "2026-01-01T00:31:00.000Z",
  };
}

function e1ThresholdInput() {
  return {
    legacyPrescription: resolveWorkoutPrescription({
      workoutSelector: "Thursday",
      blocks: { warm: 0, sustain: 60, cool: 0 },
      hrTargets: {
        main_set: "155–162",
        main_set_intensity_id: "threshold",
        main_set_kind: "work",
        intervals: null,
      },
      resolvedAt: E1_RESOLVED_AT,
    }),
    workoutIntent: "threshold",
    activity: "bike",
    athleteId: "athlete-e4a",
    profile: e1Profile(),
    fitnessState: e1NarrowFitness(),
    policy: PHASE_E1_SHADOW_POLICY,
    resolvedAt: E1_RESOLVED_AT,
  };
}

test("the assessor does not reinterpret a real E1 domain fallback as scientific success", () => {
  const evaluation = evaluatePersonalizedPrescription(e1ThresholdInput());
  assert.equal(evaluation.phases.length, 1);
  assert.equal(evaluation.phases[0].outcome, "fallback");
  assert.equal(evaluation.phases[0].fallbackReason, "outside_observed_hr_range");
  const snapshot = evaluation.fitnessEvidenceSnapshot;
  const record = {
    athleteId: evaluation.athleteId,
    activity: evaluation.activity,
    workoutSessionId: "thu-fallback",
    createdAt: "2026-10-01T12:00:00.000Z",
    calibrationWorkloadProvenance: snapshot.calibration.workloadProvenance,
    phases: [{
      kind: evaluation.phases[0].kind,
      intensityId: evaluation.phases[0].intensityId,
      characterizationOutcome: "insufficient_evidence",
      shadowOutcome: evaluation.phases[0].outcome,
      fallbackReason: evaluation.phases[0].fallbackReason,
      legacyHeartRate: { min: 155, max: 162 },
      observedPowerProvenance: "unavailable",
      controllerContext: { saturationRatio: 0 },
    }],
  };
  const contexts = {
    assessment: {
      "thu-fallback": {
        observedAt: snapshot.metricObservedAt,
        calibrationProvenance: snapshot.calibration.workloadProvenance,
        algorithm: { ...snapshot.algorithm },
        protocol: { ...snapshot.calibration.protocol },
        evidenceSessionIds: [...snapshot.evidenceSessionIds],
      },
    },
    workout: {
      "thu-fallback": { machineId: "proform-smart-power-10", machineProfileVersion: 1 },
    },
  };
  const target = subject({
    athleteId: "athlete-e4a",
    calibration: calibration({
      evidenceSessionIds: ["formal-e4a"],
      observedAt: snapshot.metricObservedAt,
    }),
  });
  const built = buildSubjectEvidence({
    subject: target,
    records: [record],
    assessmentContexts: contexts.assessment,
    workoutContexts: contexts.workout,
    currentCalibration: target.calibration,
  });
  assert.equal(built.sessions.length, 0);
  assert.equal(built.candidateStatus, "outside_domain");
  const assessment = assessPersonalizedWorkloadEvidence(
    built, target, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1, EVALUATED_AT);
  assert.equal(assessment.state, "not_applicable");
  assert.deepEqual(assessment.reasonCodes, ["candidate_outside_domain"]);
  assert.equal(assessment.runtimeAuthority, false);
});

function characterizedRecord({ sessionId, createdAt, athlete = "athlete-a", calibrationIds = ["formal-a"],
  machineId = "proform-smart-power-10", machineProfileVersion = 1, observedProvenance = "measured_watts",
  intensity = "threshold", band = [155, 162], signed = 0, domainBucket = "interior", saturation = 0,
  characterizedCount = 1 } = {}) {
  const midpoint = 125;
  const width = 30;
  const comparison = {
    candidateMidpointWatts: midpoint,
    observedInBandMedianWatts: midpoint + signed,
    signedDifferenceWatts: signed,
    absoluteDifferenceWatts: Math.abs(signed),
    signedDifferencePercent: signed / midpoint,
    candidateContainsObservedMedian: true,
    candidateObservedOverlapWatts: 10,
    candidateObservedOverlapRatio: 1,
    agreement: "inside_candidate",
  };
  const phases = Array.from({ length: characterizedCount }, (_, index) => ({
    phaseId: `sustain-${index}`,
    kind: "work",
    intensityId: intensity,
    shadowOutcome: "candidate",
    legacyHeartRate: { min: band[0], max: band[1] },
    candidatePower: { minWatts: 110, maxWatts: 140 },
    evidenceCoverage: {
      plannedDurationSec: 1200, observedDurationSec: 1200,
      hrCoveredSeconds: 1200, powerCoveredSeconds: 1200, jointCoveredSeconds: 1200,
      hrCoverageRatio: 1, powerCoverageRatio: 1, jointCoverageRatio: 1,
    },
    observedPowerProvenance: observedProvenance,
    controllerContext: {
      available: true,
      observed: { coveredSeconds: 1200, lowerBoundSeconds: 0, upperBoundSeconds: 0 },
      desired: { coveredSeconds: 1200, lowerBoundSeconds: 0, upperBoundSeconds: 0 },
      commanded: { coveredSeconds: 0, lowerBoundSeconds: 0, upperBoundSeconds: 0 },
      anyBoundarySaturationSeconds: 0,
      saturationRatio: saturation,
      lowerBoundaryDecisionCount: 0,
      upperBoundaryDecisionCount: 0,
    },
    candidateDomainMargins: {
      heartRateToLowerBoundaryBpm: 5, heartRateToUpperBoundaryBpm: 3,
      wattsToLowerBoundary: 20, wattsToUpperBoundary: 40, bucket: domainBucket,
    },
    comparison: { ...comparison },
    stableInBandWorkload: { sampleCount: 600, medianWatts: midpoint + signed,
      q1Watts: 120, q3Watts: 130, minWatts: 110, maxWatts: 140 },
    characterizationOutcome: "characterized",
  }));
  return {
    record: {
      schemaVersion: 2,
      characterizer: { id: "personalization-prescription-characterization", version: 2 },
      mode: "diagnostic",
      activationEligible: false,
      sourceShadow: {
        resolverId: "personalized-prescription-resolver", resolverVersion: 1,
        shadowSchemaVersion: 1, resolvedAt: "2026-10-01T11:00:00.000Z",
      },
      athleteId: athlete,
      workoutSessionId: sessionId,
      workoutSelector: intensity === "threshold" ? "Thursday" : "Tuesday",
      workoutIntent: intensity,
      activity: "bike",
      formalAssessmentQuality: "high",
      calibrationWorkloadProvenance: "measured_watts",
      formalAssessmentProvenance: {
        algorithm: { id: "bike-submax-linear-hr-workload", version: 1 },
        protocol: { id: "bike-submax-70rpm", version: 1 },
      },
      policy: {
        id: "e2-characterization-policy", version: 1, minObservedPhaseDurationSec: 60,
        minHrCoverageRatio: 0.8, minPowerCoverageRatio: 0.8, minJointCoverageRatio: 0.75,
        settlingSeconds: 30, minSettledInBandSeconds: 15, heartRateChangeWindowSeconds: 60,
        minHeartRateChangeWindowSamples: 30, domainEdgeFraction: 0.1,
      },
      phases,
      createdAt,
    },
    assessment: {
      observedAt: "2026-09-01T00:30:00.000Z",
      quality: "high",
      calibrationProvenance: "measured_watts",
      observedMinHeartRateBpm: 110,
      observedMaxHeartRateBpm: 165,
      observedMinWatts: 90,
      observedMaxWatts: 180,
      algorithm: { id: "bike-submax-linear-hr-workload", version: 1 },
      protocol: { id: "bike-submax-70rpm", version: 1 },
      evidenceSessionIds: calibrationIds,
    },
    workout: {
      appVersion: "0.10.13",
      machineId,
      machineProfileVersion,
      activePrescriptionSchemaVersion: 1,
      shadowSchemaVersion: 1,
      characterizationSchemaVersion: 2,
    },
  };
}

function builderInput(rows, { currentCalibration = "known" } = {}) {
  const target = subject();
  return {
    subject: target,
    records: rows.map((row) => row.record),
    assessmentContexts: Object.fromEntries(rows.map((row) => [row.record.workoutSessionId, row.assessment])),
    workoutContexts: Object.fromEntries(rows.map((row) => [row.record.workoutSessionId, row.workout])),
    currentCalibration: currentCalibration === "known" ? target.calibration : currentCalibration,
  };
}

test("the hardened builder isolates cohorts, fails closed, and never pools unknowns", () => {
  const rows = [
    characterizedRecord({ sessionId: "thu-1", createdAt: "2026-09-08T14:30:00.000Z", signed: 1 }),
    characterizedRecord({ sessionId: "thu-2", createdAt: "2026-09-16T14:30:00.000Z", signed: -1 }),
    characterizedRecord({ sessionId: "thu-other-machine", createdAt: "2026-09-24T14:30:00.000Z",
      signed: 50, machineId: "other-bike" }),
  ];
  const input = builderInput(rows);
  input.assessmentContexts["thu-2"] = {
    ...rows[1].assessment,
    evidenceSessionIds: [],
  };
  const built = buildSubjectEvidence(input);
  assert.equal(built.sessions.length, 1);
  assert.deepEqual(built.sessions.map((entry) => entry.workoutSessionId), ["thu-1"]);
  assert.equal(built.candidateStatus, "available");
  assert.equal(built.excludedIncompleteIdentitySessions, 1);
  assert.equal(built.excludedMultiPhaseSessions, 0);
  const assessment = assessPersonalizedWorkloadEvidence(
    built, input.subject, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1, EVALUATED_AT);
  assert.ok(!assessment.evidenceDigest.calibrationInstanceId.includes("unavailable"));
  assert.equal(assessment.evidenceDigest.excludedIncompleteIdentitySessions, 1);
});

test("an incomplete characterized sibling phase still triggers multi-phase exclusion", () => {
  const row = characterizedRecord({ sessionId: "dual-partial", createdAt: "2026-09-08T14:30:00.000Z",
    characterizedCount: 2 });
  delete row.record.phases[1].comparison;
  const built = buildSubjectEvidence(builderInput([row]));
  assert.equal(built.sessions.length, 0);
  assert.equal(built.excludedMultiPhaseSessions, 1);
});

test("fallback and exclusion counts from another calibration or machine never reach the subject", () => {
  const foreign = characterizedRecord({ sessionId: "thu-foreign", createdAt: "2026-09-08T14:30:00.000Z",
    calibrationIds: ["formal-b"], characterizedCount: 2 });
  const foreignFallback = characterizedRecord({ sessionId: "thu-foreign-fb",
    createdAt: "2026-09-09T14:30:00.000Z", machineId: "other-bike" });
  foreignFallback.record.phases = [{
    kind: "work", intensityId: "threshold", characterizationOutcome: "insufficient_evidence",
    shadowOutcome: "fallback", fallbackReason: "outside_observed_hr_range", legacyHeartRate: { min: 155, max: 162 },
    observedPowerProvenance: "unavailable", controllerContext: { saturationRatio: 0 },
  }];
  const built = buildSubjectEvidence(builderInput([foreign, foreignFallback]));
  assert.equal(built.sessions.length, 0);
  assert.equal(built.excludedMultiPhaseSessions, 0);
  assert.equal(built.candidateStatus, "unavailable");
});

test("discovery output order is independent of record order", () => {
  const rows = [
    characterizedRecord({ sessionId: "a", createdAt: "2026-09-08T14:30:00.000Z" }),
    characterizedRecord({ sessionId: "b", createdAt: "2026-09-09T14:30:00.000Z", machineProfileVersion: 2 }),
    characterizedRecord({ sessionId: "c", createdAt: "2026-09-10T14:30:00.000Z",
      observedProvenance: "calibrated_watts" }),
  ];
  const discover = (ordered) => discoverDiagnosticSubjects(
    ordered.map((row) => row.record),
    Object.fromEntries(ordered.map((row) => [row.record.workoutSessionId, row.assessment])),
    Object.fromEntries(ordered.map((row) => [row.record.workoutSessionId, row.workout])),
    "athlete-a");
  const forward = discover(rows);
  assert.equal(forward.length, 3);
  assert.deepEqual(discover([...rows].reverse()), forward);
  assert.deepEqual(discover([rows[1], rows[2], rows[0]]), forward);
});

test("multi-phase sessions are excluded rather than silently reduced", () => {
  const rows = [characterizedRecord({ sessionId: "dual", createdAt: "2026-09-08T14:30:00.000Z",
    characterizedCount: 2 })];
  const built = buildSubjectEvidence(builderInput(rows));
  assert.equal(built.sessions.length, 0);
  assert.equal(built.excludedMultiPhaseSessions, 1);
  // The frozen E1 candidate exists even though no session is usable evidence.
  assert.equal(built.candidateStatus, "available");
  const assessment = assessPersonalizedWorkloadEvidence(
    built, subject(), E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1, EVALUATED_AT);
  assert.equal(assessment.state, "collecting");
});

test("discovery separates machine cohorts without hard-coding Thursday", () => {
  const rows = [
    characterizedRecord({ sessionId: "thu-1", createdAt: "2026-09-08T14:30:00.000Z" }),
    characterizedRecord({ sessionId: "thu-2", createdAt: "2026-09-16T14:30:00.000Z", machineId: "other-bike" }),
    characterizedRecord({ sessionId: "tue-1", createdAt: "2026-09-10T14:30:00.000Z",
      intensity: "aerobic_base", band: [115, 130] }),
  ];
  const subjects = discoverDiagnosticSubjects(
    rows.map((row) => row.record),
    Object.fromEntries(rows.map((row) => [row.record.workoutSessionId, row.assessment])),
    Object.fromEntries(rows.map((row) => [row.record.workoutSessionId, row.workout])),
    "athlete-a");
  assert.equal(subjects.length, 3);
  assert.deepEqual(subjects.map((entry) => entry.intensityId).sort(),
    ["aerobic_base", "threshold", "threshold"]);
  assert.ok(subjects.every((entry) => entry.phaseStructureClass === null));
});

test("aerobic-base evidence assesses through the same generic gates", () => {
  const target = subject({ intensityId: "aerobic_base", legacyHrBand: { minBpm: 115, maxBpm: 130 } });
  const dates = ["2026-09-08T14:30:00.000Z", "2026-09-16T14:30:00.000Z",
    "2026-09-24T14:30:00.000Z", "2026-10-02T14:30:00.000Z"];
  const sessions = [1, -1, 2, -2].map((signed, index) => session(`base-${index + 1}`, dates[index], signed, {
    intensityId: "aerobic_base",
    legacyHrBand: { minBpm: 115, maxBpm: 130 },
  }));
  const assessment = assessPersonalizedWorkloadEvidence(
    evidence(sessions, {}), target, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1, EVALUATED_AT);
  assert.equal(assessment.state, "collecting");
  assert.deepEqual(assessment.reasonCodes, ["open_loop_evidence_unavailable", "actuation_mode_unknown"]);
});

function walkSourceFiles() {
  const sourceFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`);
      else if (entry.name.endsWith(".ts")) sourceFiles.push(`${dir}${entry.name}`);
    }
  };
  walk("../src/");
  return sourceFiles;
}

test("developer diagnostics is the only permitted E4A consumer", () => {
  const sourceFiles = walkSourceFiles();
  assert.ok(sourceFiles.length > 20);
  const consumers = sourceFiles.filter((file) => !file.endsWith("/personalizationScientificAssessment.ts") &&
    /personalizationScientificAssessment/.test(readFileSync(new URL(file, import.meta.url), "utf8")));
  assert.deepEqual(consumers, ["../src/personalizationDiagnosticsView.ts"]);
  const diagnostics = readFileSync(new URL("../src/personalizationDiagnosticsView.ts", import.meta.url), "utf8");
  assert.match(diagnostics, /from "\.\/personalizationScientificAssessment\.js"/);
  // One-way: E4A never imports diagnostics (or anything else).
  const e4a = readFileSync(new URL("../src/personalizationScientificAssessment.ts", import.meta.url), "utf8");
  assert.doesNotMatch(e4a, /personalizationDiagnosticsView/);
});

test("no runtime or control module consumes E4A, directly or through diagnostics", () => {
  const sourceFiles = walkSourceFiles();
  const boundary = sourceFiles.filter((file) =>
    /\/(workoutPrescription|workoutLogic|fitnessState|fitnessRefinement|personalizedPrescription|personalizedPrescriptionCharacterization|uiControls)\.ts$/.test(file) ||
    /\/machines\//.test(file) ||
    /\/platform\/bikeBridge/i.test(file) ||
    /\/vo2/i.test(file));
  assert.ok(boundary.some((file) => file.endsWith("/uiControls.ts")));
  assert.ok(boundary.some((file) => file.endsWith("/workoutLogic.ts")));
  assert.ok(boundary.some((file) => file.includes("/machines/learning/")));
  assert.ok(boundary.some((file) => file.includes("/machines/dynamics/")));
  assert.ok(boundary.some((file) => /\/platform\/bikeBridge/i.test(file)));
  assert.ok(boundary.some((file) => /\/vo2/i.test(file)));
  for (const file of boundary) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /personalizationScientificAssessment/, file);
    assert.doesNotMatch(source, /assessPersonalizedWorkloadEvidence|scientificAssessments|E4A_SCIENTIFIC/, file);
    // uiControls hosts the developer diagnostics panel; every other boundary
    // module must not reach E4A transitively through diagnostics either.
    if (!file.endsWith("/uiControls.ts")) {
      assert.doesNotMatch(source, /personalizationDiagnosticsView/, file);
    }
  }
});

test("developer diagnostics show runtime-only E4A without exporting it", () => {
  const rows = [
    characterizedRecord({ sessionId: "thu-1", createdAt: "2026-09-08T14:30:00.000Z", signed: 1 }),
    characterizedRecord({ sessionId: "thu-2", createdAt: "2026-09-16T14:30:00.000Z", signed: -1 }),
  ];
  const assessments = Object.fromEntries(rows.map((row) => [row.record.workoutSessionId, row.assessment]));
  const workouts = Object.fromEntries(rows.map((row) => [row.record.workoutSessionId, row.workout]));
  const model = buildPersonalizationDiagnosticsModel(rows.map((row) => row.record), undefined,
    assessments, workouts, {}, EVALUATED_AT);
  assert.equal(model.scientificAssessments.length, 1);
  const [assessment] = model.scientificAssessments;
  assert.equal(assessment.state, "collecting");
  assert.equal(assessment.runtimeAuthority, false);
  // Production diagnostics now use policy v2 (deliberate switch from v1).
  assert.deepEqual(assessment.policy, { id: "e4a-scientific-assessment-policy", version: 2 });
  const html = personalizationDiagnosticsHtml(model);
  const start = html.indexOf('id="personalizationScientificAssessments"');
  assert.ok(start > 0);
  const section = html.slice(start, html.indexOf("</section>", start));
  // No v2 provenance join was supplied, so both sessions are excluded as machine-incomparable.
  for (const pattern of [/Scientific state<\/dt><dd>collecting/, /Runtime authority<\/dt><dd>no/,
    /Subject<\/dt><dd>athlete-a/, /personalization-scientific-assessor@1/,
    /e4a-scientific-assessment-policy@2/, /open_loop_evidence_unavailable/, /machine_comparability_unavailable/,
    /Sessions \/ distinct dates<\/dt><dd>0 \/ 0/, /proform-smart-power-10 \/ v1/,
    /Measured watts \/ Measured watts/, /Machine-comparable closed-loop transfer sessions<\/dt><dd>0 \(excluded: Execution provenance unavailable 2\)/,
    /Machine-comparable held-response sessions<\/dt><dd>0 \(excluded: none\)/,
    /Independent open-loop evidence<\/dt><dd>unavailable/]) {
    assert.match(section, pattern);
  }
  const withoutClock = buildPersonalizationDiagnosticsModel(rows.map((row) => row.record), undefined,
    assessments, workouts);
  assert.deepEqual(withoutClock.scientificAssessments, []);
});

test("diagnostics export v2 keeps its exact historical key contract", () => {
  const rows = [
    characterizedRecord({ sessionId: "thu-1", createdAt: "2026-09-08T14:30:00.000Z", signed: 1 }),
    characterizedRecord({ sessionId: "thu-2", createdAt: "2026-09-16T14:30:00.000Z", signed: -1 }),
  ];
  const model = buildPersonalizationDiagnosticsModel(
    rows.map((row) => row.record),
    undefined,
    Object.fromEntries(rows.map((row) => [row.record.workoutSessionId, row.assessment])),
    Object.fromEntries(rows.map((row) => [row.record.workoutSessionId, row.workout])),
    {},
    EVALUATED_AT);
  // Runtime diagnostics may be richer than the export.
  assert.equal(model.scientificAssessments.length, 1);
  assert.equal(model.thresholdLongitudinal.sessionCount, 2);
  const exported = createPersonalizationDiagnosticsExport(model);
  assert.equal(exported.schemaVersion, 3);
  assert.deepEqual(Object.keys(exported), [
    "schemaVersion",
    "filters",
    "aggregate",
    "diagnosticRows",
    "characterizationRecords",
  ]);
  for (const forbidden of ["thresholdLongitudinal", "scientificAssessments", "E4A", "e4a"]) {
    assert.equal(forbidden in exported, false, forbidden);
  }
  assert.doesNotMatch(JSON.stringify(exported), /scientific|runtimeAuthority|e4a|thresholdLongitudinal/i);
});

function insufficientCandidateRow(sessionId, createdAt) {
  const row = characterizedRecord({ sessionId, createdAt });
  const [phase] = row.record.phases;
  delete phase.comparison;
  delete phase.stableInBandWorkload;
  phase.characterizationOutcome = "insufficient_evidence";
  phase.exclusionReason = "insufficient_settled_in_band_evidence";
  return row;
}

test("E1 candidate + insufficient E2 evidence is a collecting subject, not not_applicable", () => {
  const rows = [insufficientCandidateRow("thu-short", "2026-09-08T14:30:00.000Z")];
  const subjects = discoverDiagnosticSubjects(
    rows.map((row) => row.record),
    Object.fromEntries(rows.map((row) => [row.record.workoutSessionId, row.assessment])),
    Object.fromEntries(rows.map((row) => [row.record.workoutSessionId, row.workout])),
    "athlete-a");
  assert.equal(subjects.length, 1);
  assert.deepEqual(subjects[0], subject());
  const built = buildSubjectEvidence({ ...builderInput(rows), subject: subjects[0] });
  assert.equal(built.sessions.length, 0);
  assert.equal(built.candidateStatus, "available");
  const assessment = assessPersonalizedWorkloadEvidence(
    built, subjects[0], E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1, EVALUATED_AT);
  assert.equal(assessment.state, "collecting");
  assert.equal(gateOf(assessment, "candidate_availability").status, "pass");
  assert.ok(assessment.reasonCodes.includes("insufficient_independent_sessions"));
  assert.ok(!assessment.reasonCodes.includes("candidate_unavailable"));
});

test("a genuine non-domain E1 fallback is not_applicable / candidate_unavailable", () => {
  const row = characterizedRecord({ sessionId: "thu-fb", createdAt: "2026-09-08T14:30:00.000Z" });
  row.record.phases = [{
    kind: "work", intensityId: "threshold", characterizationOutcome: "not_candidate",
    shadowOutcome: "fallback", fallbackReason: "low_quality_calibration",
    legacyHeartRate: { min: 155, max: 162 },
    observedPowerProvenance: "measured_watts", controllerContext: { saturationRatio: 0 },
  }];
  const built = buildSubjectEvidence(builderInput([row]));
  assert.equal(built.candidateStatus, "unavailable");
  const assessment = assessPersonalizedWorkloadEvidence(
    built, subject(), E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1, EVALUATED_AT);
  assert.equal(assessment.state, "not_applicable");
  assert.deepEqual(assessment.reasonCodes, ["candidate_unavailable"]);
  // A fallback never becomes a discovered subject.
  assert.deepEqual(discoverDiagnosticSubjects([row.record], { "thu-fb": row.assessment },
    { "thu-fb": row.workout }, "athlete-a"), []);
});

test("structurally impossible session values are excluded and cannot contribute to eligible", () => {
  const healthy = futureCompleteSessions([1, -1, 2, -2]);
  assert.equal(assess(healthy, {}, SYNTHETIC_FUTURE_POLICY).state, "eligible");
  const corruptions = {
    "negative width": { candidateWidthWatts: -30, widthNormalizedAbsoluteError: null },
    "zero width": { candidateWidthWatts: 0, widthNormalizedAbsoluteError: null },
    "non-positive midpoint": { candidateMidpointWatts: 0 },
    "negative absolute error": { absoluteDifferenceWatts: -2 },
    "absolute error inconsistent with signed": { absoluteDifferenceWatts: 7 },
    "signed error inconsistent with observed": { signedDifferenceWatts: 9 },
    "inconsistent normalized error": { widthNormalizedAbsoluteError: 5 },
    "saturation below zero": { saturationRatio: -0.1 },
    "saturation above one": { saturationRatio: 1.5 },
    "inverted legacy HR band": { legacyHrBand: { minBpm: 162, maxBpm: 155 } },
    "non-positive legacy HR": { legacyHrBand: { minBpm: 0, maxBpm: 162 } },
    "negative assessment age": { assessmentAgeDays: -3 },
    "workout before its calibration": { createdAt: "2026-08-20T14:30:00.000Z" },
    "negative open-loop window count": { openLoop: { stableResistanceWindowCount: -1 } },
  };
  for (const [name, corruption] of Object.entries(corruptions)) {
    const sessions = healthy.map((entry, index) => index === 3 ? { ...entry, ...corruption } : entry);
    const assessment = assess(sessions, {}, SYNTHETIC_FUTURE_POLICY);
    assert.notEqual(assessment.state, "eligible", name);
    assert.equal(assessment.evidenceDigest.sessionCount, 3, name);
    assert.ok(assessment.evidenceDigest.ignoredInvalidSessions + assessment.evidenceDigest.ignoredCrossCohortSessions >= 1, name);
    assert.ok(!assessment.evidenceDigest.sessionIds.includes("thu-4"), name);
  }
  // Non-band corruptions match the cohort and are counted as invalid, not cross-cohort.
  const negativeWidth = assess(healthy.map((entry, index) =>
    index === 3 ? { ...entry, candidateWidthWatts: -30, widthNormalizedAbsoluteError: null } : entry),
  {}, SYNTHETIC_FUTURE_POLICY);
  assert.equal(negativeWidth.evidenceDigest.ignoredInvalidSessions, 1);
  assert.equal(negativeWidth.evidenceDigest.ignoredCrossCohortSessions, 0);
});

test("valid floating-point noise in derived comparison values is not rejected", () => {
  const noisy = futureCompleteSessions([1, -1, 2, -2]).map((entry) => ({
    ...entry,
    candidateMidpointWatts: 125.1,
    observedSettledWatts: 125.1 + entry.signedDifferenceWatts,
    signedDifferenceWatts: (125.1 + entry.signedDifferenceWatts) - 125.1,
  }));
  const assessment = assess(noisy, {}, SYNTHETIC_FUTURE_POLICY);
  assert.equal(assessment.evidenceDigest.ignoredInvalidSessions, 0);
  assert.equal(assessment.state, "eligible");
});

test("evaluatedAt before the newest evidence makes configured recency unavailable and blocks eligible", () => {
  const healthy = futureCompleteSessions([1, -1, 2, -2]);
  const configured = { ...SYNTHETIC_FUTURE_POLICY, staleness: { maxDaysSinceNewestSession: 30 } };
  const fresh = assess(healthy, {}, configured);
  assert.equal(fresh.state, "eligible");
  assert.equal(gateOf(fresh, "recency").status, "pass");
  const backwards = assess(healthy, { evaluatedAt: "2026-09-30T00:00:00.000Z" }, configured);
  assert.equal(gateOf(backwards, "recency").status, "unavailable");
  assert.ok(backwards.evidenceDigest.newestSessionAgeDays < 0);
  assert.equal(backwards.state, "collecting");
  assert.ok(!backwards.reasonCodes.includes("evidence_stale"));
  // Production staleness stays not_configured.
  const production = assess(healthy, { evaluatedAt: "2026-09-30T00:00:00.000Z" });
  assert.equal(gateOf(production, "recency").status, "unavailable");
  assert.equal(production.state, "collecting");
});

test("contradiction precedence is deterministic across scrambled input", () => {
  const sessions = futureCompleteSessions([60, -20, 60, 40]);
  const forward = assess(sessions, {}, SYNTHETIC_FUTURE_POLICY);
  assert.equal(forward.state, "contradicted");
  assert.deepEqual(forward.reasonCodes, ["persistent_signed_bias_positive", "variance_exceeds_policy"]);
  for (const order of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
    assert.deepEqual(assess(order.map((index) => sessions[index]), {}, SYNTHETIC_FUTURE_POLICY), forward);
  }
  const production = assess(sessions);
  assert.equal(production.state, "contradicted");
  assert.deepEqual(production.reasonCodes, ["persistent_signed_bias_positive", "variance_exceeds_policy",
    "open_loop_evidence_unavailable", "actuation_mode_unknown"]);
});

test("the policy type is versionable while the production constant stays pinned", () => {
  assert.equal(SCIENTIFIC_ASSESSMENT_POLICY_ID_V1, "e4a-scientific-assessment-policy");
  assert.equal(SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V1, 1);
  assert.equal(E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1.id, SCIENTIFIC_ASSESSMENT_POLICY_ID_V1);
  assert.equal(E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1.version, SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V1);
  const fileName = fileURLToPath(new URL("../src/__e4aPolicyTypeCheck.ts", import.meta.url));
  const code = `import {
  E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1,
  assessPersonalizedWorkloadEvidence,
  type ScientificAssessmentPolicy,
} from "./personalizationScientificAssessment.js";

export const synthetic: ScientificAssessmentPolicy = {
  ...E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1,
  id: "e4a-synthetic-future-test-policy",
  version: 7,
  openLoopEvidence: "required",
  actuationModeEvidence: "required",
  staleness: { maxDaysSinceNewestSession: 30 },
};
export const usable = assessPersonalizedWorkloadEvidence;
export const recordedVersion: number = usable(null as never, null as never, synthetic, "").policy.version;

// @ts-expect-error the production constant pins its literal id
export const wrongId: typeof E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1 = { ...E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1, id: "other" };
// @ts-expect-error the production constant pins version 1
export const wrongVersion: typeof E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1 = { ...E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1, version: 2 };
// @ts-expect-error the production constant pins open-loop evidence as unavailable
export const openLoop: typeof E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1 = { ...E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1, openLoopEvidence: "required" };
// @ts-expect-error the production constant pins actuation-mode evidence as unavailable
export const actuation: typeof E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1 = { ...E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1, actuationModeEvidence: "required" };
`;
  const options = {
    target: ts.ScriptTarget.ES2019,
    module: ts.ModuleKind.ES2020,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2019.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name.replace(/\\/g, "/") === fileName.replace(/\\/g, "/")
      ? ts.createSourceFile(name, code, languageVersion)
      : getSourceFile(name, languageVersion, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name.replace(/\\/g, "/") === fileName.replace(/\\/g, "/") || fileExists(name);
  const program = ts.createProgram([fileName], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName.replace(/\\/g, "/") === fileName.replace(/\\/g, "/"))
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  assert.deepEqual(diagnostics, []);
});
