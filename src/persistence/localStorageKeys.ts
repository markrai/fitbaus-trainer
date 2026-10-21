/**
 * Canonical CURRENT FitBaus Trainer localStorage key registry.
 *
 * Answers "what localStorage state does this version of FitBaus Trainer
 * own?". It is deliberately separate from the legacy migration contract in
 * migration/contracts.ts, which answers "what legacy state may be transported?".
 *
 * Keys are listed explicitly; there is no generic prefix rule. Per-day /
 * per-session keys are modelled as explicit patterns, never as concrete
 * instances, and are never durable.
 */

export type PersistenceClass =
  | "DURABLE"
  | "DERIVED_DURABLE"
  | "TRANSIENT_SESSION"
  | "MIGRATION_ONLY"
  | "CACHE_OR_EPHEMERAL";

/** Durable state owned by the current app. Values are persisted key names and must never change. */
export const DURABLE_LOCAL_STORAGE_KEYS = {
  athleteIdentity: "athlete_identity_v1",
  athleteProfile: "athlete_profile_v1",
  /** Compatibility mirror written on profile save; canonical reads prefer athleteProfile. */
  legacyProfileMirror: "profile",
  fitnessState: "fitness_state_v1",
  formalCalibrationMachineProvenance: "formal_calibration_machine_provenance_v1",
  equipmentSelection: "fitbaus_trainer_equipment_selection",
  bikeBridge: "fitbaus_trainer_bike_bridge",
  machineLearning: "fitbaus_trainer_machine_learning",
  hrDynamics: "fitbaus_trainer_hr_dynamics",
  shadowResistancePredictions: "fitbaus_trainer_shadow_resistance_predictions",
  downregulationParticleSizeScale: "downregulationParticleSizeScale",
  downregulationParticleStyle: "downregulationParticleStyle",
  downregulationNoiseEntropyMinBpm: "downregulationNoiseEntropyMinBpm",
  downregulationSoundStyle: "downregulationSoundStyle",
  showSecondsCountdown: "showSecondsCountdown",
  voicePromptsEnabled: "voicePromptsEnabled",
  bleDebug: "bleDebug",
} as const;
export type DurableLocalStorageKeyName = keyof typeof DURABLE_LOCAL_STORAGE_KEYS;
export type DurableLocalStorageKey = (typeof DURABLE_LOCAL_STORAGE_KEYS)[DurableLocalStorageKeyName];

/** Written only by the legacy data migration importer; durable once written. */
export const MIGRATION_LOCAL_STORAGE_KEYS = {
  migrationReceipt: "fitbaus_trainer_migration_receipt_v1",
} as const;

/** Safe-to-lose bookkeeping and developer toggles. */
export const EPHEMERAL_LOCAL_STORAGE_KEYS = {
  installPromptShown: "installPromptShown",
  enableServiceWorkerDev: "enableServiceWorkerDev",
} as const;

export interface LocalKeyContract {
  readonly persistence: PersistenceClass;
  readonly owner: string;
}

export const DURABLE_LOCAL_KEY_CONTRACTS: Readonly<Record<DurableLocalStorageKeyName, LocalKeyContract>> = Object.freeze({
  athleteIdentity: { persistence: "DURABLE", owner: "profile" },
  athleteProfile: { persistence: "DURABLE", owner: "profile" },
  legacyProfileMirror: { persistence: "DERIVED_DURABLE", owner: "profile" },
  fitnessState: { persistence: "DURABLE", owner: "fitnessState" },
  formalCalibrationMachineProvenance: { persistence: "DURABLE", owner: "calibrationMachineProvenance" },
  equipmentSelection: { persistence: "DURABLE", owner: "machines/selection" },
  bikeBridge: { persistence: "DURABLE", owner: "platform/bikeBridgeConfig" },
  machineLearning: { persistence: "DERIVED_DURABLE", owner: "machines/learning" },
  hrDynamics: { persistence: "DERIVED_DURABLE", owner: "machines/dynamics" },
  shadowResistancePredictions: { persistence: "DERIVED_DURABLE", owner: "machines/prediction" },
  downregulationParticleSizeScale: { persistence: "DURABLE", owner: "downregulation/renderer" },
  downregulationParticleStyle: { persistence: "DURABLE", owner: "downregulation/renderer" },
  downregulationNoiseEntropyMinBpm: { persistence: "DURABLE", owner: "downregulation/renderer" },
  downregulationSoundStyle: { persistence: "DURABLE", owner: "downregulation/calmAudio" },
  showSecondsCountdown: { persistence: "DURABLE", owner: "uiControls" },
  voicePromptsEnabled: { persistence: "DURABLE", owner: "uiControls" },
  bleDebug: { persistence: "DURABLE", owner: "hrMonitor" },
});

