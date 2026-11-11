import { getHrSamples } from "../../workoutStorage.js";
import { deriveLearningCandidate } from "./derive.js";
import { applyConservativeUpdate, getLearnedStartingResistance, loadLearnedStore, putLearnedStart, } from "./storage.js";
import { learningKey, workDurationClass, } from "./types.js";
export { LEARNING_STORAGE_KEY, formatLearnedGuidanceLabel, learningKey, parseLearningKey, workDurationClass, } from "./types.js";
export { applyConservativeUpdate, getLearnedStartingResistance, listLearnedStarts, loadLearnedStore, putLearnedStart, resetLearnedGuidanceForMachine, saveLearnedStore, } from "./storage.js";
export { deriveLearningCandidate, hrResponseQualifies, integerMedian, lateHrWindow, rollingHrMedian } from "./derive.js";
export function lookupLearnedWorkStart(parts, storage) {
    return getLearnedStartingResistance({
        machineId: parts.machineId,
        machineProfileVersion: parts.machineProfileVersion,
        activity: parts.activity,
        intent: parts.intent,
        durationClass: workDurationClass(parts.durationSeconds),
    }, storage);
}
export function applyCompletedWorkoutLearning(summary, hrSamples, storage, updatedAt = new Date().toISOString()) {
    const candidate = deriveLearningCandidate(summary, hrSamples);
    if (!candidate)
        return undefined;
    const store = loadLearnedStore(storage);
    const previous = store.entries[learningKey(candidate.key)];
    return putLearnedStart(candidate.key, applyConservativeUpdate(previous, candidate.resistance, updatedAt), storage);
}
export async function learnFromCompletedWorkout(summary, storage) {
    if (summary.cancelled)
        return undefined;
    try {
        const samples = await getHrSamples(summary.external_session_id);
        return applyCompletedWorkoutLearning(summary, samples.map((sample) => ({ elapsedSeconds: sample.timestamp_sec, bpm: sample.hr })), storage);
    }
    catch (error) {
        console.error("Machine starting-resistance learning failed:", error);
        return undefined;
    }
}
