/**
 * Frozen migration bundle schema v1 contract (historical, migration-owned):
 * legacy source identity, bundle store list and key paths, legacy
 * localStorage allowlist/classification, bundle shape, and MigrationError.
 * Never derived from the current schema; the current destination identity
 * lives in src/persistence/ and only constrains these values one way.
 */

import type { CurrentStoreName } from "../persistence/currentSchema.js";
import type { DurableLocalStorageKey } from "../persistence/localStorageKeys.js";

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
] as const satisfies readonly CurrentStoreName[];
export type MigrationStoreName = (typeof MIGRATION_STORE_NAMES)[number];

export const STORE_KEY_PATHS: Record<MigrationStoreName, string | string[]> = {
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
} as const satisfies Readonly<Record<string, DurableLocalStorageKey>>;
export const LEGACY_KEY_RENAMES: Readonly<Record<string, string>> = LEGACY_KEY_RENAME_TABLE;

/** Durable keys whose canonical name did not change. */
export const UNCHANGED_DURABLE_KEYS: ReadonlySet<string> = new Set([
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

const TRANSIENT_EXACT_KEYS: ReadonlySet<string> = new Set([
  "installPromptShown",
  "enableServiceWorkerDev",
  "updateApplied",
]);

/** Per-day / per-session transient key prefixes (active workout state). */
export const TRANSIENT_KEY_PREFIXES: readonly string[] = [
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

export type LocalKeyClassification =
  | "MIGRATE_EXACTLY"
  | "MIGRATE_WITH_KEY_RENAME"
  | "TRANSIENT_DO_NOT_MIGRATE"
  | "UNKNOWN_REQUIRES_REVIEW";

export function classifyLegacyLocalStorageKey(key: string): LocalKeyClassification {
  if (Object.prototype.hasOwnProperty.call(LEGACY_KEY_RENAMES, key)) return "MIGRATE_WITH_KEY_RENAME";
  if (UNCHANGED_DURABLE_KEYS.has(key)) return "MIGRATE_EXACTLY";
  if (TRANSIENT_EXACT_KEYS.has(key)) return "TRANSIENT_DO_NOT_MIGRATE";
  if (TRANSIENT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return "TRANSIENT_DO_NOT_MIGRATE";
  return "UNKNOWN_REQUIRES_REVIEW";
}

export function destinationKeyForLegacyKey(key: string): string | null {
  const classification = classifyLegacyLocalStorageKey(key);
  if (classification === "MIGRATE_WITH_KEY_RENAME") return LEGACY_KEY_RENAMES[key];
  if (classification === "MIGRATE_EXACTLY") return key;
  return null;
}

export class MigrationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface MigrationStoreEntry {
  key: unknown;
  value: Record<string, unknown>;
}

export interface MigrationLocalStorageEntry {
  source_key: string;
  destination_key: string;
  classification: "MIGRATE_EXACTLY" | "MIGRATE_WITH_KEY_RENAME";
  /** Exact stored string from the legacy app. Never reserialized. */
  value: string;
}

export interface MigrationBundle {
  format: typeof MIGRATION_FORMAT;
  schema_version: typeof MIGRATION_SCHEMA_VERSION;
  exported_at: string;
  source: {
    package_id: typeof LEGACY_PACKAGE_ID;
    app_version: string | null;
    indexeddb_name: typeof LEGACY_DB_NAME;
    indexeddb_version: number | null;
    store_names: string[];
  };
  indexeddb: { stores: Record<MigrationStoreName, MigrationStoreEntry[]> };
  local_storage: MigrationLocalStorageEntry[];
  excluded_local_keys: { key: string; classification: string }[];
  /** Undefined-valued legacy properties normalized to absent (reported, not silent). */
  undefined_properties_dropped: number;
  unknown_local_keys: { key: string; value_sha256: string }[];
  unknown_stores: { name: string; record_count: number }[];
  manifest: {
    store_counts: Record<MigrationStoreName, number>;
    local_storage_count: number;
    section_digests: { indexeddb: string; local_storage: string };
    /** Deterministic per-store digests over each store's sorted entries. */
    store_digests: Record<MigrationStoreName, string>;
    bundle_digest: string;
  };
}
