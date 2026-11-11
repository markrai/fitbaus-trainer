import { getMachineDefinition, isMachineId } from "../registry.js";
import { learningKey, parseLearningKey } from "../learning/types.js";
import { MAX_SHADOW_RESISTANCE, MAX_SHADOW_SUGGESTED_LEVELS, MIN_SHADOW_RESISTANCE, SHADOW_PREDICTION_LIMIT, SHADOW_PREDICTION_STORAGE_KEY, SHADOW_PREDICTION_STORE_VERSION, } from "./types.js";
import { shadowPredictionEventKey, usableShadowSessionId, validateShadowDirection } from "./validation.js";
function storageOrBrowser(storage) {
    return storage !== null && storage !== void 0 ? storage : localStorage;
}
function emptyEntry(updatedAt) {
    return { increase: [], decrease: [], updatedAt };
}
export function emptyShadowPredictionStore() {
    return { version: SHADOW_PREDICTION_STORE_VERSION, entries: {}, processedSessions: [] };
}
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function isInt(value) {
    return typeof value === "number" && Number.isInteger(value);
}
function sanitizeResistance(value) {
    if (!isInt(value) || value < MIN_SHADOW_RESISTANCE || value > MAX_SHADOW_RESISTANCE)
        return undefined;
    return value;
}
function sanitizeDirection(value) {
    return value === "increase" || value === "decrease" ? value : undefined;
}
function sanitizePrediction(value, parts) {
    if (!value || typeof value !== "object")
        return undefined;
    const raw = value;
    if (raw.version !== 1)
        return undefined;
    if (raw.machineId !== parts.machineId)
        return undefined;
    if (raw.machineProfileVersion !== parts.machineProfileVersion)
        return undefined;
    if (raw.activity !== parts.activity)
        return undefined;
    if (raw.intent !== parts.intent)
        return undefined;
    if (raw.durationClass !== parts.durationClass)
        return undefined;
    if (typeof raw.phaseId !== "string" || raw.phaseId.trim() === "")
        return undefined;
    if (!isInt(raw.changeElapsedSeconds) || raw.changeElapsedSeconds < 0)
        return undefined;
    const direction = sanitizeDirection(raw.direction);
    if (!direction)
        return undefined;
    const fromResistance = sanitizeResistance(raw.fromResistance);
    const actualToResistance = sanitizeResistance(raw.actualToResistance);
    if (fromResistance === undefined || actualToResistance === undefined)
        return undefined;
    if (!isInt(raw.preChangeHr))
        return undefined;
    const preChangeHr = raw.preChangeHr;
    if (!isInt(raw.targetHeartRateMin) || !isInt(raw.targetHeartRateMax))
        return undefined;
    if (!isInt(raw.modelSampleCount) || raw.modelSampleCount < 1)
        return undefined;
    if (!isInt(raw.modelMedianHrPerLevel) || !isInt(raw.modelMadBpm) || raw.modelMadBpm < 0)
        return undefined;
    const modelMedianHrPerLevel = raw.modelMedianHrPerLevel;
    if (!isFiniteNumber(raw.modelDirectionConsistency) || raw.modelDirectionConsistency < 0 || raw.modelDirectionConsistency > 1) {
        return undefined;
    }
    if (!isInt(raw.estimatedLevelsNeeded) || raw.estimatedLevelsNeeded < 0)
        return undefined;
    const shadowCappedLevels = isInt(raw.shadowCappedLevels) ? raw.shadowCappedLevels : raw.shadowAppliedCapLevels;
    if (!isInt(shadowCappedLevels) || shadowCappedLevels < 0 || shadowCappedLevels > MAX_SHADOW_SUGGESTED_LEVELS) {
        return undefined;
    }
    const shadowSuggestedResistance = sanitizeResistance(raw.shadowSuggestedResistance);
    if (shadowSuggestedResistance === undefined)
        return undefined;
    const shadowEffectiveLevels = isInt(raw.shadowEffectiveLevels)
        ? raw.shadowEffectiveLevels
        : Math.abs(shadowSuggestedResistance - fromResistance);
    if (shadowEffectiveLevels < 0 || shadowEffectiveLevels > MAX_SHADOW_SUGGESTED_LEVELS)
        return undefined;
    if (!isInt(raw.predictedHrDeltaForActualStep) || !isInt(raw.predictedSettledHrAfterActualStep))
        return undefined;
    let predictedHrDeltaForShadowSuggestion;
    let predictedHrAtShadowSuggestion;
    if (isInt(raw.shadowEffectiveLevels)) {
        if (!isInt(raw.predictedHrDeltaForShadowSuggestion) || !isInt(raw.predictedHrAtShadowSuggestion))
            return undefined;
        predictedHrDeltaForShadowSuggestion = raw.predictedHrDeltaForShadowSuggestion;
        predictedHrAtShadowSuggestion = raw.predictedHrAtShadowSuggestion;
    }
    else {
        predictedHrDeltaForShadowSuggestion = modelMedianHrPerLevel * shadowEffectiveLevels;
        predictedHrAtShadowSuggestion = preChangeHr + predictedHrDeltaForShadowSuggestion;
    }
    const event = {
        version: 1,
        machineId: parts.machineId,
        machineProfileVersion: parts.machineProfileVersion,
        activity: parts.activity,
        intent: parts.intent,
        durationClass: parts.durationClass,
        phaseId: raw.phaseId,
        changeElapsedSeconds: raw.changeElapsedSeconds,
        direction,
        fromResistance,
        actualToResistance,
        preChangeHr,
        targetHeartRateMin: raw.targetHeartRateMin,
        targetHeartRateMax: raw.targetHeartRateMax,
        modelSampleCount: raw.modelSampleCount,
        modelMedianHrPerLevel,
        modelMadBpm: raw.modelMadBpm,
        modelDirectionConsistency: raw.modelDirectionConsistency,
        estimatedLevelsNeeded: raw.estimatedLevelsNeeded,
        shadowCappedLevels,
        shadowEffectiveLevels,
        shadowSuggestedResistance,
        predictedHrDeltaForActualStep: raw.predictedHrDeltaForActualStep,
        predictedSettledHrAfterActualStep: raw.predictedSettledHrAfterActualStep,
        predictedHrDeltaForShadowSuggestion,
        predictedHrAtShadowSuggestion,
    };
    if (typeof raw.sessionId === "string" && raw.sessionId.trim() !== "")
        event.sessionId = raw.sessionId;
    if (isInt(raw.intervalIndex) && raw.intervalIndex >= 0)
        event.intervalIndex = raw.intervalIndex;
    if (isInt(raw.observedHrDelta)) {
        event.observedHrDelta = raw.observedHrDelta;
        if (isInt(raw.predictionErrorBpm))
            event.predictionErrorBpm = raw.predictionErrorBpm;
        if (isInt(raw.absolutePredictionErrorBpm) && raw.absolutePredictionErrorBpm >= 0) {
            event.absolutePredictionErrorBpm = raw.absolutePredictionErrorBpm;
        }
        if (typeof raw.directionMatched === "boolean")
            event.directionMatched = raw.directionMatched;
    }
    return event;
}
function sanitizeStoredEntry(value, parts) {
    if (!value || typeof value !== "object")
        return undefined;
    const raw = value;
    if (typeof raw.updatedAt !== "string" || raw.updatedAt.trim() === "")
        return undefined;
    const increase = [];
    const decrease = [];
    if (Array.isArray(raw.increase)) {
        for (const item of raw.increase) {
            const event = sanitizePrediction(item, parts);
            if (event && event.direction === "increase")
                increase.push(event);
        }
    }
    if (Array.isArray(raw.decrease)) {
        for (const item of raw.decrease) {
            const event = sanitizePrediction(item, parts);
            if (event && event.direction === "decrease")
                decrease.push(event);
        }
    }
    return {
        increase: increase.slice(-SHADOW_PREDICTION_LIMIT),
        decrease: decrease.slice(-SHADOW_PREDICTION_LIMIT),
        updatedAt: raw.updatedAt,
    };
}
function sanitizeProcessedSessions(value) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const processed = [];
    for (const item of value) {
        if (!usableShadowSessionId(item) || seen.has(item))
            continue;
        seen.add(item);
        processed.push(item);
    }
    return processed;
}
export function sanitizeShadowPredictionStore(value) {
    if (!value || typeof value !== "object")
        return emptyShadowPredictionStore();
    const raw = value;
    if (raw.version !== SHADOW_PREDICTION_STORE_VERSION || !raw.entries || typeof raw.entries !== "object") {
        return emptyShadowPredictionStore();
    }
    const entries = {};
    for (const [key, entry] of Object.entries(raw.entries)) {
        const parsed = parseLearningKey(key);
        const clean = parsed ? sanitizeStoredEntry(entry, parsed) : undefined;
        if (!parsed || !clean)
            continue;
        if (!isMachineId(parsed.machineId))
            continue;
        const definition = getMachineDefinition(parsed.machineId);
        if (!definition || definition.activity !== parsed.activity)
            continue;
        if (clean.increase.length === 0 && clean.decrease.length === 0)
            continue;
        entries[key] = clean;
    }
    return {
        version: SHADOW_PREDICTION_STORE_VERSION,
        entries,
        processedSessions: processedSessionsFrom(raw.processedSessions, entries),
    };
}
function processedSessionsFrom(rawProcessedSessions, entries) {
    const processed = new Set(sanitizeProcessedSessions(rawProcessedSessions));
    for (const entry of Object.values(entries)) {
        for (const event of [...entry.increase, ...entry.decrease]) {
            if (usableShadowSessionId(event.sessionId))
                processed.add(event.sessionId);
        }
    }
    return [...processed];
}
export function loadShadowPredictionStore(storage) {
    try {
        const raw = storageOrBrowser(storage).getItem(SHADOW_PREDICTION_STORAGE_KEY);
        return raw ? sanitizeShadowPredictionStore(JSON.parse(raw)) : emptyShadowPredictionStore();
    }
    catch {
        return emptyShadowPredictionStore();
    }
}
export function saveShadowPredictionStore(store, storage) {
    const clean = sanitizeShadowPredictionStore(store);
    storageOrBrowser(storage).setItem(SHADOW_PREDICTION_STORAGE_KEY, JSON.stringify(clean));
    return clean;
}
export function appendBoundedPredictions(values, event) {
    const next = [...values, event];
    return next.length > SHADOW_PREDICTION_LIMIT ? next.slice(-SHADOW_PREDICTION_LIMIT) : next;
}
function hasMatchingShadowEvent(values, event) {
    const key = shadowPredictionEventKey(event);
    if (!key)
        return false;
    return values.some((existing) => shadowPredictionEventKey(existing) === key);
}
function cloneEntry(entry) {
    return {
        increase: [...entry.increase],
        decrease: [...entry.decrease],
        updatedAt: entry.updatedAt,
    };
}
function directionDiagnostics(events, direction) {
    if (events.length === 0)
        return undefined;
    const latest = events[events.length - 1];
    const validation = validateShadowDirection(events, direction);
    const diagnostics = {
        modelMedianHrPerLevel: latest.modelMedianHrPerLevel,
        predictionCount: events.length,
        directionMatchCount: validation.directionMatchCount,
        directionEvaluatedCount: validation.realizedPredictionCount,
        validationStatus: validation.status,
        validationHighConfidence: validation.highConfidence,
        validationOpportunityCount: validation.predictionOpportunityCount,
        realizedPredictionCount: validation.realizedPredictionCount,
        distinctSessionCount: validation.distinctSessionCount,
        withinToleranceCount: validation.withinToleranceCount,
    };
    if (validation.medianAbsolutePredictionErrorBpm !== undefined) {
        diagnostics.medianAbsolutePredictionErrorBpm = validation.medianAbsolutePredictionErrorBpm;
    }
    if (validation.medianSignedPredictionErrorBpm !== undefined) {
        diagnostics.medianSignedPredictionErrorBpm = validation.medianSignedPredictionErrorBpm;
    }
    if (validation.realizationRate !== undefined)
        diagnostics.realizationRate = validation.realizationRate;
    if (validation.directionMatchRate !== undefined)
        diagnostics.directionMatchRate = validation.directionMatchRate;
    if (validation.withinToleranceRate !== undefined)
        diagnostics.withinToleranceRate = validation.withinToleranceRate;
    return diagnostics;
}
export function toPublicShadowDiagnostics(parts, entry) {
    const listed = {
        ...parts,
        updatedAt: entry.updatedAt,
    };
    const increase = directionDiagnostics(entry.increase, "increase");
    const decrease = directionDiagnostics(entry.decrease, "decrease");
    if (increase)
        listed.increase = increase;
    if (decrease)
        listed.decrease = decrease;
    return listed;
}
export function getShadowPredictionEntry(parts, storage) {
    return loadShadowPredictionStore(storage).entries[learningKey(parts)];
}
export function listShadowPredictions(machineId, storage) {
    const store = loadShadowPredictionStore(storage);
    const listed = [];
    for (const [key, entry] of Object.entries(store.entries)) {
        const parsed = parseLearningKey(key);
        if (!parsed || parsed.machineId !== machineId)
            continue;
        listed.push(toPublicShadowDiagnostics(parsed, entry));
    }
    listed.sort((a, b) => {
        const intent = a.intent.localeCompare(b.intent);
        if (intent !== 0)
            return intent;
        return a.durationClass.localeCompare(b.durationClass);
    });
    return listed;
}
export function hasProcessedShadowSession(sessionId, storage) {
    if (!usableShadowSessionId(sessionId))
        return false;
    return loadShadowPredictionStore(storage).processedSessions.includes(sessionId);
}
export function markShadowSessionProcessed(sessionId, storage) {
    persistShadowPredictions([], storage, new Date().toISOString(), sessionId);
}
export function persistShadowPredictions(predictions, storage, updatedAt = new Date().toISOString(), processedSessionId) {
    if (predictions.length === 0 && !usableShadowSessionId(processedSessionId))
        return [];
    const store = loadShadowPredictionStore(storage);
    const saved = [];
    for (const prediction of predictions) {
        const parts = {
            machineId: prediction.machineId,
            machineProfileVersion: prediction.machineProfileVersion,
            activity: prediction.activity,
            intent: prediction.intent,
            durationClass: prediction.durationClass,
        };
        const key = learningKey(parts);
        const current = store.entries[key] ? cloneEntry(store.entries[key]) : emptyEntry(updatedAt);
        const existing = prediction.direction === "increase" ? current.increase : current.decrease;
        if (hasMatchingShadowEvent(existing, prediction))
            continue;
        current.updatedAt = updatedAt;
        if (prediction.direction === "increase") {
            current.increase = appendBoundedPredictions(current.increase, prediction);
        }
        else {
            current.decrease = appendBoundedPredictions(current.decrease, prediction);
        }
        store.entries[key] = current;
        saved.push(prediction);
    }
    let processedSessions = store.processedSessions;
    if (usableShadowSessionId(processedSessionId) && !processedSessions.includes(processedSessionId)) {
        processedSessions = [...processedSessions, processedSessionId];
    }
    if (saved.length > 0 || processedSessions !== store.processedSessions) {
        saveShadowPredictionStore({
            version: SHADOW_PREDICTION_STORE_VERSION,
            entries: store.entries,
            processedSessions,
        }, storage);
    }
    return saved;
}
export function resetShadowPredictionsForMachine(machineId, storage) {
    const store = loadShadowPredictionStore(storage);
    const entries = {};
    for (const [key, entry] of Object.entries(store.entries)) {
        const parsed = parseLearningKey(key);
        if (!parsed || parsed.machineId === machineId)
            continue;
        entries[key] = entry;
    }
    return saveShadowPredictionStore({
        version: SHADOW_PREDICTION_STORE_VERSION,
        entries,
        processedSessions: store.processedSessions,
    }, storage);
}
export function emptyShadowPredictionEntry(updatedAt) {
    return emptyEntry(updatedAt);
}
