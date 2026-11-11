import test from "node:test";
import assert from "node:assert/strict";

import {
  THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1,
  createThresholdRegionSettledWorkloadAggregatePolicyV1,
  evaluateThresholdRegionSettledWorkloadAggregate,
  thresholdRegionAggregatePolicyIsProductionReady,
  summarizeSessionMedianSeries,
  classifyCrossSessionTrend,
  workoutDateFromSessionEndedAt,
  compatibilityKeyFromObservation,
} from "../dist/thresholdRegionSettledWorkloadAggregate.js";
import {
  STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
  evaluateSteadyStateSettledWorkloadAggregate,
} from "../dist/steadyStateSettledWorkloadAggregate.js";
import {
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1,
  THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_ID_V1,
} from "../dist/thresholdRegionSettledWorkload.js";
import { PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1 } from "../dist/types.js";

const ATHLETE = "afa677b3-9682-4fb9-8f7d-af77375975d7";
const ANCHOR = "2026-10-11T18:18:38.106Z";
const MACHINE = "proform-smart-power-10";

function observation({
  sessionId = "session-a",
  workoutDate = "2026-10-16",
  athleteId = ATHLETE,
  machineId = MACHINE,
  machineProfileVersion = 1,
  formalAnchorObservedAt = ANCHOR,
  targetHrMin = 155,
  targetHrMax = 162,
  measuredWattsMedian = 114,
  measuredWattsMad = 6,
  hrMedian = 158,
  hrInBandFraction = 0.96,
  heldResistance = 10,
  postSettlingDurationSec = 246,
  settledFromSec,
  qualifyingDurationSec,
  windowStartSec = 1051,
  windowEndSecExclusive,
  hrCoverageRatio = 1,
  measuredWattsSampleCount = 180,
  measuredWattsCoverageRatio = 0.83,
  cadenceMedian = 67,
  cadenceCoverageRatio = 0.83,
  sessionEndedAt,
  admissionPolicyId = THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1,
  admissionPolicyVersion = THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1,
  schemaId = THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
  schemaVersion = THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
  provenance = THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
  workoutIntent = "threshold",
  intensityId = "threshold",
  archetype = "steady_state",
  workoutDateSpoof,
} = {}) {
  const ended = sessionEndedAt ?? `${workoutDate}T15:00:00.000Z`;
  const row = {
    schemaId,
    schemaVersion,
    provenance,
    admissionPolicyId,
    admissionPolicyVersion,
    athleteId,
    sessionId,
    machineId,
    machineProfileVersion,
    workoutIntent,
    intensityId,
    archetype,
    targetHrMin,
    targetHrMax,
    windowStartSec,
    windowEndSecExclusive: windowEndSecExclusive ?? windowStartSec + postSettlingDurationSec + 120,
    settledFromSec: settledFromSec ?? windowStartSec + 120,
    qualifyingDurationSec: qualifyingDurationSec ?? Math.min(postSettlingDurationSec, 200),
    postSettlingDurationSec,
    heldResistance,
    hrMedian,
    hrInBandFraction,
    hrCoverageRatio,
    measuredWattsMedian,
    measuredWattsMad,
    measuredWattsSampleCount,
    measuredWattsCoverageRatio,
    cadenceMedian,
    cadenceCoverageRatio,
    controllerSettledProvenance: "controller_held_resistance_plus_target_hold_audit",
    formalAnchorObservedAt,
    sessionEndedAt: ended,
    quality: "unverified",
    eligibleForPrescription: false,
    interpretation: "descriptive_observation_only",
  };
  if (workoutDateSpoof !== undefined) row.workoutDate = workoutDateSpoof;
  return row;
}

function completePolicy(overrides = {}) {
  return createThresholdRegionSettledWorkloadAggregatePolicyV1({
    maxCrossSessionMadRatio: 0.08,
    maxObservationAgeDays: 90,
    ...overrides,
  });
}

function threeStable(overrides = {}) {
  return [
    observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 112, ...overrides }),
    observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114, ...overrides }),
    observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 116, ...overrides }),
  ];
}

