import {
  defaultBikeBridgeStorage,
  loadBikeBridgeSettings,
  parseBikeBridgeBaseUrl,
  saveBikeBridgeSettings,
  type BikeBridgeSettings,
  type BikeBridgeStorage,
} from "./bikeBridgeConfig.js";
import { isSessionControlMode, type SessionControlMode } from "../sessionControlMode.js";
import {
  BIKE_BRIDGE_REQUEST_TIMEOUT_MS,
  createBikeBridgeClient,
  createDefaultBikeBridgeTransport,
  isBikeBridgeClientOk,
  isBikeBridgeUrlOk,
  toBridgeBrightness,
  toBridgeHeartRateBpm,
  toBridgeResistanceLevel,
  type BikeBridgeClient,
  type BikeBridgeClientResult,
  type BikeBridgeHttpTransport,
  type BikeTelemetry,
  type BridgeStatus,
  type ResistanceAcceptedResponse,
} from "./bikeBridgeClient.js";
import { getCurrentBpm } from "../hrMonitor.js";
import type { ResistanceActuationOriginV1, ResistanceActuationTriggerV1 } from "../types.js";

export const BIKE_BRIDGE_POLL_INTERVAL_MS = 1000;
export const FREESTYLE_RESISTANCE_LATCH_DEBOUNCE_MS = 2000;
export const FREESTYLE_HOLD_MISMATCH_CONFIRM_POLLS = 2;
export const FREESTYLE_HOLD_MIN_CORRECTION_SPACING_MS = 3000;
export const FREESTYLE_HOLD_MAX_CORRECTION_ATTEMPTS = 3;
export const FREESTYLE_HOLD_BACKOFF_MS = 5000;
export const FREESTYLE_HOLD_ACTIVE_PEDAL_RPM_MIN = 1;
export const FREESTYLE_HOLD_FAILURE_WINDOW_MS = 60_000;
export const FREESTYLE_HOLD_STABLE_CLEAR_MS = 20_000;

export type FreestyleResistanceHoldStatus =
  | "inactive"
  | "holding"
  | "released"
  | "unavailable"
  | "suspended";

export type BikeBridgeReadiness =
  | "not_configured"
  | "unreachable"
  | "reachable_disconnected"
  | "reachable_not_initialized"
  | "telemetry_ready"
  | "control_ready"
  | "invalid_response";

export type BikeBridgeLastCommandOutcome =
  | "accepted"
  | "failed"
  | "unavailable"
  | "timeout"
  | "unknown";

export interface BikeBridgeViewState {
  readiness: BikeBridgeReadiness;
  configuredUrl: string;
  automaticControlEnabled: boolean;
  consoleBrightness: number;
  controlAvailable: boolean;
  desiredResistance?: number;
  commandedResistance?: number;
  requestedResistance: number | null;
  observedResistance: number | null;
  observedResistanceCurrent: boolean;
  rpm: number | null;
  rpmCurrent: boolean;
  watts: number | null;
  wattsCurrent: boolean;
  telemetrySnapshotAt: string | null;
  telemetryReceivedAtMs: number | null;
  telemetryStale: boolean;
  lastError: string | null;
  lastCommandOutcome: BikeBridgeLastCommandOutcome | null;
  freestyleHoldStatus: FreestyleResistanceHoldStatus;
  freestyleHoldTarget: number | null;
}

export interface BikeBridgeGuidanceInput {
  desiredResistance?: number;
  recommendationChanged: boolean;
  workoutActive: boolean;
  paused: boolean;
  /** Who chose this recommendation; recorded on posted commands only. Never changes command behavior. */
  actuationOrigin?: ResistanceActuationOriginV1;
  /** Workout session that produced this guidance; provenance routing only. */
  workout?: BikeBridgeWorkoutContext;
}

export interface BikeBridgeWorkoutContext {
  day: string;
  sessionId: string;
}

/** One posted resistance command, reported at the actual actuation call site. */
export interface BikeBridgeActuationRequest {
  decisionId: string;
  origin: ResistanceActuationOriginV1;
  trigger: ResistanceActuationTriggerV1;
  requestedResistance: number;
  observedAtMs: number;
  /** Session whose guidance set the current desired resistance; never the UI's selected day. */
  workout?: BikeBridgeWorkoutContext;
}

export type BikeBridgeActuationOutcome = "accepted" | "failed" | "unavailable" | "timeout";

/** Provenance observer. Failures inside it never affect commands. */
export interface BikeBridgeActuationObserver {
  requested(request: BikeBridgeActuationRequest): unknown;
  resolved(token: unknown, outcome: BikeBridgeActuationOutcome): void;
}

/**
 * Identity and control authority for a session bound to this bridge instance.
 * Exported so callers (F1 lifecycle) can construct and pass it to bindSession().
 */
export interface BikeBridgeSessionBinding {
  sessionId: string;
  controlMode: SessionControlMode;
}

export interface BikeBridgeSessionOptions {
  storage?: BikeBridgeStorage;
  transport?: BikeBridgeHttpTransport;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  freestyleLatchDebounceMs?: number;
  freestyleHoldMismatchConfirmPolls?: number;
  freestyleHoldMinCorrectionSpacingMs?: number;
  freestyleHoldMaxCorrectionAttempts?: number;
  freestyleHoldBackoffMs?: number;
  freestyleHoldActivePedalRpmMin?: number;
  freestyleHoldFailureWindowMs?: number;
  freestyleHoldStableClearMs?: number;
  now?: () => number;
  /** Override live BPM source (defaults to hrMonitor.getCurrentBpm). */
  getCurrentBpm?: () => number | null;
}

