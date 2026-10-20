import { integerMedian } from "../hrQuality.js";
import { responseDetectionRate } from "./derive.js";
export function recentDetectedDelays(responses) {
    return responses.filter((value) => value !== null && Number.isInteger(value) && Number.isFinite(value));
}
export function recentObservationCount(responses) {
    return responses.length;
}
export function recentDetectedCount(responses) {
    return recentDetectedDelays(responses).length;
}
export function recentDetectionRate(responses) {
    return responseDetectionRate(recentDetectedCount(responses), recentObservationCount(responses));
}
export function delayConcentrationNearMedian(delays, windowSeconds) {
    const values = delays.filter((value) => Number.isInteger(value) && Number.isFinite(value));
    if (values.length === 0)
        return undefined;
    if (!Number.isFinite(windowSeconds) || windowSeconds < 0)
        return undefined;
    const median = integerMedian(values);
    if (median === undefined)
        return undefined;
    const near = values.filter((value) => Math.abs(value - median) <= windowSeconds).length;
    return near / values.length;
}
