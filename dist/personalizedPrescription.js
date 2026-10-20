import { ATHLETE_PROFILE_SCHEMA_VERSION_V1, FITNESS_STATE_SCHEMA_VERSION_V1, FITNESS_STATE_SCHEMA_VERSION_V2, FITNESS_STATE_SCHEMA_VERSION_V3, PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1, PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1, PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1, } from "./types.js";
import { parseAthleteProfile, PROFILE_WEIGHT_LBS_TO_KG } from "./profile.js";
import { parseFitnessState } from "./fitnessState.js";
import { SUPPORTED_VO2_FORMAL_ASSESSMENT_CONTRACTS, isSupportedVo2EstimatorProtocolPair, } from "./vo2Estimator.js";
import { VO2_WORKOUT_SELECTOR_ID } from "./vo2Protocol.js";
import { personalizationShadowPrescriptionEnabledForIntensity, personalizationShadowPrescriptionEnabledForIntent, } from "./personalizationCapability.js";
/**
 * Immutable PersonalizedPrescriptionPolicyV1 serialized contract for
 * `allowedIntensities`.
 *
 * This is historical schema-v1 representation only — NOT current product
 * runtime eligibility. Runtime phase eligibility uses
 * personalizationShadowPrescriptionEnabledForIntensity /
 * PERSONALIZATION_CAPABILITIES_V1. Capability evolution that widens shadow
 * intensities requires a deliberate new E1 policy/evaluation schema for new
 * writes; it must not reinterpret or invalidate historical v1 records.
 *
 * Frozen at runtime so callers cannot mutate the permanent v1 definition.
 * Policy objects and parsed records must use value-equivalent copies, not
 * this array identity.
 */
export const PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES = Object.freeze(["aerobic_base", "threshold"]);
/** Fresh mutable tuple copy of the immutable v1 schema contract (no shared identity). */
function personalizedPrescriptionV1AllowedIntensitiesCopy() {
    return [
        PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES[0],
        PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES[1],
    ];
}
/**
 * E1 is the canonical shadow athlete-relative mechanical workload prescription
 * derived from formal calibration for supported ordinary-workout phases.
 * It does not personalize the active heart-rate prescription and never controls
 * resistance. The legacy HR prescription remains live control authority; E1
 * records athlete-specific watts for shadow evaluation only.
 * See docs/personalization-architecture.md.
 *
 * E1 intentionally has no activation-approved freshness lifetime. Production
 * shadow capture records freshness as not evaluated until policy owners supply
 * an explicit provisional characterization value.
 *
 * evaluatePhase intensity eligibility is capability-driven
 * (personalizationShadowPrescriptionEnabledForIntensity). Policy
 * `allowedIntensities` is a value-equivalent copy of the immutable v1 schema
 * contract — not a second runtime allowlist and not the frozen array itself.
 */
