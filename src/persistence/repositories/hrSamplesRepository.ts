/**
 * Raw persistence for the `hr_samples` store (key `[session_id, timestamp_sec]`;
 * index `session_id`). Persistence only: no physiological interpretation.
 */

import type { HrSample } from "../../types.js";
import type { CurrentStoreName } from "../currentSchema.js";
import {
  deleteBySessionIndex,
  openCurrentDatabase,
  requestResult,
  transactionComplete,
  untilTransactionComplete,
} from "../indexedDb.js";

export const STORE_HR_SAMPLES = "hr_samples" satisfies CurrentStoreName;

/**
 * Add the row unless the key already exists. A ConstraintError means another
 * writer stored this [session_id, timestamp_sec] first: first write wins, so
 * it is handled here and neither aborts the transaction nor reaches its error
 * handler.
 */
function addUnlessAnotherWriterWon(store: IDBObjectStore, row: HrSample): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = store.add(row);
    request.onsuccess = () => resolve();
    request.onerror = (event) => {
      if (request.error?.name === "ConstraintError") {
        event.preventDefault();
        event.stopPropagation();
        resolve();
      } else {
        reject(request.error);
      }
    };
  });
}

/**
 * Add a sample unless one already exists for the same session second (first
 * write wins). Resolves once the readwrite transaction has committed.
 */
export async function addHrSampleIfAbsent(sessionId: string, timestampSec: number, hr: number): Promise<void> {
  const database = await openCurrentDatabase();
  const tx = database.transaction([STORE_HR_SAMPLES], "readwrite");
  const completed = transactionComplete(tx);
  const store = tx.objectStore(STORE_HR_SAMPLES);
  const key: [string, number] = [sessionId, timestampSec];
  const work = (async () => {
    if (await requestResult(store.get(key))) return;
    await addUnlessAnotherWriterWon(store, { session_id: sessionId, timestamp_sec: timestampSec, hr });
  })();
  await untilTransactionComplete(work, completed);
}

/** Persisted rows for one session via the `session_id` index (primary-key order). */
export async function getHrSampleRows(sessionId: string): Promise<HrSample[]> {
  const database = await openCurrentDatabase();
  const tx = database.transaction([STORE_HR_SAMPLES], "readonly");
  const completed = transactionComplete(tx);
  const store = tx.objectStore(STORE_HR_SAMPLES);
  const index = store.index("session_id");
  return untilTransactionComplete(new Promise<HrSample[]>((resolve, reject) => {
    const request = index.getAll(sessionId);
    request.onsuccess = () => resolve(request.result as HrSample[] || []);
    request.onerror = () => reject(request.error);
  }), completed);
}

/** Delete one session's rows; resolves once the readwrite transaction has committed. */
export async function deleteHrSampleRowsForSession(sessionId: string): Promise<void> {
  const database = await openCurrentDatabase();
  const tx = database.transaction([STORE_HR_SAMPLES], "readwrite");
  const completed = transactionComplete(tx);
  await untilTransactionComplete(deleteBySessionIndex(tx.objectStore(STORE_HR_SAMPLES), sessionId), completed);
}

/** Delete one session's rows inside a caller-owned transaction that includes `hr_samples`; the caller awaits commit. */
export function deleteHrSampleRowsInTransaction(tx: IDBTransaction, sessionId: string): Promise<void> {
  return deleteBySessionIndex(tx.objectStore(STORE_HR_SAMPLES), sessionId);
}
