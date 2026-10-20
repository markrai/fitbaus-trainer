import {
  WORKOUT_EXECUTION_PROVENANCE_SCHEMA_VERSION_V1,
  type Activity,
  type PhaseActuationModeV1,
  type PhaseActuationSummaryV1,
  type ResistanceActuationEventV1,
  type ResistanceActuationOriginV1,
  type ResistanceActuationOutcomeV1,
  type ResistanceActuationTriggerV1,
  type WorkoutActuationProvenanceV1,
  type WorkoutCalibrationMachineProvenanceV1,
  type WorkoutExecutionProvenanceV1,
  type WorkoutMachineProvenanceV1,
  type WorkoutPhaseKind,
} from "./types.js";
import { parseFormalCalibrationInstanceIdentity, parseFrozenMachineIdentity } from "./calibrationMachineProvenance.js";
import { getMachineDefinition } from "./machines/registry.js";
import { getSelectedMachineId, type EquipmentStorage } from "./machines/selection.js";

/**
 * Execution provenance: what actually executed a workout. Machine identity is
 * frozen at start; resistance actuation is captured at the Bike Bridge command
 * site with an explicit origin. Nothing here is read by prescription, guidance,
 * or control, and nothing is inferred from commanded/desired/observed resistance.
 */

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const DECISION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** Permanent v1 reader bound; the writer never persists more events than this. */
export const MAX_EXECUTION_PROVENANCE_EVENTS = 5000;
const MAX_EVENTS = MAX_EXECUTION_PROVENANCE_EVENTS;
const MAX_PHASES = 100;

