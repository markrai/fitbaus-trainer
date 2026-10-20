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

export type BleUuidDescriptor = {
  uuid: string;
};

export type BleUuidCharacteristic = {
  uuid: string;
  /** Present when the platform exposes descriptors (Android/iOS getServices). */
  descriptors?: ReadonlyArray<BleUuidDescriptor> | null;
};

export type BleUuidService = {
  uuid: string;
  characteristics: ReadonlyArray<BleUuidCharacteristic>;
};

export type BleCharacteristicClient = {
  getServices(deviceId: string): Promise<BleUuidService[]>;
  discoverServices?(deviceId: string): Promise<void>;
  startNotifications(
    deviceId: string,
    service: string,
    characteristic: string,
    callback: (value: DataView) => void,
    options?: { timeout?: number }
  ): Promise<void>;
};

export type WaitForCharacteristicOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Elapsed time before first explicit rediscovery (in-flight discovery is polled first). */
  rediscoveryAfterMs?: number;
  maxDiscoverAttempts?: number;
  /** CCCD UUID required when getServices exposes a descriptors array. */
  cccdUuid?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type StartNotificationsWhenReadyOptions = WaitForCharacteristicOptions & {
  maxNotificationAttempts?: number;
  notificationRetryDelayMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 100;
/** Poll in-flight connect discovery first; rediscover only after this much elapsed time. */
const DEFAULT_REDISCOVERY_AFTER_MS = 1_500;
const DEFAULT_MAX_DISCOVER_ATTEMPTS = 1;
const DEFAULT_MAX_NOTIFICATION_ATTEMPTS = 5;

export function normalizeBleUuid(uuid: string): string {
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
export function servicesIncludeNotificationTarget(
  services: ReadonlyArray<BleUuidService> | null | undefined,
  serviceUuid: string,
  characteristicUuid: string,
  cccdUuid: string = CCCD_UUID
): boolean {
  const wantService = normalizeBleUuid(serviceUuid);
  const wantChar = normalizeBleUuid(characteristicUuid);
  const wantCccd = normalizeBleUuid(cccdUuid);
  if (!services || !wantService || !wantChar) return false;

  for (const service of services) {
    if (normalizeBleUuid(service?.uuid) !== wantService) continue;
    const characteristics = service?.characteristics;
    if (!characteristics) continue;
    for (const characteristic of characteristics) {
      if (normalizeBleUuid(characteristic?.uuid) !== wantChar) continue;
      const descriptors = characteristic.descriptors;
      if (descriptors == null) return true;
      if (!wantCccd) return true;
      for (const descriptor of descriptors) {
        if (normalizeBleUuid(descriptor?.uuid) === wantCccd) return true;
      }
      return false;
    }
  }
  return false;
}

/** @deprecated Prefer servicesIncludeNotificationTarget (includes CCCD when exposed). */
export function servicesIncludeCharacteristic(
  services: ReadonlyArray<BleUuidService> | null | undefined,
  serviceUuid: string,
  characteristicUuid: string
): boolean {
  return servicesIncludeNotificationTarget(services, serviceUuid, characteristicUuid, "");
}

export function isCharacteristicNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /characteristic not found/i.test(message);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForBleCharacteristic(
  client: Pick<BleCharacteristicClient, "getServices" | "discoverServices">,
  deviceId: string,
  serviceUuid: string,
  characteristicUuid: string,
  options: WaitForCharacteristicOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const rediscoveryAfterMs = options.rediscoveryAfterMs ?? DEFAULT_REDISCOVERY_AFTER_MS;
  const maxDiscoverAttempts = options.maxDiscoverAttempts ?? DEFAULT_MAX_DISCOVER_ATTEMPTS;
  const cccdUuid = options.cccdUuid ?? CCCD_UUID;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
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
      throw new Error(
        `BLE characteristic ${characteristicUuid} on service ${serviceUuid} not available after ${timeoutMs}ms`
      );
    }

    const elapsed = now() - startedAt;
    const mayRediscover =
      elapsed >= rediscoveryAfterMs &&
      discoverAttempts < maxDiscoverAttempts &&
      typeof client.discoverServices === "function";

    if (mayRediscover) {
      discoverAttempts += 1;
      try {
        await client.discoverServices(deviceId);
      } catch {
        // Rediscovery may fail while discovery is still in flight; keep polling.
      }
      continue;
    }

    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

export async function startNotificationsWhenReady(
  client: BleCharacteristicClient,
  deviceId: string,
  serviceUuid: string,
  characteristicUuid: string,
  callback: (value: DataView) => void,
  options: StartNotificationsWhenReadyOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxNotificationAttempts =
    options.maxNotificationAttempts ?? DEFAULT_MAX_NOTIFICATION_ATTEMPTS;
  const notificationRetryDelayMs =
    options.notificationRetryDelayMs ?? options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const deadline = now() + timeoutMs;

  await waitForBleCharacteristic(client, deviceId, serviceUuid, characteristicUuid, {
    ...options,
    timeoutMs,
    now,
    sleep,
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxNotificationAttempts; attempt++) {
    try {
      await client.startNotifications(deviceId, serviceUuid, characteristicUuid, callback);
      return;
    } catch (error) {
      lastError = error;
      const timeLeft = deadline - now();
      // Only "Characteristic not found" is a proven incomplete-GATT signal.
      // Do not retry "Setting notification failed." — it is ambiguous (missing
      // CCCD, setCharacteristicNotification failure, writeDescriptor failure).
      if (
        !isCharacteristicNotFoundError(error) ||
        attempt >= maxNotificationAttempts ||
        timeLeft <= 0
      ) {
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
    : new Error(String(lastError ?? "startNotifications failed"));
}
