/**
 * Application-facing workout storage service.
 *
 * Raw IndexedDB mechanics live in src/persistence/ (one connection in
 * indexedDb.ts, one repository per store). This module keeps the public API,
 * the failure sentinels and log messages callers rely on, per-session write
 * serialization, reconstruction of persisted workout models, retention
 * policy, and the one atomic cross-store deletion.
 */
import { parseOrdinaryBikeTelemetrySample } from "./ordinaryWorkoutTelemetry.js";
import { parseWorkoutResponse } from "./workoutResponse.js";
import { parsePersonalizedPrescriptionCharacterization } from "./personalizedPrescriptionCharacterization.js";
import { parseWorkoutExecutionProvenance } from "./executionProvenance.js";
import { rebuildStoredPassiveFitnessProjection } from "./fitnessRefinement.js";
import { parsePersonalizedPrescriptionEvaluation } from "./personalizedPrescription.js";
import { openCurrentDatabase, resetCurrentDatabaseForTests, transactionComplete, untilTransactionComplete, } from "./persistence/indexedDb.js";
import { STORE_WORKOUTS, deleteWorkoutRowInTransaction, putWorkoutRow, readWorkoutRowsNewestFirst, } from "./persistence/repositories/workoutsRepository.js";
import { STORE_HR_SAMPLES, addHrSampleIfAbsent, deleteHrSampleRowsForSession, deleteHrSampleRowsInTransaction, getHrSampleRows, } from "./persistence/repositories/hrSamplesRepository.js";
import { STORE_ORDINARY_BIKE_TELEMETRY, deleteOrdinaryBikeTelemetryRowsForSession, deleteOrdinaryBikeTelemetryRowsInTransaction, getOrdinaryBikeTelemetryRows, writeOrdinaryBikeTelemetrySample, } from "./persistence/repositories/ordinaryBikeTelemetryRepository.js";
import { deleteSisuSettingsRow, getSisuSettingsRow, putSisuSettingsRow, } from "./persistence/repositories/sisuSettingsRepository.js";
import { deleteAbandonedOrdinaryBikeTelemetry } from "./persistence/operations/abandonedTelemetryCleanup.js";
export { STORE_ORDINARY_BIKE_TELEMETRY };
export const ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const initDB = openCurrentDatabase;
async function storeOrdinaryBikeTelemetrySample(value) {
    const sample = parseOrdinaryBikeTelemetrySample(value);
    if (!sample)
        return "rejected";
    try {
        return await writeOrdinaryBikeTelemetrySample(sample);
    }
    catch (error) {
        console.error("Error storing ordinary bike telemetry:", error);
        return "failed";
    }
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
        const rows = await getOrdinaryBikeTelemetryRows(sessionId);
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
async function clearOrdinaryBikeTelemetry(sessionId) {
    try {
        await flushOrdinaryBikeTelemetryWrites(sessionId);
        await deleteOrdinaryBikeTelemetryRowsForSession(sessionId);
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
        const cutoff = now - maxAgeMs;
        return await deleteAbandonedOrdinaryBikeTelemetry(new Date(cutoff).toISOString());
    }
    catch (error) {
        console.error("Error cleaning abandoned ordinary bike telemetry:", error);
        return 0;
    }
}
async function storeHrSample(sessionId, timestampSec, hr) {
    try {
        await addHrSampleIfAbsent(sessionId, timestampSec, hr);
    }
    catch (error) {
        console.error("Error storing HR sample:", error);
    }
}
async function getHrSamples(sessionId) {
    try {
        return await getHrSampleRows(sessionId);
    }
    catch (error) {
        console.error("Error getting HR samples:", error);
        return [];
    }
}
async function storeWorkoutSummary(summary) {
    try {
        await putWorkoutRow(summary);
        return true;
    }
    catch (error) {
        console.error("Error storing workout summary:", error);
        return false;
    }
}
async function clearHrSamples(sessionId) {
    try {
        return await deleteHrSampleRowsForSession(sessionId);
    }
    catch (error) {
        console.error("Error clearing HR samples:", error);
    }
}
/**
 * Reconstruct a persisted workout row for the application: versioned
 * sub-records are re-parsed and dropped when invalid or owned by another
 * session/athlete. Persisted rows themselves are never rewritten.
 */
function reconstructWorkoutRow(row) {
    var _a, _b, _c, _d;
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
    return row;
}
async function getAllWorkoutSummaries() {
    try {
        const rows = await readWorkoutRowsNewestFirst();
        return rows.map(reconstructWorkoutRow);
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
        // One readwrite transaction across all three stores: a workout and its HR
        // samples and telemetry are deleted together or not at all.
        const tx = database.transaction([STORE_WORKOUTS, STORE_HR_SAMPLES, STORE_ORDINARY_BIKE_TELEMETRY], "readwrite");
        const completed = transactionComplete(tx);
        await untilTransactionComplete(Promise.all([
            deleteWorkoutRowInTransaction(tx, sessionId),
            deleteHrSampleRowsInTransaction(tx, sessionId),
            deleteOrdinaryBikeTelemetryRowsInTransaction(tx, sessionId),
        ]), completed);
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
        await putSisuSettingsRow({
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
        return await getSisuSettingsRow();
    }
    catch (error) {
        console.error("Error getting SISU settings:", error);
        return null;
    }
}
async function clearSisuSettings() {
    try {
        await deleteSisuSettingsRow();
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
export const resetWorkoutStorageForTests = resetCurrentDatabaseForTests;
export { initDB, storeHrSample, getHrSamples, storeWorkoutSummary, clearHrSamples, storeOrdinaryBikeTelemetrySample, getOrdinaryBikeTelemetrySamples, clearOrdinaryBikeTelemetry, cleanupAbandonedOrdinaryBikeTelemetry, getAllWorkoutSummaries, deleteWorkoutSummary, storeSisuSettings, getSisuSettings, clearSisuSettings, };
