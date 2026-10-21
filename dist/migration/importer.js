/**
 * Import orchestration: receipt/idempotence policy, destination-empty
 * preflight, single-transaction writes, and verified rollback.
 */
import { LEGACY_PACKAGE_ID, MIGRATION_FORMAT, MIGRATION_SCHEMA_VERSION, MIGRATION_STORE_NAMES, MigrationError, } from "./contracts.js";
import { assertMigrationBundleImportable, summarizeMigrationBundle, validateMigrationBundleStructure, } from "./bundle.js";
import { MIGRATION_RECEIPT_KEY, inspectDestinationLocalState, openDestinationDb, readAllDestinationStores, txDone, verifyDestinationAgainstBundle, } from "./destination.js";
import { sha256Hex, verifyMigrationBundleIntegrity } from "./integrity.js";
import { canonicalStringify, isRecord } from "./serialization.js";
export async function importMigrationBundle(bundleInput, options) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const bundle = validateMigrationBundleStructure(bundleInput);
    const summary = summarizeMigrationBundle(bundle);
    await verifyMigrationBundleIntegrity(bundle);
    // §2 hard gate: unknown source state blocks before any destination access/write.
    assertMigrationBundleImportable(bundle);
    const storage = options.storage;
    const factory = (_a = options.indexedDBFactory) !== null && _a !== void 0 ? _a : globalThis.indexedDB;
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
            let receipt = null;
            let malformed = false;
            try {
                receipt = JSON.parse(receiptRaw);
            }
            catch {
                malformed = true;
            }
            if (!malformed && (!isRecord(receipt) || typeof receipt.bundle_digest !== "string"))
                malformed = true;
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
            const receiptDigest = receipt.bundle_digest;
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
                        message: "A prior import receipt exists for this bundle, but stored data no longer matches it; manual review is required. No data was changed.",
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
            if (destinationStores[name].length > 0)
                reasons.push(`destination store ${name} is not empty`);
        }
        const preflight = {
            state: reasons.length === 0 ? "EMPTY_BOOTSTRAP_STATE" : "MEANINGFUL_USER_DATA",
            reasons,
            bootstrapKeysPresent: preflightLocal.bootstrapKeysPresent,
        };
        if (preflight.state === "MEANINGFUL_USER_DATA") {
            return { status: "DESTINATION_NOT_EMPTY", summary, destinationPreflight: preflight };
        }
        // Snapshot everything we may touch (bootstrap state + empty stores) for rollback.
        const localSnapshot = new Map();
        for (const key of storage.keys())
            localSnapshot.set(key, storage.getItem(key));
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
                    if (((_b = options.faultInjection) === null || _b === void 0 ? void 0 : _b.failBeforeStoreWrite) === name) {
                        throw new MigrationError("INJECTED_IDB_FAILURE", `Injected failure before writing ${name}`);
                    }
                    const store = tx.objectStore(name);
                    for (const entry of bundle.indexeddb.stores[name])
                        store.put(entry.value);
                }
                await txPromise;
            }
            catch (txError) {
                try {
                    tx.abort();
                }
                catch {
                    /* already finished/aborted */
                }
                await txPromise.catch(() => undefined);
                throw txError;
            }
            // 2) localStorage: write exact strings to destination keys.
            for (const entry of bundle.local_storage) {
                if (((_c = options.faultInjection) === null || _c === void 0 ? void 0 : _c.failOnLocalStorageKey) === entry.destination_key) {
                    throw new MigrationError("INJECTED_LOCALSTORAGE_FAILURE", "Injected localStorage failure");
                }
                storage.setItem(entry.destination_key, entry.value);
            }
            // 3) Receipt (written before final verification so verification covers the full state).
            const receipt = {
                schema_version: MIGRATION_SCHEMA_VERSION,
                bundle_digest: bundle.manifest.bundle_digest,
                imported_at: ((_e = (_d = options.now) === null || _d === void 0 ? void 0 : _d.call(options)) !== null && _e !== void 0 ? _e : new Date()).toISOString(),
                source_package_id: LEGACY_PACKAGE_ID,
                format: MIGRATION_FORMAT,
            };
            storage.setItem(MIGRATION_RECEIPT_KEY, JSON.stringify(receipt));
            // 4) Post-import verification.
            const verification = await verifyDestinationAgainstBundle(bundle, storage, db);
            if (verification.status !== "VERIFIED_MATCH") {
                throw new MigrationError("POST_IMPORT_MISMATCH", `Post-import verification failed: ${verification.mismatches.join("; ")}`);
            }
            return { status: "IMPORTED_VERIFIED", summary, verification, destinationPreflight: preflight };
        }
        catch (error) {
            // Rollback (§3): restore IDB + localStorage (incl. receipt state, which
            // is part of the local snapshot), then VERIFY against the pre-import
            // snapshot. Only a verified restoration may be FAILED_ROLLED_BACK.
            let rollbackFailed = false;
            try {
                if ((_f = options.faultInjection) === null || _f === void 0 ? void 0 : _f.failIdbRollback) {
                    throw new MigrationError("INJECTED_IDB_ROLLBACK_FAILURE", "Injected IndexedDB rollback failure");
                }
                const rollbackTx = db.transaction([...MIGRATION_STORE_NAMES], "readwrite");
                const rollbackDone = txDone(rollbackTx);
                try {
                    for (const name of MIGRATION_STORE_NAMES) {
                        const store = rollbackTx.objectStore(name);
                        store.clear();
                        for (const entry of storeSnapshot[name])
                            store.put(entry.value);
                    }
                    await rollbackDone;
                }
                catch (rbError) {
                    try {
                        rollbackTx.abort();
                    }
                    catch {
                        /* ignore */
                    }
                    await rollbackDone.catch(() => undefined);
                    throw rbError;
                }
            }
            catch {
                rollbackFailed = true;
            }
            try {
                if ((_g = options.faultInjection) === null || _g === void 0 ? void 0 : _g.failLocalStorageRollback) {
                    throw new MigrationError("INJECTED_LOCALSTORAGE_ROLLBACK_FAILURE", "Injected localStorage rollback failure");
                }
                for (const key of storage.keys()) {
                    if (!localSnapshot.has(key))
                        storage.removeItem(key);
                }
                for (const [key, value] of localSnapshot) {
                    if (value === null)
                        storage.removeItem(key);
                    else
                        storage.setItem(key, value);
                }
            }
            catch {
                rollbackFailed = true;
            }
            if ((_h = options.faultInjection) === null || _h === void 0 ? void 0 : _h.corruptAfterRollback) {
                try {
                    storage.setItem("__rollback_verification_sabotage__", "1");
                }
                catch {
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
                        if (restoredDigest !== snapshotDigest)
                            verified = false;
                    }
                    const restoredKeys = storage.keys().slice().sort();
                    const snapshotKeys = [...localSnapshot.keys()].sort();
                    if (canonicalStringify(restoredKeys) !== canonicalStringify(snapshotKeys))
                        verified = false;
                    else {
                        for (const [key, value] of localSnapshot) {
                            if (storage.getItem(key) !== value)
                                verified = false;
                        }
                    }
                }
                catch {
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
    }
    finally {
        db.close();
    }
}
