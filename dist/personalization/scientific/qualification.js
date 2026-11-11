/**
 * E4A evidence qualification: can this subject or evidence row participate in
 * scientific assessment at all? Strict semantic validation of frozen rows, the
 * exact policy-v2 provenance trust boundary, and frozen E1 candidate outcomes.
 * Everything fails closed; nothing is clamped or coerced.
 */
import { SCIENTIFIC_MACHINE_COMPARABILITY_REASONS_V2, SCIENTIFIC_TIMED_ACTUATION_JOINS_V2 } from "./policy.js";
import { isFiniteNumber, isIsoDateTime, isNonEmptyString, isRecord, utcDateKey } from "./guards.js";
/**
 * Subject-level qualification inputs for the identity, candidate, and
 * provenance gates. Unknown or incomplete values never qualify (fail closed).
 */
export function inspectSubject(subject) {
    const subjectIdentityOk = isNonEmptyString(subject.athleteId) &&
        subject.activity === "bike" &&
        subject.phaseKind === "work" &&
        (subject.intensityId === "threshold" || subject.intensityId === "aerobic_base") &&
        subject.modality === "legacy_hr_region_workload" &&
        subject.phaseStructureClass === null;
    const calibrationOk = calibrationIdentityValid(subject.calibration);
    const subjectSessionIds = isRecord(subject.calibration) &&
        Array.isArray(subject.calibration.evidenceSessionIds)
        ? subject.calibration.evidenceSessionIds
        : [];
    const athleteOk = isNonEmptyString(subject.athleteId);
    const machineOk = isNonEmptyString(subject.machineId) && Number.isInteger(subject.machineProfileVersion);
    const bandOk = isRecord(subject.legacyHrBand) &&
        isFiniteNumber(subject.legacyHrBand.minBpm) &&
        isFiniteNumber(subject.legacyHrBand.maxBpm) &&
        subject.legacyHrBand.minBpm > 0 &&
        subject.legacyHrBand.maxBpm >= subject.legacyHrBand.minBpm;
    const observedProvenanceOk = subject.observedPowerProvenance === "measured_watts" ||
        subject.observedPowerProvenance === "calibrated_watts";
    return { subjectIdentityOk, calibrationOk, subjectSessionIds, athleteOk, machineOk, bandOk, observedProvenanceOk };
}
export function calibrationIdentityValid(identity) {
    if (!isRecord(identity))
        return false;
    if (!Array.isArray(identity.evidenceSessionIds) || identity.evidenceSessionIds.length === 0)
        return false;
    if (!identity.evidenceSessionIds.every(isNonEmptyString))
        return false;
    if (!isNonEmptyString(identity.estimatorId) || !Number.isInteger(identity.estimatorVersion))
        return false;
    if (!isNonEmptyString(identity.protocolId) || !Number.isInteger(identity.protocolVersion))
        return false;
    if (!isIsoDateTime(identity.observedAt))
        return false;
    return identity.workloadProvenance === "measured_watts" ||
        identity.workloadProvenance === "calibrated_at_verified_cadence";
}
/** Relative tolerance matching the strict E2 reader's derived-value check. */
function nearlyEqual(a, b) {
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
export function sessionEvidenceValid(session) {
    if (!isNonEmptyString(session.workoutSessionId) || utcDateKey(session.createdAt) === null)
        return false;
    if (!isFiniteNumber(session.candidateWidthWatts) || session.candidateWidthWatts <= 0)
        return false;
    if (!isFiniteNumber(session.candidateMidpointWatts) || session.candidateMidpointWatts <= 0)
        return false;
    if (!isFiniteNumber(session.observedSettledWatts) || session.observedSettledWatts < 0)
        return false;
    if (!isFiniteNumber(session.signedDifferenceWatts))
        return false;
    if (!isFiniteNumber(session.absoluteDifferenceWatts) || session.absoluteDifferenceWatts < 0)
        return false;
    if (!nearlyEqual(session.signedDifferenceWatts, session.observedSettledWatts - session.candidateMidpointWatts))
        return false;
    if (!nearlyEqual(session.absoluteDifferenceWatts, Math.abs(session.signedDifferenceWatts)))
        return false;
    if (session.widthNormalizedAbsoluteError !== null &&
        (!isFiniteNumber(session.widthNormalizedAbsoluteError) ||
            !nearlyEqual(session.widthNormalizedAbsoluteError, session.absoluteDifferenceWatts / session.candidateWidthWatts)))
        return false;
    if (!isFiniteNumber(session.saturationRatio) ||
        session.saturationRatio < 0 || session.saturationRatio > 1)
        return false;
    if (!isRecord(session.legacyHrBand) ||
        !isFiniteNumber(session.legacyHrBand.minBpm) || !isFiniteNumber(session.legacyHrBand.maxBpm) ||
        session.legacyHrBand.minBpm <= 0 || session.legacyHrBand.maxBpm < session.legacyHrBand.minBpm)
        return false;
    // Chronology: a workout cannot precede the formal calibration it was
    // prescribed from, and a derived assessment age cannot be negative.
    if (session.assessmentAgeDays !== null &&
        (!isFiniteNumber(session.assessmentAgeDays) || session.assessmentAgeDays < 0))
        return false;
    if (isRecord(session.calibration) && isIsoDateTime(session.calibration.observedAt) &&
        Date.parse(session.createdAt) < Date.parse(session.calibration.observedAt))
        return false;
    if (session.openLoop !== null && (!isRecord(session.openLoop) ||
        !Number.isInteger(session.openLoop.stableResistanceWindowCount) ||
        session.openLoop.stableResistanceWindowCount < 0))
        return false;
    if (session.provenanceV2 !== undefined && session.provenanceV2 !== null &&
        !provenanceV2Valid(session.provenanceV2))
        return false;
    return session.domainBucket === "interior" || session.domainBucket === "edge";
}
export function heldWorkloadForwardSessionValid(value) {
    return isRecord(value) && isNonEmptyString(value.workoutSessionId) &&
        Number.isInteger(value.qualifyingWindowCount) && value.qualifyingWindowCount >= 1 &&
        Number.isInteger(value.qualifyingDurationSec) && value.qualifyingDurationSec >= 1 &&
        isFiniteNumber(value.medianSignedErrorBpm) &&
        isFiniteNumber(value.medianAbsoluteErrorBpm) && value.medianAbsoluteErrorBpm >= 0;
}
export const HELD_CONTEXTS = [
    "automatic_selected",
    "programmatic_selected",
    "no_app_selector_observed",
    "unknown",
];
function countValid(value) {
    return Number.isInteger(value) && value >= 0;
}
function exactKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
/**
 * Strict policy-v2 trust boundary. Exact vocabularies and exact keys; the
 * comparability flag must agree with its reason; provenance absence must be
 * consistent everywhere; contexts exist exactly when the timed join is
 * available and must account for exactly the durable qualifying windows.
 */
export function provenanceV2Valid(value, requireHeld = false) {
    if (!isRecord(value) || value.independentOpenLoopEvidence !== false ||
        !exactKeys(value, ["machineComparison", "actuationCapture", "heldWorkload", "independentOpenLoopEvidence"]))
        return false;
    const comparison = value.machineComparison;
    if (!isRecord(comparison) || !exactKeys(comparison, ["comparable", "reason"]) ||
        typeof comparison.comparable !== "boolean" ||
        !SCIENTIFIC_MACHINE_COMPARABILITY_REASONS_V2.includes(comparison.reason))
        return false;
    if (comparison.comparable !== (comparison.reason === "same_machine_and_profile"))
        return false;
    if (value.actuationCapture !== "complete" && value.actuationCapture !== "incomplete" &&
        value.actuationCapture !== "unavailable")
        return false;
    const provenanceAbsent = value.actuationCapture === "unavailable";
    if (provenanceAbsent !== (comparison.reason === "execution_provenance_unavailable"))
        return false;
    const held = value.heldWorkload;
    if (held === null)
        return !requireHeld;
    if (!isRecord(held) ||
        !exactKeys(held, ["available", "timedJoin", "qualifyingWindowCount", "qualifyingDurationSec", "contexts"]) ||
        typeof held.available !== "boolean" ||
        !SCIENTIFIC_TIMED_ACTUATION_JOINS_V2.includes(held.timedJoin) ||
        !countValid(held.qualifyingWindowCount) || !countValid(held.qualifyingDurationSec))
        return false;
    if (requireHeld && !held.available)
        return false;
    if ((held.timedJoin === "execution_provenance_unavailable") !== provenanceAbsent &&
        !(provenanceAbsent && held.timedJoin === "not_applicable"))
        return false;
    if ((held.timedJoin === "available") !== (held.contexts !== null))
        return false;
    if (held.contexts === null)
        return true;
    if (!isRecord(held.contexts) || !exactKeys(held.contexts, HELD_CONTEXTS))
        return false;
    let windows = 0;
    let duration = 0;
    for (const context of HELD_CONTEXTS) {
        const totals = held.contexts[context];
        if (!isRecord(totals) || !exactKeys(totals, ["windowCount", "durationSec"]) ||
            !countValid(totals.windowCount) || !countValid(totals.durationSec))
            return false;
        windows += totals.windowCount;
        duration += totals.durationSec;
    }
    // Window-level classification covers exactly the durable qualifying windows.
    return windows === held.qualifyingWindowCount && duration === held.qualifyingDurationSec;
}
/** Held-response cohort row: identity is checked exactly like a transfer row; no closed-loop value exists. */
export function heldSessionValid(session) {
    if (!isRecord(session) || !isNonEmptyString(session.workoutSessionId) || utcDateKey(session.createdAt) === null)
        return false;
    if (!isRecord(session.legacyHrBand) ||
        !isFiniteNumber(session.legacyHrBand.minBpm) || !isFiniteNumber(session.legacyHrBand.maxBpm) ||
        session.legacyHrBand.minBpm <= 0 || session.legacyHrBand.maxBpm < session.legacyHrBand.minBpm)
        return false;
    if (isRecord(session.calibration) && isIsoDateTime(session.calibration.observedAt) &&
        Date.parse(session.createdAt) < Date.parse(session.calibration.observedAt))
        return false;
    return provenanceV2Valid(session.provenanceV2, true);
}
/** Frozen E1 outcome as persisted on the E2 phase: a valid candidate band exists. */
export function phaseHasFrozenCandidate(phase) {
    return phase.shadowOutcome === "candidate" &&
        isRecord(phase.candidatePower) &&
        isFiniteNumber(phase.candidatePower.minWatts) &&
        isFiniteNumber(phase.candidatePower.maxWatts) &&
        phase.candidatePower.maxWatts >= phase.candidatePower.minWatts;
}
export function phaseIsOutsideDomainFallback(phase) {
    return phase.shadowOutcome === "fallback" &&
        (phase.fallbackReason === "outside_observed_hr_range" ||
            phase.fallbackReason === "outside_observed_workload_range");
}
