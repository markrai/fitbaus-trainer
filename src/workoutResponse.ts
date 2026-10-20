import {
  ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
  WORKOUT_RESPONSE_SCHEMA_VERSION,
  WORKOUT_RESPONSE_SCHEMA_VERSION_V1,
  type CurrentWorkoutResponse,
  type HrSample,
  type OrdinaryBikeTelemetrySample,
  type PhaseIntensityId,
  type PlanBlock,
  type ResolvedHeartRateTarget,
  type ResolvedWorkoutPhaseTarget,
  type ResolvedWorkoutPrescription,
  type WorkoutPhaseKind,
  type WorkoutPhaseResponse,
  type WorkoutResponse,
  type WorkoutResponseV1,
  type WorkoutResponseScalarSummary,
} from "./types.js";
import { parseOrdinaryBikeTelemetrySample } from "./ordinaryWorkoutTelemetry.js";
import { parseResolvedWorkoutPrescription } from "./workoutPrescription.js";
import { canonicalMedian } from "./stats.js";

/**
 * WorkoutResponse is the durable phase-level summary of observed mechanical
 * workload and physiological response for ordinary workouts. It may also
 * retain recommendation and command context, but those fields are not
 * observations.
 *
 * Authority chain:
 *   prescription ≠ recommendation ≠ command ≠ observation ≠ physiological response
 *
 * Recommendation is intent. Observation is evidence of what physically happened.
 * Derived performed-load statistics (mode, MAD, paired-row agreement) describe
 * variation and are not compliance grades; they are computed at read time and
 * are not persisted on this schema.
 */

const OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_ACTIVE_DURATION_SEC = 24 * 60 * 60;
const MAX_PHASE_COUNT = 2000;
const PHASE_KINDS = new Set<WorkoutPhaseKind>(["warmup", "work", "recovery", "cooldown"]);
const INTENSITY_IDS = new Set<PhaseIntensityId>([
  "warmup_easy",
  "aerobic_base",
  "threshold",
  "vo2_short",
  "vo2_long",
  "recovery",
  "cooldown",
  "strength_support",
]);

export interface DeriveWorkoutResponseInput {
  athleteId: string;
  sessionId: string;
  blocks: PlanBlock;
  resolvedPrescription: ResolvedWorkoutPrescription;
  completedActiveSec: number;
  cancelled: boolean;
  earlyCooldownElapsed?: number | null;
  hrSamples: readonly HrSample[];
  bikeSamples: readonly OrdinaryBikeTelemetrySample[];
}

