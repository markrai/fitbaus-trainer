/**
 * Threshold adapter over the generic steady-state settled-workload engine.
 *
 * Preserves Threshold schema / provenance / failure-code identities.
 * Segmentation, settling, coverage, occupancy, MAD, cadence, and actuation
 * provenance live in `steadyStateSettledWorkload.ts` — do not reimplement here.
 *
 * Named-adapter invariant: callers may override scientific/mechanical policy
 * *values* via `createThresholdRegionSettledWorkloadPolicyV1`, but may never
 * replace Threshold semantic/schema/provenance/policy identity with another
 * evidence family. The generic kernel remains freely configurable; this
 * adapter does not.
 *
 * Scientific claim (unchanged): descriptive ordinary-workout mechanical
 * workload while the legacy HR controller has settled in the Threshold HR
 * region. Design / shadow-only — not E1, not Phase D, not FTP, not control.
 */
import { collectControllerResistanceTransitions, collectControllerTimeline, createSteadyStateSettledWorkloadPolicyV1, evaluateSteadyStateSettledWorkloadContract, observationsAreContinuousForPolicy, segmentControllerHeldResistance, steadyStateSettledPolicyIsProductionReady, } from "./steadyStateSettledWorkload.js";
import { steadyStateEvidenceEnabledForIntensity } from "./personalizationCapability.js";
export { collectControllerResistanceTransitions, collectControllerTimeline, observationsAreContinuousForPolicy, segmentControllerHeldResistance, };
/** Evidence observation schema identity (Threshold-named; unshipped design contract). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1 = "threshold-region-settled-workload-observation";
export const THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1 = 1;
/** Evidence admission policy identity. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1 = "threshold-region-settled-workload-policy";
export const THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1 = 1;
/**
 * Future shadow-advice resolver identity. Distinct from
 * `personalized-prescription-resolver` (E1 formal-calibration inversion).
 */
export const THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_ID_V1 = "threshold-region-ordinary-workout-shadow-resolver";
export const THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_VERSION_V1 = 1;
/** Provenance label for the Threshold scientific claim. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1 = "ordinary_workout_settled_threshold_region";
export const THRESHOLD_REGION_SEMANTIC_IDENTITY_V1 = {
    archetype: "steady_state",
    workoutIntent: "threshold",
    intensityId: "threshold",
};
export const THRESHOLD_REGION_CONTRACT_IDENTITY_V1 = {
    schemaId: THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
    schemaVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
    provenance: THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
};
/**
 * Threshold steady-state configuration: semantic identity + Threshold-named
 * contract identity + explicitly resolved Threshold scientific admission
 * (0.90 / 0.10 / 120). These values are Threshold-specific authorization —
 * not generic steady-state defaults.
 */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1 = createSteadyStateSettledWorkloadPolicyV1({
    id: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1,
    version: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1,
    semanticIdentity: THRESHOLD_REGION_SEMANTIC_IDENTITY_V1,
    contractIdentity: THRESHOLD_REGION_CONTRACT_IDENTITY_V1,
    overrides: {
        /** Strong majority of measured HR inside the product control band. */
        minInBandFraction: 0.9,
        /**
         * Aligns with fitness-refinement moderate MAD/baseline quality (≤0.10);
         * rejects unstable workload without Phase D span sensitivity to outliers.
         */
        maxMeasuredWattsMadRatio: 0.1,
        /**
         * Two minutes of post-settling elapsed evidence after the 120 s settling
         * floor (effective hold ≈ 4 min). Distinct from the 30-sample joint floor.
         */
        minAdviceGradeDurationSec: 120,
    },
});
/**
 * Build a Threshold policy that preserves canonical identity while allowing
 * scientific/mechanical value overrides (tests / sensitivity analysis).
 */
export function createThresholdRegionSettledWorkloadPolicyV1(overrides) {
    return {
        ...THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
        ...overrides,
        id: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1,
        version: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1,
        semanticIdentity: { ...THRESHOLD_REGION_SEMANTIC_IDENTITY_V1 },
        contractIdentity: { ...THRESHOLD_REGION_CONTRACT_IDENTITY_V1 },
    };
}
function mapFailureCode(code) {
    if (code === "intent_mismatch")
        return "intent_not_threshold";
    if (code === "intensity_mismatch")
        return "intensity_not_threshold";
    return code;
}
function mapWindow(window) {
    return {
        ...window,
        resolvedGateFailures: window.resolvedGateFailures.map(mapFailureCode),
    };
}
/**
 * Runtime fail-closed: supplied policy must carry canonical Threshold identity.
 * Does not rewrite mismatched identity — rejects before kernel delegation.
 */
export function isCanonicalThresholdRegionSettledWorkloadPolicy(policy) {
    if (!policy || typeof policy !== "object")
        return false;
    const candidate = policy;
    const semantic = candidate.semanticIdentity;
    const contract = candidate.contractIdentity;
    return (candidate.id === THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1 &&
        candidate.version === THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1 &&
        !!semantic &&
        semantic.archetype === "steady_state" &&
        semantic.workoutIntent === "threshold" &&
        semantic.intensityId === "threshold" &&
        !!contract &&
        contract.schemaId === THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1 &&
        contract.schemaVersion === THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1 &&
        contract.provenance === THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1);
}
function rejectForeignPolicy(policy) {
    return {
        policy,
        policyProductionReady: false,
        unresolvedPolicyFields: [],
        identityFailures: ["intent_not_threshold", "intensity_not_threshold"],
        windows: [],
        acceptedWindow: null,
        observation: null,
    };
}
/**
 * Pure Threshold contract evaluator. Delegates to the generic steady-state
 * engine with Threshold semantic/contract identity. Does not persist, advise,
 * or control.
 *
 * Product enablement is enforced here (capability layer): the generic kernel
 * remains a pure configurable algorithm and does not consult
 * `PERSONALIZATION_CAPABILITIES_V1`. Only adapters/routers with
 * `completedWorkoutEvidence === true` may treat engine output as product evidence.
 *
 * Foreign/generic policies injected through this named boundary fail closed.
 */
export function evaluateThresholdRegionSettledWorkloadContract(input) {
    var _a;
    if (!steadyStateEvidenceEnabledForIntensity("threshold")) {
        return {
            policy: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
            policyProductionReady: false,
            unresolvedPolicyFields: [],
            identityFailures: ["intensity_not_threshold"],
            windows: [],
            acceptedWindow: null,
            observation: null,
        };
    }
    const supplied = (_a = input.policy) !== null && _a !== void 0 ? _a : THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1;
    if (!isCanonicalThresholdRegionSettledWorkloadPolicy(supplied)) {
        return rejectForeignPolicy(THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1);
    }
    const result = evaluateSteadyStateSettledWorkloadContract({
        ...input,
        policy: supplied,
    });
    return {
        policy: supplied,
        policyProductionReady: result.policyProductionReady,
        unresolvedPolicyFields: result.unresolvedPolicyFields,
        identityFailures: result.identityFailures.map(mapFailureCode),
        windows: result.windows.map(mapWindow),
        acceptedWindow: result.acceptedWindow ? mapWindow(result.acceptedWindow) : null,
        observation: result.observation,
    };
}
export function thresholdRegionSettledPolicyIsProductionReady(policy = THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1) {
    if (!isCanonicalThresholdRegionSettledWorkloadPolicy(policy))
        return false;
    return steadyStateSettledPolicyIsProductionReady(policy);
}
