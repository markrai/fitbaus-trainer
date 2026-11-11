import { ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1 } from "./telemetry.js";

export const FREESTYLE_STABLE_OBSERVATION_SCHEMA_VERSION_V1 = 1 as const;
export const FREESTYLE_STABLE_OBSERVATION_POLICY_ID_V1 = "freestyle-stable-observation" as const;
export const FREESTYLE_STABLE_OBSERVATION_POLICY_VERSION_V1 = 1 as const;

export const FREESTYLE_STABLE_OBSERVATION_POLICY = {
  policyId: FREESTYLE_STABLE_OBSERVATION_POLICY_ID_V1,
  policyVersion: FREESTYLE_STABLE_OBSERVATION_POLICY_VERSION_V1,
  criteriaClass: "provisional_engineering" as const,
  maxObservationGapSec: 1,
  maxWallClockExcessSec: 1,
  minMechanicallyQualifiedDurationSec: 180,
  minFreshPowerCoverageRatio: 0.95,
  minCadenceCoverageRatio: 0.95,
  maxWattsMadAbs: 12,
  maxWattsMadRatio: 0.1,
  maxCadenceMadRpm: 5,
  minJointHrPowerCoverageRatio: 1,
} as const;

export type FreestyleStableObservationPolicyV1 = typeof FREESTYLE_STABLE_OBSERVATION_POLICY;
export type FreestyleStableWindowQualification =
  | "candidate"
  | "mechanically_qualified"
  | "hr_co_observed";
export type FreestyleStableAnalysisStatus = "unavailable" | "diagnostic_only" | "observed";
export type FreestyleStableWattsProvenance =
  | "measured_watts"
  | "calibrated_watts"
  | "mixed"
  | "unavailable";

export const FREESTYLE_STABLE_OBSERVATION_REASONS = [
  "insufficient_duration",
  "power_unavailable",
  "mixed_watt_provenance",
  "insufficient_power_coverage",
  "non_pedaling_zero_load",
  "workload_unstable",
  "insufficient_cadence_coverage",
  "coasting",
  "cadence_unstable",
  "insufficient_hr_coverage",
  "insufficient_joint_hr_power_coverage",
  "f1_evidence_incomplete",
] as const;

export type FreestyleStableObservationReason = (typeof FREESTYLE_STABLE_OBSERVATION_REASONS)[number];

const REASON_SET = new Set<string>(FREESTYLE_STABLE_OBSERVATION_REASONS);
const MECHANICAL_REASONS = new Set<FreestyleStableObservationReason>([
  "insufficient_duration",
  "power_unavailable",
  "mixed_watt_provenance",
  "insufficient_power_coverage",
  "non_pedaling_zero_load",
  "workload_unstable",
  "insufficient_cadence_coverage",
  "coasting",
  "cadence_unstable",
]);
const HR_INSUFFICIENCY_REASONS = new Set<FreestyleStableObservationReason>([
  "insufficient_hr_coverage",
  "insufficient_joint_hr_power_coverage",
]);

export interface FreestyleStableObservationWindowV1 {
  startActiveSec: number;
  endActiveSec: number;
  durationSec: number;
  qualifyingObservedSeconds: number;
  observedResistanceLevel: number;
  wattsProvenance: FreestyleStableWattsProvenance;
  freshPowerCoverageRatio: number;
  cadenceCoverageRatio: number;
  hrCoverageRatio: number;
  jointHrPowerCoverageRatio: number;
  powerOnlyObservedSeconds: number;
  hrOnlyObservedSeconds: number;
  jointHrPowerSeconds: number;
  powerMedianWatts?: number;
  powerMadWatts?: number;
  cadenceMedianRpm?: number;
  cadenceMadRpm?: number;
  hrMedianBpm?: number;
  hrMadBpm?: number;
  jointPowerMedianWatts?: number;
  jointHrMedianBpm?: number;
  qualification: FreestyleStableWindowQualification;
  reasons: FreestyleStableObservationReason[];
}

