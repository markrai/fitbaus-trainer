import type {
  FitnessMetricQuality,
  PlanBlock,
  Vo2AssessmentPoint,
  Vo2AssessmentReasonCode,
  Vo2AssessmentResult,
  Vo2WorkloadSource,
} from "./types.js";
import { VO2_MIN_ACCEPTED_STAGES, VO2_MIN_ELIGIBLE_STAGES } from "./vo2Estimator.js";
import { VO2_WORKOUT_LABEL } from "./vo2Protocol.js";

export interface Vo2AssessmentPresentation {
  title: string;
  valueText: string;
  body: string;
  detail: string;
  estimated: boolean;
  stages: Vo2StageDiagnosticPresentation[];
}

export interface Vo2StageDiagnosticPresentation {
  stageNumber?: number;
  stageId: string;
  headline: string;
  detail: string;
  eligible: boolean;
}

const REASON_PRIORITY: readonly Vo2AssessmentReasonCode[] = [
  "missing_profile_age",
  "missing_profile_weight",
  "invalid_profile_age",
  "invalid_profile_weight",
  "unsupported_protocol_id",
  "unsupported_protocol_version",
  "unsupported_evidence_schema",
  "too_few_accepted_stages",
  "too_few_eligible_stages",
  "stage_unstable_hr",
  "insufficient_stage_hr_samples",
  "stage_incomplete",
  "missing_stage_hr",
  "cadence_outside_verified_range",
  "insufficient_workload_samples",
  "unverified_performed_workload",
  "invalid_workload",
  "invalid_workload_progression",
  "invalid_hr_progression",
  "hr_below_estimator_range",
  "hr_above_submax_ceiling",
  "nonpositive_slope",
  "unstable_regression",
  "invalid_extrapolation",
  "invalid_estimate",
  "missing_protocol_evidence",
];

function primaryReason(codes: readonly Vo2AssessmentReasonCode[]): Vo2AssessmentReasonCode | undefined {
  for (const code of REASON_PRIORITY) {
    if (codes.includes(code)) return code;
  }
  return codes[0];
}

export function formatVo2EstimateMlKgMin(value: number): string {
  return value.toFixed(1);
}

/** Shared user-facing language for formal VO2 fit/evidence quality. */
export function vo2FitQualityText(quality: FitnessMetricQuality | undefined): string {
  if (quality === "high") return "Strong heart-rate/workload fit";
  if (quality === "moderate") return "Adequate heart-rate/workload fit";
  if (quality === "low") return "Limited heart-rate/workload fit";
  return "Fit quality unavailable";
}

export function vo2SelectorOptionText(): string {
  return VO2_WORKOUT_LABEL + " (up to 30 min)";
}

export function vo2WorkoutBlocksText(blocks: PlanBlock): string {
  return (
    "Warm-Up: " +
    blocks.warm +
    " min · Workout: up to " +
    blocks.sustain +
    " min · Cool-Down: " +
    blocks.cool +
    " min"
  );
}

export function genericWorkoutBlocksText(blocks: PlanBlock): string {
  return "Warm-Up: " + blocks.warm + " min · Workout: " + blocks.sustain + " min · Cool-Down: " + blocks.cool + " min";
}

export function vo2EndWorkoutButtonLabel(isVo2: boolean): string {
  return isVo2 ? "End test" : "Yes, end and save";
}

export function vo2CancelModalTitle(isVo2: boolean): string {
  return isVo2 ? "End test?" : "End workout?";
}

export function vo2CancelModalBody(isVo2: boolean): string {
  return isVo2
    ? "You can cool down, record that you reached your limit, end and save, or keep going."
    : "You can cool down first, end and save now, or keep going.";
}

export function vo2LimitReachedButtonVisible(isVo2: boolean, workStillActive: boolean): boolean {
  return isVo2 && workStillActive;
}

export function vo2HistoryOutcomeText(result: Vo2AssessmentResult | undefined): string | null {
  if (!result) return null;
  if (result.status === "estimated" && result.estimate_ml_kg_min != null && Number.isFinite(result.estimate_ml_kg_min)) {
    return "VO₂ " + formatVo2EstimateMlKgMin(result.estimate_ml_kg_min) + " ml/kg/min";
  }
  return "VO₂ estimate unavailable";
}

