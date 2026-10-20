/**
 * Workout summary construction and emit orchestration. Sequences identity,
 * optional personalization artifacts (E1 copy / Response / E2), VO₂ assessment
 * attach, then summary persistence. On successful save only: VO₂ FitnessState
 * promotion and Phase D rebuild. Machine-model learning runs afterward and is
 * currently not gated by successful summary persistence. Scientific policy
 * remains in subsystem modules — this file is the finalization boundary, not
 * the science owner. See docs/personalization-architecture.md.
 */

import { calculateZoneMinutes, determinePrimaryZone } from "./zoneCalculator.js";
import {
  flushOrdinaryBikeTelemetryWrites,
  getAllWorkoutSummaries,
  getHrSamples,
  getOrdinaryBikeTelemetrySamples,
  storeWorkoutSummary,
} from "./workoutStorage.js";
import { formatISO8601UTC } from "./utils/dateTime.js";
import { Activity, WorkoutSummary, type WorkoutExecutionProvenanceV1 } from "./types.js";
import type { MachineId } from "./machines/types.js";
import { getMachineUsageSnapshot, type MachineUsageSnapshot } from "./machines/runtime.js";
import { getSession, totalPausedDurationSec } from "./sessionStore.js";
import { getPlan, getWorkoutMetadata, getHrTargets } from "./workoutData.js";
import { getActiveWorkoutActivity } from "./workoutActivity.js";
import { learnFromCompletedWorkout } from "./machines/learning/index.js";
import { learnShadowPredictionsFromCompletedWorkout } from "./machines/prediction/index.js";
import { learnHrDynamicsFromCompletedWorkout } from "./machines/dynamics/index.js";
import { actualElapsedSeconds, adjustedBlockLengths } from "./workoutLogic.js";
import { attachVo2Evidence, buildVo2Evidence } from "./vo2Evidence.js";
import { isVo2WorkoutSelector } from "./vo2Protocol.js";
import { buildVo2ProtocolEvidenceForRuntime } from "./vo2ProtocolV3.js";
import { assessVo2, type Vo2ProfileInputs } from "./vo2Estimator.js";
import { readExplicitVo2ProfileInputs } from "./profile.js";
import { getBikeTelemetrySamples } from "./bikeTelemetryTrace.js";
import { resolveWorkoutPrescription } from "./workoutPrescription.js";
import { promoteVo2SummaryToStoredFitnessState } from "./fitnessState.js";
import { generateUUID } from "./utils/uuid.js";
import { deriveWorkoutResponse } from "./workoutResponse.js";
import {
  characterizePersonalizedPrescription,
  PHASE_E2_CHARACTERIZATION_POLICY_V1,
  PHASE_E2_HELD_WORKLOAD_POLICY_V1,
} from "./personalizedPrescriptionCharacterization.js";
import { rebuildStoredPassiveFitnessProjection } from "./fitnessRefinement.js";
import { finalizeExecutionProvenance } from "./executionProvenance.js";
import { recordPromotedCalibrationMachineProvenance } from "./calibrationMachineProvenance.js";
import { readFitnessState } from "./fitnessState.js";
import { APP_VERSION } from "./version.js";

export function buildHrTrace(hrSamples: any[]) {
  if (!hrSamples || hrSamples.length === 0) {
    return { sampling_interval_seconds: 60, samples: [] };
  }
  const sorted = [...hrSamples].sort((a, b) => a.timestamp_sec - b.timestamp_sec);
  const downsampled: Array<{ t: number; hr: number }> = [];
  const interval = 60;

  for (let t = 0; t <= sorted[sorted.length - 1].timestamp_sec; t += interval) {
    let closestSample = null;
    let minDiff = Infinity;
    for (const sample of sorted) {
      const diff = Math.abs(sample.timestamp_sec - t);
      if (diff < minDiff) {
        minDiff = diff;
        closestSample = sample;
      }
    }
    if (closestSample && closestSample.hr && closestSample.hr > 0) {
      downsampled.push({ t, hr: closestSample.hr });
    }
  }
  return { sampling_interval_seconds: 60, samples: downsampled };
}

