/**
 * Athlete identity, the versioned athlete profile, and the legacy compatibility
 * profile. These are deliberately separate stored shapes.
 */
/** Permanent historical schema identities. Readers must not key old data to current aliases. */
export const ATHLETE_PROFILE_SCHEMA_VERSION_V1 = 1;
export const ATHLETE_PROFILE_SCHEMA_VERSION = ATHLETE_PROFILE_SCHEMA_VERSION_V1;
