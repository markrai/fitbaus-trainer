import { integerMedian, qualifiedHrMedian } from "../hrQuality.js";
import { clampAutomaticResistance } from "../proformSmartPower10.js";
import { getMachineDefinition } from "../registry.js";
import { isLearningIntent, workDurationClass, } from "./types.js";
export { integerMedian };
export function rollingHrMedian(samples) {
    return qualifiedHrMedian(samples);
}
function collectWorkPhases(trace) {
    var _a, _b, _c;
    const grouped = new Map();
    for (const entry of trace) {
        if (entry.phaseKind !== "work" || !entry.phaseId)
            continue;
        if (!Number.isFinite(entry.phaseDurationSeconds) || entry.phaseDurationSeconds <= 0)
            continue;
        if (!Number.isInteger(entry.resistance))
            continue;
        const list = (_a = grouped.get(entry.phaseId)) !== null && _a !== void 0 ? _a : [];
        list.push(entry);
        grouped.set(entry.phaseId, list);
    }
    const phases = [];
    for (const [phaseId, entries] of grouped) {
        const ordered = [...entries].sort((a, b) => a.elapsedSeconds - b.elapsedSeconds);
        const first = ordered[0];
        const durationSeconds = first.phaseDurationSeconds;
        const phaseElapsed = Number.isFinite(first.phaseElapsedSeconds) ? first.phaseElapsedSeconds : 0;
        const startElapsed = first.elapsedSeconds - phaseElapsed;
        phases.push({
            phaseId,
            durationClass: workDurationClass(durationSeconds),
            durationSeconds,
            startElapsed,
            endElapsed: startElapsed + durationSeconds,
            entries: ordered,
            finalResistance: ordered[ordered.length - 1].resistance,
            targetHeartRateMin: (_b = ordered[ordered.length - 1].targetHeartRateMin) !== null && _b !== void 0 ? _b : first.targetHeartRateMin,
            targetHeartRateMax: (_c = ordered[ordered.length - 1].targetHeartRateMax) !== null && _c !== void 0 ? _c : first.targetHeartRateMax,
        });
    }
    return phases.sort((a, b) => a.startElapsed - b.startElapsed);
}
function lastHalf(items) {
    return items.slice(Math.floor(items.length / 2));
}
export function lateHrWindow(phase) {
    const tailSeconds = phase.durationClass === "short"
        ? 15
        : phase.durationClass === "medium"
            ? 30
            : phase.durationSeconds / 3;
    return {
        start: Math.max(phase.startElapsed, phase.endElapsed - tailSeconds),
        end: phase.endElapsed,
    };
}
function samplesInWindows(samples, windows) {
    return samples.filter((sample) => windows.some((window) => sample.elapsedSeconds >= window.start && sample.elapsedSeconds < window.end));
}
function resistanceAtTime(phase, elapsedSeconds) {
    var _a;
    let active;
    for (const entry of phase.entries) {
        const at = phase.startElapsed + ((_a = entry.phaseElapsedSeconds) !== null && _a !== void 0 ? _a : Math.max(0, entry.elapsedSeconds - phase.startElapsed));
        if (at <= elapsedSeconds)
            active = entry.resistance;
        else
            break;
    }
    return active;
}
function longBlockCandidate(phase) {
    var _a;
    const thirdStart = phase.startElapsed + phase.durationSeconds * (2 / 3);
    const resistances = [];
    const begin = Math.floor(thirdStart);
    const finish = Math.max(begin + 1, Math.floor(phase.endElapsed));
    for (let elapsed = begin; elapsed < finish; elapsed++) {
        const resistance = resistanceAtTime(phase, elapsed);
        if (resistance !== undefined)
            resistances.push(resistance);
    }
    if (resistances.length === 0) {
        const fallback = (_a = resistanceAtTime(phase, thirdStart)) !== null && _a !== void 0 ? _a : phase.finalResistance;
        if (fallback !== undefined)
            resistances.push(fallback);
    }
    return { resistance: integerMedian(resistances) };
}
function repeatedIntervalCandidate(phases) {
    const late = lastHalf(phases);
    return {
        resistance: integerMedian(late.map((phase) => phase.finalResistance)),
        late,
    };
}
export function hrResponseQualifies(samples, windows, targetMin, targetMax) {
    if (targetMin === undefined || targetMax === undefined)
        return false;
    const median = rollingHrMedian(samplesInWindows(samples, windows));
    if (median === undefined)
        return false;
    return median >= targetMin - 3 && median <= targetMax + 3;
}
function phaseHrQualifies(phase, samples) {
    return hrResponseQualifies(samples, [lateHrWindow(phase)], phase.targetHeartRateMin, phase.targetHeartRateMax);
}
function lateWorkHrQualifies(phases, samples) {
    return phases.length > 0 && phases.every((phase) => phaseHrQualifies(phase, samples));
}
export function deriveLearningCandidate(summary, hrSamples) {
    var _a;
    if (summary.cancelled)
        return undefined;
    if (summary.activity !== "bike")
        return undefined;
    if (summary.machine_id !== "proform-smart-power-10")
        return undefined;
    const machine = getMachineDefinition(summary.machine_id);
    if (!machine || summary.machine_profile_version !== machine.profileVersion)
        return undefined;
    if (!isLearningIntent(summary.intent))
        return undefined;
    const phases = collectWorkPhases((_a = summary.machine_guidance_trace) !== null && _a !== void 0 ? _a : []);
    if (phases.length === 0)
        return undefined;
    const classes = new Set(phases.map((phase) => phase.durationClass));
    if (classes.size !== 1)
        return undefined;
    const durationClass = phases[0].durationClass;
    const singleLong = durationClass === "long" && phases.length === 1;
    const derived = singleLong
        ? { ...longBlockCandidate(phases[0]), late: phases }
        : repeatedIntervalCandidate(phases);
    if (derived.resistance === undefined)
        return undefined;
    if (!lateWorkHrQualifies(derived.late, hrSamples))
        return undefined;
    return {
        key: {
            machineId: "proform-smart-power-10",
            machineProfileVersion: machine.profileVersion,
            activity: "bike",
            intent: summary.intent,
            durationClass,
        },
        resistance: clampAutomaticResistance(derived.resistance),
    };
}