export function determineStressProfile(primaryZone: number): "low" | "moderate" | "high" {
  if (primaryZone === 1 || primaryZone === 2) return "low";
  if (primaryZone === 3) return "moderate";
  return "high";
}

export function applyMachineUsageToSummary(
  summary: WorkoutSummary,
  machineUsage: MachineUsageSnapshot | null
): WorkoutSummary {
  if (!machineUsage) return summary;
  summary.machine_id = machineUsage.machineId;
  summary.machine_profile_version = machineUsage.profileVersion;
  summary.machine_guidance_trace = machineUsage.guidanceTrace;
  if (machineUsage.decisionAudit && machineUsage.decisionAudit.length > 0) {
    summary.machine_decision_audit = machineUsage.decisionAudit;
  }
  return summary;
}

/**
 * Summary machine identity comes only from the identity frozen at workout start.
 * Runtime guidance trace/audit are attached only when they belong to that same
 * machine and the selection never changed mid-workout; a legacy session without
 * a start snapshot gets no machine identity rather than today's selection.
 */
export function applyFrozenMachineUsageToSummary(
  summary: WorkoutSummary,
  provenance: WorkoutExecutionProvenanceV1 | null,
  machineUsage: MachineUsageSnapshot | null
): WorkoutSummary {
  const machine = provenance && provenance.sessionId === summary.external_session_id ? provenance.machine : null;
  if (!machine || machine.status !== "selected") return summary;
  summary.machine_id = machine.machineId as MachineId;
  summary.machine_profile_version = machine.machineProfileVersion;
  if (machineUsage && !machineUsage.machineSelectionChanged && machineUsage.machineId === machine.machineId &&
      machineUsage.profileVersion === machine.machineProfileVersion) {
    summary.machine_guidance_trace = machineUsage.guidanceTrace;
    if (machineUsage.decisionAudit && machineUsage.decisionAudit.length > 0) {
      summary.machine_decision_audit = machineUsage.decisionAudit;
    }
  }
  return summary;
}

function selectionChangedSinceStart(
  machine: WorkoutExecutionProvenanceV1["machine"],
  machineUsage: MachineUsageSnapshot | null
): boolean {
  if (!machineUsage) return false;
  if (machineUsage.machineSelectionChanged) return true;
  return machine.status !== "selected" || machineUsage.machineId !== machine.machineId ||
    machineUsage.profileVersion !== machine.machineProfileVersion;
}

export function applyWorkoutActivityToSummary(
  summary: WorkoutSummary,
  activity: Activity | undefined
): WorkoutSummary {
  if (!activity) return summary;
  summary.activity = activity;
  return summary;
}

function validateSummary(summary: WorkoutSummary) {
  const errors: string[] = [];
  const totalSeconds = Math.floor((new Date(summary.endedAt).getTime() - new Date(summary.startedAt).getTime()) / 1000);
  const expectedDuration = Math.round(totalSeconds / 60);
  if (summary.duration_minutes !== expectedDuration) {
    errors.push(`duration_minutes mismatch: expected ${expectedDuration}, got ${summary.duration_minutes}`);
  }
  const zoneSum =
    summary.zone_minutes.z1 +
    summary.zone_minutes.z2 +
    summary.zone_minutes.z3 +
    summary.zone_minutes.z4 +
    summary.zone_minutes.z5;
  if (zoneSum !== summary.duration_minutes) {
    errors.push(`zone_minutes sum (${zoneSum}) does not equal duration_minutes (${summary.duration_minutes})`);
  }
  const primaryZoneKey = `z${summary.primary_zone}` as keyof typeof summary.zone_minutes;
  if (summary.zone_minutes[primaryZoneKey] <= 0) {
    errors.push(`primary_zone ${summary.primary_zone} has zero or negative minutes in zone_minutes`);
  }
  if (new Date(summary.startedAt) >= new Date(summary.endedAt)) {
    errors.push(`startedAt (${summary.startedAt}) must be before endedAt (${summary.endedAt})`);
  }
  const MAX_DURATION_MINUTES = 1440;
  if (summary.duration_minutes > MAX_DURATION_MINUTES) {
    errors.push(`Duration ${summary.duration_minutes} exceeds maximum ${MAX_DURATION_MINUTES} minutes`);
  }
  try {
    JSON.stringify(summary);
  } catch (e: any) {
    errors.push(`Invalid JSON: ${e.message}`);
  }
  if (errors.length > 0) console.error("Workout summary validation errors:", errors);
}

