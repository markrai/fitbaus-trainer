/**
 * HR controller for Downregulation visualization.
 * - Baseline: mean HR over first 30 seconds after start.
 * - Rolling 20s window: smoothedHR = mean of samples in last 20 seconds.
 * - Exponential smoothing: optional second pass for responsiveness.
 * - Variance (20s window): higher variance reduces coherence (variancePenalty).
 * - Slope: negative HR slope (smooth decline) gives small coherence bonus;
 *   we do NOT reward sudden drops (slope is computed over 20s, and large negative slopes are capped).
 * - coherenceFactor = clamp(smoothedDelta - variancePenalty + slopeBonus, 0, 1).
 */

const BASELINE_WINDOW_MS = 30 * 1000;
const ROLLING_WINDOW_MS = 20 * 1000;
const EXP_ALPHA = 0.15; // exponential smoothing: higher = more responsive
const VARIANCE_PENALTY_SCALE = 0.002; // map variance (bpm^2) to penalty (max ~0.05)
const SLOPE_BONUS_MAX = 0.03; // max bonus for smooth negative slope
const SLOPE_THRESHOLD_BPM_PER_SEC = 2; // slope steeper than this (negative) is "sudden drop", no bonus

interface Sample {
  t: number;
  bpm: number;
}

let samples: Sample[] = [];
let baselineHR: number | null = null;
let baselineEndTime: number | null = null;
let expSmoothedHR: number | null = null;

/**
 * Add a new HR sample. Call from hrMonitor onBpm or from simulated HR.
 */
export function setCurrentHR(bpm: number): void {
  const t = Date.now();
  if (bpm <= 0 || !Number.isFinite(bpm)) return;
  samples.push({ t, bpm });

  // Prune old samples (keep last 2 minutes for baseline + rolling)
  const cutoff = t - Math.max(BASELINE_WINDOW_MS, ROLLING_WINDOW_MS) - 5000;
  samples = samples.filter((s) => s.t > cutoff);

  // Baseline: mean HR over first 30 seconds
  if (baselineEndTime === null && baselineHR === null) {
    const firstT = samples[0]?.t ?? t;
    if (t - firstT >= BASELINE_WINDOW_MS) {
      const baselineSamples = samples.filter((s) => s.t >= firstT && s.t <= firstT + BASELINE_WINDOW_MS);
      if (baselineSamples.length > 0) {
        baselineHR = baselineSamples.reduce((sum, s) => sum + s.bpm, 0) / baselineSamples.length;
        baselineEndTime = firstT + BASELINE_WINDOW_MS;
      }
    }
  }

  // Exponential smoothing of current BPM (for responsiveness)
  if (expSmoothedHR === null) {
    expSmoothedHR = bpm;
  } else {
    expSmoothedHR = EXP_ALPHA * bpm + (1 - EXP_ALPHA) * expSmoothedHR;
  }
}

/**
 * Rolling 20s mean HR (for delta and variance).
 */
function getRollingMeanAndVariance(now: number): { mean: number; variance: number; count: number } {
  const start = now - ROLLING_WINDOW_MS;
  const windowSamples = samples.filter((s) => s.t >= start && s.t <= now);
  const count = windowSamples.length;
  if (count < 2) {
    return { mean: expSmoothedHR ?? 70, variance: 0, count };
  }
  const mean = windowSamples.reduce((s, x) => s + x.bpm, 0) / count;
  const variance = windowSamples.reduce((s, x) => s + (x.bpm - mean) ** 2, 0) / count;
  return { mean, variance, count };
}

/**
 * Slope (bpm per second) over the 20s window: (last - first) / (timeSpan).
 * Negative = HR declining (downregulation). We cap large negative slopes so sudden drops don't get rewarded.
 */
function getSlope(now: number): number {
  const start = now - ROLLING_WINDOW_MS;
  const windowSamples = samples.filter((s) => s.t >= start && s.t <= now);
  if (windowSamples.length < 2) return 0;
  const first = windowSamples[0];
  const last = windowSamples[windowSamples.length - 1];
  const dtSec = (last.t - first.t) / 1000;
  if (dtSec <= 0) return 0;
  return (last.bpm - first.bpm) / dtSec; // bpm per second
}

/**
 * Delta = (baselineHR - currentHR) / baselineHR. Clamped to [0, 1].
 * Uses smoothed HR (rolling 20s mean) as currentHR.
 */
export function getDelta(): number {
  if (baselineHR == null || baselineHR <= 0) return 0;
  const now = Date.now();
  const { mean } = getRollingMeanAndVariance(now);
  const delta = (baselineHR - mean) / baselineHR;
  return Math.max(0, Math.min(1, delta));
}

/**
 * Coherence factor for the shader: 0 = chaotic, 1 = ordered.
 * coherenceFactor = clamp(smoothedDelta - variancePenalty + slopeBonus, 0, 1).
 * - variancePenalty: higher HR variance in 20s reduces coherence.
 * - slopeBonus: smooth negative slope (HR declining) gives small bonus; sudden drops are capped (no reward).
 */
export function getCoherenceFactor(): number {
  const delta = getDelta();
  const now = Date.now();
  const { mean, variance } = getRollingMeanAndVariance(now);
  const slope = getSlope(now);

  // Variance penalty: scale variance (bpm^2) to ~0..0.05
  const variancePenalty = Math.min(0.05, variance * VARIANCE_PENALTY_SCALE);

  // Slope bonus: only for smooth negative slope. bpm/sec: 0 to -2 -> bonus 0 to SLOPE_BONUS_MAX; steeper = sudden drop = no bonus
  let slopeBonus = 0;
  if (slope < 0 && slope >= -SLOPE_THRESHOLD_BPM_PER_SEC) {
    slopeBonus = (Math.abs(slope) / SLOPE_THRESHOLD_BPM_PER_SEC) * SLOPE_BONUS_MAX;
  }

  const raw = delta - variancePenalty + slopeBonus;
  return Math.max(0, Math.min(1, raw));
}

export function getSmoothedHR(): number | null {
  return expSmoothedHR;
}

export function getBaselineHR(): number | null {
  return baselineHR;
}

export function isBaselineReady(): boolean {
  return baselineHR != null;
}

export function reset(): void {
  samples = [];
  baselineHR = null;
  baselineEndTime = null;
  expSmoothedHR = null;
}
