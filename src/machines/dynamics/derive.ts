import type { WorkoutSummary } from "../../types.js";
import { qualifiedHrMedian, samplesInRange, validDistinctHr, MIN_HR_SAMPLES, MIN_HR_SPAN_SECONDS } from "../hrQuality.js";
import { getMachineDefinition } from "../registry.js";
import type { MachineGuidanceTraceEntry } from "../trace.js";
import {
  isLearningIntent,
  workDurationClass,
  type LearningHrSample,
  type LearningKeyParts,
  type WorkDurationClass,
} from "../learning/types.js";
import {
  IN_WORK_BASELINE_SECONDS,
  MAX_ABS_HR_DELTA,
  MAX_ABS_HR_PER_LEVEL,
  MAX_RESISTANCE_STEP,
  MIN_OBSERVABLE_WINDOW_SECONDS,
  RESPONSE_ONSET_BPM,
  RESPONSE_PERSISTENCE_SECONDS,
  RESPONSE_SEARCH_SECONDS,
  ROLLING_ONSET_LOOKBACK_SECONDS,
  SETTLED_WINDOW_SECONDS,
  WORK_START_BASELINE_FALLBACK_SECONDS,
  WORK_START_BASELINE_SECONDS,
  type MachineHrResponseObservation,
} from "./types.js";

interface WorkPhase {
  phaseId: string;
  durationClass: WorkDurationClass;
  durationSeconds: number;
  startElapsed: number;
  endElapsed: number;
  intervalIndex?: number;
  entries: MachineGuidanceTraceEntry[];
}

function collectWorkPhases(trace: readonly MachineGuidanceTraceEntry[]): WorkPhase[] {
  const grouped = new Map<string, MachineGuidanceTraceEntry[]>();
  for (const entry of trace) {
    if (entry.phaseKind !== "work" || !entry.phaseId) continue;
    if (!Number.isFinite(entry.phaseDurationSeconds) || (entry.phaseDurationSeconds as number) <= 0) continue;
    if (!Number.isInteger(entry.resistance)) continue;
    const list = grouped.get(entry.phaseId) ?? [];
    list.push(entry);
    grouped.set(entry.phaseId, list);
  }
  const phases: WorkPhase[] = [];
  for (const [phaseId, entries] of grouped) {
    const ordered = [...entries].sort((a, b) => a.elapsedSeconds - b.elapsedSeconds);
    const first = ordered[0];
    const durationSeconds = first.phaseDurationSeconds as number;
    const phaseElapsed = Number.isFinite(first.phaseElapsedSeconds) ? (first.phaseElapsedSeconds as number) : 0;
    const startElapsed = first.elapsedSeconds - phaseElapsed;
    phases.push({
      phaseId,
      durationClass: workDurationClass(durationSeconds),
      durationSeconds,
      startElapsed,
      endElapsed: startElapsed + durationSeconds,
      intervalIndex: first.intervalIndex,
      entries: ordered,
    });
  }
  return phases.sort((a, b) => a.startElapsed - b.startElapsed);
}

function entryEventTime(phase: WorkPhase, entry: MachineGuidanceTraceEntry): number {
  if (Number.isFinite(entry.phaseElapsedSeconds)) {
    return phase.startElapsed + (entry.phaseElapsedSeconds as number);
  }
  return entry.elapsedSeconds;
}

function nextResistanceChangeElapsed(
  phase: WorkPhase,
  afterElapsed: number,
  currentResistance: number
): number | undefined {
  for (const entry of phase.entries) {
    const at = entryEventTime(phase, entry);
    if (at > afterElapsed && entry.resistance !== currentResistance) return at;
  }
  return undefined;
}

function observationWindowEnd(changeElapsed: number, phaseEnd: number, nextChange?: number): number {
  return Math.min(changeElapsed + RESPONSE_SEARCH_SECONDS, phaseEnd, nextChange ?? Number.POSITIVE_INFINITY);
}

