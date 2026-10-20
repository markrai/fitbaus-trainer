import { getSession, clearSession, markSummaryEmitted } from "./sessionStore.js";
import { clearBikeTelemetrySamples } from "./bikeTelemetryTrace.js";
import { clearOrdinaryBikeTelemetry } from "./workoutStorage.js";
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
function presentVo2AssessmentIfAny(summary) {
    if (!(summary === null || summary === void 0 ? void 0 : summary.vo2_assessment))
        return;
    if (typeof window.presentVo2Assessment === "function") {
        window.presentVo2Assessment(summary);
    }
}
export function releaseTransientSessionTelemetry(sessionId, storage) {
    if (!sessionId)
        return;
    clearBikeTelemetrySamples(sessionId, storage);
}
/** Discard a session that will never be finalized. Clears transient bike telemetry. */
export function discardWorkoutSession(day, storage) {
    const session = getSession(day, storage);
    const sessionId = session.sessionId;
    clearSession(day, storage);
    releaseTransientSessionTelemetry(sessionId, storage);
    if (sessionId && session.summaryEmitted !== "true" && typeof indexedDB !== "undefined") {
        void clearOrdinaryBikeTelemetry(sessionId);
    }
}
export function handleWorkoutCompletion(day) {
    const session = getSession(day);
    if (session.summaryEmitted !== "false" || typeof window.generateWorkoutSummary !== "function")
        return;
    const sessionId = session.sessionId;
    const sessionStart = session.sessionStart;
    if (!sessionId || !sessionStart)
        return;
    const sessionStartTime = parseInt(sessionStart);
    const sessionAge = Date.now() - sessionStartTime;
    if (sessionAge > MAX_SESSION_AGE_MS) {
        console.warn(`Skipping stale workout session for ${day} on completion (age: ${Math.round(sessionAge / (1000 * 60 * 60))} hours)`);
        discardWorkoutSession(day);
        return;
    }
    const endedAt = Date.now();
    return window
        .generateWorkoutSummary(sessionId, sessionStartTime, endedAt, day)
        .then((summary) => window.emitWorkoutSummary(summary).then(() => summary))
        .then((summary) => {
        markSummaryEmitted(day);
        presentVo2AssessmentIfAny(summary);
        releaseTransientSessionTelemetry(sessionId);
    })
        .catch((error) => {
        console.error("Error emitting workout summary on completion:", error);
        if (error.message && error.message.includes("exceeds maximum")) {
            console.warn("Stale session detected on completion, cleaning up...");
            discardWorkoutSession(day);
        }
    });
}
export async function handleWorkoutCancellation(day) {
    const session = getSession(day);
    if (!session.startTime ||
        !session.sessionId ||
        !session.sessionStart ||
        session.summaryEmitted !== "false" ||
        typeof window.generateWorkoutSummary !== "function") {
        return;
    }
    const sessionStartTime = parseInt(session.sessionStart);
    const sessionAge = Date.now() - sessionStartTime;
    if (sessionAge > MAX_SESSION_AGE_MS) {
        console.warn(`Skipping stale workout session for ${day} (age: ${Math.round(sessionAge / (1000 * 60 * 60))} hours)`);
        return;
    }
    const endedAt = Date.now();
    try {
        const summary = await window.generateWorkoutSummary(session.sessionId, sessionStartTime, endedAt, day, { cancelled: true });
        await window.emitWorkoutSummary(summary);
        presentVo2AssessmentIfAny(summary);
        releaseTransientSessionTelemetry(session.sessionId);
    }
    catch (error) {
        console.error("Error emitting workout summary on cancel:", error);
        if (error.message && error.message.includes("exceeds maximum")) {
            console.warn("Stale session detected, cleaning up...");
        }
    }
}
