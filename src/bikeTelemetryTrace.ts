import type { BikeTelemetrySample } from "./vo2Workload.js";

export interface TelemetryTraceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memory = new Map<string, BikeTelemetrySample[]>();

export function bikeTelemetryStorageKey(sessionId: string): string {
  return "bike_telemetry_" + sessionId;
}

function storageKey(sessionId: string): string {
  return bikeTelemetryStorageKey(sessionId);
}

function storageOrMemory(storage?: TelemetryTraceStorage): TelemetryTraceStorage | undefined {
  if (storage) return storage;
  return typeof localStorage !== "undefined" ? localStorage : undefined;
}

function persist(sessionId: string, samples: BikeTelemetrySample[], storage?: TelemetryTraceStorage): void {
  memory.set(sessionId, samples);
  const store = storageOrMemory(storage);
  if (!store) return;
  store.setItem(storageKey(sessionId), JSON.stringify(samples));
}

function parseStored(raw: string | null): BikeTelemetrySample[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row) => row && typeof row === "object" && Number.isFinite(row.timestamp_sec)
    ) as BikeTelemetrySample[];
  } catch {
    return [];
  }
}

/** Reuse already-polled Bike Bridge metrics. One sample per active second. */
export function recordBikeTelemetrySample(
  sessionId: string,
  sample: BikeTelemetrySample,
  storage?: TelemetryTraceStorage
): void {
  if (!sessionId || !Number.isFinite(sample.timestamp_sec) || sample.timestamp_sec < 0) return;
  const timestamp = Math.floor(sample.timestamp_sec);
  const samples = getBikeTelemetrySamples(sessionId, storage);
  if (samples.some((entry) => entry.timestamp_sec === timestamp)) return;
  const next: BikeTelemetrySample = { timestamp_sec: timestamp };
  if (typeof sample.rpm === "number" && Number.isFinite(sample.rpm) && sample.rpm > 0) next.rpm = sample.rpm;
  if (typeof sample.watts === "number" && Number.isFinite(sample.watts) && sample.watts > 0) {
    next.watts = sample.watts;
  }
  if (
    typeof sample.observed_resistance === "number" &&
    Number.isFinite(sample.observed_resistance) &&
    sample.observed_resistance > 0
  ) {
    next.observed_resistance = sample.observed_resistance;
  }
  if (next.rpm == null && next.watts == null && next.observed_resistance == null) return;
  samples.push(next);
  persist(sessionId, samples, storage);
}

export function getBikeTelemetrySamples(
  sessionId: string,
  storage?: TelemetryTraceStorage
): BikeTelemetrySample[] {
  const cached = memory.get(sessionId);
  if (cached) return cached;
  const store = storageOrMemory(storage);
  const loaded = parseStored(store?.getItem(storageKey(sessionId)) ?? null);
  memory.set(sessionId, loaded);
  return loaded;
}

export function clearBikeTelemetrySamples(sessionId: string, storage?: TelemetryTraceStorage): void {
  memory.delete(sessionId);
  storageOrMemory(storage)?.removeItem(storageKey(sessionId));
}