test("aggregate identities are distinct from single-session, Phase D, and E1 resolver", () => {
  assert.equal(
    THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1,
    "threshold-region-settled-workload-aggregate"
  );
  assert.notEqual(
    THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1,
    THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1
  );
  assert.notEqual(
    THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_ID_V1,
    PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1
  );
  assert.equal(
    THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1,
    "ordinary_workout_settled_threshold_region_aggregate"
  );
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.minSessions, 3);
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.minDistinctDates, 3);
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.maxCrossSessionMadRatio, null);
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.maxObservationAgeDays, null);
  assert.equal(thresholdRegionAggregatePolicyIsProductionReady(), false);
});

test("default policy remains non-emitting until unresolved scientific fields are set", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable(),
  });
  assert.equal(result.policyProductionReady, false);
  assert.ok(result.unresolvedPolicyFields.includes("maxCrossSessionMadRatio"));
  assert.ok(result.unresolvedPolicyFields.includes("maxObservationAgeDays"));
  assert.ok(result.failures.includes("policy_threshold_unresolved"));
  assert.equal(result.aggregate, null);
  assert.equal(result.diagnostics.aggregateMeasuredWattsMedian, 114);
});

test("compatibility key reads admission policy from observation payload, not module constants", () => {
  const obs = observation({
    admissionPolicyId: "threshold-region-settled-workload-policy",
    admissionPolicyVersion: 1,
  });
  const key = compatibilityKeyFromObservation(obs);
  assert.equal(key.admissionPolicyId, obs.admissionPolicyId);
  assert.equal(key.admissionPolicyVersion, obs.admissionPolicyVersion);
});

test("different admission policy version fails observation-family identity (not mixed lineage)", () => {
  // admissionPolicyVersion is part of configured observationIdentity — foreign
  // versions are invalid inputs to the Threshold aggregate, not a second lineage.
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({
        sessionId: "s1",
        workoutDate: "2026-10-12",
        measuredWattsMedian: 114,
        admissionPolicyVersion: 1,
      }),
      observation({
        sessionId: "s2",
        workoutDate: "2026-10-14",
        measuredWattsMedian: 114,
        admissionPolicyVersion: 1,
      }),
      observation({
        sessionId: "s3",
        workoutDate: "2026-10-16",
        measuredWattsMedian: 114,
        admissionPolicyVersion: 2,
      }),
    ],
    policy: completePolicy(),
  });
  const foreign = result.rejected.find((r) => r.sessionId === "s3");
  assert.ok(foreign);
  assert.ok(foreign.failures.includes("invalid_observation_payload"));
  assert.equal(result.acceptedObservations.length, 2);
  assert.equal(result.aggregate, null);
  assert.ok(result.failures.includes("insufficient_observations"));
});

test("wrong athlete rejects", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      ...threeStable().slice(0, 2),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", athleteId: "other-athlete" }),
    ],
    policy: completePolicy(),
  });
  assert.ok(result.failures.includes("mixed_compatibility_lineage"));
  assert.equal(result.aggregate, null);
});

test("wrong machine / profile rejects", () => {
  const machine = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      ...threeStable().slice(0, 2),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", machineId: "other-bike" }),
    ],
    policy: completePolicy(),
  });
  assert.ok(machine.failures.includes("mixed_compatibility_lineage"));

  const profile = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      ...threeStable().slice(0, 2),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", machineProfileVersion: 2 }),
    ],
    expectedCompatibility: compatibilityKeyFromObservation(threeStable()[0]),
    policy: completePolicy(),
  });
  assert.ok(profile.rejected.some((r) => r.failures.includes("incompatible_machine_profile")));
});

test("different target HR band rejects", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      ...threeStable().slice(0, 2),
      observation({
        sessionId: "s3",
        workoutDate: "2026-10-16",
        targetHrMin: 150,
        targetHrMax: 157,
      }),
    ],
    expectedCompatibility: compatibilityKeyFromObservation(threeStable()[0]),
    policy: completePolicy(),
  });
  assert.ok(result.rejected.some((r) => r.failures.includes("incompatible_target_hr_band")));
});

test("new formal anchor starts a new lineage", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      ...threeStable().slice(0, 2),
      observation({
        sessionId: "s3",
        workoutDate: "2026-10-16",
        formalAnchorObservedAt: "2026-10-15T12:00:00.000Z",
      }),
    ],
    expectedCompatibility: compatibilityKeyFromObservation(threeStable()[0]),
    policy: completePolicy(),
  });
  assert.ok(result.rejected.some((r) => r.failures.includes("incompatible_formal_anchor")));
  assert.equal(result.acceptedObservations.length, 2);
});

