/**
 * Pure, deterministic Freestyle ride response derivation engine (Level A analytics).
 * Computes descriptive workload statistics from raw telemetry without interpolation
 * or extrapolation. Reuses numericDistribution/numericMedian from workloadForwardResponse.
 */

import {
  FREESTYLE_RIDE_RESPONSE_SCHEMA_VERSION_V1,
  type FreestyleRideResponseV1,
  type FreestyleWorkloadScalarSummary,
  type FreestyleObservedResistanceDistribution,
} from "./contracts/freestyleRideResponse.js";
import { ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1 } from "./contracts/telemetry.js";
import type { OrdinaryBikeTelemetrySample, HrSample, BikeWattsProvenance } from "./types.js";
import { numericDistribution, numericMedian } from "./workloadForwardResponse.js";

export interface DeriveFreestyleRideResponseInput {
  athleteId: string;
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  activeDurationSec: number;
  pausedDurationSec: number;
  cancelled?: boolean;
  evidenceIncomplete?: boolean;
  hrSamples: readonly HrSample[];
  bikeSamples: readonly OrdinaryBikeTelemetrySample[];
}

const OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

function isOwnerId(v: unknown): v is string {
  return typeof v === "string" && OWNER_ID_PATTERN.test(v);
}

function clampRatio(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function roundTo(v: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(v * factor) / factor;
}

/**
 * Deduplicate bike samples by activeSec within session scope.
 * Prefer fresh > stale > unavailable. Never double-count a second.
 */
function deduplicateSamples(
  samples: readonly OrdinaryBikeTelemetrySample[],
  sessionId: string,
  athleteId: string,
  activeDurationSec: number
): OrdinaryBikeTelemetrySample[] {
  const bySecond = new Map<number, OrdinaryBikeTelemetrySample>();
  const priority: Record<string, number> = { fresh: 3, stale: 2, unavailable: 1 };

  for (const sample of samples) {
    if (!sample) continue;
    if (sample.sessionId !== sessionId) continue;
    if (sample.athleteId !== athleteId) continue;
    if (sample.activeSec < 0 || sample.activeSec >= activeDurationSec) continue;
    if (!Number.isInteger(sample.activeSec)) continue;

    const existing = bySecond.get(sample.activeSec);
    if (!existing || (priority[sample.availability] ?? 0) > (priority[existing.availability] ?? 0)) {
      bySecond.set(sample.activeSec, sample);
    }
  }

  return [...bySecond.values()].sort((a, b) => a.activeSec - b.activeSec);
}

function buildScalarSummary(
  values: readonly number[],
  activeDurationSec: number
): FreestyleWorkloadScalarSummary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const dist = numericDistribution(sorted);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const q1 = dist.q1;
  const q3 = dist.q3;
  return {
    sampleCount: values.length,
    coverageRatio: clampRatio(activeDurationSec > 0 ? values.length / activeDurationSec : 0),
    mean: roundTo(mean, 2),
    median: roundTo(dist.median, 2),
    min: roundTo(dist.min, 2),
    max: roundTo(dist.max, 2),
    distribution: {
      q1: roundTo(q1, 2),
      q3: roundTo(q3, 2),
      iqr: roundTo(q3 - q1, 2),
    },
  };
}

/**
 * Derive a FreestyleRideResponseV1 from raw telemetry. Returns null if
 * identity or timing is fundamentally invalid (fail-closed).
 */
