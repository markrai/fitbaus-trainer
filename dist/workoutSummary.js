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
import { flushOrdinaryBikeTelemetryWrites, getAllWorkoutSummaries, getHrSamples, getOrdinaryBikeTelemetrySamples, storeWorkoutSummary, } from "./workoutStorage.js";
import { formatISO8601UTC } from "./utils/dateTime.js";
import { getMachineUsageSnapshot } from "./machines/runtime.js";
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
import { assessVo2 } from "./vo2Estimator.js";
import { readExplicitVo2ProfileInputs } from "./profile.js";
import { getBikeTelemetrySamples } from "./bikeTelemetryTrace.js";
import { resolveWorkoutPrescription } from "./workoutPrescription.js";
import { promoteVo2SummaryToStoredFitnessState } from "./fitnessState.js";
import { generateUUID } from "./utils/uuid.js";
import { deriveWorkoutResponse } from "./workoutResponse.js";
import { characterizePersonalizedPrescription, PHASE_E2_CHARACTERIZATION_POLICY_V1, PHASE_E2_HELD_WORKLOAD_POLICY_V1, } from "./personalizedPrescriptionCharacterization.js";
import { rebuildStoredPassiveFitnessProjection } from "./fitnessRefinement.js";
import { finalizeExecutionProvenance } from "./executionProvenance.js";
import { recordPromotedCalibrationMachineProvenance } from "./calibrationMachineProvenance.js";
import { readFitnessState } from "./fitnessState.js";
import { APP_VERSION } from "./version.js";
import { countValidHrSampleSeconds, isFreestyleWorkoutSelector, } from "./freestyleRide.js";
import { deriveFreestyleRideResponse } from "./freestyleRideResponse.js";
import { deriveFreestyleStableObservation } from "./freestyleStableObservation.js";
export function buildHrTrace(hrSamples) {
    if (!hrSamples || hrSamples.length === 0) {
        return { sampling_interval_seconds: 60, samples: [] };
    }
    const sorted = [...hrSamples].sort((a, b) => a.timestamp_sec - b.timestamp_sec);
    const downsampled = [];
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
export function determineStressProfile(primaryZone) {
    if (primaryZone <= 0)
        return "unknown";
    if (primaryZone === 1 || primaryZone === 2)
        return "low";
    if (primaryZone === 3)
        return "moderate";
    return "high";
}
export function determinePrimaryZoneHonest(zoneMinutes) {
    let max = 0;
    let primary = 0;
    ["z5", "z4", "z3", "z2", "z1"].forEach((key) => {
        const val = zoneMinutes[key];
        if (val > max) {
            max = val;
            primary = parseInt(key.slice(1), 10);
        }
    });
    return max === 0 ? 0 : primary;
}
export function applyMachineUsageToSummary(summary, machineUsage) {
    if (!machineUsage)
        return summary;
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
export function applyFrozenMachineUsageToSummary(summary, provenance, machineUsage) {
    const machine = provenance && provenance.sessionId === summary.external_session_id ? provenance.machine : null;
    if (!machine || machine.status !== "selected")
        return summary;
    summary.machine_id = machine.machineId;
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
function selectionChangedSinceStart(machine, machineUsage) {
    if (!machineUsage)
        return false;
    if (machineUsage.machineSelectionChanged)
        return true;
    return machine.status !== "selected" || machineUsage.machineId !== machine.machineId ||
        machineUsage.profileVersion !== machine.machineProfileVersion;
}
export function applyWorkoutActivityToSummary(summary, activity) {
    if (!activity)
        return summary;
    summary.activity = activity;
    return summary;
}
function validateSummary(summary) {
    var _a, _b;
    const errors = [];
    const freestyleHonest = isFreestyleWorkoutSelector(summary.day) || summary.open_ended_timing != null;
    const totalSeconds = Math.floor((new Date(summary.endedAt).getTime() - new Date(summary.startedAt).getTime()) / 1000);
    const expectedDuration = freestyleHonest
        ? Math.max(0, Math.round(((_b = (_a = summary.open_ended_timing) === null || _a === void 0 ? void 0 : _a.active_sec) !== null && _b !== void 0 ? _b : 0) / 60))
        : Math.round(totalSeconds / 60);
    if (summary.duration_minutes !== expectedDuration) {
        errors.push(`duration_minutes mismatch: expected ${expectedDuration}, got ${summary.duration_minutes}`);
    }
    const zoneSum = summary.zone_minutes.z1 +
        summary.zone_minutes.z2 +
        summary.zone_minutes.z3 +
        summary.zone_minutes.z4 +
        summary.zone_minutes.z5;
    if (!freestyleHonest && zoneSum !== summary.duration_minutes) {
        errors.push(`zone_minutes sum (${zoneSum}) does not equal duration_minutes (${summary.duration_minutes})`);
    }
    if (freestyleHonest) {
        if (summary.primary_zone < 0 || summary.primary_zone > 5) {
            errors.push(`primary_zone ${summary.primary_zone} is out of range for open-ended timing`);
        }
        if (summary.primary_zone > 0) {
            const primaryZoneKey = `z${summary.primary_zone}`;
            if (summary.zone_minutes[primaryZoneKey] <= 0) {
                errors.push(`primary_zone ${summary.primary_zone} has zero or negative minutes in zone_minutes`);
            }
        }
        else if (zoneSum > 0) {
            errors.push("primary_zone 0 is incompatible with non-zero observed zone minutes");
        }
        if (summary.evidence_incomplete != null && summary.evidence_incomplete !== true) {
            errors.push("evidence_incomplete must be true when present");
        }
    }
    else {
        if (summary.evidence_incomplete === true) {
            errors.push("evidence_incomplete is only valid for Freestyle open-ended summaries");
        }
        const primaryZoneKey = `z${summary.primary_zone}`;
        if (summary.zone_minutes[primaryZoneKey] <= 0) {
            errors.push(`primary_zone ${summary.primary_zone} has zero or negative minutes in zone_minutes`);
        }
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
    }
    catch (e) {
        errors.push(`Invalid JSON: ${e.message}`);
    }
    if (errors.length > 0)
        console.error("Workout summary validation errors:", errors);
}
async function generateWorkoutSummary(sessionId, startedAt, endedAt, day, options) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
    const freestyleFinalization = options === null || options === void 0 ? void 0 : options.freestyleFinalization;
    const isFreestyle = isFreestyleWorkoutSelector(day) || freestyleFinalization != null;
    const effectiveEndedAt = (_a = freestyleFinalization === null || freestyleFinalization === void 0 ? void 0 : freestyleFinalization.endedAtMs) !== null && _a !== void 0 ? _a : endedAt;
    const effectiveStartedAt = (_b = freestyleFinalization === null || freestyleFinalization === void 0 ? void 0 : freestyleFinalization.startedAtMs) !== null && _b !== void 0 ? _b : startedAt;
    if (!Number.isFinite(effectiveStartedAt) ||
        !Number.isFinite(effectiveEndedAt) ||
        effectiveEndedAt <= effectiveStartedAt) {
        throw new Error(`Invalid workout timestamps. Started: ${effectiveStartedAt}, Ended: ${effectiveEndedAt}`);
    }
    const durationMs = effectiveEndedAt - effectiveStartedAt;
    const durationMinutesCheck = Math.round(durationMs / (1000 * 60));
    const MAX_DURATION_MINUTES = 1440;
    const MAX_FREESTYLE_ACTIVE_DURATION_SEC = MAX_DURATION_MINUTES * 60;
    const session = getSession(day);
    const activeDurationSec = freestyleFinalization
        ? freestyleFinalization.activeDurationSec
        : actualElapsedSeconds(session.startTime, session.paused, session.pausedElapsed, effectiveEndedAt);
    const pausedDurationSec = freestyleFinalization
        ? freestyleFinalization.pausedDurationSec
        : totalPausedDurationSec(session, effectiveEndedAt);
    const wallClockSec = Math.max(0, Math.floor((effectiveEndedAt - effectiveStartedAt) / 1000));
    if (isFreestyle) {
        if (!Number.isFinite(activeDurationSec) ||
            activeDurationSec < 0 ||
            !Number.isFinite(pausedDurationSec) ||
            pausedDurationSec < 0 ||
            activeDurationSec > wallClockSec + 1 ||
            activeDurationSec + pausedDurationSec > wallClockSec + 2) {
            throw new Error(`Inconsistent Freestyle timing. active=${activeDurationSec}, paused=${pausedDurationSec}, wall=${wallClockSec}`);
        }
        if (activeDurationSec > MAX_FREESTYLE_ACTIVE_DURATION_SEC) {
            throw new Error(`Freestyle active duration ${activeDurationSec} seconds exceeds maximum of ${MAX_FREESTYLE_ACTIVE_DURATION_SEC} seconds.`);
        }
    }
    else if (durationMinutesCheck > MAX_DURATION_MINUTES) {
        throw new Error(`Workout duration ${durationMinutesCheck} minutes exceeds maximum of ${MAX_DURATION_MINUTES} minutes. This likely indicates a stale workout session. Started: ${new Date(effectiveStartedAt).toISOString()}, Ended: ${new Date(effectiveEndedAt).toISOString()}`);
    }
    const hrSamples = await getHrSamples(sessionId);
    const zoneMinutes = calculateZoneMinutes(hrSamples);
    const primaryZone = isFreestyle
        ? determinePrimaryZoneHonest(zoneMinutes)
        : determinePrimaryZone(zoneMinutes);
    const stressProfile = determineStressProfile(primaryZone);
    const hrTrace = buildHrTrace(hrSamples);
    const durationMinutes = isFreestyle
        ? Math.max(0, Math.round(activeDurationSec / 60))
        : Math.round(wallClockSec / 60);
    let intent = "unknown";
    if (typeof window.getWorkoutMetadata === "function") {
        const metadata = window.getWorkoutMetadata();
        if (metadata && metadata[day]) {
            intent = metadata[day].intent || metadata[day].type || "unknown";
        }
    }
    const summary = {
        external_session_id: sessionId,
        app_version: APP_VERSION,
        startedAt: formatISO8601UTC(effectiveStartedAt),
        endedAt: formatISO8601UTC(effectiveEndedAt),
        category: "cardio",
        intent,
        duration_minutes: durationMinutes,
        primary_zone: primaryZone,
        stress_profile: stressProfile,
        zone_minutes: zoneMinutes,
        hr_trace: hrTrace,
        day,
        cancelled: options === null || options === void 0 ? void 0 : options.cancelled,
    };
    if (isFreestyle) {
        const validHrSec = countValidHrSampleSeconds(hrSamples);
        const unknownHrSec = Math.max(0, activeDurationSec - validHrSec);
        summary.open_ended_timing = {
            wall_clock_sec: wallClockSec,
            active_sec: activeDurationSec,
            paused_sec: pausedDurationSec,
            valid_hr_sec: validHrSec,
            unknown_hr_sec: unknownHrSec,
        };
        if ((freestyleFinalization === null || freestyleFinalization === void 0 ? void 0 : freestyleFinalization.evidenceIncomplete) === true) {
            summary.evidence_incomplete = true;
        }
    }
    const machineUsage = getMachineUsageSnapshot(sessionId);
    applyFrozenMachineUsageToSummary(summary, session.executionProvenance, machineUsage);
    if (session.athleteId)
        summary.athlete_id = session.athleteId;
    if (session.athleteFitnessSnapshot) {
        summary.athlete_fitness_snapshot = { ...session.athleteFitnessSnapshot };
    }
    const allowed = (_d = (_c = getWorkoutMetadata()[day]) === null || _c === void 0 ? void 0 : _c.activities) !== null && _d !== void 0 ? _d : [];
    applyWorkoutActivityToSummary(summary, getActiveWorkoutActivity(allowed, session.activity));
    const base = getPlan()[day];
    const liveBlocks = base ? adjustedBlockLengths(base, null) : null;
    const phasePlan = session.phasePlan;
    const blocks = isFreestyle ? null : (_e = phasePlan === null || phasePlan === void 0 ? void 0 : phasePlan.blocks) !== null && _e !== void 0 ? _e : liveBlocks;
    const rawPrescriptionTime = Number((_g = (_f = session.sessionStart) !== null && _f !== void 0 ? _f : session.startTime) !== null && _g !== void 0 ? _g : effectiveStartedAt);
    const resolvedPrescription = !isFreestyle && blocks
        ? (_h = phasePlan === null || phasePlan === void 0 ? void 0 : phasePlan.resolvedPrescription) !== null && _h !== void 0 ? _h : resolveWorkoutPrescription({
            workoutSelector: day,
            blocks,
            hrTargets: phasePlan ? phasePlan.hrTargets : (_j = getHrTargets()[day]) !== null && _j !== void 0 ? _j : null,
            resolvedAt: Number.isFinite(rawPrescriptionTime) && rawPrescriptionTime > 0
                ? new Date(rawPrescriptionTime).toISOString()
                : formatISO8601UTC(effectiveStartedAt),
        })
        : undefined;
    if (resolvedPrescription)
        summary.resolved_prescription = resolvedPrescription;
    if (!isFreestyle && (phasePlan === null || phasePlan === void 0 ? void 0 : phasePlan.shadowPrescriptionEvaluation)) {
        summary.shadow_prescription_evaluation = phasePlan.shadowPrescriptionEvaluation;
    }
    attachVo2Evidence(summary, buildVo2Evidence({
        day,
        activity: summary.activity,
        intent: summary.intent,
        blocks: blocks !== null && blocks !== void 0 ? blocks : undefined,
        hrTargets: isFreestyle ? null : phasePlan ? phasePlan.hrTargets : (_k = getHrTargets()[day]) !== null && _k !== void 0 ? _k : null,
        resolvedPrescription,
        activeDurationSec,
        pausedDurationSec,
        earlyCooldownElapsed: isFreestyle ? null : session.earlyCooldownElapsed,
        cancelled: options === null || options === void 0 ? void 0 : options.cancelled,
        hrSamples,
        machineId: summary.machine_id,
        machineProfileVersion: summary.machine_profile_version,
        machineGuidanceTraceEntryCount: (_l = summary.machine_guidance_trace) === null || _l === void 0 ? void 0 : _l.length,
        vo2Protocol: isFreestyle ? null : session.vo2ProtocolRuntime,
        protocol: !isFreestyle && session.vo2ProtocolRuntime
            ? buildVo2ProtocolEvidenceForRuntime(session.vo2ProtocolRuntime, session.sessionId || sessionId ? getBikeTelemetrySamples(session.sessionId || sessionId) : [])
            : undefined,
    }));
    // Freestyle Level-A analytics: derive after open_ended_timing, before structured response
    if (isFreestyle && session.athleteId && session.activity === "bike") {
        try {
            await flushOrdinaryBikeTelemetryWrites(sessionId);
            const bikeSamples = await getOrdinaryBikeTelemetrySamples(sessionId);
            const freestyleResponse = deriveFreestyleRideResponse({
                athleteId: session.athleteId,
                sessionId,
                startedAtMs: effectiveStartedAt,
                endedAtMs: effectiveEndedAt,
                activeDurationSec,
                pausedDurationSec,
                cancelled: (options === null || options === void 0 ? void 0 : options.cancelled) === true,
                evidenceIncomplete: (freestyleFinalization === null || freestyleFinalization === void 0 ? void 0 : freestyleFinalization.evidenceIncomplete) === true,
                hrSamples,
                bikeSamples,
            });
            if (freestyleResponse) {
                summary.freestyle_ride_response = freestyleResponse;
            }
            try {
                const stableObservation = deriveFreestyleStableObservation({
                    athleteId: session.athleteId,
                    sessionId,
                    startedAtMs: effectiveStartedAt,
                    endedAtMs: effectiveEndedAt,
                    activeDurationSec,
                    pausedDurationSec,
                    evidenceIncomplete: (freestyleFinalization === null || freestyleFinalization === void 0 ? void 0 : freestyleFinalization.evidenceIncomplete) === true,
                    hrSamples,
                    bikeSamples,
                });
                if (stableObservation) {
                    summary.freestyle_stable_observation = stableObservation;
                }
            }
            catch (error) {
                console.error("Error deriving freestyle stable observation:", error);
            }
        }
        catch (error) {
            console.error("Error deriving freestyle ride response:", error);
        }
    }
    if (isVo2WorkoutSelector(day)) {
        const profile = (_p = (_m = options === null || options === void 0 ? void 0 : options.vo2Profile) !== null && _m !== void 0 ? _m : (_o = session.vo2ProtocolRuntime) === null || _o === void 0 ? void 0 : _o.assessment_profile) !== null && _p !== void 0 ? _p : readExplicitVo2ProfileInputs();
        summary.vo2_assessment = assessVo2(summary.vo2_evidence, profile);
    }
    else if (!isFreestyle &&
        session.activity === "bike" &&
        session.athleteId &&
        (phasePlan === null || phasePlan === void 0 ? void 0 : phasePlan.resolvedPrescription)) {
        try {
            await flushOrdinaryBikeTelemetryWrites(sessionId);
            const bikeSamples = await getOrdinaryBikeTelemetrySamples(sessionId);
            const response = deriveWorkoutResponse({
                athleteId: session.athleteId,
                sessionId,
                blocks: phasePlan.blocks,
                resolvedPrescription: phasePlan.resolvedPrescription,
                completedActiveSec: activeDurationSec,
                cancelled: (options === null || options === void 0 ? void 0 : options.cancelled) === true,
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
        }
        catch (error) {
            console.error("Error deriving ordinary workout response:", error);
        }
    }
    if (session.executionProvenance && session.executionProvenance.sessionId === sessionId) {
        const finalized = finalizeExecutionProvenance(session.executionProvenance, {
            selectionChangedDuringWorkout: selectionChangedSinceStart(session.executionProvenance.machine, machineUsage),
            phases: (_q = summary.workout_response) === null || _q === void 0 ? void 0 : _q.phases.map((phase) => ({
                phaseId: phase.phaseId,
                kind: phase.kind,
                ...(phase.intervalIndex !== undefined ? { intervalIndex: phase.intervalIndex } : {}),
                activeStartSec: phase.activeStartSec,
                activeEndSec: phase.activeEndSec,
            })),
        });
        if (finalized)
            summary.execution_provenance = finalized;
    }
    validateSummary(summary);
    if (!isFreestyle) {
        const zoneSum = summary.zone_minutes.z1 +
            summary.zone_minutes.z2 +
            summary.zone_minutes.z3 +
            summary.zone_minutes.z4 +
            summary.zone_minutes.z5;
        if (zoneSum !== summary.duration_minutes) {
            const diff = summary.duration_minutes - zoneSum;
            const primaryZoneKey = `z${summary.primary_zone}`;
            summary.zone_minutes[primaryZoneKey] = Math.max(0, summary.zone_minutes[primaryZoneKey] + diff);
        }
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
export function recordPromotedFormalCalibrationMachine(summary, storage, recordedAt = new Date().toISOString()) {
    var _a;
    const store = storage !== null && storage !== void 0 ? storage : localStorage;
    const provenance = summary.execution_provenance;
    const machine = provenance && provenance.sessionId === summary.external_session_id &&
        provenance.machine.status === "selected" && !provenance.machine.selectionChangedDuringWorkout
        ? { machineId: provenance.machine.machineId, machineProfileVersion: provenance.machine.machineProfileVersion }
        : null;
    const athleteId = summary.athlete_id;
    if (typeof athleteId !== "string" || !athleteId)
        return "not_applicable";
    return recordPromotedCalibrationMachineProvenance({
        athleteId,
        sessionId: summary.external_session_id,
        endedAt: summary.endedAt,
        machine,
        // readFitnessState returns state only when it belongs to this exact athlete.
        calibrationMetric: (_a = readFitnessState(athleteId, store)) === null || _a === void 0 ? void 0 : _a.hrWorkloadCalibration,
    }, store, recordedAt);
}
function isFreestyleSummary(summary) {
    return (isFreestyleWorkoutSelector(summary.day) ||
        summary.intent === "freestyle" ||
        summary.open_ended_timing != null);
}
async function emitWorkoutSummary(summary) {
    var _a, _b;
    const saved = await storeWorkoutSummary(summary);
    if (saved && summary.vo2_assessment) {
        try {
            const promotion = promoteVo2SummaryToStoredFitnessState(summary);
            if (promotion === "promoted") {
                recordPromotedFormalCalibrationMachine(summary);
            }
            else {
                const assessment = summary.vo2_assessment;
                const inputSnapshot = assessment.input_snapshot && typeof assessment.input_snapshot === "object"
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
                        id: (_a = inputSnapshot === null || inputSnapshot === void 0 ? void 0 : inputSnapshot.protocol_id) !== null && _a !== void 0 ? _a : null,
                        version: (_b = inputSnapshot === null || inputSnapshot === void 0 ? void 0 : inputSnapshot.protocol_version) !== null && _b !== void 0 ? _b : null,
                    },
                };
                if (promotion === "not_eligible") {
                    console.warn("VO2 workout summary was saved, but formal FitnessState promotion was not eligible.", diagnostic);
                }
                else {
                    console.error("VO2 workout summary was saved, but formal FitnessState promotion could not be persisted.", diagnostic);
                }
            }
        }
        catch (error) {
            console.error("Error promoting VO2 assessment to fitness state:", error);
        }
    }
    if (saved && !isFreestyleSummary(summary)) {
        try {
            const history = await getAllWorkoutSummaries();
            rebuildStoredPassiveFitnessProjection(history.map((row) => row.summary));
        }
        catch (error) {
            console.error("Error rebuilding passive fitness projection:", error);
        }
    }
    if (!isFreestyleSummary(summary)) {
        await learnFromCompletedWorkout(summary);
        await learnShadowPredictionsFromCompletedWorkout(summary);
        await learnHrDynamicsFromCompletedWorkout(summary);
    }
    return saved;
}
async function emitWorkoutSummaryConfirmed(summary) {
    return emitWorkoutSummary(summary);
}
export function registerSummaryGlobals() {
    window.generateUUID = generateUUID;
    window.generateWorkoutSummary = generateWorkoutSummary;
    window.emitWorkoutSummary = emitWorkoutSummary;
    window.emitWorkoutSummaryConfirmed = emitWorkoutSummaryConfirmed;
}
export { generateUUID, generateWorkoutSummary, emitWorkoutSummary, emitWorkoutSummaryConfirmed, };
