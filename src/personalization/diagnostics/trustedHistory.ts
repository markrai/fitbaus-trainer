/**
 * Trusted diagnostic inputs from strictly parsed workout history
 * (getAllWorkoutSummaries output): identity-checked E2 records and frozen
 * assessment, workout, execution-provenance and performed-load contexts.
 * No parser and no storage access here.
 */

import {
  buildPhasePerformedLoadViews,
  type PhasePerformedLoadView,
} from "../../performedLoad.js";
import type { PersonalizedPrescriptionCharacterization, PersonalizedPrescriptionEvaluationV1, WorkoutExecutionProvenanceV1 } from "../../types.js";
import type { FrozenAssessmentDiagnosticContext, FrozenWorkoutDiagnosticContext, TrustedWorkoutHistoryRow } from "./model.js";

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
