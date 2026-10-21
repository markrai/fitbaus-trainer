/**
 * E4A assessment report data: the fail-closed unsupported-policy result, the
 * evidence digest, the policy-v2 provenance digest, and the display subject
 * key. Data shaping only; presentation lives in the diagnostics view.
 */

import {
  SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1,
  SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1,
  SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1,
} from "./policy.js";
import { isRecord } from "./guards.js";
import { normalizedSessionIds } from "./cohort.js";
import type { summarizeHeldSessions } from "./aggregation.js";
import type {
  ScientificAssessment,
  ScientificAssessmentEvidence,
  ScientificAssessmentProvenanceDigestV2,
  ScientificAssessmentSessionEvidence,
  ScientificAssessmentSubject,
} from "./model.js";

export function unsupportedPolicyAssessment(
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

/** Assessment evidence digest with its fixed rounding; the shape is part of the assessment contract. */
export function buildEvidenceDigest(input: {
  sessions: readonly ScientificAssessmentSessionEvidence[];
  distinctDateCount: number;
  calendarSpanDays: number | null;
  interiorCount: number;
  saturationIncidence: number | null;
  medianSigned: number | null;
  medianAbsolute: number | null;
  medianWidth: number | null;
  settledCv: number | null;
  newestAgeDays: number | null;
  subjectSessionIds: readonly string[];
  evidence: ScientificAssessmentEvidence;
  ignoredCrossCohortSessions: number;
  ignoredInvalidSessions: number;
  heldForward: { count: number; signed: number | null; absolute: number | null };
  provenanceDigest: ScientificAssessmentProvenanceDigestV2 | undefined;
}): ScientificAssessment["evidenceDigest"] {
  const {
    sessions, distinctDateCount, calendarSpanDays, interiorCount, saturationIncidence, medianSigned,
    medianAbsolute, medianWidth, settledCv, newestAgeDays, subjectSessionIds, evidence,
    ignoredCrossCohortSessions, ignoredInvalidSessions, heldForward, provenanceDigest,
  } = input;
  return {
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
  };
}

const sortedCounts = (counts: Record<string, number>) =>
  Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));

/** Runtime-only policy-v2 digest: channel counts, exclusions by reason (sorted), and held-channel totals. */
export function provenanceDigestV2(input: {
  transferComparableSessionCount: number;
  heldComparableSessionCount: number;
  excludedTransferMachineIncomparableSessions: Record<string, number>;
  excludedHeldMachineIncomparableSessions: Record<string, number>;
  ignoredInvalidHeldSessions: number;
  heldDigest: ReturnType<typeof summarizeHeldSessions>["digest"];
}): ScientificAssessmentProvenanceDigestV2 {
  return {
    transferComparableSessionCount: input.transferComparableSessionCount,
    heldComparableSessionCount: input.heldComparableSessionCount,
    excludedTransferMachineIncomparableSessions: sortedCounts(input.excludedTransferMachineIncomparableSessions),
    excludedHeldMachineIncomparableSessions: sortedCounts(input.excludedHeldMachineIncomparableSessions),
    ignoredInvalidHeldSessions: input.ignoredInvalidHeldSessions,
    ...input.heldDigest,
  };
}

/** Subject key for display, e.g. `threshold.legacy_hr_region_workload`. */
export function scientificSubjectKey(subject: ScientificAssessmentSubject): string {
  return `${subject.intensityId}.${subject.modality}`;
}
