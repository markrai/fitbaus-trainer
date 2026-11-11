import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  createSteadyStateSettledWorkloadPolicyV1,
  evaluateSteadyStateSettledWorkloadContract,
  steadyStateSettledPolicyIsProductionReady,
  STEADY_STATE_SETTLED_WORKLOAD_POLICY_V1,
  STEADY_STATE_SETTLED_WORKLOAD_SCHEMA_ID_V1,
  STEADY_STATE_SETTLED_WORKLOAD_PROVENANCE_V1,
} from "../dist/steadyStateSettledWorkload.js";
import { compatibilityKeyFromObservation } from "../dist/steadyStateSettledWorkloadAggregate.js";
import {
  THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
  evaluateThresholdRegionSettledWorkloadContract,
  thresholdRegionSettledPolicyIsProductionReady,
} from "../dist/thresholdRegionSettledWorkload.js";
import {
  PERSONALIZATION_CAPABILITIES_V1,
  steadyStateEvidenceEnabledForIntensity,
  CROSS_INTENT_SAME_INTENSITY_EVIDENCE_SHARING_V1,
} from "../dist/personalizationCapability.js";

const ATHLETE = "afa677b3-9682-4fb9-8f7d-af77375975d7";
const SESSION = "6f4612a2-fe0e-4976-9444-8dc1df81c141";
const ANCHOR = "2026-10-11T18:18:38.106Z";
const ENDED = "2026-10-16T14:59:14.030Z";
const BASE = Date.parse("2026-10-16T14:29:48.416Z");

/** Explicit science — required for observation emission; not conferred by the factory. */
const EXPLICIT_SCIENCE = {
  minInBandFraction: 0.9,
  maxMeasuredWattsMadRatio: 0.1,
  minAdviceGradeDurationSec: 120,
};

function isoAtActiveSec(activeSec) {
  return new Date(BASE + activeSec * 1000).toISOString();
}

function bikeSample(activeSec, { resistance, watts, cadence = 67 }) {
  return {
    schemaVersion: 1,
    athleteId: ATHLETE,
    sessionId: SESSION,
    activeSec,
    observedAt: isoAtActiveSec(activeSec),
    availability: "fresh",
    commandedResistance: resistance,
    desiredResistance: resistance,
    observedResistance: { value: resistance, source: "observed", freshnessMs: 0 },
    watts: { value: watts, source: "measured_watts", freshnessMs: 0 },
    cadenceRpm: { value: cadence, source: "measured", freshnessMs: 0 },
    sourceSampleId: `synth-${activeSec}`,
    freshnessMs: 0,
  };
}

function holdAudit(elapsedSeconds, resistance = 10, representativeHeartRate = 159) {
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
  };
}

function denseHoldInput(intent, intensityId, policy) {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  for (let sec = 600; sec < 1050; sec++) {
    hrByActiveSec.set(sec, 140);
    bikeSamples.push(bikeSample(sec, { resistance: 8, watts: 90 }));
  }
  for (let sec = 1050; sec < 1417; sec++) {
    const hr = sec < 1170 ? 158 : sec < 1300 ? 160 : 157;
    hrByActiveSec.set(sec, hr);
    const watts = sec % 47 === 0 ? 57 : 110 + (sec % 5);
    bikeSamples.push(bikeSample(sec, { resistance: 10, watts, cadence: 66 + (sec % 3) }));
  }
  return {
    expectedAthleteId: ATHLETE,
    sessionId: SESSION,
    athleteId: ATHLETE,
    activity: "bike",
    intent,
    intensityId,
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
    machineDecisionAudit: [
      holdAudit(1170, 10, 159),
      holdAudit(1230, 10, 159),
      holdAudit(1290, 10, 160),
      holdAudit(1350, 10, 157),
    ],
    policy,
  };
}

test("generic reference steady-state policy leaves intensity science unresolved", () => {
  assert.equal(STEADY_STATE_SETTLED_WORKLOAD_POLICY_V1.minInBandFraction, null);
  assert.equal(STEADY_STATE_SETTLED_WORKLOAD_POLICY_V1.maxMeasuredWattsMadRatio, null);
  assert.equal(STEADY_STATE_SETTLED_WORKLOAD_POLICY_V1.minAdviceGradeDurationSec, null);
  assert.equal(steadyStateSettledPolicyIsProductionReady(), false);

  const factoryDefault = createSteadyStateSettledWorkloadPolicyV1({
    semanticIdentity: {
      archetype: "steady_state",
      workoutIntent: "synthetic_steady",
      intensityId: "synthetic_zone",
    },
  });
  assert.equal(factoryDefault.minInBandFraction, null);
  assert.equal(factoryDefault.maxMeasuredWattsMadRatio, null);
  assert.equal(factoryDefault.minAdviceGradeDurationSec, null);
  assert.equal(steadyStateSettledPolicyIsProductionReady(factoryDefault), false);
});

