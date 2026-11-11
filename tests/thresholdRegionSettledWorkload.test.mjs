import test from "node:test";
import assert from "node:assert/strict";

import {
  THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1,
  THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
  createThresholdRegionSettledWorkloadPolicyV1,
  evaluateThresholdRegionSettledWorkloadContract,
  collectControllerResistanceTransitions,
  collectControllerTimeline,
  segmentControllerHeldResistance,
  thresholdRegionSettledPolicyIsProductionReady,
} from "../dist/thresholdRegionSettledWorkload.js";
import { createSteadyStateSettledWorkloadPolicyV1 } from "../dist/steadyStateSettledWorkload.js";
import { PHASE_E2_HELD_WORKLOAD_POLICY_V1 } from "../dist/personalizedPrescriptionCharacterization.js";
import { PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1 } from "../dist/types.js";

const ATHLETE = "afa677b3-9682-4fb9-8f7d-af77375975d7";
const SESSION = "6f4612a2-fe0e-4976-9444-8dc1df81c141";
const ANCHOR = "2026-10-11T18:18:38.106Z";
const ENDED = "2026-10-16T14:59:14.030Z";
const BASE = Date.parse("2026-10-16T14:29:48.416Z");

function isoAtActiveSec(activeSec) {
  return new Date(BASE + activeSec * 1000).toISOString();
}

function bikeSample(activeSec, {
  resistance,
  watts,
  wattsSource = "measured_watts",
  cadence = 67,
  availability = "fresh",
  observedResistance,
  desiredResistance,
  commandedResistance,
  /** Test-only: attach metrics even on stale/unavailable rows (malformed vs producer). */
  forceMetrics = false,
} = {}) {
  const held = resistance;
  const sample = {
    schemaVersion: 1,
    athleteId: ATHLETE,
    sessionId: SESSION,
    activeSec,
    observedAt: isoAtActiveSec(activeSec),
    availability,
  };
  const allowMetrics = availability === "fresh" || forceMetrics;
  const obs = observedResistance ?? held;
  if (allowMetrics && obs != null) {
    sample.observedResistance = { value: obs, source: "observed", freshnessMs: 0 };
  }
  const desired = desiredResistance ?? held;
  if (desired != null) sample.desiredResistance = desired;
  const commanded = commandedResistance ?? held;
  if (commanded != null) sample.commandedResistance = commanded;
  if (allowMetrics && watts != null) {
    sample.watts = { value: watts, source: wattsSource, freshnessMs: 0 };
  }
  if (allowMetrics && cadence != null) {
    sample.cadenceRpm = { value: cadence, source: "measured", freshnessMs: 0 };
  }
  if (availability === "fresh") {
    sample.sourceSampleId = `synth-${activeSec}`;
    sample.freshnessMs = 0;
  } else if (availability === "stale") {
    sample.sourceSampleId = `stale-${activeSec}`;
    sample.freshnessMs = 5000;
  }
  return sample;
}

function changeAudit(elapsedSeconds, resistanceBefore, resistanceAfter, extras = {}) {
  return {
    version: 1,
    kind: "evaluation",
    elapsedSeconds,
    phaseKind: "work",
    phaseId: "sustain",
    phaseElapsedSeconds: elapsedSeconds - 600,
    phaseDurationSeconds: 1200,
    representativeHeartRate: 160,
    resistanceBefore,
    resistanceAfter,
    heartRateAssessment: resistanceAfter > resistanceBefore ? "low" : "high",
    decision: resistanceAfter > resistanceBefore ? "increase" : "decrease",
    decisionReason: resistanceAfter > resistanceBefore ? "below_target" : "above_target",
    evaluationKind: "after_hold",
    targetHeartRateMin: 155,
    targetHeartRateMax: 162,
    ...extras,
  };
}

function actuationEvent(activeSec, requestedResistance, commandId = 1, outcome = "accepted") {
  return {
    commandId,
    decisionId: `dec-${commandId}`,
    origin: "automatic_hr_control",
    trigger: "decision",
    requestedResistance,
    activeSec,
    observedAt: isoAtActiveSec(activeSec),
    outcome,
  };
}

function holdAudit(elapsedSeconds, resistance = 10, representativeHeartRate = 159, extras = {}) {
  return {
    version: 1,
    kind: "evaluation",
    elapsedSeconds,
    phaseKind: "work",
    phaseId: "sustain",
    phaseElapsedSeconds: elapsedSeconds - 600,
    phaseDurationSeconds: 1200,
    representativeHeartRate,
    resistanceBefore: resistance,
    resistanceAfter: resistance,
    heartRateAssessment: "target",
    decision: "hold",
    decisionReason: "within_target_policy",
    evaluationKind: "after_hold",
    constraint: "target_hold",
    targetHeartRateMin: 155,
    targetHeartRateMax: 162,
    ...extras,
  };
}

/**
 * SYNTHETIC dense fixture (every-second telemetry). Useful for gate logic, but
 * NOT an Oct 16 replay — real bike telemetry is intermittent.
 */
function syntheticDenseHoldFixture(overrides = {}) {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  for (let sec = 600; sec < 900; sec++) {
    const r = sec < 700 ? 8 : sec < 800 ? 9 : 11;
    hrByActiveSec.set(sec, 130 + Math.floor((sec - 600) / 20));
    bikeSamples.push(bikeSample(sec, { resistance: r, watts: 90 + (r - 8) * 8 }));
  }
  for (let sec = 900; sec < 990; sec++) {
    hrByActiveSec.set(sec, 165);
    bikeSamples.push(bikeSample(sec, { resistance: 12, watts: 140 }));
  }
  for (let sec = 990; sec < 1050; sec++) {
    hrByActiveSec.set(sec, 162);
    bikeSamples.push(bikeSample(sec, { resistance: 11, watts: 125 }));
  }
  for (let sec = 1050; sec < 1417; sec++) {
    const hr = sec < 1170 ? 158 : sec < 1300 ? 160 : 157;
    hrByActiveSec.set(sec, hr);
    const watts = sec % 47 === 0 ? 57 : 110 + (sec % 5);
    bikeSamples.push(bikeSample(sec, { resistance: 10, watts, cadence: 66 + (sec % 3) }));
  }

  const audit = [
    holdAudit(1110, 10, 162),
    holdAudit(1170, 10, 159),
    holdAudit(1230, 10, 159),
    holdAudit(1290, 10, 160),
    holdAudit(1350, 10, 157),
    holdAudit(1410, 10, 157),
  ];

  return {
    expectedAthleteId: ATHLETE,
    sessionId: SESSION,
    athleteId: ATHLETE,
    activity: "bike",
    intent: "threshold",
    intensityId: "threshold",
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    formalAnchorObservedAt: ANCHOR,
    sessionEndedAt: ENDED,
    workActiveStartSec: 600,
    workActiveEndSecExclusive: 1417,
    targetHrMin: 155,
    targetHrMax: 162,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: audit,
    ...overrides,
  };
}

/**
 * Real-gap-shaped fixture: sustained controller hold at R10 with intermittent
 * bike rows (gaps of 2–4 s like Oct 16), observed resistance consistent when
 * present, HR largely 155–162, fresh measured watts at realistic coverage.
 * Preserves the gap pattern that previously fragmented segmentStableResistance.
 */
