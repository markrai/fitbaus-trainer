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
import { parseFreestyleRideResponse } from "./contracts/freestyleRideResponse.js";
import { parseFreestyleStableObservation } from "./contracts/freestyleStableObservation.js";
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
  getWorkoutRowInTransaction,
  getWorkoutRowsBySessionId,
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

export interface OrdinaryTelemetryFlushResult {
  ok: boolean;
  failedCount: number;
  retriedCount: number;
  unresolvedFailures: number;
  /** Irrecoverable parse/admission rejections retained across flushes. */
  rejectedCount: number;
  /** Storage failures still present after this flush's retry pass. */
  retryableFailures: number;
}

const initDB = openCurrentDatabase;

let ordinaryTelemetryWriteFailureInjectorForTests: (() => boolean) | null = null;
let ordinaryTelemetryWriteGateForTests: (() => Promise<void>) | null = null;

function setOrdinaryTelemetryWriteFailureInjectorForTests(
  injector: (() => boolean) | null
): void {
  ordinaryTelemetryWriteFailureInjectorForTests = injector;
}

function setOrdinaryTelemetryWriteGateForTests(gate: (() => Promise<void>) | null): void {
  ordinaryTelemetryWriteGateForTests = gate;
}

async function storeOrdinaryBikeTelemetrySample(
  value: OrdinaryBikeTelemetrySample
): Promise<OrdinaryTelemetryWriteResult> {
  const sample = parseOrdinaryBikeTelemetrySample(value);
  if (!sample) return "rejected";
  try {
    if (ordinaryTelemetryWriteFailureInjectorForTests?.()) return "failed";
    if (ordinaryTelemetryWriteGateForTests) {
      await ordinaryTelemetryWriteGateForTests();
    }
    return await writeOrdinaryBikeTelemetrySample(sample);
  } catch (error) {
    console.error("Error storing ordinary bike telemetry:", error);
    return "failed";
  }
}

interface PendingOrdinaryWriteChain {
  promise: Promise<void>;
  failedSamples: OrdinaryBikeTelemetrySample[];
  failedCount: number;
  rejectedCount: number;
  flushing: boolean;
}

const pendingOrdinaryWrites = new Map<string, PendingOrdinaryWriteChain>();
const sealedOrdinaryTelemetrySessions = new Set<string>();
const ordinaryFlushes = new Map<string, Promise<OrdinaryTelemetryFlushResult>>();

/** Serialize per-session writes so finalization can reliably flush the last observed second. */
export function queueOrdinaryBikeTelemetrySample(sample: OrdinaryBikeTelemetrySample): void {
  if (sealedOrdinaryTelemetrySessions.has(sample.sessionId)) {
    return;
  }
  const prior = pendingOrdinaryWrites.get(sample.sessionId);
  const chain: PendingOrdinaryWriteChain = prior ?? {
    promise: Promise.resolve(),
    failedSamples: [],
    failedCount: 0,
    rejectedCount: 0,
    flushing: false,
  };
  const nextPromise = chain.promise
    .catch(() => undefined)
    .then(async () => {
      const result = await storeOrdinaryBikeTelemetrySample(sample);
      if (result === "failed") {
        chain.failedCount += 1;
        chain.failedSamples.push(sample);
      } else if (result === "rejected") {
        chain.rejectedCount += 1;
      }
    });
  chain.promise = nextPromise;
  pendingOrdinaryWrites.set(sample.sessionId, chain);
  void nextPromise.finally(() => {
    const current = pendingOrdinaryWrites.get(sample.sessionId);
    if (
      current &&
      current.promise === nextPromise &&
      current.failedSamples.length === 0 &&
      current.rejectedCount === 0 &&
      !current.flushing
    ) {
      pendingOrdinaryWrites.delete(sample.sessionId);
    }
  });
}

