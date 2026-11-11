/**
 * Personalized prescription characterization contracts (schemas V1-V3), each
 * historical version kept explicit. Contract shapes only; logic lives in
 * src/personalizedPrescriptionCharacterization.ts.
 */

import type { PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1, PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1, PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1, PersonalizedPrescriptionFallbackReasonV1, PersonalizedPrescriptionWorkloadProvenanceV1 } from "./personalizedPrescriptionEvaluation.js";
import type { Activity, PhaseIntensityId, ResolvedHeartRateTarget, WorkoutPhaseKind } from "./workoutPrescription.js";

/** Permanent Phase E2 diagnostic schema. This record has no control authority. */
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V1 = 1 as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V2 = 2 as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3 = 3 as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION =
  PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1 =
  "personalized-prescription-characterization" as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V1 = 1 as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V2 = 2 as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V3 = 3 as const;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION =
  PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V3;

export type PersonalizedPrescriptionCharacterizationOutcomeV1 =
  | "characterized"
  | "insufficient_evidence"
  | "not_candidate"
  | "unsupported_observed_provenance"
  | "telemetry_unavailable";

export type PersonalizedPrescriptionCharacterizationExclusionReasonV1 =
  | "phase_too_short"
  | "missing_telemetry"
  | "insufficient_hr_coverage"
  | "insufficient_power_coverage"
  | "insufficient_joint_coverage"
  | "insufficient_settled_in_band_evidence"
  | "unsupported_power_provenance"
  | "phase_evidence_unavailable";

export interface PersonalizedPrescriptionCharacterizationPolicyV1 {
  id: "e2-characterization-policy";
  version: 1;
  minObservedPhaseDurationSec: number;
  minHrCoverageRatio: number;
  minPowerCoverageRatio: number;
  minJointCoverageRatio: number;
  settlingSeconds: number;
  minSettledInBandSeconds: number;
  heartRateChangeWindowSeconds: number;
  minHeartRateChangeWindowSamples: number;
  domainEdgeFraction: number;
}

export interface PersonalizedPrescriptionEvidenceCoverageV1 {
  plannedDurationSec: number;
  observedDurationSec: number;
  hrCoveredSeconds: number;
  powerCoveredSeconds: number;
  jointCoveredSeconds: number;
  hrCoverageRatio: number;
  powerCoverageRatio: number;
  jointCoverageRatio: number;
}

export interface PersonalizedPrescriptionObservedHeartRateV1 {
  sampleCount: number;
  meanBpm: number;
  medianBpm: number;
  minBpm: number;
  maxBpm: number;
  belowBandSeconds: number;
  insideBandSeconds: number;
  aboveBandSeconds: number;
  insideBandRatio: number;
  earlyWindowMedianBpm?: number;
  lateWindowMedianBpm?: number;
  heartRateChangeLateVsEarlyBpm?: number;
}

export interface PersonalizedPrescriptionObservedPowerV1 {
  provenance: "measured_watts" | "calibrated_watts";
  sampleCount: number;
  medianWatts: number;
  q1Watts: number;
  q3Watts: number;
  minWatts: number;
  maxWatts: number;
  belowCandidateSeconds: number;
  insideCandidateSeconds: number;
  aboveCandidateSeconds: number;
  insideCandidateRatio: number;
}

export interface PersonalizedPrescriptionStableInBandWorkloadV1 {
  sampleCount: number;
  medianWatts: number;
  q1Watts: number;
  q3Watts: number;
  minWatts: number;
  maxWatts: number;
}

export interface PersonalizedPrescriptionResistanceCoverageV1 {
  coveredSeconds: number;
  lowerBoundSeconds: number;
  upperBoundSeconds: number;
}

export interface PersonalizedPrescriptionControllerContextV1 {
  available: boolean;
  observed: PersonalizedPrescriptionResistanceCoverageV1;
  desired: PersonalizedPrescriptionResistanceCoverageV1;
  commanded: PersonalizedPrescriptionResistanceCoverageV1;
  anyBoundarySaturationSeconds: number;
  saturationRatio: number;
  lowerBoundaryDecisionCount: number;
  upperBoundaryDecisionCount: number;
}

export interface PersonalizedPrescriptionCandidateDomainMarginsV1 {
  heartRateToLowerBoundaryBpm: number;
  heartRateToUpperBoundaryBpm: number;
  wattsToLowerBoundary: number;
  wattsToUpperBoundary: number;
  bucket: "edge" | "interior";
}

export interface PersonalizedPrescriptionCandidateComparisonV1 {
  candidateMidpointWatts: number;
  observedInBandMedianWatts: number;
  signedDifferenceWatts: number;
  absoluteDifferenceWatts: number;
  signedDifferencePercent: number;
  candidateContainsObservedMedian: boolean;
  candidateObservedOverlapWatts: number;
  candidateObservedOverlapRatio: number;
  agreement: "inside_candidate" | "below_candidate" | "above_candidate";
}

