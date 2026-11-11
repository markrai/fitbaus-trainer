import { recordActuationOutcome, recordActuationRequest, } from "./executionProvenance.js";
import { getSession } from "./sessionStore.js";
/**
 * Bike Bridge observer that appends each posted resistance command, with its
 * explicit origin, to the start-time provenance record of the workout session
 * whose guidance produced it, on the canonical active clock. Routing uses the
 * session identity carried with the command, never the mutable UI selected day
 * (the day dropdown can change while a session persists). It only records; it
 * never influences commands.
 */
export function createActuationProvenanceObserver(storage) {
    const store = (storage !== null && storage !== void 0 ? storage : localStorage);
    return {
        requested(request) {
            const workout = request.workout;
            if (!workout)
                return undefined;
            const session = getSession(workout.day, store);
            // The originating session ended or was replaced: its record is no longer active.
            if (session.sessionId !== workout.sessionId)
                return undefined;
            const commandId = recordActuationRequest(workout.day, session, request, store);
            return commandId === null ? undefined : { day: workout.day, sessionId: workout.sessionId, commandId };
        },
        resolved(token, outcome) {
            const value = token;
            if (!value)
                return;
            recordActuationOutcome(value.day, value.sessionId, value.commandId, outcome, store);
        },
    };
}