function profileMissingDetail(codes: readonly Vo2AssessmentReasonCode[]): string {
  const missingAge = codes.includes("missing_profile_age") || codes.includes("invalid_profile_age");
  const missingWeight = codes.includes("missing_profile_weight") || codes.includes("invalid_profile_weight");
  if (missingAge && missingWeight) {
    return "Your age and body weight are required for this estimate. Add them in Settings → Profile.";
  }
  if (missingAge) {
    return "Your age is required for this estimate. Add it in Settings → Profile.";
  }
  return "Your body weight is required for this estimate. Add it in Settings → Profile.";
}

export function vo2InsufficientDetail(
  result: Pick<Vo2AssessmentResult, "reason_codes" | "accepted_stage_count" | "eligible_stage_count"> &
    Partial<Pick<Vo2AssessmentResult, "diagnostics">>
): string {
  const reason = primaryReason(result.reason_codes);
  switch (reason) {
    case "missing_profile_age":
    case "missing_profile_weight":
    case "invalid_profile_age":
    case "invalid_profile_weight":
      return profileMissingDetail(result.reason_codes);
    case "too_few_accepted_stages":
      return (
        "Only " +
        result.accepted_stage_count +
        " stable work stage" +
        (result.accepted_stage_count === 1 ? " was" : "s were") +
        " completed. At least " +
        VO2_MIN_ACCEPTED_STAGES +
        " are required."
      );
    case "unsupported_evidence_schema":
      return "This assessment uses an unsupported evidence-record version.";
    case "too_few_eligible_stages":
      return eligibleStageFailureDetail(result);
    case "stage_unstable_hr":
      return "One or more work stages did not reach stable heart rate within five minutes.";
    case "insufficient_stage_hr_samples":
      return "One or more work stages did not record enough heart-rate samples to verify stability.";
    case "stage_incomplete":
      return "One or more work stages ended before stability could be evaluated.";
    case "missing_stage_hr":
      return "One or more stages is missing a stable heart-rate reading.";
    case "unverified_performed_workload":
      return "Performed workload could not be validated from bike telemetry.";
    case "insufficient_workload_samples":
      return "There were not enough measured watts or cadence samples to verify performed workload.";
    case "cadence_outside_verified_range":
      return "Cadence was outside the verified range for using the bike's 70-RPM workload calibration.";
    case "invalid_workload":
    case "invalid_workload_progression":
      return "Stage workloads did not increase as required.";
    case "invalid_hr_progression":
    case "nonpositive_slope":
      return "Heart rate did not increase with workload as required.";
    case "hr_below_estimator_range":
      return "Heart rate stayed below the range this estimate can use.";
    case "hr_above_submax_ceiling":
      return "Heart rate was too close to predicted maximum for a submaximal estimate.";
    case "unstable_regression":
      return "The heart-rate response did not form a reliable pattern.";
    case "invalid_extrapolation":
    case "invalid_estimate":
      return "The estimate could not be projected to maximal heart rate from this data.";
    default:
      return "We recorded the test, but there wasn't enough stable workload and heart-rate data to produce a reliable estimate.";
  }
}

function fitQualityLine(result: Vo2AssessmentResult): string {
  return result.fit_quality ? vo2FitQualityText(result.fit_quality) + "." : "";
}

function pointStageNumber(point: Vo2AssessmentPoint): number | undefined {
  if (!("stage_number" in point)) return undefined;
  return Number.isInteger(point.stage_number) && point.stage_number > 0 ? point.stage_number : undefined;
}

