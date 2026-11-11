/**
 * E4A cohort identity: what makes evidence belong to the same scientific
 * subject. Calibration-instance equality (evidence sessions compared as a
 * set), the full subject-identity match, identity construction from frozen
 * contexts, cohort admission, and distinct-subject discovery.
 */

import type { PolicyGeneration } from "./policy.js";
import { compareCanonicalText, isIsoDateTime, isNonEmptyString, isRecord } from "./guards.js";
import { heldSessionValid, phaseHasFrozenCandidate, sessionEvidenceValid } from "./qualification.js";
import type {
  BuildSubjectEvidenceInput,
  ScientificAssessmentCalibrationIdentity,
  ScientificAssessmentFrozenCalibrationContext,
  ScientificAssessmentFrozenWorkoutContext,
  ScientificAssessmentIntensity,
  ScientificAssessmentSessionEvidence,
  ScientificAssessmentSubject,
  ScientificHeldSessionEvidenceV2,
} from "./model.js";

export function calibrationEquals(
  left: ScientificAssessmentCalibrationIdentity,
  right: ScientificAssessmentCalibrationIdentity
): boolean {
  if (left.estimatorId !== right.estimatorId || left.estimatorVersion !== right.estimatorVersion) return false;
  if (left.protocolId !== right.protocolId || left.protocolVersion !== right.protocolVersion) return false;
  if (left.observedAt !== right.observedAt || left.workloadProvenance !== right.workloadProvenance) return false;
  // Evidence session IDs identify the calibration instance as a set: order
  // must not turn the same calibration into a false supersession.
  const leftIds = normalizedSessionIds(left.evidenceSessionIds);
  const rightIds = normalizedSessionIds(right.evidenceSessionIds);
  if (leftIds.length !== rightIds.length) return false;
  return leftIds.every((id, index) => id === rightIds[index]);
}

export function normalizedSessionIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort(compareCanonicalText);
}

/** Subject identity fields shared by both cohorts; no HR-band success or closed-loop value involved. */
type SubjectIdentityFields = Pick<ScientificAssessmentSessionEvidence, "athleteId" | "activity" | "phaseKind" |
  "intensityId" | "calibration" | "machineId" | "machineProfileVersion" | "observedPowerProvenance" | "legacyHrBand">;

export function sessionMatchesSubject(
  session: SubjectIdentityFields,
  subject: ScientificAssessmentSubject
): boolean {
  if (session.athleteId !== subject.athleteId) return false;
  if (session.activity !== subject.activity || session.phaseKind !== subject.phaseKind) return false;
  if (session.intensityId !== subject.intensityId) return false;
  if (!calibrationEquals(session.calibration, subject.calibration)) return false;
  if (session.machineId !== subject.machineId) return false;
  if (session.machineProfileVersion !== subject.machineProfileVersion) return false;
  if (session.observedPowerProvenance !== subject.observedPowerProvenance) return false;
  if (session.legacyHrBand?.minBpm !== subject.legacyHrBand.minBpm) return false;
  if (session.legacyHrBand?.maxBpm !== subject.legacyHrBand.maxBpm) return false;
  return true;
}

export function sessionIdentityFrom(
  record: BuildSubjectEvidenceInput["records"][number],
  assessment: ScientificAssessmentFrozenCalibrationContext | undefined,
  workout: ScientificAssessmentFrozenWorkoutContext | undefined
): ScientificAssessmentCalibrationIdentity | null {
  const sessionIds = assessment?.evidenceSessionIds?.filter(isNonEmptyString) ?? [];
  const uniqueSorted = [...new Set(sessionIds)].sort(compareCanonicalText);
  if (uniqueSorted.length === 0) return null;
  if (!isIsoDateTime(assessment?.observedAt)) return null;
  if (!isNonEmptyString(assessment?.algorithm?.id)) return null;
  if (!Number.isInteger(assessment?.algorithm?.version)) return null;
  if (!isNonEmptyString(assessment?.protocol?.id)) return null;
  if (!Number.isInteger(assessment?.protocol?.version)) return null;
  const provenance = record.calibrationWorkloadProvenance ?? assessment?.calibrationProvenance;
  if (provenance !== "measured_watts" && provenance !== "calibrated_at_verified_cadence") return null;
  if (!isNonEmptyString(workout?.machineId)) return null;
  if (!Number.isInteger(workout?.machineProfileVersion)) return null;
  return {
    evidenceSessionIds: uniqueSorted,
    estimatorId: assessment.algorithm!.id,
    estimatorVersion: assessment.algorithm!.version,
    protocolId: assessment.protocol!.id,
    protocolVersion: assessment.protocol!.version,
    observedAt: assessment.observedAt,
    workloadProvenance: provenance,
  };
}

