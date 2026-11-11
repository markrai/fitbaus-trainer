/**
 * E4A data model: gates, subject and calibration identity, per-session
 * evidence rows, the policy-v2 provenance join shapes, the assessment output,
 * and the structural view of frozen E2 records the evidence builder reads.
 * Type-only; owned by the E4A subsystem.
 */

import type {
  SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1,
  SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1,
  SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1,
  ScientificAssessmentReasonCode,
  ScientificAssessmentState,
} from "./policy.js";

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

export type FrozenPhase = BuildSubjectEvidenceInput["records"][number]["phases"][number];

export interface DiagnosticCohortDiscovery {
  subject: ScientificAssessmentSubject;
  evidence: ScientificAssessmentEvidence;
}
