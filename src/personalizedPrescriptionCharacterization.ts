/**
 * E2 completed-workout characterization of frozen E1 shadow candidates
 * (including held-workload forward-response). Diagnostic / descriptive only —
 * never live workout control. See docs/personalization-architecture.md.
 */

import {
  PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V1,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V2,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V1,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V2,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V3,
  PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1,
  PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1,
  PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1,
  type BikeWattsProvenance,
  type HrSample,
  type OrdinaryBikeTelemetrySample,
  type PersonalizedPrescriptionCandidateComparisonV1,
  type PersonalizedPrescriptionCharacterizationExclusionReasonV1,
  type PersonalizedPrescriptionCharacterizationPolicyV1,
  type PersonalizedPrescriptionCharacterization,
  type PersonalizedPrescriptionCharacterizationV1,
  type CurrentPersonalizedPrescriptionCharacterization,
  type PersonalizedPrescriptionControllerContextV1,
  type PersonalizedPrescriptionDistributionV1,
  type PersonalizedPrescriptionEvaluationV1,
  type PersonalizedPrescriptionHeldWorkloadForwardModelV1,
  type PersonalizedPrescriptionHeldWorkloadForwardResponseV1,
  type PersonalizedPrescriptionHeldWorkloadPolicyV1,
  type PersonalizedPrescriptionPhaseCharacterizationV1,
  type PersonalizedPrescriptionPhaseCharacterizationV3,
  type PersonalizedPrescriptionStableResistanceSummaryV1,
  type PersonalizedPrescriptionPhaseEvaluationV1,
  type PersonalizedPrescriptionResistanceCoverageV1,
  type WorkoutPhaseResponse,
  type WorkoutResponse,
} from "./types.js";
import type { MachineDecisionAuditEntry } from "./machines/audit/types.js";
import { parseOrdinaryBikeTelemetrySample } from "./ordinaryWorkoutTelemetry.js";
import { parsePersonalizedPrescriptionEvaluation } from "./personalizedPrescription.js";
import { parseWorkoutResponse } from "./workoutResponse.js";
import { VO2_FORMAL_ASSESSMENT_CONTRACT_V1 } from "./vo2Estimator.js";
import { cadenceInBand } from "./vo2Workload.js";
import {
  absolutePredictionError,
  countContinuousResistanceChanges,
  numericDistribution,
  numericMedian,
  numericQuantile,
  orderByActiveSecond,
  predictForwardResponse,
  segmentStableResistance,
  settledActiveSeconds,
  signedPredictionError,
  type StableResistanceObservation,
} from "./workloadForwardResponse.js";

/** Provisional evidence-quality policy only. These values never authorize control. */
export const PHASE_E2_CHARACTERIZATION_POLICY_V1: PersonalizedPrescriptionCharacterizationPolicyV1 = {
  id: "e2-characterization-policy",
  version: 1,
  minObservedPhaseDurationSec: 60,
  minHrCoverageRatio: 0.8,
  minPowerCoverageRatio: 0.8,
  minJointCoverageRatio: 0.75,
  settlingSeconds: 30,
  minSettledInBandSeconds: 15,
  heartRateChangeWindowSeconds: 60,
  minHeartRateChangeWindowSamples: 30,
  domainEdgeFraction: 0.1,
};

/**
 * E2 v3 held-workload forward-response characterization policy. These are
 * versioned characterization policy values, not validated universal
 * physiological constants and not activation, safety, or E4 pass/fail thresholds.
 *
 * settlingSeconds = 120: the frozen formal calibration's HR points are
 * steady-state minute-3 responses of >= 180 s protocol stages, so HR is only
 * compared with the forward prediction after a comparable time under held load.
 * Gap and wall-clock tolerances absorb 1 Hz sampling jitter on the active clock;
 * the active clock stops while paused, so larger wall-clock excess is a pause.
 */
export const PHASE_E2_HELD_WORKLOAD_POLICY_V1: PersonalizedPrescriptionHeldWorkloadPolicyV1 = {
  id: "e2-held-workload-forward-response-policy",
  version: 1,
  settlingSeconds: 120,
  maxObservationGapSec: 2,
  maxWallClockExcessSec: 2,
  minQualifyingSeconds: 30,
};

const OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_PHASES = 100;

export interface CharacterizationSummaryIdentity {
  external_session_id: string;
  athlete_id?: string;
  day?: string;
  intent: string;
  activity?: "bike" | "elliptical" | "strength";
}

export interface CharacterizePersonalizedPrescriptionInput {
  summary: CharacterizationSummaryIdentity;
  shadowEvaluation: unknown;
  workoutResponse: unknown;
  hrSamples: readonly HrSample[];
  bikeSamples: readonly OrdinaryBikeTelemetrySample[];
  machineDecisionAudit?: readonly MachineDecisionAuditEntry[];
  policy: PersonalizedPrescriptionCharacterizationPolicyV1;
  /** Defaults to PHASE_E2_HELD_WORKLOAD_POLICY_V1. */
  heldWorkloadPolicy?: PersonalizedPrescriptionHeldWorkloadPolicyV1;
  createdAt: string;
}

export const PERSONALIZED_PRESCRIPTION_AGGREGATE_SCHEMA_VERSION_V1 = 1 as const;
export const PERSONALIZED_PRESCRIPTION_AGGREGATE_SCHEMA_VERSION_V2 = 2 as const;
export const PERSONALIZED_PRESCRIPTION_AGGREGATE_SCHEMA_VERSION =
  PERSONALIZED_PRESCRIPTION_AGGREGATE_SCHEMA_VERSION_V2;

export interface PersonalizedPrescriptionCharacterizationAggregateGroupV1 {
  workoutIntent: string;
  intensityId: string;
  calibrationWorkloadProvenance: string;
  observedPowerProvenance: string;
  formalAssessmentQuality: string;
  candidateDomainMarginBucket: string;
  completedWorkouts: number;
  phaseCount: number;
  candidatePhases: number;
  fallbackPhases: number;
  evaluableCandidatePhases: number;
  exclusionCounts: Record<string, number>;
  signedDifferenceWatts: { count: number; median?: number };
  absoluteDifferenceWatts: { count: number; median?: number };
  observedMedianInsideCandidate: { count: number; total: number; proportion?: number };
  heartRateInsideBandRatio: { count: number; median?: number };
  hrCoverageRatio: { count: number; median?: number };
  powerCoverageRatio: { count: number; median?: number };
  jointCoverageRatio: { count: number; median?: number };
  controllerSaturationIncidence: { count: number; total: number; proportion?: number };
}

/** Current cohort shape. Formal-assessment identity is part of the grouping key. */
export interface PersonalizedPrescriptionCharacterizationAggregateGroupV2
  extends PersonalizedPrescriptionCharacterizationAggregateGroupV1 {
  formalAssessmentAlgorithm: string;
  formalAssessmentProtocol: string;
}

export interface PersonalizedPrescriptionCharacterizationAggregateV1 {
  schemaVersion: typeof PERSONALIZED_PRESCRIPTION_AGGREGATE_SCHEMA_VERSION_V1;
  workoutCount: number;
  phaseCount: number;
  candidatePhases: number;
  fallbackPhases: number;
  evaluableCandidatePhases: number;
  groups: PersonalizedPrescriptionCharacterizationAggregateGroupV1[];
}

export interface PersonalizedPrescriptionCharacterizationAggregateV2 {
  schemaVersion: typeof PERSONALIZED_PRESCRIPTION_AGGREGATE_SCHEMA_VERSION_V2;
  workoutCount: number;
  phaseCount: number;
  candidatePhases: number;
  fallbackPhases: number;
  evaluableCandidatePhases: number;
  groups: PersonalizedPrescriptionCharacterizationAggregateGroupV2[];
}

export type PersonalizedPrescriptionCharacterizationAggregate =
  | PersonalizedPrescriptionCharacterizationAggregateV1
  | PersonalizedPrescriptionCharacterizationAggregateV2;
export type CurrentPersonalizedPrescriptionCharacterizationAggregate =
  PersonalizedPrescriptionCharacterizationAggregateV2;

export interface PersonalizedPrescriptionDiagnosticRowV1 {
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
  observedPowerProvenance: string;
  outcome: string;
  exclusion: string;
}

export interface PersonalizedPrescriptionDiagnosticRowV2 extends PersonalizedPrescriptionDiagnosticRowV1 {
  formalAssessmentProvenance: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function containsNonFiniteNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFiniteNumber);
  if (isObject(value)) return Object.values(value).some(containsNonFiniteNumber);
  return false;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function ratioValue(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}