function baselineHr(
  samples: readonly LearningHrSample[],
  endExclusive: number,
  preferredSeconds: number,
  fallbackSeconds?: number
): number | undefined {
  const preferred = qualifiedHrMedian(samplesInRange(samples, endExclusive - preferredSeconds, endExclusive));
  if (preferred !== undefined) return preferred;
  if (fallbackSeconds === undefined) return undefined;
  return qualifiedHrMedian(samplesInRange(samples, endExclusive - fallbackSeconds, endExclusive));
}

function settledHr(
  samples: readonly LearningHrSample[],
  changeElapsed: number,
  windowEnd: number
): number | undefined {
  const start = Math.max(changeElapsed, windowEnd - SETTLED_WINDOW_SECONDS);
  if (windowEnd <= start) return undefined;
  return qualifiedHrMedian(samplesInRange(samples, start, windowEnd));
}

function responseOnsetDelay(
  samples: readonly LearningHrSample[],
  changeElapsed: number,
  windowEnd: number,
  baseline: number,
  direction: "up" | "down"
): number | undefined {
  const threshold = direction === "up" ? baseline + RESPONSE_ONSET_BPM : baseline - RESPONSE_ONSET_BPM;
  const distinct = validDistinctHr(samples);
  const firstT = Math.ceil(changeElapsed + 1);
  const lastT = Math.floor(windowEnd) - 1;
  let runStart: number | undefined;
  let runLength = 0;
  for (let t = firstT; t <= lastT; t++) {
    const window = distinct.filter(
      (sample) =>
        sample.elapsedSeconds > changeElapsed &&
        sample.elapsedSeconds <= t &&
        sample.elapsedSeconds >= t - ROLLING_ONSET_LOOKBACK_SECONDS
    );
    const median = qualifiedHrMedian(window);
    const hit =
      median !== undefined && (direction === "up" ? median >= threshold : median <= threshold);
    if (hit) {
      if (runStart === undefined) runStart = t;
      runLength += 1;
      if (runLength >= RESPONSE_PERSISTENCE_SECONDS) {
        const delay = runStart - changeElapsed;
        if (!Number.isInteger(delay) || delay < 0 || delay > RESPONSE_SEARCH_SECONDS) return undefined;
        return delay;
      }
    } else {
      runStart = undefined;
      runLength = 0;
    }
  }
  return undefined;
}

function hasEvaluableOnsetRun(
  samples: readonly LearningHrSample[],
  changeElapsed: number,
  windowEnd: number
): boolean {
  const distinct = validDistinctHr(samples);
  const firstT = Math.ceil(changeElapsed + 1);
  const lastT = Math.floor(windowEnd) - 1;
  let runLength = 0;
  for (let t = firstT; t <= lastT; t++) {
    const window = distinct.filter(
      (sample) =>
        sample.elapsedSeconds > changeElapsed &&
        sample.elapsedSeconds <= t &&
        sample.elapsedSeconds >= t - ROLLING_ONSET_LOOKBACK_SECONDS
    );
    if (qualifiedHrMedian(window) !== undefined) {
      runLength += 1;
      if (runLength >= RESPONSE_PERSISTENCE_SECONDS) return true;
    } else {
      runLength = 0;
    }
  }
  return false;
}

export function observationWindowIsObservable(
  samples: readonly LearningHrSample[],
  changeElapsed: number,
  windowEnd: number,
  baseline: number | undefined
): boolean {
  if (baseline === undefined) return false;
  if (windowEnd - changeElapsed < MIN_OBSERVABLE_WINDOW_SECONDS) return false;
  const post = validDistinctHr(samplesInRange(samples, changeElapsed, windowEnd, { startExclusive: true }));
  if (post.length < MIN_HR_SAMPLES) return false;
  const span = post[post.length - 1].elapsedSeconds - post[0].elapsedSeconds;
  if (span < MIN_HR_SPAN_SECONDS) return false;
  if (post[post.length - 1].elapsedSeconds - changeElapsed < MIN_OBSERVABLE_WINDOW_SECONDS - 1) return false;
  return hasEvaluableOnsetRun(samples, changeElapsed, windowEnd);
}

