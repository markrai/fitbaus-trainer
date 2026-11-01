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

  function notify(): void {
    listeners.forEach((listener) => listener());
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
    // Freestyle binding is observation-only: no resistance commands.
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
    void sendTarget(target, trigger);
  }

  function observeRequest(target: number, trigger: ResistanceActuationTriggerV1): unknown {
    if (!actuationObserver) return undefined;
    try {
      return actuationObserver.requested({
        decisionId: desiredDecision?.id ?? decisionEpoch + "-0",
        origin: desiredDecision?.origin ?? "unclassified",
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

  async function sendTarget(target: number, trigger: ResistanceActuationTriggerV1): Promise<void> {
    if (sendInFlight) {
      pendingLevel = target;
      pendingTrigger = trigger;
      return;
    }
    // Re-check authority at the actual HTTP dispatch boundary. If Freestyle
    // binding was established while a send was queued, discard without firing.
    if (!canCommand()) {
      pendingLevel = undefined;
      return;
    }
    const generation = bindingGeneration;
    sendInFlight = true;
    pendingLevel = undefined;
    commandedResistance = target;
    const token = observeRequest(target, trigger);
    let outcome: BikeBridgeActuationOutcome = "failed";
    try {
      const result = await client.setResistance(target);
      if (generation !== bindingGeneration) {
        // Stale completion: the bridge was rebound while this request was in
        // flight. The hardware may still execute it, but it must not mutate
        // the new session's command bookkeeping.
        if (isBikeBridgeClientOk(result)) outcome = "accepted";
        else if (result.kind === "timeout") outcome = "timeout";
        else if (result.status === 503 || result.kind === "unreachable") outcome = "unavailable";
      } else if (isBikeBridgeClientOk(result)) {
        lastAccepted = result.value.requested;
        holdFailedLevel = undefined;
        lastCommandOutcome = "accepted";
        outcome = "accepted";
        lastError = null;
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
      } else if (result.status === 503 || result.kind === "unreachable") {
        lastCommandOutcome = "unavailable";
        outcome = "unavailable";
        lastError = result.message;
        holdFailedLevel = target;
      } else {
        lastCommandOutcome = "failed";
        lastError = result.message;
        holdFailedLevel = target;
      }
    } finally {
      sendInFlight = false;
      observeOutcome(token, outcome);
      notify();
      // Only reschedule a pending level if we still have authority to command.
      // This prevents a Freestyle binding established during a now-completed
      // in-flight HTTP request from triggering another command.
      if (pendingLevel !== undefined && canCommand()) {
        const next = pendingLevel;
        pendingLevel = undefined;
        scheduleSend(next, false, pendingTrigger);
      } else {
        pendingLevel = undefined;
      }
    }
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
      // Freestyle binding: allow telemetry/state updates; suppress all command paths.
      if (bindingState.type === "bound" && bindingState.controlMode === "manual_freestyle_ride") {
        workoutActive = input.workoutActive;
        paused = input.paused;
        // Clear any stale desired state; never set a desiredResistance for freestyle.
        desiredResistance = undefined;
        pendingLevel = undefined;
        needsReconcile = false;
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
        // Explicit disarm blocks all resistance commands until a new session binds.
        bindingState = { type: "disarmed" };
        desiredResistance = undefined;
        pendingLevel = undefined;
        needsReconcile = false;
        commandedResistance = undefined;
        guidanceWorkout = undefined;
        // An already-dispatched request cannot be recalled; its late result is
        // ignored by the generation guard. holdFailedLevel no longer applies.
        holdFailedLevel = undefined;
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
        // Same-session authority is immutable: a mode change is rejected
        // without touching state; a same-mode retry is idempotent.
        if (bindingState.controlMode !== binding.controlMode) {
          throw new Error("Session binding is already frozen with a conflicting control mode");
        }
        return;
      }
      bindingGeneration += 1;
      bindingState = { type: "bound", sessionId: binding.sessionId, controlMode: binding.controlMode };
      // New binding: discard stale command state from the previous session.
      desiredResistance = undefined;
      pendingLevel = undefined;
      needsReconcile = false;
      commandedResistance = undefined;
      holdFailedLevel = undefined;
      lastAccepted = undefined;
      guidanceWorkout = { day: "", sessionId: binding.sessionId };
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
