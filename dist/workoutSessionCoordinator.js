import { beginWorkout, getPausedElapsed, getStartTime, isPaused, pauseWorkout, restartWorkout, resumeWorkout, requestEarlyCooldown, restoreBikeBridgeBindingForActiveSession, startWorkout, todayName, tickVo2ProtocolWithCanonicalHr, vo2TickSessionKey, requestVo2LimitReached } from "./workoutLogic.js";
import { discardFreestyleRide, finishFreestyleRide, handleWorkoutCompletion, retryFreestyleSave, discardWorkoutSession } from "./workoutLifecycle.js";
import { getPlan, getWorkoutMetadata } from "./workoutData.js";
import { getSession, isSessionStale } from "./sessionStore.js";
import { FREESTYLE_WORKOUT_SELECTOR_ID, isFreestyleWorkoutSelector, readActiveSessionOwner, readSessionFinalization, readFreestyleAuthorityFault, markFreestyleAuthorityFault, clearFreestyleAuthorityFault } from "./freestyleRide.js";
import { getBikeBridgeSession } from "./platform/bikeBridgeRuntime.js";
import { isVo2WorkoutSelector, VO2_WORKOUT_SELECTOR_ID } from "./vo2Protocol.js";
import { deriveWorkoutState } from "./workoutDisplayState.js";
const ordinarySelectors = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", VO2_WORKOUT_SELECTOR_ID];
const defaultDependencies = {
    beginWorkout,
    getPausedElapsed,
    getStartTime,
    isPaused,
    pauseWorkout,
    restartWorkout,
    resumeWorkout,
    requestEarlyCooldown,
    restoreBikeBridgeBindingForActiveSession,
    startWorkout,
    todayName,
    tickVo2ProtocolWithCanonicalHr,
    vo2TickSessionKey,
    requestVo2LimitReached,
    discardFreestyleRide,
    finishFreestyleRide,
    handleWorkoutCompletion,
    retryFreestyleSave,
    discardWorkoutSession,
    readActiveSessionOwner,
    readSessionFinalization,
    readFreestyleAuthorityFault,
    markFreestyleAuthorityFault,
    clearFreestyleAuthorityFault,
    getBikeBridgeSession,
    getPlan,
    getWorkoutMetadata,
    getSession,
    isSessionStale,
    deriveWorkoutState,
};
function findUnresolvedOrdinaryDay(getSession, readSessionFinalization) {
    for (const day of ordinarySelectors) {
        if (readSessionFinalization(day))
            return day;
    }
    for (const day of ordinarySelectors) {
        const session = getSession(day);
        if ((session.sessionId || session.startTime) && session.summaryEmitted !== "true")
            return day;
    }
    return undefined;
}
export function createWorkoutSessionCoordinator(effects, overrides = {}) {
    const { beginWorkout, getPausedElapsed, getStartTime, isPaused, pauseWorkout, restartWorkout, resumeWorkout, requestEarlyCooldown, restoreBikeBridgeBindingForActiveSession, startWorkout, todayName, tickVo2ProtocolWithCanonicalHr, vo2TickSessionKey, requestVo2LimitReached, discardFreestyleRide, finishFreestyleRide, handleWorkoutCompletion, retryFreestyleSave, readActiveSessionOwner, readSessionFinalization, readFreestyleAuthorityFault, markFreestyleAuthorityFault, clearFreestyleAuthorityFault, getBikeBridgeSession, getPlan, getWorkoutMetadata, getSession, deriveWorkoutState } = { ...defaultDependencies, ...overrides };
    let selectedDay = null;
    let updateDisplaySeq = 0;
    function getSelectedDay() {
        return selectedDay || todayName();
    }
    function setSelectedDay(day) {
        selectedDay = day;
    }
    function resolveOwnedWorkoutDay() {
        const owner = readActiveSessionOwner();
        if (owner) {
            const session = getSession(owner.selector);
            if (session.sessionId === owner.sessionId && session.startTime) {
                return owner.selector;
            }
        }
        const finalization = readSessionFinalization(FREESTYLE_WORKOUT_SELECTOR_ID);
        if (finalization)
            return FREESTYLE_WORKOUT_SELECTOR_ID;
        return findUnresolvedOrdinaryDay(getSession, readSessionFinalization) || getSelectedDay();
    }
    function selectWorkoutDay(day) {
        const owner = readActiveSessionOwner();
        if (owner) {
            const session = getSession(owner.selector);
            if (session.sessionId === owner.sessionId && session.startTime && day !== owner.selector) {
                setSelectedDay(owner.selector);
                return { day: owner.selector, blocked: true };
            }
        }
        const unresolved = findUnresolvedOrdinaryDay(getSession, readSessionFinalization);
        if (unresolved && unresolved !== day) {
            setSelectedDay(unresolved);
            return { day: unresolved, blocked: true };
        }
        setSelectedDay(day);
        return { day, blocked: false };
    }
    async function refresh() {
        var _a;
        const seq = ++updateDisplaySeq;
        try {
            if (typeof getPlan !== "function" || typeof getWorkoutMetadata !== "function")
                return;
            const day = resolveOwnedWorkoutDay();
            if (selectedDay !== day)
                selectedDay = day;
            const plan = getPlan();
            const workoutMetadata = getWorkoutMetadata();
            const base = plan[day];
            const startTime = getStartTime(day);
            const paused = typeof isPaused === "function" && isPaused(day);
            const pausedElapsed = typeof getPausedElapsed === "function" ? getPausedElapsed(day) : 0;
            const { liveBpm, lastBpmUpdateTime } = effects.readLiveHeartRate();
            // Live-HR guard contract: the v3 ceiling guard evaluates inside the tick below, so this
            // call must stay unconditional (every refresh, any elapsed) -- never gate it on checkpoints.
            if (startTime && isVo2WorkoutSelector(day) && getSession(day).summaryEmitted !== "true" && !readSessionFinalization(day)) {
                const elapsedSec = paused ? pausedElapsed : Math.floor((Date.now() - parseInt(startTime, 10)) / 1000);
                const sessionKey = vo2TickSessionKey(getSession(day));
                const isCurrent = () => seq === updateDisplaySeq && resolveOwnedWorkoutDay() === day && !readSessionFinalization(day);
                const tick = await tickVo2ProtocolWithCanonicalHr(day, elapsedSec, paused, undefined, { isCurrent });
                if (tick === undefined || !isCurrent() || vo2TickSessionKey(getSession(day)) !== sessionKey)
                    return;
                effects.setVo2Cues((_a = tick === null || tick === void 0 ? void 0 : tick.cues) !== null && _a !== void 0 ? _a : []);
            }
            else {
                effects.setVo2Cues([]);
            }
            const state = deriveWorkoutState(day, plan, workoutMetadata, base, startTime, paused, pausedElapsed, liveBpm, lastBpmUpdateTime);
            effects.render(state, liveBpm);
        }
        catch (error) {
            effects.onRefreshError(error);
        }
    }
    function pause(day, elapsedSec) {
        pauseWorkout(day, elapsedSec);
        effects.releaseWakeLock();
        effects.updateDisplay();
    }
    function resume(day) {
        resumeWorkout(day);
        effects.requestWakeLock();
        effects.updateDisplay();
    }
    function complete(day) {
        const session = getSession(day);
        if (session.summaryEmitted === "true" && !readSessionFinalization(day))
            return;
        handleWorkoutCompletion(day);
    }
    function finishOwnedFreestyleRide() {
        return finishFreestyleRide(resolveOwnedWorkoutDay());
    }
    function retryOwnedFreestyleSave() {
        return retryFreestyleSave(FREESTYLE_WORKOUT_SELECTOR_ID);
    }
    function discardOwnedFreestyleRide() {
        var _a, _b;
        const day = resolveOwnedWorkoutDay();
        const session = getSession(day);
        const finalization = readSessionFinalization(day);
        const targetSessionId = session.sessionId && (finalization === null || finalization === void 0 ? void 0 : finalization.sessionId) && session.sessionId !== finalization.sessionId
            ? undefined
            : (_b = (_a = session.sessionId) !== null && _a !== void 0 ? _a : finalization === null || finalization === void 0 ? void 0 : finalization.sessionId) !== null && _b !== void 0 ? _b : undefined;
        return discardFreestyleRide(day, undefined, targetSessionId ? { sessionId: targetSessionId } : undefined);
    }
    function checkFreestyleAuthority(day, session) {
        if (!isFreestyleWorkoutSelector(day) || !session.sessionId)
            return { status: "valid" };
        const authorityOk = !!session.controlAuthority &&
            session.controlAuthority.source === "frozen" &&
            session.controlAuthority.mode === "manual_freestyle_ride" &&
            session.controlAuthority.sessionId === session.sessionId;
        if (!authorityOk) {
            try {
                getBikeBridgeSession().bindSession(null);
            }
            catch (error) {
                console.error("Failed to disarm Bike Bridge after authority fault:", error);
            }
            return { status: "invalid", newlyMarked: markFreestyleAuthorityFault(day, session.sessionId) };
        }
        if (readFreestyleAuthorityFault(day)) {
            clearFreestyleAuthorityFault(day);
            return { status: "restored" };
        }
        return { status: "valid" };
    }
    return { getSelectedDay, setSelectedDay, resolveOwnedWorkoutDay, selectWorkoutDay, refresh, startWorkout, beginWorkout, restartWorkout, requestEarlyCooldown, requestVo2LimitReached, pause, resume, complete, finishOwnedFreestyleRide, discardOwnedFreestyleRide, retryOwnedFreestyleSave, checkFreestyleAuthority, restoreBikeBridgeBindingForActiveSession };
}
export function collectProtectedOrdinarySessionIds() {
    const ids = [];
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", VO2_WORKOUT_SELECTOR_ID]) {
        const finalization = readSessionFinalization(day);
        if (finalization)
            ids.push(finalization.sessionId);
        const session = getSession(day);
        if (session.sessionId && session.summaryEmitted !== "true")
            ids.push(session.sessionId);
    }
    return ids;
}
export function cleanupStaleWorkoutSessions(overrides = {}) {
    const { getSession, isSessionStale, discardWorkoutSession, readSessionFinalization } = { ...defaultDependencies, ...overrides };
    const days = [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
        VO2_WORKOUT_SELECTOR_ID,
    ];
    days.forEach((day) => {
        const session = getSession(day);
        if (session.sessionStart && isSessionStale(day) && !readSessionFinalization(day)) {
            const hours = Math.round((Date.now() - parseInt(session.sessionStart)) / (1000 * 60 * 60));
            console.warn(`Cleaning up stale workout session for ${day} (age: ${hours} hours)`);
            discardWorkoutSession(day);
        }
    });
}
export async function recoverActiveOrFinalizingSession(setSelectedDay, overrides = {}) {
    const { getSession, readSessionFinalization, readActiveSessionOwner, finishFreestyleRide, restoreBikeBridgeBindingForActiveSession } = { ...defaultDependencies, ...overrides };
    const freestyleFinalization = readSessionFinalization(FREESTYLE_WORKOUT_SELECTOR_ID);
    if (freestyleFinalization) {
        setSelectedDay(FREESTYLE_WORKOUT_SELECTOR_ID);
        try {
            if (freestyleFinalization.status === "finalizing" ||
                freestyleFinalization.status === "save_failed") {
                await finishFreestyleRide(FREESTYLE_WORKOUT_SELECTOR_ID);
            }
        }
        catch (error) {
            console.error("Freestyle recovery failed; preserving ride evidence:", error);
        }
        return;
    }
    const freestyleSession = getSession(FREESTYLE_WORKOUT_SELECTOR_ID);
    if (freestyleSession.sessionId && freestyleSession.startTime) {
        setSelectedDay(FREESTYLE_WORKOUT_SELECTOR_ID);
        restoreBikeBridgeBindingForActiveSession(FREESTYLE_WORKOUT_SELECTOR_ID);
        return;
    }
    const owner = readActiveSessionOwner();
    if (!owner) {
        const unresolved = findUnresolvedOrdinaryDay(getSession, readSessionFinalization);
        if (unresolved)
            setSelectedDay(unresolved);
        return;
    }
    const session = getSession(owner.selector);
    if (!session.sessionId || session.sessionId !== owner.sessionId || !session.startTime) {
        const unresolved = findUnresolvedOrdinaryDay(getSession, readSessionFinalization);
        if (unresolved)
            setSelectedDay(unresolved);
        return;
    }
    setSelectedDay(owner.selector);
    if (isFreestyleWorkoutSelector(owner.selector)) {
        restoreBikeBridgeBindingForActiveSession(owner.selector);
    }
}
