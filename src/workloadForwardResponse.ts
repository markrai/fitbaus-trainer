/**
 * Pure, policy-neutral mechanics shared by workload/physiological-response reducers.
 * Consumers own admission, provenance, cadence, domain, exclusion, and persistence policy.
 */

export interface ActiveSecondObservation {
  activeSec: number;
}

export interface TimedActiveSecondObservation extends ActiveSecondObservation {
  observedAt: string;
}

export interface StableResistanceObservation extends TimedActiveSecondObservation {
  /** Undefined observations cannot establish or preserve a resistance hold. */
  observedResistance?: number;
  /** Optional workload-source identity; conflicting defined values split a hold. */
  workloadProvenance?: string;
}

export interface ObservationContinuityPolicy {
  maxObservationGapSec: number;
  maxWallClockExcessSec: number;
}

export interface StableResistanceWindow<T extends StableResistanceObservation> {
  resistance: number;
  workloadProvenance?: string;
  observations: T[];
}

export interface NumericDistribution {
  median: number;
  q1: number;
  q3: number;
  min: number;
  max: number;
}

export interface LinearForwardModel {
  intercept: number;
  slope: number;
}

/** Stable ordering by active second. Equal seconds retain input order. */
export function orderByActiveSecond<T extends ActiveSecondObservation>(observations: readonly T[]): T[] {
  return [...observations].sort((a, b) => a.activeSec - b.activeSec);
}

/**
 * Active-clock continuity with a wall-clock guard. Advancing active time must
 * also advance wall time, without exceeding the consumer-supplied tolerance.
 */
export function observationsAreContinuous(
  previous: TimedActiveSecondObservation,
  next: TimedActiveSecondObservation,
  policy: ObservationContinuityPolicy
): boolean {
  const activeStep = next.activeSec - previous.activeSec;
  if (activeStep < 1 || activeStep > policy.maxObservationGapSec) return false;
  const wallStep = (Date.parse(next.observedAt) - Date.parse(previous.observedAt)) / 1000;
  return Number.isFinite(wallStep) && wallStep > 0 &&
    Math.abs(wallStep - activeStep) <= policy.maxWallClockExcessSec;
}

/** Maximal chronological runs of unchanged observed resistance and compatible provenance. */
export function segmentStableResistance<T extends StableResistanceObservation>(
  observations: readonly T[],
  policy: ObservationContinuityPolicy
): StableResistanceWindow<T>[] {
  const windows: StableResistanceWindow<T>[] = [];
  let current: StableResistanceWindow<T> | undefined;
  for (const observation of observations) {
    if (observation.observedResistance === undefined) {
      current = undefined;
      continue;
    }
    const previous = current?.observations[current.observations.length - 1];
    const continues = current !== undefined && previous !== undefined &&
      observationsAreContinuous(previous, observation, policy) &&
      current.resistance === observation.observedResistance &&
      (observation.workloadProvenance === undefined || current.workloadProvenance === undefined ||
        current.workloadProvenance === observation.workloadProvenance);
    if (!continues) {
      current = { resistance: observation.observedResistance, observations: [] };
      windows.push(current);
    }
    current!.observations.push(observation);
    if (observation.workloadProvenance !== undefined && current!.workloadProvenance === undefined) {
      current!.workloadProvenance = observation.workloadProvenance;
    }
  }
  return windows;
}

/** Resistance changes count only across observations that satisfy continuity. */
export function countContinuousResistanceChanges<T extends StableResistanceObservation>(
  observations: readonly T[],
  policy: ObservationContinuityPolicy
): number {
  let count = 0;
  let previous: T | undefined;
  for (const observation of observations) {
    if (observation.observedResistance === undefined) {
      previous = undefined;
      continue;
    }
    if (previous && observationsAreContinuous(previous, observation, policy) &&
        previous.observedResistance !== observation.observedResistance) count += 1;
    previous = observation;
  }
  return count;
}

/** Inclusive active seconds remaining after a consumer-supplied settling interval. */
export function settledActiveSeconds(firstActiveSec: number, lastActiveSec: number, settlingSeconds: number): number[] {
  const seconds: number[] = [];
  for (let second = firstActiveSec + settlingSeconds; second <= lastActiveSec; second += 1) seconds.push(second);
  return seconds;
}

export function numericQuantile(values: readonly number[], probability: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  if (ordered.length === 1) return ordered[0];
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction;
}

export function numericMedian(values: readonly number[]): number {
  return numericQuantile(values, 0.5);
}

export function numericDistribution(values: readonly number[]): NumericDistribution {
  return {
    median: numericMedian(values),
    q1: numericQuantile(values, 0.25),
    q3: numericQuantile(values, 0.75),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export function predictForwardResponse(model: LinearForwardModel, workload: number): number {
  return model.intercept + model.slope * workload;
}

/** Signed response error is observation minus prediction. */
export function signedPredictionError(observed: number, predicted: number): number {
  return observed - predicted;
}

export function absolutePredictionError(observed: number, predicted: number): number {
  return Math.abs(signedPredictionError(observed, predicted));
}
