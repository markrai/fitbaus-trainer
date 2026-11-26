import { adjustedBlockLengths, getPhase } from "./workoutLogic.js";
import { getHrTargets } from "./workoutData.js";
import { getSession } from "./sessionStore.js";
import { assessmentBasedWorkloadForPhase } from "./personalizedPrescription.js";
import { isVo2WorkoutSelector, vo2ProtocolDisplayName } from "./vo2Protocol.js";
import { FREESTYLE_WORKOUT_LABEL, freestyleWorkoutBlocksText, isFreestyleWorkoutSelector, readSessionFinalization } from "./freestyleRide.js";
import { genericWorkoutBlocksText, vo2WorkoutBlocksText } from "./vo2AssessmentView.js";
import { getActiveWorkoutActivity } from "./workoutActivity.js";
import { findResolvedPhaseTarget, formatResolvedHeartRateTarget, resolveWorkoutPrescription } from "./workoutPrescription.js";
export const BPM_TIMEOUT_MS = 3000;
function resolvedPrescriptionForSession(day, blocks, session) {
    var _a, _b, _c;
    if ((_a = session.phasePlan) === null || _a === void 0 ? void 0 : _a.resolvedPrescription)
        return session.phasePlan.resolvedPrescription;
    const rawResolvedAt = Number((_b = session.sessionStart) !== null && _b !== void 0 ? _b : session.startTime);
    return resolveWorkoutPrescription({
        workoutSelector: day,
        blocks,
        hrTargets: session.phasePlan ? session.phasePlan.hrTargets : (_c = getHrTargets()[day]) !== null && _c !== void 0 ? _c : null,
        resolvedAt: Number.isFinite(rawResolvedAt) && rawResolvedAt > 0
            ? new Date(rawResolvedAt).toISOString()
            : "historical-session",
    });
}
export function deriveWorkoutState(day, plan, workoutMetadata, base, startTime, paused, pausedElapsed, liveBpm, lastBpmUpdateTime) {
    var _a, _b, _c, _d, _e;
    if (day === "Downregulation") {
        return { screen: "downregulation", day: "Downregulation", plan, workoutMetadata };
    }
    if (!base) {
        return { screen: "rest", day, plan, workoutMetadata };
    }
    const session = getSession(day);
    const blocks = (_b = (_a = session.phasePlan) === null || _a === void 0 ? void 0 : _a.blocks) !== null && _b !== void 0 ? _b : adjustedBlockLengths(base, null);
    const workoutBlocksText = isFreestyleWorkoutSelector(day)
        ? freestyleWorkoutBlocksText()
        : isVo2WorkoutSelector(day)
            ? vo2WorkoutBlocksText(blocks)
            : genericWorkoutBlocksText(blocks);
    if (!startTime) {
        return { screen: "idle", day, plan, workoutMetadata, base, blocks, workoutBlocksText };
    }
    const finalization = !isFreestyleWorkoutSelector(day) ? readSessionFinalization(day) : null;
    if (finalization && finalization.sessionId === session.sessionId) {
        return { screen: "completed", day, plan, workoutMetadata, base, blocks, workoutBlocksText, elapsedSec: finalization.activeDurationSec };
    }
    if (isVo2WorkoutSelector(day) && session.vo2ProtocolRestartRequired) {
        return { screen: "vo2_restart_required", day, plan, workoutMetadata, base, blocks, workoutBlocksText };
    }
    const elapsedSec = paused ? pausedElapsed : Math.floor((Date.now() - parseInt(startTime)) / 1000);
    const phase = getPhase(elapsedSec, blocks, session.earlyCooldownElapsed, {
        day,
        hrTargets: session.phasePlan ? session.phasePlan.hrTargets : undefined,
        vo2Protocol: session.vo2ProtocolRuntime,
    });
    if (phase.done) {
        return { screen: "completed", day, plan, workoutMetadata, base, blocks, workoutBlocksText, elapsedSec };
    }
    const prescription = isFreestyleWorkoutSelector(day)
        ? undefined
        : resolvedPrescriptionForSession(day, blocks, session);
    const resolvedPhaseTarget = isVo2WorkoutSelector(day) || isFreestyleWorkoutSelector(day)
        ? undefined
        : findResolvedPhaseTarget(prescription, phase.phaseId, elapsedSec);
    let phaseDisplayName = phase.phase;
    if (isFreestyleWorkoutSelector(day)) {
        phaseDisplayName = FREESTYLE_WORKOUT_LABEL;
    }
    else if (isVo2WorkoutSelector(day)) {
        phaseDisplayName = vo2ProtocolDisplayName(phase);
    }
    else if (phase.kind === "warmup") {
        const subsectionName = resolvedPhaseTarget === null || resolvedPhaseTarget === void 0 ? void 0 : resolvedPhaseTarget.detailName;
        if (subsectionName)
            phaseDisplayName = "Warm-Up (" + subsectionName + ")";
    }
    else if (phase.detailName) {
        phaseDisplayName = phase.detailName;
    }
    else if (phase.kind === "work" || phase.kind === "recovery") {
        phaseDisplayName = "Workout";
    }
    const hrTargetTextValue = isFreestyleWorkoutSelector(day)
        ? ""
        : formatResolvedHeartRateTarget(resolvedPhaseTarget);
    const assessmentBasedWorkload = isVo2WorkoutSelector(day) || isFreestyleWorkoutSelector(day)
        ? null
        : assessmentBasedWorkloadForPhase((_c = session.phasePlan) === null || _c === void 0 ? void 0 : _c.shadowPrescriptionEvaluation, phase.phaseId);
    const nowTime = Date.now();
    const liveBpmStale = lastBpmUpdateTime != null && nowTime - lastBpmUpdateTime > BPM_TIMEOUT_MS;
    return {
        screen: "active",
        day,
        plan,
        workoutMetadata,
        base,
        blocks,
        workoutBlocksText,
        elapsedSec,
        phase,
        phaseDisplayName,
        activity: (_e = getActiveWorkoutActivity((_d = workoutMetadata[day]) === null || _d === void 0 ? void 0 : _d.activities, session.activity)) !== null && _e !== void 0 ? _e : null,
        paused,
        hrTargetTextValue,
        assessmentBasedWorkload,
        resolvedPhaseTarget,
        liveBpm: liveBpm !== null && liveBpm !== void 0 ? liveBpm : null,
        liveBpmStale,
    };
}
