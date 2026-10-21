/**
 * Versioned fitness metric value shared by the athlete profile and FitnessState.
 */

export type FitnessMetricSource =
  | "formal_assessment"
  | "user_entered"
  | "workout_observation"
  | "demographic_estimate";

export type FitnessMetricQuality = "high" | "moderate" | "low" | "unverified";

export interface FitnessMetric<T> {
  value: T;
  source: FitnessMetricSource;
  quality: FitnessMetricQuality;
  observedAt: string;
  updatedAt: string;
  algorithm?: {
    id: string;
    version: number;
  };
  evidenceSessionIds?: string[];
}
