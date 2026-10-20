import {
  ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION,
  ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
  type BikeWattsProvenance,
  type CurrentOrdinaryBikeTelemetrySample,
  type OrdinaryBikeTelemetryAvailability,
  type OrdinaryBikeTelemetrySample,
  type OrdinaryBikeTelemetrySampleV1,
} from "./types.js";

export const ORDINARY_TELEMETRY_MAX_FRESHNESS_MS = 2500;
const OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

export interface OrdinaryTelemetryMetricInput {
  value: number | null;
  current: boolean;
}

export interface BuildOrdinaryBikeTelemetrySampleInput {
  athleteId: string | undefined;
  sessionId: string | null | undefined;
  activeSec: number;
  observedAtMs: number;
  telemetryStale: boolean;
  telemetryReceivedAtMs: number | null;
  telemetrySnapshotAt: string | null;
  watts: OrdinaryTelemetryMetricInput;
  cadenceRpm: OrdinaryTelemetryMetricInput;
  observedResistance: OrdinaryTelemetryMetricInput;
  desiredResistance?: number;
  commandedResistance?: number;
  maxFreshnessMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isOwnerId(value: unknown): value is string {
  return typeof value === "string" && OWNER_ID_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseControllerResistance(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (!isFiniteNumber(value) || value < 0 || value > 100) return null;
  return value;
}

function parseObservedMetric<T extends "measured" | "observed">(
  value: unknown,
  source: T,
  maxValue: number
): { value: number; source: T; freshnessMs: number } | null | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) return null;
  if (!isFiniteNumber(value.value) || value.value < 0 || value.value > maxValue) return null;
  if (value.source !== source || !isNonNegativeFinite(value.freshnessMs)) return null;
  return { value: value.value, source, freshnessMs: value.freshnessMs };
}

function parseWatts(
  value: unknown
): { value: number; source: BikeWattsProvenance; freshnessMs: number } | null | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) return null;
  if (!isFiniteNumber(value.value) || value.value < 0 || value.value > 5000) return null;
  if (value.source !== "measured_watts" && value.source !== "calibrated_watts") return null;
  if (!isNonNegativeFinite(value.freshnessMs)) return null;
  return { value: value.value, source: value.source, freshnessMs: value.freshnessMs };
}

function parseOrdinaryBikeTelemetryV1(value: Record<string, unknown>): OrdinaryBikeTelemetrySampleV1 | null {
  if (!isOwnerId(value.athleteId) || !isOwnerId(value.sessionId)) return null;
  if (!isNonNegativeInteger(value.activeSec) || value.activeSec > 24 * 60 * 60) return null;
  if (!isIsoTimestamp(value.observedAt)) return null;
  if (value.availability !== "fresh" && value.availability !== "stale" && value.availability !== "unavailable") {
    return null;
  }
  const availability = value.availability as OrdinaryBikeTelemetryAvailability;
  if (
    value.sourceSampleId !== undefined &&
    (typeof value.sourceSampleId !== "string" || value.sourceSampleId.trim() === "" || value.sourceSampleId.length > 256)
  ) {
    return null;
  }
  if (value.freshnessMs !== undefined && !isNonNegativeFinite(value.freshnessMs)) return null;
  const watts = parseWatts(value.watts);
  const cadenceRpm = parseObservedMetric(value.cadenceRpm, "measured", 300);
  const observedResistance = parseObservedMetric(value.observedResistance, "observed", 100);
  const desiredResistance = parseControllerResistance(value.desiredResistance);
  const commandedResistance = parseControllerResistance(value.commandedResistance);
  if (
    watts === null ||
    cadenceRpm === null ||
    observedResistance === null ||
    desiredResistance === null ||
    commandedResistance === null
  ) {
    return null;
  }
  if (availability !== "fresh" && (watts || cadenceRpm || observedResistance)) return null;
  if (availability === "fresh" && (value.sourceSampleId === undefined || value.freshnessMs === undefined)) return null;
  if (availability === "fresh" && (value.freshnessMs as number) > ORDINARY_TELEMETRY_MAX_FRESHNESS_MS) return null;
  if (
    availability === "fresh" &&
    [watts, cadenceRpm, observedResistance].some(
      (metric) => metric !== undefined && metric.freshnessMs !== value.freshnessMs
    )
  ) {
    return null;
  }
  if (availability === "stale" && ((value.sourceSampleId === undefined) !== (value.freshnessMs === undefined))) return null;
  if (availability === "unavailable" && (value.sourceSampleId !== undefined || value.freshnessMs !== undefined)) return null;
  const sourceSampleId = value.sourceSampleId as string | undefined;
  const freshnessMs = value.freshnessMs as number | undefined;
  return {
    schemaVersion: ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
    athleteId: value.athleteId,
    sessionId: value.sessionId,
    activeSec: value.activeSec,
    observedAt: value.observedAt,
    availability,
    ...(sourceSampleId !== undefined ? { sourceSampleId } : {}),
    ...(freshnessMs !== undefined ? { freshnessMs } : {}),
    ...(watts ? { watts } : {}),
    ...(cadenceRpm ? { cadenceRpm } : {}),
    ...(observedResistance ? { observedResistance } : {}),
    ...(desiredResistance !== undefined ? { desiredResistance } : {}),
    ...(commandedResistance !== undefined ? { commandedResistance } : {}),
  };
}

