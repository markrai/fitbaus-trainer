/**
 * Generic multi-session steady-state settled-workload aggregation (design / shadow-only).
 *
 * Aggregates independent session observations produced by the steady-state
 * single-session engine. Parameterized by semantic identity and contract
 * identity — not hard-coded to Threshold.
 *
 * Independence model: one workout session = one contribution.
 * Central tendency: unweighted median of session measured-watt medians.
 * Non-production-ready while maxCrossSessionMadRatio / maxObservationAgeDays
 * remain null.
 */

import { canonicalMedian } from "./stats.js";
import { medianAbsoluteDeviation } from "./performedLoad.js";
import { isIsoTimestamp } from "./utils/dateTime.js";
import {
  STEADY_STATE_SETTLED_WORKLOAD_POLICY_ID_V1,
  STEADY_STATE_SETTLED_WORKLOAD_POLICY_VERSION_V1,
  STEADY_STATE_SETTLED_WORKLOAD_PROVENANCE_V1,
  STEADY_STATE_SETTLED_WORKLOAD_SCHEMA_ID_V1,
  STEADY_STATE_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
  type SteadyStateSettledWorkloadObservationV1,
} from "./steadyStateSettledWorkload.js";

/** Aggregate evidence schema identity (distinct from single-session observation). */
export const STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1 =
  "steady-state-settled-workload-aggregate" as const;
export const STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1 = 1 as const;

/** Aggregation policy identity (distinct from single-session admission policy). */
export const STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1 =
  "steady-state-settled-workload-aggregate-policy" as const;
export const STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1 = 1 as const;

/** Provenance label for the multi-session claim. */
export const STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1 =
  "ordinary_workout_settled_steady_state_region_aggregate" as const;

export type SteadyStateAggregateFailureCode =
  | "insufficient_observations"
  | "insufficient_distinct_dates"
  | "incompatible_athlete"
  | "incompatible_machine"
  | "incompatible_machine_profile"
  | "incompatible_formal_anchor"
  | "incompatible_target_hr_band"
  | "incompatible_admission_policy"
  | "incompatible_observation_schema"
  | "incompatible_provenance"
  | "mixed_compatibility_lineage"
  | "duplicate_session_id"
  | "contradictory_duplicate_session"
  | "invalid_observation_payload"
  | "unstable_cross_session_workload"
  | "stale_observation"
  | "policy_threshold_unresolved"
  | "non_positive_aggregate_watts";

export type SteadyStateAggregateTrendDirection = "flat" | "rising" | "falling" | "mixed";

/**
 * Expected single-session observation family this aggregate may consume.
 * Distinct from `contractIdentity` (what the aggregate itself emits).
 * Named adapters (Threshold) set this to their observation contract so
 * homogeneous foreign observations cannot define a new lineage by accident.
 */
export interface SteadyStateAggregateObservationIdentityV1 {
  semanticIdentity: {
    workoutIntent: string;
    intensityId: string;
    archetype: "steady_state";
  };
  contractIdentity: {
    schemaId: string;
    schemaVersion: number;
    provenance: string;
  };
  admissionPolicyId: string;
  admissionPolicyVersion: number;
}

/**
 * Aggregation policy. `null` scientific fields keep emission fail-closed.
 *
 * Quantity floors (3/3) are product-policy judgments informed by repeated-
 * measure reliability literature and the need for a one-outlier-resistant
 * median+MAD — NOT a copy of Phase D's 4/4 rule.
 *
 * `observationIdentity` = accepted input evidence family.
 * `contractIdentity` = aggregate emission identity.
 */
