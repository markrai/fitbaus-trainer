/**
 * Read-only HR personalization readiness and exploratory %HRR interpretation.
 * Diagnostic only: never grants prescription authority, never writes FitnessState,
 * and never feeds live workout targets, heart color, or machine guidance.
 */
import { HR_PERSONALIZATION_AUTHORITY_NOTICE, HR_PERSONALIZATION_PROVISIONAL_FRESHNESS_DAYS, HR_PERSONALIZATION_READINESS_ALGORITHM_ID, HR_PERSONALIZATION_READINESS_ALGORITHM_VERSION, } from "./contracts/hrPersonalizationReadiness.js";
import { parseResolvedWorkoutPrescription } from "./workoutPrescription.js";
import { predictedHrMaxBpm, VO2_AGE_YEARS_MAX, VO2_AGE_YEARS_MIN, VO2_PREDICTED_HRMAX_MAX, VO2_PREDICTED_HRMAX_MIN, } from "./vo2Estimator.js";
import { RESTING_HR_SESSION_MAX_BPM, RESTING_HR_SESSION_MIN_BPM } from "./types.js";
export { HR_PERSONALIZATION_AUTHORITY_NOTICE, HR_PERSONALIZATION_PROVISIONAL_FRESHNESS_DAYS, HR_PERSONALIZATION_READINESS_ALGORITHM_ID, HR_PERSONALIZATION_READINESS_ALGORITHM_VERSION, } from "./contracts/hrPersonalizationReadiness.js";
function round3(value) {
    return Math.round(value * 1000) / 1000;
}
function isFinitePositiveBpm(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
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
function evaluateResting(input) {
    const base = {
        available: false,
        reasonCodes: ["resting_session_ineligible_for_prescription"],
        heartRateBpm: null,
        quality: null,
        source: null,
        algorithmId: null,
        algorithmVersion: null,
        observedAt: null,
        ageDays: null,
        provisionalFreshness: "unknown",
        interpretation: null,
        eligibleForPrescription: false,
    };
    if (input.fitnessStorageStatus === "absent") {
        return { ...base, reasonCodes: [...base.reasonCodes, "resting_session_storage_absent", "resting_session_missing"] };
    }
    if (input.fitnessStorageStatus === "unreadable") {
        return { ...base, reasonCodes: [...base.reasonCodes, "resting_session_storage_unreadable", "resting_session_corrupt"] };
    }
    if (input.fitnessStorageStatus === "athlete_mismatch" || input.athleteId !== input.expectedAthleteId) {
        return { ...base, reasonCodes: [...base.reasonCodes, "resting_session_athlete_mismatch"] };
    }
    if (!input.fitnessState) {
        return { ...base, reasonCodes: [...base.reasonCodes, "resting_session_missing"] };
    }
    if (input.fitnessState.athleteId !== input.expectedAthleteId) {
        return { ...base, reasonCodes: [...base.reasonCodes, "resting_session_athlete_mismatch"] };
    }
    const metric = input.fitnessState.restingHeartRateSession;
    if (!metric) {
        return { ...base, reasonCodes: [...base.reasonCodes, "resting_session_missing"] };
    }
    return restingMetricView(metric, input.nowMs, base.reasonCodes);
}
function restingMetricView(metric, nowMs, priorReasons) {
    const ageDays = ageDaysBetween(metric.observedAt, nowMs);
    const provisionalFreshness = ageDays === null
        ? "unknown"
        : ageDays <= HR_PERSONALIZATION_PROVISIONAL_FRESHNESS_DAYS
            ? "fresh"
            : "stale";
    const freshnessReason = provisionalFreshness === "stale"
        ? "resting_session_provisional_stale"
        : provisionalFreshness === "fresh"
            ? "resting_session_provisional_fresh"
            : "resting_session_present";
    return {
        available: true,
        reasonCodes: [
            ...priorReasons.filter((code) => code !== "resting_session_missing"),
            "resting_session_present",
            freshnessReason,
        ],
        heartRateBpm: metric.value.heartRateBpm,
        quality: metric.quality,
        source: metric.source,
        algorithmId: metric.algorithm.id,
        algorithmVersion: metric.algorithm.version,
        observedAt: metric.observedAt,
        ageDays,
        provisionalFreshness,
        interpretation: metric.value.interpretation,
        eligibleForPrescription: false,
    };
}
function evaluateHrMax(input) {
    const reasonCodes = ["hrmax_observed_unavailable"];
    const age = input.ageYears;
    if (age == null || !Number.isFinite(age)) {
        return {
            available: false,
            reasonCodes: [...reasonCodes, "hrmax_demographics_missing"],
            observedHrMaxBpm: null,
            predictedHrMaxBpm: null,
            predictedSource: null,
            predictedLabel: null,
            ageYearsUsed: null,
        };
    }
    if (age < VO2_AGE_YEARS_MIN || age > VO2_AGE_YEARS_MAX) {
        return {
            available: false,
            reasonCodes: [...reasonCodes, "hrmax_demographics_invalid"],
            observedHrMaxBpm: null,
            predictedHrMaxBpm: null,
            predictedSource: null,
            predictedLabel: null,
            ageYearsUsed: null,
        };
    }
    const predicted = predictedHrMaxBpm(age);
    if (!Number.isFinite(predicted) ||
        predicted < VO2_PREDICTED_HRMAX_MIN ||
        predicted > VO2_PREDICTED_HRMAX_MAX) {
        return {
            available: false,
            reasonCodes: [...reasonCodes, "hrmax_prediction_out_of_range"],
            observedHrMaxBpm: null,
            predictedHrMaxBpm: null,
            predictedSource: null,
            predictedLabel: null,
            ageYearsUsed: age,
        };
    }
    return {
        available: true,
        reasonCodes: [...reasonCodes, "hrmax_age_predicted_tanaka"],
        observedHrMaxBpm: null,
        predictedHrMaxBpm: predicted,
        predictedSource: "tanaka_age_predicted",
        predictedLabel: "age-predicted (Tanaka 2001)",
        ageYearsUsed: age,
    };
}
function evaluateThreshold() {
    return {
        available: false,
        reasonCodes: ["threshold_hr_evidence_absent"],
        note: "No validated lactate-threshold, ventilatory-threshold, or measured threshold-HR evidence is available. Ordinary workout intent labels and formal HR/workload calibration are not treated as physiological threshold HR.",
    };
}
function evaluateExploratoryHrr(resting, hrMax) {
    const interpretation = "exploratory_provisional_only";
    if (!resting.available || resting.heartRateBpm == null) {
        return {
            available: false,
            reasonCodes: ["hrr_unavailable_missing_resting"],
            heartRateReserveBpm: null,
            restingHrBpm: null,
            estimatedHrMaxBpm: null,
            estimatedHrMaxSource: null,
            interpretation,
            eligibleForPrescription: false,
        };
    }
    if (!hrMax.available || hrMax.predictedHrMaxBpm == null) {
        return {
            available: false,
            reasonCodes: ["hrr_unavailable_missing_hrmax"],
            heartRateReserveBpm: null,
            restingHrBpm: resting.heartRateBpm,
            estimatedHrMaxBpm: null,
            estimatedHrMaxSource: null,
            interpretation,
            eligibleForPrescription: false,
        };
    }
    const restingBpm = resting.heartRateBpm;
    const maxBpm = hrMax.predictedHrMaxBpm;
    if (restingBpm < RESTING_HR_SESSION_MIN_BPM ||
        restingBpm > RESTING_HR_SESSION_MAX_BPM ||
        restingBpm >= maxBpm) {
        return {
            available: false,
            reasonCodes: ["hrr_unavailable_implausible"],
            heartRateReserveBpm: null,
            restingHrBpm: restingBpm,
            estimatedHrMaxBpm: maxBpm,
            estimatedHrMaxSource: "tanaka_age_predicted",
            interpretation,
            eligibleForPrescription: false,
        };
    }
    const reserve = maxBpm - restingBpm;
    if (!(reserve > 0) || !Number.isFinite(reserve)) {
        return {
            available: false,
            reasonCodes: ["hrr_unavailable_nonpositive"],
            heartRateReserveBpm: null,
            restingHrBpm: restingBpm,
            estimatedHrMaxBpm: maxBpm,
            estimatedHrMaxSource: "tanaka_age_predicted",
            interpretation,
            eligibleForPrescription: false,
        };
    }
    return {
        available: true,
        reasonCodes: ["hrr_available_exploratory"],
        heartRateReserveBpm: round3(reserve),
        restingHrBpm: restingBpm,
        estimatedHrMaxBpm: maxBpm,
        estimatedHrMaxSource: "tanaka_age_predicted",
        interpretation,
        eligibleForPrescription: false,
    };
}
/**
 * Pure fraction-of-HRR for one BPM against exploratory reserve.
 * Returns null when the calculation is out of domain (no clamping).
 * Valid domain is inclusive [0, 1].
 */
export function exploratoryFractionOfHrr(targetBpm, restingHrBpm, heartRateReserveBpm) {
    if (!isFinitePositiveBpm(targetBpm) || !isFinitePositiveBpm(restingHrBpm) || !isFinitePositiveBpm(heartRateReserveBpm)) {
        return null;
    }
    if (!(heartRateReserveBpm > 0))
        return null;
    const fraction = (targetBpm - restingHrBpm) / heartRateReserveBpm;
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
        return null;
    return round3(fraction);
}
/**
 * Decide which resolved endpoints are physiologically meaningful for exploratory
 * %HRR. Legacy `<N` encodes `{ min: 0, max: N-1 }`; uncapped `≥N` encodes
 * `{ min: N, max: 200 }`. Those synthetic bounds are not interpreted as HRR ends.
 */
export function meaningfulHrTargetEndpoints(expected, displayTargetHrBpm) {
    const text = displayTargetHrBpm != null ? String(displayTargetHrBpm).trim() : "";
    if (/^</.test(text)) {
        return { interpretMin: false, interpretMax: expected.max != null && Number.isFinite(expected.max) };
    }
    if (/^≥/.test(text) && !/\(\s*cap\s*\d+\s*\)/i.test(text)) {
        return { interpretMin: expected.min != null && Number.isFinite(expected.min) && expected.min > 0, interpretMax: false };
    }
    if (/^≥/.test(text) && /\(\s*cap\s*\d+\s*\)/i.test(text)) {
        return {
            interpretMin: expected.min != null && Number.isFinite(expected.min) && expected.min > 0,
            interpretMax: expected.max != null && Number.isFinite(expected.max) && expected.max > 0,
        };
    }
    // Missing display: treat legacy synthetic zero floor as open-ended upper bound only.
    if (expected.min === 0 && expected.max != null && expected.max > 0) {
        return { interpretMin: false, interpretMax: true };
    }
    return {
        interpretMin: expected.min != null && Number.isFinite(expected.min) && expected.min > 0,
        interpretMax: expected.max != null && Number.isFinite(expected.max) && expected.max > 0,
    };
}
function interpretPhaseTarget(phase, hrr) {
    var _a;
    const expected = (_a = phase.expectedHeartRate) !== null && _a !== void 0 ? _a : null;
    const base = {
        phaseId: phase.phaseId,
        kind: phase.kind,
        ...(phase.intensityId ? { intensityId: phase.intensityId } : {}),
        ...(phase.detailName ? { detailName: phase.detailName } : {}),
        ...(phase.displayTargetHrBpm !== undefined ? { displayTargetHrBpm: phase.displayTargetHrBpm } : {}),
        source: phase.source,
        expectedHeartRate: expected,
        minFractionOfHrr: null,
        maxFractionOfHrr: null,
        minPercentOfHrr: null,
        maxPercentOfHrr: null,
        reasonCodes: [],
    };
    if (!hrr.available || hrr.heartRateReserveBpm == null || hrr.restingHrBpm == null) {
        return { ...base, reasonCodes: ["target_interpretation_unavailable"] };
    }
    if (!expected || (expected.min == null && expected.max == null)) {
        return { ...base, reasonCodes: ["target_interpretation_unavailable"] };
    }
    const endpoints = meaningfulHrTargetEndpoints(expected, phase.displayTargetHrBpm);
    if (!endpoints.interpretMin && !endpoints.interpretMax) {
        return { ...base, reasonCodes: ["target_interpretation_unavailable"] };
    }
    // Reversed meaningful bounds are invalid; synthetic open-ended encodings are not.
    if (endpoints.interpretMin &&
        endpoints.interpretMax &&
        expected.min != null &&
        expected.max != null &&
        expected.min > expected.max) {
        return { ...base, reasonCodes: ["target_range_invalid"] };
    }
    if ((endpoints.interpretMin && (expected.min == null || !Number.isFinite(expected.min) || expected.min <= 0)) ||
        (endpoints.interpretMax && (expected.max == null || !Number.isFinite(expected.max) || expected.max <= 0))) {
        return { ...base, reasonCodes: ["target_range_invalid"] };
    }
    const minFraction = endpoints.interpretMin
        ? exploratoryFractionOfHrr(expected.min, hrr.restingHrBpm, hrr.heartRateReserveBpm)
        : null;
    const maxFraction = endpoints.interpretMax
        ? exploratoryFractionOfHrr(expected.max, hrr.restingHrBpm, hrr.heartRateReserveBpm)
        : null;
    const reasons = [];
    const attemptedMin = endpoints.interpretMin;
    const attemptedMax = endpoints.interpretMax;
    if ((attemptedMin && minFraction == null) || (attemptedMax && maxFraction == null)) {
        reasons.push("target_out_of_domain");
    }
    if (minFraction != null || maxFraction != null) {
        reasons.push("target_interpretation_available");
    }
    else if (reasons.length === 0) {
        reasons.push("target_interpretation_unavailable");
    }
    return {
        ...base,
        minFractionOfHrr: minFraction,
        maxFractionOfHrr: maxFraction,
        minPercentOfHrr: minFraction == null ? null : round3(minFraction * 100),
        maxPercentOfHrr: maxFraction == null ? null : round3(maxFraction * 100),
        reasonCodes: reasons,
    };
}
/**
 * Diagnostic-only active-session check using existing lifecycle markers.
 * A frozen phasePlan is not evidence of an active workout — require sessionId
 * and startTime, and when an active owner record exists it must match this day.
 */
export function isHrReadinessDiagnosticSessionActive(input) {
    var _a;
    if (typeof input.sessionId !== "string" || input.sessionId.length === 0)
        return false;
    if (typeof input.startTime !== "string" || input.startTime.length === 0)
        return false;
    const owner = (_a = input.activeOwner) !== null && _a !== void 0 ? _a : null;
    if (!owner)
        return true;
    return owner.selector === input.workoutSelector && owner.sessionId === input.sessionId;
}
/**
 * Choose which resolved prescription diagnostics should interpret.
 * Prefers a strict-validated frozen session prescription; never substitutes the
 * current template when a frozen prescription was present but unusable; allows
 * an inactive template preview only when no frozen prescription applies.
 */
export function selectHrReadinessPrescription(input) {
    const hasFrozenField = input.frozenPrescription != null;
    if (hasFrozenField) {
        const validated = parseResolvedWorkoutPrescription(input.frozenPrescription);
        if (validated && validated.workoutSelector === input.workoutSelector) {
            // Reuse the session object when it already validates; parse confirms safety.
            const frozen = typeof input.frozenPrescription === "object" &&
                !Array.isArray(input.frozenPrescription) &&
                input.frozenPrescription.workoutSelector === input.workoutSelector
                ? input.frozenPrescription
                : validated;
            return { prescription: frozen, provenance: "frozen_session" };
        }
        // Malformed or wrong-workout frozen prescription: never fall back to template.
        return { prescription: null, provenance: "none" };
    }
    if (input.sessionActive) {
        return { prescription: null, provenance: "none" };
    }
    if (input.templatePrescription && input.templatePrescription.workoutSelector === input.workoutSelector) {
        return { prescription: input.templatePrescription, provenance: "inactive_template_preview" };
    }
    return { prescription: null, provenance: "none" };
}
/**
 * Deterministic, read-only evaluation of athlete HR evidence and exploratory
 * %HRR interpretation of existing legacy BPM targets.
 */
export function evaluateHrPersonalizationReadiness(input) {
    var _a, _b;
    const resting = evaluateResting(input);
    const hrMax = evaluateHrMax(input);
    const thresholdHr = evaluateThreshold();
    const exploratoryHrr = evaluateExploratoryHrr(resting, hrMax);
    const prescription = input.resolvedPrescription;
    const provenance = (_a = input.resolvedPrescriptionProvenance) !== null && _a !== void 0 ? _a : (prescription ? "frozen_session" : "none");
    const exploratoryTargetInterpretations = prescription && Array.isArray(prescription.phases)
        ? prescription.phases.map((phase) => interpretPhaseTarget(phase, exploratoryHrr))
        : [];
    const reasonCodes = [
        "prescription_authority_legacy_only",
        ...resting.reasonCodes,
        ...hrMax.reasonCodes,
        ...thresholdHr.reasonCodes,
        ...exploratoryHrr.reasonCodes,
    ];
    return {
        algorithm: {
            id: HR_PERSONALIZATION_READINESS_ALGORITHM_ID,
            version: HR_PERSONALIZATION_READINESS_ALGORITHM_VERSION,
        },
        athleteId: input.expectedAthleteId,
        evaluatedAtMs: input.nowMs,
        resting,
        hrMax,
        thresholdHr,
        exploratoryHrr,
        selectedWorkoutSelector: (_b = prescription === null || prescription === void 0 ? void 0 : prescription.workoutSelector) !== null && _b !== void 0 ? _b : null,
        resolvedPrescriptionProvenance: provenance,
        exploratoryTargetInterpretations,
        personalizedHrTargetsActive: false,
        prescriptionAuthority: "legacy_bpm_only",
        authorityNotice: HR_PERSONALIZATION_AUTHORITY_NOTICE,
        reasonCodes,
    };
}
