/**
 * Frozen migration bundle schema v1 contract (historical, migration-owned):
 * legacy source identity, bundle store list and key paths, legacy
 * localStorage allowlist/classification, bundle shape, and MigrationError.
 * Never derived from the current schema; the current destination identity
 * lives in src/persistence/ and only constrains these values one way.
 */
export const MIGRATION_FORMAT = "fitbaus-trainer-migration";
export const MIGRATION_SCHEMA_VERSION = 1;
export const LEGACY_PACKAGE_ID = "com.markrai.sisutrainer";
export const LEGACY_DB_NAME = "vo2_workout_db";
/** Bundle schema v1 store list (frozen). Each must also be a current destination store. */
export const MIGRATION_STORE_NAMES = [
    "workouts",
    "hr_samples",
    "ordinary_bike_telemetry",
    "sisu_settings",
];
export const STORE_KEY_PATHS = {
    workouts: "session_id",
    hr_samples: ["session_id", "timestamp_sec"],
    ordinary_bike_telemetry: ["session_id", "active_sec"],
    sisu_settings: "key",
};
/**
 * Explicit allowlisted renames. No generic prefix substitution, ever.
 * Destinations must be current durable keys (checked at compile time).
 */
const LEGACY_KEY_RENAME_TABLE = {
    sisu_trainer_equipment_selection: "fitbaus_trainer_equipment_selection",
    sisu_trainer_bike_bridge: "fitbaus_trainer_bike_bridge",
    sisu_trainer_machine_learning: "fitbaus_trainer_machine_learning",
    sisu_trainer_hr_dynamics: "fitbaus_trainer_hr_dynamics",
    sisu_trainer_shadow_resistance_predictions: "fitbaus_trainer_shadow_resistance_predictions",
};
export const LEGACY_KEY_RENAMES = LEGACY_KEY_RENAME_TABLE;
/** Durable keys whose canonical name did not change. */
export const UNCHANGED_DURABLE_KEYS = new Set([
    "athlete_identity_v1",
    "athlete_profile_v1",
    "profile",
    "fitness_state_v1",
    "formal_calibration_machine_provenance_v1",
    "downregulationParticleSizeScale",
    "downregulationParticleStyle",
    "downregulationNoiseEntropyMinBpm",
    "downregulationSoundStyle",
    "showSecondsCountdown",
    "voicePromptsEnabled",
    "bleDebug",
]);
const TRANSIENT_EXACT_KEYS = new Set([
    "installPromptShown",
    "enableServiceWorkerDev",
    "updateApplied",
]);
/** Per-day / per-session transient key prefixes (active workout state). */
export const TRANSIENT_KEY_PREFIXES = [
    "start_",
    "session_id_",
    "session_start_",
    "summary_emitted_",
    "paused_",
    "paused_elapsed_",
    "paused_duration_",
    "pause_wall_start_",
    "early_cooldown_elapsed_",
    "activity_",
    "phase_plan_",
    "athlete_id_",
    "athlete_fitness_snapshot_",
    "vo2_protocol_runtime_",
    "vo2_protocol_plan_",
    "execution_provenance_",
    "session_control_mode_v1_",
    "bike_telemetry_",
];
export function classifyLegacyLocalStorageKey(key) {
    if (Object.prototype.hasOwnProperty.call(LEGACY_KEY_RENAMES, key))
        return "MIGRATE_WITH_KEY_RENAME";
    if (UNCHANGED_DURABLE_KEYS.has(key))
        return "MIGRATE_EXACTLY";
    if (TRANSIENT_EXACT_KEYS.has(key))
        return "TRANSIENT_DO_NOT_MIGRATE";
    if (TRANSIENT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)))
        return "TRANSIENT_DO_NOT_MIGRATE";
    return "UNKNOWN_REQUIRES_REVIEW";
}
export function destinationKeyForLegacyKey(key) {
    const classification = classifyLegacyLocalStorageKey(key);
    if (classification === "MIGRATE_WITH_KEY_RENAME")
        return LEGACY_KEY_RENAMES[key];
    if (classification === "MIGRATE_EXACTLY")
        return key;
    return null;
}
export class MigrationError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