function stageReasonText(point: Vo2AssessmentPoint, result: Vo2AssessmentResult): string {
  const reasons = new Set<string>(point.ineligibility_reasons);
  if (reasons.has("hr_above_submax_ceiling")) {
    const ceiling = result.input_snapshot.predicted_hr_max != null
      ? result.input_snapshot.predicted_hr_max * result.diagnostics.estimator_submax_hrmax_fraction
      : undefined;
    return ceiling != null
      ? `steady heart rate reached ${Math.round(point.steady_state_bpm ?? ceiling)} bpm, at or above the ${Math.round(ceiling)} bpm submaximal ceiling`
      : "steady heart rate was above the estimator's submaximal ceiling";
  }
  if (reasons.has("hr_below_estimator_range")) {
    return `steady heart rate was below the ${result.diagnostics.estimator_min_hr_bpm} bpm usable floor`;
  }
  if (reasons.has("cadence_outside_verified_range")) {
    return "cadence was outside the verified 70 ± 5 RPM range and measured watts were unavailable";
  }
  if (reasons.has("insufficient_workload_samples")) {
    return "there were not enough measured watts or cadence samples to verify performed workload";
  }
  if (reasons.has("stage_unstable_hr")) return "heart rate did not stabilize within five minutes";
  if (reasons.has("insufficient_stage_hr_samples")) return "there were not enough heart-rate samples to verify stability";
  if (reasons.has("stage_incomplete")) return "the stage ended before stability could be evaluated";
  if (reasons.has("missing_stage_hr")) return "a steady heart-rate reading was missing";
  if (reasons.has("invalid_workload")) return "the performed workload was invalid";
  if (reasons.has("unverified_performed_workload")) return "performed workload could not be verified";
  return reasons.size > 0 ? "it did not meet the estimator's validity policy" : "no exclusion was recorded";
}

function eligibleStageFailureDetail(
  result: Pick<Vo2AssessmentResult, "accepted_stage_count" | "eligible_stage_count"> &
    Partial<Pick<Vo2AssessmentResult, "diagnostics" | "input_snapshot">>
): string {
  let detail =
    result.accepted_stage_count +
    " stage" +
    (result.accepted_stage_count === 1 ? " reached" : "s reached") +
    " stable heart rate, but only " +
    result.eligible_stage_count +
    (result.eligible_stage_count === 1 ? " was" : " were") +
    " valid for VO₂ estimation. At least " +
    VO2_MIN_ELIGIBLE_STAGES +
    " valid submaximal stages are required.";
  const rejected = result.diagnostics && "stage_points" in result.diagnostics
    ? result.diagnostics.stage_points.find((point) => point.protocol_accepted && !point.estimator_eligible)
    : undefined;
  if (rejected && result.diagnostics && result.input_snapshot) {
    detail += ` Stage ${rejected.stage_number} was excluded because ${stageReasonText(rejected, result as Vo2AssessmentResult)}.`;
  }
  return detail;
}

function workloadSourceText(source: Vo2WorkloadSource | undefined): string {
  if (source === "measured_watts") return "measured watts";
  if (source === "calibrated_at_verified_cadence") return "70-RPM calibration with verified cadence";
  if (source === "prescribed_only") return "prescription only";
  return "unavailable";
}

function passText(value: boolean | undefined): string {
  return value === undefined ? "not assessed" : value ? "passed" : "failed";
}

export function vo2StageDiagnostics(result: Vo2AssessmentResult): Vo2StageDiagnosticPresentation[] {
  const points: readonly Vo2AssessmentPoint[] =
    "stage_points" in result.diagnostics && result.diagnostics.stage_points.length
      ? result.diagnostics.stage_points
      : result.diagnostics.accepted_points ?? [];
  return points.map((point) => {
    const number = pointStageNumber(point);
    const isV2Point = "protocol_stage_status" in point;
    const watts = point.watts ?? point.calibrated_watts_at_70rpm;
    const headline =
      (number != null ? `Stage ${number}` : `Stage record ${point.stage_id}`) +
      (isV2Point ? ` · resistance ${point.prescribed_resistance}` : " · resistance unavailable") +
      (watts != null ? ` · ${Math.round(watts)} W` : "");
    const facts = [
      `Workload: ${workloadSourceText(point.workload_source)}`,
      `Steady HR: ${point.steady_state_bpm != null ? `${Math.round(point.steady_state_bpm)} bpm` : "unavailable"}`,
      `HR stability: ${passText(isV2Point ? point.hr_stability_passed : point.protocol_accepted ? true : undefined)}`,
      `Workload evidence: ${passText(isV2Point ? point.workload_evidence_passed : undefined)}`,
      `Submaximal HR: ${passText(isV2Point ? point.submax_hr_eligible : undefined)}`,
      point.estimator_eligible ? "Eligible" : `Ineligible — ${stageReasonText(point, result)}`,
    ];
    return {
      ...(number != null ? { stageNumber: number } : {}),
      stageId: point.stage_id,
      headline,
      detail: facts.join(" · "),
      eligible: point.estimator_eligible,
    };
  });
}