function summarizeDuplicateResult(result) {
  return {
    accepted: result.acceptedObservations.map((o) => ({
      sessionId: o.sessionId,
      measuredWattsMedian: o.measuredWattsMedian,
      postSettlingDurationSec: o.postSettlingDurationSec,
      qualifyingDurationSec: o.qualifyingDurationSec,
      settledFromSec: o.settledFromSec,
      hrCoverageRatio: o.hrCoverageRatio,
      measuredWattsCoverageRatio: o.measuredWattsCoverageRatio,
      cadenceMedian: o.cadenceMedian,
      cadenceCoverageRatio: o.cadenceCoverageRatio,
    })),
    rejected: [...result.rejected]
      .map((r) => ({ sessionId: r.sessionId, failures: [...r.failures].sort() }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    diagnostics: {
      sessionMeasuredWattsMedians: result.diagnostics.sessionMeasuredWattsMedians,
      aggregateMeasuredWattsMedian: result.diagnostics.aggregateMeasuredWattsMedian,
      distinctDateCount: result.diagnostics.distinctDateCount,
    },
    aggregate: result.aggregate,
    failures: [...result.failures].sort(),
  };
}

test("identical duplicate session collapses; contradictory duplicate fails session", () => {
  const identical = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 112 }),
      observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 112 }),
      observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114 }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 116 }),
    ],
    policy: completePolicy(),
  });
  assert.ok(identical.rejected.some((r) => r.failures.includes("duplicate_session_id")));
  assert.equal(identical.acceptedObservations.length, 3);
  assert.deepEqual(
    identical.acceptedObservations.map((o) => o.measuredWattsMedian),
    [112, 114, 116]
  );

  const contradictoryA = [
    observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 112 }),
    observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 130 }),
    observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114 }),
    observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 116 }),
  ];
  const contradictoryB = [...contradictoryA].reverse();
  const left = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: contradictoryA,
    policy: completePolicy(),
  });
  const right = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: contradictoryB,
    policy: completePolicy(),
  });
  assert.ok(left.rejected.some((r) => r.failures.includes("contradictory_duplicate_session")));
  assert.ok(right.rejected.some((r) => r.failures.includes("contradictory_duplicate_session")));
  assert.deepEqual(summarizeDuplicateResult(left), summarizeDuplicateResult(right));
  assert.equal(left.aggregate, null);
});

test("canonical-field-only contradictions fail session regardless of input order", () => {
  const companions = [
    observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114 }),
    observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 116 }),
  ];
  const baseS1 = {
    sessionId: "s1",
    workoutDate: "2026-10-12",
    measuredWattsMedian: 112,
    sessionEndedAt: "2026-10-12T15:00:00.000Z",
    windowStartSec: 1051,
    settledFromSec: 1171,
    postSettlingDurationSec: 246,
    qualifyingDurationSec: 200,
    hrCoverageRatio: 1,
    measuredWattsCoverageRatio: 0.83,
    cadenceMedian: 67,
    cadenceCoverageRatio: 0.83,
  };
  const fieldCases = [
    ["postSettlingDurationSec", { postSettlingDurationSec: 200 }],
    ["qualifyingDurationSec", { qualifyingDurationSec: 150 }],
    ["hrCoverageRatio", { hrCoverageRatio: 0.9 }],
    ["measuredWattsCoverageRatio", { measuredWattsCoverageRatio: 0.75 }],
    ["cadenceMedian", { cadenceMedian: 70 }],
    ["cadenceCoverageRatio", { cadenceCoverageRatio: 0.75 }],
    ["settledFromSec", { settledFromSec: 1180 }],
  ];

  for (const [label, delta] of fieldCases) {
    const a = observation(baseS1);
    const b = observation({ ...baseS1, ...delta });
    const forward = evaluateThresholdRegionSettledWorkloadAggregate({
      observations: [a, b, ...companions],
      policy: completePolicy(),
    });
    const reverse = evaluateThresholdRegionSettledWorkloadAggregate({
      observations: [b, a, ...companions],
      policy: completePolicy(),
    });
    assert.ok(
      forward.rejected.some(
        (r) => r.sessionId === "s1" && r.failures.includes("contradictory_duplicate_session")
      ),
      `${label}: should be contradictory`
    );
    assert.ok(
      !forward.acceptedObservations.some((o) => o.sessionId === "s1"),
      `${label}: s1 must contribute zero`
    );
    assert.deepEqual(
      summarizeDuplicateResult(forward),
      summarizeDuplicateResult(reverse),
      `${label}: reversed input must match`
    );
  }
});

