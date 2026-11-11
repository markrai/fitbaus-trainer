/**
 * Threshold adapter over the generic steady-state settled-workload aggregate.
 *
 * Preserves Threshold aggregate schema / provenance identities.
 * Session independence, median-of-medians, lineage, duplicates, and trend
 * diagnostics live in `steadyStateSettledWorkloadAggregate.ts`.
 *
 * Named-adapter invariant: callers may override scientific sensitivity values
 * via `createThresholdRegionSettledWorkloadAggregatePolicyV1`, but may never
 * replace aggregate id/version, `contractIdentity`, or `observationIdentity`
 * with a foreign family. The generic aggregate kernel remains configurable;
 * this adapter does not.
 *
 * Product enablement is enforced here (capability layer).
 *
 * Non-production-ready while maxCrossSessionMadRatio / maxObservationAgeDays
 * remain null. Design / shadow-only.
 */

import {
  THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
  type ThresholdRegionSettledWorkloadObservationV1,
} from "./thresholdRegionSettledWorkload.js";
import { steadyStateEvidenceEnabledForIntensity } from "./personalizationCapability.js";
import {
  classifyCrossSessionTrend,
  compatibilityKeyFromObservation as steadyStateCompatibilityKeyFromObservation,
  evaluateSteadyStateSettledWorkloadAggregate,
  steadyStateAggregatePolicyIsProductionReady,
  summarizeSessionMedianSeries,
  workoutDateFromSessionEndedAt,
  type SteadyStateAggregateCompatibilityKeyV1,
  type SteadyStateAggregateEvaluationV1,
  type SteadyStateAggregateFailureCode,
  type SteadyStateAggregateObservationIdentityV1,
  type SteadyStateAggregateTrendDirection,
  type SteadyStateSettledWorkloadAggregatePolicyV1,
  type SteadyStateSettledWorkloadAggregateV1,
  STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
} from "./steadyStateSettledWorkloadAggregate.js";

export {
  classifyCrossSessionTrend,
  summarizeSessionMedianSeries,
  workoutDateFromSessionEndedAt,
};

/** Aggregate evidence schema identity (Threshold-named; unshipped design contract). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1 =
  "threshold-region-settled-workload-aggregate" as const;
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1 = 1 as const;

/** Aggregation policy identity (distinct from single-session admission policy). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1 =
  "threshold-region-settled-workload-aggregate-policy" as const;
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1 = 1 as const;

/** Provenance label for the multi-session Threshold claim. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1 =
  "ordinary_workout_settled_threshold_region_aggregate" as const;

export const THRESHOLD_REGION_AGGREGATE_CONTRACT_IDENTITY_V1 = {
  schemaId: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1,
  schemaVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1,
  provenance: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1,
} as const;

/** Threshold single-session observation family this aggregate may consume. */
export const THRESHOLD_REGION_AGGREGATE_OBSERVATION_IDENTITY_V1 = {
  semanticIdentity: {
    workoutIntent: "threshold",
    intensityId: "threshold",
    archetype: "steady_state",
  },
  contractIdentity: {
    schemaId: THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
    schemaVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
    provenance: THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
  },
  admissionPolicyId: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1,
  admissionPolicyVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1,
} as const satisfies SteadyStateAggregateObservationIdentityV1;

export type ThresholdRegionAggregateFailureCode = SteadyStateAggregateFailureCode;
export type ThresholdRegionAggregateTrendDirection = SteadyStateAggregateTrendDirection;

/**
 * Threshold-pinned aggregate policy. Identity fields are fixed; only sensitivity
 * / quantity value fields may vary via the Threshold aggregate builder.
 */
export type ThresholdRegionSettledWorkloadAggregatePolicyV1 = Omit<
  SteadyStateSettledWorkloadAggregatePolicyV1,
  "id" | "version" | "contractIdentity" | "observationIdentity"
> & {
  id: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1;
  version: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1;
  contractIdentity: typeof THRESHOLD_REGION_AGGREGATE_CONTRACT_IDENTITY_V1;
  observationIdentity: typeof THRESHOLD_REGION_AGGREGATE_OBSERVATION_IDENTITY_V1;
};

