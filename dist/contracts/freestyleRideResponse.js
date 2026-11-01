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
function parseScalarSummary(v) {
    if (!isObject(v))
        return null;
    if (!isNonNegativeInteger(v.sampleCount) || v.sampleCount === 0)
        return null;
    if (!isRatio(v.coverageRatio))
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
    const expectedIqr = dist.q3 - dist.q1;
    if (Math.abs(dist.iqr - expectedIqr) > 0.001)
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
function parseResistanceDistribution(v) {
    if (!Array.isArray(v))
        return null;
    const result = [];
    for (const item of v) {
        if (!isObject(item))
            return null;
        if (!isNonNegativeFinite(item.level))
            return null;
        if (!isNonNegativeFinite(item.activeSeconds))
            return null;
        if (!isRatio(item.fraction))
            return null;
        result.push({
            level: item.level,
            activeSeconds: item.activeSeconds,
            fraction: item.fraction,
        });
    }
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
    if (Date.parse(timing.endedAt) <= Date.parse(timing.startedAt))
        return null;
    if (typeof timing.completedNaturally !== "boolean")
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
    if (!isNonNegativeInteger(hr.validSampleCount))
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
    if (hr.expectedDurationSec > 0) {
        const expectedCoverage = Math.min(1, hr.validSampleCount / hr.expectedDurationSec);
        if (Math.abs(hr.coverageRatio - expectedCoverage) > 0.001)
            return null;
    }
    else if (hr.validSampleCount > 0) {
        return null;
    }
    // Evidence.bike
    if (!isObject(evidence.bike))
        return null;
    const bike = evidence.bike;
    if (!isNonNegativeInteger(bike.expectedDurationSec))
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
    // Row count consistency: rowCount = freshSampleCount + staleSampleCount + unavailableSampleCount
    const rowSum = bike.freshSampleCount +
        bike.staleSampleCount +
        bike.unavailableSampleCount;
    if (rowSum !== bike.rowCount)
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
    // Workload (optional)
    let parsedWorkload;
    if (raw.workload !== undefined) {
        if (!isObject(raw.workload))
            return null;
        const wl = raw.workload;
        if (wl.workStatus !== "complete" && wl.workStatus !== "partial" && wl.workStatus !== "unavailable")
            return null;
        if (!isRatio(wl.powerCoverageRatio))
            return null;
        if (wl.observedWorkJoules !== undefined && !isNonNegativeFinite(wl.observedWorkJoules))
            return null;
        if (wl.observedWorkKj !== undefined && !isNonNegativeFinite(wl.observedWorkKj))
            return null;
        // kJ/J consistency
        if (wl.observedWorkJoules !== undefined && wl.observedWorkKj !== undefined) {
            const expectedKj = wl.observedWorkJoules / 1000;
            if (Math.abs(wl.observedWorkKj - expectedKj) > 0.01)
                return null;
        }
        let watts;
        if (wl.watts !== undefined) {
            if (!isObject(wl.watts))
                return null;
            const w = wl.watts;
            if (w.provenance !== "measured_watts" && w.provenance !== "calibrated_watts" && w.provenance !== "mixed")
                return null;
            const scalar = parseScalarSummary(w);
            if (!scalar)
                return null;
            watts = { ...scalar, provenance: w.provenance };
        }
        let cadenceRpm;
        if (wl.cadenceRpm !== undefined) {
            cadenceRpm = (_a = parseScalarSummary(wl.cadenceRpm)) !== null && _a !== void 0 ? _a : undefined;
            if (wl.cadenceRpm !== undefined && !cadenceRpm)
                return null;
        }
        let observedResistance;
        if (wl.observedResistance !== undefined) {
            if (!isObject(wl.observedResistance))
                return null;
            const or = wl.observedResistance;
            const levels = parseResistanceDistribution(or.levelsUsed);
            if (!levels)
                return null;
            if (!isRatio(or.coverageRatio))
                return null;
            if (or.medianLevel !== undefined && !isNonNegativeFinite(or.medianLevel))
                return null;
            observedResistance = {
                levelsUsed: levels,
                coverageRatio: or.coverageRatio,
                ...(or.medianLevel !== undefined ? { medianLevel: or.medianLevel } : {}),
            };
        }
        parsedWorkload = {
            workStatus: wl.workStatus,
            powerCoverageRatio: wl.powerCoverageRatio,
            ...(wl.observedWorkJoules !== undefined ? { observedWorkJoules: wl.observedWorkJoules } : {}),
            ...(wl.observedWorkKj !== undefined ? { observedWorkKj: wl.observedWorkKj } : {}),
            ...(watts ? { watts: watts } : {}),
            ...(cadenceRpm ? { cadenceRpm } : {}),
            ...(observedResistance ? { observedResistance } : {}),
        };
    }
    return {
        schemaVersion: FREESTYLE_RIDE_RESPONSE_SCHEMA_VERSION_V1,
        athleteId: raw.athleteId,
        sessionId: raw.sessionId,
        timing: {
            activeDurationSec: timing.activeDurationSec,
            pausedDurationSec: timing.pausedDurationSec,
            startedAt: timing.startedAt,
            endedAt: timing.endedAt,
            completedNaturally: timing.completedNaturally,
        },
        evidence: parsedEvidence,
        ...(parsedWorkload ? { workload: parsedWorkload } : {}),
    };
}