test("field-equivalent duplicate still collapses to one contribution", () => {
  const twinA = observation({
    sessionId: "s1",
    workoutDate: "2026-10-12",
    measuredWattsMedian: 112,
    postSettlingDurationSec: 246,
    qualifyingDurationSec: 200,
    settledFromSec: 1171,
    hrCoverageRatio: 1,
    measuredWattsCoverageRatio: 0.83,
    cadenceMedian: 67,
    cadenceCoverageRatio: 0.83,
  });
  const twinB = observation({
    sessionId: "s1",
    workoutDate: "2026-10-12",
    measuredWattsMedian: 112,
    postSettlingDurationSec: 246,
    qualifyingDurationSec: 200,
    settledFromSec: 1171,
    hrCoverageRatio: 1,
    measuredWattsCoverageRatio: 0.83,
    cadenceMedian: 67,
    cadenceCoverageRatio: 0.83,
  });
  const forward = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      twinA,
      twinB,
      observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114 }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 116 }),
    ],
    policy: completePolicy(),
  });
  const reverse = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      twinB,
      twinA,
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 116 }),
      observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114 }),
    ],
    policy: completePolicy(),
  });
  assert.ok(forward.rejected.some((r) => r.failures.includes("duplicate_session_id")));
  assert.equal(forward.acceptedObservations.filter((o) => o.sessionId === "s1").length, 1);
  assert.ok(forward.aggregate);
  assert.deepEqual(summarizeDuplicateResult(forward), summarizeDuplicateResult(reverse));
});

test("minimum-session and minimum-date boundaries", () => {
  const twoSessions = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable().slice(0, 2),
    policy: completePolicy(),
  });
  assert.ok(twoSessions.failures.includes("insufficient_observations"));
  assert.equal(twoSessions.aggregate, null);

  const threeSameDate = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-10-16", measuredWattsMedian: 112 }),
      observation({ sessionId: "s2", workoutDate: "2026-10-16", measuredWattsMedian: 114 }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 116 }),
    ],
    policy: completePolicy(),
  });
  assert.ok(threeSameDate.failures.includes("insufficient_distinct_dates"));
  assert.equal(threeSameDate.aggregate, null);

  const exactlyThree = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable(),
    policy: completePolicy(),
  });
  assert.ok(exactlyThree.aggregate);
  assert.equal(exactlyThree.aggregate.sessionCount, 3);
  assert.equal(exactlyThree.aggregate.distinctDateCount, 3);
});

test("stable repeated watts pass under complete policy and are shadow-candidate eligible", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable(),
    policy: completePolicy(),
  });
  assert.equal(result.policyProductionReady, true);
  assert.ok(result.aggregate);
  assert.equal(result.aggregate.aggregateMeasuredWattsMedian, 114);
  assert.equal(result.aggregate.interpretation, "descriptive_aggregate_only");
  assert.equal(result.aggregate.eligibleForPrescription, false);
  assert.equal(result.aggregate.eligibleForShadowCandidate, true);
  assert.equal(result.aggregate.quality, "unverified");
  assert.equal(result.aggregate.schemaId, THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1);
  assert.ok(result.aggregate.crossSessionWattsMadRatio <= 0.08);
  assert.equal(
    result.aggregate.admissionPolicyId,
    THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1
  );
});

