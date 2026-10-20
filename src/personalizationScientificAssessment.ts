/**
 * E4A scientific assessment — pure, versioned, no authority.
 *
 * E4A evaluates hardened E1/E2 threshold (and future aerobic-base) transfer
 * evidence and derives a per-subject scientific state with explicit reason
 * codes and named gate results. It is the first E4 slice:
 *
 * ```text
 * E3 evidence
 *     ↓
 * E4A policy
 *     ↓
 * scientific state + reasons + gates
 * ```
 *
 * E4A scientific assessment ≠ product authorization ≠ runtime authority.
 * E4B (explicit product + athlete authorization) and E4C (session-start
 * runtime compatibility) do not exist. This module has no knowledge of any
 * authorization record.
 *
 * Purity contract: the core evaluator is deterministic, reads no storage,
 * samples no clock (caller-supplied ISO strings are parsed, never read from
 * a live time source), reads no global profile, touches no machine runtime,
 * imports no control code, mutates no FitnessState, and never recomputes
 * E1/E2 values. `evaluatedAt` is supplied by the caller. E4A output is
 * derived and runtime-only: no
 * store, no workout-summary field, no FitnessState field, no export field.
 *
 * Controller-circularity caveat:
 *
 * ```text
 * E1 candidate: calibration inverse at the legacy HR region.
 * E2/E3 observed settled watts: measured while the legacy HR controller was
 * actively seeking that same HR region.
 * ```
 *
 * Current candidate-vs-observed agreement is therefore transfer evidence,
 * not independent proof of prescription quality. In particular the assessor
 * never treats HR-in-band occupancy, inside-candidate agreement, or perfect
 * closed-loop error as success: without truly independent open-loop evidence
 * and trustworthy actuation-mode evidence, `eligible` is unreachable under the
 * production policy. E2 v3 held-workload forward-response evidence (forward HR
 * prediction error at held observed resistance) removes HR-band conditioning
 * but not controller selection of the held resistance, so it is surfaced
 * descriptively in the digest and never satisfies the open-loop gate.
 *
 * Modality semantics: the current E1 threshold candidate is athlete-relative
 * workload associated with the prescribed legacy threshold HR region. It is
 * not a personal physiological threshold (no FTP / lactate / ventilatory
 * threshold evidence exists). The subject modality is named accordingly:
 * `legacy_hr_region_workload`.
 *
 * E3/E4A layering:
 *
 * ```text
 * E3 longitudinal evidence = read-only analysis
 * E4A                      = scientific policy assessment over comparable evidence
 * ```
 *
 * E4A does not import E3 or any other module: the only permitted consumer is
 * the read-only developer diagnostics projection, which imports E4A (never
 * the reverse). E4A therefore independently verifies identity at its own
 * trust boundary instead of trusting upstream grouping. The E4A evidence
 * builder below applies the full cohort key over frozen E2 fields:
 * athlete × evidence session IDs × estimator id/version × protocol id/version
 * × formal observedAt × calibration workload provenance × observed-power
 * provenance × machine ID × machine profile version × legacy HR band.
 * Sessions with incomplete identity are excluded with counts (fail closed);
 * they are never pooled into an "unavailable" cohort. Sessions carrying more
 * than one characterized threshold/aerobic-base phase for the subject
 * intensity are excluded rather than silently reduced to one phase.
 */

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

