/**
 * H2 shadow athlete-specific HR intensity candidate contracts.
 * Shapes and policy identity only; evaluation lives in src/hrIntensityCandidate.ts.
 *
 * Population %HRR guidance is not an individually measured physiological threshold
 * and never grants live prescription authority.
 */
/** Shadow HR intensity candidate algorithm (H2). */
export const HR_INTENSITY_CANDIDATE_ALGORITHM_ID = "hr-intensity-candidate-shadow";
export const HR_INTENSITY_CANDIDATE_ALGORITHM_VERSION = 1;
/**
 * Provisional aerobic-base policy: ACSM moderate-intensity %HRR / %VO₂R band.
 * Source: ACSM Guidelines for Exercise Testing and Prescription intensity
 * classification — moderate = 40%–59% HRR (population exercise-prescription
 * guidance, not an individually measured AeT/VT1/LT).
 */
export const HR_INTENSITY_AEROBIC_BASE_POLICY_ID = "hr-intensity-aerobic-base-hrr-acsm-moderate";
export const HR_INTENSITY_AEROBIC_BASE_POLICY_VERSION = 1;
export const HR_INTENSITY_AEROBIC_BASE_MIN_FRACTION_OF_HRR = 0.4;
export const HR_INTENSITY_AEROBIC_BASE_MAX_FRACTION_OF_HRR = 0.59;
export const HR_INTENSITY_CANDIDATE_AUTHORITY_NOTICE = "Exploratory athlete-specific HR candidates are not active. Workouts continue using their existing BPM targets.";
/**
 * Exploratory candidate generation freshness window (days). Separate from future
 * live-control eligibility; stale resting evidence withholds H2 candidates.
 */
export const HR_INTENSITY_CANDIDATE_EXPLORATORY_FRESHNESS_DAYS = 90;
/** Current aerobic-base shadow policy object (version field is pinned inside). */
export const HR_INTENSITY_AEROBIC_BASE_POLICY = {
    id: "hr-intensity-aerobic-base-hrr-acsm-moderate",
    version: 1,
    intensityId: "aerobic_base",
    requiredPhaseKind: "work",
    minFractionOfHrr: 0.4,
    maxFractionOfHrr: 0.59,
    sourceLabel: "ACSM GETP moderate-intensity %HRR (40–59%)",
    interpretation: "population_exercise_prescription_guidance_not_individual_threshold",
};