export interface SteadyStateSettledWorkloadAggregatePolicyV1 {
  id: string;
  version: number;
  /** Aggregate emission contract identity (schema / provenance). */
  contractIdentity: {
    schemaId: string;
    schemaVersion: number;
    provenance: string;
  };
  /**
   * Intrinsic observation-family identity this aggregate is allowed to consume.
   * Validated against each observation's recorded fields (not reconstructed).
   */
  observationIdentity: SteadyStateAggregateObservationIdentityV1;
  /** Independence unit: session (not window, not telemetry-second). */
  independenceUnit: "session";
  /** Unweighted median of per-session measured-watt medians. */
  aggregateStatistic: "median_of_session_medians";
  /** Minimum distinct sessionIds after compatibility filtering. */
  minSessions: number;
  /** Minimum distinct calendar dates (UTC YYYY-MM-DD from sessionEndedAt). */
  minDistinctDates: number;
  /**
   * UNRESOLVED: max MAD(sessionMedians) / median(sessionMedians).
   * Distinct from single-session within-hold MAD ratio (0.10).
   */
  maxCrossSessionMadRatio: number | null;
  /**
   * Trend handling. v1 records direction diagnostically and does not reject
   * solely on monotonicity (insufficient real multi-session evidence to set
   * a rejection threshold).
   */
  trendHandling: "diagnostic_only";
  /**
   * UNRESOLVED: optional max age in days from newest observation.
   * Lineage changes (anchor / machine profile / HR band) invalidate regardless.
   */
  maxObservationAgeDays: number | null;
  /**
   * When true and policy is production-ready, emitted aggregates may set
   * `eligibleForShadowCandidate=true`. Prescription remains false.
   */
  allowShadowCandidateEligibility: boolean;
}

export const STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1: SteadyStateSettledWorkloadAggregatePolicyV1 =
  {
    id: STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1,
    version: STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1,
    contractIdentity: {
      schemaId: STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1,
      schemaVersion: STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1,
      provenance: STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1,
    },
    observationIdentity: {
      semanticIdentity: {
        workoutIntent: "steady_state_reference",
        intensityId: "steady_state_reference",
        archetype: "steady_state",
      },
      contractIdentity: {
        schemaId: STEADY_STATE_SETTLED_WORKLOAD_SCHEMA_ID_V1,
        schemaVersion: STEADY_STATE_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
        provenance: STEADY_STATE_SETTLED_WORKLOAD_PROVENANCE_V1,
      },
      admissionPolicyId: STEADY_STATE_SETTLED_WORKLOAD_POLICY_ID_V1,
      admissionPolicyVersion: STEADY_STATE_SETTLED_WORKLOAD_POLICY_VERSION_V1,
    },
    independenceUnit: "session",
    aggregateStatistic: "median_of_session_medians",
    minSessions: 3,
    minDistinctDates: 3,
    maxCrossSessionMadRatio: null,
    trendHandling: "diagnostic_only",
    maxObservationAgeDays: null,
    allowShadowCandidateEligibility: true,
  };

/**
 * Explicit compatibility lineage — all fields must match for aggregation.
 * Includes workout/intensity/archetype so distinct intensity regions never
 * mix. Whether multiple intents sharing one intensityId should later share
 * lineage is UNRESOLVED (`CROSS_INTENT_SAME_INTENSITY_EVIDENCE_SHARING_V1`);
 * both intent and intensityId remain in the key for now.
 */
export interface SteadyStateAggregateCompatibilityKeyV1 {
  athleteId: string;
  machineId: string;
  machineProfileVersion: number;
  formalAnchorObservedAt: string;
  workoutIntent: string;
  intensityId: string;
  archetype: "steady_state";
  targetHrMin: number;
  targetHrMax: number;
  /** Recorded on each observation — not reconstructed from current module constants. */
  admissionPolicyId: string;
  admissionPolicyVersion: number;
  observationSchemaId: string;
  observationSchemaVersion: number;
  observationProvenance: string;
}

