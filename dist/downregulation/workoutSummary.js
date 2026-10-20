/**
 * Generate WorkoutSummary for a Downregulation session so it can be stored and synced to Sisu.
 */
import { getHrSamples } from "../workoutStorage.js";
import { calculateZoneMinutes, determinePrimaryZone } from "../zoneCalculator.js";
import { buildHrTrace, determineStressProfile } from "../workoutSummary.js";
import { formatISO8601UTC } from "../utils/dateTime.js";
import { captureAthleteFitnessSnapshot } from "../fitnessState.js";
const MAX_DURATION_MINUTES = 1440;
const DOWNREGULATION_DAY = "Downregulation";
const DOWNREGULATION_INTENT = "physiological_downregulation";
/**
 * Build a WorkoutSummary for a completed Downregulation session.
 * Uses HR samples from IndexedDB; if none (no strap), creates summary with empty hr_trace and zones 0.
 */
export async function generateDownregulationSummary(sessionId, startedAt, endedAt, _stats) {
    const durationMs = endedAt - startedAt;
    const durationMinutes = Math.round(durationMs / (1000 * 60));
    if (durationMinutes > MAX_DURATION_MINUTES) {
        throw new Error(`Downregulation duration ${durationMinutes} minutes exceeds maximum of ${MAX_DURATION_MINUTES} minutes. Started: ${new Date(startedAt).toISOString()}, Ended: ${new Date(endedAt).toISOString()}`);
    }
    const hrSamples = await getHrSamples(sessionId);
    let zoneMinutes = calculateZoneMinutes(hrSamples);
    let primaryZone = determinePrimaryZone(zoneMinutes);
    let stressProfile = determineStressProfile(primaryZone);
    let hrTrace = buildHrTrace(hrSamples);
    if (!hrSamples || hrSamples.length === 0) {
        zoneMinutes = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
        primaryZone = 1;
        stressProfile = "low";
        hrTrace = { sampling_interval_seconds: 60, samples: [] };
        // Ensure zone sum equals duration for validation: put full duration in z1
        zoneMinutes.z1 = durationMinutes;
    }
    const summary = {
        external_session_id: sessionId,
        startedAt: formatISO8601UTC(startedAt),
        endedAt: formatISO8601UTC(endedAt),
        category: "cardio",
        intent: DOWNREGULATION_INTENT,
        duration_minutes: durationMinutes,
        primary_zone: primaryZone,
        stress_profile: stressProfile,
        zone_minutes: zoneMinutes,
        hr_trace: hrTrace,
        day: DOWNREGULATION_DAY,
        cancelled: false,
    };
    const athleteFitnessSnapshot = captureAthleteFitnessSnapshot();
    summary.athlete_id = athleteFitnessSnapshot.athleteId;
    summary.athlete_fitness_snapshot = athleteFitnessSnapshot;
    // Align zone sum with duration_minutes if needed (e.g. rounding)
    const zoneSum = summary.zone_minutes.z1 +
        summary.zone_minutes.z2 +
        summary.zone_minutes.z3 +
        summary.zone_minutes.z4 +
        summary.zone_minutes.z5;
    if (zoneSum !== summary.duration_minutes) {
        const diff = summary.duration_minutes - zoneSum;
        const key = `z${summary.primary_zone}`;
        summary.zone_minutes[key] = Math.max(0, summary.zone_minutes[key] + diff);
    }
    return summary;
}
