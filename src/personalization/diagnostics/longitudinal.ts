/**
 * E3 threshold transfer series: read-time longitudinal projection over frozen
 * E1/E2/summary fields, grouped by exact calibration x provenance x machine
 * cohort. Descriptive only; it authorizes nothing.
 */

import { canonicalMedian } from "../../stats.js";
import type { PersonalizedPrescriptionCharacterization } from "../../types.js";
import type { FrozenAssessmentDiagnosticContext, FrozenWorkoutDiagnosticContext, ThresholdCalibrationIdentity, ThresholdLongitudinalAnalysis, ThresholdLongitudinalCohort, ThresholdLongitudinalCohortKey, ThresholdLongitudinalExclusion, ThresholdLongitudinalExclusionReason, ThresholdLongitudinalSession } from "./model.js";

/** Population CV for the complete descriptive cohort, not a reliability score. */
function coefficientOfVariation(values: readonly number[]): number | undefined {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (finite.length < 2) return undefined;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  if (mean === 0) return undefined;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function calibrationIdentity(
  context: FrozenAssessmentDiagnosticContext | null | undefined
): ThresholdCalibrationIdentity | null {
  const ids = context?.evidenceSessionIds;
  if (!context || !Array.isArray(ids) || ids.length === 0 ||
      ids.some((value) => typeof value !== "string" || value.trim() === "") ||
      !context.algorithm || typeof context.algorithm.id !== "string" || context.algorithm.id.trim() === "" ||
      !positiveInteger(context.algorithm.version) ||
      !context.protocol || typeof context.protocol.id !== "string" || context.protocol.id.trim() === "" ||
      !positiveInteger(context.protocol.version) ||
      (context.calibrationProvenance !== "measured_watts" &&
       context.calibrationProvenance !== "calibrated_at_verified_cadence" &&
       context.calibrationProvenance !== "mixed") ||
      typeof context.observedAt !== "string" || !Number.isFinite(Date.parse(context.observedAt))) return null;
  return {
    evidenceSessionIds: [...new Set(ids)].sort(lexicalCompare),
    estimator: { ...context.algorithm },
    protocol: { ...context.protocol },
    workloadProvenance: context.calibrationProvenance,
    observedAt: context.observedAt,
  };
}

/** E2 createdAt is frozen from WorkoutSummary.endedAt during finalization. */
function assessmentAgeDays(createdAt: string, observedAt: string | undefined): number | null {
  if (!observedAt) return null;
  const created = Date.parse(createdAt);
  const assessed = Date.parse(observedAt);
  if (!Number.isFinite(created) || !Number.isFinite(assessed) || created < assessed) return null;
  return Math.round((created - assessed) / (24 * 60 * 60 * 1000));
}

function canonicalCohortKey(key: ThresholdLongitudinalCohortKey): string {
  return JSON.stringify({
    athleteId: key.athleteId,
    calibration: {
      evidenceSessionIds: key.calibration.evidenceSessionIds,
      estimator: key.calibration.estimator,
      protocol: key.calibration.protocol,
      workloadProvenance: key.calibration.workloadProvenance,
      observedAt: key.calibration.observedAt,
    },
    observedPowerProvenance: key.observedPowerProvenance,
    machineId: key.machineId,
    machineProfileVersion: key.machineProfileVersion,
  });
}

type ThresholdLongitudinalDerivation =
  | { kind: "eligible"; session: ThresholdLongitudinalSession }
  | { kind: "ineligible"; exclusion: ThresholdLongitudinalExclusion }
  | { kind: "not_applicable" };

function deriveThresholdLongitudinalSession(
  record: PersonalizedPrescriptionCharacterization,
  assessment: FrozenAssessmentDiagnosticContext | null,
  workout: FrozenWorkoutDiagnosticContext | null
): ThresholdLongitudinalDerivation {
  if (record.activity !== "bike") return { kind: "not_applicable" };
  const phases = record.phases.filter((phase) =>
    phase.kind === "work" && phase.intensityId === "threshold" &&
    phase.characterizationOutcome === "characterized" && phase.candidatePower && phase.comparison
  );
  if (phases.length === 0) return { kind: "not_applicable" };
  const excluded = (reason: ThresholdLongitudinalExclusionReason): ThresholdLongitudinalDerivation => ({
    kind: "ineligible",
    exclusion: { workoutSessionId: record.workoutSessionId, createdAt: record.createdAt, reason },
  });
  // A multi-interval workout needs an explicit within-session aggregation policy;
  // E3 must not invent one by selecting a convenient phase.
  if (phases.length > 1) return excluded("multiple_threshold_phases");
  const identity = calibrationIdentity(assessment);
  if (!identity || record.calibrationWorkloadProvenance !== identity.workloadProvenance) {
    return excluded("incomplete_calibration_identity");
  }
  if (!workout || typeof workout.machineId !== "string" || workout.machineId.trim() === "") {
    return excluded("missing_machine_identity");
  }
  if (!positiveInteger(workout.machineProfileVersion)) return excluded("missing_machine_profile_identity");
  const phase = phases[0];
  const values = [
    phase.candidatePower!.minWatts,
    phase.candidatePower!.maxWatts,
    phase.comparison!.candidateMidpointWatts,
    phase.comparison!.observedInBandMedianWatts,
    phase.comparison!.signedDifferenceWatts,
    phase.comparison!.absoluteDifferenceWatts,
    phase.comparison!.signedDifferencePercent,
    phase.controllerContext.saturationRatio,
  ];
  if (!values.every((value) => Number.isFinite(value)) ||
      phase.candidatePower!.maxWatts < phase.candidatePower!.minWatts ||
      phase.comparison!.absoluteDifferenceWatts < 0 ||
      phase.controllerContext.saturationRatio < 0 || phase.controllerContext.saturationRatio > 1) {
    return excluded("invalid_longitudinal_metrics");
  }
  const width = phase.candidatePower!.maxWatts - phase.candidatePower!.minWatts;
  return {
    kind: "eligible",
    session: {
      workoutSessionId: record.workoutSessionId,
      createdAt: record.createdAt,
      athleteId: record.athleteId,
      calibrationIdentity: identity,
      observedPowerProvenance: phase.observedPowerProvenance,
      machineId: workout.machineId,
      machineProfileVersion: workout.machineProfileVersion,
      domainBucket: phase.candidateDomainMargins?.bucket ?? "not_applicable",
      candidateMinWatts: phase.candidatePower!.minWatts,
      candidateMaxWatts: phase.candidatePower!.maxWatts,
      candidateWidthWatts: width,
      candidateMidpointWatts: phase.comparison!.candidateMidpointWatts,
      observedSettledWatts: phase.comparison!.observedInBandMedianWatts,
      signedDifferenceWatts: phase.comparison!.signedDifferenceWatts,
      absoluteDifferenceWatts: phase.comparison!.absoluteDifferenceWatts,
      signedDifferencePercent: phase.comparison!.signedDifferencePercent,
      widthNormalizedAbsoluteError: width > 0 ? phase.comparison!.absoluteDifferenceWatts / width : null,
      saturationRatio: phase.controllerContext.saturationRatio,
      assessmentAgeDays: assessmentAgeDays(record.createdAt, identity.observedAt),
    },
  };
}

/**
 * Session-level transfer series for characterized bike work + threshold.
 * Uses frozen E1/E2/summary fields only. Inside-candidate rate is intentionally omitted.
 */
export function buildThresholdLongitudinalAnalysis(
  records: readonly PersonalizedPrescriptionCharacterization[],
  assessmentContexts: Readonly<Record<string, FrozenAssessmentDiagnosticContext>> = {},
  workoutContexts: Readonly<Record<string, FrozenWorkoutDiagnosticContext>> = {}
): ThresholdLongitudinalAnalysis {
  const sessions: ThresholdLongitudinalSession[] = [];
  const exclusions: ThresholdLongitudinalExclusion[] = [];
  for (const record of records) {
    const result = deriveThresholdLongitudinalSession(
      record,
      assessmentContexts[record.workoutSessionId] ?? null,
      workoutContexts[record.workoutSessionId] ?? null
    );
    if (result.kind === "eligible") sessions.push(result.session);
    if (result.kind === "ineligible") exclusions.push(result.exclusion);
  }
  sessions.sort((a, b) => lexicalCompare(a.createdAt, b.createdAt) ||
    lexicalCompare(a.workoutSessionId, b.workoutSessionId));
  exclusions.sort((a, b) => lexicalCompare(a.createdAt, b.createdAt) ||
    lexicalCompare(a.workoutSessionId, b.workoutSessionId) || lexicalCompare(a.reason, b.reason));
  const groups = new Map<string, ThresholdLongitudinalSession[]>();
  for (const session of sessions) {
    const key = canonicalCohortKey({
      athleteId: session.athleteId,
      calibration: session.calibrationIdentity,
      observedPowerProvenance: session.observedPowerProvenance,
      machineId: session.machineId,
      machineProfileVersion: session.machineProfileVersion,
    });
    const list = groups.get(key) ?? [];
    list.push(session);
    groups.set(key, list);
  }
  const cohorts = [...groups.entries()].sort(([a], [b]) => lexicalCompare(a, b)).map(([, list]) => {
    const signed = list.map((session) => session.signedDifferenceWatts);
    const absolute = list.map((session) => session.absoluteDifferenceWatts);
    const widths = list.map((session) => session.candidateWidthWatts);
    const normalized = list.flatMap((session) =>
      session.widthNormalizedAbsoluteError === null ? [] : [session.widthNormalizedAbsoluteError]);
    const observed = list.map((session) => session.observedSettledWatts);
    const ages = list.flatMap((session) => session.assessmentAgeDays === null ? [] : [session.assessmentAgeDays]);
    const saturated = list.filter((session) => session.saturationRatio > 0).length;
    const cohort: ThresholdLongitudinalCohort = {
      key: {
        athleteId: list[0].athleteId,
        calibration: list[0].calibrationIdentity,
        observedPowerProvenance: list[0].observedPowerProvenance,
        machineId: list[0].machineId,
        machineProfileVersion: list[0].machineProfileVersion,
      },
      sessionCount: list.length,
      sessions: list,
    };
    const medianSigned = canonicalMedian(signed);
    const medianAbsolute = canonicalMedian(absolute);
    const medianWidth = canonicalMedian(widths);
    const medianNormalized = canonicalMedian(normalized);
    const cv = coefficientOfVariation(observed);
    const medianAge = canonicalMedian(ages);
    if (medianSigned !== undefined) cohort.medianSignedDifferenceWatts = medianSigned;
    if (medianAbsolute !== undefined) cohort.medianAbsoluteDifferenceWatts = medianAbsolute;
    if (medianWidth !== undefined) cohort.medianCandidateWidthWatts = medianWidth;
    if (medianNormalized !== undefined) cohort.medianWidthNormalizedAbsoluteError = medianNormalized;
    if (cv !== undefined) cohort.observedSettledWattsCv = cv;
    if (list.length > 0) cohort.saturationIncidence = saturated / list.length;
    if (medianAge !== undefined) cohort.medianAssessmentAgeDays = medianAge;
    return cohort;
  });
  return { sessionCount: sessions.length, cohorts, exclusions };
}