export const PHASE_E1_SHADOW_POLICY = {
    assessmentExpiryDays: null,
    assessmentExpiryPolicy: "not_configured",
    allowedIntensities: personalizedPrescriptionV1AllowedIntensitiesCopy(),
    roundingRule: "nearest_integer_watt",
    extrapolationPolicy: "none",
};
const ATHLETE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_PHASES = 100;
const MAX_POINTS = 20;
const MAX_EVIDENCE_SESSION_IDS = 1000;
const MAX_EXPIRY_DAYS = 36500;
const SUPPORTED_FITNESS_SCHEMAS = new Set([
    FITNESS_STATE_SCHEMA_VERSION_V1,
    FITNESS_STATE_SCHEMA_VERSION_V2,
    FITNESS_STATE_SCHEMA_VERSION_V3,
]);
const FALLBACK_REASONS = new Set([
    "unsupported_activity",
    "unsupported_workout",
    "unsupported_phase",
    "missing_numeric_hr_target",
    "missing_profile",
    "missing_fitness_state",
    "athlete_mismatch",
    "unsupported_fitness_schema",
    "missing_formal_calibration",
    "unsupported_calibration_source",
    "low_quality_calibration",
    "unsupported_algorithm",
    "unsupported_protocol",
    "invalid_calibration",
    "insufficient_calibration_points",
    "profile_input_mismatch",
    "assessment_stale",
    "mixed_or_unknown_workload_provenance",
    "outside_observed_hr_range",
    "outside_observed_workload_range",
    "invalid_candidate",
]);
function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function isPositiveFinite(value) {
    return isFiniteNumber(value) && value > 0;
}
function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}
function isIsoTimestamp(value) {
    if (typeof value !== "string" || value === "")
        return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function isAthleteId(value) {
    return typeof value === "string" && ATHLETE_ID_PATTERN.test(value);
}
function nearlyEqual(a, b, epsilon = 1e-9) {
    return Math.abs(a - b) <= epsilon * Math.max(1, Math.abs(a), Math.abs(b));
}
function cloneHeartRate(target) {
    if (!target)
        return undefined;
    return {
        ...(target.min !== undefined ? { min: target.min } : {}),
        ...(target.max !== undefined ? { max: target.max } : {}),
    };
}
function cloneProfileSnapshot(profile) {
    return {
        profileSchemaVersion: ATHLETE_PROFILE_SCHEMA_VERSION_V1,
        profileUpdatedAt: profile.updatedAt,
        ...(profile.demographics.ageYears !== undefined ? { ageYears: profile.demographics.ageYears } : {}),
        ...(profile.demographics.bodyMassLbs !== undefined
            ? { bodyMassKg: profile.demographics.bodyMassLbs * PROFILE_WEIGHT_LBS_TO_KG }
            : {}),
    };
}
function workloadProvenance(calibration) {
    const sources = [...new Set(calibration.points.map((point) => point.workloadSource))];
    if (sources.length !== 1)
        return sources.length > 1 ? "mixed" : null;
    return sources[0] === "measured_watts" || sources[0] === "calibrated_at_verified_cadence"
        ? sources[0]
        : null;
}
function cloneFitnessSnapshot(state, provenance) {
    const metric = state.hrWorkloadCalibration;
    if (!metric || !metric.algorithm || !metric.evidenceSessionIds)
        return null;
    const calibration = metric.value;
    return {
        fitnessStateSchemaVersion: state.schemaVersion,
        fitnessUpdatedAt: state.updatedAt,
        metricObservedAt: metric.observedAt,
        metricUpdatedAt: metric.updatedAt,
        quality: metric.quality,
        algorithm: { ...metric.algorithm },
        evidenceSessionIds: [...metric.evidenceSessionIds],
        calibration: {
            slopeBpmPerWatt: calibration.slopeBpmPerWatt,
            interceptBpm: calibration.interceptBpm,
            rSquared: calibration.rSquared,
            observedMinWatts: calibration.observedMinWatts,
            observedMaxWatts: calibration.observedMaxWatts,
            points: calibration.points.map((point) => ({ ...point })),
            protocol: { ...calibration.protocol },
            workloadProvenance: provenance,
            predictedHrMaxBpm: calibration.predictedHrMaxBpm,
            predictedHrMaxSource: calibration.predictedHrMaxSource,
            profileInputSnapshot: { ...calibration.profileInputSnapshot },
        },
    };
}
function initialChecks() {
    return {
        athleteOwnershipValid: null,
        evidenceSchemaValid: null,
        formalSourceValid: null,
        qualityValid: null,
        profileInputsMatch: null,
        freshnessValid: null,
        phaseSupported: null,
        boundedHeartRateAvailable: null,
        heartRateDomainValid: null,
        workloadDomainValid: null,
        candidateValid: null,
    };
}
function copyEvidenceChecks(checks) {
    return { ...initialChecks(), ...checks };
}
function rawCalibrationMetric(value) {
    if (!isObject(value))
        return null;
    return isObject(value.hrWorkloadCalibration) ? value.hrWorkloadCalibration : null;
}
function rawCalibrationValue(metric) {
    return metric && isObject(metric.value) ? metric.value : null;
}
function resolveEvidence(input) {
    const checks = {
        athleteOwnershipValid: null,
        evidenceSchemaValid: null,
        formalSourceValid: null,
        qualityValid: null,
        profileInputsMatch: null,
        freshnessValid: null,
    };
    const profile = parseAthleteProfile(input.profile);
    const profileSnapshot = profile ? cloneProfileSnapshot(profile) : null;
    if (!profile || profileSnapshot.ageYears === undefined || profileSnapshot.bodyMassKg === undefined) {
        return { profileSnapshot, fitnessSnapshot: null, fallbackReason: "missing_profile", checks };
    }
    if (profile.athleteId !== input.athleteId) {
        checks.athleteOwnershipValid = false;
        return { profileSnapshot, fitnessSnapshot: null, fallbackReason: "athlete_mismatch", checks };
    }
    if (input.fitnessState == null) {
        checks.athleteOwnershipValid = true;
        return { profileSnapshot, fitnessSnapshot: null, fallbackReason: "missing_fitness_state", checks };
    }
    if (!isObject(input.fitnessState) || !SUPPORTED_FITNESS_SCHEMAS.has(input.fitnessState.schemaVersion)) {
        checks.athleteOwnershipValid = true;
        checks.evidenceSchemaValid = false;
        return { profileSnapshot, fitnessSnapshot: null, fallbackReason: "unsupported_fitness_schema", checks };
    }
    if (input.fitnessState.athleteId !== input.athleteId) {
        checks.athleteOwnershipValid = false;
        return { profileSnapshot, fitnessSnapshot: null, fallbackReason: "athlete_mismatch", checks };
    }
    checks.athleteOwnershipValid = true;
    const rawMetric = rawCalibrationMetric(input.fitnessState);
    if (!rawMetric) {
        checks.evidenceSchemaValid = true;
        return { profileSnapshot, fitnessSnapshot: null, fallbackReason: "missing_formal_calibration", checks };
    }
    if (rawMetric.source !== "formal_assessment") {
        checks.formalSourceValid = false;
        return { profileSnapshot, fitnessSnapshot: null, fallbackReason: "unsupported_calibration_source", checks };
    }
    checks.formalSourceValid = true;
    const rawAlgorithm = rawMetric.algorithm;
    if (!isObject(rawAlgorithm) || !SUPPORTED_VO2_FORMAL_ASSESSMENT_CONTRACTS.some((contract) => contract.estimatorId === rawAlgorithm.id && contract.estimatorVersion === rawAlgorithm.version)) {
        return { profileSnapshot, fitnessSnapshot: null, fallbackReason: "unsupported_algorithm", checks };
    }
    const rawCalibration = rawCalibrationValue(rawMetric);
    const rawProtocol = rawCalibration === null || rawCalibration === void 0 ? void 0 : rawCalibration.protocol;
    if (!rawCalibration ||
        !isObject(rawProtocol) ||
        !SUPPORTED_VO2_FORMAL_ASSESSMENT_CONTRACTS.some((contract) => contract.protocolId === rawProtocol.id && contract.protocolVersion === rawProtocol.version)) {
        return { profileSnapshot, fitnessSnapshot: null, fallbackReason: "unsupported_protocol", checks };
    }
    if (!isSupportedVo2EstimatorProtocolPair(rawAlgorithm.id, rawAlgorithm.version, rawProtocol.id, rawProtocol.version)) {
        return { profileSnapshot, fitnessSnapshot: null, fallbackReason: "unsupported_protocol", checks };
    }
    const state = parseFitnessState(input.fitnessState);
    if (!state || !state.hrWorkloadCalibration) {
        checks.evidenceSchemaValid = false;
        return { profileSnapshot, fitnessSnapshot: null, fallbackReason: "invalid_calibration", checks };
    }
    checks.evidenceSchemaValid = true;
    const metric = state.hrWorkloadCalibration;
    const calibration = metric.value;
    const provenance = workloadProvenance(calibration);
    const fitnessSnapshot = provenance ? cloneFitnessSnapshot(state, provenance) : null;
    if (metric.quality !== "moderate" && metric.quality !== "high") {
        checks.qualityValid = false;
        return { profileSnapshot, fitnessSnapshot, fallbackReason: "low_quality_calibration", checks };
    }
    checks.qualityValid = true;
    if (calibration.points.length < 3) {
        return { profileSnapshot, fitnessSnapshot, fallbackReason: "insufficient_calibration_points", checks };
    }
    if (!provenance || provenance === "mixed") {
        return {
            profileSnapshot,
            fitnessSnapshot,
            fallbackReason: "mixed_or_unknown_workload_provenance",
            checks,
        };
    }
    if (!isPositiveFinite(calibration.slopeBpmPerWatt) ||
        !isFiniteNumber(calibration.interceptBpm) ||
        !isFiniteNumber(calibration.rSquared) ||
        calibration.rSquared < 0 ||
        calibration.rSquared > 1 ||
        !isPositiveFinite(calibration.observedMinWatts) ||
        !isPositiveFinite(calibration.observedMaxWatts) ||
        calibration.observedMinWatts > calibration.observedMaxWatts) {
        return { profileSnapshot, fitnessSnapshot, fallbackReason: "invalid_calibration", checks };
    }
    const profileMatches = nearlyEqual(profileSnapshot.ageYears, calibration.profileInputSnapshot.ageYears) &&
        nearlyEqual(profileSnapshot.bodyMassKg, calibration.profileInputSnapshot.bodyMassKg);
    checks.profileInputsMatch = profileMatches;
    if (!profileMatches) {
        return { profileSnapshot, fitnessSnapshot, fallbackReason: "profile_input_mismatch", checks };
    }
    if (input.policy.assessmentExpiryDays === null) {
        checks.freshnessValid = null;
    }
    else {
        const resolvedMs = Date.parse(input.resolvedAt);
        const observedMs = Date.parse(metric.observedAt);
        const ageMs = resolvedMs - observedMs;
        checks.freshnessValid = Number.isFinite(ageMs) && ageMs >= 0 &&
            ageMs <= input.policy.assessmentExpiryDays * 24 * 60 * 60 * 1000;
        if (!checks.freshnessValid) {
            return { profileSnapshot, fitnessSnapshot, fallbackReason: "assessment_stale", checks };
        }
    }
    return { profileSnapshot, fitnessSnapshot, calibration, checks };
}
function phaseIdentity(phase) {
    return {
        phaseId: phase.phaseId,
        kind: phase.kind,
        ...(phase.intensityId ? { intensityId: phase.intensityId } : {}),
        ...(phase.detailName ? { detailName: phase.detailName } : {}),
        ...(phase.intervalIndex !== undefined ? { intervalIndex: phase.intervalIndex } : {}),
        ...(phase.activeStartSec !== undefined ? { activeStartSec: phase.activeStartSec } : {}),
        ...(phase.activeEndSec !== undefined ? { activeEndSec: phase.activeEndSec } : {}),
        ...(phase.expectedHeartRate ? { activeHeartRate: cloneHeartRate(phase.expectedHeartRate) } : {}),
    };
}
function fallbackPhase(phase, reason, checks) {
    return { ...phaseIdentity(phase), outcome: "fallback", fallbackReason: reason, safetyChecks: checks };
}
function boundedHeartRate(target) {
    return !!target && isPositiveFinite(target.min) && isPositiveFinite(target.max) && target.min <= target.max;
}
function evaluatePhase(phase, input, evidence) {
    var _a, _b;
    const checks = copyEvidenceChecks(evidence.checks);
    if (input.activity !== "bike")
        return fallbackPhase(phase, "unsupported_activity", checks);
    if (input.legacyPrescription.workoutSelector === VO2_WORKOUT_SELECTOR_ID) {
        return fallbackPhase(phase, "unsupported_workout", checks);
    }
    const phaseSupported = phase.kind === "work" &&
        personalizationShadowPrescriptionEnabledForIntensity((_a = phase.intensityId) !== null && _a !== void 0 ? _a : "");
    checks.phaseSupported = phaseSupported;
    if (!phaseSupported)
        return fallbackPhase(phase, "unsupported_phase", checks);
    if (!personalizationShadowPrescriptionEnabledForIntent(input.workoutIntent)) {
        return fallbackPhase(phase, "unsupported_workout", checks);
    }
    checks.boundedHeartRateAvailable = boundedHeartRate(phase.expectedHeartRate);
    if (!checks.boundedHeartRateAvailable) {
        return fallbackPhase(phase, "missing_numeric_hr_target", checks);
    }
    if (evidence.fallbackReason || !evidence.calibration || !evidence.fitnessSnapshot) {
        return fallbackPhase(phase, (_b = evidence.fallbackReason) !== null && _b !== void 0 ? _b : "invalid_calibration", checks);
    }
    const calibration = evidence.calibration;
    const heartRates = calibration.points.map((point) => point.heartRateBpm);
    const observedMinHeartRate = Math.min(...heartRates);
    const observedMaxHeartRate = Math.max(...heartRates);
    const heartRate = phase.expectedHeartRate;
    checks.heartRateDomainValid = heartRate.min >= observedMinHeartRate && heartRate.max <= observedMaxHeartRate;
    if (!checks.heartRateDomainValid) {
        return fallbackPhase(phase, "outside_observed_hr_range", checks);
    }
    const rawMin = (heartRate.min - calibration.interceptBpm) / calibration.slopeBpmPerWatt;
    const rawMax = (heartRate.max - calibration.interceptBpm) / calibration.slopeBpmPerWatt;
    const rawCandidateValid = isPositiveFinite(rawMin) && isPositiveFinite(rawMax) && rawMin <= rawMax;
    if (!rawCandidateValid) {
        checks.candidateValid = false;
        return fallbackPhase(phase, "invalid_candidate", checks);
    }
    checks.workloadDomainValid = rawMin >= calibration.observedMinWatts && rawMax <= calibration.observedMaxWatts;
    if (!checks.workloadDomainValid) {
        return fallbackPhase(phase, "outside_observed_workload_range", checks);
    }
    const candidatePower = {
        minWatts: Math.round(rawMin),
        maxWatts: Math.round(rawMax),
    };
    checks.candidateValid = Number.isInteger(candidatePower.minWatts) &&
        Number.isInteger(candidatePower.maxWatts) &&
        candidatePower.minWatts > 0 &&
        candidatePower.minWatts <= candidatePower.maxWatts;
    checks.workloadDomainValid = checks.workloadDomainValid &&
        candidatePower.minWatts >= calibration.observedMinWatts &&
        candidatePower.maxWatts <= calibration.observedMaxWatts;
    if (!checks.candidateValid)
        return fallbackPhase(phase, "invalid_candidate", checks);
    if (!checks.workloadDomainValid) {
        return fallbackPhase(phase, "outside_observed_workload_range", checks);
    }
    return {
        ...phaseIdentity(phase),
        candidatePower,
        outcome: "candidate",
        safetyChecks: checks,
    };
}
function policyIsValid(policy) {
    if (!isObject(policy))
        return false;
    const expiryValid = policy.assessmentExpiryDays === null ||
        (isPositiveInteger(policy.assessmentExpiryDays) && policy.assessmentExpiryDays <= MAX_EXPIRY_DAYS);
    if (!expiryValid)
        return false;
    if (policy.assessmentExpiryPolicy !== "not_configured" &&
        policy.assessmentExpiryPolicy !== "provisional_characterization")
        return false;
    if (policy.assessmentExpiryDays === null && policy.assessmentExpiryPolicy !== "not_configured")
        return false;
    if (policy.assessmentExpiryDays !== null && policy.assessmentExpiryPolicy !== "provisional_characterization")
        return false;
    return Array.isArray(policy.allowedIntensities) &&
        policy.allowedIntensities.length === PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES.length &&
        policy.allowedIntensities.every((id, index) => id === PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES[index]) &&
        policy.roundingRule === "nearest_integer_watt" &&
        policy.extrapolationPolicy === "none";
}
/** Pure Phase E1 shadow workload evaluation. The returned candidate has no runtime/controller path. */
export function evaluatePersonalizedPrescription(input) {
    if (!isAthleteId(input.athleteId))
        throw new Error("Invalid athlete identity for shadow prescription");
    if (!isIsoTimestamp(input.resolvedAt))
        throw new Error("Invalid shadow resolution timestamp");
    if (!policyIsValid(input.policy))
        throw new Error("Invalid Phase E1 shadow policy");
    if (!input.legacyPrescription || input.legacyPrescription.phases.length > MAX_PHASES) {
        throw new Error("Invalid authoritative prescription for shadow evaluation");
    }
    const evidence = resolveEvidence(input);
    return {
        schemaVersion: PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1,
        resolver: {
            id: PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1,
            version: PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1,
        },
        mode: "shadow",
        activationEligible: false,
        resolvedAt: input.resolvedAt,
        workoutSelector: input.legacyPrescription.workoutSelector,
        workoutIntent: input.workoutIntent,
        activity: input.activity,
        athleteId: input.athleteId,
        profileInputSnapshot: evidence.profileSnapshot,
        fitnessEvidenceSnapshot: evidence.fitnessSnapshot,
        policy: {
            ...input.policy,
            allowedIntensities: [...input.policy.allowedIntensities],
        },
        phases: input.legacyPrescription.phases.map((phase) => evaluatePhase(phase, input, evidence)),
    };
}
/**
 * Read-only shadow watt advice projected from the already-frozen E1 evaluation.
 * Formal-assessment-calibration derived; advisory only — never machine-control
 * authority and never a validated FTP/threshold prescription. Exact phase
 * identity is required; fallback data is never promoted to advice.
 * See docs/personalization-architecture.md.
 */
export function assessmentBasedWorkloadForPhase(evaluation, phaseId) {
    const phase = evaluation === null || evaluation === void 0 ? void 0 : evaluation.phases.find((candidate) => candidate.phaseId === phaseId);
    if ((phase === null || phase === void 0 ? void 0 : phase.outcome) !== "candidate" || !phase.candidatePower)
        return null;
    const { minWatts, maxWatts } = phase.candidatePower;
    if (!Number.isInteger(minWatts) ||
        !Number.isInteger(maxWatts) ||
        minWatts <= 0 ||
        minWatts > maxWatts) {
        return null;
    }
    return { minWatts, maxWatts };
}
function parseHeartRate(value) {
    if (value === undefined)
        return undefined;
    if (!isObject(value))
        return null;
    const min = value.min;
    const max = value.max;
    if (min !== undefined && (!isFiniteNumber(min) || min < 0 || min > 250))
        return null;
    if (max !== undefined && (!isFiniteNumber(max) || max <= 0 || max > 250))
        return null;
    if (min === undefined && max === undefined)
        return null;
    if (isFiniteNumber(min) && isFiniteNumber(max) && min > max)
        return null;
    return {
        ...(min !== undefined ? { min: min } : {}),
        ...(max !== undefined ? { max: max } : {}),
    };
}
function parseChecks(value) {
    if (!isObject(value))
        return null;
    const keys = [
        "athleteOwnershipValid",
        "evidenceSchemaValid",
        "formalSourceValid",
        "qualityValid",
        "profileInputsMatch",
        "freshnessValid",
        "phaseSupported",
        "boundedHeartRateAvailable",
        "heartRateDomainValid",
        "workloadDomainValid",
        "candidateValid",
    ];
    const parsed = {};
    for (const key of keys) {
        if (value[key] !== null && typeof value[key] !== "boolean")
            return null;
        parsed[key] = value[key];
    }
    return parsed;
}
function parseProfileSnapshot(value) {
    if (value === null)
        return null;
    if (!isObject(value) || value.profileSchemaVersion !== ATHLETE_PROFILE_SCHEMA_VERSION_V1 || !isIsoTimestamp(value.profileUpdatedAt)) {
        return undefined;
    }
    if (value.ageYears !== undefined && !isPositiveFinite(value.ageYears))
        return undefined;
    if (value.bodyMassKg !== undefined && !isPositiveFinite(value.bodyMassKg))
        return undefined;
    return {
        profileSchemaVersion: ATHLETE_PROFILE_SCHEMA_VERSION_V1,
        profileUpdatedAt: value.profileUpdatedAt,
        ...(value.ageYears !== undefined ? { ageYears: value.ageYears } : {}),
        ...(value.bodyMassKg !== undefined ? { bodyMassKg: value.bodyMassKg } : {}),
    };
}
function parseFitnessSnapshot(value) {
    if (value === null)
        return null;
    if (!isObject(value) || !SUPPORTED_FITNESS_SCHEMAS.has(value.fitnessStateSchemaVersion))
        return undefined;
    if (!isIsoTimestamp(value.fitnessUpdatedAt) || !isIsoTimestamp(value.metricObservedAt) || !isIsoTimestamp(value.metricUpdatedAt)) {
        return undefined;
    }
    if (Date.parse(value.metricUpdatedAt) < Date.parse(value.metricObservedAt))
        return undefined;
    if (value.quality !== "low" && value.quality !== "moderate" && value.quality !== "high" && value.quality !== "unverified") {
        return undefined;
    }
    if (!isObject(value.algorithm) || typeof value.algorithm.id !== "string" || !isPositiveInteger(value.algorithm.version)) {
        return undefined;
    }
    if (!Array.isArray(value.evidenceSessionIds) ||
        value.evidenceSessionIds.length === 0 ||
        value.evidenceSessionIds.length > MAX_EVIDENCE_SESSION_IDS ||
        value.evidenceSessionIds.some((id) => typeof id !== "string" || id.trim() === ""))
        return undefined;
    if (!isObject(value.calibration))
        return undefined;
    const calibration = value.calibration;
    if (!isPositiveFinite(calibration.slopeBpmPerWatt) ||
        !isFiniteNumber(calibration.interceptBpm) ||
        !isFiniteNumber(calibration.rSquared) ||
        calibration.rSquared < 0 ||
        calibration.rSquared > 1 ||
        !isPositiveFinite(calibration.observedMinWatts) ||
        !isPositiveFinite(calibration.observedMaxWatts) ||
        calibration.observedMinWatts > calibration.observedMaxWatts ||
        !Array.isArray(calibration.points) ||
        calibration.points.length < 2 ||
        calibration.points.length > MAX_POINTS)
        return undefined;
    const points = [];
    const stageIds = new Set();
    let priorWatts = -Infinity;
    for (const raw of calibration.points) {
        if (!isObject(raw) || typeof raw.stageId !== "string" || raw.stageId.trim() === "" || stageIds.has(raw.stageId)) {
            return undefined;
        }
        if (!isPositiveFinite(raw.watts) || raw.watts <= priorWatts || !isPositiveFinite(raw.heartRateBpm) || raw.heartRateBpm > 250) {
            return undefined;
        }
        if (raw.workloadSource !== "measured_watts" && raw.workloadSource !== "calibrated_at_verified_cadence") {
            return undefined;
        }
        stageIds.add(raw.stageId);
        priorWatts = raw.watts;
        points.push({
            stageId: raw.stageId,
            watts: raw.watts,
            heartRateBpm: raw.heartRateBpm,
            workloadSource: raw.workloadSource,
        });
    }
    if (!nearlyEqual(points[0].watts, calibration.observedMinWatts) ||
        !nearlyEqual(points[points.length - 1].watts, calibration.observedMaxWatts))
        return undefined;
    if (!isObject(calibration.protocol) || typeof calibration.protocol.id !== "string" || !isPositiveInteger(calibration.protocol.version)) {
        return undefined;
    }
    if (calibration.workloadProvenance !== "measured_watts" &&
        calibration.workloadProvenance !== "calibrated_at_verified_cadence" &&
        calibration.workloadProvenance !== "mixed")
        return undefined;
    const sources = [...new Set(points.map((point) => point.workloadSource))];
    const expectedProvenance = sources.length === 1 ? sources[0] : "mixed";
    if (calibration.workloadProvenance !== expectedProvenance)
        return undefined;
    if (!isPositiveFinite(calibration.predictedHrMaxBpm) || calibration.predictedHrMaxSource !== "demographic_estimate") {
        return undefined;
    }
    if (!isObject(calibration.profileInputSnapshot) ||
        !isPositiveFinite(calibration.profileInputSnapshot.ageYears) ||
        !isPositiveFinite(calibration.profileInputSnapshot.bodyMassKg))
        return undefined;
    return {
        fitnessStateSchemaVersion: value.fitnessStateSchemaVersion,
        fitnessUpdatedAt: value.fitnessUpdatedAt,
        metricObservedAt: value.metricObservedAt,
        metricUpdatedAt: value.metricUpdatedAt,
        quality: value.quality,
        algorithm: { id: value.algorithm.id, version: value.algorithm.version },
        evidenceSessionIds: [...value.evidenceSessionIds],
        calibration: {
            slopeBpmPerWatt: calibration.slopeBpmPerWatt,
            interceptBpm: calibration.interceptBpm,
            rSquared: calibration.rSquared,
            observedMinWatts: calibration.observedMinWatts,
            observedMaxWatts: calibration.observedMaxWatts,
            points,
            protocol: { id: calibration.protocol.id, version: calibration.protocol.version },
            workloadProvenance: calibration.workloadProvenance,
            predictedHrMaxBpm: calibration.predictedHrMaxBpm,
            predictedHrMaxSource: "demographic_estimate",
            profileInputSnapshot: {
                ageYears: calibration.profileInputSnapshot.ageYears,
                bodyMassKg: calibration.profileInputSnapshot.bodyMassKg,
            },
        },
    };
}
function parsePhase(value, evidence) {
    if (!isObject(value) || typeof value.phaseId !== "string" || value.phaseId.trim() === "")
        return null;
    if (value.kind !== "warmup" && value.kind !== "work" && value.kind !== "recovery" && value.kind !== "cooldown")
        return null;
    const allowedIntensities = new Set([
        "warmup_easy", "aerobic_base", "threshold", "vo2_short", "vo2_long", "recovery", "cooldown", "strength_support",
    ]);
    if (value.intensityId !== undefined && !allowedIntensities.has(value.intensityId))
        return null;
    if (value.detailName !== undefined && (typeof value.detailName !== "string" || value.detailName.trim() === ""))
        return null;
    if (value.intervalIndex !== undefined && !isPositiveInteger(value.intervalIndex))
        return null;
    if (value.activeStartSec !== undefined && (!isFiniteNumber(value.activeStartSec) || value.activeStartSec < 0))
        return null;
    if (value.activeEndSec !== undefined && (!isPositiveFinite(value.activeEndSec) ||
        (isFiniteNumber(value.activeStartSec) && value.activeEndSec <= value.activeStartSec)))
        return null;
    const activeHeartRate = parseHeartRate(value.activeHeartRate);
    if (activeHeartRate === null)
        return null;
    const safetyChecks = parseChecks(value.safetyChecks);
    if (!safetyChecks)
        return null;
    const base = {
        phaseId: value.phaseId,
        kind: value.kind,
        ...(value.intensityId !== undefined ? { intensityId: value.intensityId } : {}),
        ...(value.detailName !== undefined ? { detailName: value.detailName } : {}),
        ...(value.intervalIndex !== undefined ? { intervalIndex: value.intervalIndex } : {}),
        ...(value.activeStartSec !== undefined ? { activeStartSec: value.activeStartSec } : {}),
        ...(value.activeEndSec !== undefined ? { activeEndSec: value.activeEndSec } : {}),
        ...(activeHeartRate !== undefined ? { activeHeartRate } : {}),
        safetyChecks,
    };
    if (value.outcome === "candidate") {
        if (value.fallbackReason !== undefined || !isObject(value.candidatePower) || !evidence)
            return null;
        const minWatts = value.candidatePower.minWatts;
        const maxWatts = value.candidatePower.maxWatts;
        if (!isPositiveInteger(minWatts) || !isPositiveInteger(maxWatts) || minWatts > maxWatts)
            return null;
        if (minWatts < evidence.calibration.observedMinWatts || maxWatts > evidence.calibration.observedMaxWatts)
            return null;
        if (!boundedHeartRate(activeHeartRate))
            return null;
        const observedHrs = evidence.calibration.points.map((point) => point.heartRateBpm);
        if (activeHeartRate.min < Math.min(...observedHrs) || activeHeartRate.max > Math.max(...observedHrs))
            return null;
        const expectedMin = Math.round((activeHeartRate.min - evidence.calibration.interceptBpm) / evidence.calibration.slopeBpmPerWatt);
        const expectedMax = Math.round((activeHeartRate.max - evidence.calibration.interceptBpm) / evidence.calibration.slopeBpmPerWatt);
        if (minWatts !== expectedMin || maxWatts !== expectedMax)
            return null;
        if (safetyChecks.phaseSupported !== true ||
            safetyChecks.boundedHeartRateAvailable !== true ||
            safetyChecks.heartRateDomainValid !== true ||
            safetyChecks.workloadDomainValid !== true ||
            safetyChecks.candidateValid !== true)
            return null;
        return { ...base, candidatePower: { minWatts, maxWatts }, outcome: "candidate" };
    }
    if (value.outcome !== "fallback" || typeof value.fallbackReason !== "string" ||
        !FALLBACK_REASONS.has(value.fallbackReason) ||
        value.candidatePower !== undefined)
        return null;
    return {
        ...base,
        outcome: "fallback",
        fallbackReason: value.fallbackReason,
    };
}
/** Strict permanent reader for the Phase E1 shadow schema. */
export function parsePersonalizedPrescriptionEvaluation(value) {
    if (!isObject(value) || value.schemaVersion !== PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1)
        return null;
    if (!isObject(value.resolver) || value.resolver.id !== PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1 ||
        value.resolver.version !== PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1)
        return null;
    if (value.mode !== "shadow" || value.activationEligible !== false)
        return null;
    if (!isIsoTimestamp(value.resolvedAt) || typeof value.workoutSelector !== "string" || value.workoutSelector.trim() === "" ||
        typeof value.workoutIntent !== "string" || !isAthleteId(value.athleteId))
        return null;
    if (value.activity !== "bike" && value.activity !== "elliptical" && value.activity !== "strength")
        return null;
    const profileInputSnapshot = parseProfileSnapshot(value.profileInputSnapshot);
    if (profileInputSnapshot === undefined)
        return null;
    const fitnessEvidenceSnapshot = parseFitnessSnapshot(value.fitnessEvidenceSnapshot);
    if (fitnessEvidenceSnapshot === undefined || !policyIsValid(value.policy))
        return null;
    if (!Array.isArray(value.phases) || value.phases.length > MAX_PHASES)
        return null;
    const phases = [];
    for (const raw of value.phases) {
        const phase = parsePhase(raw, fitnessEvidenceSnapshot);
        if (!phase)
            return null;
        phases.push(phase);
    }
    const candidatePhases = phases.filter((phase) => phase.outcome === "candidate");
    if (candidatePhases.length > 0) {
        if (!profileInputSnapshot || !fitnessEvidenceSnapshot ||
            profileInputSnapshot.ageYears === undefined || profileInputSnapshot.bodyMassKg === undefined)
            return null;
        const evidence = fitnessEvidenceSnapshot;
        if (evidence.quality !== "moderate" && evidence.quality !== "high" ||
            !isSupportedVo2EstimatorProtocolPair(evidence.algorithm.id, evidence.algorithm.version, evidence.calibration.protocol.id, evidence.calibration.protocol.version) ||
            evidence.calibration.workloadProvenance === "mixed" ||
            evidence.calibration.points.length < 3 ||
            !nearlyEqual(profileInputSnapshot.ageYears, evidence.calibration.profileInputSnapshot.ageYears) ||
            !nearlyEqual(profileInputSnapshot.bodyMassKg, evidence.calibration.profileInputSnapshot.bodyMassKg))
            return null;
        const parsedPolicy = value.policy;
        if (parsedPolicy.assessmentExpiryDays !== null) {
            const evidenceAgeMs = Date.parse(value.resolvedAt) - Date.parse(evidence.metricObservedAt);
            if (evidenceAgeMs < 0 || evidenceAgeMs > parsedPolicy.assessmentExpiryDays * 24 * 60 * 60 * 1000)
                return null;
        }
        if (candidatePhases.some((phase) => phase.safetyChecks.athleteOwnershipValid !== true ||
            phase.safetyChecks.evidenceSchemaValid !== true ||
            phase.safetyChecks.formalSourceValid !== true ||
            phase.safetyChecks.qualityValid !== true ||
            phase.safetyChecks.profileInputsMatch !== true ||
            (parsedPolicy.assessmentExpiryDays === null
                ? phase.safetyChecks.freshnessValid !== null
                : phase.safetyChecks.freshnessValid !== true)))
            return null;
    }
    return {
        schemaVersion: PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1,
        resolver: {
            id: PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1,
            version: PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1,
        },
        mode: "shadow",
        activationEligible: false,
        resolvedAt: value.resolvedAt,
        workoutSelector: value.workoutSelector,
        workoutIntent: value.workoutIntent,
        activity: value.activity,
        athleteId: value.athleteId,
        profileInputSnapshot,
        fitnessEvidenceSnapshot,
        policy: {
            assessmentExpiryDays: value.policy.assessmentExpiryDays,
            assessmentExpiryPolicy: value.policy.assessmentExpiryPolicy,
            allowedIntensities: personalizedPrescriptionV1AllowedIntensitiesCopy(),
            roundingRule: "nearest_integer_watt",
            extrapolationPolicy: "none",
        },
        phases,
    };
}