export const ACTUATION_ORIGINS: readonly ResistanceActuationOriginV1[] = [
  "automatic_hr_control",
  "learned_starting_resistance",
  "default_starting_resistance",
  "controller_carryover",
  "scripted_phase_program",
  "vo2_protocol_fixed_resistance",
  "unclassified",
];
const PROGRAMMATIC_ORIGINS = new Set<ResistanceActuationOriginV1>([
  "learned_starting_resistance",
  "default_starting_resistance",
  "controller_carryover",
  "scripted_phase_program",
  "vo2_protocol_fixed_resistance",
]);
const TRIGGERS = new Set<ResistanceActuationTriggerV1>(["decision", "reconciliation_resend"]);
const OUTCOMES = new Set<ResistanceActuationOutcomeV1>(["accepted", "failed", "unavailable", "timeout", "pending"]);
const INCOMPLETE_REASONS = ["active_clock_unavailable", "persistence_failed"] as const;
const PHASE_KINDS = new Set<WorkoutPhaseKind>(["warmup", "work", "recovery", "cooldown"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

/** Freeze the selected machine for the workout activity at start. Never re-read at finalization. */
export function captureWorkoutMachineProvenance(
  activity: Activity | undefined,
  storage?: EquipmentStorage
): WorkoutMachineProvenanceV1 {
  const machineId = activity ? getSelectedMachineId(activity, storage) : undefined;
  const definition = machineId ? getMachineDefinition(machineId) : undefined;
  if (!definition || definition.activity !== activity) {
    return { status: "none_selected", selectionChangedDuringWorkout: false };
  }
  return {
    status: "selected",
    machineId: definition.id,
    machineProfileVersion: definition.profileVersion,
    selectionChangedDuringWorkout: false,
  };
}

export function createInProgressExecutionProvenance(
  sessionId: string,
  machine: WorkoutMachineProvenanceV1,
  calibrationMachine: WorkoutCalibrationMachineProvenanceV1
): WorkoutExecutionProvenanceV1 {
  return {
    schemaVersion: WORKOUT_EXECUTION_PROVENANCE_SCHEMA_VERSION_V1,
    sessionId,
    machine: { ...machine },
    calibrationMachine: { ...calibrationMachine },
    actuation: {
      captureScope: "app_resistance_commands",
      consoleResistanceChanges: "not_observable",
      coverage: "complete",
      incompleteReasons: [],
      events: [],
    },
  };
}

function parseMachine(value: unknown): WorkoutMachineProvenanceV1 | null {
  if (!isObject(value) || typeof value.selectionChangedDuringWorkout !== "boolean") return null;
  if (value.status === "none_selected") {
    return exactKeys(value, ["status", "selectionChangedDuringWorkout"])
      ? { status: "none_selected", selectionChangedDuringWorkout: value.selectionChangedDuringWorkout }
      : null;
  }
  if (value.status !== "selected" ||
      !exactKeys(value, ["status", "machineId", "machineProfileVersion", "selectionChangedDuringWorkout"])) return null;
  const identity = parseFrozenMachineIdentity({ machineId: value.machineId, machineProfileVersion: value.machineProfileVersion });
  return identity
    ? { status: "selected", ...identity, selectionChangedDuringWorkout: value.selectionChangedDuringWorkout }
    : null;
}

function parseCalibrationMachine(value: unknown): WorkoutCalibrationMachineProvenanceV1 | null {
  if (!isObject(value)) return null;
  if (value.status === "no_frozen_calibration") {
    return exactKeys(value, ["status"]) ? { status: "no_frozen_calibration" } : null;
  }
  const calibration = parseFormalCalibrationInstanceIdentity(value.calibration);
  if (!calibration) return null;
  if (value.status === "unavailable" || value.status === "integrity_failure") {
    return exactKeys(value, ["status", "calibration"]) ? { status: value.status, calibration } : null;
  }
  if (value.status !== "available" ||
      !exactKeys(value, ["status", "calibration", "machineId", "machineProfileVersion"])) return null;
  const identity = parseFrozenMachineIdentity({ machineId: value.machineId, machineProfileVersion: value.machineProfileVersion });
  return identity ? { status: "available", calibration, ...identity } : null;
}

function parseEvent(value: unknown, index: number): ResistanceActuationEventV1 | null {
  if (!isObject(value) || !exactKeys(value,
    ["commandId", "decisionId", "origin", "trigger", "requestedResistance", "activeSec", "observedAt", "outcome"])) return null;
  if (value.commandId !== index + 1) return null;
  if (typeof value.decisionId !== "string" || !DECISION_ID_PATTERN.test(value.decisionId)) return null;
  if (!ACTUATION_ORIGINS.includes(value.origin as ResistanceActuationOriginV1)) return null;
  if (!TRIGGERS.has(value.trigger as ResistanceActuationTriggerV1)) return null;
  if (!isNonNegativeInteger(value.requestedResistance) || value.requestedResistance > 100) return null;
  if (!isNonNegativeInteger(value.activeSec) || value.activeSec > 24 * 60 * 60) return null;
  if (!isIso(value.observedAt) || !OUTCOMES.has(value.outcome as ResistanceActuationOutcomeV1)) return null;
  return {
    commandId: value.commandId,
    decisionId: value.decisionId,
    origin: value.origin as ResistanceActuationOriginV1,
    trigger: value.trigger as ResistanceActuationTriggerV1,
    requestedResistance: value.requestedResistance,
    activeSec: value.activeSec,
    observedAt: value.observedAt,
    outcome: value.outcome as ResistanceActuationOutcomeV1,
  };
}

function isAmbiguous(event: ResistanceActuationEventV1): boolean {
  return event.outcome === "timeout" || event.outcome === "pending" ||
    (event.outcome === "accepted" && event.origin === "unclassified");
}

export interface PhaseBoundary {
  phaseId: string;
  kind: WorkoutPhaseKind;
  intervalIndex?: number;
  activeStartSec: number;
  activeEndSec: number;
}

/**
 * Phase-mode rule. `canonical` is the only current v1 semantics and the only rule
 * any writer uses. `published_b7fef00` reproduces the published v1 writer
 * (commit b7fef00) exactly, which ignored failed/unavailable commands; it exists
 * solely for published WorkoutExecutionProvenance v1 writer compatibility.
 */
type PhaseModeRule = "canonical" | "published_b7fef00";

/** Deterministic phase derivation on the active clock: an event belongs to [activeStartSec, activeEndSec). */
export function derivePhaseActuationSummaries(
  actuation: Pick<WorkoutActuationProvenanceV1, "coverage" | "events">,
  boundaries: readonly PhaseBoundary[]
): PhaseActuationSummaryV1[] {
  return derivePhaseActuationSummariesWithRule(actuation, boundaries, "canonical");
}

function derivePhaseActuationSummariesWithRule(
  actuation: Pick<WorkoutActuationProvenanceV1, "coverage" | "events">,
  boundaries: readonly PhaseBoundary[],
  rule: PhaseModeRule
): PhaseActuationSummaryV1[] {
  return boundaries.map((boundary) => {
    const events = actuation.events.filter((event) =>
      event.activeSec >= boundary.activeStartSec && event.activeSec < boundary.activeEndSec);
    const accepted = events.filter((event) => event.outcome === "accepted");
    const automaticAcceptedCount = accepted.filter((event) => event.origin === "automatic_hr_control").length;
    const programmaticAcceptedCount = accepted.filter((event) => PROGRAMMATIC_ORIGINS.has(event.origin)).length;
    const ambiguousCount = events.filter(isAmbiguous).length;
    const rejectedCount = events.filter((event) => event.outcome === "failed" || event.outcome === "unavailable").length;
    // `none` means zero app resistance-command events under complete capture.
    // A failed/unavailable command was still an app actuation attempt whose
    // physical effect is not established, so it makes the phase unknown.
    const rejectedMakesUnknown = rule === "canonical" && rejectedCount > 0;
    let mode: PhaseActuationModeV1;
    if (actuation.coverage !== "complete" || ambiguousCount > 0 || rejectedMakesUnknown) mode = "unknown";
    else if (automaticAcceptedCount > 0) mode = "automatic";
    else if (programmaticAcceptedCount > 0) mode = "programmatic";
    else mode = "none";
    return {
      phaseId: boundary.phaseId,
      kind: boundary.kind,
      ...(boundary.intervalIndex !== undefined ? { intervalIndex: boundary.intervalIndex } : {}),
      activeStartSec: boundary.activeStartSec,
      activeEndSec: boundary.activeEndSec,
      mode,
      automaticAcceptedCount,
      programmaticAcceptedCount,
      rejectedCount,
      ambiguousCount,
      decisionCount: new Set(events.map((event) => event.decisionId)).size,
    };
  });
}

function parsePhaseBoundary(value: unknown): PhaseBoundary | null {
  if (!isObject(value) || typeof value.phaseId !== "string" || value.phaseId === "" ||
      !PHASE_KINDS.has(value.kind as WorkoutPhaseKind)) return null;
  if (value.intervalIndex !== undefined && !isNonNegativeInteger(value.intervalIndex)) return null;
  if (!isNonNegativeInteger(value.activeStartSec) || !isNonNegativeInteger(value.activeEndSec) ||
      value.activeEndSec < value.activeStartSec) return null;
  return {
    phaseId: value.phaseId,
    kind: value.kind as WorkoutPhaseKind,
    ...(value.intervalIndex !== undefined ? { intervalIndex: value.intervalIndex as number } : {}),
    activeStartSec: value.activeStartSec,
    activeEndSec: value.activeEndSec,
  };
}

/**
 * Strict reader for in-progress and durable provenance. Unknown schema versions,
 * malformed origins/times/identities, inconsistent decisions, and phase summaries
 * that do not equal their derivation from the sparse events all fail closed.
 */
export function parseWorkoutExecutionProvenance(value: unknown): WorkoutExecutionProvenanceV1 | null {
  if (!isObject(value) || value.schemaVersion !== WORKOUT_EXECUTION_PROVENANCE_SCHEMA_VERSION_V1) return null;
  if (!exactKeys(value, ["schemaVersion", "sessionId", "machine", "calibrationMachine", "actuation"])) return null;
  if (typeof value.sessionId !== "string" || !SESSION_ID_PATTERN.test(value.sessionId)) return null;
  const machine = parseMachine(value.machine);
  const calibrationMachine = parseCalibrationMachine(value.calibrationMachine);
  if (!machine || !calibrationMachine) return null;
  const actuation = value.actuation;
  if (!isObject(actuation) || !exactKeys(actuation,
    ["captureScope", "consoleResistanceChanges", "coverage", "incompleteReasons", "events"], ["phases"])) return null;
  if (actuation.captureScope !== "app_resistance_commands" || actuation.consoleResistanceChanges !== "not_observable") return null;
  if (actuation.coverage !== "complete" && actuation.coverage !== "incomplete") return null;
  const reasons = actuation.incompleteReasons;
  if (!Array.isArray(reasons) || new Set(reasons).size !== reasons.length ||
      !reasons.every((reason) => (INCOMPLETE_REASONS as readonly unknown[]).includes(reason)) ||
      (actuation.coverage === "incomplete") !== (reasons.length > 0)) return null;
  if (!Array.isArray(actuation.events) || actuation.events.length > MAX_EVENTS) return null;
  const events: ResistanceActuationEventV1[] = [];
  const decisions = new Map<string, { origin: string; requestedResistance: number }>();
  for (let index = 0; index < actuation.events.length; index += 1) {
    const event = parseEvent(actuation.events[index], index);
    if (!event) return null;
    const previous = events[events.length - 1];
    if (previous && (event.activeSec < previous.activeSec || Date.parse(event.observedAt) < Date.parse(previous.observedAt))) {
      return null;
    }
    const decision = decisions.get(event.decisionId);
    if (decision && (decision.origin !== event.origin || decision.requestedResistance !== event.requestedResistance)) return null;
    decisions.set(event.decisionId, { origin: event.origin, requestedResistance: event.requestedResistance });
    events.push(event);
  }
  const parsedActuation: WorkoutActuationProvenanceV1 = {
    captureScope: "app_resistance_commands",
    consoleResistanceChanges: "not_observable",
    coverage: actuation.coverage,
    incompleteReasons: [...reasons] as WorkoutActuationProvenanceV1["incompleteReasons"],
    events,
  };
  if (actuation.phases !== undefined) {
    if (!Array.isArray(actuation.phases) || actuation.phases.length > MAX_PHASES) return null;
    const boundaries: PhaseBoundary[] = [];
    for (const phase of actuation.phases) {
      const boundary = parsePhaseBoundary(phase);
      if (!boundary) return null;
      const previous = boundaries[boundaries.length - 1];
      if (previous && boundary.activeStartSec < previous.activeEndSec) return null;
      boundaries.push(boundary);
    }
    const stored = JSON.stringify(actuation.phases);
    const derived = derivePhaseActuationSummaries(parsedActuation, boundaries);
    if (JSON.stringify(derived) !== stored) {
      // Published WorkoutExecutionProvenance v1 writer compatibility: accept a
      // record only if its stored summaries are exactly what the published
      // b7fef00 writer derives from this record's own events and boundaries,
      // then return the canonical summaries. Any other mismatch fails closed.
      const published = derivePhaseActuationSummariesWithRule(parsedActuation, boundaries, "published_b7fef00");
      if (JSON.stringify(published) !== stored) return null;
    }
    parsedActuation.phases = derived;
  }
  return {
    schemaVersion: WORKOUT_EXECUTION_PROVENANCE_SCHEMA_VERSION_V1,
    sessionId: value.sessionId,
    machine,
    calibrationMachine,
    actuation: parsedActuation,
  };
}

export interface ActuationRequest {
  decisionId: string;
  origin: ResistanceActuationOriginV1;
  trigger: ResistanceActuationTriggerV1;
  requestedResistance: number;
  observedAtMs: number;
}

/** Canonical active clock (paused time excluded). Null while paused or not started. */
export function activeSecondAt(
  session: { startTime: string | null; paused: boolean },
  nowMs: number
): number | null {
  if (!session.startTime || session.paused) return null;
  const start = parseInt(session.startTime, 10);
  if (!Number.isFinite(start) || nowMs < start) return null;
  return Math.floor((nowMs - start) / 1000);
}

/** Append one posted command. Without an active-clock second the event cannot be placed, so coverage becomes incomplete. */
export function appendActuationEvent(
  record: WorkoutExecutionProvenanceV1,
  request: ActuationRequest,
  activeSec: number | null
): { record: WorkoutExecutionProvenanceV1; commandId: number | null } {
  const actuation = record.actuation;
  // v1 capacity: never persist more events than the permanent reader accepts.
  // The existing events are kept unchanged (no eviction, no ID wrap) and capture
  // becomes incomplete via `persistence_failed`: the record could not persist
  // additional evidence within its bounded durable representation.
  if (actuation.events.length >= MAX_EVENTS) {
    return { record: markIncomplete(record, "persistence_failed"), commandId: null };
  }
  if (activeSec === null || !Number.isFinite(request.observedAtMs)) {
    return { record: markIncomplete(record, "active_clock_unavailable"), commandId: null };
  }
  const previous = actuation.events[actuation.events.length - 1];
  const observedAt = new Date(request.observedAtMs).toISOString();
  if (previous && (activeSec < previous.activeSec || Date.parse(observedAt) < Date.parse(previous.observedAt))) {
    return { record: markIncomplete(record, "active_clock_unavailable"), commandId: null };
  }
  const commandId = actuation.events.length + 1;
  const event: ResistanceActuationEventV1 = {
    commandId,
    decisionId: request.decisionId,
    origin: request.origin,
    trigger: request.trigger,
    requestedResistance: request.requestedResistance,
    activeSec,
    observedAt,
    outcome: "pending",
  };
  return { record: { ...record, actuation: { ...actuation, events: [...actuation.events, event] } }, commandId };
}

export function resolveActuationEvent(
  record: WorkoutExecutionProvenanceV1,
  commandId: number,
  outcome: Exclude<ResistanceActuationOutcomeV1, "pending">
): WorkoutExecutionProvenanceV1 {
  const events = record.actuation.events.map((event) =>
    event.commandId === commandId && event.outcome === "pending" ? { ...event, outcome } : event);
  return { ...record, actuation: { ...record.actuation, events } };
}

export function markIncomplete(
  record: WorkoutExecutionProvenanceV1,
  reason: WorkoutActuationProvenanceV1["incompleteReasons"][number]
): WorkoutExecutionProvenanceV1 {
  const reasons = record.actuation.incompleteReasons.includes(reason)
    ? record.actuation.incompleteReasons
    : [...record.actuation.incompleteReasons, reason].sort() as WorkoutActuationProvenanceV1["incompleteReasons"];
  return { ...record, actuation: { ...record.actuation, coverage: "incomplete", incompleteReasons: reasons } };
}

/** Durable summary record: frozen start identity plus derived phase summaries over frozen phase boundaries. */
export function finalizeExecutionProvenance(
  record: WorkoutExecutionProvenanceV1,
  options: { selectionChangedDuringWorkout: boolean; phases?: readonly PhaseBoundary[] }
): WorkoutExecutionProvenanceV1 | null {
  const machine: WorkoutMachineProvenanceV1 = {
    ...record.machine,
    selectionChangedDuringWorkout: record.machine.selectionChangedDuringWorkout || options.selectionChangedDuringWorkout,
  };
  const actuation: WorkoutActuationProvenanceV1 = {
    captureScope: "app_resistance_commands",
    consoleResistanceChanges: "not_observable",
    coverage: record.actuation.coverage,
    incompleteReasons: [...record.actuation.incompleteReasons],
    events: record.actuation.events.map((event) => ({ ...event })),
  };
  if (options.phases) {
    const boundaries = [...options.phases].sort((a, b) => a.activeStartSec - b.activeStartSec);
    actuation.phases = derivePhaseActuationSummaries(actuation, boundaries);
  }
  return parseWorkoutExecutionProvenance({ ...record, machine, actuation });
}

export interface ExecutionProvenanceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function executionProvenanceKey(day: string): string {
  return "execution_provenance_" + day;
}

export function readInProgressExecutionProvenance(
  day: string,
  storage: Pick<ExecutionProvenanceStorage, "getItem">
): WorkoutExecutionProvenanceV1 | null {
  const raw = storage.getItem(executionProvenanceKey(day));
  if (!raw) return null;
  try {
    const parsed = parseWorkoutExecutionProvenance(JSON.parse(raw));
    return parsed && parsed.actuation.phases === undefined ? parsed : null;
  } catch {
    return null;
  }
}

export function writeInProgressExecutionProvenance(
  day: string,
  record: WorkoutExecutionProvenanceV1,
  storage: ExecutionProvenanceStorage
): boolean {
  try {
    storage.setItem(executionProvenanceKey(day), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Record one posted command for the session on `day`. Returns the command ID to resolve later. */
export function recordActuationRequest(
  day: string,
  session: { sessionId: string | null; startTime: string | null; paused: boolean },
  request: ActuationRequest,
  storage: ExecutionProvenanceStorage
): number | null {
  if (!session.sessionId) return null;
  const record = readInProgressExecutionProvenance(day, storage);
  // A session without a provenance snapshot (legacy/pre-upgrade) stays unknown; nothing is reconstructed.
  if (!record || record.sessionId !== session.sessionId) return null;
  const next = appendActuationEvent(record, request, activeSecondAt(session, request.observedAtMs));
  if (!writeInProgressExecutionProvenance(day, next.record, storage)) {
    writeInProgressExecutionProvenance(day, markIncomplete(record, "persistence_failed"), storage);
    return null;
  }
  return next.commandId;
}

export function recordActuationOutcome(
  day: string,
  sessionId: string,
  commandId: number,
  outcome: Exclude<ResistanceActuationOutcomeV1, "pending">,
  storage: ExecutionProvenanceStorage
): void {
  const record = readInProgressExecutionProvenance(day, storage);
  if (!record || record.sessionId !== sessionId) return;
  if (!writeInProgressExecutionProvenance(day, resolveActuationEvent(record, commandId, outcome), storage)) {
    writeInProgressExecutionProvenance(day, markIncomplete(record, "persistence_failed"), storage);
  }
}
