export const WORKOUT_PRESCRIPTION_SCHEMA_VERSION = 1;
/** Permanent identity for the Phase A resolver; keep readable after newer resolvers ship. */
export const LEGACY_HR_TARGET_RESOLVER_ID = "legacy-hr-target-resolver";
export const LEGACY_HR_TARGET_RESOLVER_VERSION = 1;
/** Resolver used for new resolutions in this build. */
export const WORKOUT_PRESCRIPTION_RESOLVER_ID = LEGACY_HR_TARGET_RESOLVER_ID;
export const WORKOUT_PRESCRIPTION_RESOLVER_VERSION = LEGACY_HR_TARGET_RESOLVER_VERSION;
/**
 * Permanent Phase E1 shadow schema identity.
 * E1 is the canonical shadow athlete-relative mechanical workload prescription
 * derived from formal calibration for supported ordinary-workout phases.
 * It does not personalize the active heart-rate prescription and has no control authority.
 */
export const PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1 = 1;
export const PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1 = "personalized-prescription-resolver";
export const PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1 = 1;
/** Permanent Phase E2 diagnostic schema. This record has no control authority. */
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V1 = 1;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V2 = 2;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3 = 3;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION = PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1 = "personalized-prescription-characterization";
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V1 = 1;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V2 = 2;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V3 = 3;
export const PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION = PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V3;
/** Permanent historical schema identities. Readers must not key old data to current aliases. */
export const ATHLETE_PROFILE_SCHEMA_VERSION_V1 = 1;
export const FITNESS_STATE_SCHEMA_VERSION_V1 = 1;
export const FITNESS_STATE_SCHEMA_VERSION_V2 = 2;
export const FITNESS_STATE_SCHEMA_VERSION_V3 = 3;
export const ATHLETE_PROFILE_SCHEMA_VERSION = ATHLETE_PROFILE_SCHEMA_VERSION_V1;
export const FITNESS_STATE_SCHEMA_VERSION = FITNESS_STATE_SCHEMA_VERSION_V3;
/** Permanent historical schema identities for Phase C evidence. */
export const ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1 = 1;
export const ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION = ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1;
export const WORKOUT_RESPONSE_SCHEMA_VERSION_V1 = 1;
export const WORKOUT_RESPONSE_SCHEMA_VERSION = WORKOUT_RESPONSE_SCHEMA_VERSION_V1;
/** Local evidence for the VO2 estimator. Not itself a VO2 result. */
export const VO2_EVIDENCE_SCHEMA_VERSION_V1 = 1;
export const VO2_ASSESSMENT_SCHEMA_VERSION_V1 = 1;
export const VO2_EVIDENCE_SCHEMA_VERSION_V2 = 2;
export const VO2_ASSESSMENT_SCHEMA_VERSION_V2 = 2;
/** Writer aliases. Historical readers must use the explicit V1 constants above. */
export const VO2_EVIDENCE_SCHEMA_VERSION = VO2_EVIDENCE_SCHEMA_VERSION_V2;
export const VO2_ASSESSMENT_SCHEMA_VERSION = VO2_ASSESSMENT_SCHEMA_VERSION_V2;
/** Permanent historical identity for the v1 protocol; keep readable after newer protocols ship. */
export const LEGACY_VO2_PROTOCOL_ID = "bike-submax-70rpm";
export const LEGACY_VO2_PROTOCOL_VERSION_V1 = 1;
/** Backward-compatible name for the permanent historical protocol identity. */
export const LEGACY_VO2_PROTOCOL_VERSION = LEGACY_VO2_PROTOCOL_VERSION_V1;
export const VO2_PROTOCOL_VERSION_V2 = 2;
export const VO2_PROTOCOL_VERSION_V3 = 3;
/** Protocol identity shared by formal assessments. New athlete-started sessions write v3; v2 remains the reader for historical evidence. */
export const VO2_PROTOCOL_ID = LEGACY_VO2_PROTOCOL_ID;
/** v2 marker used by the v2 reader/validators. Do not point at v3: v2 validation depends on this staying 2. */
export const VO2_PROTOCOL_VERSION = VO2_PROTOCOL_VERSION_V2;
/** Permanent execution-provenance schema identity. */
export const WORKOUT_EXECUTION_PROVENANCE_SCHEMA_VERSION_V1 = 1;
export const FORMAL_CALIBRATION_MACHINE_PROVENANCE_SCHEMA_VERSION_V1 = 1;
