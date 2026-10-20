import {
  aggregatePersonalizedPrescriptionCharacterizations,
  personalizedPrescriptionDiagnosticRows,
  type PersonalizedPrescriptionCharacterizationAggregateV1,
  type PersonalizedPrescriptionCharacterizationAggregateV2,
} from "./personalizedPrescriptionCharacterization.js";
import { buildPhasePerformedLoadViews, type PhasePerformedLoadView } from "./performedLoad.js";
// One-way, read-only dependency: diagnostics consume E4A; E4A imports nothing.
import {
  E4A_CURRENT_SCIENTIFIC_ASSESSMENT_POLICY,
  assessPersonalizedWorkloadEvidence,
  buildSubjectEvidence,
  discoverDiagnosticSubjects,
  scientificSubjectKey,
  type ScientificAssessment,
} from "./personalizationScientificAssessment.js";
import { canonicalMedian } from "./stats.js";
import type { ScientificSessionEvidenceV2 } from "./scientificSessionEvidence.js";
import {
  LEGACY_HR_TARGET_RESOLVER_ID,
  LEGACY_HR_TARGET_RESOLVER_VERSION,
  type PersonalizedPrescriptionCharacterizationExclusionReasonV1,
  type PersonalizedPrescriptionCharacterization,
  type PersonalizedPrescriptionCharacterizationV1,
  type PersonalizedPrescriptionCharacterizationV2,
  type PersonalizedPrescriptionEvaluationV1,
  type PersonalizedPrescriptionFormalAssessmentProvenanceV2,
  type PersonalizedPrescriptionHeldWorkloadForwardResponseV1,
  type PersonalizedPrescriptionPhaseCharacterizationV1,
  type PersonalizedPrescriptionWorkloadProvenanceV1,
  type WorkoutExecutionProvenanceV1,
  type WorkoutSummary,
} from "./types.js";

export const PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS: readonly PersonalizedPrescriptionCharacterizationExclusionReasonV1[] = [
  "phase_too_short",
  "missing_telemetry",
  "insufficient_hr_coverage",
  "insufficient_power_coverage",
  "insufficient_joint_coverage",
  "insufficient_settled_in_band_evidence",
  "unsupported_power_provenance",
  "phase_evidence_unavailable",
];

export interface PersonalizationDiagnosticsFilters {
  workoutIntent: string;
  intensity: string;
  calibrationProvenance: string;
  observedPowerProvenance: string;
  assessmentQuality: string;
  domainBucket: string;
}

export const EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS: PersonalizationDiagnosticsFilters = {
  workoutIntent: "all",
  intensity: "all",
  calibrationProvenance: "all",
  observedPowerProvenance: "all",
  assessmentQuality: "all",
  domainBucket: "all",
};

export const PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V1 = 1 as const;
export const PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V2 = 2 as const;
export const PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V3 = 3 as const;
export const PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION =
  PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V3;

export interface PersonalizationDiagnosticsFilterOptions {
  workoutIntent: string[];
  intensity: string[];
  calibrationProvenance: string[];
  observedPowerProvenance: string[];
  assessmentQuality: string[];
  domainBucket: string[];
}

export interface PersonalizationDiagnosticPresentationRow {
  index: number;
  date: string;
  workout: string;
  phase: string;
  legacyHeartRate: string;
  candidateWatts: string;
  observedInBandWatts: number | null;
  deltaWatts: number | null;
  hrCoveragePercent: number;
  powerCoveragePercent: number;
  hrInsideTargetPercent: number | null;
  saturationPercent: number;
  calibrationProvenance: string;
  formalAssessmentProvenance: string;
  observedPowerProvenance: string;
  assessmentDomain: string;
  agreement: string;
  outcome: string;
  exclusion: string;
  assessmentContext: FrozenAssessmentDiagnosticContext | null;
  workoutContext: FrozenWorkoutDiagnosticContext | null;
  /** Durable WorkoutResponse observation only; never used to generate E1 candidates. */
  performedLoadPhase: PhasePerformedLoadView | null;
  /** Frozen execution provenance for the workout; runtime diagnostics only, never exported. */
  executionProvenance: WorkoutExecutionProvenanceV1 | null;
  record: PersonalizedPrescriptionCharacterization;
  phaseRecord: PersonalizedPrescriptionPhaseCharacterizationV1;
}

export interface PersonalizationEvidenceCollectionSummary {
  completedWorkoutsWithE2: number;
  candidatePhases: number;
  evaluableCandidatePhases: number;
  measuredToMeasuredObservations: number;
  cadenceCalibratedObservations: number;
  aerobicBaseCandidatePhases: number;
  aerobicVolumeCandidatePhases: number;
  interiorCandidatePhases: number;
  edgeCandidatePhases: number;
  saturatedCandidatePhases: number;
  saturationDeterminateCandidatePhases: number;
  saturationIncidence?: number;
  exclusionCounts: Record<PersonalizedPrescriptionCharacterizationExclusionReasonV1, number>;
}

/**
 * All-record E2 v3 held-workload forward-response counts. Phase medians are
 * summarized across phases; filters never affect this summary. Descriptive only.
 */
export interface PersonalizationHeldWorkloadForwardSummary {
  recordsWithHeldWorkloadEvidence: number;
  phasesWithHeldWorkloadSummary: number;
  characterizedPhases: number;
  measuredWattsCharacterizedPhases: number;
  calibratedWattsCharacterizedPhases: number;
  stableWindowCount: number;
  qualifyingWindowCount: number;
  qualifyingDurationSec: number;
  outsideCalibrationDomainSeconds: number;
  medianPhaseSignedErrorBpm?: number;
  medianPhaseAbsoluteErrorBpm?: number;
}

/** All-record execution-provenance counts. Descriptive only; filters never affect it. */
export interface PersonalizationExecutionProvenanceSummary {
  workoutsWithE2: number;
  workoutsWithProvenance: number;
  frozenMachineSelected: number;
  selectionChangedDuringWorkout: number;
  calibrationMachineAvailable: number;
  calibrationMachineUnavailable: number;
  calibrationMachineIntegrityFailures: number;
  sameMachineAndProfile: number;
  differentMachine: number;
  sameMachineDifferentProfile: number;
  incompleteActuationCapture: number;
}

/** One workout's E4A v2 join, summarized for developer diagnostics. */
export interface PersonalizationHeldActuationContextRow {
  workoutSessionId: string;
  createdAt: string;
  machineComparison: ScientificSessionEvidenceV2["machineComparison"];
  actuationCapture: ScientificSessionEvidenceV2["actuationCapture"];
  phaseCount: number;
  qualifyingWindowCount: number;
  qualifyingDurationSec: number;
  timedJoin: string;
  contexts: Record<"automatic_selected" | "programmatic_selected" | "no_app_selector_observed" | "unknown",
    { windowCount: number; durationSec: number }> | null;
}

export interface PersonalizationDiagnosticsModel {
  filters: PersonalizationDiagnosticsFilters;
  filterOptions: PersonalizationDiagnosticsFilterOptions;
  sourceRecordCount: number;
  records: PersonalizedPrescriptionCharacterization[];
  aggregate: PersonalizedPrescriptionCharacterizationAggregateV2;
  rows: PersonalizationDiagnosticPresentationRow[];
  exclusionCounts: Record<PersonalizedPrescriptionCharacterizationExclusionReasonV1, number>;
  evidenceCollectionSummary: PersonalizationEvidenceCollectionSummary;
  thresholdLongitudinal: ThresholdLongitudinalAnalysis;
  /** Runtime-only; never exported. */
  heldWorkloadForward: PersonalizationHeldWorkloadForwardSummary;
  /** Runtime-only; never exported. */
  executionProvenance: PersonalizationExecutionProvenanceSummary;
  /** Runtime-only E4A v2 join rows (one per workout); never exported. */
  heldActuationContext: PersonalizationHeldActuationContextRow[];
  /**
   * Runtime-only E4A scientific assessments under the frozen production
   * policy. Developer diagnostics only: never exported, never persisted,
   * `runtimeAuthority: false`. Empty when no `evaluatedAt` was supplied.
   */
  scientificAssessments: ScientificAssessment[];
}

export interface TrustedWorkoutHistoryRow {
  summary: WorkoutSummary;
}

export interface FrozenAssessmentDiagnosticContext {
  observedAt: string;
  quality: string;
  calibrationProvenance: PersonalizedPrescriptionWorkloadProvenanceV1;
  observedMinHeartRateBpm: number;
  observedMaxHeartRateBpm: number;
  observedMinWatts: number;
  observedMaxWatts: number;
  fitnessStateSchemaVersion?: number;
  algorithm?: { id: string; version: number };
  protocol?: { id: string; version: number };
  evidenceSessionIds?: string[];
}

export interface FrozenWorkoutDiagnosticContext {
  appVersion: string | null;
  machineId: string | null;
  machineProfileVersion: number | null;
  activePrescriptionSchemaVersion: number | null;
  shadowSchemaVersion: number | null;
  characterizationSchemaVersion: number;
}

/**
 * Frozen formal-assessment identity used by the read-time E3 projection.
 * Regression coefficients plus FitnessState container schema/timestamps are
 * deliberately excluded: the evidence set plus versioned estimator/protocol
 * contract defines the deterministic calibration, while workload provenance
 * distinguishes its units.
 */
export interface ThresholdCalibrationIdentity {
  evidenceSessionIds: string[];
  estimator: PersonalizedPrescriptionFormalAssessmentProvenanceV2["algorithm"];
  protocol: PersonalizedPrescriptionFormalAssessmentProvenanceV2["protocol"];
  workloadProvenance: PersonalizedPrescriptionWorkloadProvenanceV1;
  observedAt: string;
}

export interface ThresholdLongitudinalCohortKey {
  athleteId: string;
  calibration: ThresholdCalibrationIdentity;
  observedPowerProvenance: PersonalizedPrescriptionPhaseCharacterizationV1["observedPowerProvenance"];
  machineId: string;
  machineProfileVersion: number;
}

export type ThresholdLongitudinalExclusionReason =
  | "multiple_threshold_phases"
  | "incomplete_calibration_identity"
  | "missing_machine_identity"
  | "missing_machine_profile_identity"
  | "invalid_longitudinal_metrics";

export interface ThresholdLongitudinalExclusion {
  workoutSessionId: string;
  createdAt: string;
  reason: ThresholdLongitudinalExclusionReason;
}

export interface ThresholdLongitudinalSession {
  workoutSessionId: string;
  createdAt: string;
  athleteId: string;
  calibrationIdentity: ThresholdCalibrationIdentity;
  observedPowerProvenance: PersonalizedPrescriptionPhaseCharacterizationV1["observedPowerProvenance"];
  machineId: string;
  machineProfileVersion: number;
  domainBucket: string;
  candidateMinWatts: number;
  candidateMaxWatts: number;
  candidateWidthWatts: number;
  candidateMidpointWatts: number;
  observedSettledWatts: number;
  signedDifferenceWatts: number;
  absoluteDifferenceWatts: number;
  signedDifferencePercent: number;
  widthNormalizedAbsoluteError: number | null;
  saturationRatio: number;
  assessmentAgeDays: number | null;
}

