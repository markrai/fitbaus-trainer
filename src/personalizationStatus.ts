import { PROFILE_WEIGHT_LBS_TO_KG } from "./profile.js";
import type {
  AthleteProfile,
  FitnessState,
  PersonalizedPrescriptionCharacterization,
} from "./types.js";
import { isSupportedVo2EstimatorProtocolPair } from "./vo2Estimator.js";

export type PersonalizationStatusKind = "assessment_missing" | "evaluation_available";

export interface PersonalizationStatus {
  kind: PersonalizationStatusKind;
  assessmentAvailable: boolean;
  personalizationEvaluationAvailable: boolean;
  /** Phase E3 is visibility-only. This value is deliberately not inferred from evidence. */
  activePersonalizationEnabled: false;
  title: string;
  body: string;
  source?: "FitBaus VO₂ assessment";
  assessedAt?: string;
  workloadCalibration?: "Measured power" | "Estimated from verified cadence";
  workoutPersonalization: "Inactive" | "Validation in progress";
}

export interface PersonalizationStatusFormatOptions {
  locale?: string;
  timeZone?: string;
}

export interface PersonalizationHistoryDetail {
  kind: "candidate" | "not_candidate";
  title: "Personalization evaluation recorded";
  body:
    | "This workout contributed data toward validating individualized bike targets."
    | "No individualized workload target was available for this workout.";
}

/** Pure display projection from an already-parsed, persisted E2 characterization. */
export function buildPersonalizationHistoryDetail(
  characterization: PersonalizedPrescriptionCharacterization | null | undefined
): PersonalizationHistoryDetail | null {
  if (!characterization) return null;
  const hasCharacterizedCandidate = characterization.phases.some((phase) =>
    phase.shadowOutcome === "candidate" &&
    phase.characterizationOutcome === "characterized" &&
    phase.candidatePower !== undefined
  );
  return {
    kind: hasCharacterizedCandidate ? "candidate" : "not_candidate",
    title: "Personalization evaluation recorded",
    body: hasCharacterizedCandidate
      ? "This workout contributed data toward validating individualized bike targets."
      : "No individualized workload target was available for this workout.",
  };
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

function assessmentDate(timestamp: string, options: PersonalizationStatusFormatOptions): string {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(options.locale ?? "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(parsed);
}

function qualifyingCalibration(
  profile: AthleteProfile,
  state: FitnessState | null
): "Measured power" | "Estimated from verified cadence" | null {
  if (!state || state.athleteId !== profile.athleteId) return null;
  const metric = state.hrWorkloadCalibration;
  if (!metric || metric.source !== "formal_assessment" || !["moderate", "high"].includes(metric.quality)) return null;
  const calibration = metric.value;
  if (!isSupportedVo2EstimatorProtocolPair(
    metric.algorithm?.id,
    metric.algorithm?.version,
    calibration.protocol.id,
    calibration.protocol.version
  )) return null;
  if (calibration.points.length < 3) return null;
  const age = profile.demographics.ageYears;
  const pounds = profile.demographics.bodyMassLbs;
  if (age === undefined || pounds === undefined) return null;
  if (!nearlyEqual(age, calibration.profileInputSnapshot.ageYears) ||
      !nearlyEqual(pounds * PROFILE_WEIGHT_LBS_TO_KG, calibration.profileInputSnapshot.bodyMassKg)) return null;
  const sources = new Set(calibration.points.map((point) => point.workloadSource));
  if (sources.size !== 1) return null;
  if (sources.has("measured_watts")) return "Measured power";
  if (sources.has("calibrated_at_verified_cadence")) return "Estimated from verified cadence";
  return null;
}

/** Pure athlete-facing projection. It cannot represent active personalized control in E3. */
export function buildPersonalizationStatus(
  profile: AthleteProfile,
  state: FitnessState | null,
  options: PersonalizationStatusFormatOptions = {}
): PersonalizationStatus {
  const workloadCalibration = qualifyingCalibration(profile, state);
  const observedAt = state?.hrWorkloadCalibration?.observedAt;
  if (workloadCalibration && observedAt) {
    return {
      kind: "evaluation_available",
      assessmentAvailable: true,
      personalizationEvaluationAvailable: true,
      activePersonalizationEnabled: false,
      title: "Personalization data available",
      body: "FitBaus can evaluate personalized bike workload targets from your assessment. These targets are currently being validated and do not control your workouts yet.",
      source: "FitBaus VO₂ assessment",
      assessedAt: assessmentDate(observedAt, options),
      workloadCalibration,
      workoutPersonalization: "Validation in progress",
    };
  }
  return {
    kind: "assessment_missing",
    assessmentAvailable: false,
    personalizationEvaluationAvailable: false,
    activePersonalizationEnabled: false,
    title: "Personalized bike targets are not available yet.",
    body: "Complete a FitBaus VO₂ assessment to establish the calibration used for personalization research.",
    workoutPersonalization: "Inactive",
  };
}