test("single outlier handling via median; unstable cross-session watts fail", () => {
  const withOutlier = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 112 }),
      observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114 }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 150 }),
    ],
    policy: completePolicy({ maxCrossSessionMadRatio: 0.05 }),
  });
  assert.equal(withOutlier.diagnostics.aggregateMeasuredWattsMedian, 114);
  assert.ok((withOutlier.diagnostics.crossSessionWattsMadRatio ?? 1) < 0.05);
  assert.ok(withOutlier.aggregate);

  const unstable = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 105 }),
      observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114 }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 123 }),
    ],
    policy: completePolicy({ maxCrossSessionMadRatio: 0.05 }),
  });
  assert.equal(unstable.diagnostics.aggregateMeasuredWattsMedian, 114);
  assert.ok((unstable.diagnostics.crossSessionWattsMadRatio ?? 0) > 0.05);
  assert.ok(unstable.failures.includes("unstable_cross_session_workload"));
  assert.equal(unstable.aggregate, null);

  const mild = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable(),
    policy: completePolicy({ maxCrossSessionMadRatio: 0.05 }),
  });
  assert.ok(mild.aggregate);
});

test("trend is diagnostic only under v1 policy", () => {
  assert.equal(classifyCrossSessionTrend([100, 105, 110, 115]), "rising");
  assert.equal(classifyCrossSessionTrend([115, 110, 105, 100]), "falling");
  assert.equal(classifyCrossSessionTrend([110, 114, 112]), "mixed");
  assert.equal(classifyCrossSessionTrend([114, 114, 114]), "flat");

  const rising = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 100 }),
      observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 105 }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 110 }),
      observation({ sessionId: "s4", workoutDate: "2026-10-18", measuredWattsMedian: 115 }),
    ],
    policy: completePolicy({ maxCrossSessionMadRatio: 0.2 }),
  });
  assert.equal(rising.diagnostics.trendDirection, "rising");
  assert.ok(rising.aggregate);
  assert.equal(rising.aggregate.trendDirection, "rising");
});

test("same watts across incompatible machines still reject on provenance", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 114 }),
      observation({
        sessionId: "s2",
        workoutDate: "2026-10-14",
        measuredWattsMedian: 114,
        machineId: "other-machine",
      }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 114 }),
    ],
    policy: completePolicy(),
  });
  assert.ok(result.failures.includes("mixed_compatibility_lineage"));
  assert.equal(result.aggregate, null);
});

test("mixed-lineage input order cannot change selected lineage", () => {
  // Stay inside Threshold observationIdentity; mix athlete/machine lineage via anchors.
  const mixed = [
    observation({
      sessionId: "s1",
      workoutDate: "2026-10-12",
      measuredWattsMedian: 112,
      formalAnchorObservedAt: ANCHOR,
    }),
    observation({
      sessionId: "s2",
      workoutDate: "2026-10-14",
      measuredWattsMedian: 114,
      formalAnchorObservedAt: "2026-10-12T12:00:00.000Z",
    }),
    observation({
      sessionId: "s3",
      workoutDate: "2026-10-16",
      measuredWattsMedian: 116,
      formalAnchorObservedAt: ANCHOR,
    }),
  ];
  const forward = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: mixed,
    policy: completePolicy(),
  });
  const reverse = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [...mixed].reverse(),
    policy: completePolicy(),
  });
  assert.equal(forward.compatibility, null);
  assert.equal(reverse.compatibility, null);
  assert.deepEqual(forward.failures.sort(), reverse.failures.sort());
  assert.equal(forward.aggregate, null);
  assert.equal(reverse.aggregate, null);
  assert.equal(forward.acceptedObservations.length, 0);
  assert.equal(reverse.acceptedObservations.length, 0);
});

