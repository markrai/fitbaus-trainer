import { isNativeRuntime } from "./platform/runtime.js";
let wakeLock = null;
let nativeWakeLockActive = false;
let nativeWakeLockDesired = false;
let nativeWakeLockOperation = Promise.resolve();
async function requestWakeLock() {
    if (isNativeRuntime()) {
        nativeWakeLockDesired = true;
        let acquired = nativeWakeLockActive;
        nativeWakeLockOperation = nativeWakeLockOperation
            .catch(() => { })
            .then(async () => {
            if (!nativeWakeLockDesired || nativeWakeLockActive)
                return;
            const { acquireNativeWakeLock } = await import("./platform/nativeWakeLock.js");
            acquired = await acquireNativeWakeLock();
            nativeWakeLockActive = acquired;
            if (acquired)
                console.log("Wake lock activated");
        });
        try {
            await nativeWakeLockOperation;
            return acquired || nativeWakeLockActive;
        }
        catch (error) {
            console.error("Error requesting wake lock:", error);
            return false;
        }
    }
    try {
        if ("wakeLock" in navigator) {
            // @ts-ignore - Wake Lock types not universally available
            wakeLock = await navigator.wakeLock.request("screen");
            wakeLock.addEventListener("release", () => console.log("Wake lock released by system"));
            console.log("Wake lock activated");
            return true;
        }
        else {
            console.warn("Wake Lock API not supported");
            return false;
        }
    }
    catch (error) {
        console.error("Error requesting wake lock:", error);
        return false;
    }
}
async function releaseWakeLock() {
    if (isNativeRuntime()) {
        nativeWakeLockDesired = false;
        nativeWakeLockOperation = nativeWakeLockOperation
            .catch(() => { })
            .then(async () => {
            if (!nativeWakeLockActive)
                return;
            const { releaseNativeWakeLock } = await import("./platform/nativeWakeLock.js");
            await releaseNativeWakeLock();
            nativeWakeLockActive = false;
            console.log("Wake lock released");
        });
        try {
            await nativeWakeLockOperation;
        }
        catch (error) {
            console.error("Error releasing wake lock:", error);
        }
        return;
    }
    if (wakeLock) {
        try {
            await wakeLock.release();
            wakeLock = null;
            console.log("Wake lock released");
        }
        catch (error) {
            console.error("Error releasing wake lock:", error);
        }
    }
}
export function registerWakeLockGlobals() {
    window.requestWakeLock = requestWakeLock;
    window.releaseWakeLock = releaseWakeLock;
    document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState === "visible" && wakeLock === null && !nativeWakeLockActive) {
            if (typeof window.getSelectedDay === "function" && typeof window.getStartTime === "function") {
                const day = window.getSelectedDay();
                const startTime = window.getStartTime(day);
                if (startTime) {
                    await requestWakeLock();
                }
            }
        }
    });
}
export { requestWakeLock, releaseWakeLock };
