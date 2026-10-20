/**
 * Phase D passive fitness refinement: multi-session descriptive fixed-HR-window
 * workload trend from ordinary workouts. Persists on FitnessState as
 * `passiveAerobicObservation` with `eligibleForPrescription: false`. Not formal
 * calibration, not an E1 input, and not machine-control authority. Admission
 * science stays here — do not reuse E1 shadowPrescription capability flags.
 * See docs/personalization-architecture.md.
 */
import { FITNESS_STATE_SCHEMA_VERSION_V3, } from "./types.js";
import { FITNESS_STATE_STORAGE_KEY, readFitnessState, storeFitnessState, } from "./fitnessState.js";
import { loadAthleteProfile } from "./profile.js";
import { parseWorkoutResponse } from "./workoutResponse.js";
export const FITNESS_REFINEMENT_ALGORITHM_V1 = {
    id: "fitness-refinement-v1",
    version: 1,
    minimumMeasuredSessions: 4,
    minimumCalibratedSessions: 5,
    minimumDistinctDates: 4,
    minimumPhaseDurationSec: 8 * 60,
    minimumSessionCompletionFraction: 0.8,
    minimumSessionHrCoverage: 0.75,
    minimumSessionFreshBikeCoverage: 0.75,
    minimumPhaseCompletionFraction: 0.9,
    minimumPhaseHrCoverage: 0.8,
    minimumMeasuredWattsCoverage: 0.8,
    minimumCalibratedWattsCoverage: 0.9,
    minimumCadenceCoverage: 0.75,
    comparableHrBandBpm: 10,
    recentWindowSessions: 4,
    declineCorroborationSessions: 3,
    declineThresholdFraction: 0.02,
    maximumImprovementFractionPerSession: 0.015,
    maximumDeclineFractionPerSession: 0.0075,
};
/**
 * Corrected writer. V1 remains a permanent historical identity only: its
 * 10-BPM cluster trended raw watts and was not truly HR-normalized.
 */
export const FITNESS_REFINEMENT_ALGORITHM_V2 = {
    id: "fitness-refinement-v2",
    version: 2,
    minimumMeasuredSessions: 4,
    minimumCalibratedSessions: 5,
    minimumDistinctDates: 4,
    minimumPlannedPhaseDurationSec: 8 * 60,
    minimumCompletedPhaseDurationSec: 8 * 60,
    minimumSessionCompletionFraction: 0.8,
    minimumSessionHrCoverage: 0.75,
    minimumSessionFreshBikeCoverage: 0.75,
    minimumPhaseCompletionFraction: 0.9,
    minimumPhaseHrCoverage: 0.8,
    minimumMeasuredWattsCoverage: 0.8,
    minimumCalibratedWattsCoverage: 0.9,
    minimumCadenceCoverage: 0.75,
    minimumPhaseMedianHeartRateBpm: 80,
    maximumPhaseMedianHeartRateBpm: 200,
    minimumPhaseMedianWorkloadWatts: 30,
    maximumPhaseMedianWorkloadWatts: 600,
    fixedHrWindowWidthBpm: 2,
    recentWindowSessions: 4,
    declineCorroborationSessions: 3,
    declineThresholdFraction: 0.02,
    maximumImprovementFractionPerSession: 0.015,
    maximumDeclineFractionPerSession: 0.0075,
    maximumRecentEvidenceSessionIds: 16,
    evidenceDigestAlgorithm: "fnv1a32",
};
/** Current writer alias. Historical readers must use a permanent version constant. */
export const FITNESS_REFINEMENT_ALGORITHM = FITNESS_REFINEMENT_ALGORITHM_V2;
function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
/**
 * Phase D selection is deliberately non-prescriptive: formal measurements stay
 * authoritative and the ordinary-workout observation is a separate descriptive view.
 */
