import {
  ATHLETE_PROFILE_SCHEMA_VERSION,
  ATHLETE_PROFILE_SCHEMA_VERSION_V1,
  FITNESS_STATE_SCHEMA_VERSION,
  FITNESS_STATE_SCHEMA_VERSION_V1,
  FITNESS_STATE_SCHEMA_VERSION_V2,
  FITNESS_STATE_SCHEMA_VERSION_V3,
  LEGACY_VO2_PROTOCOL_ID,
  LEGACY_VO2_PROTOCOL_VERSION,
  VO2_ASSESSMENT_SCHEMA_VERSION_V1,
  VO2_ASSESSMENT_SCHEMA_VERSION_V2,
  VO2_EVIDENCE_SCHEMA_VERSION_V1,
  VO2_EVIDENCE_SCHEMA_VERSION_V2,
  VO2_PROTOCOL_ID,
  VO2_PROTOCOL_VERSION,
  VO2_PROTOCOL_VERSION_V3,
  type AthleteFitnessSnapshot,
  type AthleteProfile,
  type FitnessMetric,
  type FitnessMetricQuality,
  type FitnessState,
  type HrWorkloadCalibration,
  type HrWorkloadCalibrationPoint,
  type PassiveAerobicTrend,
  type PassiveAerobicObservation,
  type PassiveAerobicObservationMetric,
  type Vo2AssessmentResult,
  type WorkoutSummary,
} from "./types.js";
import {
  loadAthleteProfile,
  parseAthleteProfile,
  type ProfileStorage,
} from "./profile.js";
import {
  LEGACY_VO2_ESTIMATOR_ID,
  LEGACY_VO2_ESTIMATOR_VERSION,
  VO2_ESTIMATOR_ID,
  VO2_ESTIMATOR_VERSION,
} from "./vo2Estimator.js";

/**
 * FitnessState persistence and readers. FitnessState is an umbrella athlete
 * store: formal assessment metrics (E1 evidence) and Phase D passive
 * observation can coexist. Residence in FitnessState does not grant
 * prescription authority — check each metric's source / eligibleForPrescription.
 * See docs/personalization-architecture.md.
 */
export const FITNESS_STATE_STORAGE_KEY = "fitness_state_v1";
const MAX_V1_EVIDENCE_SESSION_IDS = 1000;
const MAX_V2_RECENT_EVIDENCE_SESSION_IDS = 16;
const MAX_CALIBRATION_POINTS = 20;
const ATHLETE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Permanent v1 reader/verifier contract. These values describe already-written
 * evidence and must not follow the aliases used to create new assessments.
 */
export const VO2_FITNESS_PROJECTION_V1 = {
  fitnessStateSchemaVersion: FITNESS_STATE_SCHEMA_VERSION_V1,
  assessmentSchemaVersion: VO2_ASSESSMENT_SCHEMA_VERSION_V1,
  evidenceSchemaVersion: VO2_EVIDENCE_SCHEMA_VERSION_V1,
  estimatorId: LEGACY_VO2_ESTIMATOR_ID,
  estimatorVersion: LEGACY_VO2_ESTIMATOR_VERSION,
  protocolId: LEGACY_VO2_PROTOCOL_ID,
  protocolVersion: LEGACY_VO2_PROTOCOL_VERSION,
  ageYearsMin: 10,
  ageYearsMax: 100,
  weightKgMin: 20,
  weightKgMax: 250,
  vo2EstimateMin: 10,
  vo2EstimateMax: 100,
  predictedMaxWattsMax: 800,
  minimumAcceptedStages: 3,
  minimumEligibleStages: 3,
  minimumRSquared: 0.7,
  highQualityRSquared: 0.95,
  moderateQualityRSquared: 0.85,
  hrMaxIntercept: 208,
  hrMaxAgeCoefficient: 0.7,
  cycleVo2WattsCoefficient: 10.8,
  cycleVo2RestingValue: 7,
} as const;

/** Corrected protocol/estimator-v2 projection; v1 remains unchanged above. */
export const VO2_FITNESS_PROJECTION_V2 = {
  ...VO2_FITNESS_PROJECTION_V1,
  fitnessStateSchemaVersion: FITNESS_STATE_SCHEMA_VERSION_V3,
  assessmentSchemaVersion: VO2_ASSESSMENT_SCHEMA_VERSION_V2,
  evidenceSchemaVersion: VO2_EVIDENCE_SCHEMA_VERSION_V2,
  estimatorId: VO2_ESTIMATOR_ID,
  estimatorVersion: VO2_ESTIMATOR_VERSION,
  protocolId: VO2_PROTOCOL_ID,
  protocolVersion: VO2_PROTOCOL_VERSION,
} as const;

/**
 * Adaptive protocol-v3 collection projected with the unchanged estimator-v2
 * scientific semantics. The assessment records protocol v3 as its observed
 * identity while estimator-v2 diagnostics retain v2 as their primary expected
 * protocol version.
 */
export const VO2_FITNESS_PROJECTION_V2_PROTOCOL_V3 = {
  ...VO2_FITNESS_PROJECTION_V2,
  protocolVersion: VO2_PROTOCOL_VERSION_V3,
  diagnosticsExpectedProtocolVersion: VO2_PROTOCOL_VERSION,
} as const;

export const SUPPORTED_VO2_FITNESS_PROJECTIONS = [
  VO2_FITNESS_PROJECTION_V1,
  VO2_FITNESS_PROJECTION_V2,
  VO2_FITNESS_PROJECTION_V2_PROTOCOL_V3,
] as const;

export interface FitnessStateStorage extends ProfileStorage {
  setItem?(key: string, value: string): void;
}

export interface WritableFitnessStateStorage extends FitnessStateStorage {
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface PromoteVo2AssessmentInput {
  currentState: FitnessState | null;
  athleteProfile: AthleteProfile;
  workoutSummary: WorkoutSummary;
  assessment: Vo2AssessmentResult;
  updatedAt: string;
}

export type PersistedFitnessPromotionResult =
  | "promoted"
  | "not_eligible"
  | "persistence_failed";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isAthleteId(value: unknown): value is string {
  return typeof value === "string" && ATHLETE_ID_PATTERN.test(value);
}

function isEvidenceSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 256;
}

function nearlyEqual(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) <= epsilon * Math.max(1, Math.abs(a), Math.abs(b));
}

type SupportedVo2FitnessProjection = (typeof SUPPORTED_VO2_FITNESS_PROJECTIONS)[number];

export function isSupportedVo2FitnessEstimator(id: unknown, version: unknown): boolean {
  return SUPPORTED_VO2_FITNESS_PROJECTIONS.some(
    (projection) => projection.estimatorId === id && projection.estimatorVersion === version
  );
}

export function isSupportedVo2FitnessProtocol(id: unknown, version: unknown): boolean {
  return SUPPORTED_VO2_FITNESS_PROJECTIONS.some(
    (projection) => projection.protocolId === id && projection.protocolVersion === version
  );
}

function supportedProjection(
  estimatorId: unknown,
  estimatorVersion: unknown,
  protocolId: unknown,
  protocolVersion: unknown,
  projections: readonly SupportedVo2FitnessProjection[] = SUPPORTED_VO2_FITNESS_PROJECTIONS
): SupportedVo2FitnessProjection | undefined {
  return projections.find(
    (projection) =>
      projection.estimatorId === estimatorId &&
      projection.estimatorVersion === estimatorVersion &&
      projection.protocolId === protocolId &&
      projection.protocolVersion === protocolVersion
  );
}

function predictedHrMaxBpmForProjection(ageYears: number, projection: SupportedVo2FitnessProjection): number {
  return projection.hrMaxIntercept - projection.hrMaxAgeCoefficient * ageYears;
}

