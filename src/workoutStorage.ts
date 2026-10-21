/**
 * Application-facing workout storage service.
 *
 * Raw IndexedDB mechanics live in src/persistence/ (one connection in
 * indexedDb.ts, one repository per store). This module keeps the public API,
 * the failure sentinels and log messages callers rely on, per-session write
 * serialization, reconstruction of persisted workout models, retention
 * policy, and the one atomic cross-store deletion.
 */

import { HrSample, WorkoutSummary, SisuSettings, type OrdinaryBikeTelemetrySample } from "./types.js";
import { parseOrdinaryBikeTelemetrySample } from "./ordinaryWorkoutTelemetry.js";
import { parseWorkoutResponse } from "./workoutResponse.js";
import { parsePersonalizedPrescriptionCharacterization } from "./personalizedPrescriptionCharacterization.js";
import { parseWorkoutExecutionProvenance } from "./executionProvenance.js";
import { rebuildStoredPassiveFitnessProjection } from "./fitnessRefinement.js";
import { parsePersonalizedPrescriptionEvaluation } from "./personalizedPrescription.js";
import {
  openCurrentDatabase,
  resetCurrentDatabaseForTests,
  transactionComplete,
  untilTransactionComplete,
} from "./persistence/indexedDb.js";
import {
  STORE_WORKOUTS,
  deleteWorkoutRowInTransaction,
  putWorkoutRow,
  readWorkoutRowsNewestFirst,
} from "./persistence/repositories/workoutsRepository.js";
import {
  STORE_HR_SAMPLES,
  addHrSampleIfAbsent,
  deleteHrSampleRowsForSession,
  deleteHrSampleRowsInTransaction,
  getHrSampleRows,
} from "./persistence/repositories/hrSamplesRepository.js";
import {
  STORE_ORDINARY_BIKE_TELEMETRY,
  deleteOrdinaryBikeTelemetryRowsForSession,
  deleteOrdinaryBikeTelemetryRowsInTransaction,
  getOrdinaryBikeTelemetryRows,
  writeOrdinaryBikeTelemetrySample,
} from "./persistence/repositories/ordinaryBikeTelemetryRepository.js";
import {
  deleteSisuSettingsRow,
  getSisuSettingsRow,
  putSisuSettingsRow,
} from "./persistence/repositories/sisuSettingsRepository.js";
import { deleteAbandonedOrdinaryBikeTelemetry } from "./persistence/operations/abandonedTelemetryCleanup.js";

export { STORE_ORDINARY_BIKE_TELEMETRY };
export const ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export type OrdinaryTelemetryWriteResult = "stored" | "duplicate" | "rejected" | "failed";

const initDB = openCurrentDatabase;

async function storeOrdinaryBikeTelemetrySample(
  value: OrdinaryBikeTelemetrySample
): Promise<OrdinaryTelemetryWriteResult> {
  const sample = parseOrdinaryBikeTelemetrySample(value);
  if (!sample) return "rejected";
  try {
    return await writeOrdinaryBikeTelemetrySample(sample);
  } catch (error) {
    console.error("Error storing ordinary bike telemetry:", error);
    return "failed";
  }
}

const pendingOrdinaryWrites = new Map<string, Promise<void>>();

/** Serialize per-session writes so finalization can reliably flush the last observed second. */
export function queueOrdinaryBikeTelemetrySample(sample: OrdinaryBikeTelemetrySample): void {
  const prior = pendingOrdinaryWrites.get(sample.sessionId) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined)
    .then(async () => {
      await storeOrdinaryBikeTelemetrySample(sample);
    });
  pendingOrdinaryWrites.set(sample.sessionId, next);
  void next.finally(() => {
    if (pendingOrdinaryWrites.get(sample.sessionId) === next) pendingOrdinaryWrites.delete(sample.sessionId);
  });
}

export async function flushOrdinaryBikeTelemetryWrites(sessionId: string): Promise<void> {
  await (pendingOrdinaryWrites.get(sessionId) ?? Promise.resolve());
}