export interface BikeBridgeSession {
  start(): void;
  stop(): void;
  isPolling(): boolean;
  getViewState(): BikeBridgeViewState;
  subscribe(listener: () => void): () => void;
  configure(settings: Partial<BikeBridgeSettings> & { baseUrl?: string }): { ok: boolean; error?: string };
  setConsoleBrightness(value: number): Promise<BikeBridgeClientResult<ResistanceAcceptedResponse>>;
  onGuidance(input: BikeBridgeGuidanceInput): void;
  postedResistanceBodies(): string[];
  setActuationObserver(observer: BikeBridgeActuationObserver | null): void;
  /**
   * Bind an owning session to this bridge. Pass null to explicitly disarm
   * (permanently blocks all resistance commands until a new session is bound).
   * Initial_unbound state is retained for legacy callers that never call bindSession.
   */
  bindSession(binding: BikeBridgeSessionBinding | null): void;
  /** Returns the currently bound session, or null if unbound or disarmed. */
  getSessionBinding(): BikeBridgeSessionBinding | null;
  /** True when explicitly disarmed via bindSession(null). */
  isDisarmed(): boolean;
  /**
   * Clear Freestyle hold target and disable latching/restoration until enableFreestyleHold().
   * Does not issue a synthetic zero command.
   */
  releaseFreestyleHold(): void;
  /**
   * Explicitly activate hold at the current fresh observed resistance (1-15).
   * Refuses when observed resistance is R0 or unavailable.
   */
  enableFreestyleHold(): { ok: true } | { ok: false; error: string };
}

function classifyReadiness(
  configured: boolean,
  status: BridgeStatus | null,
  pollKind: "ok" | "timeout" | "unreachable" | "http_error" | "malformed" | "not_configured" | null
): BikeBridgeReadiness {
  if (!configured) return "not_configured";
  if (pollKind === null) return "not_configured";
  if (pollKind === "malformed") return "invalid_response";
  if (!status) return "unreachable";
  if (!status.connected) return "reachable_disconnected";
  if (!status.initialized) return "reachable_not_initialized";
  if (status.resistanceControlAvailable) return "control_ready";
  return "telemetry_ready";
}

function formatMetric(value: number | null | undefined): number | null {
  return value === undefined ? null : value;
}

