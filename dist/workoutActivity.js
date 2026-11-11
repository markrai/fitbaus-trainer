export const ACTIVITY_LABELS = {
    bike: "Bike",
    elliptical: "Elliptical",
    strength: "Strength",
};
export function isActivity(value) {
    return value === "bike" || value === "elliptical" || value === "strength";
}
export function getAllowedActivities(activities) {
    if (!Array.isArray(activities))
        return [];
    return activities.filter(isActivity);
}
export function getActiveWorkoutActivity(allowed, selected) {
    const allowedList = getAllowedActivities(allowed);
    if (allowedList.length === 1)
        return allowedList[0];
    if (isActivity(selected) && allowedList.includes(selected))
        return selected;
    return undefined;
}
export function requireAllowedActivity(allowed, candidate) {
    const allowedList = getAllowedActivities(allowed);
    if (isActivity(candidate) && allowedList.includes(candidate))
        return candidate;
    throw new Error(`Activity ${String(candidate)} is not allowed for this workout`);
}