function oct16RealGapShapedFixture(overrides = {}) {
  const hrByActiveSec = new Map();
  const bikeSamples = [];

  // Dense ramp / overshoot / correction (pre-hold) — synthetic preamble.
  for (let sec = 600; sec < 1050; sec++) {
    const r = sec < 750 ? 8 : sec < 870 ? 11 : sec < 990 ? 12 : 11;
    hrByActiveSec.set(sec, sec < 900 ? 145 : 165);
    bikeSamples.push(bikeSample(sec, { resistance: r, watts: 90 + r * 4 }));
  }

  // Contiguous commanded R10 hold 1050–1417 with intermittent telemetry.
  // First sample at 1050 mirrors real lag: commanded 10, observed still 11.
  bikeSamples.push(bikeSample(1050, {
    resistance: 10,
    observedResistance: 11,
    desiredResistance: 10,
    commandedResistance: 10,
    watts: 120,
  }));
  hrByActiveSec.set(1050, 164);

  // Gap pattern inspired by Oct 16 held R10 (1051–1417): mostly contiguous
  // samples with intermittent 2–3 s holes and a rare 4 s hole. Density stays
  // near the real ~0.83 measured-watt coverage — enough that the old
  // maxObservationGapSec=2 splitter would fragment the hold, but evidence
  // coverage still clears the resolved 0.80 gate.
  const presentSecs = [];
  let sec = 1051;
  let gapCycle = 0;
  while (sec <= 1417) {
    presentSecs.push(sec);
    gapCycle += 1;
    let step = 1;
    if (gapCycle % 11 === 0) step = 2;
    if (gapCycle % 29 === 0) step = 3;
    if (gapCycle % 97 === 0) step = 4;
    sec += step;
  }
  if (presentSecs[presentSecs.length - 1] !== 1417) presentSecs.push(1417);

  for (const activeSec of presentSecs) {
    const hr = activeSec < 1170 ? 158 : activeSec < 1300 ? 160 : 157;
    hrByActiveSec.set(activeSec, hr);
    // Fill HR on gap seconds too (HR stream is denser than bike in reality).
    const watts = activeSec % 47 === 0 ? 57 : 110 + (activeSec % 5);
    bikeSamples.push(bikeSample(activeSec, {
      resistance: 10,
      watts,
      cadence: 66 + (activeSec % 3),
    }));
  }
  for (let s = 1051; s <= 1417; s++) {
    if (!hrByActiveSec.has(s)) {
      hrByActiveSec.set(s, s < 1170 ? 158 : s < 1300 ? 160 : 157);
    }
  }

  const audit = [
    holdAudit(1110, 10, 162, { evaluationKind: "after_decrease" }),
    holdAudit(1170, 10, 159),
    holdAudit(1230, 10, 159),
    holdAudit(1290, 10, 160),
    holdAudit(1350, 10, 157),
    holdAudit(1410, 10, 157),
  ];

  return {
    expectedAthleteId: ATHLETE,
    sessionId: SESSION,
    athleteId: ATHLETE,
    activity: "bike",
    intent: "threshold",
    intensityId: "threshold",
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    formalAnchorObservedAt: ANCHOR,
    sessionEndedAt: ENDED,
    workActiveStartSec: 600,
    workActiveEndSecExclusive: 1418,
    targetHrMin: 155,
    targetHrMax: 162,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: audit,
    ...overrides,
  };
}

test("policy reuses E2 held-workload settling/gap floors and stays distinct from E1 resolver id", () => {
  assert.equal(
    THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1.settlingSeconds,
    PHASE_E2_HELD_WORKLOAD_POLICY_V1.settlingSeconds
  );
  assert.equal(
    THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1.maxObservationGapSec,
    PHASE_E2_HELD_WORKLOAD_POLICY_V1.maxObservationGapSec
  );
  assert.equal(
    THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1.minQualifyingSeconds,
    PHASE_E2_HELD_WORKLOAD_POLICY_V1.minQualifyingSeconds
  );
  assert.notEqual(
    THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_ID_V1,
    PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1
  );
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1, "ordinary_workout_settled_threshold_region");
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1.minInBandFraction, 0.9);
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1.maxMeasuredWattsMadRatio, 0.1);
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1.minAdviceGradeDurationSec, 120);
  assert.equal(thresholdRegionSettledPolicyIsProductionReady(), true);
  assert.deepEqual(
    evaluateThresholdRegionSettledWorkloadContract(syntheticDenseHoldFixture()).unresolvedPolicyFields,
    []
  );
});

test("synthetic dense fixture accepts settled hold under resolved gates and rejects ramp-only segments", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(syntheticDenseHoldFixture());
  assert.equal(result.identityFailures.length, 0);
  assert.ok(result.acceptedWindow, "expected a resolved-gate accepting window");
  assert.equal(result.acceptedWindow.windowStartSec, 1050);
  assert.equal(result.acceptedWindow.settledFromSec, 1170);
  assert.ok(result.acceptedWindow.postSettlingDurationSec >= 30);
  assert.ok(result.acceptedWindow.qualifyingSampleCount >= 30);
  assert.ok(result.acceptedWindow.hasTargetHoldCorroboration);
  assert.ok((result.acceptedWindow.hrInBandFraction ?? 0) >= 0.9);
  assert.ok((result.acceptedWindow.measuredWattsMedian ?? 0) > 100);
  assert.ok((result.acceptedWindow.measuredWattsMedian ?? 0) < 130);
  assert.ok(result.observation);
  assert.equal(result.observation.eligibleForPrescription, false);
  assert.equal(result.observation.quality, "unverified");
  assert.equal(result.observation.interpretation, "descriptive_observation_only");
  assert.equal(result.policyProductionReady, true);

  const rampish = result.windows.filter((w) => w.windowStartSec < 1050);
  for (const window of rampish) {
    assert.equal(window.acceptsUnderResolvedGates, false);
  }
});

test("actual-gap-shaped sustained hold qualifies under resolved gates", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(oct16RealGapShapedFixture());
  assert.equal(result.identityFailures.length, 0);
  assert.ok(result.acceptedWindow, "gap-shaped hold should qualify under resolved gates");
  // Contaminated commanded-10 sample at 1050 (observed 11) is trimmed away.
  assert.equal(result.acceptedWindow.heldResistance, 10);
  assert.equal(result.acceptedWindow.windowStartSec, 1051);
  assert.equal(result.acceptedWindow.settledFromSec, 1171);
  assert.ok(result.acceptedWindow.postSettlingDurationSec >= 200);
  assert.ok(result.acceptedWindow.qualifyingSampleCount >= 30);
  assert.ok(result.acceptedWindow.measuredWattsCoverageRatio >= 0.8);
  assert.ok(result.acceptedWindow.hasTargetHoldCorroboration);
  // 1170 is before settledFrom (1171); corroboration uses post-settle holds only.
  assert.ok(result.acceptedWindow.matchingHoldAuditElapsedSeconds.includes(1230));
  assert.ok(result.observation);
  assert.equal(result.observation.eligibleForPrescription, false);
});

test("telemetry gaps alone do not masquerade as resistance changes", () => {
  const samples = [];
  // Same commanded/observed resistance with 3-second holes — must stay one window.
  for (const sec of [100, 101, 104, 105, 108, 109, 112, 113, 116]) {
    samples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
  }
  const windows = segmentControllerHeldResistance(samples, 100, 117);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].resistance, 10);
  assert.equal(windows[0].startSec, 100);
  assert.equal(windows[0].endSecInclusive, 116);
});

test("contradictory observed resistance rejects/splits the hold", () => {
  const samples = [
    bikeSample(100, { resistance: 10, watts: 114 }),
    bikeSample(101, { resistance: 10, watts: 114 }),
    bikeSample(102, { resistance: 10, observedResistance: 11, commandedResistance: 10, desiredResistance: 10, watts: 120 }),
    bikeSample(103, { resistance: 10, watts: 114 }),
    bikeSample(104, { resistance: 10, watts: 114 }),
  ];
  const windows = segmentControllerHeldResistance(samples, 100, 105);
  assert.equal(windows.length, 2);
  assert.deepEqual(
    windows.map((w) => ({ r: w.resistance, start: w.startSec, end: w.endSecInclusive })),
    [
      { r: 10, start: 100, end: 101 },
      { r: 10, start: 103, end: 104 },
    ]
  );
});

test("wrong-resistance audit hold cannot corroborate a window", () => {
  const input = oct16RealGapShapedFixture({
    machineDecisionAudit: [
      holdAudit(1170, 12, 159), // wrong resistance
      holdAudit(1230, 9, 159),
    ],
  });
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  const holdWindow = result.windows.find((w) => w.heldResistance === 10 && w.windowStartSec === 1051);
  assert.ok(holdWindow);
  assert.equal(holdWindow.hasTargetHoldCorroboration, false);
  assert.ok(holdWindow.resolvedGateFailures.includes("missing_target_hold_corroboration"));
  assert.equal(result.acceptedWindow, null);
});