test("date is derived deterministically from absolute sessionEndedAt; non-absolute and spoofed dates reject", () => {
  assert.equal(
    workoutDateFromSessionEndedAt("2026-10-16T14:59:14.030Z"),
    "2026-10-16"
  );
  assert.equal(
    workoutDateFromSessionEndedAt("2026-10-17T03:30:00.000Z"),
    "2026-10-17"
  );
  assert.equal(workoutDateFromSessionEndedAt("not-a-date"), null);
  assert.equal(workoutDateFromSessionEndedAt("2026-10-16T23:30:00"), null);
  assert.equal(workoutDateFromSessionEndedAt("2026-10-16"), null);
  assert.equal(workoutDateFromSessionEndedAt("10/16/2026 23:30"), null);
  assert.equal(workoutDateFromSessionEndedAt("2026-10-16T23:30:00-04:00"), null);
  assert.equal(workoutDateFromSessionEndedAt("2026-10-16T23:30:00Z"), null);
  assert.equal(workoutDateFromSessionEndedAt(""), null);

  const rejects = [
    ["yesterday", "yesterday"],
    ["offsetless", "2026-10-16T23:30:00"],
    ["date-only", "2026-10-16"],
    ["locale", "10/16/2026 23:30"],
    ["offset", "2026-10-16T23:30:00-04:00"],
  ];
  for (const [label, sessionEndedAt] of rejects) {
    const malformed = evaluateThresholdRegionSettledWorkloadAggregate({
      observations: [
        observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 112 }),
        observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114 }),
        observation({
          sessionId: "s3",
          workoutDate: "2026-10-16",
          measuredWattsMedian: 116,
          sessionEndedAt,
        }),
      ],
      policy: completePolicy(),
    });
    assert.ok(
      malformed.rejected.some(
        (r) => r.sessionId === "s3" && r.failures.includes("invalid_observation_payload")
      ),
      `${label} should reject`
    );
  }

  const spoofed = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 112 }),
      observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114 }),
      observation({
        sessionId: "s3",
        workoutDate: "2026-10-16",
        measuredWattsMedian: 116,
        workoutDateSpoof: "2026-10-01",
      }),
    ],
    policy: completePolicy(),
  });
  assert.ok(
    spoofed.rejected.some(
      (r) => r.sessionId === "s3" && r.failures.includes("invalid_observation_payload")
    )
  );

  const ok = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable(),
    policy: completePolicy(),
  });
  assert.deepEqual(ok.aggregate.workoutDates, ["2026-10-12", "2026-10-14", "2026-10-16"]);
});

test("sensitivity helper matches design matrix medians", () => {
  const cases = [
    { watts: [114], expectMedian: 114 },
    { watts: [114, 115], expectMedian: 114.5 },
    { watts: [112, 114, 116], expectMedian: 114 },
    { watts: [105, 114, 123], expectMedian: 114 },
    { watts: [112, 114, 150], expectMedian: 114 },
    { watts: [110, 114, 118, 120], expectMedian: 116 },
    { watts: [100, 105, 110, 115], expectMedian: 107.5 },
  ];
  for (const c of cases) {
    const summary = summarizeSessionMedianSeries(c.watts);
    assert.equal(summary.median, c.expectMedian, `watts=${c.watts}`);
  }
});

test("stale observation fails when age gate is set", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-01-01", measuredWattsMedian: 112 }),
      observation({ sessionId: "s2", workoutDate: "2026-01-08", measuredWattsMedian: 114 }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 116 }),
    ],
    policy: completePolicy({ maxObservationAgeDays: 60 }),
    asOfDate: "2026-10-16",
  });
  assert.ok(result.failures.includes("stale_observation"));
  assert.equal(result.aggregate, null);
});

test("same valid lineage still computes median/MAD diagnostics under default unresolved policy", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable(),
  });
  assert.equal(result.diagnostics.aggregateMeasuredWattsMedian, 114);
  assert.ok(result.diagnostics.crossSessionWattsMad != null);
  assert.ok(result.diagnostics.crossSessionWattsMadRatio != null);
  assert.equal(result.aggregate, null);
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.maxCrossSessionMadRatio, null);
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.maxObservationAgeDays, null);
});

test("Threshold aggregate observationIdentity declares Threshold single-session family", () => {
  const id = THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.observationIdentity;
  assert.equal(id.semanticIdentity.workoutIntent, "threshold");
  assert.equal(id.semanticIdentity.intensityId, "threshold");
  assert.equal(id.semanticIdentity.archetype, "steady_state");
  assert.equal(id.contractIdentity.schemaId, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1);
  assert.equal(id.contractIdentity.schemaVersion, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1);
  assert.equal(id.contractIdentity.provenance, THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1);
  assert.equal(id.admissionPolicyId, THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1);
  assert.equal(id.admissionPolicyVersion, THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1);
  assert.notEqual(
    THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.contractIdentity.schemaId,
    id.contractIdentity.schemaId,
    "aggregate output identity ≠ accepted input observation identity"
  );
});

