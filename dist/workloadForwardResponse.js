/**
 * Pure, policy-neutral mechanics shared by workload/physiological-response reducers.
 * Consumers own admission, provenance, cadence, domain, exclusion, and persistence policy.
 */
/** Stable ordering by active second. Equal seconds retain input order. */
export function orderByActiveSecond(observations) {
    return [...observations].sort((a, b) => a.activeSec - b.activeSec);
}
/**
 * Active-clock continuity with a wall-clock guard. Advancing active time must
 * also advance wall time, without exceeding the consumer-supplied tolerance.
 */
export function observationsAreContinuous(previous, next, policy) {
    const activeStep = next.activeSec - previous.activeSec;
    if (activeStep < 1 || activeStep > policy.maxObservationGapSec)
        return false;
    const wallStep = (Date.parse(next.observedAt) - Date.parse(previous.observedAt)) / 1000;
    return Number.isFinite(wallStep) && wallStep > 0 &&
        Math.abs(wallStep - activeStep) <= policy.maxWallClockExcessSec;
}
/** Maximal chronological runs of unchanged observed resistance and compatible provenance. */
export function segmentStableResistance(observations, policy) {
    const windows = [];
    let current;
    for (const observation of observations) {
        if (observation.observedResistance === undefined) {
            current = undefined;
            continue;
        }
        const previous = current === null || current === void 0 ? void 0 : current.observations[current.observations.length - 1];
        const continues = current !== undefined && previous !== undefined &&
            observationsAreContinuous(previous, observation, policy) &&
            current.resistance === observation.observedResistance &&
            (observation.workloadProvenance === undefined || current.workloadProvenance === undefined ||
                current.workloadProvenance === observation.workloadProvenance);
        if (!continues) {
            current = { resistance: observation.observedResistance, observations: [] };
            windows.push(current);
        }
        current.observations.push(observation);
        if (observation.workloadProvenance !== undefined && current.workloadProvenance === undefined) {
            current.workloadProvenance = observation.workloadProvenance;
        }
    }
    return windows;
}
/** Resistance changes count only across observations that satisfy continuity. */
export function countContinuousResistanceChanges(observations, policy) {
    let count = 0;
    let previous;
    for (const observation of observations) {
        if (observation.observedResistance === undefined) {
            previous = undefined;
            continue;
        }
        if (previous && observationsAreContinuous(previous, observation, policy) &&
            previous.observedResistance !== observation.observedResistance)
            count += 1;
        previous = observation;
    }
    return count;
}
/** Inclusive active seconds remaining after a consumer-supplied settling interval. */
export function settledActiveSeconds(firstActiveSec, lastActiveSec, settlingSeconds) {
    const seconds = [];
    for (let second = firstActiveSec + settlingSeconds; second <= lastActiveSec; second += 1)
        seconds.push(second);
    return seconds;
}
export function numericQuantile(values, probability) {
    const ordered = [...values].sort((a, b) => a - b);
    if (ordered.length === 1)
        return ordered[0];
    const position = (ordered.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const fraction = position - lower;
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction;
}
export function numericMedian(values) {
    return numericQuantile(values, 0.5);
}
export function numericDistribution(values) {
    return {
        median: numericMedian(values),
        q1: numericQuantile(values, 0.25),
        q3: numericQuantile(values, 0.75),
        min: Math.min(...values),
        max: Math.max(...values),
    };
}
export function predictForwardResponse(model, workload) {
    return model.intercept + model.slope * workload;
}
/** Signed response error is observation minus prediction. */
export function signedPredictionError(observed, predicted) {
    return observed - predicted;
}
export function absolutePredictionError(observed, predicted) {
    return Math.abs(signedPredictionError(observed, predicted));
}
