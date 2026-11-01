import { FREESTYLE_STABLE_OBSERVATION_POLICY, FREESTYLE_STABLE_OBSERVATION_SCHEMA_VERSION_V1, } from "./contracts/freestyleStableObservation.js";
import { ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1 } from "./contracts/telemetry.js";
import { numericMedian, orderByActiveSecond, segmentStableResistance, } from "./workloadForwardResponse.js";
const OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const POLICY = FREESTYLE_STABLE_OBSERVATION_POLICY;
function isOwnerId(v) {
    return typeof v === "string" && OWNER_ID_PATTERN.test(v);
}
function clampRatio(v) {
    if (!Number.isFinite(v))
        return 0;
    return Math.max(0, Math.min(1, v));
}
function roundTo(v, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round(v * factor) / factor;
}
function madAroundMedian(values, median) {
    return numericMedian(values.map((value) => Math.abs(value - median)));
}
function deduplicateSamples(samples, sessionId, athleteId, activeDurationSec) {
    var _a, _b;
    const bySecond = new Map();
    const priority = { fresh: 3, stale: 2, unavailable: 1 };
    for (const sample of samples) {
        if (!sample)
            continue;
        if (sample.sessionId !== sessionId)
            continue;
        if (sample.athleteId !== athleteId)
            continue;
        if (sample.activeSec < 0 || sample.activeSec >= activeDurationSec)
            continue;
        if (!Number.isInteger(sample.activeSec))
            continue;
        const existing = bySecond.get(sample.activeSec);
        if (!existing || ((_a = priority[sample.availability]) !== null && _a !== void 0 ? _a : 0) > ((_b = priority[existing.availability]) !== null && _b !== void 0 ? _b : 0)) {
            bySecond.set(sample.activeSec, sample);
        }
    }
    return orderByActiveSecond([...bySecond.values()]);
}
function mapObservations(samples) {
    return samples.map((sample) => {
        const fresh = sample.availability === "fresh";
        const observation = {
            activeSec: sample.activeSec,
            observedAt: sample.observedAt,
        };
        if (fresh && sample.observedResistance) {
            observation.observedResistance = sample.observedResistance.value;
        }
        if (fresh && sample.watts) {
            observation.watts = { value: sample.watts.value, source: sample.watts.source };
            observation.workloadProvenance = sample.watts.source;
        }
        if (fresh && sample.cadenceRpm) {
            observation.cadenceRpm = sample.cadenceRpm.value;
        }
        return observation;
    });
}
function validHrBySecond(samples, sessionId, activeDurationSec) {
    const bySecond = new Map();
    for (const sample of samples) {
        if (sample.session_id !== sessionId)
            continue;
        if (typeof sample.hr !== "number" || !Number.isFinite(sample.hr) || sample.hr <= 0)
            continue;
        if (typeof sample.timestamp_sec !== "number" || !Number.isFinite(sample.timestamp_sec))
            continue;
        if (sample.timestamp_sec < 0 || sample.timestamp_sec >= activeDurationSec)
            continue;
        const sec = Math.floor(sample.timestamp_sec);
        if (!bySecond.has(sec))
            bySecond.set(sec, sample.hr);
    }
    return bySecond;
}
function provenanceOf(values) {
    const sources = new Set(values.map((value) => value.source));
    if (sources.size === 0)
        return "unavailable";
    if (sources.size > 1)
        return "mixed";
    return [...sources][0];
}
function classifyWindow(observations, hrBySecond, evidenceIncomplete) {
    const startActiveSec = observations[0].activeSec;
    const endActiveSec = observations[observations.length - 1].activeSec + 1;
    const durationSec = endActiveSec - startActiveSec;
    const wattsBySec = new Map();
    const cadenceValues = [];
    for (const obs of observations) {
        if (obs.watts !== undefined)
            wattsBySec.set(obs.activeSec, obs.watts);
        if (obs.cadenceRpm !== undefined)
            cadenceValues.push(obs.cadenceRpm);
    }
    const hrValues = [];
    const hrInWindow = new Set();
    for (const [sec, hr] of hrBySecond) {
        if (sec < startActiveSec || sec >= endActiveSec)
            continue;
        hrInWindow.add(sec);
        hrValues.push(hr);
    }
    let joint = 0;
    let powerOnly = 0;
    const wattsEntries = [];
    const jointPower = [];
    const jointHr = [];
    for (const [sec, watts] of wattsBySec) {
        wattsEntries.push(watts);
        const hr = hrBySecond.get(sec);
        if (hr !== undefined) {
            joint += 1;
            jointPower.push(watts.value);
            jointHr.push(hr);
        }
        else
            powerOnly += 1;
    }
    let hrOnly = 0;
    for (const sec of hrInWindow) {
        if (!wattsBySec.has(sec))
            hrOnly += 1;
    }
    const freshPowerCoverageRatio = clampRatio(durationSec > 0 ? (powerOnly + joint) / durationSec : 0);
    const cadenceCoverageRatio = clampRatio(durationSec > 0 ? cadenceValues.length / durationSec : 0);
    const hrCoverageRatio = clampRatio(durationSec > 0 ? hrInWindow.size / durationSec : 0);
    const jointHrPowerCoverageRatio = clampRatio(durationSec > 0 ? joint / durationSec : 0);
    const wattsValues = wattsEntries.map((entry) => entry.value);
    const wattsProvenance = provenanceOf(wattsEntries);
    const reasons = [];
    if (durationSec < POLICY.minMechanicallyQualifiedDurationSec)
        reasons.push("insufficient_duration");
    if (wattsValues.length === 0)
        reasons.push("power_unavailable");
    else if (wattsProvenance === "mixed")
        reasons.push("mixed_watt_provenance");
    if (wattsValues.length > 0 && freshPowerCoverageRatio < POLICY.minFreshPowerCoverageRatio) {
        reasons.push("insufficient_power_coverage");
    }
    let powerMedianWatts;
    let powerMadWatts;
    if (wattsValues.length > 0) {
        powerMedianWatts = roundTo(numericMedian(wattsValues), 2);
        powerMadWatts = roundTo(madAroundMedian(wattsValues, numericMedian(wattsValues)), 2);
        if (powerMedianWatts === 0)
            reasons.push("non_pedaling_zero_load");
        else {
            const wattsMadLimit = Math.max(POLICY.maxWattsMadAbs, POLICY.maxWattsMadRatio * powerMedianWatts);
            if (powerMadWatts > wattsMadLimit)
                reasons.push("workload_unstable");
        }
    }
    let cadenceMedianRpm;
    let cadenceMadRpm;
    if (cadenceValues.length > 0) {
        cadenceMedianRpm = roundTo(numericMedian(cadenceValues), 2);
        cadenceMadRpm = roundTo(madAroundMedian(cadenceValues, numericMedian(cadenceValues)), 2);
        if (cadenceCoverageRatio < POLICY.minCadenceCoverageRatio)
            reasons.push("insufficient_cadence_coverage");
        if (cadenceMedianRpm === 0 || cadenceValues.some((value) => value === 0))
            reasons.push("coasting");
        else if (cadenceMadRpm > POLICY.maxCadenceMadRpm)
            reasons.push("cadence_unstable");
    }
    else {
        reasons.push("insufficient_cadence_coverage");
    }
    const mechanicalReasons = [
        "insufficient_duration",
        "power_unavailable",
        "mixed_watt_provenance",
        "insufficient_power_coverage",
        "non_pedaling_zero_load",
        "workload_unstable",
        "insufficient_cadence_coverage",
        "coasting",
        "cadence_unstable",
    ];
    const mechanicallyOk = mechanicalReasons.every((reason) => !reasons.includes(reason));
    if (jointHrPowerCoverageRatio < POLICY.minJointHrPowerCoverageRatio) {
        reasons.push(hrInWindow.size === 0 ? "insufficient_hr_coverage" : "insufficient_joint_hr_power_coverage");
    }
    if (evidenceIncomplete)
        reasons.push("f1_evidence_incomplete");
    let qualification = "candidate";
    if (!evidenceIncomplete && mechanicallyOk) {
        qualification = jointHrPowerCoverageRatio >= POLICY.minJointHrPowerCoverageRatio
            ? "hr_co_observed"
            : "mechanically_qualified";
    }
    let hrMedianBpm;
    let hrMadBpm;
    if (hrValues.length > 0) {
        hrMedianBpm = roundTo(numericMedian(hrValues), 1);
        hrMadBpm = roundTo(madAroundMedian(hrValues, numericMedian(hrValues)), 1);
    }
    return {
        startActiveSec,
        endActiveSec,
        durationSec,
        qualifyingObservedSeconds: observations.length,
        observedResistanceLevel: observations[0].observedResistance,
        wattsProvenance,
        freshPowerCoverageRatio,
        cadenceCoverageRatio,
        hrCoverageRatio,
        jointHrPowerCoverageRatio,
        powerOnlyObservedSeconds: powerOnly,
        hrOnlyObservedSeconds: hrOnly,
        jointHrPowerSeconds: joint,
        ...(powerMedianWatts !== undefined ? { powerMedianWatts } : {}),
        ...(powerMadWatts !== undefined ? { powerMadWatts } : {}),
        ...(cadenceMedianRpm !== undefined ? { cadenceMedianRpm } : {}),
        ...(cadenceMadRpm !== undefined ? { cadenceMadRpm } : {}),
        ...(hrMedianBpm !== undefined ? { hrMedianBpm } : {}),
        ...(hrMadBpm !== undefined ? { hrMadBpm } : {}),
        ...(joint > 0 ? {
            jointPowerMedianWatts: roundTo(numericMedian(jointPower), 2),
            jointHrMedianBpm: roundTo(numericMedian(jointHr), 1),
        } : {}),
        qualification,
        reasons,
    };
}
export function deriveFreestyleStableObservation(input) {
    if (!isOwnerId(input.athleteId) || !isOwnerId(input.sessionId))
        return null;
    if (!Number.isFinite(input.startedAtMs) || !Number.isFinite(input.endedAtMs) || input.endedAtMs <= input.startedAtMs) {
        return null;
    }
    if (!Number.isFinite(input.activeDurationSec) || input.activeDurationSec < 0 || !Number.isInteger(input.activeDurationSec)) {
        return null;
    }
    if (!Number.isFinite(input.pausedDurationSec) || input.pausedDurationSec < 0)
        return null;
    const evidenceIncomplete = input.evidenceIncomplete === true;
    const samples = mapObservations(deduplicateSamples(input.bikeSamples, input.sessionId, input.athleteId, input.activeDurationSec));
    const segmented = segmentStableResistance(samples, {
        maxObservationGapSec: POLICY.maxObservationGapSec,
        maxWallClockExcessSec: POLICY.maxWallClockExcessSec,
    });
    const hrBySecond = validHrBySecond(input.hrSamples, input.sessionId, input.activeDurationSec);
    const windows = segmented.map((window) => classifyWindow(window.observations, hrBySecond, evidenceIncomplete));
    const mechanicallyQualifiedCount = windows.filter((window) => window.qualification === "mechanically_qualified" || window.qualification === "hr_co_observed").length;
    const hrCoObservedCount = windows.filter((window) => window.qualification === "hr_co_observed").length;
    let analysisStatus;
    if (windows.length === 0)
        analysisStatus = "unavailable";
    else if (evidenceIncomplete || mechanicallyQualifiedCount === 0)
        analysisStatus = "diagnostic_only";
    else
        analysisStatus = "observed";
    return {
        schemaVersion: FREESTYLE_STABLE_OBSERVATION_SCHEMA_VERSION_V1,
        policy: POLICY,
        athleteId: input.athleteId,
        sessionId: input.sessionId,
        timing: {
            activeDurationSec: input.activeDurationSec,
            pausedDurationSec: input.pausedDurationSec,
            startedAt: new Date(input.startedAtMs).toISOString(),
            endedAt: new Date(input.endedAtMs).toISOString(),
        },
        observationProvenance: {
            bikeStore: "ordinary_bike_telemetry",
            hrStore: "hr_samples",
            telemetrySchemaVersion: ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
        },
        analysisStatus,
        candidateWindowCount: windows.length,
        mechanicallyQualifiedCount,
        hrCoObservedCount,
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
