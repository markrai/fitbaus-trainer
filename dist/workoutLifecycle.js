import { getSession, clearSession, markSummaryEmitted, totalPausedDurationSec, } from "./sessionStore.js";
import { clearBikeTelemetrySamples } from "./bikeTelemetryTrace.js";
import { clearOrdinaryBikeTelemetry, clearOrdinaryBikeTelemetryQueue, deleteFreestyleSessionEvidenceAtomic, flushOrdinaryBikeTelemetryWrites, getWorkoutSummaryBySessionId, } from "./workoutStorage.js";
import { getBikeBridgeSession } from "./platform/bikeBridgeRuntime.js";
import { resetMachineGuidanceRuntime } from "./machines/runtime.js";
import { FREESTYLE_WORKOUT_SELECTOR_ID, clearActiveSessionOwner, clearFreestyleAuthorityFault, clearSessionFinalization, freezeSessionFinalization, isFreestyleWorkoutSelector, markSessionFinalizationEvidenceIncomplete, markSessionFinalizationInProgress, markSessionFinalizationSaveFailed, readActiveSessionOwner, readFreestyleAuthorityFault, readSessionFinalization, } from "./freestyleRide.js";
import { VO2_WORKOUT_SELECTOR_ID } from "./vo2Protocol.js";
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
export function canApplyWorkoutSessionEffects(day, sessionId, storage) {
    const owner = readActiveSessionOwner(storage);
    if (owner && (owner.selector !== day || owner.sessionId !== sessionId))
        return false;
    const current = getSession(day, storage);
    if (current.sessionId && current.sessionId !== sessionId)
        return false;
    try {
        const binding = getBikeBridgeSession().getSessionBinding();
        if (binding && binding.sessionId !== sessionId)
            return false;
        if (owner || binding)
            return true;
    }
    catch (error) {
        console.error("Cannot verify workout control binding:", error);
        return false;
    }
    for (const selector of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", VO2_WORKOUT_SELECTOR_ID, FREESTYLE_WORKOUT_SELECTOR_ID]) {
        if (selector === day)
            continue;
        const other = getSession(selector, storage);
        if (other.startTime && other.summaryEmitted !== "true")
            return false;
    }
    return true;
}
function stopOwnedWorkoutControl(day, sessionId, storage) {
    if (!canApplyWorkoutSessionEffects(day, sessionId, storage))
        return;
    disarmBikeBridge();
    if (canApplyWorkoutSessionEffects(day, sessionId, storage))
        resetMachineGuidanceRuntime();
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
    stopOwnedWorkoutControl(day, sessionId, storage);
    if (sessionId && session.summaryEmitted !== "true" && typeof indexedDB !== "undefined") {
        void clearOrdinaryBikeTelemetry(sessionId);
    }
}
const ordinaryEnds = new WeakMap();
function matchingOrdinaryEnd(day, sessionId, storage) {
    const session = getSession(day, storage);
    const owner = readActiveSessionOwner(storage);
    return session.sessionId === sessionId &&
        (!owner || (owner.selector === day && owner.sessionId === sessionId));
}
function endOrdinaryWorkout(day, cancelled, prepare) {
    if (isFreestyleWorkoutSelector(day))
        return Promise.resolve("no_session");
    const storage = localStorage;
    const session = getSession(day, storage);
    if (!session.sessionId || !session.sessionStart || !session.startTime) {
        return Promise.resolve(session.sessionId ? "failed" : "no_session");
    }
    const sessionId = session.sessionId;
    if (!matchingOrdinaryEnd(day, sessionId, storage))
        return Promise.resolve("superseded");
    if (session.summaryEmitted === "true") {
        const finalization = readSessionFinalization(day, storage);
        if (finalization && finalization.sessionId === sessionId) {
            releaseTransientSessionTelemetry(sessionId, storage);
            clearSessionFinalization(day, storage);
            clearActiveSessionOwner({ selector: day, sessionId }, storage);
        }
        return Promise.resolve("already_saved");
    }
    if (session.summaryEmitted !== "false")
        return Promise.resolve("failed");
    let pending = ordinaryEnds.get(storage);
    if (!pending) {
        pending = new Map();
        ordinaryEnds.set(storage, pending);
    }
    const existing = pending.get(sessionId);
    if (existing)
        return existing;
    const prior = readSessionFinalization(day, storage);
    if (prior && prior.sessionId !== sessionId)
        return Promise.resolve("superseded");
    const startedAtMs = Number(session.sessionStart);
    const endedAtMs = prior ? prior.endedAtMs : Date.now();
    if (!prior && endedAtMs - startedAtMs > MAX_SESSION_AGE_MS) {
        discardWorkoutSession(day, storage);
        return Promise.resolve("no_session");
    }
    const task = Promise.resolve().then(async () => {
        if (!matchingOrdinaryEnd(day, sessionId, storage))
            return "superseded";
        try {
            const freeze = freezeSessionFinalization({
                selector: day,
                sessionId,
                startedAtMs,
                endedAtMs,
                activeDurationSec: activeElapsedSeconds(session.startTime, session.paused, session.pausedElapsed, endedAtMs),
                pausedDurationSec: totalPausedDurationSec(session, endedAtMs),
                cancelled,
                storage,
            });
            if (freeze.ok === false)
                return "superseded";
            const record = freeze.record;
            markSessionFinalizationInProgress(day, storage);
            if (canApplyWorkoutSessionEffects(day, sessionId, storage)) {
                disarmBikeBridge();
                if (canApplyWorkoutSessionEffects(day, sessionId, storage) && typeof window.releaseWakeLock === "function") {
                    void Promise.resolve(window.releaseWakeLock()).catch(error => console.error("Wake lock release failed:", error));
                }
            }
            if (!matchingOrdinaryEnd(day, sessionId, storage))
                return "superseded";
            if (!prior && prepare)
                prepare(record.endedAtMs);
            if (typeof window.generateWorkoutSummary !== "function" ||
                typeof window.emitWorkoutSummary !== "function")
                throw new Error("Summary persistence unavailable");
            const summary = await window.generateWorkoutSummary(sessionId, record.startedAtMs, record.endedAtMs, day, { cancelled: record.cancelled === true });
            if (!matchingOrdinaryEnd(day, sessionId, storage))
                return "superseded";
            if (summary.external_session_id !== sessionId)
                throw new Error("Summary session identity mismatch");
            const saved = await window.emitWorkoutSummary(summary);
            if (!matchingOrdinaryEnd(day, sessionId, storage))
                return "superseded";
            if (saved !== true)
                throw new Error("Workout summary was not persisted");
            markSummaryEmitted(day, storage);
            releaseTransientSessionTelemetry(sessionId, storage);
            clearSessionFinalization(day, storage);
            clearActiveSessionOwner({ selector: day, sessionId }, storage);
            try {
                presentVo2AssessmentIfAny(summary);
            }
            catch (error) {
                console.error("Could not present saved workout assessment:", error);
            }
            return "saved";
        }
        catch (error) {
            console.error("Error finalizing workout:", error);
            if (!matchingOrdinaryEnd(day, sessionId, storage))
                return "superseded";
            const current = readSessionFinalization(day, storage);
            if (current && current.sessionId === sessionId)
                markSessionFinalizationSaveFailed(day, storage);
            return "failed";
        }
    }).finally(() => {
        pending.delete(sessionId);
    });
    pending.set(sessionId, task);
    return task;
}
export function handleWorkoutCompletion(day) {
    return endOrdinaryWorkout(day, false);
}
export function handleWorkoutCancellation(day, prepare) {
    return endOrdinaryWorkout(day, true, prepare);
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
    stopOwnedWorkoutControl(day, finalization.sessionId, storage);
    throwIfCleanupInjected("before_clear_finalization");
    const remaining = readSessionFinalization(day, storage);
    if (!remaining || remaining.sessionId === finalization.sessionId) {
        clearSessionFinalization(day, storage);
    }
    try {
        if (canApplyWorkoutSessionEffects(day, finalization.sessionId, storage) && typeof window.releaseWakeLock === "function") {
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
    releaseTransientSessionTelemetry(targetId, storage);
    const latestFinalization = readSessionFinalization(day, storage);
    if (latestFinalization && latestFinalization.sessionId === targetId) {
        clearSessionFinalization(day, storage);
    }
    const fault = readFreestyleAuthorityFault(day, storage);
    if (fault === targetId) {
        clearFreestyleAuthorityFault(day, storage);
    }
    if (getSession(day, storage).sessionId === targetId) {
        clearSession(day, storage, { preserveFinalization: true });
    }
    const stillLive = getSession(day, storage);
    const stillFinal = readSessionFinalization(day, storage);
    if (stillLive.sessionId === targetId || (stillFinal === null || stillFinal === void 0 ? void 0 : stillFinal.sessionId) === targetId) {
        return { ok: false, reason: "delete_failed" };
    }
    if (!stillLive.sessionId) {
        stopOwnedWorkoutControl(day, targetId, storage);
    }
    if (canApplyWorkoutSessionEffects(day, targetId, storage) &&
        typeof globalThis !== "undefined" &&
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
