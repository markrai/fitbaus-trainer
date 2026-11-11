import { BleClient, numberToUUID } from "@capacitor-community/bluetooth-le";
import { startNotificationsWhenReady, } from "./bleCharacteristicReady.js";
import { dispatchHeartRateMeasurement } from "./heartRateDispatch.js";
const HEART_RATE_SERVICE = numberToUUID(0x180d);
const HEART_RATE_MEASUREMENT = numberToUUID(0x2a37);
const BATTERY_SERVICE = numberToUUID(0x180f);
const BATTERY_LEVEL = numberToUUID(0x2a19);
const BATTERY_POLL_MS = 2 * 60 * 1000;
let initializePromise = null;
let activeDeviceId = null;
let activeHandlers = null;
let batteryPollIntervalId = null;
let activeClient = BleClient;
function initializeBle(client) {
    if (!initializePromise) {
        initializePromise = client.initialize({ androidNeverForLocation: true }).catch((error) => {
            initializePromise = null;
            throw error;
        });
    }
    return initializePromise;
}
function clearBatteryPolling() {
    if (batteryPollIntervalId !== null) {
        clearInterval(batteryPollIntervalId);
        batteryPollIntervalId = null;
    }
}
function handleDisconnect(deviceId) {
    if (activeDeviceId !== deviceId)
        return;
    const handlers = activeHandlers;
    activeDeviceId = null;
    activeHandlers = null;
    clearBatteryPolling();
    handlers === null || handlers === void 0 ? void 0 : handlers.onDisconnected();
}
function dispatchMeasurement(value) {
    const handlers = activeHandlers;
    if (!handlers)
        return;
    dispatchHeartRateMeasurement(value, {
        onBpm: handlers.onBpm,
        onRrIntervals: handlers.onRrIntervals,
        onOptionalFieldError: handlers.onOptionalFieldError,
        onOptionalFieldsOk: handlers.onOptionalFieldsOk,
        onClearOptionalFieldError: handlers.onClearOptionalFieldError,
    });
}
async function readBattery(client, deviceId) {
    try {
        const value = await client.read(deviceId, BATTERY_SERVICE, BATTERY_LEVEL);
        const percent = value.getUint8(0);
        return percent >= 0 && percent <= 100 ? percent : null;
    }
    catch {
        return null;
    }
}
async function updateBattery(client, deviceId) {
    const percent = await readBattery(client, deviceId);
    if (activeDeviceId !== deviceId)
        return false;
    activeHandlers === null || activeHandlers === void 0 ? void 0 : activeHandlers.onBattery(percent);
    return percent !== null;
}
/** Test-only: clear module connection state between cases. */
export function resetNativeBleForTests() {
    initializePromise = null;
    activeDeviceId = null;
    activeHandlers = null;
    activeClient = BleClient;
    clearBatteryPolling();
}
export async function connectNativeBle(handlers, deps = {}) {
    var _a;
    const client = (_a = deps.client) !== null && _a !== void 0 ? _a : BleClient;
    activeClient = client;
    await initializeBle(client);
    if (activeDeviceId)
        await disconnectNativeBle();
    const device = await client.requestDevice({
        services: [HEART_RATE_SERVICE],
        optionalServices: [BATTERY_SERVICE],
        displayMode: "list",
    });
    activeDeviceId = device.deviceId;
    activeHandlers = handlers;
    try {
        await client.connect(device.deviceId, handleDisconnect);
        // connect() can resolve before Android GATT service discovery finishes;
        // wait for 0x180D/0x2A37 (+ CCCD 0x2902 when exposed) before subscription / onConnected.
        await startNotificationsWhenReady(client, device.deviceId, HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT, (value) => {
            try {
                dispatchMeasurement(value);
            }
            catch (error) {
                console.error("Native BLE Heart Rate Measurement parse error:", error);
            }
        }, deps.readinessOptions);
        handlers.onConnected(device.name || "Heart rate sensor");
        if (await updateBattery(client, device.deviceId)) {
            batteryPollIntervalId = setInterval(() => {
                void updateBattery(client, device.deviceId);
            }, BATTERY_POLL_MS);
        }
    }
    catch (error) {
        try {
            await client.disconnect(device.deviceId);
        }
        catch {
        }
        handleDisconnect(device.deviceId);
        throw error;
    }
}
export async function disconnectNativeBle() {
    const deviceId = activeDeviceId;
    const client = activeClient;
    if (!deviceId)
        return;
    try {
        await client.stopNotifications(deviceId, HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT);
    }
    catch {
    }
    try {
        await client.disconnect(deviceId);
    }
    finally {
        handleDisconnect(deviceId);
    }
}