function workloadSourceLine(result: Vo2AssessmentResult): string {
  const sources = new Set(
    (result.diagnostics.eligible_points ?? [])
      .map((point) => point.workload_source)
      .filter((source): source is NonNullable<typeof source> => source != null)
  );
  if (sources.size === 1 && sources.has("measured_watts")) {
    return "Estimated from your cycling heart-rate response to measured bike workload.";
  }
  if (sources.has("calibrated_at_verified_cadence") && !sources.has("measured_watts")) {
    return "Cadence was verified; workload used the 70-RPM calibration table.";
  }
  return "Estimated from your cycling heart-rate response.";
}

function isHrBoundaryShortfall(
  result: Pick<Vo2AssessmentResult, "reason_codes" | "eligible_stage_count">
): boolean {
  return (
    result.eligible_stage_count < VO2_MIN_ELIGIBLE_STAGES &&
    result.reason_codes.includes("hr_above_submax_ceiling")
  );
}

/**
 * Adaptive refusal: the protocol stopped under the submax HR policy without
 * any observed crossing, i.e. no higher calibrated workload could be
 * justified safely. A live hard-ceiling breach always leaves an incomplete
 * (non-accepted) stage, so requiring every stage to be accepted keeps that
 * case out of this wording.
 */
function isNoSafeWorkloadShortfall(result: Vo2AssessmentResult): boolean {
  if (result.termination_reason !== "submax_hr_ceiling") return false;
  if (result.eligible_stage_count >= VO2_MIN_ELIGIBLE_STAGES) return false;
  if ((result.reason_codes as readonly string[]).includes("hr_above_submax_ceiling")) return false;
  const diagnostics = result.diagnostics;
  if (!("stage_points" in diagnostics)) return false;
  return diagnostics.stage_points.every((point) => point.protocol_accepted);
}

export function vo2AssessmentPresentation(result: Vo2AssessmentResult | undefined): Vo2AssessmentPresentation {
  if (!result) {
    return {
      title: "VO₂ Max Estimate",
      valueText: "",
      body: "No VO₂ assessment was recorded for this workout.",
      detail: "",
      estimated: false,
      stages: [],
    };
  }
  if (result.status === "estimated" && result.estimate_ml_kg_min != null && Number.isFinite(result.estimate_ml_kg_min)) {
    const stages = result.eligible_stage_count || result.stages_used.length;
    return {
      title: "VO₂ Max Estimate",
      valueText: formatVo2EstimateMlKgMin(result.estimate_ml_kg_min) + " ml/kg/min",
      body:
        "Based on " +
        stages +
        " stable stage" +
        (stages === 1 ? "" : "s") +
        ". " +
        workloadSourceLine(result),
      detail: fitQualityLine(result),
      estimated: true,
      stages: vo2StageDiagnostics(result),
    };
  }
  if (isHrBoundaryShortfall(result)) {
    return {
      title: "Not enough submaximal stages to estimate VO₂ max",
      valueText: "",
      body: "We recorded the assessment, but your heart rate reached the test's submaximal limit before we collected enough usable stages for a reliable estimate.",
      detail: vo2InsufficientDetail(result),
      estimated: false,
      stages: vo2StageDiagnostics(result),
    };
  }
  if (isNoSafeWorkloadShortfall(result)) {
    return {
      title: "Not enough submaximal stages to estimate VO₂ max",
      valueText: "",
      body: "We recorded the assessment, but the test stopped because no higher workload could be selected safely while staying within the submaximal test range, so too few usable stages were collected for a reliable estimate.",
      detail: vo2InsufficientDetail(result),
      estimated: false,
      stages: vo2StageDiagnostics(result),
    };
  }
  return {
    title: "Not enough data to estimate VO₂ max",
    valueText: "",
    body:
      result.accepted_stage_count >= VO2_MIN_ACCEPTED_STAGES && result.eligible_stage_count < VO2_MIN_ELIGIBLE_STAGES
        ? `${result.accepted_stage_count} stages reached stable heart rate, but only ${result.eligible_stage_count} were valid for VO₂ estimation.`
        : "We recorded the test, but there wasn't enough stable workload and heart-rate data to produce a reliable estimate.",
    detail: vo2InsufficientDetail(result),
    estimated: false,
    stages: vo2StageDiagnostics(result),
  };
}
