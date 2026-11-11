export const FREESTYLE_WORKOUT_SELECTOR_ID = "Freestyle";
export const FREESTYLE_WORKOUT_LABEL = "Freestyle Ride";
export const FREESTYLE_WORKOUT_INTENT = "freestyle";
export const FREESTYLE_PHASE_ID = "freestyle_ride";
export const ACTIVE_SESSION_OWNER_KEY = "active_session_owner_v1";
export const SESSION_FINALIZATION_KEY_PREFIX = "session_finalization_v1_";
export const FREESTYLE_AUTHORITY_FAULT_KEY_PREFIX = "freestyle_authority_fault_v1_";
export const SESSION_FINALIZATION_SCHEMA_VERSION_V1 = 1;
function storageOrBrowser(storage) {
    return storage !== null && storage !== void 0 ? storage : localStorage;
}
export function isFreestyleWorkoutSelector(day) {
    return day === FREESTYLE_WORKOUT_SELECTOR_ID;
}
export function freestylePlanBlocks() {
    return { warm: 0, sustain: 0, cool: 0 };
}
export function freestyleWorkoutMetadata() {
    return {
        type: FREESTYLE_WORKOUT_LABEL,
        intent: FREESTYLE_WORKOUT_INTENT,
        activities: ["bike"],
    };
}
export function freestyleWorkoutBlocksText() {
    return "Open-ended - observation only";
}
export function freestylePhaseState(elapsedSec) {
    const active = Math.max(0, Math.floor(elapsedSec));
    return {
        phase: "Freestyle",
        kind: "work",
        phaseId: FREESTYLE_PHASE_ID,
        phaseElapsedSeconds: active,
        phaseDurationSeconds: 0,
        timeLeft: 0,
        done: false,
    };
}
export function sessionFinalizationKey(selector) {
    return SESSION_FINALIZATION_KEY_PREFIX + selector;
}
export function freestyleAuthorityFaultKey(selector) {
    return FREESTYLE_AUTHORITY_FAULT_KEY_PREFIX + selector;
}
export function parseActiveSessionOwner(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const value = raw;
    if (typeof value.selector !== "string" || value.selector.length === 0)
        return null;
    if (typeof value.sessionId !== "string" || value.sessionId.length === 0)
        return null;
    const owner = {
        selector: value.selector,
        sessionId: value.sessionId,
    };
    if (typeof value.athleteId === "string" && value.athleteId.length > 0) {
        owner.athleteId = value.athleteId;
    }
    return owner;
}
export function readActiveSessionOwner(storage) {
    const raw = storageOrBrowser(storage).getItem(ACTIVE_SESSION_OWNER_KEY);
    if (!raw)
        return null;
    try {
        return parseActiveSessionOwner(JSON.parse(raw));
    }
    catch {
        return null;
    }
}
export function writeActiveSessionOwner(owner, storage) {
    storageOrBrowser(storage).setItem(ACTIVE_SESSION_OWNER_KEY, JSON.stringify(owner));
}
export function clearActiveSessionOwner(expected, storage) {
    const store = storageOrBrowser(storage);
    if (expected) {
        const current = readActiveSessionOwner(store);
        if (!current ||
            current.selector !== expected.selector ||
            current.sessionId !== expected.sessionId) {
            return;
        }
    }
    store.removeItem(ACTIVE_SESSION_OWNER_KEY);
}
export function claimActiveSessionOwner(owner, storage) {
    const current = readActiveSessionOwner(storage);
    if (current &&
        (current.selector !== owner.selector || current.sessionId !== owner.sessionId)) {
        return { ok: false, reason: "competing_active_session" };
    }
    writeActiveSessionOwner(owner, storage);
    return { ok: true };
}
export function readFreestyleAuthorityFault(selector, storage) {
    const raw = storageOrBrowser(storage).getItem(freestyleAuthorityFaultKey(selector));
    return typeof raw === "string" && raw.length > 0 ? raw : null;
}
export function markFreestyleAuthorityFault(selector, sessionId, storage) {
    const store = storageOrBrowser(storage);
    const key = freestyleAuthorityFaultKey(selector);
    const previous = store.getItem(key);
    store.setItem(key, sessionId);
    return previous !== sessionId;
}
export function clearFreestyleAuthorityFault(selector, storage) {
    storageOrBrowser(storage).removeItem(freestyleAuthorityFaultKey(selector));
}
export function parseSessionFinalization(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const value = raw;
    if (value.schemaVersion !== SESSION_FINALIZATION_SCHEMA_VERSION_V1)
        return null;
    if (typeof value.selector !== "string" || value.selector.length === 0)
        return null;
    if (typeof value.sessionId !== "string" || value.sessionId.length === 0)
        return null;
    if (typeof value.startedAtMs !== "number" || !Number.isFinite(value.startedAtMs) || value.startedAtMs <= 0) {
        return null;
    }
    if (typeof value.endedAtMs !== "number" || !Number.isFinite(value.endedAtMs) || value.endedAtMs < value.startedAtMs) {
        return null;
    }
    if (typeof value.activeDurationSec !== "number" ||
        !Number.isFinite(value.activeDurationSec) ||
        value.activeDurationSec < 0) {
        return null;
    }
    if (typeof value.pausedDurationSec !== "number" ||
        !Number.isFinite(value.pausedDurationSec) ||
        value.pausedDurationSec < 0) {
        return null;
    }
    if (value.status !== "finalizing" && value.status !== "save_failed")
        return null;
    const record = {
        schemaVersion: SESSION_FINALIZATION_SCHEMA_VERSION_V1,
        selector: value.selector,
        sessionId: value.sessionId,
        startedAtMs: Math.floor(value.startedAtMs),
        endedAtMs: Math.floor(value.endedAtMs),
        activeDurationSec: Math.floor(value.activeDurationSec),
        pausedDurationSec: Math.floor(value.pausedDurationSec),
        status: value.status,
    };
    if (typeof value.athleteId === "string" && value.athleteId.length > 0) {
        record.athleteId = value.athleteId;
    }
    if (value.evidenceIncomplete === true)
        record.evidenceIncomplete = true;
    return record;
}
export function readSessionFinalization(selector, storage) {
    const raw = storageOrBrowser(storage).getItem(sessionFinalizationKey(selector));
    if (!raw)
        return null;
    try {
        return parseSessionFinalization(JSON.parse(raw));
    }
    catch {
        return null;
    }
}
export function writeSessionFinalization(record, storage) {
    storageOrBrowser(storage).setItem(sessionFinalizationKey(record.selector), JSON.stringify(record));
}
export function clearSessionFinalization(selector, storage) {
    storageOrBrowser(storage).removeItem(sessionFinalizationKey(selector));
}
export function freezeSessionFinalization(input) {
    const existing = readSessionFinalization(input.selector, input.storage);
    if (existing && existing.sessionId !== input.sessionId) {
        return { ok: false, reason: "session_conflict", existing };
    }
    if (existing &&
        existing.sessionId === input.sessionId &&
        (existing.status === "finalizing" || existing.status === "save_failed")) {
        return { ok: true, record: existing };
    }
    const record = {
        schemaVersion: SESSION_FINALIZATION_SCHEMA_VERSION_V1,
        selector: input.selector,
        sessionId: input.sessionId,
        startedAtMs: Math.floor(input.startedAtMs),
        endedAtMs: Math.floor(input.endedAtMs),
        activeDurationSec: Math.floor(input.activeDurationSec),
        pausedDurationSec: Math.floor(input.pausedDurationSec),
        status: "finalizing",
    };
    if (input.athleteId)
        record.athleteId = input.athleteId;
    if (input.evidenceIncomplete === true)
        record.evidenceIncomplete = true;
    writeSessionFinalization(record, input.storage);
    return { ok: true, record };
}
export function markSessionFinalizationSaveFailed(selector, storage, patch) {
    const existing = readSessionFinalization(selector, storage);
    if (!existing)
        return null;
    const next = {
        ...existing,
        status: "save_failed",
        ...((patch === null || patch === void 0 ? void 0 : patch.evidenceIncomplete) === true ? { evidenceIncomplete: true } : {}),
    };
    writeSessionFinalization(next, storage);
    return next;
}
export function markSessionFinalizationInProgress(selector, storage) {
    const existing = readSessionFinalization(selector, storage);
    if (!existing)
        return null;
    if (existing.status === "finalizing")
        return existing;
    const next = { ...existing, status: "finalizing" };
    writeSessionFinalization(next, storage);
    return next;
}
export function markSessionFinalizationEvidenceIncomplete(selector, storage) {
    const existing = readSessionFinalization(selector, storage);
    if (!existing)
        return null;
    if (existing.evidenceIncomplete === true && existing.status === "finalizing")
        return existing;
    const next = {
        ...existing,
        status: "finalizing",
        evidenceIncomplete: true,
    };
    writeSessionFinalization(next, storage);
    return next;
}
export function collectProtectedFreestyleSessionIds(storage, liveSessionId) {
    var _a;
    const ids = new Set();
    const sessionIdFromFinalization = (_a = readSessionFinalization(FREESTYLE_WORKOUT_SELECTOR_ID, storage)) === null || _a === void 0 ? void 0 : _a.sessionId;
    if (sessionIdFromFinalization)
        ids.add(sessionIdFromFinalization);
    const owner = readActiveSessionOwner(storage);
    if (owner && isFreestyleWorkoutSelector(owner.selector))
        ids.add(owner.sessionId);
    const fault = readFreestyleAuthorityFault(FREESTYLE_WORKOUT_SELECTOR_ID, storage);
    if (fault)
        ids.add(fault);
    if (typeof liveSessionId === "string" && liveSessionId.length > 0) {
        ids.add(liveSessionId);
    }
    else {
        const liveFromStorage = storageOrBrowser(storage).getItem("session_id_" + FREESTYLE_WORKOUT_SELECTOR_ID);
        if (typeof liveFromStorage === "string" && liveFromStorage.length > 0) {
            ids.add(liveFromStorage);
        }
    }
    return [...ids];
}
export function countValidHrSampleSeconds(samples) {
    let count = 0;
    for (const sample of samples) {
        if (typeof sample.hr === "number" && Number.isFinite(sample.hr) && sample.hr > 0) {
            count += 1;
        }
    }
    return count;
}
