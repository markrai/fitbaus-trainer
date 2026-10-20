import { readFitnessState } from "./fitnessState.js";
import { loadAthleteProfile } from "./profile.js";
import { formatVo2EstimateMlKgMin, vo2FitQualityText } from "./vo2AssessmentView.js";
import { buildPersonalizationStatus } from "./personalizationStatus.js";
function finiteText(value) {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}
function formatDateTime(timestamp, options) {
    var _a;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime()))
        return "Date unavailable";
    return new Intl.DateTimeFormat((_a = options.locale) !== null && _a !== void 0 ? _a : "en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }).format(date);
}
function workloadSourceText(sources) {
    const unique = new Set(sources);
    if (unique.size === 1 && unique.has("measured_watts"))
        return "measured bike power";
    if (unique.size === 1 && unique.has("calibrated_watts"))
        return "cadence-based calibrated power";
    return "measured and cadence-based power";
}
function calibrationSourceText(state) {
    var _a, _b;
    const sources = (_b = (_a = state.hrWorkloadCalibration) === null || _a === void 0 ? void 0 : _a.value.points.map((point) => point.workloadSource === "measured_watts" ? "measured_watts" : "calibrated_watts")) !== null && _b !== void 0 ? _b : [];
    return workloadSourceText(sources);
}
function signedPercent(value) {
    const rounded = Math.round(value * 10) / 10;
    return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}
