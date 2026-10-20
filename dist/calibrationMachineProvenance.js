import { FORMAL_CALIBRATION_MACHINE_PROVENANCE_SCHEMA_VERSION_V1, } from "./types.js";
/**
 * Sidecar store binding exact promoted formal-calibration instances to the
 * machine their workload evidence was measured on. It lives beside FitnessState
 * so FitnessState, E1, and E2 schemas stay unchanged, and it is never deleted
 * with the source assessment summary.
 */
export const FORMAL_CALIBRATION_MACHINE_PROVENANCE_STORAGE_KEY = "formal_calibration_machine_provenance_v1";
const MAX_RECORDS = 500;
const ATHLETE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MACHINE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function isIso(value) {
    if (typeof value !== "string" || value === "")
        return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function isPositiveInteger(value) {
    return Number.isInteger(value) && value >= 1;
}
function exactKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every((key) => key in value);
}
export function parseFrozenMachineIdentity(value) {
    if (!isObject(value) || !exactKeys(value, ["machineId", "machineProfileVersion"]))
        return null;
    if (typeof value.machineId !== "string" || !MACHINE_ID_PATTERN.test(value.machineId))
        return null;
    if (!isPositiveInteger(value.machineProfileVersion))
        return null;
    return { machineId: value.machineId, machineProfileVersion: value.machineProfileVersion };
}
function versioned(value) {
    if (!isObject(value) || !exactKeys(value, ["id", "version"]))
        return null;
    if (typeof value.id !== "string" || value.id.trim() === "" || !isPositiveInteger(value.version))
        return null;
    return { id: value.id, version: value.version };
}
/** Strict exact-identity reader. Evidence session IDs must already be sorted and unique. */
export function parseFormalCalibrationInstanceIdentity(value) {
    if (!isObject(value) || !exactKeys(value, ["athleteId", "evidenceSessionIds", "observedAt", "algorithm", "protocol", "workloadProvenance"]))
        return null;
    if (typeof value.athleteId !== "string" || !ATHLETE_ID_PATTERN.test(value.athleteId))
        return null;
    if (!Array.isArray(value.evidenceSessionIds) || value.evidenceSessionIds.length === 0 ||
        value.evidenceSessionIds.length > 1000)
        return null;
    const ids = value.evidenceSessionIds;
    if (!ids.every((id) => typeof id === "string" && SESSION_ID_PATTERN.test(id)))
        return null;
    const canonical = [...new Set(ids)].sort();
    if (canonical.length !== ids.length || canonical.some((id, index) => id !== ids[index]))
        return null;
    if (!isIso(value.observedAt))
        return null;
    const algorithm = versioned(value.algorithm);
    const protocol = versioned(value.protocol);
    if (!algorithm || !protocol)
        return null;
    if (value.workloadProvenance !== "measured_watts" && value.workloadProvenance !== "calibrated_at_verified_cadence" &&
        value.workloadProvenance !== "mixed")
        return null;
    return {
        athleteId: value.athleteId,
        evidenceSessionIds: [...canonical],
        observedAt: value.observedAt,
        algorithm,
        protocol,
        workloadProvenance: value.workloadProvenance,
    };
}
function workloadProvenance(points) {
    const sources = [...new Set(points.map((point) => point.workloadSource))];
    if (sources.length > 1)
        return "mixed";
    return sources[0] === "measured_watts" || sources[0] === "calibrated_at_verified_cadence" ? sources[0] : null;
}
/** Identity of the formal calibration metric exactly as persisted in FitnessState. */
export function calibrationIdentityFromMetric(athleteId, metric) {
    if (!metric || metric.source !== "formal_assessment" || !metric.algorithm || !metric.evidenceSessionIds)
        return null;
    const provenance = workloadProvenance(metric.value.points);
    if (!provenance)
        return null;
    return parseFormalCalibrationInstanceIdentity({
        athleteId,
        evidenceSessionIds: [...new Set(metric.evidenceSessionIds)].sort(),
        observedAt: metric.observedAt,
        algorithm: { id: metric.algorithm.id, version: metric.algorithm.version },
        protocol: { id: metric.value.protocol.id, version: metric.value.protocol.version },
        workloadProvenance: provenance,
    });
}
/** Identity of the calibration an E1 record froze; the same dimensions, read from the immutable E1 snapshot. */
export function calibrationIdentityFromE1Snapshot(athleteId, snapshot) {
    if (!snapshot)
        return null;
    return parseFormalCalibrationInstanceIdentity({
        athleteId,
        evidenceSessionIds: [...new Set(snapshot.evidenceSessionIds)].sort(),
        observedAt: snapshot.metricObservedAt,
        algorithm: { id: snapshot.algorithm.id, version: snapshot.algorithm.version },
        protocol: { id: snapshot.calibration.protocol.id, version: snapshot.calibration.protocol.version },
        workloadProvenance: snapshot.calibration.workloadProvenance,
    });
}
export function calibrationIdentityKey(identity) {
    return JSON.stringify([identity.athleteId, identity.evidenceSessionIds, identity.observedAt,
        identity.algorithm.id, identity.algorithm.version, identity.protocol.id, identity.protocol.version,
        identity.workloadProvenance]);
}
export function parseFormalCalibrationMachineProvenance(value) {
    if (!isObject(value) || value.schemaVersion !== FORMAL_CALIBRATION_MACHINE_PROVENANCE_SCHEMA_VERSION_V1)
        return null;
    if (!exactKeys(value, ["schemaVersion", "calibration", "machine", "sourceSessionId", "recordedAt"]))
        return null;
    const calibration = parseFormalCalibrationInstanceIdentity(value.calibration);
    const machine = parseFrozenMachineIdentity(value.machine);
    if (!calibration || !machine)
        return null;
    if (typeof value.sourceSessionId !== "string" || !SESSION_ID_PATTERN.test(value.sourceSessionId) ||
        !calibration.evidenceSessionIds.includes(value.sourceSessionId))
        return null;
    if (!isIso(value.recordedAt) || Date.parse(value.recordedAt) < Date.parse(calibration.observedAt))
        return null;
    return {
        schemaVersion: FORMAL_CALIBRATION_MACHINE_PROVENANCE_SCHEMA_VERSION_V1,
        calibration,
        machine,
        sourceSessionId: value.sourceSessionId,
        recordedAt: value.recordedAt,
    };
}
/** Whole-store reader. Any malformed or unknown-version entry makes the store untrustworthy (null). */
export function parseFormalCalibrationMachineProvenanceStore(raw) {
    if (raw === null)
        return [];
    try {
        const value = JSON.parse(raw);
        if (!Array.isArray(value) || value.length > MAX_RECORDS)
            return null;
        const records = [];
        for (const entry of value) {
            const parsed = parseFormalCalibrationMachineProvenance(entry);
            if (!parsed)
                return null;
            records.push(parsed);
        }
        return records;
    }
    catch {
        return null;
    }
}
function sameMachine(a, b) {
    return a.machineId === b.machineId && a.machineProfileVersion === b.machineProfileVersion;
}
/** Exact-identity lookup. Conflicting machine identities for one calibration are an integrity failure, never last-write-wins. */
export function lookupCalibrationMachine(records, identity) {
    if (records === null)
        return { status: "integrity_failure" };
    const key = calibrationIdentityKey(identity);
    const matches = records.filter((record) => calibrationIdentityKey(record.calibration) === key);
    if (matches.length === 0)
        return { status: "unavailable" };
    if (matches.some((record) => !sameMachine(record.machine, matches[0].machine)))
        return { status: "integrity_failure" };
    return { status: "available", machine: { ...matches[0].machine } };
}
export function readFormalCalibrationMachineProvenance(storage) {
    try {
        return parseFormalCalibrationMachineProvenanceStore(storage.getItem(FORMAL_CALIBRATION_MACHINE_PROVENANCE_STORAGE_KEY));
    }
    catch {
        return null;
    }
}
/**
 * Idempotent append. An identical record is not duplicated; a conflicting
 * machine for the same calibration is appended so the conflict stays visible and
 * lookups report integrity_failure. An untrustworthy store is never overwritten.
 */