test("correct-resistance target hold can corroborate it", () => {
  const input = oct16RealGapShapedFixture({
    machineDecisionAudit: [holdAudit(1230, 10, 159)],
  });
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  assert.ok(result.acceptedWindow);
  assert.equal(result.acceptedWindow.hasTargetHoldCorroboration, true);
  assert.deepEqual(result.acceptedWindow.matchingHoldAuditElapsedSeconds, [1230]);
});

test("contract does not hard-code resistance 10 — another held resistance can qualify", () => {
  const input = syntheticDenseHoldFixture();
  for (const sample of input.bikeSamples) {
    if (sample.activeSec >= 1050) {
      sample.observedResistance = { value: 7, source: "observed", freshnessMs: 0 };
      sample.desiredResistance = 7;
      sample.commandedResistance = 7;
    }
  }
  input.machineDecisionAudit = input.machineDecisionAudit.map((entry) => ({
    ...entry,
    resistanceBefore: 7,
    resistanceAfter: 7,
  }));
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  assert.ok(result.acceptedWindow);
  assert.equal(result.acceptedWindow.heldResistance, 7);
});

test("rejects brief target pass-through (short post-settling)", () => {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  for (let sec = 600; sec < 780; sec++) {
    hrByActiveSec.set(sec, 158);
    bikeSamples.push(bikeSample(sec, { resistance: 9, watts: 120 }));
  }
  for (let sec = 780; sec < 820; sec++) {
    hrByActiveSec.set(sec, 159);
    bikeSamples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
  }
  const result = evaluateThresholdRegionSettledWorkloadContract({
    ...syntheticDenseHoldFixture(),
    workActiveEndSecExclusive: 820,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: [holdAudit(800)],
  });
  assert.equal(result.acceptedWindow, null);
  assert.ok(
    result.windows.every((w) =>
      w.resolvedGateFailures.includes("insufficient_post_settling_duration") ||
      w.resolvedGateFailures.includes("missing_target_hold_corroboration") ||
      w.resolvedGateFailures.length > 0
    )
  );
});

test("rejects stale/unavailable watts and calibrated-only workload", () => {
  const base = syntheticDenseHoldFixture();
  for (const sample of base.bikeSamples) {
    if (sample.activeSec >= 1170) sample.availability = "stale";
  }
  const stale = evaluateThresholdRegionSettledWorkloadContract(base);
  assert.equal(stale.acceptedWindow, null);

  const calibrated = syntheticDenseHoldFixture();
  for (const sample of calibrated.bikeSamples) {
    if (sample.activeSec >= 1050 && sample.watts) sample.watts.source = "calibrated_watts";
  }
  const cal = evaluateThresholdRegionSettledWorkloadContract(calibrated);
  assert.equal(cal.acceptedWindow, null);
  assert.ok(
    cal.windows.some((w) =>
      w.resolvedGateFailures.includes("non_measured_watt_provenance") ||
      w.resolvedGateFailures.includes("insufficient_measured_watt_coverage")
    )
  );
});

test("rejects athlete mismatch, machine provenance mismatch, and pre-anchor session", () => {
  assert.deepEqual(
    evaluateThresholdRegionSettledWorkloadContract(syntheticDenseHoldFixture({ athleteId: "other" })).identityFailures,
    ["athlete_mismatch"]
  );
  assert.ok(
    evaluateThresholdRegionSettledWorkloadContract(
      syntheticDenseHoldFixture({ machineId: undefined, machineProfileVersion: undefined })
    ).identityFailures.includes("missing_machine_provenance")
  );
  assert.ok(
    evaluateThresholdRegionSettledWorkloadContract(
      syntheticDenseHoldFixture({ sessionEndedAt: "2026-10-10T00:00:00.000Z" })
    ).identityFailures.includes("pre_formal_anchor")
  );
});

test("malformed session timestamp fails closed", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(
    syntheticDenseHoldFixture({ sessionEndedAt: "not-a-timestamp" })
  );
  assert.ok(result.identityFailures.includes("invalid_session_or_anchor_timestamp"));
  assert.equal(result.acceptedWindow, null);
});

test("malformed formal-anchor timestamp fails closed", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(
    syntheticDenseHoldFixture({ formalAnchorObservedAt: "yesterday" })
  );
  assert.ok(result.identityFailures.includes("invalid_session_or_anchor_timestamp"));
  assert.equal(result.acceptedWindow, null);
});

test("absolute toISOString timestamps pass; offsetless and non-absolute forms fail closed", () => {
  const ok = evaluateThresholdRegionSettledWorkloadContract(
    syntheticDenseHoldFixture({
      sessionEndedAt: "2026-10-16T14:59:14.030Z",
      formalAnchorObservedAt: "2026-10-11T18:18:38.106Z",
    })
  );
  assert.ok(ok.observation);
  assert.equal(ok.observation.sessionEndedAt, "2026-10-16T14:59:14.030Z");
  assert.equal(ok.observation.formalAnchorObservedAt, "2026-10-11T18:18:38.106Z");

  for (const [label, sessionEndedAt] of [
    ["offsetless datetime", "2026-10-16T23:30:00"],
    ["date-only", "2026-10-16"],
    ["locale-style", "10/16/2026 23:30"],
    ["offset timestamp", "2026-10-16T23:30:00-04:00"],
    ["Z without fractional ms", "2026-10-16T23:30:00Z"],
    ["empty", ""],
  ]) {
    const result = evaluateThresholdRegionSettledWorkloadContract(
      syntheticDenseHoldFixture({ sessionEndedAt })
    );
    assert.ok(
      result.identityFailures.includes("invalid_session_or_anchor_timestamp"),
      `${label} should fail identity`
    );
    assert.equal(result.observation, null, `${label} must not emit observation`);
    assert.equal(result.acceptedWindow, null, `${label} must not accept window`);
  }

  for (const [label, formalAnchorObservedAt] of [
    ["offsetless anchor", "2026-10-11T18:18:38"],
    ["date-only anchor", "2026-10-11"],
    ["offset anchor", "2026-10-11T18:18:38-04:00"],
  ]) {
    const result = evaluateThresholdRegionSettledWorkloadContract(
      syntheticDenseHoldFixture({ formalAnchorObservedAt })
    );
    assert.ok(
      result.identityFailures.includes("invalid_session_or_anchor_timestamp"),
      `${label} should fail identity`
    );
    assert.equal(result.observation, null, `${label} must not emit observation`);
  }
});

test("rejects missing target-hold corroboration and mostly out-of-band HR when occupancy gate is set", () => {
  const noHold = evaluateThresholdRegionSettledWorkloadContract(
    syntheticDenseHoldFixture({ machineDecisionAudit: [] })
  );
  assert.equal(noHold.acceptedWindow, null);
  assert.ok(
    noHold.windows.some((w) => w.resolvedGateFailures.includes("missing_target_hold_corroboration"))
  );

  const outOfBand = syntheticDenseHoldFixture();
  for (const [sec, _hr] of outOfBand.hrByActiveSec) {
    if (sec >= 1170) outOfBand.hrByActiveSec.set(sec, 140);
  }
  const result = evaluateThresholdRegionSettledWorkloadContract(outOfBand);
  assert.equal(result.acceptedWindow, null);
  assert.ok(
    result.windows.some((w) => w.resolvedGateFailures.includes("insufficient_in_band_occupancy"))
  );
});

test("insufficient measured-watt coverage still rejects", () => {
  const input = oct16RealGapShapedFixture();
  // Drop most post-settle bike watts so coverage falls well below 0.80.
  input.bikeSamples = input.bikeSamples.filter((sample) => {
    if (sample.activeSec < 1171) return true;
    return sample.activeSec % 10 === 0;
  });
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  assert.equal(result.acceptedWindow, null);
  assert.ok(
    result.windows.some((w) =>
      w.heldResistance === 10 &&
      w.resolvedGateFailures.includes("insufficient_measured_watt_coverage")
    )
  );
});