export interface FreestyleStableObservationV1 {
  schemaVersion: typeof FREESTYLE_STABLE_OBSERVATION_SCHEMA_VERSION_V1;
  policy: FreestyleStableObservationPolicyV1;
  athleteId: string;
  sessionId: string;
  timing: {
    activeDurationSec: number;
    pausedDurationSec: number;
    startedAt: string;
    endedAt: string;
  };
  observationProvenance: {
    bikeStore: "ordinary_bike_telemetry";
    hrStore: "hr_samples";
    telemetrySchemaVersion: typeof ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1;
  };
  analysisStatus: FreestyleStableAnalysisStatus;
  candidateWindowCount: number;
  mechanicallyQualifiedCount: number;
  hrCoObservedCount: number;
  windows: FreestyleStableObservationWindowV1[];
  f1EvidenceIncomplete?: true;
  scientificAuthority: {
    eligibleForCalibration: false;
    eligibleForPrescription: false;
    interpretation: "descriptive_observation_only";
    hrArtifactFiltering: "none";
    physiologicalEquilibriumClaimed: false;
  };
}

const OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const QUALIFICATIONS: FreestyleStableWindowQualification[] = [
  "candidate",
  "mechanically_qualified",
  "hr_co_observed",
];
const PROVENANCE: FreestyleStableWattsProvenance[] = [
  "measured_watts",
  "calibrated_watts",
  "mixed",
  "unavailable",
];

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
  return Number.isFinite(Date.parse(v));
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

function parseReasons(v: unknown): FreestyleStableObservationReason[] | null {
  if (!Array.isArray(v)) return null;
  const reasons: FreestyleStableObservationReason[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string" || !REASON_SET.has(item) || seen.has(item)) return null;
    seen.add(item);
    reasons.push(item as FreestyleStableObservationReason);
  }
  return reasons;
}

function wattsMadLimit(medianWatts: number): number {
  return Math.max(
    FREESTYLE_STABLE_OBSERVATION_POLICY.maxWattsMadAbs,
    FREESTYLE_STABLE_OBSERVATION_POLICY.maxWattsMadRatio * medianWatts
  );
}

function reasonsInclude(
  reasons: readonly FreestyleStableObservationReason[],
  reason: FreestyleStableObservationReason
): boolean {
  return reasons.includes(reason);
}

function hasAnyReason(
  reasons: readonly FreestyleStableObservationReason[],
  set: Set<FreestyleStableObservationReason>
): boolean {
  return reasons.some((reason) => set.has(reason));
}