export function recordFormalCalibrationMachineProvenance(record, storage) {
    const parsed = parseFormalCalibrationMachineProvenance(record);
    if (!parsed || typeof storage.setItem !== "function")
        return "invalid";
    const records = readFormalCalibrationMachineProvenance(storage);
    if (records === null)
        return "store_untrustworthy";
    const key = calibrationIdentityKey(parsed.calibration);
    const matches = records.filter((existing) => calibrationIdentityKey(existing.calibration) === key);
    if (matches.some((existing) => sameMachine(existing.machine, parsed.machine)))
        return "already_recorded";
    if (records.length >= MAX_RECORDS)
        return "persistence_failed";
    try {
        storage.setItem(FORMAL_CALIBRATION_MACHINE_PROVENANCE_STORAGE_KEY, JSON.stringify([...records, parsed]));
    }
    catch {
        return "persistence_failed";
    }
    return matches.length > 0 ? "conflict_recorded" : "recorded";
}
/** Copy the exact sidecar match for an E1-frozen calibration into a workout's start-time provenance. */
export function resolveWorkoutCalibrationMachine(identity, storage) {
    if (!identity)
        return { status: "no_frozen_calibration" };
    const lookup = lookupCalibrationMachine(readFormalCalibrationMachineProvenance(storage), identity);
    if (lookup.status === "available")
        return { status: "available", calibration: identity, ...lookup.machine };
    return { status: lookup.status, calibration: identity };
}
/**
 * After a successful formal promotion, bind the promoted calibration instance to
 * the machine frozen at that assessment's start. The persisted FitnessState
 * calibration must be exactly this assessment's instance (its evidence session
 * and observedAt); otherwise nothing is written.
 */
export function recordPromotedCalibrationMachineProvenance(input, storage, recordedAt) {
    if (!input.machine)
        return "not_applicable";
    const identity = calibrationIdentityFromMetric(input.athleteId, input.calibrationMetric);
    if (!identity || identity.observedAt !== input.endedAt ||
        identity.evidenceSessionIds.length !== 1 || identity.evidenceSessionIds[0] !== input.sessionId) {
        return "not_applicable";
    }
    return recordFormalCalibrationMachineProvenance({
        schemaVersion: FORMAL_CALIBRATION_MACHINE_PROVENANCE_SCHEMA_VERSION_V1,
        calibration: identity,
        machine: { ...input.machine },
        sourceSessionId: input.sessionId,
        recordedAt,
    }, storage);
}
