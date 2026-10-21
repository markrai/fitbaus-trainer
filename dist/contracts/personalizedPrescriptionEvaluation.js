/**
 * Personalized prescription shadow-evaluation contract (schema V1). Contract
 * shapes only; resolution logic lives in src/personalizedPrescription.ts.
 */
/**
 * Permanent Phase E1 shadow schema identity.
 * E1 is the canonical shadow athlete-relative mechanical workload prescription
 * derived from formal calibration for supported ordinary-workout phases.
 * It does not personalize the active heart-rate prescription and has no control authority.
 */
export const PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1 = 1;
export const PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1 = "personalized-prescription-resolver";
export const PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1 = 1;
