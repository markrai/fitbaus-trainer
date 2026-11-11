function getCapacitorBridge() {
    return globalThis.Capacitor;
}
export function isNativeRuntime() {
    const bridge = getCapacitorBridge();
    if (!bridge)
        return false;
    if (typeof bridge.isNativePlatform === "function") {
        return bridge.isNativePlatform();
    }
    const platform = typeof bridge.getPlatform === "function" ? bridge.getPlatform() : "web";
    return platform === "android" || platform === "ios";
}
export function getRuntimePlatform() {
    var _a, _b;
    const platform = (_b = (_a = getCapacitorBridge()) === null || _a === void 0 ? void 0 : _a.getPlatform) === null || _b === void 0 ? void 0 : _b.call(_a);
    return platform === "android" || platform === "ios" ? platform : "web";
}
async function hideSystemBars() {
    const { SystemBars } = await import("@capacitor/core");
    await SystemBars.hide();
}
function listenForAppResume(onResume) {
    var _a;
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible")
            onResume();
    });
    const capacitor = getCapacitorBridge();
    (_a = capacitor.addListener) === null || _a === void 0 ? void 0 : _a.call(capacitor, "App", "appStateChange", (state) => {
        if (state === null || state === void 0 ? void 0 : state.isActive)
            onResume();
    });
}
export function applyRuntimeDocumentState() {
    if (!isNativeRuntime())
        return;
    document.documentElement.classList.add("capacitor-native");
    const hideBars = () => {
        void hideSystemBars().catch(() => { });
    };
    hideBars();
    listenForAppResume(hideBars);
}
