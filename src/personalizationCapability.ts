/**
 * Central personalization capability / phase-archetype seam.
 *
 * Workouts are declarative consumers. Personalization sits above named
 * workout selectors and routes evidence through reusable archetypes
 * (`steady_state`, `interval`, `recovery`).
 *
 * Declaring an archetype does NOT enable an algorithm. The generic
 * steady-state engine is a pure configurable algorithm and does not consult
 * this table. Product evidence is enabled only through capability-authorized
 * adapters/routers with `completedWorkoutEvidence: true` — currently
 * Threshold → steady_state only. Exercising the kernel under a synthetic
 * policy does not activate product evidence for that intensity.
 *
 * Phase-intensity eligibility and workout-intent eligibility are orthogonal
 * product-routing dimensions. A workout may pair e.g. workoutIntent
 * `aerobic_volume` with phase intensity `aerobic_base`.
 *
 * These tables own product routing flags only — not scientific numeric
 * thresholds, HR zones, VO₂ protocol science, Phase D admission, cross-intent
 * evidence sharing, or machine-control behavior.
 * See docs/personalization-architecture.md.
 */

import type { PhaseIntensityId } from "./types.js";

export type PersonalizationPhaseArchetype = "steady_state" | "interval" | "recovery";

/**
 * Product workout-intent vocabulary used by personalization routing.
 * Distinct from PhaseIntensityId (phase intensity ids such as vo2_short /
 * vo2_long / strength_support are not workout intents).
 */
export type PersonalizationWorkoutIntent =
  | "aerobic_base"
  | "aerobic_volume"
  | "threshold"
  | "vo2_primer"
  | "vo2_priority"
  | "support_strength"
  | "recovery";

export interface PersonalizationCapabilityV1 {
  activity: "bike";
  /** Primary intensity region this capability addresses. */
  intensityId: PhaseIntensityId | "recovery";
  archetype: PersonalizationPhaseArchetype;
  /** E1 / shadow prescription path may consider this intensity. */
  shadowPrescription: boolean;
  /**
   * Whether the completed-workout settled-workload evidence engine may emit
   * observations for this capability. False = architecture declared only.
   */
  completedWorkoutEvidence: boolean;
  notes?: string;
}

/**
 * Workout-intent → E1 shadow-prescription routing eligibility.
 * Orthogonal to PERSONALIZATION_CAPABILITIES_V1 (phase intensity).
 * Product routing only — no science, evidence sharing, or VO₂ protocol rules.
 */
export interface PersonalizationIntentCapabilityV1 {
  workoutIntent: PersonalizationWorkoutIntent;
  shadowPrescription: boolean;
  notes?: string;
}

/**
 * Source of truth for intensity → archetype mapping.
 * Evidence algorithms are enabled only where `completedWorkoutEvidence` is true.
 */
export const PERSONALIZATION_CAPABILITIES_V1: readonly PersonalizationCapabilityV1[] = [
  {
    activity: "bike",
    intensityId: "aerobic_base",
    archetype: "steady_state",
    shadowPrescription: true,
    completedWorkoutEvidence: false,
    notes: "Future steady_state consumer; not enabled this slice.",
  },
  {
    activity: "bike",
    intensityId: "threshold",
    archetype: "steady_state",
    shadowPrescription: true,
    completedWorkoutEvidence: true,
    notes: "First steady_state configuration (Threshold adapter).",
  },
  {
    activity: "bike",
    intensityId: "vo2_short",
    archetype: "interval",
    shadowPrescription: false,
    completedWorkoutEvidence: false,
  },
  {
    activity: "bike",
    intensityId: "vo2_long",
    archetype: "interval",
    shadowPrescription: false,
    completedWorkoutEvidence: false,
  },
  {
    activity: "bike",
    intensityId: "recovery",
    archetype: "recovery",
    shadowPrescription: false,
    completedWorkoutEvidence: false,
  },
] as const;