export function responseDetectionRate(detected: number, observed: number): number | undefined {
  if (!Number.isInteger(observed) || observed <= 0) return undefined;
  if (!Number.isInteger(detected) || detected < 0) return undefined;
  return detected / observed;
}

function roundedDelta(settled: number | undefined, baseline: number | undefined): number | undefined {
  if (settled === undefined || baseline === undefined) return undefined;
  return Math.round(settled - baseline);
}

export function observationDelayIsSane(observation: MachineHrResponseObservation): boolean {
  if (observation.responseDelaySeconds === undefined) return true;
  return (
    Number.isInteger(observation.responseDelaySeconds) &&
    observation.responseDelaySeconds >= 0 &&
    observation.responseDelaySeconds <= RESPONSE_SEARCH_SECONDS
  );
}

export function observationHrDeltaIsSane(observation: MachineHrResponseObservation): boolean {
  if (observation.hrDelta !== undefined && Math.abs(observation.hrDelta) > MAX_ABS_HR_DELTA) return false;
  if (
    observation.resistanceDelta !== undefined &&
    observation.resistanceDelta !== 0 &&
    observation.hrDelta !== undefined
  ) {
    const perLevel = observation.hrDelta / Math.abs(observation.resistanceDelta);
    if (Math.abs(perLevel) > MAX_ABS_HR_PER_LEVEL) return false;
  }
  return true;
}

export function observationPassesSanity(observation: MachineHrResponseObservation): boolean {
  return observationDelayIsSane(observation) && observationHrDeltaIsSane(observation);
}

export function observationHasAggregatableMetric(observation: MachineHrResponseObservation): boolean {
  return observation.responseDelaySeconds !== undefined || observation.hrDelta !== undefined;
}

export function observationContributesToStore(observation: MachineHrResponseObservation): boolean {
  return observation.windowObservable || observationHasAggregatableMetric(observation);
}

function observeEvent(params: {
  key: LearningKeyParts;
  phase: WorkPhase;
  kind: MachineHrResponseObservation["kind"];
  fromResistance?: number;
  toResistance: number;
  resistanceDelta?: number;
  changeElapsed: number;
  windowEnd: number;
  baseline: number | undefined;
  samples: readonly LearningHrSample[];
  direction: "up" | "down";
  targetHeartRateMin?: number;
  targetHeartRateMax?: number;
}): MachineHrResponseObservation {
  const delay =
    params.baseline === undefined
      ? undefined
      : responseOnsetDelay(params.samples, params.changeElapsed, params.windowEnd, params.baseline, params.direction);
  const settled = settledHr(params.samples, params.changeElapsed, params.windowEnd);
  const windowObservable = observationWindowIsObservable(
    params.samples,
    params.changeElapsed,
    params.windowEnd,
    params.baseline
  );
  const responseDetected = delay !== undefined;
  return {
    machineId: params.key.machineId,
    machineProfileVersion: params.key.machineProfileVersion,
    activity: params.key.activity,
    intent: params.key.intent,
    durationClass: params.phase.durationClass,
    phaseId: params.phase.phaseId,
    intervalIndex: params.phase.intervalIndex,
    fromResistance: params.fromResistance,
    toResistance: params.toResistance,
    resistanceDelta: params.resistanceDelta,
    changeElapsedSeconds: params.changeElapsed,
    baselineHr: params.baseline === undefined ? undefined : Math.round(params.baseline),
    settledHr: settled === undefined ? undefined : Math.round(settled),
    hrDelta: roundedDelta(settled, params.baseline),
    responseDelaySeconds: delay,
    observationWindowSeconds: Math.max(0, Math.round(params.windowEnd - params.changeElapsed)),
    windowObservable,
    responseDetected,
    targetHeartRateMin: params.targetHeartRateMin,
    targetHeartRateMax: params.targetHeartRateMax,
    kind: params.kind,
  };
}