export function createBikeBridgeSession(options: BikeBridgeSessionOptions = {}): BikeBridgeSession {
  const storage = options.storage ?? defaultBikeBridgeStorage();
  const timeoutMs = options.requestTimeoutMs ?? BIKE_BRIDGE_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? BIKE_BRIDGE_POLL_INTERVAL_MS;
  const freestyleLatchDebounceMs = Math.max(
    0,
    options.freestyleLatchDebounceMs ?? FREESTYLE_RESISTANCE_LATCH_DEBOUNCE_MS
  );
  const freestyleHoldMismatchConfirmPolls = Math.max(
    1,
    Math.floor(options.freestyleHoldMismatchConfirmPolls ?? FREESTYLE_HOLD_MISMATCH_CONFIRM_POLLS)
  );
  const freestyleHoldMinCorrectionSpacingMs = Math.max(
    0,
    options.freestyleHoldMinCorrectionSpacingMs ?? FREESTYLE_HOLD_MIN_CORRECTION_SPACING_MS
  );
  const freestyleHoldMaxCorrectionAttempts = Math.max(
    1,
    Math.floor(options.freestyleHoldMaxCorrectionAttempts ?? FREESTYLE_HOLD_MAX_CORRECTION_ATTEMPTS)
  );
  const freestyleHoldBackoffMs = Math.max(
    0,
    options.freestyleHoldBackoffMs ?? FREESTYLE_HOLD_BACKOFF_MS
  );
  const freestyleHoldActivePedalRpmMin = Math.max(
    0,
    options.freestyleHoldActivePedalRpmMin ?? FREESTYLE_HOLD_ACTIVE_PEDAL_RPM_MIN
  );
  const freestyleHoldFailureWindowMs = Math.max(
    0,
    options.freestyleHoldFailureWindowMs ?? FREESTYLE_HOLD_FAILURE_WINDOW_MS
  );
  const freestyleHoldStableClearMs = Math.max(
    0,
    options.freestyleHoldStableClearMs ?? FREESTYLE_HOLD_STABLE_CLEAR_MS
  );
  const now = options.now ?? Date.now;
  const readBpm = options.getCurrentBpm ?? getCurrentBpm;
  const postedBodies: string[] = [];
  const baseTransport = options.transport ?? createDefaultBikeBridgeTransport();
  const transport: BikeBridgeHttpTransport = {
    async request(request) {
      if (
        request.method === "POST" &&
        request.jsonBody !== undefined &&
        typeof request.url === "string" &&
        request.url.includes("/api/v1/resistance")
      ) {
        postedBodies.push(JSON.stringify(request.jsonBody));
      }
      return baseTransport.request(request);
    },
  };
  const client: BikeBridgeClient = createBikeBridgeClient(
    () => loadBikeBridgeSettings(storage).baseUrl,
    transport,
    timeoutMs
  );

  let timer: ReturnType<typeof setInterval> | undefined;
  let pollInFlight = false;
  let sendInFlight = false;
  let pendingLevel: number | undefined;
  // Logical decision identity: one per recommendation change; re-sends reuse it.
  const decisionEpoch = Math.max(0, Math.floor(now())).toString(36);
  let decisionSeq = 0;
  let desiredDecision: { id: string; origin: ResistanceActuationOriginV1 } | undefined;
  let pendingTrigger: ResistanceActuationTriggerV1 = "decision";
  let actuationObserver: BikeBridgeActuationObserver | null = null;
  let guidanceWorkout: BikeBridgeWorkoutContext | undefined;
  let lastAccepted: number | undefined;
  let holdFailedLevel: number | undefined;
  let needsReconcile = false;
  let desiredResistance: number | undefined;
  let commandedResistance: number | undefined;
  let workoutActive = false;
  let paused = false;
  let lastStatus: BridgeStatus | null = null;
  let lastTelemetry: BikeTelemetry | null = null;
  let lastTelemetryReceivedAtMs: number | null = null;
  let telemetryStale = false;
  let lastError: string | null = null;
  let lastPollKind: "ok" | "timeout" | "unreachable" | "http_error" | "malformed" | "not_configured" | null = null;
  let lastCommandOutcome: BikeBridgeLastCommandOutcome | null = null;
  let previousControlAvailable = false;
  const listeners = new Set<() => void>();

  // Bridge binding state machine:
  //   initial_unbound - legacy compatibility; callers that never call bindSession work as before.
  //   disarmed        - bindSession(null); blocks all resistance commands until a new bind.
  //   bound           - explicit session. Freestyle blocks commands; controllable modes defer
  //                     to the existing canCommand() logic.
  type BridgeBindingState =
    | { type: "initial_unbound" }
    | { type: "disarmed" }
    | { type: "bound"; sessionId: string; controlMode: SessionControlMode };

  let bindingState: BridgeBindingState = { type: "initial_unbound" };

  // Authority generation, bumped on every effective bindSession change.
  // sendTarget captures it at dispatch; a stale completion still releases
  // the transport lock but must not touch the new session's bookkeeping.
  let bindingGeneration = 0;

  let freestyleLatchBaselineReady = false;
  let freestyleLatchBaselineLevel: number | null = null;
  let freestyleLatchCandidate: number | undefined;
  let freestyleLatchTimer: ReturnType<typeof setTimeout> | undefined;
  let freestyleQueued:
    | {
        level: number;
        trigger: ResistanceActuationTriggerV1;
        authority: "freestyle_latch" | "freestyle_hold";
      }
    | undefined;
  let freestyleLastDispatchedLatch: number | undefined;
  let freestyleHoldTarget: number | undefined;
  let freestyleHoldReleased = false;
  let freestyleHoldSuspended = false;
  let freestyleHoldMismatchPolls = 0;
  let freestyleHoldAwaitingLevel: number | undefined;
  let freestyleHoldAwaitingMissPolls = 0;
  let freestyleHoldLastCorrectionAtMs: number | undefined;
  let freestyleHoldFailureAtMs: number[] = [];
  let freestyleHoldStableSinceMs: number | undefined;

  function notify(): void {
    listeners.forEach((listener) => listener());
  }

  function isFreestyleBound(): boolean {
    return bindingState.type === "bound" && bindingState.controlMode === "manual_freestyle_ride";
  }

  function clearFreestyleHoldCorrectionState(): void {
    freestyleHoldMismatchPolls = 0;
    freestyleHoldAwaitingLevel = undefined;
    freestyleHoldAwaitingMissPolls = 0;
    if (freestyleQueued?.authority === "freestyle_hold") {
      freestyleQueued = undefined;
    }
  }

  function clearFreestyleHoldFailureBudget(): void {
    freestyleHoldFailureAtMs = [];
    freestyleHoldStableSinceMs = undefined;
  }

  function pruneFreestyleHoldFailures(atMs: number): void {
    if (freestyleHoldFailureWindowMs <= 0) {
      freestyleHoldFailureAtMs = [];
      return;
    }
    const cutoff = atMs - freestyleHoldFailureWindowMs;
    freestyleHoldFailureAtMs = freestyleHoldFailureAtMs.filter((stamp) => stamp >= cutoff);
  }

  function freestyleHoldFailureCount(atMs = now()): number {
    pruneFreestyleHoldFailures(atMs);
    return freestyleHoldFailureAtMs.length;
  }

  function recordFreestyleHoldFailure(): void {
    const atMs = now();
    freestyleHoldStableSinceMs = undefined;
    freestyleHoldFailureAtMs.push(atMs);
    pruneFreestyleHoldFailures(atMs);
    if (freestyleHoldFailureAtMs.length >= freestyleHoldMaxCorrectionAttempts) {
      freestyleHoldSuspended = true;
      clearFreestyleHoldCorrectionState();
    }
  }

  function clearFreestyleHoldTarget(): void {
    freestyleHoldTarget = undefined;
    freestyleHoldSuspended = false;
    freestyleHoldLastCorrectionAtMs = undefined;
    clearFreestyleHoldFailureBudget();
    clearFreestyleHoldCorrectionState();
  }

  function resetFreestyleLatchState(): void {
    if (freestyleLatchTimer !== undefined) {
      clearTimeout(freestyleLatchTimer);
      freestyleLatchTimer = undefined;
    }
    freestyleLatchBaselineReady = false;
    freestyleLatchBaselineLevel = null;
    freestyleLatchCandidate = undefined;
    freestyleQueued = undefined;
    freestyleLastDispatchedLatch = undefined;
    freestyleHoldReleased = false;
    clearFreestyleHoldTarget();
  }

  function cancelFreestyleLatchPending(): void {
    if (freestyleLatchTimer !== undefined) {
      clearTimeout(freestyleLatchTimer);
      freestyleLatchTimer = undefined;
    }
    freestyleLatchCandidate = undefined;
    if (freestyleQueued?.authority === "freestyle_latch") {
      freestyleQueued = undefined;
    }
  }

  function canFreestyleAuthorityCommand(): boolean {
    if (!isFreestyleBound()) return false;
    if (!configured()) return false;
    if (!workoutActive || paused) return false;
    if (telemetryStale) return false;
    if (!lastStatus?.connected || !lastStatus?.initialized) return false;
    if (!controlAvailable()) return false;
    return true;
  }

  function isActivelyPedaling(): boolean {
    const rpm = lastTelemetry?.rpm;
    if (!rpm || rpm.current !== true || rpm.value === null || rpm.value === undefined) return false;
    return rpm.value >= freestyleHoldActivePedalRpmMin;
  }

  function freestyleHoldStatusForView(): FreestyleResistanceHoldStatus {
    if (!isFreestyleBound() || !workoutActive) return "inactive";
    if (freestyleHoldReleased) return "released";
    if (freestyleHoldSuspended) return "suspended";
    if (freestyleHoldTarget === undefined) return "inactive";
    if (
      paused ||
      telemetryStale ||
      !lastStatus?.connected ||
      !lastStatus?.initialized ||
      !controlAvailable()
    ) {
      return "unavailable";
    }
    return "holding";
  }

  function settings(): BikeBridgeSettings {
    return loadBikeBridgeSettings(storage);
  }

  function configured(): boolean {
    return parseBikeBridgeBaseUrl(settings().baseUrl).ok;
  }

  function controlAvailable(): boolean {
    return lastStatus?.resistanceControlAvailable === true;
  }

  function canCommand(): boolean {
    // Explicit disarm permanently blocks until a new session is bound.
    if (bindingState.type === "disarmed") return false;
    // Freestyle blocks the structured guidance/reconcile command path.
    // Observed-change latching and hold restore use canFreestyleAuthorityCommand().
    if (bindingState.type === "bound" && bindingState.controlMode === "manual_freestyle_ride") return false;
    return (
      configured() &&
      settings().automaticControlEnabled &&
      workoutActive &&
      !paused &&
      controlAvailable()
    );
  }

  function requestedForView(): number | null {
    if (lastStatus && lastStatus.resistance.requested !== null) return lastStatus.resistance.requested;
    if (lastCommandOutcome === "accepted" && lastAccepted !== undefined) return lastAccepted;
    return lastStatus?.resistance.requested ?? null;
  }

  function viewState(): BikeBridgeViewState {
    const current = settings();
    const readiness = classifyReadiness(configured(), lastStatus, lastPollKind);
    return {
      readiness,
      configuredUrl: current.baseUrl,
      automaticControlEnabled: current.automaticControlEnabled,
      consoleBrightness: current.consoleBrightness,
      controlAvailable: controlAvailable(),
      desiredResistance,
      commandedResistance,
      requestedResistance: requestedForView(),
      observedResistance: formatMetric(lastTelemetry?.resistance.value),
      observedResistanceCurrent: lastTelemetry?.resistance.current === true,
      rpm: formatMetric(lastTelemetry?.rpm.value),
      rpmCurrent: lastTelemetry?.rpm.current === true,
      watts: formatMetric(lastTelemetry?.watts.value),
      wattsCurrent: lastTelemetry?.watts.current === true,
      telemetrySnapshotAt: lastTelemetry?.snapshotAt ?? null,
      telemetryReceivedAtMs: lastTelemetryReceivedAtMs,
      telemetryStale,
      lastError,
      lastCommandOutcome,
      freestyleHoldStatus: freestyleHoldStatusForView(),
      freestyleHoldTarget: freestyleHoldTarget ?? null,
    };
  }

  function scheduleSend(
    level: number | undefined,
    force = false,
    trigger: ResistanceActuationTriggerV1 = "reconciliation_resend"
  ): void {
    const target = level === undefined ? undefined : toBridgeResistanceLevel(level);
    if (target === undefined || !canCommand()) return;
    if (!force && lastAccepted === target) return;
    if (!force && holdFailedLevel === target) return;
    if (sendInFlight) {
      pendingLevel = target;
      pendingTrigger = trigger;
      return;
    }
    void sendTarget(target, trigger, "structured");
  }

  function observeRequest(
    target: number,
    trigger: ResistanceActuationTriggerV1,
    origin: ResistanceActuationOriginV1,
    decisionId: string
  ): unknown {
    if (!actuationObserver) return undefined;
    try {
      return actuationObserver.requested({
        decisionId,
        origin,
        trigger,
        requestedResistance: target,
        observedAtMs: now(),
        ...(guidanceWorkout ? { workout: { ...guidanceWorkout } } : {}),
      });
    } catch {
      return undefined;
    }
  }

  function observeOutcome(token: unknown, outcome: BikeBridgeActuationOutcome): void {
    if (!actuationObserver || token === undefined) return;
    try {
      actuationObserver.resolved(token, outcome);
    } catch {
      // Provenance capture must never affect resistance commands.
    }
  }

  async function sendTarget(
    target: number,
    trigger: ResistanceActuationTriggerV1,
    authority: "structured" | "freestyle_latch" | "freestyle_hold"
  ): Promise<void> {
    if (sendInFlight) {
      if (authority === "structured") {
        pendingLevel = target;
        pendingTrigger = trigger;
      } else if (authority === "freestyle_latch") {
        freestyleQueued = { level: target, trigger, authority };
      } else if (!freestyleQueued || freestyleQueued.authority !== "freestyle_latch") {
        freestyleQueued = { level: target, trigger, authority };
      }
      return;
    }
    if (authority === "structured") {
      if (!canCommand()) {
        pendingLevel = undefined;
        return;
      }
    } else if (!canFreestyleAuthorityCommand()) {
      freestyleQueued = undefined;
      return;
    } else if (authority === "freestyle_hold") {
      if (freestyleHoldReleased || freestyleHoldSuspended || freestyleHoldTarget !== target) {
        if (freestyleQueued?.authority === "freestyle_hold") freestyleQueued = undefined;
        return;
      }
    }
    const generation = bindingGeneration;
    const origin: ResistanceActuationOriginV1 =
      authority === "freestyle_latch"
        ? "freestyle_observed_resistance_latch"
        : authority === "freestyle_hold"
          ? "freestyle_resistance_hold_restore"
          : desiredDecision?.origin ?? "unclassified";
    const decisionId =
      authority === "freestyle_latch"
        ? decisionEpoch + "-fl-" + (++decisionSeq)
        : authority === "freestyle_hold"
          ? decisionEpoch + "-fh-" + (++decisionSeq)
          : desiredDecision?.id ?? decisionEpoch + "-0";
    sendInFlight = true;
    pendingLevel = undefined;
    freestyleQueued = undefined;
    commandedResistance = target;
    if (authority === "freestyle_hold") {
      freestyleHoldLastCorrectionAtMs = now();
      freestyleHoldStableSinceMs = undefined;
    }
    const token = observeRequest(target, trigger, origin, decisionId);
    let outcome: BikeBridgeActuationOutcome = "failed";
    try {
      const result = await client.setResistance(target);
      if (generation !== bindingGeneration) {
        if (isBikeBridgeClientOk(result)) outcome = "accepted";
        else if (result.kind === "timeout") outcome = "timeout";
        else if (result.status === 503 || result.kind === "unreachable") outcome = "unavailable";
      } else if (isBikeBridgeClientOk(result)) {
        lastAccepted = result.value.requested;
        holdFailedLevel = undefined;
        lastCommandOutcome = "accepted";
        outcome = "accepted";
        lastError = null;
        if (authority === "freestyle_hold") {
          freestyleHoldAwaitingLevel = target;
          freestyleHoldAwaitingMissPolls = 0;
        }
        if (lastStatus) {
          lastStatus = {
            ...lastStatus,
            resistance: {
              ...lastStatus.resistance,
              requested: result.value.requested,
            },
          };
        }
      } else if (result.kind === "timeout") {
        lastCommandOutcome = "timeout";
        outcome = "timeout";
        lastError = "resistance command timed out";
        holdFailedLevel = target;
        if (authority === "freestyle_hold") {
          freestyleHoldAwaitingLevel = undefined;
          recordFreestyleHoldFailure();
        }
      } else if (result.status === 503 || result.kind === "unreachable") {
        lastCommandOutcome = "unavailable";
        outcome = "unavailable";
        lastError = result.message;
        holdFailedLevel = target;
        if (authority === "freestyle_hold") {
          freestyleHoldAwaitingLevel = undefined;
          recordFreestyleHoldFailure();
        }
      } else {
        lastCommandOutcome = "failed";
        lastError = result.message;
        holdFailedLevel = target;
        if (authority === "freestyle_hold") {
          freestyleHoldAwaitingLevel = undefined;
          recordFreestyleHoldFailure();
        }
      }
    } finally {
      sendInFlight = false;
      observeOutcome(token, outcome);
      notify();
      if (pendingLevel !== undefined && canCommand()) {
        const next = pendingLevel;
        pendingLevel = undefined;
        scheduleSend(next, false, pendingTrigger);
      } else {
        pendingLevel = undefined;
        if (freestyleQueued && canFreestyleAuthorityCommand()) {
          const next = freestyleQueued;
          freestyleQueued = undefined;
          void sendTarget(next.level, next.trigger, next.authority);
        } else {
          freestyleQueued = undefined;
        }
      }
    }
  }

  function armFreestyleLatch(level: number): void {
    if (freestyleHoldReleased) return;
    clearFreestyleHoldCorrectionState();
    if (freestyleLatchTimer !== undefined) {
      clearTimeout(freestyleLatchTimer);
      freestyleLatchTimer = undefined;
    }
    freestyleLatchCandidate = level;
    freestyleLatchTimer = setTimeout(() => {
      freestyleLatchTimer = undefined;
      void dispatchFreestyleLatch(level);
    }, freestyleLatchDebounceMs);
  }

  function adoptFreestyleHoldTarget(target: number): void {
    freestyleHoldTarget = target;
    freestyleHoldReleased = false;
    freestyleHoldSuspended = false;
    freestyleHoldLastCorrectionAtMs = undefined;
    clearFreestyleHoldFailureBudget();
    clearFreestyleHoldCorrectionState();
    freestyleLastDispatchedLatch = target;
    freestyleLatchBaselineLevel = target;
  }

  async function dispatchFreestyleLatch(level: number): Promise<void> {
    if (freestyleLatchCandidate !== level) return;
    freestyleLatchCandidate = undefined;
    if (freestyleHoldReleased) return;
    if (!canFreestyleAuthorityCommand()) return;
    const observed = lastTelemetry?.resistance;
    if (
      !observed ||
      observed.current !== true ||
      observed.value === null ||
      observed.value === undefined ||
      observed.value !== level
    ) {
      return;
    }
    const target = toBridgeResistanceLevel(level);
    if (target === undefined) return;
    if (freestyleLastDispatchedLatch === target && freestyleHoldTarget === target) {
      freestyleLatchBaselineLevel = target;
      return;
    }
    adoptFreestyleHoldTarget(target);
    await sendTarget(target, "observed_change_latch", "freestyle_latch");
  }

  function spacingElapsedForHoldCorrection(): boolean {
    if (freestyleHoldLastCorrectionAtMs === undefined) return true;
    const elapsed = now() - freestyleHoldLastCorrectionAtMs;
    const needBackoff =
      freestyleHoldFailureCount() > 0 && freestyleHoldAwaitingLevel === undefined;
    const required = needBackoff
      ? Math.max(freestyleHoldMinCorrectionSpacingMs, freestyleHoldBackoffMs)
      : freestyleHoldMinCorrectionSpacingMs;
    return elapsed >= required;
  }

  function maybeRestoreFreestyleHold(): void {
    freestyleHoldStableSinceMs = undefined;
    if (!canFreestyleAuthorityCommand()) return;
    if (freestyleHoldReleased || freestyleHoldSuspended) return;
    if (freestyleHoldTarget === undefined) return;
    if (freestyleLatchCandidate !== undefined) return;
    if (!isActivelyPedaling()) {
      freestyleHoldMismatchPolls = 0;
      return;
    }
    if (freestyleHoldAwaitingLevel !== undefined) {
      freestyleHoldAwaitingMissPolls += 1;
      if (
        freestyleHoldAwaitingMissPolls >= freestyleHoldMismatchConfirmPolls &&
        spacingElapsedForHoldCorrection()
      ) {
        freestyleHoldAwaitingLevel = undefined;
        freestyleHoldAwaitingMissPolls = 0;
        recordFreestyleHoldFailure();
        if (freestyleHoldSuspended) return;
      } else {
        return;
      }
    }
    freestyleHoldMismatchPolls += 1;
    if (freestyleHoldMismatchPolls < freestyleHoldMismatchConfirmPolls) return;
    if (!spacingElapsedForHoldCorrection()) return;
    if (freestyleHoldFailureCount() >= freestyleHoldMaxCorrectionAttempts) {
      freestyleHoldSuspended = true;
      clearFreestyleHoldCorrectionState();
      return;
    }
    freestyleHoldMismatchPolls = 0;
    void sendTarget(freestyleHoldTarget, "unexpected_zero_restore", "freestyle_hold");
  }

  function noteFreestyleHoldObservation(value: number): void {
    if (freestyleHoldTarget === undefined) return;
    if (value !== freestyleHoldTarget) {
      freestyleHoldStableSinceMs = undefined;
      return;
    }
    freestyleHoldMismatchPolls = 0;
    if (freestyleHoldAwaitingLevel === value) {
      freestyleHoldAwaitingLevel = undefined;
      freestyleHoldAwaitingMissPolls = 0;
    }
    const atMs = now();
    if (freestyleHoldStableSinceMs === undefined) {
      freestyleHoldStableSinceMs = atMs;
      return;
    }
    if (
      freestyleHoldFailureAtMs.length > 0 &&
      atMs - freestyleHoldStableSinceMs >= freestyleHoldStableClearMs
    ) {
      freestyleHoldFailureAtMs = [];
    }
  }

  function updateFreestyleLatchFromTelemetry(): void {
    if (!isFreestyleBound()) return;
    if (!workoutActive || paused) {
      cancelFreestyleLatchPending();
      clearFreestyleHoldTarget();
      return;
    }
    if (!lastStatus?.connected || !lastStatus?.initialized || !controlAvailable()) {
      cancelFreestyleLatchPending();
      clearFreestyleHoldTarget();
      return;
    }
    if (telemetryStale || !lastTelemetry) {
      cancelFreestyleLatchPending();
      clearFreestyleHoldCorrectionState();
      return;
    }
    const observed = lastTelemetry.resistance;
    if (!observed || observed.current !== true || observed.value === null || observed.value === undefined) {
      cancelFreestyleLatchPending();
      clearFreestyleHoldCorrectionState();
      return;
    }
    const value = observed.value;
    if (!freestyleLatchBaselineReady) {
      freestyleLatchBaselineReady = true;
      freestyleLatchBaselineLevel = value;
      return;
    }
    if (freestyleHoldReleased) {
      cancelFreestyleLatchPending();
      if (value === 0) {
        freestyleLatchBaselineLevel = 0;
        return;
      }
      if (Number.isInteger(value) && value >= 1 && value <= 15) {
        freestyleLatchBaselineLevel = value;
      }
      return;
    }
    if (value === 0) {
      cancelFreestyleLatchPending();
      freestyleLatchBaselineLevel = 0;
      maybeRestoreFreestyleHold();
      return;
    }
    if (!Number.isInteger(value) || value < 1 || value > 15) {
      cancelFreestyleLatchPending();
      clearFreestyleHoldCorrectionState();
      return;
    }
    noteFreestyleHoldObservation(value);
    if (value === freestyleLatchBaselineLevel) {
      if (freestyleLatchCandidate === value) {
        cancelFreestyleLatchPending();
      }
      return;
    }
    if (value === freestyleHoldTarget || value === freestyleLastDispatchedLatch) {
      freestyleLatchBaselineLevel = value;
      cancelFreestyleLatchPending();
      clearFreestyleHoldCorrectionState();
      return;
    }
    if (freestyleLatchCandidate === value) return;
    armFreestyleLatch(value);
  }

  async function mirrorHeartRate(): Promise<void> {
    // Presentation-only: never touches lastError, resistance, guidance, or poll kind.
    if (!configured()) return;
    const raw = readBpm();
    if (raw === null || raw === undefined) return;
    const bpm = toBridgeHeartRateBpm(raw);
    if (bpm === undefined) return;
    try {
      await client.postHeartRate(bpm);
    } catch {
      // ignore
    }
  }

  async function pushConsoleBrightness(
    value?: number
  ): Promise<BikeBridgeClientResult<ResistanceAcceptedResponse>> {
    const level = toBridgeBrightness(value ?? settings().consoleBrightness);
    if (level === undefined) {
      return { ok: false, kind: "malformed", message: "value must be an integer from 0 to 100" };
    }
    if (!configured()) {
      return { ok: false, kind: "not_configured", message: "missing url" };
    }
    try {
      return await client.setBrightness(level);
    } catch {
      return { ok: false, kind: "unreachable", message: "unreachable" };
    }
  }

  async function tick(): Promise<void> {
    if (pollInFlight) return;
    if (!configured()) {
      lastPollKind = "not_configured";
      lastStatus = null;
      notify();
      return;
    }
    pollInFlight = true;
    try {
      const previousKind = lastPollKind;
      const statusResult = await client.getStatus();
      if (isBikeBridgeClientOk(statusResult)) {
        lastStatus = statusResult.value;
        lastPollKind = "ok";
        if (statusResult.value.resistanceControlAvailable && lastCommandOutcome === "accepted") {
          lastError = null;
        }
      } else {
        lastPollKind = statusResult.kind === "not_configured" ? "not_configured" : statusResult.kind;
        lastStatus = null;
        lastError = statusResult.message;
      }

      const telemetryResult = await client.getTelemetry();
      if (isBikeBridgeClientOk(telemetryResult)) {
        lastTelemetry = telemetryResult.value;
        lastTelemetryReceivedAtMs = now();
        telemetryStale = false;
      } else if (lastTelemetry) {
        telemetryStale = true;
        if (!isBikeBridgeClientOk(statusResult)) lastError = telemetryResult.message;
      } else {
        telemetryStale = true;
        if (!isBikeBridgeClientOk(statusResult)) lastError = telemetryResult.message;
      }

      const available = controlAvailable();
      if (isBikeBridgeClientOk(statusResult) && available) {
        const recoveredFromLoss =
          previousKind === "unreachable" ||
          previousKind === "timeout" ||
          previousKind === "http_error" ||
          previousKind === "malformed";
        const controlAppeared = !previousControlAvailable && previousKind === "ok";
        const target = desiredResistance === undefined ? undefined : toBridgeResistanceLevel(desiredResistance);
        if ((recoveredFromLoss || controlAppeared) && target !== undefined && lastAccepted !== target) {
          needsReconcile = true;
        }
      }
      previousControlAvailable = available;
      if (needsReconcile && canCommand()) {
        needsReconcile = false;
        holdFailedLevel = undefined;
        scheduleSend(desiredResistance, true);
      }
      updateFreestyleLatchFromTelemetry();
    } finally {
      pollInFlight = false;
      void mirrorHeartRate();
      notify();
    }
  }

  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void tick();
      }, pollIntervalMs);
      void tick();
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      cancelFreestyleLatchPending();
      clearFreestyleHoldCorrectionState();
    },
    isPolling() {
      return timer !== undefined;
    },
    getViewState() {
      return viewState();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    configure(partial) {
      const current = settings();
      let baseUrl = current.baseUrl;
      const nextBrightness =
        partial.consoleBrightness !== undefined ? partial.consoleBrightness : current.consoleBrightness;
      if (partial.baseUrl !== undefined) {
        const trimmed = partial.baseUrl.trim();
        if (!trimmed) {
          saveBikeBridgeSettings(
            {
              baseUrl: "",
              automaticControlEnabled:
                partial.automaticControlEnabled !== undefined
                  ? partial.automaticControlEnabled
                  : current.automaticControlEnabled,
              consoleBrightness: nextBrightness,
            },
            storage
          );
          lastStatus = null;
          lastTelemetry = null;
          lastTelemetryReceivedAtMs = null;
          lastPollKind = "not_configured";
          lastError = null;
          notify();
          return { ok: true };
        }
        const parsed = parseBikeBridgeBaseUrl(partial.baseUrl);
        if (!isBikeBridgeUrlOk(parsed)) return { ok: false, error: parsed.error };
        baseUrl = parsed.normalized;
      }
      const nextEnabled =
        partial.automaticControlEnabled !== undefined
          ? partial.automaticControlEnabled
          : current.automaticControlEnabled;
      const enabledChanged = nextEnabled !== current.automaticControlEnabled;
      const urlChanged = baseUrl !== current.baseUrl;
      if (urlChanged) {
        lastStatus = null;
        lastTelemetry = null;
        lastTelemetryReceivedAtMs = null;
        lastAccepted = undefined;
        holdFailedLevel = undefined;
        telemetryStale = false;
        lastPollKind = null;
        lastError = null;
      }
      saveBikeBridgeSettings(
        {
          baseUrl,
          automaticControlEnabled: nextEnabled,
          consoleBrightness: nextBrightness,
        },
        storage
      );
      if (enabledChanged && !nextEnabled) pendingLevel = undefined;
      if (enabledChanged && nextEnabled) {
        holdFailedLevel = undefined;
        needsReconcile = true;
        // Only dispatch if session authority permits. Freestyle or disarmed bindings
        // must not receive a resistance command when the user toggles the global setting.
        if (canCommand() && desiredResistance !== undefined) {
          scheduleSend(desiredResistance, true);
        }
      }
      notify();
      return { ok: true };
    },
    async setConsoleBrightness(value) {
      const level = toBridgeBrightness(value);
      if (level === undefined) {
        return {
          ok: false,
          kind: "malformed",
          message: "value must be an integer from 0 to 100",
        };
      }
      const current = settings();
      saveBikeBridgeSettings(
        {
          baseUrl: current.baseUrl,
          automaticControlEnabled: current.automaticControlEnabled,
          consoleBrightness: level,
        },
        storage
      );
      notify();
      return pushConsoleBrightness(level);
    },
    onGuidance(input) {
      // --- Session authority guards ---
      // Disarmed: no commands, but allow workoutActive/paused flags to update
      // for correct view-state rendering. Resistance-setting paths are blocked by canCommand().
      if (bindingState.type === "disarmed") {
        workoutActive = input.workoutActive;
        paused = input.paused;
        pendingLevel = undefined;
        notify();
        return;
      }
      // Bound sessions require matching identity. Missing or foreign
      // workout identity never authorizes commands or touches live state.
      if (bindingState.type === "bound") {
        if (input.workout === undefined || input.workout.sessionId !== bindingState.sessionId) return;
      }
      // Freestyle binding: observation + latch/hold only.
      // Structured guidance/reconcile command paths stay suppressed.
      if (bindingState.type === "bound" && bindingState.controlMode === "manual_freestyle_ride") {
        workoutActive = input.workoutActive;
        paused = input.paused;
        desiredResistance = undefined;
        pendingLevel = undefined;
        needsReconcile = false;
        if (input.workoutActive) {
          guidanceWorkout = input.workout ? { ...input.workout } : guidanceWorkout;
        }
        if (input.paused) {
          cancelFreestyleLatchPending();
          clearFreestyleHoldTarget();
          freestyleHoldReleased = false;
        }
        if (!input.workoutActive) {
          resetFreestyleLatchState();
          commandedResistance = undefined;
        }
        notify();
        return;
      }

      // --- Existing structured workout logic (unchanged) ---
      const wasActive = workoutActive;
      const wasPaused = paused;
      workoutActive = input.workoutActive;
      paused = input.paused;
      desiredResistance = input.desiredResistance;
      if (input.workoutActive) guidanceWorkout = input.workout ? { ...input.workout } : undefined;
      if (input.workoutActive && input.recommendationChanged) {
        decisionSeq += 1;
        desiredDecision = { id: decisionEpoch + "-" + decisionSeq, origin: input.actuationOrigin ?? "unclassified" };
      }
      if (!input.workoutActive) {
        pendingLevel = undefined;
        lastAccepted = undefined;
        holdFailedLevel = undefined;
        needsReconcile = false;
        commandedResistance = undefined;
        notify();
        return;
      }
      if (!wasActive) {
        lastAccepted = undefined;
        holdFailedLevel = undefined;
        needsReconcile = true;
      }
      if (input.paused) {
        pendingLevel = undefined;
        notify();
        return;
      }
      if (wasPaused) {
        holdFailedLevel = undefined;
        needsReconcile = false;
        scheduleSend(input.desiredResistance, true);
        notify();
        return;
      }
      if (input.recommendationChanged) {
        holdFailedLevel = undefined;
        needsReconcile = false;
        scheduleSend(input.desiredResistance, true, "decision");
      } else if (needsReconcile) {
        holdFailedLevel = undefined;
        needsReconcile = false;
        scheduleSend(input.desiredResistance, true);
      }
      notify();
    },
    postedResistanceBodies() {
      return [...postedBodies];
    },
    setActuationObserver(observer) {
      actuationObserver = observer;
    },
    bindSession(binding) {
      if (binding === null) {
        if (bindingState.type === "disarmed") return;
        bindingGeneration += 1;
        bindingState = { type: "disarmed" };
        desiredResistance = undefined;
        pendingLevel = undefined;
        needsReconcile = false;
        commandedResistance = undefined;
        guidanceWorkout = undefined;
        holdFailedLevel = undefined;
        resetFreestyleLatchState();
        notify();
        return;
      }
      if (
        typeof binding.sessionId !== "string" ||
        binding.sessionId.length === 0 ||
        !isSessionControlMode(binding.controlMode)
      ) {
        throw new Error("Invalid session binding");
      }
      if (bindingState.type === "bound" && bindingState.sessionId === binding.sessionId) {
        if (bindingState.controlMode !== binding.controlMode) {
          throw new Error("Session binding is already frozen with a conflicting control mode");
        }
        return;
      }
      bindingGeneration += 1;
      bindingState = { type: "bound", sessionId: binding.sessionId, controlMode: binding.controlMode };
      desiredResistance = undefined;
      pendingLevel = undefined;
      needsReconcile = false;
      commandedResistance = undefined;
      holdFailedLevel = undefined;
      lastAccepted = undefined;
      guidanceWorkout = { day: "", sessionId: binding.sessionId };
      resetFreestyleLatchState();
      notify();
    },
    getSessionBinding() {
      if (bindingState.type === "bound") {
        return { sessionId: bindingState.sessionId, controlMode: bindingState.controlMode };
      }
      return null;
    },
    isDisarmed() {
      return bindingState.type === "disarmed";
    },
    releaseFreestyleHold() {
      cancelFreestyleLatchPending();
      clearFreestyleHoldTarget();
      freestyleHoldReleased = true;
      freestyleQueued = undefined;
      freestyleLastDispatchedLatch = undefined;
      notify();
    },
    enableFreestyleHold() {
      if (!isFreestyleBound()) {
        return { ok: false as const, error: "Freestyle hold is unavailable" };
      }
      if (!workoutActive || paused) {
        return { ok: false as const, error: "Start or resume Freestyle to enable hold" };
      }
      if (
        telemetryStale ||
        !lastTelemetry ||
        !lastStatus?.connected ||
        !lastStatus?.initialized ||
        !controlAvailable()
      ) {
        return { ok: false as const, error: "Fresh bike telemetry is required to enable hold" };
      }
      const observed = lastTelemetry.resistance;
      if (!observed || observed.current !== true || observed.value === null || observed.value === undefined) {
        return { ok: false as const, error: "Fresh bike telemetry is required to enable hold" };
      }
      if (observed.value === 0) {
        return {
          ok: false as const,
          error: "Enable hold requires a rider-selectable resistance (R1–R15)",
        };
      }
      const target = toBridgeResistanceLevel(observed.value);
      if (target === undefined) {
        return {
          ok: false as const,
          error: "Enable hold requires a rider-selectable resistance (R1–R15)",
        };
      }
      if (!canFreestyleAuthorityCommand()) {
        return { ok: false as const, error: "Freestyle hold is unavailable" };
      }
      adoptFreestyleHoldTarget(target);
      void sendTarget(target, "observed_change_latch", "freestyle_latch");
      notify();
      return { ok: true as const };
    },
  };
}

