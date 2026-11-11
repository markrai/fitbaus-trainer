/**
 * Wait for GATT notification target availability after BleClient.connect.
 *
 * On some Android stacks, @capacitor-community/bluetooth-le's connect() can
 * resolve before service discovery has populated the GATT table (e.g. when
 * onMtuChanged resolves the connect callback early, or the "Already connected"
 * path skips rediscovery). startNotifications then fails with
 * "Characteristic not found."
 *
 * Android setNotifications also requires CCCD 0x2902; when that descriptor is
 * missing the plugin rejects with "Setting notification failed." (same string
 * as other notification setup failures). Prefer proving CCCD readiness via
 * getServices() over retrying that ambiguous error.
 */
/** Client Characteristic Configuration Descriptor (required to enable notifications). */
export const CCCD_UUID = "00002902-0000-1000-8000-00805f9b34fb";
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_POLL_MS = 100;
/** Poll in-flight connect discovery first; rediscover only after this much elapsed time. */
const DEFAULT_REDISCOVERY_AFTER_MS = 1500;
const DEFAULT_MAX_DISCOVER_ATTEMPTS = 1;
const DEFAULT_MAX_NOTIFICATION_ATTEMPTS = 5;
export function normalizeBleUuid(uuid) {
    return String(uuid || "")
        .trim()
        .toLowerCase();
}
/**
 * True when service/characteristic exist. If the characteristic includes a
 * `descriptors` array (even empty), CCCD must also be present. If `descriptors`
 * is omitted/null, only the characteristic is required (platforms that do not
 * expose descriptor lists).
 */
export function servicesIncludeNotificationTarget(services, serviceUuid, characteristicUuid, cccdUuid = CCCD_UUID) {
    const wantService = normalizeBleUuid(serviceUuid);
    const wantChar = normalizeBleUuid(characteristicUuid);
    const wantCccd = normalizeBleUuid(cccdUuid);
    if (!services || !wantService || !wantChar)
        return false;
    for (const service of services) {
        if (normalizeBleUuid(service === null || service === void 0 ? void 0 : service.uuid) !== wantService)
            continue;
        const characteristics = service === null || service === void 0 ? void 0 : service.characteristics;
        if (!characteristics)
            continue;
        for (const characteristic of characteristics) {
            if (normalizeBleUuid(characteristic === null || characteristic === void 0 ? void 0 : characteristic.uuid) !== wantChar)
                continue;
            const descriptors = characteristic.descriptors;
            if (descriptors == null)
                return true;
            if (!wantCccd)
                return true;
            for (const descriptor of descriptors) {
                if (normalizeBleUuid(descriptor === null || descriptor === void 0 ? void 0 : descriptor.uuid) === wantCccd)
                    return true;
            }
            return false;
        }
    }
    return false;
}
/** @deprecated Prefer servicesIncludeNotificationTarget (includes CCCD when exposed). */
export function servicesIncludeCharacteristic(services, serviceUuid, characteristicUuid) {
    return servicesIncludeNotificationTarget(services, serviceUuid, characteristicUuid, "");
}
export function isCharacteristicNotFoundError(error) {
    const message = error instanceof Error ? error.message : String(error !== null && error !== void 0 ? error : "");
    return /characteristic not found/i.test(message);
}
function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function waitForBleCharacteristic(client, deviceId, serviceUuid, characteristicUuid, options = {}) {
    var _a, _b, _c, _d, _e, _f, _g;
    const timeoutMs = (_a = options.timeoutMs) !== null && _a !== void 0 ? _a : DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = (_b = options.pollIntervalMs) !== null && _b !== void 0 ? _b : DEFAULT_POLL_MS;
    const rediscoveryAfterMs = (_c = options.rediscoveryAfterMs) !== null && _c !== void 0 ? _c : DEFAULT_REDISCOVERY_AFTER_MS;
    const maxDiscoverAttempts = (_d = options.maxDiscoverAttempts) !== null && _d !== void 0 ? _d : DEFAULT_MAX_DISCOVER_ATTEMPTS;
    const cccdUuid = (_e = options.cccdUuid) !== null && _e !== void 0 ? _e : CCCD_UUID;
    const now = (_f = options.now) !== null && _f !== void 0 ? _f : Date.now;
    const sleep = (_g = options.sleep) !== null && _g !== void 0 ? _g : defaultSleep;
    const startedAt = now();
    const deadline = startedAt + timeoutMs;
    let discoverAttempts = 0;
    while (true) {
        const services = await client.getServices(deviceId);
        if (servicesIncludeNotificationTarget(services, serviceUuid, characteristicUuid, cccdUuid)) {
            return;
        }
        const remaining = deadline - now();
        if (remaining <= 0) {
            throw new Error(`BLE characteristic ${characteristicUuid} on service ${serviceUuid} not available after ${timeoutMs}ms`);
        }
        const elapsed = now() - startedAt;
        const mayRediscover = elapsed >= rediscoveryAfterMs &&
            discoverAttempts < maxDiscoverAttempts &&
            typeof client.discoverServices === "function";
        if (mayRediscover) {
            discoverAttempts += 1;
            try {
                await client.discoverServices(deviceId);
            }
            catch {
                // Rediscovery may fail while discovery is still in flight; keep polling.
            }
            continue;
        }
        await sleep(Math.min(pollIntervalMs, remaining));
    }
}
export async function startNotificationsWhenReady(client, deviceId, serviceUuid, characteristicUuid, callback, options = {}) {
    var _a, _b, _c, _d, _e, _f;
    const timeoutMs = (_a = options.timeoutMs) !== null && _a !== void 0 ? _a : DEFAULT_TIMEOUT_MS;
    const now = (_b = options.now) !== null && _b !== void 0 ? _b : Date.now;
    const sleep = (_c = options.sleep) !== null && _c !== void 0 ? _c : defaultSleep;
    const maxNotificationAttempts = (_d = options.maxNotificationAttempts) !== null && _d !== void 0 ? _d : DEFAULT_MAX_NOTIFICATION_ATTEMPTS;
    const notificationRetryDelayMs = (_f = (_e = options.notificationRetryDelayMs) !== null && _e !== void 0 ? _e : options.pollIntervalMs) !== null && _f !== void 0 ? _f : DEFAULT_POLL_MS;
    const deadline = now() + timeoutMs;
    await waitForBleCharacteristic(client, deviceId, serviceUuid, characteristicUuid, {
        ...options,
        timeoutMs,
        now,
        sleep,
    });
    let lastError;
    for (let attempt = 1; attempt <= maxNotificationAttempts; attempt++) {
        try {
            await client.startNotifications(deviceId, serviceUuid, characteristicUuid, callback);
            return;
        }
        catch (error) {
            lastError = error;
            const timeLeft = deadline - now();
            // Only "Characteristic not found" is a proven incomplete-GATT signal.
            // Do not retry "Setting notification failed." — it is ambiguous (missing
            // CCCD, setCharacteristicNotification failure, writeDescriptor failure).
            if (!isCharacteristicNotFoundError(error) ||
                attempt >= maxNotificationAttempts ||
                timeLeft <= 0) {
                throw error;
            }
            await waitForBleCharacteristic(client, deviceId, serviceUuid, characteristicUuid, {
                ...options,
                timeoutMs: timeLeft,
                now,
                sleep,
            });
            await sleep(Math.min(notificationRetryDelayMs, Math.max(0, deadline - now())));
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError !== null && lastError !== void 0 ? lastError : "startNotifications failed"));
}
