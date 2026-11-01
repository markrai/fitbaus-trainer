/**
 * Freestyle Ride Response contract (schema V1). Descriptive workload analytics
 * for open-ended, self-paced cycling sessions. Never impersonates structured
 * phase execution — WorkoutResponseV1 is for prescribed workouts only.
 */

import {
  ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
} from "./telemetry.js";

export const FREESTYLE_RIDE_RESPONSE_SCHEMA_VERSION_V1 = 1 as const;

export interface FreestyleWorkloadScalarSummary {
  sampleCount: number;
  coverageRatio: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  distribution: {
    q1: number;
    q3: number;
    iqr: number;
  };
}

export interface FreestyleObservedResistanceDistribution {
  level: number;
  activeSeconds: number;
  fraction: number;
}

export interface FreestyleRideResponseV1 {
  schemaVersion: typeof FREESTYLE_RIDE_RESPONSE_SCHEMA_VERSION_V1;
  athleteId: string;
  sessionId: string;
  timing: {
    activeDurationSec: number;
    pausedDurationSec: number;
    startedAt: string;
    endedAt: string;
    completedNaturally: boolean;
  };
  evidence: {
    hr: {
      expectedDurationSec: number;
      validSampleCount: number;
      coverageRatio: number;
      source: "ble_chest_strap" | "unavailable";
      meanBpm?: number;
      medianBpm?: number;
      minBpm?: number;
      maxBpm?: number;
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
    f1EvidenceIncomplete?: true;
  };
  workload?: {
    workStatus: "complete" | "partial" | "unavailable";
    observedWorkJoules?: number;
    observedWorkKj?: number;
    powerCoverageRatio: number;
    watts?: FreestyleWorkloadScalarSummary & {
      provenance: "measured_watts" | "calibrated_watts" | "mixed";
    };
    cadenceRpm?: FreestyleWorkloadScalarSummary;
    observedResistance?: {
      levelsUsed: FreestyleObservedResistanceDistribution[];
      medianLevel?: number;
      coverageRatio: number;
    };
  };
}

const OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonNegativeFinite(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0;
}

function isNonNegativeInteger(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0;
}

function isRatio(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0 && v <= 1;
}

function isIsoTimestamp(v: unknown): v is string {
  if (typeof v !== "string" || v === "") return false;
  const parsed = Date.parse(v);
  return Number.isFinite(parsed);
}

function isOwnerId(v: unknown): v is string {
  return typeof v === "string" && OWNER_ID_PATTERN.test(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseScalarSummary(v: unknown): FreestyleWorkloadScalarSummary | null {
  if (!isObject(v)) return null;
  if (!isNonNegativeInteger(v.sampleCount) || (v.sampleCount as number) === 0) return null;
  if (!isRatio(v.coverageRatio)) return null;
  if (!isFiniteNumber(v.mean) || !isFiniteNumber(v.median)) return null;
  if (!isFiniteNumber(v.min) || !isFiniteNumber(v.max)) return null;
  if ((v.min as number) > (v.max as number)) return null;
  if ((v.median as number) < (v.min as number) || (v.median as number) > (v.max as number)) return null;
  if (!isObject(v.distribution)) return null;
  const dist = v.distribution as Record<string, unknown>;
  if (!isFiniteNumber(dist.q1) || !isFiniteNumber(dist.q3) || !isFiniteNumber(dist.iqr)) return null;
  if ((dist.q1 as number) > (dist.q3 as number)) return null;
  const expectedIqr = (dist.q3 as number) - (dist.q1 as number);
  if (Math.abs((dist.iqr as number) - expectedIqr) > 0.001) return null;
  return {
    sampleCount: v.sampleCount as number,
    coverageRatio: v.coverageRatio as number,
    mean: v.mean as number,
    median: v.median as number,
    min: v.min as number,
    max: v.max as number,
    distribution: { q1: dist.q1 as number, q3: dist.q3 as number, iqr: dist.iqr as number },
  };
}

function parseResistanceDistribution(v: unknown): FreestyleObservedResistanceDistribution[] | null {
  if (!Array.isArray(v)) return null;
  const result: FreestyleObservedResistanceDistribution[] = [];
  for (const item of v) {
    if (!isObject(item)) return null;
    if (!isNonNegativeFinite(item.level)) return null;
    if (!isNonNegativeFinite(item.activeSeconds)) return null;
    if (!isRatio(item.fraction)) return null;
    result.push({
      level: item.level as number,
      activeSeconds: item.activeSeconds as number,
      fraction: item.fraction as number,
    });
  }
  return result;
}

/**
 * Strict fail-closed parser for FreestyleRideResponseV1. Returns null on any
 * structural, type, or consistency violation.
 */
export function parseFreestyleRideResponse(raw: unknown): FreestyleRideResponseV1 | null {
  if (!isObject(raw)) return null;
  if (raw.schemaVersion !== FREESTYLE_RIDE_RESPONSE_SCHEMA_VERSION_V1) return null;
  if (!isOwnerId(raw.athleteId) || !isOwnerId(raw.sessionId)) return null;

  // Timing
  if (!isObject(raw.timing)) return null;
  const timing = raw.timing as Record<string, unknown>;
  if (!isNonNegativeInteger(timing.activeDurationSec)) return null;
  if (!isNonNegativeFinite(timing.pausedDurationSec)) return null;
  if (!isIsoTimestamp(timing.startedAt) || !isIsoTimestamp(timing.endedAt)) return null;
  if (Date.parse(timing.endedAt as string) <= Date.parse(timing.startedAt as string)) return null;
  if (typeof timing.completedNaturally !== "boolean") return null;

  // Evidence
  if (!isObject(raw.evidence)) return null;
  const evidence = raw.evidence as Record<string, unknown>;

  // Evidence.hr
  if (!isObject(evidence.hr)) return null;
  const hr = evidence.hr as Record<string, unknown>;
  if (!isNonNegativeInteger(hr.expectedDurationSec)) return null;
  if (!isNonNegativeInteger(hr.validSampleCount)) return null;
  if (!isRatio(hr.coverageRatio)) return null;
  if (hr.source !== "ble_chest_strap" && hr.source !== "unavailable") return null;
  if (hr.source === "unavailable" && (hr.validSampleCount as number) > 0) return null;
  for (const optKey of ["meanBpm", "medianBpm", "minBpm", "maxBpm"] as const) {
    if (hr[optKey] !== undefined) {
      if (!isFiniteNumber(hr[optKey]) || (hr[optKey] as number) <= 0) return null;
    }
  }
  if (hr.minBpm !== undefined && hr.maxBpm !== undefined && (hr.minBpm as number) > (hr.maxBpm as number)) return null;
  if (hr.medianBpm !== undefined && hr.minBpm !== undefined && (hr.medianBpm as number) < (hr.minBpm as number)) return null;
  if (hr.medianBpm !== undefined && hr.maxBpm !== undefined && (hr.medianBpm as number) > (hr.maxBpm as number)) return null;

  // Cross-validate hr consistency: coverage = validSampleCount / expectedDurationSec
  if ((hr.expectedDurationSec as number) > 0) {
    const expectedCoverage = Math.min(1, (hr.validSampleCount as number) / (hr.expectedDurationSec as number));
    if (Math.abs((hr.coverageRatio as number) - expectedCoverage) > 0.001) return null;
  } else if ((hr.validSampleCount as number) > 0) {
    return null;
  }

  // Evidence.bike
  if (!isObject(evidence.bike)) return null;
  const bike = evidence.bike as Record<string, unknown>;
  if (!isNonNegativeInteger(bike.expectedDurationSec)) return null;
  if (!isNonNegativeInteger(bike.rowCount)) return null;
  if (!isNonNegativeInteger(bike.freshSampleCount)) return null;
  if (!isNonNegativeInteger(bike.staleSampleCount)) return null;
  if (!isNonNegativeInteger(bike.unavailableSampleCount)) return null;
  if (!isNonNegativeInteger(bike.implicitMissingCount)) return null;
  if (!isRatio(bike.freshRowCoverageRatio)) return null;
  const wattsProvenanceValues = ["measured_watts", "calibrated_watts", "mixed", "unavailable"];
  if (!wattsProvenanceValues.includes(bike.wattsProvenance as string)) return null;

  // Row count consistency: rowCount = freshSampleCount + staleSampleCount + unavailableSampleCount
  const rowSum = (bike.freshSampleCount as number) +
    (bike.staleSampleCount as number) +
    (bike.unavailableSampleCount as number);
  if (rowSum !== (bike.rowCount as number)) return null;

  // Evidence.rawTelemetry
  if (!isObject(evidence.rawTelemetry)) return null;
  const rawTelem = evidence.rawTelemetry as Record<string, unknown>;
  if (rawTelem.store !== "ordinary_bike_telemetry") return null;
  if (rawTelem.schemaVersion !== ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1) return null;

  // Evidence.f1EvidenceIncomplete
  if (evidence.f1EvidenceIncomplete !== undefined && evidence.f1EvidenceIncomplete !== true) return null;

  // Assemble evidence
  const parsedEvidence: FreestyleRideResponseV1["evidence"] = {
    hr: {
      expectedDurationSec: hr.expectedDurationSec as number,
      validSampleCount: hr.validSampleCount as number,
      coverageRatio: hr.coverageRatio as number,
      source: hr.source as "ble_chest_strap" | "unavailable",
      ...(hr.meanBpm !== undefined ? { meanBpm: hr.meanBpm as number } : {}),
      ...(hr.medianBpm !== undefined ? { medianBpm: hr.medianBpm as number } : {}),
      ...(hr.minBpm !== undefined ? { minBpm: hr.minBpm as number } : {}),
      ...(hr.maxBpm !== undefined ? { maxBpm: hr.maxBpm as number } : {}),
    },
    bike: {
      expectedDurationSec: bike.expectedDurationSec as number,
      rowCount: bike.rowCount as number,
      freshSampleCount: bike.freshSampleCount as number,
      staleSampleCount: bike.staleSampleCount as number,
      unavailableSampleCount: bike.unavailableSampleCount as number,
      implicitMissingCount: bike.implicitMissingCount as number,
      freshRowCoverageRatio: bike.freshRowCoverageRatio as number,
      wattsProvenance: bike.wattsProvenance as FreestyleRideResponseV1["evidence"]["bike"]["wattsProvenance"],
    },
    rawTelemetry: {
      store: "ordinary_bike_telemetry",
      schemaVersion: ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
    },
    ...(evidence.f1EvidenceIncomplete === true ? { f1EvidenceIncomplete: true as const } : {}),
  };

  // Workload (optional)
  let parsedWorkload: FreestyleRideResponseV1["workload"] | undefined;
  if (raw.workload !== undefined) {
    if (!isObject(raw.workload)) return null;
    const wl = raw.workload as Record<string, unknown>;
    if (wl.workStatus !== "complete" && wl.workStatus !== "partial" && wl.workStatus !== "unavailable") return null;
    if (!isRatio(wl.powerCoverageRatio)) return null;

    if (wl.observedWorkJoules !== undefined && !isNonNegativeFinite(wl.observedWorkJoules)) return null;
    if (wl.observedWorkKj !== undefined && !isNonNegativeFinite(wl.observedWorkKj)) return null;
    // kJ/J consistency
    if (wl.observedWorkJoules !== undefined && wl.observedWorkKj !== undefined) {
      const expectedKj = (wl.observedWorkJoules as number) / 1000;
      if (Math.abs((wl.observedWorkKj as number) - expectedKj) > 0.01) return null;
    }

    let watts: (FreestyleWorkloadScalarSummary & { provenance: string }) | undefined;
    if (wl.watts !== undefined) {
      if (!isObject(wl.watts)) return null;
      const w = wl.watts as Record<string, unknown>;
      if (w.provenance !== "measured_watts" && w.provenance !== "calibrated_watts" && w.provenance !== "mixed") return null;
      const scalar = parseScalarSummary(w);
      if (!scalar) return null;
      watts = { ...scalar, provenance: w.provenance as string };
    }

    let cadenceRpm: FreestyleWorkloadScalarSummary | undefined;
    if (wl.cadenceRpm !== undefined) {
      cadenceRpm = parseScalarSummary(wl.cadenceRpm) ?? undefined;
      if (wl.cadenceRpm !== undefined && !cadenceRpm) return null;
    }

    let observedResistance: FreestyleRideResponseV1["workload"] extends undefined ? never : NonNullable<NonNullable<FreestyleRideResponseV1["workload"]>["observedResistance"]> | undefined;
    if (wl.observedResistance !== undefined) {
      if (!isObject(wl.observedResistance)) return null;
      const or = wl.observedResistance as Record<string, unknown>;
      const levels = parseResistanceDistribution(or.levelsUsed);
      if (!levels) return null;
      if (!isRatio(or.coverageRatio)) return null;
      if (or.medianLevel !== undefined && !isNonNegativeFinite(or.medianLevel)) return null;
      observedResistance = {
        levelsUsed: levels,
        coverageRatio: or.coverageRatio as number,
        ...(or.medianLevel !== undefined ? { medianLevel: or.medianLevel as number } : {}),
      };
    }

    parsedWorkload = {
      workStatus: wl.workStatus as "complete" | "partial" | "unavailable",
      powerCoverageRatio: wl.powerCoverageRatio as number,
      ...(wl.observedWorkJoules !== undefined ? { observedWorkJoules: wl.observedWorkJoules as number } : {}),
      ...(wl.observedWorkKj !== undefined ? { observedWorkKj: wl.observedWorkKj as number } : {}),
      ...(watts ? { watts: watts as any } : {}),
      ...(cadenceRpm ? { cadenceRpm } : {}),
      ...(observedResistance ? { observedResistance } : {}),
    };
  }

  return {
    schemaVersion: FREESTYLE_RIDE_RESPONSE_SCHEMA_VERSION_V1,
    athleteId: raw.athleteId as string,
    sessionId: raw.sessionId as string,
    timing: {
      activeDurationSec: timing.activeDurationSec as number,
      pausedDurationSec: timing.pausedDurationSec as number,
      startedAt: timing.startedAt as string,
      endedAt: timing.endedAt as string,
      completedNaturally: timing.completedNaturally as boolean,
    },
    evidence: parsedEvidence,
    ...(parsedWorkload ? { workload: parsedWorkload } : {}),
  };
}
