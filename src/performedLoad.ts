import { canonicalMedian } from "./stats.js";
import type {
  OrdinaryBikeTelemetrySample,
  PhaseIntensityId,
  ResolvedHeartRateTarget,
  WorkoutPhaseKind,
  WorkoutPhaseResponse,
  WorkoutResponse,
  WorkoutResponseScalarSummary,
} from "./types.js";

/**
 * MAD = canonicalMedian(|x − median(x)|) over finite values.
 * Descriptive variability only; never a qualification threshold.
 */
export function medianAbsoluteDeviation(values: readonly number[]): number | undefined {
  const median = canonicalMedian(values);
  if (median === undefined) return undefined;
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return canonicalMedian(finite.map((value) => Math.abs(value - median)));
}

function isDiscreteResistance(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

/**
 * Frequency mode over finite integers only. Non-integers are ignored.
 * Machine-specific resistance domains belong upstream, not here.
 *
 * Ties: highest frequency → value closest to the observed median → lower value.
 */
export function discreteResistanceMode(values: readonly number[]): number | undefined {
  const integers = values.filter(isDiscreteResistance);
  if (integers.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const value of integers) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let highest = 0;
  for (const count of counts.values()) {
    if (count > highest) highest = count;
  }
  const tied = [...counts.entries()]
    .filter(([, count]) => count === highest)
    .map(([value]) => value);
  if (tied.length === 1) return tied[0];
  const median = canonicalMedian(integers);
  if (median === undefined) return tied.sort((a, b) => a - b)[0];
  let closestDistance = Infinity;
  for (const value of tied) {
    const distance = Math.abs(value - median);
    if (distance < closestDistance) closestDistance = distance;
  }
  const closest = tied.filter((value) => Math.abs(value - median) === closestDistance);
  return closest.sort((a, b) => a - b)[0];
}

/**
 * Paired-row observed-vs-desired agreement.
 *
 * Only fresh rows with both a valid discrete desiredResistance and a valid
 * discrete observedResistance participate. Match iff the two integers are equal.
 *
 * This is sample-weighted (matching rows / comparable rows), not inferred
 * time-weighted occupancy. Gaps between active seconds do not invent samples.
 * Never inferred from aggregate medians. Commanded resistance and guidance
 * traces are not substitutes for paired telemetry.
 *
 * No comparable rows → undefined.
 */
export function observedVsDesiredAgreement(
  samples: readonly OrdinaryBikeTelemetrySample[]
): number | undefined {
  let comparable = 0;
  let matching = 0;
  for (const sample of samples) {
    if (sample.availability !== "fresh") continue;
    if (!isDiscreteResistance(sample.desiredResistance)) continue;
    if (!isDiscreteResistance(sample.observedResistance?.value)) continue;
    comparable += 1;
    if (sample.desiredResistance === sample.observedResistance.value) matching += 1;
  }
  if (comparable === 0) return undefined;
  return matching / comparable;
}

export interface PhasePerformedLoadView {
  sessionId: string;
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
  desiredResistanceMedian?: number;
  commandedResistanceMedian?: number;
  observedResistanceMedian?: number;
  observedResistanceCoverageRatio?: number;
  /** Distribution-derived; absent when raw samples are unavailable. */
  observedResistanceMode?: number;
  /** Paired-row ratio; absent without comparable raw rows. */
  observedVsDesiredAgreement?: number;
  cadenceMedianRpm?: number;
  cadenceCoverageRatio?: number;
  cadenceMadRpm?: number;
  wattsMedian?: number;
  wattsCoverageRatio?: number;
  wattsMad?: number;
  wattsProvenance?: "measured_watts" | "calibrated_watts" | "mixed";
  observedSampleCount: number;
  freshBikeRowCoverageRatio?: number;
  hasRawSamples: boolean;
}

export interface PerformedLoadWorkoutView {
  sessionId: string;
  startedAt: string;
  label: string;
  cancelled: boolean;
  freshBikeRowCoverageRatio: number;
  wattsProvenance: WorkoutResponse["evidence"]["bike"]["wattsProvenance"];
  phases: PhasePerformedLoadView[];
}

function samplesInFrozenPhaseWindow(
  phase: WorkoutPhaseResponse,
  samples: readonly OrdinaryBikeTelemetrySample[]
): OrdinaryBikeTelemetrySample[] {
  return samples.filter(
    (sample) => sample.activeSec >= phase.activeStartSec && sample.activeSec < phase.activeEndSec
  );
}

function viewFromPhase(
  sessionId: string,
  phase: WorkoutPhaseResponse,
  samples: readonly OrdinaryBikeTelemetrySample[],
  freshBikeRowCoverageRatio: number
): PhasePerformedLoadView {
  const inWindow = samplesInFrozenPhaseWindow(phase, samples);
  const hasRawSamples = inWindow.length > 0;
  const observedResistances = inWindow
    .filter((sample) => sample.availability === "fresh" && isDiscreteResistance(sample.observedResistance?.value))
    .map((sample) => sample.observedResistance!.value);
  const cadenceValues = inWindow
    .filter((sample) => sample.availability === "fresh" && sample.cadenceRpm)
    .map((sample) => sample.cadenceRpm!.value);
  const wattValues = inWindow
    .filter((sample) => sample.availability === "fresh" && sample.watts)
    .map((sample) => sample.watts!.value);
  const observedSampleCount = hasRawSamples
    ? observedResistances.length
    : phase.observedResistance?.sampleCount ?? 0;
  const view: PhasePerformedLoadView = {
    sessionId,
    phaseInstanceId: phase.phaseInstanceId,
    phaseId: phase.phaseId,
    kind: phase.kind,
    plannedDurationSec: phase.plannedDurationSec,
    completedDurationSec: phase.completedDurationSec,
    activeStartSec: phase.activeStartSec,
    activeEndSec: phase.activeEndSec,
    observedSampleCount,
    hasRawSamples,
    freshBikeRowCoverageRatio,
  };
  if (phase.intensityId) view.intensityId = phase.intensityId;
  if (phase.detailName) view.detailName = phase.detailName;
  if (phase.intervalIndex !== undefined) view.intervalIndex = phase.intervalIndex;
  if (phase.expectedHeartRate) view.expectedHeartRate = { ...phase.expectedHeartRate };
  if (phase.hr) view.hr = { ...phase.hr };
  if (phase.desiredResistance) view.desiredResistanceMedian = phase.desiredResistance.median;
  if (phase.commandedResistance) view.commandedResistanceMedian = phase.commandedResistance.median;
  if (phase.observedResistance) {
    view.observedResistanceMedian = phase.observedResistance.median;
    view.observedResistanceCoverageRatio = phase.observedResistance.coverageRatio;
  }
  if (phase.cadenceRpm) {
    view.cadenceMedianRpm = phase.cadenceRpm.median;
    view.cadenceCoverageRatio = phase.cadenceRpm.coverageRatio;
  }
  if (phase.watts) {
    view.wattsMedian = phase.watts.median;
    view.wattsCoverageRatio = phase.watts.coverageRatio;
    view.wattsProvenance = phase.watts.provenance;
  }
  if (hasRawSamples) {
    const mode = discreteResistanceMode(observedResistances);
    if (mode !== undefined) view.observedResistanceMode = mode;
    const agreement = observedVsDesiredAgreement(inWindow);
    if (agreement !== undefined) view.observedVsDesiredAgreement = agreement;
    const cadenceMad = medianAbsoluteDeviation(cadenceValues);
    if (cadenceMad !== undefined) view.cadenceMadRpm = cadenceMad;
    const wattsMad = medianAbsoluteDeviation(wattValues);
    if (wattsMad !== undefined) view.wattsMad = wattsMad;
  }
  return view;
}

/**
 * Assign telemetry using frozen response windows only:
 * `activeSec ∈ [activeStartSec, activeEndSec)`.
 * Repeated intervals stay distinct via `phaseInstanceId`.
 * Missing raw samples still yield durable response fields; distribution
 * statistics (mode, MAD, agreement) remain omitted.
 */
export function buildPhasePerformedLoadViews(
  response: WorkoutResponse,
  samples: readonly OrdinaryBikeTelemetrySample[] = []
): PhasePerformedLoadView[] {
  const coverage = response.evidence.bike.freshRowCoverageRatio;
  return response.phases.map((phase) => viewFromPhase(response.sessionId, phase, samples, coverage));
}

export function buildPerformedLoadWorkoutView(input: {
  response: WorkoutResponse;
  samples?: readonly OrdinaryBikeTelemetrySample[];
  startedAt: string;
  day?: string;
  intent?: string;
  cancelled?: boolean;
}): PerformedLoadWorkoutView {
  const labelParts = [input.day, input.intent].filter((value): value is string => !!value);
  return {
    sessionId: input.response.sessionId,
    startedAt: input.startedAt,
    label: labelParts.length > 0 ? labelParts.join(" · ") : input.response.sessionId,
    cancelled: input.cancelled === true,
    freshBikeRowCoverageRatio: input.response.evidence.bike.freshRowCoverageRatio,
    wattsProvenance: input.response.evidence.bike.wattsProvenance,
    phases: buildPhasePerformedLoadViews(input.response, input.samples ?? []),
  };
}

export const PERFORMED_LOAD_DIAGNOSTICS_RECENT_LIMIT = 10;