export interface ThresholdLongitudinalCohort {
  key: ThresholdLongitudinalCohortKey;
  sessionCount: number;
  sessions: ThresholdLongitudinalSession[];
  medianSignedDifferenceWatts?: number;
  medianAbsoluteDifferenceWatts?: number;
  medianCandidateWidthWatts?: number;
  medianWidthNormalizedAbsoluteError?: number;
  observedSettledWattsCv?: number;
  saturationIncidence?: number;
  medianAssessmentAgeDays?: number;
}

export interface ThresholdLongitudinalAnalysis {
  sessionCount: number;
  cohorts: ThresholdLongitudinalCohort[];
  exclusions: ThresholdLongitudinalExclusion[];
}

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

function phaseDimensions(record: PersonalizedPrescriptionCharacterization, phase: PersonalizedPrescriptionPhaseCharacterizationV1) {
  return {
    workoutIntent: record.workoutIntent,
    intensity: phase.intensityId ?? "unspecified",
    calibrationProvenance: record.calibrationWorkloadProvenance ?? "unavailable",
    observedPowerProvenance: phase.observedPowerProvenance,
    assessmentQuality: record.formalAssessmentQuality ?? "unavailable",
    domainBucket: phase.candidateDomainMargins?.bucket ?? "not_applicable",
  };
}

function phaseMatchesFilters(
  record: PersonalizedPrescriptionCharacterization,
  phase: PersonalizedPrescriptionPhaseCharacterizationV1,
  filters: PersonalizationDiagnosticsFilters
): boolean {
  const dimensions = phaseDimensions(record, phase);
  return (filters.workoutIntent === "all" || filters.workoutIntent === dimensions.workoutIntent) &&
    (filters.intensity === "all" || filters.intensity === dimensions.intensity) &&
    (filters.calibrationProvenance === "all" || filters.calibrationProvenance === dimensions.calibrationProvenance) &&
    (filters.observedPowerProvenance === "all" || filters.observedPowerProvenance === dimensions.observedPowerProvenance) &&
    (filters.assessmentQuality === "all" || filters.assessmentQuality === dimensions.assessmentQuality) &&
    (filters.domainBucket === "all" || filters.domainBucket === dimensions.domainBucket);
}