function cycleVo2MlKgMinForProjection(
  predictedMaxWatts: number,
  weightKg: number,
  projection: SupportedVo2FitnessProjection
): number {
  return (
    (projection.cycleVo2WattsCoefficient * predictedMaxWatts) / weightKg +
    projection.cycleVo2RestingValue
  );
}

function diagnosticsExpectedProtocolVersion(projection: SupportedVo2FitnessProjection): number {
  return "diagnosticsExpectedProtocolVersion" in projection
    ? projection.diagnosticsExpectedProtocolVersion
    : projection.protocolVersion;
}

function fitHrVsWattsV1(points: readonly HrWorkloadCalibrationPoint[]): {
  slope: number;
  intercept: number;
  rSquared: number;
} | null {
  if (points.length < 2) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const point of points) {
    sumX += point.watts;
    sumY += point.heartRateBpm;
    sumXY += point.watts * point.heartRateBpm;
    sumXX += point.watts * point.watts;
  }
  const denominator = points.length * sumXX - sumX * sumX;
  if (!Number.isFinite(denominator) || denominator === 0) return null;
  const slope = (points.length * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / points.length;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
  const meanY = sumY / points.length;
  let totalVariance = 0;
  let residualVariance = 0;
  for (const point of points) {
    const predicted = slope * point.watts + intercept;
    residualVariance += (point.heartRateBpm - predicted) ** 2;
    totalVariance += (point.heartRateBpm - meanY) ** 2;
  }
  if (!Number.isFinite(totalVariance) || totalVariance === 0) return null;
  const rSquared = 1 - residualVariance / totalVariance;
  return Number.isFinite(rSquared) ? { slope, intercept, rSquared } : null;
}

function parseAlgorithm(value: unknown): FitnessMetric<number>["algorithm"] | null | undefined {
  if (value == null) return undefined;
  if (!isObject(value) || typeof value.id !== "string" || value.id.trim() === "") return null;
  if (!isPositiveInteger(value.version)) return null;
  return { id: value.id, version: value.version };
}

function parseEvidenceSessionIds(value: unknown): string[] | null | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_V1_EVIDENCE_SESSION_IDS) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "" || seen.has(item)) return null;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function parseMetricEnvelope<T>(
  value: unknown,
  parseValue: (candidate: unknown) => T | null
): FitnessMetric<T> | null {
  if (!isObject(value)) return null;
  const parsedValue = parseValue(value.value);
  if (parsedValue == null) return null;
  if (
    value.source !== "formal_assessment" &&
    value.source !== "workout_observation" &&
    value.source !== "demographic_estimate"
  ) {
    return null;
  }
  if (
    value.quality !== "high" &&
    value.quality !== "moderate" &&
    value.quality !== "low" &&
    value.quality !== "unverified"
  ) {
    return null;
  }
  if (!isIsoTimestamp(value.observedAt) || !isIsoTimestamp(value.updatedAt)) return null;
  if (Date.parse(value.updatedAt) < Date.parse(value.observedAt)) return null;
  const algorithm = parseAlgorithm(value.algorithm);
  if (algorithm === null) return null;
  const evidenceSessionIds = parseEvidenceSessionIds(value.evidenceSessionIds);
  if (evidenceSessionIds === null) return null;
  return {
    value: parsedValue,
    source: value.source,
    quality: value.quality,
    observedAt: value.observedAt,
    updatedAt: value.updatedAt,
    ...(algorithm ? { algorithm } : {}),
    ...(evidenceSessionIds ? { evidenceSessionIds } : {}),
  };
}

function isSupportedFormalMetric(
  metric: FitnessMetric<unknown> | undefined,
  projections: readonly SupportedVo2FitnessProjection[]
): boolean {
  if (!metric) return true;
  return (
    metric.source === "formal_assessment" &&
    metric.quality !== "unverified" &&
    projections.some((projection) =>
      projection.estimatorId === metric.algorithm?.id && projection.estimatorVersion === metric.algorithm?.version
    ) &&
    Array.isArray(metric.evidenceSessionIds) &&
    metric.evidenceSessionIds.length > 0
  );
}

function parseCalibration(
  value: unknown,
  projections: readonly SupportedVo2FitnessProjection[]
): HrWorkloadCalibration | null {
  if (!isObject(value)) return null;
  if (!isPositiveFinite(value.slopeBpmPerWatt) || !isFiniteNumber(value.interceptBpm)) return null;
  if (!isFiniteNumber(value.rSquared) || value.rSquared < 0 || value.rSquared > 1) return null;
  if (!isPositiveFinite(value.observedMinWatts) || !isPositiveFinite(value.observedMaxWatts)) return null;
  if (value.observedMaxWatts < value.observedMinWatts) return null;
  if (!Array.isArray(value.points) || value.points.length < 2 || value.points.length > MAX_CALIBRATION_POINTS) return null;

  const points: HrWorkloadCalibrationPoint[] = [];
  const stageIds = new Set<string>();
  let previousWatts = -Infinity;
  for (const candidate of value.points) {
    if (!isObject(candidate)) return null;
    if (typeof candidate.stageId !== "string" || candidate.stageId.trim() === "" || stageIds.has(candidate.stageId)) {
      return null;
    }
    if (!isPositiveFinite(candidate.watts) || candidate.watts <= previousWatts) return null;
    if (!isPositiveFinite(candidate.heartRateBpm) || candidate.heartRateBpm > 250) return null;
    if (candidate.workloadSource !== "measured_watts" && candidate.workloadSource !== "calibrated_at_verified_cadence") {
      return null;
    }
    stageIds.add(candidate.stageId);
    previousWatts = candidate.watts;
    points.push({
      stageId: candidate.stageId,
      watts: candidate.watts,
      heartRateBpm: candidate.heartRateBpm,
      workloadSource: candidate.workloadSource,
    });
  }
  if (!nearlyEqual(points[0].watts, value.observedMinWatts)) return null;
  if (!nearlyEqual(points[points.length - 1].watts, value.observedMaxWatts)) return null;
  if (!isObject(value.protocol)) return null;
  const protocolId = value.protocol.id;
  const protocolVersion = value.protocol.version;
  if (
    typeof protocolId !== "string" ||
    !isPositiveInteger(protocolVersion) ||
    !projections.some((projection) =>
      projection.protocolId === protocolId && projection.protocolVersion === protocolVersion
    )
  ) {
    return null;
  }
  if (!isPositiveFinite(value.predictedHrMaxBpm) || value.predictedHrMaxSource !== "demographic_estimate") return null;
  if (!isObject(value.profileInputSnapshot)) return null;
  if (
    !isFiniteNumber(value.profileInputSnapshot.ageYears) ||
    !isPositiveFinite(value.profileInputSnapshot.bodyMassKg)
  ) {
    return null;
  }
  return {
    slopeBpmPerWatt: value.slopeBpmPerWatt,
    interceptBpm: value.interceptBpm,
    rSquared: value.rSquared,
    observedMinWatts: value.observedMinWatts,
    observedMaxWatts: value.observedMaxWatts,
    points,
    protocol: { id: protocolId, version: protocolVersion },
    predictedHrMaxBpm: value.predictedHrMaxBpm,
    predictedHrMaxSource: "demographic_estimate",
    profileInputSnapshot: {
      ageYears: value.profileInputSnapshot.ageYears,
      bodyMassKg: value.profileInputSnapshot.bodyMassKg,
    },
  };
}