function qualificationAgreesWithMeasurements(
  window: {
    durationSec: number;
    wattsProvenance: FreestyleStableWattsProvenance;
    freshPowerCoverageRatio: number;
    cadenceCoverageRatio: number;
    hrCoverageRatio: number;
    jointHrPowerCoverageRatio: number;
    powerMedianWatts?: number;
    powerMadWatts?: number;
    cadenceMedianRpm?: number;
    cadenceMadRpm?: number;
  },
  reasons: readonly FreestyleStableObservationReason[],
  qualification: FreestyleStableWindowQualification,
  evidenceIncomplete: boolean
): boolean {
  const policy = FREESTYLE_STABLE_OBSERVATION_POLICY;
  const durationOk = window.durationSec >= policy.minMechanicallyQualifiedDurationSec;
  const provenanceOk =
    window.wattsProvenance === "measured_watts" || window.wattsProvenance === "calibrated_watts";
  const powerCoverageOk = window.freshPowerCoverageRatio >= policy.minFreshPowerCoverageRatio;
  const cadenceCoverageOk = window.cadenceCoverageRatio >= policy.minCadenceCoverageRatio;
  const powerPresent = window.powerMedianWatts !== undefined && window.powerMadWatts !== undefined;
  const cadencePresent = window.cadenceMedianRpm !== undefined && window.cadenceMadRpm !== undefined;
  const positiveLoad = powerPresent && (window.powerMedianWatts as number) > 0;
  const powerStable = positiveLoad &&
    (window.powerMadWatts as number) <= wattsMadLimit(window.powerMedianWatts as number);
  const cadencePositive = cadencePresent && (window.cadenceMedianRpm as number) > 0;
  const cadenceStable = cadencePositive &&
    (window.cadenceMadRpm as number) <= policy.maxCadenceMadRpm;
  const mechanicalOk =
    durationOk && provenanceOk && powerCoverageOk && cadenceCoverageOk &&
    powerPresent && cadencePresent && positiveLoad && powerStable && cadencePositive && cadenceStable;
  if (reasonsInclude(reasons, "insufficient_duration") !== !durationOk) return false;
  if (reasonsInclude(reasons, "power_unavailable") !== !powerPresent) return false;
  if (reasonsInclude(reasons, "mixed_watt_provenance") !== (window.wattsProvenance === "mixed")) return false;
  if (reasonsInclude(reasons, "insufficient_power_coverage") !== (powerPresent && !powerCoverageOk)) return false;
  if (reasonsInclude(reasons, "non_pedaling_zero_load") !== (powerPresent && (window.powerMedianWatts as number) === 0)) {
    return false;
  }
  if (reasonsInclude(reasons, "workload_unstable") !== (positiveLoad && !powerStable)) return false;
  if (reasonsInclude(reasons, "insufficient_cadence_coverage") !== !cadenceCoverageOk) return false;
  const coasting = reasonsInclude(reasons, "coasting");
  if (!cadencePositive && cadencePresent && !coasting) return false;
  const expectCadenceUnstable = cadencePositive && !cadenceStable && !coasting;
  if (reasonsInclude(reasons, "cadence_unstable") !== expectCadenceUnstable) return false;
  if (reasonsInclude(reasons, "f1_evidence_incomplete") !== evidenceIncomplete) return false;
  const jointOk = window.jointHrPowerCoverageRatio >= policy.minJointHrPowerCoverageRatio;
  if (reasonsInclude(reasons, "insufficient_hr_coverage") !== (window.hrCoverageRatio === 0)) return false;
  if (reasonsInclude(reasons, "insufficient_joint_hr_power_coverage") !== (window.hrCoverageRatio > 0 && !jointOk)) {
    return false;
  }
  if (qualification === "hr_co_observed") {
    return mechanicalOk && jointOk && !evidenceIncomplete &&
      !hasAnyReason(reasons, MECHANICAL_REASONS) &&
      !hasAnyReason(reasons, HR_INSUFFICIENCY_REASONS);
  }
  if (qualification === "mechanically_qualified") {
    return mechanicalOk && !jointOk && !evidenceIncomplete &&
      !hasAnyReason(reasons, MECHANICAL_REASONS) &&
      hasAnyReason(reasons, HR_INSUFFICIENCY_REASONS);
  }
  return !mechanicalOk || evidenceIncomplete || hasAnyReason(reasons, MECHANICAL_REASONS);
}

function parseOptionalMetric(v: unknown): number | undefined | null {
  if (v === undefined) return undefined;
  if (!isNonNegativeFinite(v)) return null;
  return v;
}

function parsePolicy(v: unknown): FreestyleStableObservationPolicyV1 | null {
  if (!isObject(v)) return null;
  const expected = FREESTYLE_STABLE_OBSERVATION_POLICY;
  if (v.policyId !== expected.policyId) return null;
  if (v.policyVersion !== expected.policyVersion) return null;
  if (v.criteriaClass !== expected.criteriaClass) return null;
  if (v.maxObservationGapSec !== expected.maxObservationGapSec) return null;
  if (v.maxWallClockExcessSec !== expected.maxWallClockExcessSec) return null;
  if (v.minMechanicallyQualifiedDurationSec !== expected.minMechanicallyQualifiedDurationSec) return null;
  if (v.minFreshPowerCoverageRatio !== expected.minFreshPowerCoverageRatio) return null;
  if (v.minCadenceCoverageRatio !== expected.minCadenceCoverageRatio) return null;
  if (v.maxWattsMadAbs !== expected.maxWattsMadAbs) return null;
  if (v.maxWattsMadRatio !== expected.maxWattsMadRatio) return null;
  if (v.maxCadenceMadRpm !== expected.maxCadenceMadRpm) return null;
  if (v.minJointHrPowerCoverageRatio !== expected.minJointHrPowerCoverageRatio) return null;
  return expected;
}

