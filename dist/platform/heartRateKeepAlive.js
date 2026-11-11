import { registerPlugin } from "@capacitor/core";
import { isNativeRuntime } from "./runtime.js";
const HeartRateKeepAlive = registerPlugin("HeartRateKeepAlive", {
    web: () => ({
        async start() { },
        async stop() { },
    }),
});
/** Keep BLE + WebView timers alive so console HR stays live when Trainer is off-screen. */
export async function startHeartRateKeepAlive() {
    if (!isNativeRuntime())
        return;
    try {
        await HeartRateKeepAlive.start();
    }
    catch (error) {
        console.warn("Heart-rate keep-alive could not start:", error);
    }
}
export async function stopHeartRateKeepAlive() {
    if (!isNativeRuntime())
        return;
    try {
        await HeartRateKeepAlive.stop();
    }
    catch (error) {
        console.warn("Heart-rate keep-alive could not stop:", error);
    }
}