/** Strict reconstruction of the permanent v1 persisted fitness projection. */
function parseFitnessStateV1(
  value: Record<string, unknown>,
  allowedProjections: readonly SupportedVo2FitnessProjection[] = [VO2_FITNESS_PROJECTION_V1]
): FitnessState | null {
  if (value.schemaVersion !== FITNESS_STATE_SCHEMA_VERSION_V1 || !isAthleteId(value.athleteId)) return null;
  if (value.passiveAerobicTrend !== undefined || value.passiveAerobicObservation !== undefined) return null;
  if (!isIsoTimestamp(value.updatedAt)) return null;

  const vo2Max = value.vo2Max == null
    ? undefined
    : parseMetricEnvelope(value.vo2Max, (candidate) =>
        isFiniteNumber(candidate) &&
        candidate >= VO2_FITNESS_PROJECTION_V1.vo2EstimateMin &&
        candidate <= VO2_FITNESS_PROJECTION_V1.vo2EstimateMax
          ? candidate
          : null
      );
  if (value.vo2Max != null && !vo2Max) return null;
  const predictedMaxWatts = value.predictedMaxWatts == null
    ? undefined
    : parseMetricEnvelope(value.predictedMaxWatts, (candidate) =>
        isPositiveFinite(candidate) && candidate <= VO2_FITNESS_PROJECTION_V1.predictedMaxWattsMax ? candidate : null
      );
  if (value.predictedMaxWatts != null && !predictedMaxWatts) return null;
  if (
    value.predictedMaxWatts != null &&
    (!isObject(value.predictedMaxWatts) ||
      value.predictedMaxWatts.derivation !== "demographic_hrmax_extrapolation" ||
      value.predictedMaxWatts.predictedHrMaxSource !== "demographic_estimate")
  ) {
    return null;
  }
  const hrWorkloadCalibration = value.hrWorkloadCalibration == null
    ? undefined
    : parseMetricEnvelope(value.hrWorkloadCalibration, (candidate) => parseCalibration(candidate, allowedProjections));
  if (value.hrWorkloadCalibration != null && !hrWorkloadCalibration) return null;
  if (
    !isSupportedFormalMetric(vo2Max, allowedProjections) ||
    !isSupportedFormalMetric(predictedMaxWatts, allowedProjections) ||
    !isSupportedFormalMetric(hrWorkloadCalibration, allowedProjections)
  ) {
    return null;
  }
  const metrics: FitnessMetric<unknown>[] = [];
  if (vo2Max) metrics.push(vo2Max);
  if (predictedMaxWatts) metrics.push(predictedMaxWatts);
  if (hrWorkloadCalibration) metrics.push(hrWorkloadCalibration);
  const firstAlgorithm = metrics[0]?.algorithm;
  if (
    metrics.some(
      (metric) =>
        metric.algorithm?.id !== firstAlgorithm?.id ||
        metric.algorithm?.version !== firstAlgorithm?.version
    )
  ) {
    return null;
  }
  if (hrWorkloadCalibration) {
    for (const metric of metrics) {
      if (
        metric &&
        !supportedProjection(
          metric.algorithm?.id,
          metric.algorithm?.version,
          hrWorkloadCalibration.value.protocol.id,
          hrWorkloadCalibration.value.protocol.version,
          allowedProjections
        )
      ) {
        return null;
      }
    }
  }

  for (const metric of metrics) {
    if (metric && Date.parse(metric.updatedAt) > Date.parse(value.updatedAt)) return null;
  }
  return {
    schemaVersion: FITNESS_STATE_SCHEMA_VERSION_V1,
    athleteId: value.athleteId,
    ...(vo2Max ? { vo2Max } : {}),
    ...(predictedMaxWatts
      ? {
          predictedMaxWatts: {
            ...predictedMaxWatts,
            derivation: "demographic_hrmax_extrapolation" as const,
            predictedHrMaxSource: "demographic_estimate" as const,
          },
        }
      : {}),
    ...(hrWorkloadCalibration ? { hrWorkloadCalibration } : {}),
    updatedAt: value.updatedAt,
  };
}

/** Permanent Phase D v1 algorithm reader contract; never follows a writer alias. */
export const PASSIVE_FITNESS_REFINEMENT_READER_V1 = {
  id: "fitness-refinement-v1",
  version: 1,
  comparisonBandBpm: 10,
  minimumMeasuredSessions: 4,
  minimumCalibratedSessions: 5,
  minimumDistinctDates: 4,
  moderateMinimumSessions: 6,
  highMinimumSessions: 8,
  moderateMaximumMadFraction: 0.1,
  highMaximumMadFraction: 0.05,
} as const;

function parsePassiveAerobicTrend(value: unknown): PassiveAerobicTrend | null {
  if (!isObject(value) || value.metric !== "workload_at_comparable_hr") return null;
  if (value.intensityId !== "aerobic_base" && value.intensityId !== "threshold") return null;
  for (const key of [
    "referenceHeartRateBpm",
    "projectedComparableWorkloadWatts",
    "baselineComparableWorkloadWatts",
    "observedMinWatts",
    "observedMaxWatts",
    "observedMinHeartRateBpm",
    "observedMaxHeartRateBpm",
  ] as const) {
    if (!isPositiveFinite(value[key])) return null;
  }
  if (!isFiniteNumber(value.changeFromBaselinePercent) || !isFiniteNumber(value.medianAbsoluteDeviationWatts)) return null;
  if (value.medianAbsoluteDeviationWatts < 0) return null;
  if (!isPositiveInteger(value.qualifiedSessionCount) || !isPositiveInteger(value.observationCount)) return null;
  if (!isPositiveInteger(value.distinctWorkoutDateCount)) return null;
  if (value.observationCount !== value.qualifiedSessionCount) return null;
  if (
    value.distinctWorkoutDateCount > value.qualifiedSessionCount ||
    value.distinctWorkoutDateCount < PASSIVE_FITNESS_REFINEMENT_READER_V1.minimumDistinctDates
  ) return null;
  if (
    (value.observedMaxHeartRateBpm as number) - (value.observedMinHeartRateBpm as number) >
    PASSIVE_FITNESS_REFINEMENT_READER_V1.comparisonBandBpm
  ) return null;
  if (
    value.observedMinWatts > value.observedMaxWatts ||
    value.observedMinHeartRateBpm > value.observedMaxHeartRateBpm ||
    value.baselineComparableWorkloadWatts < value.observedMinWatts ||
    value.baselineComparableWorkloadWatts > value.observedMaxWatts ||
    value.projectedComparableWorkloadWatts < value.observedMinWatts ||
    value.projectedComparableWorkloadWatts > value.observedMaxWatts ||
    value.referenceHeartRateBpm < value.observedMinHeartRateBpm ||
    value.referenceHeartRateBpm > value.observedMaxHeartRateBpm
  ) return null;
  if (value.comparisonBandBpm !== PASSIVE_FITNESS_REFINEMENT_READER_V1.comparisonBandBpm) return null;
  if (!isHistoricalRoundedPercentConsistent(
    value.baselineComparableWorkloadWatts as number,
    value.projectedComparableWorkloadWatts as number,
    value.changeFromBaselinePercent as number
  )) return null;
  if (!isIsoTimestamp(value.earliestEvidenceAt) || !isIsoTimestamp(value.latestEvidenceAt)) return null;
  if (Date.parse(value.earliestEvidenceAt) > Date.parse(value.latestEvidenceAt)) return null;
  if (
    !Array.isArray(value.workloadSourceClasses) ||
    value.workloadSourceClasses.length === 0 ||
    value.workloadSourceClasses.length > 2
  ) return null;
  const workloadSourceClasses: Array<"measured_watts" | "calibrated_watts"> = [];
  for (const source of value.workloadSourceClasses) {
    if (source !== "measured_watts" && source !== "calibrated_watts") return null;
    if (workloadSourceClasses.includes(source)) return null;
    workloadSourceClasses.push(source);
  }
  if (workloadSourceClasses.some((source, index) => index > 0 && source <= workloadSourceClasses[index - 1])) {
    return null;
  }
  const requiredSessionCount = workloadSourceClasses.includes("calibrated_watts")
    ? PASSIVE_FITNESS_REFINEMENT_READER_V1.minimumCalibratedSessions
    : PASSIVE_FITNESS_REFINEMENT_READER_V1.minimumMeasuredSessions;
  if ((value.qualifiedSessionCount as number) < requiredSessionCount) return null;
  const hasAnchorTime = value.formalAnchorObservedAt !== undefined;
  const hasAnchorSession = value.formalAnchorSessionId !== undefined;
  if (hasAnchorTime && !isIsoTimestamp(value.formalAnchorObservedAt)) return null;
  if (hasAnchorSession && !isEvidenceSessionId(value.formalAnchorSessionId)) return null;
  if (hasAnchorSession && !hasAnchorTime) return null;
  if (hasAnchorTime && Date.parse(value.formalAnchorObservedAt as string) >= Date.parse(value.earliestEvidenceAt)) return null;
  const referenceHeartRateBpm = value.referenceHeartRateBpm as number;
  const projectedComparableWorkloadWatts = value.projectedComparableWorkloadWatts as number;
  const baselineComparableWorkloadWatts = value.baselineComparableWorkloadWatts as number;
  const changeFromBaselinePercent = value.changeFromBaselinePercent as number;
  const observedMinWatts = value.observedMinWatts as number;
  const observedMaxWatts = value.observedMaxWatts as number;
  const observedMinHeartRateBpm = value.observedMinHeartRateBpm as number;
  const observedMaxHeartRateBpm = value.observedMaxHeartRateBpm as number;
  const medianAbsoluteDeviationWatts = value.medianAbsoluteDeviationWatts as number;
  return {
    metric: "workload_at_comparable_hr",
    intensityId: value.intensityId,
    referenceHeartRateBpm,
    projectedComparableWorkloadWatts,
    baselineComparableWorkloadWatts,
    changeFromBaselinePercent,
    qualifiedSessionCount: value.qualifiedSessionCount as number,
    observationCount: value.observationCount as number,
    distinctWorkoutDateCount: value.distinctWorkoutDateCount as number,
    workloadSourceClasses,
    earliestEvidenceAt: value.earliestEvidenceAt,
    latestEvidenceAt: value.latestEvidenceAt,
    observedMinWatts,
    observedMaxWatts,
    observedMinHeartRateBpm,
    observedMaxHeartRateBpm,
    medianAbsoluteDeviationWatts,
    comparisonBandBpm: value.comparisonBandBpm as number,
    ...(hasAnchorTime ? { formalAnchorObservedAt: value.formalAnchorObservedAt as string } : {}),
    ...(hasAnchorSession ? { formalAnchorSessionId: value.formalAnchorSessionId as string } : {}),
  };
}

