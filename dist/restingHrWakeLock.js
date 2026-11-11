/**
 * Resting-HR ownership over the shared screen wake lock.
 * Acquires before measurement begins; releases are token-scoped so a stale
 * attempt cannot drop a newer measurement's claim.
 */
import { releaseWakeLock, requestWakeLock } from "./wakeLock.js";
let acquireGeneration = 0;
/** Token of the resting-HR attempt that currently owns the shared claim, if any. */
let heldToken = null;
/** Serializes start attempts so cancel/cleanup of A completes before B acquires. */
let startChain = Promise.resolve();
/**
 * Run one resting-HR start body exclusively. The previous attempt's cleanup
 * (including a late wake-lock settle) finishes before the next body runs.
 */
export async function runExclusiveRestingHrStart(fn) {
    let release;
    const done = new Promise((resolve) => {
        release = () => resolve();
    });
    const previous = startChain;
    startChain = previous.then(() => done);
    await previous;
    try {
        return await fn();
    }
    finally {
        release();
    }
}
/**
 * Request resting-HR wake-lock ownership. Callers must not start measuring
 * unless the result is `{ status: "acquired", token }`, and must release with
 * that same token.
 */
export async function acquireRestingHrWakeLock() {
    const token = ++acquireGeneration;
    const ok = await requestWakeLock("restingHr");
    if (token !== acquireGeneration) {
        // Stale: a newer attempt (or cancel) owns the generation. Never release
        // here — cancel already dropped a pending claim, and a newer holder must
        // keep the screen awake.
        return { status: "stale" };
    }
    if (!ok) {
        return { status: "failed" };
    }
    heldToken = token;
    return { status: "acquired", token };
}
/** Invalidate any in-flight acquire (cancel / supersede). */
export function invalidateRestingHrWakeLockAcquire() {
    acquireGeneration += 1;
}
/**
 * Release only if `token` is still the active resting-HR holder.
 * A late cleanup from attempt A is a no-op once attempt B holds the claim.
 */
export async function releaseRestingHrWakeLock(token) {
    if (heldToken !== token)
        return;
    heldToken = null;
    await releaseWakeLock("restingHr");
}
/**
 * Cancel-time release for a pending acquire that never published a token, or
 * for the active token when ending the current attempt. Safe under the start
 * mutex: only the current attempt is in flight.
 */
export async function forceReleaseRestingHrWakeLock() {
    heldToken = null;
    await releaseWakeLock("restingHr");
}
export function getRestingHrWakeLockTokenForTests() {
    return heldToken;
}
export function resetRestingHrWakeLockForTests() {
    acquireGeneration = 0;
    heldToken = null;
    startChain = Promise.resolve();
}