export interface SteadyStateSettledWorkloadAggregateV1 {
  schemaId: string;
  schemaVersion: number;
  provenance: string;
  compatibility: SteadyStateAggregateCompatibilityKeyV1;
  sessionIds: string[];
  workoutDates: string[];
  sessionCount: number;
  distinctDateCount: number;
  /** Unweighted median of session measured-watt medians. */
  aggregateMeasuredWattsMedian: number;
  /** MAD across session medians (not within-session MAD). */
  crossSessionWattsMad: number;
  crossSessionWattsMadRatio: number;
  sessionMeasuredWattsMedians: number[];
  trendDirection: SteadyStateAggregateTrendDirection;
  /** Peak-to-peak span / aggregate median (diagnostic). */
  sessionWattsSpanRatio: number;
  quality: "unverified";
  interpretation: "descriptive_aggregate_only";
  eligibleForPrescription: false;
  /**
   * Structurally eligible to feed a future shadow candidate once the
   * aggregation policy is production-ready. Not UI advice.
   */
  eligibleForShadowCandidate: boolean;
  observedAt: string;
  admissionPolicyId: string;
  admissionPolicyVersion: number;
  aggregatePolicyId: string;
  aggregatePolicyVersion: number;
}

export interface SteadyStateAggregateEvaluationV1 {
  policy: SteadyStateSettledWorkloadAggregatePolicyV1;
  policyProductionReady: boolean;
  unresolvedPolicyFields: Array<keyof SteadyStateSettledWorkloadAggregatePolicyV1>;
  compatibility: SteadyStateAggregateCompatibilityKeyV1 | null;
  acceptedObservations: SteadyStateSettledWorkloadObservationV1[];
  rejected: Array<{
    sessionId: string;
    failures: SteadyStateAggregateFailureCode[];
  }>;
  failures: SteadyStateAggregateFailureCode[];
  /** Diagnostics even when aggregate is not emitted. */
  diagnostics: {
    sessionMeasuredWattsMedians: number[];
    aggregateMeasuredWattsMedian: number | null;
    crossSessionWattsMad: number | null;
    crossSessionWattsMadRatio: number | null;
    trendDirection: SteadyStateAggregateTrendDirection | null;
    sessionWattsSpanRatio: number | null;
    distinctDateCount: number;
  };
  aggregate: SteadyStateSettledWorkloadAggregateV1 | null;
}

/** Aggregation consumes single-session observations directly (no caller workoutDate). */
export type SteadyStateAggregateObservationInputV1 = SteadyStateSettledWorkloadObservationV1;

function unresolvedAggregateFields(
  policy: SteadyStateSettledWorkloadAggregatePolicyV1
): Array<keyof SteadyStateSettledWorkloadAggregatePolicyV1> {
  const fields: Array<keyof SteadyStateSettledWorkloadAggregatePolicyV1> = [];
  if (policy.maxCrossSessionMadRatio === null) fields.push("maxCrossSessionMadRatio");
  if (policy.maxObservationAgeDays === null) fields.push("maxObservationAgeDays");
  return fields;
}

export function steadyStateAggregatePolicyIsProductionReady(
  policy: SteadyStateSettledWorkloadAggregatePolicyV1 = STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1
): boolean {
  return unresolvedAggregateFields(policy).length === 0;
}

/**
 * Derive UTC calendar date from canonical absolute `sessionEndedAt`.
 * Requires `isIsoTimestamp` (toISOString round-trip); host timezone cannot
 * change the result.
 */
export function workoutDateFromSessionEndedAt(sessionEndedAt: string): string | null {
  if (!isIsoTimestamp(sessionEndedAt)) return null;
  return new Date(Date.parse(sessionEndedAt)).toISOString().slice(0, 10);
}