function assertWrongFamilyRejected(label, mutate) {
  test(`Threshold aggregate rejects wrong observation ${label}`, () => {
    const rows = threeStable().map((row, index) => mutate({ ...row }, index));
    const result = evaluateThresholdRegionSettledWorkloadAggregate({
      observations: rows,
      policy: completePolicy(),
    });
    assert.equal(result.acceptedObservations.length, 0, label);
    assert.equal(result.aggregate, null, label);
    assert.ok(
      result.rejected.every((r) => r.failures.includes("invalid_observation_payload")),
      label
    );
    assert.ok(result.failures.includes("insufficient_observations") || result.failures.length > 0, label);
  });
}

assertWrongFamilyRejected("schemaId", (row) => {
  row.schemaId = "steady-state-settled-workload-observation";
  return row;
});
assertWrongFamilyRejected("schemaVersion", (row) => {
  row.schemaVersion = 2;
  return row;
});
assertWrongFamilyRejected("provenance", (row) => {
  row.provenance = "ordinary_workout_settled_steady_state_region";
  return row;
});
assertWrongFamilyRejected("workoutIntent", (row) => {
  row.workoutIntent = "aerobic_base";
  return row;
});
assertWrongFamilyRejected("intensityId", (row) => {
  row.intensityId = "aerobic_base";
  return row;
});
assertWrongFamilyRejected("archetype", (row) => {
  row.archetype = "interval";
  return row;
});
assertWrongFamilyRejected("admissionPolicyId", (row) => {
  row.admissionPolicyId = "steady-state-settled-workload-policy";
  return row;
});
assertWrongFamilyRejected("admissionPolicyVersion", (row) => {
  row.admissionPolicyVersion = 2;
  return row;
});

test("Threshold aggregate rejects homogeneous generic/synthetic steady-state observations", () => {
  const synthetic = [
    observation({
      sessionId: "s1",
      workoutDate: "2026-10-12",
      measuredWattsMedian: 112,
      schemaId: "steady-state-settled-workload-observation",
      schemaVersion: 1,
      provenance: "ordinary_workout_settled_steady_state_region",
      workoutIntent: "steady_state_reference",
      intensityId: "steady_state_reference",
      archetype: "steady_state",
      admissionPolicyId: "steady-state-settled-workload-policy",
      admissionPolicyVersion: 1,
    }),
    observation({
      sessionId: "s2",
      workoutDate: "2026-10-14",
      measuredWattsMedian: 114,
      schemaId: "steady-state-settled-workload-observation",
      schemaVersion: 1,
      provenance: "ordinary_workout_settled_steady_state_region",
      workoutIntent: "steady_state_reference",
      intensityId: "steady_state_reference",
      archetype: "steady_state",
      admissionPolicyId: "steady-state-settled-workload-policy",
      admissionPolicyVersion: 1,
    }),
    observation({
      sessionId: "s3",
      workoutDate: "2026-10-16",
      measuredWattsMedian: 116,
      schemaId: "steady-state-settled-workload-observation",
      schemaVersion: 1,
      provenance: "ordinary_workout_settled_steady_state_region",
      workoutIntent: "steady_state_reference",
      intensityId: "steady_state_reference",
      archetype: "steady_state",
      admissionPolicyId: "steady-state-settled-workload-policy",
      admissionPolicyVersion: 1,
    }),
  ];
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: synthetic,
    policy: completePolicy(),
  });
  assert.equal(result.acceptedObservations.length, 0);
  assert.equal(result.aggregate, null);
  assert.equal(result.rejected.length, 3);
  assert.ok(result.rejected.every((r) => r.failures.includes("invalid_observation_payload")));
});

function threeGenericSteadyStateObservations() {
  return [
    observation({
      sessionId: "s1",
      workoutDate: "2026-10-12",
      measuredWattsMedian: 112,
      schemaId: "steady-state-settled-workload-observation",
      schemaVersion: 1,
      provenance: "ordinary_workout_settled_steady_state_region",
      workoutIntent: "steady_state_reference",
      intensityId: "steady_state_reference",
      archetype: "steady_state",
      admissionPolicyId: "steady-state-settled-workload-policy",
      admissionPolicyVersion: 1,
    }),
    observation({
      sessionId: "s2",
      workoutDate: "2026-10-14",
      measuredWattsMedian: 114,
      schemaId: "steady-state-settled-workload-observation",
      schemaVersion: 1,
      provenance: "ordinary_workout_settled_steady_state_region",
      workoutIntent: "steady_state_reference",
      intensityId: "steady_state_reference",
      archetype: "steady_state",
      admissionPolicyId: "steady-state-settled-workload-policy",
      admissionPolicyVersion: 1,
    }),
    observation({
      sessionId: "s3",
      workoutDate: "2026-10-16",
      measuredWattsMedian: 116,
      schemaId: "steady-state-settled-workload-observation",
      schemaVersion: 1,
      provenance: "ordinary_workout_settled_steady_state_region",
      workoutIntent: "steady_state_reference",
      intensityId: "steady_state_reference",
      archetype: "steady_state",
      admissionPolicyId: "steady-state-settled-workload-policy",
      admissionPolicyVersion: 1,
    }),
  ];
}