function iso(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function ratio(count: number, duration: number): number {
  return duration > 0 ? Math.max(0, Math.min(1, count / duration)) : 0;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

const quantile = numericQuantile;
const median = numericMedian;

function policyValid(value: unknown): value is PersonalizedPrescriptionCharacterizationPolicyV1 {
  if (!isObject(value) || value.id !== "e2-characterization-policy" || value.version !== 1) return false;
  return Number.isInteger(value.minObservedPhaseDurationSec) && (value.minObservedPhaseDurationSec as number) > 0 &&
    ratioValue(value.minHrCoverageRatio) && ratioValue(value.minPowerCoverageRatio) &&
    ratioValue(value.minJointCoverageRatio) && Number.isInteger(value.settlingSeconds) &&
    (value.settlingSeconds as number) >= 0 && Number.isInteger(value.minSettledInBandSeconds) &&
    (value.minSettledInBandSeconds as number) > 0 && Number.isInteger(value.heartRateChangeWindowSeconds) &&
    (value.heartRateChangeWindowSeconds as number) > 0 && Number.isInteger(value.minHeartRateChangeWindowSamples) &&
    (value.minHeartRateChangeWindowSamples as number) > 0 && ratioValue(value.domainEdgeFraction);
}

function phaseMatches(
  shadow: PersonalizedPrescriptionPhaseEvaluationV1,
  response: WorkoutPhaseResponse
): boolean {
  if (shadow.phaseId !== response.phaseId || shadow.kind !== response.kind) return false;
  if (shadow.intensityId !== response.intensityId || shadow.intervalIndex !== response.intervalIndex) return false;
  if (shadow.activeStartSec !== undefined && shadow.activeStartSec !== response.activeStartSec) return false;
  if (shadow.activeEndSec !== undefined && shadow.activeEndSec !== response.activeEndSec) return false;
  return true;
}

function responseForPhase(
  shadow: PersonalizedPrescriptionPhaseEvaluationV1,
  response: WorkoutResponse
): WorkoutPhaseResponse | undefined {
  const matches = response.phases.filter((phase) => phaseMatches(shadow, phase));
  return matches.length === 1 ? matches[0] : undefined;
}

function resistanceCoverage(
  samples: readonly OrdinaryBikeTelemetrySample[],
  selector: (sample: OrdinaryBikeTelemetrySample) => number | undefined
): PersonalizedPrescriptionResistanceCoverageV1 {
  const values = samples.map(selector).filter((value): value is number => finite(value));
  return {
    coveredSeconds: values.length,
    lowerBoundSeconds: values.filter((value) => value === 1).length,
    upperBoundSeconds: values.filter((value) => value === 15).length,
  };
}

function controllerContext(
  samples: readonly OrdinaryBikeTelemetrySample[],
  audit: readonly MachineDecisionAuditEntry[],
  observedDurationSec: number
): PersonalizedPrescriptionControllerContextV1 {
  const observed = resistanceCoverage(samples, (sample) => sample.observedResistance?.value);
  const desired = resistanceCoverage(samples, (sample) => sample.desiredResistance);
  const commanded = resistanceCoverage(samples, (sample) => sample.commandedResistance);
  const saturatedSeconds = new Set<number>();
  for (const sample of samples) {
    const values = [sample.observedResistance?.value, sample.desiredResistance, sample.commandedResistance];
    if (values.some((value) => value === 1 || value === 15)) saturatedSeconds.add(sample.activeSec);
  }
  return {
    available: observed.coveredSeconds + desired.coveredSeconds + commanded.coveredSeconds > 0 || audit.length > 0,
    observed,
    desired,
    commanded,
    anyBoundarySaturationSeconds: saturatedSeconds.size,
    saturationRatio: ratio(saturatedSeconds.size, observedDurationSec),
    lowerBoundaryDecisionCount: audit.filter(
      (entry) => entry.kind === "evaluation" && entry.constraint === "r1_floor"
    ).length,
    upperBoundaryDecisionCount: audit.filter(
      (entry) => entry.kind === "evaluation" && entry.constraint === "r15_cap"
    ).length,
  };
}

/**
 * Closed-loop settling timestamps only (any observed, desired, or commanded change restarts settling).
 * Held-workload segmentation uses fresh observed resistance alone; auto/manual mode is not captured.
 */
function resistanceChangeSeconds(samples: readonly OrdinaryBikeTelemetrySample[]): number[] {
  const changes = new Set<number>();
  let previousObserved: number | undefined;
  let previousDesired: number | undefined;
  let previousCommanded: number | undefined;
  for (const sample of orderByActiveSecond(samples)) {
    const values = [sample.observedResistance?.value, sample.desiredResistance, sample.commandedResistance];
    const previous = [previousObserved, previousDesired, previousCommanded];
    if (values.some((value, index) => value !== undefined && previous[index] !== undefined && value !== previous[index])) {
      changes.add(sample.activeSec);
    }
    if (values[0] !== undefined) previousObserved = values[0];
    if (values[1] !== undefined) previousDesired = values[1];
    if (values[2] !== undefined) previousCommanded = values[2];
  }
  return [...changes];
}

function isSettled(second: number, phaseStart: number, changes: readonly number[], settlingSeconds: number): boolean {
  if (second < phaseStart + settlingSeconds) return false;
  return !changes.some((change) => second >= change && second < change + settlingSeconds);
}

function observedPowerProvenance(samples: readonly OrdinaryBikeTelemetrySample[]):
  BikeWattsProvenance | "mixed" | "unavailable" {
  const sources = new Set(samples.flatMap((sample) => sample.watts ? [sample.watts.source] : []));
  if (sources.size === 0) return "unavailable";
  if (sources.size > 1) return "mixed";
  return [...sources][0];
}

function exclusionFor(
  coverage: PersonalizedPrescriptionPhaseCharacterizationV1["evidenceCoverage"],
  provenance: BikeWattsProvenance | "mixed" | "unavailable",
  settledCount: number,
  policy: PersonalizedPrescriptionCharacterizationPolicyV1
): PersonalizedPrescriptionCharacterizationExclusionReasonV1 | undefined {
  if (coverage.observedDurationSec < policy.minObservedPhaseDurationSec) return "phase_too_short";
  if (coverage.hrCoveredSeconds === 0 && coverage.powerCoveredSeconds === 0) return "missing_telemetry";
  if (coverage.hrCoverageRatio < policy.minHrCoverageRatio) return "insufficient_hr_coverage";
  if (coverage.powerCoverageRatio < policy.minPowerCoverageRatio) return "insufficient_power_coverage";
  if (coverage.jointCoverageRatio < policy.minJointCoverageRatio) return "insufficient_joint_coverage";
  if (provenance === "mixed") return "unsupported_power_provenance";
  if (provenance === "unavailable") return "insufficient_power_coverage";
  if (settledCount < policy.minSettledInBandSeconds) return "insufficient_settled_in_band_evidence";
  return undefined;
}

function compareCandidate(
  minCandidate: number,
  maxCandidate: number,
  stableValues: readonly number[]
): PersonalizedPrescriptionCandidateComparisonV1 {
  const candidateMidpointWatts = (minCandidate + maxCandidate) / 2;
  const observedInBandMedianWatts = median(stableValues);
  const signedDifferenceWatts = observedInBandMedianWatts - candidateMidpointWatts;
  const observedQ1 = quantile(stableValues, 0.25);
  const observedQ3 = quantile(stableValues, 0.75);
  const overlap = Math.max(0, Math.min(maxCandidate, observedQ3) - Math.max(minCandidate, observedQ1));
  const observedBandWidth = observedQ3 - observedQ1;
  return {
    candidateMidpointWatts,
    observedInBandMedianWatts,
    signedDifferenceWatts,
    absoluteDifferenceWatts: Math.abs(signedDifferenceWatts),
    signedDifferencePercent: candidateMidpointWatts > 0
      ? signedDifferenceWatts / candidateMidpointWatts
      : 0,
    candidateContainsObservedMedian:
      observedInBandMedianWatts >= minCandidate && observedInBandMedianWatts <= maxCandidate,
    candidateObservedOverlapWatts: overlap,
    candidateObservedOverlapRatio: observedBandWidth > 0
      ? overlap / observedBandWidth
      : observedInBandMedianWatts >= minCandidate && observedInBandMedianWatts <= maxCandidate ? 1 : 0,
    agreement: observedInBandMedianWatts < minCandidate
      ? "below_candidate"
      : observedInBandMedianWatts > maxCandidate
        ? "above_candidate"
        : "inside_candidate",
  };
}

function distribution(values: readonly number[]): PersonalizedPrescriptionDistributionV1 {
  return numericDistribution(values);
}

function heldWorkloadPolicyValid(value: unknown): value is PersonalizedPrescriptionHeldWorkloadPolicyV1 {
  if (!isObject(value) || value.id !== "e2-held-workload-forward-response-policy" || value.version !== 1) return false;
  return Number.isInteger(value.settlingSeconds) && (value.settlingSeconds as number) >= 0 &&
    Number.isInteger(value.maxObservationGapSec) && (value.maxObservationGapSec as number) >= 1 &&
    nonNegative(value.maxWallClockExcessSec) &&
    Number.isInteger(value.minQualifyingSeconds) && (value.minQualifyingSeconds as number) > 0;
}

function forwardModelFrom(evaluation: PersonalizedPrescriptionEvaluationV1):
  PersonalizedPrescriptionHeldWorkloadForwardModelV1 | undefined {
  const calibration = evaluation.fitnessEvidenceSnapshot?.calibration;
  if (!calibration) return undefined;
  return {
    interceptBpm: calibration.interceptBpm,
    slopeBpmPerWatt: calibration.slopeBpmPerWatt,
    observedMinWatts: calibration.observedMinWatts,
    observedMaxWatts: calibration.observedMaxWatts,
  };
}

/** Fresh physical observation of resistance. Desired and commanded resistance never qualify. */
function hasFreshObservedResistance(sample: OrdinaryBikeTelemetrySample): boolean {
  return sample.availability === "fresh" && sample.observedResistance !== undefined;
}

type PhasePowerProvenance = PersonalizedPrescriptionHeldWorkloadForwardResponseV1["observedPowerProvenance"];

/**
 * Whether a sample may preserve held-load continuity for a phase of the given
 * observed power provenance.
 *
 * measured_watts: fresh observed resistance alone establishes mechanical
 * continuity; a missing watt sample stays inside the hold as unavailable
 * evidence and cadence is descriptive.
 *
 * calibrated_watts (and mixed, which never yields forward evidence): calibrated
 * watts are the resistance-table workload at the formal protocol cadence, so
 * cadence is part of the workload model. Every sample, including one with no
 * watt estimate, must carry fresh measured cadence inside the existing
 * verified-cadence contract; missing or off-band cadence breaks the window, so
 * it can never advance calibrated-workload settling time. A sample with
 * unchanged fresh observed resistance and verified cadence but no watt estimate
 * keeps the same contract workload, so it remains inside the hold and is
 * counted as watts-unavailable evidence (never imputed).
 */
function heldObservationTrustworthy(sample: OrdinaryBikeTelemetrySample, phaseProvenance: PhasePowerProvenance): boolean {
  if (!hasFreshObservedResistance(sample)) return false;
  const cadenceIsWorkloadModel = phaseProvenance === "calibrated_watts" || phaseProvenance === "mixed" ||
    sample.watts?.source === "calibrated_watts";
  if (!cadenceIsWorkloadModel) return true;
  return sample.cadenceRpm !== undefined && cadenceInBand(sample.cadenceRpm.value);
}

/**
 * Active-clock continuity. The active clock stops while paused, so wall-clock
 * excess reveals a pause. Wall-clock chronology must also move forward: a zero
 * or negative wall step for advancing active time breaks continuity.
 */
interface HeldWindow {
  resistance: number;
  provenance?: BikeWattsProvenance;
  samples: OrdinaryBikeTelemetrySample[];
}

/** Maximal runs of unchanged fresh observed resistance inside one phase; never bridges pauses or gaps. */
function stableObservedResistanceWindows(
  samples: readonly OrdinaryBikeTelemetrySample[],
  phaseProvenance: PhasePowerProvenance,
  policy: PersonalizedPrescriptionHeldWorkloadPolicyV1
): HeldWindow[] {
  const normalized = samples.map((sample) => ({
    sample,
    activeSec: sample.activeSec,
    observedAt: sample.observedAt,
    ...(heldObservationTrustworthy(sample, phaseProvenance)
      ? { observedResistance: sample.observedResistance!.value }
      : {}),
    ...(sample.watts?.source ? { workloadProvenance: sample.watts.source } : {}),
  } satisfies StableResistanceObservation & { sample: OrdinaryBikeTelemetrySample }));
  return segmentStableResistance(normalized, policy).map((window) => ({
    resistance: window.resistance,
    ...(window.workloadProvenance ? { provenance: window.workloadProvenance as BikeWattsProvenance } : {}),
    samples: window.observations.map((observation) => observation.sample),
  }));
}

/** Counted only between continuous fresh observations; a change across a pause or gap is not observable as one change. */
function observedResistanceChangeCount(
  samples: readonly OrdinaryBikeTelemetrySample[],
  policy: PersonalizedPrescriptionHeldWorkloadPolicyV1
): number {
  return countContinuousResistanceChanges(samples.map((sample) => ({
    activeSec: sample.activeSec,
    observedAt: sample.observedAt,
    ...(hasFreshObservedResistance(sample) ? { observedResistance: sample.observedResistance!.value } : {}),
  })), policy);
}

const HELD_WORKLOAD_EMPTY_EXCLUSIONS = () => ({
  observationGap: 0,
  wattsUnavailable: 0,
  outsideCalibrationDomain: 0,
  heartRateUnavailable: 0,
});

/**
 * Held-workload forward-response characterization. Observed watts under held
 * observed resistance are mapped through the frozen E1 calibration
 * (predicted HR = intercept + slope × watts) and compared with observed HR.
 * Deliberately no HR-band, candidate-agreement, or controller-success filter.
 */
/**
 * Transient internal view of the exact stable observed-resistance windows the
 * canonical E2 v3 reducer used. Never persisted, never part of the E2 v3 reader,
 * and produced only by the same loop that builds the durable summary.
 */
export interface HeldWorkloadWindowAnalysisInternal {
  firstActiveSec: number;
  lastActiveSec: number;
  observedResistance: number;
  provenance: BikeWattsProvenance | null;
  /** First active second whose HR response may contribute (window start + settling). */
  settledFromActiveSec: number;
  qualifyingDurationSec: number;
  /** First/last qualifying second, present when qualifyingDurationSec > 0. */
  qualifyingFirstActiveSec?: number;
  qualifyingLastActiveSec?: number;
}

export interface HeldWorkloadPhaseAnalysisInternal {
  phaseId: string;
  kind: PersonalizedPrescriptionPhaseEvaluationV1["kind"];
  intervalIndex?: number;
  activeStartSec?: number;
  outcome: PersonalizedPrescriptionHeldWorkloadForwardResponseV1["outcome"];
  windows: HeldWorkloadWindowAnalysisInternal[];
}

export interface HeldWorkloadForwardAnalysisInternal {
  /** The exact record the canonical reducer produced for these inputs. */
  record: CurrentPersonalizedPrescriptionCharacterization | null;
  phases: HeldWorkloadPhaseAnalysisInternal[];
}

function characterizeHeldWorkload(
  shadow: PersonalizedPrescriptionPhaseEvaluationV1,
  hasResponse: boolean,
  bike: readonly OrdinaryBikeTelemetrySample[],
  hrBySecond: ReadonlyMap<number, number>,
  model: PersonalizedPrescriptionHeldWorkloadForwardModelV1 | undefined,
  observedPowerProvenance: PersonalizedPrescriptionHeldWorkloadForwardResponseV1["observedPowerProvenance"],
  policy: PersonalizedPrescriptionHeldWorkloadPolicyV1,
  windowAnalysis?: HeldWorkloadWindowAnalysisInternal[]
): PersonalizedPrescriptionHeldWorkloadForwardResponseV1 {
  if (shadow.outcome !== "candidate") return { outcome: "not_candidate", observedPowerProvenance };
  if (!model) return { outcome: "calibration_unavailable", observedPowerProvenance };
  if (!hasResponse) {
    return { outcome: "insufficient_evidence", exclusionReason: "phase_evidence_unavailable", observedPowerProvenance };
  }
  const windows = stableObservedResistanceWindows(bike, observedPowerProvenance, policy);
  const excluded = HELD_WORKLOAD_EMPTY_EXCLUSIONS();
  const signed: number[] = [];
  const absolute: number[] = [];
  const observed: number[] = [];
  const predicted: number[] = [];
  const cadence: number[] = [];
  let stableDurationSec = 0;
  let postSettlingDurationSec = 0;
  let qualifyingWindowCount = 0;
  for (const window of windows) {
    const first = window.samples[0].activeSec;
    const last = window.samples[window.samples.length - 1].activeSec;
    stableDurationSec += last - first + 1;
    const bySecond = new Map(window.samples.map((sample) => [sample.activeSec, sample]));
    let qualifying = 0;
    let qualifyingFirst: number | undefined;
    let qualifyingLast: number | undefined;
    for (const second of settledActiveSeconds(first, last, policy.settlingSeconds)) {
      postSettlingDurationSec += 1;
      const sample = bySecond.get(second);
      if (!sample) { excluded.observationGap += 1; continue; }
      if (!sample.watts) { excluded.wattsUnavailable += 1; continue; }
      const watts = sample.watts.value;
      if (watts < model.observedMinWatts || watts > model.observedMaxWatts) {
        excluded.outsideCalibrationDomain += 1;
        continue;
      }
      const heartRate = hrBySecond.get(second);
      if (heartRate === undefined) { excluded.heartRateUnavailable += 1; continue; }
      const prediction = predictForwardResponse({ intercept: model.interceptBpm, slope: model.slopeBpmPerWatt }, watts);
      signed.push(signedPredictionError(heartRate, prediction));
      absolute.push(absolutePredictionError(heartRate, prediction));
      observed.push(heartRate);
      predicted.push(prediction);
      if (sample.cadenceRpm) cadence.push(sample.cadenceRpm.value);
      qualifying += 1;
      qualifyingFirst ??= second;
      qualifyingLast = second;
    }
    if (qualifying > 0) qualifyingWindowCount += 1;
    windowAnalysis?.push({
      firstActiveSec: first,
      lastActiveSec: last,
      observedResistance: window.resistance,
      provenance: window.provenance ?? null,
      settledFromActiveSec: first + policy.settlingSeconds,
      qualifyingDurationSec: qualifying,
      ...(qualifyingFirst !== undefined ? { qualifyingFirstActiveSec: qualifyingFirst } : {}),
      ...(qualifyingLast !== undefined ? { qualifyingLastActiveSec: qualifyingLast } : {}),
    });
  }
  const stableResistance: PersonalizedPrescriptionStableResistanceSummaryV1 = {
    observedResistanceChangeCount: observedResistanceChangeCount(bike, policy),
    stableWindowCount: windows.length,
    qualifyingWindowCount,
    stableDurationSec,
    postSettlingDurationSec,
    qualifyingDurationSec: signed.length,
    excludedPostSettlingSeconds: excluded,
  };
  const base = { observedPowerProvenance, stableResistance };
  if (observedPowerProvenance === "mixed") {
    return { outcome: "unsupported_observed_provenance", exclusionReason: "unsupported_power_provenance", ...base };
  }
  if (windows.length === 0) {
    return { outcome: "insufficient_evidence", exclusionReason: "no_stable_observed_resistance", ...base };
  }
  if (signed.length < policy.minQualifyingSeconds) {
    return { outcome: "insufficient_evidence", exclusionReason: "insufficient_post_settling_evidence", ...base };
  }
  return {
    outcome: "characterized",
    ...base,
    forwardHeartRate: {
      observedHeartRateMedianBpm: median(observed),
      predictedHeartRateMedianBpm: median(predicted),
      signedErrorBpm: distribution(signed),
      absoluteErrorBpm: distribution(absolute),
    },
    ...(cadence.length > 0 ? {
      cadenceRpm: {
        observationCount: cadence.length,
        median: median(cadence),
        q1: quantile(cadence, 0.25),
        q3: quantile(cadence, 0.75),
      },
    } : {}),
  };
}

function characterizePhase(
  shadow: PersonalizedPrescriptionPhaseEvaluationV1,
  response: WorkoutPhaseResponse | undefined,
  evaluation: PersonalizedPrescriptionEvaluationV1,
  hrBySecond: ReadonlyMap<number, number>,
  bikeBySecond: ReadonlyMap<number, OrdinaryBikeTelemetrySample>,
  audit: readonly MachineDecisionAuditEntry[],
  policy: PersonalizedPrescriptionCharacterizationPolicyV1,
  heldWorkloadPolicy: PersonalizedPrescriptionHeldWorkloadPolicyV1,
  analysis?: HeldWorkloadPhaseAnalysisInternal[]
): PersonalizedPrescriptionPhaseCharacterizationV3 {
  const closedLoop = characterizeClosedLoopPhase(shadow, response, evaluation, hrBySecond, bikeBySecond, audit, policy);
  const start = response?.activeStartSec ?? shadow.activeStartSec;
  const completedEnd = start === undefined ? undefined : start + (response?.completedDurationSec ?? 0);
  const bike = start === undefined || completedEnd === undefined ? [] : orderByActiveSecond(
    [...bikeBySecond.values()].filter((sample) => sample.activeSec >= start && sample.activeSec < completedEnd)
  );
  const windows: HeldWorkloadWindowAnalysisInternal[] = [];
  const heldWorkloadForwardResponse = characterizeHeldWorkload(
    shadow,
    response !== undefined && start !== undefined,
    bike,
    hrBySecond,
    forwardModelFrom(evaluation),
    closedLoop.observedPowerProvenance,
    heldWorkloadPolicy,
    analysis ? windows : undefined
  );
  analysis?.push({
    phaseId: shadow.phaseId,
    kind: shadow.kind,
    ...(shadow.intervalIndex !== undefined ? { intervalIndex: shadow.intervalIndex } : {}),
    ...(start !== undefined ? { activeStartSec: start } : {}),
    outcome: heldWorkloadForwardResponse.outcome,
    windows,
  });
  return { ...closedLoop, heldWorkloadForwardResponse };
}

/** Closed-loop transfer characterization, unchanged since E2 v2. */
function characterizeClosedLoopPhase(
  shadow: PersonalizedPrescriptionPhaseEvaluationV1,
  response: WorkoutPhaseResponse | undefined,
  evaluation: PersonalizedPrescriptionEvaluationV1,
  hrBySecond: ReadonlyMap<number, number>,
  bikeBySecond: ReadonlyMap<number, OrdinaryBikeTelemetrySample>,
  audit: readonly MachineDecisionAuditEntry[],
  policy: PersonalizedPrescriptionCharacterizationPolicyV1
): PersonalizedPrescriptionPhaseCharacterizationV1 {
  const start = response?.activeStartSec ?? shadow.activeStartSec;
  const end = response?.activeEndSec ?? shadow.activeEndSec;
  const plannedDurationSec = response?.plannedDurationSec ??
    (start !== undefined && end !== undefined ? Math.max(0, end - start) : 0);
  const observedDurationSec = response?.completedDurationSec ?? 0;
  const completedEnd = start === undefined ? undefined : start + observedDurationSec;
  const hrEntries = start === undefined || completedEnd === undefined ? [] : [...hrBySecond.entries()]
    .filter(([second]) => second >= start && second < completedEnd)
    .sort(([a], [b]) => a - b);
  const bike = start === undefined || completedEnd === undefined ? [] : orderByActiveSecond(
    [...bikeBySecond.values()].filter((sample) => sample.activeSec >= start && sample.activeSec < completedEnd)
  );
  const powerSamples = bike.filter((sample) => sample.watts !== undefined);
  const joint = powerSamples.filter((sample) => hrBySecond.has(sample.activeSec));
  const coverage = {
    plannedDurationSec,
    observedDurationSec,
    hrCoveredSeconds: hrEntries.length,
    powerCoveredSeconds: powerSamples.length,
    jointCoveredSeconds: joint.length,
    hrCoverageRatio: ratio(hrEntries.length, observedDurationSec),
    powerCoverageRatio: ratio(powerSamples.length, observedDurationSec),
    jointCoverageRatio: ratio(joint.length, observedDurationSec),
  };
  const phaseAudit = start === undefined || completedEnd === undefined ? [] : audit.filter((entry) =>
    entry.phaseId === shadow.phaseId && entry.intervalIndex === shadow.intervalIndex &&
    entry.elapsedSeconds >= start && entry.elapsedSeconds < completedEnd
  );
  const controller = controllerContext(bike, phaseAudit, observedDurationSec);
  const base: PersonalizedPrescriptionPhaseCharacterizationV1 = {
    phaseId: shadow.phaseId,
    kind: shadow.kind,
    ...(shadow.intensityId ? { intensityId: shadow.intensityId } : {}),
    ...(shadow.detailName ? { detailName: shadow.detailName } : {}),
    ...(shadow.intervalIndex !== undefined ? { intervalIndex: shadow.intervalIndex } : {}),
    ...(start !== undefined ? { activeStartSec: start } : {}),
    ...(end !== undefined ? { activeEndSec: end } : {}),
    shadowOutcome: shadow.outcome,
    ...(shadow.fallbackReason ? { fallbackReason: shadow.fallbackReason } : {}),
    ...(shadow.activeHeartRate ? { legacyHeartRate: { ...shadow.activeHeartRate } } : {}),
    ...(shadow.candidatePower ? { candidatePower: { ...shadow.candidatePower } } : {}),
    evidenceCoverage: coverage,
    observedPowerProvenance: observedPowerProvenance(powerSamples),
    controllerContext: controller,
    characterizationOutcome: shadow.outcome === "candidate" ? "insufficient_evidence" : "not_candidate",
  };
  if (shadow.outcome !== "candidate" || !shadow.candidatePower || !shadow.activeHeartRate ||
      shadow.activeHeartRate.min === undefined || shadow.activeHeartRate.max === undefined) return base;
  if (!response) {
    return { ...base, exclusionReason: "phase_evidence_unavailable" };
  }

  const hrValues = hrEntries.map(([, value]) => value);
  if (hrValues.length > 0) {
    const below = hrValues.filter((value) => value < shadow.activeHeartRate!.min!).length;
    const inside = hrValues.filter(
      (value) => value >= shadow.activeHeartRate!.min! && value <= shadow.activeHeartRate!.max!
    ).length;
    const above = hrValues.length - below - inside;
    base.observedHeartRate = {
      sampleCount: hrValues.length,
      meanBpm: hrValues.reduce((sum, value) => sum + value, 0) / hrValues.length,
      medianBpm: median(hrValues),
      minBpm: Math.min(...hrValues),
      maxBpm: Math.max(...hrValues),
      belowBandSeconds: below,
      insideBandSeconds: inside,
      aboveBandSeconds: above,
      insideBandRatio: inside / hrValues.length,
    };
  }

  const provenance = observedPowerProvenance(powerSamples);
  const powerValues = powerSamples.map((sample) => sample.watts!.value);
  if (powerValues.length > 0 && provenance !== "mixed" && provenance !== "unavailable") {
    const below = powerValues.filter((value) => value < shadow.candidatePower!.minWatts).length;
    const inside = powerValues.filter(
      (value) => value >= shadow.candidatePower!.minWatts && value <= shadow.candidatePower!.maxWatts
    ).length;
    const above = powerValues.length - below - inside;
    base.observedPower = {
      provenance,
      sampleCount: powerValues.length,
      medianWatts: median(powerValues),
      q1Watts: quantile(powerValues, 0.25),
      q3Watts: quantile(powerValues, 0.75),
      minWatts: Math.min(...powerValues),
      maxWatts: Math.max(...powerValues),
      belowCandidateSeconds: below,
      insideCandidateSeconds: inside,
      aboveCandidateSeconds: above,
      insideCandidateRatio: inside / powerValues.length,
    };
  }

  const changes = resistanceChangeSeconds(bike);
  const stableJoint = start === undefined ? [] : joint.filter((sample) => {
    const hr = hrBySecond.get(sample.activeSec)!;
    return isSettled(sample.activeSec, start, changes, policy.settlingSeconds) &&
      hr >= shadow.activeHeartRate!.min! && hr <= shadow.activeHeartRate!.max!;
  });
  const stableValues = stableJoint.map((sample) => sample.watts!.value);

  if (start !== undefined && completedEnd !== undefined && base.observedHeartRate &&
      observedDurationSec >= policy.settlingSeconds + 2 * policy.heartRateChangeWindowSeconds) {
    const settledHr = hrEntries.filter(([second]) => isSettled(second, start, changes, policy.settlingSeconds));
    const firstWindowStart = start + policy.settlingSeconds;
    const early = settledHr.filter(([second]) =>
      second >= firstWindowStart && second < firstWindowStart + policy.heartRateChangeWindowSeconds
    ).map(([, value]) => value);
    const late = settledHr.filter(([second]) =>
      second >= completedEnd - policy.heartRateChangeWindowSeconds && second < completedEnd
    ).map(([, value]) => value);
    if (early.length >= policy.minHeartRateChangeWindowSamples &&
        late.length >= policy.minHeartRateChangeWindowSamples) {
      base.observedHeartRate.earlyWindowMedianBpm = median(early);
      base.observedHeartRate.lateWindowMedianBpm = median(late);
      base.observedHeartRate.heartRateChangeLateVsEarlyBpm = median(late) - median(early);
    }
  }

  const fitness = evaluation.fitnessEvidenceSnapshot;
  if (fitness) {
    const observedHrs = fitness.calibration.points.map((point) => point.heartRateBpm);
    const hrMin = Math.min(...observedHrs);
    const hrMax = Math.max(...observedHrs);
    const hrLower = shadow.activeHeartRate.min - hrMin;
    const hrUpper = hrMax - shadow.activeHeartRate.max;
    const wattsLower = shadow.candidatePower.minWatts - fitness.calibration.observedMinWatts;
    const wattsUpper = fitness.calibration.observedMaxWatts - shadow.candidatePower.maxWatts;
    const hrSpan = hrMax - hrMin;
    const wattsSpan = fitness.calibration.observedMaxWatts - fitness.calibration.observedMinWatts;
    const edge = (hrSpan > 0 && Math.min(hrLower, hrUpper) / hrSpan <= policy.domainEdgeFraction) ||
      (wattsSpan > 0 && Math.min(wattsLower, wattsUpper) / wattsSpan <= policy.domainEdgeFraction);
    base.candidateDomainMargins = {
      heartRateToLowerBoundaryBpm: hrLower,
      heartRateToUpperBoundaryBpm: hrUpper,
      wattsToLowerBoundary: wattsLower,
      wattsToUpperBoundary: wattsUpper,
      bucket: edge ? "edge" : "interior",
    };
  }

  const exclusion = exclusionFor(coverage, provenance, stableValues.length, policy);
  if (exclusion) {
    base.exclusionReason = exclusion;
    base.characterizationOutcome = exclusion === "missing_telemetry"
      ? "telemetry_unavailable"
      : exclusion === "unsupported_power_provenance"
        ? "unsupported_observed_provenance"
        : "insufficient_evidence";
    return base;
  }

  base.stableInBandWorkload = {
    sampleCount: stableValues.length,
    medianWatts: median(stableValues),
    q1Watts: quantile(stableValues, 0.25),
    q3Watts: quantile(stableValues, 0.75),
    minWatts: Math.min(...stableValues),
    maxWatts: Math.max(...stableValues),
  };
  base.comparison = compareCandidate(
    shadow.candidatePower.minWatts,
    shadow.candidatePower.maxWatts,
    stableValues
  );
  base.characterizationOutcome = "characterized";
  return base;
}

/** Pure E2 reducer. All current-state and time inputs are supplied explicitly. */
export function characterizePersonalizedPrescription(
  input: CharacterizePersonalizedPrescriptionInput
): CurrentPersonalizedPrescriptionCharacterization | null {
  return characterizeWithOptionalAnalysis(input);
}

/**
 * Transient E2 v3 held-window analysis from the canonical reducer itself (no
 * second window algorithm). Returns the exact record plus the windows used to
 * build its durable summaries. For read-only diagnostics/E4A joins only.
 */
export function analyzeHeldWorkloadForwardResponseInternal(
  input: CharacterizePersonalizedPrescriptionInput
): HeldWorkloadForwardAnalysisInternal {
  const phases: HeldWorkloadPhaseAnalysisInternal[] = [];
  const record = characterizeWithOptionalAnalysis(input, phases);
  return { record, phases: record ? phases : [] };
}

function characterizeWithOptionalAnalysis(
  input: CharacterizePersonalizedPrescriptionInput,
  analysis?: HeldWorkloadPhaseAnalysisInternal[]
): CurrentPersonalizedPrescriptionCharacterization | null {
  const shadow = parsePersonalizedPrescriptionEvaluation(input.shadowEvaluation);
  const response = parseWorkoutResponse(input.workoutResponse);
  const heldWorkloadPolicy = input.heldWorkloadPolicy ?? PHASE_E2_HELD_WORKLOAD_POLICY_V1;
  if (!shadow || !response || !policyValid(input.policy) || !heldWorkloadPolicyValid(heldWorkloadPolicy) ||
      !iso(input.createdAt)) return null;
  if (!OWNER_ID_PATTERN.test(input.summary.external_session_id) || !input.summary.athlete_id ||
      shadow.athleteId !== input.summary.athlete_id || response.athleteId !== input.summary.athlete_id ||
      response.sessionId !== input.summary.external_session_id || shadow.workoutSelector !== input.summary.day ||
      shadow.workoutIntent !== input.summary.intent || shadow.activity !== input.summary.activity) return null;

  const hrBySecond = new Map<number, number>();
  for (const sample of input.hrSamples) {
    if (sample.session_id === response.sessionId && Number.isInteger(sample.timestamp_sec) &&
        sample.timestamp_sec >= 0 && finite(sample.hr) && sample.hr >= 30 && sample.hr <= 250) {
      hrBySecond.set(sample.timestamp_sec, sample.hr);
    }
  }
  const bikeBySecond = new Map<number, OrdinaryBikeTelemetrySample>();
  const sourceIds = new Set<string>();
  for (const raw of input.bikeSamples) {
    const sample = parseOrdinaryBikeTelemetrySample(raw);
    if (!sample || sample.athleteId !== response.athleteId || sample.sessionId !== response.sessionId ||
        bikeBySecond.has(sample.activeSec) || (sample.sourceSampleId && sourceIds.has(sample.sourceSampleId))) continue;
    bikeBySecond.set(sample.activeSec, sample);
    if (sample.sourceSampleId) sourceIds.add(sample.sourceSampleId);
  }
  const audit = input.machineDecisionAudit ?? [];
  const phases = shadow.phases.map((phase) => characterizePhase(
    phase,
    responseForPhase(phase, response),
    shadow,
    hrBySecond,
    bikeBySecond,
    audit,
    input.policy,
    heldWorkloadPolicy,
    analysis
  ));
  const forwardModel = forwardModelFrom(shadow);
  return {
    schemaVersion: PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3,
    characterizer: {
      id: PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1,
      version: PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V3,
    },
    mode: "diagnostic",
    activationEligible: false,
    sourceShadow: {
      resolverId: PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1,
      resolverVersion: PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1,
      shadowSchemaVersion: PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1,
      resolvedAt: shadow.resolvedAt,
    },
    athleteId: shadow.athleteId,
    workoutSessionId: response.sessionId,
    workoutSelector: shadow.workoutSelector,
    workoutIntent: shadow.workoutIntent,
    activity: shadow.activity,
    ...(shadow.fitnessEvidenceSnapshot ? {
      formalAssessmentQuality: shadow.fitnessEvidenceSnapshot.quality,
      calibrationWorkloadProvenance: shadow.fitnessEvidenceSnapshot.calibration.workloadProvenance,
      formalAssessmentProvenance: {
        algorithm: { ...shadow.fitnessEvidenceSnapshot.algorithm },
        protocol: { ...shadow.fitnessEvidenceSnapshot.calibration.protocol },
      },
    } : {}),
    policy: { ...input.policy },
    heldWorkloadPolicy: { ...heldWorkloadPolicy },
    ...(forwardModel ? { heldWorkloadForwardModel: forwardModel } : {}),
    phases,
    createdAt: input.createdAt,
  };
}

const OUTCOMES = new Set(["characterized", "insufficient_evidence", "not_candidate",
  "unsupported_observed_provenance", "telemetry_unavailable"]);
const EXCLUSIONS = new Set(["phase_too_short", "missing_telemetry", "insufficient_hr_coverage",
  "insufficient_power_coverage", "insufficient_joint_coverage", "insufficient_settled_in_band_evidence",
  "unsupported_power_provenance", "phase_evidence_unavailable"]);

function phaseLinkMatches(
  value: Record<string, unknown>,
  shadow: PersonalizedPrescriptionPhaseEvaluationV1
): boolean {
  if (value.phaseId !== shadow.phaseId || value.kind !== shadow.kind || value.intensityId !== shadow.intensityId ||
      value.intervalIndex !== shadow.intervalIndex || value.shadowOutcome !== shadow.outcome) return false;
  if (shadow.activeStartSec !== undefined && value.activeStartSec !== shadow.activeStartSec) return false;
  if (shadow.activeEndSec !== undefined && value.activeEndSec !== shadow.activeEndSec) return false;
  if (JSON.stringify(value.legacyHeartRate) !== JSON.stringify(shadow.activeHeartRate)) return false;
  if (JSON.stringify(value.candidatePower) !== JSON.stringify(shadow.candidatePower)) return false;
  if (value.fallbackReason !== shadow.fallbackReason) return false;
  return true;
}

function parsedPhase(value: unknown, shadow: PersonalizedPrescriptionPhaseEvaluationV1):
  PersonalizedPrescriptionPhaseCharacterizationV1 | null {
  if (!isObject(value) || !phaseLinkMatches(value, shadow) || !isObject(value.evidenceCoverage) ||
      !isObject(value.controllerContext) || !OUTCOMES.has(value.characterizationOutcome as string)) return null;
  if (value.observedPowerProvenance !== "measured_watts" && value.observedPowerProvenance !== "calibrated_watts" &&
      value.observedPowerProvenance !== "mixed" && value.observedPowerProvenance !== "unavailable") return null;
  const coverage = value.evidenceCoverage;
  const coverageCounts = [coverage.plannedDurationSec, coverage.observedDurationSec, coverage.hrCoveredSeconds,
    coverage.powerCoveredSeconds, coverage.jointCoveredSeconds];
  if (!coverageCounts.every(nonNegative) || !ratioValue(coverage.hrCoverageRatio) ||
      !ratioValue(coverage.powerCoverageRatio) || !ratioValue(coverage.jointCoverageRatio) ||
      !nearlyEqual(coverage.hrCoverageRatio, ratio(coverage.hrCoveredSeconds as number, coverage.observedDurationSec as number)) ||
      !nearlyEqual(coverage.powerCoverageRatio, ratio(coverage.powerCoveredSeconds as number, coverage.observedDurationSec as number)) ||
      !nearlyEqual(coverage.jointCoverageRatio, ratio(coverage.jointCoveredSeconds as number, coverage.observedDurationSec as number))) return null;
  if (value.exclusionReason !== undefined && !EXCLUSIONS.has(value.exclusionReason as string)) return null;
  if (shadow.outcome === "fallback" && (value.characterizationOutcome !== "not_candidate" || value.comparison !== undefined)) return null;
  if (shadow.outcome === "candidate" && value.characterizationOutcome === "not_candidate") return null;
  const controller = value.controllerContext;
  if (typeof controller.available !== "boolean" || !nonNegative(controller.anyBoundarySaturationSeconds) ||
      !ratioValue(controller.saturationRatio) || !nonNegative(controller.lowerBoundaryDecisionCount) ||
      !nonNegative(controller.upperBoundaryDecisionCount)) return null;
  for (const key of ["observed", "desired", "commanded"]) {
    const item = controller[key];
    if (!isObject(item) || !nonNegative(item.coveredSeconds) || !nonNegative(item.lowerBoundSeconds) ||
        !nonNegative(item.upperBoundSeconds)) return null;
  }
  if (value.characterizationOutcome === "characterized") {
    if (!isObject(value.stableInBandWorkload) || !isObject(value.comparison) || value.exclusionReason !== undefined) return null;
    const comparison = value.comparison;
    const candidate = shadow.candidatePower!;
    const midpoint = (candidate.minWatts + candidate.maxWatts) / 2;
    if (![comparison.candidateMidpointWatts, comparison.observedInBandMedianWatts,
      comparison.signedDifferenceWatts, comparison.absoluteDifferenceWatts, comparison.signedDifferencePercent,
      comparison.candidateObservedOverlapWatts, comparison.candidateObservedOverlapRatio].every(finite) ||
      typeof comparison.candidateContainsObservedMedian !== "boolean" ||
      !nearlyEqual(comparison.candidateMidpointWatts as number, midpoint) ||
      !nearlyEqual(comparison.signedDifferenceWatts as number,
        (comparison.observedInBandMedianWatts as number) - midpoint) ||
      comparison.candidateContainsObservedMedian !==
        ((comparison.observedInBandMedianWatts as number) >= candidate.minWatts &&
         (comparison.observedInBandMedianWatts as number) <= candidate.maxWatts)) return null;
  } else if (value.comparison !== undefined || value.stableInBandWorkload !== undefined) return null;
  return value as unknown as PersonalizedPrescriptionPhaseCharacterizationV1;
}

const HELD_OUTCOMES = new Set(["characterized", "insufficient_evidence", "not_candidate",
  "calibration_unavailable", "unsupported_observed_provenance"]);
const HELD_RESPONSE_KEYS = new Set(["outcome", "exclusionReason", "observedPowerProvenance",
  "stableResistance", "forwardHeartRate", "cadenceRpm"]);
const STABLE_RESISTANCE_COUNT_KEYS = ["observedResistanceChangeCount", "stableWindowCount", "qualifyingWindowCount",
  "stableDurationSec", "postSettlingDurationSec", "qualifyingDurationSec"];
const STABLE_RESISTANCE_KEYS = [...STABLE_RESISTANCE_COUNT_KEYS, "excludedPostSettlingSeconds"];
const HELD_EXCLUSION_KEYS = ["observationGap", "wattsUnavailable", "outsideCalibrationDomain", "heartRateUnavailable"];
const DISTRIBUTION_KEYS = ["median", "q1", "q3", "min", "max"];
const FORWARD_HEART_RATE_KEYS = ["observedHeartRateMedianBpm", "predictedHeartRateMedianBpm",
  "signedErrorBpm", "absoluteErrorBpm"];
const CADENCE_KEYS = ["observationCount", "median", "q1", "q3"];
const FORWARD_MODEL_KEYS = ["interceptBpm", "slopeBpmPerWatt", "observedMinWatts", "observedMaxWatts"] as const;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function count(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function distributionValid(value: unknown): value is PersonalizedPrescriptionDistributionV1 {
  if (!isObject(value) || !exactKeys(value, DISTRIBUTION_KEYS)) return false;
  const { median: mid, q1, q3, min, max } = value;
  return [mid, q1, q3, min, max].every(finite) &&
    (min as number) <= (q1 as number) && (q1 as number) <= (mid as number) &&
    (mid as number) <= (q3 as number) && (q3 as number) <= (max as number);
}

function stableResistanceValid(value: unknown, observedDurationSec: number):
  value is PersonalizedPrescriptionStableResistanceSummaryV1 {
  if (!isObject(value) || !exactKeys(value, STABLE_RESISTANCE_KEYS)) return false;
  const excluded = value.excludedPostSettlingSeconds;
  if (!isObject(excluded) || !exactKeys(excluded, HELD_EXCLUSION_KEYS) ||
      !HELD_EXCLUSION_KEYS.every((key) => count(excluded[key]))) return false;
  if (!STABLE_RESISTANCE_COUNT_KEYS.every((key) => count(value[key]))) return false;
  const windows = value.stableWindowCount as number;
  const qualifyingWindows = value.qualifyingWindowCount as number;
  const stable = value.stableDurationSec as number;
  const post = value.postSettlingDurationSec as number;
  const qualifying = value.qualifyingDurationSec as number;
  const excludedTotal = HELD_EXCLUSION_KEYS.reduce((sum, key) => sum + (excluded[key] as number), 0);
  return qualifyingWindows <= windows && (qualifyingWindows === 0) === (qualifying === 0) &&
    (windows === 0 ? stable === 0 : stable >= windows) && stable <= observedDurationSec &&
    post <= stable && post === qualifying + excludedTotal &&
    (value.observedResistanceChangeCount as number) <= observedDurationSec;
}

function forwardModelEquals(
  value: unknown,
  expected: PersonalizedPrescriptionHeldWorkloadForwardModelV1 | undefined
): boolean {
  if (!expected) return value === undefined;
  return isObject(value) && exactKeys(value, FORWARD_MODEL_KEYS) &&
    FORWARD_MODEL_KEYS.every((key) => value[key] === expected[key]);
}

/** Strict v3 held-workload forward-response reader; structural and derived invariants fail closed. */
function heldWorkloadResponseValid(
  value: unknown,
  shadow: PersonalizedPrescriptionPhaseEvaluationV1,
  phase: PersonalizedPrescriptionPhaseCharacterizationV1,
  model: PersonalizedPrescriptionHeldWorkloadForwardModelV1 | undefined,
  policy: PersonalizedPrescriptionHeldWorkloadPolicyV1
): value is PersonalizedPrescriptionHeldWorkloadForwardResponseV1 {
  if (!isObject(value) || !Object.keys(value).every((key) => HELD_RESPONSE_KEYS.has(key)) ||
      !HELD_OUTCOMES.has(value.outcome as string) ||
      value.observedPowerProvenance !== phase.observedPowerProvenance) return false;
  const outcome = value.outcome;
  const reason = value.exclusionReason;
  const hasStable = value.stableResistance !== undefined;
  if (hasStable && !stableResistanceValid(value.stableResistance, phase.evidenceCoverage.observedDurationSec)) {
    return false;
  }
  const stable = value.stableResistance as PersonalizedPrescriptionStableResistanceSummaryV1 | undefined;
  if (outcome !== "characterized" && (value.forwardHeartRate !== undefined || value.cadenceRpm !== undefined)) {
    return false;
  }
  if ((shadow.outcome === "candidate") === (outcome === "not_candidate")) return false;
  if (outcome === "not_candidate" || outcome === "calibration_unavailable") {
    if (outcome === "calibration_unavailable" && model) return false;
    return reason === undefined && !hasStable;
  }
  if (!model) return false;
  if (outcome === "unsupported_observed_provenance") {
    return reason === "unsupported_power_provenance" && value.observedPowerProvenance === "mixed" && hasStable;
  }
  if (value.observedPowerProvenance === "mixed") return false;
  if (outcome === "insufficient_evidence") {
    if (reason === "phase_evidence_unavailable") return !hasStable;
    if (!stable) return false;
    if (reason === "no_stable_observed_resistance") return stable.stableWindowCount === 0;
    return reason === "insufficient_post_settling_evidence" && stable.stableWindowCount > 0 &&
      stable.qualifyingDurationSec < policy.minQualifyingSeconds;
  }
  if (reason !== undefined || !stable || stable.qualifyingDurationSec < policy.minQualifyingSeconds ||
      (value.observedPowerProvenance !== "measured_watts" && value.observedPowerProvenance !== "calibrated_watts")) {
    return false;
  }
  const forward = value.forwardHeartRate;
  if (!isObject(forward) || !exactKeys(forward, FORWARD_HEART_RATE_KEYS) ||
      !finite(forward.observedHeartRateMedianBpm) || !finite(forward.predictedHeartRateMedianBpm) ||
      !distributionValid(forward.signedErrorBpm) || !distributionValid(forward.absoluteErrorBpm)) return false;
  const signed = forward.signedErrorBpm;
  const absolute = forward.absoluteErrorBpm;
  const predictedAtMin = model.interceptBpm + model.slopeBpmPerWatt * model.observedMinWatts;
  const predictedAtMax = model.interceptBpm + model.slopeBpmPerWatt * model.observedMaxWatts;
  const predicted = forward.predictedHeartRateMedianBpm;
  if (absolute.min < 0 || !nearlyEqual(absolute.max, Math.max(Math.abs(signed.min), Math.abs(signed.max))) ||
      forward.observedHeartRateMedianBpm < 30 || forward.observedHeartRateMedianBpm > 250 ||
      predicted < Math.min(predictedAtMin, predictedAtMax) - 1e-9 ||
      predicted > Math.max(predictedAtMin, predictedAtMax) + 1e-9) return false;
  if (value.cadenceRpm !== undefined) {
    const cadence = value.cadenceRpm;
    if (!isObject(cadence) || !exactKeys(cadence, CADENCE_KEYS) || !count(cadence.observationCount) ||
        (cadence.observationCount as number) < 1 ||
        (cadence.observationCount as number) > stable.qualifyingDurationSec ||
        ![cadence.median, cadence.q1, cadence.q3].every((item) => finite(item) && item >= 0 && item <= 300) ||
        (cadence.q1 as number) > (cadence.median as number) ||
        (cadence.median as number) > (cadence.q3 as number)) return false;
  }
  // Every qualifying calibrated-watts second had verified measured cadence in the
  // producer, so a calibrated characterization with cadence removed or weakened
  // fails closed. Measured-watts cadence stays descriptive and optional.
  if (value.observedPowerProvenance === "calibrated_watts") {
    const cadence = value.cadenceRpm as { observationCount: number; median: number; q1: number; q3: number } | undefined;
    if (!cadence || cadence.observationCount !== stable.qualifyingDurationSec ||
        ![cadence.median, cadence.q1, cadence.q3].every((item) => cadenceInBand(item))) return false;
  }
  return true;
}

/**
 * Strict E2 reader with an immutable structural link to the trusted E1 record.
 * v1 and v2 stay readable exactly as written and can never carry v3 fields;
 * v3 is current; any other schema/characterizer version fails closed.
 */
export function parsePersonalizedPrescriptionCharacterization(
  value: unknown,
  shadowValue: unknown,
  expected?: {
    athleteId?: string;
    sessionId?: string;
    workoutSelector?: string;
    activity?: string;
    workoutResponse?: unknown;
  }
): PersonalizedPrescriptionCharacterization | null {
  const shadow = parsePersonalizedPrescriptionEvaluation(shadowValue);
  const isV1 = isObject(value) &&
    value.schemaVersion === PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V1 &&
    isObject(value.characterizer) &&
    value.characterizer.version === PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V1;
  const isV2 = isObject(value) &&
    value.schemaVersion === PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V2 &&
    isObject(value.characterizer) &&
    value.characterizer.version === PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V2;
  const isV3 = isObject(value) &&
    value.schemaVersion === PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3 &&
    isObject(value.characterizer) &&
    value.characterizer.version === PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V3;
  if (!shadow || !isObject(value) || (!isV1 && !isV2 && !isV3) ||
      containsNonFiniteNumber(value) ||
      !isObject(value.characterizer) || value.characterizer.id !== PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1 ||
      value.mode !== "diagnostic" || value.activationEligible !== false || !isObject(value.sourceShadow) ||
      value.sourceShadow.resolverId !== shadow.resolver.id ||
      value.sourceShadow.resolverVersion !== shadow.resolver.version ||
      value.sourceShadow.shadowSchemaVersion !== shadow.schemaVersion ||
      value.sourceShadow.resolvedAt !== shadow.resolvedAt || value.athleteId !== shadow.athleteId ||
      value.workoutSelector !== shadow.workoutSelector || value.workoutIntent !== shadow.workoutIntent ||
      value.activity !== shadow.activity || !OWNER_ID_PATTERN.test(value.workoutSessionId as string) ||
      !policyValid(value.policy) || !iso(value.createdAt) || !Array.isArray(value.phases) ||
      value.phases.length !== shadow.phases.length || value.phases.length > MAX_PHASES) return null;
  const expectedQuality = shadow.fitnessEvidenceSnapshot?.quality;
  const expectedProvenance = shadow.fitnessEvidenceSnapshot?.calibration.workloadProvenance;
  if (value.formalAssessmentQuality !== expectedQuality ||
      value.calibrationWorkloadProvenance !== expectedProvenance) return null;
  if (isV1 && shadow.fitnessEvidenceSnapshot && (
    shadow.fitnessEvidenceSnapshot.algorithm.id !== VO2_FORMAL_ASSESSMENT_CONTRACT_V1.estimatorId ||
    shadow.fitnessEvidenceSnapshot.algorithm.version !== VO2_FORMAL_ASSESSMENT_CONTRACT_V1.estimatorVersion ||
    shadow.fitnessEvidenceSnapshot.calibration.protocol.id !== VO2_FORMAL_ASSESSMENT_CONTRACT_V1.protocolId ||
    shadow.fitnessEvidenceSnapshot.calibration.protocol.version !== VO2_FORMAL_ASSESSMENT_CONTRACT_V1.protocolVersion
  )) return null;
  if (isV2 || isV3) {
    const expectedFormal = shadow.fitnessEvidenceSnapshot;
    if (expectedFormal) {
      if (!isObject(value.formalAssessmentProvenance) ||
          !isObject(value.formalAssessmentProvenance.algorithm) ||
          !isObject(value.formalAssessmentProvenance.protocol) ||
          value.formalAssessmentProvenance.algorithm.id !== expectedFormal.algorithm.id ||
          value.formalAssessmentProvenance.algorithm.version !== expectedFormal.algorithm.version ||
          value.formalAssessmentProvenance.protocol.id !== expectedFormal.calibration.protocol.id ||
          value.formalAssessmentProvenance.protocol.version !== expectedFormal.calibration.protocol.version) return null;
    } else if (value.formalAssessmentProvenance !== undefined) return null;
  }
  // Historical records can never be relabeled to carry, hide, or smuggle v3 evidence.
  if (!isV3 && ("heldWorkloadPolicy" in value || "heldWorkloadForwardModel" in value ||
      value.phases.some((phase) => isObject(phase) && "heldWorkloadForwardResponse" in phase))) return null;
  const forwardModel = forwardModelFrom(shadow);
  if (isV3 && (!heldWorkloadPolicyValid(value.heldWorkloadPolicy) ||
      !forwardModelEquals(value.heldWorkloadForwardModel, forwardModel))) return null;
  if (expected && (expected.athleteId !== undefined && value.athleteId !== expected.athleteId ||
      expected.sessionId !== undefined && value.workoutSessionId !== expected.sessionId ||
      expected.workoutSelector !== undefined && value.workoutSelector !== expected.workoutSelector ||
      expected.activity !== undefined && value.activity !== expected.activity)) return null;
  const phases: PersonalizedPrescriptionPhaseCharacterizationV1[] = [];
  const expectedResponse = expected?.workoutResponse === undefined
    ? null
    : parseWorkoutResponse(expected.workoutResponse);
  if (expected?.workoutResponse !== undefined && !expectedResponse) return null;
  for (let index = 0; index < shadow.phases.length; index += 1) {
    const phase = parsedPhase(value.phases[index], shadow.phases[index]);
    if (!phase) return null;
    if (expectedResponse) {
      const responsePhase = responseForPhase(shadow.phases[index], expectedResponse);
      if (!responsePhase || phase.activeStartSec !== responsePhase.activeStartSec ||
          phase.activeEndSec !== responsePhase.activeEndSec ||
          phase.evidenceCoverage.plannedDurationSec !== responsePhase.plannedDurationSec ||
          phase.evidenceCoverage.observedDurationSec !== responsePhase.completedDurationSec) return null;
    }
    if (isV3 && !heldWorkloadResponseValid(
      (phase as PersonalizedPrescriptionPhaseCharacterizationV3).heldWorkloadForwardResponse,
      shadow.phases[index],
      phase,
      forwardModel,
      value.heldWorkloadPolicy as PersonalizedPrescriptionHeldWorkloadPolicyV1
    )) return null;
    phases.push(phase);
  }
  const parsed = {
    ...(value as unknown as PersonalizedPrescriptionCharacterization),
    sourceShadow: { ...(value.sourceShadow as PersonalizedPrescriptionCharacterizationV1["sourceShadow"]) },
    policy: { ...(value.policy as unknown as PersonalizedPrescriptionCharacterizationPolicyV1) },
    phases,
  } as PersonalizedPrescriptionCharacterization;
  if ((isV2 || isV3) && "formalAssessmentProvenance" in parsed && parsed.formalAssessmentProvenance) {
    parsed.formalAssessmentProvenance = {
      algorithm: { ...parsed.formalAssessmentProvenance.algorithm },
      protocol: { ...parsed.formalAssessmentProvenance.protocol },
    };
  }
  if (parsed.schemaVersion === PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3) {
    parsed.heldWorkloadPolicy = { ...parsed.heldWorkloadPolicy };
    if (parsed.heldWorkloadForwardModel) parsed.heldWorkloadForwardModel = { ...parsed.heldWorkloadForwardModel };
  }
  return parsed;
}

function metric(values: readonly number[]): { count: number; median?: number } {
  return values.length > 0 ? { count: values.length, median: median(values) } : { count: 0 };
}

/** Pure, order-independent cohort report. Measured and calibrated sources are never pooled. */
export function aggregatePersonalizedPrescriptionCharacterizations(
  records: readonly PersonalizedPrescriptionCharacterization[]
): PersonalizedPrescriptionCharacterizationAggregateV2 {
  const groups = new Map<string, { sessions: Set<string>; phases: PersonalizedPrescriptionPhaseCharacterizationV1[];
    record: PersonalizedPrescriptionCharacterization }>();
  let phaseCount = 0;
  let candidates = 0;
  let fallbacks = 0;
  let evaluable = 0;
  for (const record of records) {
    for (const phase of record.phases) {
      phaseCount += 1;
      if (phase.shadowOutcome === "candidate") candidates += 1; else fallbacks += 1;
      if (phase.characterizationOutcome === "characterized") evaluable += 1;
      const parts = [record.workoutIntent, phase.intensityId ?? "unspecified",
        record.calibrationWorkloadProvenance ?? "unavailable",
        phase.observedPowerProvenance, record.formalAssessmentQuality ?? "unavailable",
        phase.candidateDomainMargins?.bucket ?? "not_applicable",
        "formalAssessmentProvenance" in record
          ? `${record.formalAssessmentProvenance?.algorithm.id}@${record.formalAssessmentProvenance?.algorithm.version}`
          : "historical-e2-v1",
        "formalAssessmentProvenance" in record
          ? `${record.formalAssessmentProvenance?.protocol.id}@${record.formalAssessmentProvenance?.protocol.version}`
          : "historical-e2-v1"];
      const key = JSON.stringify(parts);
      const group = groups.get(key) ?? { sessions: new Set<string>(), phases: [], record };
      group.sessions.add(record.workoutSessionId);
      group.phases.push(phase);
      groups.set(key, group);
    }
  }
  const output = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => {
    const first = group.phases[0];
    const exclusions: Record<string, number> = {};
    for (const phase of group.phases) if (phase.exclusionReason) {
      exclusions[phase.exclusionReason] = (exclusions[phase.exclusionReason] ?? 0) + 1;
    }
    const characterized = group.phases.filter((phase) => phase.characterizationOutcome === "characterized");
    const insideTotal = characterized.filter((phase) => phase.comparison).length;
    const insideCount = characterized.filter((phase) => phase.comparison?.candidateContainsObservedMedian).length;
    const saturationTotal = group.phases.filter((phase) => phase.shadowOutcome === "candidate").length;
    const saturationCount = group.phases.filter((phase) =>
      phase.shadowOutcome === "candidate" && phase.controllerContext.anyBoundarySaturationSeconds > 0
    ).length;
    return {
      workoutIntent: group.record.workoutIntent,
      intensityId: first.intensityId ?? "unspecified",
      calibrationWorkloadProvenance: group.record.calibrationWorkloadProvenance ?? "unavailable",
      observedPowerProvenance: first.observedPowerProvenance,
      formalAssessmentQuality: group.record.formalAssessmentQuality ?? "unavailable",
      formalAssessmentAlgorithm: "formalAssessmentProvenance" in group.record && group.record.formalAssessmentProvenance
        ? `${group.record.formalAssessmentProvenance.algorithm.id}@${group.record.formalAssessmentProvenance.algorithm.version}`
        : "historical-e2-v1",
      formalAssessmentProtocol: "formalAssessmentProvenance" in group.record && group.record.formalAssessmentProvenance
        ? `${group.record.formalAssessmentProvenance.protocol.id}@${group.record.formalAssessmentProvenance.protocol.version}`
        : "historical-e2-v1",
      candidateDomainMarginBucket: first.candidateDomainMargins?.bucket ?? "not_applicable",
      completedWorkouts: group.sessions.size,
      phaseCount: group.phases.length,
      candidatePhases: group.phases.filter((phase) => phase.shadowOutcome === "candidate").length,
      fallbackPhases: group.phases.filter((phase) => phase.shadowOutcome === "fallback").length,
      evaluableCandidatePhases: characterized.length,
      exclusionCounts: Object.fromEntries(Object.entries(exclusions).sort(([a], [b]) => a.localeCompare(b))),
      signedDifferenceWatts: metric(characterized.flatMap((phase) =>
        phase.comparison ? [phase.comparison.signedDifferenceWatts] : [])),
      absoluteDifferenceWatts: metric(characterized.flatMap((phase) =>
        phase.comparison ? [phase.comparison.absoluteDifferenceWatts] : [])),
      observedMedianInsideCandidate: { count: insideCount, total: insideTotal,
        ...(insideTotal > 0 ? { proportion: insideCount / insideTotal } : {}) },
      heartRateInsideBandRatio: metric(group.phases.flatMap((phase) =>
        phase.observedHeartRate ? [phase.observedHeartRate.insideBandRatio] : [])),
      hrCoverageRatio: metric(group.phases.map((phase) => phase.evidenceCoverage.hrCoverageRatio)),
      powerCoverageRatio: metric(group.phases.map((phase) => phase.evidenceCoverage.powerCoverageRatio)),
      jointCoverageRatio: metric(group.phases.map((phase) => phase.evidenceCoverage.jointCoverageRatio)),
      controllerSaturationIncidence: { count: saturationCount, total: saturationTotal,
        ...(saturationTotal > 0 ? { proportion: saturationCount / saturationTotal } : {}) },
    };
  });
  return {
    schemaVersion: PERSONALIZED_PRESCRIPTION_AGGREGATE_SCHEMA_VERSION,
    workoutCount: new Set(records.map((record) => record.workoutSessionId)).size,
    phaseCount,
    candidatePhases: candidates,
    fallbackPhases: fallbacks,
    evaluableCandidatePhases: evaluable,
    groups: output,
  };
}

/** Small developer-facing table/JSON surface; no athlete UI consumes this. */
export function personalizedPrescriptionDiagnosticRows(
  records: readonly PersonalizedPrescriptionCharacterization[]
): PersonalizedPrescriptionDiagnosticRowV2[] {
  return records.flatMap((record) => record.phases.map((phase) => ({
    workout: `${record.workoutSelector} (${record.workoutSessionId})`,
    phase: phase.detailName ?? `${phase.kind}${phase.intervalIndex ? ` ${phase.intervalIndex}` : ""}`,
    legacyHeartRate: phase.legacyHeartRate?.min !== undefined && phase.legacyHeartRate.max !== undefined
      ? `${phase.legacyHeartRate.min}-${phase.legacyHeartRate.max} bpm` : "n/a",
    candidateWatts: phase.candidatePower
      ? `${phase.candidatePower.minWatts}-${phase.candidatePower.maxWatts} W` : "n/a",
    observedInBandWatts: phase.stableInBandWorkload?.medianWatts ?? null,
    deltaWatts: phase.comparison?.signedDifferenceWatts ?? null,
    hrCoveragePercent: phase.evidenceCoverage.hrCoverageRatio * 100,
    powerCoveragePercent: phase.evidenceCoverage.powerCoverageRatio * 100,
    hrInsideTargetPercent: phase.observedHeartRate ? phase.observedHeartRate.insideBandRatio * 100 : null,
    saturationPercent: phase.controllerContext.saturationRatio * 100,
    calibrationProvenance: record.calibrationWorkloadProvenance ?? "unavailable",
    formalAssessmentProvenance: "formalAssessmentProvenance" in record && record.formalAssessmentProvenance
      ? `${record.formalAssessmentProvenance.algorithm.id}@${record.formalAssessmentProvenance.algorithm.version} · ` +
        `${record.formalAssessmentProvenance.protocol.id}@${record.formalAssessmentProvenance.protocol.version}`
      : "historical-e2-v1",
    observedPowerProvenance: phase.observedPowerProvenance,
    outcome: phase.characterizationOutcome,
    exclusion: phase.exclusionReason ?? "none",
  })));
}