function parseWindow(
  v: unknown,
  activeDurationSec: number,
  evidenceIncomplete: boolean
): FreestyleStableObservationWindowV1 | null {
  if (!isObject(v)) return null;
  if (!isNonNegativeInteger(v.startActiveSec) || !isNonNegativeInteger(v.endActiveSec)) return null;
  if (!isNonNegativeInteger(v.durationSec) || v.durationSec === 0) return null;
  if ((v.startActiveSec as number) >= (v.endActiveSec as number)) return null;
  if ((v.endActiveSec as number) > activeDurationSec) return null;
  if ((v.durationSec as number) !== (v.endActiveSec as number) - (v.startActiveSec as number)) return null;
  if (!isNonNegativeInteger(v.qualifyingObservedSeconds)) return null;
  if ((v.qualifyingObservedSeconds as number) > (v.durationSec as number)) return null;
  if ((v.qualifyingObservedSeconds as number) === 0) return null;
  if (!isNonNegativeFinite(v.observedResistanceLevel)) return null;
  if (!PROVENANCE.includes(v.wattsProvenance as FreestyleStableWattsProvenance)) return null;
  if (!isRatio(v.freshPowerCoverageRatio) || !isRatio(v.cadenceCoverageRatio)) return null;
  if (!isRatio(v.hrCoverageRatio) || !isRatio(v.jointHrPowerCoverageRatio)) return null;
  if (!isNonNegativeInteger(v.powerOnlyObservedSeconds)) return null;
  if (!isNonNegativeInteger(v.hrOnlyObservedSeconds)) return null;
  if (!isNonNegativeInteger(v.jointHrPowerSeconds)) return null;
  const duration = v.durationSec as number;
  const powerOnly = v.powerOnlyObservedSeconds as number;
  const hrOnly = v.hrOnlyObservedSeconds as number;
  const joint = v.jointHrPowerSeconds as number;
  if (powerOnly + joint > duration || hrOnly + joint > duration) return null;
  if (powerOnly + hrOnly + joint > duration) return null;
  if (!nearlyEqual(v.freshPowerCoverageRatio as number, Math.min(1, (powerOnly + joint) / duration))) return null;
  if (!nearlyEqual(v.hrCoverageRatio as number, Math.min(1, (hrOnly + joint) / duration))) return null;
  if (!nearlyEqual(v.jointHrPowerCoverageRatio as number, Math.min(1, joint / duration))) return null;
  const powerMedianWatts = parseOptionalMetric(v.powerMedianWatts);
  const powerMadWatts = parseOptionalMetric(v.powerMadWatts);
  const cadenceMedianRpm = parseOptionalMetric(v.cadenceMedianRpm);
  const cadenceMadRpm = parseOptionalMetric(v.cadenceMadRpm);
  const hrMedianBpm = parseOptionalMetric(v.hrMedianBpm);
  const hrMadBpm = parseOptionalMetric(v.hrMadBpm);
  const jointPowerMedianWatts = parseOptionalMetric(v.jointPowerMedianWatts);
  const jointHrMedianBpm = parseOptionalMetric(v.jointHrMedianBpm);
  if (
    powerMedianWatts === null || powerMadWatts === null ||
    cadenceMedianRpm === null || cadenceMadRpm === null ||
    hrMedianBpm === null || hrMadBpm === null ||
    jointPowerMedianWatts === null || jointHrMedianBpm === null
  ) return null;
  const powerCount = powerOnly + joint;
  const hrCount = hrOnly + joint;
  if (powerCount === 0 && (powerMedianWatts !== undefined || powerMadWatts !== undefined)) return null;
  if (powerCount > 0 && (powerMedianWatts === undefined || powerMadWatts === undefined)) return null;
  if (hrCount === 0 && (hrMedianBpm !== undefined || hrMadBpm !== undefined)) return null;
  if (hrCount > 0 && (hrMedianBpm === undefined || hrMadBpm === undefined)) return null;
  if ((v.cadenceCoverageRatio as number) === 0 && (cadenceMedianRpm !== undefined || cadenceMadRpm !== undefined)) return null;
  if ((v.cadenceCoverageRatio as number) > 0 && (cadenceMedianRpm === undefined || cadenceMadRpm === undefined)) return null;
  if (joint === 0 && (jointPowerMedianWatts !== undefined || jointHrMedianBpm !== undefined)) return null;
  if (joint > 0 && (jointPowerMedianWatts === undefined || jointHrMedianBpm === undefined)) return null;
  if (!QUALIFICATIONS.includes(v.qualification as FreestyleStableWindowQualification)) return null;
  const reasons = parseReasons(v.reasons);
  if (!reasons) return null;
  const qualification = v.qualification as FreestyleStableWindowQualification;
  if (!qualificationAgreesWithMeasurements(
    {
      durationSec: duration,
      wattsProvenance: v.wattsProvenance as FreestyleStableWattsProvenance,
      freshPowerCoverageRatio: v.freshPowerCoverageRatio as number,
      cadenceCoverageRatio: v.cadenceCoverageRatio as number,
      hrCoverageRatio: v.hrCoverageRatio as number,
      jointHrPowerCoverageRatio: v.jointHrPowerCoverageRatio as number,
      ...(powerMedianWatts !== undefined ? { powerMedianWatts } : {}),
      ...(powerMadWatts !== undefined ? { powerMadWatts } : {}),
      ...(cadenceMedianRpm !== undefined ? { cadenceMedianRpm } : {}),
      ...(cadenceMadRpm !== undefined ? { cadenceMadRpm } : {}),
    },
    reasons,
    qualification,
    evidenceIncomplete
  )) return null;
  return {
    startActiveSec: v.startActiveSec as number,
    endActiveSec: v.endActiveSec as number,
    durationSec: duration,
    qualifyingObservedSeconds: v.qualifyingObservedSeconds as number,
    observedResistanceLevel: v.observedResistanceLevel as number,
    wattsProvenance: v.wattsProvenance as FreestyleStableWattsProvenance,
    freshPowerCoverageRatio: v.freshPowerCoverageRatio as number,
    cadenceCoverageRatio: v.cadenceCoverageRatio as number,
    hrCoverageRatio: v.hrCoverageRatio as number,
    jointHrPowerCoverageRatio: v.jointHrPowerCoverageRatio as number,
    powerOnlyObservedSeconds: powerOnly,
    hrOnlyObservedSeconds: hrOnly,
    jointHrPowerSeconds: joint,
    ...(powerMedianWatts !== undefined ? { powerMedianWatts } : {}),
    ...(powerMadWatts !== undefined ? { powerMadWatts } : {}),
    ...(cadenceMedianRpm !== undefined ? { cadenceMedianRpm } : {}),
    ...(cadenceMadRpm !== undefined ? { cadenceMadRpm } : {}),
    ...(hrMedianBpm !== undefined ? { hrMedianBpm } : {}),
    ...(hrMadBpm !== undefined ? { hrMadBpm } : {}),
    ...(jointPowerMedianWatts !== undefined ? { jointPowerMedianWatts } : {}),
    ...(jointHrMedianBpm !== undefined ? { jointHrMedianBpm } : {}),
    qualification,
    reasons,
  };
}