function options(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function personalizationDiagnosticsFilterOptions(
  records: readonly PersonalizedPrescriptionCharacterization[]
): PersonalizationDiagnosticsFilterOptions {
  const dimensions = records.flatMap((record) => record.phases.map((phase) => phaseDimensions(record, phase)));
  return {
    workoutIntent: options(dimensions.map((value) => value.workoutIntent)),
    intensity: options(dimensions.map((value) => value.intensity)),
    calibrationProvenance: options(dimensions.map((value) => value.calibrationProvenance)),
    observedPowerProvenance: options(dimensions.map((value) => value.observedPowerProvenance)),
    assessmentQuality: options(dimensions.map((value) => value.assessmentQuality)),
    domainBucket: options(dimensions.map((value) => value.domainBucket)),
  };
}

/**
 * Consumes only getAllWorkoutSummaries() output, after its strict E1/E2 readers.
 * This function deliberately contains no parser and never reads IndexedDB itself.
 */
export function extractTrustedPersonalizationCharacterizations(
  history: readonly TrustedWorkoutHistoryRow[],
  currentAthleteId: string
): PersonalizedPrescriptionCharacterization[] {
  return history.flatMap(({ summary }) => {
    const evaluation = summary.shadow_prescription_evaluation;
    const record = summary.shadow_prescription_characterization;
    if (!evaluation || !record || summary.athlete_id !== currentAthleteId) return [];
    if (record.athleteId !== currentAthleteId || evaluation.athleteId !== currentAthleteId) return [];
    if (record.workoutSessionId !== summary.external_session_id) return [];
    if (record.workoutSelector !== summary.day || evaluation.workoutSelector !== summary.day) return [];
    if (record.activity !== summary.activity) return [];
    return [record];
  });
}

export function extractTrustedPersonalizationAssessmentContexts(
  history: readonly TrustedWorkoutHistoryRow[],
  currentAthleteId: string
): Record<string, FrozenAssessmentDiagnosticContext> {
  const contexts: Record<string, FrozenAssessmentDiagnosticContext> = {};
  for (const { summary } of history) {
    const evaluation = summary.shadow_prescription_evaluation as PersonalizedPrescriptionEvaluationV1 | undefined;
    const record = summary.shadow_prescription_characterization;
    if (!evaluation || !record || summary.athlete_id !== currentAthleteId ||
        record.athleteId !== currentAthleteId || evaluation.athleteId !== currentAthleteId ||
        record.workoutSessionId !== summary.external_session_id ||
        record.workoutSelector !== summary.day || evaluation.workoutSelector !== summary.day ||
        record.activity !== summary.activity || evaluation.activity !== summary.activity) continue;
    const evidence = evaluation.fitnessEvidenceSnapshot;
    if (!evidence || evidence.calibration.points.length === 0) continue;
    const heartRates = evidence.calibration.points.map((point) => point.heartRateBpm);
    contexts[record.workoutSessionId] = {
      observedAt: evidence.metricObservedAt,
      quality: evidence.quality,
      calibrationProvenance: evidence.calibration.workloadProvenance,
      observedMinHeartRateBpm: Math.min(...heartRates),
      observedMaxHeartRateBpm: Math.max(...heartRates),
      observedMinWatts: evidence.calibration.observedMinWatts,
      observedMaxWatts: evidence.calibration.observedMaxWatts,
      ...(evidence.fitnessStateSchemaVersion !== undefined
        ? { fitnessStateSchemaVersion: evidence.fitnessStateSchemaVersion } : {}),
      ...(evidence.algorithm ? { algorithm: { ...evidence.algorithm } } : {}),
      ...(evidence.calibration.protocol ? { protocol: { ...evidence.calibration.protocol } } : {}),
      ...(evidence.evidenceSessionIds ? { evidenceSessionIds: [...evidence.evidenceSessionIds] } : {}),
    };
  }
  return contexts;
}

/** Existing local workout metadata only; no device or identifier is synthesized. */
export function extractTrustedPersonalizationWorkoutContexts(
  history: readonly TrustedWorkoutHistoryRow[],
  currentAthleteId: string
): Record<string, FrozenWorkoutDiagnosticContext> {
  const contexts: Record<string, FrozenWorkoutDiagnosticContext> = {};
  for (const { summary } of history) {
    const evaluation = summary.shadow_prescription_evaluation;
    const record = summary.shadow_prescription_characterization;
    if (!evaluation || !record || summary.athlete_id !== currentAthleteId ||
        record.athleteId !== currentAthleteId || evaluation.athleteId !== currentAthleteId ||
        record.workoutSessionId !== summary.external_session_id ||
        record.workoutSelector !== summary.day || evaluation.workoutSelector !== summary.day ||
        record.activity !== summary.activity || evaluation.activity !== summary.activity) continue;
    contexts[record.workoutSessionId] = {
      appVersion: summary.app_version ?? null,
      machineId: summary.machine_id ?? null,
      machineProfileVersion: summary.machine_profile_version ?? null,
      activePrescriptionSchemaVersion: summary.resolved_prescription?.schemaVersion ?? null,
      shadowSchemaVersion: evaluation.schemaVersion ?? null,
      characterizationSchemaVersion: record.schemaVersion,
    };
  }
  return contexts;
}

/** Strictly parsed summary provenance (from getAllWorkoutSummaries) linked to its own session. */
export function extractTrustedExecutionProvenanceContexts(
  history: readonly TrustedWorkoutHistoryRow[],
  currentAthleteId: string
): Record<string, WorkoutExecutionProvenanceV1> {
  const contexts: Record<string, WorkoutExecutionProvenanceV1> = {};
  for (const { summary } of history) {
    const provenance = summary.execution_provenance;
    if (!provenance || summary.athlete_id !== currentAthleteId ||
        provenance.sessionId !== summary.external_session_id) continue;
    contexts[provenance.sessionId] = provenance;
  }
  return contexts;
}

/**
 * Calibration-vs-workout machine comparison. Identities are compared exactly:
 * a different machine with the same profile version, or the same machine with a
 * different profile version, stays distinguishable. No eligibility is implied.
 */
export function calibrationWorkoutMachineComparison(
  provenance: WorkoutExecutionProvenanceV1 | null
): "same_machine_and_profile" | "different_machine" | "same_machine_different_profile" | "unavailable" {
  if (!provenance || provenance.machine.status !== "selected" ||
      provenance.calibrationMachine.status !== "available") return "unavailable";
  if (provenance.machine.machineId !== provenance.calibrationMachine.machineId) return "different_machine";
  return provenance.machine.machineProfileVersion === provenance.calibrationMachine.machineProfileVersion
    ? "same_machine_and_profile"
    : "same_machine_different_profile";
}

export function summarizeExecutionProvenance(
  records: readonly PersonalizedPrescriptionCharacterization[],
  contexts: Readonly<Record<string, WorkoutExecutionProvenanceV1>>
): PersonalizationExecutionProvenanceSummary {
  const sessions = [...new Set(records.map((record) => record.workoutSessionId))];
  const provenance = sessions.flatMap((id) => contexts[id] ? [contexts[id]] : []);
  const comparisons = provenance.map(calibrationWorkoutMachineComparison);
  return {
    workoutsWithE2: sessions.length,
    workoutsWithProvenance: provenance.length,
    frozenMachineSelected: provenance.filter((item) => item.machine.status === "selected").length,
    selectionChangedDuringWorkout: provenance.filter((item) => item.machine.selectionChangedDuringWorkout).length,
    calibrationMachineAvailable: provenance.filter((item) => item.calibrationMachine.status === "available").length,
    calibrationMachineUnavailable: provenance.filter((item) => item.calibrationMachine.status === "unavailable").length,
    calibrationMachineIntegrityFailures: provenance.filter((item) =>
      item.calibrationMachine.status === "integrity_failure").length,
    sameMachineAndProfile: comparisons.filter((item) => item === "same_machine_and_profile").length,
    differentMachine: comparisons.filter((item) => item === "different_machine").length,
    sameMachineDifferentProfile: comparisons.filter((item) => item === "same_machine_different_profile").length,
    incompleteActuationCapture: provenance.filter((item) => item.actuation.coverage === "incomplete").length,
  };
}

/** Workout-level rows: window totals are descriptive; one workout is one row/session. */
export function summarizeHeldActuationContext(
  records: readonly PersonalizedPrescriptionCharacterization[],
  contexts: Readonly<Record<string, ScientificSessionEvidenceV2>>
): PersonalizationHeldActuationContextRow[] {
  const seen = new Set<string>();
  return [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.workoutSessionId.localeCompare(b.workoutSessionId))
    .flatMap((record) => {
      const evidence = contexts[record.workoutSessionId];
      if (!evidence || seen.has(record.workoutSessionId)) return [];
      seen.add(record.workoutSessionId);
      const phases = evidence.phases.filter((phase) => phase.heldWorkload.available);
      const joins = [...new Set(phases.map((phase) => phase.heldWorkload.timedJoin))];
      const joined = phases.every((phase) => phase.heldWorkload.contexts !== null) && phases.length > 0;
      const contextTotals = joined ? {
        automatic_selected: { windowCount: 0, durationSec: 0 },
        programmatic_selected: { windowCount: 0, durationSec: 0 },
        no_app_selector_observed: { windowCount: 0, durationSec: 0 },
        unknown: { windowCount: 0, durationSec: 0 },
      } : null;
      if (contextTotals) {
        for (const phase of phases) {
          for (const key of Object.keys(contextTotals) as Array<keyof typeof contextTotals>) {
            contextTotals[key].windowCount += phase.heldWorkload.contexts![key].windowCount;
            contextTotals[key].durationSec += phase.heldWorkload.contexts![key].durationSec;
          }
        }
      }
      return [{
        workoutSessionId: record.workoutSessionId,
        createdAt: record.createdAt,
        machineComparison: { ...evidence.machineComparison },
        actuationCapture: evidence.actuationCapture,
        phaseCount: phases.length,
        qualifyingWindowCount: phases.reduce((sum, phase) => sum + phase.heldWorkload.qualifyingWindowCount, 0),
        qualifyingDurationSec: phases.reduce((sum, phase) => sum + phase.heldWorkload.qualifyingDurationSec, 0),
        timedJoin: phases.length === 0 ? "not_applicable" : joins.length === 1 ? joins[0] : "mixed",
        contexts: contextTotals,
      }];
    });
}

function matchPerformedLoadPhase(
  phase: PersonalizedPrescriptionPhaseCharacterizationV1,
  views: readonly PhasePerformedLoadView[]
): PhasePerformedLoadView | null {
  const matches = views.filter((view) =>
    view.phaseId === phase.phaseId &&
    view.kind === phase.kind &&
    view.intensityId === phase.intensityId &&
    view.intervalIndex === phase.intervalIndex
  );
  if (matches.length === 0) return null;
  if (phase.activeStartSec !== undefined) {
    const timed = matches.find((view) => view.activeStartSec === phase.activeStartSec);
    if (timed) return timed;
  }
  return matches[0];
}

/**
 * Observation-only views from durable WorkoutResponse. Raw telemetry is not
 * consulted here so performed-load never participates in E1 candidate generation.
 */
export function extractTrustedPersonalizationPerformedLoadContexts(
  history: readonly TrustedWorkoutHistoryRow[],
  currentAthleteId: string
): Record<string, PhasePerformedLoadView[]> {
  const contexts: Record<string, PhasePerformedLoadView[]> = {};
  for (const { summary } of history) {
    const evaluation = summary.shadow_prescription_evaluation;
    const record = summary.shadow_prescription_characterization;
    const response = summary.workout_response;
    if (!evaluation || !record || !response || summary.athlete_id !== currentAthleteId ||
        record.athleteId !== currentAthleteId || evaluation.athleteId !== currentAthleteId ||
        record.workoutSessionId !== summary.external_session_id ||
        response.sessionId !== summary.external_session_id ||
        record.workoutSelector !== summary.day || evaluation.workoutSelector !== summary.day ||
        record.activity !== summary.activity || evaluation.activity !== summary.activity) continue;
    contexts[record.workoutSessionId] = buildPhasePerformedLoadViews(response, []);
  }
  return contexts;
}

function exclusionCountsFor(
  records: readonly PersonalizedPrescriptionCharacterization[]
): Record<PersonalizedPrescriptionCharacterizationExclusionReasonV1, number> {
  return Object.fromEntries(
    PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS.map((reason) => [
      reason,
      records.reduce((count, record) =>
        count + record.phases.filter((phase) => phase.exclusionReason === reason).length, 0),
    ])
  ) as Record<PersonalizedPrescriptionCharacterizationExclusionReasonV1, number>;
}

/** All-record evidence readiness counts. Filters never affect this summary. */
export function summarizePersonalizationEvidenceCollection(
  records: readonly PersonalizedPrescriptionCharacterization[]
): PersonalizationEvidenceCollectionSummary {
  const candidates = records.flatMap((record) => record.phases.map((phase) => ({ record, phase })))
    .filter(({ phase }) => phase.shadowOutcome === "candidate");
  const saturationDeterminate = candidates.filter(({ phase }) => phase.controllerContext.available);
  const saturated = saturationDeterminate.filter(({ phase }) =>
    phase.controllerContext.anyBoundarySaturationSeconds > 0);
  return {
    completedWorkoutsWithE2: new Set(records.map((record) => record.workoutSessionId)).size,
    candidatePhases: candidates.length,
    evaluableCandidatePhases: candidates.filter(({ phase }) =>
      phase.characterizationOutcome === "characterized").length,
    measuredToMeasuredObservations: candidates.filter(({ record, phase }) =>
      record.calibrationWorkloadProvenance === "measured_watts" &&
      phase.observedPowerProvenance === "measured_watts").length,
    cadenceCalibratedObservations: candidates.filter(({ record, phase }) =>
      record.calibrationWorkloadProvenance === "calibrated_at_verified_cadence" ||
      phase.observedPowerProvenance === "calibrated_watts").length,
    aerobicBaseCandidatePhases: candidates.filter(({ record }) => record.workoutIntent === "aerobic_base").length,
    aerobicVolumeCandidatePhases: candidates.filter(({ record }) => record.workoutIntent === "aerobic_volume").length,
    interiorCandidatePhases: candidates.filter(({ phase }) =>
      phase.candidateDomainMargins?.bucket === "interior").length,
    edgeCandidatePhases: candidates.filter(({ phase }) =>
      phase.candidateDomainMargins?.bucket === "edge").length,
    saturatedCandidatePhases: saturated.length,
    saturationDeterminateCandidatePhases: saturationDeterminate.length,
    ...(saturationDeterminate.length > 0 ? { saturationIncidence: saturated.length / saturationDeterminate.length } : {}),
    exclusionCounts: exclusionCountsFor(records),
  };
}

/** Shallow record copy with a subset of its own phases; the record's schema version is preserved. */
function withPhases(
  record: PersonalizedPrescriptionCharacterization,
  phases: readonly PersonalizedPrescriptionPhaseCharacterizationV1[]
): PersonalizedPrescriptionCharacterization {
  return { ...record, phases: [...phases] } as PersonalizedPrescriptionCharacterization;
}

function heldWorkloadResponseOf(
  phase: PersonalizedPrescriptionPhaseCharacterizationV1
): PersonalizedPrescriptionHeldWorkloadForwardResponseV1 | undefined {
  return "heldWorkloadForwardResponse" in phase
    ? (phase as { heldWorkloadForwardResponse: PersonalizedPrescriptionHeldWorkloadForwardResponseV1 })
      .heldWorkloadForwardResponse
    : undefined;
}

/** All-record held-workload forward-response summary. Filters never affect it. */
export function summarizeHeldWorkloadForwardEvidence(
  records: readonly PersonalizedPrescriptionCharacterization[]
): PersonalizationHeldWorkloadForwardSummary {
  const held = records.flatMap((record) => record.phases.flatMap((phase) => {
    const response = heldWorkloadResponseOf(phase);
    return response ? [{ record, response }] : [];
  }));
  const characterized = held.filter(({ response }) =>
    response.outcome === "characterized" && response.forwardHeartRate !== undefined);
  const sum = (select: (response: PersonalizedPrescriptionHeldWorkloadForwardResponseV1) => number) =>
    held.reduce((total, { response }) => total + select(response), 0);
  const signed = canonicalMedian(characterized.map(({ response }) => response.forwardHeartRate!.signedErrorBpm.median));
  const absolute = canonicalMedian(characterized.map(({ response }) =>
    response.forwardHeartRate!.absoluteErrorBpm.median));
  return {
    recordsWithHeldWorkloadEvidence: new Set(held.map(({ record }) => record.workoutSessionId)).size,
    phasesWithHeldWorkloadSummary: held.length,
    characterizedPhases: characterized.length,
    measuredWattsCharacterizedPhases: characterized.filter(({ response }) =>
      response.observedPowerProvenance === "measured_watts").length,
    calibratedWattsCharacterizedPhases: characterized.filter(({ response }) =>
      response.observedPowerProvenance === "calibrated_watts").length,
    stableWindowCount: sum((response) => response.stableResistance?.stableWindowCount ?? 0),
    qualifyingWindowCount: sum((response) => response.stableResistance?.qualifyingWindowCount ?? 0),
    qualifyingDurationSec: sum((response) => response.stableResistance?.qualifyingDurationSec ?? 0),
    outsideCalibrationDomainSeconds: sum((response) =>
      response.stableResistance?.excludedPostSettlingSeconds.outsideCalibrationDomain ?? 0),
    ...(signed !== undefined ? { medianPhaseSignedErrorBpm: signed } : {}),
    ...(absolute !== undefined ? { medianPhaseAbsoluteErrorBpm: absolute } : {}),
  };
}

export function filterPersonalizationCharacterizations(
  records: readonly PersonalizedPrescriptionCharacterization[],
  filters: PersonalizationDiagnosticsFilters
): PersonalizedPrescriptionCharacterization[] {
  return records.flatMap((record) => {
    const phases = record.phases.filter((phase) => phaseMatchesFilters(record, phase, filters));
    return phases.length > 0 ? [withPhases(record, phases)] : [];
  });
}

export function buildPersonalizationDiagnosticsModel(
  records: readonly PersonalizedPrescriptionCharacterization[],
  filters: PersonalizationDiagnosticsFilters = EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS,
  assessmentContexts: Readonly<Record<string, FrozenAssessmentDiagnosticContext>> = {},
  workoutContexts: Readonly<Record<string, FrozenWorkoutDiagnosticContext>> = {},
  performedLoadContexts: Readonly<Record<string, readonly PhasePerformedLoadView[]>> = {},
  scientificAssessmentEvaluatedAt: string | null = null,
  executionProvenanceContexts: Readonly<Record<string, WorkoutExecutionProvenanceV1>> = {},
  scientificSessionEvidenceContexts: Readonly<Record<string, ScientificSessionEvidenceV2>> = {}
): PersonalizationDiagnosticsModel {
  const normalizedFilters = { ...EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS, ...filters };
  const filtered = filterPersonalizationCharacterizations(records, normalizedFilters);
  const baseRows = personalizedPrescriptionDiagnosticRows(filtered);
  let rowIndex = 0;
  const rows = filtered.flatMap((record) => record.phases.map((phase) => {
    const base = baseRows[rowIndex];
    const row: PersonalizationDiagnosticPresentationRow = {
      ...base,
      index: rowIndex,
      date: record.createdAt,
      workout: record.workoutIntent,
      assessmentDomain: phase.candidateDomainMargins?.bucket ?? "not_applicable",
      agreement: phase.comparison?.agreement ?? "not_available",
      assessmentContext: assessmentContexts[record.workoutSessionId] ?? null,
      workoutContext: workoutContexts[record.workoutSessionId] ?? null,
      performedLoadPhase: matchPerformedLoadPhase(phase, performedLoadContexts[record.workoutSessionId] ?? []),
      executionProvenance: executionProvenanceContexts[record.workoutSessionId] ?? null,
      record,
      phaseRecord: phase,
    };
    rowIndex += 1;
    return row;
  }));
  const exclusionCounts = exclusionCountsFor(filtered);
  return {
    filters: normalizedFilters,
    filterOptions: personalizationDiagnosticsFilterOptions(records),
    sourceRecordCount: records.length,
    records: filtered,
    aggregate: aggregatePersonalizedPrescriptionCharacterizations(filtered),
    rows,
    exclusionCounts,
    evidenceCollectionSummary: summarizePersonalizationEvidenceCollection(records),
    thresholdLongitudinal: buildThresholdLongitudinalAnalysis(records, assessmentContexts, workoutContexts),
    heldWorkloadForward: summarizeHeldWorkloadForwardEvidence(records),
    executionProvenance: summarizeExecutionProvenance(records, executionProvenanceContexts),
    heldActuationContext: summarizeHeldActuationContext(records, scientificSessionEvidenceContexts),
    scientificAssessments: scientificAssessmentEvaluatedAt === null
      ? []
      : buildDiagnosticScientificAssessments(records, assessmentContexts, workoutContexts,
        scientificAssessmentEvaluatedAt, scientificSessionEvidenceContexts),
  };
}

/**
 * Read-only E4A projection over all trusted records (filters never apply).
 * The current calibration is not vouched for here (`null`): diagnostics do
 * not read FitnessState, so supersession is reported `unavailable`.
 */
export function buildDiagnosticScientificAssessments(
  records: readonly PersonalizedPrescriptionCharacterization[],
  assessmentContexts: Readonly<Record<string, FrozenAssessmentDiagnosticContext>>,
  workoutContexts: Readonly<Record<string, FrozenWorkoutDiagnosticContext>>,
  evaluatedAt: string,
  sessionEvidenceV2: Readonly<Record<string, ScientificSessionEvidenceV2>> = {}
): ScientificAssessment[] {
  const athleteIds = [...new Set(records.map((record) => record.athleteId))].sort((a, b) => a.localeCompare(b));
  return athleteIds.flatMap((athleteId) =>
    discoverDiagnosticSubjects(records, assessmentContexts, workoutContexts, athleteId).map((subject) =>
      assessPersonalizedWorkloadEvidence(
        buildSubjectEvidence({ subject, records, assessmentContexts, workoutContexts, currentCalibration: null,
          sessionEvidenceV2 }),
        subject,
        E4A_CURRENT_SCIENTIFIC_ASSESSMENT_POLICY,
        evaluatedAt
      )));
}

export interface PersonalizationDiagnosticsExportV1 {
  schemaVersion: typeof PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V1;
  filters: PersonalizationDiagnosticsFilters;
  aggregate: PersonalizedPrescriptionCharacterizationAggregateV1;
  diagnosticRows: Array<Omit<PersonalizationDiagnosticPresentationRow,
    "record" | "phaseRecord" | "formalAssessmentProvenance" | "performedLoadPhase">>;
  characterizationRecords: PersonalizedPrescriptionCharacterizationV1[];
}

type ExportedDiagnosticRow = Omit<PersonalizationDiagnosticPresentationRow,
  "record" | "phaseRecord" | "performedLoadPhase" | "executionProvenance">;

/**
 * Permanent historical export contract. Its record contract is exactly the E2
 * versions that existed when it was current (v1 and v2); it can never carry an
 * E2 v3 record.
 */
export interface PersonalizationDiagnosticsExportV2 {
  schemaVersion: typeof PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V2;
  filters: PersonalizationDiagnosticsFilters;
  aggregate: PersonalizedPrescriptionCharacterizationAggregateV2;
  diagnosticRows: ExportedDiagnosticRow[];
  characterizationRecords: Array<PersonalizedPrescriptionCharacterizationV1 | PersonalizedPrescriptionCharacterizationV2>;
}

/**
 * Current export. Same durable fields as v2; the bump only admits E2 v3
 * records. Runtime projections (E3 series, held-workload summary, E4A) stay
 * unexported.
 */
export interface PersonalizationDiagnosticsExportV3 {
  schemaVersion: typeof PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V3;
  filters: PersonalizationDiagnosticsFilters;
  aggregate: PersonalizedPrescriptionCharacterizationAggregateV2;
  diagnosticRows: ExportedDiagnosticRow[];
  characterizationRecords: PersonalizedPrescriptionCharacterization[];
}

export type PersonalizationDiagnosticsExport =
  | PersonalizationDiagnosticsExportV1
  | PersonalizationDiagnosticsExportV2
  | PersonalizationDiagnosticsExportV3;
export type CurrentPersonalizationDiagnosticsExport = PersonalizationDiagnosticsExportV3;

function exportBody(model: PersonalizationDiagnosticsModel) {
  return {
    filters: { ...model.filters },
    aggregate: model.aggregate,
    diagnosticRows: model.rows.map(({
      record: _record,
      phaseRecord: _phaseRecord,
      performedLoadPhase: _performedLoadPhase,
      executionProvenance: _executionProvenance,
      ...row
    }) => row),
    characterizationRecords: [...model.records]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.workoutSessionId.localeCompare(b.workoutSessionId))
      .map((record) => withPhases(record, record.phases)),
  };
}