/**
 * Transfer-cohort admission. Only sessions matching every subject identity
 * dimension participate; malformed or duplicated in-cohort sessions are
 * excluded with counts. Survivors are put in canonical ID order.
 */
export function admitTransferSessions(
  evidenceSessions: readonly ScientificAssessmentSessionEvidence[] | undefined,
  subject: ScientificAssessmentSubject,
  subjectComparable: boolean
): {
  validSessions: ScientificAssessmentSessionEvidence[];
  ignoredCrossCohortSessions: number;
  ignoredInvalidSessions: number;
} {
  let ignoredCrossCohortSessions = 0;
  let ignoredInvalidSessions = 0;
  const cohortSessions = [...(evidenceSessions ?? [])].filter((session) => {
    if (!subjectComparable || !sessionMatchesSubject(session, subject)) {
      ignoredCrossCohortSessions += 1;
      return false;
    }
    return true;
  });
  const idCounts = new Map<string, number>();
  for (const session of cohortSessions) {
    idCounts.set(session.workoutSessionId, (idCounts.get(session.workoutSessionId) ?? 0) + 1);
  }
  // Malformed evidence (unparseable timestamp, non-finite measurement,
  // unknown domain bucket) and duplicated workout session IDs cannot count as
  // independent sessions; every copy is excluded rather than picking one.
  const validSessions = cohortSessions.filter((session) => {
    if (sessionEvidenceValid(session) && idCounts.get(session.workoutSessionId) === 1) return true;
    ignoredInvalidSessions += 1;
    return false;
  }).sort((a, b) => compareCanonicalText(a.workoutSessionId, b.workoutSessionId));
  return { validSessions, ignoredCrossCohortSessions, ignoredInvalidSessions };
}

/**
 * Policy v2 machine comparability admission for the transfer channel. Policy
 * v1 keeps every valid session; incomparable sessions are counted by reason.
 */
export function partitionTransferByMachine(
  validSessions: ScientificAssessmentSessionEvidence[],
  generation: PolicyGeneration
): {
  sessions: ScientificAssessmentSessionEvidence[];
  excludedTransferMachineIncomparableSessions: Record<string, number>;
} {
  const excludedTransferMachineIncomparableSessions: Record<string, number> = {};
  const sessions = generation === 1 ? validSessions : validSessions.filter((session) => {
    if (session.provenanceV2?.machineComparison.comparable === true) return true;
    const reason = session.provenanceV2?.machineComparison.reason ?? "execution_provenance_unavailable";
    excludedTransferMachineIncomparableSessions[reason] = (excludedTransferMachineIncomparableSessions[reason] ?? 0) + 1;
    return false;
  });
  return { sessions, excludedTransferMachineIncomparableSessions };
}

/**
 * Policy v2 held-response cohort admission: subject-matching held-forward
 * workouts, independent of closed-loop characterization and HR-band success.
 */
export function admitHeldSessions(
  heldSessionsV2: readonly ScientificHeldSessionEvidenceV2[] | undefined,
  subject: ScientificAssessmentSubject,
  subjectComparable: boolean
): {
  heldSessions: ScientificHeldSessionEvidenceV2[];
  validHeldCount: number;
  ignoredInvalidHeldSessions: number;
  excludedHeldMachineIncomparableSessions: Record<string, number>;
} {
  let ignoredInvalidHeldSessions = 0;
  const excludedHeldMachineIncomparableSessions: Record<string, number> = {};
  const candidates = [...(heldSessionsV2 ?? [])];
  const heldIds = new Map<string, number>();
  for (const session of candidates) {
    if (isRecord(session) && isNonEmptyString(session.workoutSessionId)) {
      heldIds.set(session.workoutSessionId, (heldIds.get(session.workoutSessionId) ?? 0) + 1);
    }
  }
  const validHeld = candidates.filter((session) => {
    if (subjectComparable && heldSessionValid(session) && sessionMatchesSubject(session, subject) &&
      heldIds.get(session.workoutSessionId) === 1) return true;
    ignoredInvalidHeldSessions += 1;
    return false;
  }).sort((a, b) => compareCanonicalText(a.workoutSessionId, b.workoutSessionId));
  const validHeldCount = validHeld.length;
  const heldSessions = validHeld.filter((session) => {
    if (session.provenanceV2.machineComparison.comparable) return true;
    const reason = session.provenanceV2.machineComparison.reason;
    excludedHeldMachineIncomparableSessions[reason] = (excludedHeldMachineIncomparableSessions[reason] ?? 0) + 1;
    return false;
  });
  return { heldSessions, validHeldCount, ignoredInvalidHeldSessions, excludedHeldMachineIncomparableSessions };
}

