/**
 * H2: athlete-specific HR intensity candidates (shadow only).
 * Independent of legacy BPM targets. Never grants live prescription authority.
 */
import { HR_INTENSITY_AEROBIC_BASE_POLICY, HR_INTENSITY_CANDIDATE_ALGORITHM_ID, HR_INTENSITY_CANDIDATE_ALGORITHM_VERSION, HR_INTENSITY_CANDIDATE_AUTHORITY_NOTICE, HR_INTENSITY_CANDIDATE_EXPLORATORY_FRESHNESS_DAYS, } from "./contracts/hrIntensityCandidate.js";
import { meaningfulHrTargetEndpoints } from "./hrPersonalizationReadiness.js";
import { predictedHrMaxBpm, VO2_AGE_YEARS_MAX, VO2_AGE_YEARS_MIN, VO2_PREDICTED_HRMAX_MAX, VO2_PREDICTED_HRMAX_MIN, } from "./vo2Estimator.js";
import { RESTING_HR_SESSION_MAX_BPM, RESTING_HR_SESSION_MIN_BPM } from "./types.js";
export { HR_INTENSITY_AEROBIC_BASE_POLICY_ID, HR_INTENSITY_AEROBIC_BASE_POLICY, HR_INTENSITY_AEROBIC_BASE_POLICY_VERSION, HR_INTENSITY_AEROBIC_BASE_MIN_FRACTION_OF_HRR, HR_INTENSITY_AEROBIC_BASE_MAX_FRACTION_OF_HRR, HR_INTENSITY_CANDIDATE_ALGORITHM_ID, HR_INTENSITY_CANDIDATE_ALGORITHM_VERSION, HR_INTENSITY_CANDIDATE_AUTHORITY_NOTICE, HR_INTENSITY_CANDIDATE_EXPLORATORY_FRESHNESS_DAYS, } from "./contracts/hrIntensityCandidate.js";
function round3(value) {
    return Math.round(value * 1000) / 1000;
}
function ageDaysBetween(observedAt, nowMs) {
    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs))
        return null;
    const delta = nowMs - observedMs;
    if (!Number.isFinite(delta) || delta < 0)
        return null;
    return Math.floor(delta / (24 * 60 * 60 * 1000));
}
function inspectEvidence(input) {
    const evidenceReasons = ["activation_ineligible_shadow_only", "hrmax_observed_unavailable"];
    const uncertaintyLabels = [
        "hrmax_age_predicted_tanaka_not_measured",
        "resting_session_observation_not_clinical_basal",
    ];
    let restingHrBpm = null;
    let restingQuality = null;
    let restingAgeDays = null;
    let restingProvisionalFreshness = "unknown";
    let restingOk = false;
    if (input.fitnessStorageStatus === "absent") {
        evidenceReasons.push("resting_session_storage_absent", "resting_session_missing");
    }
    else if (input.fitnessStorageStatus === "unreadable") {
        evidenceReasons.push("resting_session_storage_unreadable", "resting_session_corrupt");
    }
    else if (input.fitnessStorageStatus === "athlete_mismatch" || input.athleteId !== input.expectedAthleteId) {
        evidenceReasons.push("resting_session_athlete_mismatch");
    }
    else if (!input.fitnessState) {
        evidenceReasons.push("resting_session_missing");
    }
    else if (input.fitnessState.athleteId !== input.expectedAthleteId) {
        evidenceReasons.push("resting_session_athlete_mismatch");
    }
    else {
        const metric = input.fitnessState.restingHeartRateSession;
        if (!metric) {
            evidenceReasons.push("resting_session_missing");
        }
        else {
            const viewed = inspectRestingMetric(metric, input.nowMs);
            restingHrBpm = viewed.heartRateBpm;
            restingQuality = viewed.quality;
            restingAgeDays = viewed.ageDays;
            restingProvisionalFreshness = viewed.provisionalFreshness;
            evidenceReasons.push(...viewed.reasons);
            uncertaintyLabels.push(...viewed.uncertaintyLabels);
            restingOk = viewed.okForExploratoryCandidate;
        }
    }
    let predicted = null;
    let hrMaxOk = false;
    const age = input.ageYears;
    if (age == null || !Number.isFinite(age)) {
        evidenceReasons.push("hrmax_demographics_missing");
    }
    else if (age < VO2_AGE_YEARS_MIN || age > VO2_AGE_YEARS_MAX) {
        evidenceReasons.push("hrmax_demographics_invalid");
    }
    else {
        const value = predictedHrMaxBpm(age);
        if (!(value >= VO2_PREDICTED_HRMAX_MIN && value <= VO2_PREDICTED_HRMAX_MAX)) {
            evidenceReasons.push("hrmax_prediction_out_of_range");
        }
        else {
            predicted = value;
            hrMaxOk = true;
        }
    }
    let heartRateReserveBpm = null;
    let canComputeCandidate = false;
    if (!restingOk || restingHrBpm == null) {
        if (!evidenceReasons.includes("resting_session_missing") &&
            !evidenceReasons.includes("resting_session_athlete_mismatch") &&
            !evidenceReasons.includes("resting_session_storage_absent") &&
            !evidenceReasons.includes("resting_session_storage_unreadable") &&
            !evidenceReasons.includes("resting_session_quality_insufficient") &&
            !evidenceReasons.includes("resting_session_exploratory_stale") &&
            !evidenceReasons.includes("resting_session_age_unknown")) {
            evidenceReasons.push("hrr_unavailable_missing_resting");
        }
    }
    else if (!hrMaxOk || predicted == null) {
        evidenceReasons.push("hrr_unavailable_missing_hrmax");
    }
    else if (restingHrBpm < RESTING_HR_SESSION_MIN_BPM ||
        restingHrBpm > RESTING_HR_SESSION_MAX_BPM ||
        restingHrBpm >= predicted) {
        evidenceReasons.push("hrr_unavailable_implausible");
    }
    else {
        const reserve = predicted - restingHrBpm;
        if (!(reserve > 0) || !Number.isFinite(reserve)) {
            evidenceReasons.push("hrr_unavailable_nonpositive");
        }
        else {
            heartRateReserveBpm = round3(reserve);
            canComputeCandidate = true;
        }
    }
    return {
        restingHrBpm,
        restingQuality,
        restingAgeDays,
        restingProvisionalFreshness,
        predictedHrMaxBpm: predicted,
        predictedHrMaxSource: predicted == null ? null : "tanaka_age_predicted",
        heartRateReserveBpm,
        evidenceReasons,
        canComputeCandidate,
        uncertaintyLabels,
    };
}
function inspectRestingMetric(metric, nowMs) {
    const ageDays = ageDaysBetween(metric.observedAt, nowMs);
    const provisionalFreshness = ageDays === null
        ? "unknown"
        : ageDays <= HR_INTENSITY_CANDIDATE_EXPLORATORY_FRESHNESS_DAYS
            ? "fresh"
            : "stale";
    const reasons = [];
    const uncertaintyLabels = [];
    let ok = true;
    if (metric.quality !== "high" && metric.quality !== "moderate") {
        reasons.push("resting_session_quality_insufficient");
        ok = false;
    }
    else if (metric.quality === "moderate") {
        uncertaintyLabels.push("resting_quality_moderate");
    }
    if (provisionalFreshness === "unknown") {
        reasons.push("resting_session_age_unknown");
        ok = false;
    }
    else if (provisionalFreshness === "stale") {
        reasons.push("resting_session_exploratory_stale");
        ok = false;
    }
    return {
        heartRateBpm: metric.value.heartRateBpm,
        quality: metric.quality === "high" || metric.quality === "moderate" ? metric.quality : null,
        ageDays,
        provisionalFreshness,
        reasons,
        uncertaintyLabels,
        okForExploratoryCandidate: ok,
    };
}
function phaseQualification(phase, policy) {
    const labels = [];
    if (phase.intensityId == null) {
        return { eligible: false, reasons: ["phase_intensity_missing"], labels };
    }
    if (phase.intensityId !== policy.intensityId) {
        return { eligible: false, reasons: ["phase_intensity_unsupported"], labels };
    }
    // Sustained aerobic-base work only — withhold warmup subsections / recovery / ambiguous kinds.
    if (phase.kind !== policy.requiredPhaseKind) {
        return {
            eligible: false,
            reasons: ["phase_kind_not_sustained_work", "phase_aerobic_base_ambiguous"],
            labels,
        };
    }
    if (phase.intervalIndex != null) {
        return {
            eligible: false,
            reasons: ["phase_aerobic_base_ambiguous"],
            labels,
        };
    }
    labels.push("qualified_aerobic_base_sustained_work");
    labels.push("policy_population_hrr_not_individual_threshold");
    return { eligible: true, reasons: ["policy_aerobic_base_acsm_moderate_hrr"], labels };
}
/**
 * Karvonen target from fraction of HRR. No clamping; fails closed on nonfinite results.
 */
