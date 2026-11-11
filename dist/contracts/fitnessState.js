/**
 * Stored FitnessState shape, its schema versions, and its evidence sub-shapes.
 * Contract shapes only; algorithms live in src/fitnessState.ts and
 * src/fitnessRefinement.ts.
 */
/** Permanent historical schema identities. Readers must not key old data to current aliases. */
export const FITNESS_STATE_SCHEMA_VERSION_V1 = 1;
export const FITNESS_STATE_SCHEMA_VERSION_V2 = 2;
export const FITNESS_STATE_SCHEMA_VERSION_V3 = 3;
export const FITNESS_STATE_SCHEMA_VERSION_V4 = 4;
export const FITNESS_STATE_SCHEMA_VERSION = FITNESS_STATE_SCHEMA_VERSION_V4;
export const RESTING_HR_SESSION_ALGORITHM_ID = "resting-hr-session";
export const RESTING_HR_SESSION_ALGORITHM_VERSION = 1;
export const RESTING_HR_SESSION_HISTORY_CAP = 8;
export const RESTING_HR_SESSION_TOTAL_DURATION_SEC = 300;
export const RESTING_HR_SESSION_SETTLE_DURATION_SEC = 90;
export const RESTING_HR_SESSION_OBSERVATION_DURATION_SEC = 210;
export const RESTING_HR_SESSION_MIN_BPM = 35;
export const RESTING_HR_SESSION_MAX_BPM = 110;
