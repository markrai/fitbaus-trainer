import { dispatchHeartRateMeasurement } from "./platform/heartRateDispatch.js";
import { HrvSession, type HrvDiagnosticSnapshot } from "./platform/hrvSession.js";
import { isNativeRuntime } from "./platform/runtime.js";

export type { HrvSnapshot } from "./platform/hrvAccumulator.js";
export type { HrvReadiness } from "./platform/hrvAccumulator.js";
export type { HrvDiagnosticSnapshot } from "./platform/hrvSession.js";

type BluetoothDevice = any;

let currentHrDevice: BluetoothDevice | null = null;
let currentHrCharacteristic: any = null;
const BATTERY_POLL_MS = 2 * 60 * 1000;
let batteryPollIntervalId: ReturnType<typeof setInterval> | null = null;
let currentBpm: number | null = null;
let connectInProgress = false;
const bpmCallbacks: Array<(bpm: number) => void> = [];
const rrCallbacks: Array<(rrMs: number) => void> = [];
const hrvCallbacks: Array<(snapshot: HrvDiagnosticSnapshot) => void> = [];

const hrvSession = new HrvSession();

function bleDebugEnabled() {
  try {
    return localStorage.getItem("bleDebug") === "true";
  } catch {
    return false;
  }
}

function updateHrStatus() {
  if (typeof (window as any).updateHrMonitorStatus === "function") {
    (window as any).updateHrMonitorStatus();
  }
}

function updateBattery(percent: number | null) {
  (window as any).hrBatteryPercent = percent;
  updateHrStatus();
}

function buildHrvSnapshot(): HrvDiagnosticSnapshot {
  return hrvSession.getSnapshot();
}

function clearHrSessionForConnectAttempt(): void {
  hrvSession.prepareConnectAttempt();
  notifyHrv();
}

function activateHrSession(): void {
  hrvSession.activateConnected();
  notifyHrv();
}

function endHrSession(): void {
  hrvSession.deactivate();
  notifyHrv();
}

function notifyHrv(): void {
  const snapshot = buildHrvSnapshot();
  for (const cb of hrvCallbacks) {
    try {
      cb(snapshot);
    } catch (error) {
      console.error("hrMonitor onHrvUpdate callback error:", error);
    }
  }
}

function handleBpm(hr: number) {
  currentBpm = hr;
  for (const cb of bpmCallbacks) {
    try {
      cb(hr);
    } catch (error) {
      console.error("hrMonitor onBpm callback error:", error);
    }
  }
}

function emitRrIntervals(rrIntervalsMs: readonly number[]): void {
  for (const rrMs of rrIntervalsMs) {
    for (const cb of rrCallbacks) {
      try {
        cb(rrMs);
      } catch (error) {
        console.error("hrMonitor onRrInterval callback error:", error);
      }
    }
  }
}

function noteOptionalFieldError(message: string): void {
  hrvSession.noteOptionalFieldError(message);
  if (bleDebugEnabled()) {
    console.log("[BLE] Optional HR field parse error:", message);
  }
  notifyHrv();
}

function clearOptionalFieldErrorSilent(): void {
  hrvSession.clearOptionalFieldErrorSilent();
}

function noteOptionalFieldsOk(): void {
  const { shouldNotify } = hrvSession.noteOptionalFieldsOk();
  if (shouldNotify) notifyHrv();
}

/**
 * Ingest all RR values from one Heart Rate Measurement notification so the
 * accumulator can assign physiological end-times (not identical JS now()).
 * rrSeenThisSession is set only when the accumulator accepts at least one RR.
 */
function handleRrPacket(rrIntervalsMs: readonly number[]): void {
  if (rrIntervalsMs.length === 0) return;
  hrvSession.ingestRrPacket(rrIntervalsMs);
  emitRrIntervals(rrIntervalsMs);
  notifyHrv();
}

function handleMeasurement(value: DataView): void {
  dispatchHeartRateMeasurement(value, {
    onBpm: handleBpm,
    onRrIntervals: handleRrPacket,
    onOptionalFieldError: noteOptionalFieldError,
    onOptionalFieldsOk: noteOptionalFieldsOk,
    onClearOptionalFieldError: clearOptionalFieldErrorSilent,
  });
}

