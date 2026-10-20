import { BleClient, numberToUUID } from "@capacitor-community/bluetooth-le";
import {
  startNotificationsWhenReady,
  type StartNotificationsWhenReadyOptions,
} from "./bleCharacteristicReady.js";
import { dispatchHeartRateMeasurement } from "./heartRateDispatch.js";

const HEART_RATE_SERVICE = numberToUUID(0x180d);
const HEART_RATE_MEASUREMENT = numberToUUID(0x2a37);
const BATTERY_SERVICE = numberToUUID(0x180f);
const BATTERY_LEVEL = numberToUUID(0x2a19);
const BATTERY_POLL_MS = 2 * 60 * 1000;

export interface NativeBleHandlers {
  onConnected: (name: string) => void;
  onDisconnected: () => void;
  onBpm: (bpm: number) => void;
  /**
   * All RR intervals from one 0x2A37 notification, in chronological order.
   * Prefer this over per-interval callbacks so HRV can reconstruct beat timing.
   */
  onRrIntervals?: (rrIntervalsMs: readonly number[]) => void;
  /** Optional EE/RR bytes were malformed; BPM was still delivered. */
  onOptionalFieldError?: (message: string) => void;
  /** Clean BPM-only measurement (optional fields OK, no RR). */
  onOptionalFieldsOk?: () => void;
  /** Silent clear of a stale optional-field diagnostic before RR ingest. */
  onClearOptionalFieldError?: () => void;
  onBattery: (percent: number | null) => void;
}

/** Minimal BleClient surface used by the native HR connect path (injectable in tests). */
export type NativeBleClient = {
  initialize(options?: { androidNeverForLocation?: boolean }): Promise<void>;
  requestDevice(options?: {
    services?: string[];
    optionalServices?: string[];
    displayMode?: string;
  }): Promise<{ deviceId: string; name?: string }>;
  connect(
    deviceId: string,
    onDisconnect?: (deviceId: string) => void,
    options?: { timeout?: number }
  ): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  getServices(deviceId: string): Promise<
    Array<{
      uuid: string;
      characteristics: Array<{
        uuid: string;
        descriptors?: Array<{ uuid: string }> | null;
      }>;
    }>
  >;
  discoverServices?(deviceId: string): Promise<void>;
  startNotifications(
    deviceId: string,
    service: string,
    characteristic: string,
    callback: (value: DataView) => void,
    options?: { timeout?: number }
  ): Promise<void>;
  stopNotifications(deviceId: string, service: string, characteristic: string): Promise<void>;
  read(
    deviceId: string,
    service: string,
    characteristic: string,
    options?: { timeout?: number }
  ): Promise<DataView>;
};

export type ConnectNativeBleDeps = {
  client?: NativeBleClient;
  readinessOptions?: StartNotificationsWhenReadyOptions;
};

let initializePromise: Promise<void> | null = null;
let activeDeviceId: string | null = null;
let activeHandlers: NativeBleHandlers | null = null;
let batteryPollIntervalId: ReturnType<typeof setInterval> | null = null;
let activeClient: NativeBleClient = BleClient as unknown as NativeBleClient;

function initializeBle(client: NativeBleClient): Promise<void> {
  if (!initializePromise) {
    initializePromise = client.initialize({ androidNeverForLocation: true }).catch((error) => {
      initializePromise = null;
      throw error;
    });
  }
  return initializePromise;
}

function clearBatteryPolling(): void {
  if (batteryPollIntervalId !== null) {
    clearInterval(batteryPollIntervalId);
    batteryPollIntervalId = null;
  }
}

function handleDisconnect(deviceId: string): void {
  if (activeDeviceId !== deviceId) return;
  const handlers = activeHandlers;
  activeDeviceId = null;
  activeHandlers = null;
  clearBatteryPolling();
  handlers?.onDisconnected();
}

function dispatchMeasurement(value: DataView): void {
  const handlers = activeHandlers;
  if (!handlers) return;
  dispatchHeartRateMeasurement(value, {
    onBpm: handlers.onBpm,
    onRrIntervals: handlers.onRrIntervals,
    onOptionalFieldError: handlers.onOptionalFieldError,
    onOptionalFieldsOk: handlers.onOptionalFieldsOk,
    onClearOptionalFieldError: handlers.onClearOptionalFieldError,
  });
}

async function readBattery(client: NativeBleClient, deviceId: string): Promise<number | null> {
  try {
    const value = await client.read(deviceId, BATTERY_SERVICE, BATTERY_LEVEL);
    const percent = value.getUint8(0);
    return percent >= 0 && percent <= 100 ? percent : null;
  } catch {
    return null;
  }
}

async function updateBattery(client: NativeBleClient, deviceId: string): Promise<boolean> {
  const percent = await readBattery(client, deviceId);
  if (activeDeviceId !== deviceId) return false;
  activeHandlers?.onBattery(percent);
  return percent !== null;
}

/** Test-only: clear module connection state between cases. */
export function resetNativeBleForTests(): void {
  initializePromise = null;
  activeDeviceId = null;
  activeHandlers = null;
  activeClient = BleClient as unknown as NativeBleClient;
  clearBatteryPolling();
}

export async function connectNativeBle(
  handlers: NativeBleHandlers,
  deps: ConnectNativeBleDeps = {}
): Promise<void> {
  const client = deps.client ?? (BleClient as unknown as NativeBleClient);
  activeClient = client;
  await initializeBle(client);
  if (activeDeviceId) await disconnectNativeBle();

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
    await startNotificationsWhenReady(
      client,
      device.deviceId,
      HEART_RATE_SERVICE,
      HEART_RATE_MEASUREMENT,
      (value) => {
        try {
          dispatchMeasurement(value);
        } catch (error) {
          console.error("Native BLE Heart Rate Measurement parse error:", error);
        }
      },
      deps.readinessOptions
    );
    handlers.onConnected(device.name || "Heart rate sensor");
    if (await updateBattery(client, device.deviceId)) {
      batteryPollIntervalId = setInterval(() => {
        void updateBattery(client, device.deviceId);
      }, BATTERY_POLL_MS);
    }
  } catch (error) {
    try {
      await client.disconnect(device.deviceId);
    } catch {
    }
    handleDisconnect(device.deviceId);
    throw error;
  }
}

export async function disconnectNativeBle(): Promise<void> {
  const deviceId = activeDeviceId;
  const client = activeClient;
  if (!deviceId) return;
  try {
    await client.stopNotifications(deviceId, HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT);
  } catch {
  }
  try {
    await client.disconnect(deviceId);
  } finally {
    handleDisconnect(deviceId);
  }
}