async function getOrdinaryBikeTelemetrySamples(sessionId: string): Promise<OrdinaryBikeTelemetrySample[]> {
  try {
    const rows = await getOrdinaryBikeTelemetryRows(sessionId);
    const samples: OrdinaryBikeTelemetrySample[] = [];
    for (const row of rows) {
      const parsed = parseOrdinaryBikeTelemetrySample(row?.sample);
      if (
        !parsed ||
        parsed.sessionId !== sessionId ||
        row.session_id !== parsed.sessionId ||
        row.athlete_id !== parsed.athleteId ||
        row.active_sec !== parsed.activeSec
      ) {
        continue;
      }
      samples.push(parsed);
    }
    return samples.sort((a, b) => a.activeSec - b.activeSec);
  } catch (error) {
    console.error("Error getting ordinary bike telemetry:", error);
    return [];
  }
}

async function clearOrdinaryBikeTelemetry(sessionId: string): Promise<void> {
  try {
    await flushOrdinaryBikeTelemetryWrites(sessionId);
    await deleteOrdinaryBikeTelemetryRowsForSession(sessionId);
  } catch (error) {
    console.error("Error clearing ordinary bike telemetry:", error);
  }
}

/** Delete old raw traces only when no immutable workout summary owns the session. */
async function cleanupAbandonedOrdinaryBikeTelemetry(
  now = Date.now(),
  maxAgeMs = ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS
): Promise<number> {
  try {
    if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return 0;
    const cutoff = now - maxAgeMs;
    return await deleteAbandonedOrdinaryBikeTelemetry(new Date(cutoff).toISOString());
  } catch (error) {
    console.error("Error cleaning abandoned ordinary bike telemetry:", error);
    return 0;
  }
}

async function storeHrSample(sessionId: string, timestampSec: number, hr: number) {
  try {
    await addHrSampleIfAbsent(sessionId, timestampSec, hr);
  } catch (error) {
    console.error("Error storing HR sample:", error);
  }
}

async function getHrSamples(sessionId: string): Promise<HrSample[]> {
  try {
    return await getHrSampleRows(sessionId);
  } catch (error) {
    console.error("Error getting HR samples:", error);
    return [];
  }
}

async function storeWorkoutSummary(summary: WorkoutSummary): Promise<boolean> {
  try {
    await putWorkoutRow(summary);
    return true;
  } catch (error) {
    console.error("Error storing workout summary:", error);
    return false;
  }
}

async function clearHrSamples(sessionId: string) {
  try {
    return await deleteHrSampleRowsForSession(sessionId);
  } catch (error) {
    console.error("Error clearing HR samples:", error);
  }
}

/**
 * Reconstruct a persisted workout row for the application: versioned
 * sub-records are re-parsed and dropped when invalid or owned by another
 * session/athlete. Persisted rows themselves are never rewritten.
 */
function reconstructWorkoutRow(row: any): any {
  if (row?.summary?.workout_response !== undefined) {
    const parsed = parseWorkoutResponse(row.summary.workout_response);
    row.summary = { ...row.summary };
    if (
      parsed &&
      parsed.sessionId === row.session_id &&
      parsed.sessionId === row.summary.external_session_id &&
      parsed.athleteId === row.summary.athlete_id
    ) row.summary.workout_response = parsed;
    else delete row.summary.workout_response;
  }
  if (row?.summary?.shadow_prescription_evaluation !== undefined) {
    const parsedShadow = parsePersonalizedPrescriptionEvaluation(
      row.summary.shadow_prescription_evaluation
    );
    row.summary = { ...row.summary };
    if (
      parsedShadow &&
      parsedShadow.athleteId === row.summary.athlete_id &&
      parsedShadow.workoutSelector === row.summary.day
    ) {
      row.summary.shadow_prescription_evaluation = parsedShadow;
    } else {
      delete row.summary.shadow_prescription_evaluation;
    }
  }
  if (row?.summary?.execution_provenance !== undefined) {
    const parsedProvenance = parseWorkoutExecutionProvenance(row.summary.execution_provenance);
    row.summary = { ...row.summary };
    if (parsedProvenance && parsedProvenance.sessionId === row.session_id &&
        parsedProvenance.sessionId === row.summary.external_session_id) {
      row.summary.execution_provenance = parsedProvenance;
    } else {
      delete row.summary.execution_provenance;
    }
  }
  if (row?.summary?.shadow_prescription_characterization !== undefined) {
    const parsedCharacterization = row.summary.workout_response === undefined
      ? null
      : parsePersonalizedPrescriptionCharacterization(
          row.summary.shadow_prescription_characterization,
          row.summary.shadow_prescription_evaluation,
          {
            athleteId: row.summary.athlete_id,
            sessionId: row.summary.external_session_id,
            workoutSelector: row.summary.day,
            activity: row.summary.activity,
            workoutResponse: row.summary.workout_response,
          }
        );
    row.summary = { ...row.summary };
    if (parsedCharacterization) {
      row.summary.shadow_prescription_characterization = parsedCharacterization;
    } else {
      delete row.summary.shadow_prescription_characterization;
    }
  }
  return row;
}