function observationContext(metric) {
    return metric.value.intensityId === "threshold" ? "Threshold workouts" : "Aerobic-base workouts";
}
function observationQualityText(metric) {
    if (metric.quality === "high")
        return "Strong consistency";
    if (metric.quality === "moderate")
        return "Adequate consistency";
    return "Limited consistency";
}
/** One ownership-safe read for everything shown in Settings -> Profile. */
export function readProfileFitnessData(storage) {
    const athleteProfile = loadAthleteProfile(storage);
    return {
        athleteProfile,
        fitnessState: readFitnessState(athleteProfile.athleteId, storage),
    };
}
/** Pure presentation projection. It does not write profile or fitness state. */
export function buildProfileFitnessPresentation(athleteProfile, fitnessState, options = {}) {
    var _a, _b, _c;
    const demographics = athleteProfile.demographics;
    const assessmentMetric = fitnessState === null || fitnessState === void 0 ? void 0 : fitnessState.vo2Max;
    const calibration = (_a = fitnessState === null || fitnessState === void 0 ? void 0 : fitnessState.hrWorkloadCalibration) === null || _a === void 0 ? void 0 : _a.value;
    const observationMetric = fitnessState === null || fitnessState === void 0 ? void 0 : fitnessState.passiveAerobicObservation;
    return {
        profileFields: {
            age: finiteText(demographics.ageYears),
            weight: finiteText(demographics.bodyMassLbs),
            height: finiteText(demographics.heightInches),
            sex: (_b = demographics.sex) !== null && _b !== void 0 ? _b : "",
            enteredVo2: finiteText((_c = athleteProfile.userEnteredVo2) === null || _c === void 0 ? void 0 : _c.value),
        },
        assessment: assessmentMetric
            ? {
                vo2: `${formatVo2EstimateMlKgMin(assessmentMetric.value)} ml/kg/min`,
                assessedAt: formatDateTime(assessmentMetric.observedAt, options),
                evidence: vo2FitQualityText(assessmentMetric.quality),
                predictedMaxPower: (fitnessState === null || fitnessState === void 0 ? void 0 : fitnessState.predictedMaxWatts)
                    ? `${Math.round(fitnessState.predictedMaxWatts.value)} W`
                    : null,
                calibration: calibration
                    ? `${calibration.points.length} protocol stages · ${Math.round(calibration.observedMinWatts)}–${Math.round(calibration.observedMaxWatts)} W · ${calibrationSourceText(fitnessState)}`
                    : null,
            }
            : null,
        observation: observationMetric
            ? {
                context: observationContext(observationMetric),
                workload: `${Math.round(observationMetric.value.guardedTrendWorkloadWatts)} W in the ${Math.round(observationMetric.value.heartRateWindowMinBpm)}–${Math.round(observationMetric.value.heartRateWindowMaxExclusiveBpm - 1)} bpm window`,
                trend: `${signedPercent(observationMetric.value.guardedTrendChangeFromBaselinePercent)} vs. the observed baseline`,
                evidence: `${observationMetric.evidence.sessionCount} workouts across ${observationMetric.evidence.distinctWorkoutDateCount} days · ${observationQualityText(observationMetric)} · ${workloadSourceText(observationMetric.value.workloadSourceClasses)}`,
                observedAt: formatDateTime(observationMetric.observedAt, options),
            }
            : null,
        personalization: buildPersonalizationStatus(athleteProfile, fitnessState, options),
    };
}
function setText(documentRef, id, value) {
    const element = documentRef.getElementById(id);
    if (element)
        element.textContent = value;
}
function setHidden(documentRef, id, hidden) {
    const element = documentRef.getElementById(id);
    if (element)
        element.hidden = hidden;
}
export function renderProfileFitness(data, documentRef = document, options = {}) {
    var _a, _b, _c;
    const presentation = buildProfileFitnessPresentation(data.athleteProfile, data.fitnessState, options);
    const assessment = presentation.assessment;
    setHidden(documentRef, "fitnessAssessmentEmpty", assessment !== null);
    setHidden(documentRef, "fitnessAssessmentContent", assessment === null);
    if (assessment) {
        setText(documentRef, "assessedVo2", assessment.vo2);
        setText(documentRef, "fitnessAssessedAt", assessment.assessedAt);
        setText(documentRef, "fitnessAssessmentEvidence", assessment.evidence);
        setHidden(documentRef, "predictedMaxPowerRow", assessment.predictedMaxPower === null);
        if (assessment.predictedMaxPower)
            setText(documentRef, "predictedMaxPower", assessment.predictedMaxPower);
        setHidden(documentRef, "fitnessCalibrationRow", assessment.calibration === null);
        if (assessment.calibration)
            setText(documentRef, "fitnessCalibration", assessment.calibration);
    }
    const observation = presentation.observation;
    setHidden(documentRef, "trainingObservationEmpty", observation !== null);
    setHidden(documentRef, "trainingObservationContent", observation === null);
    if (observation) {
        setText(documentRef, "trainingObservationContext", observation.context);
        setText(documentRef, "trainingObservationWorkload", observation.workload);
        setText(documentRef, "trainingObservationTrend", observation.trend);
        setText(documentRef, "trainingObservationEvidence", observation.evidence);
        setText(documentRef, "trainingObservationAt", observation.observedAt);
    }
    const personalization = presentation.personalization;
    setText(documentRef, "personalizationStatusTitle", personalization.title);
    setText(documentRef, "personalizationStatusBody", personalization.body);
    setHidden(documentRef, "personalizationEvidence", !personalization.personalizationEvaluationAvailable);
    if (personalization.personalizationEvaluationAvailable) {
        setText(documentRef, "personalizationSource", (_a = personalization.source) !== null && _a !== void 0 ? _a : "");
        setText(documentRef, "personalizationAssessedAt", (_b = personalization.assessedAt) !== null && _b !== void 0 ? _b : "");
        setText(documentRef, "personalizationCalibration", (_c = personalization.workloadCalibration) !== null && _c !== void 0 ? _c : "");
    }
    setText(documentRef, "personalizationActivation", personalization.workoutPersonalization);
    return presentation;
}
export function loadProfileFitness() {
    if (typeof localStorage === "undefined" || typeof document === "undefined")
        return null;
    return renderProfileFitness(readProfileFitnessData(localStorage));
}
export function registerProfileFitnessGlobals() {
    window.loadProfileFitness = loadProfileFitness;
}
