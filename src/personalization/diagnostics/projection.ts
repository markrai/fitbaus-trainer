/**
 * Personalization diagnostics projection: what the developer diagnostics
 * show. Filters, all-record summaries, the diagnostics view model, and E4A
 * scientific assessments via the public E4A facade. Pure and read-only:
 * no DOM, no storage, no control path.
 */

import { aggregatePersonalizedPrescriptionCharacterizations, personalizedPrescriptionDiagnosticRows } from "../../personalizedPrescriptionCharacterization.js";
import type { PhasePerformedLoadView } from "../../performedLoad.js";
import {
  E4A_CURRENT_SCIENTIFIC_ASSESSMENT_POLICY,
  assessPersonalizedWorkloadEvidence,
  buildSubjectEvidence,
  discoverDiagnosticSubjects,
  type ScientificAssessment,
} from "../../personalizationScientificAssessment.js";
import { canonicalMedian } from "../../stats.js";
import type { ScientificSessionEvidenceV2 } from "../../scientificSessionEvidence.js";
import type { PersonalizedPrescriptionCharacterization, PersonalizedPrescriptionCharacterizationExclusionReasonV1, PersonalizedPrescriptionHeldWorkloadForwardResponseV1, PersonalizedPrescriptionPhaseCharacterizationV1, WorkoutExecutionProvenanceV1 } from "../../types.js";
import {
  EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS,
  PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS,
  type FrozenAssessmentDiagnosticContext,
  type FrozenWorkoutDiagnosticContext,
  type PersonalizationDiagnosticPresentationRow,
  type PersonalizationDiagnosticsFilterOptions,
  type PersonalizationDiagnosticsFilters,
  type PersonalizationDiagnosticsModel,
  type PersonalizationEvidenceCollectionSummary,
  type PersonalizationExecutionProvenanceSummary,
  type PersonalizationHeldActuationContextRow,
  type PersonalizationHeldWorkloadForwardSummary,
} from "./model.js";
import { buildThresholdLongitudinalAnalysis } from "./longitudinal.js";

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
export function withPhases(
  record: PersonalizedPrescriptionCharacterization,
  phases: readonly PersonalizedPrescriptionPhaseCharacterizationV1[]
): PersonalizedPrescriptionCharacterization {
  return { ...record, phases: [...phases] } as PersonalizedPrescriptionCharacterization;
}

export function heldWorkloadResponseOf(
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
