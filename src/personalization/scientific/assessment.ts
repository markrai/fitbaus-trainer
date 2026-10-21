/**
 * E4A scientific assessment: named gates in fixed order, the state
 * precedence, and canonical reason ordering over qualified, admitted, and
 * aggregated evidence. Pure and deterministic in (evidence, subject, policy,
 * evaluatedAt). The output carries runtimeAuthority false and no authority.
 */

import {
  REASON_ORDER,
  SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1,
  SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1,
  SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1,
  policyGeneration,
  type ScientificAssessmentPolicy,
  type ScientificAssessmentPolicyV2,
  type ScientificAssessmentReasonCode,
  type ScientificAssessmentState,
} from "./policy.js";
import { isFiniteNumber } from "./guards.js";
import { calibrationIdentityValid, inspectSubject } from "./qualification.js";
import { admitHeldSessions, admitTransferSessions, calibrationEquals, partitionTransferByMachine } from "./cohort.js";
import { heldWorkloadForwardDigest, summarizeHeldSessions, summarizeTransferSessions } from "./aggregation.js";
import { buildEvidenceDigest, provenanceDigestV2, unsupportedPolicyAssessment } from "./report.js";
import type {
  ScientificAssessment,
  ScientificAssessmentEvidence,
  ScientificAssessmentGate,
  ScientificAssessmentGateStatus,
  ScientificAssessmentHeldActuationContext,
  ScientificAssessmentProvenanceDigestV2,
  ScientificAssessmentSubject,
  ScientificHeldSessionEvidenceV2,
} from "./model.js";

function orderReasons(reasons: Iterable<ScientificAssessmentReasonCode>): ScientificAssessmentReasonCode[] {
  const rank = new Map<ScientificAssessmentReasonCode, number>(
    REASON_ORDER.map((reason, index) => [reason, index])
  );
  return [...new Set(reasons)].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
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

  const { subjectIdentityOk, calibrationOk, subjectSessionIds, athleteOk, machineOk, bandOk, observedProvenanceOk } =
    inspectSubject(subject);

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
  const { validSessions, ignoredCrossCohortSessions, ignoredInvalidSessions } =
    admitTransferSessions(evidence.sessions, subject, subjectComparable);

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
  const { sessions, excludedTransferMachineIncomparableSessions } = partitionTransferByMachine(validSessions, generation);
  // Policy v2 held-response cohort: subject-matching held-forward workouts,
  // independent of closed-loop characterization and HR-band success.
  const { heldSessions, validHeldCount, ignoredInvalidHeldSessions, excludedHeldMachineIncomparableSessions } =
    generation === 2
      ? admitHeldSessions(evidence.heldSessionsV2, subject, subjectComparable)
      : {
        heldSessions: [] as ScientificHeldSessionEvidenceV2[],
        validHeldCount: 0,
        ignoredInvalidHeldSessions: 0,
        excludedHeldMachineIncomparableSessions: {} as Record<string, number>,
      };
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
  // Pure timestamp arithmetic only, parsed from caller-supplied ISO strings.
  // The evaluator never samples the clock; timestamps arrive as arguments.
  const {
    distinctDateCount, calendarSpanDays, interiorCount, saturationIncidence,
    medianSigned, medianAbsolute, medianWidth, settledCv, newestAgeDays,
  } = summarizeTransferSessions(sessions, evaluatedAt);

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
    provenanceDigest = provenanceDigestV2({
      transferComparableSessionCount: sessions.length,
      heldComparableSessionCount: heldSessions.length,
      excludedTransferMachineIncomparableSessions,
      excludedHeldMachineIncomparableSessions,
      ignoredInvalidHeldSessions,
      heldDigest: v2.digest,
    });
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
    evidenceDigest: buildEvidenceDigest({
      sessions,
      distinctDateCount,
      calendarSpanDays,
      interiorCount,
      saturationIncidence,
      medianSigned,
      medianAbsolute,
      medianWidth,
      settledCv,
      newestAgeDays,
      subjectSessionIds,
      evidence,
      ignoredCrossCohortSessions,
      ignoredInvalidSessions,
      heldForward,
      provenanceDigest,
    }),
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
  const { held, joined, contexts, digest } = summarizeHeldSessions(sessions);
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
