import { integerMedian } from "../hrQuality.js";
import { getMachineDefinition, isMachineId } from "../registry.js";
import { learningKey, parseLearningKey } from "../learning/types.js";
import { hasActiveTimingPersonalization, timingModeForEntry } from "./timing.js";
import { DYNAMICS_SAMPLE_LIMIT, DYNAMICS_STORAGE_KEY, DYNAMICS_STORE_VERSION, MAX_ABS_HR_DELTA, MAX_ABS_HR_PER_LEVEL, RECENT_OPPORTUNITY_LIMIT, RESPONSE_SEARCH_SECONDS, } from "./types.js";
import { recentDetectedCount, recentObservationCount } from "./recent.js";
function storageOrBrowser(storage) {
    return storage !== null && storage !== void 0 ? storage : localStorage;
}
function emptyEntry(updatedAt) {
    return {
        workStartDelays: [],
        workStartHrDeltas: [],
        increaseDelays: [],
        increaseHrPerLevel: [],
        decreaseDelays: [],
        decreaseHrPerLevel: [],
        workStartObservationCount: 0,
        workStartDetectedResponseCount: 0,
        increaseObservationCount: 0,
        increaseDetectedResponseCount: 0,
        decreaseObservationCount: 0,
        decreaseDetectedResponseCount: 0,
        workStartRecentResponses: [],
        increaseRecentResponses: [],
        decreaseRecentResponses: [],
        updatedAt,
    };
}
export function emptyDynamicsStore() {
    return { version: DYNAMICS_STORE_VERSION, entries: {} };
}
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function sanitizeNumberArray(value, allowed) {
    if (!Array.isArray(value))
        return [];
    const clean = [];
    for (const item of value) {
        if (!isFiniteNumber(item) || !allowed(item))
            continue;
        clean.push(item);
    }
    return clean.slice(-DYNAMICS_SAMPLE_LIMIT);
}
function sanitizeCount(value) {
    if (!Number.isInteger(value) || value < 0)
        return 0;
    return value;
}
function sanitizeDetectedCount(detected, observed) {
    return Math.min(sanitizeCount(detected), observed);
}
function sanitizeRecentResponses(value) {
    if (!Array.isArray(value))
        return [];
    const clean = [];
    for (const item of value) {
        if (item === null) {
            clean.push(null);
            continue;
        }
        if (isFiniteNumber(item) && delayAllowed(item))
            clean.push(item);
    }
    return clean.slice(-RECENT_OPPORTUNITY_LIMIT);
}
function delayAllowed(value) {
    return Number.isInteger(value) && value >= 0 && value <= RESPONSE_SEARCH_SECONDS;
}
function hrDeltaAllowed(value) {
    return Number.isInteger(value) && Math.abs(value) <= MAX_ABS_HR_DELTA;
}
function perLevelAllowed(value) {
    return Number.isInteger(value) && Math.abs(value) <= MAX_ABS_HR_PER_LEVEL;
}
function sanitizeStoredEntry(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const raw = value;
    if (typeof raw.updatedAt !== "string" || raw.updatedAt.trim() === "")
        return undefined;
    return {
        workStartDelays: sanitizeNumberArray(raw.workStartDelays, delayAllowed),
        workStartHrDeltas: sanitizeNumberArray(raw.workStartHrDeltas, hrDeltaAllowed),
        increaseDelays: sanitizeNumberArray(raw.increaseDelays, delayAllowed),
        increaseHrPerLevel: sanitizeNumberArray(raw.increaseHrPerLevel, perLevelAllowed),
        decreaseDelays: sanitizeNumberArray(raw.decreaseDelays, delayAllowed),
        decreaseHrPerLevel: sanitizeNumberArray(raw.decreaseHrPerLevel, perLevelAllowed),
        workStartObservationCount: sanitizeCount(raw.workStartObservationCount),
        workStartDetectedResponseCount: sanitizeDetectedCount(raw.workStartDetectedResponseCount, sanitizeCount(raw.workStartObservationCount)),
        increaseObservationCount: sanitizeCount(raw.increaseObservationCount),
        increaseDetectedResponseCount: sanitizeDetectedCount(raw.increaseDetectedResponseCount, sanitizeCount(raw.increaseObservationCount)),
        decreaseObservationCount: sanitizeCount(raw.decreaseObservationCount),
        decreaseDetectedResponseCount: sanitizeDetectedCount(raw.decreaseDetectedResponseCount, sanitizeCount(raw.decreaseObservationCount)),
        workStartRecentResponses: sanitizeRecentResponses(raw.workStartRecentResponses),
        increaseRecentResponses: sanitizeRecentResponses(raw.increaseRecentResponses),
        decreaseRecentResponses: sanitizeRecentResponses(raw.decreaseRecentResponses),
        updatedAt: raw.updatedAt,
    };
}
export function sanitizeDynamicsStore(value) {
    if (!value || typeof value !== "object")
        return emptyDynamicsStore();
    const raw = value;
    if (raw.version !== DYNAMICS_STORE_VERSION || !raw.entries || typeof raw.entries !== "object") {
        return emptyDynamicsStore();
    }
    const entries = {};
    for (const [key, entry] of Object.entries(raw.entries)) {
        const parsed = parseLearningKey(key);
        const clean = sanitizeStoredEntry(entry);
        if (!parsed || !clean)
            continue;
        if (!isMachineId(parsed.machineId))
            continue;
        const definition = getMachineDefinition(parsed.machineId);
        if (!definition || definition.activity !== parsed.activity)
            continue;
        entries[key] = clean;
    }
    return { version: DYNAMICS_STORE_VERSION, entries };
}
export function loadDynamicsStore(storage) {
    try {
        const raw = storageOrBrowser(storage).getItem(DYNAMICS_STORAGE_KEY);
        return raw ? sanitizeDynamicsStore(JSON.parse(raw)) : emptyDynamicsStore();
    }
    catch {
        return emptyDynamicsStore();
    }
}
export function saveDynamicsStore(store, storage) {
    const clean = sanitizeDynamicsStore(store);
    storageOrBrowser(storage).setItem(DYNAMICS_STORAGE_KEY, JSON.stringify(clean));
    return clean;
}
export function appendBoundedSample(values, value) {
    const next = [...values, value];
    return next.length > DYNAMICS_SAMPLE_LIMIT ? next.slice(-DYNAMICS_SAMPLE_LIMIT) : next;
}
export function appendBoundedRecentResponse(values, value) {
    const next = [...values, value];
    return next.length > RECENT_OPPORTUNITY_LIMIT ? next.slice(-RECENT_OPPORTUNITY_LIMIT) : next;
}
export function toPublicDynamics(parts, entry) {
    var _a, _b, _c, _d, _e, _f;
    const listed = {
        ...parts,
        workStartSampleCount: Math.max(entry.workStartDelays.length, entry.workStartHrDeltas.length),
        workStartDelaySampleCount: entry.workStartDelays.length,
        medianWorkStartDelaySeconds: integerMedian(entry.workStartDelays),
        medianWorkStartHrDelta: integerMedian(entry.workStartHrDeltas),
        increaseSampleCount: Math.max(entry.increaseDelays.length, entry.increaseHrPerLevel.length),
        increaseDelaySampleCount: entry.increaseDelays.length,
        medianIncreaseDelaySeconds: integerMedian(entry.increaseDelays),
        medianIncreaseHrDeltaPerStep: integerMedian(entry.increaseHrPerLevel),
        decreaseSampleCount: Math.max(entry.decreaseDelays.length, entry.decreaseHrPerLevel.length),
        decreaseDelaySampleCount: entry.decreaseDelays.length,
        medianDecreaseDelaySeconds: integerMedian(entry.decreaseDelays),
        medianDecreaseHrDeltaPerStep: integerMedian(entry.decreaseHrPerLevel),
        workStartObservationCount: entry.workStartObservationCount,
        workStartDetectedResponseCount: entry.workStartDetectedResponseCount,
        increaseObservationCount: entry.increaseObservationCount,
        increaseDetectedResponseCount: entry.increaseDetectedResponseCount,
        decreaseObservationCount: entry.decreaseObservationCount,
        decreaseDetectedResponseCount: entry.decreaseDetectedResponseCount,
        workStartRecentObservationCount: recentObservationCount((_a = entry.workStartRecentResponses) !== null && _a !== void 0 ? _a : []),
        workStartRecentDetectedResponseCount: recentDetectedCount((_b = entry.workStartRecentResponses) !== null && _b !== void 0 ? _b : []),
        increaseRecentObservationCount: recentObservationCount((_c = entry.increaseRecentResponses) !== null && _c !== void 0 ? _c : []),
        increaseRecentDetectedResponseCount: recentDetectedCount((_d = entry.increaseRecentResponses) !== null && _d !== void 0 ? _d : []),
        decreaseRecentObservationCount: recentObservationCount((_e = entry.decreaseRecentResponses) !== null && _e !== void 0 ? _e : []),
        decreaseRecentDetectedResponseCount: recentDetectedCount((_f = entry.decreaseRecentResponses) !== null && _f !== void 0 ? _f : []),
        updatedAt: entry.updatedAt,
    };
    if (hasActiveTimingPersonalization(entry, parts.durationClass))
        listed.timingPersonalized = true;
    const timingMode = timingModeForEntry(entry, parts.durationClass);
    if (timingMode)
        listed.timingMode = timingMode;
    return listed;
}
export function getDynamicsEntry(parts, storage) {
    return loadDynamicsStore(storage).entries[learningKey(parts)];
}
export function listHrDynamics(machineId, storage) {
    const store = loadDynamicsStore(storage);
    const listed = [];
    for (const [key, entry] of Object.entries(store.entries)) {
        const parsed = parseLearningKey(key);
        if (!parsed || parsed.machineId !== machineId)
            continue;
        listed.push(toPublicDynamics(parsed, entry));
    }
    listed.sort((a, b) => {
        const intent = a.intent.localeCompare(b.intent);
        if (intent !== 0)
            return intent;
        return a.durationClass.localeCompare(b.durationClass);
    });
    return listed;
}
export function putDynamicsEntry(parts, entry, storage) {
    const store = loadDynamicsStore(storage);
    const key = learningKey(parts);
    store.entries[key] = entry;
    const saved = saveDynamicsStore(store, storage).entries[key];
    if (!saved)
        return undefined;
    return toPublicDynamics(parts, saved);
}
export function resetHrDynamicsForMachine(machineId, storage) {
    const store = loadDynamicsStore(storage);
    const entries = {};
    for (const [key, entry] of Object.entries(store.entries)) {
        const parsed = parseLearningKey(key);
        if (!parsed || parsed.machineId === machineId)
            continue;
        entries[key] = entry;
    }
    return saveDynamicsStore({ version: DYNAMICS_STORE_VERSION, entries }, storage);
}
export function entryHasDynamicsSamples(entry) {
    var _a, _b, _c, _d, _e, _f;
    return (entry.workStartDelays.length > 0 ||
        entry.workStartHrDeltas.length > 0 ||
        entry.increaseDelays.length > 0 ||
        entry.increaseHrPerLevel.length > 0 ||
        entry.decreaseDelays.length > 0 ||
        entry.decreaseHrPerLevel.length > 0 ||
        entry.workStartObservationCount > 0 ||
        entry.increaseObservationCount > 0 ||
        entry.decreaseObservationCount > 0 ||
        ((_b = (_a = entry.workStartRecentResponses) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) > 0 ||
        ((_d = (_c = entry.increaseRecentResponses) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : 0) > 0 ||
        ((_f = (_e = entry.decreaseRecentResponses) === null || _e === void 0 ? void 0 : _e.length) !== null && _f !== void 0 ? _f : 0) > 0);
}
export function cloneEntry(entry) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    return {
        workStartDelays: [...entry.workStartDelays],
        workStartHrDeltas: [...entry.workStartHrDeltas],
        increaseDelays: [...entry.increaseDelays],
        increaseHrPerLevel: [...entry.increaseHrPerLevel],
        decreaseDelays: [...entry.decreaseDelays],
        decreaseHrPerLevel: [...entry.decreaseHrPerLevel],
        workStartObservationCount: (_a = entry.workStartObservationCount) !== null && _a !== void 0 ? _a : 0,
        workStartDetectedResponseCount: (_b = entry.workStartDetectedResponseCount) !== null && _b !== void 0 ? _b : 0,
        increaseObservationCount: (_c = entry.increaseObservationCount) !== null && _c !== void 0 ? _c : 0,
        increaseDetectedResponseCount: (_d = entry.increaseDetectedResponseCount) !== null && _d !== void 0 ? _d : 0,
        decreaseObservationCount: (_e = entry.decreaseObservationCount) !== null && _e !== void 0 ? _e : 0,
        decreaseDetectedResponseCount: (_f = entry.decreaseDetectedResponseCount) !== null && _f !== void 0 ? _f : 0,
        workStartRecentResponses: [...((_g = entry.workStartRecentResponses) !== null && _g !== void 0 ? _g : [])],
        increaseRecentResponses: [...((_h = entry.increaseRecentResponses) !== null && _h !== void 0 ? _h : [])],
        decreaseRecentResponses: [...((_j = entry.decreaseRecentResponses) !== null && _j !== void 0 ? _j : [])],
        updatedAt: entry.updatedAt,
    };
}
export function emptyDynamicsEntry(updatedAt) {
    return emptyEntry(updatedAt);
}