test("large unsupported telemetry gap still rejects where evidence becomes inadequate", () => {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  // Controller holds R10 for a long elapsed span, but bike evidence only exists
  // in a thin band — coverage fails even though load continuity is intact.
  for (let sec = 600; sec < 900; sec++) {
    hrByActiveSec.set(sec, 158);
    if (sec < 620 || sec >= 880) {
      bikeSamples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
    }
  }
  // Keep a couple of mid-hold samples so controller span still covers 600–899.
  bikeSamples.push(bikeSample(700, { resistance: 10, watts: 114 }));
  bikeSamples.push(bikeSample(800, { resistance: 10, watts: 114 }));
  bikeSamples.sort((a, b) => a.activeSec - b.activeSec);

  const result = evaluateThresholdRegionSettledWorkloadContract({
    ...syntheticDenseHoldFixture(),
    workActiveStartSec: 600,
    workActiveEndSecExclusive: 900,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: [holdAudit(780, 10, 158), holdAudit(840, 10, 158)],
  });
  assert.equal(result.acceptedWindow, null);
  const window = result.windows.find((w) => w.heldResistance === 10);
  assert.ok(window);
  assert.ok(window.windowStartSec === 600 && window.windowEndSecExclusive === 900);
  assert.ok(
    window.resolvedGateFailures.includes("insufficient_measured_watt_coverage") ||
      window.resolvedGateFailures.includes("insufficient_cadence_coverage") ||
      window.resolvedGateFailures.includes("insufficient_post_settling_duration")
  );
});

test("minQualifyingSeconds counts joint HR+watt samples, not merely elapsed span", () => {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  // Long elapsed post-settle span, but only 20 joint HR+watt seconds.
  for (let sec = 600; sec < 900; sec++) {
    hrByActiveSec.set(sec, 158);
  }
  for (let sec = 600; sec < 900; sec++) {
    if (sec < 720 || sec % 9 === 0) {
      bikeSamples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
    } else if (sec === 899) {
      bikeSamples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
    }
  }
  // Ensure controller endpoints exist
  if (!bikeSamples.some((s) => s.activeSec === 600)) {
    bikeSamples.push(bikeSample(600, { resistance: 10, watts: 114 }));
  }
  bikeSamples.sort((a, b) => a.activeSec - b.activeSec);

  const result = evaluateThresholdRegionSettledWorkloadContract({
    ...syntheticDenseHoldFixture(),
    workActiveStartSec: 600,
    workActiveEndSecExclusive: 900,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: [holdAudit(780, 10, 158)],
    policy: {
      ...THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
      minQualifyingSeconds: 30,
    },
  });
  const window = result.windows.find((w) => w.heldResistance === 10);
  assert.ok(window);
  assert.ok(window.postSettlingDurationSec >= 30, "elapsed span is long");
  assert.ok(window.qualifyingSampleCount < 30, `qualifying=${window.qualifyingSampleCount}`);
  assert.ok(window.resolvedGateFailures.includes("insufficient_post_settling_duration"));
  assert.equal(result.acceptedWindow, null);
});

test("rare watt outliers do not inflate MAD the way min/max span would", () => {
  const input = syntheticDenseHoldFixture({
    policy: {
      ...THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
      maxMeasuredWattsMadRatio: 0.05,
    },
  });
  for (const sample of input.bikeSamples) {
    if (sample.activeSec >= 1170 && sample.watts) {
      sample.watts.value = sample.activeSec % 47 === 0 ? 57 : 114;
    }
  }
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  assert.ok(result.acceptedWindow);
  assert.ok((result.acceptedWindow.measuredWattsMadRatio ?? 1) < 0.05);
});

test("rejects unstable settled workload when MAD ratio gate is set", () => {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  for (let sec = 600; sec < 900; sec++) {
    hrByActiveSec.set(sec, 158);
    bikeSamples.push(bikeSample(sec, {
      resistance: 9,
      watts: sec % 2 === 0 ? 70 : 150,
      cadence: 68,
    }));
  }
  const result = evaluateThresholdRegionSettledWorkloadContract({
    ...syntheticDenseHoldFixture(),
    workActiveStartSec: 600,
    workActiveEndSecExclusive: 900,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: [holdAudit(780, 9, 158), holdAudit(840, 9, 158)],
  });
  const window = result.windows.find((w) => w.heldResistance === 9);
  assert.ok(window);
  assert.ok((window.measuredWattsMadRatio ?? 0) > 0.1, `madRatio=${window.measuredWattsMadRatio}`);
  assert.equal(result.acceptedWindow, null);
  assert.ok(window.resolvedGateFailures.includes("unstable_measured_workload"));
});

test("production observation requires complete policy; schema identity is set when emitted", () => {
  assert.equal(thresholdRegionSettledPolicyIsProductionReady(), true);
  const result = evaluateThresholdRegionSettledWorkloadContract(syntheticDenseHoldFixture());
  assert.ok(result.acceptedWindow);
  assert.ok(result.observation);
  assert.equal(result.observation.schemaId, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1);
  assert.equal(result.observation.eligibleForPrescription, false);
  assert.equal(result.observation.quality, "unverified");
  assert.equal(result.observation.interpretation, "descriptive_observation_only");
  assert.equal(result.observation.provenance, THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1);
  assert.equal(result.observation.heldResistance, 10);
  assert.equal(
    result.observation.controllerSettledProvenance,
    "controller_held_resistance_plus_target_hold_audit"
  );
  assert.equal(result.observation.admissionPolicyId, THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1);
  assert.equal(
    result.observation.admissionPolicyVersion,
    THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1
  );
  assert.equal(result.observation.sessionEndedAt, ENDED);
});

test("observation records the evaluating admission policy id/version and sessionEndedAt", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(syntheticDenseHoldFixture());
  assert.ok(result.observation);
  assert.equal(result.observation.admissionPolicyId, result.policy.id);
  assert.equal(result.observation.admissionPolicyVersion, result.policy.version);
  assert.equal(result.observation.admissionPolicyId, THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1);
  assert.equal(
    result.observation.admissionPolicyVersion,
    THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1
  );
  assert.equal(result.observation.sessionEndedAt, ENDED);
  assert.match(result.observation.sessionEndedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("stale row with cadence must not inflate cadence coverage", () => {
  const input = syntheticDenseHoldFixture();
  // Malformed vs producer: stale rows carrying cadenceRpm must not count.
  for (const sample of input.bikeSamples) {
    if (sample.activeSec >= 1170 && sample.activeSec % 2 === 0) {
      sample.availability = "stale";
      sample.freshnessMs = 5000;
      sample.cadenceRpm = { value: 90, source: "measured", freshnessMs: 5000 };
      // Keep watts absent on stale so watt path is not the failure mode.
      delete sample.watts;
    }
  }
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  const window = result.windows.find((w) => w.heldResistance === 10 && w.windowStartSec === 1050);
  assert.ok(window);
  // Settled span is dense; half the seconds are stale-with-cadence and must not count.
  assert.ok(window.cadenceCoverageRatio < 0.75, `cadCov=${window.cadenceCoverageRatio}`);
  assert.ok(window.resolvedGateFailures.includes("insufficient_cadence_coverage"));
});

test("unavailable row with cadence must not inflate cadence coverage", () => {
  const input = syntheticDenseHoldFixture();
  for (const sample of input.bikeSamples) {
    if (sample.activeSec >= 1170 && sample.activeSec % 2 === 0) {
      sample.availability = "unavailable";
      delete sample.freshnessMs;
      delete sample.sourceSampleId;
      sample.cadenceRpm = { value: 90, source: "measured", freshnessMs: 0 };
      delete sample.watts;
    }
  }
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  const window = result.windows.find((w) => w.heldResistance === 10 && w.windowStartSec === 1050);
  assert.ok(window);
  assert.ok(window.cadenceCoverageRatio < 0.75, `cadCov=${window.cadenceCoverageRatio}`);
  assert.ok(window.resolvedGateFailures.includes("insufficient_cadence_coverage"));
});

test("fresh measured cadence does count", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(syntheticDenseHoldFixture());
  assert.ok(result.acceptedWindow);
  assert.ok(result.acceptedWindow.cadenceCoverageRatio >= 0.75);
  assert.ok(result.acceptedWindow.cadenceMedian != null);
});

test("stale observed resistance does not contradict controller-held state", () => {
  // Telemetry shows commanded R10 throughout; a stale row claiming observed R11
  // must not split the hold (producer forbids metrics on stale; evaluator ignores).
  const samples = [
    bikeSample(100, { resistance: 10, watts: 114 }),
    bikeSample(101, {
      resistance: 10,
      availability: "stale",
      forceMetrics: true,
      observedResistance: 11,
      watts: 114,
    }),
    bikeSample(102, { resistance: 10, watts: 114 }),
    bikeSample(103, { resistance: 10, watts: 114 }),
  ];
  const windows = segmentControllerHeldResistance(samples, 100, 104);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].resistance, 10);
  assert.equal(windows[0].startSec, 100);
  assert.equal(windows[0].endSecInclusive, 103);
});