/**
 * Stable local export. It includes immutable E2 records, never profile data or raw HR traces.
 * The contract is exactly schemaVersion, filters, aggregate, diagnosticRows,
 * characterizationRecords; runtime-only analyses (E3 series, held-workload
 * summary, E4A) are never exported.
 */
export function createPersonalizationDiagnosticsExport(
  model: PersonalizationDiagnosticsModel
): PersonalizationDiagnosticsExportV3 {
  return { schemaVersion: PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V3, ...exportBody(model) };
}

/**
 * Historical export-v2 writer. Fails closed (null) when the model holds any
 * record outside the v2 record contract, rather than widening or relabeling it.
 */
export function createHistoricalPersonalizationDiagnosticsExportV2(
  model: PersonalizationDiagnosticsModel
): PersonalizationDiagnosticsExportV2 | null {
  const body = exportBody(model);
  const records = body.characterizationRecords.filter(
    (record): record is PersonalizedPrescriptionCharacterizationV1 | PersonalizedPrescriptionCharacterizationV2 =>
      record.schemaVersion === 1 || record.schemaVersion === 2);
  if (records.length !== body.characterizationRecords.length) return null;
  return { schemaVersion: PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V2, ...body, characterizationRecords: records };
}

export function personalizationDiagnosticsExportJson(model: PersonalizationDiagnosticsModel): string {
  return `${JSON.stringify(createPersonalizationDiagnosticsExport(model), null, 2)}\n`;
}

const LABELS: Record<string, string> = {
  measured_watts: "Measured watts",
  calibrated_at_verified_cadence: "Cadence-calibrated watts",
  calibrated_watts: "Calibrated watts",
  mixed: "Mixed",
  unavailable: "Unavailable",
  unspecified: "Unspecified",
  not_applicable: "Not applicable",
  multiple_threshold_phases: "Multiple characterized threshold phases",
  incomplete_calibration_identity: "Incomplete formal calibration identity",
  missing_machine_identity: "Missing historical machine identity",
  missing_machine_profile_identity: "Missing historical machine-profile identity",
  invalid_longitudinal_metrics: "Invalid longitudinal metrics",
  aerobic_base: "Aerobic base",
  aerobic_volume: "Aerobic volume",
  inside_candidate: "Inside candidate",
  below_candidate: "Below candidate",
  above_candidate: "Above candidate",
  not_available: "Not available",
  characterized: "Characterized",
  insufficient_evidence: "Insufficient evidence",
  not_candidate: "No candidate",
  unsupported_observed_provenance: "Unsupported observed provenance",
  telemetry_unavailable: "Telemetry unavailable",
  phase_too_short: "Phase too short",
  missing_telemetry: "Missing telemetry",
  insufficient_hr_coverage: "Insufficient HR coverage",
  insufficient_power_coverage: "Insufficient power coverage",
  insufficient_joint_coverage: "Insufficient joint coverage",
  insufficient_settled_in_band_evidence: "Insufficient settled in-target evidence",
  unsupported_power_provenance: "Unsupported or mixed power source",
  phase_evidence_unavailable: "Phase evidence unavailable",
  calibration_unavailable: "Frozen calibration unavailable",
  automatic_hr_control: "Automatic HR control",
  learned_starting_resistance: "Learned starting resistance",
  default_starting_resistance: "Default starting resistance",
  controller_carryover: "Controller carry-over",
  scripted_phase_program: "Scripted phase program",
  vo2_protocol_fixed_resistance: "VO₂ protocol fixed resistance",
  unclassified: "Unclassified",
  decision: "Decision",
  reconciliation_resend: "Re-send of current decision",
  complete: "Complete",
  incomplete: "Incomplete",
  no_frozen_calibration: "No frozen calibration",
  integrity_failure: "Conflicting provenance records",
  same_machine_and_profile: "Same machine and profile",
  different_machine: "Different machine",
  execution_provenance_unavailable: "Execution provenance unavailable",
  workout_machine_unavailable: "Workout machine unavailable",
  workout_machine_selection_changed: "Workout machine selection changed",
  calibration_machine_unavailable: "Calibration machine unavailable",
  calibration_machine_integrity_failure: "Conflicting calibration machine records",
  calibration_identity_mismatch: "Calibration identity mismatch",
  raw_telemetry_unavailable: "Raw telemetry unavailable",
  reconstruction_mismatch: "Raw telemetry does not reproduce E2",
  same_machine_different_profile: "Same machine, different profile",
  no_stable_observed_resistance: "No stable observed resistance",
  insufficient_post_settling_evidence: "Insufficient post-settling evidence",
  edge: "Edge",
  interior: "Interior",
  high: "High",
  moderate: "Moderate",
  low: "Low",
  unverified: "Unverified",
};

