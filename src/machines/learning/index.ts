import { getHrSamples } from "../../workoutStorage.js";
import type { WorkoutSummary } from "../../types.js";
import { deriveLearningCandidate } from "./derive.js";
import {
  applyConservativeUpdate,
  getLearnedStartingResistance,
  loadLearnedStore,
  putLearnedStart,
  type LearningStorage,
} from "./storage.js";
import {
  learningKey,
  workDurationClass,
  type LearningHrSample,
  type LearningKeyParts,
} from "./types.js";

export {
  LEARNING_STORAGE_KEY,
  formatLearnedGuidanceLabel,
  learningKey,
  parseLearningKey,
  workDurationClass,
  type LearnedMachineStart,
  type LearningKeyParts,
  type WorkDurationClass,
} from "./types.js";
export {
  applyConservativeUpdate,
  getLearnedStartingResistance,
  listLearnedStarts,
  loadLearnedStore,
  putLearnedStart,
  resetLearnedGuidanceForMachine,
  saveLearnedStore,
} from "./storage.js";
export { deriveLearningCandidate, hrResponseQualifies, integerMedian, lateHrWindow, rollingHrMedian } from "./derive.js";

export function lookupLearnedWorkStart(
  parts: Omit<LearningKeyParts, "durationClass"> & { durationSeconds: number },
  storage?: LearningStorage
): number | undefined {
  return getLearnedStartingResistance(
    {
      machineId: parts.machineId,
      machineProfileVersion: parts.machineProfileVersion,
      activity: parts.activity,
      intent: parts.intent,
      durationClass: workDurationClass(parts.durationSeconds),
    },
    storage
  );
}

export function applyCompletedWorkoutLearning(
  summary: WorkoutSummary,
  hrSamples: readonly LearningHrSample[],
  storage?: LearningStorage,
  updatedAt = new Date().toISOString()
) {
  const candidate = deriveLearningCandidate(summary, hrSamples);
  if (!candidate) return undefined;
  const store = loadLearnedStore(storage);
  const previous = store.entries[learningKey(candidate.key)];
  return putLearnedStart(
    candidate.key,
    applyConservativeUpdate(previous, candidate.resistance, updatedAt),
    storage
  );
}

export async function learnFromCompletedWorkout(summary: WorkoutSummary, storage?: LearningStorage) {
  if (summary.cancelled) return undefined;
  try {
    const samples = await getHrSamples(summary.external_session_id);
    return applyCompletedWorkoutLearning(
      summary,
      samples.map((sample) => ({ elapsedSeconds: sample.timestamp_sec, bpm: sample.hr })),
      storage
    );
  } catch (error) {
    console.error("Machine starting-resistance learning failed:", error);
    return undefined;
  }
}