export function flushOrdinaryBikeTelemetryWrites(sessionId: string): Promise<OrdinaryTelemetryFlushResult> {
  if (sealedOrdinaryTelemetrySessions.has(sessionId)) return Promise.resolve({ ok: false, failedCount: 0, retriedCount: 0, unresolvedFailures: 1, rejectedCount: 0, retryableFailures: 1 });
  return joinOrdinaryTelemetryDrain(sessionId);
}
function joinOrdinaryTelemetryDrain(sessionId: string): Promise<OrdinaryTelemetryFlushResult> {
  const existing = ordinaryFlushes.get(sessionId);
  if (existing)
    return existing;
  const chain = pendingOrdinaryWrites.get(sessionId);
  if (!chain) return Promise.resolve({ ok: true, failedCount: 0, retriedCount: 0, unresolvedFailures: 0, rejectedCount: 0, retryableFailures: 0 });
  const task = drainOrdinaryBikeTelemetryWrites(sessionId, chain);
  ordinaryFlushes.set(sessionId, task);
  return task;
}
async function drainOrdinaryBikeTelemetryWrites(sessionId: string, chain: PendingOrdinaryWriteChain): Promise<OrdinaryTelemetryFlushResult> {
  let failedCount = 0;
  let retriedCount = 0;
  chain.flushing = true;
  try {
    for (;;) {
      const task = chain.promise.then(async () => {
        failedCount += chain.failedCount;
        const retryQueue = chain.failedSamples.splice(0);
        chain.failedCount = 0;
        retriedCount += retryQueue.length;
        for (const sample of retryQueue) {
          const result = await storeOrdinaryBikeTelemetrySample(sample);
          if (result === "failed") {
            chain.failedCount += 1;
            chain.failedSamples.push(sample);
          }
          else if (result === "rejected") {
            chain.rejectedCount += 1;
          }
        }
      });
      chain.promise = task;
      await task;
      if (chain.promise !== task)
        continue;
      const rejectedCount = chain.rejectedCount;
      const retryableFailures = chain.failedSamples.length;
      if (retryableFailures === 0 && rejectedCount === 0 && pendingOrdinaryWrites.get(sessionId) === chain)
        pendingOrdinaryWrites.delete(sessionId);
      return {
        ok: retryableFailures === 0 && rejectedCount === 0,
        failedCount,
        retriedCount,
        unresolvedFailures: retryableFailures + rejectedCount,
        rejectedCount,
        retryableFailures,
      };
    }
  }
  finally {
    chain.flushing = false;
    ordinaryFlushes.delete(sessionId);
  }
}

/** Drop pending queue state after incomplete Freestyle evidence has been explicitly accepted. */
function clearOrdinaryBikeTelemetryQueue(sessionId: string): void {
  if (ordinaryFlushes.has(sessionId)) return;
  pendingOrdinaryWrites.delete(sessionId);
}

function peekOrdinaryBikeTelemetryWriteFailures(sessionId: string): number {
  return pendingOrdinaryWrites.get(sessionId)?.failedCount ?? 0;
}

export async function getOrdinaryBikeTelemetrySamplesStrict(sessionId: string): Promise<OrdinaryBikeTelemetrySample[]> {
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
}

async function getOrdinaryBikeTelemetrySamples(sessionId: string): Promise<OrdinaryBikeTelemetrySample[]> {
  try {
    return await getOrdinaryBikeTelemetrySamplesStrict(sessionId);
  } catch (error) {
    console.error("Error getting ordinary bike telemetry:", error);
    return [];
  }
}

async function withOrdinaryTelemetryDeletion(sessionId: string, remove: (flush: OrdinaryTelemetryFlushResult) => Promise<void>): Promise<void> {
  if (sealedOrdinaryTelemetrySessions.has(sessionId)) throw new Error("Bike evidence deletion already in progress");
  sealedOrdinaryTelemetrySessions.add(sessionId);
  try {
    const flush = await joinOrdinaryTelemetryDrain(sessionId);
    await remove(flush);
    pendingOrdinaryWrites.delete(sessionId);
  } finally {
    sealedOrdinaryTelemetrySessions.delete(sessionId);
  }
}

