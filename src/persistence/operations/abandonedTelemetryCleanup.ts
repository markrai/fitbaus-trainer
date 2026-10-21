/**
 * Cross-store persistence operation: delete ordinary bike telemetry for
 * sessions that have an old row but no workout.
 *
 * Candidate discovery, the ownership check, and deletion all happen in ONE
 * readwrite transaction over `workouts` + `ordinary_bike_telemetry`, so the
 * decision "old telemetry and no workout" is atomic with the delete. Any
 * transaction touching either store is ordered entirely before or after it.
 *
 * Policy (unchanged): a session is a candidate if ANY row has
 * observed_at < cutoff; an owned session keeps all its rows; an unowned
 * candidate loses ALL its rows (including recent ones). Resolves with the
 * number of sessions deleted, after commit. Any failure aborts the whole
 * transaction, so nothing is partially deleted.
 */

import { openCurrentDatabase, transactionComplete, untilTransactionComplete } from "../indexedDb.js";
import {
  STORE_ORDINARY_BIKE_TELEMETRY,
  deleteOrdinaryBikeTelemetryRowsInTransaction,
  findTelemetrySessionIdsObservedBeforeInTransaction,
} from "../repositories/ordinaryBikeTelemetryRepository.js";
import { STORE_WORKOUTS, getWorkoutRowInTransaction } from "../repositories/workoutsRepository.js";

export async function deleteAbandonedOrdinaryBikeTelemetry(cutoffIso: string): Promise<number> {
  const database = await openCurrentDatabase();
  const tx = database.transaction([STORE_WORKOUTS, STORE_ORDINARY_BIKE_TELEMETRY], "readwrite");
  const completed = transactionComplete(tx);
  const work = (async () => {
    try {
      const candidates = await findTelemetrySessionIdsObservedBeforeInTransaction(tx, cutoffIso);
      let deleted = 0;
      for (const sessionId of candidates) {
        if ((await getWorkoutRowInTransaction(tx, sessionId)) !== undefined) continue;
        await deleteOrdinaryBikeTelemetryRowsInTransaction(tx, sessionId);
        deleted += 1;
      }
      return deleted;
    } catch (error) {
      // Abort so no earlier deletion in this transaction can commit.
      try {
        tx.abort();
      } catch {
        // Already aborted or finished.
      }
      throw error;
    }
  })();
  return untilTransactionComplete(work, completed);
}
