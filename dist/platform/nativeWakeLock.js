import { KeepAwake } from "@capacitor-community/keep-awake";
export async function acquireNativeWakeLock() {
    const { isSupported } = await KeepAwake.isSupported();
    if (!isSupported)
        return false;
    await KeepAwake.keepAwake();
    return true;
}
export async function releaseNativeWakeLock() {
    await KeepAwake.allowSleep();
}
