import type {
  Activity,
  AthleteFitnessSnapshot,
  HrTargetsForDay,
  PersonalizedPrescriptionEvaluationV1,
  PlanBlock,
  ResolvedWorkoutPrescription,
  WorkoutExecutionProvenanceV1,
  WorkoutMachineProvenanceV1,
} from "./types.js";
import { isActivity } from "./workoutActivity.js";
import {
  isValidVo2ProtocolRuntime,
  readPersistedVo2ProtocolRuntime,
  type Vo2ProtocolRuntime,
} from "./vo2Protocol.js";
import {
  isValidVo2ProtocolRuntimeV3,
  isVo2ProtocolRuntimeV3,
  parseVo2ProtocolRuntimeV3,
  type Vo2ProtocolRuntimeV3,
} from "./vo2ProtocolV3.js";
import { captureAthleteFitnessSnapshot, parseAthleteFitnessSnapshot } from "./fitnessState.js";
import {
  parsePersistedHrTargetsForDay,
  parseResolvedWorkoutPrescription,
  persistedHrTargetsFitBlocks,
} from "./workoutPrescription.js";
import { parsePersonalizedPrescriptionEvaluation } from "./personalizedPrescription.js";
import {
  captureWorkoutMachineProvenance,
  createInProgressExecutionProvenance,
  executionProvenanceKey,
  readInProgressExecutionProvenance,
  writeInProgressExecutionProvenance,
} from "./executionProvenance.js";
import { calibrationIdentityFromE1Snapshot, resolveWorkoutCalibrationMachine } from "./calibrationMachineProvenance.js";
import {
  clearFrozenSessionControlMode,
  freezeSessionControlMode,
  resolveSessionControlAuthority,
  sessionControlModeKey,
  type SessionControlAuthority,
  type SessionControlMode,
} from "./sessionControlMode.js";

const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Minimum phase-planning input captured at workout start for evidence replay. */
export interface PhasePlanSnapshot {
  blocks: PlanBlock;
  hrTargets: HrTargetsForDay | null;
  /** Versioned, frozen target resolution used by UI, guidance, evidence, and summary. */
  resolvedPrescription?: ResolvedWorkoutPrescription;
  /** Phase E1 shadow record. UI may project read-only advice; machine guidance never consumes it. */
  shadowPrescriptionEvaluation?: PersonalizedPrescriptionEvaluationV1;
}

export interface SessionData {
  startTime: string | null;
  sessionId: string | null;
  sessionStart: string | null;
  summaryEmitted: string | null;
  paused: boolean;
  pausedElapsed: number;
  /** Cumulative completed pause seconds (excludes an open pause). */
  pausedDurationSec: number;
  /** Wall-clock ms when the current pause began, if paused. */
  pauseWallStart: number | null;
  earlyCooldownElapsed: number | null;
  activity?: Activity;
  /** Stable owner for new sessions. Absent on legacy sessions. */
  athleteId?: string;
  /** Future resolver input pointer; Phase A does not consume it. */
  athleteFitnessSnapshot?: AthleteFitnessSnapshot;
  /** Blocks + HR targets frozen at workout start for phase evidence replay. */
  phasePlan: PhasePlanSnapshot | null;
  vo2ProtocolRuntime: Vo2ProtocolRuntime | Vo2ProtocolRuntimeV3 | null;
  /** A persisted protocol-v1 assessment must be restarted rather than resumed with v2 rules. */
  vo2ProtocolRestartRequired: boolean;
  blockedVo2ProtocolVersion?: number;
  /**
   * Start-time execution provenance for this session (frozen machine identity,
   * calibration machine provenance, captured actuation events). Null for legacy
   * sessions started without it; never reconstructed from current selection.
   */
  executionProvenance: WorkoutExecutionProvenanceV1 | null;
  /** Frozen runtime command authority, or the narrow pre-seam compatibility authority. */
  controlAuthority: SessionControlAuthority | null;
}

function storageOrBrowser(storage?: SessionStorage): SessionStorage {
  return storage ?? localStorage;
}

function parseStoredActivity(raw: string | null): Activity | undefined {
  return isActivity(raw) ? raw : undefined;
}

function earlyCooldownKey(day: string): string {
  return "early_cooldown_elapsed_" + day;
}

