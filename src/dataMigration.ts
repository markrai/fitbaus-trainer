/**
 * FitBaus Trainer legacy data migration (Slice 1).
 *
 * Semantic-preserving transport from the legacy Android identity
 * (com.markrai.sisutrainer, IndexedDB `vo2_workout_db`, `sisu_trainer_*` keys)
 * to the current identity (com.markrai.fitbaus.trainer, `fitbaus_trainer_db`,
 * `fitbaus_trainer_*` keys). Migration is TRANSPORT, not recomputation:
 * localStorage strings are carried as exact stored strings; supported
 * IndexedDB values preserve all supported fields and historical provenance,
 * with one explicit normalization — legacy undefined-valued object
 * properties are normalized to absence (counted and reported, since JSON
 * has no undefined). Nothing is re-parsed into current science models or
 * regenerated.
 */

export const MIGRATION_FORMAT = "fitbaus-trainer-migration";
export const MIGRATION_SCHEMA_VERSION = 1;
export const LEGACY_PACKAGE_ID = "com.markrai.sisutrainer";
export const LEGACY_DB_NAME = "vo2_workout_db";
export const DESTINATION_DB_NAME = "fitbaus_trainer_db";
export const DESTINATION_DB_VERSION = 3;
export const MIGRATION_RECEIPT_KEY = "fitbaus_trainer_migration_receipt_v1";

export const MIGRATION_STORE_NAMES = [
  "workouts",
  "hr_samples",
  "ordinary_bike_telemetry",
  "sisu_settings",
] as const;
export type MigrationStoreName = (typeof MIGRATION_STORE_NAMES)[number];

const STORE_KEY_PATHS: Record<MigrationStoreName, string | string[]> = {
  workouts: "session_id",
  hr_samples: ["session_id", "timestamp_sec"],
  ordinary_bike_telemetry: ["session_id", "active_sec"],
  sisu_settings: "key",
};

/** Explicit allowlisted renames. No generic prefix substitution, ever. */
export const LEGACY_KEY_RENAMES: Readonly<Record<string, string>> = {
  sisu_trainer_equipment_selection: "fitbaus_trainer_equipment_selection",
  sisu_trainer_bike_bridge: "fitbaus_trainer_bike_bridge",
  sisu_trainer_machine_learning: "fitbaus_trainer_machine_learning",
  sisu_trainer_hr_dynamics: "fitbaus_trainer_hr_dynamics",
  sisu_trainer_shadow_resistance_predictions: "fitbaus_trainer_shadow_resistance_predictions",
};

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

// ---------------------------------------------------------------------------
// Deterministic canonical JSON + SHA-256
// ---------------------------------------------------------------------------

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value) ?? "null";
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalStringify(item ?? null)).join(",") + "]";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(record[k])).join(",") + "}";
  }
  return "null";
}

export class MigrationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * JSON serialization-domain validation. A value is in the supported
 * migration domain if it is null, a boolean, a finite number, a string, an
 * array of such values, or a plain object (Object.prototype / null
 * prototype) of such values — with the single explicit normalization that
 * undefined-valued object properties are treated as absent (counted via
 * countUndefinedProperties and reported as undefined_properties_dropped).
 * Everything else (undefined array elements/keys, NaN/Infinity, bigint,
 * symbol, function, Date, Map/Set, Blob/File, ArrayBuffer/typed
 * arrays/DataView, class instances, cyclic references) is rejected
 * UNSUPPORTED_STORED_VALUE with only the store/primary-key location —
 * never payload contents — and is never coerced.
 */
export function assertMigrationJsonLossless(
  value: unknown,
  location: string,
  ancestors: Set<object> = new Set()
): void {
  const fail = (kind: string): never => {
    throw new MigrationError(
      "UNSUPPORTED_STORED_VALUE",
      `Unsupported stored value (${kind}) at ${location}; export/import blocked without coercion.`
    );
  };
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("non-finite number");
    return;
  }
  if (value === undefined) fail("undefined");
  if (typeof value === "bigint") fail("bigint");
  if (typeof value === "symbol") fail("symbol");
  if (typeof value === "function") fail("function");
  if (typeof value !== "object") fail(typeof value);
  const obj = value as object;
  if (ancestors.has(obj)) fail("cyclic reference");
  if (typeof Date !== "undefined" && obj instanceof Date) fail("Date");
  if (typeof Map !== "undefined" && obj instanceof Map) fail("Map");
  if (typeof Set !== "undefined" && obj instanceof Set) fail("Set");
  if (typeof Blob !== "undefined" && obj instanceof Blob) fail("Blob/File");
  if (typeof ArrayBuffer !== "undefined" && (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj))) {
    fail("ArrayBuffer/typed array/DataView");
  }
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) fail(`undefined array element at index ${i}`);
        assertMigrationJsonLossless(obj[i], location, ancestors);
      }
      return;
    }
    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) fail("non-plain object");
    if (Object.getOwnPropertySymbols(obj).length > 0) fail("symbol-keyed property");
    for (const key of Object.keys(obj)) {
      const child = (obj as Record<string, unknown>)[key];
      // Explicit normalization (Slice 1.1 amendment, real-device data):
      // an undefined-valued object property is treated as ABSENT. JSON has
      // no undefined; reading the property yields undefined either way, and
      // every legacy consumer reads such optional fields by truthiness.
      // The count is reported in the bundle (undefined_properties_dropped),
      // never silently dropped. Undefined array elements, undefined primary
      // keys, and all non-plain/non-finite types below remain hard failures.
      if (child === undefined) continue;
      assertMigrationJsonLossless(child, location, ancestors);
    }
  } finally {
    ancestors.delete(obj);
  }
}

