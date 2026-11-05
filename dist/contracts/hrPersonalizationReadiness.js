/**
 * Diagnostic-only HR personalization readiness / exploratory %HRR contracts.
 * Shapes only; evaluation lives in src/hrPersonalizationReadiness.ts.
 */
/**
 * Provisional engineering freshness window for exploratory reporting only.
 * Measurements older than this are labeled stale for exploration; the label
 * does not grant or deny prescription eligibility (always ineligible today).
 */
export const HR_PERSONALIZATION_PROVISIONAL_FRESHNESS_DAYS = 90;
export const HR_PERSONALIZATION_READINESS_ALGORITHM_ID = "hr-personalization-readiness";
export const HR_PERSONALIZATION_READINESS_ALGORITHM_VERSION = 1;
export const HR_PERSONALIZATION_AUTHORITY_NOTICE = "Personalized HR targets are not active. Current workouts still use their existing BPM prescriptions.";