export function workoutEligibleForHrDynamics(
  summary: Pick<
    WorkoutSummary,
    "cancelled" | "activity" | "machine_id" | "machine_profile_version" | "intent"
  >
): boolean {
  if (summary.cancelled) return false;
  if (summary.activity !== "bike") return false;
  if (summary.machine_id !== "proform-smart-power-10") return false;
  const machine = getMachineDefinition(summary.machine_id);
  if (!machine || summary.machine_profile_version !== machine.profileVersion) return false;
  return isLearningIntent(summary.intent);
}

export function deriveHrDynamicsObservations(
  summary: Pick<
    WorkoutSummary,
    "cancelled" | "activity" | "machine_id" | "machine_profile_version" | "intent" | "machine_guidance_trace"
  >,
  hrSamples: readonly LearningHrSample[]
): MachineHrResponseObservation[] {
  if (!workoutEligibleForHrDynamics(summary)) return [];
  const machine = getMachineDefinition(summary.machine_id as string);
  if (!machine || !summary.intent) return [];
  const key: LearningKeyParts = {
    machineId: "proform-smart-power-10",
    machineProfileVersion: machine.profileVersion,
    activity: "bike",
    intent: summary.intent,
    durationClass: "short",
  };
  const observations: MachineHrResponseObservation[] = [];
  for (const phase of collectWorkPhases(summary.machine_guidance_trace ?? [])) {
    const startEntry = phase.entries[0];
    const startAt = phase.startElapsed;
    const nextChange = nextResistanceChangeElapsed(phase, startAt, startEntry.resistance);
    const startWindowEnd = observationWindowEnd(startAt, phase.endElapsed, nextChange);
    observations.push(
      observeEvent({
        key: { ...key, durationClass: phase.durationClass },
        phase,
        kind: "work_start",
        toResistance: startEntry.resistance,
        changeElapsed: startAt,
        windowEnd: startWindowEnd,
        baseline: baselineHr(
          hrSamples,
          startAt,
          WORK_START_BASELINE_SECONDS,
          WORK_START_BASELINE_FALLBACK_SECONDS
        ),
        samples: hrSamples,
        direction: "up",
        targetHeartRateMin: startEntry.targetHeartRateMin,
        targetHeartRateMax: startEntry.targetHeartRateMax,
      })
    );

    for (let index = 1; index < phase.entries.length; index++) {
      const previous = phase.entries[index - 1];
      const current = phase.entries[index];
      if (current.resistance === previous.resistance) continue;
      const resistanceDelta = current.resistance - previous.resistance;
      if (!Number.isInteger(resistanceDelta) || Math.abs(resistanceDelta) > MAX_RESISTANCE_STEP) continue;
      const changeElapsed = entryEventTime(phase, current);
      const next = nextResistanceChangeElapsed(phase, changeElapsed, current.resistance);
      const windowEnd = observationWindowEnd(changeElapsed, phase.endElapsed, next);
      observations.push(
        observeEvent({
          key: { ...key, durationClass: phase.durationClass },
          phase,
          kind: resistanceDelta > 0 ? "resistance_increase" : "resistance_decrease",
          fromResistance: previous.resistance,
          toResistance: current.resistance,
          resistanceDelta,
          changeElapsed,
          windowEnd,
          baseline: baselineHr(hrSamples, changeElapsed, IN_WORK_BASELINE_SECONDS),
          samples: hrSamples,
          direction: resistanceDelta > 0 ? "up" : "down",
          targetHeartRateMin: current.targetHeartRateMin,
          targetHeartRateMax: current.targetHeartRateMax,
        })
      );
    }
  }
  return observations;
}