async function generateWorkoutSummary(
  sessionId: string,
  startedAt: number,
  endedAt: number,
  day: string,
  options?: { cancelled?: boolean; vo2Profile?: Vo2ProfileInputs }
): Promise<WorkoutSummary> {
  const durationMs = endedAt - startedAt;
  const durationMinutesCheck = Math.round(durationMs / (1000 * 60));
  const MAX_DURATION_MINUTES = 1440;
  if (durationMinutesCheck > MAX_DURATION_MINUTES) {
    throw new Error(
      `Workout duration ${durationMinutesCheck} minutes exceeds maximum of ${MAX_DURATION_MINUTES} minutes. This likely indicates a stale workout session. Started: ${new Date(
        startedAt
      ).toISOString()}, Ended: ${new Date(endedAt).toISOString()}`
    );
  }

  const hrSamples = await getHrSamples(sessionId);
  const zoneMinutes = calculateZoneMinutes(hrSamples);
  const primaryZone = determinePrimaryZone(zoneMinutes);
  const stressProfile = determineStressProfile(primaryZone);
  const hrTrace = buildHrTrace(hrSamples);

  const totalSeconds = Math.floor((endedAt - startedAt) / 1000);
  const durationMinutes = Math.round(totalSeconds / 60);

  let intent = "unknown";
  if (typeof (window as any).getWorkoutMetadata === "function") {
    const metadata = (window as any).getWorkoutMetadata();
    if (metadata && metadata[day]) {
      intent = metadata[day].intent || metadata[day].type || "unknown";
    }
  }

  const summary: WorkoutSummary = {
    external_session_id: sessionId,
    app_version: APP_VERSION,
    startedAt: formatISO8601UTC(startedAt),
    endedAt: formatISO8601UTC(endedAt),
    category: "cardio",
    intent,
    duration_minutes: durationMinutes,
    primary_zone: primaryZone,
    stress_profile: stressProfile,
    zone_minutes: zoneMinutes,
    hr_trace: hrTrace,
    day,
    cancelled: options?.cancelled,
  };

  const session = getSession(day);
  const machineUsage = getMachineUsageSnapshot(sessionId);
  applyFrozenMachineUsageToSummary(summary, session.executionProvenance, machineUsage);
  if (session.athleteId) summary.athlete_id = session.athleteId;
  if (session.athleteFitnessSnapshot) {
    summary.athlete_fitness_snapshot = { ...session.athleteFitnessSnapshot };
  }
  const allowed = getWorkoutMetadata()[day]?.activities ?? [];
  applyWorkoutActivityToSummary(summary, getActiveWorkoutActivity(allowed, session.activity));

  const base = getPlan()[day];
  const liveBlocks = base ? adjustedBlockLengths(base, null) : null;
  const phasePlan = session.phasePlan;
  const blocks = phasePlan?.blocks ?? liveBlocks;
  const rawPrescriptionTime = Number(session.sessionStart ?? session.startTime ?? startedAt);
  const resolvedPrescription = blocks
    ? phasePlan?.resolvedPrescription ?? resolveWorkoutPrescription({
        workoutSelector: day,
        blocks,
        hrTargets: phasePlan ? phasePlan.hrTargets : getHrTargets()[day] ?? null,
        resolvedAt: Number.isFinite(rawPrescriptionTime) && rawPrescriptionTime > 0
          ? new Date(rawPrescriptionTime).toISOString()
          : formatISO8601UTC(startedAt),
      })
    : undefined;
  if (resolvedPrescription) summary.resolved_prescription = resolvedPrescription;
  if (phasePlan?.shadowPrescriptionEvaluation) {
    // Copy the workout-start record exactly; never re-read current athlete evidence here.
    summary.shadow_prescription_evaluation = phasePlan.shadowPrescriptionEvaluation;
  }
  const activeDurationSec = actualElapsedSeconds(
    session.startTime,
    session.paused,
    session.pausedElapsed,
    endedAt
  );
  attachVo2Evidence(
    summary,
    buildVo2Evidence({
      day,
      activity: summary.activity,
      intent: summary.intent,
      blocks,
      hrTargets: phasePlan ? phasePlan.hrTargets : getHrTargets()[day] ?? null,
      resolvedPrescription,
      activeDurationSec,
      pausedDurationSec: totalPausedDurationSec(session, endedAt),
      earlyCooldownElapsed: session.earlyCooldownElapsed,
      cancelled: options?.cancelled,
      hrSamples,
      machineId: summary.machine_id,
      machineProfileVersion: summary.machine_profile_version,
      machineGuidanceTraceEntryCount: summary.machine_guidance_trace?.length,
      vo2Protocol: session.vo2ProtocolRuntime,
      protocol: session.vo2ProtocolRuntime
        ? buildVo2ProtocolEvidenceForRuntime(
            session.vo2ProtocolRuntime,
            session.sessionId || sessionId ? getBikeTelemetrySamples(session.sessionId || sessionId) : []
          )
        : undefined,
    })
  );

  if (isVo2WorkoutSelector(day)) {
    const profile = options?.vo2Profile ?? session.vo2ProtocolRuntime?.assessment_profile ?? readExplicitVo2ProfileInputs();
    summary.vo2_assessment = assessVo2(summary.vo2_evidence, profile);
  } else if (
    session.activity === "bike" &&
    session.athleteId &&
    phasePlan?.resolvedPrescription
  ) {
    try {
      await flushOrdinaryBikeTelemetryWrites(sessionId);
      const bikeSamples = await getOrdinaryBikeTelemetrySamples(sessionId);
      const response = deriveWorkoutResponse({
        athleteId: session.athleteId,
        sessionId,
        blocks: phasePlan.blocks,
        resolvedPrescription: phasePlan.resolvedPrescription,
        completedActiveSec: activeDurationSec,
        cancelled: options?.cancelled === true,
        earlyCooldownElapsed: session.earlyCooldownElapsed,
        hrSamples,
        bikeSamples,
      });
      if (response) {
        summary.workout_response = response;
        if (summary.shadow_prescription_evaluation) {
          const characterization = characterizePersonalizedPrescription({
            summary,
            shadowEvaluation: summary.shadow_prescription_evaluation,
            workoutResponse: response,
            hrSamples,
            bikeSamples,
            machineDecisionAudit: summary.machine_decision_audit,
            policy: PHASE_E2_CHARACTERIZATION_POLICY_V1,
            heldWorkloadPolicy: PHASE_E2_HELD_WORKLOAD_POLICY_V1,
            createdAt: summary.endedAt,
          });
          if (characterization) {
            summary.shadow_prescription_characterization = characterization;
          }
        }
      }
    } catch (error) {
      console.error("Error deriving ordinary workout response:", error);
    }
  }

  if (session.executionProvenance && session.executionProvenance.sessionId === sessionId) {
    const finalized = finalizeExecutionProvenance(session.executionProvenance, {
      selectionChangedDuringWorkout: selectionChangedSinceStart(session.executionProvenance.machine, machineUsage),
      phases: summary.workout_response?.phases.map((phase) => ({
        phaseId: phase.phaseId,
        kind: phase.kind,
        ...(phase.intervalIndex !== undefined ? { intervalIndex: phase.intervalIndex } : {}),
        activeStartSec: phase.activeStartSec,
        activeEndSec: phase.activeEndSec,
      })),
    });
    if (finalized) summary.execution_provenance = finalized;
  }

  validateSummary(summary);
  const zoneSum =
    summary.zone_minutes.z1 +
    summary.zone_minutes.z2 +
    summary.zone_minutes.z3 +
    summary.zone_minutes.z4 +
    summary.zone_minutes.z5;
  if (zoneSum !== summary.duration_minutes) {
    const diff = summary.duration_minutes - zoneSum;
    const primaryZoneKey = `z${summary.primary_zone}` as keyof typeof summary.zone_minutes;
    summary.zone_minutes[primaryZoneKey] = Math.max(0, summary.zone_minutes[primaryZoneKey] + diff);
  }

  return summary;
}