export interface LocalKeyPatternContract {
  readonly prefix: string;
  /** What the dynamic suffix identifies. */
  readonly suffix: "day" | "session_id";
  readonly persistence: "TRANSIENT_SESSION";
  readonly owner: string;
}

/** Per-day / per-session active-workout state. Never durable, never migrated. */
export const TRANSIENT_LOCAL_KEY_PATTERNS: readonly LocalKeyPatternContract[] = Object.freeze(
  (
    [
      ["start_", "day", "sessionStore"],
      ["session_id_", "day", "sessionStore"],
      ["session_start_", "day", "sessionStore"],
      ["summary_emitted_", "day", "sessionStore"],
      ["paused_", "day", "sessionStore"],
      ["paused_elapsed_", "day", "sessionStore"],
      ["paused_duration_", "day", "sessionStore"],
      ["pause_wall_start_", "day", "sessionStore"],
      ["early_cooldown_elapsed_", "day", "sessionStore"],
      ["activity_", "day", "sessionStore"],
      ["phase_plan_", "day", "sessionStore"],
      ["athlete_id_", "day", "sessionStore"],
      ["athlete_fitness_snapshot_", "day", "sessionStore"],
      ["vo2_protocol_runtime_", "day", "sessionStore"],
      // Retired; current code only removes it.
      ["vo2_protocol_plan_", "day", "sessionStore"],
      ["execution_provenance_", "day", "executionProvenance"],
      ["session_control_mode_v1_", "day", "sessionControlMode"],
      ["bike_telemetry_", "session_id", "bikeTelemetryTrace"],
    ] as const
  ).map(([prefix, suffix, owner]) =>
    Object.freeze({ prefix, suffix, persistence: "TRANSIENT_SESSION" as const, owner })
  )
);

const DURABLE_KEY_SET: ReadonlySet<string> = new Set(Object.values(DURABLE_LOCAL_STORAGE_KEYS));

export function isCurrentDurableLocalStorageKey(key: string): key is DurableLocalStorageKey {
  return DURABLE_KEY_SET.has(key);
}

/** Classify a current localStorage key; null means the current app does not own it. */
export function classifyCurrentLocalStorageKey(key: string): PersistenceClass | null {
  for (const name of Object.keys(DURABLE_LOCAL_STORAGE_KEYS) as DurableLocalStorageKeyName[]) {
    if (DURABLE_LOCAL_STORAGE_KEYS[name] === key) return DURABLE_LOCAL_KEY_CONTRACTS[name].persistence;
  }
  if ((Object.values(MIGRATION_LOCAL_STORAGE_KEYS) as string[]).includes(key)) return "MIGRATION_ONLY";
  if ((Object.values(EPHEMERAL_LOCAL_STORAGE_KEYS) as string[]).includes(key)) return "CACHE_OR_EPHEMERAL";
  if (TRANSIENT_LOCAL_KEY_PATTERNS.some((pattern) => key.startsWith(pattern.prefix))) return "TRANSIENT_SESSION";
  return null;
}
