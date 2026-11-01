/**
 * Freestyle Ride Response contract (schema V1). Descriptive workload analytics
 * for open-ended, self-paced cycling sessions. Never impersonates structured
 * phase execution — WorkoutResponseV1 is for prescribed workouts only.
 */
import { ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1, } from "./telemetry.js";
export const FREESTYLE_RIDE_RESPONSE_SCHEMA_VERSION_V1 = 1;
const OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
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
    const parsed = Date.parse(v);
    return Number.isFinite(parsed);
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
function parseScalarSummary(v, activeDurationSec) {
    if (!isObject(v))
        return null;
    if (!isNonNegativeInteger(v.sampleCount) || v.sampleCount === 0)
        return null;
    if (v.sampleCount > activeDurationSec)
        return null;
    if (!isRatio(v.coverageRatio))
        return null;
    const expectedCoverage = activeDurationSec > 0
        ? Math.min(1, v.sampleCount / activeDurationSec)
        : 0;
    if (!nearlyEqual(v.coverageRatio, expectedCoverage))
        return null;
    if (!isFiniteNumber(v.mean) || !isFiniteNumber(v.median))
        return null;
    if (!isFiniteNumber(v.min) || !isFiniteNumber(v.max))
        return null;
    if (v.min > v.max)
        return null;
    if (v.median < v.min || v.median > v.max)
        return null;
    if (!isObject(v.distribution))
        return null;
    const dist = v.distribution;
    if (!isFiniteNumber(dist.q1) || !isFiniteNumber(dist.q3) || !isFiniteNumber(dist.iqr))
        return null;
    if (dist.q1 > dist.q3)
        return null;
    if (dist.q1 + 0.001 < v.min)
        return null;
    if (dist.q3 - 0.001 > v.max)
        return null;
    const expectedIqr = dist.q3 - dist.q1;
    if (!nearlyEqual(dist.iqr, expectedIqr))
        return null;
    return {
        sampleCount: v.sampleCount,
        coverageRatio: v.coverageRatio,
        mean: v.mean,
        median: v.median,
        min: v.min,
        max: v.max,
        distribution: { q1: dist.q1, q3: dist.q3, iqr: dist.iqr },
    };
}
function parseResistanceDistribution(v, activeDurationSec, coverageRatio) {
    if (!Array.isArray(v) || v.length === 0)
        return null;
    const result = [];
    let totalSeconds = 0;
    for (const item of v) {
        if (!isObject(item))
            return null;
        if (!isNonNegativeFinite(item.level))
            return null;
        if (!isNonNegativeInteger(item.activeSeconds) || item.activeSeconds === 0)
            return null;
        if (!isRatio(item.fraction))
            return null;
        const seconds = item.activeSeconds;
        totalSeconds += seconds;
        const expectedFraction = activeDurationSec > 0 ? Math.min(1, seconds / activeDurationSec) : 0;
        if (!nearlyEqual(item.fraction, expectedFraction))
            return null;
        result.push({
            level: item.level,
            activeSeconds: seconds,
            fraction: item.fraction,
        });
    }
    if (totalSeconds > activeDurationSec)
        return null;
    const expectedCoverage = activeDurationSec > 0 ? Math.min(1, totalSeconds / activeDurationSec) : 0;
    if (!nearlyEqual(coverageRatio, expectedCoverage))
        return null;
    return result;
}
/**
 * Strict fail-closed parser for FreestyleRideResponseV1. Returns null on any
 * structural, type, or consistency violation.
 */