export function karvonenTargetBpm(restingHrBpm, heartRateReserveBpm, fractionOfHrr) {
    if (!Number.isFinite(restingHrBpm) ||
        !Number.isFinite(heartRateReserveBpm) ||
        !Number.isFinite(fractionOfHrr) ||
        restingHrBpm <= 0 ||
        heartRateReserveBpm <= 0 ||
        fractionOfHrr < 0 ||
        fractionOfHrr > 1) {
        return null;
    }
    const raw = restingHrBpm + fractionOfHrr * heartRateReserveBpm;
    if (!Number.isFinite(raw))
        return null;
    const rounded = Math.round(raw);
    if (!Number.isFinite(rounded) || rounded <= 0)
        return null;
    return rounded;
}
function buildLegacyComparison(phase, candidate) {
    var _a;
    const expected = (_a = phase.expectedHeartRate) !== null && _a !== void 0 ? _a : null;
    const base = {
        ...(phase.displayTargetHrBpm !== undefined ? { displayTargetHrBpm: phase.displayTargetHrBpm } : {}),
        expectedHeartRate: expected,
        comparedLegacyMinBpm: null,
        comparedLegacyMaxBpm: null,
        minDeltaBpm: null,
        maxDeltaBpm: null,
        reasonCodes: [],
    };
    if (!expected || (expected.min == null && expected.max == null)) {
        return { ...base, reasonCodes: ["legacy_comparison_unavailable"] };
    }
    const endpoints = meaningfulHrTargetEndpoints(expected, phase.displayTargetHrBpm);
    const comparedMin = endpoints.interpretMin && expected.min != null && expected.min > 0 ? expected.min : null;
    const comparedMax = endpoints.interpretMax && expected.max != null && expected.max > 0 ? expected.max : null;
    const reasons = [];
    if (!endpoints.interpretMin || !endpoints.interpretMax) {
        reasons.push("legacy_comparison_open_ended");
    }
    if (comparedMin == null && comparedMax == null) {
        reasons.push("legacy_comparison_unavailable");
    }
    let minDelta = null;
    let maxDelta = null;
    if (candidate) {
        if (comparedMin != null)
            minDelta = candidate.minBpm - comparedMin;
        if (comparedMax != null)
            maxDelta = candidate.maxBpm - comparedMax;
    }
    return {
        ...base,
        comparedLegacyMinBpm: comparedMin,
        comparedLegacyMaxBpm: comparedMax,
        minDeltaBpm: minDelta,
        maxDeltaBpm: maxDelta,
        reasonCodes: reasons,
    };
}
function evaluatePhase(phase, evidence, policy) {
    const qualification = phaseQualification(phase, policy);
    const base = {
        phaseId: phase.phaseId,
        kind: phase.kind,
        ...(phase.intensityId ? { intensityId: phase.intensityId } : {}),
        ...(phase.detailName ? { detailName: phase.detailName } : {}),
        ...(phase.intervalIndex !== undefined ? { intervalIndex: phase.intervalIndex } : {}),
        status: "withheld",
        reasonCodes: [],
        candidateHeartRate: null,
        legacyComparison: buildLegacyComparison(phase, null),
        uncertaintyLabels: [...evidence.uncertaintyLabels],
        qualificationLabels: [...qualification.labels],
    };
    if (!qualification.eligible) {
        return {
            ...base,
            reasonCodes: [...qualification.reasons],
            legacyComparison: buildLegacyComparison(phase, null),
        };
    }
    if (!evidence.canComputeCandidate || evidence.restingHrBpm == null || evidence.heartRateReserveBpm == null) {
        const reasons = evidence.evidenceReasons.filter((code) => code.startsWith("resting_") ||
            code.startsWith("hrmax_") ||
            code.startsWith("hrr_") ||
            code === "activation_ineligible_shadow_only");
        return {
            ...base,
            reasonCodes: reasons.length > 0 ? reasons : ["hrr_unavailable_missing_resting"],
            legacyComparison: buildLegacyComparison(phase, null),
        };
    }
    const minBpm = karvonenTargetBpm(evidence.restingHrBpm, evidence.heartRateReserveBpm, policy.minFractionOfHrr);
    const maxBpm = karvonenTargetBpm(evidence.restingHrBpm, evidence.heartRateReserveBpm, policy.maxFractionOfHrr);
    if (minBpm == null || maxBpm == null) {
        return {
            ...base,
            reasonCodes: ["candidate_calculation_nonfinite", "activation_ineligible_shadow_only"],
            legacyComparison: buildLegacyComparison(phase, null),
        };
    }
    if (minBpm > maxBpm || minBpm <= 0 || maxBpm <= 0) {
        return {
            ...base,
            reasonCodes: ["candidate_range_invalid", "activation_ineligible_shadow_only"],
            legacyComparison: buildLegacyComparison(phase, null),
        };
    }
    // Domain: candidate must lie within [resting, predicted HRmax] inclusive; no clamping.
    if (evidence.predictedHrMaxBpm != null &&
        (minBpm < evidence.restingHrBpm || maxBpm > evidence.predictedHrMaxBpm)) {
        return {
            ...base,
            reasonCodes: ["candidate_range_invalid", "activation_ineligible_shadow_only"],
            legacyComparison: buildLegacyComparison(phase, null),
        };
    }
    const candidateHeartRate = {
        minBpm,
        maxBpm,
        minFractionOfHrr: policy.minFractionOfHrr,
        maxFractionOfHrr: policy.maxFractionOfHrr,
    };
    return {
        ...base,
        status: "candidate",
        reasonCodes: ["candidate_available", "policy_aerobic_base_acsm_moderate_hrr", "activation_ineligible_shadow_only"],
        candidateHeartRate,
        legacyComparison: buildLegacyComparison(phase, candidateHeartRate),
        uncertaintyLabels: [...evidence.uncertaintyLabels],
        qualificationLabels: [...qualification.labels],
    };
}
/**
 * Deterministic shadow evaluation of athlete-specific HR intensity candidates.
 * Candidate BPM bands are independent of legacy targets (legacy is comparison only).
 */