/** Safe value overrides — identity fields are not overridable. */
export type ThresholdRegionSettledWorkloadAggregatePolicyValueOverridesV1 = Partial<
  Pick<
    ThresholdRegionSettledWorkloadAggregatePolicyV1,
    | "independenceUnit"
    | "aggregateStatistic"
    | "minSessions"
    | "minDistinctDates"
    | "maxCrossSessionMadRatio"
    | "maxObservationAgeDays"
    | "trendHandling"
    | "allowShadowCandidateEligibility"
  >
>;

export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1: ThresholdRegionSettledWorkloadAggregatePolicyV1 =
  {
    ...STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
    id: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1,
    version: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1,
    contractIdentity: { ...THRESHOLD_REGION_AGGREGATE_CONTRACT_IDENTITY_V1 },
    observationIdentity: {
      semanticIdentity: { ...THRESHOLD_REGION_AGGREGATE_OBSERVATION_IDENTITY_V1.semanticIdentity },
      contractIdentity: { ...THRESHOLD_REGION_AGGREGATE_OBSERVATION_IDENTITY_V1.contractIdentity },
      admissionPolicyId: THRESHOLD_REGION_AGGREGATE_OBSERVATION_IDENTITY_V1.admissionPolicyId,
      admissionPolicyVersion: THRESHOLD_REGION_AGGREGATE_OBSERVATION_IDENTITY_V1.admissionPolicyVersion,
    },
  };

/**
 * Build a Threshold aggregate policy that preserves canonical identity while
 * allowing scientific sensitivity / quantity overrides.
 */
export function createThresholdRegionSettledWorkloadAggregatePolicyV1(
  overrides?: ThresholdRegionSettledWorkloadAggregatePolicyValueOverridesV1
): ThresholdRegionSettledWorkloadAggregatePolicyV1 {
  return {
    ...THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
    ...overrides,
    id: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1,
    version: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1,
    contractIdentity: { ...THRESHOLD_REGION_AGGREGATE_CONTRACT_IDENTITY_V1 },
    observationIdentity: {
      semanticIdentity: { ...THRESHOLD_REGION_AGGREGATE_OBSERVATION_IDENTITY_V1.semanticIdentity },
      contractIdentity: { ...THRESHOLD_REGION_AGGREGATE_OBSERVATION_IDENTITY_V1.contractIdentity },
      admissionPolicyId: THRESHOLD_REGION_AGGREGATE_OBSERVATION_IDENTITY_V1.admissionPolicyId,
      admissionPolicyVersion: THRESHOLD_REGION_AGGREGATE_OBSERVATION_IDENTITY_V1.admissionPolicyVersion,
    },
  };
}

/** Explicit compatibility lineage — all fields must match for aggregation. */
export type ThresholdRegionAggregateCompatibilityKeyV1 = SteadyStateAggregateCompatibilityKeyV1;

export type ThresholdRegionSettledWorkloadAggregateV1 = SteadyStateSettledWorkloadAggregateV1 & {
  schemaId: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1;
  schemaVersion: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1;
  provenance: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1;
  aggregatePolicyId: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1;
  aggregatePolicyVersion: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1;
};

export type ThresholdRegionAggregateEvaluationV1 = Omit<
  SteadyStateAggregateEvaluationV1,
  "policy" | "aggregate" | "acceptedObservations"
> & {
  policy: ThresholdRegionSettledWorkloadAggregatePolicyV1;
  acceptedObservations: ThresholdRegionSettledWorkloadObservationV1[];
  aggregate: ThresholdRegionSettledWorkloadAggregateV1 | null;
};

export type ThresholdRegionAggregateObservationInputV1 = ThresholdRegionSettledWorkloadObservationV1;

/**
 * Runtime fail-closed: supplied aggregate policy must carry canonical Threshold
 * output + input-observation identity. Does not rewrite mismatched identity.
 */
