/**
 * E4A scientific-assessment identity and policy: schema/assessor/policy
 * identities, the state and reason-code vocabularies (canonical order), the
 * policy-v2 trust-boundary vocabularies, the frozen v1 and current v2 policies,
 * and fail-closed policy dispatch. Every historical version stays explicit.
 */

import { isNonEmptyString, isRecord } from "./guards.js";

export const SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1 = 1 as const;
export const SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1 =
  "personalization-scientific-assessor" as const;
export const SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1 = 1 as const;
export const SCIENTIFIC_ASSESSMENT_POLICY_ID_V1 =
  "e4a-scientific-assessment-policy" as const;
export const SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V1 = 1 as const;
export const SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V2 = 2 as const;

/**
 * Minimum scientific state vocabulary. Every E4A output is already an
 * evaluation, so there is no `evaluated` state, and there are no
 * product-flavored states (`promising`, `validated`, `approved`, `active`,
 * `live` are deliberately absent).
 *
 * - `not_applicable`: the subject cannot currently produce scientifically
 *   evaluable evidence (unsupported modality, incomplete identity, or no
 *   E1 candidate for the subject).
 * - `collecting`: a valid subject exists but required evidence is incomplete
 *   (volume, spread, domain, quality, or a required dimension such as
 *   open-loop evidence is unavailable).
 * - `eligible`: all scientific-policy gates pass. Unreachable under the
 *   production policy while open-loop or actuation-mode evidence is
 *   unavailable.
 * - `contradicted`: adequate evidence actively disagrees with the candidate
 *   (persistent signed bias or excess variability on otherwise adequate,
 *   informative evidence), independent of `collecting`.
 * - `stale`: previously adequate evidence no longer represents current
 *   conditions. Never produced from assessment age alone under the
 *   production policy (recency is explicitly not configured there).
 * - `superseded`: the subject calibration is no longer the athlete's current
 *   formal calibration. Terminal for the subject; evidence never transfers
 *   automatically across formal assessments.
 */
export type ScientificAssessmentState =
  | "not_applicable"
  | "collecting"
  | "eligible"
  | "contradicted"
  | "stale"
  | "superseded";

export const SCIENTIFIC_ASSESSMENT_STATES: readonly ScientificAssessmentState[] = [
  "not_applicable",
  "collecting",
  "eligible",
  "contradicted",
  "stale",
  "superseded",
];

/**
 * Finite reason-code vocabulary. Only reasons the assessor can establish
 * from current inputs are listed, in canonical (stable output) order.
 */
export type ScientificAssessmentReasonCode =
  | "identity_incomplete_calibration"
  | "identity_incomplete_machine"
  | "unsupported_modality"
  | "candidate_unavailable"
  | "candidate_outside_domain"
  | "insufficient_independent_sessions"
  | "insufficient_calendar_spread"
  | "edge_domain_only"
  | "controller_saturation_dominant"
  | "persistent_signed_bias_positive"
  | "persistent_signed_bias_negative"
  | "variance_exceeds_policy"
  | "open_loop_evidence_unavailable"
  | "actuation_mode_unknown"
  // Policy v2 only: exact machine comparability, held-workload evidence, and
  // window-level actuation context. Context categories are truthful labels of
  // non-independent evidence, never physiological contradiction.
  | "machine_comparability_unavailable"
  | "held_workload_evidence_unavailable"
  | "actuation_provenance_unavailable"
  | "timed_actuation_join_unavailable"
  | "actuation_capture_incomplete"
  | "actuation_context_unknown"
  | "controller_selected_evidence"
  | "programmatic_selected_evidence"
  | "no_app_selector_observed"
  | "evidence_stale"
  | "calibration_superseded"
  | "unsupported_policy";

export const REASON_ORDER: readonly ScientificAssessmentReasonCode[] = [
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
] as const;

export const SCIENTIFIC_TIMED_ACTUATION_JOINS_V2 = [
  "available",
  "not_applicable",
  "execution_provenance_unavailable",
  "raw_telemetry_unavailable",
  "reconstruction_mismatch",
] as const;

/**
 * Versioned explicit E4A skeleton policy. Follows the E1/E2 policy pattern
 * (`id` + `version`; no buried literals in the reducer).
 *
 * This first policy is a skeleton: it declares which dimensions are
 * required, descriptive, or currently unavailable. Every numeric gate value
 * below is a characterization/development value for evidence collection —
 * explicitly not a validated physiological limit and not an activation
 * threshold. `minIndependentSessions` / `minDistinctDates` follow the Phase D
 * "four sessions on four dates" precedent for independent-session evidence.
 */