test("telemetry gap with no known controller transition can remain one hold", () => {
  const samples = [
    bikeSample(100, { resistance: 10, watts: 114 }),
    bikeSample(101, { resistance: 10, watts: 114 }),
    // gap 102-108
    bikeSample(109, { resistance: 10, watts: 114 }),
    bikeSample(110, { resistance: 10, watts: 114 }),
  ];
  const windows = segmentControllerHeldResistance(samples, 100, 111, {
    machineDecisionAudit: [],
    resistanceActuationEvents: [],
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startSec, 100);
  assert.equal(windows[0].endSecInclusive, 110);
});

test("known R10→R11 transition inside telemetry gap splits R10 continuity", () => {
  const samples = [
    bikeSample(100, { resistance: 10, watts: 114 }),
    bikeSample(101, { resistance: 10, watts: 114 }),
    // gap; controller changes to R11 then we next see R10 again at 110
    bikeSample(110, { resistance: 10, watts: 114 }),
    bikeSample(111, { resistance: 10, watts: 114 }),
  ];
  const windows = segmentControllerHeldResistance(samples, 100, 112, {
    machineDecisionAudit: [changeAudit(105, 10, 11)],
    resistanceActuationEvents: [actuationEvent(105, 11, 1)],
  });
  const r10 = windows.filter((w) => w.resistance === 10);
  // Must not be one continuous 100–111 R10 hold.
  assert.ok(r10.every((w) => w.endSecInclusive < 105 || w.startSec > 105));
  assert.ok(!r10.some((w) => w.startSec <= 100 && w.endSecInclusive >= 110));
});

test("known R10→R11→R10 cannot be flattened into one R10 hold", () => {
  const samples = [
    bikeSample(100, { resistance: 10, watts: 114 }),
    bikeSample(120, { resistance: 10, watts: 114 }),
  ];
  const windows = segmentControllerHeldResistance(samples, 100, 121, {
    resistanceActuationEvents: [
      actuationEvent(100, 10, 1),
      actuationEvent(105, 11, 2),
      actuationEvent(110, 10, 3),
    ],
  });
  const r10 = windows.filter((w) => w.resistance === 10);
  assert.ok(r10.length >= 2, `r10 windows=${JSON.stringify(r10)}`);
  assert.ok(r10.some((w) => w.startSec === 100 && w.endSecInclusive === 104));
  assert.ok(r10.some((w) => w.startSec === 110 && w.endSecInclusive === 120));
  assert.ok(windows.some((w) => w.resistance === 11 && w.startSec === 105 && w.endSecInclusive === 109));
});

test("commanded R10 with observed R11 at transition second trims; first corroborated R10 begins window", () => {
  const samples = [
    bikeSample(1050, {
      resistance: 10,
      observedResistance: 11,
      commandedResistance: 10,
      desiredResistance: 10,
      watts: 120,
    }),
    bikeSample(1051, { resistance: 10, watts: 114 }),
    bikeSample(1052, { resistance: 10, watts: 114 }),
  ];
  const windows = segmentControllerHeldResistance(samples, 1050, 1053, {
    machineDecisionAudit: [changeAudit(1050, 11, 10)],
    resistanceActuationEvents: [actuationEvent(1050, 10, 1)],
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].resistance, 10);
  assert.equal(windows[0].startSec, 1051);
  assert.equal(windows[0].endSecInclusive, 1052);
});

test("wrong-resistance hold audit still cannot corroborate after integrity harden", () => {
  const input = oct16RealGapShapedFixture({
    machineDecisionAudit: [
      changeAudit(1050, 11, 10),
      holdAudit(1230, 12, 159),
    ],
    resistanceActuationEvents: [actuationEvent(1050, 10, 1)],
  });
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  const holdWindow = result.windows.find((w) => w.heldResistance === 10 && w.windowStartSec === 1051);
  assert.ok(holdWindow);
  assert.equal(holdWindow.hasTargetHoldCorroboration, false);
  assert.ok(holdWindow.resolvedGateFailures.includes("missing_target_hold_corroboration"));
});

test("same-second actuation R10 + audit R11 => R10 (actuation wins)", () => {
  const transitions = collectControllerResistanceTransitions({
    workActiveStartSec: 1000,
    workActiveEndSecExclusive: 1100,
    resistanceActuationEvents: [actuationEvent(1050, 10, 1)],
    machineDecisionAudit: [changeAudit(1050, 10, 11)], // would prefer R11 if numeric sort won
  });
  assert.deepEqual(transitions, [{ activeSec: 1050, resistance: 10 }]);
});

test("same-second actuation R11 + audit R10 => R11 (actuation wins)", () => {
  const transitions = collectControllerResistanceTransitions({
    workActiveStartSec: 1000,
    workActiveEndSecExclusive: 1100,
    resistanceActuationEvents: [actuationEvent(1050, 11, 1)],
    machineDecisionAudit: [changeAudit(1050, 11, 10)], // lower R must not win via sort
  });
  assert.deepEqual(transitions, [{ activeSec: 1050, resistance: 11 }]);
});

test("same-second actuation + agreeing audit => one transition", () => {
  const transitions = collectControllerResistanceTransitions({
    workActiveStartSec: 1000,
    workActiveEndSecExclusive: 1100,
    resistanceActuationEvents: [actuationEvent(1050, 10, 1)],
    machineDecisionAudit: [changeAudit(1050, 11, 10)],
  });
  assert.deepEqual(transitions, [{ activeSec: 1050, resistance: 10 }]);
});

test("audit-only transition still works", () => {
  const transitions = collectControllerResistanceTransitions({
    workActiveStartSec: 1000,
    workActiveEndSecExclusive: 1100,
    machineDecisionAudit: [changeAudit(1050, 11, 10)],
    resistanceActuationEvents: [],
  });
  assert.deepEqual(transitions, [{ activeSec: 1050, resistance: 10 }]);
});

test("actuation-only transition still works", () => {
  const transitions = collectControllerResistanceTransitions({
    workActiveStartSec: 1000,
    workActiveEndSecExclusive: 1100,
    resistanceActuationEvents: [actuationEvent(1050, 10, 1)],
    machineDecisionAudit: [],
  });
  assert.deepEqual(transitions, [{ activeSec: 1050, resistance: 10 }]);
});

test("numeric resistance value never determines provenance precedence", () => {
  // Audit claims higher R at 1050; actuation claims lower R. Precedence must
  // follow source, not max(resistance).
  const a = collectControllerResistanceTransitions({
    workActiveStartSec: 1000,
    workActiveEndSecExclusive: 1100,
    resistanceActuationEvents: [actuationEvent(1050, 7, 1)],
    machineDecisionAudit: [changeAudit(1050, 7, 12)],
  });
  assert.deepEqual(a, [{ activeSec: 1050, resistance: 7 }]);
  const b = collectControllerResistanceTransitions({
    workActiveStartSec: 1000,
    workActiveEndSecExclusive: 1100,
    resistanceActuationEvents: [actuationEvent(1050, 12, 1)],
    machineDecisionAudit: [changeAudit(1050, 12, 7)],
  });
  assert.deepEqual(b, [{ activeSec: 1050, resistance: 12 }]);
});

test("multiple accepted actuation events in one activeSec: last commandId wins", () => {
  // Writer allows non-decreasing activeSec; append order = commandId.
  const transitions = collectControllerResistanceTransitions({
    workActiveStartSec: 1000,
    workActiveEndSecExclusive: 1100,
    resistanceActuationEvents: [
      actuationEvent(1050, 10, 1),
      actuationEvent(1050, 11, 2),
    ],
    machineDecisionAudit: [changeAudit(1050, 11, 9)], // must not override commandId 2
  });
  assert.deepEqual(transitions, [{ activeSec: 1050, resistance: 11 }]);
});

test("accepted actuation + conflicting audit => accepted actuation wins", () => {
  const transitions = collectControllerResistanceTransitions({
    workActiveStartSec: 1000,
    workActiveEndSecExclusive: 1100,
    resistanceActuationEvents: [actuationEvent(1050, 10, 1, "accepted")],
    machineDecisionAudit: [changeAudit(1050, 10, 11)],
  });
  assert.deepEqual(transitions, [{ activeSec: 1050, resistance: 10 }]);
});

for (const outcome of ["failed", "unavailable", "timeout", "pending"]) {
  test(`${outcome} actuation + audit transition => audit cannot establish known resistance that second`, () => {
    // Pre-fix: only outcome==="accepted" blocked audit fill, so audit R10
    // would create a known transition despite non-accepted actuation at 1050.
    const timeline = collectControllerTimeline({
      workActiveStartSec: 1000,
      workActiveEndSecExclusive: 1100,
      resistanceActuationEvents: [actuationEvent(1050, 10, 1, outcome)],
      machineDecisionAudit: [changeAudit(1050, 11, 10)],
    });
    assert.ok(
      timeline.some((m) => m.kind === "uncertain" && m.activeSec === 1050),
      `${outcome}: expected uncertain mark`
    );
    assert.ok(
      !timeline.some((m) => m.kind === "known" && m.activeSec === 1050),
      `${outcome}: audit must not manufacture known R10 at 1050`
    );
  });
}

test("uncertain event inside R10 hold => R10 continuity cannot bridge through it", () => {
  const samples = [
    bikeSample(100, { resistance: 10, watts: 114 }),
    bikeSample(120, { resistance: 10, watts: 114 }),
  ];
  const windows = segmentControllerHeldResistance(samples, 100, 121, {
    resistanceActuationEvents: [
      actuationEvent(100, 10, 1, "accepted"),
      actuationEvent(110, 10, 2, "timeout"),
      actuationEvent(115, 10, 3, "accepted"),
    ],
  });
  const r10 = windows.filter((w) => w.resistance === 10);
  assert.ok(r10.length >= 2, `expected split R10 holds, got ${JSON.stringify(r10)}`);
  assert.ok(!r10.some((w) => w.startSec <= 100 && w.endSecInclusive >= 115));
  assert.ok(r10.some((w) => w.endSecInclusive === 109 && w.boundedByAmbiguousActuation));
});

test("uncertain event followed by later accepted R10 => later R10 may recover", () => {
  const samples = [
    bikeSample(100, { resistance: 9, watts: 100 }),
    bikeSample(1110, { resistance: 10, watts: 114 }),
    bikeSample(1400, { resistance: 10, watts: 114 }),
  ];
  const windows = segmentControllerHeldResistance(samples, 100, 1410, {
    resistanceActuationEvents: [
      actuationEvent(1050, 10, 1, "timeout"),
      actuationEvent(1110, 10, 2, "accepted"),
    ],
    machineDecisionAudit: [changeAudit(1050, 11, 10)],
  });
  const recovered = windows.find((w) => w.resistance === 10 && w.startSec === 1110);
  assert.ok(recovered, `expected recovered R10 at 1110, got ${JSON.stringify(windows)}`);
  assert.ok(recovered.endSecInclusive >= 1400);
});

test("accepted R10 → ambiguous command → accepted R10 => ambiguity remains a boundary", () => {
  const samples = [
    bikeSample(100, { resistance: 10, watts: 114 }),
    bikeSample(200, { resistance: 10, watts: 114 }),
  ];
  const windows = segmentControllerHeldResistance(samples, 100, 201, {
    resistanceActuationEvents: [
      actuationEvent(100, 10, 1, "accepted"),
      actuationEvent(150, 10, 2, "failed"),
      actuationEvent(160, 10, 3, "accepted"),
    ],
  });
  assert.ok(windows.length >= 2);
  assert.ok(!windows.some((w) => w.startSec === 100 && w.endSecInclusive >= 160));
});

test("coverage=complete + clean events => existing behavior unchanged", () => {
  const input = oct16RealGapShapedFixture({
    actuationCoverage: "complete",
    resistanceActuationEvents: [
      actuationEvent(1050, 10, 1, "accepted"),
    ],
    machineDecisionAudit: [
      changeAudit(1050, 11, 10),
      holdAudit(1230, 10, 159),
      holdAudit(1290, 10, 160),
      holdAudit(1350, 10, 157),
      holdAudit(1410, 10, 157),
    ],
  });
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  assert.ok(result.acceptedWindow);
  assert.equal(result.acceptedWindow.heldResistance, 10);
  assert.equal(result.acceptedWindow.windowStartSec, 1051);
  assert.ok(!result.identityFailures.includes("incomplete_actuation_provenance"));
});

test("coverage=incomplete => fail-closed with incomplete_actuation_provenance", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(
    oct16RealGapShapedFixture({
      actuationCoverage: "incomplete",
      resistanceActuationEvents: [actuationEvent(1050, 10, 1, "accepted")],
    })
  );
  assert.ok(result.identityFailures.includes("incomplete_actuation_provenance"));
  assert.equal(result.acceptedWindow, null);
});

