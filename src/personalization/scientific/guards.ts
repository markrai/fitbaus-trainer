/**
 * Shared pure value guards and UTC date arithmetic for the E4A scientific
 * assessment subsystem. No clock is sampled: timestamps arrive as arguments.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export function utcDateKey(createdAt: string): string | null {
  if (!isIsoDateTime(createdAt)) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(createdAt)) return null;
  return createdAt.slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return (to - from) / (24 * 60 * 60 * 1000);
}

/**
 * Canonical E4A text order: JavaScript code-unit order of the exact stored
 * strings. Never locale-sensitive collation, no case folding or
 * normalization, so canonical identity and output order are the same on
 * every runtime and locale.
 */
export function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
