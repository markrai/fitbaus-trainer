/**
 * Raw persistence for the `workouts` store (key `session_id`; indexes
 * `startedAt`, `day`). Rows are returned exactly as persisted; turning them
 * into application summaries is workoutStorage's job.
 */
import { openCurrentDatabase, requestResult, transactionComplete, untilTransactionComplete } from "../indexedDb.js";
export const STORE_WORKOUTS = "workouts";
/** Upsert the workout row for a summary; resolves when the readwrite transaction completes. */
export async function putWorkoutRow(summary) {
    const database = await openCurrentDatabase();
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
}
/** All persisted workout rows, newest `startedAt` first. */
export async function readWorkoutRowsNewestFirst() {
    const database = await openCurrentDatabase();
    const tx = database.transaction([STORE_WORKOUTS], "readonly");
    const completed = transactionComplete(tx);
    const store = tx.objectStore(STORE_WORKOUTS);
    const index = store.index("startedAt");
    return untilTransactionComplete(new Promise((resolve, reject) => {
        const rows = [];
        const request = index.openCursor(null, "prev");
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                rows.push(cursor.value);
                cursor.continue();
            }
            else {
                resolve(rows);
            }
        };
        request.onerror = () => reject(request.error);
    }), completed);
}
/** Look up workout rows for several sessions in one readonly transaction (`row` is undefined when absent). */
export async function getWorkoutRowsBySessionId(sessionIds) {
    const database = await openCurrentDatabase();
    const workoutTx = database.transaction([STORE_WORKOUTS], "readonly");
    const completed = transactionComplete(workoutTx);
    const workoutStore = workoutTx.objectStore(STORE_WORKOUTS);
    return untilTransactionComplete(Promise.all(sessionIds.map(async (sessionId) => ({
        sessionId,
        row: await requestResult(workoutStore.get(sessionId)),
    }))), completed);
}
/** The workout row for one session inside a caller-owned transaction that includes `workouts` (undefined when absent). */
export function getWorkoutRowInTransaction(tx, sessionId) {
    return requestResult(tx.objectStore(STORE_WORKOUTS).get(sessionId));
}
/** Delete a workout row inside a caller-owned transaction that includes `workouts`; the caller awaits commit. */
export async function deleteWorkoutRowInTransaction(tx, sessionId) {
    await requestResult(tx.objectStore(STORE_WORKOUTS).delete(sessionId));
}