async function clearOrdinaryBikeTelemetry(sessionId: string): Promise<void> {
  try {
    await withOrdinaryTelemetryDeletion(sessionId, () => deleteOrdinaryBikeTelemetryRowsForSession(sessionId));
  } catch (error) {
    console.error("Error clearing ordinary bike telemetry:", error);
  }
}

let freestyleEvidenceDeleteFailureInjectorForTests: (() => boolean) | null = null;

function setFreestyleEvidenceDeleteFailureInjectorForTests(
  injector: (() => boolean) | null
): void {
  freestyleEvidenceDeleteFailureInjectorForTests = injector;
}

function setOrdinaryTelemetryDeleteFailureInjectorForTests(
  injector: (() => boolean) | null
): void {
  freestyleEvidenceDeleteFailureInjectorForTests = injector;
}

/** Throws on failure so Freestyle discard can fail closed before clearing session markers. */
export async function deleteOrdinaryBikeTelemetryForSessionStrict(
  sessionId: string
): Promise<void> {
  await withOrdinaryTelemetryDeletion(sessionId, () => deleteOrdinaryBikeTelemetryRowsForSession(sessionId));
}

export async function deleteHrSamplesForSessionStrict(sessionId: string): Promise<void> {
  await withWorkoutHrDeletion(sessionId, () => deleteHrSampleRowsForSession(sessionId));
}

/**
 * Atomically delete Freestyle HR + ordinary telemetry for one session.
 * Queued writes are flushed and sealed first so they cannot recreate rows.
 */
async function deleteFreestyleSessionEvidenceAtomic(sessionId: string): Promise<void> {
  await deleteUnpersistedWorkoutEvidenceAtomic(sessionId, false);
}

export async function deleteUnpersistedWorkoutEvidenceAtomic(sessionId: string, allowRetryableFailures: boolean): Promise<void> {
  await withWorkoutHrDeletion(sessionId, () => withOrdinaryTelemetryDeletion(sessionId, async (flush) => {
    if (!allowRetryableFailures && !flush.ok && flush.retryableFailures > 0) {
      throw new Error("cannot discard while telemetry flush has retryable failures");
    }

    const database = await openCurrentDatabase();
    const tx = database.transaction(
      [STORE_WORKOUTS, STORE_HR_SAMPLES, STORE_ORDINARY_BIKE_TELEMETRY],
      "readwrite"
    );
    const completed = transactionComplete(tx);
    const work = (async () => {
      const workout = await getWorkoutRowInTransaction(tx, sessionId);
      if (workout !== undefined) {
        throw new Error("cannot delete evidence owned by a persisted workout");
      }
      await deleteOrdinaryBikeTelemetryRowsInTransaction(tx, sessionId);
      if (freestyleEvidenceDeleteFailureInjectorForTests?.()) {
        try {
          tx.abort();
        } catch {
          // Already aborting or finished.
        }
        throw new Error("injected freestyle evidence delete failure");
      }
      await deleteHrSampleRowsInTransaction(tx, sessionId);
    })();
    await untilTransactionComplete(work, completed);
  }));
}

/** Delete old raw traces only when no immutable workout summary owns the session. */
async function cleanupAbandonedOrdinaryBikeTelemetry(
  now = Date.now(),
  maxAgeMs = ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS,
  protectedSessionIds: readonly string[] = []
): Promise<number> {
  try {
    if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return 0;
    const cutoff = now - maxAgeMs;
    return await deleteAbandonedOrdinaryBikeTelemetry(
      new Date(cutoff).toISOString(),
      protectedSessionIds
    );
  } catch (error) {
    console.error("Error cleaning abandoned ordinary bike telemetry:", error);
    return 0;
  }
}

