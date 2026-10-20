import { integerMedian } from "../hrQuality.js";
import { responseDetectionRate } from "./derive.js";
import type { RecentHrResponse } from "./types.js";

export function recentDetectedDelays(responses: readonly RecentHrResponse[]): number[] {
  return responses.filter(
    (value): value is number => value !== null && Number.isInteger(value) && Number.isFinite(value)
  );
}

export function recentObservationCount(responses: readonly RecentHrResponse[]): number {
  return responses.length;
}

export function recentDetectedCount(responses: readonly RecentHrResponse[]): number {
  return recentDetectedDelays(responses).length;
}

export function recentDetectionRate(responses: readonly RecentHrResponse[]): number | undefined {
  return responseDetectionRate(recentDetectedCount(responses), recentObservationCount(responses));
}

export function delayConcentrationNearMedian(
  delays: readonly number[],
  windowSeconds: number
): number | undefined {
  const values = delays.filter((value) => Number.isInteger(value) && Number.isFinite(value));
  if (values.length === 0) return undefined;
  if (!Number.isFinite(windowSeconds) || windowSeconds < 0) return undefined;
  const median = integerMedian(values);
  if (median === undefined) return undefined;
  const near = values.filter((value) => Math.abs(value - median) <= windowSeconds).length;
  return near / values.length;
}
