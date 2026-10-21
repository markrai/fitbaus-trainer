/**
 * Raw persistence for the `sisu_settings` store (key `key`; single row "config").
 * Writes and deletes resolve once their readwrite transaction has committed.
 */
import { openCurrentDatabase, requestResult, transactionComplete, untilTransactionComplete } from "../indexedDb.js";
export const STORE_SISU_SETTINGS = "sisu_settings";
export const SISU_SETTINGS_KEY = "config";
export async function putSisuSettingsRow(row) {
    const database = await openCurrentDatabase();
    const tx = database.transaction([STORE_SISU_SETTINGS], "readwrite");
    const completed = transactionComplete(tx);
    await untilTransactionComplete(requestResult(tx.objectStore(STORE_SISU_SETTINGS).put(row)), completed);
}
/** The "config" row, or null when absent. */
export async function getSisuSettingsRow() {
    const database = await openCurrentDatabase();
    const tx = database.transaction([STORE_SISU_SETTINGS], "readonly");
    const completed = transactionComplete(tx);
    const store = tx.objectStore(STORE_SISU_SETTINGS);
    return untilTransactionComplete(new Promise((resolve, reject) => {
        const request = store.get(SISU_SETTINGS_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    }), completed);
}
export async function deleteSisuSettingsRow() {
    const database = await openCurrentDatabase();
    const tx = database.transaction([STORE_SISU_SETTINGS], "readwrite");
    const completed = transactionComplete(tx);
    await untilTransactionComplete(requestResult(tx.objectStore(STORE_SISU_SETTINGS).delete(SISU_SETTINGS_KEY)), completed);
}