function pausedDurationKey(day: string): string {
  return "paused_duration_" + day;
}

function pauseWallStartKey(day: string): string {
  return "pause_wall_start_" + day;
}

function phasePlanKey(day: string): string {
  return "phase_plan_" + day;
}

function athleteIdKey(day: string): string {
  return "athlete_id_" + day;
}

function athleteFitnessSnapshotKey(day: string): string {
  return "athlete_fitness_snapshot_" + day;
}

function vo2ProtocolRuntimeKey(day: string): string {
  return "vo2_protocol_runtime_" + day;
}

function legacyVo2ProtocolPlanKey(day: string): string {
  return "vo2_protocol_plan_" + day;
}

function parseEarlyCooldownElapsed(raw: string | null): number | null {
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function parseNonNegativeInt(raw: string | null): number {
  const value = parseInt(raw || "0", 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseOptionalWallMs(raw: string | null): number | null {
  if (raw == null || raw === "") return null;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parsePhasePlan(raw: string | null): PhasePlanSnapshot | null {
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    const warm = Number(parsed?.blocks?.warm);
    const sustain = Number(parsed?.blocks?.sustain);
    const cool = Number(parsed?.blocks?.cool);
    if (![warm, sustain, cool].every((n) => Number.isFinite(n) && n >= 0)) return null;
    const blocks = { warm, sustain, cool };
    const parsedHrTargets = parsed?.hrTargets == null
      ? null
      : parsePersistedHrTargetsForDay(parsed.hrTargets);
    const hrTargets = parsedHrTargets && persistedHrTargetsFitBlocks(parsedHrTargets, blocks)
      ? parsedHrTargets
      : null;
    return {
      blocks,
      hrTargets,
      resolvedPrescription: parseResolvedWorkoutPrescription(parsed?.resolvedPrescription) ?? undefined,
      shadowPrescriptionEvaluation:
        parsePersonalizedPrescriptionEvaluation(parsed?.shadowPrescriptionEvaluation) ?? undefined,
    };
  } catch {
    return null;
  }
}

function parseStoredAthleteFitnessSnapshot(raw: string | null): AthleteFitnessSnapshot | undefined {
  if (!raw) return undefined;
  try {
    return parseAthleteFitnessSnapshot(JSON.parse(raw)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Total paused seconds including an open pause through `now`. */
export function totalPausedDurationSec(
  session: Pick<SessionData, "paused" | "pausedDurationSec" | "pauseWallStart">,
  now = Date.now()
): number {
  let total = session.pausedDurationSec;
  if (session.paused && session.pauseWallStart != null) {
    total += Math.max(0, Math.floor((now - session.pauseWallStart) / 1000));
  }
  return total;
}

export function getEarlyCooldownElapsed(day: string, storage?: SessionStorage): number | null {
  return parseEarlyCooldownElapsed(storageOrBrowser(storage).getItem(earlyCooldownKey(day)));
}

export function setEarlyCooldownElapsed(day: string, elapsedSec: number, storage?: SessionStorage): void {
  if (getEarlyCooldownElapsed(day, storage) != null) return;
  if (!Number.isFinite(elapsedSec) || elapsedSec < 0) return;
  storageOrBrowser(storage).setItem(earlyCooldownKey(day), String(Math.floor(elapsedSec)));
}

export function getSession(day: string, storage?: SessionStorage): SessionData {
  const store = storageOrBrowser(storage);
  const athleteFitnessSnapshot = parseStoredAthleteFitnessSnapshot(
    store.getItem(athleteFitnessSnapshotKey(day))
  );
  const storedAthleteId = store.getItem(athleteIdKey(day));
  const athleteId = athleteFitnessSnapshot && storedAthleteId === athleteFitnessSnapshot.athleteId
    ? storedAthleteId
    : undefined;
  const persistedVo2Runtime = (() => {
    const raw = store.getItem(vo2ProtocolRuntimeKey(day));
    if (!raw) return readPersistedVo2ProtocolRuntime(null);
    let parsedVo2: unknown = null;
    try {
      parsedVo2 = JSON.parse(raw);
    } catch {
      return readPersistedVo2ProtocolRuntime(null);
    }
    const persisted = readPersistedVo2ProtocolRuntime(parsedVo2);
    if (persisted.runtime || persisted.restartRequired) return persisted;
    const v3 = parseVo2ProtocolRuntimeV3(parsedVo2);
    if (v3) {
      return {
        runtime: v3,
        restartRequired: false,
        observedProtocolVersion: v3.plan.protocol_version,
      };
    }
    return persisted;
  })();
  const sessionId = store.getItem("session_id_" + day);
  const executionProvenance = readInProgressExecutionProvenance(day, store);
  const controlAuthority = resolveSessionControlAuthority(
    day,
    sessionId,
    persistedVo2Runtime.runtime !== null,
    store
  );
  return {
    startTime: store.getItem("start_" + day),
    sessionId,
    sessionStart: store.getItem("session_start_" + day),
    summaryEmitted: store.getItem("summary_emitted_" + day),
    paused: store.getItem("paused_" + day) === "true",
    pausedElapsed: parseInt(store.getItem("paused_elapsed_" + day) || "0", 10),
    pausedDurationSec: parseNonNegativeInt(store.getItem(pausedDurationKey(day))),
    pauseWallStart: parseOptionalWallMs(store.getItem(pauseWallStartKey(day))),
    earlyCooldownElapsed: parseEarlyCooldownElapsed(store.getItem(earlyCooldownKey(day))),
    activity: parseStoredActivity(store.getItem("activity_" + day)),
    athleteId,
    athleteFitnessSnapshot: athleteId ? athleteFitnessSnapshot : undefined,
    phasePlan: parsePhasePlan(store.getItem(phasePlanKey(day))),
    vo2ProtocolRuntime: persistedVo2Runtime.runtime,
    vo2ProtocolRestartRequired: persistedVo2Runtime.restartRequired,
    ...(persistedVo2Runtime.observedProtocolVersion != null && persistedVo2Runtime.restartRequired
      ? { blockedVo2ProtocolVersion: persistedVo2Runtime.observedProtocolVersion }
      : {}),
    executionProvenance: executionProvenance && executionProvenance.sessionId === sessionId ? executionProvenance : null,
    controlAuthority,
  };
}

export function startSession(
  day: string,
  startTime: number,
  sessionId?: string | null,
  activity?: Activity,
  storage?: SessionStorage,
  phasePlan?: PhasePlanSnapshot | null,
  athleteFitnessSnapshotOverride?: AthleteFitnessSnapshot,
  machineProvenanceOverride?: WorkoutMachineProvenanceV1,
  controlMode?: SessionControlMode
): void {
  const store = storageOrBrowser(storage);
  const previousSessionId = store.getItem("session_id_" + day);
  if (sessionId != null && controlMode && previousSessionId === sessionId && store.getItem(sessionControlModeKey(day)) != null) {
    // Validate a same-session retry before any session-owned state is cleared.
    freezeSessionControlMode(day, sessionId, controlMode, store);
  }
  store.removeItem(earlyCooldownKey(day));
  store.removeItem(pausedDurationKey(day));
  store.removeItem(pauseWallStartKey(day));
  store.removeItem("paused_" + day);
  store.removeItem("paused_elapsed_" + day);
  store.removeItem(phasePlanKey(day));
  store.removeItem(athleteIdKey(day));
  store.removeItem(athleteFitnessSnapshotKey(day));
  store.removeItem(legacyVo2ProtocolPlanKey(day));
  store.removeItem(vo2ProtocolRuntimeKey(day));
  store.removeItem(executionProvenanceKey(day));
  clearFrozenSessionControlMode(day, store);
  store.setItem("start_" + day, String(startTime));
  if (sessionId != null) {
    store.setItem("session_id_" + day, sessionId);
    store.setItem("session_start_" + day, String(startTime));
    store.setItem("summary_emitted_" + day, "false");
  }
  if (activity) store.setItem("activity_" + day, activity);
  else store.removeItem("activity_" + day);
  const athleteFitnessSnapshot = athleteFitnessSnapshotOverride ?? captureAthleteFitnessSnapshot(store);
  store.setItem(athleteIdKey(day), athleteFitnessSnapshot.athleteId);
  store.setItem(athleteFitnessSnapshotKey(day), JSON.stringify(athleteFitnessSnapshot));
  if (phasePlan?.blocks) {
    store.setItem(
      phasePlanKey(day),
      JSON.stringify({
        blocks: phasePlan.blocks,
        hrTargets: phasePlan.hrTargets ?? null,
        resolvedPrescription: phasePlan.resolvedPrescription,
        shadowPrescriptionEvaluation: phasePlan.shadowPrescriptionEvaluation,
      })
    );
  }
  if (sessionId != null) {
    if (controlMode) freezeSessionControlMode(day, sessionId, controlMode, store);
    // Freeze provenance once, at start. Reload reads it back; finalization never re-reads selection.
    const evaluation = phasePlan?.shadowPrescriptionEvaluation;
    const calibrationIdentity = evaluation
      ? calibrationIdentityFromE1Snapshot(evaluation.athleteId, evaluation.fitnessEvidenceSnapshot)
      : null;
    writeInProgressExecutionProvenance(day, createInProgressExecutionProvenance(
      sessionId,
      machineProvenanceOverride ?? captureWorkoutMachineProvenance(activity, store),
      resolveWorkoutCalibrationMachine(calibrationIdentity, store)
    ), store);
  }
}

export function pauseSession(
  day: string,
  elapsedSec: number,
  storage?: SessionStorage,
  now = Date.now()
): void {
  const store = storageOrBrowser(storage);
  store.setItem("paused_" + day, "true");
  store.setItem("paused_elapsed_" + day, String(elapsedSec));
  if (store.getItem(pauseWallStartKey(day)) == null) {
    store.setItem(pauseWallStartKey(day), String(now));
  }
}

export function resumeSession(day: string, storage?: SessionStorage, now = Date.now()): void {
  const store = storageOrBrowser(storage);
  const pausedElapsed = parseInt(store.getItem("paused_elapsed_" + day) || "0", 10);
  const pauseWallStart = parseOptionalWallMs(store.getItem(pauseWallStartKey(day)));
  if (pauseWallStart != null) {
    const add = Math.max(0, Math.floor((now - pauseWallStart) / 1000));
    const prev = parseNonNegativeInt(store.getItem(pausedDurationKey(day)));
    store.setItem(pausedDurationKey(day), String(prev + add));
  }
  const newStart = now - pausedElapsed * 1000;
  store.setItem("start_" + day, String(newStart));
  store.removeItem("paused_" + day);
  store.removeItem("paused_elapsed_" + day);
  store.removeItem(pauseWallStartKey(day));
}

export function clearSession(day: string, storage?: SessionStorage): void {
  const store = storageOrBrowser(storage);
  store.removeItem("start_" + day);
  store.removeItem("session_id_" + day);
  store.removeItem("session_start_" + day);
  store.removeItem("summary_emitted_" + day);
  store.removeItem("paused_" + day);
  store.removeItem("paused_elapsed_" + day);
  store.removeItem(pausedDurationKey(day));
  store.removeItem(pauseWallStartKey(day));
  store.removeItem(earlyCooldownKey(day));
  store.removeItem("activity_" + day);
  store.removeItem(phasePlanKey(day));
  store.removeItem(athleteIdKey(day));
  store.removeItem(athleteFitnessSnapshotKey(day));
  store.removeItem(executionProvenanceKey(day));
  clearFrozenSessionControlMode(day, store);
  store.removeItem(legacyVo2ProtocolPlanKey(day));
  store.removeItem(vo2ProtocolRuntimeKey(day));
}

export function persistVo2ProtocolRuntime(
  day: string,
  runtime: Vo2ProtocolRuntime | Vo2ProtocolRuntimeV3,
  storage?: SessionStorage
): void {
  const valid = isVo2ProtocolRuntimeV3(runtime)
    ? isValidVo2ProtocolRuntimeV3(runtime)
    : isValidVo2ProtocolRuntime(runtime);
  if (!valid) return;
  storageOrBrowser(storage).setItem(vo2ProtocolRuntimeKey(day), JSON.stringify(runtime));
}

export function markSummaryEmitted(day: string): void {
  localStorage.setItem("summary_emitted_" + day, "true");
}

export function isSessionStale(day: string): boolean {
  const sessionStart = localStorage.getItem("session_start_" + day);
  if (!sessionStart) return true;
  const sessionAge = Date.now() - parseInt(sessionStart);
  return sessionAge > MAX_SESSION_AGE_MS;
}
