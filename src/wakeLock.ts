import { isNativeRuntime } from "./platform/runtime.js";

/** Callers that may hold the shared screen wake lock. */
export type WakeLockOwner = "workout" | "restingHr";

type WakeLockPlatform = {
  acquire: () => Promise<boolean>;
  release: () => Promise<void>;
  isHeld: () => boolean;
};

let wakeLock: any = null;
let nativeWakeLockActive = false;
let nativeWakeLockOperation: Promise<void> = Promise.resolve();
const owners = new Set<WakeLockOwner>();
let platformOverride: WakeLockPlatform | null = null;

function defaultWebPlatform(): WakeLockPlatform {
  return {
    async acquire() {
      if (wakeLock) return true;
      try {
        if (!("wakeLock" in navigator)) {
          console.warn("Wake Lock API not supported");
          return false;
        }
        // @ts-ignore - Wake Lock types not universally available
        wakeLock = await (navigator as any).wakeLock.request("screen");
        wakeLock.addEventListener("release", () => {
          console.log("Wake lock released by system");
          wakeLock = null;
        });
        console.log("Wake lock activated");
        return true;
      } catch (error) {
        console.error("Error requesting wake lock:", error);
        wakeLock = null;
        return false;
      }
    },
    async release() {
      if (!wakeLock) return;
      try {
        await wakeLock.release();
        wakeLock = null;
        console.log("Wake lock released");
      } catch (error) {
        console.error("Error releasing wake lock:", error);
        wakeLock = null;
      }
    },
    isHeld() {
      return wakeLock != null;
    },
  };
}

function defaultNativePlatform(): WakeLockPlatform {
  return {
    async acquire() {
      nativeWakeLockOperation = nativeWakeLockOperation
        .catch(() => {})
        .then(async () => {
          if (owners.size === 0) {
            if (!nativeWakeLockActive) return;
            const { releaseNativeWakeLock } = await import("./platform/nativeWakeLock.js");
            await releaseNativeWakeLock();
            nativeWakeLockActive = false;
            console.log("Wake lock released");
            return;
          }
          if (nativeWakeLockActive) return;
          const { acquireNativeWakeLock } = await import("./platform/nativeWakeLock.js");
          const acquired = await acquireNativeWakeLock();
          nativeWakeLockActive = acquired;
          if (acquired) console.log("Wake lock activated");
          if (nativeWakeLockActive && owners.size === 0) {
            const { releaseNativeWakeLock } = await import("./platform/nativeWakeLock.js");
            await releaseNativeWakeLock();
            nativeWakeLockActive = false;
            console.log("Wake lock released");
          }
        });
      await nativeWakeLockOperation;
      return nativeWakeLockActive;
    },
    async release() {
      nativeWakeLockOperation = nativeWakeLockOperation
        .catch(() => {})
        .then(async () => {
          if (owners.size > 0 || !nativeWakeLockActive) return;
          const { releaseNativeWakeLock } = await import("./platform/nativeWakeLock.js");
          await releaseNativeWakeLock();
          nativeWakeLockActive = false;
          console.log("Wake lock released");
        });
      await nativeWakeLockOperation;
    },
    isHeld() {
      return nativeWakeLockActive;
    },
  };
}

function activePlatform(): WakeLockPlatform {
  if (platformOverride) return platformOverride;
  return isNativeRuntime() ? defaultNativePlatform() : defaultWebPlatform();
}

function isPlatformHeld(): boolean {
  return activePlatform().isHeld();
}

async function syncPlatformToOwners(): Promise<boolean> {
  const platform = activePlatform();
  if (owners.size > 0) {
    return platform.acquire();
  }
  await platform.release();
  return false;
}

/**
 * Acquire (or retain) the shared screen wake lock for `owner`.
 * Default owner is `workout` so existing call sites stay unchanged.
 * Returns false when the platform lock could not be held for this owner.
 */
async function requestWakeLock(owner: WakeLockOwner = "workout"): Promise<boolean> {
  owners.add(owner);
  try {
    const held = await syncPlatformToOwners();
    if (!owners.has(owner)) {
      await syncPlatformToOwners();
      return false;
    }
    if (!held) {
      owners.delete(owner);
      await syncPlatformToOwners();
      return false;
    }
    return true;
  } catch (error) {
    console.error("Error requesting wake lock:", error);
    owners.delete(owner);
    try {
      await syncPlatformToOwners();
    } catch {
      /* ignore follow-up release errors */
    }
    return false;
  }
}

/**
 * Drop `owner`'s claim on the shared wake lock. The platform lock is released
 * only when no owners remain, so ending resting-HR never clears an active workout lock.
 */
async function releaseWakeLock(owner: WakeLockOwner = "workout"): Promise<void> {
  owners.delete(owner);
  try {
    await syncPlatformToOwners();
  } catch (error) {
    console.error("Error releasing wake lock:", error);
  }
}

/** Reacquire the platform lock when owners still expect it (visibility/resume). */
async function reacquireWakeLockIfNeeded(): Promise<void> {
  if (owners.size === 0 || isPlatformHeld()) return;
  try {
    await activePlatform().acquire();
  } catch (error) {
    console.error("Error requesting wake lock:", error);
  }
}

export function registerWakeLockGlobals() {
  (window as any).requestWakeLock = requestWakeLock;
  (window as any).releaseWakeLock = releaseWakeLock;
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    if (isPlatformHeld()) return;

    if (owners.size > 0) {
      await reacquireWakeLockIfNeeded();
      return;
    }

    // Preserve ordinary-workout resume: if a workout is mid-session, reclaim as workout.
    if (typeof (window as any).getSelectedDay === "function" && typeof (window as any).getStartTime === "function") {
      const day = (window as any).getSelectedDay();
      const startTime = (window as any).getStartTime(day);
      if (startTime) {
        await requestWakeLock("workout");
      }
    }
  });
}

export function getWakeLockOwnersForTests(): WakeLockOwner[] {
  return [...owners].sort();
}

export function isWakeLockHeldForTests(): boolean {
  return isPlatformHeld();
}

/** Test-only: replace KeepAwake / Screen Wake Lock with an in-memory fake. */
export function setWakeLockPlatformForTests(platform: WakeLockPlatform | null): void {
  platformOverride = platform;
}

export async function resetWakeLockForTests(): Promise<void> {
  owners.clear();
  try {
    if (platformOverride) {
      await platformOverride.release();
    } else if (isNativeRuntime()) {
      await defaultNativePlatform().release();
    } else if (wakeLock) {
      await defaultWebPlatform().release();
    }
  } catch {
    /* ignore */
  }
  wakeLock = null;
  nativeWakeLockActive = false;
  nativeWakeLockOperation = Promise.resolve();
  platformOverride = null;
}

export { requestWakeLock, releaseWakeLock, reacquireWakeLockIfNeeded };
