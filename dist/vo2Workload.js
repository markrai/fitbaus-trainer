/**
 * Bike Bridge polls ~1 Hz. Require at least this many valid samples in the
 * last 120 s of an accepted stage (the two 60 s windows that define HR steady-state).
 */
export const VO2_PRESCRIBED_CADENCE_RPM = 70;
export const VO2_WORKLOAD_WINDOW_SEC = 120;
export const VO2_WORKLOAD_MIN_SAMPLES = 45;
/** Inclusive tolerance around prescribed 70 RPM for calibrated-table eligibility. */
export const VO2_CADENCE_TOLERANCE_RPM = 5;
/** Fraction of cadence samples that must lie in-band. */
export const VO2_CADENCE_MIN_IN_BAND_RATIO = 0.75;
function isPositiveFinite(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
export function median(values) {
    if (values.length === 0)
        return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1)
        return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
}
export function cadenceInBand(rpm, prescribed = VO2_PRESCRIBED_CADENCE_RPM) {
    return Math.abs(rpm - prescribed) <= VO2_CADENCE_TOLERANCE_RPM;
}
function windowBounds(stage) {
    const end = stage.active_end_sec;
    const start = Math.max(stage.active_start_sec, end - VO2_WORKLOAD_WINDOW_SEC);
    return { start, end };
}
function samplesInWindow(samples, start, end) {
    return samples.filter((sample) => Number.isFinite(sample.timestamp_sec) && sample.timestamp_sec >= start && sample.timestamp_sec <= end);
}
/**
 * Compact per-stage workload provenance from already-polled Bike Bridge telemetry.
 * Does not poll the bike. Prescribed 70 RPM is never treated as measured cadence.
 */
export function summarizeVo2StageWorkload(stage, samples = [], prescribedCadenceRpm = VO2_PRESCRIBED_CADENCE_RPM) {
    const bounds = windowBounds(stage);
    const windowSamples = samplesInWindow(samples, bounds.start, bounds.end);
    const wattsValues = windowSamples.map((sample) => sample.watts).filter(isPositiveFinite);
    const rpmValues = windowSamples.map((sample) => sample.rpm).filter(isPositiveFinite);
    const wattsMedian = median(wattsValues);
    const rpmMedian = median(rpmValues);
    const inBand = rpmValues.filter((rpm) => cadenceInBand(rpm, prescribedCadenceRpm));
    const cadenceRatio = rpmValues.length > 0 ? inBand.length / rpmValues.length : undefined;
    const wattsMeasured = wattsValues.length >= VO2_WORKLOAD_MIN_SAMPLES && wattsMedian != null;
    const cadenceMeasured = rpmValues.length >= VO2_WORKLOAD_MIN_SAMPLES && rpmMedian != null;
    const cadenceVerified = cadenceMeasured &&
        cadenceRatio != null &&
        cadenceRatio >= VO2_CADENCE_MIN_IN_BAND_RATIO &&
        cadenceInBand(rpmMedian, prescribedCadenceRpm);
    let source = "prescribed_only";
    let estimatorWatts;
    if (wattsMeasured) {
        source = "measured_watts";
        estimatorWatts = wattsMedian;
    }
    else if (cadenceVerified && isPositiveFinite(stage.calibrated_watts_at_70rpm)) {
        source = "calibrated_at_verified_cadence";
        estimatorWatts = stage.calibrated_watts_at_70rpm;
    }
    const evidence = {
        source,
        calibrated_watts_at_70rpm: stage.calibrated_watts_at_70rpm,
        measured_watts_sample_count: wattsValues.length,
        measured_cadence_sample_count: rpmValues.length,
        cadence_measured: cadenceMeasured,
        watts_measured: wattsMeasured,
    };
    if (estimatorWatts != null)
        evidence.estimator_watts = estimatorWatts;
    if (wattsMedian != null)
        evidence.measured_watts_median = wattsMedian;
    if (rpmMedian != null)
        evidence.measured_cadence_median_rpm = rpmMedian;
    if (cadenceRatio != null)
        evidence.cadence_in_band_ratio = cadenceRatio;
    return evidence;
}
export function measuredWorkloadForTests(watts, extras = {}) {
    return {
        source: "measured_watts",
        estimator_watts: watts,
        calibrated_watts_at_70rpm: watts,
        measured_watts_median: watts,
        measured_watts_sample_count: 90,
        measured_cadence_median_rpm: VO2_PRESCRIBED_CADENCE_RPM,
        measured_cadence_sample_count: 90,
        cadence_in_band_ratio: 1,
        cadence_measured: true,
        watts_measured: true,
        ...extras,
    };
}
export function verifiedCadenceWorkloadForTests(calibratedWatts, extras = {}) {
    return {
        source: "calibrated_at_verified_cadence",
        estimator_watts: calibratedWatts,
        calibrated_watts_at_70rpm: calibratedWatts,
        measured_watts_sample_count: 0,
        measured_cadence_median_rpm: VO2_PRESCRIBED_CADENCE_RPM,
        measured_cadence_sample_count: 90,
        cadence_in_band_ratio: 1,
        cadence_measured: true,
        watts_measured: false,
        ...extras,
    };
}
export function prescribedOnlyWorkloadForTests(calibratedWatts, extras = {}) {
    return {
        source: "prescribed_only",
        calibrated_watts_at_70rpm: calibratedWatts,
        measured_watts_sample_count: 0,
        measured_cadence_sample_count: 0,
        cadence_measured: false,
        watts_measured: false,
        ...extras,
    };
}