async function getAllWorkoutSummaries(): Promise<Array<{ summary: WorkoutSummary }>> {
  try {
    const rows = await readWorkoutRowsNewestFirst();
    return rows.map(reconstructWorkoutRow);
  } catch (error) {
    console.error("Error getting all workout summaries:", error);
    return [];
  }
}

async function deleteWorkoutSummary(sessionId: string) {
  try {
    await flushOrdinaryBikeTelemetryWrites(sessionId);
    const database = await initDB();
    // One readwrite transaction across all three stores: a workout and its HR
    // samples and telemetry are deleted together or not at all.
    const tx = database.transaction(
      [STORE_WORKOUTS, STORE_HR_SAMPLES, STORE_ORDINARY_BIKE_TELEMETRY],
      "readwrite"
    );
    const completed = transactionComplete(tx);
    await untilTransactionComplete(
      Promise.all([
        deleteWorkoutRowInTransaction(tx, sessionId),
        deleteHrSampleRowsInTransaction(tx, sessionId),
        deleteOrdinaryBikeTelemetryRowsInTransaction(tx, sessionId),
      ]),
      completed
    );
    try {
      const history = await getAllWorkoutSummaries();
      rebuildStoredPassiveFitnessProjection(history.map((row) => row.summary));
    } catch (error) {
      console.error("Error rebuilding passive fitness projection after deletion:", error);
    }
    return true;
  } catch (error) {
    console.error("Error deleting workout summary:", error);
    return false;
  }
}

async function storeSisuSettings(host: string, port: number, protocol?: "https" | "http") {
  try {
    await putSisuSettingsRow({
      key: "config",
      host,
      port,
      protocol,
      last_connected: new Date().toISOString(),
      last_sync: null,
    } as SisuSettings);
    return true;
  } catch (error) {
    console.error("Error storing SISU settings:", error);
    return false;
  }
}

async function getSisuSettings(): Promise<SisuSettings | null> {
  try {
    return await getSisuSettingsRow();
  } catch (error) {
    console.error("Error getting SISU settings:", error);
    return null;
  }
}

async function clearSisuSettings() {
  try {
    await deleteSisuSettingsRow();
    return true;
  } catch (error) {
    console.error("Error clearing SISU settings:", error);
    return false;
  }
}

export function registerStorageGlobals() {
  (window as any).initDB = initDB;
  (window as any).storeHrSample = storeHrSample;
  (window as any).getHrSamples = getHrSamples;
  (window as any).storeWorkoutSummary = storeWorkoutSummary;
  (window as any).clearHrSamples = clearHrSamples;
  (window as any).storeOrdinaryBikeTelemetrySample = storeOrdinaryBikeTelemetrySample;
  (window as any).getOrdinaryBikeTelemetrySamples = getOrdinaryBikeTelemetrySamples;
  (window as any).clearOrdinaryBikeTelemetry = clearOrdinaryBikeTelemetry;
  (window as any).getAllWorkoutSummaries = getAllWorkoutSummaries;
  (window as any).deleteWorkoutSummary = deleteWorkoutSummary;
  (window as any).storeSisuSettings = storeSisuSettings;
  (window as any).getSisuSettings = getSisuSettings;
  (window as any).clearSisuSettings = clearSisuSettings;
}

/** Close the cached IDB handle and delete the app database (tests only). */
export const resetWorkoutStorageForTests = resetCurrentDatabaseForTests;

export {
  initDB,
  storeHrSample,
  getHrSamples,
  storeWorkoutSummary,
  clearHrSamples,
  storeOrdinaryBikeTelemetrySample,
  getOrdinaryBikeTelemetrySamples,
  clearOrdinaryBikeTelemetry,
  cleanupAbandonedOrdinaryBikeTelemetry,
  getAllWorkoutSummaries,
  deleteWorkoutSummary,
  storeSisuSettings,
  getSisuSettings,
  clearSisuSettings,
};
