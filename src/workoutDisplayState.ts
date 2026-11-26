import { adjustedBlockLengths, getPhase } from "./workoutLogic.js";
import { getHrTargets } from "./workoutData.js";
import { getSession } from "./sessionStore.js";
import { assessmentBasedWorkloadForPhase } from "./personalizedPrescription.js";
import { isVo2WorkoutSelector, vo2ProtocolDisplayName } from "./vo2Protocol.js";
import { FREESTYLE_WORKOUT_LABEL, freestyleWorkoutBlocksText, isFreestyleWorkoutSelector, readSessionFinalization } from "./freestyleRide.js";
import { genericWorkoutBlocksText, vo2WorkoutBlocksText } from "./vo2AssessmentView.js";
import { getActiveWorkoutActivity } from "./workoutActivity.js";
import { findResolvedPhaseTarget, formatResolvedHeartRateTarget, resolveWorkoutPrescription } from "./workoutPrescription.js";
import type { Activity, ResolvedWorkoutPhaseTarget, ResolvedWorkoutPrescription, WorkoutPhaseState } from "./types.js";

export const BPM_TIMEOUT_MS = 3000;

function resolvedPrescriptionForSession(
  day: string,
  blocks: { warm: number; sustain: number; cool: number },
  session: ReturnType<typeof getSession>
): ResolvedWorkoutPrescription {
  if (session.phasePlan?.resolvedPrescription) return session.phasePlan.resolvedPrescription;
  const rawResolvedAt = Number(session.sessionStart ?? session.startTime);
  return resolveWorkoutPrescription({
    workoutSelector: day,
    blocks,
    hrTargets: session.phasePlan ? session.phasePlan.hrTargets : getHrTargets()[day] ?? null,
    resolvedAt: Number.isFinite(rawResolvedAt) && rawResolvedAt > 0
      ? new Date(rawResolvedAt).toISOString()
      : "historical-session",
  });
}

export type WorkoutDisplayState =
  | { screen: "rest"; day: string; plan: any; workoutMetadata: any }
  | { screen: "downregulation"; day: "Downregulation"; plan: any; workoutMetadata: any }
  | {
      screen: "idle";
      day: string;
      plan: any;
      workoutMetadata: any;
      base: any;
      blocks: any;
      workoutBlocksText: string;
    }
  | {
      screen: "completed";
      day: string;
      plan: any;
      workoutMetadata: any;
      base: any;
      blocks: any;
      workoutBlocksText: string;
      elapsedSec: number;
    }
  | {
      screen: "vo2_restart_required";
      day: string;
      plan: any;
      workoutMetadata: any;
      base: any;
      blocks: any;
      workoutBlocksText: string;
    }
  | {
      screen: "active";
      day: string;
      plan: any;
      workoutMetadata: any;
      base: any;
      blocks: any;
      workoutBlocksText: string;
      elapsedSec: number;
      phase: WorkoutPhaseState;
      phaseDisplayName: string;
      activity: Activity | null;
      paused: boolean;
      hrTargetTextValue: string;
      assessmentBasedWorkload: { minWatts: number; maxWatts: number } | null;
      resolvedPhaseTarget?: ResolvedWorkoutPhaseTarget;
      liveBpm: number | null;
      liveBpmStale: boolean;
    };

export function deriveWorkoutState(
  day: string,
  plan: any,
  workoutMetadata: any,
  base: any,
  startTime: string | null,
  paused: boolean,
  pausedElapsed: number,
  liveBpm: number | null,
  lastBpmUpdateTime: number | null
): WorkoutDisplayState {
  if (day === "Downregulation") {
    return { screen: "downregulation", day: "Downregulation", plan, workoutMetadata };
  }
  if (!base) {
    return { screen: "rest", day, plan, workoutMetadata };
  }

  const session = getSession(day);
  const blocks = session.phasePlan?.blocks ?? adjustedBlockLengths(base, null);
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
  const resolvedPhaseTarget =
    isVo2WorkoutSelector(day) || isFreestyleWorkoutSelector(day)
      ? undefined
      : findResolvedPhaseTarget(prescription, phase.phaseId, elapsedSec);

  let phaseDisplayName: string = phase.phase;
  if (isFreestyleWorkoutSelector(day)) {
    phaseDisplayName = FREESTYLE_WORKOUT_LABEL;
  } else if (isVo2WorkoutSelector(day)) {
    phaseDisplayName = vo2ProtocolDisplayName(phase);
  } else if (phase.kind === "warmup") {
    const subsectionName = resolvedPhaseTarget?.detailName;
    if (subsectionName) phaseDisplayName = "Warm-Up (" + subsectionName + ")";
  } else if (phase.detailName) {
    phaseDisplayName = phase.detailName;
  } else if (phase.kind === "work" || phase.kind === "recovery") {
    phaseDisplayName = "Workout";
  }

  const hrTargetTextValue = isFreestyleWorkoutSelector(day)
    ? ""
    : formatResolvedHeartRateTarget(resolvedPhaseTarget);
  const assessmentBasedWorkload =
    isVo2WorkoutSelector(day) || isFreestyleWorkoutSelector(day)
      ? null
      : assessmentBasedWorkloadForPhase(
          session.phasePlan?.shadowPrescriptionEvaluation,
          phase.phaseId
        );
  const nowTime = Date.now();
  const liveBpmStale =
    lastBpmUpdateTime != null && nowTime - lastBpmUpdateTime > BPM_TIMEOUT_MS;

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
    activity: getActiveWorkoutActivity(workoutMetadata[day]?.activities, session.activity) ?? null,
    paused,
    hrTargetTextValue,
    assessmentBasedWorkload,
    resolvedPhaseTarget,
    liveBpm: liveBpm ?? null,
    liveBpmStale,
  };
}
