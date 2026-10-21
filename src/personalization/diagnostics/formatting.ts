/**
 * Deterministic diagnostics text formatting: value labels and number, ratio,
 * band and percentage formats. No HTML and no DOM.
 */

const LABELS: Record<string, string> = {
  measured_watts: "Measured watts",
  calibrated_at_verified_cadence: "Cadence-calibrated watts",
  calibrated_watts: "Calibrated watts",
  mixed: "Mixed",
  unavailable: "Unavailable",
  unspecified: "Unspecified",
  not_applicable: "Not applicable",
  multiple_threshold_phases: "Multiple characterized threshold phases",
  incomplete_calibration_identity: "Incomplete formal calibration identity",
  missing_machine_identity: "Missing historical machine identity",
  missing_machine_profile_identity: "Missing historical machine-profile identity",
  invalid_longitudinal_metrics: "Invalid longitudinal metrics",
  aerobic_base: "Aerobic base",
  aerobic_volume: "Aerobic volume",
  inside_candidate: "Inside candidate",
  below_candidate: "Below candidate",
  above_candidate: "Above candidate",
  not_available: "Not available",
  characterized: "Characterized",
  insufficient_evidence: "Insufficient evidence",
  not_candidate: "No candidate",
  unsupported_observed_provenance: "Unsupported observed provenance",
  telemetry_unavailable: "Telemetry unavailable",
  phase_too_short: "Phase too short",
  missing_telemetry: "Missing telemetry",
  insufficient_hr_coverage: "Insufficient HR coverage",
  insufficient_power_coverage: "Insufficient power coverage",
  insufficient_joint_coverage: "Insufficient joint coverage",
  insufficient_settled_in_band_evidence: "Insufficient settled in-target evidence",
  unsupported_power_provenance: "Unsupported or mixed power source",
  phase_evidence_unavailable: "Phase evidence unavailable",
  calibration_unavailable: "Frozen calibration unavailable",
  automatic_hr_control: "Automatic HR control",
  learned_starting_resistance: "Learned starting resistance",
  default_starting_resistance: "Default starting resistance",
  controller_carryover: "Controller carry-over",
  scripted_phase_program: "Scripted phase program",
  vo2_protocol_fixed_resistance: "VO₂ protocol fixed resistance",
  unclassified: "Unclassified",
  decision: "Decision",
  reconciliation_resend: "Re-send of current decision",
  complete: "Complete",
  incomplete: "Incomplete",
  no_frozen_calibration: "No frozen calibration",
  integrity_failure: "Conflicting provenance records",
  same_machine_and_profile: "Same machine and profile",
  different_machine: "Different machine",
  execution_provenance_unavailable: "Execution provenance unavailable",
  workout_machine_unavailable: "Workout machine unavailable",
  workout_machine_selection_changed: "Workout machine selection changed",
  calibration_machine_unavailable: "Calibration machine unavailable",
  calibration_machine_integrity_failure: "Conflicting calibration machine records",
  calibration_identity_mismatch: "Calibration identity mismatch",
  raw_telemetry_unavailable: "Raw telemetry unavailable",
  reconstruction_mismatch: "Raw telemetry does not reproduce E2",
  same_machine_different_profile: "Same machine, different profile",
  no_stable_observed_resistance: "No stable observed resistance",
  insufficient_post_settling_evidence: "Insufficient post-settling evidence",
  edge: "Edge",
  interior: "Interior",
  high: "High",
  moderate: "Moderate",
  low: "Low",
  unverified: "Unverified",
};

export function personalizationDiagnosticLabel(value: string): string {
  return LABELS[value] ?? value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
export function percent(value: number | undefined): string {
  return value === undefined ? "n/a" : `${Math.round(value * 100)}%`;
}
export function formatSigned(value: number | undefined, suffix: string): string {
  if (value === undefined) return "n/a";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}${suffix}`;
}

export function formatRatio(value: number | undefined | null): string {
  if (value === undefined || value === null) return "n/a";
  return String(Math.round(value * 100) / 100);
}
export const ACTUATION_MODE_LABELS: Record<string, string> = {
  automatic: "Automatic",
  programmatic: "Programmatic only",
  none: "No app resistance commands",
  unknown: "Unknown",
};

export function machineLabel(identity: { machineId: string; machineProfileVersion: number }): string {
  return `${identity.machineId} / profile ${identity.machineProfileVersion}`;
}
export const HELD_CONTEXT_LABELS: Record<string, string> = {
  automatic_selected: "Controller-context evidence (automatic-selected)",
  programmatic_selected: "Programmatic-context evidence",
  no_app_selector_observed: "No captured app selector",
  unknown: "Unknown",
};
export function formatBoundHeartRate(target: { min?: number; max?: number } | undefined): string {
  if (target?.min === undefined || target?.max === undefined) return "unavailable";
  return `${target.min}–${target.max} bpm`;
}

export function formatWattsBand(power: { minWatts?: number; maxWatts?: number } | undefined): string {
  if (power?.minWatts === undefined || power?.maxWatts === undefined) return "unavailable";
  return `${power.minWatts}–${power.maxWatts} W`;
}

export function formatOptionalWatts(value: number | undefined): string {
  return value === undefined ? "unavailable" : `${formatOptionalNumber(value)} W`;
}

export function formatOptionalRpm(value: number | undefined): string {
  return value === undefined ? "unavailable" : `${formatOptionalNumber(value)} rpm`;
}

export function formatOptionalNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

export function formatOptionalPercent(value: number | undefined): string {
  return value === undefined ? "unavailable" : percent(value);
}
