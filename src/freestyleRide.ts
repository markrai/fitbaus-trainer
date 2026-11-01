import type { PlanBlock, WorkoutMetadata, WorkoutPhaseState } from "./types.js";
import type { SessionStorage } from "./sessionStore.js";

export const FREESTYLE_WORKOUT_SELECTOR_ID = "Freestyle";
export const FREESTYLE_WORKOUT_LABEL = "Freestyle Ride";
export const FREESTYLE_WORKOUT_INTENT = "freestyle";
export const FREESTYLE_PHASE_ID = "freestyle_ride";

export const ACTIVE_SESSION_OWNER_KEY = "active_session_owner_v1";
export const SESSION_FINALIZATION_KEY_PREFIX = "session_finalization_v1_";
export const FREESTYLE_AUTHORITY_FAULT_KEY_PREFIX = "freestyle_authority_fault_v1_";

export const SESSION_FINALIZATION_SCHEMA_VERSION_V1 = 1 as const;

export interface ActiveSessionOwnerV1 {
  selector: string;
  sessionId: string;
  athleteId?: string;
}

export type SessionFinalizationStatus = "finalizing" | "save_failed";

export interface SessionFinalizationV1 {
  schemaVersion: typeof SESSION_FINALIZATION_SCHEMA_VERSION_V1;
  selector: string;
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  activeDurationSec: number;
  pausedDurationSec: number;
  status: SessionFinalizationStatus;
  athleteId?: string;
  evidenceIncomplete?: boolean;
}

export type FreezeSessionFinalizationResult =
  | { ok: true; record: SessionFinalizationV1 }
  | { ok: false; reason: "session_conflict"; existing: SessionFinalizationV1 };

function storageOrBrowser(storage?: SessionStorage): SessionStorage {
  return storage ?? localStorage;
}

export function isFreestyleWorkoutSelector(day: string | null | undefined): boolean {
  return day === FREESTYLE_WORKOUT_SELECTOR_ID;
}

export function freestylePlanBlocks(): PlanBlock {
  return { warm: 0, sustain: 0, cool: 0 };
}

export function freestyleWorkoutMetadata(): WorkoutMetadata {
  return {
    type: FREESTYLE_WORKOUT_LABEL,
    intent: FREESTYLE_WORKOUT_INTENT,
    activities: ["bike"],
  };
}

export function freestyleWorkoutBlocksText(): string {
  return "Open-ended - observation only";
}

export function freestylePhaseState(elapsedSec: number): WorkoutPhaseState {
  const active = Math.max(0, Math.floor(elapsedSec));
  return {
    phase: "Freestyle",
    kind: "work",
    phaseId: FREESTYLE_PHASE_ID,
    phaseElapsedSeconds: active,
    phaseDurationSeconds: 0,
    timeLeft: 0,
    done: false,
  };
}

export function sessionFinalizationKey(selector: string): string {
  return SESSION_FINALIZATION_KEY_PREFIX + selector;
}

export function freestyleAuthorityFaultKey(selector: string): string {
  return FREESTYLE_AUTHORITY_FAULT_KEY_PREFIX + selector;
}

export function parseActiveSessionOwner(raw: unknown): ActiveSessionOwnerV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.selector !== "string" || value.selector.length === 0) return null;
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return null;
  const owner: ActiveSessionOwnerV1 = {
    selector: value.selector,
    sessionId: value.sessionId,
  };
  if (typeof value.athleteId === "string" && value.athleteId.length > 0) {
    owner.athleteId = value.athleteId;
  }
  return owner;
}

