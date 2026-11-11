import type { WorkoutSummary } from "../../types.js";
import type { MachineGuidanceTraceEntry } from "../trace.js";
import { integerMedian, qualifiedHrMedian } from "../hrQuality.js";
import { clampAutomaticResistance } from "../proformSmartPower10.js";
import { getMachineDefinition } from "../registry.js";
import {
  isLearningIntent,
  workDurationClass,
  type LearningHrSample,
  type LearningKeyParts,
  type WorkDurationClass,
} from "./types.js";

export { integerMedian };

interface WorkPhase {
  phaseId: string;
  durationClass: WorkDurationClass;
  durationSeconds: number;
  startElapsed: number;
  endElapsed: number;
  entries: MachineGuidanceTraceEntry[];
  finalResistance: number;
  targetHeartRateMin?: number;
  targetHeartRateMax?: number;
}

export function rollingHrMedian(samples: readonly LearningHrSample[]): number | undefined {
  return qualifiedHrMedian(samples);
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
      entries: ordered,
      finalResistance: ordered[ordered.length - 1].resistance,
      targetHeartRateMin: ordered[ordered.length - 1].targetHeartRateMin ?? first.targetHeartRateMin,
      targetHeartRateMax: ordered[ordered.length - 1].targetHeartRateMax ?? first.targetHeartRateMax,
    });
  }
  return phases.sort((a, b) => a.startElapsed - b.startElapsed);
}

function lastHalf<T>(items: readonly T[]): T[] {
  return items.slice(Math.floor(items.length / 2));
}

export function lateHrWindow(phase: Pick<WorkPhase, "durationClass" | "durationSeconds" | "startElapsed" | "endElapsed">): {
  start: number;
  end: number;
} {
  const tailSeconds = phase.durationClass === "short"
    ? 15
    : phase.durationClass === "medium"
      ? 30
      : phase.durationSeconds / 3;
  return {
    start: Math.max(phase.startElapsed, phase.endElapsed - tailSeconds),
    end: phase.endElapsed,
  };
}

function samplesInWindows(
  samples: readonly LearningHrSample[],
  windows: Array<{ start: number; end: number }>
): LearningHrSample[] {
  return samples.filter((sample) =>
    windows.some((window) => sample.elapsedSeconds >= window.start && sample.elapsedSeconds < window.end)
  );
}

function resistanceAtTime(phase: WorkPhase, elapsedSeconds: number): number | undefined {
  let active: number | undefined;
  for (const entry of phase.entries) {
    const at = phase.startElapsed + (entry.phaseElapsedSeconds ?? Math.max(0, entry.elapsedSeconds - phase.startElapsed));
    if (at <= elapsedSeconds) active = entry.resistance;
    else break;
  }
  return active;
}

function longBlockCandidate(phase: WorkPhase): { resistance?: number } {
  const thirdStart = phase.startElapsed + phase.durationSeconds * (2 / 3);
  const resistances: number[] = [];
  const begin = Math.floor(thirdStart);
  const finish = Math.max(begin + 1, Math.floor(phase.endElapsed));
  for (let elapsed = begin; elapsed < finish; elapsed++) {
    const resistance = resistanceAtTime(phase, elapsed);
    if (resistance !== undefined) resistances.push(resistance);
  }
  if (resistances.length === 0) {
    const fallback = resistanceAtTime(phase, thirdStart) ?? phase.finalResistance;
    if (fallback !== undefined) resistances.push(fallback);
  }
  return { resistance: integerMedian(resistances) };
}

function repeatedIntervalCandidate(phases: WorkPhase[]): { resistance?: number; late: WorkPhase[] } {
  const late = lastHalf(phases);
  return {
    resistance: integerMedian(late.map((phase) => phase.finalResistance)),
    late,
  };
}

export function hrResponseQualifies(
  samples: readonly LearningHrSample[],
  windows: Array<{ start: number; end: number }>,
  targetMin?: number,
  targetMax?: number
): boolean {
  if (targetMin === undefined || targetMax === undefined) return false;
  const median = rollingHrMedian(samplesInWindows(samples, windows));
  if (median === undefined) return false;
  return median >= targetMin - 3 && median <= targetMax + 3;
}

function phaseHrQualifies(phase: WorkPhase, samples: readonly LearningHrSample[]): boolean {
  return hrResponseQualifies(
    samples,
    [lateHrWindow(phase)],
    phase.targetHeartRateMin,
    phase.targetHeartRateMax
  );
}

function lateWorkHrQualifies(phases: readonly WorkPhase[], samples: readonly LearningHrSample[]): boolean {
  return phases.length > 0 && phases.every((phase) => phaseHrQualifies(phase, samples));
}

export function deriveLearningCandidate(
  summary: Pick<
    WorkoutSummary,
    "cancelled" | "activity" | "machine_id" | "machine_profile_version" | "intent" | "machine_guidance_trace"
  >,
  hrSamples: readonly LearningHrSample[]
): { key: LearningKeyParts; resistance: number } | undefined {
  if (summary.cancelled) return undefined;
  if (summary.activity !== "bike") return undefined;
  if (summary.machine_id !== "proform-smart-power-10") return undefined;
  const machine = getMachineDefinition(summary.machine_id);
  if (!machine || summary.machine_profile_version !== machine.profileVersion) return undefined;
  if (!isLearningIntent(summary.intent)) return undefined;
  const phases = collectWorkPhases(summary.machine_guidance_trace ?? []);
  if (phases.length === 0) return undefined;

  const classes = new Set(phases.map((phase) => phase.durationClass));
  if (classes.size !== 1) return undefined;
  const durationClass = phases[0].durationClass;

  const singleLong = durationClass === "long" && phases.length === 1;
  const derived = singleLong
    ? { ...longBlockCandidate(phases[0]), late: phases }
    : repeatedIntervalCandidate(phases);
  if (derived.resistance === undefined) return undefined;
  if (!lateWorkHrQualifies(derived.late, hrSamples)) return undefined;

  return {
    key: {
      machineId: "proform-smart-power-10",
      machineProfileVersion: machine.profileVersion,
      activity: "bike",
      intent: summary.intent,
      durationClass,
    },
    resistance: clampAutomaticResistance(derived.resistance),
  };
}