/**
 * V1 rounded watts and percentage independently to three decimals. Accept only
 * percentages that could have been emitted from values inside those exact
 * persisted rounding intervals.
 */
function isHistoricalRoundedPercentConsistent(
  baselineWatts: number,
  projectedWatts: number,
  changePercent: number
): boolean {
  const halfRoundingUnit = 0.0005;
  const minimumPossiblePercent =
    ((projectedWatts - halfRoundingUnit) / (baselineWatts + halfRoundingUnit) - 1) * 100;
  const maximumPossiblePercent =
    ((projectedWatts + halfRoundingUnit) / (baselineWatts - halfRoundingUnit) - 1) * 100;
  const storedMinimum = changePercent - halfRoundingUnit;
  const storedMaximum = changePercent + halfRoundingUnit;
  return storedMaximum >= minimumPossiblePercent && storedMinimum <= maximumPossiblePercent;
}

function isPassiveV1QualityConsistent(
  value: PassiveAerobicTrend,
  quality: Exclude<FitnessMetricQuality, "unverified">
): boolean {
  const allMeasured =
    value.workloadSourceClasses.length === 1 && value.workloadSourceClasses[0] === "measured_watts";
  if (!allMeasured) return quality === "low";
  const roundingHalfUnit = 0.0005;
  const minimumPossibleRatio = Math.max(0, value.medianAbsoluteDeviationWatts - roundingHalfUnit) /
    (value.baselineComparableWorkloadWatts + roundingHalfUnit);
  const maximumPossibleRatio = (value.medianAbsoluteDeviationWatts + roundingHalfUnit) /
    Math.max(Number.EPSILON, value.baselineComparableWorkloadWatts - roundingHalfUnit);
  const highPossible =
    value.observationCount >= PASSIVE_FITNESS_REFINEMENT_READER_V1.highMinimumSessions &&
    minimumPossibleRatio <= PASSIVE_FITNESS_REFINEMENT_READER_V1.highMaximumMadFraction;
  const moderatePossible =
    value.observationCount >= PASSIVE_FITNESS_REFINEMENT_READER_V1.moderateMinimumSessions &&
    minimumPossibleRatio <= PASSIVE_FITNESS_REFINEMENT_READER_V1.moderateMaximumMadFraction &&
    (value.observationCount < PASSIVE_FITNESS_REFINEMENT_READER_V1.highMinimumSessions ||
      maximumPossibleRatio > PASSIVE_FITNESS_REFINEMENT_READER_V1.highMaximumMadFraction);
  const lowPossible =
    value.observationCount < PASSIVE_FITNESS_REFINEMENT_READER_V1.moderateMinimumSessions ||
    maximumPossibleRatio > PASSIVE_FITNESS_REFINEMENT_READER_V1.moderateMaximumMadFraction;
  return quality === "high" ? highPossible : quality === "moderate" ? moderatePossible : lowPossible;
}

function parseFitnessStateV2(value: Record<string, unknown>): FitnessState | null {
  if (value.schemaVersion !== FITNESS_STATE_SCHEMA_VERSION_V2) return null;
  if (value.passiveAerobicObservation !== undefined) return null;
  const formal = parseFitnessStateV1({
    ...value,
    schemaVersion: FITNESS_STATE_SCHEMA_VERSION_V1,
    passiveAerobicTrend: undefined,
    passiveAerobicObservation: undefined,
  }, [VO2_FITNESS_PROJECTION_V1]);
  if (!formal) return null;
  const passive = value.passiveAerobicTrend == null
    ? undefined
    : parseMetricEnvelope(value.passiveAerobicTrend, parsePassiveAerobicTrend);
  if (value.passiveAerobicTrend != null && !passive) return null;
  if (passive) {
    const anchor = latestFormalAnchorIdentity(formal);
    const hasPassiveAnchor = passive.value.formalAnchorObservedAt !== undefined;
    if (
      passive.source !== "workout_observation" ||
      passive.quality === "unverified" ||
      passive.algorithm?.id !== PASSIVE_FITNESS_REFINEMENT_READER_V1.id ||
      passive.algorithm.version !== PASSIVE_FITNESS_REFINEMENT_READER_V1.version ||
      !passive.evidenceSessionIds ||
      passive.evidenceSessionIds.length !== passive.value.qualifiedSessionCount ||
      passive.observedAt !== passive.value.latestEvidenceAt ||
      passive.updatedAt !== passive.value.latestEvidenceAt ||
      !isPassiveV1QualityConsistent(passive.value, passive.quality as Exclude<FitnessMetricQuality, "unverified">) ||
      Date.parse(passive.updatedAt) > Date.parse(value.updatedAt as string)
    ) return null;
    if (
      Boolean(anchor) !== hasPassiveAnchor ||
      (anchor && passive.value.formalAnchorObservedAt !== anchor.observedAt) ||
      (anchor && passive.value.formalAnchorSessionId !== anchor.sessionId)
    ) return null;
  }
  return {
    ...formal,
    schemaVersion: FITNESS_STATE_SCHEMA_VERSION_V2,
    ...(passive ? { passiveAerobicTrend: passive } : {}),
  };
}