/**
 * Sidecar machine provenance for a just-promoted formal calibration. Uses the
 * machine frozen at assessment start only; an ambiguous identity (no machine at
 * start, or selection changed mid-assessment) records nothing. The athlete is the
 * summary's own frozen `athlete_id` (the identity promotion verified), never the
 * currently loaded profile; without it nothing is recorded.
 */
export function recordPromotedFormalCalibrationMachine(
  summary: WorkoutSummary,
  storage?: Storage,
  recordedAt = new Date().toISOString()
): ReturnType<typeof recordPromotedCalibrationMachineProvenance> {
  const store = storage ?? localStorage;
  const provenance = summary.execution_provenance;
  const machine = provenance && provenance.sessionId === summary.external_session_id &&
    provenance.machine.status === "selected" && !provenance.machine.selectionChangedDuringWorkout
    ? { machineId: provenance.machine.machineId, machineProfileVersion: provenance.machine.machineProfileVersion }
    : null;
  const athleteId = summary.athlete_id;
  if (typeof athleteId !== "string" || !athleteId) return "not_applicable";
  return recordPromotedCalibrationMachineProvenance({
    athleteId,
    sessionId: summary.external_session_id,
    endedAt: summary.endedAt,
    machine,
    // readFitnessState returns state only when it belongs to this exact athlete.
    calibrationMetric: readFitnessState(athleteId, store)?.hrWorkloadCalibration,
  }, store, recordedAt);
}

