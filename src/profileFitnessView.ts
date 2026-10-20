import { readFitnessState, type FitnessStateStorage } from "./fitnessState.js";
import { loadAthleteProfile } from "./profile.js";
import type {
  AthleteProfile,
  BikeWattsProvenance,
  FitnessState,
  PassiveAerobicObservationMetric,
} from "./types.js";
import { formatVo2EstimateMlKgMin, vo2FitQualityText } from "./vo2AssessmentView.js";
import { buildPersonalizationStatus, type PersonalizationStatus } from "./personalizationStatus.js";

export interface ProfileFitnessData {
  athleteProfile: AthleteProfile;
  fitnessState: FitnessState | null;
}

export interface ProfileFitnessPresentation {
  profileFields: {
    age: string;
    weight: string;
    height: string;
    sex: string;
    enteredVo2: string;
  };
  assessment: null | {
    vo2: string;
    assessedAt: string;
    evidence: string;
    predictedMaxPower: string | null;
    calibration: string | null;
  };
  observation: null | {
    context: string;
    workload: string;
    trend: string;
    evidence: string;
    observedAt: string;
  };
  personalization: PersonalizationStatus;
}

export interface PresentationFormatOptions {
  locale?: string;
  timeZone?: string;
}

function finiteText(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function formatDateTime(timestamp: string, options: PresentationFormatOptions): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(options.locale ?? "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

function workloadSourceText(sources: readonly BikeWattsProvenance[]): string {
  const unique = new Set(sources);
  if (unique.size === 1 && unique.has("measured_watts")) return "measured bike power";
  if (unique.size === 1 && unique.has("calibrated_watts")) return "cadence-based calibrated power";
  return "measured and cadence-based power";
}

function calibrationSourceText(state: FitnessState): string {
  const sources = state.hrWorkloadCalibration?.value.points.map((point) =>
    point.workloadSource === "measured_watts" ? "measured_watts" : "calibrated_watts"
  ) ?? [];
  return workloadSourceText(sources);
}

function signedPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}

function observationContext(metric: PassiveAerobicObservationMetric): string {
  return metric.value.intensityId === "threshold" ? "Threshold workouts" : "Aerobic-base workouts";
}

function observationQualityText(metric: PassiveAerobicObservationMetric): string {
  if (metric.quality === "high") return "Strong consistency";
  if (metric.quality === "moderate") return "Adequate consistency";
  return "Limited consistency";
}

/** One ownership-safe read for everything shown in Settings -> Profile. */
export function readProfileFitnessData(storage?: FitnessStateStorage): ProfileFitnessData {
  const athleteProfile = loadAthleteProfile(storage);
  return {
    athleteProfile,
    fitnessState: readFitnessState(athleteProfile.athleteId, storage),
  };
}

/** Pure presentation projection. It does not write profile or fitness state. */
export function buildProfileFitnessPresentation(
  athleteProfile: AthleteProfile,
  fitnessState: FitnessState | null,
  options: PresentationFormatOptions = {}
): ProfileFitnessPresentation {
  const demographics = athleteProfile.demographics;
  const assessmentMetric = fitnessState?.vo2Max;
  const calibration = fitnessState?.hrWorkloadCalibration?.value;
  const observationMetric = fitnessState?.passiveAerobicObservation;

  return {
    profileFields: {
      age: finiteText(demographics.ageYears),
      weight: finiteText(demographics.bodyMassLbs),
      height: finiteText(demographics.heightInches),
      sex: demographics.sex ?? "",
      enteredVo2: finiteText(athleteProfile.userEnteredVo2?.value),
    },
    assessment: assessmentMetric
      ? {
          vo2: `${formatVo2EstimateMlKgMin(assessmentMetric.value)} ml/kg/min`,
          assessedAt: formatDateTime(assessmentMetric.observedAt, options),
          evidence: vo2FitQualityText(assessmentMetric.quality),
          predictedMaxPower: fitnessState?.predictedMaxWatts
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

function setText(documentRef: Document, id: string, value: string): void {
  const element = documentRef.getElementById(id);
  if (element) element.textContent = value;
}

function setHidden(documentRef: Document, id: string, hidden: boolean): void {
  const element = documentRef.getElementById(id);
  if (element) element.hidden = hidden;
}

export function renderProfileFitness(
  data: ProfileFitnessData,
  documentRef: Document = document,
  options: PresentationFormatOptions = {}
): ProfileFitnessPresentation {
  const presentation = buildProfileFitnessPresentation(data.athleteProfile, data.fitnessState, options);
  const assessment = presentation.assessment;
  setHidden(documentRef, "fitnessAssessmentEmpty", assessment !== null);
  setHidden(documentRef, "fitnessAssessmentContent", assessment === null);
  if (assessment) {
    setText(documentRef, "assessedVo2", assessment.vo2);
    setText(documentRef, "fitnessAssessedAt", assessment.assessedAt);
    setText(documentRef, "fitnessAssessmentEvidence", assessment.evidence);
    setHidden(documentRef, "predictedMaxPowerRow", assessment.predictedMaxPower === null);
    if (assessment.predictedMaxPower) setText(documentRef, "predictedMaxPower", assessment.predictedMaxPower);
    setHidden(documentRef, "fitnessCalibrationRow", assessment.calibration === null);
    if (assessment.calibration) setText(documentRef, "fitnessCalibration", assessment.calibration);
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
    setText(documentRef, "personalizationSource", personalization.source ?? "");
    setText(documentRef, "personalizationAssessedAt", personalization.assessedAt ?? "");
    setText(documentRef, "personalizationCalibration", personalization.workloadCalibration ?? "");
  }
  setText(documentRef, "personalizationActivation", personalization.workoutPersonalization);
  return presentation;
}

export function loadProfileFitness(): ProfileFitnessPresentation | null {
  if (typeof localStorage === "undefined" || typeof document === "undefined") return null;
  return renderProfileFitness(readProfileFitnessData(localStorage));
}

export function registerProfileFitnessGlobals(): void {
  (window as any).loadProfileFitness = loadProfileFitness;
}
