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
  FREESTYLE_WORKOUT_SELECTOR_ID,
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

import { VO2_WORKOUT_SELECTOR_ID } from "./vo2Protocol.js";

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

export function canApplyWorkoutSessionEffects(day: string, sessionId: string | null, storage?: SessionStorage): boolean {
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
function stopOwnedWorkoutControl(day: string, sessionId: string | null, storage?: SessionStorage): void {
  if (!canApplyWorkoutSessionEffects(day, sessionId, storage))
    return;
  disarmBikeBridge();
  if (canApplyWorkoutSessionEffects(day, sessionId, storage))
    resetMachineGuidanceRuntime();
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
  stopOwnedWorkoutControl(day, sessionId, storage);
  if (sessionId && session.summaryEmitted !== "true" && typeof indexedDB !== "undefined") {
    void clearOrdinaryBikeTelemetry(sessionId);
  }
}

export type WorkoutEndResult = "saved" | "already_saved" | "no_session" | "failed" | "superseded";

const ordinaryEnds = new WeakMap<SessionStorage, Map<string, Promise<WorkoutEndResult>>>();
function matchingOrdinaryEnd(day: string, sessionId: string, storage: SessionStorage): boolean {
  const session = getSession(day, storage);
  const owner = readActiveSessionOwner(storage);
  return session.sessionId === sessionId &&
    (!owner || (owner.selector === day && owner.sessionId === sessionId));
}
function endOrdinaryWorkout(day: string, cancelled: boolean, prepare?: (endedAtMs: number) => void): Promise<WorkoutEndResult> {
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
  const task = Promise.resolve().then(async (): Promise<WorkoutEndResult> => {
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
        if (canApplyWorkoutSessionEffects(day, sessionId, storage) && typeof (window as any).releaseWakeLock === "function") {
          void Promise.resolve((window as any).releaseWakeLock()).catch(error => console.error("Wake lock release failed:", error));
        }
      }
      if (!matchingOrdinaryEnd(day, sessionId, storage)) return "superseded";
      if (!prior && prepare)
        prepare(record.endedAtMs);
      if (typeof (window as any).generateWorkoutSummary !== "function" ||
        typeof (window as any).emitWorkoutSummary !== "function")
        throw new Error("Summary persistence unavailable");
      const summary: WorkoutSummary = await (window as any).generateWorkoutSummary(sessionId, record.startedAtMs, record.endedAtMs, day, { cancelled: record.cancelled === true });
      if (!matchingOrdinaryEnd(day, sessionId, storage))
        return "superseded";
      if (summary.external_session_id !== sessionId)
        throw new Error("Summary session identity mismatch");
      const saved = await (window as any).emitWorkoutSummary(summary);
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
      } catch (error) {
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
export function handleWorkoutCompletion(day: string): Promise<WorkoutEndResult> {
  return endOrdinaryWorkout(day, false);
}
export function handleWorkoutCancellation(day: string, prepare?: (endedAtMs: number) => void): Promise<WorkoutEndResult> {
  return endOrdinaryWorkout(day, true, prepare);
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

  stopOwnedWorkoutControl(day, finalization.sessionId, storage);
  throwIfCleanupInjected("before_clear_finalization");

  const remaining = readSessionFinalization(day, storage);
  if (!remaining || remaining.sessionId === finalization.sessionId) {
    clearSessionFinalization(day, storage);
  }

  try {
    if (canApplyWorkoutSessionEffects(day, finalization.sessionId, storage) && typeof (window as any).releaseWakeLock === "function") {
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
  if (stillLive.sessionId === targetId || stillFinal?.sessionId === targetId) {
    return { ok: false, reason: "delete_failed" };
  }

  if (!stillLive.sessionId) {
    stopOwnedWorkoutControl(day, targetId, storage);
  }
  if (
    canApplyWorkoutSessionEffects(day, targetId, storage) &&
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
