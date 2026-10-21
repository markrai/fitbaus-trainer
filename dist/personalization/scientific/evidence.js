/**
 * E4A evidence builder: selects exactly the sessions belonging to a subject
 * from frozen E2 records and joins their policy-v2 provenance. It never
 * recomputes E1/E2 values.
 */
import { daysBetween } from "./guards.js";
import { HELD_CONTEXTS, phaseHasFrozenCandidate, phaseIsOutsideDomainFallback } from "./qualification.js";
import { calibrationEquals, sessionIdentityFrom, sessionMatchesSubject } from "./cohort.js";
/** No v2 join for the workout: execution provenance is unavailable, stated consistently. */
function unavailableHeldProvenance(stable) {
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
function sessionProvenanceV2(input, phase) {
    if (!input)
        return null;
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
            contexts: match.heldWorkload.contexts === null ? null : Object.fromEntries(HELD_CONTEXTS.map((context) => [context, { ...match.heldWorkload.contexts[context] }])),
        } : null,
        independentOpenLoopEvidence: false,
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
export function buildSubjectEvidence(input) {
    var _a, _b, _c, _d, _e, _f, _g;
    const sessions = [];
    const heldWorkloadForwardSessions = [];
    const heldSessionsV2 = [];
    let excludedIncompleteIdentitySessions = 0;
    let excludedMultiPhaseSessions = 0;
    let candidateSeen = false;
    let outsideDomainSeen = false;
    const subject = input.subject;
    for (const record of input.records) {
        if (record.athleteId !== subject.athleteId)
            continue;
        if (record.activity !== "bike")
            continue;
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
            workout.machineId !== subject.machineId ||
            workout.machineProfileVersion !== subject.machineProfileVersion)
            continue;
        const subjectPhases = record.phases.filter((phase) => phase.kind === "work" && phase.intensityId === subject.intensityId);
        // Candidate existence comes from the frozen E1 outcome on the subject's
        // own legacy HR band, independent of whether E2 characterized the phase
        // (or whether the session is later excluded as evidence).
        for (const phase of subjectPhases) {
            if (((_a = phase.legacyHeartRate) === null || _a === void 0 ? void 0 : _a.min) !== subject.legacyHrBand.minBpm ||
                ((_b = phase.legacyHeartRate) === null || _b === void 0 ? void 0 : _b.max) !== subject.legacyHrBand.maxBpm)
                continue;
            if (phaseHasFrozenCandidate(phase))
                candidateSeen = true;
            else if (phaseIsOutsideDomainFallback(phase))
                outsideDomainSeen = true;
        }
        // Every characterized phase counts toward the multi-phase rule, complete
        // or not, so an incomplete sibling cannot silently reduce a session to
        // one phase.
        const characterized = subjectPhases.filter((phase) => phase.characterizationOutcome === "characterized");
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
        const relevantPhases = subjectPhases.filter((phase) => {
            var _a, _b;
            return ((_a = phase.legacyHeartRate) === null || _a === void 0 ? void 0 : _a.min) === subject.legacyHrBand.minBpm &&
                ((_b = phase.legacyHeartRate) === null || _b === void 0 ? void 0 : _b.max) === subject.legacyHrBand.maxBpm &&
                phaseHasFrozenCandidate(phase) &&
                phase.observedPowerProvenance === subject.observedPowerProvenance;
        });
        if (relevantPhases.length === 1 &&
            ((_c = relevantPhases[0].heldWorkloadForwardResponse) === null || _c === void 0 ? void 0 : _c.outcome) === "characterized") {
            const heldPhase = relevantPhases[0];
            const held = heldPhase.heldWorkloadForwardResponse;
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
                        machineId: workout.machineId,
                        machineProfileVersion: workout.machineProfileVersion,
                        observedPowerProvenance: heldPhase.observedPowerProvenance,
                        legacyHrBand: { minBpm: heldPhase.legacyHeartRate.min, maxBpm: heldPhase.legacyHeartRate.max },
                        provenanceV2: (_d = sessionProvenanceV2(input.sessionEvidenceV2[record.workoutSessionId], heldPhase)) !== null && _d !== void 0 ? _d : unavailableHeldProvenance(held.stableResistance),
                    });
                }
            }
        }
        // Uncharacterized phases (E1 fallback or insufficient E2 evidence) never
        // become evidence; they only grounded the candidate status above.
        if (characterized.length === 0)
            continue;
        if (characterized[0].candidatePower === undefined ||
            characterized[0].comparison === undefined ||
            ((_e = characterized[0].legacyHeartRate) === null || _e === void 0 ? void 0 : _e.min) === undefined ||
            ((_f = characterized[0].legacyHeartRate) === null || _f === void 0 ? void 0 : _f.max) === undefined) {
            excludedIncompleteIdentitySessions += 1;
            continue;
        }
        const phase = characterized[0];
        if (phase.observedPowerProvenance !== "measured_watts" &&
            phase.observedPowerProvenance !== "calibrated_watts") {
            excludedIncompleteIdentitySessions += 1;
            continue;
        }
        const width = phase.candidatePower.maxWatts - phase.candidatePower.minWatts;
        const normalized = width > 0 ? phase.comparison.absoluteDifferenceWatts / width : null;
        sessions.push({
            workoutSessionId: record.workoutSessionId,
            createdAt: record.createdAt,
            athleteId: record.athleteId,
            activity: record.activity,
            phaseKind: phase.kind,
            intensityId: phase.intensityId,
            calibration: identity,
            machineId: workout.machineId,
            machineProfileVersion: workout.machineProfileVersion,
            observedPowerProvenance: phase.observedPowerProvenance,
            legacyHrBand: { minBpm: phase.legacyHeartRate.min, maxBpm: phase.legacyHeartRate.max },
            candidateWidthWatts: width,
            candidateMidpointWatts: phase.comparison.candidateMidpointWatts,
            observedSettledWatts: phase.comparison.observedInBandMedianWatts,
            signedDifferenceWatts: phase.comparison.signedDifferenceWatts,
            absoluteDifferenceWatts: phase.comparison.absoluteDifferenceWatts,
            widthNormalizedAbsoluteError: normalized,
            saturationRatio: phase.controllerContext.saturationRatio,
            domainBucket: ((_g = phase.candidateDomainMargins) === null || _g === void 0 ? void 0 : _g.bucket) === "interior" ? "interior" : "edge",
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