function isStructurallyValidObservationPayload(
  observation: SteadyStateSettledWorkloadObservationV1
): boolean {
  if (!observation || typeof observation !== "object") return false;
  if (typeof observation.schemaId !== "string" || observation.schemaId.length === 0) return false;
  if (
    typeof observation.schemaVersion !== "number" ||
    !Number.isFinite(observation.schemaVersion) ||
    !Number.isInteger(observation.schemaVersion)
  ) {
    return false;
  }
  if (typeof observation.provenance !== "string" || observation.provenance.length === 0) return false;
  if (typeof observation.workoutIntent !== "string" || observation.workoutIntent.length === 0) {
    return false;
  }
  if (typeof observation.intensityId !== "string" || observation.intensityId.length === 0) {
    return false;
  }
  if (observation.archetype !== "steady_state") return false;
  if (observation.eligibleForPrescription !== false) return false;
  if (observation.interpretation !== "descriptive_observation_only") return false;
  if (typeof observation.athleteId !== "string" || observation.athleteId.length === 0) return false;
  if (typeof observation.sessionId !== "string" || observation.sessionId.length === 0) return false;
  if (typeof observation.machineId !== "string" || observation.machineId.length === 0) return false;
  if (
    typeof observation.machineProfileVersion !== "number" ||
    !Number.isFinite(observation.machineProfileVersion)
  ) {
    return false;
  }
  if (!isIsoTimestamp(observation.formalAnchorObservedAt)) return false;
  if (typeof observation.admissionPolicyId !== "string" || observation.admissionPolicyId.length === 0) {
    return false;
  }
  if (
    typeof observation.admissionPolicyVersion !== "number" ||
    !Number.isFinite(observation.admissionPolicyVersion) ||
    !Number.isInteger(observation.admissionPolicyVersion)
  ) {
    return false;
  }
  if (!Number.isFinite(observation.targetHrMin) || !Number.isFinite(observation.targetHrMax)) return false;
  if (!Number.isFinite(observation.measuredWattsMedian) || observation.measuredWattsMedian <= 0) {
    return false;
  }
  if (!isIsoTimestamp(observation.sessionEndedAt)) return false;
  if (workoutDateFromSessionEndedAt(observation.sessionEndedAt) == null) return false;
  // Caller-supplied workoutDate (if present on a malformed payload) must not disagree.
  const spoof = (observation as { workoutDate?: unknown }).workoutDate;
  if (spoof !== undefined) {
    const derived = workoutDateFromSessionEndedAt(observation.sessionEndedAt);
    if (typeof spoof !== "string" || spoof !== derived) return false;
  }
  return true;
}

/**
 * Runtime fail-closed: observation's intrinsic recorded identity must match
 * the aggregate policy's configured input family.
 */
export function observationMatchesAggregateObservationIdentity(
  observation: SteadyStateSettledWorkloadObservationV1,
  expected: SteadyStateAggregateObservationIdentityV1
): boolean {
  return (
    observation.workoutIntent === expected.semanticIdentity.workoutIntent &&
    observation.intensityId === expected.semanticIdentity.intensityId &&
    observation.archetype === expected.semanticIdentity.archetype &&
    observation.schemaId === expected.contractIdentity.schemaId &&
    observation.schemaVersion === expected.contractIdentity.schemaVersion &&
    observation.provenance === expected.contractIdentity.provenance &&
    observation.admissionPolicyId === expected.admissionPolicyId &&
    observation.admissionPolicyVersion === expected.admissionPolicyVersion
  );
}

function isValidObservationForAggregatePolicy(
  observation: SteadyStateSettledWorkloadObservationV1,
  policy: SteadyStateSettledWorkloadAggregatePolicyV1
): boolean {
  return (
    isStructurallyValidObservationPayload(observation) &&
    observationMatchesAggregateObservationIdentity(observation, policy.observationIdentity)
  );
}

export function compatibilityKeyFromObservation(
  observation: SteadyStateSettledWorkloadObservationV1
): SteadyStateAggregateCompatibilityKeyV1 {
  return {
    athleteId: observation.athleteId,
    machineId: observation.machineId,
    machineProfileVersion: observation.machineProfileVersion,
    formalAnchorObservedAt: observation.formalAnchorObservedAt,
    workoutIntent: observation.workoutIntent,
    intensityId: observation.intensityId,
    archetype: "steady_state",
    targetHrMin: observation.targetHrMin,
    targetHrMax: observation.targetHrMax,
    admissionPolicyId: observation.admissionPolicyId,
    admissionPolicyVersion: observation.admissionPolicyVersion,
    observationSchemaId: observation.schemaId,
    observationSchemaVersion: observation.schemaVersion,
    observationProvenance: observation.provenance,
  };
}