let appSession: BikeBridgeSession | undefined;

export function getBikeBridgeSession(): BikeBridgeSession {
  if (!appSession) appSession = createBikeBridgeSession();
  return appSession;
}

/** Test-only seam so F1 lifecycle can assert against a mocked bridge transport. */
export function setBikeBridgeSessionForTests(session: BikeBridgeSession | null): void {
  appSession = session ?? undefined;
}

export function startBikeBridgeRuntime(): void {
  getBikeBridgeSession().start();
}

export function formatBikeBridgeNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : String(value);
}

export function formatBikeBridgeReadiness(readiness: BikeBridgeReadiness): string {
  switch (readiness) {
    case "not_configured":
      return "Not configured";
    case "unreachable":
      return "Unreachable";
    case "reachable_disconnected":
      return "Bike disconnected";
    case "reachable_not_initialized":
      return "Bike not initialized";
    case "telemetry_ready":
      return "Connected";
    case "control_ready":
      return "Connected";
    case "invalid_response":
      return "Invalid response";
    default:
      return "Unreachable";
  }
}

export function formatBikeBridgeControl(state: Pick<BikeBridgeViewState, "automaticControlEnabled" | "controlAvailable">): string {
  if (!state.automaticControlEnabled) return "Disabled";
  return state.controlAvailable ? "Ready" : "Unavailable";
}
