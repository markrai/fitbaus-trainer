/**
 * Workout response summary contracts (schema V1).
 */

import type { ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1 } from "./telemetry.js";
import type { PhaseIntensityId, ResolvedHeartRateTarget, WorkoutPhaseKind } from "./workoutPrescription.js";

export const WORKOUT_RESPONSE_SCHEMA_VERSION_V1 = 1 as const;
export const WORKOUT_RESPONSE_SCHEMA_VERSION = WORKOUT_RESPONSE_SCHEMA_VERSION_V1;

/** Compact phase-level scalar series. Absence of a summary means not recorded, not zero. */
export interface WorkoutResponseScalarSummary {
  sampleCount: number;
  coverageRatio: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  end: number;
}

/**
 * Per-phase durable evidence. Observed mechanical fields come from Bike Bridge
 * telemetry. Desired/commanded resistance retain recommendation and command
 * context and must never populate observed fields.
 */
export interface WorkoutPhaseResponse {
  phaseInstanceId: string;
  phaseId: string;
  kind: WorkoutPhaseKind;
  intensityId?: PhaseIntensityId;
  detailName?: string;
  intervalIndex?: number;
  activeStartSec: number;
  activeEndSec: number;
  plannedDurationSec: number;
  completedDurationSec: number;
  expectedHeartRate?: ResolvedHeartRateTarget;
  hr?: WorkoutResponseScalarSummary;
  watts?: WorkoutResponseScalarSummary & {
    provenance: "measured_watts" | "calibrated_watts" | "mixed";
  };
  cadenceRpm?: WorkoutResponseScalarSummary;
  /** Observed resistance from telemetry. */
  observedResistance?: WorkoutResponseScalarSummary;
  /** Recommendation / desired setting context. Not an observation. */
  desiredResistance?: WorkoutResponseScalarSummary;
  /** Commanded Bike Bridge setting when automatic control posted. Not an observation. */
  commandedResistance?: WorkoutResponseScalarSummary;
}

/**
 * WorkoutResponse is the durable phase-level summary of observed mechanical
 * workload and physiological response for ordinary workouts. It may also
 * retain recommendation and command context, but those fields are not
 * observations.
 *
 * prescription ≠ recommendation ≠ command ≠ observation ≠ physiological response
 *
 * Recommendation is intent. Observation is evidence of what physically happened.
 */
export interface WorkoutResponseV1 {
  schemaVersion: typeof WORKOUT_RESPONSE_SCHEMA_VERSION_V1;
  athleteId: string;
  sessionId: string;
  completion: {
    plannedActiveSec: number;
    completedActiveSec: number;
    completionFraction: number;
    cancelled: boolean;
    earlyCooldown: boolean;
  };
  evidence: {
    hr: {
      expectedDurationSec: number;
      validSampleCount: number;
      coverageRatio: number;
      source: "ble_chest_strap" | "unavailable";
    };
    bike: {
      expectedDurationSec: number;
      rowCount: number;
      freshSampleCount: number;
      staleSampleCount: number;
      unavailableSampleCount: number;
      implicitMissingCount: number;
      freshRowCoverageRatio: number;
      wattsProvenance: "measured_watts" | "calibrated_watts" | "mixed" | "unavailable";
    };
    rawTelemetry: {
      store: "ordinary_bike_telemetry";
      schemaVersion: typeof ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1;
    };
  };
  phases: WorkoutPhaseResponse[];
}

/** Persisted/read union. Add historical members here without relabeling prior schemas. */
export type WorkoutResponse = WorkoutResponseV1;
/** Writer alias. Advance this only when a new writer and matching parser are introduced. */
export type CurrentWorkoutResponse = WorkoutResponseV1;

export interface ZoneMinutes {
  z1: number;
  z2: number;
  z3: number;
  z4: number;
  z5: number;
}
