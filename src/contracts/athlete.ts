/**
 * Athlete identity, the versioned athlete profile, and the legacy compatibility
 * profile. These are deliberately separate stored shapes.
 */

import type { FitnessMetric } from "./fitnessMetric.js";

export interface Profile {
  weight: number | string;
  height: number | string;
  age: number | string;
  sex: "male" | "female" | "" | string;
  vo2: number | string;
}

/** Permanent historical schema identities. Readers must not key old data to current aliases. */
export const ATHLETE_PROFILE_SCHEMA_VERSION_V1 = 1 as const;
export const ATHLETE_PROFILE_SCHEMA_VERSION = ATHLETE_PROFILE_SCHEMA_VERSION_V1;
/**
 * Versioned internal identity for the current single local athlete.
 * Body mass and height intentionally retain the profile form's pounds/inches
 * so legacy profile migration needs no unit conversion and remains idempotent.
 */
export interface AthleteProfile {
  schemaVersion: typeof ATHLETE_PROFILE_SCHEMA_VERSION;
  athleteId: string;
  demographics: {
    ageYears?: number;
    bodyMassLbs?: number;
    heightInches?: number;
    sex?: "male" | "female";
  };
  userEnteredVo2?: FitnessMetric<number>;
  createdAt: string;
  updatedAt: string;
}

export interface AthleteIdentity {
  schemaVersion: 1;
  athleteId: string;
  createdAt: string;
}