/** Permanent corrected Phase D reader contract; independent of future writer aliases. */
export const PASSIVE_FITNESS_REFINEMENT_READER_V2 = {
  id: "fitness-refinement-v2",
  version: 2,
  metric: "descriptive_workload_trend_in_fixed_hr_window",
  fixedHrWindowWidthBpm: 2,
  minimumObservedHeartRateBpm: 80,
  maximumObservedHeartRateBpm: 200,
  minimumHeartRateWindowBpm: 80,
  maximumHeartRateWindowExclusiveBpm: 202,
  minimumObservedWorkloadWatts: 30,
  maximumObservedWorkloadWatts: 600,
  minimumMeasuredSessions: 4,
  minimumCalibratedSessions: 5,
  minimumDistinctDates: 4,
  moderateMinimumSessions: 6,
  highMinimumSessions: 8,
  moderateMaximumMadFraction: 0.1,
  highMaximumMadFraction: 0.05,
  maximumRecentEvidenceSessionIds: 16,
  evidenceDigestAlgorithm: "fnv1a32",
} as const;

function expectedPassiveV2Quality(
  value: PassiveAerobicObservation,
  observationCount: number
): Exclude<FitnessMetricQuality, "unverified"> {
  const allMeasured =
    value.workloadSourceClasses.length === 1 && value.workloadSourceClasses[0] === "measured_watts";
  if (
    allMeasured &&
    observationCount >= PASSIVE_FITNESS_REFINEMENT_READER_V2.highMinimumSessions &&
    value.medianAbsoluteDeviationWatts / value.baselineWorkloadMedianWatts <=
      PASSIVE_FITNESS_REFINEMENT_READER_V2.highMaximumMadFraction
  ) return "high";
  if (
    allMeasured &&
    observationCount >= PASSIVE_FITNESS_REFINEMENT_READER_V2.moderateMinimumSessions &&
    value.medianAbsoluteDeviationWatts / value.baselineWorkloadMedianWatts <=
      PASSIVE_FITNESS_REFINEMENT_READER_V2.moderateMaximumMadFraction
  ) return "moderate";
  return "low";
}