function onHrDisconnect() {
  if (batteryPollIntervalId !== null) {
    clearInterval(batteryPollIntervalId);
    batteryPollIntervalId = null;
  }
  currentHrDevice = null;
  currentHrCharacteristic = null;
  currentBpm = null;
  connectInProgress = false;
  endHrSession();
  (window as any).hrDeviceName = null;
  (window as any).hrBatteryPercent = null;
  (window as any).liveBpm = null;
  (window as any).lastBpmUpdateTime = null;
  updateHrStatus();
  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
  if (typeof (window as any).updateHrDisplay === "function") (window as any).updateHrDisplay(null);
}

function dataViewFromValue(value: any): DataView {
  if (value instanceof DataView) return value;
  if (value instanceof ArrayBuffer) return new DataView(value);
  if (value && value.buffer instanceof ArrayBuffer) {
    return new DataView(value.buffer, value.byteOffset || 0, value.byteLength || value.buffer.byteLength);
  }
  return new DataView(new ArrayBuffer(0));
}

function pollBatteryOnce() {
  const device = currentHrDevice;
  if (!device?.gatt?.connected) return;
  device.gatt
    .getPrimaryService("battery_service")
    .then((service: any) => service.getCharacteristic("battery_level").readValue())
    .then((value: ArrayBuffer | DataView) => {
      const percent = dataViewFromValue(value).getUint8(0);
      if (percent >= 0 && percent <= 100) updateBattery(percent);
    })
    .catch(() => {});
}

function startBatteryPolling() {
  if (batteryPollIntervalId !== null) return;
  batteryPollIntervalId = setInterval(pollBatteryOnce, BATTERY_POLL_MS);
}

async function dumpGattProfile(server: any) {
  if (!bleDebugEnabled()) return;
  try {
    const services = await server.getPrimaryServices();
    console.log("[BLE] Primary services:", services.map((service: any) => service.uuid));
    for (const service of services) {
      try {
        const characteristics = await service.getCharacteristics();
        console.log(
          `[BLE] Service ${service.uuid} characteristics:`,
          characteristics.map((characteristic: any) => characteristic.uuid)
        );
        for (const characteristic of characteristics) {
          try {
            console.log(`[BLE]  - Char ${characteristic.uuid} props`, characteristic.properties);
          } catch {
          }
        }
      } catch (error) {
        console.log("[BLE] Could not enumerate characteristics for service", service.uuid, error);
      }
    }
  } catch (error) {
    console.log("[BLE] Could not enumerate primary services", error);
  }
}

async function readBatteryPercentStandardBas(server: any): Promise<number | null> {
  const batteryService = await server.getPrimaryService("battery_service");
  const batteryCharacteristic = await batteryService.getCharacteristic("battery_level");
  try {
    if (batteryCharacteristic?.properties?.notify) {
      await batteryCharacteristic.startNotifications();
      batteryCharacteristic.addEventListener("characteristicvaluechanged", (event: any) => {
        try {
          const percent = dataViewFromValue(event?.target?.value).getUint8(0);
          if (percent >= 0 && percent <= 100) updateBattery(percent);
        } catch {
        }
      });
    }
  } catch {
  }
  const percent = dataViewFromValue(await batteryCharacteristic.readValue()).getUint8(0);
  return percent >= 0 && percent <= 100 ? percent : null;
}

type BatteryProbe = {
  name: string;
  read: (server: any, device?: BluetoothDevice) => Promise<number | null>;
};

const BATTERY_PROBES: BatteryProbe[] = [
  { name: "standard_bas_180f_2a19", read: (server) => readBatteryPercentStandardBas(server) },
];

async function readBatteryPercentWithProbes(server: any, device?: BluetoothDevice): Promise<number | null> {
  for (const probe of BATTERY_PROBES) {
    try {
      const percent = await probe.read(server, device);
      if (typeof percent === "number" && percent >= 0 && percent <= 100) {
        if (bleDebugEnabled()) console.log("[BLE] Battery probe success:", probe.name, percent);
        return percent;
      }
      if (bleDebugEnabled()) console.log("[BLE] Battery probe returned null:", probe.name);
    } catch (error) {
      if (bleDebugEnabled()) console.log("[BLE] Battery probe failed:", probe.name, error);
    }
  }
  return null;
}

function handleCharacteristicValueChanged(event: any) {
  try {
    handleMeasurement(dataViewFromValue(event.target.value));
  } catch (error) {
    console.error("Web Bluetooth Heart Rate Measurement parse error:", error);
  }
}