export interface PersonalizedPrescriptionPhaseCharacterizationV1 {
  phaseId: string;
  kind: WorkoutPhaseKind;
  intensityId?: PhaseIntensityId;
  detailName?: string;
  intervalIndex?: number;
  activeStartSec?: number;
  activeEndSec?: number;
  shadowOutcome: "candidate" | "fallback";
  fallbackReason?: PersonalizedPrescriptionFallbackReasonV1;
  legacyHeartRate?: ResolvedHeartRateTarget;
  candidatePower?: { minWatts: number; maxWatts: number };
  evidenceCoverage: PersonalizedPrescriptionEvidenceCoverageV1;
  observedHeartRate?: PersonalizedPrescriptionObservedHeartRateV1;
  observedPowerProvenance: "measured_watts" | "calibrated_watts" | "mixed" | "unavailable";
  observedPower?: PersonalizedPrescriptionObservedPowerV1;
  stableInBandWorkload?: PersonalizedPrescriptionStableInBandWorkloadV1;
  controllerContext: PersonalizedPrescriptionControllerContextV1;
  candidateDomainMargins?: PersonalizedPrescriptionCandidateDomainMarginsV1;
  comparison?: PersonalizedPrescriptionCandidateComparisonV1;
  characterizationOutcome: PersonalizedPrescriptionCharacterizationOutcomeV1;
  exclusionReason?: PersonalizedPrescriptionCharacterizationExclusionReasonV1;
}

export interface PersonalizedPrescriptionCharacterizationV1 {
  schemaVersion: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V1;
  characterizer: {
    id: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1;
    version: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V1;
  };
  mode: "diagnostic";
  activationEligible: false;
  sourceShadow: {
    resolverId: typeof PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1;
    resolverVersion: typeof PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1;
    shadowSchemaVersion: typeof PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1;
    resolvedAt: string;
  };
  athleteId: string;
  workoutSessionId: string;
  workoutSelector: string;
  workoutIntent: string;
  activity: Activity;
  formalAssessmentQuality?: "low" | "moderate" | "high" | "unverified";
  calibrationWorkloadProvenance?: PersonalizedPrescriptionWorkloadProvenanceV1;
  policy: PersonalizedPrescriptionCharacterizationPolicyV1;
  phases: PersonalizedPrescriptionPhaseCharacterizationV1[];
  createdAt: string;
}

export interface PersonalizedPrescriptionFormalAssessmentProvenanceV2 {
  algorithm: {
    id: string;
    version: number;
  };
  protocol: {
    id: string;
    version: number;
  };
}

/** Current E2 record. Provenance is copied from and verified against its immutable E1 source. */
export interface PersonalizedPrescriptionCharacterizationV2
  extends Omit<PersonalizedPrescriptionCharacterizationV1, "schemaVersion" | "characterizer"> {
  schemaVersion: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V2;
  characterizer: {
    id: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1;
    version: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V2;
  };
  formalAssessmentProvenance?: PersonalizedPrescriptionFormalAssessmentProvenanceV2;
}

/**
 * Versioned E2 v3 characterization policy for held-workload forward-response
 * evidence. Every value is a characterization policy value (how evidence is
 * segmented and counted), never a validated universal physiological constant,
 * an activation threshold, a safety threshold, or an E4 pass/fail criterion.
 */
export interface PersonalizedPrescriptionHeldWorkloadPolicyV1 {
  id: "e2-held-workload-forward-response-policy";
  version: 1;
  /**
   * Active seconds after a stable observed-resistance window begins before its
   * HR response contributes forward-prediction error.
   */
  settlingSeconds: number;
  /** Largest active-second step between consecutive fresh observations inside one window. */
  maxObservationGapSec: number;
  /**
   * Largest wall-clock excess over active-clock progress between consecutive
   * observations. The active clock does not advance while paused, so a larger
   * excess is a pause (or clock discontinuity) and breaks the window.
   */
  maxWallClockExcessSec: number;
  /** Qualifying post-settling seconds needed before forward-error statistics are summarized. */
  minQualifyingSeconds: number;
}

/** Frozen E1 forward model copied for durable evaluation: predicted HR = intercept + slope × watts. */
export interface PersonalizedPrescriptionHeldWorkloadForwardModelV1 {
  interceptBpm: number;
  slopeBpmPerWatt: number;
  /** Trustworthy observed watt domain of the frozen calibration. No extrapolation outside it. */
  observedMinWatts: number;
  observedMaxWatts: number;
}