function keysEqual(
  a: SteadyStateAggregateCompatibilityKeyV1,
  b: SteadyStateAggregateCompatibilityKeyV1
): boolean {
  return (
    a.athleteId === b.athleteId &&
    a.machineId === b.machineId &&
    a.machineProfileVersion === b.machineProfileVersion &&
    a.formalAnchorObservedAt === b.formalAnchorObservedAt &&
    a.workoutIntent === b.workoutIntent &&
    a.intensityId === b.intensityId &&
    a.archetype === b.archetype &&
    a.targetHrMin === b.targetHrMin &&
    a.targetHrMax === b.targetHrMax &&
    a.admissionPolicyId === b.admissionPolicyId &&
    a.admissionPolicyVersion === b.admissionPolicyVersion &&
    a.observationSchemaId === b.observationSchemaId &&
    a.observationSchemaVersion === b.observationSchemaVersion &&
    a.observationProvenance === b.observationProvenance
  );
}

function compatibilityKeyFingerprint(key: SteadyStateAggregateCompatibilityKeyV1): string {
  return [
    key.athleteId,
    key.machineId,
    String(key.machineProfileVersion),
    key.formalAnchorObservedAt,
    key.workoutIntent,
    key.intensityId,
    key.archetype,
    String(key.targetHrMin),
    String(key.targetHrMax),
    key.admissionPolicyId,
    String(key.admissionPolicyVersion),
    key.observationSchemaId,
    String(key.observationSchemaVersion),
    key.observationProvenance,
  ].join("\u001f");
}

function compatibilityFailures(
  expected: SteadyStateAggregateCompatibilityKeyV1,
  actual: SteadyStateAggregateCompatibilityKeyV1
): SteadyStateAggregateFailureCode[] {
  const failures: SteadyStateAggregateFailureCode[] = [];
  if (actual.athleteId !== expected.athleteId) failures.push("incompatible_athlete");
  if (actual.machineId !== expected.machineId) failures.push("incompatible_machine");
  if (actual.machineProfileVersion !== expected.machineProfileVersion) {
    failures.push("incompatible_machine_profile");
  }
  if (actual.formalAnchorObservedAt !== expected.formalAnchorObservedAt) {
    failures.push("incompatible_formal_anchor");
  }
  if (
    actual.workoutIntent !== expected.workoutIntent ||
    actual.intensityId !== expected.intensityId ||
    actual.archetype !== expected.archetype
  ) {
    failures.push("incompatible_provenance");
  }
  if (actual.targetHrMin !== expected.targetHrMin || actual.targetHrMax !== expected.targetHrMax) {
    failures.push("incompatible_target_hr_band");
  }
  if (
    actual.admissionPolicyId !== expected.admissionPolicyId ||
    actual.admissionPolicyVersion !== expected.admissionPolicyVersion
  ) {
    failures.push("incompatible_admission_policy");
  }
  if (
    actual.observationSchemaId !== expected.observationSchemaId ||
    actual.observationSchemaVersion !== expected.observationSchemaVersion
  ) {
    failures.push("incompatible_observation_schema");
  }
  if (actual.observationProvenance !== expected.observationProvenance) {
    failures.push("incompatible_provenance");
  }
  return failures;
}

/**
 * Exact-duplicate fingerprint over the complete canonical single-session
 * observation schema. Any differing field → contradictory duplicate.
 * Caller extras (e.g. spoofed `workoutDate`) are ignored.
 */
export function canonicalObservationDuplicateFingerprint(
  observation: SteadyStateSettledWorkloadObservationV1
): string {
  // Field order mirrors SteadyStateSettledWorkloadObservationV1.
  return [
    observation.schemaId,
    String(observation.schemaVersion),
    observation.provenance,
    observation.admissionPolicyId,
    String(observation.admissionPolicyVersion),
    observation.athleteId,
    observation.sessionId,
    observation.machineId,
    String(observation.machineProfileVersion),
    observation.workoutIntent,
    observation.intensityId,
    observation.archetype,
    String(observation.targetHrMin),
    String(observation.targetHrMax),
    String(observation.windowStartSec),
    String(observation.windowEndSecExclusive),
    String(observation.settledFromSec),
    String(observation.qualifyingDurationSec),
    String(observation.postSettlingDurationSec),
    String(observation.heldResistance),
    String(observation.hrMedian),
    String(observation.hrInBandFraction),
    String(observation.hrCoverageRatio),
    String(observation.measuredWattsMedian),
    String(observation.measuredWattsMad),
    String(observation.measuredWattsSampleCount),
    String(observation.measuredWattsCoverageRatio),
    String(observation.cadenceMedian),
    String(observation.cadenceCoverageRatio),
    observation.controllerSettledProvenance,
    observation.formalAnchorObservedAt,
    observation.sessionEndedAt,
    observation.quality,
    String(observation.eligibleForPrescription),
    observation.interpretation,
  ].join("\u001f");
}

