import { getHrTargets, getPlan, getWorkoutMetadata } from "./workoutData.js";
import { todayName } from "./utils/dateTime.js";
import { getSession, startSession, pauseSession, resumeSession, clearSession, getEarlyCooldownElapsed, setEarlyCooldownElapsed, persistVo2ProtocolRuntime, } from "./sessionStore.js";
import { handleWorkoutCancellation } from "./workoutLifecycle.js";
import { resetMachineGuidanceRuntime } from "./machines/runtime.js";
import { getActiveWorkoutActivity, requireAllowedActivity } from "./workoutActivity.js";
import { isVo2WorkoutSelector, vo2ProtocolVoiceCues, isStaleVo2ProtocolTick, VO2_HR_FRESHNESS_MS, } from "./vo2Protocol.js";
import { advanceVo2ProtocolRuntime, createVo2ProtocolRuntimeV3, evaluateVo2PreflightV3ForUi, resolveVo2PreflightPolicyOverride, getVo2ProtocolPhaseForRuntime, vo2ProtocolNeedsHrEvaluationForRuntime, } from "./vo2ProtocolV3.js";
import { clearOrdinaryBikeTelemetry, getHrSamples } from "./workoutStorage.js";
import { clearBikeTelemetrySamples, getBikeTelemetrySamples, recordBikeTelemetrySample, } from "./bikeTelemetryTrace.js";
import { parseLegacyHeartRateTarget, resolveWorkoutPrescription } from "./workoutPrescription.js";
import { PHASE_E1_SHADOW_POLICY, evaluatePersonalizedPrescription, } from "./personalizedPrescription.js";
import { loadAthleteProfile } from "./profile.js";
import { FITNESS_STATE_STORAGE_KEY, parseFitnessState } from "./fitnessState.js";
import { buildOrdinaryBikeTelemetrySample, } from "./ordinaryWorkoutTelemetry.js";
const RING_CIRC = 339.292;
const RING_CIRC_LANDSCAPE = 407.1504;
function getRingCircumference() {
    return window.matchMedia("(orientation: landscape)").matches ? RING_CIRC_LANDSCAPE : RING_CIRC;
}
function getStartTime(day) {
    const dayToUse = day || todayName();
    return getSession(dayToUse).startTime;
}
function isPaused(day) {
    const dayToUse = day || todayName();
    return getSession(dayToUse).paused;
}
function getPausedElapsed(day) {
    const dayToUse = day || todayName();
    return getSession(dayToUse).pausedElapsed;
}
function pauseWorkout(day, elapsedSec) {
    const dayToUse = day || todayName();
    pauseSession(dayToUse, elapsedSec !== null && elapsedSec !== void 0 ? elapsedSec : 0);
    if (typeof window.updateDisplay === "function")
        window.updateDisplay();
}
function resumeWorkout(day) {
    const dayToUse = day || todayName();
    resumeSession(dayToUse);
    if (typeof window.updateDisplay === "function")
        window.updateDisplay();
}
function completedPhase() {
    return {
        phase: "Completed",
        kind: "completed",
        phaseId: "completed",
        phaseElapsedSeconds: 0,
        phaseDurationSeconds: 0,
        timeLeft: 0,
        done: true,
    };
}
function cooldownPhase(elapsedSec, startSec, durationSec) {
    const phaseElapsedSeconds = elapsedSec - startSec;
    if (phaseElapsedSeconds >= durationSec)
        return completedPhase();
    return {
        phase: "Cool-Down",
        kind: "cooldown",
        phaseId: "cooldown",
        phaseElapsedSeconds,
        phaseDurationSeconds: durationSec,
        timeLeft: durationSec - phaseElapsedSeconds,
        done: false,
    };
}
function actualElapsedSeconds(startTime, paused, pausedElapsed, now) {
    if (!startTime)
        return 0;
    if (paused)
        return pausedElapsed;
    return Math.floor((now - parseInt(startTime, 10)) / 1000);
}
/** Authoritative active workout clock (excludes paused time). */
const activeElapsedSeconds = actualElapsedSeconds;
function lastPersistedElapsedFromHrSamples(samples) {
    let max;
    for (const sample of samples) {
        if (!Number.isFinite(sample.timestamp_sec))
            continue;
        if (max === undefined || sample.timestamp_sec > max)
            max = sample.timestamp_sec;
    }
    return max;
}
function workoutRelativeHrSample(session, now = Date.now(), lastPersistedElapsed) {
    if (!session.startTime || !session.sessionId || session.paused)
        return null;
    const elapsedSec = actualElapsedSeconds(session.startTime, false, session.pausedElapsed, now);
    if (lastPersistedElapsed != null && elapsedSec <= lastPersistedElapsed)
        return null;
    return { elapsedSec };
}
/** Record bike telemetry on the same pause-safe active clock as HR / VO₂ protocol elapsed. */
function recordVo2ActiveBikeTelemetry(session, metrics, now = Date.now(), storage) {
    if (!session.sessionId)
        return null;
    const clock = workoutRelativeHrSample(session, now);
    if (!clock)
        return null;
    recordBikeTelemetrySample(session.sessionId, { timestamp_sec: clock.elapsedSec, ...metrics }, storage);
    return clock.elapsedSec;
}
/** Build athlete-owned ordinary evidence on the same canonical active clock as HR. */
function ordinaryActiveBikeTelemetrySample(session, telemetry, now = Date.now()) {
    const clock = workoutRelativeHrSample(session, now);
    if (!clock)
        return null;
    return buildOrdinaryBikeTelemetrySample({
        ...telemetry,
        athleteId: session.athleteId,
        sessionId: session.sessionId,
        activeSec: clock.elapsedSec,
        observedAtMs: now,
    });
}
function releaseReplacedSessionTelemetry(day, nextSessionId) {
    const previous = getSession(day);
    const previousId = previous.sessionId;
    if (previousId && previousId !== nextSessionId) {
        clearBikeTelemetrySamples(previousId);
        if (previous.summaryEmitted !== "true")
            return clearOrdinaryBikeTelemetry(previousId);
    }
    return Promise.resolve();
}
function planEarlyCooldownTransition(input) {
    if (!input.hasSession || !input.blocks || input.blocks.cool <= 0) {
        return { type: "unavailable" };
    }
    const phase = getPhase(input.elapsedSec, input.blocks, input.earlyCooldownElapsed, {
        vo2Protocol: input.vo2Protocol,
    });
    if (phase.done)
        return { type: "unavailable" };
    if (phase.kind === "cooldown") {
        return { type: "already-in-cooldown", resume: input.paused };
    }
    return { type: "enter-early-cooldown", elapsedSec: input.elapsedSec, resume: input.paused };
}
function resolveEarlyCooldownBlocks(day, blocksOverride) {
    if (blocksOverride !== undefined)
        return blocksOverride;
    const snapshot = getSession(day).phasePlan;
    if (snapshot === null || snapshot === void 0 ? void 0 : snapshot.blocks)
        return snapshot.blocks;
    const base = getPlan()[day];
    return base ? adjustedBlockLengths(base, null) : null;
}
let earlyCooldownInFlight = false;
function requestEarlyCooldown(day, options) {
    var _a;
    if (earlyCooldownInFlight)
        return { type: "unavailable" };
    earlyCooldownInFlight = true;
    try {
        const dayToUse = day || (typeof window.getSelectedDay === "function" ? window.getSelectedDay() : todayName());
        const storage = options === null || options === void 0 ? void 0 : options.storage;
        const now = (_a = options === null || options === void 0 ? void 0 : options.now) !== null && _a !== void 0 ? _a : Date.now();
        const session = getSession(dayToUse, storage);
        const blocks = resolveEarlyCooldownBlocks(dayToUse, options === null || options === void 0 ? void 0 : options.blocks);
        const elapsedSec = actualElapsedSeconds(session.startTime, session.paused, session.pausedElapsed, now);
        const decision = planEarlyCooldownTransition({
            blocks,
            hasSession: Boolean(session.startTime),
            elapsedSec,
            paused: session.paused,
            earlyCooldownElapsed: getEarlyCooldownElapsed(dayToUse, storage),
            vo2Protocol: session.vo2ProtocolRuntime,
        });
        if (decision.type === "unavailable")
            return decision;
        if (decision.type === "enter-early-cooldown") {
            setEarlyCooldownElapsed(dayToUse, decision.elapsedSec, storage);
            tickVo2Protocol(dayToUse, decision.elapsedSec, false, storage);
        }
        if (session.paused)
            resumeSession(dayToUse, storage, now);
        if (typeof window.requestWakeLock === "function")
            window.requestWakeLock();
        if (typeof window.updateDisplay === "function")
            window.updateDisplay();
        return decision;
    }
    finally {
        earlyCooldownInFlight = false;
    }
}
let vo2LimitReachedInFlight = false;
function requestVo2LimitReached(day, options) {
    var _a;
    if (vo2LimitReachedInFlight)
        return { type: "unavailable" };
    vo2LimitReachedInFlight = true;
    try {
        const dayToUse = day || (typeof window.getSelectedDay === "function" ? window.getSelectedDay() : todayName());
        if (!isVo2WorkoutSelector(dayToUse))
            return { type: "unavailable" };
        const storage = options === null || options === void 0 ? void 0 : options.storage;
        const now = (_a = options === null || options === void 0 ? void 0 : options.now) !== null && _a !== void 0 ? _a : Date.now();
        const session = getSession(dayToUse, storage);
        const blocks = resolveEarlyCooldownBlocks(dayToUse, options === null || options === void 0 ? void 0 : options.blocks);
        const elapsedSec = actualElapsedSeconds(session.startTime, session.paused, session.pausedElapsed, now);
        const decision = planEarlyCooldownTransition({
            blocks,
            hasSession: Boolean(session.startTime),
            elapsedSec,
            paused: session.paused,
            earlyCooldownElapsed: getEarlyCooldownElapsed(dayToUse, storage),
            vo2Protocol: session.vo2ProtocolRuntime,
        });
        if (decision.type === "unavailable")
            return decision;
        if (decision.type === "already-in-cooldown")
            return decision;
        markVo2ProtocolLimitReached(dayToUse, decision.elapsedSec, storage);
        if (session.paused)
            resumeSession(dayToUse, storage, now);
        if (typeof window.requestWakeLock === "function")
            window.requestWakeLock();
        if (typeof window.updateDisplay === "function")
            window.updateDisplay();
        return { type: "enter-limit-reached", elapsedSec: decision.elapsedSec, resume: session.paused };
    }
    finally {
        vo2LimitReachedInFlight = false;
    }
}
function startWorkout() {
    var _a, _b;
    const day = typeof window.getSelectedDay === "function" ? window.getSelectedDay() : todayName();
    const allowed = (_b = (_a = getWorkoutMetadata()[day]) === null || _a === void 0 ? void 0 : _a.activities) !== null && _b !== void 0 ? _b : [];
    const automatic = getActiveWorkoutActivity(allowed);
    if (automatic) {
        beginWorkout(automatic);
        return;
    }
    if (allowed.length > 1) {
        if (typeof window.promptWorkoutActivitySelection === "function") {
            window.promptWorkoutActivitySelection(allowed);
        }
        return;
    }
    beginWorkout();
}
/** Current product entry points may select only the two already-shipping authorities. */
function controlModeForUserFacingWorkout(day) {
    return isVo2WorkoutSelector(day) ? "vo2_protocol" : "legacy_hr_control";
}
/** Freeze the plan inputs the live runtime will use for this session. */
function capturePhasePlanSnapshot(day, resolvedAt = new Date().toISOString()) {
    var _a;
    const base = getPlan()[day];
    if (!base)
        return null;
    const blocks = adjustedBlockLengths(base, null);
    const hrTargets = (_a = getHrTargets()[day]) !== null && _a !== void 0 ? _a : null;
    const frozenTargets = hrTargets ? JSON.parse(JSON.stringify(hrTargets)) : null;
    const frozenBlocks = { warm: blocks.warm, sustain: blocks.sustain, cool: blocks.cool };
    return {
        blocks: frozenBlocks,
        hrTargets: frozenTargets,
        resolvedPrescription: resolveWorkoutPrescription({
            workoutSelector: day,
            blocks: frozenBlocks,
            hrTargets: frozenTargets,
            resolvedAt,
        }),
    };
}
/**
 * Read athlete evidence once at workout start and freeze the non-authoritative
 * E1 shadow workload evaluation beside the already-authoritative legacy HR
 * prescription. E1 does not personalize or replace the active heart-rate target.
 */
