export interface HrQualitySample {
  elapsedSeconds: number;
  bpm: number;
}

export const MIN_HR_SAMPLES = 5;
export const MIN_HR_SPAN_SECONDS = 4;

export function validDistinctHr(samples: readonly HrQualitySample[]): HrQualitySample[] {
  const byElapsed = new Map<number, number>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.bpm) || sample.bpm <= 0) continue;
    if (!Number.isFinite(sample.elapsedSeconds)) continue;
    byElapsed.set(sample.elapsedSeconds, sample.bpm);
  }
  return [...byElapsed.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([elapsedSeconds, bpm]) => ({ elapsedSeconds, bpm }));
}

export interface QualifiedHrMedian {
  median: number;
  sampleCount: number;
  windowSpanSeconds: number;
}

export function qualifiedHrMedianDetails(samples: readonly HrQualitySample[]): QualifiedHrMedian | undefined {
  const distinct = validDistinctHr(samples);
  if (distinct.length < MIN_HR_SAMPLES) return undefined;
  const span = distinct[distinct.length - 1].elapsedSeconds - distinct[0].elapsedSeconds;
  if (span < MIN_HR_SPAN_SECONDS) return undefined;
  const values = distinct.map((sample) => sample.bpm).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
  return {
    median,
    sampleCount: distinct.length,
    windowSpanSeconds: span,
  };
}

export function qualifiedHrMedian(samples: readonly HrQualitySample[]): number | undefined {
  return qualifiedHrMedianDetails(samples)?.median;
}

export function integerMedian(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export function integerMedianAbsoluteDeviation(values: readonly number[]): number | undefined {
  const samples = values.filter((value) => Number.isInteger(value) && Number.isFinite(value));
  const median = integerMedian(samples);
  if (median === undefined) return undefined;
  return integerMedian(samples.map((value) => Math.abs(value - median)));
}

export function samplesInRange(
  samples: readonly HrQualitySample[],
  start: number,
  end: number,
  options?: { startExclusive?: boolean; endInclusive?: boolean }
): HrQualitySample[] {
  const startExclusive = options?.startExclusive === true;
  const endInclusive = options?.endInclusive === true;
  return samples.filter((sample) => {
    const afterStart = startExclusive ? sample.elapsedSeconds > start : sample.elapsedSeconds >= start;
    const beforeEnd = endInclusive ? sample.elapsedSeconds <= end : sample.elapsedSeconds < end;
    return afterStart && beforeEnd;
  });
}