/** Count undefined-valued object properties (normalized to absent, reported). */
export function countUndefinedProperties(value: unknown, ancestors: Set<object> = new Set()): number {
  if (typeof value !== "object" || value === null) return 0;
  if (ancestors.has(value)) return 0;
  ancestors.add(value);
  let count = 0;
  try {
    if (Array.isArray(value)) {
      for (const item of value) count += countUndefinedProperties(item, ancestors);
      return count;
    }
    for (const key of Object.keys(value)) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) count += 1;
      else count += countUndefinedProperties(child, ancestors);
    }
    return count;
  } finally {
    ancestors.delete(value);
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 (crypto.subtle) unavailable");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Bundle contract
// ---------------------------------------------------------------------------

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

export function deriveStoreKey(store: MigrationStoreName, row: Record<string, unknown>): unknown {
  const keyPath = STORE_KEY_PATHS[store];
  if (typeof keyPath === "string") return row[keyPath];
  return keyPath.map((part) => row[part]);
}

function canonicalKeyText(key: unknown): string {
  return canonicalStringify(key ?? null);
}

export function sortStoreEntries(entries: MigrationStoreEntry[]): MigrationStoreEntry[] {
  return [...entries].sort((a, b) => canonicalKeyText(a.key).localeCompare(canonicalKeyText(b.key)));
}

export interface BuildBundleInput {
  exportedAt: string;
  appVersion?: string | null;
  sourceDbVersion?: number | null;
  /** Raw rows per store (values as stored; see undefined normalization above). */
  storeRows: Partial<Record<MigrationStoreName, Record<string, unknown>[]>>;
  unknownStores?: { name: string; record_count: number }[];
  /** Every legacy localStorage key/value pair (exact strings). */
  localEntries: { key: string; value: string }[];
}

export async function buildMigrationBundle(input: BuildBundleInput): Promise<MigrationBundle> {
  const stores = {} as Record<MigrationStoreName, MigrationStoreEntry[]>;
  const storeCounts = {} as Record<MigrationStoreName, number>;
  for (const name of MIGRATION_STORE_NAMES) {
    const rows = input.storeRows[name] ?? [];
    // Lossless preflight BEFORE any bundle is created: row + primary key.
    rows.forEach((row, index) => {
      let keyLabel = `row ${index}`;
      try {
        const k = deriveStoreKey(name, row);
        assertMigrationJsonLossless(k, `${name} primary key (row ${index})`);
        keyLabel = canonicalKeyText(k);
      } catch (error) {
        if (error instanceof MigrationError && error.code === "UNSUPPORTED_STORED_VALUE") throw error;
        throw error;
      }
      assertMigrationJsonLossless(row, `${name}[${keyLabel}]`);
    });
    const entries = sortStoreEntries(rows.map((row) => ({ key: deriveStoreKey(name, row), value: row })));
    const seen = new Set<string>();
    for (const entry of entries) {
      const text = canonicalKeyText(entry.key);
      if (seen.has(text)) throw new Error(`Duplicate primary key in ${name}: ${text}`);
      seen.add(text);
    }
    stores[name] = entries;
    storeCounts[name] = entries.length;
  }

  const localStorageEntries: MigrationLocalStorageEntry[] = [];
  const excluded: { key: string; classification: string }[] = [];
  const unknown: { key: string; value_sha256: string }[] = [];
  for (const { key, value } of [...input.localEntries].sort((a, b) => a.key.localeCompare(b.key))) {
    const classification = classifyLegacyLocalStorageKey(key);
    const destination = destinationKeyForLegacyKey(key);
    if (destination !== null && (classification === "MIGRATE_EXACTLY" || classification === "MIGRATE_WITH_KEY_RENAME")) {
      localStorageEntries.push({ source_key: key, destination_key: destination, classification, value });
    } else if (classification === "TRANSIENT_DO_NOT_MIGRATE") {
      excluded.push({ key, classification });
    } else {
      unknown.push({ key, value_sha256: await sha256Hex(value) });
    }
  }
  localStorageEntries.sort((a, b) => a.destination_key.localeCompare(b.destination_key));

  const storeDigests = {} as Record<MigrationStoreName, string>;
  for (const name of MIGRATION_STORE_NAMES) {
    storeDigests[name] = await sha256Hex(canonicalStringify(stores[name]));
  }
  const sectionDigests = {
    indexeddb: await sha256Hex(canonicalStringify(stores)),
    local_storage: await sha256Hex(canonicalStringify(localStorageEntries)),
  };
  let undefinedDropped = 0;
  for (const name of MIGRATION_STORE_NAMES) {
    for (const row of input.storeRows[name] ?? []) undefinedDropped += countUndefinedProperties(row);
  }
  const bundleWithoutDigest = {
    format: MIGRATION_FORMAT,
    schema_version: MIGRATION_SCHEMA_VERSION,
    exported_at: input.exportedAt,
    undefined_properties_dropped: undefinedDropped,
    source: {
      package_id: LEGACY_PACKAGE_ID,
      app_version: input.appVersion ?? null,
      indexeddb_name: LEGACY_DB_NAME,
      indexeddb_version: input.sourceDbVersion ?? null,
      store_names: [...MIGRATION_STORE_NAMES] as string[],
    },
    indexeddb: { stores },
    local_storage: localStorageEntries,
    excluded_local_keys: excluded,
    unknown_local_keys: unknown,
    unknown_stores: input.unknownStores ?? [],
  } as const;
  const bundleDigest = await sha256Hex(
    canonicalStringify({ ...bundleWithoutDigest, section_digests: sectionDigests, store_digests: storeDigests })
  );
  return {
    ...bundleWithoutDigest,
    manifest: {
      store_counts: storeCounts,
      local_storage_count: localStorageEntries.length,
      section_digests: sectionDigests,
      store_digests: storeDigests,
      bundle_digest: bundleDigest,
    },
  };
}

// ---------------------------------------------------------------------------
// Validation (fail closed, before any destination write)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMigrationBundleJson(text: string): MigrationBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MigrationError("INVALID_JSON", "Migration file is not valid JSON (corrupt or truncated).");
  }
  return validateMigrationBundleStructure(parsed);
}

