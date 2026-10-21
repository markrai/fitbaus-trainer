/**
 * Stored FitnessState shape, its schema versions, and its evidence sub-shapes.
 * Contract shapes only; algorithms live in src/fitnessState.ts and
 * src/fitnessRefinement.ts.
 */

import type { ATHLETE_PROFILE_SCHEMA_VERSION } from "./athlete.js";
import type { FitnessMetric, FitnessMetricQuality } from "./fitnessMetric.js";
import type { BikeWattsProvenance } from "./telemetry.js";
import type { Vo2WorkloadSource } from "./vo2Evidence.js";

/** Permanent historical schema identities. Readers must not key old data to current aliases. */
export const FITNESS_STATE_SCHEMA_VERSION_V1 = 1 as const;
export const FITNESS_STATE_SCHEMA_VERSION_V2 = 2 as const;
export const FITNESS_STATE_SCHEMA_VERSION_V3 = 3 as const;
export const FITNESS_STATE_SCHEMA_VERSION = FITNESS_STATE_SCHEMA_VERSION_V3;

export interface HrWorkloadCalibrationPoint {
  stageId: string;
  watts: number;
  heartRateBpm: number;
  workloadSource: Exclude<Vo2WorkloadSource, "prescribed_only">;
}

export interface HrWorkloadCalibration {
  slopeBpmPerWatt: number;
  interceptBpm: number;
  rSquared: number;
  observedMinWatts: number;
  observedMaxWatts: number;
  points: HrWorkloadCalibrationPoint[];
  protocol: {
    id: string;
    version: number;
  };
  /** Demographic extrapolation input retained for audit; never observed HRmax. */
  predictedHrMaxBpm: number;
  predictedHrMaxSource: "demographic_estimate";
  profileInputSnapshot: {
    ageYears: number;
    bodyMassKg: number;
  };
}

export interface PredictedMaxWattsMetric extends FitnessMetric<number> {
  derivation: "demographic_hrmax_extrapolation";
  predictedHrMaxSource: "demographic_estimate";
}

export type PassiveAerobicIntensityId = "aerobic_base" | "threshold";

/** Historical Phase D v1 shape. Reader-supported, but not effective current evidence. */
export interface PassiveAerobicTrend {
  metric: "workload_at_comparable_hr";
  intensityId: PassiveAerobicIntensityId;
  referenceHeartRateBpm: number;
  projectedComparableWorkloadWatts: number;
  baselineComparableWorkloadWatts: number;
  changeFromBaselinePercent: number;
  qualifiedSessionCount: number;
  observationCount: number;
  distinctWorkoutDateCount: number;
  workloadSourceClasses: BikeWattsProvenance[];
  earliestEvidenceAt: string;
  latestEvidenceAt: string;
  observedMinWatts: number;
  observedMaxWatts: number;
  observedMinHeartRateBpm: number;
  observedMaxHeartRateBpm: number;
  medianAbsoluteDeviationWatts: number;
  comparisonBandBpm: number;
  formalAnchorObservedAt?: string;
  formalAnchorSessionId?: string;
}

export interface PassiveEvidenceDigest {
  algorithm: "fnv1a32";
  value: string;
}

/** Bounded provenance for a rebuildable projection whose source of truth is workout history. */
export interface PassiveEvidenceSummary {
  sessionCount: number;
  observationCount: number;
  distinctWorkoutDateCount: number;
  earliestEvidenceAt: string;
  latestEvidenceAt: string;
  firstSessionId: string;
  latestSessionId: string;
  recentSessionIds: string[];
  digest: PassiveEvidenceDigest;
}

/**
 * Descriptive Phase D v2 output. It deliberately makes no HR normalization or
 * prescription-authority claim; Phase E must not consume it as a fitness target.
 */
export interface PassiveAerobicObservation {
  metric: "descriptive_workload_trend_in_fixed_hr_window";
  interpretation: "descriptive_observation_only";
  normalizedToReferenceHr: false;
  eligibleForPrescription: false;
  intensityId: PassiveAerobicIntensityId;
  heartRateWindowCenterBpm: number;
  heartRateWindowMinBpm: number;
  heartRateWindowMaxExclusiveBpm: number;
  guardedTrendWorkloadWatts: number;
  baselineWorkloadMedianWatts: number;
  guardedTrendChangeFromBaselinePercent: number;
  workloadSourceClasses: BikeWattsProvenance[];
  observedMinWatts: number;
  observedMaxWatts: number;
  observedMinHeartRateBpm: number;
  observedMaxHeartRateBpm: number;
  medianAbsoluteDeviationWatts: number;
  formalAnchorObservedAt?: string;
  formalAnchorSessionId?: string;
}

export interface PassiveAerobicObservationMetric {
  value: PassiveAerobicObservation;
  source: "workout_observation";
  quality: Exclude<FitnessMetricQuality, "unverified">;
  observedAt: string;
  updatedAt: string;
  algorithm: {
    id: "fitness-refinement-v2";
    version: 2;
  };
  evidence: PassiveEvidenceSummary;
}

export interface FitnessState {
  schemaVersion:
    | typeof FITNESS_STATE_SCHEMA_VERSION_V1
    | typeof FITNESS_STATE_SCHEMA_VERSION_V2
    | typeof FITNESS_STATE_SCHEMA_VERSION_V3;
  athleteId: string;
  vo2Max?: FitnessMetric<number>;
  /** Extrapolated by the named estimator; not directly measured maximal power. */
  predictedMaxWatts?: PredictedMaxWattsMetric;
  hrWorkloadCalibration?: FitnessMetric<HrWorkloadCalibration>;
  /** Historical Phase D v1 metric; retained only for storage compatibility. */
  passiveAerobicTrend?: FitnessMetric<PassiveAerobicTrend>;
  /** Current descriptive Phase D metric; explicitly unavailable to prescription resolution. */
  passiveAerobicObservation?: PassiveAerobicObservationMetric;
  updatedAt: string;
}

/** Minimal historical pointer for future prescription resolvers. Not consumed by Phase A. */
export interface AthleteFitnessSnapshot {
  athleteId: string;
  profileSchemaVersion: typeof ATHLETE_PROFILE_SCHEMA_VERSION;
  fitnessStateSchemaVersion?:
    | typeof FITNESS_STATE_SCHEMA_VERSION_V1
    | typeof FITNESS_STATE_SCHEMA_VERSION_V2
    | typeof FITNESS_STATE_SCHEMA_VERSION_V3;
  fitnessUpdatedAt?: string;
}