function captureWorkoutStartContext(day, activity, resolvedAt, storage) {
    var _a, _b;
    const phasePlan = capturePhasePlanSnapshot(day, resolvedAt);
    if (!(phasePlan === null || phasePlan === void 0 ? void 0 : phasePlan.resolvedPrescription))
        return { phasePlan };
    const store = storage !== null && storage !== void 0 ? storage : (typeof localStorage !== "undefined" ? localStorage : undefined);
    if (!store)
        return { phasePlan };
    try {
        const profile = loadAthleteProfile(store);
        const storedFitness = store.getItem(FITNESS_STATE_STORAGE_KEY);
        let rawFitnessState = null;
        if (storedFitness) {
            try {
                rawFitnessState = JSON.parse(storedFitness);
            }
            catch {
                rawFitnessState = storedFitness;
            }
        }
        const parsedFitness = parseFitnessState(rawFitnessState);
        const athleteFitnessSnapshot = {
            athleteId: profile.athleteId,
            profileSchemaVersion: profile.schemaVersion,
            ...((parsedFitness === null || parsedFitness === void 0 ? void 0 : parsedFitness.athleteId) === profile.athleteId
                ? {
                    fitnessStateSchemaVersion: parsedFitness.schemaVersion,
                    fitnessUpdatedAt: parsedFitness.updatedAt,
                }
                : {}),
        };
        phasePlan.shadowPrescriptionEvaluation = evaluatePersonalizedPrescription({
            legacyPrescription: phasePlan.resolvedPrescription,
            workoutIntent: (_b = (_a = getWorkoutMetadata()[day]) === null || _a === void 0 ? void 0 : _a.intent) !== null && _b !== void 0 ? _b : "",
            activity,
            athleteId: profile.athleteId,
            profile,
            fitnessState: rawFitnessState,
            policy: PHASE_E1_SHADOW_POLICY,
            resolvedAt,
        });
        return { phasePlan, athleteFitnessSnapshot };
    }
    catch (error) {
        console.error("Shadow prescription evaluation failed; continuing with legacy prescription:", error);
        return { phasePlan };
    }
}
function beginWorkout(activity) {
    var _a, _b, _c, _d;
    const day = typeof window.getSelectedDay === "function" ? window.getSelectedDay() : todayName();
    if (isVo2WorkoutSelector(day)) {
        const preflight = evaluateVo2PreflightV3ForUi(Date.now(), resolveVo2PreflightPolicyOverride());
        if (preflight.ok === false) {
            if (typeof window.showToast === "function") {
                window.showToast(preflight.message, "error");
            }
            return;
        }
        const allowed = (_b = (_a = getWorkoutMetadata()[day]) === null || _a === void 0 ? void 0 : _a.activities) !== null && _b !== void 0 ? _b : [];
        const resolved = activity !== undefined
            ? requireAllowedActivity(allowed, activity)
            : getActiveWorkoutActivity(allowed);
        if (allowed.length > 1 && resolved === undefined)
            return;
        const startTime = Date.now();
        const startContext = captureWorkoutStartContext(day, resolved, new Date(startTime).toISOString());
        const runtime = createVo2ProtocolRuntimeV3(preflight.plan, preflight.assessmentProfile);
        let sessionId = null;
        if (typeof window.generateUUID === "function") {
            sessionId = window.generateUUID();
            void releaseReplacedSessionTelemetry(day, sessionId);
            startSession(day, startTime, sessionId, resolved, undefined, startContext.phasePlan, startContext.athleteFitnessSnapshot, undefined, controlModeForUserFacingWorkout(day));
        }
        else {
            void releaseReplacedSessionTelemetry(day, null);
            startSession(day, startTime, null, resolved, undefined, startContext.phasePlan, startContext.athleteFitnessSnapshot, undefined, controlModeForUserFacingWorkout(day));
        }
        persistVo2ProtocolRuntime(day, runtime);
        resetMachineGuidanceRuntime(sessionId);
        if (typeof window.initDB === "function") {
            window.initDB().catch((err) => console.error("Failed to init DB:", err));
        }
        if (typeof window.requestWakeLock === "function") {
            window.requestWakeLock();
        }
        if (typeof window.updateDisplay === "function")
            window.updateDisplay();
        return;
    }
    const allowed = (_d = (_c = getWorkoutMetadata()[day]) === null || _c === void 0 ? void 0 : _c.activities) !== null && _d !== void 0 ? _d : [];
    const resolved = activity !== undefined
        ? requireAllowedActivity(allowed, activity)
        : getActiveWorkoutActivity(allowed);
    if (allowed.length > 1 && resolved === undefined)
        return;
    const startTime = Date.now();
    const startContext = captureWorkoutStartContext(day, resolved, new Date(startTime).toISOString());
    let sessionId = null;
    if (typeof window.generateUUID === "function") {
        sessionId = window.generateUUID();
        void releaseReplacedSessionTelemetry(day, sessionId);
        startSession(day, startTime, sessionId, resolved, undefined, startContext.phasePlan, startContext.athleteFitnessSnapshot, undefined, controlModeForUserFacingWorkout(day));
        if (typeof window.initDB === "function") {
            window.initDB().catch((err) => console.error("Failed to init DB:", err));
        }
    }
    else {
        void releaseReplacedSessionTelemetry(day, null);
        startSession(day, startTime, null, resolved, undefined, startContext.phasePlan, startContext.athleteFitnessSnapshot, undefined, controlModeForUserFacingWorkout(day));
    }
    resetMachineGuidanceRuntime(sessionId);
    if (typeof window.requestWakeLock === "function") {
        window.requestWakeLock();
    }
    if (typeof window.updateDisplay === "function")
        window.updateDisplay();
}
async function restartWorkout() {
    const day = typeof window.getSelectedDay === "function" ? window.getSelectedDay() : todayName();
    const session = getSession(day);
    const elapsedSec = actualElapsedSeconds(session.startTime, session.paused, session.pausedElapsed, Date.now());
    markVo2ProtocolCancelled(day, elapsedSec);
    await handleWorkoutCancellation(day);
    if (typeof window.releaseWakeLock === "function") {
        await window.releaseWakeLock();
    }
    clearSession(day);
    resetMachineGuidanceRuntime();
    if (session.sessionId) {
        clearBikeTelemetrySamples(session.sessionId);
        await clearOrdinaryBikeTelemetry(session.sessionId);
        if (typeof window.clearHrSamples === "function") {
            await window.clearHrSamples(session.sessionId).catch((err) => console.error("Error clearing HR samples:", err));
        }
    }
    if (typeof window.updateDisplay === "function")
        window.updateDisplay();
}
function resolveDayHrTargets(day, hrTargets) {
    return hrTargets !== undefined ? hrTargets : getHrTargets()[day];
}
function getIntervalRuntime(day, sustainElapsed, hrTargets) {
    var _a;
    const intervals = (_a = resolveDayHrTargets(day, hrTargets)) === null || _a === void 0 ? void 0 : _a.intervals;
    if (!intervals || intervals.phases.length === 0)
        return null;
    const phases = intervals.phases;
    const totalDuration = phases.reduce((sum, phase) => sum + phase.duration * 60, 0);
    if (totalDuration <= 0)
        return null;
    const cycleIndex = intervals.isSequence ? 0 : Math.floor(sustainElapsed / totalDuration);
    const elapsedInCycle = intervals.isSequence
        ? Math.min(sustainElapsed, Math.max(0, totalDuration - 1))
        : sustainElapsed % totalDuration;
    let accumulated = 0;
    for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
        const interval = phases[phaseIndex];
        const durationSeconds = interval.duration * 60;
        if (elapsedInCycle < accumulated + durationSeconds) {
            const workPhasesThroughCurrent = phases
                .slice(0, phaseIndex + 1)
                .filter((phase) => phase.kind === "work").length;
            return {
                interval,
                phaseIndex,
                phaseElapsedSeconds: elapsedInCycle - accumulated,
                phaseDurationSeconds: durationSeconds,
                intervalIndex: intervals.isSequence ? Math.max(1, workPhasesThroughCurrent) : cycleIndex + 1,
                phaseId: intervals.isSequence ? `sequence:${phaseIndex}` : `cycle:${cycleIndex}:${phaseIndex}`,
            };
        }
        accumulated += durationSeconds;
    }
    return null;
}
function resolveVo2ProtocolRuntime(day, options) {
    if (options && Object.prototype.hasOwnProperty.call(options, "vo2Protocol"))
        return options.vo2Protocol;
    if (!isVo2WorkoutSelector(day))
        return undefined;
    return getSession(day).vo2ProtocolRuntime;
}
function getPhase(elapsedSec, blocks, earlyCooldownElapsed, options) {
    var _a, _b, _c;
    const day = (_a = options === null || options === void 0 ? void 0 : options.day) !== null && _a !== void 0 ? _a : (typeof window.getSelectedDay === "function" ? window.getSelectedDay() : todayName());
    const vo2Runtime = resolveVo2ProtocolRuntime(day, options);
    if (vo2Runtime)
        return getVo2ProtocolPhaseForRuntime(elapsedSec, vo2Runtime, earlyCooldownElapsed);
    const w = blocks.warm * 60;
    const s = blocks.sustain * 60;
    const c = blocks.cool * 60;
    if (earlyCooldownElapsed != null &&
        Number.isFinite(earlyCooldownElapsed) &&
        earlyCooldownElapsed >= 0 &&
        c > 0 &&
        elapsedSec >= earlyCooldownElapsed) {
        return cooldownPhase(elapsedSec, earlyCooldownElapsed, c);
    }
    if (elapsedSec < w) {
        return {
            phase: "Warm-Up",
            kind: "warmup",
            phaseId: "warmup",
            phaseElapsedSeconds: elapsedSec,
            phaseDurationSeconds: w,
            timeLeft: w - elapsedSec,
            done: false,
        };
    }
    if (elapsedSec < w + s) {
        const day = (_b = options === null || options === void 0 ? void 0 : options.day) !== null && _b !== void 0 ? _b : (typeof window.getSelectedDay === "function" ? window.getSelectedDay() : todayName());
        const dayHrTargets = resolveDayHrTargets(day, options === null || options === void 0 ? void 0 : options.hrTargets);
        const sustainElapsed = Math.max(0, elapsedSec - w);
        const intervalRuntime = getIntervalRuntime(day, sustainElapsed, dayHrTargets);
        if (intervalRuntime) {
            return {
                phase: "Sustain",
                kind: intervalRuntime.interval.kind,
                phaseId: intervalRuntime.phaseId,
                phaseElapsedSeconds: intervalRuntime.phaseElapsedSeconds,
                phaseDurationSeconds: intervalRuntime.phaseDurationSeconds,
                timeLeft: intervalRuntime.phaseDurationSeconds - intervalRuntime.phaseElapsedSeconds,
                done: false,
                detailName: intervalRuntime.interval.phase,
                intervalIndex: intervalRuntime.intervalIndex,
            };
        }
        return {
            phase: "Sustain",
            kind: (_c = dayHrTargets === null || dayHrTargets === void 0 ? void 0 : dayHrTargets.main_set_kind) !== null && _c !== void 0 ? _c : "work",
            phaseId: "sustain",
            phaseElapsedSeconds: sustainElapsed,
            phaseDurationSeconds: s,
            timeLeft: w + s - elapsedSec,
            done: false,
        };
    }
    if (elapsedSec < w + s + c) {
        return cooldownPhase(elapsedSec, w + s, c);
    }
    return completedPhase();
}
/**
 * Fresh live-HR spot reading (bpm) for the v3 ceiling guard. Mirrors the
 * preflight trust rule (strap attached, positive bpm, update within freshness),
 * tightened to fail closed: rejects future timestamps and non-finite garbage.
 * Null when unknown, stale, invalid, or when no browser HR feed exists.
 */