export function personalizationDiagnosticLabel(value: string): string {
  return LABELS[value] ?? value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function percent(value: number | undefined): string {
  return value === undefined ? "n/a" : `${Math.round(value * 100)}%`;
}

function metric(value: number | undefined, count: number, suffix: string): string {
  return `<strong>${value === undefined ? "n/a" : `${Math.round(value * 10) / 10}${suffix}`}</strong><span>n = ${count} phases</span>`;
}

function optionMarkup(values: readonly string[], selected: string): string {
  return [`<option value="all"${selected === "all" ? " selected" : ""}>All</option>`, ...values.map((value) =>
    `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(personalizationDiagnosticLabel(value))}</option>`
  )].join("");
}

function formatSigned(value: number | undefined, suffix: string): string {
  if (value === undefined) return "n/a";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}${suffix}`;
}

function formatRatio(value: number | undefined | null): string {
  if (value === undefined || value === null) return "n/a";
  return String(Math.round(value * 100) / 100);
}

function thresholdLongitudinalHtml(analysis: ThresholdLongitudinalAnalysis): string {
  const note = `<p class="developer-diagnostics-note">Signed error is transfer error under legacy heart-rate control. The live controller searches for the prescribed HR band, so settled watts near the candidate can reflect that search rather than independent prescription quality. This series does not use inside-candidate rate as a success score, and it does not authorize control.</p>`;
  const exclusions = analysis.exclusions.length === 0 ? "" : `<div class="personalization-table-scroll" tabindex="0"><table class="personalization-table"><thead><tr><th>Excluded session</th><th>Date</th><th>Longitudinal reason</th></tr></thead><tbody>${analysis.exclusions.map((exclusion) => `<tr><td>${escapeHtml(exclusion.workoutSessionId)}</td><td>${escapeHtml(new Date(exclusion.createdAt).toLocaleDateString())}</td><td>${escapeHtml(personalizationDiagnosticLabel(exclusion.reason))}</td></tr>`).join("")}</tbody></table></div><p class="developer-diagnostics-note">Excluded sessions remain available in phase-level E2 diagnostics; incomplete identities are never pooled.</p>`;
  if (analysis.sessionCount === 0) {
    return `<section class="personalization-longitudinal" id="personalizationThresholdLongitudinal"><h4>Threshold transfer series</h4>${note}<div class="personalization-diagnostics-empty"><strong>No comparable bike threshold work sessions yet.</strong><span>A session requires exactly one characterized threshold phase plus complete frozen calibration and machine identity.</span></div>${exclusions}</section>`;
  }
  const cohorts = analysis.cohorts.map((cohort) => {
    const domains = [...new Set(cohort.sessions.map((session) => session.domainBucket))];
    const rows = cohort.sessions.map((session) => `<tr>
      <td>${escapeHtml(new Date(session.createdAt).toLocaleDateString())}</td>
      <td>${escapeHtml(session.workoutSessionId)}</td>
      <td>${session.assessmentAgeDays === null ? "n/a" : `${session.assessmentAgeDays} d`}</td>
      <td>${escapeHtml(`${session.machineId} @ profile ${session.machineProfileVersion}`)}</td>
      <td>${escapeHtml(personalizationDiagnosticLabel(session.domainBucket))}</td>
      <td>${formatOptionalNumber(session.candidateWidthWatts)} W</td>
      <td>${formatOptionalNumber(session.candidateMidpointWatts)} W</td>
      <td>${formatOptionalNumber(session.observedSettledWatts)} W</td>
      <td>${formatSigned(session.signedDifferenceWatts, " W")}</td>
      <td>${formatOptionalNumber(session.absoluteDifferenceWatts)} W</td>
      <td>${formatRatio(session.widthNormalizedAbsoluteError)}</td>
      <td>${percent(session.saturationRatio)}</td>
    </tr>`).join("");
    return `<article class="personalization-cohort">
      <h4>Calibration ${escapeHtml(cohort.key.calibration.evidenceSessionIds.join(", "))}</h4>
      <div class="personalization-cohort-tags"><span>${escapeHtml(`${cohort.key.calibration.estimator.id}@${cohort.key.calibration.estimator.version}`)} estimator</span><span>${escapeHtml(`${cohort.key.calibration.protocol.id}@${cohort.key.calibration.protocol.version}`)} protocol</span><span>${escapeHtml(personalizationDiagnosticLabel(cohort.key.calibration.workloadProvenance))} calibration</span><span>${escapeHtml(personalizationDiagnosticLabel(cohort.key.observedPowerProvenance))} observed</span><span>${escapeHtml(`${cohort.key.machineId} @ profile ${cohort.key.machineProfileVersion}`)}</span>${domains.map((bucket) => `<span>${escapeHtml(personalizationDiagnosticLabel(bucket))} domain</span>`).join("")}</div>
      <div class="personalization-metric-grid">
        <div><label>Sessions</label><strong>${cohort.sessionCount}</strong><span>unique bike threshold workouts</span></div>
        <div><label>Median signed error</label><strong>${formatSigned(cohort.medianSignedDifferenceWatts, " W")}</strong><span>candidate midpoint vs settled watts</span></div>
        <div><label>Median absolute error</label><strong>${cohort.medianAbsoluteDifferenceWatts === undefined ? "n/a" : `${formatOptionalNumber(cohort.medianAbsoluteDifferenceWatts)} W`}</strong><span>n = ${cohort.sessionCount} sessions</span></div>
        <div><label>Median candidate width</label><strong>${cohort.medianCandidateWidthWatts === undefined ? "n/a" : `${formatOptionalNumber(cohort.medianCandidateWidthWatts)} W`}</strong><span>max − min candidate watts</span></div>
        <div><label>Median width-normalized error</label><strong>${formatRatio(cohort.medianWidthNormalizedAbsoluteError)}</strong><span>absolute error / candidate width</span></div>
        <div><label>Observed settled watts CV</label><strong>${cohort.observedSettledWattsCv === undefined ? "n/a" : percent(cohort.observedSettledWattsCv)}</strong><span>descriptive population variability</span></div>
        <div><label>Sessions with any boundary saturation</label><strong>${cohort.saturationIncidence === undefined ? "n/a" : percent(cohort.saturationIncidence)}</strong><span>saturationRatio &gt; 0</span></div>
        <div><label>Median assessment age</label><strong>${cohort.medianAssessmentAgeDays === undefined ? "n/a" : `${Math.round(cohort.medianAssessmentAgeDays)} d`}</strong><span>workout createdAt − frozen E1 observedAt</span></div>
      </div>
      <div class="personalization-table-scroll" tabindex="0"><table class="personalization-table"><thead><tr><th>Date</th><th>Session</th><th>Assessment age</th><th>Machine</th><th>Domain</th><th>Candidate width</th><th>Candidate midpoint</th><th>Settled watts</th><th>Signed error</th><th>Abs error</th><th>Width-norm error</th><th>Saturation</th></tr></thead><tbody>${rows}</tbody></table></div>
    </article>`;
  }).join("");
  return `<section class="personalization-longitudinal" id="personalizationThresholdLongitudinal"><h4>Threshold transfer series</h4>${note}<div class="personalization-count-grid"><div><strong>${analysis.sessionCount}</strong><span>Comparable bike threshold sessions</span></div><div><strong>${analysis.cohorts.length}</strong><span>Calibration × provenance × machine cohorts</span></div></div><div class="personalization-cohorts">${cohorts}</div>${exclusions}</section>`;
}

const HELD_WORKLOAD_NOTE = `<p class="developer-diagnostics-note">Held-workload forward-response evidence: observed watts while observed resistance stays unchanged, after a settling interval, are mapped through the frozen formal calibration to a predicted heart rate (signed error = observed HR − predicted HR). It is not filtered by legacy heart-rate target occupancy. The live controller may have chosen the held resistance, so this is not independent open-loop evidence, and it does not authorize control.</p>`;

function executionProvenanceHtml(summary: PersonalizationExecutionProvenanceSummary): string {
  const note = `<p class="developer-diagnostics-note">Machine provenance is frozen at workout start; calibration machine provenance is copied at start from an exact formal-calibration record. Actuation provenance lists captured app resistance commands with their recorded origin; console resistance changes are not observable. Descriptive only: it does not change any assessment.</p>`;
  return `<section class="personalization-longitudinal" id="personalizationExecutionProvenance"><h4>Machine and actuation provenance</h4>${note}<div class="personalization-count-grid">
      <div><strong>${summary.workoutsWithProvenance} / ${summary.workoutsWithE2}</strong><span>Workouts with execution provenance</span></div>
      <div><strong>${summary.frozenMachineSelected}</strong><span>Frozen workout machine recorded</span></div>
      <div><strong>${summary.selectionChangedDuringWorkout}</strong><span>Machine selection changed mid-workout</span></div>
      <div><strong>${summary.calibrationMachineAvailable} / ${summary.calibrationMachineUnavailable} / ${summary.calibrationMachineIntegrityFailures}</strong><span>Calibration machine available / unavailable / conflicting</span></div>
      <div><strong>${summary.sameMachineAndProfile} / ${summary.differentMachine} / ${summary.sameMachineDifferentProfile}</strong><span>Calibration vs workout: same / other machine / other profile</span></div>
      <div><strong>${summary.incompleteActuationCapture}</strong><span>Incomplete actuation capture</span></div>
    </div></section>`;
}

const ACTUATION_MODE_LABELS: Record<string, string> = {
  automatic: "Automatic",
  programmatic: "Programmatic only",
  none: "No app resistance commands",
  unknown: "Unknown",
};

function machineLabel(identity: { machineId: string; machineProfileVersion: number }): string {
  return `${identity.machineId} / profile ${identity.machineProfileVersion}`;
}

function provenanceDetailHtml(
  provenance: WorkoutExecutionProvenanceV1 | null,
  phase: PersonalizedPrescriptionPhaseCharacterizationV1
): string {
  if (!provenance) {
    return `<section><h5>Machine provenance</h5><dl>${detailRow("Availability", "not recorded (historical workout)")}${detailRow("Actuation provenance", "unknown")}</dl></section>`;
  }
  const machine = provenance.machine;
  const calibration = provenance.calibrationMachine;
  const phaseSummary = provenance.actuation.phases?.find((item) =>
    item.phaseId === phase.phaseId && item.intervalIndex === phase.intervalIndex &&
    (phase.activeStartSec === undefined || item.activeStartSec === phase.activeStartSec));
  const events = phaseSummary
    ? provenance.actuation.events.filter((event) =>
      event.activeSec >= phaseSummary.activeStartSec && event.activeSec < phaseSummary.activeEndSec)
    : [];
  const eventRows = events.map((event) => `<tr><td>${event.activeSec} s</td><td>${escapeHtml(personalizationDiagnosticLabel(event.origin))}</td><td>${escapeHtml(personalizationDiagnosticLabel(event.trigger))}</td><td>R${event.requestedResistance}</td><td>${escapeHtml(event.outcome)}</td></tr>`).join("");
  return `<section><h5>Machine provenance</h5><dl>${detailRow("Frozen workout machine", machine.status === "selected" ? machineLabel(machine) : "none selected at start")}${detailRow("Selection changed mid-workout", machine.selectionChangedDuringWorkout ? "yes" : "no")}${detailRow("Calibration machine", calibration.status === "available" ? machineLabel(calibration) : personalizationDiagnosticLabel(calibration.status))}${detailRow("Calibration vs workout", personalizationDiagnosticLabel(calibrationWorkoutMachineComparison(provenance)))}</dl></section>
    <section><h5>Actuation provenance</h5><dl>${detailRow("Capture", `${personalizationDiagnosticLabel(provenance.actuation.coverage)} app resistance commands; console changes not observable`)}${detailRow("Phase actuation mode", phaseSummary ? ACTUATION_MODE_LABELS[phaseSummary.mode] : "unavailable")}${detailRow("Captured automatic / programmatic resistance events", phaseSummary ? `${phaseSummary.automaticAcceptedCount} / ${phaseSummary.programmaticAcceptedCount}` : "n/a")}${detailRow("Rejected / ambiguous commands", phaseSummary ? `${phaseSummary.rejectedCount} / ${phaseSummary.ambiguousCount}` : "n/a")}${detailRow("Distinct decisions", phaseSummary?.decisionCount)}</dl>${eventRows ? `<div class="personalization-table-scroll" tabindex="0"><table class="personalization-table"><thead><tr><th>Active time</th><th>Origin</th><th>Trigger</th><th>Requested</th><th>Outcome</th></tr></thead><tbody>${eventRows}</tbody></table></div>` : ""}</section>`;
}

const HELD_CONTEXT_LABELS: Record<string, string> = {
  automatic_selected: "Controller-context evidence (automatic-selected)",
  programmatic_selected: "Programmatic-context evidence",
  no_app_selector_observed: "No captured app selector",
  unknown: "Unknown",
};

function heldActuationContextHtml(rows: readonly PersonalizationHeldActuationContextRow[]): string {
  const note = `<p class="developer-diagnostics-note">E4A v2 joins each qualifying held-workload window to the captured app resistance commands. "No app selector observed" does not establish manual or open-loop resistance because console changes are not observable. Independent open-loop evidence: unavailable.</p>`;
  if (rows.length === 0) {
    return `<section class="personalization-longitudinal" id="personalizationHeldActuationContext"><h4>Held-workload actuation context (E4A v2)</h4>${note}<div class="personalization-diagnostics-empty"><strong>No E4A v2 joins yet.</strong><span>Joins need E2 v3 held-workload evidence and execution provenance.</span></div></section>`;
  }
  const durations = (row: PersonalizationHeldActuationContextRow) => row.contexts
    ? Object.keys(HELD_CONTEXT_LABELS).map((key) => `${row.contexts![key as keyof typeof row.contexts].durationSec} s`).join(" / ")
    : "unavailable";
  const body = rows.map((row) => `<tr><td>${escapeHtml(new Date(row.createdAt).toLocaleDateString())}</td><td>${escapeHtml(row.workoutSessionId)}</td><td>${escapeHtml(personalizationDiagnosticLabel(row.machineComparison.reason))}</td><td>${escapeHtml(personalizationDiagnosticLabel(row.timedJoin))}</td><td>${row.qualifyingWindowCount} / ${row.qualifyingDurationSec} s</td><td>${escapeHtml(durations(row))}</td><td>unavailable</td></tr>`).join("");
  return `<section class="personalization-longitudinal" id="personalizationHeldActuationContext"><h4>Held-workload actuation context (E4A v2)</h4>${note}<div class="personalization-table-scroll" tabindex="0"><table class="personalization-table"><thead><tr><th>Date</th><th>Session</th><th>Machine comparability</th><th>Timed join</th><th>Qualifying windows / duration</th><th>Duration by context (controller / programmatic / no captured app selector / unknown)</th><th>Independent open-loop evidence</th></tr></thead><tbody>${body}</tbody></table></div><p class="developer-diagnostics-note">Each workout is one longitudinal session; window counts and durations are descriptive.</p></section>`;
}

function heldWorkloadForwardHtml(summary: PersonalizationHeldWorkloadForwardSummary): string {
  if (summary.phasesWithHeldWorkloadSummary === 0) {
    return `<section class="personalization-longitudinal" id="personalizationHeldWorkloadForward"><h4>Held-workload forward-response evidence</h4>${HELD_WORKLOAD_NOTE}<div class="personalization-diagnostics-empty"><strong>No E2 v3 held-workload evidence yet.</strong><span>Workouts characterized before E2 v3 carry closed-loop transfer evidence only.</span></div></section>`;
  }
  return `<section class="personalization-longitudinal" id="personalizationHeldWorkloadForward"><h4>Held-workload forward-response evidence</h4>${HELD_WORKLOAD_NOTE}<div class="personalization-count-grid">
      <div><strong>${summary.recordsWithHeldWorkloadEvidence}</strong><span>Workouts with E2 v3 held-workload summaries</span></div>
      <div><strong>${summary.characterizedPhases} / ${summary.phasesWithHeldWorkloadSummary}</strong><span>Characterized / summarized phases</span></div>
      <div><strong>${summary.qualifyingWindowCount} / ${summary.stableWindowCount}</strong><span>Qualifying / stable observed-resistance windows</span></div>
      <div><strong>${summary.qualifyingDurationSec} s</strong><span>Post-settling qualifying duration</span></div>
      <div><strong>${formatSigned(summary.medianPhaseSignedErrorBpm, " bpm")}</strong><span>Median phase forward HR signed error</span></div>
      <div><strong>${summary.medianPhaseAbsoluteErrorBpm === undefined ? "n/a" : `${formatOptionalNumber(summary.medianPhaseAbsoluteErrorBpm)} bpm`}</strong><span>Median phase forward HR absolute error</span></div>
      <div><strong>${summary.measuredWattsCharacterizedPhases} / ${summary.calibratedWattsCharacterizedPhases}</strong><span>Measured / calibrated watts characterized phases</span></div>
      <div><strong>${summary.outsideCalibrationDomainSeconds} s</strong><span>Excluded outside calibration watt domain</span></div>
    </div></section>`;
}

function heldWorkloadDetailHtml(response: PersonalizedPrescriptionHeldWorkloadForwardResponseV1 | undefined): string {
  if (!response) {
    return `<section><h5>Held-workload forward-response evidence</h5><dl>${detailRow("Availability", "not recorded (pre-E2 v3 record)")}</dl></section>`;
  }
  const stable = response.stableResistance;
  const forward = response.forwardHeartRate;
  const excluded = stable?.excludedPostSettlingSeconds;
  const signed = (value: number) => `${value > 0 ? "+" : ""}${formatOptionalNumber(value)}`;
  return `<section><h5>Held-workload forward-response evidence</h5><dl>${detailRow("Outcome", personalizationDiagnosticLabel(response.outcome))}${detailRow("Exclusion", personalizationDiagnosticLabel(response.exclusionReason ?? "none"))}${detailRow("Observed power", personalizationDiagnosticLabel(response.observedPowerProvenance))}${detailRow("Stable / qualifying windows", stable ? `${stable.stableWindowCount} / ${stable.qualifyingWindowCount}` : "n/a")}${detailRow("Stable / post-settling / qualifying duration", stable ? `${stable.stableDurationSec} / ${stable.postSettlingDurationSec} / ${stable.qualifyingDurationSec} sec` : "n/a")}${detailRow("Observed resistance changes", stable?.observedResistanceChangeCount)}${detailRow("Excluded: gap / no watts / outside domain / no HR", excluded ? `${excluded.observationGap} / ${excluded.wattsUnavailable} / ${excluded.outsideCalibrationDomain} / ${excluded.heartRateUnavailable} sec` : "n/a")}${detailRow("Observed / predicted HR median", forward ? `${formatOptionalNumber(forward.observedHeartRateMedianBpm)} / ${formatOptionalNumber(forward.predictedHeartRateMedianBpm)} bpm` : "n/a")}${detailRow("Forward HR signed error median / IQR", forward ? `${signed(forward.signedErrorBpm.median)} bpm / ${signed(forward.signedErrorBpm.q1)}–${signed(forward.signedErrorBpm.q3)} bpm` : "n/a")}${detailRow("Forward HR absolute error median / max", forward ? `${formatOptionalNumber(forward.absoluteErrorBpm.median)} / ${formatOptionalNumber(forward.absoluteErrorBpm.max)} bpm` : "n/a")}${detailRow("Cadence median / IQR", response.cadenceRpm ? `${formatOptionalNumber(response.cadenceRpm.median)} rpm / ${formatOptionalNumber(response.cadenceRpm.q1)}–${formatOptionalNumber(response.cadenceRpm.q3)} rpm` : "n/a")}</dl></section>`;
}

function scientificAssessmentsHtml(assessments: readonly ScientificAssessment[]): string {
  const note = `<p class="developer-diagnostics-note">E4A scientific assessment over comparable frozen E1/E2 evidence. Scientific state is not product authorization and has no runtime authority. Under the production policy (v2), only exactly machine-comparable sessions are evidence and held-workload actuation context is reported from captured provenance; independent open-loop evidence is required but unavailable, so eligible is unreachable.</p>`;
  if (assessments.length === 0) {
    return `<section class="personalization-longitudinal" id="personalizationScientificAssessments"><h4>Scientific assessment (E4A)</h4>${note}<div class="personalization-diagnostics-empty"><strong>No assessable subjects yet.</strong><span>A subject needs a frozen E1 candidate with complete calibration and machine identity.</span></div></section>`;
  }
  const cards = assessments.map((assessment) => {
    const subject = assessment.subject;
    const digest = assessment.evidenceDigest;
    const gates = assessment.gates.map((gate) => `<tr><td>${escapeHtml(gate.id)}</td><td>${escapeHtml(gate.status)}</td><td>${escapeHtml(gate.reasonCode ?? "")}</td></tr>`).join("");
    return `<article class="personalization-cohort">
      <h4>${escapeHtml(scientificSubjectKey(subject))} · ${escapeHtml(personalizationDiagnosticLabel(assessment.state))}</h4>
      <dl>${detailRow("Scientific state", assessment.state)}${detailRow("Runtime authority", assessment.runtimeAuthority ? "yes" : "no")}${detailRow("Subject", `${subject.athleteId} · ${subject.activity} ${subject.phaseKind} · ${subject.intensityId} · ${subject.modality} · ${subject.legacyHrBand.minBpm}–${subject.legacyHrBand.maxBpm} bpm`)}${detailRow("Calibration", `${digest.calibrationInstanceId} · ${subject.calibration.estimatorId}@${subject.calibration.estimatorVersion} · ${subject.calibration.protocolId}@${subject.calibration.protocolVersion}`)}${detailRow("Assessor", `${assessment.assessor.id}@${assessment.assessor.version}`)}${detailRow("Policy", `${assessment.policy.id}@${assessment.policy.version}`)}${detailRow("Reason codes", assessment.reasonCodes.length === 0 ? "none" : assessment.reasonCodes.join(", "))}${detailRow("Sessions / distinct dates", `${digest.sessionCount} / ${digest.distinctDateCount}`)}${detailRow("Excluded (identity / multi-phase / invalid)", `${digest.excludedIncompleteIdentitySessions} / ${digest.excludedMultiPhaseSessions} / ${digest.ignoredInvalidSessions}`)}${detailRow("Machine / profile", `${subject.machineId} / v${subject.machineProfileVersion}`)}${detailRow("Power provenance (calibration / observed)", `${personalizationDiagnosticLabel(subject.calibration.workloadProvenance)} / ${personalizationDiagnosticLabel(subject.observedPowerProvenance)}`)}${digest.provenanceV2 ? `${detailRow("Machine-comparable closed-loop transfer sessions", `${digest.provenanceV2.transferComparableSessionCount} (excluded: ${Object.entries(digest.provenanceV2.excludedTransferMachineIncomparableSessions).map(([reason, count]) => `${personalizationDiagnosticLabel(reason)} ${count}`).join(", ") || "none"})`)}${detailRow("Machine-comparable held-response sessions", `${digest.provenanceV2.heldComparableSessionCount} (excluded: ${Object.entries(digest.provenanceV2.excludedHeldMachineIncomparableSessions).map(([reason, count]) => `${personalizationDiagnosticLabel(reason)} ${count}`).join(", ") || "none"})`)}${detailRow("Held evidence / timed join sessions", `${digest.provenanceV2.sessionsWithHeldWorkloadEvidence} / ${digest.provenanceV2.sessionsWithTimedActuationJoin}`)}${detailRow("Held duration by context (controller / programmatic / no captured app selector / unknown)", Object.values(digest.provenanceV2.heldContexts).map((item) => `${item.durationSec} s`).join(" / "))}${detailRow("Independent open-loop evidence", "unavailable")}` : ""}${detailRow("Held-workload forward sessions (descriptive, not open-loop)", `${digest.heldWorkloadForwardSessionCount} · signed ${digest.medianHeldWorkloadForwardSignedErrorBpm === null ? "n/a" : formatSigned(digest.medianHeldWorkloadForwardSignedErrorBpm, " bpm")} · absolute ${digest.medianHeldWorkloadForwardAbsoluteErrorBpm === null ? "n/a" : `${digest.medianHeldWorkloadForwardAbsoluteErrorBpm} bpm`}`)}</dl>
      <div class="personalization-table-scroll" tabindex="0"><table class="personalization-table"><thead><tr><th>Gate</th><th>Status</th><th>Reason</th></tr></thead><tbody>${gates}</tbody></table></div>
    </article>`;
  }).join("");
  return `<section class="personalization-longitudinal" id="personalizationScientificAssessments"><h4>Scientific assessment (E4A)</h4>${note}<div class="personalization-cohorts">${cards}</div></section>`;
}

/** Responsive developer presentation only; every number comes from E2 helpers or frozen fields. */
export function personalizationDiagnosticsHtml(model: PersonalizationDiagnosticsModel): string {
  if (model.sourceRecordCount === 0) {
    return `<div class="personalization-diagnostics-empty"><strong>No personalization characterization data yet.</strong><span>Complete a qualifying bike threshold workout after a formal VO₂ assessment to begin collecting shadow workload validation data. Candidate watts do not control the workout.</span></div>`;
  }
  const aggregate = model.aggregate;
  const evidence = model.evidenceCollectionSummary;
  const filters = model.filters;
  const filterOptions = model.filterOptions;
  const filtersHtml = [
    ["personalizationIntentFilter", "Workout intent", "workoutIntent", filterOptions.workoutIntent],
    ["personalizationIntensityFilter", "Intensity", "intensity", filterOptions.intensity],
    ["personalizationCalibrationFilter", "Formal calibration", "calibrationProvenance", filterOptions.calibrationProvenance],
    ["personalizationObservedPowerFilter", "Observed power", "observedPowerProvenance", filterOptions.observedPowerProvenance],
    ["personalizationQualityFilter", "Assessment quality", "assessmentQuality", filterOptions.assessmentQuality],
    ["personalizationDomainFilter", "Assessment domain", "domainBucket", filterOptions.domainBucket],
  ].map(([id, label, key, values]) => `<label><span>${label}</span><select id="${id}" class="modal-input personalization-filter" onchange="applyPersonalizationDiagnosticsFilters()">${optionMarkup(values as string[], filters[key as keyof PersonalizationDiagnosticsFilters])}</select></label>`).join("");
  const cohortHtml = aggregate.groups.map((group) => `<article class="personalization-cohort">
    <h4>${escapeHtml(personalizationDiagnosticLabel(group.workoutIntent))} · ${escapeHtml(personalizationDiagnosticLabel(group.intensityId))}</h4>
    <div class="personalization-cohort-tags"><span>${escapeHtml(personalizationDiagnosticLabel(group.calibrationWorkloadProvenance))}</span><span>${escapeHtml(personalizationDiagnosticLabel(group.observedPowerProvenance))} observed</span><span>${escapeHtml(group.formalAssessmentAlgorithm)}</span><span>${escapeHtml(group.formalAssessmentProtocol)}</span><span>${escapeHtml(personalizationDiagnosticLabel(group.formalAssessmentQuality))} quality</span><span>${escapeHtml(personalizationDiagnosticLabel(group.candidateDomainMarginBucket))} domain</span></div>
    <div class="personalization-metric-grid">
      <div><label>Median signed difference</label>${metric(group.signedDifferenceWatts.median, group.signedDifferenceWatts.count, " W")}</div>
      <div><label>Median absolute difference</label>${metric(group.absoluteDifferenceWatts.median, group.absoluteDifferenceWatts.count, " W")}</div>
      <div><label>Observed median inside candidate</label><strong>${group.observedMedianInsideCandidate.count} / ${group.observedMedianInsideCandidate.total}${group.observedMedianInsideCandidate.proportion === undefined ? "" : ` · ${percent(group.observedMedianInsideCandidate.proportion)}`}</strong><span>n = ${group.observedMedianInsideCandidate.total} phases</span></div>
      <div><label>Median HR coverage</label>${metric(group.hrCoverageRatio.median === undefined ? undefined : group.hrCoverageRatio.median * 100, group.hrCoverageRatio.count, "%")}</div>
      <div><label>Median power coverage</label>${metric(group.powerCoverageRatio.median === undefined ? undefined : group.powerCoverageRatio.median * 100, group.powerCoverageRatio.count, "%")}</div>
      <div><label>Median joint coverage</label>${metric(group.jointCoverageRatio.median === undefined ? undefined : group.jointCoverageRatio.median * 100, group.jointCoverageRatio.count, "%")}</div>
      <div><label>Controller saturation incidence</label><strong>${group.controllerSaturationIncidence.count} / ${group.controllerSaturationIncidence.total}${group.controllerSaturationIncidence.proportion === undefined ? "" : ` · ${percent(group.controllerSaturationIncidence.proportion)}`}</strong><span>n = ${group.controllerSaturationIncidence.total} candidate phases</span></div>
    </div>
  </article>`).join("");
  const exclusions = PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS.map((reason) => `<div><span>${escapeHtml(personalizationDiagnosticLabel(reason))}</span><strong>${model.exclusionCounts[reason]}</strong></div>`).join("");
  const allEvidenceExclusions = PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS.map((reason) => `<div><span>${escapeHtml(personalizationDiagnosticLabel(reason))}</span><strong>${evidence.exclusionCounts[reason]}</strong></div>`).join("");
  const rows = model.rows.map((row) => `<tr>
    <td>${escapeHtml(new Date(row.date).toLocaleDateString())}</td><td>${escapeHtml(row.workout)}</td><td>${escapeHtml(row.phase)}</td>
    <td>${escapeHtml(row.legacyHeartRate)}</td><td>${escapeHtml(row.candidateWatts)}</td><td>${row.observedInBandWatts === null ? "n/a" : `${Math.round(row.observedInBandWatts)} W`}</td><td>${row.deltaWatts === null ? "n/a" : `${row.deltaWatts > 0 ? "+" : ""}${Math.round(row.deltaWatts)} W`}</td>
    <td>${percent(row.hrCoveragePercent / 100)}</td><td>${percent(row.powerCoveragePercent / 100)}</td><td>${row.hrInsideTargetPercent === null ? "n/a" : percent(row.hrInsideTargetPercent / 100)}</td><td>${percent(row.saturationPercent / 100)}</td>
    <td>${escapeHtml(personalizationDiagnosticLabel(row.calibrationProvenance))}</td><td>${escapeHtml(personalizationDiagnosticLabel(row.observedPowerProvenance))}</td><td>${escapeHtml(personalizationDiagnosticLabel(row.outcome))}</td><td>${escapeHtml(personalizationDiagnosticLabel(row.exclusion))}</td>
    <td><button type="button" class="button secondary personalization-detail-button" onclick="openPersonalizationDiagnostic(${row.index})">Inspect</button></td>
  </tr>`).join("");
  return `<p class="developer-diagnostics-note">Active prescription is the legacy heart-rate band. Shadow athlete-relative prescription is candidate watts from formal VO₂ calibration. Bike work + threshold is the primary validated scope. These candidates have no live authority.</p>
    <section class="personalization-evidence-summary"><h4>All persisted E2 evidence</h4>
    <div class="personalization-count-grid">
      <div><strong>${evidence.completedWorkoutsWithE2}</strong><span>Completed workouts with E2</span></div>
      <div><strong>${evidence.candidatePhases}</strong><span>Candidate phases</span></div>
      <div><strong>${evidence.evaluableCandidatePhases}</strong><span>Evaluable candidate phases</span></div>
      <div><strong>${evidence.measuredToMeasuredObservations}</strong><span>Measured → measured observations</span></div>
      <div><strong>${evidence.cadenceCalibratedObservations}</strong><span>Any cadence-calibrated observations</span></div>
      <div><strong>${evidence.aerobicBaseCandidatePhases}</strong><span>Aerobic-base candidate phases</span></div>
      <div><strong>${evidence.aerobicVolumeCandidatePhases}</strong><span>Aerobic-volume candidate phases</span></div>
      <div><strong>${evidence.interiorCandidatePhases}</strong><span>Interior candidate phases</span></div>
      <div><strong>${evidence.edgeCandidatePhases}</strong><span>Edge candidate phases</span></div>
      <div><strong>${evidence.saturatedCandidatePhases} / ${evidence.saturationDeterminateCandidatePhases}${evidence.saturationIncidence === undefined ? "" : ` · ${percent(evidence.saturationIncidence)}`}</strong><span>Saturated / saturation-determinate candidates</span></div>
    </div>
    <div class="personalization-exclusions"><h4>Exclusions in all persisted evidence</h4>${allEvidenceExclusions}</div>
  </section>
    ${thresholdLongitudinalHtml(model.thresholdLongitudinal)}
    ${heldWorkloadForwardHtml(model.heldWorkloadForward)}
    ${executionProvenanceHtml(model.executionProvenance)}
    ${heldActuationContextHtml(model.heldActuationContext)}
    ${scientificAssessmentsHtml(model.scientificAssessments)}
    <div class="personalization-filter-grid">${filtersHtml}</div>
    <div class="personalization-count-grid"><div><strong>${aggregate.workoutCount}</strong><span>Completed workouts with E2 data</span></div><div><strong>${aggregate.candidatePhases}</strong><span>Candidate phases</span></div><div><strong>${aggregate.evaluableCandidatePhases}</strong><span>Evaluable candidate phases</span></div><div><strong>${aggregate.fallbackPhases}</strong><span>Fallback phases</span></div></div>
    ${aggregate.groups.length > 0 ? `<div class="personalization-cohorts">${cohortHtml}</div>` : `<div class="personalization-diagnostics-empty"><strong>No phases match these filters.</strong><span>Change a filter to inspect another cohort.</span></div>`}
    <div class="personalization-exclusions"><h4>Exclusions in visible cohort</h4>${exclusions}</div>
    <div class="personalization-table-scroll" tabindex="0"><table class="personalization-table"><thead><tr><th>Date</th><th>Workout</th><th>Phase</th><th>Legacy HR</th><th>Candidate watts</th><th>Observed in-band</th><th>Difference</th><th>HR coverage</th><th>Power coverage</th><th>HR in target</th><th>Saturation</th><th>Formal calibration</th><th>Observed power</th><th>Outcome</th><th>Exclusion</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div id="personalizationDiagnosticDetail" class="personalization-diagnostic-detail" hidden></div>`;
}

function detailRow(label: string, value: string | number | undefined): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${value === undefined ? "n/a" : escapeHtml(value)}</dd></div>`;
}

