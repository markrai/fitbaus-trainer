import { todayName } from "./utils/dateTime.js";
import { isActivity } from "./workoutActivity.js";
import { VO2_WORKOUT_SELECTOR_ID, vo2PlanBlocks, vo2WorkoutMetadata } from "./vo2Protocol.js";
import { parseWorkoutDuration, parseWorkoutTemplateDocument, } from "./workoutTemplate.js";
let plan = {};
let workoutMetadata = {};
let hrTargets = {};
function isWorkoutPhaseKind(value) {
    return value === "warmup" || value === "work" || value === "recovery" || value === "cooldown";
}
function parseActivities(activities) {
    if (!Array.isArray(activities))
        return [];
    return activities.filter(isActivity);
}
function getSelectedVariant(variants, now = Date.now()) {
    if (!variants || !Array.isArray(variants) || variants.length === 0)
        return null;
    const epoch = new Date("2024-01-01").getTime();
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const weekNumber = Math.floor((now - epoch) / msPerWeek);
    const variantIndex = weekNumber % variants.length;
    return variants[variantIndex];
}
function processWorkout(workout, transformed) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    if (!workout || !workout.day)
        return;
    const warm = parseWorkoutDuration((_a = workout.warmup) === null || _a === void 0 ? void 0 : _a.duration_min);
    const cool = parseWorkoutDuration((_b = workout.cooldown) === null || _b === void 0 ? void 0 : _b.duration_min);
    hrTargets[workout.day] = {
        warmup: ((_c = workout.warmup) === null || _c === void 0 ? void 0 : _c.target_hr_bpm) || "",
        warmup_intensity_id: (_d = workout.warmup) === null || _d === void 0 ? void 0 : _d.intensity_id,
        warmup_subsections: ((_e = workout.warmup) === null || _e === void 0 ? void 0 : _e.subsections) || null,
        cooldown: ((_f = workout.cooldown) === null || _f === void 0 ? void 0 : _f.target_hr_bpm) || "",
        cooldown_intensity_id: (_g = workout.cooldown) === null || _g === void 0 ? void 0 : _g.intensity_id,
        main_set: ((_h = workout.main_set) === null || _h === void 0 ? void 0 : _h.target_hr_bpm) || "",
        main_set_intensity_id: (_j = workout.main_set) === null || _j === void 0 ? void 0 : _j.intensity_id,
        main_set_kind: isWorkoutPhaseKind((_k = workout.main_set) === null || _k === void 0 ? void 0 : _k.phase_kind) ? workout.main_set.phase_kind : "work",
        intervals: null,
    };
    let sustain = 0;
    if (workout.main_set) {
        if (workout.main_set.duration_min) {
            sustain = parseWorkoutDuration(workout.main_set.duration_min);
        }
        else if (workout.main_set.intervals && Array.isArray(workout.main_set.intervals)) {
            const intervals = workout.main_set.intervals;
            const isSequence = workout.main_set.is_sequence === true;
            let totalDuration = 0;
            const intervalPhases = [];
            intervals.forEach((interval) => {
                let intervalDuration = 0;
                if (interval.duration_min)
                    intervalDuration = parseWorkoutDuration(interval.duration_min);
                totalDuration += intervalDuration;
                intervalPhases.push({
                    phase: interval.phase,
                    kind: isWorkoutPhaseKind(interval.kind) ? interval.kind : "work",
                    duration: intervalDuration,
                    target_hr_bpm: interval.target_hr_bpm || "",
                    intensity_id: interval.intensity_id,
                });
            });
            if (isSequence) {
                sustain = totalDuration;
                hrTargets[workout.day].intervals = { phases: intervalPhases, repetitions: 1, isSequence: true };
            }
            else {
                const repetitions = workout.main_set.repetitions || 1;
                sustain = totalDuration * repetitions;
                hrTargets[workout.day].intervals = { phases: intervalPhases, repetitions, isSequence: false };
            }
        }
    }
    if (warm > 0 || sustain > 0 || cool > 0) {
        transformed[workout.day] = { warm, sustain, cool };
        workoutMetadata[workout.day] = {
            type: workout.type || "",
            intent: workout.intent || "",
            activities: parseActivities(workout.activities),
        };
    }
    else {
        transformed[workout.day] = null;
    }
}
function transformWorkoutData(workoutData, now = Date.now()) {
    const transformed = {};
    if (!workoutData || !workoutData.weekly_plan) {
        console.error("Invalid workout data structure");
        return transformed;
    }
    workoutData.weekly_plan.forEach((workout) => {
        if (!workout || !workout.day)
            return;
        if (workout.variants && Array.isArray(workout.variants) && workout.variants.length > 0) {
            const selectedVariant = getSelectedVariant(workout.variants, now);
            if (selectedVariant) {
                const variantWorkout = { ...selectedVariant, day: workout.day };
                processWorkout(variantWorkout, transformed);
            }
        }
        else {
            processWorkout(workout, transformed);
        }
    });
    plan = transformed;
    return transformed;
}
async function initializeWorkoutPlan() {
    workoutMetadata = {};
    hrTargets = {};
    try {
        const response = await fetch("data.json");
        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);
        const workoutData = parseWorkoutTemplateDocument(await response.json());
        plan = transformWorkoutData(workoutData);
    }
    catch (error) {
        console.error("Failed to load workout data from data.json:", error);
        plan = {};
        workoutMetadata = {};
        hrTargets = {};
    }
    const today = todayName();
    console.log("Today is:", today, "Plan for today:", plan[today]);
    installStandaloneVo2Workout();
}
function installStandaloneVo2Workout() {
    plan[VO2_WORKOUT_SELECTOR_ID] = vo2PlanBlocks();
    workoutMetadata[VO2_WORKOUT_SELECTOR_ID] = vo2WorkoutMetadata();
    hrTargets[VO2_WORKOUT_SELECTOR_ID] = {
        intervals: null,
        main_set_kind: "work",
    };
}
const getPlan = () => plan;
const getWorkoutMetadata = () => workoutMetadata;
const getHrTargets = () => hrTargets;
export function registerWorkoutDataGlobals() {
    window.initializeWorkoutPlan = initializeWorkoutPlan;
    window.getPlan = getPlan;
    window.getWorkoutMetadata = getWorkoutMetadata;
    window.getHrTargets = getHrTargets;
}
export { initializeWorkoutPlan, getPlan, getWorkoutMetadata, getHrTargets, installStandaloneVo2Workout, getSelectedVariant, transformWorkoutData, };