/**
 * Source of truth for workout-intent → shadow-prescription routing.
 * Matches current E1 intent allowlist; unknown intents fail closed via helpers.
 */
export const PERSONALIZATION_INTENT_CAPABILITIES_V1: readonly PersonalizationIntentCapabilityV1[] = [
  { workoutIntent: "aerobic_base", shadowPrescription: true },
  { workoutIntent: "aerobic_volume", shadowPrescription: true },
  { workoutIntent: "threshold", shadowPrescription: true },
  { workoutIntent: "vo2_primer", shadowPrescription: false },
  { workoutIntent: "vo2_priority", shadowPrescription: false },
  { workoutIntent: "support_strength", shadowPrescription: false },
  { workoutIntent: "recovery", shadowPrescription: false },
] as const;

export function personalizationCapabilityForIntensity(
  intensityId: string
): PersonalizationCapabilityV1 | undefined {
  return PERSONALIZATION_CAPABILITIES_V1.find((row) => row.intensityId === intensityId);
}

export function personalizationIntentCapabilityForIntent(
  workoutIntent: string
): PersonalizationIntentCapabilityV1 | undefined {
  return PERSONALIZATION_INTENT_CAPABILITIES_V1.find((row) => row.workoutIntent === workoutIntent);
}

/**
 * Whether E1 / shadow prescription may consider this intensity.
 * Derives from PERSONALIZATION_CAPABILITIES_V1 only — no workout intent,
 * VO₂ selector, or scientific-threshold logic.
 */
export function personalizationShadowPrescriptionEnabledForIntensity(
  intensityId: string
): boolean {
  return personalizationCapabilityForIntensity(intensityId)?.shadowPrescription === true;
}

/**
 * Whether E1 / shadow prescription may consider this workout intent.
 * Derives from PERSONALIZATION_INTENT_CAPABILITIES_V1 only — no intensity,
 * activity, selector, or scientific-threshold logic. Unknown intents fail closed.
 */
export function personalizationShadowPrescriptionEnabledForIntent(
  workoutIntent: string
): boolean {
  return personalizationIntentCapabilityForIntent(workoutIntent)?.shadowPrescription === true;
}

/**
 * Current product shadow-prescription enabled intensity set, derived from
 * PERSONALIZATION_CAPABILITIES_V1 in table order.
 *
 * This is a live routing/eligibility snapshot — not the historical E1
 * PersonalizedPrescriptionPolicyV1 serialized contract (see
 * PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES).
 */
export function personalizationShadowPrescriptionEnabledIntensities(): readonly PhaseIntensityId[] {
  return PERSONALIZATION_CAPABILITIES_V1.filter((row) => row.shadowPrescription).map(
    (row) => row.intensityId as PhaseIntensityId
  );
}

/**
 * Current product shadow-prescription enabled workout-intent set, derived from
 * PERSONALIZATION_INTENT_CAPABILITIES_V1 in table order.
 * Live routing snapshot only — not part of E1 schema v1 serialization.
 */
export function personalizationShadowPrescriptionEnabledIntents(): readonly PersonalizationWorkoutIntent[] {
  return PERSONALIZATION_INTENT_CAPABILITIES_V1.filter((row) => row.shadowPrescription).map(
    (row) => row.workoutIntent
  );
}

export function steadyStateEvidenceEnabledForIntensity(intensityId: string): boolean {
  const row = personalizationCapabilityForIntensity(intensityId);
  return row?.archetype === "steady_state" && row.completedWorkoutEvidence === true;
}

/**
 * UNRESOLVED product decision: whether multiple workout intents that share the
 * same intensityId + steady_state archetype (e.g. aerobic_base intent vs
 * aerobic_volume intent both carrying intensityId=aerobic_base) should share
 * one evidence lineage. Generic compatibility currently includes both
 * workoutIntent and intensityId so they remain distinguishable until decided.
 */
export const CROSS_INTENT_SAME_INTENSITY_EVIDENCE_SHARING_V1 = "unresolved" as const;
