/**
 * The single application connection to the current FitBaus Trainer IndexedDB
 * database, plus the request/transaction helpers shared by the store
 * repositories. No workout-domain policy lives here.
 *
 * Completion contract for repositories: create the transaction, attach
 * transactionComplete(tx) immediately, then issue requests, and resolve only
 * after the transaction completes (see untilTransactionComplete).
 */

import { CURRENT_DB_NAME, CURRENT_DB_VERSION, applyCurrentSchemaUpgrade } from "./currentSchema.js";

let db: IDBDatabase | null = null;
let opening: Promise<IDBDatabase> | null = null;
/** Bumped by the test reset so an open that was in flight cannot repopulate the cache. */
let generation = 0;

/**
 * The cached page-lifetime connection. Concurrent first callers share one
 * in-flight open; a failed open is not cached, so a later call retries. If
 * another context needs a version upgrade (or the browser closes the
 * connection), the connection is closed and dropped from the cache.
 */
export function openCurrentDatabase(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);
  if (opening) return opening;
  const openGeneration = generation;
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(CURRENT_DB_NAME, CURRENT_DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const connection = request.result;
      if (openGeneration !== generation) {
        connection.close();
        reject(new Error("IndexedDB open was superseded by a reset"));
        return;
      }
      const release = () => {
        if (db === connection) db = null;
      };
      connection.onversionchange = () => {
        connection.close();
        release();
      };
      connection.onclose = release;
      db = connection;
      resolve(connection);
    };
    request.onupgradeneeded = (event) => {
      applyCurrentSchemaUpgrade((event.target as IDBOpenDBRequest).result);
    };
  });
  opening = attempt;
  const settle = () => {
    if (opening === attempt) opening = null;
  };
  attempt.then(settle, settle);
  return attempt;
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Attach immediately after creating the transaction, before issuing requests. */
export function transactionComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // At this point tx.error is still null; the failing request carries the error.
    tx.onerror = (event) =>
      reject((event?.target as IDBRequest | null)?.error ?? tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

/**
 * Resolve with `work`'s result only once the transaction has also completed.
 * Either failing rejects; both promises are always observed.
 */
export async function untilTransactionComplete<T>(work: Promise<T>, completed: Promise<void>): Promise<T> {
  const [result] = await Promise.all([work, completed]);
  return result;
}

/**
 * Cursor-delete every row in `store` whose `session_id` index matches.
 * Resolves when the cursor is exhausted and rejects if the cursor request
 * fails; callers still await the transaction for commit.
 */
export function deleteBySessionIndex(store: IDBObjectStore, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = store.index("session_id").openCursor(IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/** Close the cached IDB handle, abandon any in-flight open, and delete the app database (tests only). */
export async function resetCurrentDatabaseForTests(): Promise<void> {
  generation += 1;
  opening = null;
  if (db) {
    db.close();
    db = null;
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(CURRENT_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