test("Threshold policy explicitly supplies 0.90 / 0.10 / 120 and remains structurally production-ready", () => {
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1.minInBandFraction, 0.9);
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1.maxMeasuredWattsMadRatio, 0.1);
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1.minAdviceGradeDurationSec, 120);
  assert.equal(thresholdRegionSettledPolicyIsProductionReady(), true);
});

test("generic steady_state engine does not require literal threshold semantic identity", () => {
  const policy = createSteadyStateSettledWorkloadPolicyV1({
    semanticIdentity: {
      archetype: "steady_state",
      workoutIntent: "synthetic_steady",
      intensityId: "synthetic_zone",
    },
    overrides: EXPLICIT_SCIENCE,
  });
  assert.notEqual(policy.semanticIdentity.workoutIntent, "threshold");
  assert.notEqual(policy.semanticIdentity.intensityId, "threshold");
  assert.equal(policy.contractIdentity.schemaId, STEADY_STATE_SETTLED_WORKLOAD_SCHEMA_ID_V1);
  assert.equal(policy.contractIdentity.provenance, STEADY_STATE_SETTLED_WORKLOAD_PROVENANCE_V1);

  const result = evaluateSteadyStateSettledWorkloadContract(
    denseHoldInput("synthetic_steady", "synthetic_zone", policy)
  );
  assert.equal(result.identityFailures.length, 0);
  assert.ok(result.acceptedWindow);
  assert.ok(result.observation);
  assert.equal(result.observation.workoutIntent, "synthetic_steady");
  assert.equal(result.observation.intensityId, "synthetic_zone");
  assert.equal(result.observation.archetype, "steady_state");
  assert.equal(result.observation.schemaId, STEADY_STATE_SETTLED_WORKLOAD_SCHEMA_ID_V1);
  assert.equal(result.observation.eligibleForPrescription, false);
  assert.equal(result.observation.interpretation, "descriptive_observation_only");
});

test("synthetic kernel exercise for aerobic_base is algorithm-only — not product activation", () => {
  // Explicit science + synthetic contract: proves the generic engine is
  // configurable. Does NOT authorize Aerobic Base product evidence.
  const policy = createSteadyStateSettledWorkloadPolicyV1({
    id: "synthetic-aerobic-base-test-policy",
    version: 1,
    semanticIdentity: {
      archetype: "steady_state",
      workoutIntent: "aerobic_base",
      intensityId: "aerobic_base",
    },
    contractIdentity: {
      schemaId: "synthetic-aerobic-base-settled-workload-observation",
      schemaVersion: 1,
      provenance: "synthetic_test_only_aerobic_base_region",
    },
    overrides: EXPLICIT_SCIENCE,
  });
  const result = evaluateSteadyStateSettledWorkloadContract(
    denseHoldInput("aerobic_base", "aerobic_base", policy)
  );
  assert.ok(
    result.observation,
    "kernel may emit under explicit synthetic config; this is not product evidence"
  );
  assert.equal(result.observation.provenance, "synthetic_test_only_aerobic_base_region");
  assert.equal(steadyStateEvidenceEnabledForIntensity("aerobic_base"), false);
  const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  assert.equal(existsSync(path.join(srcRoot, "aerobicBaseSettledWorkload.ts")), false);
  assert.equal(existsSync(path.join(srcRoot, "aerobicBaseSettledWorkloadAggregate.ts")), false);
});

test("different semantic lineages stay distinguishable via compatibility keys", () => {
  const thresholdPolicy = THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1;
  const syntheticPolicy = createSteadyStateSettledWorkloadPolicyV1({
    semanticIdentity: {
      archetype: "steady_state",
      workoutIntent: "synthetic_steady",
      intensityId: "synthetic_zone",
    },
    overrides: EXPLICIT_SCIENCE,
  });
  const threshold = evaluateSteadyStateSettledWorkloadContract(
    denseHoldInput("threshold", "threshold", thresholdPolicy)
  );
  const synthetic = evaluateSteadyStateSettledWorkloadContract(
    denseHoldInput("synthetic_steady", "synthetic_zone", syntheticPolicy)
  );
  assert.ok(threshold.observation);
  assert.ok(synthetic.observation);
  const k1 = compatibilityKeyFromObservation(threshold.observation);
  const k2 = compatibilityKeyFromObservation(synthetic.observation);
  assert.notEqual(k1.workoutIntent, k2.workoutIntent);
  assert.notEqual(k1.intensityId, k2.intensityId);
  assert.notEqual(k1.observationSchemaId, k2.observationSchemaId);
});