interface PhaseWindow {
  phaseInstanceId: string;
  phaseId: string;
  kind: WorkoutPhaseKind;
  intensityId?: PhaseIntensityId;
  detailName?: string;
  intervalIndex?: number;
  activeStartSec: number;
  activeEndSec: number;
  expectedHeartRate?: ResolvedHeartRateTarget;
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

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function ratio(count: number, expected: number): number {
  return expected > 0 ? clampRatio(count / expected) : 0;
}

function ratiosEqual(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-9;
}

function summarize(values: readonly { at: number; value: number }[], expectedDurationSec: number): WorkoutResponseScalarSummary | undefined {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((a, b) => a.at - b.at);
  const numbers = ordered.map((entry) => entry.value);
  const median = canonicalMedian(numbers);
  if (median === undefined) return undefined;
  return {
    sampleCount: numbers.length,
    coverageRatio: ratio(numbers.length, expectedDurationSec),
    mean: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
    median,
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    end: ordered[ordered.length - 1].value,
  };
}

function genericTarget(
  prescription: ResolvedWorkoutPrescription,
  phaseId: string
): ResolvedWorkoutPhaseTarget | undefined {
  return prescription.phases.find(
    (phase) => phase.phaseId === phaseId && phase.activeStartSec === undefined && phase.activeEndSec === undefined
  );
}

function descriptorAt(
  activeSec: number,
  blocks: PlanBlock,
  prescription: ResolvedWorkoutPrescription,
  earlyCooldownElapsed: number | null
): Omit<PhaseWindow, "phaseInstanceId" | "activeStartSec" | "activeEndSec"> | null {
  const warmEnd = Math.round(blocks.warm * 60);
  const sustainEnd = warmEnd + Math.round(blocks.sustain * 60);
  const normalEnd = sustainEnd + Math.round(blocks.cool * 60);
  if (earlyCooldownElapsed != null && activeSec >= earlyCooldownElapsed) {
    if (activeSec >= earlyCooldownElapsed + Math.round(blocks.cool * 60)) return null;
    const target = genericTarget(prescription, "cooldown");
    return {
      phaseId: "cooldown",
      kind: "cooldown",
      intensityId: target?.intensityId,
      detailName: target?.detailName,
      intervalIndex: target?.intervalIndex,
      expectedHeartRate: target?.expectedHeartRate,
    };
  }
  if (activeSec >= normalEnd) return null;
  const timed = prescription.phases.find(
    (phase) =>
      phase.activeStartSec !== undefined &&
      phase.activeEndSec !== undefined &&
      activeSec >= phase.activeStartSec &&
      activeSec < phase.activeEndSec
  );
  if (timed) {
    return {
      phaseId: timed.phaseId,
      kind: timed.kind,
      intensityId: timed.intensityId,
      detailName: timed.detailName,
      intervalIndex: timed.intervalIndex,
      expectedHeartRate: timed.expectedHeartRate,
    };
  }
  const phaseId = activeSec < warmEnd ? "warmup" : activeSec < sustainEnd ? "sustain" : "cooldown";
  const fallbackKind: WorkoutPhaseKind = phaseId === "warmup" ? "warmup" : phaseId === "cooldown" ? "cooldown" : "work";
  const target = genericTarget(prescription, phaseId);
  return {
    phaseId,
    kind: target?.kind ?? fallbackKind,
    intensityId: target?.intensityId,
    detailName: target?.detailName,
    intervalIndex: target?.intervalIndex,
    expectedHeartRate: target?.expectedHeartRate,
  };
}

function descriptorKey(value: ReturnType<typeof descriptorAt>): string {
  if (!value) return "none";
  return [
    value.phaseId,
    value.kind,
    value.intensityId ?? "",
    value.detailName ?? "",
    value.intervalIndex ?? "",
  ].join("|");
}

function frozenPhaseWindows(
  blocks: PlanBlock,
  prescription: ResolvedWorkoutPrescription,
  earlyCooldownElapsed: number | null
): PhaseWindow[] {
  const ordinaryEnd = Math.round((blocks.warm + blocks.sustain + blocks.cool) * 60);
  const end = earlyCooldownElapsed == null
    ? ordinaryEnd
    : Math.min(ordinaryEnd, Math.round(earlyCooldownElapsed) + Math.round(blocks.cool * 60));
  const windows: PhaseWindow[] = [];
  const identityCounts = new Map<string, number>();
  let current: ReturnType<typeof descriptorAt> = null;
  let currentKey = "none";
  let start = 0;
  const append = (descriptor: NonNullable<typeof current>, from: number, to: number) => {
    const base = `${descriptor.phaseId}@${from}-${to}`;
    const occurrence = (identityCounts.get(base) ?? 0) + 1;
    identityCounts.set(base, occurrence);
    windows.push({
      phaseInstanceId: occurrence === 1 ? base : `${base}#${occurrence}`,
      ...descriptor,
      activeStartSec: from,
      activeEndSec: to,
    });
  };
  for (let second = 0; second <= end; second++) {
    const next = second < end ? descriptorAt(second, blocks, prescription, earlyCooldownElapsed) : null;
    const nextKey = descriptorKey(next);
    if (second === 0) {
      current = next;
      currentKey = nextKey;
      start = 0;
      continue;
    }
    if (nextKey !== currentKey) {
      if (current) append(current, start, second);
      current = next;
      currentKey = nextKey;
      start = second;
    }
  }
  return windows;
}

function provenance(samples: readonly OrdinaryBikeTelemetrySample[]): "measured_watts" | "calibrated_watts" | "mixed" | "unavailable" {
  const sources = new Set(samples.map((sample) => sample.watts?.source).filter(Boolean));
  if (sources.size === 0) return "unavailable";
  if (sources.size > 1) return "mixed";
  return sources.has("measured_watts") ? "measured_watts" : "calibrated_watts";
}

function phaseResponse(
  window: PhaseWindow,
  completedActiveSec: number,
  hrSamples: readonly HrSample[],
  bikeSamples: readonly OrdinaryBikeTelemetrySample[]
): WorkoutPhaseResponse {
  const completedEnd = Math.min(window.activeEndSec, completedActiveSec);
  const completedDurationSec = Math.max(0, completedEnd - window.activeStartSec);
  const hr = hrSamples
    .filter((sample) => sample.timestamp_sec >= window.activeStartSec && sample.timestamp_sec < completedEnd)
    .map((sample) => ({ at: sample.timestamp_sec, value: sample.hr }));
  const bike = bikeSamples.filter(
    (sample) => sample.activeSec >= window.activeStartSec && sample.activeSec < completedEnd
  );
  const watts = summarize(
    bike.filter((sample) => sample.watts).map((sample) => ({ at: sample.activeSec, value: sample.watts!.value })),
    completedDurationSec
  );
  const cadenceRpm = summarize(
    bike.filter((sample) => sample.cadenceRpm).map((sample) => ({ at: sample.activeSec, value: sample.cadenceRpm!.value })),
    completedDurationSec
  );
  const observedResistance = summarize(
    bike.filter((sample) => sample.observedResistance).map((sample) => ({ at: sample.activeSec, value: sample.observedResistance!.value })),
    completedDurationSec
  );
  return {
    phaseInstanceId: window.phaseInstanceId,
    phaseId: window.phaseId,
    kind: window.kind,
    ...(window.intensityId ? { intensityId: window.intensityId } : {}),
    ...(window.detailName ? { detailName: window.detailName } : {}),
    ...(window.intervalIndex !== undefined ? { intervalIndex: window.intervalIndex } : {}),
    activeStartSec: window.activeStartSec,
    activeEndSec: window.activeEndSec,
    plannedDurationSec: window.activeEndSec - window.activeStartSec,
    completedDurationSec,
    ...(window.expectedHeartRate ? { expectedHeartRate: { ...window.expectedHeartRate } } : {}),
    ...(summarize(hr, completedDurationSec) ? { hr: summarize(hr, completedDurationSec) } : {}),
    ...(watts ? { watts: { ...watts, provenance: provenance(bike) as "measured_watts" | "calibrated_watts" | "mixed" } } : {}),
    ...(cadenceRpm ? { cadenceRpm } : {}),
    ...(observedResistance ? { observedResistance } : {}),
    ...(summarize(
      bike.filter((sample) => sample.desiredResistance !== undefined).map((sample) => ({ at: sample.activeSec, value: sample.desiredResistance! })),
      completedDurationSec
    ) ? {
      desiredResistance: summarize(
        bike.filter((sample) => sample.desiredResistance !== undefined).map((sample) => ({ at: sample.activeSec, value: sample.desiredResistance! })),
        completedDurationSec
      ),
    } : {}),
    ...(summarize(
      bike.filter((sample) => sample.commandedResistance !== undefined).map((sample) => ({ at: sample.activeSec, value: sample.commandedResistance! })),
      completedDurationSec
    ) ? {
      commandedResistance: summarize(
        bike.filter((sample) => sample.commandedResistance !== undefined).map((sample) => ({ at: sample.activeSec, value: sample.commandedResistance! })),
        completedDurationSec
      ),
    } : {}),
  };
}

export function deriveWorkoutResponse(input: DeriveWorkoutResponseInput): CurrentWorkoutResponse | null {
  if (!isOwnerId(input.athleteId) || !isOwnerId(input.sessionId)) return null;
  if (
    !isNonNegativeFinite(input.blocks.warm) ||
    !isNonNegativeFinite(input.blocks.sustain) ||
    !isNonNegativeFinite(input.blocks.cool) ||
    !isNonNegativeInteger(input.completedActiveSec)
  ) {
    return null;
  }
  const prescription = parseResolvedWorkoutPrescription(input.resolvedPrescription);
  if (!prescription) return null;
  const earlyCooldownElapsed = input.earlyCooldownElapsed == null
    ? null
    : isNonNegativeFinite(input.earlyCooldownElapsed)
      ? Math.round(input.earlyCooldownElapsed)
      : null;
  const plannedActiveSec = Math.round((input.blocks.warm + input.blocks.sustain + input.blocks.cool) * 60);
  const completedActiveSec = Math.min(input.completedActiveSec, 24 * 60 * 60);
  const hrBySecond = new Map<number, HrSample>();
  for (const sample of input.hrSamples) {
    if (
      sample.session_id !== input.sessionId ||
      !isNonNegativeInteger(sample.timestamp_sec) ||
      !isFiniteNumber(sample.hr) ||
      sample.hr < 30 ||
      sample.hr > 250 ||
      sample.timestamp_sec >= completedActiveSec
    ) {
      continue;
    }
    hrBySecond.set(sample.timestamp_sec, { ...sample });
  }
  const bikeBySecond = new Map<number, OrdinaryBikeTelemetrySample>();
  const sourceIds = new Set<string>();
  for (const value of input.bikeSamples) {
    const sample = parseOrdinaryBikeTelemetrySample(value);
    if (
      !sample ||
      sample.athleteId !== input.athleteId ||
      sample.sessionId !== input.sessionId ||
      sample.activeSec >= completedActiveSec ||
      bikeBySecond.has(sample.activeSec) ||
      (sample.sourceSampleId && sourceIds.has(sample.sourceSampleId))
    ) {
      continue;
    }
    bikeBySecond.set(sample.activeSec, sample);
    if (sample.sourceSampleId) sourceIds.add(sample.sourceSampleId);
  }
  const hrSamples = [...hrBySecond.values()].sort((a, b) => a.timestamp_sec - b.timestamp_sec);
  const bikeSamples = [...bikeBySecond.values()].sort((a, b) => a.activeSec - b.activeSec);
  const freshSampleCount = bikeSamples.filter((sample) => sample.availability === "fresh").length;
  const staleSampleCount = bikeSamples.filter((sample) => sample.availability === "stale").length;
  const unavailableSampleCount = bikeSamples.filter((sample) => sample.availability === "unavailable").length;
  const implicitMissingCount = Math.max(0, completedActiveSec - bikeSamples.length);
  const response: CurrentWorkoutResponse = {
    schemaVersion: WORKOUT_RESPONSE_SCHEMA_VERSION,
    athleteId: input.athleteId,
    sessionId: input.sessionId,
    completion: {
      plannedActiveSec,
      completedActiveSec,
      completionFraction: plannedActiveSec > 0 ? clampRatio(completedActiveSec / plannedActiveSec) : 0,
      cancelled: input.cancelled,
      earlyCooldown: earlyCooldownElapsed != null,
    },
    evidence: {
      hr: {
        expectedDurationSec: completedActiveSec,
        validSampleCount: hrSamples.length,
        coverageRatio: ratio(hrSamples.length, completedActiveSec),
        source: hrSamples.length > 0 ? "ble_chest_strap" : "unavailable",
      },
      bike: {
        expectedDurationSec: completedActiveSec,
        rowCount: bikeSamples.length,
        freshSampleCount,
        staleSampleCount,
        unavailableSampleCount,
        implicitMissingCount,
        freshRowCoverageRatio: ratio(freshSampleCount, completedActiveSec),
        wattsProvenance: provenance(bikeSamples),
      },
      rawTelemetry: {
        store: "ordinary_bike_telemetry",
        schemaVersion: ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
      },
    },
    phases: frozenPhaseWindows(input.blocks, prescription, earlyCooldownElapsed).map((window) =>
      phaseResponse(window, completedActiveSec, hrSamples, bikeSamples)
    ),
  };
  return parseWorkoutResponse(response);
}

function parseScalarSummary(
  value: unknown,
  allowedMin: number,
  allowedMax: number
): WorkoutResponseScalarSummary | null {
  if (!isObject(value)) return null;
  if (!isNonNegativeInteger(value.sampleCount) || value.sampleCount === 0) return null;
  if (!isFiniteNumber(value.coverageRatio) || value.coverageRatio < 0 || value.coverageRatio > 1) return null;
  for (const key of ["mean", "median", "min", "max", "end"] as const) {
    if (!isFiniteNumber(value[key])) return null;
  }
  const sampleCount = value.sampleCount as number;
  const coverageRatio = value.coverageRatio as number;
  const mean = value.mean as number;
  const summaryMedian = value.median as number;
  const min = value.min as number;
  const max = value.max as number;
  const end = value.end as number;
  if (
    min > max ||
    min < allowedMin ||
    max > allowedMax ||
    mean < min ||
    mean > max ||
    summaryMedian < min ||
    summaryMedian > max ||
    end < min ||
    end > max
  ) {
    return null;
  }
  return {
    sampleCount,
    coverageRatio,
    mean,
    median: summaryMedian,
    min,
    max,
    end,
  };
}

function parseExpectedHeartRate(value: unknown): ResolvedHeartRateTarget | null | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) return null;
  if (value.min !== undefined && (!isNonNegativeFinite(value.min) || value.min > 250)) return null;
  if (value.max !== undefined && (!isNonNegativeFinite(value.max) || value.max > 250)) return null;
  if (value.min === undefined && value.max === undefined) return null;
  if (value.min !== undefined && value.max !== undefined && value.min > value.max) return null;
  return {
    ...(value.min !== undefined ? { min: value.min as number } : {}),
    ...(value.max !== undefined ? { max: value.max as number } : {}),
  };
}