export function isCanonicalThresholdRegionSettledWorkloadAggregatePolicy(
  policy: unknown
): policy is ThresholdRegionSettledWorkloadAggregatePolicyV1 {
  if (!policy || typeof policy !== "object") return false;
  const candidate = policy as SteadyStateSettledWorkloadAggregatePolicyV1;
  const out = candidate.contractIdentity;
  const input = candidate.observationIdentity;
  const expectedIn = THRESHOLD_REGION_AGGREGATE_OBSERVATION_IDENTITY_V1;
  return (
    candidate.id === THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1 &&
    candidate.version === THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1 &&
    !!out &&
    out.schemaId === THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1 &&
    out.schemaVersion === THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1 &&
    out.provenance === THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1 &&
    !!input &&
    input.semanticIdentity?.workoutIntent === expectedIn.semanticIdentity.workoutIntent &&
    input.semanticIdentity?.intensityId === expectedIn.semanticIdentity.intensityId &&
    input.semanticIdentity?.archetype === expectedIn.semanticIdentity.archetype &&
    input.contractIdentity?.schemaId === expectedIn.contractIdentity.schemaId &&
    input.contractIdentity?.schemaVersion === expectedIn.contractIdentity.schemaVersion &&
    input.contractIdentity?.provenance === expectedIn.contractIdentity.provenance &&
    input.admissionPolicyId === expectedIn.admissionPolicyId &&
    input.admissionPolicyVersion === expectedIn.admissionPolicyVersion
  );
}

export function thresholdRegionAggregatePolicyIsProductionReady(
  policy: ThresholdRegionSettledWorkloadAggregatePolicyV1 =
    THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1
): boolean {
  if (!isCanonicalThresholdRegionSettledWorkloadAggregatePolicy(policy)) return false;
  return steadyStateAggregatePolicyIsProductionReady(policy);
}

export function compatibilityKeyFromObservation(
  observation: ThresholdRegionSettledWorkloadObservationV1
): ThresholdRegionAggregateCompatibilityKeyV1 {
  return steadyStateCompatibilityKeyFromObservation(observation);
}

export { canonicalObservationDuplicateFingerprint } from "./steadyStateSettledWorkloadAggregate.js";

function rejectForeignAggregatePolicy(
  observations: readonly ThresholdRegionAggregateObservationInputV1[]
): ThresholdRegionAggregateEvaluationV1 {
  return {
    policy: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
    policyProductionReady: false,
    unresolvedPolicyFields: ["maxCrossSessionMadRatio", "maxObservationAgeDays"],
    compatibility: null,
    acceptedObservations: [],
    rejected: observations.map((observation) => ({
      sessionId: observation?.sessionId ?? "unknown",
      failures: ["invalid_observation_payload"],
    })),
    failures: ["invalid_observation_payload"],
    diagnostics: {
      sessionMeasuredWattsMedians: [],
      aggregateMeasuredWattsMedian: null,
      crossSessionWattsMad: null,
      crossSessionWattsMadRatio: null,
      trendDirection: null,
      sessionWattsSpanRatio: null,
      distinctDateCount: 0,
    },
    aggregate: null,
  };
}

/**
 * Evaluate multi-session Threshold aggregation. Delegates to the generic
 * steady-state aggregate only after Threshold aggregate identity is validated.
 */
export function evaluateThresholdRegionSettledWorkloadAggregate(args: {
  observations: readonly ThresholdRegionAggregateObservationInputV1[];
  expectedCompatibility?: ThresholdRegionAggregateCompatibilityKeyV1;
  policy?: ThresholdRegionSettledWorkloadAggregatePolicyV1;
  asOfDate?: string;
}): ThresholdRegionAggregateEvaluationV1 {
  if (!steadyStateEvidenceEnabledForIntensity("threshold")) {
    return rejectForeignAggregatePolicy(args.observations);
  }

  const supplied = args.policy ?? THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1;
  if (!isCanonicalThresholdRegionSettledWorkloadAggregatePolicy(supplied)) {
    return rejectForeignAggregatePolicy(args.observations);
  }

  const result = evaluateSteadyStateSettledWorkloadAggregate({
    observations: args.observations,
    expectedCompatibility: args.expectedCompatibility,
    policy: supplied,
    asOfDate: args.asOfDate,
  });

  return {
    ...result,
    policy: supplied,
    acceptedObservations: result.acceptedObservations as ThresholdRegionSettledWorkloadObservationV1[],
    aggregate: result.aggregate as ThresholdRegionSettledWorkloadAggregateV1 | null,
  };
}

/** Re-export Threshold single-session identity constants used by aggregate tests. */
export {
  THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
};