export function parseFreestyleRideResponse(raw) {
    var _a;
    if (!isObject(raw))
        return null;
    if (raw.schemaVersion !== FREESTYLE_RIDE_RESPONSE_SCHEMA_VERSION_V1)
        return null;
    if (!isOwnerId(raw.athleteId) || !isOwnerId(raw.sessionId))
        return null;
    // Timing
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
    if (typeof timing.completedNaturally !== "boolean")
        return null;
    const activeDurationSec = timing.activeDurationSec;
    const pausedDurationSec = timing.pausedDurationSec;
    const wallClockSec = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
    if (activeDurationSec > wallClockSec + 1)
        return null;
    if (activeDurationSec + pausedDurationSec > wallClockSec + 2)
        return null;
    // Evidence
    if (!isObject(raw.evidence))
        return null;
    const evidence = raw.evidence;
    // Evidence.hr
    if (!isObject(evidence.hr))
        return null;
    const hr = evidence.hr;
    if (!isNonNegativeInteger(hr.expectedDurationSec))
        return null;
    if (hr.expectedDurationSec !== activeDurationSec)
        return null;
    if (!isNonNegativeInteger(hr.validSampleCount))
        return null;
    if (hr.validSampleCount > activeDurationSec)
        return null;
    if (!isRatio(hr.coverageRatio))
        return null;
    if (hr.source !== "ble_chest_strap" && hr.source !== "unavailable")
        return null;
    if (hr.source === "unavailable" && hr.validSampleCount > 0)
        return null;
    for (const optKey of ["meanBpm", "medianBpm", "minBpm", "maxBpm"]) {
        if (hr[optKey] !== undefined) {
            if (!isFiniteNumber(hr[optKey]) || hr[optKey] <= 0)
                return null;
        }
    }
    if (hr.minBpm !== undefined && hr.maxBpm !== undefined && hr.minBpm > hr.maxBpm)
        return null;
    if (hr.medianBpm !== undefined && hr.minBpm !== undefined && hr.medianBpm < hr.minBpm)
        return null;
    if (hr.medianBpm !== undefined && hr.maxBpm !== undefined && hr.medianBpm > hr.maxBpm)
        return null;
    // Cross-validate hr consistency: coverage = validSampleCount / expectedDurationSec
    if (activeDurationSec > 0) {
        const expectedCoverage = Math.min(1, hr.validSampleCount / activeDurationSec);
        if (!nearlyEqual(hr.coverageRatio, expectedCoverage))
            return null;
    }
    else if (hr.validSampleCount > 0 || hr.coverageRatio !== 0) {
        return null;
    }
    // Evidence.bike
    if (!isObject(evidence.bike))
        return null;
    const bike = evidence.bike;
    if (!isNonNegativeInteger(bike.expectedDurationSec))
        return null;
    if (bike.expectedDurationSec !== activeDurationSec)
        return null;
    if (!isNonNegativeInteger(bike.rowCount))
        return null;
    if (!isNonNegativeInteger(bike.freshSampleCount))
        return null;
    if (!isNonNegativeInteger(bike.staleSampleCount))
        return null;
    if (!isNonNegativeInteger(bike.unavailableSampleCount))
        return null;
    if (!isNonNegativeInteger(bike.implicitMissingCount))
        return null;
    if (!isRatio(bike.freshRowCoverageRatio))
        return null;
    const wattsProvenanceValues = ["measured_watts", "calibrated_watts", "mixed", "unavailable"];
    if (!wattsProvenanceValues.includes(bike.wattsProvenance))
        return null;
    const freshCount = bike.freshSampleCount;
    const staleCount = bike.staleSampleCount;
    const unavailableCount = bike.unavailableSampleCount;
    const rowCount = bike.rowCount;
    if (freshCount + staleCount + unavailableCount !== rowCount)
        return null;
    if (rowCount > activeDurationSec)
        return null;
    const expectedImplicit = Math.max(0, activeDurationSec - rowCount);
    if (bike.implicitMissingCount !== expectedImplicit)
        return null;
    const expectedFreshCoverage = activeDurationSec > 0 ? Math.min(1, freshCount / activeDurationSec) : 0;
    if (!nearlyEqual(bike.freshRowCoverageRatio, expectedFreshCoverage))
        return null;
    // Evidence.rawTelemetry
    if (!isObject(evidence.rawTelemetry))
        return null;
    const rawTelem = evidence.rawTelemetry;
    if (rawTelem.store !== "ordinary_bike_telemetry")
        return null;
    if (rawTelem.schemaVersion !== ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1)
        return null;
    // Evidence.f1EvidenceIncomplete
    if (evidence.f1EvidenceIncomplete !== undefined && evidence.f1EvidenceIncomplete !== true)
        return null;
    // Assemble evidence
    const parsedEvidence = {
        hr: {
            expectedDurationSec: hr.expectedDurationSec,
            validSampleCount: hr.validSampleCount,
            coverageRatio: hr.coverageRatio,
            source: hr.source,
            ...(hr.meanBpm !== undefined ? { meanBpm: hr.meanBpm } : {}),
            ...(hr.medianBpm !== undefined ? { medianBpm: hr.medianBpm } : {}),
            ...(hr.minBpm !== undefined ? { minBpm: hr.minBpm } : {}),
            ...(hr.maxBpm !== undefined ? { maxBpm: hr.maxBpm } : {}),
        },
        bike: {
            expectedDurationSec: bike.expectedDurationSec,
            rowCount: bike.rowCount,
            freshSampleCount: bike.freshSampleCount,
            staleSampleCount: bike.staleSampleCount,
            unavailableSampleCount: bike.unavailableSampleCount,
            implicitMissingCount: bike.implicitMissingCount,
            freshRowCoverageRatio: bike.freshRowCoverageRatio,
            wattsProvenance: bike.wattsProvenance,
        },
        rawTelemetry: {
            store: "ordinary_bike_telemetry",
            schemaVersion: ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
        },
        ...(evidence.f1EvidenceIncomplete === true ? { f1EvidenceIncomplete: true } : {}),
    };
    let parsedWorkload;
    if (raw.workload === undefined) {
        if (activeDurationSec > 0)
            return null;
    }
    else {
        if (!isObject(raw.workload))
            return null;
        const wl = raw.workload;
        if (wl.workStatus !== "complete" && wl.workStatus !== "partial" && wl.workStatus !== "unavailable")
            return null;
        if (!isRatio(wl.powerCoverageRatio))
            return null;
        const powerCoverageRatio = wl.powerCoverageRatio;
        const workStatus = wl.workStatus;
        if (workStatus === "complete" && powerCoverageRatio < 0.95)
            return null;
        if (workStatus === "partial" && !(powerCoverageRatio > 0 && powerCoverageRatio < 0.95))
            return null;
        if (workStatus === "unavailable" && powerCoverageRatio !== 0)
            return null;
        if (wl.observedWorkJoules !== undefined && !isNonNegativeFinite(wl.observedWorkJoules))
            return null;
        if (wl.observedWorkKj !== undefined && !isNonNegativeFinite(wl.observedWorkKj))
            return null;
        if (wl.observedWorkJoules !== undefined && wl.observedWorkKj !== undefined) {
            const expectedKj = wl.observedWorkJoules / 1000;
            if (!nearlyEqual(wl.observedWorkKj, expectedKj, 0.01))
                return null;
        }
        let watts;
        if (wl.watts !== undefined) {
            if (!isObject(wl.watts))
                return null;
            const w = wl.watts;
            if (w.provenance !== "measured_watts" && w.provenance !== "calibrated_watts" && w.provenance !== "mixed")
                return null;
            if (bike.wattsProvenance === "unavailable")
                return null;
            if (w.provenance !== bike.wattsProvenance)
                return null;
            const scalar = parseScalarSummary(w, activeDurationSec);
            if (!scalar)
                return null;
            if (!nearlyEqual(scalar.coverageRatio, powerCoverageRatio))
                return null;
            watts = {
                ...scalar,
                provenance: w.provenance,
            };
        }
        if (workStatus === "unavailable") {
            if (wl.observedWorkJoules !== undefined || wl.observedWorkKj !== undefined || watts)
                return null;
        }
        else {
            if (wl.observedWorkJoules === undefined || wl.observedWorkKj === undefined || !watts)
                return null;
        }
        let cadenceRpm;
        if (wl.cadenceRpm !== undefined) {
            cadenceRpm = (_a = parseScalarSummary(wl.cadenceRpm, activeDurationSec)) !== null && _a !== void 0 ? _a : undefined;
            if (!cadenceRpm)
                return null;
        }
        let observedResistance;
        if (wl.observedResistance !== undefined) {
            if (!isObject(wl.observedResistance))
                return null;
            const or = wl.observedResistance;
            if (!isRatio(or.coverageRatio))
                return null;
            if (or.medianLevel !== undefined && !isNonNegativeFinite(or.medianLevel))
                return null;
            const levels = parseResistanceDistribution(or.levelsUsed, activeDurationSec, or.coverageRatio);
            if (!levels)
                return null;
            observedResistance = {
                levelsUsed: levels,
                coverageRatio: or.coverageRatio,
                ...(or.medianLevel !== undefined ? { medianLevel: or.medianLevel } : {}),
            };
        }
        parsedWorkload = {
            workStatus,
            powerCoverageRatio,
            ...(wl.observedWorkJoules !== undefined ? { observedWorkJoules: wl.observedWorkJoules } : {}),
            ...(wl.observedWorkKj !== undefined ? { observedWorkKj: wl.observedWorkKj } : {}),
            ...(watts ? { watts } : {}),
            ...(cadenceRpm ? { cadenceRpm } : {}),
            ...(observedResistance ? { observedResistance } : {}),
        };
    }
    return {
        schemaVersion: FREESTYLE_RIDE_RESPONSE_SCHEMA_VERSION_V1,
        athleteId: raw.athleteId,
        sessionId: raw.sessionId,
        timing: {
            activeDurationSec,
            pausedDurationSec,
            startedAt: timing.startedAt,
            endedAt: timing.endedAt,
            completedNaturally: timing.completedNaturally,
        },
        evidence: parsedEvidence,
        ...(parsedWorkload ? { workload: parsedWorkload } : {}),
    };
}
