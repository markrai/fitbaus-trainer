import {
  getSession,
  clearSession,
  markSummaryEmitted,
  totalPausedDurationSec,
  type SessionStorage,
} from "./sessionStore.js";
import { clearBikeTelemetrySamples, type TelemetryTraceStorage } from "./bikeTelemetryTrace.js";
import type { WorkoutSummary } from "./types.js";
import {
  clearOrdinaryBikeTelemetry,
  clearOrdinaryBikeTelemetryQueue,
  deleteFreestyleSessionEvidenceAtomic,
  flushOrdinaryBikeTelemetryWrites,
  getWorkoutSummaryBySessionId,
} from "./workoutStorage.js";
import { getBikeBridgeSession } from "./platform/bikeBridgeRuntime.js";
import { resetMachineGuidanceRuntime } from "./machines/runtime.js";
import {
  clearActiveSessionOwner,
  clearFreestyleAuthorityFault,
  clearSessionFinalization,
  freezeSessionFinalization,
  isFreestyleWorkoutSelector,
  markSessionFinalizationEvidenceIncomplete,
  markSessionFinalizationInProgress,
  markSessionFinalizationSaveFailed,
  readActiveSessionOwner,
  readFreestyleAuthorityFault,
  readSessionFinalization,
  type SessionFinalizationV1,
} from "./freestyleRide.js";

const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FREESTYLE_ACTIVE_DURATION_SEC = 24 * 60 * 60;

function activeElapsedSeconds(
  startTime: string | null,
  paused: boolean,
  pausedElapsed: number,
  now: number
): number {
  if (!startTime) return 0;
  if (paused) return pausedElapsed;
  return Math.floor((now - parseInt(startTime, 10)) / 1000);
}

function presentVo2AssessmentIfAny(summary: WorkoutSummary | undefined): void {
  if (!summary?.vo2_assessment) return;
  if (typeof (window as any).presentVo2Assessment === "function") {
    (window as any).presentVo2Assessment(summary);
  }
}

export function releaseTransientSessionTelemetry(
  sessionId: string | null | undefined,
  storage?: TelemetryTraceStorage
): void {
  if (!sessionId) return;
  clearBikeTelemetrySamples(sessionId, storage);
}

function disarmBikeBridge(): void {
  try {
    getBikeBridgeSession().bindSession(null);
  } catch (error) {
    console.error("Failed to disarm Bike Bridge:", error);
  }
}

function summaryMatchesFinalization(
  summary: WorkoutSummary,
  finalization: SessionFinalizationV1
): boolean {
  if (summary.external_session_id !== finalization.sessionId) return false;
  if (finalization.athleteId && summary.athlete_id && summary.athlete_id !== finalization.athleteId) {
    return false;
  }
  const freestyleProvenance =
    summary.intent === "freestyle" ||
    summary.day === finalization.selector ||
    (summary as { open_ended_timing?: unknown }).open_ended_timing != null;
  if (!freestyleProvenance) return false;
  const startedMs = Date.parse(summary.startedAt);
  const endedMs = Date.parse(summary.endedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) return false;
  return startedMs === finalization.startedAtMs && endedMs === finalization.endedAtMs;
}

let freestyleCleanupFailureInjectorForTests: ((step: string) => boolean) | null = null;

export function setFreestyleCleanupFailureInjectorForTests(
  injector: ((step: string) => boolean) | null
): void {
  freestyleCleanupFailureInjectorForTests = injector;
}

function throwIfCleanupInjected(step: string): void {
  if (freestyleCleanupFailureInjectorForTests?.(step)) {
    throw new Error(`injected freestyle cleanup failure at ${step}`);
  }
}

export type FreestyleOwnershipFailure =
  | "no_session"
  | "authority"
  | "ownership_mismatch"
  | "session_conflict";

export function validateFreestyleFinalizationOwnership(
  day: string,
  finalization: SessionFinalizationV1,
  storage?: SessionStorage
): { ok: true } | { ok: false; reason: FreestyleOwnershipFailure } {
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
  if (
    !authority ||
    authority.source !== "frozen" ||
    authority.mode !== "manual_freestyle_ride" ||
    authority.sessionId !== finalization.sessionId
  ) {
    return { ok: false, reason: "authority" };
  }
  if (
    finalization.athleteId &&
    session.athleteId &&
    finalization.athleteId !== session.athleteId
  ) {
    return { ok: false, reason: "ownership_mismatch" };
  }
  return { ok: true };
}