async function emitWorkoutSummary(summary: WorkoutSummary) {
  const saved = await storeWorkoutSummary(summary);
  if (saved && summary.vo2_assessment) {
    try {
      const promotion = promoteVo2SummaryToStoredFitnessState(summary);
      if (promotion === "promoted") {
        recordPromotedFormalCalibrationMachine(summary);
      } else {
        const assessment = summary.vo2_assessment;
        const inputSnapshot =
          assessment.input_snapshot && typeof assessment.input_snapshot === "object"
            ? assessment.input_snapshot
            : null;
        const diagnostic = {
          external_session_id: summary.external_session_id,
          promotion_result: promotion,
          assessment_estimator: {
            id: assessment.estimator_id,
            version: assessment.estimator_version,
          },
          assessment_protocol: {
            id: inputSnapshot?.protocol_id ?? null,
            version: inputSnapshot?.protocol_version ?? null,
          },
        };
        if (promotion === "not_eligible") {
          console.warn(
            "VO2 workout summary was saved, but formal FitnessState promotion was not eligible.",
            diagnostic
          );
        } else {
          console.error(
            "VO2 workout summary was saved, but formal FitnessState promotion could not be persisted.",
            diagnostic
          );
        }
      }
    } catch (error) {
      console.error("Error promoting VO2 assessment to fitness state:", error);
    }
  }
  if (saved) {
    try {
      const history = await getAllWorkoutSummaries();
      rebuildStoredPassiveFitnessProjection(history.map((row) => row.summary));
    } catch (error) {
      console.error("Error rebuilding passive fitness projection:", error);
    }
  }
  await learnFromCompletedWorkout(summary);
  await learnShadowPredictionsFromCompletedWorkout(summary);
  await learnHrDynamicsFromCompletedWorkout(summary);
}

export function registerSummaryGlobals() {
  (window as any).generateUUID = generateUUID;
  (window as any).generateWorkoutSummary = generateWorkoutSummary;
  (window as any).emitWorkoutSummary = emitWorkoutSummary;
}

export { generateUUID, generateWorkoutSummary, emitWorkoutSummary };