test("no actuation provenance at all => audit/telemetry fallback still works", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(
    oct16RealGapShapedFixture({
      resistanceActuationEvents: undefined,
      actuationCoverage: undefined,
    })
  );
  assert.ok(result.acceptedWindow);
  assert.equal(result.acceptedWindow.heldResistance, 10);
});

/**
 * Pre-fix: when timeline had only uncertain marks (hasKnown=false),
 * splitTelemetryIntervalsAtUncertain(telemetry…) could create a post-timeout
 * R10 hold from commanded/desired rows and accept excellent evidence after it.
 */
for (const outcome of ["timeout", "failed", "unavailable", "pending"]) {
  test(`${outcome} + good telemetry after + no later accepted => no post-ambiguity qualifying hold`, () => {
    const hrByActiveSec = new Map();
    const bikeSamples = [];
    for (let sec = 100; sec < 150; sec++) {
      hrByActiveSec.set(sec, 158);
      bikeSamples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
    }
    // Excellent post-ambiguity telemetry that must not re-establish known R10.
    for (let sec = 151; sec < 500; sec++) {
      hrByActiveSec.set(sec, 158);
      bikeSamples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
    }
    const result = evaluateThresholdRegionSettledWorkloadContract({
      ...syntheticDenseHoldFixture(),
      workActiveStartSec: 100,
      workActiveEndSecExclusive: 500,
      hrByActiveSec,
      bikeSamples,
      machineDecisionAudit: [holdAudit(400, 10, 158)],
      resistanceActuationEvents: [
        actuationEvent(100, 10, 1, "accepted"),
        actuationEvent(150, 11, 2, outcome),
      ],
      actuationCoverage: "complete",
    });
    assert.equal(result.acceptedWindow, null, `${outcome}: must not accept post-ambiguity hold`);
    const post = result.windows.filter((w) => w.windowStartSec >= 150);
    assert.equal(post.length, 0, `${outcome}: no post-150 held windows, got ${JSON.stringify(post)}`);
  });
}

