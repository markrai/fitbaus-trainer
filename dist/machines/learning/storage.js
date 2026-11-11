import { getMachineDefinition, isMachineId } from "../registry.js";
import { clampAutomaticResistance } from "../proformSmartPower10.js";
import { LEARNING_STORAGE_KEY, LEARNING_STORE_VERSION, learningKey, parseLearningKey, } from "./types.js";
function storageOrBrowser(storage) {
    return storage !== null && storage !== void 0 ? storage : localStorage;
}
function isPositiveInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function sanitizeStoredEntry(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const raw = value;
    if (!isPositiveInteger(raw.resistance) || !isPositiveInteger(raw.sampleCount))
        return undefined;
    if (typeof raw.updatedAt !== "string" || raw.updatedAt.trim() === "")
        return undefined;
    const resistance = clampAutomaticResistance(raw.resistance);
    if (resistance !== raw.resistance)
        return undefined;
    return {
        resistance,
        sampleCount: raw.sampleCount,
        updatedAt: raw.updatedAt,
    };
}
export function emptyLearnedStore() {
    return { version: LEARNING_STORE_VERSION, entries: {} };
}
export function sanitizeLearnedStore(value) {
    if (!value || typeof value !== "object")
        return emptyLearnedStore();
    const raw = value;
    if (raw.version !== LEARNING_STORE_VERSION || !raw.entries || typeof raw.entries !== "object") {
        return emptyLearnedStore();
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
    return { version: LEARNING_STORE_VERSION, entries };
}
export function loadLearnedStore(storage) {
    try {
        const raw = storageOrBrowser(storage).getItem(LEARNING_STORAGE_KEY);
        return raw ? sanitizeLearnedStore(JSON.parse(raw)) : emptyLearnedStore();
    }
    catch {
        return emptyLearnedStore();
    }
}
export function saveLearnedStore(store, storage) {
    const clean = sanitizeLearnedStore(store);
    storageOrBrowser(storage).setItem(LEARNING_STORAGE_KEY, JSON.stringify(clean));
    return clean;
}
export function getLearnedStartingResistance(parts, storage) {
    const entry = loadLearnedStore(storage).entries[learningKey(parts)];
    return entry === null || entry === void 0 ? void 0 : entry.resistance;
}
export function listLearnedStarts(machineId, storage) {
    const store = loadLearnedStore(storage);
    const listed = [];
    for (const [key, entry] of Object.entries(store.entries)) {
        const parsed = parseLearningKey(key);
        if (!parsed || parsed.machineId !== machineId)
            continue;
        listed.push({ ...parsed, ...entry });
    }
    listed.sort((a, b) => {
        const intent = a.intent.localeCompare(b.intent);
        if (intent !== 0)
            return intent;
        return a.durationClass.localeCompare(b.durationClass);
    });
    return listed;
}
export function putLearnedStart(parts, entry, storage) {
    const store = loadLearnedStore(storage);
    const key = learningKey(parts);
    store.entries[key] = entry;
    const saved = saveLearnedStore(store, storage).entries[key];
    if (!saved)
        return undefined;
    return { ...parts, ...saved };
}
export function resetLearnedGuidanceForMachine(machineId, storage) {
    const store = loadLearnedStore(storage);
    const entries = {};
    for (const [key, entry] of Object.entries(store.entries)) {
        const parsed = parseLearningKey(key);
        if (!parsed || parsed.machineId === machineId)
            continue;
        entries[key] = entry;
    }
    return saveLearnedStore({ version: LEARNING_STORE_VERSION, entries }, storage);
}
export function applyConservativeUpdate(previous, candidate, updatedAt) {
    var _a;
    const nextResistance = previous
        ? clampAutomaticResistance(previous.resistance + Math.max(-1, Math.min(1, candidate - previous.resistance)))
        : clampAutomaticResistance(candidate);
    return {
        resistance: nextResistance,
        sampleCount: ((_a = previous === null || previous === void 0 ? void 0 : previous.sampleCount) !== null && _a !== void 0 ? _a : 0) + 1,
        updatedAt,
    };
}