export function readActiveSessionOwner(storage?: SessionStorage): ActiveSessionOwnerV1 | null {
  const raw = storageOrBrowser(storage).getItem(ACTIVE_SESSION_OWNER_KEY);
  if (!raw) return null;
  try {
    return parseActiveSessionOwner(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeActiveSessionOwner(owner: ActiveSessionOwnerV1, storage?: SessionStorage): void {
  storageOrBrowser(storage).setItem(ACTIVE_SESSION_OWNER_KEY, JSON.stringify(owner));
}

export function clearActiveSessionOwner(
  expected?: Pick<ActiveSessionOwnerV1, "selector" | "sessionId">,
  storage?: SessionStorage
): void {
  const store = storageOrBrowser(storage);
  if (expected) {
    const current = readActiveSessionOwner(store);
    if (
      !current ||
      current.selector !== expected.selector ||
      current.sessionId !== expected.sessionId
    ) {
      return;
    }
  }
  store.removeItem(ACTIVE_SESSION_OWNER_KEY);
}

export function claimActiveSessionOwner(
  owner: ActiveSessionOwnerV1,
  storage?: SessionStorage
): { ok: true } | { ok: false; reason: "competing_active_session" } {
  const current = readActiveSessionOwner(storage);
  if (
    current &&
    (current.selector !== owner.selector || current.sessionId !== owner.sessionId)
  ) {
    return { ok: false, reason: "competing_active_session" };
  }
  writeActiveSessionOwner(owner, storage);
  return { ok: true };
}

export function readFreestyleAuthorityFault(
  selector: string,
  storage?: SessionStorage
): string | null {
  const raw = storageOrBrowser(storage).getItem(freestyleAuthorityFaultKey(selector));
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function markFreestyleAuthorityFault(
  selector: string,
  sessionId: string,
  storage?: SessionStorage
): boolean {
  const store = storageOrBrowser(storage);
  const key = freestyleAuthorityFaultKey(selector);
  const previous = store.getItem(key);
  store.setItem(key, sessionId);
  return previous !== sessionId;
}

export function clearFreestyleAuthorityFault(selector: string, storage?: SessionStorage): void {
  storageOrBrowser(storage).removeItem(freestyleAuthorityFaultKey(selector));
}

export function parseSessionFinalization(raw: unknown): SessionFinalizationV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== SESSION_FINALIZATION_SCHEMA_VERSION_V1) return null;
  if (typeof value.selector !== "string" || value.selector.length === 0) return null;
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return null;
  if (typeof value.startedAtMs !== "number" || !Number.isFinite(value.startedAtMs) || value.startedAtMs <= 0) {
    return null;
  }
  if (typeof value.endedAtMs !== "number" || !Number.isFinite(value.endedAtMs) || value.endedAtMs < value.startedAtMs) {
    return null;
  }
  if (
    typeof value.activeDurationSec !== "number" ||
    !Number.isFinite(value.activeDurationSec) ||
    value.activeDurationSec < 0
  ) {
    return null;
  }
  if (
    typeof value.pausedDurationSec !== "number" ||
    !Number.isFinite(value.pausedDurationSec) ||
    value.pausedDurationSec < 0
  ) {
    return null;
  }
  if (value.status !== "finalizing" && value.status !== "save_failed") return null;
  const record: SessionFinalizationV1 = {
    schemaVersion: SESSION_FINALIZATION_SCHEMA_VERSION_V1,
    selector: value.selector,
    sessionId: value.sessionId,
    startedAtMs: Math.floor(value.startedAtMs),
    endedAtMs: Math.floor(value.endedAtMs),
    activeDurationSec: Math.floor(value.activeDurationSec),
    pausedDurationSec: Math.floor(value.pausedDurationSec),
    status: value.status,
  };
  if (typeof value.athleteId === "string" && value.athleteId.length > 0) {
    record.athleteId = value.athleteId;
  }
  if (value.evidenceIncomplete === true) record.evidenceIncomplete = true;
  return record;
}

export function readSessionFinalization(
  selector: string,
  storage?: SessionStorage
): SessionFinalizationV1 | null {
  const raw = storageOrBrowser(storage).getItem(sessionFinalizationKey(selector));
  if (!raw) return null;
  try {
    return parseSessionFinalization(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeSessionFinalization(
  record: SessionFinalizationV1,
  storage?: SessionStorage
): void {
  storageOrBrowser(storage).setItem(sessionFinalizationKey(record.selector), JSON.stringify(record));
}

export function clearSessionFinalization(selector: string, storage?: SessionStorage): void {
  storageOrBrowser(storage).removeItem(sessionFinalizationKey(selector));
}

export function freezeSessionFinalization(input: {
  selector: string;
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  activeDurationSec: number;
  pausedDurationSec: number;
  athleteId?: string;
  evidenceIncomplete?: boolean;
  storage?: SessionStorage;
}): FreezeSessionFinalizationResult {
  const existing = readSessionFinalization(input.selector, input.storage);
  if (existing && existing.sessionId !== input.sessionId) {
    return { ok: false, reason: "session_conflict", existing };
  }
  if (
    existing &&
    existing.sessionId === input.sessionId &&
    (existing.status === "finalizing" || existing.status === "save_failed")
  ) {
    return { ok: true, record: existing };
  }
  const record: SessionFinalizationV1 = {
    schemaVersion: SESSION_FINALIZATION_SCHEMA_VERSION_V1,
    selector: input.selector,
    sessionId: input.sessionId,
    startedAtMs: Math.floor(input.startedAtMs),
    endedAtMs: Math.floor(input.endedAtMs),
    activeDurationSec: Math.floor(input.activeDurationSec),
    pausedDurationSec: Math.floor(input.pausedDurationSec),
    status: "finalizing",
  };
  if (input.athleteId) record.athleteId = input.athleteId;
  if (input.evidenceIncomplete === true) record.evidenceIncomplete = true;
  writeSessionFinalization(record, input.storage);
  return { ok: true, record };
}

export function markSessionFinalizationSaveFailed(
  selector: string,
  storage?: SessionStorage,
  patch?: Partial<Pick<SessionFinalizationV1, "evidenceIncomplete">>
): SessionFinalizationV1 | null {
  const existing = readSessionFinalization(selector, storage);
  if (!existing) return null;
  const next: SessionFinalizationV1 = {
    ...existing,
    status: "save_failed",
    ...(patch?.evidenceIncomplete === true ? { evidenceIncomplete: true } : {}),
  };
  writeSessionFinalization(next, storage);
  return next;
}

export function markSessionFinalizationInProgress(
  selector: string,
  storage?: SessionStorage
): SessionFinalizationV1 | null {
  const existing = readSessionFinalization(selector, storage);
  if (!existing) return null;
  if (existing.status === "finalizing") return existing;
  const next: SessionFinalizationV1 = { ...existing, status: "finalizing" };
  writeSessionFinalization(next, storage);
  return next;
}

export function markSessionFinalizationEvidenceIncomplete(
  selector: string,
  storage?: SessionStorage
): SessionFinalizationV1 | null {
  const existing = readSessionFinalization(selector, storage);
  if (!existing) return null;
  if (existing.evidenceIncomplete === true && existing.status === "finalizing") return existing;
  const next: SessionFinalizationV1 = {
    ...existing,
    status: "finalizing",
    evidenceIncomplete: true,
  };
  writeSessionFinalization(next, storage);
  return next;
}

export function collectProtectedFreestyleSessionIds(
  storage?: SessionStorage,
  liveSessionId?: string | null
): string[] {
  const ids = new Set<string>();
  const sessionIdFromFinalization = readSessionFinalization(FREESTYLE_WORKOUT_SELECTOR_ID, storage)?.sessionId;
  if (sessionIdFromFinalization) ids.add(sessionIdFromFinalization);
  const owner = readActiveSessionOwner(storage);
  if (owner && isFreestyleWorkoutSelector(owner.selector)) ids.add(owner.sessionId);
  const fault = readFreestyleAuthorityFault(FREESTYLE_WORKOUT_SELECTOR_ID, storage);
  if (fault) ids.add(fault);
  if (typeof liveSessionId === "string" && liveSessionId.length > 0) {
    ids.add(liveSessionId);
  } else {
    const liveFromStorage = storageOrBrowser(storage).getItem(
      "session_id_" + FREESTYLE_WORKOUT_SELECTOR_ID
    );
    if (typeof liveFromStorage === "string" && liveFromStorage.length > 0) {
      ids.add(liveFromStorage);
    }
  }
  return [...ids];
}

export function countValidHrSampleSeconds(
  samples: readonly { hr?: number; timestamp_sec?: number }[]
): number {
  let count = 0;
  for (const sample of samples) {
    if (typeof sample.hr === "number" && Number.isFinite(sample.hr) && sample.hr > 0) {
      count += 1;
    }
  }
  return count;
}
