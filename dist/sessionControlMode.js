export const SESSION_CONTROL_MODE_SCHEMA_VERSION_V1 = 1;
export const SESSION_CONTROL_MODES = [
    "legacy_hr_control",
    "vo2_protocol",
    "prospective_fixed_load",
];
function exactKeys(value, expected) {
    const keys = Object.keys(value).sort();
    return keys.length === expected.length && expected.slice().sort().every((key, index) => key === keys[index]);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isSessionControlMode(value) {
    return typeof value === "string" && SESSION_CONTROL_MODES.includes(value);
}
/** Strict permanent reader: unknown/missing/extra fields are rejected. */
export function parseFrozenSessionControlMode(value) {
    if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "sessionId", "mode"]))
        return null;
    if (value.schemaVersion !== SESSION_CONTROL_MODE_SCHEMA_VERSION_V1)
        return null;
    if (typeof value.sessionId !== "string" || value.sessionId.length === 0)
        return null;
    if (!isSessionControlMode(value.mode))
        return null;
    return {
        schemaVersion: SESSION_CONTROL_MODE_SCHEMA_VERSION_V1,
        sessionId: value.sessionId,
        mode: value.mode,
    };
}
export function sessionControlModeKey(day) {
    return "session_control_mode_v1_" + day;
}
export function inspectFrozenSessionControlMode(day, expectedSessionId, storage) {
    const raw = storage.getItem(sessionControlModeKey(day));
    if (raw == null)
        return { status: "missing" };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { status: "invalid_or_mismatched" };
    }
    const record = parseFrozenSessionControlMode(parsed);
    if (!record || record.sessionId !== expectedSessionId)
        return { status: "invalid_or_mismatched" };
    return { status: "valid", record };
}
/**
 * Freeze once for one exact session. Same-value retries are idempotent; any
 * malformed, different-session, or conflicting-mode record is an integrity error.
 */
export function freezeSessionControlMode(day, sessionId, mode, storage) {
    if (!sessionId || !isSessionControlMode(mode))
        throw new Error("Invalid session control-mode freeze request");
    const key = sessionControlModeKey(day);
    const raw = storage.getItem(key);
    if (raw != null) {
        let existing = null;
        try {
            existing = parseFrozenSessionControlMode(JSON.parse(raw));
        }
        catch {
            existing = null;
        }
        if (!existing)
            throw new Error("Existing session control-mode record is invalid");
        if (existing.sessionId !== sessionId || existing.mode !== mode) {
            throw new Error("Session control mode is already frozen with a conflicting identity or mode");
        }
        return existing;
    }
    const record = {
        schemaVersion: SESSION_CONTROL_MODE_SCHEMA_VERSION_V1,
        sessionId,
        mode,
    };
    storage.setItem(key, JSON.stringify(record));
    return record;
}
export function clearFrozenSessionControlMode(day, storage) {
    storage.removeItem(sessionControlModeKey(day));
}
/**
 * Missing records use the narrow historical compatibility path. Corrupt or
 * mismatched records fail closed. Prospective mode is never inferred.
 */
export function resolveSessionControlAuthority(day, sessionId, historicalVo2RuntimePresent, storage) {
    if (!sessionId)
        return null;
    const inspected = inspectFrozenSessionControlMode(day, sessionId, storage);
    if (inspected.status === "valid") {
        return { sessionId, mode: inspected.record.mode, source: "frozen" };
    }
    if (inspected.status === "invalid_or_mismatched")
        return null;
    return {
        sessionId,
        mode: historicalVo2RuntimePresent ? "vo2_protocol" : "legacy_hr_control",
        source: "historical_compatibility",
    };
}