let hrWriteGateForTests: (() => Promise<void>) | null = null;
let hrReadFailureForTests: (() => boolean) | null = null;
export function setWorkoutHrPersistenceHooksForTests(writeGate: (() => Promise<void>) | null, readFailure: (() => boolean) | null = null): void {
  hrWriteGateForTests = writeGate;
  hrReadFailureForTests = readFailure;
}
interface PendingWorkoutHrWrites {
 tail: Promise<void>;
 failed: Map<number, HrSample>;
}
const pendingWorkoutHrWrites = new Map<string, PendingWorkoutHrWrites>();
const sealedWorkoutHrSessions = new Set<string>();
const workoutHrFlushes = new Map<string, Promise<boolean>>();
async function writeWorkoutHrSample(sample: HrSample): Promise<void> {
  if (hrWriteGateForTests)
    await hrWriteGateForTests();
  await addHrSampleIfAbsent(sample.session_id, sample.timestamp_sec, sample.hr);
}
async function attemptWorkoutHrWrite(chain: PendingWorkoutHrWrites, sample: HrSample): Promise<void> {
  try {
    await writeWorkoutHrSample(sample);
    chain.failed.delete(sample.timestamp_sec);
  }
  catch (error) {
    chain.failed.set(sample.timestamp_sec, sample);
    console.error("Error storing workout HR evidence:", error);
  }
}
export function queueWorkoutHrSample(sessionId: string, elapsedSec: number, bpm: number): boolean {
  if (sealedWorkoutHrSessions.has(sessionId))
    return false;
  let chain = pendingWorkoutHrWrites.get(sessionId);
  if (!chain) {
    chain = { tail: Promise.resolve(), failed: new Map() };
    pendingWorkoutHrWrites.set(sessionId, chain);
  }
  const sample = { session_id: sessionId, timestamp_sec: elapsedSec, hr: bpm };
  const task = chain.tail.then(async () => {
    await attemptWorkoutHrWrite(chain, chain.failed.get(elapsedSec) || sample);
  });
  chain.tail = task;
  void task.then(() => {
    if (pendingWorkoutHrWrites.get(sessionId) === chain && chain.tail === task && chain.failed.size === 0 && !workoutHrFlushes.has(sessionId))
      pendingWorkoutHrWrites.delete(sessionId);
  });
  return true;
}
export function flushWorkoutHrWrites(sessionId: string): Promise<boolean> {
  if (sealedWorkoutHrSessions.has(sessionId))
    return Promise.resolve(false);
  const existing = workoutHrFlushes.get(sessionId);
  if (existing)
    return existing;
  const chain = pendingWorkoutHrWrites.get(sessionId);
  if (!chain) return Promise.resolve(true);
  const task = drainWorkoutHrWrites(sessionId, chain);
  workoutHrFlushes.set(sessionId, task);
  return task;
}
async function drainWorkoutHrWrites(sessionId: string, chain: PendingWorkoutHrWrites): Promise<boolean> {
  try {
    for (;;) {
      const task = chain.tail.then(async () => {
        for (const sample of Array.from(chain.failed.values())) {
          await attemptWorkoutHrWrite(chain, sample);
        }
      });
      chain.tail = task;
      await task;
      if (chain.tail !== task)
        continue;
      const ok = chain.failed.size === 0;
      if (ok && pendingWorkoutHrWrites.get(sessionId) === chain)
        pendingWorkoutHrWrites.delete(sessionId);
      return ok;
    }
  } finally {
    workoutHrFlushes.delete(sessionId);
  }
}
export async function getHrSamplesStrict(sessionId: string): Promise<HrSample[]> {
  if (hrReadFailureForTests && hrReadFailureForTests())
    throw new Error("Workout HR evidence read failed");
  return getHrSampleRows(sessionId);
}
export async function readCanonicalWorkoutHrSamples(sessionId: string): Promise<HrSample[]> {
  if (!(await flushWorkoutHrWrites(sessionId)))
    throw new Error("Workout HR evidence writes remain unconfirmed");
  return getHrSamplesStrict(sessionId);
}
async function withWorkoutHrDeletion(sessionId: string, remove: () => Promise<void>): Promise<void> {
  if (sealedWorkoutHrSessions.has(sessionId)) throw new Error("HR evidence deletion already in progress");
  sealedWorkoutHrSessions.add(sessionId);
  try {
    const draining = workoutHrFlushes.get(sessionId);
    if (draining) await draining;
    const chain = pendingWorkoutHrWrites.get(sessionId);
    if (chain)
      await chain.tail;
    await remove();
    pendingWorkoutHrWrites.delete(sessionId);
  }
  finally {
    sealedWorkoutHrSessions.delete(sessionId);
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

export async function getWorkoutSummaryBySessionIdStrict(sessionId: string): Promise<WorkoutSummary | null> {
  const [entry] = await getWorkoutRowsBySessionId([sessionId]);
  if (!entry || entry.row === undefined) return null;
  const row = entry.row as { summary?: WorkoutSummary };
  if (!row || !row.summary || row.summary.external_session_id !== sessionId) throw new Error("Invalid saved workout identity");
  return reconstructWorkoutRow({ ...row, session_id: sessionId }).summary;
}

async function getWorkoutSummaryBySessionId(sessionId: string): Promise<WorkoutSummary | null> {
  try {
    return await getWorkoutSummaryBySessionIdStrict(sessionId);
  } catch (error) {
    console.error("Error reading workout summary by session:", error);
    return null;
  }
}

async function clearHrSamples(sessionId: string) {
  try {
    return await deleteHrSamplesForSessionStrict(sessionId);
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
  if (row?.summary?.freestyle_ride_response !== undefined) {
    const parsedFreestyle = parseFreestyleRideResponse(row.summary.freestyle_ride_response);
    row.summary = { ...row.summary };
    if (
      parsedFreestyle &&
      parsedFreestyle.sessionId === row.session_id &&
      parsedFreestyle.sessionId === row.summary.external_session_id &&
      parsedFreestyle.athleteId === row.summary.athlete_id
    ) {
      row.summary.freestyle_ride_response = parsedFreestyle;
    } else {
      delete row.summary.freestyle_ride_response;
    }
  }
  if (row?.summary?.freestyle_stable_observation !== undefined) {
    const parsedStable = parseFreestyleStableObservation(row.summary.freestyle_stable_observation);
    row.summary = { ...row.summary };
    if (
      parsedStable &&
      parsedStable.sessionId === row.session_id &&
      parsedStable.sessionId === row.summary.external_session_id &&
      parsedStable.athleteId === row.summary.athlete_id
    ) {
      row.summary.freestyle_stable_observation = parsedStable;
    } else {
      delete row.summary.freestyle_stable_observation;
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
    await withWorkoutHrDeletion(sessionId, () => withOrdinaryTelemetryDeletion(sessionId, async () => {
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
    }));
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
export async function resetWorkoutStorageForTests(): Promise<void> {
  await Promise.all(Array.from(pendingWorkoutHrWrites.values(), chain => chain.tail));
  pendingWorkoutHrWrites.clear();
  sealedWorkoutHrSessions.clear();
  hrWriteGateForTests = null;
  hrReadFailureForTests = null;
  await resetCurrentDatabaseForTests();
}

export {
  initDB,
  storeHrSample,
  getHrSamples,
  storeWorkoutSummary,
  getWorkoutSummaryBySessionId,
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
  peekOrdinaryBikeTelemetryWriteFailures,
  setOrdinaryTelemetryWriteFailureInjectorForTests,
  setOrdinaryTelemetryWriteGateForTests,
  setOrdinaryTelemetryDeleteFailureInjectorForTests,
  setFreestyleEvidenceDeleteFailureInjectorForTests,
  deleteFreestyleSessionEvidenceAtomic,
  clearOrdinaryBikeTelemetryQueue,
};