/** Strict historical dispatcher. Future writer aliases cannot relabel persisted v1 evidence. */
export function parseOrdinaryBikeTelemetrySample(value: unknown): OrdinaryBikeTelemetrySample | null {
  if (!isObject(value)) return null;
  switch (value.schemaVersion) {
    case ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1:
      return parseOrdinaryBikeTelemetryV1(value);
    default:
      return null;
  }
}

/**
 * Build one active-clock observation. Only Bike Bridge values from a successful,
 * current poll become observed evidence; controller values remain separate audit fields.
 */
export function buildOrdinaryBikeTelemetrySample(
  input: BuildOrdinaryBikeTelemetrySampleInput
): CurrentOrdinaryBikeTelemetrySample | null {
  if (!isOwnerId(input.athleteId) || !isOwnerId(input.sessionId)) return null;
  if (!isNonNegativeInteger(input.activeSec) || !Number.isFinite(input.observedAtMs)) return null;
  const observedAt = new Date(input.observedAtMs);
  if (!Number.isFinite(observedAt.getTime())) return null;
  const maxFreshnessMs = input.maxFreshnessMs ?? ORDINARY_TELEMETRY_MAX_FRESHNESS_MS;
  if (!isNonNegativeFinite(maxFreshnessMs)) return null;
  const receivedAt = input.telemetryReceivedAtMs;
  const freshnessMs = receivedAt == null ? undefined : Math.max(0, input.observedAtMs - receivedAt);
  const hasSnapshot = typeof input.telemetrySnapshotAt === "string" && input.telemetrySnapshotAt.trim() !== "";
  const availability: OrdinaryBikeTelemetryAvailability = receivedAt == null || !hasSnapshot
    ? "unavailable"
    : input.telemetryStale || freshnessMs == null || freshnessMs > maxFreshnessMs
      ? "stale"
      : "fresh";
  const desiredResistance = parseControllerResistance(input.desiredResistance);
  const commandedResistance = parseControllerResistance(input.commandedResistance);
  if (desiredResistance === null || commandedResistance === null) return null;

  const sample: CurrentOrdinaryBikeTelemetrySample = {
    schemaVersion: ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION,
    athleteId: input.athleteId,
    sessionId: input.sessionId,
    activeSec: input.activeSec,
    observedAt: observedAt.toISOString(),
    availability,
    ...(desiredResistance !== undefined ? { desiredResistance } : {}),
    ...(commandedResistance !== undefined ? { commandedResistance } : {}),
  };
  if (availability === "stale" && freshnessMs !== undefined && input.telemetrySnapshotAt) {
    sample.sourceSampleId = input.telemetrySnapshotAt;
    sample.freshnessMs = freshnessMs;
    return parseOrdinaryBikeTelemetrySample(sample);
  }
  if (availability !== "fresh" || freshnessMs === undefined || !input.telemetrySnapshotAt) return sample;
  sample.sourceSampleId = input.telemetrySnapshotAt;
  sample.freshnessMs = freshnessMs;
  if (input.watts.current && isFiniteNumber(input.watts.value) && input.watts.value >= 0) {
    sample.watts = { value: input.watts.value, source: "measured_watts", freshnessMs };
  }
  if (input.cadenceRpm.current && isFiniteNumber(input.cadenceRpm.value) && input.cadenceRpm.value >= 0) {
    sample.cadenceRpm = { value: input.cadenceRpm.value, source: "measured", freshnessMs };
  }
  if (
    input.observedResistance.current &&
    isFiniteNumber(input.observedResistance.value) &&
    input.observedResistance.value >= 0
  ) {
    sample.observedResistance = {
      value: input.observedResistance.value,
      source: "observed",
      freshnessMs,
    };
  }
  return parseOrdinaryBikeTelemetrySample(sample);
}
