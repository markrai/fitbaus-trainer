/**
 * Canonical finite-sample median used by ordinary workout aggregation
 * (`workoutResponse`) and performed-load descriptive statistics.
 * Empty or non-finite-only input returns undefined. Even-length samples
 * average the two central values.
 */
export function canonicalMedian(values) {
    const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
    if (finite.length === 0)
        return undefined;
    const sorted = [...finite].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}
