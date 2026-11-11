import type { Activity } from "./types.js";

export const ACTIVITY_LABELS: Record<Activity, string> = {
  bike: "Bike",
  elliptical: "Elliptical",
  strength: "Strength",
};

export function isActivity(value: unknown): value is Activity {
  return value === "bike" || value === "elliptical" || value === "strength";
}

export function getAllowedActivities(activities: unknown): Activity[] {
  if (!Array.isArray(activities)) return [];
  return activities.filter(isActivity);
}

export function getActiveWorkoutActivity(
  allowed: readonly Activity[] | undefined | null,
  selected?: unknown
): Activity | undefined {
  const allowedList = getAllowedActivities(allowed);
  if (allowedList.length === 1) return allowedList[0];
  if (isActivity(selected) && allowedList.includes(selected)) return selected;
  return undefined;
}

export function requireAllowedActivity(
  allowed: readonly Activity[] | undefined | null,
  candidate: unknown
): Activity {
  const allowedList = getAllowedActivities(allowed);
  if (isActivity(candidate) && allowedList.includes(candidate)) return candidate;
  throw new Error(`Activity ${String(candidate)} is not allowed for this workout`);
}