function formatBoundHeartRate(target: { min?: number; max?: number } | undefined): string {
  if (target?.min === undefined || target?.max === undefined) return "unavailable";
  return `${target.min}–${target.max} bpm`;
}

function formatWattsBand(power: { minWatts?: number; maxWatts?: number } | undefined): string {
  if (power?.minWatts === undefined || power?.maxWatts === undefined) return "unavailable";
  return `${power.minWatts}–${power.maxWatts} W`;
}

function formatOptionalWatts(value: number | undefined): string {
  return value === undefined ? "unavailable" : `${formatOptionalNumber(value)} W`;
}

function formatOptionalRpm(value: number | undefined): string {
  return value === undefined ? "unavailable" : `${formatOptionalNumber(value)} rpm`;
}

function formatOptionalNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

function formatOptionalPercent(value: number | undefined): string {
  return value === undefined ? "unavailable" : percent(value);
}

export function personalizationDiagnosticDetailHtml(row: PersonalizationDiagnosticPresentationRow): string {
  const phase = row.phaseRecord;
  const record = row.record;
  const coverage = phase.evidenceCoverage;
  const heartRate = phase.observedHeartRate;
  const power = phase.observedPower;
  const stable = phase.stableInBandWorkload;
  const comparison = phase.comparison;
  const controller = phase.controllerContext;
  const assessment = row.assessmentContext;
  const workout = row.workoutContext;
  const performed = row.performedLoadPhase;
  const signed = (value: number | undefined, suffix: string) => value === undefined ? "n/a" : `${value > 0 ? "+" : ""}${Math.round(value * 10) / 10}${suffix}`;
  const shadowWorkload = phase.candidatePower
    ? formatWattsBand(phase.candidatePower)
    : phase.fallbackReason
      ? personalizationDiagnosticLabel(phase.fallbackReason)
      : "unavailable";
  const activeHeartRate = formatBoundHeartRate(phase.legacyHeartRate);
  return `<div class="personalization-detail-heading"><div><h4>${escapeHtml(row.workout)} · ${escapeHtml(row.phase)}</h4><span>${escapeHtml(new Date(row.date).toLocaleString())}</span></div><button type="button" class="button secondary" onclick="closePersonalizationDiagnostic()">Close</button></div>
    <section><h5>Active prescription</h5><dl>${detailRow("Heart rate", activeHeartRate)}${detailRow("Resolver", `${LEGACY_HR_TARGET_RESOLVER_ID}@${LEGACY_HR_TARGET_RESOLVER_VERSION}`)}${detailRow("Live authority", "yes")}</dl></section>
    <section><h5>Shadow athlete-relative prescription</h5><dl>${detailRow("Workload", shadowWorkload)}${detailRow("Source", "formal VO₂ calibration")}${detailRow("Mode", "shadow")}${detailRow("Live authority", "no")}${detailRow("Outcome", personalizationDiagnosticLabel(row.outcome))}</dl></section>
    <section><h5>Observed response</h5><dl>${detailRow("Planned / observed duration", `${coverage.plannedDurationSec} / ${coverage.observedDurationSec} sec`)}${detailRow("HR / power / joint coverage", `${percent(coverage.hrCoverageRatio)} / ${percent(coverage.powerCoverageRatio)} / ${percent(coverage.jointCoverageRatio)}`)}${detailRow("HR median / min / max", heartRate ? `${heartRate.medianBpm} / ${heartRate.minBpm} / ${heartRate.maxBpm} bpm` : "n/a")}${detailRow("HR seconds below / inside / above", heartRate ? `${heartRate.belowBandSeconds} / ${heartRate.insideBandSeconds} / ${heartRate.aboveBandSeconds}` : "n/a")}${detailRow("Power median / IQR / min / max", power ? `${power.medianWatts} / ${power.q1Watts}–${power.q3Watts} / ${power.minWatts}–${power.maxWatts} W` : "n/a")}${detailRow("Power seconds below / inside / above candidate", power ? `${power.belowCandidateSeconds} / ${power.insideCandidateSeconds} / ${power.aboveCandidateSeconds}` : "n/a")}${detailRow("Settled in-band samples", stable?.sampleCount)}${detailRow("Settled median / IQR", stable ? `${stable.medianWatts} W / ${stable.q1Watts}–${stable.q3Watts} W` : "n/a")}${detailRow("Late vs early HR", signed(heartRate?.heartRateChangeLateVsEarlyBpm, " bpm"))}${detailRow("Controller saturation", `${percent(controller.saturationRatio)} · lower ${controller.lowerBoundaryDecisionCount}, upper ${controller.upperBoundaryDecisionCount} decisions`)}${detailRow("Observed watts (response)", formatOptionalWatts(performed?.wattsMedian))}${detailRow("Observed resistance (response)", performed?.observedResistanceMedian === undefined ? "unavailable" : String(performed.observedResistanceMedian))}${detailRow("Cadence (response)", formatOptionalRpm(performed?.cadenceMedianRpm))}${detailRow("Bike-row coverage (response)", formatOptionalPercent(performed?.observedResistanceCoverageRatio ?? performed?.freshBikeRowCoverageRatio))}</dl></section>
    <section><h5>Frozen evidence provenance</h5><dl>${detailRow("App version", workout?.appVersion ?? "unavailable")}${detailRow("Machine", workout?.machineId ?? "unavailable")}${detailRow("Machine profile version", workout?.machineProfileVersion ?? "unavailable")}${detailRow("Active / E1 / E2 schema", workout ? `${workout.activePrescriptionSchemaVersion ?? "n/a"} / ${workout.shadowSchemaVersion ?? "n/a"} / ${workout.characterizationSchemaVersion}` : "n/a")}${detailRow("Assessment evidence sessions", assessment?.evidenceSessionIds?.join(", ") ?? "n/a")}${detailRow("Assessment algorithm", assessment?.algorithm ? `${assessment.algorithm.id}@${assessment.algorithm.version}` : "n/a")}${detailRow("Assessment protocol", assessment?.protocol ? `${assessment.protocol.id}@${assessment.protocol.version}` : "n/a")}</dl></section>
    <section><h5>Frozen assessment context</h5><dl>${detailRow("Assessment date", assessment ? new Date(assessment.observedAt).toLocaleDateString() : "n/a")}${detailRow("Assessment quality", personalizationDiagnosticLabel(assessment?.quality ?? record.formalAssessmentQuality ?? "unavailable"))}${detailRow("Calibration provenance", personalizationDiagnosticLabel(assessment?.calibrationProvenance ?? record.calibrationWorkloadProvenance ?? "unavailable"))}${detailRow("Calibration HR range", assessment ? `${assessment.observedMinHeartRateBpm}–${assessment.observedMaxHeartRateBpm} bpm` : "n/a")}${detailRow("Calibration watt range", assessment ? `${assessment.observedMinWatts}–${assessment.observedMaxWatts} W` : "n/a")}${detailRow("Candidate watts", row.candidateWatts)}${detailRow("Assessment domain", personalizationDiagnosticLabel(row.assessmentDomain))}${detailRow("Domain HR margins", phase.candidateDomainMargins ? `${phase.candidateDomainMargins.heartRateToLowerBoundaryBpm} / ${phase.candidateDomainMargins.heartRateToUpperBoundaryBpm} bpm` : "n/a")}${detailRow("Domain watt margins", phase.candidateDomainMargins ? `${phase.candidateDomainMargins.wattsToLowerBoundary} / ${phase.candidateDomainMargins.wattsToUpperBoundary} W` : "n/a")}</dl></section>
    <section><h5>Closed-loop transfer evidence</h5><dl>${detailRow("Candidate midpoint", comparison ? `${comparison.candidateMidpointWatts} W` : "n/a")}${detailRow("Observed settled median", comparison ? `${comparison.observedInBandMedianWatts} W` : "n/a")}${detailRow("Signed / absolute difference", comparison ? `${signed(comparison.signedDifferenceWatts, " W")} / ${comparison.absoluteDifferenceWatts} W` : "n/a")}${detailRow("Percentage difference", comparison ? signed(comparison.signedDifferencePercent, "%") : "n/a")}${detailRow("Candidate contains observed median", comparison ? (comparison.candidateContainsObservedMedian ? "Yes" : "No") : "n/a")}${detailRow("Observed IQR overlap", comparison ? `${comparison.candidateObservedOverlapWatts} W · ${percent(comparison.candidateObservedOverlapRatio)}` : "n/a")}${detailRow("Descriptive agreement", personalizationDiagnosticLabel(row.agreement))}${detailRow("Outcome", personalizationDiagnosticLabel(row.outcome))}${detailRow("Exclusion", personalizationDiagnosticLabel(row.exclusion))}</dl></section>
    ${heldWorkloadDetailHtml(heldWorkloadResponseOf(phase))}
    ${provenanceDetailHtml(row.executionProvenance, phase)}`;
}
