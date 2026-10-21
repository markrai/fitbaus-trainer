/** SHA-256 digests over canonical JSON and bundle integrity verification. */
import { MIGRATION_STORE_NAMES, MigrationError } from "./contracts.js";
import { canonicalStringify } from "./serialization.js";
export async function sha256Hex(text) {
    var _a;
    const subtle = (_a = globalThis.crypto) === null || _a === void 0 ? void 0 : _a.subtle;
    if (!subtle)
        throw new Error("SHA-256 (crypto.subtle) unavailable");
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/**
 * Whole-bundle digest. Input is every bundle field except `manifest`, plus the
 * section and per-store digests, as canonical JSON. Shared by build and verify.
 */
export function computeBundleDigest(bundleWithoutManifest, sectionDigests, storeDigests) {
    return sha256Hex(canonicalStringify({ ...bundleWithoutManifest, section_digests: sectionDigests, store_digests: storeDigests }));
}
export async function verifyMigrationBundleIntegrity(bundle) {
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
    const bundleDigest = await computeBundleDigest(rest, bundle.manifest.section_digests, bundle.manifest.store_digests);
    if (bundleDigest !== bundle.manifest.bundle_digest) {
        throw new MigrationError("DIGEST_MISMATCH", "Whole-bundle digest mismatch.");
    }
}
