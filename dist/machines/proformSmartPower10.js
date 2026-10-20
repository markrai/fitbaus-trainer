import { qualifiedHrMedianDetails } from "./hrQuality.js";
export const AUTOMATIC_RESISTANCE_MIN = 1;
export const AUTOMATIC_RESISTANCE_MAX = 15;
export const TARGET_HR_ADJUST_MARGIN_BPM = 3;
export const HIGH_RESISTANCE_INCREASE_DEFICIT_BPM = 5;
export const HIGH_RESISTANCE_INCREASE_FROM = 13;
export const HOLD_EVALUATION_COOLDOWN_SECONDS = 60;
/** Four-minute VO2 work must leave enough time for bounded one-level feedback. */
export const VO2_PRIORITY_INITIAL_EVALUATION_SECONDS = 60;
export const VO2_PRIORITY_FAST_RESPONSE_MAX_PHASE_SECONDS = 240;
export const estimatedWattsAt70Rpm = Object.freeze({
    1: 66,
    2: 69,
    3: 70,
    4: 78,
    5: 82,
    6: 86,
    7: 97,
    8: 108,
    9: 114,
    10: 123,
    11: 134,
    12: 147,
    13: 156,
    14: 180,
    15: 201,
});
export function getEstimatedWattsAt70Rpm(resistance) {
    return estimatedWattsAt70Rpm[resistance];
}
export function clampAutomaticResistance(resistance) {
    return Math.max(AUTOMATIC_RESISTANCE_MIN, Math.min(AUTOMATIC_RESISTANCE_MAX, Math.round(resistance)));
}
function rollingMedianDetails(context) {
    return qualifiedHrMedianDetails(context.recentHeartRates);
}
function rollingMedian(context) {
    var _a;
    return (_a = rollingMedianDetails(context)) === null || _a === void 0 ? void 0 : _a.median;
}
export function classifyWorkResistanceAdjustment(median, min, max, currentResistance) {
    if (median >= max + TARGET_HR_ADJUST_MARGIN_BPM) {
        const resistanceAfter = clampAutomaticResistance(currentResistance - 1);
        const blocked = resistanceAfter === currentResistance;
        return {
            assessment: "high",
            decision: blocked ? "hold" : "decrease",
            constraint: blocked ? "r1_floor" : "none",
            decisionReason: blocked ? "lower_resistance_bound" : "above_target",
            resistanceBefore: currentResistance,
            resistanceAfter,
        };
    }
    const requiredDeficit = currentResistance >= HIGH_RESISTANCE_INCREASE_FROM
        ? HIGH_RESISTANCE_INCREASE_DEFICIT_BPM
        : TARGET_HR_ADJUST_MARGIN_BPM;
    if (median <= min - requiredDeficit && currentResistance < 15) {
        return {
            assessment: "low",
            decision: "increase",
            constraint: "none",
            decisionReason: "below_target",
            resistanceBefore: currentResistance,
            resistanceAfter: clampAutomaticResistance(currentResistance + 1),
        };
    }
    const genericLow = median <= min - TARGET_HR_ADJUST_MARGIN_BPM;
    if (genericLow && currentResistance >= 15) {
        return {
            assessment: "low",
            decision: "hold",
            constraint: "r15_cap",
            decisionReason: "upper_resistance_bound",
            resistanceBefore: currentResistance,
            resistanceAfter: currentResistance,
        };
    }
    if (genericLow && currentResistance >= HIGH_RESISTANCE_INCREASE_FROM) {
        return {
            assessment: "low",
            decision: "hold",
            constraint: "r13_plus_deficit_guard",
            decisionReason: "increase_guarded",
            resistanceBefore: currentResistance,
            resistanceAfter: currentResistance,
        };
    }
    return {
        assessment: "target",
        decision: "hold",
        constraint: "target_hold",
        decisionReason: "within_target_policy",
        resistanceBefore: currentResistance,
        resistanceAfter: currentResistance,
    };
}
function startingWorkResistance(durationSeconds) {
    if (durationSeconds <= 75)
        return 11;
    if (durationSeconds <= 150)
        return 10;
    return 8;
}
function workStartResistance(context) {
    const fallback = startingWorkResistance(context.phaseDurationSeconds);
    const learned = context.learnedStartingResistance;
    if (learned === undefined || !Number.isFinite(learned))
        return { resistance: fallback, learned: false };
    return { resistance: clampAutomaticResistance(learned), learned: true };
}
function actionForResistance(previous, next, phaseChanged) {
    if (phaseChanged || previous === undefined)
        return "set";
    if (next > previous)
        return "increase";
    if (next < previous)
        return "decrease";
    return "hold";
}
function recommendation(resistance, cadenceRpm, action, reason, includeEstimatedWatts) {
    const guidance = {
        machineId: "proform-smart-power-10",
        resistance: clampAutomaticResistance(resistance),
        cadenceRpm,
        action,
        reason,
    };
    if (includeEstimatedWatts && cadenceRpm === 70) {
        guidance.estimatedWatts = getEstimatedWattsAt70Rpm(guidance.resistance);
    }
    return guidance;
}
export function finalizeProFormShortWork(completed, state) {
    if (completed.phaseDurationSeconds > 75 || state.shortIntervalEvaluated)
        return state;
    const adapted = adaptWorkResistance({
        recentHeartRates: completed.recentHeartRates,
        targetHeartRateMin: completed.targetHeartRateMin,
        targetHeartRateMax: completed.targetHeartRateMax,
    }, completed.resistance);
    return {
        ...state,
        shortIntervalEvaluated: true,
        nextWorkResistance: adapted.evaluated ? adapted.resistance : completed.resistance,
    };
}
function adaptWorkResistance(context, currentResistance) {
    const details = rollingMedianDetails(context);
    const min = context.targetHeartRateMin;
    const max = context.targetHeartRateMax;
    if (details === undefined || min === undefined || max === undefined) {
        return { resistance: currentResistance, median: details === null || details === void 0 ? void 0 : details.median, evaluated: false, details };
    }
    const classified = classifyWorkResistanceAdjustment(details.median, min, max, currentResistance);
    return {
        resistance: classified.resistanceAfter,
        median: details.median,
        evaluated: true,
        details,
        classified,
    };
}
function holdGuidance(context, state, phaseChanged) {
    var _a;
    const resistance = clampAutomaticResistance(context.holdResistance);
    const cadence = (_a = context.holdCadenceRpm) !== null && _a !== void 0 ? _a : 70;
    const action = actionForResistance(state.currentResistance, resistance, phaseChanged);
    return {
        guidance: recommendation(resistance, cadence, action, "Fixed protocol resistance", cadence === 70),
        state: {
            ...state,
            currentResistance: resistance,
            currentCadenceRpm: cadence,
        },
    };
}
function warmupGuidance(context, state, phaseChanged) {
    const fraction = context.phaseDurationSeconds > 0
        ? Math.max(0, Math.min(1, context.phaseElapsedSeconds / context.phaseDurationSeconds))
        : 0;
    const target = fraction < 1 / 3
        ? { resistance: 3, cadence: 60, reason: "Progressive warm-up, first third" }
        : fraction < 2 / 3
            ? { resistance: 5, cadence: 65, reason: "Progressive warm-up, middle third" }
            : { resistance: 6, cadence: 70, reason: "Progressive warm-up, final third" };
    const action = actionForResistance(state.currentResistance, target.resistance, phaseChanged);
    const nextState = {
        ...state,
        currentResistance: target.resistance,
        currentCadenceRpm: target.cadence,
    };
    return {
        guidance: recommendation(target.resistance, target.cadence, action, target.reason, target.cadence === 70),
        state: nextState,
    };
}
function recoveryGuidance(context, state, phaseChanged, cooldown) {
    var _a;
    let resistance = phaseChanged ? 2 : (_a = state.currentResistance) !== null && _a !== void 0 ? _a : 2;
    let reason = cooldown ? "Conservative cooldown" : "Easy recovery";
    if (!cooldown && context.phaseElapsedSeconds >= 30) {
        const median = rollingMedian(context);
        if (median !== undefined && context.targetHeartRateMax !== undefined && median >= context.targetHeartRateMax + 3) {
            const reduced = clampAutomaticResistance(resistance - 1);
            if (reduced < resistance) {
                resistance = reduced;
                reason = `Recovery heart rate remains high at ${Math.round(median)} bpm`;
            }
        }
    }
    const action = actionForResistance(state.currentResistance, resistance, phaseChanged);
    const nextState = {
        ...state,
        currentResistance: resistance,
        currentCadenceRpm: 63,
        nextWorkResistance: state.nextWorkResistance,
    };
    return {
        guidance: recommendation(resistance, 63, action, reason, false),
        state: nextState,
    };
}
function waitingForObservedResponse() {
    return "Waiting for your observed heart-rate response";
}
function freezeWorkTiming(context, state, phaseChanged) {
    var _a, _b, _c;
    if (!phaseChanged)
        return state;
    return {
        ...state,
        initialEvaluationSeconds: (_a = context.personalizedTiming) === null || _a === void 0 ? void 0 : _a.initialEvaluationSeconds,
        increaseCooldownSeconds: (_b = context.personalizedTiming) === null || _b === void 0 ? void 0 : _b.increaseCooldownSeconds,
        decreaseCooldownSeconds: (_c = context.personalizedTiming) === null || _c === void 0 ? void 0 : _c.decreaseCooldownSeconds,
        currentEvaluationCooldownSeconds: undefined,
        lastWorkAdjustmentDirection: undefined,
    };
}
function recordWorkEvaluation(state, elapsedSeconds, action) {
    var _a, _b;
    state.lastEvaluationPhaseElapsedSeconds = elapsedSeconds;
    if (action === "increase") {
        state.lastWorkAdjustmentDirection = "increase";
        state.currentEvaluationCooldownSeconds = (_a = state.increaseCooldownSeconds) !== null && _a !== void 0 ? _a : 60;
        return;
    }
    if (action === "decrease") {
        state.lastWorkAdjustmentDirection = "decrease";
        state.currentEvaluationCooldownSeconds = (_b = state.decreaseCooldownSeconds) !== null && _b !== void 0 ? _b : 60;
        return;
    }
    state.currentEvaluationCooldownSeconds = 60;
}
function mediumWaitReason(elapsedSeconds, initialWait, usingLearnedStart) {
    if (usingLearnedStart)
        return "Learned starting resistance from prior workouts";
    if (initialWait < 60)
        return waitingForObservedResponse();
    if (initialWait > 60 && elapsedSeconds >= 60)
        return waitingForObservedResponse();
    return "Waiting 60 seconds for heart-rate response";
}
function longInitialWaitReason(elapsedSeconds, initialWait, usingLearnedStart) {
    if (usingLearnedStart)
        return "Learned starting resistance from prior workouts";
    if (initialWait < 90)
        return waitingForObservedResponse();
    if (initialWait > 90 && elapsedSeconds >= 90)
        return waitingForObservedResponse();
    return "Waiting 90 seconds for heart-rate stabilization";
}
function longCooldownWaitReason(elapsedSeconds, lastEvaluation, cooldown) {
    const since = lastEvaluation === undefined ? elapsedSeconds : elapsedSeconds - lastEvaluation;
    if (cooldown < 60)
        return waitingForObservedResponse();
    if (cooldown > 60 && since >= 60)
        return waitingForObservedResponse();
    return "Holding during the 60-second adjustment cooldown";
}
function durationBandFor(phaseDurationSeconds) {
    if (phaseDurationSeconds <= 75)
        return "short";
    if (phaseDurationSeconds <= 150)
        return "medium";
    return "long";
}
function frozenTimingFromState(state) {
    const timing = {};
    if (state.initialEvaluationSeconds !== undefined)
        timing.initialEvaluationSeconds = state.initialEvaluationSeconds;
    if (state.increaseCooldownSeconds !== undefined)
        timing.increaseCooldownSeconds = state.increaseCooldownSeconds;
    if (state.decreaseCooldownSeconds !== undefined)
        timing.decreaseCooldownSeconds = state.decreaseCooldownSeconds;
    return Object.keys(timing).length > 0 ? timing : undefined;
}
function phaseObservationFields(context) {
    const fields = {
        phaseKind: context.phaseKind,
        phaseId: context.phaseId,
        phaseElapsedSeconds: context.phaseElapsedSeconds,
        phaseDurationSeconds: context.phaseDurationSeconds,
    };
    if (context.intervalIndex !== undefined)
        fields.intervalIndex = context.intervalIndex;
    if (context.targetHeartRateMin !== undefined)
        fields.targetHeartRateMin = context.targetHeartRateMin;
    if (context.targetHeartRateMax !== undefined)
        fields.targetHeartRateMax = context.targetHeartRateMax;
    return fields;
}
function nextWaitAfterDecision(state, durationBand) {
    var _a;
    if (durationBand !== "long")
        return undefined;
    return (_a = state.currentEvaluationCooldownSeconds) !== null && _a !== void 0 ? _a : HOLD_EVALUATION_COOLDOWN_SECONDS;
}
function successfulEvaluationObservation(context, state, adapted, resistanceBefore, waitBeforeEvaluationSeconds) {
    if (!adapted.evaluated || !adapted.classified || !adapted.details)
        return undefined;
    const durationBand = durationBandFor(context.phaseDurationSeconds);
    const nextWait = nextWaitAfterDecision(state, durationBand);
    const observation = {
        deferred: false,
        durationBand,
        ...phaseObservationFields(context),
        representativeHeartRate: adapted.details.median,
        representativeSampleCount: adapted.details.sampleCount,
        representativeWindowSpanSeconds: adapted.details.windowSpanSeconds,
        resistanceBefore,
        resistanceAfter: adapted.classified.resistanceAfter,
        heartRateAssessment: adapted.classified.assessment,
        decision: adapted.classified.decision,
        constraint: adapted.classified.constraint,
        decisionReason: adapted.classified.decisionReason,
        waitBeforeEvaluationSeconds,
    };
    const timing = frozenTimingFromState(state);
    if (timing)
        observation.personalizedTiming = timing;
    if (nextWait !== undefined) {
        observation.nextEvaluationWaitSeconds = nextWait;
        observation.nextEligiblePhaseElapsedSeconds = context.phaseElapsedSeconds + nextWait;
    }
    return observation;
}
function deferredEvaluationObservation(context, resistance, eligibleSincePhaseElapsedSeconds) {
    return {
        deferred: true,
        durationBand: durationBandFor(context.phaseDurationSeconds),
        ...phaseObservationFields(context),
        resistanceBefore: resistance,
        resistanceAfter: resistance,
        eligibleSincePhaseElapsedSeconds,
    };
}
function initialWaitSeconds(state, context) {
    var _a, _b, _c;
    if (context.phaseDurationSeconds <= 75)
        return Math.max(0, context.phaseDurationSeconds - 1);
    if (context.phaseDurationSeconds <= 150)
        return (_a = state.initialEvaluationSeconds) !== null && _a !== void 0 ? _a : 60;
    if (context.intent === "vo2_priority" &&
        context.phaseDurationSeconds <= VO2_PRIORITY_FAST_RESPONSE_MAX_PHASE_SECONDS) {
        return Math.min((_b = state.initialEvaluationSeconds) !== null && _b !== void 0 ? _b : VO2_PRIORITY_INITIAL_EVALUATION_SECONDS, VO2_PRIORITY_INITIAL_EVALUATION_SECONDS);
    }
    return (_c = state.initialEvaluationSeconds) !== null && _c !== void 0 ? _c : 90;
}
function workPhaseStartedObservation(context, state, resistance) {
    const initialWait = initialWaitSeconds(state, context);
    const observation = {
        phaseKind: context.phaseKind,
        phaseId: context.phaseId,
        phaseElapsedSeconds: context.phaseElapsedSeconds,
        phaseDurationSeconds: context.phaseDurationSeconds,
        resistance,
        initialEvaluationWaitSeconds: initialWait,
        nextEligiblePhaseElapsedSeconds: initialWait,
    };
    if (context.intervalIndex !== undefined)
        observation.intervalIndex = context.intervalIndex;
    if (context.targetHeartRateMin !== undefined)
        observation.targetHeartRateMin = context.targetHeartRateMin;
    if (context.targetHeartRateMax !== undefined)
        observation.targetHeartRateMax = context.targetHeartRateMax;
    const timing = frozenTimingFromState(state);
    if (timing)
        observation.personalizedTiming = timing;
    return observation;
}
function workGuidance(context, state, phaseChanged) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const start = workStartResistance(context);
    const usingLearnedStart = phaseChanged && state.nextWorkResistance === undefined && start.learned;
    let resistance = phaseChanged
        ? (_a = state.nextWorkResistance) !== null && _a !== void 0 ? _a : start.resistance
        : (_c = (_b = state.currentResistance) !== null && _b !== void 0 ? _b : state.nextWorkResistance) !== null && _c !== void 0 ? _c : start.resistance;
    let action = actionForResistance(state.currentResistance, resistance, phaseChanged);
    let reason = usingLearnedStart
        ? "Learned starting resistance from prior workouts"
        : "Conservative work-phase starting recommendation";
    const nextState = freezeWorkTiming(context, {
        ...state,
        currentResistance: resistance,
        currentCadenceRpm: 70,
        nextWorkResistance: context.phaseDurationSeconds <= 75 && state.shortIntervalEvaluated
            ? (_d = state.nextWorkResistance) !== null && _d !== void 0 ? _d : resistance
            : resistance,
    }, phaseChanged);
    let workPhaseStarted;
    let workEvaluation;
    if (phaseChanged) {
        workPhaseStarted = workPhaseStartedObservation(context, nextState, resistance);
    }
    if (context.phaseDurationSeconds <= 75) {
        const shortWait = Math.max(0, context.phaseDurationSeconds - 1);
        if (!nextState.shortIntervalEvaluated && context.phaseElapsedSeconds >= shortWait) {
            const adapted = adaptWorkResistance(context, resistance);
            if (adapted.evaluated) {
                nextState.shortIntervalEvaluated = true;
                nextState.nextWorkResistance = adapted.resistance;
                if (adapted.resistance > resistance)
                    reason = "Hold this repetition; increase the next repetition after the final heart-rate response";
                else if (adapted.resistance < resistance)
                    reason = "Hold this repetition; reduce the next repetition after the final heart-rate response";
                else
                    reason = "Hold this repetition; final heart-rate response supports the current resistance";
                workEvaluation = successfulEvaluationObservation(context, nextState, adapted, resistance, shortWait);
            }
            else {
                reason = usingLearnedStart
                    ? "Learned starting resistance from prior workouts"
                    : "Short interval resistance is held for the full repetition";
                workEvaluation = deferredEvaluationObservation(context, resistance, shortWait);
            }
        }
        else {
            reason = usingLearnedStart
                ? "Learned starting resistance from prior workouts"
                : "Short interval resistance is held for the full repetition";
        }
    }
    else if (context.phaseDurationSeconds <= 150) {
        const initialWait = (_e = nextState.initialEvaluationSeconds) !== null && _e !== void 0 ? _e : 60;
        if (!nextState.mediumIntervalEvaluated && context.phaseElapsedSeconds >= initialWait) {
            const adapted = adaptWorkResistance(context, resistance);
            if (adapted.evaluated) {
                const resistanceBefore = (_f = nextState.currentResistance) !== null && _f !== void 0 ? _f : resistance;
                nextState.mediumIntervalEvaluated = true;
                resistance = adapted.resistance;
                action = actionForResistance(nextState.currentResistance, resistance, false);
                nextState.currentResistance = resistance;
                nextState.nextWorkResistance = resistance;
                reason = action === "hold"
                    ? "Heart-rate response supports the current resistance"
                    : `Adjusted after ${Math.round(adapted.median)} bpm rolling heart rate`;
                workEvaluation = successfulEvaluationObservation(context, nextState, adapted, resistanceBefore, initialWait);
            }
            else {
                reason = mediumWaitReason(context.phaseElapsedSeconds, initialWait, usingLearnedStart);
                workEvaluation = deferredEvaluationObservation(context, resistance, initialWait);
            }
        }
        else if (!nextState.mediumIntervalEvaluated) {
            reason = mediumWaitReason(context.phaseElapsedSeconds, initialWait, usingLearnedStart);
        }
        else {
            reason = "Medium interval adjustment limit reached";
        }
    }
    else {
        const initialWait = initialWaitSeconds(nextState, context);
        const cooldown = (_g = nextState.currentEvaluationCooldownSeconds) !== null && _g !== void 0 ? _g : 60;
        const lastEvaluation = nextState.lastEvaluationPhaseElapsedSeconds;
        const canEvaluate = context.phaseElapsedSeconds >= initialWait &&
            (lastEvaluation === undefined || context.phaseElapsedSeconds - lastEvaluation >= cooldown);
        if (canEvaluate) {
            const adapted = adaptWorkResistance(context, resistance);
            if (adapted.evaluated) {
                const resistanceBefore = (_h = nextState.currentResistance) !== null && _h !== void 0 ? _h : resistance;
                resistance = adapted.resistance;
                action = actionForResistance(nextState.currentResistance, resistance, false);
                nextState.currentResistance = resistance;
                nextState.nextWorkResistance = resistance;
                recordWorkEvaluation(nextState, context.phaseElapsedSeconds, action);
                reason = action === "hold"
                    ? "Rolling heart rate is within the target range"
                    : `Adjusted after ${Math.round(adapted.median)} bpm rolling heart rate`;
                const waitBefore = lastEvaluation === undefined ? initialWait : cooldown;
                workEvaluation = successfulEvaluationObservation(context, nextState, adapted, resistanceBefore, waitBefore);
            }
            else {
                reason = lastEvaluation === undefined
                    ? longInitialWaitReason(context.phaseElapsedSeconds, initialWait, usingLearnedStart)
                    : longCooldownWaitReason(context.phaseElapsedSeconds, lastEvaluation, cooldown);
                const eligibleSince = lastEvaluation === undefined ? initialWait : lastEvaluation + cooldown;
                workEvaluation = deferredEvaluationObservation(context, resistance, eligibleSince);
            }
        }
        else if (context.phaseElapsedSeconds < initialWait) {
            reason = longInitialWaitReason(context.phaseElapsedSeconds, initialWait, usingLearnedStart);
        }
        else {
            reason = longCooldownWaitReason(context.phaseElapsedSeconds, lastEvaluation, cooldown);
        }
    }
    const result = {
        guidance: recommendation(resistance, 70, action, reason, true),
        state: nextState,
    };
    if (workPhaseStarted)
        result.workPhaseStarted = workPhaseStarted;
    if (workEvaluation)
        result.workEvaluation = workEvaluation;
    return result;
}
export function getProFormSmartPower10Guidance(context, state) {
    let priorWorkEvaluation;
    const finalizedState = context.completedShortWork
        ? finalizeProFormShortWork(context.completedShortWork, state)
        : state;
    if (context.completedShortWork &&
        !state.shortIntervalEvaluated &&
        finalizedState.shortIntervalEvaluated) {
        const completed = context.completedShortWork;
        const adapted = adaptWorkResistance({
            recentHeartRates: completed.recentHeartRates,
            targetHeartRateMin: completed.targetHeartRateMin,
            targetHeartRateMax: completed.targetHeartRateMax,
        }, completed.resistance);
        if (adapted.evaluated && adapted.classified && adapted.details) {
            priorWorkEvaluation = {
                deferred: false,
                durationBand: "short",
                phaseKind: "work",
                phaseId: completed.phaseId,
                phaseElapsedSeconds: completed.phaseDurationSeconds,
                phaseDurationSeconds: completed.phaseDurationSeconds,
                representativeHeartRate: adapted.details.median,
                representativeSampleCount: adapted.details.sampleCount,
                representativeWindowSpanSeconds: adapted.details.windowSpanSeconds,
                resistanceBefore: completed.resistance,
                resistanceAfter: adapted.classified.resistanceAfter,
                heartRateAssessment: adapted.classified.assessment,
                decision: adapted.classified.decision,
                constraint: adapted.classified.constraint,
                decisionReason: adapted.classified.decisionReason,
                waitBeforeEvaluationSeconds: Math.max(0, completed.phaseDurationSeconds - 1),
            };
            if (completed.targetHeartRateMin !== undefined) {
                priorWorkEvaluation.targetHeartRateMin = completed.targetHeartRateMin;
            }
            if (completed.targetHeartRateMax !== undefined) {
                priorWorkEvaluation.targetHeartRateMax = completed.targetHeartRateMax;
            }
        }
    }
    const phaseChanged = finalizedState.currentPhaseId !== context.phaseId;
    const phaseState = phaseChanged
        ? {
            ...finalizedState,
            currentPhaseId: context.phaseId,
            currentPhaseKind: context.phaseKind,
            lastEvaluationPhaseElapsedSeconds: undefined,
            shortIntervalEvaluated: false,
            mediumIntervalEvaluated: false,
            initialEvaluationSeconds: undefined,
            increaseCooldownSeconds: undefined,
            decreaseCooldownSeconds: undefined,
            currentEvaluationCooldownSeconds: undefined,
            lastWorkAdjustmentDirection: undefined,
        }
        : finalizedState;
    if (context.holdResistance != null && Number.isFinite(context.holdResistance)) {
        const held = holdGuidance(context, phaseState, phaseChanged);
        if (priorWorkEvaluation)
            held.priorWorkEvaluation = priorWorkEvaluation;
        return held;
    }
    const result = context.phaseKind === "warmup"
        ? warmupGuidance(context, phaseState, phaseChanged)
        : context.phaseKind === "work"
            ? workGuidance(context, phaseState, phaseChanged)
            : context.phaseKind === "recovery"
                ? recoveryGuidance(context, phaseState, phaseChanged, false)
                : recoveryGuidance(context, phaseState, phaseChanged, true);
    if (priorWorkEvaluation)
        result.priorWorkEvaluation = priorWorkEvaluation;
    return result;
}
export const proformSmartPower10Adapter = {
    definition: {
        id: "proform-smart-power-10",
        name: "ProForm SMART Power 10.0",
        activity: "bike",
        profileVersion: 1,
    },
    getGuidance: getProFormSmartPower10Guidance,
};