export type PersonalizedPrescriptionHeldWorkloadOutcomeV1 =
  | "characterized"
  | "insufficient_evidence"
  | "not_candidate"
  | "calibration_unavailable"
  | "unsupported_observed_provenance";

export type PersonalizedPrescriptionHeldWorkloadExclusionReasonV1 =
  | "phase_evidence_unavailable"
  | "no_stable_observed_resistance"
  | "insufficient_post_settling_evidence"
  | "unsupported_power_provenance";

export interface PersonalizedPrescriptionDistributionV1 {
  median: number;
  q1: number;
  q3: number;
  min: number;
  max: number;
}

/**
 * Stable observed-resistance segmentation of one phase. Durations are spans on
 * the active clock. Every post-settling second is accounted for exactly once:
 * postSettlingDurationSec = qualifyingDurationSec + sum(excludedPostSettlingSeconds).
 */
export interface PersonalizedPrescriptionStableResistanceSummaryV1 {
  /** Value changes between consecutive continuous fresh observations; changes across gaps/pauses are not counted. */
  observedResistanceChangeCount: number;
  stableWindowCount: number;
  /** Windows contributing at least one qualifying post-settling second. */
  qualifyingWindowCount: number;
  stableDurationSec: number;
  postSettlingDurationSec: number;
  qualifyingDurationSec: number;
  excludedPostSettlingSeconds: {
    /** Tolerated missing active seconds inside a window; never interpolated. */
    observationGap: number;
    wattsUnavailable: number;
    /** Observed watts outside the frozen calibration domain; never clamped or extrapolated. */
    outsideCalibrationDomain: number;
    heartRateUnavailable: number;
  };
}

export interface PersonalizedPrescriptionForwardHeartRateSummaryV1 {
  observedHeartRateMedianBpm: number;
  predictedHeartRateMedianBpm: number;
  /** Signed error = observed HR − predicted HR. Positive: HR higher than the frozen calibration predicts. */
  signedErrorBpm: PersonalizedPrescriptionDistributionV1;
  absoluteErrorBpm: PersonalizedPrescriptionDistributionV1;
}

/**
 * Held-workload forward-response evidence for one phase: observed watts under
 * held observed resistance → frozen E1 calibration → predicted HR, compared
 * with observed HR. Never conditioned on legacy HR-band occupancy or
 * controller success. The controller may have selected the held resistance, so
 * this is not independent or randomized open-loop evidence.
 */
export interface PersonalizedPrescriptionHeldWorkloadForwardResponseV1 {
  outcome: PersonalizedPrescriptionHeldWorkloadOutcomeV1;
  exclusionReason?: PersonalizedPrescriptionHeldWorkloadExclusionReasonV1;
  observedPowerProvenance: "measured_watts" | "calibrated_watts" | "mixed" | "unavailable";
  /** Absent when segmentation was not attempted (no candidate, calibration, or phase evidence). */
  stableResistance?: PersonalizedPrescriptionStableResistanceSummaryV1;
  /** Pooled over every qualifying second of every qualifying window; present only when characterized. */
  forwardHeartRate?: PersonalizedPrescriptionForwardHeartRateSummaryV1;
  /** Descriptive cadence context over qualifying seconds with fresh measured cadence. */
  cadenceRpm?: { observationCount: number; median: number; q1: number; q3: number };
}

export interface PersonalizedPrescriptionPhaseCharacterizationV3 extends PersonalizedPrescriptionPhaseCharacterizationV1 {
  heldWorkloadForwardResponse: PersonalizedPrescriptionHeldWorkloadForwardResponseV1;
}

/**
 * Current E2 record. Closed-loop fields are identical to v2; the v3 delta is
 * held-workload forward-response evidence, its policy, and the frozen forward model.
 */
export interface PersonalizedPrescriptionCharacterizationV3
  extends Omit<PersonalizedPrescriptionCharacterizationV2, "schemaVersion" | "characterizer" | "phases"> {
  schemaVersion: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3;
  characterizer: {
    id: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1;
    version: typeof PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V3;
  };
  heldWorkloadPolicy: PersonalizedPrescriptionHeldWorkloadPolicyV1;
  /** Present exactly when the linked E1 record carries a frozen formal calibration. */
  heldWorkloadForwardModel?: PersonalizedPrescriptionHeldWorkloadForwardModelV1;
  phases: PersonalizedPrescriptionPhaseCharacterizationV3[];
}

export type PersonalizedPrescriptionCharacterization =
  | PersonalizedPrescriptionCharacterizationV1
  | PersonalizedPrescriptionCharacterizationV2
  | PersonalizedPrescriptionCharacterizationV3;
export type CurrentPersonalizedPrescriptionCharacterization = PersonalizedPrescriptionCharacterizationV3;