export function selectEffectiveFitnessProjection(state) {
    var _a, _b, _c;
    if (!state)
        return {};
    return {
        ...(((_a = state.vo2Max) === null || _a === void 0 ? void 0 : _a.source) === "formal_assessment" ? { authoritativeVo2Max: state.vo2Max } : {}),
        ...(((_b = state.hrWorkloadCalibration) === null || _b === void 0 ? void 0 : _b.source) === "formal_assessment"
            ? { authoritativeHrWorkloadCalibration: state.hrWorkloadCalibration }
            : {}),
        ...(((_c = state.passiveAerobicObservation) === null || _c === void 0 ? void 0 : _c.source) === "workout_observation"
            ? { descriptiveAerobicObservation: state.passiveAerobicObservation }
            : {}),
    };
}
function isIsoTimestamp(value) {
    if (typeof value !== "string" || value === "")
        return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}
function round(value, digits = 3) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
function unique(values) {
    return [...new Set(values)];
}
function phaseReason(phase) {
    const policy = FITNESS_REFINEMENT_ALGORITHM_V2;
    if (phase.kind !== "work" ||
        (phase.intensityId !== "aerobic_base" && phase.intensityId !== "threshold"))
        return "unsupported_phase_semantics";
    if (phase.plannedDurationSec < policy.minimumPlannedPhaseDurationSec ||
        phase.completedDurationSec < policy.minimumCompletedPhaseDurationSec)
        return "phase_too_short";
    if (phase.completedDurationSec / phase.plannedDurationSec < policy.minimumPhaseCompletionFraction) {
        return "low_phase_completion";
    }
    if (!phase.hr || phase.hr.coverageRatio < policy.minimumPhaseHrCoverage)
        return "low_phase_hr_coverage";
    if (!phase.watts || phase.watts.provenance === "mixed")
        return "unsupported_workload_provenance";
    const minimumWattsCoverage = phase.watts.provenance === "measured_watts"
        ? policy.minimumMeasuredWattsCoverage
        : policy.minimumCalibratedWattsCoverage;
    if (phase.watts.coverageRatio < minimumWattsCoverage)
        return "low_phase_workload_coverage";
    if (phase.hr.median < policy.minimumPhaseMedianHeartRateBpm ||
        phase.hr.median > policy.maximumPhaseMedianHeartRateBpm)
        return "implausible_hr";
    if (phase.watts.median < policy.minimumPhaseMedianWorkloadWatts ||
        phase.watts.median > policy.maximumPhaseMedianWorkloadWatts)
        return "implausible_watts";
    if (phase.hr.max - phase.hr.min > 45 || Math.abs(phase.hr.end - phase.hr.median) > 20) {
        return "unstable_hr";
    }
    if ((phase.watts.max - phase.watts.min) / phase.watts.mean > 0.35)
        return "unstable_workload";
    if (!phase.cadenceRpm ||
        phase.cadenceRpm.coverageRatio < policy.minimumCadenceCoverage ||
        phase.cadenceRpm.mean < 45 ||
        phase.cadenceRpm.mean > 120 ||
        phase.cadenceRpm.max - phase.cadenceRpm.min > 25)
        return "missing_or_unstable_cadence";
    return null;
}
/** Pure Phase D gate. It uses only frozen summary/response evidence and the expected owner. */
export function qualifyWorkoutResponseForPassiveFitness(summary, athleteId) {
    var _a;
    if (!isObject(summary) || typeof summary.external_session_id !== "string" || !isIsoTimestamp(summary.endedAt)) {
        return { qualified: false, rejectionReasons: ["invalid_summary"] };
    }
    const sessionId = summary.external_session_id;
    const response = parseWorkoutResponse(summary.workout_response);
    if (!response)
        return { qualified: false, sessionId, rejectionReasons: ["invalid_response"] };
    if (summary.athlete_id !== athleteId ||
        response.athleteId !== athleteId ||
        response.sessionId !== sessionId)
        return { qualified: false, sessionId, rejectionReasons: ["ownership_mismatch"] };
    if (summary.activity !== "bike")
        return { qualified: false, sessionId, rejectionReasons: ["activity_not_bike"] };
    if (response.completion.cancelled || summary.cancelled === true) {
        return { qualified: false, sessionId, rejectionReasons: ["cancelled"] };
    }
    if (response.completion.completionFraction < FITNESS_REFINEMENT_ALGORITHM_V2.minimumSessionCompletionFraction) {
        return { qualified: false, sessionId, rejectionReasons: ["low_completion"] };
    }
    if (response.evidence.hr.coverageRatio < FITNESS_REFINEMENT_ALGORITHM_V2.minimumSessionHrCoverage) {
        return { qualified: false, sessionId, rejectionReasons: ["low_session_hr_coverage"] };
    }
    if (response.evidence.bike.freshRowCoverageRatio < FITNESS_REFINEMENT_ALGORITHM_V2.minimumSessionFreshBikeCoverage) {
        return { qualified: false, sessionId, rejectionReasons: ["low_fresh_workload_coverage"] };
    }
    const phaseRejectionReasons = [];
    const accepted = new Map();
    for (const phase of response.phases) {
        const reason = phaseReason(phase);
        if (reason) {
            phaseRejectionReasons.push(reason);
            continue;
        }
        const intensity = phase.intensityId;
        const phaseHeartRateBpm = round(phase.hr.median);
        const heartRateWindowMinBpm = fixedHrWindowMin(phaseHeartRateBpm);
        const key = `${intensity}:${heartRateWindowMinBpm}`;
        const group = (_a = accepted.get(key)) !== null && _a !== void 0 ? _a : { intensityId: intensity, phases: [] };
        group.phases.push(phase);
        accepted.set(key, group);
    }
    if (accepted.size === 0) {
        return {
            qualified: false,
            sessionId,
            rejectionReasons: unique([...phaseRejectionReasons, "no_qualified_phase"]),
        };
    }
    const observations = [];
    for (const { intensityId, phases } of accepted.values()) {
        const completedDurationSec = phases.reduce((sum, phase) => sum + phase.completedDurationSec, 0);
        const weighted = (selector) => phases.reduce((sum, phase) => sum + selector(phase) * phase.completedDurationSec, 0) / completedDurationSec;
        const sources = unique(phases.map((phase) => phase.watts.provenance));
        if (sources.length !== 1 || sources[0] === "mixed")
            continue;
        observations.push({
            athleteId,
            sessionId,
            workoutDate: summary.endedAt.slice(0, 10),
            observedAt: summary.endedAt,
            intensityId,
            // Aggregate only phase medians already assigned to this exact fixed HR
            // window. Rounding each constituent first prevents a boundary-crossing
            // aggregate from being placed into a window no phase supported.
            heartRateBpm: round(weighted((phase) => round(phase.hr.median))),
            watts: round(weighted((phase) => phase.watts.median)),
            workloadSource: sources[0],
            phaseCount: phases.length,
            completedDurationSec,
        });
    }
    if (observations.length === 0) {
        return { qualified: false, sessionId, rejectionReasons: ["unsupported_workload_provenance"] };
    }
    return { qualified: true, sessionId, observations, phaseRejectionReasons: unique(phaseRejectionReasons) };
}
function latestFormalAnchor(state) {
    var _a;
    if (!state)
        return undefined;
    const formal = [state.vo2Max, state.predictedMaxWatts, state.hrWorkloadCalibration]
        .filter((metric) => (metric === null || metric === void 0 ? void 0 : metric.source) === "formal_assessment")
        .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    return formal
        ? { observedAt: formal.observedAt, ...(((_a = formal.evidenceSessionIds) === null || _a === void 0 ? void 0 : _a[0]) ? { sessionId: formal.evidenceSessionIds[0] } : {}) }
        : undefined;
}
function formalOnlyState(state) {
    var _a, _b, _c;
    if (!state)
        return null;
    const formal = {
        ...(((_a = state.vo2Max) === null || _a === void 0 ? void 0 : _a.source) === "formal_assessment" ? { vo2Max: state.vo2Max } : {}),
        ...(((_b = state.predictedMaxWatts) === null || _b === void 0 ? void 0 : _b.source) === "formal_assessment" ? { predictedMaxWatts: state.predictedMaxWatts } : {}),
        ...(((_c = state.hrWorkloadCalibration) === null || _c === void 0 ? void 0 : _c.source) === "formal_assessment"
            ? { hrWorkloadCalibration: state.hrWorkloadCalibration }
            : {}),
    };
    if (Object.keys(formal).length === 0)
        return null;
    const retainedUpdateTimes = [formal.vo2Max, formal.predictedMaxWatts, formal.hrWorkloadCalibration]
        .map((metric) => metric === null || metric === void 0 ? void 0 : metric.updatedAt)
        .filter((value) => !!value)
        .sort();
    return {
        schemaVersion: state.schemaVersion,
        athleteId: state.athleteId,
        ...formal,
        updatedAt: retainedUpdateTimes[retainedUpdateTimes.length - 1],
    };
}
function chronological(observations) {
    return [...observations].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.sessionId.localeCompare(b.sessionId));
}
function fixedHrWindowMin(heartRateBpm) {
    const width = FITNESS_REFINEMENT_ALGORITHM_V2.fixedHrWindowWidthBpm;
    return Math.floor(heartRateBpm / width) * width;
}
function minimumSessionsFor(observations) {
    return observations.some((observation) => observation.workloadSource === "calibrated_watts")
        ? FITNESS_REFINEMENT_ALGORITHM_V2.minimumCalibratedSessions
        : FITNESS_REFINEMENT_ALGORITHM_V2.minimumMeasuredSessions;
}
/** Select the first fixed 2-BPM bin to independently become eligible. */
function selectFixedHrWindow(observations) {
    var _a;
    const groups = new Map();
    for (const observation of chronological(observations)) {
        const windowMinBpm = fixedHrWindowMin(observation.heartRateBpm);
        const key = `${observation.intensityId}:${windowMinBpm}`;
        const group = (_a = groups.get(key)) !== null && _a !== void 0 ? _a : [];
        group.push(observation);
        groups.set(key, group);
    }
    const eligible = [];
    for (const group of groups.values()) {
        for (let end = 0; end < group.length; end += 1) {
            const prefix = group.slice(0, end + 1);
            const distinctDates = unique(prefix.map((observation) => observation.workoutDate));
            if (prefix.length >= minimumSessionsFor(prefix) &&
                distinctDates.length >= FITNESS_REFINEMENT_ALGORITHM_V2.minimumDistinctDates) {
                const windowMinBpm = fixedHrWindowMin(prefix[0].heartRateBpm);
                eligible.push({
                    intensityId: prefix[0].intensityId,
                    windowMinBpm,
                    windowMaxExclusiveBpm: windowMinBpm + FITNESS_REFINEMENT_ALGORITHM_V2.fixedHrWindowWidthBpm,
                    eligibleAt: prefix[prefix.length - 1].observedAt,
                    observations: chronological(group),
                });
                break;
            }
        }
    }
    return eligible.sort((a, b) => Date.parse(a.eligibleAt) - Date.parse(b.eligibleAt) ||
        a.intensityId.localeCompare(b.intensityId) ||
        a.windowMinBpm - b.windowMinBpm)[0];
}
function projectionQuality(observations, madWatts, baselineWatts) {
    const allMeasured = observations.every((observation) => observation.workloadSource === "measured_watts");
    if (allMeasured && observations.length >= 8 && madWatts / baselineWatts <= 0.05)
        return "high";
    if (allMeasured && observations.length >= 6 && madWatts / baselineWatts <= 0.1)
        return "moderate";
    return "low";
}
function fnv1a32(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
function evidenceDigest(observations) {
    return fnv1a32(observations.map((observation) => [
        observation.sessionId,
        observation.observedAt,
        observation.intensityId,
        observation.heartRateBpm.toFixed(3),
        observation.watts.toFixed(3),
        observation.workloadSource,
    ].join("\u001f")).join("\n"));
}
function countReason(counts, reason) {
    var _a;
    counts[reason] = ((_a = counts[reason]) !== null && _a !== void 0 ? _a : 0) + 1;
}
/**
 * Rebuild from the entire immutable evidence set. Sorting, de-duplication and
 * evidence-watermark timestamps make callback order and duplicate replay inert.
 */
export function rebuildPassiveFitnessProjection(input) {
    var _a, _b, _c, _d, _e, _f, _g;
    const formalState = formalOnlyState(input.currentState);
    const anchor = latestFormalAnchor(formalState);
    const reasonCounts = {};
    const qualifications = input.workoutSummaries.map((summary) => ({
        summary,
        qualification: qualifyWorkoutResponseForPassiveFitness(summary, input.athleteId),
    }));
    const rejectedSessions = new Set();
    const bySession = new Map();
    for (const { qualification } of qualifications) {
        if (qualification.qualified === false) {
            rejectedSessions.add((_a = qualification.sessionId) !== null && _a !== void 0 ? _a : `invalid-${rejectedSessions.size}`);
            qualification.rejectionReasons.forEach((reason) => countReason(reasonCounts, reason));
            continue;
        }
        if (anchor && qualification.observations.every((observation) => Date.parse(observation.observedAt) <= Date.parse(anchor.observedAt))) {
            rejectedSessions.add(qualification.sessionId);
            countReason(reasonCounts, "not_after_formal_anchor");
            continue;
        }
        const observations = qualification.observations.filter((observation) => !anchor || Date.parse(observation.observedAt) > Date.parse(anchor.observedAt));
        if (!bySession.has(qualification.sessionId) && observations.length > 0) {
            bySession.set(qualification.sessionId, observations);
        }
    }
    const all = [...bySession.values()].flat();
    const selection = selectFixedHrWindow(all);
    const selected = (_b = selection === null || selection === void 0 ? void 0 : selection.observations) !== null && _b !== void 0 ? _b : [];
    const sources = unique(selected.map((observation) => observation.workloadSource)).sort();
    const distinctDates = unique(selected.map((observation) => observation.workoutDate));
    const minimumSessions = minimumSessionsFor(selected);
    const priorGuardedTrendWorkload = (_e = (_d = (_c = input.currentState) === null || _c === void 0 ? void 0 : _c.passiveAerobicObservation) === null || _d === void 0 ? void 0 : _d.value.guardedTrendWorkloadWatts) !== null && _e !== void 0 ? _e : (_g = (_f = input.currentState) === null || _f === void 0 ? void 0 : _f.passiveAerobicTrend) === null || _g === void 0 ? void 0 : _g.value.projectedComparableWorkloadWatts;
    const baseDiagnostics = {
        algorithm: { id: FITNESS_REFINEMENT_ALGORITHM_V2.id, version: FITNESS_REFINEMENT_ALGORITHM_V2.version },
        athleteId: input.athleteId,
        qualifiedSessionCount: bySession.size,
        rejectedSessionCount: rejectedSessions.size,
        rejectionReasonCounts: reasonCounts,
        evidenceSessionIds: selected.map((observation) => observation.sessionId),
        workloadSourceMix: sources,
        ...(anchor ? { formalAnchor: anchor } : {}),
        ...(priorGuardedTrendWorkload !== undefined
            ? { previousGuardedTrendWorkloadWatts: priorGuardedTrendWorkload }
            : {}),
        ...(selected[0]
            ? { evidenceRange: { earliest: selected[0].observedAt, latest: selected[selected.length - 1].observedAt } }
            : {}),
        ...(selection ? { selectedIntensityId: selection.intensityId } : {}),
        status: "insufficient_evidence",
    };
    if (!selection ||
        selected.length < minimumSessions ||
        distinctDates.length < FITNESS_REFINEMENT_ALGORITHM_V2.minimumDistinctDates) {
        return { state: formalState, diagnostics: baseDiagnostics };
    }
    const baselineSessions = selected.slice(0, minimumSessions);
    const baselineWatts = median(baselineSessions.map((observation) => observation.watts));
    let guardedWatts = baselineWatts;
    let rollingCandidateWatts = baselineWatts;
    for (let index = minimumSessions; index < selected.length; index += 1) {
        const throughCurrent = selected.slice(0, index + 1);
        const recent = throughCurrent.slice(-FITNESS_REFINEMENT_ALGORITHM_V2.recentWindowSessions);
        rollingCandidateWatts = median(recent.map((observation) => observation.watts));
        if (rollingCandidateWatts > guardedWatts) {
            guardedWatts += Math.min(rollingCandidateWatts - guardedWatts, guardedWatts * FITNESS_REFINEMENT_ALGORITHM_V2.maximumImprovementFractionPerSession);
            continue;
        }
        const corroborating = throughCurrent
            .slice(-FITNESS_REFINEMENT_ALGORITHM_V2.declineCorroborationSessions)
            .every((observation) => observation.watts < guardedWatts * (1 - FITNESS_REFINEMENT_ALGORITHM_V2.declineThresholdFraction));
        if (corroborating) {
            guardedWatts -= Math.min(guardedWatts - rollingCandidateWatts, guardedWatts * FITNESS_REFINEMENT_ALGORITHM_V2.maximumDeclineFractionPerSession);
        }
    }
    const watts = selected.map((observation) => observation.watts);
    const hrs = selected.map((observation) => observation.heartRateBpm);
    const madWatts = median(watts.map((wattsValue) => Math.abs(wattsValue - median(watts))));
    const earliest = selected[0].observedAt;
    const latest = selected[selected.length - 1].observedAt;
    const storedMinWatts = round(Math.min(...watts));
    const storedMaxWatts = round(Math.max(...watts));
    const storedGuardedTrendWatts = round(guardedWatts);
    const storedBaselineWatts = round(baselineWatts);
    const storedMadWatts = round(madWatts);
    const value = {
        metric: "descriptive_workload_trend_in_fixed_hr_window",
        interpretation: "descriptive_observation_only",
        normalizedToReferenceHr: false,
        eligibleForPrescription: false,
        intensityId: selection.intensityId,
        heartRateWindowCenterBpm: selection.windowMinBpm + FITNESS_REFINEMENT_ALGORITHM_V2.fixedHrWindowWidthBpm / 2,
        heartRateWindowMinBpm: selection.windowMinBpm,
        heartRateWindowMaxExclusiveBpm: selection.windowMaxExclusiveBpm,
        guardedTrendWorkloadWatts: storedGuardedTrendWatts,
        baselineWorkloadMedianWatts: storedBaselineWatts,
        guardedTrendChangeFromBaselinePercent: round(((storedGuardedTrendWatts - storedBaselineWatts) / storedBaselineWatts) * 100),
        workloadSourceClasses: sources,
        observedMinWatts: storedMinWatts,
        observedMaxWatts: storedMaxWatts,
        observedMinHeartRateBpm: Math.min(...hrs),
        observedMaxHeartRateBpm: Math.max(...hrs),
        medianAbsoluteDeviationWatts: storedMadWatts,
        ...(anchor ? { formalAnchorObservedAt: anchor.observedAt } : {}),
        ...((anchor === null || anchor === void 0 ? void 0 : anchor.sessionId) ? { formalAnchorSessionId: anchor.sessionId } : {}),
    };
    const evidenceSessionIds = selected.map((observation) => observation.sessionId);
    const recentSessionIds = evidenceSessionIds.slice(-FITNESS_REFINEMENT_ALGORITHM_V2.maximumRecentEvidenceSessionIds);
    const passiveAerobicObservation = {
        value,
        source: "workout_observation",
        quality: projectionQuality(selected, storedMadWatts, storedBaselineWatts),
        observedAt: latest,
        updatedAt: latest,
        algorithm: { id: FITNESS_REFINEMENT_ALGORITHM_V2.id, version: FITNESS_REFINEMENT_ALGORITHM_V2.version },
        evidence: {
            sessionCount: selected.length,
            observationCount: selected.length,
            distinctWorkoutDateCount: distinctDates.length,
            earliestEvidenceAt: earliest,
            latestEvidenceAt: latest,
            firstSessionId: evidenceSessionIds[0],
            latestSessionId: evidenceSessionIds[evidenceSessionIds.length - 1],
            recentSessionIds,
            digest: {
                algorithm: FITNESS_REFINEMENT_ALGORITHM_V2.evidenceDigestAlgorithm,
                value: evidenceDigest(selected),
            },
        },
    };
    const state = {
        schemaVersion: FITNESS_STATE_SCHEMA_VERSION_V3,
        athleteId: input.athleteId,
        ...((formalState === null || formalState === void 0 ? void 0 : formalState.vo2Max) ? { vo2Max: formalState.vo2Max } : {}),
        ...((formalState === null || formalState === void 0 ? void 0 : formalState.predictedMaxWatts) ? { predictedMaxWatts: formalState.predictedMaxWatts } : {}),
        ...((formalState === null || formalState === void 0 ? void 0 : formalState.hrWorkloadCalibration) ? { hrWorkloadCalibration: formalState.hrWorkloadCalibration } : {}),
        passiveAerobicObservation,
        updatedAt: [formalState === null || formalState === void 0 ? void 0 : formalState.updatedAt, latest].filter((value) => !!value).sort().slice(-1)[0],
    };
    return {
        state,
        diagnostics: {
            ...baseDiagnostics,
            baselineWorkloadMedianWatts: storedBaselineWatts,
            rollingCandidateWorkloadWatts: round(rollingCandidateWatts),
            guardedTrendWorkloadWatts: storedGuardedTrendWatts,
            status: "eligible",
        },
    };
}
/** Persistence wrapper; callers must save/delete immutable history first. */
export function rebuildStoredPassiveFitnessProjection(summaries, storage) {
    const store = storage !== null && storage !== void 0 ? storage : (typeof localStorage !== "undefined" ? localStorage : undefined);
    if (!store)
        return "persistence_failed";
    const athlete = loadAthleteProfile(store);
    const currentState = readFitnessState(athlete.athleteId, store);
    if (store.getItem(FITNESS_STATE_STORAGE_KEY) !== null && !currentState) {
        return "persistence_failed";
    }
    const rebuilt = rebuildPassiveFitnessProjection({
        athleteId: athlete.athleteId,
        currentState,
        workoutSummaries: summaries,
    });
    if (!rebuilt.state) {
        if (!(currentState === null || currentState === void 0 ? void 0 : currentState.passiveAerobicTrend) && !(currentState === null || currentState === void 0 ? void 0 : currentState.passiveAerobicObservation)) {
            return "insufficient_evidence";
        }
        if (typeof store.removeItem !== "function")
            return "persistence_failed";
        try {
            store.removeItem(FITNESS_STATE_STORAGE_KEY);
            return "refined";
        }
        catch {
            return "persistence_failed";
        }
    }
    if (JSON.stringify(rebuilt.state) === JSON.stringify(currentState)) {
        return rebuilt.diagnostics.status === "eligible" ? "unchanged" : "insufficient_evidence";
    }
    return storeFitnessState(rebuilt.state, store) ? "refined" : "persistence_failed";
}
