/**
 * Compatibility facade for the shared application contracts. Each contract
 * family is owned by a module in src/contracts/; existing imports of
 * "./types.js" keep working. Contract modules never import this file.
 */

export {
  WORKOUT_PRESCRIPTION_SCHEMA_VERSION,
  LEGACY_HR_TARGET_RESOLVER_ID,
  LEGACY_HR_TARGET_RESOLVER_VERSION,
  WORKOUT_PRESCRIPTION_RESOLVER_ID,
  WORKOUT_PRESCRIPTION_RESOLVER_VERSION,
} from "./contracts/workoutPrescription.js";
export type {
  DayName,
  PlanBlock,
  Activity,
  WorkoutPhaseKind,
  PhaseIntensityId,
  ResolvedHeartRateTarget,
  ResolvedTargetQuality,
  ResolvedWorkoutPhaseTarget,
  ResolvedWorkoutPrescription,
  WorkoutPhaseState,
  WorkoutMetadata,
  HrIntervalPhase,
  HrIntervalTargets,
  HrTargetsForDay,
  Plan,
  MetadataByDay,
  HrTargetsByDay,
} from "./contracts/workoutPrescription.js";
export {
  PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1,
  PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1,
  PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1,
} from "./contracts/personalizedPrescriptionEvaluation.js";
export type {
  PersonalizedPrescriptionFallbackReasonV1,
  PersonalizedPrescriptionCheckV1,
  PersonalizedPrescriptionSafetyChecksV1,
  PersonalizedPrescriptionProfileSnapshotV1,
  PersonalizedPrescriptionWorkloadProvenanceV1,
  PersonalizedPrescriptionFitnessEvidenceSnapshotV1,
  PersonalizedPrescriptionPolicyV1,
  PersonalizedPrescriptionPhaseEvaluationV1,
  PersonalizedPrescriptionEvaluationV1,
} from "./contracts/personalizedPrescriptionEvaluation.js";
export {
  PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V1,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V2,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V1,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V2,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V3,
  PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION,
} from "./contracts/personalizedPrescriptionCharacterization.js";
export type {
  PersonalizedPrescriptionCharacterizationOutcomeV1,
  PersonalizedPrescriptionCharacterizationExclusionReasonV1,
  PersonalizedPrescriptionCharacterizationPolicyV1,
  PersonalizedPrescriptionEvidenceCoverageV1,
  PersonalizedPrescriptionObservedHeartRateV1,
  PersonalizedPrescriptionObservedPowerV1,
  PersonalizedPrescriptionStableInBandWorkloadV1,
  PersonalizedPrescriptionResistanceCoverageV1,
  PersonalizedPrescriptionControllerContextV1,
  PersonalizedPrescriptionCandidateDomainMarginsV1,
  PersonalizedPrescriptionCandidateComparisonV1,
  PersonalizedPrescriptionPhaseCharacterizationV1,
  PersonalizedPrescriptionCharacterizationV1,
  PersonalizedPrescriptionFormalAssessmentProvenanceV2,
  PersonalizedPrescriptionCharacterizationV2,
  PersonalizedPrescriptionHeldWorkloadPolicyV1,
  PersonalizedPrescriptionHeldWorkloadForwardModelV1,
  PersonalizedPrescriptionHeldWorkloadOutcomeV1,
  PersonalizedPrescriptionHeldWorkloadExclusionReasonV1,
  PersonalizedPrescriptionDistributionV1,
  PersonalizedPrescriptionStableResistanceSummaryV1,
  PersonalizedPrescriptionForwardHeartRateSummaryV1,
  PersonalizedPrescriptionHeldWorkloadForwardResponseV1,
  PersonalizedPrescriptionPhaseCharacterizationV3,
  PersonalizedPrescriptionCharacterizationV3,
  PersonalizedPrescriptionCharacterization,
  CurrentPersonalizedPrescriptionCharacterization,
} from "./contracts/personalizedPrescriptionCharacterization.js";
export {
  ATHLETE_PROFILE_SCHEMA_VERSION_V1,
  ATHLETE_PROFILE_SCHEMA_VERSION,
} from "./contracts/athlete.js";
export type {
  Profile,
  AthleteProfile,
  AthleteIdentity,
} from "./contracts/athlete.js";
export {
  FITNESS_STATE_SCHEMA_VERSION_V1,
  FITNESS_STATE_SCHEMA_VERSION_V2,
  FITNESS_STATE_SCHEMA_VERSION_V3,
  FITNESS_STATE_SCHEMA_VERSION,
} from "./contracts/fitnessState.js";
export type {
  HrWorkloadCalibrationPoint,
  HrWorkloadCalibration,
  PredictedMaxWattsMetric,
  PassiveAerobicIntensityId,
  PassiveAerobicTrend,
  PassiveEvidenceDigest,
  PassiveEvidenceSummary,
  PassiveAerobicObservation,
  PassiveAerobicObservationMetric,
  FitnessState,
  AthleteFitnessSnapshot,
} from "./contracts/fitnessState.js";
export type {
  FitnessMetricSource,
  FitnessMetricQuality,
  FitnessMetric,
} from "./contracts/fitnessMetric.js";
export {
  ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
  ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION,
} from "./contracts/telemetry.js";
export type {
  HrSample,
  OrdinaryBikeTelemetryAvailability,
  BikeWattsProvenance,
  OrdinaryBikeTelemetrySampleV1,
  OrdinaryBikeTelemetrySample,
  CurrentOrdinaryBikeTelemetrySample,
} from "./contracts/telemetry.js";
export {
  WORKOUT_RESPONSE_SCHEMA_VERSION_V1,
  WORKOUT_RESPONSE_SCHEMA_VERSION,
} from "./contracts/workoutResponse.js";
export type {
  WorkoutResponseScalarSummary,
  WorkoutPhaseResponse,
  WorkoutResponseV1,
  WorkoutResponse,
  CurrentWorkoutResponse,
  ZoneMinutes,
} from "./contracts/workoutResponse.js";
export {
  VO2_EVIDENCE_SCHEMA_VERSION_V1,
  VO2_EVIDENCE_SCHEMA_VERSION_V2,
  VO2_EVIDENCE_SCHEMA_VERSION,
  LEGACY_VO2_PROTOCOL_ID,
  LEGACY_VO2_PROTOCOL_VERSION_V1,
  LEGACY_VO2_PROTOCOL_VERSION,
  VO2_PROTOCOL_VERSION_V2,
  VO2_PROTOCOL_VERSION_V3,
  VO2_PROTOCOL_ID,
  VO2_PROTOCOL_VERSION,
} from "./contracts/vo2Evidence.js";
export type {
  Vo2EvidencePhasePrescription,
  Vo2EvidencePhase,
  Vo2EvidenceHr,
  Vo2EvidenceMachine,
  Vo2ProtocolId,
  Vo2ProtocolVersion,
  Vo2ProtocolStageStatus,
  Vo2ProtocolTerminationReasonV1,
  Vo2ProtocolTerminationReasonV2,
  Vo2ProtocolTerminationReasonV3,
  Vo2ProtocolTerminationReason,
  Vo2ProtocolStageHrEvidence,
  Vo2AdaptiveDecisionReasonCode,
  Vo2AdaptiveStageProvenance,
  Vo2AdaptiveTerminationProvenance,
  Vo2ProtocolStageEvidence,
  Vo2ProtocolEvidenceV1,
  Vo2ProtocolEvidenceV2,
  Vo2ProtocolEvidenceV3,
  Vo2ProtocolEvidence,
  CurrentVo2ProtocolEvidence,
  AdaptiveVo2ProtocolEvidence,
  Vo2EvidenceV1,
  Vo2EvidenceV2,
  Vo2Evidence,
  CurrentVo2Evidence,
  Vo2WorkloadSource,
  Vo2ProtocolStageWorkloadEvidence,
} from "./contracts/vo2Evidence.js";
export {
  VO2_ASSESSMENT_SCHEMA_VERSION_V1,
  VO2_ASSESSMENT_SCHEMA_VERSION_V2,
  VO2_ASSESSMENT_SCHEMA_VERSION,
} from "./contracts/vo2Assessment.js";
export type {
  Vo2AssessmentStatus,
  Vo2AssessmentReasonCodeV1,
  Vo2AssessmentReasonCodeV2,
  Vo2AssessmentReasonCode,
  Vo2AssessmentFitQuality,
  Vo2AssessmentPointV1,
  Vo2AssessmentPointV2,
  Vo2AssessmentPoint,
  CurrentVo2AssessmentPoint,
  Vo2AssessmentInputSnapshot,
  Vo2AssessmentDiagnosticsV1,
  Vo2AssessmentDiagnosticsV2,
  Vo2AssessmentDiagnostics,
  CurrentVo2AssessmentDiagnostics,
  Vo2AssessmentResultV1,
  Vo2AssessmentResultV2,
  Vo2AssessmentResult,
  CurrentVo2AssessmentResult,
} from "./contracts/vo2Assessment.js";
export type {
  WorkoutSummary,
} from "./contracts/workoutSummary.js";
export {
  WORKOUT_EXECUTION_PROVENANCE_SCHEMA_VERSION_V1,
  FORMAL_CALIBRATION_MACHINE_PROVENANCE_SCHEMA_VERSION_V1,
} from "./contracts/executionProvenance.js";
export type {
  FrozenMachineIdentityV1,
  WorkoutMachineProvenanceV1,
  FormalCalibrationInstanceIdentityV1,
  FormalCalibrationMachineProvenanceV1,
  WorkoutCalibrationMachineProvenanceV1,
  ResistanceActuationOriginV1,
  ResistanceActuationTriggerV1,
  ResistanceActuationOutcomeV1,
  ResistanceActuationEventV1,
  PhaseActuationModeV1,
  PhaseActuationSummaryV1,
  WorkoutActuationProvenanceV1,
  WorkoutExecutionProvenanceV1,
} from "./contracts/executionProvenance.js";
export type {
  SisuSettings,
} from "./contracts/sisuSync.js";