test("Threshold aggregate rejects matching generic policy + homogeneous generic observations", () => {
  const observations = threeGenericSteadyStateObservations();
  const genericPolicy = {
    ...STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
    maxCrossSessionMadRatio: 0.08,
    maxObservationAgeDays: 90,
  };
  // Generic kernel may accept this family when called directly.
  const viaGeneric = evaluateSteadyStateSettledWorkloadAggregate({
    observations,
    policy: genericPolicy,
  });
  assert.ok(viaGeneric.acceptedObservations.length >= 3);
  assert.equal(viaGeneric.failures.includes("policy_threshold_unresolved"), false);
  // But the named Threshold adapter must not accept the foreign policy/family.
  const viaThreshold = evaluateThresholdRegionSettledWorkloadAggregate({
    observations,
    policy: genericPolicy,
  });
  assert.equal(viaThreshold.acceptedObservations.length, 0);
  assert.equal(viaThreshold.aggregate, null);
  assert.ok(viaThreshold.rejected.every((r) => r.failures.includes("invalid_observation_payload")));
});

test("Threshold aggregate rejects attempts to replace observationIdentity", () => {
  const foreign = {
    ...THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
    maxCrossSessionMadRatio: 0.08,
    maxObservationAgeDays: 90,
    observationIdentity: {
      ...STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.observationIdentity,
    },
  };
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable(),
    policy: foreign,
  });
  assert.equal(result.acceptedObservations.length, 0);
  assert.equal(result.aggregate, null);
});

test("Threshold aggregate rejects attempts to replace contractIdentity", () => {
  const foreign = {
    ...THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
    maxCrossSessionMadRatio: 0.08,
    maxObservationAgeDays: 90,
    contractIdentity: {
      ...STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.contractIdentity,
    },
  };
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable(),
    policy: foreign,
  });
  assert.equal(result.acceptedObservations.length, 0);
  assert.equal(result.aggregate, null);
});

test("Threshold aggregate rejects attempts to replace aggregate policy id/version", () => {
  const foreignId = {
    ...THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
    maxCrossSessionMadRatio: 0.08,
    maxObservationAgeDays: 90,
    id: "steady-state-settled-workload-aggregate-policy",
  };
  const foreignVersion = {
    ...THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
    maxCrossSessionMadRatio: 0.08,
    maxObservationAgeDays: 90,
    version: 2,
  };
  for (const policy of [foreignId, foreignVersion]) {
    const result = evaluateThresholdRegionSettledWorkloadAggregate({
      observations: threeStable(),
      policy,
    });
    assert.equal(result.acceptedObservations.length, 0);
    assert.equal(result.aggregate, null);
  }
});

test("Threshold aggregate builder preserves identity under sensitivity overrides", () => {
  const policy = createThresholdRegionSettledWorkloadAggregatePolicyV1({
    maxCrossSessionMadRatio: 0.08,
    maxObservationAgeDays: 90,
    minSessions: 2,
    minDistinctDates: 2,
  });
  assert.equal(policy.id, "threshold-region-settled-workload-aggregate-policy");
  assert.equal(policy.contractIdentity.schemaId, THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1);
  assert.equal(policy.contractIdentity.provenance, THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1);
  assert.equal(policy.observationIdentity.semanticIdentity.workoutIntent, "threshold");
  assert.equal(policy.observationIdentity.semanticIdentity.intensityId, "threshold");
  assert.equal(policy.minSessions, 2);
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable().slice(0, 2),
    policy,
  });
  assert.equal(result.acceptedObservations.length, 2);
  assert.ok(result.aggregate);
  assert.equal(result.aggregate.schemaId, THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1);
});