/** Discard a session that will never be finalized. Clears transient bike telemetry. */
export function discardWorkoutSession(day: string, storage?: SessionStorage): void {
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

export function handleWorkoutCompletion(day: string): Promise<void> | void {
  if (isFreestyleWorkoutSelector(day)) {
    return;
  }
  const session = getSession(day);
  if (session.summaryEmitted !== "false" || typeof (window as any).generateWorkoutSummary !== "function") return;
  const sessionId = session.sessionId;
  const sessionStart = session.sessionStart;
  if (!sessionId || !sessionStart) return;
  const sessionStartTime = parseInt(sessionStart);
  const sessionAge = Date.now() - sessionStartTime;
  if (sessionAge > MAX_SESSION_AGE_MS) {
    console.warn(`Skipping stale workout session for ${day} on completion (age: ${Math.round(sessionAge / (1000 * 60 * 60))} hours)`);
    discardWorkoutSession(day);
    return;
  }
  const endedAt = Date.now();
  return (window as any)
    .generateWorkoutSummary(sessionId, sessionStartTime, endedAt, day)
    .then((summary: WorkoutSummary) =>
      (window as any).emitWorkoutSummary(summary).then(() => summary)
    )
    .then((summary: WorkoutSummary) => {
      markSummaryEmitted(day);
      presentVo2AssessmentIfAny(summary);
      releaseTransientSessionTelemetry(sessionId);
      clearActiveSessionOwner({ selector: day, sessionId });
      disarmBikeBridge();
    })
    .catch((error: any) => {
      console.error("Error emitting workout summary on completion:", error);
      if (error.message && error.message.includes("exceeds maximum")) {
        console.warn("Stale session detected on completion, cleaning up...");
        discardWorkoutSession(day);
      }
    });
}

export async function handleWorkoutCancellation(day: string): Promise<void> {
  if (isFreestyleWorkoutSelector(day)) {
    return;
  }
  const session = getSession(day);
  if (
    !session.startTime ||
    !session.sessionId ||
    !session.sessionStart ||
    session.summaryEmitted !== "false" ||
    typeof (window as any).generateWorkoutSummary !== "function"
  ) {
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
    const summary = await (window as any).generateWorkoutSummary(
      session.sessionId,
      sessionStartTime,
      endedAt,
      day,
      { cancelled: true }
    );
    await (window as any).emitWorkoutSummary(summary);
    presentVo2AssessmentIfAny(summary);
    releaseTransientSessionTelemetry(session.sessionId);
    clearActiveSessionOwner({ selector: day, sessionId: session.sessionId });
    disarmBikeBridge();
  } catch (error: any) {
    console.error("Error emitting workout summary on cancel:", error);
    if (error.message && error.message.includes("exceeds maximum")) {
      console.warn("Stale session detected, cleaning up...");
    }
  }
}

export type FreestyleFinishResult =
  | { ok: true; summary: WorkoutSummary; alreadyPersisted?: boolean }
  | {
      ok: false;
      reason:
        | "not_freestyle"
        | "no_session"
        | "already_emitted"
        | "stale"
        | "authority"
        | "ownership_mismatch"
        | "session_conflict"
        | "save_failed"
        | "flush_failed"
        | "missing_generator"
        | "in_flight";
      finalization?: SessionFinalizationV1;
    };

let freestyleFinishInFlight: Promise<FreestyleFinishResult> | null = null;

async function completeFreestyleCleanupAfterSave(
  day: string,
  finalization: SessionFinalizationV1,
  summary: WorkoutSummary,
  storage?: SessionStorage
): Promise<void> {
  const live = getSession(day, storage);
  if (live.sessionId && live.sessionId !== finalization.sessionId) {
    const existingFinalization = readSessionFinalization(day, storage);
    if (existingFinalization?.sessionId === finalization.sessionId) {
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
    if (typeof (window as any).releaseWakeLock === "function") {
      await (window as any).releaseWakeLock();
    }
  } catch (error) {
    console.error("Wake lock release failed after freestyle save:", error);
  }
  void summary;
}

async function recoverAlreadyPersistedFreestyle(
  day: string,
  finalization: SessionFinalizationV1,
  storage?: SessionStorage
): Promise<FreestyleFinishResult | null> {
  const existing = await getWorkoutSummaryBySessionId(finalization.sessionId);
  if (!existing || !summaryMatchesFinalization(existing, finalization)) return null;
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
  } catch (error) {
    console.error("Cleanup after already-persisted freestyle summary failed:", error);
  }
  return { ok: true, summary: existing, alreadyPersisted: true };
}

async function persistFreestyleFinalization(
  day: string,
  finalization: SessionFinalizationV1,
  storage?: SessionStorage
): Promise<FreestyleFinishResult> {
  const ownership = validateFreestyleFinalizationOwnership(day, finalization, storage);
  if (ownership.ok === false) {
    const recovered = await recoverAlreadyPersistedFreestyle(day, finalization, storage);
    if (recovered) return recovered;
    return { ok: false, reason: ownership.reason, finalization };
  }

  const recovered = await recoverAlreadyPersistedFreestyle(day, finalization, storage);
  if (recovered) return recovered;

  if (typeof (window as any).generateWorkoutSummary !== "function") {
    return { ok: false, reason: "missing_generator", finalization };
  }
  if (typeof (window as any).emitWorkoutSummaryConfirmed !== "function") {
    return { ok: false, reason: "missing_generator", finalization };
  }

  markSessionFinalizationInProgress(day, storage);

  let evidenceIncomplete = finalization.evidenceIncomplete === true;
  let flushResult: {
    ok: boolean;
    unresolvedFailures: number;
    rejectedCount: number;
    retryableFailures: number;
  };
  try {
    flushResult = await flushOrdinaryBikeTelemetryWrites(finalization.sessionId);
  } catch (error) {
    console.error("Error flushing freestyle telemetry before save:", error);
    const failed =
      markSessionFinalizationSaveFailed(day, storage, { evidenceIncomplete: true }) ?? {
        ...finalization,
        status: "save_failed" as const,
        evidenceIncomplete: true,
      };
    return { ok: false, reason: "flush_failed", finalization: failed };
  }
  if (!flushResult.ok || flushResult.unresolvedFailures > 0) {
    if (flushResult.retryableFailures > 0) {
      const failed =
        markSessionFinalizationSaveFailed(day, storage, { evidenceIncomplete: true }) ?? {
          ...finalization,
          status: "save_failed" as const,
          evidenceIncomplete: true,
        };
      return { ok: false, reason: "flush_failed", finalization: failed };
    }
    if (flushResult.rejectedCount > 0) {
      evidenceIncomplete = true;
      markSessionFinalizationEvidenceIncomplete(day, storage);
      clearOrdinaryBikeTelemetryQueue(finalization.sessionId);
    } else {
      const failed =
        markSessionFinalizationSaveFailed(day, storage, { evidenceIncomplete: true }) ?? {
          ...finalization,
          status: "save_failed" as const,
          evidenceIncomplete: true,
        };
      return { ok: false, reason: "flush_failed", finalization: failed };
    }
  }

  let summary: WorkoutSummary;
  try {
    summary = await (window as any).generateWorkoutSummary(
      finalization.sessionId,
      finalization.startedAtMs,
      finalization.endedAtMs,
      day,
      {
        cancelled: false,
        freestyleFinalization: {
          ...finalization,
          evidenceIncomplete,
        },
      }
    );
  } catch (error: any) {
    console.error("Error generating freestyle summary:", error);
    const failed = markSessionFinalizationSaveFailed(day, storage) ?? finalization;
    return { ok: false, reason: "save_failed", finalization: failed };
  }

  if (evidenceIncomplete && summary.evidence_incomplete !== true) {
    const failed = markSessionFinalizationSaveFailed(day, storage, { evidenceIncomplete: true }) ?? {
      ...finalization,
      status: "save_failed" as const,
      evidenceIncomplete: true,
    };
    return { ok: false, reason: "save_failed", finalization: failed };
  }
  if (!evidenceIncomplete && summary.evidence_incomplete === true) {
    const failed = markSessionFinalizationSaveFailed(day, storage) ?? finalization;
    return { ok: false, reason: "save_failed", finalization: failed };
  }

  if (
    summary.external_session_id !== finalization.sessionId ||
    (finalization.athleteId &&
      summary.athlete_id &&
      summary.athlete_id !== finalization.athleteId)
  ) {
    const failed = markSessionFinalizationSaveFailed(day, storage) ?? finalization;
    return { ok: false, reason: "ownership_mismatch", finalization: failed };
  }

  let saved = false;
  try {
    saved = await (window as any).emitWorkoutSummaryConfirmed(summary);
  } catch (error) {
    console.error("Error emitting freestyle summary:", error);
    const failed = markSessionFinalizationSaveFailed(day, storage) ?? finalization;
    return { ok: false, reason: "save_failed", finalization: failed };
  }
  if (!saved) {
    const failed = markSessionFinalizationSaveFailed(day, storage) ?? {
      ...finalization,
      status: "save_failed" as const,
    };
    return { ok: false, reason: "save_failed", finalization: failed };
  }

  try {
    await completeFreestyleCleanupAfterSave(day, finalization, summary, storage);
  } catch (error) {
    console.error("Post-save freestyle cleanup failed; summary is already persisted:", error);
  }
  return { ok: true, summary };
}

export async function finishFreestyleRide(
  day: string,
  storage?: SessionStorage,
  now = Date.now()
): Promise<FreestyleFinishResult> {
  if (!isFreestyleWorkoutSelector(day)) return { ok: false, reason: "not_freestyle" };
  if (freestyleFinishInFlight) return freestyleFinishInFlight;

  freestyleFinishInFlight = (async () => {
    const existing = readSessionFinalization(day, storage);
    if (existing) {
      const ownership = validateFreestyleFinalizationOwnership(day, existing, storage);
      if (ownership.ok === false) {
        const recovered = await recoverAlreadyPersistedFreestyle(day, existing, storage);
        if (recovered) return recovered;
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
    if (
      !authority ||
      authority.source !== "frozen" ||
      authority.mode !== "manual_freestyle_ride" ||
      authority.sessionId !== session.sessionId
    ) {
      return { ok: false, reason: "authority" };
    }

    const startedAtMs = parseInt(session.sessionStart, 10);
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) {
      return { ok: false, reason: "no_session" };
    }

    if (!Number.isFinite(now) || now < startedAtMs) {
      return { ok: false, reason: "no_session" };
    }
    const activeDurationSec = activeElapsedSeconds(
      session.startTime,
      session.paused,
      session.pausedElapsed,
      now
    );
    const pausedDurationSec = totalPausedDurationSec(session, now);
    const wallClockSec = Math.max(0, Math.floor((now - startedAtMs) / 1000));
    if (
      !Number.isFinite(activeDurationSec) ||
      activeDurationSec < 0 ||
      !Number.isFinite(pausedDurationSec) ||
      pausedDurationSec < 0 ||
      activeDurationSec > wallClockSec + 1 ||
      activeDurationSec + pausedDurationSec > wallClockSec + 2
    ) {
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
      const failed =
        freezeExcess.ok === false
          ? freezeExcess.existing
          : markSessionFinalizationSaveFailed(day, storage) ?? freezeExcess.record;
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
  } finally {
    freestyleFinishInFlight = null;
  }
}

export async function retryFreestyleSave(
  day: string,
  storage?: SessionStorage
): Promise<FreestyleFinishResult> {
  if (!isFreestyleWorkoutSelector(day)) return { ok: false, reason: "not_freestyle" };
  const existing = readSessionFinalization(day, storage);
  if (!existing) return { ok: false, reason: "no_session" };
  return finishFreestyleRide(day, storage, existing.endedAtMs);
}

export type FreestyleDiscardResult =
  | { ok: true; sessionId: string }
  | {
      ok: false;
      reason:
        | "not_freestyle"
        | "finalizing"
        | "no_session"
        | "ownership_conflict"
        | "target_mismatch"
        | "delete_failed";
    };

export async function discardFreestyleRide(
  day: string,
  storage?: SessionStorage,
  options?: { sessionId?: string }
): Promise<FreestyleDiscardResult> {
  if (!isFreestyleWorkoutSelector(day)) return { ok: false, reason: "not_freestyle" };
  const finalization = readSessionFinalization(day, storage);
  if (finalization?.status === "finalizing") {
    return { ok: false, reason: "finalizing" };
  }
  const session = getSession(day, storage);
  const liveId = session.sessionId;
  const finalId = finalization?.sessionId ?? null;
  const faultId = readFreestyleAuthorityFault(day, storage);
  if (liveId && finalId && liveId !== finalId && !options?.sessionId) {
    return { ok: false, reason: "ownership_conflict" };
  }
  const targetId = options?.sessionId ?? liveId ?? finalId ?? faultId;
  if (!targetId) return { ok: false, reason: "no_session" };
  if (liveId && liveId !== targetId && finalId && finalId !== targetId) {
    return { ok: false, reason: "target_mismatch" };
  }
  if (options?.sessionId) {
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
    } catch (error) {
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
  if (stillLive.sessionId === targetId || stillFinal?.sessionId === targetId) {
    return { ok: false, reason: "delete_failed" };
  }

  if (!stillLive.sessionId) {
    disarmBikeBridge();
    resetMachineGuidanceRuntime();
  }
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as any).window !== "undefined" &&
    typeof (globalThis as any).window.releaseWakeLock === "function"
  ) {
    try {
      await (globalThis as any).window.releaseWakeLock();
    } catch (error) {
      console.error("Wake lock release failed after freestyle discard:", error);
    }
  }
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as any).window !== "undefined" &&
    typeof (globalThis as any).window.updateDisplay === "function"
  ) {
    (globalThis as any).window.updateDisplay();
  }
  return { ok: true, sessionId: targetId };
}

export function isFreestyleFinishInFlight(): boolean {
  return freestyleFinishInFlight != null;
}