/** Chronological by derived workoutDate then sessionId (order-independent of input). */
function chronological(
  observations: readonly SteadyStateSettledWorkloadObservationV1[]
): SteadyStateSettledWorkloadObservationV1[] {
  return [...observations].sort((a, b) => {
    const da = workoutDateFromSessionEndedAt(a.sessionEndedAt) ?? "";
    const db = workoutDateFromSessionEndedAt(b.sessionEndedAt) ?? "";
    return (
      da.localeCompare(db) ||
      a.sessionEndedAt.localeCompare(b.sessionEndedAt) ||
      a.sessionId.localeCompare(b.sessionId)
    );
  });
}

export function classifyCrossSessionTrend(
  sessionMediansChronological: readonly number[]
): SteadyStateAggregateTrendDirection {
  if (sessionMediansChronological.length < 2) return "flat";
  let rises = 0;
  let falls = 0;
  for (let i = 1; i < sessionMediansChronological.length; i += 1) {
    const delta = sessionMediansChronological[i]! - sessionMediansChronological[i - 1]!;
    if (delta > 0) rises += 1;
    else if (delta < 0) falls += 1;
  }
  if (rises > 0 && falls === 0) return "rising";
  if (falls > 0 && rises === 0) return "falling";
  if (rises === 0 && falls === 0) return "flat";
  return "mixed";
}

