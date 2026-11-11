/**
 * Downregulation session tracking and stats.
 * Tracks HR over the session; on end, computes comprehensive stats (including when ending HR is higher than starting).
 * Does not depend on DOM or overlay.
 */
import { getSmoothedHR, getBaselineHR } from "./hrController.js";
const SAMPLE_INTERVAL_MS = 1000;
let sessionStartTime = null;
let sampleIntervalId = null;
let firstHR = null;
let lastHR = null;
let minHR = null;
let maxHR = null;
let sumHR = 0;
let sampleCount = 0;
function sampleHR() {
    const bpm = getSmoothedHR();
    if (bpm == null || !Number.isFinite(bpm))
        return;
    if (firstHR === null)
        firstHR = bpm;
    lastHR = bpm;
    if (minHR === null || bpm < minHR)
        minHR = bpm;
    if (maxHR === null || bpm > maxHR)
        maxHR = bpm;
    sumHR += bpm;
    sampleCount += 1;
}
/**
 * Call when the downregulation view starts. Starts sampling HR every second.
 */
export function startSession() {
    if (sampleIntervalId != null)
        return;
    sessionStartTime = Date.now();
    firstHR = null;
    lastHR = null;
    minHR = null;
    maxHR = null;
    sumHR = 0;
    sampleCount = 0;
    sampleHR();
    sampleIntervalId = setInterval(sampleHR, SAMPLE_INTERVAL_MS);
}
/**
 * Call when leaving the view without tapping to end (e.g. switched day). Stops sampling, no stats.
 */
export function cancelSession() {
    if (sampleIntervalId != null) {
        clearInterval(sampleIntervalId);
        sampleIntervalId = null;
    }
    sessionStartTime = null;
    firstHR = null;
    lastHR = null;
    minHR = null;
    maxHR = null;
    sumHR = 0;
    sampleCount = 0;
}
/**
 * Call when the user taps to end the session. Stops sampling and returns comprehensive stats.
 */
export function endSession() {
    var _a, _b, _c, _d;
    if (sampleIntervalId != null) {
        clearInterval(sampleIntervalId);
        sampleIntervalId = null;
    }
    sampleHR(); // one final sample
    const baseline = getBaselineHR();
    const end = (_b = (_a = lastHR !== null && lastHR !== void 0 ? lastHR : firstHR) !== null && _a !== void 0 ? _a : baseline) !== null && _b !== void 0 ? _b : null;
    const start = (_d = (_c = firstHR !== null && firstHR !== void 0 ? firstHR : baseline) !== null && _c !== void 0 ? _c : end) !== null && _d !== void 0 ? _d : null;
    const durationMs = sessionStartTime != null ? Date.now() - sessionStartTime : 0;
    const durationSec = Math.round(durationMs / 1000);
    const avgHR = sampleCount > 0 ? sumHR / sampleCount : null;
    const capturedMin = minHR;
    const capturedMax = maxHR;
    sessionStartTime = null;
    firstHR = null;
    lastHR = null;
    minHR = null;
    maxHR = null;
    sumHR = 0;
    sampleCount = 0;
    return buildStats({
        baseline,
        start,
        end,
        minHR: capturedMin,
        maxHR: capturedMax !== null && capturedMax !== void 0 ? capturedMax : null,
        avgHR,
        durationSec,
        sampleCount,
    });
}
function buildStats(raw) {
    const lines = [];
    const { baseline, start, end, minHR, maxHR, avgHR, durationSec } = raw;
    const durationMin = Math.floor(durationSec / 60);
    const durationSecRem = durationSec % 60;
    const durationStr = durationMin > 0 ? `${durationMin} min ${durationSecRem} s` : `${durationSec} s`;
    lines.push(`Duration: ${durationStr}`);
    if (baseline != null) {
        lines.push(`Baseline (first 30 s): ${Math.round(baseline)} bpm`);
    }
    if (start != null) {
        lines.push(`Starting HR: ${Math.round(start)} bpm`);
    }
    if (end != null) {
        lines.push(`Ending HR: ${Math.round(end)} bpm`);
    }
    if (baseline != null && end != null) {
        const diff = end - baseline;
        if (diff < 0) {
            lines.push(`Ended ${Math.round(-diff)} bpm below baseline`);
        }
        else if (diff > 0) {
            lines.push(`Ended ${Math.round(diff)} bpm above baseline`);
        }
        else {
            lines.push("Ended at baseline");
        }
    }
    if (start != null && end != null) {
        const change = end - start;
        if (change < 0) {
            lines.push(`Reduction from start: ${Math.round(-change)} bpm`);
        }
        else if (change > 0) {
            lines.push(`Change from start: +${Math.round(change)} bpm`);
        }
    }
    if (minHR != null) {
        lines.push(`Lowest HR in session: ${Math.round(minHR)} bpm`);
    }
    if (maxHR != null && (minHR == null || maxHR !== minHR)) {
        lines.push(`Highest HR in session: ${Math.round(maxHR)} bpm`);
    }
    if (avgHR != null) {
        lines.push(`Average HR: ${Math.round(avgHR)} bpm`);
    }
    if (baseline != null && avgHR != null && avgHR < baseline) {
        lines.push(`Average was ${Math.round(baseline - avgHR)} bpm below baseline`);
    }
    return {
        baselineBpm: baseline !== null && baseline !== void 0 ? baseline : null,
        startBpm: start !== null && start !== void 0 ? start : null,
        endBpm: end !== null && end !== void 0 ? end : null,
        minBpm: minHR !== null && minHR !== void 0 ? minHR : null,
        maxBpm: maxHR !== null && maxHR !== void 0 ? maxHR : null,
        avgBpm: avgHR !== null && avgHR !== void 0 ? avgHR : null,
        durationSec: raw.durationSec,
        summaryLines: lines,
    };
}
