/**
 * E4A assessment report data: the fail-closed unsupported-policy result, the
 * evidence digest, the policy-v2 provenance digest, and the display subject
 * key. Data shaping only; presentation lives in the diagnostics view.
 */
import { SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1, SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1, SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1, } from "./policy.js";
import { compareCanonicalText, isRecord } from "./guards.js";
import { normalizedSessionIds } from "./cohort.js";
export function unsupportedPolicyAssessment(subject, policy, evaluatedAt) {
    var _a;
    const record = isRecord(policy) ? policy : {};
    return {
        schemaVersion: SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1,
        assessor: { id: SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1, version: SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1 },
        policy: { id: String((_a = record.id) !== null && _a !== void 0 ? _a : ""), version: Number.isInteger(record.version) ? record.version : -1 },
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
export function buildEvidenceDigest(input) {
    var _a, _b;
    const { sessions, distinctDateCount, calendarSpanDays, interiorCount, saturationIncidence, medianSigned, medianAbsolute, medianWidth, settledCv, newestAgeDays, subjectSessionIds, evidence, ignoredCrossCohortSessions, ignoredInvalidSessions, heldForward, provenanceDigest, } = input;
    return {
        sessionCount: sessions.length,
        distinctDateCount,
        calendarSpanDays: calendarSpanDays === null ? null : Math.round(calendarSpanDays * 10) / 10,
        sessionIds: sessions.map((session) => session.workoutSessionId).sort(compareCanonicalText),
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
        excludedIncompleteIdentitySessions: (_a = evidence.excludedIncompleteIdentitySessions) !== null && _a !== void 0 ? _a : 0,
        excludedMultiPhaseSessions: (_b = evidence.excludedMultiPhaseSessions) !== null && _b !== void 0 ? _b : 0,
        ignoredCrossCohortSessions,
        ignoredInvalidSessions,
        heldWorkloadForwardSessionCount: heldForward.count,
        medianHeldWorkloadForwardSignedErrorBpm: heldForward.signed,
        medianHeldWorkloadForwardAbsoluteErrorBpm: heldForward.absolute,
        ...(provenanceDigest ? { provenanceV2: provenanceDigest } : {}),
    };
}
const sortedCounts = (counts) => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compareCanonicalText(a, b)));
/** Runtime-only policy-v2 digest: channel counts, exclusions by reason (sorted), and held-channel totals. */
export function provenanceDigestV2(input) {
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
export function scientificSubjectKey(subject) {
    return `${subject.intensityId}.${subject.modality}`;
}