export function deriveFreestyleRideResponse(
  input: DeriveFreestyleRideResponseInput
): FreestyleRideResponseV1 | null {
  // Identity and timing validation
  if (!isOwnerId(input.athleteId) || !isOwnerId(input.sessionId)) return null;
  if (
    !Number.isFinite(input.startedAtMs) ||
    !Number.isFinite(input.endedAtMs) ||
    input.endedAtMs <= input.startedAtMs
  ) return null;
  if (
    !Number.isFinite(input.activeDurationSec) ||
    input.activeDurationSec < 0 ||
    !Number.isInteger(input.activeDurationSec)
  ) return null;
  if (!Number.isFinite(input.pausedDurationSec) || input.pausedDurationSec < 0) return null;

  const activeDurationSec = input.activeDurationSec;
  const startedAt = new Date(input.startedAtMs).toISOString();
  const endedAt = new Date(input.endedAtMs).toISOString();

  // ── Bike telemetry analysis ──
  const deduped = deduplicateSamples(input.bikeSamples, input.sessionId, input.athleteId, activeDurationSec);

  let freshCount = 0;
  let staleCount = 0;
  let unavailableCount = 0;
  const uniqueSeconds = new Set<number>();

  for (const s of deduped) {
    uniqueSeconds.add(s.activeSec);
    switch (s.availability) {
      case "fresh": freshCount++; break;
      case "stale": staleCount++; break;
      case "unavailable": unavailableCount++; break;
    }
  }

  const rowCount = deduped.length;
  const implicitMissingCount = Math.max(0, activeDurationSec - uniqueSeconds.size);
  const freshRowCoverageRatio = clampRatio(activeDurationSec > 0 ? freshCount / activeDurationSec : 0);

  // ── Watts / Work computation (fresh rows only, watts defined, 0 W valid) ──
  const freshWithWatts: { activeSec: number; watts: number; provenance: BikeWattsProvenance }[] = [];
  const freshCadenceValues: number[] = [];
  const freshResistanceSamples: { activeSec: number; level: number }[] = [];

  const provenanceSet = new Set<BikeWattsProvenance>();

  for (const s of deduped) {
    if (s.availability !== "fresh") continue;
    if (s.watts !== undefined) {
      freshWithWatts.push({
        activeSec: s.activeSec,
        watts: s.watts.value,
        provenance: s.watts.source,
      });
      provenanceSet.add(s.watts.source);
    }
    if (s.cadenceRpm !== undefined) {
      freshCadenceValues.push(s.cadenceRpm.value);
    }
    if (s.observedResistance !== undefined) {
      freshResistanceSamples.push({
        activeSec: s.activeSec,
        level: s.observedResistance.value,
      });
    }
  }

  // Each unique activeSec with watts = 1 second of work; no interpolation
  const wattsPerSecond = new Map<number, number>();
  for (const entry of freshWithWatts) {
    if (!wattsPerSecond.has(entry.activeSec)) {
      wattsPerSecond.set(entry.activeSec, entry.watts);
    }
  }

  const workSeconds = wattsPerSecond.size;
  const powerCoverageRatio = clampRatio(activeDurationSec > 0 ? workSeconds / activeDurationSec : 0);

  let wattsProvenance: FreestyleRideResponseV1["evidence"]["bike"]["wattsProvenance"];
  if (provenanceSet.size === 0) {
    wattsProvenance = "unavailable";
  } else if (provenanceSet.size === 1) {
    wattsProvenance = [...provenanceSet][0];
  } else {
    wattsProvenance = "mixed";
  }

  // Work = sum of watts for each unique second
  let observedWorkJoules: number | undefined;
  let observedWorkKj: number | undefined;
  const wattsValues = [...wattsPerSecond.values()];

  if (workSeconds > 0) {
    observedWorkJoules = wattsValues.reduce((s, w) => s + w, 0);
    observedWorkKj = roundTo(observedWorkJoules / 1000, 3);
    observedWorkJoules = roundTo(observedWorkJoules, 2);
  }

  // Work status
  let workStatus: "complete" | "partial" | "unavailable";
  if (powerCoverageRatio >= 0.95) {
    workStatus = "complete";
  } else if (powerCoverageRatio > 0) {
    workStatus = "partial";
  } else {
    workStatus = "unavailable";
  }

  // Watts scalar summary
  let wattsSummary: (FreestyleWorkloadScalarSummary & { provenance: "measured_watts" | "calibrated_watts" | "mixed" }) | undefined;
  if (wattsValues.length > 0 && wattsProvenance !== "unavailable") {
    const scalar = buildScalarSummary(wattsValues, activeDurationSec);
    if (scalar) {
      wattsSummary = {
        ...scalar,
        provenance: wattsProvenance as "measured_watts" | "calibrated_watts" | "mixed",
      };
    }
  }

  // Cadence (independent, fresh only, 0 rpm valid)
  let cadenceSummary: FreestyleWorkloadScalarSummary | undefined;
  if (freshCadenceValues.length > 0) {
    cadenceSummary = buildScalarSummary(freshCadenceValues, activeDurationSec) ?? undefined;
  }

  // Resistance distribution (fresh only, gaps not forward-filled)
  let observedResistance: NonNullable<FreestyleRideResponseV1["workload"]>["observedResistance"] | undefined;
  if (freshResistanceSamples.length > 0) {
    const levelMap = new Map<number, number>();
    for (const s of freshResistanceSamples) {
      levelMap.set(s.level, (levelMap.get(s.level) ?? 0) + 1);
    }
    const levelsUsed: FreestyleObservedResistanceDistribution[] = [];
    for (const [level, seconds] of [...levelMap.entries()].sort((a, b) => a[0] - b[0])) {
      levelsUsed.push({
        level,
        activeSeconds: seconds,
        fraction: clampRatio(activeDurationSec > 0 ? seconds / activeDurationSec : 0),
      });
    }
    const resistanceLevels = freshResistanceSamples.map((s) => s.level);
    const resistanceCoverage = clampRatio(
      activeDurationSec > 0 ? freshResistanceSamples.length / activeDurationSec : 0
    );
    observedResistance = {
      levelsUsed,
      coverageRatio: resistanceCoverage,
      ...(resistanceLevels.length > 0 ? { medianLevel: roundTo(numericMedian(resistanceLevels), 1) } : {}),
    };
  }

  // Build workload section
  const hasWorkload = workSeconds > 0 || cadenceSummary || observedResistance;
  const workload: FreestyleRideResponseV1["workload"] | undefined = hasWorkload
    ? {
        workStatus,
        powerCoverageRatio,
        ...(observedWorkJoules !== undefined ? { observedWorkJoules } : {}),
        ...(observedWorkKj !== undefined ? { observedWorkKj } : {}),
        ...(wattsSummary ? { watts: wattsSummary } : {}),
        ...(cadenceSummary ? { cadenceRpm: cadenceSummary } : {}),
        ...(observedResistance ? { observedResistance } : {}),
      }
    : activeDurationSec > 0
      ? { workStatus: "unavailable", powerCoverageRatio: 0 }
      : undefined;

  // ── HR analysis ──
  const validHrSamples: number[] = [];
  const hrSecondsSeen = new Set<number>();
  for (const sample of input.hrSamples) {
    if (sample.session_id !== input.sessionId) continue;
    if (typeof sample.hr !== "number" || !Number.isFinite(sample.hr) || sample.hr <= 0) continue;
    if (typeof sample.timestamp_sec !== "number" || !Number.isFinite(sample.timestamp_sec)) continue;
    if (sample.timestamp_sec < 0 || sample.timestamp_sec >= activeDurationSec) continue;
    if (!hrSecondsSeen.has(Math.floor(sample.timestamp_sec))) {
      hrSecondsSeen.add(Math.floor(sample.timestamp_sec));
      validHrSamples.push(sample.hr);
    }
  }

  const hrCoverage = clampRatio(activeDurationSec > 0 ? validHrSamples.length / activeDurationSec : 0);
  const hrSource: "ble_chest_strap" | "unavailable" = validHrSamples.length > 0 ? "ble_chest_strap" : "unavailable";

  let hrStats: Pick<FreestyleRideResponseV1["evidence"]["hr"], "meanBpm" | "medianBpm" | "minBpm" | "maxBpm"> = {};
  if (validHrSamples.length > 0) {
    const hrDist = numericDistribution(validHrSamples);
    const hrMean = validHrSamples.reduce((s, v) => s + v, 0) / validHrSamples.length;
    hrStats = {
      meanBpm: roundTo(hrMean, 1),
      medianBpm: roundTo(hrDist.median, 1),
      minBpm: roundTo(hrDist.min, 1),
      maxBpm: roundTo(hrDist.max, 1),
    };
  }

  const response: FreestyleRideResponseV1 = {
    schemaVersion: FREESTYLE_RIDE_RESPONSE_SCHEMA_VERSION_V1,
    athleteId: input.athleteId,
    sessionId: input.sessionId,
    timing: {
      activeDurationSec,
      pausedDurationSec: input.pausedDurationSec,
      startedAt,
      endedAt,
      completedNaturally: input.cancelled !== true,
    },
    evidence: {
      hr: {
        expectedDurationSec: activeDurationSec,
        validSampleCount: validHrSamples.length,
        coverageRatio: hrCoverage,
        source: hrSource,
        ...hrStats,
      },
      bike: {
        expectedDurationSec: activeDurationSec,
        rowCount,
        freshSampleCount: freshCount,
        staleSampleCount: staleCount,
        unavailableSampleCount: unavailableCount,
        implicitMissingCount,
        freshRowCoverageRatio,
        wattsProvenance,
      },
      rawTelemetry: {
        store: "ordinary_bike_telemetry",
        schemaVersion: ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
      },
      ...(input.evidenceIncomplete === true ? { f1EvidenceIncomplete: true as const } : {}),
    },
    ...(workload ? { workload } : {}),
  };

  return response;
}
