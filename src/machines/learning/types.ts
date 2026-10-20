import type { Activity } from "../../types.js";
import type { MachineId } from "../trace.js";

export type WorkDurationClass = "short" | "medium" | "long";

export interface LearningKeyParts {
  machineId: MachineId;
  machineProfileVersion: number;
  activity: Activity;
  intent: string;
  durationClass: WorkDurationClass;
}

export interface LearnedMachineStart extends LearningKeyParts {
  resistance: number;
  sampleCount: number;
  updatedAt: string;
}

export interface StoredLearnedEntry {
  resistance: number;
  sampleCount: number;
  updatedAt: string;
}

export interface LearnedMachineStore {
  version: 1;
  entries: Record<string, StoredLearnedEntry>;
}

export interface LearningHrSample {
  elapsedSeconds: number;
  bpm: number;
}

export const LEARNING_STORAGE_KEY = "fitbaus_trainer_machine_learning";
export const LEARNING_STORE_VERSION = 1 as const;

export function workDurationClass(durationSeconds: number): WorkDurationClass {
  if (durationSeconds <= 75) return "short";
  if (durationSeconds <= 150) return "medium";
  return "long";
}

export function isWorkDurationClass(value: unknown): value is WorkDurationClass {
  return value === "short" || value === "medium" || value === "long";
}

export function isLearningIntent(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_]+$/i.test(value) && value !== "unknown";
}

export function learningKey(parts: LearningKeyParts): string {
  return [
    parts.machineId,
    parts.machineProfileVersion,
    parts.activity,
    parts.intent,
    parts.durationClass,
  ].join("|");
}

export function parseLearningKey(key: string): LearningKeyParts | undefined {
  const parts = key.split("|");
  if (parts.length !== 5) return undefined;
  const [machineId, versionRaw, activity, intent, durationClass] = parts;
  const machineProfileVersion = Number(versionRaw);
  if (!Number.isInteger(machineProfileVersion) || machineProfileVersion < 1) return undefined;
  if (activity !== "bike" && activity !== "elliptical" && activity !== "strength") return undefined;
  if (!isLearningIntent(intent) || !isWorkDurationClass(durationClass)) return undefined;
  if (machineId !== "proform-smart-power-10") return undefined;
  return {
    machineId,
    machineProfileVersion,
    activity,
    intent,
    durationClass,
  };
}

export function formatLearnedGuidanceLabel(intent: string, durationClass: WorkDurationClass): string {
  const intentLabels: Record<string, string> = {
    vo2_primer: "VO₂",
    vo2_priority: "VO₂ priority",
    threshold: "Threshold",
    aerobic_base: "Aerobic base",
  };
  const classLabels: Record<WorkDurationClass, string> = {
    short: "short intervals",
    medium: "medium work",
    long: "long work",
  };
  return `${intentLabels[intent] ?? intent} ${classLabels[durationClass]}`;
}
