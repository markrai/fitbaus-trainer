export const LEARNING_STORAGE_KEY = "fitbaus_trainer_machine_learning";
export const LEARNING_STORE_VERSION = 1;
export function workDurationClass(durationSeconds) {
    if (durationSeconds <= 75)
        return "short";
    if (durationSeconds <= 150)
        return "medium";
    return "long";
}
export function isWorkDurationClass(value) {
    return value === "short" || value === "medium" || value === "long";
}
export function isLearningIntent(value) {
    return typeof value === "string" && /^[a-z0-9_]+$/i.test(value) && value !== "unknown";
}
export function learningKey(parts) {
    return [
        parts.machineId,
        parts.machineProfileVersion,
        parts.activity,
        parts.intent,
        parts.durationClass,
    ].join("|");
}
export function parseLearningKey(key) {
    const parts = key.split("|");
    if (parts.length !== 5)
        return undefined;
    const [machineId, versionRaw, activity, intent, durationClass] = parts;
    const machineProfileVersion = Number(versionRaw);
    if (!Number.isInteger(machineProfileVersion) || machineProfileVersion < 1)
        return undefined;
    if (activity !== "bike" && activity !== "elliptical" && activity !== "strength")
        return undefined;
    if (!isLearningIntent(intent) || !isWorkDurationClass(durationClass))
        return undefined;
    if (machineId !== "proform-smart-power-10")
        return undefined;
    return {
        machineId,
        machineProfileVersion,
        activity,
        intent,
        durationClass,
    };
}
export function formatLearnedGuidanceLabel(intent, durationClass) {
    var _a;
    const intentLabels = {
        vo2_primer: "VO₂",
        vo2_priority: "VO₂ priority",
        threshold: "Threshold",
        aerobic_base: "Aerobic base",
    };
    const classLabels = {
        short: "short intervals",
        medium: "medium work",
        long: "long work",
    };
    return `${(_a = intentLabels[intent]) !== null && _a !== void 0 ? _a : intent} ${classLabels[durationClass]}`;
}
