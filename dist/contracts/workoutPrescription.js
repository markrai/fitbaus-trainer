/**
 * Workout plan and prescription contracts: plan primitives (day, activity,
 * phase), the legacy HR-target resolver identity, resolved prescriptions, and
 * per-day HR target and metadata shapes.
 */
export const WORKOUT_PRESCRIPTION_SCHEMA_VERSION = 1;
/** Permanent identity for the Phase A resolver; keep readable after newer resolvers ship. */
export const LEGACY_HR_TARGET_RESOLVER_ID = "legacy-hr-target-resolver";
export const LEGACY_HR_TARGET_RESOLVER_VERSION = 1;
/** Resolver used for new resolutions in this build. */
export const WORKOUT_PRESCRIPTION_RESOLVER_ID = LEGACY_HR_TARGET_RESOLVER_ID;
export const WORKOUT_PRESCRIPTION_RESOLVER_VERSION = LEGACY_HR_TARGET_RESOLVER_VERSION;
