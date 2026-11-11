import { getSession, clearSession, markSummaryEmitted, totalPausedDurationSec, } from "./sessionStore.js";
import { clearBikeTelemetrySamples } from "./bikeTelemetryTrace.js";
import { clearOrdinaryBikeTelemetry, clearOrdinaryBikeTelemetryQueue, deleteFreestyleSessionEvidenceAtomic, flushOrdinaryBikeTelemetryWrites, getWorkoutSummaryBySessionId, } from "./workoutStorage.js";
import { getBikeBridgeSession } from "./platform/bikeBridgeRuntime.js";
import { resetMachineGuidanceRuntime } from "./machines/runtime.js";
import { clearActiveSessionOwner, clearFreestyleAuthorityFault, clearSessionFinalization, freezeSessionFinalization, isFreestyleWorkoutSelector, markSessionFinalizationEvidenceIncomplete, markSessionFinalizationInProgress, markSessionFinalizationSaveFailed, readActiveSessionOwner, readFreestyleAuthorityFault, readSessionFinalization, } from "./freestyleRide.js";
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FREESTYLE_ACTIVE_DURATION_SEC = 24 * 60 * 60;
function activeElapsedSeconds(startTime, paused, pausedElapsed, now) {
    if (!startTime)
        return 0;
    if (paused)
        return pausedElapsed;
    return Math.floor((now - parseInt(startTime, 10)) / 1000);
}
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
function disarmBikeBridge() {
    try {
        getBikeBridgeSession().bindSession(null);
    }
    catch (error) {
        console.error("Failed to disarm Bike Bridge:", error);
    }
}
function summaryMatchesFinalization(summary, finalization) {
    if (summary.external_session_id !== finalization.sessionId)
        return false;
    if (finalization.athleteId && summary.athlete_id && summary.athlete_id !== finalization.athleteId) {
        return false;
    }
    const freestyleProvenance = summary.intent === "freestyle" ||
        summary.day === finalization.selector ||
        summary.open_ended_timing != null;
    if (!freestyleProvenance)
        return false;
    const startedMs = Date.parse(summary.startedAt);
    const endedMs = Date.parse(summary.endedAt);
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs))
        return false;
    return startedMs === finalization.startedAtMs && endedMs === finalization.endedAtMs;
}
let freestyleCleanupFailureInjectorForTests = null;
export function setFreestyleCleanupFailureInjectorForTests(injector) {
    freestyleCleanupFailureInjectorForTests = injector;
}
function throwIfCleanupInjected(step) {
    if (freestyleCleanupFailureInjectorForTests === null || freestyleCleanupFailureInjectorForTests === void 0 ? void 0 : freestyleCleanupFailureInjectorForTests(step)) {
        throw new Error(`injected freestyle cleanup failure at ${step}`);
    }
}
export function validateFreestyleFinalizationOwnership(day, finalization, storage) {
    if (!isFreestyleWorkoutSelector(day) || finalization.selector !== day) {
        return { ok: false, reason: "ownership_mismatch" };
    }
    const session = getSession(day, storage);
    const owner = readActiveSessionOwner(storage);
    if (owner && owner.selector === day && owner.sessionId !== finalization.sessionId) {
        return { ok: false, reason: "ownership_mismatch" };
    }
    if (!session.sessionId || !session.startTime) {
        return { ok: false, reason: "no_session" };
    }
    if (session.sessionId !== finalization.sessionId) {
        return { ok: false, reason: "ownership_mismatch" };
    }
    const authority = session.controlAuthority;
    if (!authority ||
        authority.source !== "frozen" ||
        authority.mode !== "manual_freestyle_ride" ||
        authority.sessionId !== finalization.sessionId) {
        return { ok: false, reason: "authority" };
    }
    if (finalization.athleteId &&
        session.athleteId &&
        finalization.athleteId !== session.athleteId) {
        return { ok: false, reason: "ownership_mismatch" };
    }
    return { ok: true };
}
/** Discard a session that will never be finalized. Clears transient bike telemetry. */
export function discardWorkoutSession(day, storage) {
    const session = getSession(day, storage);
    const sessionId = session.sessionId;
    clearSession(day, storage);
    clearFreestyleAuthorityFault(day, storage);
    releaseTransientSessionTelemetry(sessionId, storage);
    disarmBikeBridge();
    resetMachineGuidanceRuntime();
    if (sessionId && session.summaryEmitted !== "true" && typeof indexedDB !== "undefined") {
        void clearOrdinaryBikeTelemetry(sessionId);
    }
}
export function handleWorkoutCompletion(day) {
    if (isFreestyleWorkoutSelector(day)) {
        return;
    }
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
        clearActiveSessionOwner({ selector: day, sessionId });
        disarmBikeBridge();
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
    if (isFreestyleWorkoutSelector(day)) {
        return;
    }
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
        clearActiveSessionOwner({ selector: day, sessionId: session.sessionId });
        disarmBikeBridge();
    }
    catch (error) {
        console.error("Error emitting workout summary on cancel:", error);
        if (error.message && error.message.includes("exceeds maximum")) {
            console.warn("Stale session detected, cleaning up...");
        }
    }
}
let freestyleFinishInFlight = null;
async function completeFreestyleCleanupAfterSave(day, finalization, summary, storage) {
    const live = getSession(day, storage);
    if (live.sessionId && live.sessionId !== finalization.sessionId) {
        const existingFinalization = readSessionFinalization(day, storage);
        if ((existingFinalization === null || existingFinalization === void 0 ? void 0 : existingFinalization.sessionId) === finalization.sessionId) {
            clearSessionFinalization(day, storage);
        }
        void summary;
        return;
    }
    if (live.sessionId === finalization.sessionId) {
        markSummaryEmitted(day, storage);
        throwIfCleanupInjected("after_mark_emitted");
    }
    const fault = readFreestyleAuthorityFault(day, storage);
    if (!fault || fault === finalization.sessionId) {
        clearFreestyleAuthorityFault(day, storage);
    }
    throwIfCleanupInjected("after_clear_fault");
    releaseTransientSessionTelemetry(finalization.sessionId);
    throwIfCleanupInjected("after_release_telemetry");
    if (!live.sessionId || live.sessionId === finalization.sessionId) {
        clearSession(day, storage, { preserveFinalization: true });
    }
    throwIfCleanupInjected("after_clear_session");
    disarmBikeBridge();
    resetMachineGuidanceRuntime();
    throwIfCleanupInjected("before_clear_finalization");
    const remaining = readSessionFinalization(day, storage);
    if (!remaining || remaining.sessionId === finalization.sessionId) {
        clearSessionFinalization(day, storage);
    }
    try {
        if (typeof window.releaseWakeLock === "function") {
            await window.releaseWakeLock();
        }
    }
    catch (error) {
        console.error("Wake lock release failed after freestyle save:", error);
    }
    void summary;
}
async function recoverAlreadyPersistedFreestyle(day, finalization, storage) {
    const existing = await getWorkoutSummaryBySessionId(finalization.sessionId);
    if (!existing || !summaryMatchesFinalization(existing, finalization))
        return null;
    const live = getSession(day, storage);
    if (live.sessionId && live.sessionId !== finalization.sessionId) {
        return null;
    }
    const owner = readActiveSessionOwner(storage);
    if (owner && owner.selector === day && owner.sessionId !== finalization.sessionId) {
        return null;
    }
    try {
        await completeFreestyleCleanupAfterSave(day, finalization, existing, storage);
    }
    catch (error) {
        console.error("Cleanup after already-persisted freestyle summary failed:", error);
    }
    return { ok: true, summary: existing, alreadyPersisted: true };
}
async function persistFreestyleFinalization(day, finalization, storage) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const ownership = validateFreestyleFinalizationOwnership(day, finalization, storage);
    if (ownership.ok === false) {
        const recovered = await recoverAlreadyPersistedFreestyle(day, finalization, storage);
        if (recovered)
            return recovered;
        return { ok: false, reason: ownership.reason, finalization };
    }
    const recovered = await recoverAlreadyPersistedFreestyle(day, finalization, storage);
    if (recovered)
        return recovered;
    if (typeof window.generateWorkoutSummary !== "function") {
        return { ok: false, reason: "missing_generator", finalization };
    }
    if (typeof window.emitWorkoutSummaryConfirmed !== "function") {
        return { ok: false, reason: "missing_generator", finalization };
    }
    markSessionFinalizationInProgress(day, storage);
    let evidenceIncomplete = finalization.evidenceIncomplete === true;
    let flushResult;
    try {
        flushResult = await flushOrdinaryBikeTelemetryWrites(finalization.sessionId);
    }
    catch (error) {
        console.error("Error flushing freestyle telemetry before save:", error);
        const failed = (_a = markSessionFinalizationSaveFailed(day, storage, { evidenceIncomplete: true })) !== null && _a !== void 0 ? _a : {
            ...finalization,
            status: "save_failed",
            evidenceIncomplete: true,
        };
        return { ok: false, reason: "flush_failed", finalization: failed };
    }
    if (!flushResult.ok || flushResult.unresolvedFailures > 0) {
        if (flushResult.retryableFailures > 0) {
            const failed = (_b = markSessionFinalizationSaveFailed(day, storage, { evidenceIncomplete: true })) !== null && _b !== void 0 ? _b : {
                ...finalization,
                status: "save_failed",
                evidenceIncomplete: true,
            };
            return { ok: false, reason: "flush_failed", finalization: failed };
        }
        if (flushResult.rejectedCount > 0) {
            evidenceIncomplete = true;
            markSessionFinalizationEvidenceIncomplete(day, storage);
            clearOrdinaryBikeTelemetryQueue(finalization.sessionId);
        }
        else {
            const failed = (_c = markSessionFinalizationSaveFailed(day, storage, { evidenceIncomplete: true })) !== null && _c !== void 0 ? _c : {
                ...finalization,
                status: "save_failed",
                evidenceIncomplete: true,
            };
            return { ok: false, reason: "flush_failed", finalization: failed };
        }
    }
    let summary;
    try {
        summary = await window.generateWorkoutSummary(finalization.sessionId, finalization.startedAtMs, finalization.endedAtMs, day, {
            cancelled: false,
            freestyleFinalization: {
                ...finalization,
                evidenceIncomplete,
            },
        });
    }
    catch (error) {
        console.error("Error generating freestyle summary:", error);
        const failed = (_d = markSessionFinalizationSaveFailed(day, storage)) !== null && _d !== void 0 ? _d : finalization;
        return { ok: false, reason: "save_failed", finalization: failed };
    }
    if (evidenceIncomplete && summary.evidence_incomplete !== true) {
        const failed = (_e = markSessionFinalizationSaveFailed(day, storage, { evidenceIncomplete: true })) !== null && _e !== void 0 ? _e : {
            ...finalization,
            status: "save_failed",
            evidenceIncomplete: true,
        };
        return { ok: false, reason: "save_failed", finalization: failed };
    }
    if (!evidenceIncomplete && summary.evidence_incomplete === true) {
        const failed = (_f = markSessionFinalizationSaveFailed(day, storage)) !== null && _f !== void 0 ? _f : finalization;
        return { ok: false, reason: "save_failed", finalization: failed };
    }
    if (summary.external_session_id !== finalization.sessionId ||
        (finalization.athleteId &&
            summary.athlete_id &&
            summary.athlete_id !== finalization.athleteId)) {
        const failed = (_g = markSessionFinalizationSaveFailed(day, storage)) !== null && _g !== void 0 ? _g : finalization;
        return { ok: false, reason: "ownership_mismatch", finalization: failed };
    }
    let saved = false;
    try {
        saved = await window.emitWorkoutSummaryConfirmed(summary);
    }
    catch (error) {
        console.error("Error emitting freestyle summary:", error);
        const failed = (_h = markSessionFinalizationSaveFailed(day, storage)) !== null && _h !== void 0 ? _h : finalization;
        return { ok: false, reason: "save_failed", finalization: failed };
    }
    if (!saved) {
        const failed = (_j = markSessionFinalizationSaveFailed(day, storage)) !== null && _j !== void 0 ? _j : {
            ...finalization,
            status: "save_failed",
        };
        return { ok: false, reason: "save_failed", finalization: failed };
    }
    try {
        await completeFreestyleCleanupAfterSave(day, finalization, summary, storage);
    }
    catch (error) {
        console.error("Post-save freestyle cleanup failed; summary is already persisted:", error);
    }
    return { ok: true, summary };
}
export async function finishFreestyleRide(day, storage, now = Date.now()) {
    if (!isFreestyleWorkoutSelector(day))
        return { ok: false, reason: "not_freestyle" };
    if (freestyleFinishInFlight)
        return freestyleFinishInFlight;
    freestyleFinishInFlight = (async () => {
        var _a;
        const existing = readSessionFinalization(day, storage);
        if (existing) {
            const ownership = validateFreestyleFinalizationOwnership(day, existing, storage);
            if (ownership.ok === false) {
                const recovered = await recoverAlreadyPersistedFreestyle(day, existing, storage);
                if (recovered)
                    return recovered;
                return { ok: false, reason: ownership.reason, finalization: existing };
            }
            return persistFreestyleFinalization(day, existing, storage);
        }
        const session = getSession(day, storage);
        if (session.summaryEmitted === "true") {
            return { ok: false, reason: "already_emitted" };
        }
        if (!session.sessionId || !session.sessionStart || !session.startTime) {
            return { ok: false, reason: "no_session" };
        }
        const authority = session.controlAuthority;
        if (!authority ||
            authority.source !== "frozen" ||
            authority.mode !== "manual_freestyle_ride" ||
            authority.sessionId !== session.sessionId) {
            return { ok: false, reason: "authority" };
        }
        const startedAtMs = parseInt(session.sessionStart, 10);
        if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) {
            return { ok: false, reason: "no_session" };
        }
        if (!Number.isFinite(now) || now < startedAtMs) {
            return { ok: false, reason: "no_session" };
        }
        const activeDurationSec = activeElapsedSeconds(session.startTime, session.paused, session.pausedElapsed, now);
        const pausedDurationSec = totalPausedDurationSec(session, now);
        const wallClockSec = Math.max(0, Math.floor((now - startedAtMs) / 1000));
        if (!Number.isFinite(activeDurationSec) ||
            activeDurationSec < 0 ||
            !Number.isFinite(pausedDurationSec) ||
            pausedDurationSec < 0 ||
            activeDurationSec > wallClockSec + 1 ||
            activeDurationSec + pausedDurationSec > wallClockSec + 2) {
            return { ok: false, reason: "no_session" };
        }
        if (activeDurationSec > MAX_FREESTYLE_ACTIVE_DURATION_SEC) {
            const freezeExcess = freezeSessionFinalization({
                selector: day,
                sessionId: session.sessionId,
                startedAtMs,
                endedAtMs: now,
                activeDurationSec,
                pausedDurationSec,
                athleteId: session.athleteId,
                storage,
            });
            const failed = freezeExcess.ok === false
                ? freezeExcess.existing
                : (_a = markSessionFinalizationSaveFailed(day, storage)) !== null && _a !== void 0 ? _a : freezeExcess.record;
            return { ok: false, reason: "stale", finalization: failed };
        }
        const freeze = freezeSessionFinalization({
            selector: day,
            sessionId: session.sessionId,
            startedAtMs,
            endedAtMs: now,
            activeDurationSec,
            pausedDurationSec,
            athleteId: session.athleteId,
            storage,
        });
        if (freeze.ok === false) {
            return { ok: false, reason: "session_conflict", finalization: freeze.existing };
        }
        return persistFreestyleFinalization(day, freeze.record, storage);
    })();
    try {
        return await freestyleFinishInFlight;
    }
    finally {
        freestyleFinishInFlight = null;
    }
}
export async function retryFreestyleSave(day, storage) {
    if (!isFreestyleWorkoutSelector(day))
        return { ok: false, reason: "not_freestyle" };
    const existing = readSessionFinalization(day, storage);
    if (!existing)
        return { ok: false, reason: "no_session" };
    return finishFreestyleRide(day, storage, existing.endedAtMs);
}
export async function discardFreestyleRide(day, storage, options) {
    var _a, _b, _c, _d;
    if (!isFreestyleWorkoutSelector(day))
        return { ok: false, reason: "not_freestyle" };
    const finalization = readSessionFinalization(day, storage);
    if ((finalization === null || finalization === void 0 ? void 0 : finalization.status) === "finalizing") {
        return { ok: false, reason: "finalizing" };
    }
    const session = getSession(day, storage);
    const liveId = session.sessionId;
    const finalId = (_a = finalization === null || finalization === void 0 ? void 0 : finalization.sessionId) !== null && _a !== void 0 ? _a : null;
    const faultId = readFreestyleAuthorityFault(day, storage);
    if (liveId && finalId && liveId !== finalId && !(options === null || options === void 0 ? void 0 : options.sessionId)) {
        return { ok: false, reason: "ownership_conflict" };
    }
    const targetId = (_d = (_c = (_b = options === null || options === void 0 ? void 0 : options.sessionId) !== null && _b !== void 0 ? _b : liveId) !== null && _c !== void 0 ? _c : finalId) !== null && _d !== void 0 ? _d : faultId;
    if (!targetId)
        return { ok: false, reason: "no_session" };
    if (liveId && liveId !== targetId && finalId && finalId !== targetId) {
        return { ok: false, reason: "target_mismatch" };
    }
    if (options === null || options === void 0 ? void 0 : options.sessionId) {
        const matchesLive = liveId === targetId;
        const matchesFinal = finalId === targetId;
        const matchesFault = faultId === targetId;
        if (!matchesLive && !matchesFinal && !matchesFault) {
            return { ok: false, reason: "target_mismatch" };
        }
    }
    if (typeof indexedDB !== "undefined") {
        try {
            await deleteFreestyleSessionEvidenceAtomic(targetId);
        }
        catch (error) {
            console.error("Error deleting freestyle evidence on discard:", error);
            return { ok: false, reason: "delete_failed" };
        }
    }
    releaseTransientSessionTelemetry(targetId);
    if (finalId === targetId) {
        clearSessionFinalization(day, storage);
    }
    const fault = readFreestyleAuthorityFault(day, storage);
    if (fault === targetId) {
        clearFreestyleAuthorityFault(day, storage);
    }
    if (liveId === targetId) {
        clearSession(day, storage, { preserveFinalization: true });
    }
    const stillLive = getSession(day, storage);
    const stillFinal = readSessionFinalization(day, storage);
    if (stillLive.sessionId === targetId || (stillFinal === null || stillFinal === void 0 ? void 0 : stillFinal.sessionId) === targetId) {
        return { ok: false, reason: "delete_failed" };
    }
    if (!stillLive.sessionId) {
        disarmBikeBridge();
        resetMachineGuidanceRuntime();
    }
    if (typeof globalThis !== "undefined" &&
        typeof globalThis.window !== "undefined" &&
        typeof globalThis.window.releaseWakeLock === "function") {
        try {
            await globalThis.window.releaseWakeLock();
        }
        catch (error) {
            console.error("Wake lock release failed after freestyle discard:", error);
        }
    }
    if (typeof globalThis !== "undefined" &&
        typeof globalThis.window !== "undefined" &&
        typeof globalThis.window.updateDisplay === "function") {
        globalThis.window.updateDisplay();
    }
    return { ok: true, sessionId: targetId };
}
export function isFreestyleFinishInFlight() {
    return freestyleFinishInFlight != null;
}