function roundV2(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parsePassiveAerobicObservation(value: unknown): PassiveAerobicObservation | null {
  if (
    !isObject(value) ||
    value.metric !== PASSIVE_FITNESS_REFINEMENT_READER_V2.metric ||
    value.interpretation !== "descriptive_observation_only" ||
    value.normalizedToReferenceHr !== false ||
    value.eligibleForPrescription !== false
  ) return null;
  if (value.intensityId !== "aerobic_base" && value.intensityId !== "threshold") return null;
  for (const key of [
    "heartRateWindowCenterBpm",
    "heartRateWindowMinBpm",
    "heartRateWindowMaxExclusiveBpm",
    "guardedTrendWorkloadWatts",
    "baselineWorkloadMedianWatts",
    "observedMinWatts",
    "observedMaxWatts",
    "observedMinHeartRateBpm",
    "observedMaxHeartRateBpm",
  ] as const) {
    if (!isPositiveFinite(value[key])) return null;
  }
  if (
    !isFiniteNumber(value.guardedTrendChangeFromBaselinePercent) ||
    !isFiniteNumber(value.medianAbsoluteDeviationWatts)
  ) {
    return null;
  }
  if ((value.medianAbsoluteDeviationWatts as number) < 0) return null;
  const windowMin = value.heartRateWindowMinBpm as number;
  const windowMax = value.heartRateWindowMaxExclusiveBpm as number;
  if (
    !Number.isInteger(windowMin) ||
    windowMin % PASSIVE_FITNESS_REFINEMENT_READER_V2.fixedHrWindowWidthBpm !== 0 ||
    windowMax - windowMin !== PASSIVE_FITNESS_REFINEMENT_READER_V2.fixedHrWindowWidthBpm ||
    windowMin < PASSIVE_FITNESS_REFINEMENT_READER_V2.minimumHeartRateWindowBpm ||
    windowMax > PASSIVE_FITNESS_REFINEMENT_READER_V2.maximumHeartRateWindowExclusiveBpm ||
    value.heartRateWindowCenterBpm !== windowMin + PASSIVE_FITNESS_REFINEMENT_READER_V2.fixedHrWindowWidthBpm / 2
  ) return null;
  const observedMinHr = value.observedMinHeartRateBpm as number;
  const observedMaxHr = value.observedMaxHeartRateBpm as number;
  const observedMinWatts = value.observedMinWatts as number;
  const observedMaxWatts = value.observedMaxWatts as number;
  const guardedTrendWatts = value.guardedTrendWorkloadWatts as number;
  const baselineMedianWatts = value.baselineWorkloadMedianWatts as number;
  if (
    observedMinHr < PASSIVE_FITNESS_REFINEMENT_READER_V2.minimumObservedHeartRateBpm ||
    observedMaxHr > PASSIVE_FITNESS_REFINEMENT_READER_V2.maximumObservedHeartRateBpm ||
    observedMinHr < windowMin ||
    observedMaxHr >= windowMax ||
    observedMinHr > observedMaxHr ||
    observedMinWatts < PASSIVE_FITNESS_REFINEMENT_READER_V2.minimumObservedWorkloadWatts ||
    observedMaxWatts > PASSIVE_FITNESS_REFINEMENT_READER_V2.maximumObservedWorkloadWatts ||
    observedMinWatts > observedMaxWatts ||
    baselineMedianWatts < PASSIVE_FITNESS_REFINEMENT_READER_V2.minimumObservedWorkloadWatts ||
    baselineMedianWatts > PASSIVE_FITNESS_REFINEMENT_READER_V2.maximumObservedWorkloadWatts ||
    guardedTrendWatts < PASSIVE_FITNESS_REFINEMENT_READER_V2.minimumObservedWorkloadWatts ||
    guardedTrendWatts > PASSIVE_FITNESS_REFINEMENT_READER_V2.maximumObservedWorkloadWatts ||
    baselineMedianWatts < observedMinWatts ||
    baselineMedianWatts > observedMaxWatts ||
    guardedTrendWatts < observedMinWatts ||
    guardedTrendWatts > observedMaxWatts
  ) return null;
  if (
    value.guardedTrendChangeFromBaselinePercent !==
    roundV2(((guardedTrendWatts - baselineMedianWatts) / baselineMedianWatts) * 100)
  ) return null;
  if (
    !Array.isArray(value.workloadSourceClasses) ||
    value.workloadSourceClasses.length === 0 ||
    value.workloadSourceClasses.length > 2
  ) return null;
  const workloadSourceClasses: Array<"measured_watts" | "calibrated_watts"> = [];
  for (const source of value.workloadSourceClasses) {
    if (source !== "measured_watts" && source !== "calibrated_watts") return null;
    if (workloadSourceClasses.includes(source)) return null;
    workloadSourceClasses.push(source);
  }
  if (workloadSourceClasses.some((source, index) => index > 0 && source <= workloadSourceClasses[index - 1])) {
    return null;
  }
  const hasAnchorTime = value.formalAnchorObservedAt !== undefined;
  const hasAnchorSession = value.formalAnchorSessionId !== undefined;
  if (hasAnchorTime && !isIsoTimestamp(value.formalAnchorObservedAt)) return null;
  if (hasAnchorSession && !isEvidenceSessionId(value.formalAnchorSessionId)) return null;
  if (hasAnchorSession && !hasAnchorTime) return null;
  return {
    metric: PASSIVE_FITNESS_REFINEMENT_READER_V2.metric,
    interpretation: "descriptive_observation_only",
    normalizedToReferenceHr: false,
    eligibleForPrescription: false,
    intensityId: value.intensityId,
    heartRateWindowCenterBpm: value.heartRateWindowCenterBpm as number,
    heartRateWindowMinBpm: windowMin,
    heartRateWindowMaxExclusiveBpm: windowMax,
    guardedTrendWorkloadWatts: guardedTrendWatts,
    baselineWorkloadMedianWatts: baselineMedianWatts,
    guardedTrendChangeFromBaselinePercent: value.guardedTrendChangeFromBaselinePercent as number,
    workloadSourceClasses,
    observedMinWatts,
    observedMaxWatts,
    observedMinHeartRateBpm: observedMinHr,
    observedMaxHeartRateBpm: observedMaxHr,
    medianAbsoluteDeviationWatts: value.medianAbsoluteDeviationWatts as number,
    ...(hasAnchorTime ? { formalAnchorObservedAt: value.formalAnchorObservedAt as string } : {}),
    ...(hasAnchorSession ? { formalAnchorSessionId: value.formalAnchorSessionId as string } : {}),
  };
}

function parsePassiveEvidenceSummary(value: unknown): PassiveAerobicObservationMetric["evidence"] | null {
  if (!isObject(value)) return null;
  if (!isPositiveInteger(value.sessionCount) || !isPositiveInteger(value.observationCount)) return null;
  if (value.sessionCount !== value.observationCount) return null;
  if (!isPositiveInteger(value.distinctWorkoutDateCount) || value.distinctWorkoutDateCount > value.sessionCount) {
    return null;
  }
  if (!isIsoTimestamp(value.earliestEvidenceAt) || !isIsoTimestamp(value.latestEvidenceAt)) return null;
  if (Date.parse(value.earliestEvidenceAt) > Date.parse(value.latestEvidenceAt)) return null;
  if (!isEvidenceSessionId(value.firstSessionId) || !isEvidenceSessionId(value.latestSessionId)) return null;
  if (!Array.isArray(value.recentSessionIds)) return null;
  const expectedRecentCount = Math.min(
    value.sessionCount as number,
    PASSIVE_FITNESS_REFINEMENT_READER_V2.maximumRecentEvidenceSessionIds
  );
  if (value.recentSessionIds.length !== expectedRecentCount) return null;
  const recentSessionIds: string[] = [];
  for (const id of value.recentSessionIds) {
    if (!isEvidenceSessionId(id) || recentSessionIds.includes(id)) return null;
    recentSessionIds.push(id);
  }
  if (recentSessionIds[recentSessionIds.length - 1] !== value.latestSessionId) return null;
  if (value.sessionCount <= PASSIVE_FITNESS_REFINEMENT_READER_V2.maximumRecentEvidenceSessionIds) {
    if (recentSessionIds[0] !== value.firstSessionId) return null;
  } else if (recentSessionIds.includes(value.firstSessionId as string)) {
    return null;
  }
  if (
    !isObject(value.digest) ||
    value.digest.algorithm !== PASSIVE_FITNESS_REFINEMENT_READER_V2.evidenceDigestAlgorithm ||
    typeof value.digest.value !== "string" ||
    !/^[0-9a-f]{8}$/.test(value.digest.value)
  ) return null;
  return {
    sessionCount: value.sessionCount as number,
    observationCount: value.observationCount as number,
    distinctWorkoutDateCount: value.distinctWorkoutDateCount as number,
    earliestEvidenceAt: value.earliestEvidenceAt,
    latestEvidenceAt: value.latestEvidenceAt,
    firstSessionId: value.firstSessionId,
    latestSessionId: value.latestSessionId,
    recentSessionIds,
    digest: { algorithm: "fnv1a32", value: value.digest.value },
  };
}

function parsePassiveAerobicObservationMetric(value: unknown): PassiveAerobicObservationMetric | null {
  if (!isObject(value)) return null;
  const parsedValue = parsePassiveAerobicObservation(value.value);
  const evidence = parsePassiveEvidenceSummary(value.evidence);
  if (!parsedValue || !evidence) return null;
  if (
    value.source !== "workout_observation" ||
    (value.quality !== "high" && value.quality !== "moderate" && value.quality !== "low") ||
    !isIsoTimestamp(value.observedAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    value.observedAt !== evidence.latestEvidenceAt ||
    value.updatedAt !== evidence.latestEvidenceAt ||
    !isObject(value.algorithm) ||
    value.algorithm.id !== PASSIVE_FITNESS_REFINEMENT_READER_V2.id ||
    value.algorithm.version !== PASSIVE_FITNESS_REFINEMENT_READER_V2.version
  ) return null;
  const requiredSessions = parsedValue.workloadSourceClasses.includes("calibrated_watts")
    ? PASSIVE_FITNESS_REFINEMENT_READER_V2.minimumCalibratedSessions
    : PASSIVE_FITNESS_REFINEMENT_READER_V2.minimumMeasuredSessions;
  if (
    evidence.sessionCount < requiredSessions ||
    evidence.distinctWorkoutDateCount < PASSIVE_FITNESS_REFINEMENT_READER_V2.minimumDistinctDates ||
    value.quality !== expectedPassiveV2Quality(parsedValue, evidence.observationCount)
  ) return null;
  return {
    value: parsedValue,
    source: "workout_observation",
    quality: value.quality,
    observedAt: value.observedAt,
    updatedAt: value.updatedAt,
    algorithm: { id: "fitness-refinement-v2", version: 2 },
    evidence,
  };
}

function latestMetricUpdatedAt(state: FitnessState): string | undefined {
  return [state.vo2Max, state.predictedMaxWatts, state.hrWorkloadCalibration, state.passiveAerobicObservation]
    .map((metric) => metric?.updatedAt)
    .filter((timestamp): timestamp is string => !!timestamp)
    .sort()
    .slice(-1)[0];
}

function parseFitnessStateV3(value: Record<string, unknown>): FitnessState | null {
  if (value.schemaVersion !== FITNESS_STATE_SCHEMA_VERSION_V3 || value.passiveAerobicTrend !== undefined) return null;
  const formal = parseFitnessStateV1({
    ...value,
    schemaVersion: FITNESS_STATE_SCHEMA_VERSION_V1,
    passiveAerobicTrend: undefined,
    passiveAerobicObservation: undefined,
  }, SUPPORTED_VO2_FITNESS_PROJECTIONS);
  if (!formal) return null;
  const passive = value.passiveAerobicObservation == null
    ? undefined
    : parsePassiveAerobicObservationMetric(value.passiveAerobicObservation);
  if (value.passiveAerobicObservation != null && !passive) return null;
  const state: FitnessState = {
    ...formal,
    schemaVersion: FITNESS_STATE_SCHEMA_VERSION_V3,
    ...(passive ? { passiveAerobicObservation: passive } : {}),
  };
  if (passive) {
    const anchor = latestFormalAnchorIdentity(formal);
    const hasPassiveAnchor = passive.value.formalAnchorObservedAt !== undefined;
    if (
      Boolean(anchor) !== hasPassiveAnchor ||
      (anchor && passive.value.formalAnchorObservedAt !== anchor.observedAt) ||
      (anchor && passive.value.formalAnchorSessionId !== anchor.sessionId) ||
      (anchor && Date.parse(anchor.observedAt) >= Date.parse(passive.evidence.earliestEvidenceAt))
    ) return null;
  }
  if (latestMetricUpdatedAt(state) !== value.updatedAt) return null;
  return state;
}

/** Dispatch persisted state by historical schema, never by the current writer alias. */
export function parseFitnessState(value: unknown): FitnessState | null {
  if (!isObject(value)) return null;
  switch (value.schemaVersion) {
    case FITNESS_STATE_SCHEMA_VERSION_V1:
      return parseFitnessStateV1(value);
    case FITNESS_STATE_SCHEMA_VERSION_V2:
      return parseFitnessStateV2(value);
    case FITNESS_STATE_SCHEMA_VERSION_V3:
      return parseFitnessStateV3(value);
    default:
      return null;
  }
}

export function parseAthleteFitnessSnapshot(value: unknown): AthleteFitnessSnapshot | null {
  if (!isObject(value) || !isAthleteId(value.athleteId)) return null;
  if (value.profileSchemaVersion !== ATHLETE_PROFILE_SCHEMA_VERSION_V1) return null;
  const hasFitnessVersion = value.fitnessStateSchemaVersion != null;
  const hasFitnessTime = value.fitnessUpdatedAt != null;
  if (hasFitnessVersion !== hasFitnessTime) return null;
  if (hasFitnessVersion) {
    if (
      value.fitnessStateSchemaVersion !== FITNESS_STATE_SCHEMA_VERSION_V1 &&
      value.fitnessStateSchemaVersion !== FITNESS_STATE_SCHEMA_VERSION_V2 &&
      value.fitnessStateSchemaVersion !== FITNESS_STATE_SCHEMA_VERSION_V3
    ) return null;
    if (!isIsoTimestamp(value.fitnessUpdatedAt)) return null;
  }
  return {
    athleteId: value.athleteId,
    profileSchemaVersion: ATHLETE_PROFILE_SCHEMA_VERSION_V1,
    ...(hasFitnessVersion
      ? {
          fitnessStateSchemaVersion: value.fitnessStateSchemaVersion as
            | typeof FITNESS_STATE_SCHEMA_VERSION_V1
            | typeof FITNESS_STATE_SCHEMA_VERSION_V2
            | typeof FITNESS_STATE_SCHEMA_VERSION_V3,
          fitnessUpdatedAt: value.fitnessUpdatedAt as string,
        }
      : {}),
  };
}

export function readFitnessState(
  athleteId: string,
  storage?: FitnessStateStorage
): FitnessState | null {
  if (!isAthleteId(athleteId)) return null;
  const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  if (!store) return null;
  const raw = store.getItem(FITNESS_STATE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = parseFitnessState(JSON.parse(raw));
    return parsed?.athleteId === athleteId ? parsed : null;
  } catch {
    return null;
  }
}

export function storeFitnessState(
  state: FitnessState,
  storage?: WritableFitnessStateStorage
): boolean {
  const parsed = parseFitnessState(state);
  const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  if (!parsed || !store) return false;
  try {
    store.setItem(FITNESS_STATE_STORAGE_KEY, JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}

export function captureAthleteFitnessSnapshot(storage?: FitnessStateStorage): AthleteFitnessSnapshot {
  const athlete = loadAthleteProfile(storage);
  const fitness = readFitnessState(athlete.athleteId, storage);
  return {
    athleteId: athlete.athleteId,
    profileSchemaVersion: ATHLETE_PROFILE_SCHEMA_VERSION,
    ...(fitness
      ? {
          fitnessStateSchemaVersion: fitness.schemaVersion,
          fitnessUpdatedAt: fitness.updatedAt,
        }
      : {}),
  };
}

function expectedFitQuality(
  rSquared: number,
  projection: SupportedVo2FitnessProjection
): Exclude<FitnessMetricQuality, "unverified"> {
  if (rSquared >= projection.highQualityRSquared) return "high";
  if (rSquared >= projection.moderateQualityRSquared) return "moderate";
  return "low";
}

function conservativeQuality(
  fitQuality: "high" | "moderate" | "low",
  points: readonly HrWorkloadCalibrationPoint[]
): Exclude<FitnessMetricQuality, "unverified"> {
  if (fitQuality === "high" && points.some((point) => point.workloadSource === "calibrated_at_verified_cadence")) {
    return "moderate";
  }
  return fitQuality;
}

function eligibleCalibrationPoints(
  summary: WorkoutSummary,
  assessment: Vo2AssessmentResult,
  projection: SupportedVo2FitnessProjection
): HrWorkloadCalibrationPoint[] | null {
  const assessmentPoints = assessment.diagnostics.eligible_points;
  const stages = summary.vo2_evidence?.protocol?.stages;
  if (!Array.isArray(assessmentPoints) || !Array.isArray(stages)) return null;
  if (
    assessmentPoints.length !== assessment.eligible_stage_count ||
    assessmentPoints.length < projection.minimumEligibleStages
  ) {
    return null;
  }
  const stageIds = new Set<string>();
  const points: HrWorkloadCalibrationPoint[] = [];
  for (const point of assessmentPoints) {
    if (!isObject(point) || point.protocol_accepted !== true || point.estimator_eligible !== true) return null;
    if (!Array.isArray(point.ineligibility_reasons) || point.ineligibility_reasons.length !== 0) return null;
    if (typeof point.stage_id !== "string" || point.stage_id === "" || stageIds.has(point.stage_id)) return null;
    if (!isPositiveFinite(point.watts) || !isPositiveFinite(point.steady_state_bpm) || point.steady_state_bpm > 250) return null;
    if (point.workload_source !== "measured_watts" && point.workload_source !== "calibrated_at_verified_cadence") {
      return null;
    }
    const stage = stages.find((candidate) => isObject(candidate) && candidate.stage_id === point.stage_id);
    if (!stage || stage.status !== "accepted") return null;
    if (!isObject(stage.workload) || stage.workload.source !== point.workload_source) return null;
    if (!nearlyEqual(stage.workload.estimator_watts as number, point.watts)) return null;
    if (!isObject(stage.hr) || !nearlyEqual(stage.hr.steady_state_bpm as number, point.steady_state_bpm)) return null;
    stageIds.add(point.stage_id);
    points.push({
      stageId: point.stage_id,
      watts: point.watts,
      heartRateBpm: point.steady_state_bpm,
      workloadSource: point.workload_source,
    });
  }
  if (points.some((point, index) => index > 0 && point.watts <= points[index - 1].watts)) return null;
  if (
    assessment.stages_used.length !== points.length ||
    assessment.stages_used.some((stageId, index) => stageId !== points[index].stageId)
  ) {
    return null;
  }
  return points;
}

function assessmentCanPromote(
  athlete: AthleteProfile,
  summary: WorkoutSummary,
  assessment: Vo2AssessmentResult
): {
  points: HrWorkloadCalibrationPoint[];
  quality: Exclude<FitnessMetricQuality, "unverified">;
  projection: SupportedVo2FitnessProjection;
  protocol: { id: string; version: number };
} | null {
  if (!isObject(summary) || !isObject(assessment)) return null;
  if (summary.athlete_id !== athlete.athleteId) return null;
  if (!isIsoTimestamp(summary.endedAt) || !isEvidenceSessionId(summary.external_session_id)) return null;
  if (assessment.status !== "estimated") return null;
  if (!isObject(assessment.input_snapshot) || !isObject(assessment.diagnostics)) return null;
  const assessmentProtocolId = assessment.input_snapshot.protocol_id;
  const assessmentProtocolVersion = assessment.input_snapshot.protocol_version;
  if (typeof assessmentProtocolId !== "string" || !isPositiveInteger(assessmentProtocolVersion)) return null;
  const projection = supportedProjection(
    assessment.estimator_id,
    assessment.estimator_version,
    assessmentProtocolId,
    assessmentProtocolVersion
  );
  if (!projection || assessment.schema_version !== projection.assessmentSchemaVersion) return null;
  if (!Array.isArray(assessment.reason_codes) || !Array.isArray(assessment.stages_used)) return null;
  if (!Array.isArray(assessment.diagnostics.accepted_points) || !Array.isArray(assessment.diagnostics.eligible_points)) {
    return null;
  }
  if (!isPositiveInteger(assessment.accepted_stage_count) || !isPositiveInteger(assessment.eligible_stage_count)) {
    return null;
  }
  if (assessment.diagnostics.accepted_points.length !== assessment.accepted_stage_count) return null;
  if (assessment.diagnostics.eligible_points.length !== assessment.eligible_stage_count) return null;
  if (assessment.stages_used.some((stageId) => typeof stageId !== "string" || stageId === "")) return null;
  if (!isObject(summary.vo2_evidence) || summary.vo2_evidence.schema_version !== projection.evidenceSchemaVersion) {
    return null;
  }
  const protocol = summary.vo2_evidence.protocol;
  if (
    !isObject(protocol) ||
    protocol.protocol_id !== projection.protocolId ||
    protocol.protocol_version !== projection.protocolVersion
  ) {
    return null;
  }
  if (!Array.isArray(protocol.stages)) return null;
  if (
    assessment.diagnostics.expected_protocol_id !== projection.protocolId ||
    assessment.diagnostics.expected_protocol_version !== diagnosticsExpectedProtocolVersion(projection)
  ) {
    return null;
  }
  if (
    assessment.diagnostics.observed_protocol_id !== projection.protocolId ||
    assessment.diagnostics.observed_protocol_version !== projection.protocolVersion
  ) {
    return null;
  }
  if (assessment.diagnostics.min_r_squared !== projection.minimumRSquared) return null;
  if (assessment.reason_codes.length !== 0) return null;
  if (assessment.accepted_stage_count < projection.minimumAcceptedStages) return null;
  if (!isFiniteNumber(assessment.estimate_ml_kg_min)) return null;
  if (
    assessment.estimate_ml_kg_min < projection.vo2EstimateMin ||
    assessment.estimate_ml_kg_min > projection.vo2EstimateMax
  ) {
    return null;
  }
  if (assessment.fit_quality !== "high" && assessment.fit_quality !== "moderate" && assessment.fit_quality !== "low") {
    return null;
  }
  const diagnostics = assessment.diagnostics;
  if (!isPositiveFinite(diagnostics.slope) || !isFiniteNumber(diagnostics.intercept)) return null;
  if (!isFiniteNumber(diagnostics.r_squared) || diagnostics.r_squared < projection.minimumRSquared || diagnostics.r_squared > 1) {
    return null;
  }
  if (assessment.fit_quality !== expectedFitQuality(diagnostics.r_squared, projection)) return null;
  if (!isPositiveFinite(diagnostics.predicted_max_watts) || diagnostics.predicted_max_watts > projection.predictedMaxWattsMax) {
    return null;
  }

  const age = assessment.input_snapshot.age_years;
  const bodyMassKg = assessment.input_snapshot.weight_kg;
  const predictedHrMax = assessment.input_snapshot.predicted_hr_max;
  if (!isFiniteNumber(age) || age < projection.ageYearsMin || age > projection.ageYearsMax) return null;
  if (!isFiniteNumber(bodyMassKg) || bodyMassKg < projection.weightKgMin || bodyMassKg > projection.weightKgMax) return null;
  if (!isPositiveFinite(predictedHrMax) || !nearlyEqual(predictedHrMax, predictedHrMaxBpmForProjection(age, projection))) {
    return null;
  }
  if (!nearlyEqual(diagnostics.predicted_hr_max as number, predictedHrMax)) return null;
  const extrapolatedWatts = (predictedHrMax - diagnostics.intercept) / diagnostics.slope;
  if (!nearlyEqual(extrapolatedWatts, diagnostics.predicted_max_watts)) return null;
  if (!nearlyEqual(
    cycleVo2MlKgMinForProjection(diagnostics.predicted_max_watts, bodyMassKg, projection),
    assessment.estimate_ml_kg_min
  )) {
    return null;
  }

  const points = eligibleCalibrationPoints(summary, assessment, projection);
  if (!points) return null;
  const recomputedFit = fitHrVsWattsV1(points);
  if (
    !recomputedFit ||
    !nearlyEqual(recomputedFit.slope, diagnostics.slope) ||
    !nearlyEqual(recomputedFit.intercept, diagnostics.intercept) ||
    !nearlyEqual(recomputedFit.rSquared, diagnostics.r_squared)
  ) {
    return null;
  }
  return {
    points,
    quality: conservativeQuality(assessment.fit_quality, points),
    projection,
    protocol: {
      id: assessmentProtocolId,
      version: assessmentProtocolVersion,
    },
  };
}

function latestFormalAnchorIdentity(
  state: FitnessState
): { observedAt: string; sessionId?: string } | undefined {
  const metrics: Array<FitnessMetric<unknown> | undefined> = [
    state.vo2Max,
    state.predictedMaxWatts,
    state.hrWorkloadCalibration,
  ];
  const metric = metrics
    .filter((candidate): candidate is FitnessMetric<unknown> => candidate?.source === "formal_assessment")
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  return metric
    ? {
        observedAt: metric.observedAt,
        ...(metric.evidenceSessionIds?.[0] ? { sessionId: metric.evidenceSessionIds[0] } : {}),
      }
    : undefined;
}

function latestFormalEvidenceTime(state: FitnessState): number | undefined {
  const anchor = latestFormalAnchorIdentity(state);
  return anchor ? Date.parse(anchor.observedAt) : undefined;
}

/** Pure, fail-closed projection from immutable formal-assessment evidence. */
export function promoteVo2AssessmentToFitnessState(
  input: PromoteVo2AssessmentInput
): FitnessState | null {
  if (!isObject(input)) return null;
  const athlete = parseAthleteProfile(input.athleteProfile);
  if (!athlete) return null;
  const current = input.currentState == null ? null : parseFitnessState(input.currentState);
  if (input.currentState != null && !current) return null;
  if (current && current.athleteId !== athlete.athleteId) return null;
  if (!isIsoTimestamp(input.updatedAt)) return null;
  const eligibility = assessmentCanPromote(athlete, input.workoutSummary, input.assessment);
  if (!eligibility) return null;
  const observedAt = input.workoutSummary.endedAt;
  if (Date.parse(input.updatedAt) < Date.parse(observedAt)) return null;
  const latest = current ? latestFormalEvidenceTime(current) : undefined;
  if (latest != null && latest >= Date.parse(observedAt)) return null;

  const diagnostics = input.assessment.diagnostics;
  const algorithm = { id: input.assessment.estimator_id, version: input.assessment.estimator_version };
  const evidenceSessionIds = [input.workoutSummary.external_session_id];
  const metricBase = {
    source: "formal_assessment" as const,
    quality: eligibility.quality,
    observedAt,
    updatedAt: input.updatedAt,
    algorithm,
    evidenceSessionIds,
  };
  const calibration: HrWorkloadCalibration = {
    slopeBpmPerWatt: diagnostics.slope as number,
    interceptBpm: diagnostics.intercept as number,
    rSquared: diagnostics.r_squared as number,
    observedMinWatts: eligibility.points[0].watts,
    observedMaxWatts: eligibility.points[eligibility.points.length - 1].watts,
    points: eligibility.points.map((point) => ({ ...point })),
    protocol: eligibility.protocol,
    predictedHrMaxBpm: diagnostics.predicted_hr_max as number,
    predictedHrMaxSource: "demographic_estimate",
    profileInputSnapshot: {
      ageYears: input.assessment.input_snapshot.age_years as number,
      bodyMassKg: input.assessment.input_snapshot.weight_kg as number,
    },
  };
  return {
    schemaVersion: eligibility.projection.fitnessStateSchemaVersion,
    athleteId: athlete.athleteId,
    vo2Max: { value: input.assessment.estimate_ml_kg_min as number, ...metricBase },
    predictedMaxWatts: {
      value: diagnostics.predicted_max_watts as number,
      ...metricBase,
      derivation: "demographic_hrmax_extrapolation",
      predictedHrMaxSource: "demographic_estimate",
    },
    hrWorkloadCalibration: { value: calibration, ...metricBase },
    updatedAt: input.updatedAt,
  };
}

/** Persistence wrapper. Workout history must already have been saved by the caller. */
export function promoteVo2SummaryToStoredFitnessState(
  summary: WorkoutSummary,
  storage?: WritableFitnessStateStorage,
  updatedAt = new Date().toISOString()
): PersistedFitnessPromotionResult {
  if (!summary.vo2_assessment) return "not_eligible";
  const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  if (!store) return "persistence_failed";
  const athlete = loadAthleteProfile(store);
  const currentState = readFitnessState(athlete.athleteId, store);
  const promoted = promoteVo2AssessmentToFitnessState({
    currentState,
    athleteProfile: athlete,
    workoutSummary: summary,
    assessment: summary.vo2_assessment,
    updatedAt,
  });
  if (!promoted) return "not_eligible";
  return storeFitnessState(promoted, store) ? "promoted" : "persistence_failed";
}
