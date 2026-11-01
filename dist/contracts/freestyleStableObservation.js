import { ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1 } from "./telemetry.js";
export const FREESTYLE_STABLE_OBSERVATION_SCHEMA_VERSION_V1 = 1;
export const FREESTYLE_STABLE_OBSERVATION_POLICY_ID_V1 = "freestyle-stable-observation";
export const FREESTYLE_STABLE_OBSERVATION_POLICY_VERSION_V1 = 1;
export const FREESTYLE_STABLE_OBSERVATION_POLICY = {
    policyId: FREESTYLE_STABLE_OBSERVATION_POLICY_ID_V1,
    policyVersion: FREESTYLE_STABLE_OBSERVATION_POLICY_VERSION_V1,
    criteriaClass: "provisional_engineering",
    maxObservationGapSec: 1,
    maxWallClockExcessSec: 1,
    minMechanicallyQualifiedDurationSec: 180,
    minFreshPowerCoverageRatio: 0.95,
    minCadenceCoverageRatio: 0.95,
    maxWattsMadAbs: 12,
    maxWattsMadRatio: 0.1,
    maxCadenceMadRpm: 5,
    minJointHrPowerCoverageRatio: 1,
};
export const FREESTYLE_STABLE_OBSERVATION_REASONS = [
    "insufficient_duration",
    "power_unavailable",
    "mixed_watt_provenance",
    "insufficient_power_coverage",
    "non_pedaling_zero_load",
    "workload_unstable",
    "insufficient_cadence_coverage",
    "coasting",
    "cadence_unstable",
    "insufficient_hr_coverage",
    "insufficient_joint_hr_power_coverage",
    "f1_evidence_incomplete",
];
const REASON_SET = new Set(FREESTYLE_STABLE_OBSERVATION_REASONS);
const MECHANICAL_REASONS = new Set([
    "insufficient_duration",
    "power_unavailable",
    "mixed_watt_provenance",
    "insufficient_power_coverage",
    "non_pedaling_zero_load",
    "workload_unstable",
    "insufficient_cadence_coverage",
    "coasting",
    "cadence_unstable",
]);
const HR_INSUFFICIENCY_REASONS = new Set([
    "insufficient_hr_coverage",
    "insufficient_joint_hr_power_coverage",
]);
const OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const QUALIFICATIONS = [
    "candidate",
    "mechanically_qualified",
    "hr_co_observed",
];
const PROVENANCE = [
    "measured_watts",
    "calibrated_watts",
    "mixed",
    "unavailable",
];
function isFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
}
function isNonNegativeFinite(v) {
    return isFiniteNumber(v) && v >= 0;
}
function isNonNegativeInteger(v) {
    return Number.isInteger(v) && v >= 0;
}
function isRatio(v) {
    return isFiniteNumber(v) && v >= 0 && v <= 1;
}
function isIsoTimestamp(v) {
    if (typeof v !== "string" || v === "")
        return false;
    return Number.isFinite(Date.parse(v));
}
function isOwnerId(v) {
    return typeof v === "string" && OWNER_ID_PATTERN.test(v);
}
function isObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
}
function nearlyEqual(a, b, tol = 0.001) {
    return Math.abs(a - b) <= tol;
}
function parseReasons(v) {
    if (!Array.isArray(v))
        return null;
    const reasons = [];
    const seen = new Set();
    for (const item of v) {
        if (typeof item !== "string" || !REASON_SET.has(item) || seen.has(item))
            return null;
        seen.add(item);
        reasons.push(item);
    }
    return reasons;
}
function wattsMadLimit(medianWatts) {
    return Math.max(FREESTYLE_STABLE_OBSERVATION_POLICY.maxWattsMadAbs, FREESTYLE_STABLE_OBSERVATION_POLICY.maxWattsMadRatio * medianWatts);
}
function reasonsInclude(reasons, reason) {
    return reasons.includes(reason);
}
function hasAnyReason(reasons, set) {
    return reasons.some((reason) => set.has(reason));
}
function qualificationAgreesWithMeasurements(window, reasons, qualification, evidenceIncomplete) {
    const policy = FREESTYLE_STABLE_OBSERVATION_POLICY;
    const durationOk = window.durationSec >= policy.minMechanicallyQualifiedDurationSec;
    const provenanceOk = window.wattsProvenance === "measured_watts" || window.wattsProvenance === "calibrated_watts";
    const powerCoverageOk = window.freshPowerCoverageRatio >= policy.minFreshPowerCoverageRatio;
    const cadenceCoverageOk = window.cadenceCoverageRatio >= policy.minCadenceCoverageRatio;
    const powerPresent = window.powerMedianWatts !== undefined && window.powerMadWatts !== undefined;
    const cadencePresent = window.cadenceMedianRpm !== undefined && window.cadenceMadRpm !== undefined;
    const positiveLoad = powerPresent && window.powerMedianWatts > 0;
    const powerStable = positiveLoad &&
        window.powerMadWatts <= wattsMadLimit(window.powerMedianWatts);
    const cadencePositive = cadencePresent && window.cadenceMedianRpm > 0;
    const cadenceStable = cadencePositive &&
        window.cadenceMadRpm <= policy.maxCadenceMadRpm;
    const mechanicalOk = durationOk && provenanceOk && powerCoverageOk && cadenceCoverageOk &&
        powerPresent && cadencePresent && positiveLoad && powerStable && cadencePositive && cadenceStable;
    if (reasonsInclude(reasons, "insufficient_duration") !== !durationOk)
        return false;
    if (reasonsInclude(reasons, "power_unavailable") !== !powerPresent)
        return false;
    if (reasonsInclude(reasons, "mixed_watt_provenance") !== (window.wattsProvenance === "mixed"))
        return false;
    if (reasonsInclude(reasons, "insufficient_power_coverage") !== (powerPresent && !powerCoverageOk))
        return false;
    if (reasonsInclude(reasons, "non_pedaling_zero_load") !== (powerPresent && window.powerMedianWatts === 0)) {
        return false;
    }
    if (reasonsInclude(reasons, "workload_unstable") !== (positiveLoad && !powerStable))
        return false;
    if (reasonsInclude(reasons, "insufficient_cadence_coverage") !== !cadenceCoverageOk)
        return false;
    const coasting = reasonsInclude(reasons, "coasting");
    if (!cadencePositive && cadencePresent && !coasting)
        return false;
    const expectCadenceUnstable = cadencePositive && !cadenceStable && !coasting;
    if (reasonsInclude(reasons, "cadence_unstable") !== expectCadenceUnstable)
        return false;
    if (reasonsInclude(reasons, "f1_evidence_incomplete") !== evidenceIncomplete)
        return false;
    const jointOk = window.jointHrPowerCoverageRatio >= policy.minJointHrPowerCoverageRatio;
    if (reasonsInclude(reasons, "insufficient_hr_coverage") !== (window.hrCoverageRatio === 0))
        return false;
    if (reasonsInclude(reasons, "insufficient_joint_hr_power_coverage") !== (window.hrCoverageRatio > 0 && !jointOk)) {
        return false;
    }
    if (qualification === "hr_co_observed") {
        return mechanicalOk && jointOk && !evidenceIncomplete &&
            !hasAnyReason(reasons, MECHANICAL_REASONS) &&
            !hasAnyReason(reasons, HR_INSUFFICIENCY_REASONS);
    }
    if (qualification === "mechanically_qualified") {
        return mechanicalOk && !jointOk && !evidenceIncomplete &&
            !hasAnyReason(reasons, MECHANICAL_REASONS) &&
            hasAnyReason(reasons, HR_INSUFFICIENCY_REASONS);
    }
    return !mechanicalOk || evidenceIncomplete || hasAnyReason(reasons, MECHANICAL_REASONS);
}
function parseOptionalMetric(v) {
    if (v === undefined)
        return undefined;
    if (!isNonNegativeFinite(v))
        return null;
    return v;
}
function parsePolicy(v) {
    if (!isObject(v))
        return null;
    const expected = FREESTYLE_STABLE_OBSERVATION_POLICY;
    if (v.policyId !== expected.policyId)
        return null;
    if (v.policyVersion !== expected.policyVersion)
        return null;
    if (v.criteriaClass !== expected.criteriaClass)
        return null;
    if (v.maxObservationGapSec !== expected.maxObservationGapSec)
        return null;
    if (v.maxWallClockExcessSec !== expected.maxWallClockExcessSec)
        return null;
    if (v.minMechanicallyQualifiedDurationSec !== expected.minMechanicallyQualifiedDurationSec)
        return null;
    if (v.minFreshPowerCoverageRatio !== expected.minFreshPowerCoverageRatio)
        return null;
    if (v.minCadenceCoverageRatio !== expected.minCadenceCoverageRatio)
        return null;
    if (v.maxWattsMadAbs !== expected.maxWattsMadAbs)
        return null;
    if (v.maxWattsMadRatio !== expected.maxWattsMadRatio)
        return null;
    if (v.maxCadenceMadRpm !== expected.maxCadenceMadRpm)
        return null;
    if (v.minJointHrPowerCoverageRatio !== expected.minJointHrPowerCoverageRatio)
        return null;
    return expected;
}
function parseWindow(v, activeDurationSec, evidenceIncomplete) {
    if (!isObject(v))
        return null;
    if (!isNonNegativeInteger(v.startActiveSec) || !isNonNegativeInteger(v.endActiveSec))
        return null;
    if (!isNonNegativeInteger(v.durationSec) || v.durationSec === 0)
        return null;
    if (v.startActiveSec >= v.endActiveSec)
        return null;
    if (v.endActiveSec > activeDurationSec)
        return null;
    if (v.durationSec !== v.endActiveSec - v.startActiveSec)
        return null;
    if (!isNonNegativeInteger(v.qualifyingObservedSeconds))
        return null;
    if (v.qualifyingObservedSeconds > v.durationSec)
        return null;
    if (v.qualifyingObservedSeconds === 0)
        return null;
    if (!isNonNegativeFinite(v.observedResistanceLevel))
        return null;
    if (!PROVENANCE.includes(v.wattsProvenance))
        return null;
    if (!isRatio(v.freshPowerCoverageRatio) || !isRatio(v.cadenceCoverageRatio))
        return null;
    if (!isRatio(v.hrCoverageRatio) || !isRatio(v.jointHrPowerCoverageRatio))
        return null;
    if (!isNonNegativeInteger(v.powerOnlyObservedSeconds))
        return null;
    if (!isNonNegativeInteger(v.hrOnlyObservedSeconds))
        return null;
    if (!isNonNegativeInteger(v.jointHrPowerSeconds))
        return null;
    const duration = v.durationSec;
    const powerOnly = v.powerOnlyObservedSeconds;
    const hrOnly = v.hrOnlyObservedSeconds;
    const joint = v.jointHrPowerSeconds;
    if (powerOnly + joint > duration || hrOnly + joint > duration)
        return null;
    if (powerOnly + hrOnly + joint > duration)
        return null;
    if (!nearlyEqual(v.freshPowerCoverageRatio, Math.min(1, (powerOnly + joint) / duration)))
        return null;
    if (!nearlyEqual(v.hrCoverageRatio, Math.min(1, (hrOnly + joint) / duration)))
        return null;
    if (!nearlyEqual(v.jointHrPowerCoverageRatio, Math.min(1, joint / duration)))
        return null;
    const powerMedianWatts = parseOptionalMetric(v.powerMedianWatts);
    const powerMadWatts = parseOptionalMetric(v.powerMadWatts);
    const cadenceMedianRpm = parseOptionalMetric(v.cadenceMedianRpm);
    const cadenceMadRpm = parseOptionalMetric(v.cadenceMadRpm);
    const hrMedianBpm = parseOptionalMetric(v.hrMedianBpm);
    const hrMadBpm = parseOptionalMetric(v.hrMadBpm);
    const jointPowerMedianWatts = parseOptionalMetric(v.jointPowerMedianWatts);
    const jointHrMedianBpm = parseOptionalMetric(v.jointHrMedianBpm);
    if (powerMedianWatts === null || powerMadWatts === null ||
        cadenceMedianRpm === null || cadenceMadRpm === null ||
        hrMedianBpm === null || hrMadBpm === null ||
        jointPowerMedianWatts === null || jointHrMedianBpm === null)
        return null;
    const powerCount = powerOnly + joint;
    const hrCount = hrOnly + joint;
    if (powerCount === 0 && (powerMedianWatts !== undefined || powerMadWatts !== undefined))
        return null;
    if (powerCount > 0 && (powerMedianWatts === undefined || powerMadWatts === undefined))
        return null;
    if (hrCount === 0 && (hrMedianBpm !== undefined || hrMadBpm !== undefined))
        return null;
    if (hrCount > 0 && (hrMedianBpm === undefined || hrMadBpm === undefined))
        return null;
    if (v.cadenceCoverageRatio === 0 && (cadenceMedianRpm !== undefined || cadenceMadRpm !== undefined))
        return null;
    if (v.cadenceCoverageRatio > 0 && (cadenceMedianRpm === undefined || cadenceMadRpm === undefined))
        return null;
    if (joint === 0 && (jointPowerMedianWatts !== undefined || jointHrMedianBpm !== undefined))
        return null;
    if (joint > 0 && (jointPowerMedianWatts === undefined || jointHrMedianBpm === undefined))
        return null;
    if (!QUALIFICATIONS.includes(v.qualification))
        return null;
    const reasons = parseReasons(v.reasons);
    if (!reasons)
        return null;
    const qualification = v.qualification;
    if (!qualificationAgreesWithMeasurements({
        durationSec: duration,
        wattsProvenance: v.wattsProvenance,
        freshPowerCoverageRatio: v.freshPowerCoverageRatio,
        cadenceCoverageRatio: v.cadenceCoverageRatio,
        hrCoverageRatio: v.hrCoverageRatio,
        jointHrPowerCoverageRatio: v.jointHrPowerCoverageRatio,
        ...(powerMedianWatts !== undefined ? { powerMedianWatts } : {}),
        ...(powerMadWatts !== undefined ? { powerMadWatts } : {}),
        ...(cadenceMedianRpm !== undefined ? { cadenceMedianRpm } : {}),
        ...(cadenceMadRpm !== undefined ? { cadenceMadRpm } : {}),
    }, reasons, qualification, evidenceIncomplete))
        return null;
    return {
        startActiveSec: v.startActiveSec,
        endActiveSec: v.endActiveSec,
        durationSec: duration,
        qualifyingObservedSeconds: v.qualifyingObservedSeconds,
        observedResistanceLevel: v.observedResistanceLevel,
        wattsProvenance: v.wattsProvenance,
        freshPowerCoverageRatio: v.freshPowerCoverageRatio,
        cadenceCoverageRatio: v.cadenceCoverageRatio,
        hrCoverageRatio: v.hrCoverageRatio,
        jointHrPowerCoverageRatio: v.jointHrPowerCoverageRatio,
        powerOnlyObservedSeconds: powerOnly,
        hrOnlyObservedSeconds: hrOnly,
        jointHrPowerSeconds: joint,
        ...(powerMedianWatts !== undefined ? { powerMedianWatts } : {}),
        ...(powerMadWatts !== undefined ? { powerMadWatts } : {}),
        ...(cadenceMedianRpm !== undefined ? { cadenceMedianRpm } : {}),
        ...(cadenceMadRpm !== undefined ? { cadenceMadRpm } : {}),
        ...(hrMedianBpm !== undefined ? { hrMedianBpm } : {}),
        ...(hrMadBpm !== undefined ? { hrMadBpm } : {}),
        ...(jointPowerMedianWatts !== undefined ? { jointPowerMedianWatts } : {}),
        ...(jointHrMedianBpm !== undefined ? { jointHrMedianBpm } : {}),
        qualification,
        reasons,
    };
}
export function parseFreestyleStableObservation(raw) {
    if (!isObject(raw))
        return null;
    if (raw.schemaVersion !== FREESTYLE_STABLE_OBSERVATION_SCHEMA_VERSION_V1)
        return null;
    if (!isOwnerId(raw.athleteId) || !isOwnerId(raw.sessionId))
        return null;
    const policy = parsePolicy(raw.policy);
    if (!policy)
        return null;
    if (!isObject(raw.timing))
        return null;
    const timing = raw.timing;
    if (!isNonNegativeInteger(timing.activeDurationSec))
        return null;
    if (!isNonNegativeFinite(timing.pausedDurationSec))
        return null;
    if (!isIsoTimestamp(timing.startedAt) || !isIsoTimestamp(timing.endedAt))
        return null;
    const startedAtMs = Date.parse(timing.startedAt);
    const endedAtMs = Date.parse(timing.endedAt);
    if (endedAtMs <= startedAtMs)
        return null;
    const activeDurationSec = timing.activeDurationSec;
    const pausedDurationSec = timing.pausedDurationSec;
    const wallClockSec = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
    if (activeDurationSec > wallClockSec + 1)
        return null;
    if (activeDurationSec + pausedDurationSec > wallClockSec + 2)
        return null;
    if (!isObject(raw.observationProvenance))
        return null;
    const provenance = raw.observationProvenance;
    if (provenance.bikeStore !== "ordinary_bike_telemetry")
        return null;
    if (provenance.hrStore !== "hr_samples")
        return null;
    if (provenance.telemetrySchemaVersion !== ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1)
        return null;
    if (raw.analysisStatus !== "unavailable" &&
        raw.analysisStatus !== "diagnostic_only" &&
        raw.analysisStatus !== "observed")
        return null;
    if (!isNonNegativeInteger(raw.candidateWindowCount))
        return null;
    if (!isNonNegativeInteger(raw.mechanicallyQualifiedCount))
        return null;
    if (!isNonNegativeInteger(raw.hrCoObservedCount))
        return null;
    if (!Array.isArray(raw.windows))
        return null;
    if (raw.f1EvidenceIncomplete !== undefined && raw.f1EvidenceIncomplete !== true)
        return null;
    const evidenceIncomplete = raw.f1EvidenceIncomplete === true;
    const windows = [];
    let previousEnd = -1;
    for (const item of raw.windows) {
        const parsed = parseWindow(item, activeDurationSec, evidenceIncomplete);
        if (!parsed)
            return null;
        if (parsed.startActiveSec < previousEnd)
            return null;
        previousEnd = parsed.endActiveSec;
        windows.push(parsed);
    }
    if (windows.length !== raw.candidateWindowCount)
        return null;
    const mechanical = windows.filter((w) => w.qualification === "mechanically_qualified" || w.qualification === "hr_co_observed").length;
    const hrCo = windows.filter((w) => w.qualification === "hr_co_observed").length;
    if (mechanical !== raw.mechanicallyQualifiedCount)
        return null;
    if (hrCo !== raw.hrCoObservedCount)
        return null;
    if (evidenceIncomplete && mechanical > 0)
        return null;
    let expectedStatus;
    if (windows.length === 0)
        expectedStatus = "unavailable";
    else if (evidenceIncomplete || mechanical === 0)
        expectedStatus = "diagnostic_only";
    else
        expectedStatus = "observed";
    if (raw.analysisStatus !== expectedStatus)
        return null;
    if (!isObject(raw.scientificAuthority))
        return null;
    const authority = raw.scientificAuthority;
    if (authority.eligibleForCalibration !== false)
        return null;
    if (authority.eligibleForPrescription !== false)
        return null;
    if (authority.interpretation !== "descriptive_observation_only")
        return null;
    if (authority.hrArtifactFiltering !== "none")
        return null;
    if (authority.physiologicalEquilibriumClaimed !== false)
        return null;
    return {
        schemaVersion: FREESTYLE_STABLE_OBSERVATION_SCHEMA_VERSION_V1,
        policy,
        athleteId: raw.athleteId,
        sessionId: raw.sessionId,
        timing: {
            activeDurationSec,
            pausedDurationSec,
            startedAt: timing.startedAt,
            endedAt: timing.endedAt,
        },
        observationProvenance: {
            bikeStore: "ordinary_bike_telemetry",
            hrStore: "hr_samples",
            telemetrySchemaVersion: ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
        },
        analysisStatus: raw.analysisStatus,
        candidateWindowCount: windows.length,
        mechanicallyQualifiedCount: mechanical,
        hrCoObservedCount: hrCo,
        windows,
        ...(evidenceIncomplete ? { f1EvidenceIncomplete: true } : {}),
        scientificAuthority: {
            eligibleForCalibration: false,
            eligibleForPrescription: false,
            interpretation: "descriptive_observation_only",
            hrArtifactFiltering: "none",
            physiologicalEquilibriumClaimed: false,
        },
    };
}
