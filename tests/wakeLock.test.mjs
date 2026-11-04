import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import {
  getWakeLockOwnersForTests,
  isWakeLockHeldForTests,
  reacquireWakeLockIfNeeded,
  releaseWakeLock,
  requestWakeLock,
  resetWakeLockForTests,
  setWakeLockPlatformForTests,
} from "../dist/wakeLock.js";
import {
  acquireRestingHrWakeLock,
  forceReleaseRestingHrWakeLock,
  getRestingHrWakeLockTokenForTests,
  invalidateRestingHrWakeLockAcquire,
  releaseRestingHrWakeLock,
  resetRestingHrWakeLockForTests,
  runExclusiveRestingHrStart,
} from "../dist/restingHrWakeLock.js";
import {
  createRestingHrAcquisition,
  evaluateRestingHrStartReadiness,
} from "../dist/restingHrAcquisition.js";
import { shouldInstallRestingHrTickTimer } from "../dist/restingHrSessionUi.js";

function createFakePlatform(options = {}) {
  const failAcquire = options.failAcquire === true;
  let held = false;
  let releaseCount = 0;
  let acquireCount = 0;
  let pendingAcquire = null;
  let resolvePending = null;

  return {
    get acquireCount() {
      return acquireCount;
    },
    get releaseCount() {
      return releaseCount;
    },
    get held() {
      return held;
    },
    deferNextAcquire() {
      pendingAcquire = new Promise((res) => {
        resolvePending = res;
      });
    },
    resolveDeferredAcquire() {
      if (resolvePending) resolvePending();
      resolvePending = null;
      pendingAcquire = null;
    },
    simulateSystemRelease() {
      held = false;
    },
    platform: {
      async acquire() {
        acquireCount += 1;
        // Only the acquire that was pending consumes the deferral, so a later
        // restart can hold the lock while the delayed request is still settling.
        const wait = pendingAcquire;
        pendingAcquire = null;
        if (wait) await wait;
        if (failAcquire) return false;
        held = true;
        return true;
      },
      async release() {
        if (!held) return;
        held = false;
        releaseCount += 1;
      },
      isHeld() {
        return held;
      },
    },
  };
}

let fake;

beforeEach(async () => {
  resetRestingHrWakeLockForTests();
  await resetWakeLockForTests();
  fake = createFakePlatform();
  setWakeLockPlatformForTests(fake.platform);
});

afterEach(async () => {
  await resetWakeLockForTests();
  resetRestingHrWakeLockForTests();
  fake = null;
});

test("resting-HR acquire claims ownership before measurement may begin", async () => {
  const result = await acquireRestingHrWakeLock();
  assert.equal(result.status, "acquired");
  assert.deepEqual(getWakeLockOwnersForTests(), ["restingHr"]);
  assert.equal(isWakeLockHeldForTests(), true);
  assert.equal(fake.acquireCount, 1);
  assert.equal(getRestingHrWakeLockTokenForTests(), result.token);
});

test("acquisition failure prevents an unprotected resting-HR session", async () => {
  await resetWakeLockForTests();
  fake = createFakePlatform({ failAcquire: true });
  setWakeLockPlatformForTests(fake.platform);
  const result = await acquireRestingHrWakeLock();
  assert.equal(result.status, "failed");
  assert.deepEqual(getWakeLockOwnersForTests(), []);
  assert.equal(isWakeLockHeldForTests(), false);
});

test("normal completion release drops only resting-HR ownership", async () => {
  const acquired = await acquireRestingHrWakeLock();
  assert.equal(acquired.status, "acquired");
  await releaseRestingHrWakeLock(acquired.token);
  assert.deepEqual(getWakeLockOwnersForTests(), []);
  assert.equal(isWakeLockHeldForTests(), false);
  assert.equal(fake.releaseCount, 1);
});

test("cancel release drops resting-HR ownership", async () => {
  const acquired = await acquireRestingHrWakeLock();
  assert.equal(acquired.status, "acquired");
  invalidateRestingHrWakeLockAcquire();
  await releaseRestingHrWakeLock(acquired.token);
  assert.deepEqual(getWakeLockOwnersForTests(), []);
  assert.equal(isWakeLockHeldForTests(), false);
});

test("disconnect-style release drops resting-HR ownership", async () => {
  const acquired = await acquireRestingHrWakeLock();
  assert.equal(acquired.status, "acquired");
  await releaseRestingHrWakeLock(acquired.token);
  assert.deepEqual(getWakeLockOwnersForTests(), []);
  assert.equal(isWakeLockHeldForTests(), false);
});