test("uncertain @150 + audit R10 @180 + no accepted => audit must not re-establish", () => {
  const timeline = collectControllerTimeline({
    workActiveStartSec: 100,
    workActiveEndSecExclusive: 300,
    resistanceActuationEvents: [actuationEvent(150, 11, 1, "timeout")],
    machineDecisionAudit: [changeAudit(180, 11, 10)],
  });
  assert.ok(timeline.some((m) => m.kind === "uncertain" && m.activeSec === 150));
  assert.ok(!timeline.some((m) => m.kind === "known" && m.activeSec === 180));
});

test("uncertain @150 + accepted R10 @180 => known R10 begins at 180", () => {
  const timeline = collectControllerTimeline({
    workActiveStartSec: 100,
    workActiveEndSecExclusive: 300,
    resistanceActuationEvents: [
      actuationEvent(150, 11, 1, "timeout"),
      actuationEvent(180, 10, 2, "accepted"),
    ],
  });
  assert.deepEqual(
    timeline.filter((m) => m.kind === "known"),
    [{ kind: "known", activeSec: 180, resistance: 10 }]
  );
});

test("uncertain @150 + accepted R11 @180 => known R11 begins at 180", () => {
  const timeline = collectControllerTimeline({
    workActiveStartSec: 100,
    workActiveEndSecExclusive: 300,
    resistanceActuationEvents: [
      actuationEvent(150, 10, 1, "failed"),
      actuationEvent(180, 11, 2, "accepted"),
    ],
  });
  assert.deepEqual(
    timeline.filter((m) => m.kind === "known"),
    [{ kind: "known", activeSec: 180, resistance: 11 }]
  );
});

test("evidence entirely before ambiguity may still qualify if otherwise valid", () => {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  // Long settled hold before ambiguity at 900.
  for (let sec = 600; sec < 900; sec++) {
    hrByActiveSec.set(sec, 158);
    bikeSamples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
  }
  for (let sec = 900; sec < 950; sec++) {
    hrByActiveSec.set(sec, 158);
    bikeSamples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
  }
  const result = evaluateThresholdRegionSettledWorkloadContract({
    ...syntheticDenseHoldFixture(),
    workActiveStartSec: 600,
    workActiveEndSecExclusive: 950,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: [holdAudit(780, 10, 158), holdAudit(840, 10, 158)],
    resistanceActuationEvents: [
      actuationEvent(600, 10, 1, "accepted"),
      actuationEvent(900, 11, 2, "timeout"),
    ],
    actuationCoverage: "complete",
  });
  assert.ok(result.acceptedWindow, "pre-ambiguity hold should qualify");
  assert.equal(result.acceptedWindow.heldResistance, 10);
  assert.ok(result.acceptedWindow.windowEndSecExclusive <= 900);
  assert.ok(!result.acceptedWindow.resolvedGateFailures.includes("ambiguous_actuation_provenance"));
});

test("evidence after accepted re-establishment may qualify if otherwise valid", () => {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  for (let sec = 600; sec < 700; sec++) {
    hrByActiveSec.set(sec, 150);
    bikeSamples.push(bikeSample(sec, { resistance: 9, watts: 100 }));
  }
  // Ambiguity then re-establish R10 with long settled evidence.
  for (let sec = 720; sec < 1100; sec++) {
    hrByActiveSec.set(sec, 158);
    bikeSamples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
  }
  const result = evaluateThresholdRegionSettledWorkloadContract({
    ...syntheticDenseHoldFixture(),
    workActiveStartSec: 600,
    workActiveEndSecExclusive: 1100,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: [holdAudit(900, 10, 158), holdAudit(960, 10, 158), holdAudit(1020, 10, 158)],
    resistanceActuationEvents: [
      actuationEvent(600, 9, 1, "accepted"),
      actuationEvent(700, 10, 2, "timeout"),
      actuationEvent(720, 10, 3, "accepted"),
    ],
    actuationCoverage: "complete",
  });
  assert.ok(result.acceptedWindow);
  assert.equal(result.acceptedWindow.heldResistance, 10);
  assert.equal(result.acceptedWindow.windowStartSec, 720);
  assert.ok(!result.acceptedWindow.resolvedGateFailures.includes("ambiguous_actuation_provenance"));
});

function controllableSettledHoldFixture({
  holdStart = 600,
  holdEndExclusive = 900,
  hrInBandFraction = 0.95,
  wattsStable = true,
  wattsMedian = 114,
  zeroMedianWatts = false,
  policyOverrides = {},
} = {}) {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  const settledFrom = holdStart + THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1.settlingSeconds;
  const settledSecs = [];
  for (let sec = settledFrom; sec < holdEndExclusive; sec++) settledSecs.push(sec);
  const inBandTarget = Math.round(hrInBandFraction * settledSecs.length);
  for (let sec = holdStart; sec < holdEndExclusive; sec++) {
    let hr = 158;
    if (sec >= settledFrom) {
      const idx = sec - settledFrom;
      hr = idx < inBandTarget ? 158 : 140;
    }
    hrByActiveSec.set(sec, hr);
    let watts = wattsMedian;
    if (zeroMedianWatts) {
      watts = 0;
    } else if (!wattsStable) {
      watts = sec % 2 === 0 ? wattsMedian * 0.5 : wattsMedian * 1.5;
    } else {
      // Mild ordinary variability (~5% MAD) without approaching the 0.10 gate.
      watts = wattsMedian + ((sec % 5) - 2);
    }
    bikeSamples.push(bikeSample(sec, { resistance: 10, watts, cadence: 67 }));
  }
  const holds = [];
  for (let t = settledFrom + 30; t < holdEndExclusive; t += 60) {
    holds.push(holdAudit(t, 10, 158));
  }
  return {
    ...syntheticDenseHoldFixture(),
    workActiveStartSec: holdStart,
    workActiveEndSecExclusive: holdEndExclusive,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: holds,
    resistanceActuationEvents: [actuationEvent(holdStart, 10, 1, "accepted")],
    actuationCoverage: "complete",
    policy: {
      ...THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
      ...policyOverrides,
    },
  };
}

test("scientific v1: occupancy exactly at threshold passes; just below fails", () => {
  const at = evaluateThresholdRegionSettledWorkloadContract(
    controllableSettledHoldFixture({ hrInBandFraction: 0.9 })
  );
  assert.ok(at.acceptedWindow);
  assert.ok(Math.abs((at.acceptedWindow.hrInBandFraction ?? 0) - 0.9) < 0.01);
  assert.ok(!at.acceptedWindow.resolvedGateFailures.includes("insufficient_in_band_occupancy"));

  const below = evaluateThresholdRegionSettledWorkloadContract(
    controllableSettledHoldFixture({ hrInBandFraction: 0.89 })
  );
  assert.equal(below.acceptedWindow, null);
  assert.ok(
    below.windows.some((w) => w.resolvedGateFailures.includes("insufficient_in_band_occupancy"))
  );
});

