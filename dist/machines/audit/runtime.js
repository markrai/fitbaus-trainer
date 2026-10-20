import { workDurationClass } from "../learning/types.js";
import { timingModeForPersonalizedTiming } from "../dynamics/timing.js";
import { MACHINE_DECISION_AUDIT_VERSION, MAX_MACHINE_DECISION_AUDIT_ENTRIES, } from "./types.js";
export function createMachineDecisionAuditState() {
    return { entries: [] };
}
export function appendMachineDecisionAuditEntries(entries, extra) {
    if (extra.length === 0)
        return [...entries];
    const next = [...entries, ...extra];
    if (next.length <= MAX_MACHINE_DECISION_AUDIT_ENTRIES)
        return next;
    return next.slice(next.length - MAX_MACHINE_DECISION_AUDIT_ENTRIES);
}
function workoutClock(workoutElapsedSeconds, phaseElapsedSeconds, phaseValue) {
    return workoutElapsedSeconds - phaseElapsedSeconds + phaseValue;
}
function timingModeFromFrozen(timing, phaseDurationSeconds) {
    return timingModeForPersonalizedTiming(timing, workDurationClass(phaseDurationSeconds));
}
function evaluationKindFor(observation, previousDecision) {
    if (observation.durationBand === "short")
        return "short_interval_final";
    if (!previousDecision)
        return "initial";
    if (previousDecision === "increase")
        return "after_increase";
    if (previousDecision === "decrease")
        return "after_decrease";
    return "after_hold";
}
function copyOptionalTargets(entry, min, max) {
    if (min !== undefined)
        entry.targetHeartRateMin = min;
    if (max !== undefined)
        entry.targetHeartRateMax = max;
    return entry;
}
function workPhaseStartedEntry(observation, workoutElapsedSeconds) {
    const entry = {
        version: MACHINE_DECISION_AUDIT_VERSION,
        kind: "work_phase_started",
        elapsedSeconds: workoutElapsedSeconds,
        phaseKind: observation.phaseKind,
        phaseId: observation.phaseId,
        phaseElapsedSeconds: observation.phaseElapsedSeconds,
        phaseDurationSeconds: observation.phaseDurationSeconds,
        resistance: observation.resistance,
        initialEvaluationWaitSeconds: observation.initialEvaluationWaitSeconds,
        nextEligibleElapsedSeconds: workoutClock(workoutElapsedSeconds, observation.phaseElapsedSeconds, observation.nextEligiblePhaseElapsedSeconds),
    };
    if (observation.intervalIndex !== undefined)
        entry.intervalIndex = observation.intervalIndex;
    const timingMode = timingModeFromFrozen(observation.personalizedTiming, observation.phaseDurationSeconds);
    if (timingMode)
        entry.timingMode = timingMode;
    return copyOptionalTargets(entry, observation.targetHeartRateMin, observation.targetHeartRateMax);
}
function evaluationEntry(observation, workoutElapsedSeconds, previousDecision) {
    if (observation.deferred ||
        observation.representativeHeartRate === undefined ||
        observation.heartRateAssessment === undefined ||
        observation.decision === undefined ||
        observation.decisionReason === undefined) {
        return undefined;
    }
    const entry = {
        version: MACHINE_DECISION_AUDIT_VERSION,
        kind: "evaluation",
        elapsedSeconds: workoutElapsedSeconds,
        phaseKind: observation.phaseKind,
        phaseId: observation.phaseId,
        phaseElapsedSeconds: observation.phaseElapsedSeconds,
        phaseDurationSeconds: observation.phaseDurationSeconds,
        representativeHeartRate: observation.representativeHeartRate,
        resistanceBefore: observation.resistanceBefore,
        resistanceAfter: observation.resistanceAfter,
        heartRateAssessment: observation.heartRateAssessment,
        decision: observation.decision,
        decisionReason: observation.decisionReason,
        evaluationKind: evaluationKindFor(observation, previousDecision),
    };
    if (observation.intervalIndex !== undefined)
        entry.intervalIndex = observation.intervalIndex;
    if (observation.representativeSampleCount !== undefined) {
        entry.representativeSampleCount = observation.representativeSampleCount;
    }
    if (observation.representativeWindowSpanSeconds !== undefined) {
        entry.representativeWindowSpanSeconds = observation.representativeWindowSpanSeconds;
    }
    if (observation.constraint !== undefined)
        entry.constraint = observation.constraint;
    if (observation.waitBeforeEvaluationSeconds !== undefined) {
        entry.waitBeforeEvaluationSeconds = observation.waitBeforeEvaluationSeconds;
    }
    if (observation.nextEvaluationWaitSeconds !== undefined) {
        entry.nextEvaluationWaitSeconds = observation.nextEvaluationWaitSeconds;
    }
    if (observation.nextEligiblePhaseElapsedSeconds !== undefined) {
        entry.nextEligibleElapsedSeconds = workoutClock(workoutElapsedSeconds, observation.phaseElapsedSeconds, observation.nextEligiblePhaseElapsedSeconds);
    }
    const timingMode = timingModeFromFrozen(observation.personalizedTiming, observation.phaseDurationSeconds);
    if (timingMode)
        entry.timingMode = timingMode;
    return copyOptionalTargets(entry, observation.targetHeartRateMin, observation.targetHeartRateMax);
}
function deferredEntry(observation, workoutElapsedSeconds) {
    if (!observation.deferred || observation.eligibleSincePhaseElapsedSeconds === undefined)
        return undefined;
    const entry = {
        version: MACHINE_DECISION_AUDIT_VERSION,
        kind: "evaluation_deferred",
        elapsedSeconds: workoutElapsedSeconds,
        phaseKind: observation.phaseKind,
        phaseId: observation.phaseId,
        phaseElapsedSeconds: observation.phaseElapsedSeconds,
        phaseDurationSeconds: observation.phaseDurationSeconds,
        resistance: observation.resistanceBefore,
        reason: "insufficient_hr",
        eligibleSinceElapsedSeconds: workoutClock(workoutElapsedSeconds, observation.phaseElapsedSeconds, observation.eligibleSincePhaseElapsedSeconds),
    };
    if (observation.intervalIndex !== undefined)
        entry.intervalIndex = observation.intervalIndex;
    return copyOptionalTargets(entry, observation.targetHeartRateMin, observation.targetHeartRateMax);
}
export function observeMachineDecisions(state, workoutElapsedSeconds, observations) {
    let next = {
        entries: state.entries,
        lastPhaseId: state.lastPhaseId,
        lastWorkPhaseStartId: state.lastWorkPhaseStartId,
        lastEvaluationId: state.lastEvaluationId,
        deferredDeadlineId: state.deferredDeadlineId,
        lastPhaseDecision: state.lastPhaseDecision,
    };
    if (observations.priorWorkEvaluation) {
        next = observeEvaluation(next, workoutElapsedSeconds, observations.priorWorkEvaluation);
    }
    if (observations.workPhaseStarted) {
        next = observeWorkPhaseStarted(next, workoutElapsedSeconds, observations.workPhaseStarted);
    }
    if (observations.workEvaluation) {
        next = observeEvaluation(next, workoutElapsedSeconds, observations.workEvaluation);
    }
    return next;
}
function appendIncoming(state, incoming) {
    if (incoming.length === 0)
        return state;
    return {
        ...state,
        entries: appendMachineDecisionAuditEntries(state.entries, incoming),
    };
}
function observeWorkPhaseStarted(state, workoutElapsedSeconds, observation) {
    const phaseId = observation.phaseId;
    let next = state;
    if (next.lastPhaseId !== phaseId) {
        next = {
            ...next,
            lastPhaseId: phaseId,
            lastPhaseDecision: undefined,
            deferredDeadlineId: undefined,
            lastEvaluationId: undefined,
        };
    }
    const startId = `${phaseId}:start`;
    if (next.lastWorkPhaseStartId === startId)
        return next;
    return appendIncoming({ ...next, lastWorkPhaseStartId: startId }, [workPhaseStartedEntry(observation, workoutElapsedSeconds)]);
}
function observeEvaluation(state, workoutElapsedSeconds, evaluation) {
    let next = state;
    if (next.lastPhaseId !== evaluation.phaseId) {
        next = {
            ...next,
            lastPhaseId: evaluation.phaseId,
            lastPhaseDecision: undefined,
            deferredDeadlineId: undefined,
            lastEvaluationId: undefined,
        };
    }
    if (evaluation.deferred) {
        const deadlineId = `${evaluation.phaseId}:deferred:${evaluation.eligibleSincePhaseElapsedSeconds}`;
        if (next.deferredDeadlineId === deadlineId)
            return next;
        const entry = deferredEntry(evaluation, workoutElapsedSeconds);
        if (!entry)
            return next;
        return appendIncoming({ ...next, deferredDeadlineId: deadlineId }, [entry]);
    }
    const evaluationId = `${evaluation.phaseId}:eval:${workoutElapsedSeconds}`;
    if (next.lastEvaluationId === evaluationId)
        return next;
    const entry = evaluationEntry(evaluation, workoutElapsedSeconds, next.lastPhaseDecision);
    if (!entry)
        return next;
    return appendIncoming({
        ...next,
        lastEvaluationId: evaluationId,
        lastPhaseDecision: entry.decision,
        deferredDeadlineId: undefined,
    }, [entry]);
}