function readFreshLiveHrBpm(now = Date.now()) {
    if (typeof window === "undefined")
        return null;
    const liveBpm = window.liveBpm;
    const lastUpdate = window.lastBpmUpdateTime;
    if (!Boolean(window.hrDeviceName))
        return null;
    if (liveBpm == null || lastUpdate == null)
        return null;
    if (!Number.isFinite(liveBpm) || !Number.isFinite(lastUpdate))
        return null;
    const ageMs = now - lastUpdate;
    if (liveBpm <= 0 || ageMs > VO2_HR_FRESHNESS_MS || ageMs < 0)
        return null;
    return liveBpm;
}
function tickVo2Protocol(day, elapsedSec, paused, storage, samples = [], telemetrySamples = [], liveHrBpm = null) {
    const session = getSession(day, storage);
    if (!session.vo2ProtocolRuntime)
        return null;
    const before = session.vo2ProtocolRuntime;
    if (isStaleVo2ProtocolTick(before, elapsedSec)) {
        return { runtime: before, cues: [] };
    }
    const next = advanceVo2ProtocolRuntime(before, {
        elapsedSec,
        paused,
        samples,
        telemetrySamples,
        earlyCooldownElapsed: getEarlyCooldownElapsed(day, storage),
        liveHrBpm,
    });
    persistVo2ProtocolRuntime(day, next, storage);
    return { runtime: next, cues: vo2ProtocolVoiceCues(before, next, elapsedSec) };
}
async function tickVo2ProtocolWithCanonicalHr(day, elapsedSec, paused, storage) {
    const session = getSession(day, storage);
    if (!session.vo2ProtocolRuntime)
        return null;
    let samples = [];
    let telemetrySamples = [];
    if (session.sessionId &&
        vo2ProtocolNeedsHrEvaluationForRuntime(session.vo2ProtocolRuntime, elapsedSec, paused)) {
        samples = await getHrSamples(session.sessionId);
        telemetrySamples = getBikeTelemetrySamples(session.sessionId, storage);
    }
    return tickVo2Protocol(day, elapsedSec, paused, storage, samples, telemetrySamples, readFreshLiveHrBpm());
}
function markVo2ProtocolCancelled(day, elapsedSec, storage) {
    const session = getSession(day, storage);
    if (!session.vo2ProtocolRuntime)
        return;
    persistVo2ProtocolRuntime(day, advanceVo2ProtocolRuntime(session.vo2ProtocolRuntime, {
        elapsedSec,
        paused: session.paused,
        samples: [],
        cancelled: true,
    }), storage);
}
function markVo2ProtocolLimitReached(day, elapsedSec, storage) {
    const session = getSession(day, storage);
    if (!session.vo2ProtocolRuntime)
        return;
    persistVo2ProtocolRuntime(day, advanceVo2ProtocolRuntime(session.vo2ProtocolRuntime, {
        elapsedSec,
        paused: session.paused,
        samples: [],
        limitReached: true,
    }), storage);
}
function formatTime(sec, options) {
    const showSeconds = options && "showSeconds" in options ? !!options.showSeconds : true;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const parts = [];
    if (h > 0)
        parts.push(h + "h");
    parts.push(m + "m");
    if (showSeconds)
        parts.push(s + "s");
    return parts.join(" ");
}
function getTodayHRV() {
    return null;
}
function adjustedBlockLengths(base, _hrv) {
    return base;
}
function updateRing(elapsedSec, blocks) {
    const ringEl = document.getElementById("ringProgress");
    const center = document.getElementById("ringCenterText");
    if (!(ringEl instanceof SVGCircleElement) || !blocks)
        return;
    const totalSec = (blocks.warm + blocks.sustain + blocks.cool) * 60;
    if (totalSec <= 0)
        return;
    const cappedElapsed = Math.max(0, Math.min(elapsedSec, totalSec));
    const remaining = totalSec - cappedElapsed;
    const ringCirc = getRingCircumference();
    const showElapsed = typeof window.getShowElapsed === "function" && window.getShowElapsed();
    if (showElapsed) {
        // Increasing ring: fill as elapsed time grows (phase colors match progress)
        const progress = cappedElapsed / totalSec;
        const offset = ringCirc * (1 - progress);
        ringEl.style.strokeDasharray = String(ringCirc);
        ringEl.style.strokeDashoffset = String(offset);
    }
    else {
        // Decrementing ring: show remaining portion
        const visibleLength = ringCirc * (remaining / totalSec);
        ringEl.style.strokeDasharray = `${visibleLength} ${ringCirc}`;
        ringEl.style.strokeDashoffset = "0";
    }
    const showSeconds = typeof window.getShowSecondsCountdown === "function" && window.getShowSecondsCountdown();
    const labelEl = document.getElementById("ringCenterLabel");
    if (center)
        center.textContent = formatTime(showElapsed ? cappedElapsed : remaining, { showSeconds });
    if (labelEl)
        labelEl.textContent = showElapsed ? "total elapsed" : "total remaining";
}
const parseHrTargetRange = parseLegacyHeartRateTarget;
function hrTargetText(phaseName, day, elapsedSec, blocks, hrTargets) {
    const dayHrTargets = resolveDayHrTargets(day, hrTargets);
    if (!dayHrTargets)
        return "";
    if (phaseName === "Warm-Up") {
        if (dayHrTargets.warmup_subsections && Array.isArray(dayHrTargets.warmup_subsections)) {
            for (const subsection of dayHrTargets.warmup_subsections) {
                const startSec = subsection.start_min * 60;
                const endSec = subsection.end_min * 60;
                if (elapsedSec >= startSec && elapsedSec < endSec) {
                    return subsection.target_hr_bpm + " bpm";
                }
            }
        }
        if (dayHrTargets.warmup)
            return dayHrTargets.warmup + " bpm";
    }
    else if (phaseName === "Cool-Down") {
        if (dayHrTargets.cooldown)
            return dayHrTargets.cooldown + " bpm";
    }
    else if (phaseName === "Sustain") {
        if (dayHrTargets.intervals && dayHrTargets.intervals.phases) {
            const warmSec = blocks.warm * 60;
            const sustainElapsed = Math.max(0, elapsedSec - warmSec);
            const intervalRuntime = getIntervalRuntime(day, sustainElapsed, dayHrTargets);
            if (intervalRuntime === null || intervalRuntime === void 0 ? void 0 : intervalRuntime.interval.target_hr_bpm)
                return intervalRuntime.interval.target_hr_bpm + " bpm";
        }
        else if (dayHrTargets.main_set) {
            return dayHrTargets.main_set + " bpm";
        }
    }
    return "";
}
export function registerWorkoutLogicGlobals() {
    window.todayName = todayName;
    window.getStartTime = getStartTime;
    window.isPaused = isPaused;
    window.getPausedElapsed = getPausedElapsed;
    window.pauseWorkout = pauseWorkout;
    window.resumeWorkout = resumeWorkout;
    window.startWorkout = startWorkout;
    window.beginWorkout = beginWorkout;
    window.restartWorkout = restartWorkout;
    window.requestEarlyCooldown = requestEarlyCooldown;
    window.requestVo2LimitReached = requestVo2LimitReached;
    window.getPhase = getPhase;
    window.formatTime = formatTime;
    window.getTodayHRV = getTodayHRV;
    window.adjustedBlockLengths = adjustedBlockLengths;
    window.updateRing = updateRing;
    window.hrTargetText = hrTargetText;
    window.parseHrTargetRange = parseHrTargetRange;
}
export { todayName, getStartTime, isPaused, getPausedElapsed, pauseWorkout, resumeWorkout, startWorkout, beginWorkout, restartWorkout, requestEarlyCooldown, requestVo2LimitReached, planEarlyCooldownTransition, actualElapsedSeconds, activeElapsedSeconds, lastPersistedElapsedFromHrSamples, workoutRelativeHrSample, recordVo2ActiveBikeTelemetry, ordinaryActiveBikeTelemetrySample, releaseReplacedSessionTelemetry, capturePhasePlanSnapshot, captureWorkoutStartContext, controlModeForUserFacingWorkout, getPhase, formatTime, adjustedBlockLengths, updateRing, hrTargetText, parseHrTargetRange, tickVo2Protocol, tickVo2ProtocolWithCanonicalHr, markVo2ProtocolCancelled, markVo2ProtocolLimitReached, };
