/**
 * Shared pure value guards and UTC date arithmetic for the E4A scientific
 * assessment subsystem. No clock is sampled: timestamps arrive as arguments.
 */
export function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
export function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
export function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}
export function isIsoDateTime(value) {
    if (typeof value !== "string" || value === "")
        return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed);
}
export function utcDateKey(createdAt) {
    if (!isIsoDateTime(createdAt))
        return null;
    if (!/^\d{4}-\d{2}-\d{2}/.test(createdAt))
        return null;
    return createdAt.slice(0, 10);
}
export function daysBetween(fromIso, toIso) {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    if (!Number.isFinite(from) || !Number.isFinite(to))
        return null;
    return (to - from) / (24 * 60 * 60 * 1000);
}