function ageDays(newerIsoDate: string, olderIsoDate: string): number | null {
  const a = Date.parse(`${newerIsoDate}T00:00:00.000Z`);
  const b = Date.parse(`${olderIsoDate}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / (24 * 3600 * 1000));
}

/**
 * Deduplicate by sessionId. Identical duplicates collapse to one (deterministic
 * chronological pick). Contradictory duplicates fail the session entirely.
 */
function resolveSessionIndependence(
  observations: readonly SteadyStateSettledWorkloadObservationV1[]
): {
  accepted: SteadyStateSettledWorkloadObservationV1[];
  rejected: SteadyStateAggregateEvaluationV1["rejected"];
} {
  const bySession = new Map<string, SteadyStateSettledWorkloadObservationV1[]>();
  for (const observation of chronological(observations)) {
    const group = bySession.get(observation.sessionId) ?? [];
    group.push(observation);
    bySession.set(observation.sessionId, group);
  }
  const accepted: SteadyStateSettledWorkloadObservationV1[] = [];
  const rejected: SteadyStateAggregateEvaluationV1["rejected"] = [];
  // Deterministic session order: by sessionId.
  for (const sessionId of [...bySession.keys()].sort()) {
    const group = bySession.get(sessionId)!;
    const fingerprints = new Set(group.map(canonicalObservationDuplicateFingerprint));
    if (fingerprints.size > 1) {
      rejected.push({ sessionId, failures: ["contradictory_duplicate_session"] });
      continue;
    }
    if (group.length > 1) {
      rejected.push({ sessionId, failures: ["duplicate_session_id"] });
    }
    // Identical payloads: any member is equivalent; pick is chronological then sessionId.
    accepted.push(group[0]!);
  }
  return { accepted: chronological(accepted), rejected };
}

/**
 * Evaluate multi-session aggregation over qualifying single-session
 * observations. Fail-closed when scientific policy fields remain unresolved.
 */
export function evaluateSteadyStateSettledWorkloadAggregate(args: {
  observations: readonly SteadyStateAggregateObservationInputV1[];
  /**
   * Expected compatibility lineage. When omitted, all valid observations must
   * share one homogeneous key (order-independent). Mixed lineages fail closed.
   */
  expectedCompatibility?: SteadyStateAggregateCompatibilityKeyV1;
  policy?: SteadyStateSettledWorkloadAggregatePolicyV1;
  /** Reference "today" for age checks (UTC YYYY-MM-DD). Defaults to newest observation date. */
  asOfDate?: string;
}): SteadyStateAggregateEvaluationV1 {
  const policy = args.policy ?? STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1;
  const unresolved = unresolvedAggregateFields(policy);
  const rejected: SteadyStateAggregateEvaluationV1["rejected"] = [];

  const valid: SteadyStateSettledWorkloadObservationV1[] = [];
  for (const observation of args.observations) {
    if (!isValidObservationForAggregatePolicy(observation, policy)) {
      rejected.push({
        sessionId: observation?.sessionId ?? "unknown",
        failures: ["invalid_observation_payload"],
      });
      continue;
    }
    valid.push(observation);
  }

  let expected: SteadyStateAggregateCompatibilityKeyV1 | null =
    args.expectedCompatibility ?? null;
  let lineageReady = true;

  if (!expected) {
    if (valid.length === 0) {
      expected = null;
    } else {
      const fingerprints = new Set(
        valid.map((observation) =>
          compatibilityKeyFingerprint(compatibilityKeyFromObservation(observation))
        )
      );
      if (fingerprints.size > 1) {
        lineageReady = false;
        expected = null;
        for (const observation of valid) {
          rejected.push({
            sessionId: observation.sessionId,
            failures: ["mixed_compatibility_lineage"],
          });
        }
      } else {
        expected = compatibilityKeyFromObservation(valid[0]!);
      }
    }
  }

  const lineageMembers: SteadyStateSettledWorkloadObservationV1[] = [];
  if (lineageReady && expected) {
    for (const observation of chronological(valid)) {
      const key = compatibilityKeyFromObservation(observation);
      const incompat = compatibilityFailures(expected, key);
      if (incompat.length > 0) {
        rejected.push({ sessionId: observation.sessionId, failures: incompat });
        continue;
      }
      lineageMembers.push(observation);
    }
  }

  const { accepted: ordered, rejected: duplicateRejected } = lineageReady
    ? resolveSessionIndependence(lineageMembers)
    : { accepted: [] as SteadyStateSettledWorkloadObservationV1[], rejected: [] };
  rejected.push(...duplicateRejected);

  const sessionMedians = ordered.map((o) => o.measuredWattsMedian);
  const dates = [
    ...new Set(
      ordered
        .map((o) => workoutDateFromSessionEndedAt(o.sessionEndedAt))
        .filter((d): d is string => d != null)
    ),
  ].sort();
  const aggregateMedian = canonicalMedian(sessionMedians) ?? null;
  const crossMad =
    sessionMedians.length > 0 ? medianAbsoluteDeviation(sessionMedians) ?? null : null;
  const crossMadRatio =
    aggregateMedian != null && aggregateMedian > 0 && crossMad != null
      ? crossMad / aggregateMedian
      : null;
  const trendDirection =
    sessionMedians.length > 0 ? classifyCrossSessionTrend(sessionMedians) : null;
  const spanRatio =
    aggregateMedian != null && aggregateMedian > 0 && sessionMedians.length > 0
      ? (Math.max(...sessionMedians) - Math.min(...sessionMedians)) / aggregateMedian
      : null;

  const failures: SteadyStateAggregateFailureCode[] = [];
  if (!lineageReady) {
    failures.push("mixed_compatibility_lineage");
  } else if (!expected) {
    failures.push("insufficient_observations");
  } else {
    if (ordered.length < policy.minSessions) failures.push("insufficient_observations");
    if (dates.length < policy.minDistinctDates) failures.push("insufficient_distinct_dates");
    if (aggregateMedian == null || aggregateMedian <= 0) {
      failures.push("non_positive_aggregate_watts");
    }
    if (policy.maxCrossSessionMadRatio !== null) {
      if (crossMadRatio == null || crossMadRatio > policy.maxCrossSessionMadRatio) {
        failures.push("unstable_cross_session_workload");
      }
    }
    if (policy.maxObservationAgeDays !== null && ordered.length > 0) {
      const newest = dates[dates.length - 1]!;
      const asOf = args.asOfDate ?? newest;
      for (const observation of ordered) {
        const date = workoutDateFromSessionEndedAt(observation.sessionEndedAt);
        const age = date == null ? null : ageDays(asOf, date);
        if (age == null || age > policy.maxObservationAgeDays) {
          failures.push("stale_observation");
          break;
        }
      }
    }
  }
  if (unresolved.length > 0) failures.push("policy_threshold_unresolved");

  const diagnostics: SteadyStateAggregateEvaluationV1["diagnostics"] = {
    sessionMeasuredWattsMedians: sessionMedians,
    aggregateMeasuredWattsMedian: aggregateMedian,
    crossSessionWattsMad: crossMad,
    crossSessionWattsMadRatio: crossMadRatio,
    trendDirection,
    sessionWattsSpanRatio: spanRatio,
    distinctDateCount: dates.length,
  };

  const policyProductionReady = unresolved.length === 0;
  let aggregate: SteadyStateSettledWorkloadAggregateV1 | null = null;
  const emissionBlockers = failures.filter((code) => code !== "policy_threshold_unresolved");
  if (
    policyProductionReady &&
    expected &&
    emissionBlockers.length === 0 &&
    aggregateMedian != null &&
    crossMad != null &&
    crossMadRatio != null &&
    trendDirection != null &&
    spanRatio != null
  ) {
    const newest = ordered[ordered.length - 1]!;
    aggregate = {
      schemaId: policy.contractIdentity.schemaId,
      schemaVersion: policy.contractIdentity.schemaVersion,
      provenance: policy.contractIdentity.provenance,
      compatibility: expected,
      sessionIds: ordered.map((o) => o.sessionId),
      workoutDates: dates,
      sessionCount: ordered.length,
      distinctDateCount: dates.length,
      aggregateMeasuredWattsMedian: aggregateMedian,
      crossSessionWattsMad: crossMad,
      crossSessionWattsMadRatio: crossMadRatio,
      sessionMeasuredWattsMedians: sessionMedians,
      trendDirection,
      sessionWattsSpanRatio: spanRatio,
      quality: "unverified",
      interpretation: "descriptive_aggregate_only",
      eligibleForPrescription: false,
      eligibleForShadowCandidate: policy.allowShadowCandidateEligibility,
      observedAt: newest.sessionEndedAt,
      admissionPolicyId: expected.admissionPolicyId,
      admissionPolicyVersion: expected.admissionPolicyVersion,
      aggregatePolicyId: policy.id,
      aggregatePolicyVersion: policy.version,
    };
  }

  return {
    policy,
    policyProductionReady,
    unresolvedPolicyFields: unresolved,
    compatibility: expected,
    acceptedObservations: ordered,
    rejected,
    failures: [...new Set(failures)],
    diagnostics,
    aggregate,
  };
}

/** Pure helper for sensitivity / design analysis of session-median series. */
export function summarizeSessionMedianSeries(sessionMedians: readonly number[]): {
  median: number | null;
  mad: number | null;
  madRatio: number | null;
  trendDirection: SteadyStateAggregateTrendDirection;
  spanRatio: number | null;
} {
  const median = canonicalMedian(sessionMedians) ?? null;
  const mad = sessionMedians.length > 0 ? medianAbsoluteDeviation(sessionMedians) ?? null : null;
  const madRatio = median != null && median > 0 && mad != null ? mad / median : null;
  const spanRatio =
    median != null && median > 0 && sessionMedians.length > 0
      ? (Math.max(...sessionMedians) - Math.min(...sessionMedians)) / median
      : null;
  return {
    median,
    mad,
    madRatio,
    trendDirection: classifyCrossSessionTrend(sessionMedians),
    spanRatio,
  };
}
