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
 *
 * Contract split: the LEGACY source side (package id, source DB name, bundle
 * store list/key paths, legacy key allowlist) is a frozen historical contract
 * owned by migration/contracts. The CURRENT destination side (DB
 * name/version/schema, current localStorage key names) comes from
 * src/persistence/.
 *
 * Public compatibility facade: the implementation lives in src/migration/.
 * Internal migration modules import each other directly, never this file.
 */

export {
  LEGACY_DB_NAME,
  LEGACY_KEY_RENAMES,
  LEGACY_PACKAGE_ID,
  MIGRATION_FORMAT,
  MIGRATION_SCHEMA_VERSION,
  MIGRATION_STORE_NAMES,
  MigrationError,
  TRANSIENT_KEY_PREFIXES,
  UNCHANGED_DURABLE_KEYS,
  classifyLegacyLocalStorageKey,
  destinationKeyForLegacyKey,
} from "./migration/contracts.js";
export type {
  LocalKeyClassification,
  MigrationBundle,
  MigrationLocalStorageEntry,
  MigrationStoreEntry,
  MigrationStoreName,
} from "./migration/contracts.js";
export { assertMigrationJsonLossless, canonicalStringify, countUndefinedProperties } from "./migration/serialization.js";
export { sha256Hex, verifyMigrationBundleIntegrity } from "./migration/integrity.js";
export {
  assertMigrationBundleImportable,
  buildMigrationBundle,
  deriveStoreKey,
  getUnreviewedSourceState,
  isMigrationBundleImportable,
  parseMigrationBundleJson,
  sortStoreEntries,
  summarizeMigrationBundle,
  validateMigrationBundleStructure,
} from "./migration/bundle.js";
export type { BuildBundleInput, MigrationBundleSummary, UnreviewedSourceState } from "./migration/bundle.js";
export {
  DESTINATION_DB_NAME,
  DESTINATION_DB_VERSION,
  MIGRATION_RECEIPT_KEY,
  browserMigrationLocalStorage,
  inspectDestinationLocalState,
  verifyDestinationAgainstBundle,
} from "./migration/destination.js";
export type {
  DestinationPreflight,
  DestinationState,
  MigrationLocalStorage,
  MigrationVerificationReport,
} from "./migration/destination.js";
export { importMigrationBundle } from "./migration/importer.js";
export type { MigrationImportOptions, MigrationImportResult, MigrationImportStatus } from "./migration/importer.js";
export { registerDataMigrationGlobals } from "./migration/browserBindings.js";
