/**
 * Raw persistence for the `ordinary_bike_telemetry` store (key
 * `[session_id, active_sec]`; indexes `session_id`, `observed_at`,
 * `session_source_id`).
 *
 * The write path keeps its de-duplication rule inside the readwrite
 * transaction so the read-compare-write stays atomic: one row per active
 * second, a stored second is replaced only by a strictly fresher sample, and
 * one source sample may not occupy two seconds. That rule needs the prior
 * row's parsed availability, so this module uses the sample parser.
 */

import type { OrdinaryBikeTelemetrySample } from "../../types.js";
import { parseOrdinaryBikeTelemetrySample } from "../../ordinaryWorkoutTelemetry.js";
import type { CurrentStoreName } from "../currentSchema.js";
import {
  deleteBySessionIndex,
  openCurrentDatabase,
  requestResult,
  transactionComplete,
  untilTransactionComplete,
} from "../indexedDb.js";

export const STORE_ORDINARY_BIKE_TELEMETRY = "ordinary_bike_telemetry" satisfies CurrentStoreName;

/** Persisted row shape. */
export interface OrdinaryBikeTelemetryRow {
  session_id: string;
  athlete_id: string;
  active_sec: number;
  observed_at: string;
  source_sample_id?: string;
  sample: OrdinaryBikeTelemetrySample;
}

function telemetryRow(sample: OrdinaryBikeTelemetrySample): OrdinaryBikeTelemetryRow {
  return {
    session_id: sample.sessionId,
    athlete_id: sample.athleteId,
    active_sec: sample.activeSec,
    observed_at: sample.observedAt,
    ...(sample.sourceSampleId ? { source_sample_id: sample.sourceSampleId } : {}),
    sample,
  };
}

function availabilityRank(sample: OrdinaryBikeTelemetrySample): number {
  return sample.availability === "fresh" ? 2 : sample.availability === "stale" ? 1 : 0;
}

async function sourceSampleBelongsToAnotherSecond(
  store: IDBObjectStore,
  sample: OrdinaryBikeTelemetrySample
): Promise<boolean> {
  if (!sample.sourceSampleId) return false;
  const sameSourceRows = await requestResult(
    store.index("session_source_id").getAll([sample.sessionId, sample.sourceSampleId])
  ) as OrdinaryBikeTelemetryRow[];
  return sameSourceRows.some((row) => row.active_sec !== sample.activeSec);
}

/** Write an already-parsed sample; resolves after the transaction completes, rejects on any failure. */
export async function writeOrdinaryBikeTelemetrySample(
  sample: OrdinaryBikeTelemetrySample
): Promise<"stored" | "duplicate"> {
  const database = await openCurrentDatabase();
  const tx = database.transaction([STORE_ORDINARY_BIKE_TELEMETRY], "readwrite");
  const completed = transactionComplete(tx);
  const store = tx.objectStore(STORE_ORDINARY_BIKE_TELEMETRY);
  let outcome: "stored" | "duplicate" = "stored";
  try {
    const existing = await requestResult(store.get([sample.sessionId, sample.activeSec])) as OrdinaryBikeTelemetryRow | undefined;
    if (existing) {
      const prior = parseOrdinaryBikeTelemetrySample(existing.sample);
      if (prior && availabilityRank(sample) > availabilityRank(prior)) {
        if (await sourceSampleBelongsToAnotherSecond(store, sample)) outcome = "duplicate";
        else await requestResult(store.put(telemetryRow(sample)));
      } else {
        outcome = "duplicate";
      }
    } else if (sample.sourceSampleId) {
      if (await sourceSampleBelongsToAnotherSecond(store, sample)) outcome = "duplicate";
      else await requestResult(store.add(telemetryRow(sample)));
    } else {
      await requestResult(store.add(telemetryRow(sample)));
    }
  } catch (error) {
    // Never let a partial read-compare-write commit, and observe the
    // transaction's own rejection so it is not left unhandled.
    try {
      tx.abort();
    } catch {
      // Already aborted or finished.
    }
    await completed.catch(() => undefined);
    throw error;
  }
  await completed;
  return outcome;
}

/** Persisted rows for one session via the `session_id` index. */
export async function getOrdinaryBikeTelemetryRows(sessionId: string): Promise<OrdinaryBikeTelemetryRow[]> {
  const database = await openCurrentDatabase();
  const tx = database.transaction([STORE_ORDINARY_BIKE_TELEMETRY], "readonly");
  const completed = transactionComplete(tx);
  return untilTransactionComplete(
    requestResult(tx.objectStore(STORE_ORDINARY_BIKE_TELEMETRY).index("session_id").getAll(sessionId)),
    completed
  ) as Promise<OrdinaryBikeTelemetryRow[]>;
}

/** Delete one session's rows; resolves when the transaction completes. */
export async function deleteOrdinaryBikeTelemetryRowsForSession(sessionId: string): Promise<void> {
  const database = await openCurrentDatabase();
  const tx = database.transaction([STORE_ORDINARY_BIKE_TELEMETRY], "readwrite");
  const completed = transactionComplete(tx);
  await untilTransactionComplete(
    deleteBySessionIndex(tx.objectStore(STORE_ORDINARY_BIKE_TELEMETRY), sessionId),
    completed
  );
}

/** Delete one session's rows inside a caller-owned transaction that includes this store; the caller awaits commit. */
export function deleteOrdinaryBikeTelemetryRowsInTransaction(tx: IDBTransaction, sessionId: string): Promise<void> {
  return deleteBySessionIndex(tx.objectStore(STORE_ORDINARY_BIKE_TELEMETRY), sessionId);
}

/** Session IDs having any row observed strictly before `cutoffIso` (via the `observed_at` index). */
export async function findTelemetrySessionIdsObservedBefore(cutoffIso: string): Promise<Set<string>> {
  const database = await openCurrentDatabase();
  const telemetryTx = database.transaction([STORE_ORDINARY_BIKE_TELEMETRY], "readonly");
  const completed = transactionComplete(telemetryTx);
  return untilTransactionComplete(findTelemetrySessionIdsObservedBeforeInTransaction(telemetryTx, cutoffIso), completed);
}

/**
 * Same scan inside a caller-owned transaction that includes this store, in
 * `observed_at` order; the caller awaits commit.
 */
export function findTelemetrySessionIdsObservedBeforeInTransaction(
  tx: IDBTransaction,
  cutoffIso: string
): Promise<Set<string>> {
  const store = tx.objectStore(STORE_ORDINARY_BIKE_TELEMETRY);
  return new Promise<Set<string>>((resolve, reject) => {
    const sessionIds = new Set<string>();
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