function parsePhaseResponse(value: unknown): WorkoutPhaseResponse | null {
  if (!isObject(value)) return null;
  if (typeof value.phaseInstanceId !== "string" || value.phaseInstanceId.trim() === "" || value.phaseInstanceId.length > 256) return null;
  if (typeof value.phaseId !== "string" || value.phaseId.trim() === "" || value.phaseId.length > 256) return null;
  if (!PHASE_KINDS.has(value.kind as WorkoutPhaseKind)) return null;
  if (value.intensityId !== undefined && !INTENSITY_IDS.has(value.intensityId as PhaseIntensityId)) return null;
  if (value.detailName !== undefined && (typeof value.detailName !== "string" || value.detailName.trim() === "" || value.detailName.length > 256)) return null;
  if (value.intervalIndex !== undefined && (!Number.isInteger(value.intervalIndex) || (value.intervalIndex as number) <= 0)) return null;
  if (!isNonNegativeInteger(value.activeStartSec) || !isNonNegativeInteger(value.activeEndSec)) return null;
  if (value.activeEndSec <= value.activeStartSec) return null;
  if (!isNonNegativeInteger(value.plannedDurationSec) || value.plannedDurationSec !== value.activeEndSec - value.activeStartSec) return null;
  if (!isNonNegativeInteger(value.completedDurationSec) || value.completedDurationSec > value.plannedDurationSec) return null;
  const expectedHeartRate = parseExpectedHeartRate(value.expectedHeartRate);
  if (expectedHeartRate === null) return null;
  const hr = value.hr === undefined ? undefined : parseScalarSummary(value.hr, 30, 250);
  const cadenceRpm = value.cadenceRpm === undefined ? undefined : parseScalarSummary(value.cadenceRpm, 0, 300);
  const observedResistance = value.observedResistance === undefined ? undefined : parseScalarSummary(value.observedResistance, 0, 100);
  const desiredResistance = value.desiredResistance === undefined ? undefined : parseScalarSummary(value.desiredResistance, 0, 100);
  const commandedResistance = value.commandedResistance === undefined ? undefined : parseScalarSummary(value.commandedResistance, 0, 100);
  if (
    (value.hr !== undefined && !hr) ||
    (value.cadenceRpm !== undefined && !cadenceRpm) ||
    (value.observedResistance !== undefined && !observedResistance) ||
    (value.desiredResistance !== undefined && !desiredResistance) ||
    (value.commandedResistance !== undefined && !commandedResistance)
  ) {
    return null;
  }
  for (const summary of [hr, cadenceRpm, observedResistance, desiredResistance, commandedResistance]) {
    if (
      summary &&
      (summary.sampleCount > value.completedDurationSec ||
        !ratiosEqual(summary.coverageRatio, ratio(summary.sampleCount, value.completedDurationSec as number)))
    ) {
      return null;
    }
  }
  let watts: WorkoutPhaseResponse["watts"];
  if (value.watts !== undefined) {
    const scalar = parseScalarSummary(value.watts, 0, 5000);
    if (!scalar || !isObject(value.watts)) return null;
    if (value.watts.provenance !== "measured_watts" && value.watts.provenance !== "calibrated_watts" && value.watts.provenance !== "mixed") {
      return null;
    }
    if (
      scalar.sampleCount > value.completedDurationSec ||
      !ratiosEqual(scalar.coverageRatio, ratio(scalar.sampleCount, value.completedDurationSec as number))
    ) {
      return null;
    }
    watts = { ...scalar, provenance: value.watts.provenance };
  }
  return {
    phaseInstanceId: value.phaseInstanceId,
    phaseId: value.phaseId,
    kind: value.kind as WorkoutPhaseKind,
    ...(value.intensityId !== undefined ? { intensityId: value.intensityId as PhaseIntensityId } : {}),
    ...(value.detailName !== undefined ? { detailName: value.detailName as string } : {}),
    ...(value.intervalIndex !== undefined ? { intervalIndex: value.intervalIndex as number } : {}),
    activeStartSec: value.activeStartSec,
    activeEndSec: value.activeEndSec,
    plannedDurationSec: value.plannedDurationSec,
    completedDurationSec: value.completedDurationSec,
    ...(expectedHeartRate ? { expectedHeartRate } : {}),
    ...(hr ? { hr } : {}),
    ...(watts ? { watts } : {}),
    ...(cadenceRpm ? { cadenceRpm } : {}),
    ...(observedResistance ? { observedResistance } : {}),
    ...(desiredResistance ? { desiredResistance } : {}),
    ...(commandedResistance ? { commandedResistance } : {}),
  };
}