test("workout interruption releases only resting-HR ownership", async () => {
  assert.equal(await requestWakeLock("workout"), true);
  const acquired = await acquireRestingHrWakeLock();
  assert.equal(acquired.status, "acquired");
  assert.deepEqual(getWakeLockOwnersForTests(), ["restingHr", "workout"]);
  await releaseRestingHrWakeLock(acquired.token);
  assert.deepEqual(getWakeLockOwnersForTests(), ["workout"]);
  assert.equal(isWakeLockHeldForTests(), true);
  assert.equal(fake.releaseCount, 0);
  await releaseWakeLock("workout");
  assert.equal(isWakeLockHeldForTests(), false);
  assert.equal(fake.releaseCount, 1);
});

test("cancel during pending acquisition does not leak a wake lock", async () => {
  fake.deferNextAcquire();
  const pending = acquireRestingHrWakeLock();
  invalidateRestingHrWakeLockAcquire();
  await forceReleaseRestingHrWakeLock();
  fake.resolveDeferredAcquire();
  const result = await pending;
  assert.equal(result.status, "stale");
  assert.deepEqual(getWakeLockOwnersForTests(), []);
  assert.equal(isWakeLockHeldForTests(), false);
});

test("start A cancel A start B then late A cannot release B or suppress B", async () => {
  fake.deferNextAcquire();

  let aFinished = false;
  let aToken = null;
  const startA = runExclusiveRestingHrStart(async () => {
    const wake = await acquireRestingHrWakeLock();
    // Cancel happened while A was awaiting: settle is stale and must not keep a claim.
    assert.equal(wake.status, "stale");
    aFinished = true;
  });

  // Let A enter the deferred platform acquire before cancel.
  await Promise.resolve();
  await Promise.resolve();

  invalidateRestingHrWakeLockAcquire();
  await forceReleaseRestingHrWakeLock();

  let bToken = null;
  const startB = runExclusiveRestingHrStart(async () => {
    // B must not run until A's exclusive body finishes (including late settle).
    assert.equal(aFinished, true);
    const wake = await acquireRestingHrWakeLock();
    assert.equal(wake.status, "acquired");
    bToken = wake.token;
  });

  // Late platform success for A after cancel; B is queued behind A's exclusive cleanup.
  fake.resolveDeferredAcquire();
  await startA;
  await startB;

  assert.equal(bToken != null, true);
  assert.deepEqual(getWakeLockOwnersForTests(), ["restingHr"]);
  assert.equal(isWakeLockHeldForTests(), true);
  assert.equal(getRestingHrWakeLockTokenForTests(), bToken);

  // Late release with a non-current token must not drop B.
  aToken = bToken - 1;
  await releaseRestingHrWakeLock(aToken);
  assert.deepEqual(getWakeLockOwnersForTests(), ["restingHr"]);
  assert.equal(isWakeLockHeldForTests(), true);

  await releaseRestingHrWakeLock(bToken);
  assert.deepEqual(getWakeLockOwnersForTests(), []);
  assert.equal(isWakeLockHeldForTests(), false);
});

test("stale acquire after newer holder does not leave the screen permanently awake or steal B", async () => {
  fake.deferNextAcquire();
  const pendingA = acquireRestingHrWakeLock();
  await Promise.resolve();
  await Promise.resolve();

  invalidateRestingHrWakeLockAcquire();
  await forceReleaseRestingHrWakeLock();

  // B starts and holds while A's delayed platform request is still outstanding.
  const b = await acquireRestingHrWakeLock();
  assert.equal(b.status, "acquired");
  assert.deepEqual(getWakeLockOwnersForTests(), ["restingHr"]);
  assert.equal(isWakeLockHeldForTests(), true);

  fake.resolveDeferredAcquire();
  const a = await pendingA;
  assert.equal(a.status, "stale");
  // Stale A must not release B or leave an orphaned held state without owners.
  assert.deepEqual(getWakeLockOwnersForTests(), ["restingHr"]);
  assert.equal(isWakeLockHeldForTests(), true);
  assert.equal(getRestingHrWakeLockTokenForTests(), b.token);

  await releaseRestingHrWakeLock(b.token);
  assert.equal(isWakeLockHeldForTests(), false);
});

test("repeated start/cancel cycles do not accumulate ownership", async () => {
  for (let i = 0; i < 5; i += 1) {
    const acquired = await acquireRestingHrWakeLock();
    assert.equal(acquired.status, "acquired");
    invalidateRestingHrWakeLockAcquire();
    await releaseRestingHrWakeLock(acquired.token);
  }
  assert.deepEqual(getWakeLockOwnersForTests(), []);
  assert.equal(isWakeLockHeldForTests(), false);
  assert.equal(fake.releaseCount, 5);
  assert.equal(fake.acquireCount, 5);
});

