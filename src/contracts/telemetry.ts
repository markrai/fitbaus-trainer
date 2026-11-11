/**
 * Persisted HR sample and ordinary bike telemetry sample shapes. Parsing lives
 * in src/ordinaryWorkoutTelemetry.ts.
 */

export interface HrSample {
  session_id: string;
  timestamp_sec: number;
  hr: number;
}

/** Permanent historical schema identities for Phase C evidence. */
export const ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1 = 1 as const;
export const ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION = ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1;
export type OrdinaryBikeTelemetryAvailability = "fresh" | "stale" | "unavailable";
export type BikeWattsProvenance = "measured_watts" | "calibrated_watts";

export interface OrdinaryBikeTelemetrySampleV1 {
  schemaVersion: typeof ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1;
  athleteId: string;
  sessionId: string;
  activeSec: number;
  observedAt: string;
  availability: OrdinaryBikeTelemetryAvailability;
  /** Stable identity from the successful Bike Bridge snapshot, used to reject duplicate observations. */
  sourceSampleId?: string;
  freshnessMs?: number;
  watts?: {
    value: number;
    source: BikeWattsProvenance;
    freshnessMs: number;
  };
  cadenceRpm?: {
    value: number;
    source: "measured";
    freshnessMs: number;
  };
  /**
   * Observed bike resistance from telemetry. Never copied from desired or commanded.
   * Absence means not observed, not zero.
   */
  observedResistance?: {
    value: number;
    source: "observed";
    freshnessMs: number;
  };
  /**
   * Controller recommendation / desired machine setting at this active second.
   * Recommendation is intent, not observation.
   */
  desiredResistance?: number;
  /**
   * Resistance posted to Bike Bridge when automatic actuation exists.
   * Command is not observation and is not required for observed evidence.
   */
  commandedResistance?: number;
}

/** Persisted/read union. Add historical members here without relabeling prior schemas. */
export type OrdinaryBikeTelemetrySample = OrdinaryBikeTelemetrySampleV1;
/** Writer alias. Advance this only when a new writer and matching parser are introduced. */
export type CurrentOrdinaryBikeTelemetrySample = OrdinaryBikeTelemetrySampleV1;
