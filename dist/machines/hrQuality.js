export const MIN_HR_SAMPLES = 5;
export const MIN_HR_SPAN_SECONDS = 4;
export function validDistinctHr(samples) {
    const byElapsed = new Map();
    for (const sample of samples) {
        if (!Number.isFinite(sample.bpm) || sample.bpm <= 0)
            continue;
        if (!Number.isFinite(sample.elapsedSeconds))
            continue;
        byElapsed.set(sample.elapsedSeconds, sample.bpm);
    }
    return [...byElapsed.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([elapsedSeconds, bpm]) => ({ elapsedSeconds, bpm }));
}
export function qualifiedHrMedianDetails(samples) {
    const distinct = validDistinctHr(samples);
    if (distinct.length < MIN_HR_SAMPLES)
        return undefined;
    const span = distinct[distinct.length - 1].elapsedSeconds - distinct[0].elapsedSeconds;
    if (span < MIN_HR_SPAN_SECONDS)
        return undefined;
    const values = distinct.map((sample) => sample.bpm).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
    return {
        median,
        sampleCount: distinct.length,
        windowSpanSeconds: span,
    };
}
export function qualifiedHrMedian(samples) {
    var _a;
    return (_a = qualifiedHrMedianDetails(samples)) === null || _a === void 0 ? void 0 : _a.median;
}
export function integerMedian(values) {
    if (values.length === 0)
        return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)];
}
export function integerMedianAbsoluteDeviation(values) {
    const samples = values.filter((value) => Number.isInteger(value) && Number.isFinite(value));
    const median = integerMedian(samples);
    if (median === undefined)
        return undefined;
    return integerMedian(samples.map((value) => Math.abs(value - median)));
}
export function samplesInRange(samples, start, end, options) {
    const startExclusive = (options === null || options === void 0 ? void 0 : options.startExclusive) === true;
    const endInclusive = (options === null || options === void 0 ? void 0 : options.endInclusive) === true;
    return samples.filter((sample) => {
        const afterStart = startExclusive ? sample.elapsedSeconds > start : sample.elapsedSeconds >= start;
        const beforeEnd = endInclusive ? sample.elapsedSeconds <= end : sample.elapsedSeconds < end;
        return afterStart && beforeEnd;
    });
}