const REASON_ORDER: readonly ScientificAssessmentReasonCode[] = [
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

export type ScientificAssessmentGateStatus =
  | "pass"
  | "fail"
  | "unavailable"
  | "not_applicable";

export interface ScientificAssessmentGate {
  id: string;
  status: ScientificAssessmentGateStatus;
  reasonCode?: ScientificAssessmentReasonCode;
  measured?: Record<string, number | string | null>;
}

export type ScientificAssessmentModality = "legacy_hr_region_workload";

export type ScientificAssessmentIntensity = "threshold" | "aerobic_base";

/**
 * Complete formal calibration identity. Reuses the hardened E3 identity
 * semantics: athlete × evidence sessions × estimator × protocol × formal
 * observedAt × calibration workload provenance. There is exactly one meaning
 * of "same calibration" shared with E3 evidence.
 */
export interface ScientificAssessmentCalibrationIdentity {
  evidenceSessionIds: readonly string[];
  estimatorId: string;
  estimatorVersion: number;
  protocolId: string;
  protocolVersion: number;
  /** Formal assessment `metricObservedAt` (frozen E1 snapshot). */
  observedAt: string;
  workloadProvenance: "measured_watts" | "calibrated_at_verified_cadence";
}

/**
 * Typed E4A subject. The first workload modality describes what E1 actually
 * represents: athlete-relative workload associated with the prescribed
 * legacy threshold HR region — never a personalized physiological threshold.
 *
 * `phaseStructureClass` is a deliberate type seam: phase-structure class
 * (e.g. continuous block vs interval structure) cannot be derived reliably
 * from existing durable E2 data (a single observed phase carries no template
 * linkage; `intervalIndex` alone does not classify structure), so v1 leaves
 * it unclassified (`null`) rather than fabricating it. It is a future
 * subject-identity requirement before any authorization: evidence from one
 * structure class must not authorize another.
 *
 * `intent` (workout family, e.g. Thursday) is recorded nowhere in the
 * subject: `intensityId` is the stronger semantic key for authorization
 * identity.
 */
export interface ScientificAssessmentSubject {
  athleteId: string;
  activity: "bike";
  phaseKind: "work";
  intensityId: ScientificAssessmentIntensity;
  modality: ScientificAssessmentModality;
  phaseStructureClass: null;
  calibration: ScientificAssessmentCalibrationIdentity;
  machineId: string;
  machineProfileVersion: number;
  observedPowerProvenance: "measured_watts" | "calibrated_watts";
  legacyHrBand: { minBpm: number; maxBpm: number };
}

/**
 * One hardened per-session evidence row for the assessed subject cohort.
 * All fields are frozen E2/E3 values; E4A never recomputes candidates.
 *
 * `openLoop` and `actuationMode` are seams for a future slice that can
 * distinguish manual/fixed-workload evidence from controller-selected workload
 * and capture trustworthy actuation mode. No E2 record (including v3
 * held-workload forward-response evidence) carries either: the production builder always supplies
 * `openLoop: null` and `actuationMode: "unknown"`, which the production
 * policy treats as required-but-unavailable so `eligible` stays unreachable.
 * Synthetic future-complete evidence may populate them to exercise the pure
 * state machine.
 */
export interface ScientificAssessmentSessionEvidence {
  workoutSessionId: string;
  createdAt: string;
  athleteId: string;
  activity: string;
  phaseKind: string;
  intensityId: string;
  calibration: ScientificAssessmentCalibrationIdentity;
  machineId: string;
  machineProfileVersion: number;
  observedPowerProvenance: "measured_watts" | "calibrated_watts";
  legacyHrBand: { minBpm: number; maxBpm: number };
  candidateWidthWatts: number;
  candidateMidpointWatts: number;
  observedSettledWatts: number;
  signedDifferenceWatts: number;
  absoluteDifferenceWatts: number;
  widthNormalizedAbsoluteError: number | null;
  saturationRatio: number;
  domainBucket: "edge" | "interior";
  assessmentAgeDays: number | null;
  openLoop: { stableResistanceWindowCount: number } | null;
  actuationMode: "unknown" | "automatic" | "manual";
  /**
   * Policy v2 join for this session's subject phase (exact machine/profile/
   * calibration comparability, E2 v3 held-workload evidence, window-level
   * actuation context). Absent/null means unavailable. Policy v1 ignores it.
   */
  provenanceV2?: ScientificAssessmentSessionProvenanceV2 | null;
}

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
 * Policy-v2 held-response cohort member: one subject-matching workout whose
 * exact subject phase has characterized E2 v3 held-workload forward-response
 * evidence. It deliberately carries NO closed-loop values (no candidate bias,
 * agreement, settled watts, or saturation) and never requires legacy HR-band
 * success or closed-loop characterization. It feeds only machine
 * comparability, held-workload evidence, and actuation-context gates.
 */
export interface ScientificHeldSessionEvidenceV2 {
  workoutSessionId: string;
  createdAt: string;
  athleteId: string;
  activity: string;
  phaseKind: string;
  intensityId: string;
  calibration: ScientificAssessmentCalibrationIdentity;
  machineId: string;
  machineProfileVersion: number;
  observedPowerProvenance: "measured_watts" | "calibrated_watts";
  legacyHrBand: { minBpm: number; maxBpm: number };
  provenanceV2: ScientificAssessmentSessionProvenanceV2;
}

export type ScientificAssessmentHeldActuationContext =
  | "automatic_selected"
  | "programmatic_selected"
  | "no_app_selector_observed"
  | "unknown";

export interface ScientificAssessmentSessionProvenanceV2 {
  machineComparison: { comparable: boolean; reason: string };
  actuationCapture: "complete" | "incomplete" | "unavailable";
  heldWorkload: {
    available: boolean;
    timedJoin: string;
    qualifyingWindowCount: number;
    qualifyingDurationSec: number;
    contexts: Record<ScientificAssessmentHeldActuationContext, { windowCount: number; durationSec: number }> | null;
  } | null;
  /** Literal false: no current actuation category is independent open-loop evidence. */
  independentOpenLoopEvidence: false;
}

/** Structural shape of the per-workout v2 join supplied by the read-only projection. */
export interface ScientificAssessmentSessionEvidenceV2Input {
  workoutSessionId: string;
  machineComparison: { comparable: boolean; reason: string };
  actuationCapture: "complete" | "incomplete" | "unavailable";
  phases: readonly {
    phaseId: string;
    intervalIndex?: number;
    activeStartSec?: number;
    heldWorkload: {
      available: boolean;
      timedJoin: string;
      qualifyingWindowCount: number;
      qualifyingDurationSec: number;
      contexts: Record<ScientificAssessmentHeldActuationContext, { windowCount: number; durationSec: number }> | null;
    };
  }[];
  independentOpenLoopEvidence: false;
}

/**
 * Descriptive E2 v3 held-workload forward-response summary for one cohort
 * session (one workout = one longitudinal observation, however many held-load
 * windows it contained). Held-load forward evidence is NOT proof of truly
 * independent open-loop evidence: the live controller may have selected the
 * held resistance. It therefore never populates `openLoop`, and no gate reads it.
 * Selection never depends on legacy HR-band occupancy or closed-loop success.
 */
export interface ScientificAssessmentHeldWorkloadForwardSession {
  workoutSessionId: string;
  qualifyingWindowCount: number;
  qualifyingDurationSec: number;
  /** Observed HR − frozen-calibration predicted HR, session median. */
  medianSignedErrorBpm: number;
  medianAbsoluteErrorBpm: number;
}

export type ScientificAssessmentCandidateStatus =
  | "available"
  | "unavailable"
  | "outside_domain";

export interface ScientificAssessmentEvidence {
  athleteId: string;
  /**
   * Whether the frozen E1 candidate exists for the subject — never whether
   * any E2 session was characterized. The builder reads the durable E2
   * copy of the frozen E1 outcome (`shadowOutcome` + `candidatePower` /
   * `fallbackReason`) on the subject's own cohort phases:
   * `available` when a matching phase recorded `shadowOutcome: "candidate"`
   * with a valid candidate band (even if E2 characterization was
   * insufficient), else `outside_domain` when a matching E1 fallback reports
   * the legacy band outside the calibration domain, else `unavailable` (E1
   * fallback of any other kind, or no evidence at all). Candidate existence
   * is never recomputed from E1 or FitnessState. Direct assessor callers
   * supply it.
   */
  candidateStatus: ScientificAssessmentCandidateStatus;
  sessions: readonly ScientificAssessmentSessionEvidence[];
  /**
   * Trustworthy current-calibration identity supplied by the caller (e.g.
   * from the live FitnessState snapshot at assessment time). `null` means
   * the caller cannot vouch for currency, so the supersession dimension is
   * reported `unavailable` and `superseded` stays unreachable. E4A never
   * reads FitnessState itself and keeps no calibration history.
   */
  currentCalibration: ScientificAssessmentCalibrationIdentity | null;
  excludedIncompleteIdentitySessions: number;
  excludedMultiPhaseSessions: number;
  /** Descriptive only (see type docs); absent means not supplied. */
  heldWorkloadForwardSessions?: readonly ScientificAssessmentHeldWorkloadForwardSession[];
  /**
   * Policy v2 held-response cohort, separate from the closed-loop transfer
   * cohort in `sessions`. Absent means not supplied; policy v1 ignores it.
   */
  heldSessionsV2?: readonly ScientificHeldSessionEvidenceV2[];
}

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

type PolicyGeneration = 1 | 2;

/**
 * Policy dispatch. The production id is pinned: version 1 must be a v1-shaped
 * policy, version 2 a v2-shaped policy, any other version fails closed.
 * Synthetic (non-production) ids keep the generic v1 evaluator unless they
 * declare the v2 dimensions.
 */
function policyGeneration(policy: unknown): PolicyGeneration | null {
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

/**
 * Pure E4A output. The typed-false pattern from E1/E2 is reused structurally:
 * `mode` is the literal `"scientific_assessment"` and `runtimeAuthority` is
 * the literal `false`. There is no type path that allows `true`, and no
 * activation-eligibility, authorization-grant, approval, or live-control
 * field exists here.
 * Scientific eligibility is not runtime authority: reaching `eligible` still
 * requires the nonexistent E4B grant plus the nonexistent E4C freeze before
 * anything could be live.
 */
export interface ScientificAssessment {
  schemaVersion: typeof SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1;
  assessor: {
    id: typeof SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1;
    version: typeof SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1;
  };
  policy: {
    id: string;
    version: number;
  };
  subject: ScientificAssessmentSubject;
  mode: "scientific_assessment";
  runtimeAuthority: false;
  state: ScientificAssessmentState;
  /** Failed-gate reason codes in canonical stable order. */
  reasonCodes: ScientificAssessmentReasonCode[];
  /** All named gates in fixed order; inspectable per-gate status. */
  gates: ScientificAssessmentGate[];
  evidenceDigest: {
    sessionCount: number;
    distinctDateCount: number;
    calendarSpanDays: number | null;
    sessionIds: string[];
    interiorSessionCount: number;
    saturationIncidence: number | null;
    medianSignedDifferenceWatts: number | null;
    medianAbsoluteDifferenceWatts: number | null;
    medianCandidateWidthWatts: number | null;
    observedSettledWattsCv: number | null;
    newestSessionAgeDays: number | null;
    calibrationInstanceId: string;
    excludedIncompleteIdentitySessions: number;
    excludedMultiPhaseSessions: number;
    ignoredCrossCohortSessions: number;
    /** Malformed or duplicated in-cohort sessions, excluded (fail closed). */
    ignoredInvalidSessions: number;
    /**
     * Descriptive held-workload forward-response visibility. Never a gate
     * input and never open-loop evidence; medians are across sessions.
     */
    heldWorkloadForwardSessionCount: number;
    medianHeldWorkloadForwardSignedErrorBpm: number | null;
    medianHeldWorkloadForwardAbsoluteErrorBpm: number | null;
    /** Policy v2 only; absent under v1. Workout-level counts plus descriptive window totals. */
    provenanceV2?: ScientificAssessmentProvenanceDigestV2;
  };
  evaluatedAt: string;
}

/**
 * Runtime-only policy-v2 digest (never persisted or exported). Each evidence
 * channel counts only the workouts it owns: closed-loop transfer sessions vs
 * held-response sessions. One workout is at most one session per channel.
 */
export interface ScientificAssessmentProvenanceDigestV2 {
  transferComparableSessionCount: number;
  heldComparableSessionCount: number;
  /** Machine-incomparable sessions excluded from each channel, by reason. */
  excludedTransferMachineIncomparableSessions: Record<string, number>;
  excludedHeldMachineIncomparableSessions: Record<string, number>;
  /** Malformed, duplicated, or cross-cohort held sessions, excluded (fail closed). */
  ignoredInvalidHeldSessions: number;
  sessionsWithHeldWorkloadEvidence: number;
  sessionsWithTimedActuationJoin: number;
  /** Window counts/durations are descriptive; longitudinal N stays workout-level. */
  heldContexts: Record<ScientificAssessmentHeldActuationContext, { sessions: number; windows: number; durationSec: number }>;
  independentOpenLoopEvidence: "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function sortedMedian(values: readonly number[]): number | null {
  const finite = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0
    ? (finite[middle - 1] + finite[middle]) / 2
    : finite[middle];
}

function coefficientOfVariation(values: readonly number[]): number | null {
  const finite = values.filter(isFiniteNumber);
  if (finite.length < 2) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  if (mean === 0) return null;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

function calibrationEquals(
  left: ScientificAssessmentCalibrationIdentity,
  right: ScientificAssessmentCalibrationIdentity
): boolean {
  if (left.estimatorId !== right.estimatorId || left.estimatorVersion !== right.estimatorVersion) return false;
  if (left.protocolId !== right.protocolId || left.protocolVersion !== right.protocolVersion) return false;
  if (left.observedAt !== right.observedAt || left.workloadProvenance !== right.workloadProvenance) return false;
  // Evidence session IDs identify the calibration instance as a set: order
  // must not turn the same calibration into a false supersession.
  const leftIds = normalizedSessionIds(left.evidenceSessionIds);
  const rightIds = normalizedSessionIds(right.evidenceSessionIds);
  if (leftIds.length !== rightIds.length) return false;
  return leftIds.every((id, index) => id === rightIds[index]);
}

function normalizedSessionIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

function calibrationIdentityValid(identity: unknown): identity is ScientificAssessmentCalibrationIdentity {
  if (!isRecord(identity)) return false;
  if (!Array.isArray(identity.evidenceSessionIds) || identity.evidenceSessionIds.length === 0) return false;
  if (!identity.evidenceSessionIds.every(isNonEmptyString)) return false;
  if (!isNonEmptyString(identity.estimatorId) || !Number.isInteger(identity.estimatorVersion)) return false;
  if (!isNonEmptyString(identity.protocolId) || !Number.isInteger(identity.protocolVersion)) return false;
  if (!isIsoDateTime(identity.observedAt)) return false;
  return identity.workloadProvenance === "measured_watts" ||
    identity.workloadProvenance === "calibrated_at_verified_cadence";
}

/** Subject identity fields shared by both cohorts; no HR-band success or closed-loop value involved. */
type SubjectIdentityFields = Pick<ScientificAssessmentSessionEvidence, "athleteId" | "activity" | "phaseKind" |
  "intensityId" | "calibration" | "machineId" | "machineProfileVersion" | "observedPowerProvenance" | "legacyHrBand">;

function sessionMatchesSubject(
  session: SubjectIdentityFields,
  subject: ScientificAssessmentSubject
): boolean {
  if (session.athleteId !== subject.athleteId) return false;
  if (session.activity !== subject.activity || session.phaseKind !== subject.phaseKind) return false;
  if (session.intensityId !== subject.intensityId) return false;
  if (!calibrationEquals(session.calibration, subject.calibration)) return false;
  if (session.machineId !== subject.machineId) return false;
  if (session.machineProfileVersion !== subject.machineProfileVersion) return false;
  if (session.observedPowerProvenance !== subject.observedPowerProvenance) return false;
  if (session.legacyHrBand?.minBpm !== subject.legacyHrBand.minBpm) return false;
  if (session.legacyHrBand?.maxBpm !== subject.legacyHrBand.maxBpm) return false;
  return true;
}

/** Relative tolerance matching the strict E2 reader's derived-value check. */
function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Semantic validation of one frozen evidence row. Fails closed on values that
 * are structurally impossible, not merely non-finite; nothing is clamped.
 * The exact E2 comparison invariants (signed = observed − midpoint,
 * absolute = |signed|, normalized = absolute / width) are checked with the
 * same relative tolerance the strict E2 reader uses, so persisted rounding
 * noise never rejects real evidence.
 */
function sessionEvidenceValid(session: ScientificAssessmentSessionEvidence): boolean {
  if (!isNonEmptyString(session.workoutSessionId) || utcDateKey(session.createdAt) === null) return false;
  if (!isFiniteNumber(session.candidateWidthWatts) || session.candidateWidthWatts <= 0) return false;
  if (!isFiniteNumber(session.candidateMidpointWatts) || session.candidateMidpointWatts <= 0) return false;
  if (!isFiniteNumber(session.observedSettledWatts) || session.observedSettledWatts < 0) return false;
  if (!isFiniteNumber(session.signedDifferenceWatts)) return false;
  if (!isFiniteNumber(session.absoluteDifferenceWatts) || session.absoluteDifferenceWatts < 0) return false;
  if (!nearlyEqual(session.signedDifferenceWatts,
    session.observedSettledWatts - session.candidateMidpointWatts)) return false;
  if (!nearlyEqual(session.absoluteDifferenceWatts, Math.abs(session.signedDifferenceWatts))) return false;
  if (session.widthNormalizedAbsoluteError !== null &&
    (!isFiniteNumber(session.widthNormalizedAbsoluteError) ||
      !nearlyEqual(session.widthNormalizedAbsoluteError,
        session.absoluteDifferenceWatts / session.candidateWidthWatts))) return false;
  if (!isFiniteNumber(session.saturationRatio) ||
    session.saturationRatio < 0 || session.saturationRatio > 1) return false;
  if (!isRecord(session.legacyHrBand) ||
    !isFiniteNumber(session.legacyHrBand.minBpm) || !isFiniteNumber(session.legacyHrBand.maxBpm) ||
    session.legacyHrBand.minBpm <= 0 || session.legacyHrBand.maxBpm < session.legacyHrBand.minBpm) return false;
  // Chronology: a workout cannot precede the formal calibration it was
  // prescribed from, and a derived assessment age cannot be negative.
  if (session.assessmentAgeDays !== null &&
    (!isFiniteNumber(session.assessmentAgeDays) || session.assessmentAgeDays < 0)) return false;
  if (isRecord(session.calibration) && isIsoDateTime(session.calibration.observedAt) &&
    Date.parse(session.createdAt) < Date.parse(session.calibration.observedAt)) return false;
  if (session.openLoop !== null && (!isRecord(session.openLoop) ||
    !Number.isInteger(session.openLoop.stableResistanceWindowCount) ||
    session.openLoop.stableResistanceWindowCount < 0)) return false;
  if (session.provenanceV2 !== undefined && session.provenanceV2 !== null &&
    !provenanceV2Valid(session.provenanceV2)) return false;
  return session.domainBucket === "interior" || session.domainBucket === "edge";
}

function heldWorkloadForwardSessionValid(value: unknown): value is ScientificAssessmentHeldWorkloadForwardSession {
  return isRecord(value) && isNonEmptyString(value.workoutSessionId) &&
    Number.isInteger(value.qualifyingWindowCount) && (value.qualifyingWindowCount as number) >= 1 &&
    Number.isInteger(value.qualifyingDurationSec) && (value.qualifyingDurationSec as number) >= 1 &&
    isFiniteNumber(value.medianSignedErrorBpm) &&
    isFiniteNumber(value.medianAbsoluteErrorBpm) && value.medianAbsoluteErrorBpm >= 0;
}

/** One entry per workout; malformed or duplicated entries are dropped (fail closed). */
function heldWorkloadForwardDigest(
  entries: readonly ScientificAssessmentHeldWorkloadForwardSession[] | undefined,
  comparable: boolean
): { count: number; signed: number | null; absolute: number | null } {
  if (!comparable || !Array.isArray(entries)) return { count: 0, signed: null, absolute: null };
  const ids = new Map<string, number>();
  for (const entry of entries) {
    if (isRecord(entry) && isNonEmptyString(entry.workoutSessionId)) {
      ids.set(entry.workoutSessionId, (ids.get(entry.workoutSessionId) ?? 0) + 1);
    }
  }
  const valid = entries.filter((entry) =>
    heldWorkloadForwardSessionValid(entry) && ids.get(entry.workoutSessionId) === 1);
  const signed = sortedMedian(valid.map((entry) => entry.medianSignedErrorBpm));
  const absolute = sortedMedian(valid.map((entry) => entry.medianAbsoluteErrorBpm));
  return {
    count: valid.length,
    signed: signed === null ? null : Math.round(signed * 10) / 10,
    absolute: absolute === null ? null : Math.round(absolute * 10) / 10,
  };
}

const HELD_CONTEXTS: readonly ScientificAssessmentHeldActuationContext[] = [
  "automatic_selected",
  "programmatic_selected",
  "no_app_selector_observed",
  "unknown",
];

function countValid(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Strict policy-v2 trust boundary. Exact vocabularies and exact keys; the
 * comparability flag must agree with its reason; provenance absence must be
 * consistent everywhere; contexts exist exactly when the timed join is
 * available and must account for exactly the durable qualifying windows.
 */
function provenanceV2Valid(value: ScientificAssessmentSessionProvenanceV2, requireHeld = false): boolean {
  if (!isRecord(value) || value.independentOpenLoopEvidence !== false ||
    !exactKeys(value, ["machineComparison", "actuationCapture", "heldWorkload", "independentOpenLoopEvidence"])) return false;
  const comparison = value.machineComparison;
  if (!isRecord(comparison) || !exactKeys(comparison, ["comparable", "reason"]) ||
    typeof comparison.comparable !== "boolean" ||
    !(SCIENTIFIC_MACHINE_COMPARABILITY_REASONS_V2 as readonly unknown[]).includes(comparison.reason)) return false;
  if (comparison.comparable !== (comparison.reason === "same_machine_and_profile")) return false;
  if (value.actuationCapture !== "complete" && value.actuationCapture !== "incomplete" &&
    value.actuationCapture !== "unavailable") return false;
  const provenanceAbsent = value.actuationCapture === "unavailable";
  if (provenanceAbsent !== (comparison.reason === "execution_provenance_unavailable")) return false;
  const held = value.heldWorkload;
  if (held === null) return !requireHeld;
  if (!isRecord(held) ||
    !exactKeys(held, ["available", "timedJoin", "qualifyingWindowCount", "qualifyingDurationSec", "contexts"]) ||
    typeof held.available !== "boolean" ||
    !(SCIENTIFIC_TIMED_ACTUATION_JOINS_V2 as readonly unknown[]).includes(held.timedJoin) ||
    !countValid(held.qualifyingWindowCount) || !countValid(held.qualifyingDurationSec)) return false;
  if (requireHeld && !held.available) return false;
  if ((held.timedJoin === "execution_provenance_unavailable") !== provenanceAbsent &&
    !(provenanceAbsent && held.timedJoin === "not_applicable")) return false;
  if ((held.timedJoin === "available") !== (held.contexts !== null)) return false;
  if (held.contexts === null) return true;
  if (!isRecord(held.contexts) || !exactKeys(held.contexts, HELD_CONTEXTS)) return false;
  let windows = 0;
  let duration = 0;
  for (const context of HELD_CONTEXTS) {
    const totals = held.contexts[context];
    if (!isRecord(totals) || !exactKeys(totals, ["windowCount", "durationSec"]) ||
      !countValid(totals.windowCount) || !countValid(totals.durationSec)) return false;
    windows += totals.windowCount;
    duration += totals.durationSec;
  }
  // Window-level classification covers exactly the durable qualifying windows.
  return windows === held.qualifyingWindowCount && duration === held.qualifyingDurationSec;
}

/** Held-response cohort row: identity is checked exactly like a transfer row; no closed-loop value exists. */
function heldSessionValid(session: ScientificHeldSessionEvidenceV2): boolean {
  if (!isRecord(session) || !isNonEmptyString(session.workoutSessionId) || utcDateKey(session.createdAt) === null) return false;
  if (!isRecord(session.legacyHrBand) ||
    !isFiniteNumber(session.legacyHrBand.minBpm) || !isFiniteNumber(session.legacyHrBand.maxBpm) ||
    session.legacyHrBand.minBpm <= 0 || session.legacyHrBand.maxBpm < session.legacyHrBand.minBpm) return false;
  if (isRecord(session.calibration) && isIsoDateTime(session.calibration.observedAt) &&
    Date.parse(session.createdAt) < Date.parse(session.calibration.observedAt)) return false;
  return provenanceV2Valid(session.provenanceV2, true);
}

function emptyHeldContextDigest(): ScientificAssessmentProvenanceDigestV2["heldContexts"] {
  return {
    automatic_selected: { sessions: 0, windows: 0, durationSec: 0 },
    programmatic_selected: { sessions: 0, windows: 0, durationSec: 0 },
    no_app_selector_observed: { sessions: 0, windows: 0, durationSec: 0 },
    unknown: { sessions: 0, windows: 0, durationSec: 0 },
  };
}

function unsupportedPolicyAssessment(
  subject: ScientificAssessmentSubject,
  policy: unknown,
  evaluatedAt: string
): ScientificAssessment {
  const record = isRecord(policy) ? policy : {};
  return {
    schemaVersion: SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1,
    assessor: { id: SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1, version: SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1 },
    policy: { id: String(record.id ?? ""), version: Number.isInteger(record.version) ? record.version as number : -1 },
    subject,
    mode: "scientific_assessment",
    runtimeAuthority: false,
    state: "not_applicable",
    reasonCodes: ["unsupported_policy"],
    gates: [{ id: "policy", status: "fail", reasonCode: "unsupported_policy" }],
    evidenceDigest: {
      sessionCount: 0,
      distinctDateCount: 0,
      calendarSpanDays: null,
      sessionIds: [],
      interiorSessionCount: 0,
      saturationIncidence: null,
      medianSignedDifferenceWatts: null,
      medianAbsoluteDifferenceWatts: null,
      medianCandidateWidthWatts: null,
      observedSettledWattsCv: null,
      newestSessionAgeDays: null,
      calibrationInstanceId: "",
      excludedIncompleteIdentitySessions: 0,
      excludedMultiPhaseSessions: 0,
      ignoredCrossCohortSessions: 0,
      ignoredInvalidSessions: 0,
      heldWorkloadForwardSessionCount: 0,
      medianHeldWorkloadForwardSignedErrorBpm: null,
      medianHeldWorkloadForwardAbsoluteErrorBpm: null,
    },
    evaluatedAt,
  };
}

function orderReasons(reasons: Iterable<ScientificAssessmentReasonCode>): ScientificAssessmentReasonCode[] {
  const rank = new Map<ScientificAssessmentReasonCode, number>(
    REASON_ORDER.map((reason, index) => [reason, index])
  );
  return [...new Set(reasons)].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
}

function utcDateKey(createdAt: string): string | null {
  if (!isIsoDateTime(createdAt)) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(createdAt)) return null;
  return createdAt.slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return (to - from) / (24 * 60 * 60 * 1000);
}

interface GateAccumulator {
  gates: ScientificAssessmentGate[];
  reasons: ScientificAssessmentReasonCode[];
  push(id: string, status: ScientificAssessmentGateStatus, reasonCode?: ScientificAssessmentReasonCode,
    measured?: Record<string, number | string | null>): void;
}

function createAccumulator(): GateAccumulator {
  const gates: ScientificAssessmentGate[] = [];
  const reasons: ScientificAssessmentReasonCode[] = [];
  return {
    gates,
    reasons,
    push(id, status, reasonCode, measured) {
      const gate: ScientificAssessmentGate = { id, status };
      if (reasonCode !== undefined && status === "fail") gate.reasonCode = reasonCode;
      if (measured !== undefined) gate.measured = measured;
      gates.push(gate);
      if (status === "fail" && reasonCode !== undefined) reasons.push(reasonCode);
    },
  };
}

/**
 * Pure scientific assessor. Deterministic in (evidence, subject, policy,
 * evaluatedAt); no storage, clock, profile, machine, UI, or control access.
 * Never recomputes E1/E2 values — it only gates frozen evidence.
 *
 * E4A evaluates E1; it never modifies E1. There is no candidate correction,
 * bias compensation, adaptive offset, or learned watt target here. A
 * corrected workload would be a future separate modality with its own shadow
 * and authorization path.
 */
export function assessPersonalizedWorkloadEvidence(
  evidence: ScientificAssessmentEvidence,
  subject: ScientificAssessmentSubject,
  policy: ScientificAssessmentPolicy | ScientificAssessmentPolicyV2,
  evaluatedAt: string
): ScientificAssessment {
  const generation = policyGeneration(policy);
  if (generation === null) return unsupportedPolicyAssessment(subject, policy, evaluatedAt);
  const acc = createAccumulator();

  const subjectIdentityOk =
    isNonEmptyString(subject.athleteId) &&
    subject.activity === "bike" &&
    subject.phaseKind === "work" &&
    (subject.intensityId === "threshold" || subject.intensityId === "aerobic_base") &&
    subject.modality === "legacy_hr_region_workload" &&
    subject.phaseStructureClass === null;
  const calibrationOk = calibrationIdentityValid(subject.calibration);
  const subjectSessionIds: readonly string[] = isRecord(subject.calibration) &&
    Array.isArray(subject.calibration.evidenceSessionIds)
    ? subject.calibration.evidenceSessionIds
    : [];
  const athleteOk = isNonEmptyString(subject.athleteId);
  const machineOk =
    isNonEmptyString(subject.machineId) && Number.isInteger(subject.machineProfileVersion);
  const bandOk =
    isRecord(subject.legacyHrBand) &&
    isFiniteNumber(subject.legacyHrBand.minBpm) &&
    isFiniteNumber(subject.legacyHrBand.maxBpm) &&
    (subject.legacyHrBand.minBpm as number) > 0 &&
    (subject.legacyHrBand.maxBpm as number) >= (subject.legacyHrBand.minBpm as number);
  const observedProvenanceOk =
    subject.observedPowerProvenance === "measured_watts" ||
    subject.observedPowerProvenance === "calibrated_watts";

  if (!subjectIdentityOk) {
    acc.push("identity", "fail", !athleteOk || !calibrationOk
      ? "identity_incomplete_calibration"
      : !machineOk
        ? "identity_incomplete_machine"
        : "unsupported_modality");
  } else if (!athleteOk || !calibrationOk) {
    acc.push("identity", "fail", "identity_incomplete_calibration");
  } else if (!machineOk) {
    acc.push("identity", "fail", "identity_incomplete_machine");
  } else {
    acc.push("identity", "pass");
  }
  const identityPass = acc.gates[acc.gates.length - 1].status === "pass";

  // Candidate availability is judged only for a valid subject; an invalid
  // subject already reports its identity reason without piling on.
  if (!identityPass) {
    acc.push("candidate_availability", "not_applicable");
  } else if (!bandOk || !observedProvenanceOk || evidence.candidateStatus === "unavailable") {
    acc.push("candidate_availability", "fail", "candidate_unavailable", {
      candidateStatus: evidence.candidateStatus,
    });
  } else if (evidence.candidateStatus === "outside_domain") {
    acc.push("candidate_availability", "fail", "candidate_outside_domain", {
      candidateStatus: evidence.candidateStatus,
    });
  } else if (evidence.candidateStatus === "available") {
    acc.push("candidate_availability", "pass", undefined, { candidateStatus: evidence.candidateStatus });
  } else {
    // Unknown status values fail closed rather than reading as available.
    acc.push("candidate_availability", "fail", "candidate_unavailable", {
      candidateStatus: String(evidence.candidateStatus),
    });
  }
  const candidatePass = acc.gates[acc.gates.length - 1].status === "pass";

  // Hardened cohort isolation inside the assessor itself: only sessions
  // matching every subject identity dimension participate. Cross-cohort
  // sessions are ignored and counted, never pooled. A subject whose own
  // identity is incomplete matches nothing (fail closed).
  // Sessions are then put in canonical ID order so every derived value,
  // including floating-point sums, is independent of input order.
  const subjectComparable = identityPass && bandOk;
  let ignoredCrossCohortSessions = 0;
  let ignoredInvalidSessions = 0;
  const cohortSessions = [...(evidence.sessions ?? [])].filter((session) => {
    if (!subjectComparable || !sessionMatchesSubject(session, subject)) {
      ignoredCrossCohortSessions += 1;
      return false;
    }
    return true;
  });
  const idCounts = new Map<string, number>();
  for (const session of cohortSessions) {
    idCounts.set(session.workoutSessionId, (idCounts.get(session.workoutSessionId) ?? 0) + 1);
  }
  // Malformed evidence (unparseable timestamp, non-finite measurement,
  // unknown domain bucket) and duplicated workout session IDs cannot count as
  // independent sessions; every copy is excluded rather than picking one.
  const validSessions = cohortSessions.filter((session) => {
    if (sessionEvidenceValid(session) && idCounts.get(session.workoutSessionId) === 1) return true;
    ignoredInvalidSessions += 1;
    return false;
  }).sort((a, b) => a.workoutSessionId.localeCompare(b.workoutSessionId));

  if (!identityPass || !candidatePass) {
    acc.push("provenance", "not_applicable");
  } else {
    acc.push("provenance", "pass", undefined, {
      calibrationProvenance: subject.calibration.workloadProvenance,
      observedProvenance: subject.observedPowerProvenance,
    });
  }

  const evaluable = identityPass && candidatePass;

  // Policy v2: exact machine/profile/calibration comparability is an admission
  // rule, applied independently to each evidence channel. Incomparable
  // sessions are excluded (counted by reason); they never contribute to
  // bias/variance, so a mismatch can never read as contradiction.
  const excludedTransferMachineIncomparableSessions: Record<string, number> = {};
  const sessions = generation === 1 ? validSessions : validSessions.filter((session) => {
    if (session.provenanceV2?.machineComparison.comparable === true) return true;
    const reason = session.provenanceV2?.machineComparison.reason ?? "execution_provenance_unavailable";
    excludedTransferMachineIncomparableSessions[reason] = (excludedTransferMachineIncomparableSessions[reason] ?? 0) + 1;
    return false;
  });
  // Policy v2 held-response cohort: subject-matching held-forward workouts,
  // independent of closed-loop characterization and HR-band success.
  let ignoredInvalidHeldSessions = 0;
  const excludedHeldMachineIncomparableSessions: Record<string, number> = {};
  let heldSessions: ScientificHeldSessionEvidenceV2[] = [];
  let validHeldCount = 0;
  if (generation === 2) {
    const candidates = [...(evidence.heldSessionsV2 ?? [])];
    const heldIds = new Map<string, number>();
    for (const session of candidates) {
      if (isRecord(session) && isNonEmptyString(session.workoutSessionId)) {
        heldIds.set(session.workoutSessionId, (heldIds.get(session.workoutSessionId) ?? 0) + 1);
      }
    }
    const validHeld = candidates.filter((session) => {
      if (subjectComparable && heldSessionValid(session) && sessionMatchesSubject(session, subject) &&
        heldIds.get(session.workoutSessionId) === 1) return true;
      ignoredInvalidHeldSessions += 1;
      return false;
    }).sort((a, b) => a.workoutSessionId.localeCompare(b.workoutSessionId));
    validHeldCount = validHeld.length;
    heldSessions = validHeld.filter((session) => {
      if (session.provenanceV2.machineComparison.comparable) return true;
      const reason = session.provenanceV2.machineComparison.reason;
      excludedHeldMachineIncomparableSessions[reason] = (excludedHeldMachineIncomparableSessions[reason] ?? 0) + 1;
      return false;
    });
  }
  let machinePass = true;
  if (generation === 2) {
    const measured = {
      transferComparableSessions: sessions.length,
      transferExcludedSessions: validSessions.length - sessions.length,
      heldComparableSessions: heldSessions.length,
      heldExcludedSessions: validHeldCount - heldSessions.length,
    };
    if (!evaluable || validSessions.length + validHeldCount === 0) {
      acc.push("machine_comparability", "not_applicable");
    } else if (sessions.length + heldSessions.length === 0) {
      acc.push("machine_comparability", "fail", "machine_comparability_unavailable", measured);
    } else {
      acc.push("machine_comparability", "pass", undefined, measured);
    }
    machinePass = acc.gates[acc.gates.length - 1].status !== "fail";
  }
  const dateKeys = new Map<string, number>();
  for (const session of sessions) {
    const key = utcDateKey(session.createdAt);
    if (key !== null) dateKeys.set(key, (dateKeys.get(key) ?? 0) + 1);
  }
  const distinctDateCount = dateKeys.size;
  const orderedTimes = sessions
    .map((session) => Date.parse(session.createdAt))
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);
  const calendarSpanDays = orderedTimes.length === 0
    ? null
    : (orderedTimes[orderedTimes.length - 1] - orderedTimes[0]) / (24 * 60 * 60 * 1000);
  const interiorCount = sessions.filter((session) => session.domainBucket === "interior").length;
  const saturatedCount = sessions.filter((session) => session.saturationRatio > 0).length;
  const saturationIncidence = sessions.length === 0 ? null : saturatedCount / sessions.length;
  const signedValues = sessions.map((session) => session.signedDifferenceWatts);
  const absoluteValues = sessions.map((session) => session.absoluteDifferenceWatts);
  const widthValues = sessions.map((session) => session.candidateWidthWatts);
  const medianSigned = sortedMedian(signedValues);
  const medianAbsolute = sortedMedian(absoluteValues);
  const medianWidth = sortedMedian(widthValues);
  const settledCv = coefficientOfVariation(sessions.map((session) => session.observedSettledWatts));
  // Pure timestamp arithmetic only, parsed from caller-supplied ISO strings.
  // The evaluator never samples the clock; timestamps arrive as arguments.
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const newestAgeDays = orderedTimes.length === 0 || !Number.isFinite(evaluatedAtMs)
    ? null
    : (evaluatedAtMs - orderedTimes[orderedTimes.length - 1]) / (24 * 60 * 60 * 1000);

  if (!evaluable) {
    acc.push("independent_session_volume", "not_applicable");
  } else if (sessions.length < policy.minIndependentSessions) {
    acc.push("independent_session_volume", "fail", "insufficient_independent_sessions", {
      sessionCount: sessions.length,
      required: policy.minIndependentSessions,
    });
  } else {
    acc.push("independent_session_volume", "pass", undefined, {
      sessionCount: sessions.length,
      required: policy.minIndependentSessions,
    });
  }
  const volumePass = acc.gates[acc.gates.length - 1].status === "pass";

  if (!evaluable) {
    acc.push("calendar_spread", "not_applicable");
  } else if (distinctDateCount < policy.minDistinctDates ||
    calendarSpanDays === null || calendarSpanDays < policy.minCalendarSpanDays) {
    acc.push("calendar_spread", "fail", "insufficient_calendar_spread", {
      distinctDates: distinctDateCount,
      requiredDates: policy.minDistinctDates,
      spanDays: calendarSpanDays,
      requiredSpanDays: policy.minCalendarSpanDays,
    });
  } else {
    acc.push("calendar_spread", "pass", undefined, {
      distinctDates: distinctDateCount,
      requiredDates: policy.minDistinctDates,
      spanDays: calendarSpanDays === null ? null : Math.round(calendarSpanDays * 10) / 10,
      requiredSpanDays: policy.minCalendarSpanDays,
    });
  }
  const spreadPass = acc.gates[acc.gates.length - 1].status === "pass";

  if (!evaluable) {
    acc.push("domain_support", "not_applicable");
  } else if (interiorCount < policy.characterizationMinInteriorSessions) {
    acc.push("domain_support", "fail", "edge_domain_only", {
      interiorSessions: interiorCount,
      requiredInterior: policy.characterizationMinInteriorSessions,
    });
  } else {
    acc.push("domain_support", "pass", undefined, {
      interiorSessions: interiorCount,
      requiredInterior: policy.characterizationMinInteriorSessions,
    });
  }
  const domainPass = acc.gates[acc.gates.length - 1].status === "pass";

  // Descriptive precision dimension: candidate width is evidence, reported
  // but never gated. Width depends on the HR band and calibration slope that
  // E1 controls, so it cannot be a success criterion on its own.
  if (!evaluable || sessions.length === 0) {
    acc.push("candidate_precision", "not_applicable");
  } else {
    acc.push("candidate_precision", "pass", undefined, {
      medianCandidateWidthWatts: medianWidth,
    });
  }

  // Signed bias and repeatability are evidence, not verdicts, until an
  // explicit policy gate evaluates them — and only on adequate, informative
  // evidence (volume + spread + domain + saturation all pass). HR-in-band
  // occupancy and inside-candidate agreement are never consulted anywhere in
  // this module: they measure closed-loop controller performance, not
  // candidate quality.
  const informative = volumePass && spreadPass && domainPass;
  if (!evaluable || sessions.length === 0) {
    acc.push("signed_bias", "not_applicable");
    acc.push("repeatability", "not_applicable");
  } else {
    if (medianSigned === null ||
      Math.abs(medianSigned) <= policy.characterizationMaxMedianAbsoluteBiasWatts) {
      acc.push("signed_bias", "pass", undefined, {
        medianSignedDifferenceWatts: medianSigned,
        maxAbsoluteBiasWatts: policy.characterizationMaxMedianAbsoluteBiasWatts,
      });
    } else if (medianSigned > 0) {
      acc.push("signed_bias", "fail", "persistent_signed_bias_positive", {
        medianSignedDifferenceWatts: Math.round(medianSigned * 10) / 10,
        maxAbsoluteBiasWatts: policy.characterizationMaxMedianAbsoluteBiasWatts,
      });
    } else {
      acc.push("signed_bias", "fail", "persistent_signed_bias_negative", {
        medianSignedDifferenceWatts: Math.round(medianSigned * 10) / 10,
        maxAbsoluteBiasWatts: policy.characterizationMaxMedianAbsoluteBiasWatts,
      });
    }
    if (settledCv === null || settledCv <= policy.characterizationMaxSettledWattsCv) {
      acc.push("repeatability", "pass", undefined, {
        settledWattsCv: settledCv,
        maxCv: policy.characterizationMaxSettledWattsCv,
      });
    } else {
      acc.push("repeatability", "fail", "variance_exceeds_policy", {
        settledWattsCv: Math.round(settledCv * 1000) / 1000,
        maxCv: policy.characterizationMaxSettledWattsCv,
      });
    }
  }
  const biasFail = acc.gates[acc.gates.length - 2].status === "fail";
  const varianceFail = acc.gates[acc.gates.length - 1].status === "fail";

  if (!evaluable) {
    acc.push("controller_saturation", "not_applicable");
  } else if (saturationIncidence !== null &&
    saturationIncidence > policy.characterizationMaxSaturationIncidence) {
    acc.push("controller_saturation", "fail", "controller_saturation_dominant", {
      saturationIncidence: Math.round(saturationIncidence * 1000) / 1000,
      maxIncidence: policy.characterizationMaxSaturationIncidence,
    });
  } else {
    acc.push("controller_saturation", "pass", undefined, {
      saturationIncidence,
      maxIncidence: policy.characterizationMaxSaturationIncidence,
    });
  }
  const saturationPass = acc.gates[acc.gates.length - 1].status === "pass";

  // Open-loop and actuation-mode gates make the current evidence gap visible
  // instead of letting closed-loop agreement pass as validation. Under a
  // policy that declares the dimension `required_but_unavailable` (the
  // production policy) the gate fails whatever the sessions carry; otherwise
  // it passes only when every session carries future open-loop evidence.
  let heldPass = true;
  let actuationContextPass = true;
  let provenanceDigest: ScientificAssessmentProvenanceDigestV2 | undefined;
  if (generation === 2) {
    const v2 = assessProvenanceV2(acc, heldSessions, evaluable);
    heldPass = v2.heldPass;
    actuationContextPass = v2.actuationContextPass;
    const sortedCounts = (counts: Record<string, number>) =>
      Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
    provenanceDigest = {
      transferComparableSessionCount: sessions.length,
      heldComparableSessionCount: heldSessions.length,
      excludedTransferMachineIncomparableSessions: sortedCounts(excludedTransferMachineIncomparableSessions),
      excludedHeldMachineIncomparableSessions: sortedCounts(excludedHeldMachineIncomparableSessions),
      ignoredInvalidHeldSessions,
      ...v2.digest,
    };
  } else if (!evaluable || sessions.length === 0) {
    acc.push("open_loop_evidence", "not_applicable");
    acc.push("actuation_mode_evidence", "not_applicable");
  } else {
    const openLoopSessions = sessions.filter((session) =>
      session.openLoop !== null &&
      isFiniteNumber(session.openLoop.stableResistanceWindowCount) &&
      (session.openLoop.stableResistanceWindowCount as number) >= 1).length;
    if (policy.openLoopEvidence === "required" && openLoopSessions === sessions.length) {
      acc.push("open_loop_evidence", "pass", undefined, {
        sessionsWithOpenLoop: openLoopSessions,
        sessionCount: sessions.length,
      });
    } else {
      acc.push("open_loop_evidence", "fail", "open_loop_evidence_unavailable", {
        policy: policy.openLoopEvidence,
        sessionsWithOpenLoop: openLoopSessions,
        sessionCount: sessions.length,
      });
    }
    const knownModeSessions = sessions.filter((session) =>
      session.actuationMode === "automatic" || session.actuationMode === "manual").length;
    if ((policy as ScientificAssessmentPolicy).actuationModeEvidence === "required" && knownModeSessions === sessions.length) {
      acc.push("actuation_mode_evidence", "pass", undefined, {
        sessionsWithKnownMode: knownModeSessions,
        sessionCount: sessions.length,
      });
    } else {
      acc.push("actuation_mode_evidence", "fail", "actuation_mode_unknown", {
        policy: (policy as ScientificAssessmentPolicy).actuationModeEvidence,
        sessionsWithKnownMode: knownModeSessions,
        sessionCount: sessions.length,
      });
    }
  }
  const openLoopPass = generation === 2
    ? acc.gates.find((gate) => gate.id === "open_loop_evidence")?.status === "pass"
    : acc.gates[acc.gates.length - 2].status === "pass";
  const actuationPass = generation === 2
    ? actuationContextPass
    : acc.gates[acc.gates.length - 1].status === "pass";

  if (!evaluable || sessions.length === 0 || policy.staleness === "not_configured") {
    acc.push("recency", "unavailable", undefined, { newestSessionAgeDays: newestAgeDays });
  } else if (newestAgeDays === null || newestAgeDays < 0) {
    // Caller-supplied `evaluatedAt` is not parseable, or precedes the newest
    // evidence (impossible chronology), so recency cannot be trusted.
    // Reported `unavailable` (blocks `eligible` when configured) rather than
    // treating negative age as fresh or inventing `stale` from a bad input.
    acc.push("recency", "unavailable", undefined, { newestSessionAgeDays: newestAgeDays });
  } else if (newestAgeDays > policy.staleness.maxDaysSinceNewestSession) {
    acc.push("recency", "fail", "evidence_stale", {
      newestSessionAgeDays: newestAgeDays,
      maxDaysSinceNewestSession: policy.staleness.maxDaysSinceNewestSession,
    });
  } else {
    acc.push("recency", "pass", undefined, {
      newestSessionAgeDays: newestAgeDays === null ? null : Math.round(newestAgeDays * 10) / 10,
      maxDaysSinceNewestSession: policy.staleness.maxDaysSinceNewestSession,
    });
  }
  const recencyFail = acc.gates[acc.gates.length - 1].status === "fail";
  const recencyUndetermined = policy.staleness !== "not_configured" &&
    acc.gates[acc.gates.length - 1].status === "unavailable";

  if (!identityPass) {
    acc.push("supersession", "not_applicable");
  } else if (evidence.currentCalibration === null) {
    // Type seam: without a caller-supplied trustworthy current-calibration
    // identity, supersession cannot be evaluated and stays unreachable.
    acc.push("supersession", "unavailable");
  } else if (!calibrationIdentityValid(evidence.currentCalibration) ||
    !calibrationEquals(evidence.currentCalibration, subject.calibration)) {
    acc.push("supersession", "fail", "calibration_superseded");
  } else {
    acc.push("supersession", "pass");
  }
  const superseded = acc.gates[acc.gates.length - 1].status === "fail";
  const supersessionPass = acc.gates[acc.gates.length - 1].status === "pass";

  // State precedence:
  //   not_applicable -> superseded -> stale -> collecting (inadequate
  //   evidence) -> contradicted -> collecting (required dimension
  //   unavailable) -> eligible.
  // `stale` requires previously adequate evidence (volume + spread pass);
  // otherwise thin old evidence is `collecting`. `contradicted` requires
  // adequate, informative evidence (volume + spread + domain + saturation
  // pass) but deliberately not open-loop / actuation-mode / currency
  // evidence: disagreement on closed-loop evidence is still disagreement,
  // whereas agreement on it is never proof. Those dimensions, a configured
  // but undeterminable recency, and an unknown current calibration only
  // block `eligible`.
  let state: ScientificAssessmentState;
  if (!identityPass || !candidatePass) {
    state = "not_applicable";
  } else if (superseded) {
    state = "superseded";
  } else if (recencyFail && volumePass && spreadPass) {
    state = "stale";
  } else if (!informative || !saturationPass || recencyFail) {
    state = "collecting";
  } else if (biasFail || varianceFail) {
    state = "contradicted";
  } else if (!openLoopPass || !actuationPass || !machinePass || !heldPass || recencyUndetermined ||
    !supersessionPass) {
    state = "collecting";
  } else {
    state = "eligible";
  }

  const heldForward = heldWorkloadForwardDigest(evidence.heldWorkloadForwardSessions, subjectComparable);

  return {
    schemaVersion: SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1,
    assessor: {
      id: SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1,
      version: SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1,
    },
    policy: { id: policy.id, version: policy.version },
    subject: {
      ...subject,
      calibration: {
        ...subject.calibration,
        evidenceSessionIds: [...subjectSessionIds],
      },
      legacyHrBand: { ...subject.legacyHrBand },
    },
    mode: "scientific_assessment",
    runtimeAuthority: false,
    state,
    reasonCodes: orderReasons(acc.reasons),
    gates: acc.gates,
    evidenceDigest: {
      sessionCount: sessions.length,
      distinctDateCount,
      calendarSpanDays: calendarSpanDays === null ? null : Math.round(calendarSpanDays * 10) / 10,
      sessionIds: sessions.map((session) => session.workoutSessionId).sort((a, b) => a.localeCompare(b)),
      interiorSessionCount: interiorCount,
      saturationIncidence: saturationIncidence === null
        ? null
        : Math.round(saturationIncidence * 1000) / 1000,
      medianSignedDifferenceWatts: medianSigned === null ? null : Math.round(medianSigned * 10) / 10,
      medianAbsoluteDifferenceWatts: medianAbsolute === null
        ? null
        : Math.round(medianAbsolute * 10) / 10,
      medianCandidateWidthWatts: medianWidth === null ? null : Math.round(medianWidth * 10) / 10,
      observedSettledWattsCv: settledCv === null ? null : Math.round(settledCv * 10000) / 10000,
      newestSessionAgeDays: newestAgeDays === null ? null : Math.round(newestAgeDays * 10) / 10,
      calibrationInstanceId: normalizedSessionIds(subjectSessionIds).join(","),
      excludedIncompleteIdentitySessions: evidence.excludedIncompleteIdentitySessions ?? 0,
      excludedMultiPhaseSessions: evidence.excludedMultiPhaseSessions ?? 0,
      ignoredCrossCohortSessions,
      ignoredInvalidSessions,
      heldWorkloadForwardSessionCount: heldForward.count,
      medianHeldWorkloadForwardSignedErrorBpm: heldForward.signed,
      medianHeldWorkloadForwardAbsoluteErrorBpm: heldForward.absolute,
      ...(provenanceDigest ? { provenanceV2: provenanceDigest } : {}),
    },
    evaluatedAt,
  };
}

/**
 * Policy v2 provenance gates over the machine-comparable held-response cohort
 * (one workout = one session, however many held windows it contains). The
 * closed-loop transfer cohort is never consulted here:
 * held_workload_evidence → actuation_context (is window-level context known?)
 * → per-category context gates (truthful, non-independent categories) →
 * open_loop_evidence (never satisfied: no category is independent evidence).
 */
function assessProvenanceV2(
  acc: GateAccumulator,
  sessions: readonly ScientificHeldSessionEvidenceV2[],
  evaluable: boolean
): {
  heldPass: boolean;
  actuationContextPass: boolean;
  digest: Omit<ScientificAssessmentProvenanceDigestV2, "transferComparableSessionCount" |
    "heldComparableSessionCount" | "excludedTransferMachineIncomparableSessions" |
    "excludedHeldMachineIncomparableSessions" | "ignoredInvalidHeldSessions">;
} {
  const held = sessions.filter((session) => session.provenanceV2?.heldWorkload?.available === true);
  const joined = held.filter((session) =>
    session.provenanceV2!.heldWorkload!.timedJoin === "available" && session.provenanceV2!.heldWorkload!.contexts !== null);
  const contexts = emptyHeldContextDigest();
  for (const session of joined) {
    const totals = session.provenanceV2!.heldWorkload!.contexts!;
    for (const context of HELD_CONTEXTS) {
      if (totals[context].windowCount > 0) contexts[context].sessions += 1;
      contexts[context].windows += totals[context].windowCount;
      contexts[context].durationSec += totals[context].durationSec;
    }
  }
  const digest = {
    sessionsWithHeldWorkloadEvidence: held.length,
    sessionsWithTimedActuationJoin: joined.length,
    heldContexts: contexts,
    independentOpenLoopEvidence: "unavailable" as const,
  };
  if (!evaluable || sessions.length === 0) {
    for (const id of ["held_workload_evidence", "actuation_context", "controller_selected_context",
      "programmatic_selected_context", "no_app_selector_context"]) {
      acc.push(id, "not_applicable");
    }
    // For a valid subject, independent open-loop evidence is unavailable whatever the session count.
    if (evaluable) {
      acc.push("open_loop_evidence", "fail", "open_loop_evidence_unavailable", {
        policy: "required_but_unavailable",
        independentSessions: 0,
        sessionCount: 0,
      });
    } else {
      acc.push("open_loop_evidence", "not_applicable");
    }
    return { heldPass: true, actuationContextPass: true, digest };
  }
  if (held.length === 0) {
    acc.push("held_workload_evidence", "fail", "held_workload_evidence_unavailable", {
      sessionsWithHeldEvidence: 0,
      sessionCount: sessions.length,
    });
  } else {
    acc.push("held_workload_evidence", "pass", undefined, {
      sessionsWithHeldEvidence: held.length,
      sessionCount: sessions.length,
    });
  }
  const heldPass = acc.gates[acc.gates.length - 1].status === "pass";

  const measured = { sessionsWithHeldEvidence: held.length, sessionsWithTimedJoin: joined.length };
  if (held.length === 0) {
    acc.push("actuation_context", "not_applicable");
  } else if (held.some((session) => session.provenanceV2!.heldWorkload!.timedJoin === "execution_provenance_unavailable" ||
    session.provenanceV2!.actuationCapture === "unavailable")) {
    acc.push("actuation_context", "fail", "actuation_provenance_unavailable", measured);
  } else if (joined.length !== held.length) {
    acc.push("actuation_context", "fail", "timed_actuation_join_unavailable", measured);
  } else if (held.some((session) => session.provenanceV2!.actuationCapture !== "complete")) {
    acc.push("actuation_context", "fail", "actuation_capture_incomplete", measured);
  } else if (contexts.unknown.windows > 0) {
    acc.push("actuation_context", "fail", "actuation_context_unknown", {
      ...measured,
      unknownWindows: contexts.unknown.windows,
    });
  } else {
    acc.push("actuation_context", "pass", undefined, measured);
  }
  const actuationContextPass = acc.gates[acc.gates.length - 1].status !== "fail";

  const category = (id: string, context: ScientificAssessmentHeldActuationContext,
    reason: ScientificAssessmentReasonCode) => {
    const totals = contexts[context];
    if (totals.windows === 0) acc.push(id, "not_applicable");
    else acc.push(id, "fail", reason, { sessions: totals.sessions, windows: totals.windows, durationSec: totals.durationSec });
  };
  category("controller_selected_context", "automatic_selected", "controller_selected_evidence");
  category("programmatic_selected_context", "programmatic_selected", "programmatic_selected_evidence");
  category("no_app_selector_context", "no_app_selector_observed", "no_app_selector_observed");

  acc.push("open_loop_evidence", "fail", "open_loop_evidence_unavailable", {
    policy: "required_but_unavailable",
    independentSessions: 0,
    sessionCount: sessions.length,
  });
  return { heldPass, actuationContextPass, digest };
}

/** Subject key for display, e.g. `threshold.legacy_hr_region_workload`. */
export function scientificSubjectKey(subject: ScientificAssessmentSubject): string {
  return `${subject.intensityId}.${subject.modality}`;
}

// ---------------------------------------------------------------------------
// Hardened evidence builder over frozen E2 records + diagnostic contexts.
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of the frozen E2 assessment context already
 * extracted for diagnostics. Declared locally (instead of importing the
 * diagnostics view) so the E4A module keeps a one-way dependency: the
 * diagnostics view imports E4A, never the reverse.
 */
export interface ScientificAssessmentFrozenCalibrationContext {
  observedAt: string;
  calibrationProvenance: string;
  algorithm?: { id: string; version: number };
  protocol?: { id: string; version: number };
  evidenceSessionIds?: string[];
}

export interface ScientificAssessmentFrozenWorkoutContext {
  machineId: string | null;
  machineProfileVersion: number | null;
}

export interface BuildSubjectEvidenceInput {
  subject: ScientificAssessmentSubject;
  records: readonly {
    athleteId: string;
    activity: string;
    workoutSessionId: string;
    createdAt: string;
    calibrationWorkloadProvenance?: string;
    phases: readonly {
      kind: string;
      intensityId?: string;
      characterizationOutcome: string;
      /** Durable E2 copy of the frozen E1 per-phase outcome. */
      shadowOutcome?: string;
      fallbackReason?: string;
      legacyHeartRate?: { min?: number; max?: number };
      candidatePower?: { minWatts: number; maxWatts: number };
      observedPowerProvenance: string;
      observedPower?: { provenance: string };
      controllerContext: { saturationRatio: number };
      candidateDomainMargins?: { bucket: string };
      comparison?: {
        candidateMidpointWatts: number;
        observedInBandMedianWatts: number;
        signedDifferenceWatts: number;
        absoluteDifferenceWatts: number;
        signedDifferencePercent: number;
        candidateContainsObservedMedian?: boolean;
        agreement?: string;
      };
      stableInBandWorkload?: { medianWatts: number };
      /** Phase identity used to select the v2 join for this exact phase. */
      phaseId?: string;
      intervalIndex?: number;
      activeStartSec?: number;
      /** Durable E2 v3 held-workload forward-response summary; absent on v1/v2 records. */
      heldWorkloadForwardResponse?: {
        outcome: string;
        stableResistance?: { qualifyingWindowCount: number; qualifyingDurationSec: number };
        forwardHeartRate?: { signedErrorBpm: { median: number }; absoluteErrorBpm: { median: number } };
      };
    }[];
  }[];
  assessmentContexts: Readonly<Record<string, ScientificAssessmentFrozenCalibrationContext>>;
  workoutContexts: Readonly<Record<string, ScientificAssessmentFrozenWorkoutContext>>;
  currentCalibration: ScientificAssessmentCalibrationIdentity | null;
  /** Policy v2 per-workout joins; absent means unavailable (v1 ignores it). */
  sessionEvidenceV2?: Readonly<Record<string, ScientificAssessmentSessionEvidenceV2Input>>;
}

/** No v2 join for the workout: execution provenance is unavailable, stated consistently. */
function unavailableHeldProvenance(
  stable: { qualifyingWindowCount: number; qualifyingDurationSec: number }
): ScientificAssessmentSessionProvenanceV2 {
  return {
    machineComparison: { comparable: false, reason: "execution_provenance_unavailable" },
    actuationCapture: "unavailable",
    heldWorkload: {
      available: true,
      timedJoin: "execution_provenance_unavailable",
      qualifyingWindowCount: stable.qualifyingWindowCount,
      qualifyingDurationSec: stable.qualifyingDurationSec,
      contexts: null,
    },
    independentOpenLoopEvidence: false,
  };
}

function sessionProvenanceV2(
  input: ScientificAssessmentSessionEvidenceV2Input | undefined,
  phase: FrozenPhase
): ScientificAssessmentSessionProvenanceV2 | null {
  if (!input) return null;
  const match = input.phases.find((candidate) => candidate.phaseId === phase.phaseId &&
    candidate.intervalIndex === phase.intervalIndex &&
    (phase.activeStartSec === undefined || candidate.activeStartSec === phase.activeStartSec));
  return {
    machineComparison: { ...input.machineComparison },
    actuationCapture: input.actuationCapture,
    heldWorkload: match ? {
      available: match.heldWorkload.available,
      timedJoin: match.heldWorkload.timedJoin,
      qualifyingWindowCount: match.heldWorkload.qualifyingWindowCount,
      qualifyingDurationSec: match.heldWorkload.qualifyingDurationSec,
      contexts: match.heldWorkload.contexts === null ? null : Object.fromEntries(HELD_CONTEXTS.map((context) =>
        [context, { ...match.heldWorkload.contexts![context] }])) as Record<ScientificAssessmentHeldActuationContext,
        { windowCount: number; durationSec: number }>,
    } : null,
    independentOpenLoopEvidence: false,
  };
}

type FrozenPhase = BuildSubjectEvidenceInput["records"][number]["phases"][number];

/** Frozen E1 outcome as persisted on the E2 phase: a valid candidate band exists. */
function phaseHasFrozenCandidate(phase: FrozenPhase): boolean {
  return phase.shadowOutcome === "candidate" &&
    isRecord(phase.candidatePower) &&
    isFiniteNumber(phase.candidatePower.minWatts) &&
    isFiniteNumber(phase.candidatePower.maxWatts) &&
    phase.candidatePower.maxWatts >= phase.candidatePower.minWatts;
}

function phaseIsOutsideDomainFallback(phase: FrozenPhase): boolean {
  return phase.shadowOutcome === "fallback" &&
    (phase.fallbackReason === "outside_observed_hr_range" ||
      phase.fallbackReason === "outside_observed_workload_range");
}

function sessionIdentityFrom(
  record: BuildSubjectEvidenceInput["records"][number],
  assessment: ScientificAssessmentFrozenCalibrationContext | undefined,
  workout: ScientificAssessmentFrozenWorkoutContext | undefined
): ScientificAssessmentCalibrationIdentity | null {
  const sessionIds = assessment?.evidenceSessionIds?.filter(isNonEmptyString) ?? [];
  const uniqueSorted = [...new Set(sessionIds)].sort((a, b) => a.localeCompare(b));
  if (uniqueSorted.length === 0) return null;
  if (!isIsoDateTime(assessment?.observedAt)) return null;
  if (!isNonEmptyString(assessment?.algorithm?.id)) return null;
  if (!Number.isInteger(assessment?.algorithm?.version)) return null;
  if (!isNonEmptyString(assessment?.protocol?.id)) return null;
  if (!Number.isInteger(assessment?.protocol?.version)) return null;
  const provenance = record.calibrationWorkloadProvenance ?? assessment?.calibrationProvenance;
  if (provenance !== "measured_watts" && provenance !== "calibrated_at_verified_cadence") return null;
  if (!isNonEmptyString(workout?.machineId)) return null;
  if (!Number.isInteger(workout?.machineProfileVersion)) return null;
  return {
    evidenceSessionIds: uniqueSorted,
    estimatorId: assessment.algorithm!.id,
    estimatorVersion: assessment.algorithm!.version,
    protocolId: assessment.protocol!.id,
    protocolVersion: assessment.protocol!.version,
    observedAt: assessment.observedAt,
    workloadProvenance: provenance,
  };
}

/**
 * Pure hardened cohort builder: selects exactly the sessions belonging to
 * `subject` from frozen E2 evidence. Incomplete-identity records are
 * excluded with counts (fail closed, never pooled). Records with more than
 * one characterized phase for the subject intensity are excluded rather than
 * reduced. Incomplete-identity records cannot be attributed to a cohort, so
 * that count is athlete-wide; records from another calibration instance or
 * machine contribute nothing (not even fallback status). Open-loop and actuation-mode seams are `null` / `"unknown"`
 * because no E2 record carries either: E2 v3 held-workload forward-response
 * evidence is surfaced descriptively in `heldWorkloadForwardSessions`, never as
 * open-loop evidence.
 */
export function buildSubjectEvidence(input: BuildSubjectEvidenceInput): ScientificAssessmentEvidence {
  const sessions: ScientificAssessmentSessionEvidence[] = [];
  const heldWorkloadForwardSessions: ScientificAssessmentHeldWorkloadForwardSession[] = [];
  const heldSessionsV2: ScientificHeldSessionEvidenceV2[] = [];
  let excludedIncompleteIdentitySessions = 0;
  let excludedMultiPhaseSessions = 0;
  let candidateSeen = false;
  let outsideDomainSeen = false;
  const subject = input.subject;

  for (const record of input.records) {
    if (record.athleteId !== subject.athleteId) continue;
    if (record.activity !== "bike") continue;
    const assessment = input.assessmentContexts[record.workoutSessionId];
    const workout = input.workoutContexts[record.workoutSessionId];
    const identity = sessionIdentityFrom(record, assessment, workout);
    if (identity === null) {
      // Cannot be attributed to any cohort, so it is counted athlete-wide.
      excludedIncompleteIdentitySessions += 1;
      continue;
    }
    // Record-level cohort isolation: another calibration instance or machine
    // contributes nothing to this subject, not even fallback or exclusion
    // counts.
    if (!calibrationEquals(identity, subject.calibration) ||
      workout!.machineId !== subject.machineId ||
      workout!.machineProfileVersion !== subject.machineProfileVersion) continue;
    const subjectPhases = record.phases.filter((phase) =>
      phase.kind === "work" && phase.intensityId === subject.intensityId);
    // Candidate existence comes from the frozen E1 outcome on the subject's
    // own legacy HR band, independent of whether E2 characterized the phase
    // (or whether the session is later excluded as evidence).
    for (const phase of subjectPhases) {
      if (phase.legacyHeartRate?.min !== subject.legacyHrBand.minBpm ||
        phase.legacyHeartRate?.max !== subject.legacyHrBand.maxBpm) continue;
      if (phaseHasFrozenCandidate(phase)) candidateSeen = true;
      else if (phaseIsOutsideDomainFallback(phase)) outsideDomainSeen = true;
    }
    // Every characterized phase counts toward the multi-phase rule, complete
    // or not, so an incomplete sibling cannot silently reduce a session to
    // one phase.
    const characterized = subjectPhases.filter((phase) =>
      phase.characterizationOutcome === "characterized");
    if (characterized.length > 1) {
      excludedMultiPhaseSessions += 1;
      continue;
    }
    // Held-workload forward visibility is selected independently of
    // closed-loop characterization and HR-band success, but never bypasses the
    // structural ambiguity rules: a multi-phase-excluded workout contributes
    // nothing, and a workout with more than one relevant subject phase (same
    // band, frozen candidate, same observed provenance) contributes nothing.
    // One workout is one observation, however many windows it held.
    const relevantPhases = subjectPhases.filter((phase) =>
      phase.legacyHeartRate?.min === subject.legacyHrBand.minBpm &&
      phase.legacyHeartRate?.max === subject.legacyHrBand.maxBpm &&
      phaseHasFrozenCandidate(phase) &&
      phase.observedPowerProvenance === subject.observedPowerProvenance);
    if (relevantPhases.length === 1 &&
      relevantPhases[0].heldWorkloadForwardResponse?.outcome === "characterized") {
      const heldPhase = relevantPhases[0];
      const held = heldPhase.heldWorkloadForwardResponse!;
      if (held.stableResistance && held.forwardHeartRate) {
        heldWorkloadForwardSessions.push({
          workoutSessionId: record.workoutSessionId,
          qualifyingWindowCount: held.stableResistance.qualifyingWindowCount,
          qualifyingDurationSec: held.stableResistance.qualifyingDurationSec,
          medianSignedErrorBpm: held.forwardHeartRate.signedErrorBpm.median,
          medianAbsoluteErrorBpm: held.forwardHeartRate.absoluteErrorBpm.median,
        });
        // Policy v2 held-response cohort member: the same exact subject phase,
        // with no closed-loop characterization or HR-band requirement.
        if (input.sessionEvidenceV2 && heldPhase.intensityId !== undefined) {
          heldSessionsV2.push({
            workoutSessionId: record.workoutSessionId,
            createdAt: record.createdAt,
            athleteId: record.athleteId,
            activity: record.activity,
            phaseKind: heldPhase.kind,
            intensityId: heldPhase.intensityId,
            calibration: identity,
            machineId: workout!.machineId!,
            machineProfileVersion: workout!.machineProfileVersion!,
            observedPowerProvenance: heldPhase.observedPowerProvenance as "measured_watts" | "calibrated_watts",
            legacyHrBand: { minBpm: heldPhase.legacyHeartRate!.min!, maxBpm: heldPhase.legacyHeartRate!.max! },
            provenanceV2: sessionProvenanceV2(input.sessionEvidenceV2[record.workoutSessionId], heldPhase) ??
              unavailableHeldProvenance(held.stableResistance),
          });
        }
      }
    }
    // Uncharacterized phases (E1 fallback or insufficient E2 evidence) never
    // become evidence; they only grounded the candidate status above.
    if (characterized.length === 0) continue;
    if (characterized[0].candidatePower === undefined ||
      characterized[0].comparison === undefined ||
      characterized[0].legacyHeartRate?.min === undefined ||
      characterized[0].legacyHeartRate?.max === undefined) {
      excludedIncompleteIdentitySessions += 1;
      continue;
    }
    const phase = characterized[0];
    if (phase.observedPowerProvenance !== "measured_watts" &&
      phase.observedPowerProvenance !== "calibrated_watts") {
      excludedIncompleteIdentitySessions += 1;
      continue;
    }
    const width = phase.candidatePower!.maxWatts - phase.candidatePower!.minWatts;
    const normalized = width > 0 ? phase.comparison!.absoluteDifferenceWatts / width : null;
    sessions.push({
      workoutSessionId: record.workoutSessionId,
      createdAt: record.createdAt,
      athleteId: record.athleteId,
      activity: record.activity,
      phaseKind: phase.kind,
      intensityId: phase.intensityId!,
      calibration: identity,
      machineId: workout!.machineId!,
      machineProfileVersion: workout!.machineProfileVersion!,
      observedPowerProvenance: phase.observedPowerProvenance as "measured_watts" | "calibrated_watts",
      legacyHrBand: { minBpm: phase.legacyHeartRate!.min!, maxBpm: phase.legacyHeartRate!.max! },
      candidateWidthWatts: width,
      candidateMidpointWatts: phase.comparison!.candidateMidpointWatts,
      observedSettledWatts: phase.comparison!.observedInBandMedianWatts,
      signedDifferenceWatts: phase.comparison!.signedDifferenceWatts,
      absoluteDifferenceWatts: phase.comparison!.absoluteDifferenceWatts,
      widthNormalizedAbsoluteError: normalized,
      saturationRatio: phase.controllerContext.saturationRatio,
      domainBucket: phase.candidateDomainMargins?.bucket === "interior" ? "interior" : "edge",
      assessmentAgeDays: null,
      openLoop: null,
      actuationMode: "unknown",
      ...(input.sessionEvidenceV2
        ? { provenanceV2: sessionProvenanceV2(input.sessionEvidenceV2[record.workoutSessionId], phase) }
        : {}),
    });
  }

  // Sessions matching the subject cohort exactly. Assessment age is derived
  // here (workout createdAt minus frozen formal observedAt); it remains
  // evidence in the digest, never a verdict on its own.
  const matched = sessions.filter((session) => sessionMatchesSubject(session, subject));
  for (const session of matched) {
    const age = daysBetween(session.calibration.observedAt, session.createdAt);
    session.assessmentAgeDays = age === null ? null : Math.round(age);
  }

  return {
    athleteId: input.subject.athleteId,
    candidateStatus: candidateSeen
      ? "available"
      : outsideDomainSeen
        ? "outside_domain"
        : "unavailable",
    sessions: matched,
    currentCalibration: input.currentCalibration,
    excludedIncompleteIdentitySessions,
    excludedMultiPhaseSessions,
    heldWorkloadForwardSessions,
    ...(input.sessionEvidenceV2 ? { heldSessionsV2 } : {}),
  };
}

export interface DiagnosticCohortDiscovery {
  subject: ScientificAssessmentSubject;
  evidence: ScientificAssessmentEvidence;
}

/**
 * Discovers distinct hardened subject cohorts present in frozen E2 evidence
 * for the assessable intensities (`threshold`, `aerobic_base`) without
 * hard-coding the reducer to Thursday. Each distinct full-identity cohort
 * becomes one assessed subject. A subject is discovered from any phase whose
 * frozen E1 outcome is a candidate, so a valid subject that is still
 * collecting E2 evidence (no characterized session yet) is assessed as
 * `collecting` rather than hidden. Cohorts with incomplete identity
 * (including an observed-power provenance that is not measured/calibrated)
 * never become subjects. Phase-structure class stays `null` (see subject docs).
 */
export function discoverDiagnosticSubjects(
  records: BuildSubjectEvidenceInput["records"],
  assessmentContexts: BuildSubjectEvidenceInput["assessmentContexts"],
  workoutContexts: BuildSubjectEvidenceInput["workoutContexts"],
  athleteId: string
): ScientificAssessmentSubject[] {
  const seen = new Map<string, ScientificAssessmentSubject>();
  const intensities: ScientificAssessmentIntensity[] = ["threshold", "aerobic_base"];
  for (const record of records) {
    if (record.athleteId !== athleteId || record.activity !== "bike") continue;
    const assessment = assessmentContexts[record.workoutSessionId];
    const workout = workoutContexts[record.workoutSessionId];
    const identity = sessionIdentityFrom(record, assessment, workout);
    if (identity === null) continue;
    for (const phase of record.phases) {
      if (phase.kind !== "work" || !phaseHasFrozenCandidate(phase)) continue;
      if (phase.intensityId !== intensities[0] && phase.intensityId !== intensities[1]) continue;
      if (phase.legacyHeartRate?.min === undefined || phase.legacyHeartRate?.max === undefined) continue;
      if (phase.observedPowerProvenance !== "measured_watts" &&
        phase.observedPowerProvenance !== "calibrated_watts") continue;
      if (!isNonEmptyString(workout?.machineId)) continue;
      if (!Number.isInteger(workout?.machineProfileVersion)) continue;
      const subject: ScientificAssessmentSubject = {
        athleteId,
        activity: "bike",
        phaseKind: "work",
        intensityId: phase.intensityId as ScientificAssessmentIntensity,
        modality: "legacy_hr_region_workload",
        phaseStructureClass: null,
        calibration: identity,
        machineId: workout.machineId!,
        machineProfileVersion: workout.machineProfileVersion!,
        observedPowerProvenance: phase.observedPowerProvenance as
          | "measured_watts"
          | "calibrated_watts",
        legacyHrBand: { minBpm: phase.legacyHeartRate.min!, maxBpm: phase.legacyHeartRate.max! },
      };
      const key = JSON.stringify([
        subject.intensityId,
        subject.calibration.evidenceSessionIds,
        subject.calibration.estimatorId,
        subject.calibration.estimatorVersion,
        subject.calibration.protocolId,
        subject.calibration.protocolVersion,
        subject.calibration.observedAt,
        subject.calibration.workloadProvenance,
        subject.machineId,
        subject.machineProfileVersion,
        subject.observedPowerProvenance,
        subject.legacyHrBand.minBpm,
        subject.legacyHrBand.maxBpm,
      ]);
      if (!seen.has(key)) seen.set(key, subject);
    }
  }
  // Sorted by the full cohort key so output order never depends on record
  // order, even for subjects that differ only in estimator, protocol,
  // provenance, or machine-profile version.
  return [...seen.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, subject]) => subject);
}