function parseWorkoutResponseV1(value: Record<string, unknown>): WorkoutResponseV1 | null {
  if (!isOwnerId(value.athleteId) || !isOwnerId(value.sessionId)) return null;
  if (!isObject(value.completion) || !isObject(value.evidence) || !Array.isArray(value.phases)) return null;
  const completion = value.completion;
  if (
    !isNonNegativeInteger(completion.plannedActiveSec) ||
    !isNonNegativeInteger(completion.completedActiveSec) ||
    completion.plannedActiveSec > MAX_ACTIVE_DURATION_SEC ||
    completion.completedActiveSec > MAX_ACTIVE_DURATION_SEC
  ) return null;
  if (!isFiniteNumber(completion.completionFraction) || completion.completionFraction < 0 || completion.completionFraction > 1) return null;
  if (!ratiosEqual(completion.completionFraction, ratio(completion.completedActiveSec, completion.plannedActiveSec))) return null;
  if (typeof completion.cancelled !== "boolean" || typeof completion.earlyCooldown !== "boolean") return null;
  if (!isObject(value.evidence.hr) || !isObject(value.evidence.bike) || !isObject(value.evidence.rawTelemetry)) return null;
  const hr = value.evidence.hr;
  const bike = value.evidence.bike;
  if (!isNonNegativeInteger(hr.expectedDurationSec) || !isNonNegativeInteger(hr.validSampleCount)) return null;
  if (!isFiniteNumber(hr.coverageRatio) || hr.coverageRatio < 0 || hr.coverageRatio > 1) return null;
  if (hr.source !== "ble_chest_strap" && hr.source !== "unavailable") return null;
  if (
    hr.expectedDurationSec !== completion.completedActiveSec ||
    hr.validSampleCount > hr.expectedDurationSec ||
    !ratiosEqual(hr.coverageRatio, ratio(hr.validSampleCount, hr.expectedDurationSec)) ||
    (hr.source === "unavailable") !== (hr.validSampleCount === 0)
  ) return null;
  for (const key of ["expectedDurationSec", "rowCount", "freshSampleCount", "staleSampleCount", "unavailableSampleCount", "implicitMissingCount"] as const) {
    if (!isNonNegativeInteger(bike[key])) return null;
  }
  if (
    !isFiniteNumber(bike.freshRowCoverageRatio) ||
    bike.freshRowCoverageRatio < 0 ||
    bike.freshRowCoverageRatio > 1
  ) return null;
  const bikeExpectedDurationSec = bike.expectedDurationSec as number;
  const bikeRowCount = bike.rowCount as number;
  const freshSampleCount = bike.freshSampleCount as number;
  const staleSampleCount = bike.staleSampleCount as number;
  const unavailableSampleCount = bike.unavailableSampleCount as number;
  const implicitMissingCount = bike.implicitMissingCount as number;
  if (
    bikeExpectedDurationSec !== completion.completedActiveSec ||
    freshSampleCount + staleSampleCount + unavailableSampleCount !== bikeRowCount ||
    bikeRowCount > bikeExpectedDurationSec ||
    implicitMissingCount !== bikeExpectedDurationSec - bikeRowCount ||
    !ratiosEqual(bike.freshRowCoverageRatio, ratio(freshSampleCount, bikeExpectedDurationSec))
  ) return null;
  if (
    bike.wattsProvenance !== "measured_watts" &&
    bike.wattsProvenance !== "calibrated_watts" &&
    bike.wattsProvenance !== "mixed" &&
    bike.wattsProvenance !== "unavailable"
  ) {
    return null;
  }
  if (
    value.evidence.rawTelemetry.store !== "ordinary_bike_telemetry" ||
    value.evidence.rawTelemetry.schemaVersion !== ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1
  ) {
    return null;
  }
  if (value.phases.length > MAX_PHASE_COUNT) return null;
  const phases: WorkoutPhaseResponse[] = [];
  const ids = new Set<string>();
  let previousEnd = 0;
  for (const candidate of value.phases) {
    const phase = parsePhaseResponse(candidate);
    if (
      !phase ||
      ids.has(phase.phaseInstanceId) ||
      phase.activeStartSec !== previousEnd ||
      phase.completedDurationSec !== Math.max(
        0,
        Math.min(phase.activeEndSec, completion.completedActiveSec as number) - phase.activeStartSec
      )
    ) return null;
    ids.add(phase.phaseInstanceId);
    previousEnd = phase.activeEndSec;
    phases.push(phase);
  }
  if (
    (completion.plannedActiveSec > 0 && phases.length === 0) ||
    (completion.earlyCooldown === false && previousEnd !== completion.plannedActiveSec) ||
    previousEnd > completion.plannedActiveSec
  ) return null;
  return {
    schemaVersion: WORKOUT_RESPONSE_SCHEMA_VERSION_V1,
    athleteId: value.athleteId,
    sessionId: value.sessionId,
    completion: {
      plannedActiveSec: completion.plannedActiveSec,
      completedActiveSec: completion.completedActiveSec,
      completionFraction: completion.completionFraction,
      cancelled: completion.cancelled,
      earlyCooldown: completion.earlyCooldown,
    },
    evidence: {
      hr: {
        expectedDurationSec: hr.expectedDurationSec as number,
        validSampleCount: hr.validSampleCount as number,
        coverageRatio: hr.coverageRatio as number,
        source: hr.source as "ble_chest_strap" | "unavailable",
      },
      bike: {
        expectedDurationSec: bike.expectedDurationSec as number,
        rowCount: bike.rowCount as number,
        freshSampleCount: bike.freshSampleCount as number,
        staleSampleCount: bike.staleSampleCount as number,
        unavailableSampleCount: bike.unavailableSampleCount as number,
        implicitMissingCount: bike.implicitMissingCount as number,
        freshRowCoverageRatio: bike.freshRowCoverageRatio as number,
        wattsProvenance: bike.wattsProvenance as "measured_watts" | "calibrated_watts" | "mixed" | "unavailable",
      },
      rawTelemetry: {
        store: "ordinary_bike_telemetry",
        schemaVersion: ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
      },
    },
    phases,
  };
}

/** Strict historical dispatcher for immutable WorkoutResponse persistence. */
export function parseWorkoutResponse(value: unknown): WorkoutResponse | null {
  if (!isObject(value)) return null;
  switch (value.schemaVersion) {
    case WORKOUT_RESPONSE_SCHEMA_VERSION_V1:
      return parseWorkoutResponseV1(value);
    default:
      return null;
  }
}