export function parseFreestyleStableObservation(raw: unknown): FreestyleStableObservationV1 | null {
  if (!isObject(raw)) return null;
  if (raw.schemaVersion !== FREESTYLE_STABLE_OBSERVATION_SCHEMA_VERSION_V1) return null;
  if (!isOwnerId(raw.athleteId) || !isOwnerId(raw.sessionId)) return null;
  const policy = parsePolicy(raw.policy);
  if (!policy) return null;
  if (!isObject(raw.timing)) return null;
  const timing = raw.timing as Record<string, unknown>;
  if (!isNonNegativeInteger(timing.activeDurationSec)) return null;
  if (!isNonNegativeFinite(timing.pausedDurationSec)) return null;
  if (!isIsoTimestamp(timing.startedAt) || !isIsoTimestamp(timing.endedAt)) return null;
  const startedAtMs = Date.parse(timing.startedAt as string);
  const endedAtMs = Date.parse(timing.endedAt as string);
  if (endedAtMs <= startedAtMs) return null;
  const activeDurationSec = timing.activeDurationSec as number;
  const pausedDurationSec = timing.pausedDurationSec as number;
  const wallClockSec = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (activeDurationSec > wallClockSec + 1) return null;
  if (activeDurationSec + pausedDurationSec > wallClockSec + 2) return null;
  if (!isObject(raw.observationProvenance)) return null;
  const provenance = raw.observationProvenance as Record<string, unknown>;
  if (provenance.bikeStore !== "ordinary_bike_telemetry") return null;
  if (provenance.hrStore !== "hr_samples") return null;
  if (provenance.telemetrySchemaVersion !== ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1) return null;
  if (
    raw.analysisStatus !== "unavailable" &&
    raw.analysisStatus !== "diagnostic_only" &&
    raw.analysisStatus !== "observed"
  ) return null;
  if (!isNonNegativeInteger(raw.candidateWindowCount)) return null;
  if (!isNonNegativeInteger(raw.mechanicallyQualifiedCount)) return null;
  if (!isNonNegativeInteger(raw.hrCoObservedCount)) return null;
  if (!Array.isArray(raw.windows)) return null;
  if (raw.f1EvidenceIncomplete !== undefined && raw.f1EvidenceIncomplete !== true) return null;
  const evidenceIncomplete = raw.f1EvidenceIncomplete === true;
  const windows: FreestyleStableObservationWindowV1[] = [];
  let previousEnd = -1;
  for (const item of raw.windows) {
    const parsed = parseWindow(item, activeDurationSec, evidenceIncomplete);
    if (!parsed) return null;
    if (parsed.startActiveSec < previousEnd) return null;
    previousEnd = parsed.endActiveSec;
    windows.push(parsed);
  }
  if (windows.length !== (raw.candidateWindowCount as number)) return null;
  const mechanical = windows.filter((w) =>
    w.qualification === "mechanically_qualified" || w.qualification === "hr_co_observed"
  ).length;
  const hrCo = windows.filter((w) => w.qualification === "hr_co_observed").length;
  if (mechanical !== (raw.mechanicallyQualifiedCount as number)) return null;
  if (hrCo !== (raw.hrCoObservedCount as number)) return null;
  if (evidenceIncomplete && mechanical > 0) return null;
  let expectedStatus: FreestyleStableAnalysisStatus;
  if (windows.length === 0) expectedStatus = "unavailable";
  else if (evidenceIncomplete || mechanical === 0) expectedStatus = "diagnostic_only";
  else expectedStatus = "observed";
  if (raw.analysisStatus !== expectedStatus) return null;
  if (!isObject(raw.scientificAuthority)) return null;
  const authority = raw.scientificAuthority as Record<string, unknown>;
  if (authority.eligibleForCalibration !== false) return null;
  if (authority.eligibleForPrescription !== false) return null;
  if (authority.interpretation !== "descriptive_observation_only") return null;
  if (authority.hrArtifactFiltering !== "none") return null;
  if (authority.physiologicalEquilibriumClaimed !== false) return null;
  return {
    schemaVersion: FREESTYLE_STABLE_OBSERVATION_SCHEMA_VERSION_V1,
    policy,
    athleteId: raw.athleteId as string,
    sessionId: raw.sessionId as string,
    timing: {
      activeDurationSec,
      pausedDurationSec,
      startedAt: timing.startedAt as string,
      endedAt: timing.endedAt as string,
    },
    observationProvenance: {
      bikeStore: "ordinary_bike_telemetry",
      hrStore: "hr_samples",
      telemetrySchemaVersion: ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
    },
    analysisStatus: raw.analysisStatus,
    candidateWindowCount: windows.length,
    mechanicallyQualifiedCount: mechanical,
    hrCoObservedCount: hrCo,
    windows,
    ...(evidenceIncomplete ? { f1EvidenceIncomplete: true as const } : {}),
    scientificAuthority: {
      eligibleForCalibration: false,
      eligibleForPrescription: false,
      interpretation: "descriptive_observation_only",
      hrArtifactFiltering: "none",
      physiologicalEquilibriumClaimed: false,
    },
  };
}
