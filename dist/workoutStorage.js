import { parseOrdinaryBikeTelemetrySample } from "./ordinaryWorkoutTelemetry.js";
import { parseWorkoutResponse } from "./workoutResponse.js";
import { parsePersonalizedPrescriptionCharacterization } from "./personalizedPrescriptionCharacterization.js";
import { parseWorkoutExecutionProvenance } from "./executionProvenance.js";
import { rebuildStoredPassiveFitnessProjection } from "./fitnessRefinement.js";
import { parsePersonalizedPrescriptionEvaluation } from "./personalizedPrescription.js";
const DB_NAME = "fitbaus_trainer_db";
const DB_VERSION = 3;
const STORE_WORKOUTS = "workouts";
const STORE_HR_SAMPLES = "hr_samples";
export const STORE_ORDINARY_BIKE_TELEMETRY = "ordinary_bike_telemetry";
const STORE_SISU_SETTINGS = "sisu_settings";
export const ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS = 48 * 60 * 60 * 1000;
let db = null;
async function initDB() {
    if (db)
        return db;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_WORKOUTS)) {
                const workoutsStore = database.createObjectStore(STORE_WORKOUTS, { keyPath: "session_id" });
                workoutsStore.createIndex("startedAt", "startedAt", { unique: false });
                workoutsStore.createIndex("day", "day", { unique: false });
            }
            if (!database.objectStoreNames.contains(STORE_HR_SAMPLES)) {
                const hrSamplesStore = database.createObjectStore(STORE_HR_SAMPLES, {
                    keyPath: ["session_id", "timestamp_sec"],
                });
                hrSamplesStore.createIndex("session_id", "session_id", { unique: false });
            }
            if (!database.objectStoreNames.contains(STORE_ORDINARY_BIKE_TELEMETRY)) {
                const telemetryStore = database.createObjectStore(STORE_ORDINARY_BIKE_TELEMETRY, {
                    keyPath: ["session_id", "active_sec"],
                });
                telemetryStore.createIndex("session_id", "session_id", { unique: false });
                telemetryStore.createIndex("observed_at", "observed_at", { unique: false });
                telemetryStore.createIndex("session_source_id", ["session_id", "source_sample_id"], { unique: false });
            }
            if (!database.objectStoreNames.contains(STORE_SISU_SETTINGS)) {
                database.createObjectStore(STORE_SISU_SETTINGS, { keyPath: "key" });
            }
        };
    });
}
function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
function transactionComplete(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
}
function telemetryRow(sample) {
    return {
        session_id: sample.sessionId,
        athlete_id: sample.athleteId,
        active_sec: sample.activeSec,
        observed_at: sample.observedAt,
        ...(sample.sourceSampleId ? { source_sample_id: sample.sourceSampleId } : {}),
        sample,
    };
}
function availabilityRank(sample) {
    return sample.availability === "fresh" ? 2 : sample.availability === "stale" ? 1 : 0;
}
async function sourceSampleBelongsToAnotherSecond(store, sample) {
    if (!sample.sourceSampleId)
        return false;
    const sameSourceRows = await requestResult(store.index("session_source_id").getAll([sample.sessionId, sample.sourceSampleId]));
    return sameSourceRows.some((row) => row.active_sec !== sample.activeSec);
}
async function storeOrdinaryBikeTelemetrySample(value) {
    const sample = parseOrdinaryBikeTelemetrySample(value);
    if (!sample)
        return "rejected";
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_ORDINARY_BIKE_TELEMETRY], "readwrite");
        const completed = transactionComplete(tx);
        const store = tx.objectStore(STORE_ORDINARY_BIKE_TELEMETRY);
        let outcome = "stored";
        const existing = await requestResult(store.get([sample.sessionId, sample.activeSec]));
        if (existing) {
            const prior = parseOrdinaryBikeTelemetrySample(existing.sample);
            if (prior && availabilityRank(sample) > availabilityRank(prior)) {
                if (await sourceSampleBelongsToAnotherSecond(store, sample))
                    outcome = "duplicate";
                else
                    await requestResult(store.put(telemetryRow(sample)));
            }
            else {
                outcome = "duplicate";
            }
        }
        else if (sample.sourceSampleId) {
            if (await sourceSampleBelongsToAnotherSecond(store, sample))
                outcome = "duplicate";
            else
                await requestResult(store.add(telemetryRow(sample)));
        }
        else {
            await requestResult(store.add(telemetryRow(sample)));
        }
        await completed;
        return outcome;
    }
    catch (error) {
        console.error("Error storing ordinary bike telemetry:", error);
        return "failed";
    }
}
function oldTelemetrySessionIds(store, cutoffIso) {
    return new Promise((resolve, reject) => {
        const sessionIds = new Set();
        const request = store
            .index("observed_at")
            .openKeyCursor(IDBKeyRange.upperBound(cutoffIso, true));
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve(sessionIds);
                return;
            }
            const primaryKey = cursor.primaryKey;
            if (Array.isArray(primaryKey) && typeof primaryKey[0] === "string") {
                sessionIds.add(primaryKey[0]);
            }
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    });
}
const pendingOrdinaryWrites = new Map();
/** Serialize per-session writes so finalization can reliably flush the last observed second. */
export function queueOrdinaryBikeTelemetrySample(sample) {
    var _a;
    const prior = (_a = pendingOrdinaryWrites.get(sample.sessionId)) !== null && _a !== void 0 ? _a : Promise.resolve();
    const next = prior
        .catch(() => undefined)
        .then(async () => {
        await storeOrdinaryBikeTelemetrySample(sample);
    });
    pendingOrdinaryWrites.set(sample.sessionId, next);
    void next.finally(() => {
        if (pendingOrdinaryWrites.get(sample.sessionId) === next)
            pendingOrdinaryWrites.delete(sample.sessionId);
    });
}
export async function flushOrdinaryBikeTelemetryWrites(sessionId) {
    var _a;
    await ((_a = pendingOrdinaryWrites.get(sessionId)) !== null && _a !== void 0 ? _a : Promise.resolve());
}
async function getOrdinaryBikeTelemetrySamples(sessionId) {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_ORDINARY_BIKE_TELEMETRY], "readonly");
        const rows = await requestResult(tx.objectStore(STORE_ORDINARY_BIKE_TELEMETRY).index("session_id").getAll(sessionId));
        const samples = [];
        for (const row of rows) {
            const parsed = parseOrdinaryBikeTelemetrySample(row === null || row === void 0 ? void 0 : row.sample);
            if (!parsed ||
                parsed.sessionId !== sessionId ||
                row.session_id !== parsed.sessionId ||
                row.athlete_id !== parsed.athleteId ||
                row.active_sec !== parsed.activeSec) {
                continue;
            }
            samples.push(parsed);
        }
        return samples.sort((a, b) => a.activeSec - b.activeSec);
    }
    catch (error) {
        console.error("Error getting ordinary bike telemetry:", error);
        return [];
    }
}
function deleteBySessionIndex(store, sessionId) {
    const request = store.index("session_id").openCursor(IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor)
            return;
        cursor.delete();
        cursor.continue();
    };
}
async function clearOrdinaryBikeTelemetry(sessionId) {
    try {
        await flushOrdinaryBikeTelemetryWrites(sessionId);
        const database = await initDB();
        const tx = database.transaction([STORE_ORDINARY_BIKE_TELEMETRY], "readwrite");
        const completed = transactionComplete(tx);
        deleteBySessionIndex(tx.objectStore(STORE_ORDINARY_BIKE_TELEMETRY), sessionId);
        await completed;
    }
    catch (error) {
        console.error("Error clearing ordinary bike telemetry:", error);
    }
}
/** Delete old raw traces only when no immutable workout summary owns the session. */
async function cleanupAbandonedOrdinaryBikeTelemetry(now = Date.now(), maxAgeMs = ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS) {
    try {
        if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0)
            return 0;
        const database = await initDB();
        const cutoff = now - maxAgeMs;
        const telemetryTx = database.transaction([STORE_ORDINARY_BIKE_TELEMETRY], "readonly");
        const candidateSessionIds = await oldTelemetrySessionIds(telemetryTx.objectStore(STORE_ORDINARY_BIKE_TELEMETRY), new Date(cutoff).toISOString());
        if (candidateSessionIds.size === 0)
            return 0;
        const workoutTx = database.transaction([STORE_WORKOUTS], "readonly");
        const workoutStore = workoutTx.objectStore(STORE_WORKOUTS);
        const ownership = await Promise.all([...candidateSessionIds].map(async (sessionId) => ({
            sessionId,
            row: await requestResult(workoutStore.get(sessionId)),
        })));
        const abandoned = ownership
            .filter(({ row }) => row === undefined)
            .map(({ sessionId }) => sessionId);
        for (const sessionId of abandoned) {
            await clearOrdinaryBikeTelemetry(sessionId);
        }
        return abandoned.length;
    }
    catch (error) {
        console.error("Error cleaning abandoned ordinary bike telemetry:", error);
        return 0;
    }
}
async function storeHrSample(sessionId, timestampSec, hr) {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_HR_SAMPLES], "readwrite");
        const store = tx.objectStore(STORE_HR_SAMPLES);
        const key = [sessionId, timestampSec];
        await new Promise((resolve, reject) => {
            const getRequest = store.get(key);
            getRequest.onerror = () => reject(getRequest.error);
            getRequest.onsuccess = () => {
                if (getRequest.result) {
                    resolve();
                    return;
                }
                const addRequest = store.add({ session_id: sessionId, timestamp_sec: timestampSec, hr });
                addRequest.onsuccess = () => resolve();
                addRequest.onerror = () => {
                    var _a;
                    if (((_a = addRequest.error) === null || _a === void 0 ? void 0 : _a.name) === "ConstraintError")
                        resolve();
                    else
                        reject(addRequest.error);
                };
            };
        });
    }
    catch (error) {
        console.error("Error storing HR sample:", error);
    }
}
async function getHrSamples(sessionId) {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_HR_SAMPLES], "readonly");
        const store = tx.objectStore(STORE_HR_SAMPLES);
        const index = store.index("session_id");
        return await new Promise((resolve, reject) => {
            const request = index.getAll(sessionId);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }
    catch (error) {
        console.error("Error getting HR samples:", error);
        return [];
    }
}
async function storeWorkoutSummary(summary) {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_WORKOUTS], "readwrite");
        const store = tx.objectStore(STORE_WORKOUTS);
        await new Promise((resolve, reject) => {
            const request = store.put({
                session_id: summary.external_session_id,
                startedAt: summary.startedAt,
                endedAt: summary.endedAt,
                day: summary.day || null,
                summary,
            });
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error("workout summary write aborted"));
        });
        return true;
    }
    catch (error) {
        console.error("Error storing workout summary:", error);
        return false;
    }
}
async function clearHrSamples(sessionId) {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_HR_SAMPLES], "readwrite");
        const store = tx.objectStore(STORE_HR_SAMPLES);
        const index = store.index("session_id");
        return await new Promise((resolve, reject) => {
            const range = IDBKeyRange.only(sessionId);
            const request = index.openCursor(range);
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
                else {
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
    }
    catch (error) {
        console.error("Error clearing HR samples:", error);
    }
}
async function getAllWorkoutSummaries() {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_WORKOUTS], "readonly");
        const store = tx.objectStore(STORE_WORKOUTS);
        const index = store.index("startedAt");
        return await new Promise((resolve, reject) => {
            const workouts = [];
            const request = index.openCursor(null, "prev");
            request.onsuccess = (event) => {
                var _a, _b, _c, _d;
                const cursor = event.target.result;
                if (cursor) {
                    const row = cursor.value;
                    if (((_a = row === null || row === void 0 ? void 0 : row.summary) === null || _a === void 0 ? void 0 : _a.workout_response) !== undefined) {
                        const parsed = parseWorkoutResponse(row.summary.workout_response);
                        row.summary = { ...row.summary };
                        if (parsed &&
                            parsed.sessionId === row.session_id &&
                            parsed.sessionId === row.summary.external_session_id &&
                            parsed.athleteId === row.summary.athlete_id)
                            row.summary.workout_response = parsed;
                        else
                            delete row.summary.workout_response;
                    }
                    if (((_b = row === null || row === void 0 ? void 0 : row.summary) === null || _b === void 0 ? void 0 : _b.shadow_prescription_evaluation) !== undefined) {
                        const parsedShadow = parsePersonalizedPrescriptionEvaluation(row.summary.shadow_prescription_evaluation);
                        row.summary = { ...row.summary };
                        if (parsedShadow &&
                            parsedShadow.athleteId === row.summary.athlete_id &&
                            parsedShadow.workoutSelector === row.summary.day) {
                            row.summary.shadow_prescription_evaluation = parsedShadow;
                        }
                        else {
                            delete row.summary.shadow_prescription_evaluation;
                        }
                    }
                    if (((_c = row === null || row === void 0 ? void 0 : row.summary) === null || _c === void 0 ? void 0 : _c.execution_provenance) !== undefined) {
                        const parsedProvenance = parseWorkoutExecutionProvenance(row.summary.execution_provenance);
                        row.summary = { ...row.summary };
                        if (parsedProvenance && parsedProvenance.sessionId === row.session_id &&
                            parsedProvenance.sessionId === row.summary.external_session_id) {
                            row.summary.execution_provenance = parsedProvenance;
                        }
                        else {
                            delete row.summary.execution_provenance;
                        }
                    }
                    if (((_d = row === null || row === void 0 ? void 0 : row.summary) === null || _d === void 0 ? void 0 : _d.shadow_prescription_characterization) !== undefined) {
                        const parsedCharacterization = row.summary.workout_response === undefined
                            ? null
                            : parsePersonalizedPrescriptionCharacterization(row.summary.shadow_prescription_characterization, row.summary.shadow_prescription_evaluation, {
                                athleteId: row.summary.athlete_id,
                                sessionId: row.summary.external_session_id,
                                workoutSelector: row.summary.day,
                                activity: row.summary.activity,
                                workoutResponse: row.summary.workout_response,
                            });
                        row.summary = { ...row.summary };
                        if (parsedCharacterization) {
                            row.summary.shadow_prescription_characterization = parsedCharacterization;
                        }
                        else {
                            delete row.summary.shadow_prescription_characterization;
                        }
                    }
                    workouts.push(row);
                    cursor.continue();
                }
                else {
                    resolve(workouts);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }
    catch (error) {
        console.error("Error getting all workout summaries:", error);
        return [];
    }
}
async function deleteWorkoutSummary(sessionId) {
    try {
        await flushOrdinaryBikeTelemetryWrites(sessionId);
        const database = await initDB();
        const tx = database.transaction([STORE_WORKOUTS, STORE_HR_SAMPLES, STORE_ORDINARY_BIKE_TELEMETRY], "readwrite");
        const completed = transactionComplete(tx);
        tx.objectStore(STORE_WORKOUTS).delete(sessionId);
        deleteBySessionIndex(tx.objectStore(STORE_HR_SAMPLES), sessionId);
        deleteBySessionIndex(tx.objectStore(STORE_ORDINARY_BIKE_TELEMETRY), sessionId);
        await completed;
        try {
            const history = await getAllWorkoutSummaries();
            rebuildStoredPassiveFitnessProjection(history.map((row) => row.summary));
        }
        catch (error) {
            console.error("Error rebuilding passive fitness projection after deletion:", error);
        }
        return true;
    }
    catch (error) {
        console.error("Error deleting workout summary:", error);
        return false;
    }
}
async function storeSisuSettings(host, port, protocol) {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_SISU_SETTINGS], "readwrite");
        const store = tx.objectStore(STORE_SISU_SETTINGS);
        await store.put({
            key: "config",
            host,
            port,
            protocol,
            last_connected: new Date().toISOString(),
            last_sync: null,
        });
        return true;
    }
    catch (error) {
        console.error("Error storing SISU settings:", error);
        return false;
    }
}
async function getSisuSettings() {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_SISU_SETTINGS], "readonly");
        const store = tx.objectStore(STORE_SISU_SETTINGS);
        return await new Promise((resolve, reject) => {
            const request = store.get("config");
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }
    catch (error) {
        console.error("Error getting SISU settings:", error);
        return null;
    }
}
async function clearSisuSettings() {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_SISU_SETTINGS], "readwrite");
        const store = tx.objectStore(STORE_SISU_SETTINGS);
        await store.delete("config");
        return true;
    }
    catch (error) {
        console.error("Error clearing SISU settings:", error);
        return false;
    }
}
export function registerStorageGlobals() {
    window.initDB = initDB;
    window.storeHrSample = storeHrSample;
    window.getHrSamples = getHrSamples;
    window.storeWorkoutSummary = storeWorkoutSummary;
    window.clearHrSamples = clearHrSamples;
    window.storeOrdinaryBikeTelemetrySample = storeOrdinaryBikeTelemetrySample;
    window.getOrdinaryBikeTelemetrySamples = getOrdinaryBikeTelemetrySamples;
    window.clearOrdinaryBikeTelemetry = clearOrdinaryBikeTelemetry;
    window.getAllWorkoutSummaries = getAllWorkoutSummaries;
    window.deleteWorkoutSummary = deleteWorkoutSummary;
    window.storeSisuSettings = storeSisuSettings;
    window.getSisuSettings = getSisuSettings;
    window.clearSisuSettings = clearSisuSettings;
}
/** Close the cached IDB handle and delete the app database (tests only). */
export async function resetWorkoutStorageForTests() {
    if (db) {
        db.close();
        db = null;
    }
    await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => resolve();
    });
}
export { initDB, storeHrSample, getHrSamples, storeWorkoutSummary, clearHrSamples, storeOrdinaryBikeTelemetrySample, getOrdinaryBikeTelemetrySamples, clearOrdinaryBikeTelemetry, cleanupAbandonedOrdinaryBikeTelemetry, getAllWorkoutSummaries, deleteWorkoutSummary, storeSisuSettings, getSisuSettings, clearSisuSettings, };
