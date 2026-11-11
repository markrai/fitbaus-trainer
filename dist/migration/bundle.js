/**
 * Pure migration-bundle operations: build, parse, structural validation,
 * unknown-source-state gate, and summary. No destination storage access.
 */
import { LEGACY_DB_NAME, LEGACY_PACKAGE_ID, MIGRATION_FORMAT, MIGRATION_SCHEMA_VERSION, MIGRATION_STORE_NAMES, MigrationError, STORE_KEY_PATHS, classifyLegacyLocalStorageKey, destinationKeyForLegacyKey, } from "./contracts.js";
import { computeBundleDigest, sha256Hex } from "./integrity.js";
import { assertMigrationJsonLossless, canonicalStringify, compareCanonicalText, countUndefinedProperties, isRecord, } from "./serialization.js";
export function deriveStoreKey(store, row) {
    const keyPath = STORE_KEY_PATHS[store];
    if (typeof keyPath === "string")
        return row[keyPath];
    return keyPath.map((part) => row[part]);
}
export function canonicalKeyText(key) {
    return canonicalStringify(key !== null && key !== void 0 ? key : null);
}
export function sortStoreEntries(entries) {
    return [...entries].sort((a, b) => compareCanonicalText(canonicalKeyText(a.key), canonicalKeyText(b.key)));
}
export async function buildMigrationBundle(input) {
    var _a, _b, _c, _d, _e;
    const stores = {};
    const storeCounts = {};
    for (const name of MIGRATION_STORE_NAMES) {
        const rows = (_a = input.storeRows[name]) !== null && _a !== void 0 ? _a : [];
        // Lossless preflight BEFORE any bundle is created: row + primary key.
        rows.forEach((row, index) => {
            let keyLabel = `row ${index}`;
            try {
                const k = deriveStoreKey(name, row);
                assertMigrationJsonLossless(k, `${name} primary key (row ${index})`);
                keyLabel = canonicalKeyText(k);
            }
            catch (error) {
                if (error instanceof MigrationError && error.code === "UNSUPPORTED_STORED_VALUE")
                    throw error;
                throw error;
            }
            assertMigrationJsonLossless(row, `${name}[${keyLabel}]`);
        });
        const entries = sortStoreEntries(rows.map((row) => ({ key: deriveStoreKey(name, row), value: row })));
        const seen = new Set();
        for (const entry of entries) {
            const text = canonicalKeyText(entry.key);
            if (seen.has(text))
                throw new Error(`Duplicate primary key in ${name}: ${text}`);
            seen.add(text);
        }
        stores[name] = entries;
        storeCounts[name] = entries.length;
    }
    const localStorageEntries = [];
    const excluded = [];
    const unknown = [];
    for (const { key, value } of [...input.localEntries].sort((a, b) => compareCanonicalText(a.key, b.key))) {
        const classification = classifyLegacyLocalStorageKey(key);
        const destination = destinationKeyForLegacyKey(key);
        if (destination !== null && (classification === "MIGRATE_EXACTLY" || classification === "MIGRATE_WITH_KEY_RENAME")) {
            localStorageEntries.push({ source_key: key, destination_key: destination, classification, value });
        }
        else if (classification === "TRANSIENT_DO_NOT_MIGRATE") {
            excluded.push({ key, classification });
        }
        else {
            unknown.push({ key, value_sha256: await sha256Hex(value) });
        }
    }
    localStorageEntries.sort((a, b) => compareCanonicalText(a.destination_key, b.destination_key));
    const storeDigests = {};
    for (const name of MIGRATION_STORE_NAMES) {
        storeDigests[name] = await sha256Hex(canonicalStringify(stores[name]));
    }
    const sectionDigests = {
        indexeddb: await sha256Hex(canonicalStringify(stores)),
        local_storage: await sha256Hex(canonicalStringify(localStorageEntries)),
    };
    let undefinedDropped = 0;
    for (const name of MIGRATION_STORE_NAMES) {
        for (const row of (_b = input.storeRows[name]) !== null && _b !== void 0 ? _b : [])
            undefinedDropped += countUndefinedProperties(row);
    }
    const bundleWithoutDigest = {
        format: MIGRATION_FORMAT,
        schema_version: MIGRATION_SCHEMA_VERSION,
        exported_at: input.exportedAt,
        undefined_properties_dropped: undefinedDropped,
        source: {
            package_id: LEGACY_PACKAGE_ID,
            app_version: (_c = input.appVersion) !== null && _c !== void 0 ? _c : null,
            indexeddb_name: LEGACY_DB_NAME,
            indexeddb_version: (_d = input.sourceDbVersion) !== null && _d !== void 0 ? _d : null,
            store_names: [...MIGRATION_STORE_NAMES],
        },
        indexeddb: { stores },
        local_storage: localStorageEntries,
        excluded_local_keys: excluded,
        unknown_local_keys: unknown,
        unknown_stores: (_e = input.unknownStores) !== null && _e !== void 0 ? _e : [],
    };
    const bundleDigest = await computeBundleDigest(bundleWithoutDigest, sectionDigests, storeDigests);
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
export function parseMigrationBundleJson(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new MigrationError("INVALID_JSON", "Migration file is not valid JSON (corrupt or truncated).");
    }
    return validateMigrationBundleStructure(parsed);
}
export function validateMigrationBundleStructure(bundle) {
    var _a;
    if (!isRecord(bundle))
        throw new MigrationError("INVALID_BUNDLE", "Migration bundle must be an object.");
    if (bundle.format !== MIGRATION_FORMAT) {
        throw new MigrationError("WRONG_FORMAT", `Expected format "${MIGRATION_FORMAT}".`);
    }
    if (bundle.schema_version !== MIGRATION_SCHEMA_VERSION) {
        throw new MigrationError("UNSUPPORTED_SCHEMA_VERSION", `Unsupported migration schema version: ${String(bundle.schema_version)}`);
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
        if (!MIGRATION_STORE_NAMES.includes(name)) {
            throw new MigrationError("MALFORMED_INDEXEDDB", `Unknown IndexedDB store in bundle: ${name}`);
        }
    }
    const stores = {};
    for (const name of MIGRATION_STORE_NAMES) {
        const rawEntries = (_a = indexeddb.stores[name]) !== null && _a !== void 0 ? _a : [];
        if (!Array.isArray(rawEntries)) {
            throw new MigrationError("MALFORMED_INDEXEDDB", `Store ${name} must be an array.`);
        }
        const seen = new Set();
        const entries = [];
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
        // Keep the bundle's stored order: digests are verified over it, so bundles from
        // any exporter ordering (including legacy localeCompare order) stay valid.
        stores[name] = entries;
    }
    if (!Array.isArray(bundle.local_storage)) {
        throw new MigrationError("MALFORMED_LOCAL_STORAGE", "Bundle localStorage section is malformed.");
    }
    const localEntries = [];
    const seenDestinations = new Set();
    for (const raw of bundle.local_storage) {
        if (!isRecord(raw) || typeof raw.source_key !== "string" || typeof raw.value !== "string") {
            throw new MigrationError("MALFORMED_LOCAL_STORAGE", "Bundle localStorage entry is malformed.");
        }
        const expectedDestination = destinationKeyForLegacyKey(raw.source_key);
        if (expectedDestination === null) {
            throw new MigrationError("MALFORMED_LOCAL_STORAGE", `Key ${raw.source_key} is transient/unknown and must not be in the migration payload.`);
        }
        if (raw.destination_key !== expectedDestination) {
            throw new MigrationError("MALFORMED_LOCAL_STORAGE", `Key ${raw.source_key} maps to ${expectedDestination}, not ${String(raw.destination_key)}.`);
        }
        if (seenDestinations.has(expectedDestination)) {
            throw new MigrationError("MALFORMED_LOCAL_STORAGE", `Duplicate destination key ${expectedDestination}.`);
        }
        seenDestinations.add(expectedDestination);
        localEntries.push({
            source_key: raw.source_key,
            destination_key: expectedDestination,
            classification: classifyLegacyLocalStorageKey(raw.source_key),
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
        ...bundle,
        indexeddb: { stores },
        local_storage: localEntries,
    };
}
export function getUnreviewedSourceState(bundle) {
    var _a, _b;
    return {
        unknownLocalKeys: ((_a = bundle.unknown_local_keys) !== null && _a !== void 0 ? _a : []).map((e) => e.key),
        unknownStores: ((_b = bundle.unknown_stores) !== null && _b !== void 0 ? _b : []).map((e) => ({ name: e.name, record_count: e.record_count })),
    };
}
export function isMigrationBundleImportable(bundle) {
    const u = getUnreviewedSourceState(bundle);
    return u.unknownLocalKeys.length === 0 && u.unknownStores.length === 0;
}
export function assertMigrationBundleImportable(bundle) {
    const u = getUnreviewedSourceState(bundle);
    if (u.unknownLocalKeys.length === 0 && u.unknownStores.length === 0)
        return;
    const parts = [];
    if (u.unknownLocalKeys.length)
        parts.push(`unknown local keys: ${u.unknownLocalKeys.join(", ")}`);
    if (u.unknownStores.length) {
        parts.push(`unknown stores: ${u.unknownStores.map((s) => `${s.name} (${s.record_count} records)`).join(", ")}`);
    }
    throw new MigrationError("UNREVIEWED_SOURCE_STATE", `Migration bundle contains unreviewed source state (${parts.join("; ")}). Import blocked; no data was changed.`);
}
export function summarizeMigrationBundle(bundle) {
    var _a, _b, _c, _d;
    return {
        exportedAt: bundle.exported_at,
        sourcePackageId: bundle.source.package_id,
        appVersion: bundle.source.app_version,
        storeCounts: { ...bundle.manifest.store_counts },
        localStorageCount: bundle.manifest.local_storage_count,
        undefinedPropertiesDropped: (_a = bundle.undefined_properties_dropped) !== null && _a !== void 0 ? _a : 0,
        unknownLocalKeys: ((_b = bundle.unknown_local_keys) !== null && _b !== void 0 ? _b : []).map((entry) => entry.key),
        unknownStores: ((_c = bundle.unknown_stores) !== null && _c !== void 0 ? _c : []).map((e) => ({ name: e.name, record_count: e.record_count })),
        excludedLocalKeys: ((_d = bundle.excluded_local_keys) !== null && _d !== void 0 ? _d : []).map((entry) => entry.key),
        bundleDigest: bundle.manifest.bundle_digest,
    };
}
