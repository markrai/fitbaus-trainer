/**
 * Personalization diagnostics data model: filters, presentation rows, summary
 * shapes, the diagnostics view model, frozen diagnostic contexts, and the E3
 * threshold longitudinal output shapes. Plain data; no DOM, no behavior.
 */
export const PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS = [
    "phase_too_short",
    "missing_telemetry",
    "insufficient_hr_coverage",
    "insufficient_power_coverage",
    "insufficient_joint_coverage",
    "insufficient_settled_in_band_evidence",
    "unsupported_power_provenance",
    "phase_evidence_unavailable",
];
export const EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS = {
    workoutIntent: "all",
    intensity: "all",
    calibrationProvenance: "all",
    observedPowerProvenance: "all",
    assessmentQuality: "all",
    domainBucket: "all",
};