test("Threshold adapter and generic engine + Threshold config are deeply equivalent", () => {
  const input = denseHoldInput("threshold", "threshold", THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1);
  const viaAdapter = evaluateThresholdRegionSettledWorkloadContract(input);
  const viaGeneric = evaluateSteadyStateSettledWorkloadContract({
    ...input,
    policy: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
  });

  assert.deepEqual(viaAdapter.identityFailures, viaGeneric.identityFailures.map((code) =>
    code === "intent_mismatch" ? "intent_not_threshold"
      : code === "intensity_mismatch" ? "intensity_not_threshold"
        : code
  ));
  assert.equal(viaAdapter.policyProductionReady, viaGeneric.policyProductionReady);
  assert.deepEqual(viaAdapter.unresolvedPolicyFields, viaGeneric.unresolvedPolicyFields);
  assert.equal(viaAdapter.windows.length, viaGeneric.windows.length);
  assert.ok(viaAdapter.acceptedWindow);
  assert.ok(viaGeneric.acceptedWindow);
  assert.equal(viaAdapter.acceptedWindow.windowStartSec, viaGeneric.acceptedWindow.windowStartSec);
  assert.equal(viaAdapter.acceptedWindow.settledFromSec, viaGeneric.acceptedWindow.settledFromSec);
  assert.equal(viaAdapter.acceptedWindow.heldResistance, viaGeneric.acceptedWindow.heldResistance);
  assert.equal(
    viaAdapter.acceptedWindow.qualifyingSampleCount,
    viaGeneric.acceptedWindow.qualifyingSampleCount
  );
  assert.equal(
    viaAdapter.acceptedWindow.postSettlingDurationSec,
    viaGeneric.acceptedWindow.postSettlingDurationSec
  );
  assert.equal(viaAdapter.acceptedWindow.hrMedian, viaGeneric.acceptedWindow.hrMedian);
  assert.equal(viaAdapter.acceptedWindow.hrInBandFraction, viaGeneric.acceptedWindow.hrInBandFraction);
  assert.equal(
    viaAdapter.acceptedWindow.measuredWattsMedian,
    viaGeneric.acceptedWindow.measuredWattsMedian
  );
  assert.equal(viaAdapter.acceptedWindow.measuredWattsMad, viaGeneric.acceptedWindow.measuredWattsMad);
  assert.equal(
    viaAdapter.acceptedWindow.measuredWattsMadRatio,
    viaGeneric.acceptedWindow.measuredWattsMadRatio
  );
  assert.ok(viaAdapter.observation);
  assert.ok(viaGeneric.observation);
  assert.equal(viaAdapter.observation.schemaId, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1);
  assert.equal(viaGeneric.observation.schemaId, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1);
  assert.equal(viaAdapter.observation.provenance, THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1);
  assert.deepEqual(
    { ...viaAdapter.observation },
    { ...viaGeneric.observation }
  );
});

test("capability table enables only Threshold completed-workout evidence", () => {
  assert.equal(steadyStateEvidenceEnabledForIntensity("threshold"), true);
  for (const id of ["aerobic_base", "vo2_short", "vo2_long", "recovery"]) {
    assert.equal(steadyStateEvidenceEnabledForIntensity(id), false, id);
  }
  const byId = Object.fromEntries(
    PERSONALIZATION_CAPABILITIES_V1.map((row) => [row.intensityId, row])
  );
  assert.equal(byId.aerobic_base.archetype, "steady_state");
  assert.equal(byId.aerobic_base.completedWorkoutEvidence, false);
  assert.equal(byId.threshold.archetype, "steady_state");
  assert.equal(byId.threshold.completedWorkoutEvidence, true);
  assert.equal(byId.vo2_short.archetype, "interval");
  assert.equal(byId.vo2_long.archetype, "interval");
  assert.equal(byId.recovery.archetype, "recovery");
  assert.equal(CROSS_INTENT_SAME_INTENSITY_EVIDENCE_SHARING_V1, "unresolved");
});

test("wrong intent against Threshold policy fails closed without emitting observation", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(
    denseHoldInput("aerobic_base", "aerobic_base", THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1)
  );
  assert.ok(result.identityFailures.includes("intent_not_threshold"));
  assert.ok(result.identityFailures.includes("intensity_not_threshold"));
  assert.equal(result.observation, null);
  assert.equal(result.acceptedWindow, null);
});
