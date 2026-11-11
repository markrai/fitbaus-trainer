/**
 * E4A scientific-assessment identity and policy: schema/assessor/policy
 * identities, the state and reason-code vocabularies (canonical order), the
 * policy-v2 trust-boundary vocabularies, the frozen v1 and current v2 policies,
 * and fail-closed policy dispatch. Every historical version stays explicit.
 */
import { isNonEmptyString, isRecord } from "./guards.js";
export const SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1 = 1;
export const SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1 = "personalization-scientific-assessor";
export const SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1 = 1;
export const SCIENTIFIC_ASSESSMENT_POLICY_ID_V1 = "e4a-scientific-assessment-policy";
export const SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V1 = 1;
export const SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V2 = 2;
export const SCIENTIFIC_ASSESSMENT_STATES = [
    "not_applicable",
    "collecting",
    "eligible",
    "contradicted",
    "stale",
    "superseded",
];
export const REASON_ORDER = [
    "identity_incomplete_calibration",
    "identity_incomplete_machine",
    "unsupported_modality",
    "candidate_unavailable",
    "candidate_outside_domain",
    "insufficient_independent_sessions",
    "insufficient_calendar_spread",
    "edge_domain_only",
    "controller_saturation_dominant",
    "persistent_signed_bias_positive",
    "persistent_signed_bias_negative",
    "variance_exceeds_policy",
    "open_loop_evidence_unavailable",
    "actuation_mode_unknown",
    "machine_comparability_unavailable",
    "held_workload_evidence_unavailable",
    "actuation_provenance_unavailable",
    "timed_actuation_join_unavailable",
    "actuation_capture_incomplete",
    "actuation_context_unknown",
    "controller_selected_evidence",
    "programmatic_selected_evidence",
    "no_app_selector_observed",
    "evidence_stale",
    "calibration_superseded",
    "unsupported_policy",
];
/**
 * Exact policy-v2 trust-boundary vocabularies. They mirror the read-only join's
 * canonical vocabularies (kept in step by test); E4A imports nothing.
 */
export const SCIENTIFIC_MACHINE_COMPARABILITY_REASONS_V2 = [
    "same_machine_and_profile",
    "execution_provenance_unavailable",
    "workout_machine_unavailable",
    "workout_machine_selection_changed",
    "calibration_unavailable",
    "calibration_machine_unavailable",
    "calibration_machine_integrity_failure",
    "calibration_identity_mismatch",
    "different_machine",
    "same_machine_different_profile",
];
export const SCIENTIFIC_TIMED_ACTUATION_JOINS_V2 = [
    "available",
    "not_applicable",
    "execution_provenance_unavailable",
    "raw_telemetry_unavailable",
    "reconstruction_mismatch",
];
/**
 * Production policy `e4a-scientific-assessment-policy@1`. Its type pins the
 * literal id/version and both evidence dimensions to
 * `required_but_unavailable`, so `eligible` is unreachable under it even for
 * a caller that supplies synthetic future-complete session evidence.
 */
export const E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1 = Object.freeze({
    id: SCIENTIFIC_ASSESSMENT_POLICY_ID_V1,
    version: SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V1,
    minIndependentSessions: 4,
    minDistinctDates: 4,
    minCalendarSpanDays: 14,
    characterizationMinInteriorSessions: 1,
    characterizationMaxMedianAbsoluteBiasWatts: 10,
    characterizationMaxSettledWattsCv: 0.15,
    characterizationMaxSaturationIncidence: 0.5,
    openLoopEvidence: "required_but_unavailable",
    actuationModeEvidence: "required_but_unavailable",
    staleness: "not_configured",
});
export const E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2 = Object.freeze({
    id: SCIENTIFIC_ASSESSMENT_POLICY_ID_V1,
    version: SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V2,
    minIndependentSessions: 4,
    minDistinctDates: 4,
    minCalendarSpanDays: 14,
    characterizationMinInteriorSessions: 1,
    characterizationMaxMedianAbsoluteBiasWatts: 10,
    characterizationMaxSettledWattsCv: 0.15,
    characterizationMaxSaturationIncidence: 0.5,
    machineComparability: "required",
    heldWorkloadEvidence: "required",
    actuationContextEvidence: "required",
    openLoopEvidence: "required_but_unavailable",
    staleness: "not_configured",
});
/** The policy production diagnostics use. Switched from v1 to v2 deliberately. */
export const E4A_CURRENT_SCIENTIFIC_ASSESSMENT_POLICY = E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2;
/**
 * Policy dispatch. The production id is pinned: version 1 must be a v1-shaped
 * policy, version 2 a v2-shaped policy, any other version fails closed.
 * Synthetic (non-production) ids keep the generic v1 evaluator unless they
 * declare the v2 dimensions.
 */
export function policyGeneration(policy) {
    if (!isRecord(policy) || !isNonEmptyString(policy.id) || !Number.isInteger(policy.version))
        return null;
    const v2Shaped = policy.machineComparability === "required" && policy.heldWorkloadEvidence === "required" &&
        policy.actuationContextEvidence === "required" && policy.openLoopEvidence === "required_but_unavailable" &&
        !("actuationModeEvidence" in policy);
    const v1Shaped = (policy.openLoopEvidence === "required_but_unavailable" || policy.openLoopEvidence === "required") &&
        (policy.actuationModeEvidence === "required_but_unavailable" || policy.actuationModeEvidence === "required") &&
        !("machineComparability" in policy);
    if (policy.id === SCIENTIFIC_ASSESSMENT_POLICY_ID_V1) {
        if (policy.version === SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V1)
            return v1Shaped ? 1 : null;
        if (policy.version === SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V2)
            return v2Shaped ? 2 : null;
        return null;
    }
    return v2Shaped ? 2 : v1Shaped ? 1 : null;
}
