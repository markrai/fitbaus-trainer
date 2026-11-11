import { isActivity } from "./workoutActivity.js";
const INTENSITY_IDS = new Set([
    "warmup_easy",
    "aerobic_base",
    "threshold",
    "vo2_short",
    "vo2_long",
    "recovery",
    "cooldown",
    "strength_support",
]);
function fail(path, message) {
    throw new Error(`Invalid workout template at ${path}: ${message}`);
}
function objectAt(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail(path, "expected an object");
    return value;
}
function durationAt(value, path) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0)
        return value;
    if (typeof value === "string" && /^\d+/.test(value) && parseInt(value, 10) > 0)
        return value;
    return fail(path, "expected a positive number or a string beginning with positive minutes");
}
function targetAt(value, path) {
    if (value === undefined)
        return undefined;
    if (typeof value === "string" && value.trim() !== "")
        return value;
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    return fail(path, "expected a non-empty string or finite number");
}
function intensityAt(value, path) {
    if (value === undefined)
        return undefined;
    if (typeof value === "string" && INTENSITY_IDS.has(value))
        return value;
    return fail(path, `unknown intensity_id ${JSON.stringify(value)}`);
}
function kindAt(value, path) {
    if (value === undefined)
        return undefined;
    if (value === "warmup" || value === "work" || value === "recovery" || value === "cooldown")
        return value;
    return fail(path, `unknown phase kind ${JSON.stringify(value)}`);
}
function phaseAt(value, path) {
    const raw = objectAt(value, path);
    return {
        duration_min: durationAt(raw.duration_min, `${path}.duration_min`),
        target_hr_bpm: targetAt(raw.target_hr_bpm, `${path}.target_hr_bpm`),
        intensity_id: intensityAt(raw.intensity_id, `${path}.intensity_id`),
    };
}
function workoutAt(value, path, requireDay) {
    const raw = objectAt(value, path);
    if (requireDay && (typeof raw.day !== "string" || raw.day.trim() === ""))
        fail(`${path}.day`, "expected a day");
    if (typeof raw.type !== "string")
        fail(`${path}.type`, "expected a string");
    if (typeof raw.intent !== "string")
        fail(`${path}.intent`, "expected a string");
    if (!Array.isArray(raw.activities) || raw.activities.length === 0 || !raw.activities.every(isActivity)) {
        fail(`${path}.activities`, "expected one or more recognized activities");
    }
    const parsed = {
        day: typeof raw.day === "string" ? raw.day : undefined,
        id: typeof raw.id === "string" ? raw.id : undefined,
        type: raw.type,
        intent: raw.intent,
        activities: [...raw.activities],
    };
    if (raw.warmup !== undefined) {
        const warmRaw = objectAt(raw.warmup, `${path}.warmup`);
        const warmup = phaseAt(warmRaw, `${path}.warmup`);
        if (warmRaw.subsections !== undefined) {
            if (!Array.isArray(warmRaw.subsections))
                fail(`${path}.warmup.subsections`, "expected an array");
            warmup.subsections = warmRaw.subsections.map((entry, index) => {
                const subsection = objectAt(entry, `${path}.warmup.subsections[${index}]`);
                if (typeof subsection.name !== "string" || subsection.name.trim() === "") {
                    fail(`${path}.warmup.subsections[${index}].name`, "expected a non-empty string");
                }
                const start = Number(subsection.start_min);
                const end = Number(subsection.end_min);
                if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) {
                    fail(`${path}.warmup.subsections[${index}]`, "expected 0 <= start_min < end_min");
                }
                return {
                    name: subsection.name,
                    start_min: start,
                    end_min: end,
                    target_hr_bpm: targetAt(subsection.target_hr_bpm, `${path}.warmup.subsections[${index}].target_hr_bpm`),
                    intensity_id: intensityAt(subsection.intensity_id, `${path}.warmup.subsections[${index}].intensity_id`),
                    notes: typeof subsection.notes === "string" ? subsection.notes : undefined,
                };
            });
        }
        parsed.warmup = warmup;
    }
    if (raw.cooldown !== undefined)
        parsed.cooldown = phaseAt(raw.cooldown, `${path}.cooldown`);
    if (raw.main_set !== undefined) {
        const mainRaw = objectAt(raw.main_set, `${path}.main_set`);
        const main = {
            target_hr_bpm: targetAt(mainRaw.target_hr_bpm, `${path}.main_set.target_hr_bpm`),
            intensity_id: intensityAt(mainRaw.intensity_id, `${path}.main_set.intensity_id`),
            phase_kind: kindAt(mainRaw.phase_kind, `${path}.main_set.phase_kind`),
            is_sequence: mainRaw.is_sequence === true,
        };
        if (mainRaw.is_sequence !== undefined && typeof mainRaw.is_sequence !== "boolean") {
            fail(`${path}.main_set.is_sequence`, "expected a boolean");
        }
        if (mainRaw.duration_min !== undefined)
            main.duration_min = durationAt(mainRaw.duration_min, `${path}.main_set.duration_min`);
        if (mainRaw.repetitions !== undefined) {
            if (!Number.isInteger(mainRaw.repetitions) || mainRaw.repetitions <= 0)
                fail(`${path}.main_set.repetitions`, "expected a positive integer");
            main.repetitions = mainRaw.repetitions;
        }
        if (mainRaw.intervals !== undefined) {
            if (!Array.isArray(mainRaw.intervals) || mainRaw.intervals.length === 0)
                fail(`${path}.main_set.intervals`, "expected a non-empty array");
            main.intervals = mainRaw.intervals.map((entry, index) => {
                const intervalRaw = objectAt(entry, `${path}.main_set.intervals[${index}]`);
                if (typeof intervalRaw.phase !== "string" || intervalRaw.phase.trim() === "")
                    fail(`${path}.main_set.intervals[${index}].phase`, "expected a name");
                return {
                    ...phaseAt(intervalRaw, `${path}.main_set.intervals[${index}]`),
                    phase: intervalRaw.phase,
                    kind: kindAt(intervalRaw.kind, `${path}.main_set.intervals[${index}].kind`),
                };
            });
        }
        if (main.duration_min === undefined && !main.intervals)
            fail(`${path}.main_set`, "expected duration_min or intervals");
        parsed.main_set = main;
    }
    return parsed;
}
export function parseWorkoutTemplateDocument(value) {
    const raw = objectAt(value, "$ ".trim());
    if (!Array.isArray(raw.weekly_plan))
        fail("$.weekly_plan", "expected an array");
    return {
        weekly_plan: raw.weekly_plan.map((entry, index) => {
            const path = `$.weekly_plan[${index}]`;
            const entryRaw = objectAt(entry, path);
            if (Array.isArray(entryRaw.variants)) {
                if (entryRaw.variants.length === 0)
                    fail(`${path}.variants`, "expected a non-empty array");
                if (typeof entryRaw.day !== "string" || entryRaw.day.trim() === "")
                    fail(`${path}.day`, "expected a day");
                return {
                    day: entryRaw.day,
                    type: "",
                    intent: "",
                    activities: [],
                    variants: entryRaw.variants.map((variant, variantIndex) => workoutAt(variant, `${path}.variants[${variantIndex}]`, false)),
                };
            }
            return workoutAt(entryRaw, path, true);
        }),
    };
}
export function parseWorkoutDuration(duration) {
    if (typeof duration === "number")
        return duration;
    if (typeof duration === "string")
        return parseInt(duration, 10);
    return 0;
}
