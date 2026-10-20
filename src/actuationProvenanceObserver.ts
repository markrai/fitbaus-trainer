import type {
  BikeBridgeActuationObserver,
  BikeBridgeActuationOutcome,
  BikeBridgeActuationRequest,
} from "./platform/bikeBridgeRuntime.js";
import {
  recordActuationOutcome,
  recordActuationRequest,
  type ExecutionProvenanceStorage,
} from "./executionProvenance.js";
import { getSession, type SessionStorage } from "./sessionStore.js";

interface ActuationToken {
  day: string;
  sessionId: string;
  commandId: number;
}

/**
 * Bike Bridge observer that appends each posted resistance command, with its
 * explicit origin, to the start-time provenance record of the workout session
 * whose guidance produced it, on the canonical active clock. Routing uses the
 * session identity carried with the command, never the mutable UI selected day
 * (the day dropdown can change while a session persists). It only records; it
 * never influences commands.
 */
export function createActuationProvenanceObserver(
  storage?: SessionStorage & ExecutionProvenanceStorage
): BikeBridgeActuationObserver {
  const store = (storage ?? localStorage) as SessionStorage & ExecutionProvenanceStorage;
  return {
    requested(request: BikeBridgeActuationRequest): ActuationToken | undefined {
      const workout = request.workout;
      if (!workout) return undefined;
      const session = getSession(workout.day, store);
      // The originating session ended or was replaced: its record is no longer active.
      if (session.sessionId !== workout.sessionId) return undefined;
      const commandId = recordActuationRequest(workout.day, session, request, store);
      return commandId === null ? undefined : { day: workout.day, sessionId: workout.sessionId, commandId };
    },
    resolved(token: unknown, outcome: BikeBridgeActuationOutcome): void {
      const value = token as ActuationToken | undefined;
      if (!value) return;
      recordActuationOutcome(value.day, value.sessionId, value.commandId, outcome, store);
    },
  };
}