export function evaluateHrIntensityCandidates(input) {
    var _a, _b, _c;
    const policy = (_a = input.policy) !== null && _a !== void 0 ? _a : HR_INTENSITY_AEROBIC_BASE_POLICY;
    const evidence = inspectEvidence(input);
    const prescription = input.resolvedPrescription;
    const provenance = (_b = input.resolvedPrescriptionProvenance) !== null && _b !== void 0 ? _b : (prescription ? "frozen_session" : "none");
    const phases = prescription && Array.isArray(prescription.phases)
        ? prescription.phases.map((phase) => evaluatePhase(phase, evidence, policy))
        : [];
    const reasonCodes = [
        ...evidence.evidenceReasons,
        "policy_aerobic_base_acsm_moderate_hrr",
    ];
    if (phases.some((phase) => phase.status === "candidate")) {
        reasonCodes.push("candidate_available");
    }
    return {
        algorithm: {
            id: HR_INTENSITY_CANDIDATE_ALGORITHM_ID,
            version: HR_INTENSITY_CANDIDATE_ALGORITHM_VERSION,
        },
        policy,
        athleteId: input.expectedAthleteId,
        evaluatedAtMs: input.nowMs,
        selectedWorkoutSelector: (_c = prescription === null || prescription === void 0 ? void 0 : prescription.workoutSelector) !== null && _c !== void 0 ? _c : null,
        resolvedPrescriptionProvenance: provenance,
        restingHrBpm: evidence.restingHrBpm,
        restingQuality: evidence.restingQuality,
        restingAgeDays: evidence.restingAgeDays,
        restingProvisionalFreshness: evidence.restingProvisionalFreshness,
        predictedHrMaxBpm: evidence.predictedHrMaxBpm,
        predictedHrMaxSource: evidence.predictedHrMaxSource,
        heartRateReserveBpm: evidence.heartRateReserveBpm,
        phases,
        mode: "shadow",
        activationEligible: false,
        authorityNotice: HR_INTENSITY_CANDIDATE_AUTHORITY_NOTICE,
        reasonCodes,
    };
}