export interface ScientificAssessmentPolicy {
  /**
   * Generic versionable identity: the evaluator accepts any explicit policy
   * id/version (e.g. synthetic test policies). Only the production constant
   * below is pinned to `e4a-scientific-assessment-policy@1`.
   */
  id: string;
  version: number;
  /** Required evidence-volume gate (characterization value, not physiology). */
  minIndependentSessions: number;
  /** Required diversity gate: distinct UTC calendar dates. */
  minDistinctDates: number;
  /** Required diversity gate: span from oldest to newest session, in days. */
  minCalendarSpanDays: number;
  /** Required domain gate: sessions strictly inside the calibration domain. */
  characterizationMinInteriorSessions: number;
  /** Contradiction gate: persistent median signed bias, in watts. */
  characterizationMaxMedianAbsoluteBiasWatts: number;
  /** Contradiction gate: session-to-session settled-watts coefficient of variation. */
  characterizationMaxSettledWattsCv: number;
  /** Quality gate: fraction of sessions with any R1/R15 saturation. */
  characterizationMaxSaturationIncidence: number;
  /**
   * Open-loop evidence (stable-resistance windows + forward HR prediction
   * error) is required for live consideration but unavailable from current
   * E2. The literal keeps the gap structural instead of hiding it in a
   * tunable. While this reads `required_but_unavailable`, the open-loop gate
   * fails regardless of session content, so `eligible` cannot be reached.
   * `required` (synthetic/future policies only) gates on per-session
   * evidence instead.
   */
  openLoopEvidence: "required_but_unavailable" | "required";
  /**
   * Trustworthy per-phase actuation mode is required but unavailable: E2
   * persists only a sticky commanded-resistance proxy, which cannot
   * distinguish manual control from bridge-unavailable sessions. Same
   * semantics as `openLoopEvidence`.
   */
  actuationModeEvidence: "required_but_unavailable" | "required";
  /**
   * Staleness follows the E1 precedent of an explicitly unconfigured
   * freshness policy: `not_configured` reports the recency dimension as
   * `unavailable` rather than passing or failing it, so assessment age
   * alone can never produce `stale` through an arbitrary hard-coded number.
   * A configured test policy combines newest-evidence age against
   * `maxDaysSinceNewestSession`.
   */
  staleness: "not_configured" | { maxDaysSinceNewestSession: number };
}

/**
 * Production policy `e4a-scientific-assessment-policy@1`. Its type pins the
 * literal id/version and both evidence dimensions to
 * `required_but_unavailable`, so `eligible` is unreachable under it even for
 * a caller that supplies synthetic future-complete session evidence.
 */
export const E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1: Readonly<ScientificAssessmentPolicy & {
  id: typeof SCIENTIFIC_ASSESSMENT_POLICY_ID_V1;
  version: typeof SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V1;
  openLoopEvidence: "required_but_unavailable";
  actuationModeEvidence: "required_but_unavailable";
}> = Object.freeze({
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

/**
 * Policy v2 (`e4a-scientific-assessment-policy@2`), the current production
 * scientific-assessment policy. It keeps every v1 numeric characterization
 * value and replaces v1's blanket "actuation mode unavailable" dimension with
 * three explicit dimensions consumed from immutable provenance:
 *
 * - exact machine/profile/calibration-instance comparability (incomparable
 *   sessions are excluded from evidence, never treated as contradiction);
 * - E2 v3 held-workload forward-response evidence;
 * - window-level actuation context of qualifying held windows.
 *
 * Known context is truthfully reported (controller-selected, programmatic,
 * no app selector observed) but none of those categories is independent
 * open-loop evidence, so `openLoopEvidence` stays required-but-unavailable and
 * `eligible` remains unreachable. v1 remains frozen and unchanged.
 */
export interface ScientificAssessmentPolicyV2 extends Omit<ScientificAssessmentPolicy, "actuationModeEvidence"> {
  id: typeof SCIENTIFIC_ASSESSMENT_POLICY_ID_V1;
  version: typeof SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V2;
  machineComparability: "required";
  heldWorkloadEvidence: "required";
  actuationContextEvidence: "required";
  openLoopEvidence: "required_but_unavailable";
}

export const E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2: Readonly<ScientificAssessmentPolicyV2> = Object.freeze({
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

export type PolicyGeneration = 1 | 2;

/**
 * Policy dispatch. The production id is pinned: version 1 must be a v1-shaped
 * policy, version 2 a v2-shaped policy, any other version fails closed.
 * Synthetic (non-production) ids keep the generic v1 evaluator unless they
 * declare the v2 dimensions.
 */
export function policyGeneration(policy: unknown): PolicyGeneration | null {
  if (!isRecord(policy) || !isNonEmptyString(policy.id) || !Number.isInteger(policy.version)) return null;
  const v2Shaped = policy.machineComparability === "required" && policy.heldWorkloadEvidence === "required" &&
    policy.actuationContextEvidence === "required" && policy.openLoopEvidence === "required_but_unavailable" &&
    !("actuationModeEvidence" in policy);
  const v1Shaped = (policy.openLoopEvidence === "required_but_unavailable" || policy.openLoopEvidence === "required") &&
    (policy.actuationModeEvidence === "required_but_unavailable" || policy.actuationModeEvidence === "required") &&
    !("machineComparability" in policy);
  if (policy.id === SCIENTIFIC_ASSESSMENT_POLICY_ID_V1) {
    if (policy.version === SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V1) return v1Shaped ? 1 : null;
    if (policy.version === SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V2) return v2Shaped ? 2 : null;
    return null;
  }
  return v2Shaped ? 2 : v1Shaped ? 1 : null;
}
