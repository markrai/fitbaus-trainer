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
import { THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1, } from "./thresholdRegionSettledWorkload.js";
import { steadyStateEvidenceEnabledForIntensity } from "./personalizationCapability.js";
import { classifyCrossSessionTrend, compatibilityKeyFromObservation as steadyStateCompatibilityKeyFromObservation, evaluateSteadyStateSettledWorkloadAggregate, steadyStateAggregatePolicyIsProductionReady, summarizeSessionMedianSeries, workoutDateFromSessionEndedAt, STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1, } from "./steadyStateSettledWorkloadAggregate.js";
export { classifyCrossSessionTrend, summarizeSessionMedianSeries, workoutDateFromSessionEndedAt, };
/** Aggregate evidence schema identity (Threshold-named; unshipped design contract). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1 = "threshold-region-settled-workload-aggregate";
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1 = 1;
/** Aggregation policy identity (distinct from single-session admission policy). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1 = "threshold-region-settled-workload-aggregate-policy";
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1 = 1;
/** Provenance label for the multi-session Threshold claim. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1 = "ordinary_workout_settled_threshold_region_aggregate";
export const THRESHOLD_REGION_AGGREGATE_CONTRACT_IDENTITY_V1 = {
    schemaId: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1,
    schemaVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1,
    provenance: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1,
};
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
};
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1 = {
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
export function createThresholdRegionSettledWorkloadAggregatePolicyV1(overrides) {
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
/**
 * Runtime fail-closed: supplied aggregate policy must carry canonical Threshold
 * output + input-observation identity. Does not rewrite mismatched identity.
 */
export function isCanonicalThresholdRegionSettledWorkloadAggregatePolicy(policy) {
    var _a, _b, _c, _d, _e, _f;
    if (!policy || typeof policy !== "object")
        return false;
    const candidate = policy;
    const out = candidate.contractIdentity;
    const input = candidate.observationIdentity;
    const expectedIn = THRESHOLD_REGION_AGGREGATE_OBSERVATION_IDENTITY_V1;
    return (candidate.id === THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1 &&
        candidate.version === THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1 &&
        !!out &&
        out.schemaId === THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1 &&
        out.schemaVersion === THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1 &&
        out.provenance === THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1 &&
        !!input &&
        ((_a = input.semanticIdentity) === null || _a === void 0 ? void 0 : _a.workoutIntent) === expectedIn.semanticIdentity.workoutIntent &&
        ((_b = input.semanticIdentity) === null || _b === void 0 ? void 0 : _b.intensityId) === expectedIn.semanticIdentity.intensityId &&
        ((_c = input.semanticIdentity) === null || _c === void 0 ? void 0 : _c.archetype) === expectedIn.semanticIdentity.archetype &&
        ((_d = input.contractIdentity) === null || _d === void 0 ? void 0 : _d.schemaId) === expectedIn.contractIdentity.schemaId &&
        ((_e = input.contractIdentity) === null || _e === void 0 ? void 0 : _e.schemaVersion) === expectedIn.contractIdentity.schemaVersion &&
        ((_f = input.contractIdentity) === null || _f === void 0 ? void 0 : _f.provenance) === expectedIn.contractIdentity.provenance &&
        input.admissionPolicyId === expectedIn.admissionPolicyId &&
        input.admissionPolicyVersion === expectedIn.admissionPolicyVersion);
}
export function thresholdRegionAggregatePolicyIsProductionReady(policy = THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1) {
    if (!isCanonicalThresholdRegionSettledWorkloadAggregatePolicy(policy))
        return false;
    return steadyStateAggregatePolicyIsProductionReady(policy);
}
export function compatibilityKeyFromObservation(observation) {
    return steadyStateCompatibilityKeyFromObservation(observation);
}
export { canonicalObservationDuplicateFingerprint } from "./steadyStateSettledWorkloadAggregate.js";
function rejectForeignAggregatePolicy(observations) {
    return {
        policy: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
        policyProductionReady: false,
        unresolvedPolicyFields: ["maxCrossSessionMadRatio", "maxObservationAgeDays"],
        compatibility: null,
        acceptedObservations: [],
        rejected: observations.map((observation) => {
            var _a;
            return ({
                sessionId: (_a = observation === null || observation === void 0 ? void 0 : observation.sessionId) !== null && _a !== void 0 ? _a : "unknown",
                failures: ["invalid_observation_payload"],
            });
        }),
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
export function evaluateThresholdRegionSettledWorkloadAggregate(args) {
    var _a;
    if (!steadyStateEvidenceEnabledForIntensity("threshold")) {
        return rejectForeignAggregatePolicy(args.observations);
    }
    const supplied = (_a = args.policy) !== null && _a !== void 0 ? _a : THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1;
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
        acceptedObservations: result.acceptedObservations,
        aggregate: result.aggregate,
    };
}
/** Re-export Threshold single-session identity constants used by aggregate tests. */
export { THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1, };
