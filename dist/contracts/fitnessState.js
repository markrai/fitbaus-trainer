/**
 * Stored FitnessState shape, its schema versions, and its evidence sub-shapes.
 * Contract shapes only; algorithms live in src/fitnessState.ts and
 * src/fitnessRefinement.ts.
 */
/** Permanent historical schema identities. Readers must not key old data to current aliases. */
export const FITNESS_STATE_SCHEMA_VERSION_V1 = 1;
export const FITNESS_STATE_SCHEMA_VERSION_V2 = 2;
export const FITNESS_STATE_SCHEMA_VERSION_V3 = 3;
export const FITNESS_STATE_SCHEMA_VERSION = FITNESS_STATE_SCHEMA_VERSION_V3;