test("ordinary workout wake-lock default owner behavior remains unchanged", async () => {
  assert.equal(await requestWakeLock(), true);
  assert.deepEqual(getWakeLockOwnersForTests(), ["workout"]);
  assert.equal(isWakeLockHeldForTests(), true);
  await releaseWakeLock();
  assert.deepEqual(getWakeLockOwnersForTests(), []);
  assert.equal(isWakeLockHeldForTests(), false);
});

test("visibility/resume reacquires without duplicating owners", async () => {
  const acquired = await acquireRestingHrWakeLock();
  assert.equal(acquired.status, "acquired");
  assert.equal(fake.acquireCount, 1);

  fake.simulateSystemRelease();
  assert.equal(isWakeLockHeldForTests(), false);
  assert.deepEqual(getWakeLockOwnersForTests(), ["restingHr"]);

  await reacquireWakeLockIfNeeded();
  assert.equal(isWakeLockHeldForTests(), true);
  assert.deepEqual(getWakeLockOwnersForTests(), ["restingHr"]);
  assert.equal(fake.acquireCount, 2);

  await reacquireWakeLockIfNeeded();
  assert.deepEqual(getWakeLockOwnersForTests(), ["restingHr"]);
  assert.equal(fake.acquireCount, 2);
});

test("tick timer installs only while the exact measurement is still active", () => {
  const state = createRestingHrAcquisition({
    startedAtMonoMs: 0,
    measurementId: "measure-1",
    athleteId: "athlete-test",
  });
  assert.equal(shouldInstallRestingHrTickTimer(state, "measure-1"), true);
  assert.equal(shouldInstallRestingHrTickTimer(state, "other"), false);
  assert.equal(shouldInstallRestingHrTickTimer(null, "measure-1"), false);

  // Early disconnect / cancel terminates the acquisition before setInterval.
  state.status = "rejected";
  state.rejectReason = "disconnected";
  assert.equal(shouldInstallRestingHrTickTimer(state, "measure-1"), false);

  const cancelled = createRestingHrAcquisition({
    startedAtMonoMs: 0,
    measurementId: "measure-2",
    athleteId: "athlete-test",
  });
  cancelled.status = "cancelled";
  cancelled.rejectReason = "interrupted";
  assert.equal(shouldInstallRestingHrTickTimer(cancelled, "measure-2"), false);
});

test("readiness after delayed wake-lock acquire refuses disconnect and active workout", async () => {
  fake.deferNextAcquire();
  const pending = acquireRestingHrWakeLock();

  // Strap drops / workout starts while acquire is in flight.
  const disconnected = evaluateRestingHrStartReadiness({
    connected: false,
    workoutInProgress: false,
    measurementInProgress: false,
  });
  assert.equal(disconnected.ok, false);
  assert.equal(disconnected.reason, "not_connected");

  const workoutActive = evaluateRestingHrStartReadiness({
    connected: true,
    workoutInProgress: true,
    measurementInProgress: false,
  });
  assert.equal(workoutActive.ok, false);
  assert.equal(workoutActive.reason, "workout_in_progress");

  fake.resolveDeferredAcquire();
  const wake = await pending;
  assert.equal(wake.status, "acquired");

  // Mimic UI: release ownership and do not start when post-await readiness fails.
  await releaseRestingHrWakeLock(wake.token);
  assert.deepEqual(getWakeLockOwnersForTests(), []);
  assert.equal(isWakeLockHeldForTests(), false);
});

test("disconnect during pending acquisition releases ownership without starting", async () => {
  fake.deferNextAcquire();
  const pending = acquireRestingHrWakeLock();
  invalidateRestingHrWakeLockAcquire();
  await forceReleaseRestingHrWakeLock();
  fake.resolveDeferredAcquire();
  const result = await pending;
  assert.equal(result.status, "stale");
  assert.deepEqual(getWakeLockOwnersForTests(), []);
  assert.equal(isWakeLockHeldForTests(), false);
  assert.equal(getRestingHrWakeLockTokenForTests(), null);
});

test("workout becoming active during pending acquisition releases ownership without starting", async () => {
  fake.deferNextAcquire();
  const pending = acquireRestingHrWakeLock();

  const readiness = evaluateRestingHrStartReadiness({
    connected: true,
    workoutInProgress: true,
    measurementInProgress: false,
  });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.reason, "workout_in_progress");

  fake.resolveDeferredAcquire();
  const wake = await pending;
  assert.equal(wake.status, "acquired");
  await releaseRestingHrWakeLock(wake.token);
  assert.deepEqual(getWakeLockOwnersForTests(), []);
  assert.equal(isWakeLockHeldForTests(), false);
});
