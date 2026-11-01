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

function nearlyEqual(a: number, b: number, tol = 0.001): boolean {
  return Math.abs(a - b) <= tol;
}

function parseScalarSummary(
  v: unknown,
  activeDurationSec: number
): FreestyleWorkloadScalarSummary | null {
  if (!isObject(v)) return null;
  if (!isNonNegativeInteger(v.sampleCount) || (v.sampleCount as number) === 0) return null;
  if ((v.sampleCount as number) > activeDurationSec) return null;
  if (!isRatio(v.coverageRatio)) return null;
  const expectedCoverage =
    activeDurationSec > 0
      ? Math.min(1, (v.sampleCount as number) / activeDurationSec)
      : 0;
  if (!nearlyEqual(v.coverageRatio as number, expectedCoverage)) return null;
  if (!isFiniteNumber(v.mean) || !isFiniteNumber(v.median)) return null;
  if (!isFiniteNumber(v.min) || !isFiniteNumber(v.max)) return null;
  if ((v.min as number) > (v.max as number)) return null;
  if ((v.median as number) < (v.min as number) || (v.median as number) > (v.max as number)) return null;
  if (!isObject(v.distribution)) return null;
  const dist = v.distribution as Record<string, unknown>;
  if (!isFiniteNumber(dist.q1) || !isFiniteNumber(dist.q3) || !isFiniteNumber(dist.iqr)) return null;
  if ((dist.q1 as number) > (dist.q3 as number)) return null;
  if ((dist.q1 as number) + 0.001 < (v.min as number)) return null;
  if ((dist.q3 as number) - 0.001 > (v.max as number)) return null;
  const expectedIqr = (dist.q3 as number) - (dist.q1 as number);
  if (!nearlyEqual(dist.iqr as number, expectedIqr)) return null;
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

function parseResistanceDistribution(
  v: unknown,
  activeDurationSec: number,
  coverageRatio: number
): FreestyleObservedResistanceDistribution[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const result: FreestyleObservedResistanceDistribution[] = [];
  let totalSeconds = 0;
  for (const item of v) {
    if (!isObject(item)) return null;
    if (!isNonNegativeFinite(item.level)) return null;
    if (!isNonNegativeInteger(item.activeSeconds) || (item.activeSeconds as number) === 0) return null;
    if (!isRatio(item.fraction)) return null;
    const seconds = item.activeSeconds as number;
    totalSeconds += seconds;
    const expectedFraction =
      activeDurationSec > 0 ? Math.min(1, seconds / activeDurationSec) : 0;
    if (!nearlyEqual(item.fraction as number, expectedFraction)) return null;
    result.push({
      level: item.level as number,
      activeSeconds: seconds,
      fraction: item.fraction as number,
    });
  }
  if (totalSeconds > activeDurationSec) return null;
  const expectedCoverage =
    activeDurationSec > 0 ? Math.min(1, totalSeconds / activeDurationSec) : 0;
  if (!nearlyEqual(coverageRatio, expectedCoverage)) return null;
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
  const startedAtMs = Date.parse(timing.startedAt as string);
  const endedAtMs = Date.parse(timing.endedAt as string);
  if (endedAtMs <= startedAtMs) return null;
  if (typeof timing.completedNaturally !== "boolean") return null;

  const activeDurationSec = timing.activeDurationSec as number;
  const pausedDurationSec = timing.pausedDurationSec as number;
  const wallClockSec = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (activeDurationSec > wallClockSec + 1) return null;
  if (activeDurationSec + pausedDurationSec > wallClockSec + 2) return null;

  // Evidence
  if (!isObject(raw.evidence)) return null;
  const evidence = raw.evidence as Record<string, unknown>;

  // Evidence.hr
  if (!isObject(evidence.hr)) return null;
  const hr = evidence.hr as Record<string, unknown>;
  if (!isNonNegativeInteger(hr.expectedDurationSec)) return null;
  if ((hr.expectedDurationSec as number) !== activeDurationSec) return null;
  if (!isNonNegativeInteger(hr.validSampleCount)) return null;
  if ((hr.validSampleCount as number) > activeDurationSec) return null;
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
  if (activeDurationSec > 0) {
    const expectedCoverage = Math.min(1, (hr.validSampleCount as number) / activeDurationSec);
    if (!nearlyEqual(hr.coverageRatio as number, expectedCoverage)) return null;
  } else if ((hr.validSampleCount as number) > 0 || (hr.coverageRatio as number) !== 0) {
    return null;
  }

  // Evidence.bike
  if (!isObject(evidence.bike)) return null;
  const bike = evidence.bike as Record<string, unknown>;
  if (!isNonNegativeInteger(bike.expectedDurationSec)) return null;
  if ((bike.expectedDurationSec as number) !== activeDurationSec) return null;
  if (!isNonNegativeInteger(bike.rowCount)) return null;
  if (!isNonNegativeInteger(bike.freshSampleCount)) return null;
  if (!isNonNegativeInteger(bike.staleSampleCount)) return null;
  if (!isNonNegativeInteger(bike.unavailableSampleCount)) return null;
  if (!isNonNegativeInteger(bike.implicitMissingCount)) return null;
  if (!isRatio(bike.freshRowCoverageRatio)) return null;
  const wattsProvenanceValues = ["measured_watts", "calibrated_watts", "mixed", "unavailable"];
  if (!wattsProvenanceValues.includes(bike.wattsProvenance as string)) return null;

  const freshCount = bike.freshSampleCount as number;
  const staleCount = bike.staleSampleCount as number;
  const unavailableCount = bike.unavailableSampleCount as number;
  const rowCount = bike.rowCount as number;
  if (freshCount + staleCount + unavailableCount !== rowCount) return null;
  if (rowCount > activeDurationSec) return null;
  const expectedImplicit = Math.max(0, activeDurationSec - rowCount);
  if ((bike.implicitMissingCount as number) !== expectedImplicit) return null;
  const expectedFreshCoverage =
    activeDurationSec > 0 ? Math.min(1, freshCount / activeDurationSec) : 0;
  if (!nearlyEqual(bike.freshRowCoverageRatio as number, expectedFreshCoverage)) return null;

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

  let parsedWorkload: FreestyleRideResponseV1["workload"] | undefined;
  if (raw.workload === undefined) {
    if (activeDurationSec > 0) return null;
  } else {
    if (!isObject(raw.workload)) return null;
    const wl = raw.workload as Record<string, unknown>;
    if (wl.workStatus !== "complete" && wl.workStatus !== "partial" && wl.workStatus !== "unavailable") return null;
    if (!isRatio(wl.powerCoverageRatio)) return null;

    const powerCoverageRatio = wl.powerCoverageRatio as number;
    const workStatus = wl.workStatus as "complete" | "partial" | "unavailable";
    if (workStatus === "complete" && powerCoverageRatio < 0.95) return null;
    if (workStatus === "partial" && !(powerCoverageRatio > 0 && powerCoverageRatio < 0.95)) return null;
    if (workStatus === "unavailable" && powerCoverageRatio !== 0) return null;

    if (wl.observedWorkJoules !== undefined && !isNonNegativeFinite(wl.observedWorkJoules)) return null;
    if (wl.observedWorkKj !== undefined && !isNonNegativeFinite(wl.observedWorkKj)) return null;
    if (wl.observedWorkJoules !== undefined && wl.observedWorkKj !== undefined) {
      const expectedKj = (wl.observedWorkJoules as number) / 1000;
      if (!nearlyEqual(wl.observedWorkKj as number, expectedKj, 0.01)) return null;
    }

    let watts: (FreestyleWorkloadScalarSummary & {
      provenance: "measured_watts" | "calibrated_watts" | "mixed";
    }) | undefined;
    if (wl.watts !== undefined) {
      if (!isObject(wl.watts)) return null;
      const w = wl.watts as Record<string, unknown>;
      if (w.provenance !== "measured_watts" && w.provenance !== "calibrated_watts" && w.provenance !== "mixed") return null;
      if ((bike.wattsProvenance as string) === "unavailable") return null;
      if (w.provenance !== bike.wattsProvenance) return null;
      const scalar = parseScalarSummary(w, activeDurationSec);
      if (!scalar) return null;
      if (!nearlyEqual(scalar.coverageRatio, powerCoverageRatio)) return null;
      watts = {
        ...scalar,
        provenance: w.provenance as "measured_watts" | "calibrated_watts" | "mixed",
      };
    }

    if (workStatus === "unavailable") {
      if (wl.observedWorkJoules !== undefined || wl.observedWorkKj !== undefined || watts) return null;
    } else {
      if (wl.observedWorkJoules === undefined || wl.observedWorkKj === undefined || !watts) return null;
    }

    let cadenceRpm: FreestyleWorkloadScalarSummary | undefined;
    if (wl.cadenceRpm !== undefined) {
      cadenceRpm = parseScalarSummary(wl.cadenceRpm, activeDurationSec) ?? undefined;
      if (!cadenceRpm) return null;
    }

    let observedResistance: NonNullable<FreestyleRideResponseV1["workload"]>["observedResistance"] | undefined;
    if (wl.observedResistance !== undefined) {
      if (!isObject(wl.observedResistance)) return null;
      const or = wl.observedResistance as Record<string, unknown>;
      if (!isRatio(or.coverageRatio)) return null;
      if (or.medianLevel !== undefined && !isNonNegativeFinite(or.medianLevel)) return null;
      const levels = parseResistanceDistribution(
        or.levelsUsed,
        activeDurationSec,
        or.coverageRatio as number
      );
      if (!levels) return null;
      observedResistance = {
        levelsUsed: levels,
        coverageRatio: or.coverageRatio as number,
        ...(or.medianLevel !== undefined ? { medianLevel: or.medianLevel as number } : {}),
      };
    }

    parsedWorkload = {
      workStatus,
      powerCoverageRatio,
      ...(wl.observedWorkJoules !== undefined ? { observedWorkJoules: wl.observedWorkJoules as number } : {}),
      ...(wl.observedWorkKj !== undefined ? { observedWorkKj: wl.observedWorkKj as number } : {}),
      ...(watts ? { watts } : {}),
      ...(cadenceRpm ? { cadenceRpm } : {}),
      ...(observedResistance ? { observedResistance } : {}),
    };
  }

  return {
    schemaVersion: FREESTYLE_RIDE_RESPONSE_SCHEMA_VERSION_V1,
    athleteId: raw.athleteId as string,
    sessionId: raw.sessionId as string,
    timing: {
      activeDurationSec,
      pausedDurationSec,
      startedAt: timing.startedAt as string,
      endedAt: timing.endedAt as string,
      completedNaturally: timing.completedNaturally as boolean,
    },
    evidence: parsedEvidence,
    ...(parsedWorkload ? { workload: parsedWorkload } : {}),
  };
}