async function connectNative() {
  const { connectNativeBle } = await import("./platform/nativeBle.js");
  clearHrSessionForConnectAttempt();
  await connectNativeBle({
    onConnected: (name) => {
      activateHrSession();
      (window as any).hrDeviceName = name;
      updateHrStatus();
    },
    onDisconnected: onHrDisconnect,
    onBpm: handleBpm,
    onRrIntervals: handleRrPacket,
    onOptionalFieldError: noteOptionalFieldError,
    onOptionalFieldsOk: noteOptionalFieldsOk,
    onClearOptionalFieldError: clearOptionalFieldErrorSilent,
    onBattery: updateBattery,
  });
}

function connectWeb() {
  const bluetooth = (navigator as any).bluetooth as { requestDevice?: Function } | undefined;
  if (!bluetooth || typeof bluetooth.requestDevice !== "function") {
    console.error("Web Bluetooth API not available: navigator.bluetooth is missing.");
    if (typeof (window as any).showToast === "function") {
      (window as any).showToast("Bluetooth not supported in this browser. Use Chrome/Edge on HTTPS (or localhost).");
    }
    connectInProgress = false;
    return;
  }

  clearHrSessionForConnectAttempt();

  bluetooth
    .requestDevice({
      filters: [{ services: ["heart_rate"] }],
      optionalServices: ["battery_service", "device_information"],
    })
    .then((device: BluetoothDevice) => {
      currentHrDevice = device;
      device.addEventListener("gattserverdisconnected", onHrDisconnect);
      return device.gatt.connect().then((server: any) => ({ device, server }));
    })
    .then(({ device, server }: { device: BluetoothDevice; server: any }) => {
      (window as any).hrDeviceName = device.name || "Heart rate sensor";
      updateHrStatus();
      void dumpGattProfile(server);
      return server.getPrimaryService("heart_rate").then((hrService: any) => ({ device, server, hrService }));
    })
    .then(({ device, server, hrService }: { device: BluetoothDevice; server: any; hrService: any }) =>
      hrService
        .getCharacteristic("heart_rate_measurement")
        .then((characteristic: any) => ({ device, server, characteristic }))
    )
    .then(({ device, server, characteristic }: { device: BluetoothDevice; server: any; characteristic: any }) => {
      currentHrCharacteristic = characteristic;
      characteristic.addEventListener("characteristicvaluechanged", handleCharacteristicValueChanged);
      activateHrSession();
      return characteristic.startNotifications().then(() => ({ device, server }));
    })
    .then(({ device, server }: { device: BluetoothDevice; server: any }) =>
      readBatteryPercentWithProbes(server, device).catch(() => null)
    )
    .then((battery) => {
      updateBattery(battery);
      if (battery !== null) startBatteryPolling();
    })
    .catch((error: any) => {
      console.error(error);
      onHrDisconnect();
    })
    .finally(() => {
      connectInProgress = false;
    });
}

export function connect(): void {
  if (connectInProgress) return;
  connectInProgress = true;
  if (isNativeRuntime()) {
    void connectNative()
      .catch((error) => {
        console.error("Native BLE connection error:", error);
        onHrDisconnect();
        if (typeof (window as any).showToast === "function") {
          (window as any).showToast("Unable to connect to the heart-rate monitor.");
        }
      })
      .finally(() => {
        connectInProgress = false;
      });
    return;
  }
  connectWeb();
}

export function onBpm(callback: (bpm: number) => void): void {
  bpmCallbacks.push(callback);
}

export function onRrInterval(callback: (rrMs: number) => void): void {
  rrCallbacks.push(callback);
}

export function onHrvUpdate(callback: (snapshot: HrvDiagnosticSnapshot) => void): void {
  hrvCallbacks.push(callback);
}

export function getCurrentBpm(): number | null {
  return currentBpm;
}

export function getHrvSnapshot(): HrvDiagnosticSnapshot {
  return buildHrvSnapshot();
}

export function disconnect(): void {
  if (isNativeRuntime()) {
    void import("./platform/nativeBle.js")
      .then(({ disconnectNativeBle }) => disconnectNativeBle())
      .catch((error) => console.error("Native BLE disconnect error:", error));
    return;
  }
  if (currentHrDevice?.gatt?.connected) {
    currentHrDevice.gatt.disconnect();
  }
}

// Dev/validation hook — no UI; lets CDP or console inspect live HRV state.
if (typeof window !== "undefined") {
  (window as any).getHrvSnapshot = getHrvSnapshot;
}