export function validateMigrationBundleStructure(bundle: unknown): MigrationBundle {
  if (!isRecord(bundle)) throw new MigrationError("INVALID_BUNDLE", "Migration bundle must be an object.");
  if (bundle.format !== MIGRATION_FORMAT) {
    throw new MigrationError("WRONG_FORMAT", `Expected format "${MIGRATION_FORMAT}".`);
  }
  if (bundle.schema_version !== MIGRATION_SCHEMA_VERSION) {
    throw new MigrationError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Unsupported migration schema version: ${String(bundle.schema_version)}`
    );
  }
  const source = bundle.source;
  if (!isRecord(source) || source.package_id !== LEGACY_PACKAGE_ID) {
    throw new MigrationError("WRONG_SOURCE_PACKAGE", `Source package must be ${LEGACY_PACKAGE_ID}.`);
  }
  if (source.indexeddb_name !== LEGACY_DB_NAME) {
    throw new MigrationError("WRONG_SOURCE_DB", `Source IndexedDB must be ${LEGACY_DB_NAME}.`);
  }
  if (typeof bundle.exported_at !== "string" || !bundle.exported_at) {
    throw new MigrationError("INVALID_BUNDLE", "Bundle is missing exported_at.");
  }
  const indexeddb = bundle.indexeddb;
  if (!isRecord(indexeddb) || !isRecord(indexeddb.stores)) {
    throw new MigrationError("MALFORMED_INDEXEDDB", "Bundle IndexedDB section is malformed.");
  }
  for (const name of Object.keys(indexeddb.stores)) {
    if (!(MIGRATION_STORE_NAMES as readonly string[]).includes(name)) {
      throw new MigrationError("MALFORMED_INDEXEDDB", `Unknown IndexedDB store in bundle: ${name}`);
    }
  }
  const stores = {} as Record<MigrationStoreName, MigrationStoreEntry[]>;
  for (const name of MIGRATION_STORE_NAMES) {
    const rawEntries = indexeddb.stores[name] ?? [];
    if (!Array.isArray(rawEntries)) {
      throw new MigrationError("MALFORMED_INDEXEDDB", `Store ${name} must be an array.`);
    }
    const seen = new Set<string>();
    const entries: MigrationStoreEntry[] = [];
    for (const raw of rawEntries) {
      if (!isRecord(raw) || !isRecord(raw.value) || !("key" in raw)) {
        throw new MigrationError("MALFORMED_INDEXEDDB", `Store ${name} contains a malformed entry.`);
      }
      // Same serialization-domain gate as export: a handcrafted bundle cannot bypass it.
      assertMigrationJsonLossless(raw.key, `${name} primary key`);
      assertMigrationJsonLossless(raw.value, `${name}[${canonicalKeyText(raw.key)}]`);
      const derived = deriveStoreKey(name, raw.value);
      if (canonicalKeyText(derived) !== canonicalKeyText(raw.key)) {
        throw new MigrationError("MALFORMED_INDEXEDDB", `Store ${name} entry key does not match its row.`);
      }
      const text = canonicalKeyText(raw.key);
      if (seen.has(text)) {
        throw new MigrationError("DUPLICATE_PRIMARY_KEY", `Duplicate primary key in ${name}: ${text}`);
      }
      seen.add(text);
      entries.push({ key: raw.key, value: raw.value });
    }
    stores[name] = sortStoreEntries(entries);
  }
  if (!Array.isArray(bundle.local_storage)) {
    throw new MigrationError("MALFORMED_LOCAL_STORAGE", "Bundle localStorage section is malformed.");
  }
  const localEntries: MigrationLocalStorageEntry[] = [];
  const seenDestinations = new Set<string>();
  for (const raw of bundle.local_storage) {
    if (!isRecord(raw) || typeof raw.source_key !== "string" || typeof raw.value !== "string") {
      throw new MigrationError("MALFORMED_LOCAL_STORAGE", "Bundle localStorage entry is malformed.");
    }
    const expectedDestination = destinationKeyForLegacyKey(raw.source_key);
    if (expectedDestination === null) {
      throw new MigrationError(
        "MALFORMED_LOCAL_STORAGE",
        `Key ${raw.source_key} is transient/unknown and must not be in the migration payload.`
      );
    }
    if (raw.destination_key !== expectedDestination) {
      throw new MigrationError(
        "MALFORMED_LOCAL_STORAGE",
        `Key ${raw.source_key} maps to ${expectedDestination}, not ${String(raw.destination_key)}.`
      );
    }
    if (seenDestinations.has(expectedDestination)) {
      throw new MigrationError("MALFORMED_LOCAL_STORAGE", `Duplicate destination key ${expectedDestination}.`);
    }
    seenDestinations.add(expectedDestination);
    localEntries.push({
      source_key: raw.source_key,
      destination_key: expectedDestination,
      classification: classifyLegacyLocalStorageKey(raw.source_key) as MigrationLocalStorageEntry["classification"],
      value: raw.value,
    });
  }
  const manifest = bundle.manifest;
  if (!isRecord(manifest) || !isRecord(manifest.store_counts) || !isRecord(manifest.section_digests) || !isRecord(manifest.store_digests)) {
    throw new MigrationError("INVALID_MANIFEST", "Bundle manifest is malformed (per-store digests required).");
  }
  for (const name of MIGRATION_STORE_NAMES) {
    if (typeof manifest.store_digests[name] !== "string") {
      throw new MigrationError("INVALID_MANIFEST", `Bundle manifest is missing per-store digest for ${name}.`);
    }
  }
  for (const name of MIGRATION_STORE_NAMES) {
    if (manifest.store_counts[name] !== stores[name].length) {
      throw new MigrationError("COUNT_MISMATCH", `Manifest count for ${name} does not match payload.`);
    }
  }
  if (manifest.local_storage_count !== localEntries.length) {
    throw new MigrationError("COUNT_MISMATCH", "Manifest localStorage count does not match payload.");
  }
  return {
    ...(bundle as unknown as MigrationBundle),
    indexeddb: { stores },
    local_storage: localEntries.sort((a, b) => a.destination_key.localeCompare(b.destination_key)),
  };
}

export async function verifyMigrationBundleIntegrity(bundle: MigrationBundle): Promise<void> {
  for (const name of MIGRATION_STORE_NAMES) {
    const digest = await sha256Hex(canonicalStringify(bundle.indexeddb.stores[name]));
    if (digest !== bundle.manifest.store_digests[name]) {
      throw new MigrationError("DIGEST_MISMATCH", `Per-store digest mismatch for ${name}.`);
    }
  }
  const indexeddbDigest = await sha256Hex(canonicalStringify(bundle.indexeddb.stores));
  if (indexeddbDigest !== bundle.manifest.section_digests.indexeddb) {
    throw new MigrationError("DIGEST_MISMATCH", "IndexedDB section digest mismatch.");
  }
  const localDigest = await sha256Hex(canonicalStringify(bundle.local_storage));
  if (localDigest !== bundle.manifest.section_digests.local_storage) {
    throw new MigrationError("DIGEST_MISMATCH", "localStorage section digest mismatch.");
  }
  const { manifest, ...rest } = bundle;
  void manifest;
  const bundleDigest = await sha256Hex(
    canonicalStringify({
      ...rest,
      section_digests: bundle.manifest.section_digests,
      store_digests: bundle.manifest.store_digests,
    })
  );
  if (bundleDigest !== bundle.manifest.bundle_digest) {
    throw new MigrationError("DIGEST_MISMATCH", "Whole-bundle digest mismatch.");
  }
}

/** Unknown source state (§2): names/counts only, never localStorage values. */
export interface UnreviewedSourceState {
  unknownLocalKeys: string[];
  unknownStores: { name: string; record_count: number }[];
}

export function getUnreviewedSourceState(bundle: MigrationBundle): UnreviewedSourceState {
  return {
    unknownLocalKeys: (bundle.unknown_local_keys ?? []).map((e) => e.key),
    unknownStores: (bundle.unknown_stores ?? []).map((e) => ({ name: e.name, record_count: e.record_count })),
  };
}

export function isMigrationBundleImportable(bundle: MigrationBundle): boolean {
  const u = getUnreviewedSourceState(bundle);
  return u.unknownLocalKeys.length === 0 && u.unknownStores.length === 0;
}

export function assertMigrationBundleImportable(bundle: MigrationBundle): void {
  const u = getUnreviewedSourceState(bundle);
  if (u.unknownLocalKeys.length === 0 && u.unknownStores.length === 0) return;
  const parts: string[] = [];
  if (u.unknownLocalKeys.length) parts.push(`unknown local keys: ${u.unknownLocalKeys.join(", ")}`);
  if (u.unknownStores.length) {
    parts.push(`unknown stores: ${u.unknownStores.map((s) => `${s.name} (${s.record_count} records)`).join(", ")}`);
  }
  throw new MigrationError(
    "UNREVIEWED_SOURCE_STATE",
    `Migration bundle contains unreviewed source state (${parts.join("; ")}). Import blocked; no data was changed.`
  );
}

export interface MigrationBundleSummary {
  exportedAt: string;
  sourcePackageId: string;
  appVersion: string | null;
  storeCounts: Record<MigrationStoreName, number>;
  localStorageCount: number;
  undefinedPropertiesDropped: number;
  unknownLocalKeys: string[];
  unknownStores: { name: string; record_count: number }[];
  excludedLocalKeys: string[];
  bundleDigest: string;
}

export function summarizeMigrationBundle(bundle: MigrationBundle): MigrationBundleSummary {
  return {
    exportedAt: bundle.exported_at,
    sourcePackageId: bundle.source.package_id,
    appVersion: bundle.source.app_version,
    storeCounts: { ...bundle.manifest.store_counts },
    localStorageCount: bundle.manifest.local_storage_count,
    undefinedPropertiesDropped: bundle.undefined_properties_dropped ?? 0,
    unknownLocalKeys: (bundle.unknown_local_keys ?? []).map((entry) => entry.key),
    unknownStores: (bundle.unknown_stores ?? []).map((e) => ({ name: e.name, record_count: e.record_count })),
    excludedLocalKeys: (bundle.excluded_local_keys ?? []).map((entry) => entry.key),
    bundleDigest: bundle.manifest.bundle_digest,
  };
}

// ---------------------------------------------------------------------------
// Storage adapters
// ---------------------------------------------------------------------------

export interface MigrationLocalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

export function browserMigrationLocalStorage(): MigrationLocalStorage {
  return {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
    keys: () => {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) keys.push(key);
      }
      return keys;
    },
  };
}

function openDestinationDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DESTINATION_DB_NAME, DESTINATION_DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Failed to open destination IndexedDB"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("workouts")) {
        const store = database.createObjectStore("workouts", { keyPath: "session_id" });
        store.createIndex("startedAt", "startedAt", { unique: false });
        store.createIndex("day", "day", { unique: false });
      }
      if (!database.objectStoreNames.contains("hr_samples")) {
        const store = database.createObjectStore("hr_samples", { keyPath: ["session_id", "timestamp_sec"] });
        store.createIndex("session_id", "session_id", { unique: false });
      }
      if (!database.objectStoreNames.contains("ordinary_bike_telemetry")) {
        const store = database.createObjectStore("ordinary_bike_telemetry", {
          keyPath: ["session_id", "active_sec"],
        });
        store.createIndex("session_id", "session_id", { unique: false });
        store.createIndex("observed_at", "observed_at", { unique: false });
        store.createIndex("session_source_id", ["session_id", "source_sample_id"], { unique: false });
      }
      if (!database.objectStoreNames.contains("sisu_settings")) {
        database.createObjectStore("sisu_settings", { keyPath: "key" });
      }
    };
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function readAllStoreRows(db: IDBDatabase, store: MigrationStoreName): Promise<MigrationStoreEntry[]> {
  if (!db.objectStoreNames.contains(store)) return [];
  const tx = db.transaction([store], "readonly");
  const objectStore = tx.objectStore(store);
  const [values, keys] = await Promise.all([
    idbRequest(objectStore.getAll()),
    idbRequest(objectStore.getAllKeys()),
  ]);
  await txDone(tx).catch(() => undefined);
  return sortStoreEntries(
    (values as Record<string, unknown>[]).map((value, index) => ({ key: keys[index], value }))
  );
}

async function readAllDestinationStores(
  db: IDBDatabase
): Promise<Record<MigrationStoreName, MigrationStoreEntry[]>> {
  const result = {} as Record<MigrationStoreName, MigrationStoreEntry[]>;
  for (const name of MIGRATION_STORE_NAMES) result[name] = await readAllStoreRows(db, name);
  return result;
}

// ---------------------------------------------------------------------------
// Destination preflight
// ---------------------------------------------------------------------------

export type DestinationState = "EMPTY_BOOTSTRAP_STATE" | "MEANINGFUL_USER_DATA";

export interface DestinationPreflight {
  state: DestinationState;
  reasons: string[];
  bootstrapKeysPresent: string[];
}

// NOTE: MIGRATION_RECEIPT_KEY is deliberately NOT harmless. Any receipt is
// meaningful destination state and is handled explicitly in the importer.
const HARMLESS_DESTINATION_KEYS: ReadonlySet<string> = new Set([
  "installPromptShown",
  "enableServiceWorkerDev",
]);

function profileLooksLikeEmptyBootstrap(storage: MigrationLocalStorage): boolean {
  const raw = storage.getItem("athlete_profile_v1");
  if (raw === null) return true;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return false;
    if (parsed.userEnteredVo2 !== undefined && parsed.userEnteredVo2 !== null) return false;
    const demographics = parsed.demographics;
    if (demographics === undefined || demographics === null) return true;
    if (!isRecord(demographics)) return false;
    return Object.values(demographics).every((v) => v === undefined || v === null || v === "");
  } catch {
    return false;
  }
}

export function inspectDestinationLocalState(storage: MigrationLocalStorage): DestinationPreflight {
  const reasons: string[] = [];
  const bootstrapKeysPresent: string[] = [];
  for (const key of storage.keys()) {
    if (HARMLESS_DESTINATION_KEYS.has(key)) continue;
    if (key === "athlete_identity_v1") {
      bootstrapKeysPresent.push(key);
      continue;
    }
    if (key === "athlete_profile_v1") {
      if (profileLooksLikeEmptyBootstrap(storage)) bootstrapKeysPresent.push(key);
      else reasons.push(`athlete_profile_v1 already contains entered profile data`);
      continue;
    }
    reasons.push(`existing destination key: ${key}`);
  }
  return {
    state: reasons.length === 0 ? "EMPTY_BOOTSTRAP_STATE" : "MEANINGFUL_USER_DATA",
    reasons,
    bootstrapKeysPresent,
  };
}

// ---------------------------------------------------------------------------
// Post-import verification
// ---------------------------------------------------------------------------

export interface MigrationVerificationReport {
  status: "VERIFIED_MATCH" | "MISMATCH";
  workouts: { expected: number; actual: number; sessionIdsMatch: boolean; digestMatch: boolean };
  hrSamples: { expected: number; actual: number; digestMatch: boolean };
  ordinaryBikeTelemetry: { expected: number; actual: number; digestMatch: boolean };
  sisuSettings: { expected: number; actual: number; digestMatch: boolean };
  storeDigests: Record<MigrationStoreName, { expected: string; actual: string; digestMatch: boolean }>;
  localStorage: { expectedKeys: number; actualKeysPresent: number; digestMatch: boolean };
  athleteIdentityPresent: boolean;
  profilePresent: boolean;
  fitnessStatePresent: boolean;
  formalCalibrationProvenancePresent: boolean;
  machineLearningPresent: boolean;
  hrDynamicsPresent: boolean;
  shadowPredictionsPresent: boolean;
  equipmentPresent: boolean;
  bikeBridgePresent: boolean;
  mismatches: string[];
}

export async function verifyDestinationAgainstBundle(
  bundle: MigrationBundle,
  storage: MigrationLocalStorage,
  db: IDBDatabase
): Promise<MigrationVerificationReport> {
  const mismatches: string[] = [];
  const actualStores = await readAllDestinationStores(db);
  const expectedWorkouts = bundle.indexeddb.stores.workouts;
  const actualWorkoutIds = new Set(actualStores.workouts.map((e) => canonicalKeyText(e.key)));
  const sessionIdsMatch =
    actualWorkoutIds.size === expectedWorkouts.length &&
    expectedWorkouts.every((e) => actualWorkoutIds.has(canonicalKeyText(e.key)));
  if (!sessionIdsMatch) mismatches.push("workout session-ID set mismatch");

  const actualIndexeddbDigest = await sha256Hex(canonicalStringify(actualStores));
  const indexeddbDigestMatch = actualIndexeddbDigest === bundle.manifest.section_digests.indexeddb;
  if (!indexeddbDigestMatch) mismatches.push("destination IndexedDB digest mismatch");
  const storeDigests = {} as MigrationVerificationReport["storeDigests"];
  for (const name of MIGRATION_STORE_NAMES) {
    const actual = await sha256Hex(canonicalStringify(actualStores[name]));
    const expected = bundle.manifest.store_digests[name];
    storeDigests[name] = { expected, actual, digestMatch: actual === expected };
    if (actual !== expected) mismatches.push(`destination store ${name} digest mismatch`);
  }

  const actualLocalEntries = bundle.local_storage.map((entry) => ({
    ...entry,
    value: storage.getItem(entry.destination_key) ?? "\u0000MISSING",
  }));
  const localDigestMatch =
    (await sha256Hex(canonicalStringify(actualLocalEntries))) === bundle.manifest.section_digests.local_storage;
  if (!localDigestMatch) mismatches.push("destination localStorage digest mismatch");
  const actualKeysPresent = bundle.local_storage.filter(
    (entry) => storage.getItem(entry.destination_key) !== null
  ).length;

  const has = (key: string) => storage.getItem(key) !== null;
  const report: MigrationVerificationReport = {
    status: mismatches.length === 0 ? "VERIFIED_MATCH" : "MISMATCH",
    workouts: {
      expected: expectedWorkouts.length,
      actual: actualStores.workouts.length,
      sessionIdsMatch,
      digestMatch: storeDigests.workouts.digestMatch,
    },
    hrSamples: {
      expected: bundle.manifest.store_counts.hr_samples,
      actual: actualStores.hr_samples.length,
      digestMatch: storeDigests.hr_samples.digestMatch,
    },
    ordinaryBikeTelemetry: {
      expected: bundle.manifest.store_counts.ordinary_bike_telemetry,
      actual: actualStores.ordinary_bike_telemetry.length,
      digestMatch: storeDigests.ordinary_bike_telemetry.digestMatch,
    },
    sisuSettings: {
      expected: bundle.manifest.store_counts.sisu_settings,
      actual: actualStores.sisu_settings.length,
      digestMatch: storeDigests.sisu_settings.digestMatch,
    },
    storeDigests,
    localStorage: {
      expectedKeys: bundle.local_storage.length,
      actualKeysPresent,
      digestMatch: localDigestMatch,
    },
    athleteIdentityPresent: has("athlete_identity_v1"),
    profilePresent: has("athlete_profile_v1"),
    fitnessStatePresent: has("fitness_state_v1"),
    formalCalibrationProvenancePresent: has("formal_calibration_machine_provenance_v1"),
    machineLearningPresent: has("fitbaus_trainer_machine_learning"),
    hrDynamicsPresent: has("fitbaus_trainer_hr_dynamics"),
    shadowPredictionsPresent: has("fitbaus_trainer_shadow_resistance_predictions"),
    equipmentPresent: has("fitbaus_trainer_equipment_selection"),
    bikeBridgePresent: has("fitbaus_trainer_bike_bridge"),
    mismatches,
  };
  return report;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type MigrationImportStatus =
  | "IMPORTED_VERIFIED"
  | "ALREADY_IMPORTED"
  | "EXISTING_IMPORT_MISMATCH"
  | "PRIOR_MIGRATION_DIFFERENT_BUNDLE"
  | "DESTINATION_NOT_EMPTY"
  | "FAILED_ROLLED_BACK"
  | "ROLLBACK_UNVERIFIED";

export interface MigrationImportResult {
  status: MigrationImportStatus;
  summary: MigrationBundleSummary;
  verification?: MigrationVerificationReport;
  destinationPreflight?: DestinationPreflight;
  error?: { code: string; message: string };
}

export interface MigrationImportOptions {
  storage: MigrationLocalStorage;
  indexedDBFactory?: IDBFactory;
  now?: () => Date;
  /** Test-only fault injection hooks. Never set in production UI. */
  faultInjection?: {
    failBeforeStoreWrite?: MigrationStoreName;
    failOnLocalStorageKey?: string;
    /** Rollback fault injection (tests only): never yields FAILED_ROLLED_BACK. */
    failIdbRollback?: boolean;
    failLocalStorageRollback?: boolean;
    corruptAfterRollback?: boolean;
  };
}

export async function importMigrationBundle(
  bundleInput: unknown,
  options: MigrationImportOptions
): Promise<MigrationImportResult> {
  const bundle = validateMigrationBundleStructure(bundleInput);
  const summary = summarizeMigrationBundle(bundle);
  await verifyMigrationBundleIntegrity(bundle);
  // §2 hard gate: unknown source state blocks before any destination access/write.
  assertMigrationBundleImportable(bundle);

  const storage = options.storage;
  const factory = options.indexedDBFactory ?? globalThis.indexedDB;
  if (!factory) {
    return {
      status: "FAILED_ROLLED_BACK",
      summary,
      error: { code: "NO_INDEXEDDB", message: "IndexedDB is unavailable in this environment." },
    };
  }
  const db = await openDestinationDb(factory);
  try {
    // Receipt policy (§1): a receipt is never harmless bootstrap data.
    const receiptRaw = storage.getItem(MIGRATION_RECEIPT_KEY);
    if (receiptRaw !== null) {
      let receipt: unknown = null;
      let malformed = false;
      try {
        receipt = JSON.parse(receiptRaw);
      } catch {
        malformed = true;
      }
      if (!malformed && (!isRecord(receipt) || typeof receipt.bundle_digest !== "string")) malformed = true;
      if (malformed) {
        return {
          status: "DESTINATION_NOT_EMPTY",
          summary,
          destinationPreflight: {
            state: "MEANINGFUL_USER_DATA",
            reasons: ["malformed migration receipt is present (meaningful destination state)"],
            bootstrapKeysPresent: [],
          },
          error: { code: "MALFORMED_MIGRATION_RECEIPT", message: "A malformed prior migration receipt exists; manual review is required. No data was changed." },
        };
      }
      const receiptDigest = (receipt as Record<string, unknown>).bundle_digest as string;
      if (receiptDigest === bundle.manifest.bundle_digest) {
        const verification = await verifyDestinationAgainstBundle(bundle, storage, db);
        if (verification.status === "VERIFIED_MATCH") {
          return { status: "ALREADY_IMPORTED", summary, verification };
        }
        return {
          status: "EXISTING_IMPORT_MISMATCH",
          summary,
          verification,
          error: {
            code: "EXISTING_IMPORT_MISMATCH",
            message:
              "A prior import receipt exists for this bundle, but stored data no longer matches it; manual review is required. No data was changed.",
          },
        };
      }
      return {
        status: "PRIOR_MIGRATION_DIFFERENT_BUNDLE",
        summary,
        destinationPreflight: {
          state: "MEANINGFUL_USER_DATA",
          reasons: ["a prior migration receipt for a different bundle is present"],
          bootstrapKeysPresent: [],
        },
        error: { code: "PRIOR_MIGRATION_DIFFERENT_BUNDLE", message: "A prior migration receipt for a different bundle exists. No data was changed." },
      };
    }

    const destinationStores = await readAllDestinationStores(db);
    const preflightLocal = inspectDestinationLocalState(storage);
    const reasons = [...preflightLocal.reasons];
    for (const name of MIGRATION_STORE_NAMES) {
      if (destinationStores[name].length > 0) reasons.push(`destination store ${name} is not empty`);
    }
    const preflight: DestinationPreflight = {
      state: reasons.length === 0 ? "EMPTY_BOOTSTRAP_STATE" : "MEANINGFUL_USER_DATA",
      reasons,
      bootstrapKeysPresent: preflightLocal.bootstrapKeysPresent,
    };
    if (preflight.state === "MEANINGFUL_USER_DATA") {
      return { status: "DESTINATION_NOT_EMPTY", summary, destinationPreflight: preflight };
    }

    // Snapshot everything we may touch (bootstrap state + empty stores) for rollback.
    const localSnapshot = new Map<string, string | null>();
    for (const key of storage.keys()) localSnapshot.set(key, storage.getItem(key));
    const storeSnapshot = destinationStores;

    try {
      // 1) IndexedDB: one transaction across all destination stores.
      // Transaction sequence: create tx, attach completion promise, put all
      // rows, await completion. On ANY error while the tx may still be
      // active, explicitly abort it and swallow its (handled) rejection so
      // it cannot commit partial rows and no unhandled rejection occurs.
      const tx = db.transaction([...MIGRATION_STORE_NAMES], "readwrite");
      const txPromise = txDone(tx);
      try {
        for (const name of MIGRATION_STORE_NAMES) {
          if (options.faultInjection?.failBeforeStoreWrite === name) {
            throw new MigrationError("INJECTED_IDB_FAILURE", `Injected failure before writing ${name}`);
          }
          const store = tx.objectStore(name);
          for (const entry of bundle.indexeddb.stores[name]) store.put(entry.value);
        }
        await txPromise;
      } catch (txError) {
        try {
          tx.abort();
        } catch {
          /* already finished/aborted */
        }
        await txPromise.catch(() => undefined);
        throw txError;
      }

      // 2) localStorage: write exact strings to destination keys.
      for (const entry of bundle.local_storage) {
        if (options.faultInjection?.failOnLocalStorageKey === entry.destination_key) {
          throw new MigrationError("INJECTED_LOCALSTORAGE_FAILURE", "Injected localStorage failure");
        }
        storage.setItem(entry.destination_key, entry.value);
      }

      // 3) Receipt (written before final verification so verification covers the full state).
      const receipt = {
        schema_version: MIGRATION_SCHEMA_VERSION,
        bundle_digest: bundle.manifest.bundle_digest,
        imported_at: (options.now?.() ?? new Date()).toISOString(),
        source_package_id: LEGACY_PACKAGE_ID,
        format: MIGRATION_FORMAT,
      };
      storage.setItem(MIGRATION_RECEIPT_KEY, JSON.stringify(receipt));

      // 4) Post-import verification.
      const verification = await verifyDestinationAgainstBundle(bundle, storage, db);
      if (verification.status !== "VERIFIED_MATCH") {
        throw new MigrationError(
          "POST_IMPORT_MISMATCH",
          `Post-import verification failed: ${verification.mismatches.join("; ")}`
        );
      }
      return { status: "IMPORTED_VERIFIED", summary, verification, destinationPreflight: preflight };
    } catch (error) {
      // Rollback (§3): restore IDB + localStorage (incl. receipt state, which
      // is part of the local snapshot), then VERIFY against the pre-import
      // snapshot. Only a verified restoration may be FAILED_ROLLED_BACK.
      let rollbackFailed = false;
      try {
        if (options.faultInjection?.failIdbRollback) {
          throw new MigrationError("INJECTED_IDB_ROLLBACK_FAILURE", "Injected IndexedDB rollback failure");
        }
        const rollbackTx = db.transaction([...MIGRATION_STORE_NAMES], "readwrite");
        const rollbackDone = txDone(rollbackTx);
        try {
          for (const name of MIGRATION_STORE_NAMES) {
            const store = rollbackTx.objectStore(name);
            store.clear();
            for (const entry of storeSnapshot[name]) store.put(entry.value);
          }
          await rollbackDone;
        } catch (rbError) {
          try {
            rollbackTx.abort();
          } catch {
            /* ignore */
          }
          await rollbackDone.catch(() => undefined);
          throw rbError;
        }
      } catch {
        rollbackFailed = true;
      }
      try {
        if (options.faultInjection?.failLocalStorageRollback) {
          throw new MigrationError("INJECTED_LOCALSTORAGE_ROLLBACK_FAILURE", "Injected localStorage rollback failure");
        }
        for (const key of storage.keys()) {
          if (!localSnapshot.has(key)) storage.removeItem(key);
        }
        for (const [key, value] of localSnapshot) {
          if (value === null) storage.removeItem(key);
          else storage.setItem(key, value);
        }
      } catch {
        rollbackFailed = true;
      }
      if (options.faultInjection?.corruptAfterRollback) {
        try {
          storage.setItem("__rollback_verification_sabotage__", "1");
        } catch {
          rollbackFailed = true;
        }
      }
      // Verify restoration: every IDB store digest + exact local key set/strings.
      let verified = !rollbackFailed;
      if (verified) {
        try {
          const restoredStores = await readAllDestinationStores(db);
          for (const name of MIGRATION_STORE_NAMES) {
            const restoredDigest = await sha256Hex(canonicalStringify(restoredStores[name]));
            const snapshotDigest = await sha256Hex(canonicalStringify(storeSnapshot[name]));
            if (restoredDigest !== snapshotDigest) verified = false;
          }
          const restoredKeys = storage.keys().slice().sort();
          const snapshotKeys = [...localSnapshot.keys()].sort();
          if (canonicalStringify(restoredKeys) !== canonicalStringify(snapshotKeys)) verified = false;
          else {
            for (const [key, value] of localSnapshot) {
              if (storage.getItem(key) !== value) verified = false;
            }
          }
        } catch {
          verified = false;
        }
      }
      return {
        status: verified ? "FAILED_ROLLED_BACK" : "ROLLBACK_UNVERIFIED",
        summary,
        destinationPreflight: preflight,
        error: {
          code: error instanceof MigrationError ? error.code : "IMPORT_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// User-visible import UI (Profile > Data)
// ---------------------------------------------------------------------------

interface PendingImport {
  bundle: MigrationBundle;
  summary: MigrationBundleSummary;
}

export function registerDataMigrationGlobals(): void {
  const win = window as unknown as Record<string, unknown>;
  let pending: PendingImport | null = null;

  const byId = (id: string) => document.getElementById(id);

  function renderSummary(element: HTMLElement, summary: MigrationBundleSummary): void {
    const counts = summary.storeCounts;
    element.innerHTML = "";
    const lines = [
      `Source: ${summary.sourcePackageId}${summary.appVersion ? ` (app ${summary.appVersion})` : ""}`,
      `Exported: ${summary.exportedAt}`,
      `Workouts: ${counts.workouts} · HR samples: ${counts.hr_samples} · Bike telemetry: ${counts.ordinary_bike_telemetry} · Sync settings: ${counts.sisu_settings}`,
      `Settings & profile keys: ${summary.localStorageCount}`,
      ...(summary.undefinedPropertiesDropped
        ? [`${summary.undefinedPropertiesDropped} undefined-valued legacy properties were treated as absent (JSON has no undefined; reading them yields undefined either way).`]
        : []),
      ...(summary.unknownLocalKeys.length
        ? [`Unrecognized legacy keys (import blocked): ${summary.unknownLocalKeys.join(", ")}`]
        : []),
      ...(summary.unknownStores.length
        ? [`Unrecognized legacy stores (import blocked): ${summary.unknownStores.map((s) => `${s.name} (${s.record_count} records)`).join(", ")}`]
        : []),
      "Import is allowed only into a fresh FitBaus Trainer installation. Existing FitBaus data will not be merged or overwritten.",
    ];
    for (const line of lines) {
      const div = document.createElement("div");
      div.textContent = line;
      element.appendChild(div);
    }
  }

  win.selectLegacyMigrationFile = async (input: HTMLInputElement): Promise<void> => {
    const status = byId("legacyImportStatus");
    const preview = byId("legacyImportPreview");
    const confirmButton = byId("legacyImportConfirmButton") as HTMLButtonElement | null;
    pending = null;
    if (confirmButton) confirmButton.hidden = true;
    const file = input.files?.[0];
    if (!file || !status || !preview) return;
    try {
      const text = await file.text();
      const bundle = parseMigrationBundleJson(text);
      await verifyMigrationBundleIntegrity(bundle);
      const summary = summarizeMigrationBundle(bundle);
      renderSummary(preview, summary);
      preview.hidden = false;
      if (!isMigrationBundleImportable(bundle)) {
        pending = null;
        if (confirmButton) confirmButton.hidden = true;
        status.textContent =
          "Migration file is intact, but it contains unrecognized legacy state that has not been approved for migration. No data was changed.";
        return;
      }
      pending = { bundle, summary };
      if (confirmButton) confirmButton.hidden = false;
      status.textContent = "Migration file verified. Review the summary, then confirm import.";
    } catch (error) {
      preview.hidden = true;
      status.textContent =
        error instanceof MigrationError
          ? `Migration file rejected (${error.code}): ${error.message} No data was changed.`
          : "Migration file could not be read. No data was changed.";
    }
  };

  win.confirmLegacyMigrationImport = async (): Promise<void> => {
    const status = byId("legacyImportStatus");
    const confirmButton = byId("legacyImportConfirmButton") as HTMLButtonElement | null;
    if (!pending || !status) return;
    if (confirmButton) confirmButton.disabled = true;
    try {
      const result = await importMigrationBundle(pending.bundle, {
        storage: browserMigrationLocalStorage(),
      });
      if (result.status === "IMPORTED_VERIFIED" && result.verification) {
        const v = result.verification;
        status.textContent =
          `Import verified: ${v.workouts.actual} workouts, ${v.hrSamples.actual} HR samples, ` +
          `${v.ordinaryBikeTelemetry.actual} bike telemetry records. ` +
          `Profile: ${v.profilePresent ? "present" : "absent"} · Fitness state: ${v.fitnessStatePresent ? "present" : "absent"} · ` +
          `Verification: VERIFIED_MATCH. Keep the legacy app installed until you have checked your history here.`;
        pending = null;
        if (confirmButton) confirmButton.hidden = true;
      } else if (result.status === "ALREADY_IMPORTED") {
        status.textContent = "This exact migration file was already imported. Nothing was changed.";
        pending = null;
        if (confirmButton) confirmButton.hidden = true;
      } else if (result.status === "EXISTING_IMPORT_MISMATCH") {
        status.textContent =
          "A prior import receipt exists for this migration file, but stored data no longer matches that bundle and manual review is required. Nothing was changed.";
        pending = null;
        if (confirmButton) confirmButton.hidden = true;
      } else if (result.status === "PRIOR_MIGRATION_DIFFERENT_BUNDLE") {
        status.textContent =
          "Import stopped: a prior migration receipt for a different migration file exists, so nothing was merged or overwritten. Manual review is required.";
      } else if (result.status === "DESTINATION_NOT_EMPTY") {
        status.textContent =
          "Import stopped: this FitBaus Trainer installation already contains data, so nothing was merged or overwritten. " +
          (result.destinationPreflight?.reasons.join("; ") ?? "");
      } else if (result.status === "ROLLBACK_UNVERIFIED") {
        status.textContent =
          "Import failed and automatic rollback could not be verified. Do not continue using this new installation until it is inspected/reset. The legacy app remains untouched.";
      } else if (result.status === "FAILED_ROLLED_BACK") {
        status.textContent = `Import failed and rollback was verified against the pre-import state. (${result.error?.code ?? "IMPORT_FAILED"})`;
      } else {
        status.textContent = `Import failed (${result.error?.code ?? "IMPORT_FAILED"}): ${result.error?.message ?? "unknown error"}`;
      }
    } catch (error) {
      status.textContent =
        error instanceof MigrationError
          ? `Import rejected (${error.code}): ${error.message} No data was changed.`
          : "Import failed before any data was changed.";
    } finally {
      if (confirmButton) confirmButton.disabled = false;
    }
  };
}
