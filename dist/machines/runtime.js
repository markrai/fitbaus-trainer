import { createMachineGuidanceState, getMachineGuidance, isSameMachineRecommendation } from "./guidance.js";
import { lookupLearnedWorkStart } from "./learning/index.js";
import { lookupPersonalizedTiming } from "./dynamics/index.js";
import { createMachineDecisionAuditState, observeMachineDecisions } from "./audit/index.js";
import { getMachineDefinition } from "./registry.js";
import { getSelectedMachineId } from "./selection.js";
function newRuntimeState(sessionId) {
    return {
        sessionId,
        guidanceState: createMachineGuidanceState(),
        recentHeartRates: [],
        trace: [],
        decisionAudit: createMachineDecisionAuditState(),
        machineSelectionChanged: false,
    };
}
/**
 * Who chose the recommendation, from the structured guidance branch:
 * fixed protocol hold, scripted warm-up/recovery/cooldown program, work-phase
 * start (carry-over, learned, or default), or a live HR evaluation.
 */
export function classifyRecommendationOrigin(input) {
    if (input.holdResistance != null && Number.isFinite(input.holdResistance)) {
        if (input.controlMode === "prospective_fixed_load")
            return "scripted_phase_program";
        if (input.controlMode === "legacy_hr_control")
            return "scripted_phase_program";
        return "vo2_protocol_fixed_resistance";
    }
    if (input.phaseKind === "warmup" || input.phaseKind === "cooldown")
        return "scripted_phase_program";
    if (input.phaseKind === "recovery")
        return input.guidancePhaseChanged ? "scripted_phase_program" : "automatic_hr_control";
    if (!input.guidancePhaseChanged)
        return "automatic_hr_control";
    if (input.priorNextWorkResistance !== undefined)
        return "controller_carryover";
    if (input.learnedStartingResistance !== undefined && Number.isFinite(input.learnedStartingResistance)) {
        return "learned_starting_resistance";
    }
    return "default_starting_resistance";
}
let runtime = newRuntimeState(null);
export function resetMachineGuidanceRuntime(sessionId = null) {
    runtime = newRuntimeState(sessionId);
}
function ensureSession(sessionId) {
    if (runtime.sessionId !== sessionId)
        resetMachineGuidanceRuntime(sessionId);
}
export function recordMachineHeartRateSample(sessionId, elapsedSeconds, bpm) {
    if (!sessionId || !Number.isFinite(bpm) || bpm <= 0)
        return false;
    ensureSession(sessionId);
    if (runtime.recentHeartRates.some((sample) => sample.elapsedSeconds === elapsedSeconds))
        return false;
    runtime.recentHeartRates.push({ elapsedSeconds, bpm });
    const cutoff = elapsedSeconds - 15;
    runtime.recentHeartRates = runtime.recentHeartRates
        .filter((sample) => sample.elapsedSeconds >= cutoff)
        .slice(-32);
    return true;
}
export function appendMachineGuidanceTrace(trace, elapsedSeconds, guidance, previous, phase) {
    if (isSameMachineRecommendation(previous, guidance))
        return [...trace];
    if (guidance.resistance === undefined || guidance.cadenceRpm === undefined)
        return [...trace];
    const entry = {
        elapsedSeconds,
        resistance: guidance.resistance,
        cadenceRpm: guidance.cadenceRpm,
        reason: guidance.reason,
        phaseKind: phase.phaseKind,
        phaseId: phase.phaseId,
        phaseDurationSeconds: phase.phaseDurationSeconds,
        phaseElapsedSeconds: phase.phaseElapsedSeconds,
    };
    if (guidance.estimatedWatts !== undefined)
        entry.estimatedWatts = guidance.estimatedWatts;
    if (phase.intervalIndex !== undefined)
        entry.intervalIndex = phase.intervalIndex;
    if (phase.targetHeartRateMin !== undefined)
        entry.targetHeartRateMin = phase.targetHeartRateMin;
    if (phase.targetHeartRateMax !== undefined)
        entry.targetHeartRateMax = phase.targetHeartRateMax;
    return [...trace, entry];
}
function workPhaseHeartRates(samples, workoutElapsedSeconds, phaseElapsedSeconds) {
    const workStart = workoutElapsedSeconds - phaseElapsedSeconds;
    const cutoff = Math.max(workStart, workoutElapsedSeconds - 15);
    return samples
        .filter((sample) => sample.elapsedSeconds >= cutoff && sample.elapsedSeconds <= workoutElapsedSeconds)
        .slice(-32);
}
function completedShortWorkFromPending(pending, liveSamples) {
    const workStart = pending.workoutElapsedSeconds - pending.phaseElapsedSeconds;
    const workEnd = workStart + pending.phaseDurationSeconds;
    const merged = new Map();
    for (const sample of [...pending.recentHeartRates, ...liveSamples]) {
        if (sample.elapsedSeconds >= workEnd - 15 && sample.elapsedSeconds < workEnd) {
            merged.set(sample.elapsedSeconds, sample);
        }
    }
    return {
        phaseId: pending.phaseId,
        phaseDurationSeconds: pending.phaseDurationSeconds,
        resistance: pending.resistance,
        targetHeartRateMin: pending.targetHeartRateMin,
        targetHeartRateMax: pending.targetHeartRateMax,
        recentHeartRates: [...merged.values()].sort((a, b) => a.elapsedSeconds - b.elapsedSeconds).slice(-32),
    };
}
export function updateMachineGuidanceRuntime(input, storage) {
    var _a, _b, _c, _d, _e;
    ensureSession(input.sessionId);
    if (input.controlAuthority === null)
        return null;
    if (input.controlAuthority && input.controlAuthority.sessionId !== input.sessionId)
        return null;
    const controlMode = (_b = (_a = input.controlAuthority) === null || _a === void 0 ? void 0 : _a.mode) !== null && _b !== void 0 ? _b : (input.holdResistance != null && Number.isFinite(input.holdResistance)
        ? "vo2_protocol"
        : "legacy_hr_control");
    const prospectiveFixedLoad = controlMode === "prospective_fixed_load";
    if (prospectiveFixedLoad && ((_c = input.controlAuthority) === null || _c === void 0 ? void 0 : _c.source) !== "frozen")
        return null;
    if (prospectiveFixedLoad && (!Number.isInteger(input.holdResistance) ||
        input.holdResistance < 1 ||
        input.holdResistance > 15))
        return null;
    if (controlMode === "vo2_protocol" && input.controlAuthority &&
        (input.holdResistance == null || !Number.isFinite(input.holdResistance)))
        return null;
    runtime.recentHeartRates = runtime.recentHeartRates.filter((sample) => sample.elapsedSeconds >= input.workoutElapsedSeconds - 15 &&
        sample.elapsedSeconds <= input.workoutElapsedSeconds);
    const machineId = getSelectedMachineId(input.activity, storage);
    if (!machineId)
        return null;
    const machine = getMachineDefinition(machineId);
    if (!machine || machine.activity !== input.activity)
        return null;
    if (runtime.machineId !== machineId) {
        if (runtime.machineId !== undefined)
            runtime.machineSelectionChanged = true;
        runtime.machineId = machineId;
        runtime.guidanceState = createMachineGuidanceState();
        runtime.previousGuidance = undefined;
        runtime.trace = [];
        runtime.lastPhaseId = undefined;
        runtime.pendingShortWork = undefined;
        runtime.decisionAudit = createMachineDecisionAuditState();
    }
    // Prospective authority branches before all ordinary HR/learning/timing work.
    if (prospectiveFixedLoad)
        runtime.pendingShortWork = undefined;
    const leavingShortWork = !prospectiveFixedLoad && runtime.pendingShortWork !== undefined &&
        (input.phaseId !== runtime.pendingShortWork.phaseId || input.phaseKind !== "work");
    const completedShortWork = leavingShortWork && runtime.pendingShortWork && !runtime.guidanceState.shortIntervalEvaluated
        ? completedShortWorkFromPending(runtime.pendingShortWork, runtime.recentHeartRates)
        : undefined;
    if (leavingShortWork)
        runtime.pendingShortWork = undefined;
    const phaseChanged = runtime.lastPhaseId !== input.phaseId;
    const learnedStartingResistance = !prospectiveFixedLoad && input.phaseKind === "work" && input.intent
        ? lookupLearnedWorkStart({
            machineId,
            machineProfileVersion: machine.profileVersion,
            activity: input.activity,
            intent: input.intent,
            durationSeconds: input.phaseDurationSeconds,
        }, storage)
        : undefined;
    const personalizedTiming = !prospectiveFixedLoad && input.phaseKind === "work" && input.intent && input.phaseDurationSeconds > 75
        ? lookupPersonalizedTiming({
            machineId,
            machineProfileVersion: machine.profileVersion,
            activity: input.activity,
            intent: input.intent,
            durationSeconds: input.phaseDurationSeconds,
        }, storage)
        : undefined;
    const priorGuidanceState = runtime.guidanceState;
    const result = getMachineGuidance({
        machineId,
        activity: input.activity,
        phaseKind: input.phaseKind,
        phaseId: input.phaseId,
        phaseElapsedSeconds: input.phaseElapsedSeconds,
        phaseDurationSeconds: input.phaseDurationSeconds,
        workoutElapsedSeconds: input.workoutElapsedSeconds,
        intervalIndex: input.intervalIndex,
        heartRateBpm: prospectiveFixedLoad ? undefined : input.heartRateBpm,
        targetHeartRateMin: prospectiveFixedLoad ? undefined : input.targetHeartRateMin,
        targetHeartRateMax: prospectiveFixedLoad ? undefined : input.targetHeartRateMax,
        intent: prospectiveFixedLoad ? undefined : input.intent,
        recentHeartRates: prospectiveFixedLoad ? [] : runtime.recentHeartRates,
        previousGuidance: runtime.previousGuidance,
        completedShortWork,
        learnedStartingResistance,
        personalizedTiming,
        holdResistance: input.holdResistance,
        holdCadenceRpm: input.holdCadenceRpm,
    }, runtime.guidanceState);
    if (!result)
        return null;
    const previous = runtime.previousGuidance;
    const recommendationChanged = !isSameMachineRecommendation(previous, result.guidance);
    runtime.trace = appendMachineGuidanceTrace(runtime.trace, input.workoutElapsedSeconds, result.guidance, previous, {
        phaseKind: input.phaseKind,
        phaseId: input.phaseId,
        intervalIndex: input.intervalIndex,
        phaseDurationSeconds: input.phaseDurationSeconds,
        phaseElapsedSeconds: input.phaseElapsedSeconds,
        targetHeartRateMin: input.targetHeartRateMin,
        targetHeartRateMax: input.targetHeartRateMax,
    });
    runtime.guidanceState = result.state;
    runtime.previousGuidance = result.guidance;
    runtime.lastPhaseId = input.phaseId;
    runtime.decisionAudit = observeMachineDecisions(runtime.decisionAudit, input.workoutElapsedSeconds, {
        priorWorkEvaluation: result.priorWorkEvaluation,
        workPhaseStarted: result.workPhaseStarted,
        workEvaluation: result.workEvaluation,
    });
    if (!prospectiveFixedLoad && input.phaseKind === "work" && input.phaseDurationSeconds <= 75) {
        runtime.pendingShortWork = {
            phaseId: input.phaseId,
            phaseDurationSeconds: input.phaseDurationSeconds,
            phaseElapsedSeconds: input.phaseElapsedSeconds,
            workoutElapsedSeconds: input.workoutElapsedSeconds,
            resistance: (_e = (_d = result.state.currentResistance) !== null && _d !== void 0 ? _d : result.guidance.resistance) !== null && _e !== void 0 ? _e : 11,
            targetHeartRateMin: input.targetHeartRateMin,
            targetHeartRateMax: input.targetHeartRateMax,
            recentHeartRates: workPhaseHeartRates(runtime.recentHeartRates, input.workoutElapsedSeconds, input.phaseElapsedSeconds),
        };
    }
    const voiceEvent = phaseChanged || recommendationChanged
        ? {
            machineId,
            phaseId: input.phaseId,
            phaseKind: input.phaseKind,
            phaseDisplayName: input.phaseDisplayName,
            intervalIndex: input.intervalIndex,
            phaseChanged,
            recommendationChanged,
            guidance: result.guidance,
        }
        : null;
    return {
        machine,
        guidance: result.guidance,
        recommendationChanged,
        phaseChanged,
        voiceEvent,
        actuationOrigin: classifyRecommendationOrigin({
            controlMode,
            phaseKind: input.phaseKind,
            holdResistance: input.holdResistance,
            guidancePhaseChanged: priorGuidanceState.currentPhaseId !== input.phaseId,
            priorNextWorkResistance: priorGuidanceState.nextWorkResistance,
            learnedStartingResistance,
        }),
    };
}
export function getMachineUsageSnapshot(sessionId) {
    if (runtime.sessionId !== sessionId || !runtime.machineId)
        return null;
    const machine = getMachineDefinition(runtime.machineId);
    if (!machine)
        return null;
    return {
        machineId: machine.id,
        profileVersion: machine.profileVersion,
        guidanceTrace: runtime.trace.map((entry) => ({ ...entry })),
        decisionAudit: runtime.decisionAudit.entries.length > 0
            ? runtime.decisionAudit.entries.map((entry) => ({ ...entry }))
            : undefined,
        machineSelectionChanged: runtime.machineSelectionChanged,
    };
}