test("scientific v1: MAD ratio exactly at threshold passes; just above fails", () => {
  // Force MAD/median via policy override near a known unstable fixture.
  const stable = evaluateThresholdRegionSettledWorkloadContract(
    controllableSettledHoldFixture({ wattsStable: true })
  );
  assert.ok(stable.acceptedWindow);
  assert.ok((stable.acceptedWindow.measuredWattsMadRatio ?? 1) <= 0.1);

  const unstable = evaluateThresholdRegionSettledWorkloadContract(
    controllableSettledHoldFixture({ wattsStable: false })
  );
  assert.equal(unstable.acceptedWindow, null);
  const uw = unstable.windows.find((w) => w.heldResistance === 10);
  assert.ok(uw);
  assert.ok((uw.measuredWattsMadRatio ?? 0) > 0.1);
  assert.ok(uw.resolvedGateFailures.includes("unstable_measured_workload"));

  // Exact-at-threshold: set policy max equal to the stable window's observed ratio.
  const ratio = stable.acceptedWindow.measuredWattsMadRatio;
  const exact = evaluateThresholdRegionSettledWorkloadContract(
    controllableSettledHoldFixture({
      wattsStable: true,
      policyOverrides: { maxMeasuredWattsMadRatio: ratio },
    })
  );
  assert.ok(exact.acceptedWindow);
  assert.ok(!exact.acceptedWindow.resolvedGateFailures.includes("unstable_measured_workload"));

  const justAbove = evaluateThresholdRegionSettledWorkloadContract(
    controllableSettledHoldFixture({
      wattsStable: true,
      policyOverrides: { maxMeasuredWattsMadRatio: ratio * 0.999 },
    })
  );
  assert.equal(justAbove.acceptedWindow, null);
  assert.ok(
    justAbove.windows.some((w) => w.resolvedGateFailures.includes("unstable_measured_workload"))
  );
});

test("scientific v1: duration exactly at threshold passes; one second below fails", () => {
  // settling 120 + 120 settled = hold length 240 ? endExclusive = start+240
  const at = evaluateThresholdRegionSettledWorkloadContract(
    controllableSettledHoldFixture({ holdStart: 600, holdEndExclusive: 840 })
  );
  assert.ok(at.acceptedWindow);
  assert.equal(at.acceptedWindow.postSettlingDurationSec, 120);

  const below = evaluateThresholdRegionSettledWorkloadContract(
    controllableSettledHoldFixture({ holdStart: 600, holdEndExclusive: 839 })
  );
  assert.equal(below.acceptedWindow, null);
  assert.ok(
    below.windows.some((w) => w.resolvedGateFailures.includes("insufficient_post_settling_duration"))
  );
  assert.equal(
    below.windows.find((w) => w.heldResistance === 10)?.postSettlingDurationSec,
    119
  );
});

test("scientific v1: good occupancy + bad MAD fails; good MAD + bad occupancy fails; short duration fails", () => {
  const badMad = evaluateThresholdRegionSettledWorkloadContract(
    controllableSettledHoldFixture({ hrInBandFraction: 0.95, wattsStable: false })
  );
  assert.equal(badMad.acceptedWindow, null);
  assert.ok(badMad.windows.some((w) => w.resolvedGateFailures.includes("unstable_measured_workload")));

  const badOcc = evaluateThresholdRegionSettledWorkloadContract(
    controllableSettledHoldFixture({ hrInBandFraction: 0.7, wattsStable: true })
  );
  assert.equal(badOcc.acceptedWindow, null);
  assert.ok(badOcc.windows.some((w) => w.resolvedGateFailures.includes("insufficient_in_band_occupancy")));

  const short = evaluateThresholdRegionSettledWorkloadContract(
    controllableSettledHoldFixture({
      holdStart: 600,
      holdEndExclusive: 750,
      hrInBandFraction: 0.95,
      wattsStable: true,
    })
  );
  assert.equal(short.acceptedWindow, null);
  assert.ok(
    short.windows.some((w) => w.resolvedGateFailures.includes("insufficient_post_settling_duration"))
  );
});

test("scientific v1: clear high-quality window passes all three gates and emits descriptive observation", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(
    controllableSettledHoldFixture({
      holdStart: 600,
      holdEndExclusive: 960,
      hrInBandFraction: 0.96,
      wattsStable: true,
    })
  );
  assert.ok(result.acceptedWindow);
  assert.equal(result.acceptedWindow.resolvedGateFailures.length, 0);
  assert.ok(result.acceptedWindow.hrInBandFraction >= 0.9);
  assert.ok(result.acceptedWindow.measuredWattsMadRatio <= 0.1);
  assert.ok(result.acceptedWindow.postSettlingDurationSec >= 120);
  assert.ok(result.observation);
  assert.equal(result.observation.eligibleForPrescription, false);
  assert.equal(result.observation.quality, "unverified");
  assert.equal(result.observation.interpretation, "descriptive_observation_only");
});

test("scientific v1: Oct 16-shaped gap fixture qualifies under chosen thresholds", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(oct16RealGapShapedFixture());
  assert.ok(result.acceptedWindow);
  assert.ok(result.acceptedWindow.hrInBandFraction >= 0.9);
  assert.ok(result.acceptedWindow.measuredWattsMadRatio <= 0.1);
  assert.ok(result.acceptedWindow.postSettlingDurationSec >= 120);
  assert.ok(result.observation);
  assert.equal(result.observation.eligibleForPrescription, false);
});

test("scientific v1: MAD ratio fail-closed for non-positive median watts", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(
    controllableSettledHoldFixture({ zeroMedianWatts: true })
  );
  assert.equal(result.acceptedWindow, null);
  const window = result.windows.find((w) => w.heldResistance === 10);
  assert.ok(window);
  assert.equal(window.measuredWattsMadRatio, null);
  assert.ok(window.resolvedGateFailures.includes("unstable_measured_workload"));
});

test("Threshold adapter rejects injected generic aerobic_base policy", () => {
  const foreign = createSteadyStateSettledWorkloadPolicyV1({
    semanticIdentity: {
      archetype: "steady_state",
      workoutIntent: "aerobic_base",
      intensityId: "aerobic_base",
    },
    overrides: {
      minInBandFraction: 0.9,
      maxMeasuredWattsMadRatio: 0.1,
      minAdviceGradeDurationSec: 120,
    },
  });
  const result = evaluateThresholdRegionSettledWorkloadContract({
    ...syntheticDenseHoldFixture(),
    policy: foreign,
  });
  assert.equal(result.observation, null);
  assert.equal(result.acceptedWindow, null);
  assert.ok(result.identityFailures.includes("intent_not_threshold"));
  assert.ok(result.identityFailures.includes("intensity_not_threshold"));
});

test("Threshold adapter rejects injected generic synthetic schema/provenance policy", () => {
  const foreign = createSteadyStateSettledWorkloadPolicyV1({
    id: "steady-state-settled-workload-policy",
    version: 1,
    semanticIdentity: {
      archetype: "steady_state",
      workoutIntent: "synthetic_steady",
      intensityId: "synthetic_zone",
    },
    contractIdentity: {
      schemaId: "steady-state-settled-workload-observation",
      schemaVersion: 1,
      provenance: "ordinary_workout_settled_steady_state_region",
    },
    overrides: {
      minInBandFraction: 0.9,
      maxMeasuredWattsMadRatio: 0.1,
      minAdviceGradeDurationSec: 120,
    },
  });
  const result = evaluateThresholdRegionSettledWorkloadContract({
    ...syntheticDenseHoldFixture(),
    policy: foreign,
  });
  assert.equal(result.observation, null);
  assert.equal(result.acceptedWindow, null);
  assert.ok(result.identityFailures.includes("intent_not_threshold"));
  assert.ok(result.identityFailures.includes("intensity_not_threshold"));
});

test("Threshold adapter still evaluates under legitimate Threshold science override", () => {
  const policy = createThresholdRegionSettledWorkloadPolicyV1({
    maxMeasuredWattsMadRatio: 0.05,
  });
  assert.equal(policy.id, THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1);
  assert.equal(policy.semanticIdentity.workoutIntent, "threshold");
  assert.equal(policy.contractIdentity.schemaId, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1);
  assert.equal(policy.minInBandFraction, 0.9);
  assert.equal(policy.maxMeasuredWattsMadRatio, 0.05);
  assert.equal(policy.minAdviceGradeDurationSec, 120);

  const result = evaluateThresholdRegionSettledWorkloadContract({
    ...syntheticDenseHoldFixture(),
    policy,
  });
  assert.equal(result.identityFailures.length, 0);
  assert.ok(result.acceptedWindow);
  assert.ok(result.observation);
  assert.equal(result.observation.workoutIntent, "threshold");
  assert.equal(result.observation.schemaId, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1);
  assert.equal(result.observation.provenance, THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1);
});
