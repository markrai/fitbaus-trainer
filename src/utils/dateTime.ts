export function todayName(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long" });
}

/**
 * Canonical absolute UTC timestamp used by ordinary workout persistence
 * (`workoutSummary.endedAt` / `startedAt` via this helper).
 * Always `Date.prototype.toISOString()` form: `YYYY-MM-DDTHH:mm:ss.sssZ`.
 */
export function formatISO8601UTC(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/**
 * Accept only absolute timestamps that round-trip through `toISOString()`.
 * This matches FitnessState / profile / ordinary-summary validators and
 * rejects offsetless / locale / date-only strings whose UTC day would
 * depend on host timezone.
 */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