/**
 * Discovers distinct hardened subject cohorts present in frozen E2 evidence
 * for the assessable intensities (`threshold`, `aerobic_base`) without
 * hard-coding the reducer to Thursday. Each distinct full-identity cohort
 * becomes one assessed subject. A subject is discovered from any phase whose
 * frozen E1 outcome is a candidate, so a valid subject that is still
 * collecting E2 evidence (no characterized session yet) is assessed as
 * `collecting` rather than hidden. Cohorts with incomplete identity
 * (including an observed-power provenance that is not measured/calibrated)
 * never become subjects. Phase-structure class stays `null` (see subject docs).
 */
export function discoverDiagnosticSubjects(
  records: BuildSubjectEvidenceInput["records"],
  assessmentContexts: BuildSubjectEvidenceInput["assessmentContexts"],
  workoutContexts: BuildSubjectEvidenceInput["workoutContexts"],
  athleteId: string
): ScientificAssessmentSubject[] {
  const seen = new Map<string, ScientificAssessmentSubject>();
  const intensities: ScientificAssessmentIntensity[] = ["threshold", "aerobic_base"];
  for (const record of records) {
    if (record.athleteId !== athleteId || record.activity !== "bike") continue;
    const assessment = assessmentContexts[record.workoutSessionId];
    const workout = workoutContexts[record.workoutSessionId];
    const identity = sessionIdentityFrom(record, assessment, workout);
    if (identity === null) continue;
    for (const phase of record.phases) {
      if (phase.kind !== "work" || !phaseHasFrozenCandidate(phase)) continue;
      if (phase.intensityId !== intensities[0] && phase.intensityId !== intensities[1]) continue;
      if (phase.legacyHeartRate?.min === undefined || phase.legacyHeartRate?.max === undefined) continue;
      if (phase.observedPowerProvenance !== "measured_watts" &&
        phase.observedPowerProvenance !== "calibrated_watts") continue;
      if (!isNonEmptyString(workout?.machineId)) continue;
      if (!Number.isInteger(workout?.machineProfileVersion)) continue;
      const subject: ScientificAssessmentSubject = {
        athleteId,
        activity: "bike",
        phaseKind: "work",
        intensityId: phase.intensityId as ScientificAssessmentIntensity,
        modality: "legacy_hr_region_workload",
        phaseStructureClass: null,
        calibration: identity,
        machineId: workout.machineId!,
        machineProfileVersion: workout.machineProfileVersion!,
        observedPowerProvenance: phase.observedPowerProvenance as
          | "measured_watts"
          | "calibrated_watts",
        legacyHrBand: { minBpm: phase.legacyHeartRate.min!, maxBpm: phase.legacyHeartRate.max! },
      };
      const key = JSON.stringify([
        subject.intensityId,
        subject.calibration.evidenceSessionIds,
        subject.calibration.estimatorId,
        subject.calibration.estimatorVersion,
        subject.calibration.protocolId,
        subject.calibration.protocolVersion,
        subject.calibration.observedAt,
        subject.calibration.workloadProvenance,
        subject.machineId,
        subject.machineProfileVersion,
        subject.observedPowerProvenance,
        subject.legacyHrBand.minBpm,
        subject.legacyHrBand.maxBpm,
      ]);
      if (!seen.has(key)) seen.set(key, subject);
    }
  }
  // Sorted by the full cohort key so output order never depends on record
  // order, even for subjects that differ only in estimator, protocol,
  // provenance, or machine-profile version.
  return [...seen.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, subject]) => subject);
}
