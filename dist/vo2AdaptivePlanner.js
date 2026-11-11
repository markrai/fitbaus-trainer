import { VO2_ESTIMATOR_MIN_HR_BPM, VO2_MIN_ELIGIBLE_STAGES, VO2_PREDICTED_HRMAX_MAX, VO2_PREDICTED_HRMAX_MIN, estimatorSubmaxHrCeilingBpm, fitHrVsWatts, } from "./vo2Estimator.js";
import { VO2_COOLDOWN_DURATION_SEC, VO2_MAX_STAGE_DURATION_SEC, VO2_PROTOCOL_MAX_RESISTANCE, VO2_WARMUP_DURATION_SEC, } from "./vo2Protocol.js";
import { AUTOMATIC_RESISTANCE_MIN } from "./machines/proformSmartPower10.js";
export const VO2_ADAPTIVE_PLANNER_VERSION = 1;
/** Advertised upper bound for a v3 assessment: 30 minutes end-to-end. */
export const VO2_ADAPTIVE_ADVERTISED_MAX_TOTAL_DURATION_SEC = 30 * 60;
/**
 * HR safety margin below the hard estimator ceiling.
 * planning_ceiling = hard_ceiling - margin.
 *
 * Control problem: after each completed stage the planner holds exactly two
 * eligible (calibratedWatts, steadyHr) points -- it completes at three --
 * both strictly below the hard submax ceiling (85% of Tanaka HRmax) and
 * at/above the 110bpm estimator floor. It must choose one unused resistance
 * (calibrated watts) whose likely steady HR stays below the hard ceiling
 * with useful separation from prior points, or stop truthfully. The model
 * is the secant line through the two points (ordinary least squares via
 * the shared estimator fit). Slope must be positive; otherwise the planner
 * stops (nonpositive_slope) instead of extrapolating.
 *
 * Quantified evidence (n=1, age-46 session): calibrated points
 * (86W/121.15bpm, 108W/132.25bpm) fit slope 0.5045 bpm/W, predicting
 * 139.81bpm at 123W, while the performed stage measured 154.12bpm --
 * 14.31bpm of underprediction for a 15W extrapolation (~0.95 bpm/W).
 * That geometry belongs to the OLD v2 ladder: fit two low points, then
 * jump 15W past the fitted region with no re-fit, no margin, and no early
 * stop. The v3 sequence for the same subject under the original 25W
 * bootstrap diverges at stage 2 (bootstrap R6/86W, conservative R7/97W) and
 * either completes at three eligible stages or terminates truthfully; from
 * a stage-3 base of 97W the failed 123W level is 26W away and structurally
 * excluded by the 25W maximum increment, and any prediction at or above
 * planning is refused outright. (The current bootstrap starts lower; see
 * VO2_ADAPTIVE_BOOTSTRAP_WATT_STEP.) The portable part of the observation
 * is the rate (~0.95 bpm/W of unmodeled steepening), not the 14.31 total.
 *
 * A second real session (age 46, protocol v3, original bootstrap) shows
 * the margin is not what limits acquisition: eligible R6/86W -> 120.30bpm
 * and R7/97W -> 137.32bpm fit 1.547 bpm/W, predicting 154.33bpm at R8/108W,
 * above the hard ceiling (149.43) as well as planning (137.43). No margin
 * >= 0 admits R8; the session stopped with two eligible stages because the
 * bootstrap had already skipped the lower calibrated levels.
 *
 * Why margin 12 is retained. The margin covers the observed rate for steps
 * up to ~12W, and steps are forced small exactly where a crossing is
 * within reach: near the ceiling the max-safe clamp holds the target at or
 * below maxSafe, bounding the prescribed step by roughly headroom/slope,
 * while far from the ceiling deep headroom absorbs larger absolute errors.
 * Every prescription is prediction-checked strictly below planning; flat
 * or negative response stops (nonpositive_slope); sparse tables refuse
 * rather than jump past the maximum increment; the session stops at three
 * eligible stages. What the margin does NOT cover is sharp convex
 * steepening inside a single large (up to 25W) step, where underprediction
 * can exceed the margin plus residual headroom. That residual is contained,
 * not prevented: the shared estimator classifier rejects any above-ceiling
 * point, the runtime retries lower at most once, then terminates truthfully.
 * v3's worst case (one 25W step) equals v2's every step, while v3
 * additionally refuses unsafe predictions, steps smaller on dense tables,
 * and stops early -- strictly safer than the status quo it replaces.
 * Usable planning range is (hard - margin) - 110bpm; for older athletes
 * with low HRmax this is intentionally tight (e.g. age 70: hard 135.15,
 * planning 123.15, usable 13.15bpm) rather than unsafe. Machine granularity
 * never justifies a smaller margin: when no calibrated level is both safe
 * and useful, the planner terminates with hr_safety_no_safe_target instead
 * of prescribing an unsafe workload.
 *
 * The margin stays fixed and is deliberately NOT tuned to make this one
 * session succeed: a single session cannot justify a distance-dependent or
 * heteroscedastic uncertainty rule, and fitting one to this fixture would
 * be overfitting. Revisit with multi-session data only.
 */
export const VO2_ADAPTIVE_SAFETY_MARGIN_BPM = 12;
/**
 * Minimum useful workload separation in calibrated watts (controllable
 * domain). Successive stages must differ by at least this much to improve
 * the HR-vs-workload regression. Enforced as a lower bound on every
 * prescribed increment alongside min_watt_increment (effective lower bound
 * is the larger of the two).
 */
export const VO2_ADAPTIVE_MIN_WATT_SEPARATION = 5;
/** Preferred calibrated-watt increment when far from the ceiling. */
export const VO2_ADAPTIVE_NORMAL_WATT_INCREMENT = 20;
/**
 * Maximum calibrated-watt increment allowed in a single step, in every
 * planner path (bootstrap, conservative, normal, retry). Never exceed v2's
 * fixed 25W step. Sparse calibration tables must refuse rather than jump
 * farther than this.
 */
export const VO2_ADAPTIVE_MAX_WATT_INCREMENT = 25;
/**
 * Minimum calibrated-watt increment the planner will prescribe. The planner
 * refuses (cannot) when no safe candidate achieves at least this increment
 * (and the separation bound). Always enforced; never decorative.
 */
export const VO2_ADAPTIVE_MIN_WATT_INCREMENT = 5;
/**
 * Maximum work stages derived from the advertised duration contract, not a
 * magic number: floor((advertisedTotal - warmup - cooldown) / maxStage).
 * With 1800 - 300 - 300 over 300-second stages this is 4, preserving the
 * "up to 30 min" bound (5 warmup + 4x5 work + 5 cooldown).
 */
export const VO2_ADAPTIVE_MAX_WORK_STAGES = Math.floor((VO2_ADAPTIVE_ADVERTISED_MAX_TOTAL_DURATION_SEC - VO2_WARMUP_DURATION_SEC - VO2_COOLDOWN_DURATION_SEC) /
    VO2_MAX_STAGE_DURATION_SEC);
/** One lower retry after an above-ceiling stage; prevents oscillation. */
export const VO2_ADAPTIVE_MAX_RETRIES_AFTER_ABOVE_CEILING = 1;
/**
 * First-stage step above warmup when no HR evidence exists yet: the smallest
 * distinguishable calibrated step (the effective minimum increment), so the
 * bootstrap selects the lowest unused calibrated level that is separated
 * from warmup. Runway rationale: the ladder only ascends (the estimator
 * requires strictly increasing workloads), so every calibrated level the
 * first stage skips is permanently lost to the minimum eligible-stage count,
 * and before any HR is observed a larger step is only a guess about where
 * the athlete's eligible HR band starts. Starting low has a bounded,
 * observed cost: a below-floor first stage is followed by the unchanged
 * fallback step and spends at most the one spare stage
 * (max_work_stages - VO2_MIN_ELIGIBLE_STAGES). Previously warmup + 25W
 * (v2's rule), which on a dense low end (e.g. warmup 66W -> 86W) skipped
 * levels that were later needed. Plans persist their policy, so a session
 * started under the old value keeps its own bootstrap step.
 */
export const VO2_ADAPTIVE_BOOTSTRAP_WATT_STEP = Math.max(VO2_ADAPTIVE_MIN_WATT_INCREMENT, VO2_ADAPTIVE_MIN_WATT_SEPARATION);
/**
 * Conservative calibrated-watt step when slope is unknown (<2 eligible
 * points) and no eligible in-band observation anchors the step (below-floor
 * or otherwise ineligible last stage, and lower retries). After an eligible
 * point that still leaves further eligible stages to collect, the planner
 * instead takes the minimum distinguishable step (see planNextVo2Stage).
 */
export const VO2_ADAPTIVE_FALLBACK_WATT_STEP = 15;
/**
 * With <2 points the slope is unknown, so require this much headroom below
 * planning (22bpm below hard with margin 12) before attempting a small step.
 */
export const VO2_ADAPTIVE_FALLBACK_MIN_HEADROOM_BPM = 10;
/** Provenance label: predicted within this of planning counts as "near ceiling". */
export const VO2_ADAPTIVE_NEAR_CEILING_THRESHOLD_BPM = 10;
export const DEFAULT_VO2_ADAPTIVE_POLICY = {
    policy_version: 1,
    safety_margin_bpm: VO2_ADAPTIVE_SAFETY_MARGIN_BPM,
    min_watt_separation: VO2_ADAPTIVE_MIN_WATT_SEPARATION,
    normal_watt_increment: VO2_ADAPTIVE_NORMAL_WATT_INCREMENT,
    max_watt_increment: VO2_ADAPTIVE_MAX_WATT_INCREMENT,
    min_watt_increment: VO2_ADAPTIVE_MIN_WATT_INCREMENT,
    max_work_stages: VO2_ADAPTIVE_MAX_WORK_STAGES,
    max_retries_after_above_ceiling: VO2_ADAPTIVE_MAX_RETRIES_AFTER_ABOVE_CEILING,
    bootstrap_watt_step: VO2_ADAPTIVE_BOOTSTRAP_WATT_STEP,
    fallback_watt_step: VO2_ADAPTIVE_FALLBACK_WATT_STEP,
    fallback_min_headroom_bpm: VO2_ADAPTIVE_FALLBACK_MIN_HEADROOM_BPM,
    near_ceiling_threshold_bpm: VO2_ADAPTIVE_NEAR_CEILING_THRESHOLD_BPM,
    min_resistance: AUTOMATIC_RESISTANCE_MIN,
    max_resistance: VO2_PROTOCOL_MAX_RESISTANCE,
};
/**
 * TEMPORARY developer-only acquisition experiment (single real-bike session).
 *
 * Isolates one question: can the athlete complete three eligible stages when
 * the planner enters the band around R5 and tolerates the 4 W R5->R6
 * calibrated step? All safety invariants (hard ceiling, estimator floor,
 * planning margin, 3-stage minimum, strict progressions, steady-state and
 * workload evidence rules, measured-watt authority, fail-closed behavior)
 * are untouched; only acquisition spacing/entry change.
 *
 * NOT a default. With the flag off, the currently staged planner defaults
 * apply unchanged (staged 5 W bootstrap — not the main-branch 25 W rule).
 * Enabled only via `window.__VO2_ACQUISITION_EXPERIMENT__ === true` (see
 * resolveVo2PreflightPolicyOverride). Delete this constant and its two
 * references to remove the experiment. Persisted plans record these values
 * in `adaptive_policy`, so experimental sessions stay auditable.
 */
export const VO2_ACQUISITION_EXPERIMENT_POLICY_OVERRIDE = Object.freeze({
    min_watt_increment: 1,
    min_watt_separation: 1,
    bootstrap_watt_step: 15,
});
function resolvePolicy(overrides) {
    return { ...DEFAULT_VO2_ADAPTIVE_POLICY, ...(overrides !== null && overrides !== void 0 ? overrides : {}) };
}
function isPositiveFinite(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function lastEligible(input) {
    return input.eligible.length > 0 ? input.eligible[input.eligible.length - 1] : undefined;
}
function listCandidates(calibration, policy, used) {
    const out = [];
    for (let r = policy.min_resistance; r <= policy.max_resistance; r++) {
        if (!Number.isInteger(r))
            continue;
        if (used.has(r))
            continue;
        const watts = calibration(r);
        if (!isPositiveFinite(watts))
            continue;
        out.push({ resistance: r, calibratedWatts: watts });
    }
    out.sort((a, b) => a.calibratedWatts - b.calibratedWatts || a.resistance - b.resistance);
    return out;
}
/**
 * Linear HR-vs-calibrated-watts fit in the controllable domain. Estimator
 * watts are never used here; see module header for the domain contract.
 */
function slopeFromEligible(eligible) {
    if (eligible.length < 2)
        return undefined;
    const fit = fitHrVsWatts(eligible.map((point) => ({ watts: point.calibratedWatts, steady_state_bpm: point.steadyHrBpm })));
    if (!fit || !Number.isFinite(fit.slope) || !Number.isFinite(fit.intercept))
        return undefined;
    return { slope: fit.slope, intercept: fit.intercept };
}
/** Effective lower bound: both separation and minimum increment must hold. */
function effectiveMinIncrementWatts(policy) {
    return Math.max(policy.min_watt_increment, policy.min_watt_separation);
}
function cannot(reason_code, termination_reason, input, policy, hard, planning, extra) {
    var _a, _b, _c, _d, _e, _f;
    const last = lastEligible(input);
    const provenance = {
        provenance_version: 1,
        eligible_stage_count: input.eligible.length,
        completed_work_stage_count: input.completedWorkStages,
        retry_count: input.retryCount,
        hard_hr_ceiling_bpm: hard,
        planning_hr_ceiling_bpm: planning,
        planning_margin_bpm: policy.safety_margin_bpm,
        reason_code,
        termination_reason,
    };
    const measured = (_b = (_a = extra === null || extra === void 0 ? void 0 : extra.last_measured_watts) !== null && _a !== void 0 ? _a : last === null || last === void 0 ? void 0 : last.estimatorWatts) !== null && _b !== void 0 ? _b : (_c = input.lastCompleted) === null || _c === void 0 ? void 0 : _c.estimatorWatts;
    const hr = (_e = (_d = extra === null || extra === void 0 ? void 0 : extra.last_steady_hr_bpm) !== null && _d !== void 0 ? _d : last === null || last === void 0 ? void 0 : last.steadyHrBpm) !== null && _e !== void 0 ? _e : (_f = input.lastCompleted) === null || _f === void 0 ? void 0 : _f.steadyHrBpm;
    if (measured != null)
        provenance.last_measured_watts = measured;
    if (hr != null)
        provenance.last_steady_hr_bpm = hr;
    if ((extra === null || extra === void 0 ? void 0 : extra.predicted_hr_bpm) != null)
        provenance.predicted_hr_bpm = extra.predicted_hr_bpm;
    return { decision: "cannot", reason_code, termination_reason, provenance };
}
/**
 * Pure planner: given eligible observations and estimator envelope, decide
 * Complete | NextStage(target) | CannotContinue(reason).
 */
export function planNextVo2Stage(rawInput) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const policy = resolvePolicy(rawInput.policy);
    const input = { ...rawInput, policy };
    const predictedHrMax = input.predictedHrMax;
    if (!Number.isFinite(predictedHrMax) ||
        predictedHrMax < VO2_PREDICTED_HRMAX_MIN ||
        predictedHrMax > VO2_PREDICTED_HRMAX_MAX) {
        return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, Number.NaN, Number.NaN);
    }
    const hard = estimatorSubmaxHrCeilingBpm(predictedHrMax);
    const planning = hard - policy.safety_margin_bpm;
    if (input.eligible.length >= VO2_MIN_ELIGIBLE_STAGES) {
        return {
            decision: "complete",
            reason_code: "sufficient_evidence",
            eligible_count: input.eligible.length,
        };
    }
    if (input.completedWorkStages >= policy.max_work_stages) {
        return cannot("stage_limit_reached", "insufficient_eligible_stages", input, policy, hard, planning);
    }
    const last = lastEligible(input);
    const lastCompleted = input.lastCompleted;
    const minIncrement = effectiveMinIncrementWatts(policy);
    const maxIncrement = policy.max_watt_increment;
    if ((lastCompleted === null || lastCompleted === void 0 ? void 0 : lastCompleted.aboveCeiling) === true) {
        if (input.retryCount >= policy.max_retries_after_above_ceiling) {
            return cannot("retry_limit_reached", "submax_hr_ceiling", input, policy, hard, planning, {
                last_measured_watts: (_a = lastCompleted.estimatorWatts) !== null && _a !== void 0 ? _a : last === null || last === void 0 ? void 0 : last.estimatorWatts,
                last_steady_hr_bpm: (_b = lastCompleted.steadyHrBpm) !== null && _b !== void 0 ? _b : last === null || last === void 0 ? void 0 : last.steadyHrBpm,
            });
        }
        const baseCalibratedWatts = (_c = last === null || last === void 0 ? void 0 : last.calibratedWatts) !== null && _c !== void 0 ? _c : input.warmupCalibratedWatts;
        const failedCalibratedWatts = lastCompleted.calibratedWatts;
        const lowerBoundWatts = baseCalibratedWatts + minIncrement - 1e-9;
        const candidates = listCandidates(input.calibration, policy, input.usedResistances).filter((entry) => entry.calibratedWatts > lowerBoundWatts && entry.calibratedWatts < failedCalibratedWatts - 1e-9);
        const withinMax = candidates.filter((entry) => entry.calibratedWatts <= baseCalibratedWatts + maxIncrement + 1e-9);
        if (candidates.length === 0) {
            return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
                last_measured_watts: last === null || last === void 0 ? void 0 : last.estimatorWatts,
                last_steady_hr_bpm: last === null || last === void 0 ? void 0 : last.steadyHrBpm,
            });
        }
        if (withinMax.length === 0) {
            // A lower retry exists below the failed workload but every option
            // violates the configured maximum increment from the last useful
            // base. Being below the failure does not waive the increment bound.
            return cannot("workload_bounds_exhausted", "insufficient_calibrated_workloads", input, policy, hard, planning);
        }
        if (input.eligible.length >= 2) {
            const line = slopeFromEligible(input.eligible);
            if (!line || !(line.slope > 0)) {
                return cannot("nonpositive_slope", "insufficient_eligible_stages", input, policy, hard, planning);
            }
            const safe = withinMax
                .map((entry) => ({ entry, predicted: line.slope * entry.calibratedWatts + line.intercept }))
                .filter((row) => Number.isFinite(row.predicted) &&
                row.predicted < planning - 1e-9 &&
                row.predicted >= VO2_ESTIMATOR_MIN_HR_BPM - 1e-9)
                .sort((a, b) => b.entry.calibratedWatts - a.entry.calibratedWatts);
            const chosen = safe[0];
            if (!chosen) {
                return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
                    last_measured_watts: last === null || last === void 0 ? void 0 : last.estimatorWatts,
                    last_steady_hr_bpm: last === null || last === void 0 ? void 0 : last.steadyHrBpm,
                });
            }
            const provenance = {
                provenance_version: VO2_ADAPTIVE_PLANNER_VERSION,
                prior_eligible_stage_count: input.eligible.length,
                hard_hr_ceiling_bpm: hard,
                planning_hr_ceiling_bpm: planning,
                planning_margin_bpm: policy.safety_margin_bpm,
                predicted_next_hr_bpm: chosen.predicted,
                selected_target_watts: chosen.entry.calibratedWatts,
                selected_calibrated_watts: chosen.entry.calibratedWatts,
                selected_resistance: chosen.entry.resistance,
                decision: "retry",
                reason_code: "retry_lower_after_above_ceiling",
            };
            if (last) {
                provenance.previous_measured_watts = last.estimatorWatts;
                provenance.previous_steady_hr_bpm = last.steadyHrBpm;
            }
            return {
                decision: "next",
                reason_code: "retry_lower_after_above_ceiling",
                target_watts: chosen.entry.calibratedWatts,
                prescribed_resistance: chosen.entry.resistance,
                calibrated_watts: chosen.entry.calibratedWatts,
                predicted_hr_bpm: chosen.predicted,
                provenance,
            };
        }
        const headroomHr = last === null || last === void 0 ? void 0 : last.steadyHrBpm;
        if (headroomHr == null || headroomHr > planning - policy.fallback_min_headroom_bpm) {
            return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
                last_measured_watts: last === null || last === void 0 ? void 0 : last.estimatorWatts,
                last_steady_hr_bpm: headroomHr !== null && headroomHr !== void 0 ? headroomHr : lastCompleted.steadyHrBpm,
            });
        }
        const targetCalibratedWatts = baseCalibratedWatts + policy.fallback_watt_step;
        const sorted = [...withinMax].sort((a, b) => Math.abs(a.calibratedWatts - targetCalibratedWatts) - Math.abs(b.calibratedWatts - targetCalibratedWatts) ||
            a.calibratedWatts - b.calibratedWatts);
        const chosen = sorted[0];
        const provenance = {
            provenance_version: VO2_ADAPTIVE_PLANNER_VERSION,
            prior_eligible_stage_count: input.eligible.length,
            hard_hr_ceiling_bpm: hard,
            planning_hr_ceiling_bpm: planning,
            planning_margin_bpm: policy.safety_margin_bpm,
            selected_target_watts: targetCalibratedWatts,
            selected_calibrated_watts: chosen.calibratedWatts,
            selected_resistance: chosen.resistance,
            decision: "retry",
            reason_code: "retry_lower_after_above_ceiling",
        };
        if (last) {
            provenance.previous_measured_watts = last.estimatorWatts;
            provenance.previous_steady_hr_bpm = last.steadyHrBpm;
        }
        return {
            decision: "next",
            reason_code: "retry_lower_after_above_ceiling",
            target_watts: targetCalibratedWatts,
            prescribed_resistance: chosen.resistance,
            calibrated_watts: chosen.calibratedWatts,
            provenance,
        };
    }
    if (input.eligible.length >= 2) {
        const line = slopeFromEligible(input.eligible);
        if (!line || !(line.slope > 0)) {
            return cannot("nonpositive_slope", "insufficient_eligible_stages", input, policy, hard, planning);
        }
        const maxSafeCalibratedWatts = (planning - line.intercept) / line.slope;
        const minWattsForFloor = (VO2_ESTIMATOR_MIN_HR_BPM - line.intercept) / line.slope;
        if (!(maxSafeCalibratedWatts > 0) || minWattsForFloor > maxSafeCalibratedWatts) {
            return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
                last_measured_watts: last === null || last === void 0 ? void 0 : last.estimatorWatts,
                last_steady_hr_bpm: last === null || last === void 0 ? void 0 : last.steadyHrBpm,
            });
        }
        const baseCalibratedWatts = (_d = last === null || last === void 0 ? void 0 : last.calibratedWatts) !== null && _d !== void 0 ? _d : input.warmupCalibratedWatts;
        if (maxSafeCalibratedWatts < baseCalibratedWatts + minIncrement - 1e-9) {
            return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
                last_measured_watts: last === null || last === void 0 ? void 0 : last.estimatorWatts,
                last_steady_hr_bpm: last === null || last === void 0 ? void 0 : last.steadyHrBpm,
            });
        }
        let targetCalibratedWatts = Math.min(baseCalibratedWatts + policy.normal_watt_increment, maxSafeCalibratedWatts);
        targetCalibratedWatts = Math.min(targetCalibratedWatts, baseCalibratedWatts + maxIncrement);
        const allAboveBase = listCandidates(input.calibration, policy, input.usedResistances).filter((entry) => entry.calibratedWatts > baseCalibratedWatts + 1e-9);
        if (allAboveBase.length === 0) {
            return cannot("workload_bounds_exhausted", "insufficient_calibrated_workloads", input, policy, hard, planning);
        }
        const withinIncrement = allAboveBase.filter((entry) => entry.calibratedWatts >= baseCalibratedWatts + minIncrement - 1e-9 &&
            entry.calibratedWatts <= baseCalibratedWatts + maxIncrement + 1e-9);
        if (withinIncrement.length === 0) {
            const nearestAbove = allAboveBase[0];
            if (nearestAbove && nearestAbove.calibratedWatts < baseCalibratedWatts + minIncrement - 1e-9) {
                return cannot("insufficient_separation", "insufficient_eligible_stages", input, policy, hard, planning, {
                    last_measured_watts: last === null || last === void 0 ? void 0 : last.estimatorWatts,
                    last_steady_hr_bpm: last === null || last === void 0 ? void 0 : last.steadyHrBpm,
                });
            }
            return cannot("workload_bounds_exhausted", "insufficient_calibrated_workloads", input, policy, hard, planning);
        }
        const safe = withinIncrement
            .map((entry) => ({ entry, predicted: line.slope * entry.calibratedWatts + line.intercept }))
            .filter((row) => Number.isFinite(row.predicted) &&
            row.predicted < planning - 1e-9 &&
            row.predicted >= VO2_ESTIMATOR_MIN_HR_BPM - 1e-9);
        if (safe.length === 0) {
            const anyAbovePlanning = withinIncrement.some((entry) => {
                const predicted = line.slope * entry.calibratedWatts + line.intercept;
                return Number.isFinite(predicted) && predicted >= planning - 1e-9;
            });
            if (anyAbovePlanning) {
                return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
                    last_measured_watts: last === null || last === void 0 ? void 0 : last.estimatorWatts,
                    last_steady_hr_bpm: last === null || last === void 0 ? void 0 : last.steadyHrBpm,
                });
            }
            return cannot("below_floor_no_safe_target", "insufficient_eligible_stages", input, policy, hard, planning);
        }
        safe.sort((a, b) => Math.abs(a.entry.calibratedWatts - targetCalibratedWatts) -
            Math.abs(b.entry.calibratedWatts - targetCalibratedWatts) || a.entry.calibratedWatts - b.entry.calibratedWatts);
        const chosen = safe[0];
        const nearCeiling = planning - chosen.predicted < policy.near_ceiling_threshold_bpm;
        const reason_code = nearCeiling
            ? "reduced_increment_near_ceiling"
            : "safe_increment";
        const provenance = {
            provenance_version: VO2_ADAPTIVE_PLANNER_VERSION,
            prior_eligible_stage_count: input.eligible.length,
            hard_hr_ceiling_bpm: hard,
            planning_hr_ceiling_bpm: planning,
            planning_margin_bpm: policy.safety_margin_bpm,
            predicted_next_hr_bpm: chosen.predicted,
            selected_target_watts: targetCalibratedWatts,
            selected_calibrated_watts: chosen.entry.calibratedWatts,
            selected_resistance: chosen.entry.resistance,
            decision: "next",
            reason_code,
        };
        if (last) {
            provenance.previous_measured_watts = last.estimatorWatts;
            provenance.previous_steady_hr_bpm = last.steadyHrBpm;
        }
        return {
            decision: "next",
            reason_code,
            target_watts: targetCalibratedWatts,
            prescribed_resistance: chosen.entry.resistance,
            calibrated_watts: chosen.entry.calibratedWatts,
            predicted_hr_bpm: chosen.predicted,
            provenance,
        };
    }
    if (input.completedWorkStages === 0) {
        const targetCalibratedWatts = input.warmupCalibratedWatts + policy.bootstrap_watt_step;
        const aboveBase = listCandidates(input.calibration, policy, input.usedResistances).filter((entry) => entry.calibratedWatts > input.warmupCalibratedWatts + 1e-9);
        if (aboveBase.length === 0) {
            return cannot("workload_bounds_exhausted", "insufficient_calibrated_workloads", input, policy, hard, planning);
        }
        const withinIncrement = aboveBase.filter((entry) => entry.calibratedWatts >= input.warmupCalibratedWatts + minIncrement - 1e-9 &&
            entry.calibratedWatts <= input.warmupCalibratedWatts + maxIncrement + 1e-9);
        if (withinIncrement.length === 0) {
            const nearestAbove = aboveBase[0];
            if (nearestAbove && nearestAbove.calibratedWatts < input.warmupCalibratedWatts + minIncrement - 1e-9) {
                return cannot("insufficient_separation", "insufficient_eligible_stages", input, policy, hard, planning);
            }
            return cannot("workload_bounds_exhausted", "insufficient_calibrated_workloads", input, policy, hard, planning);
        }
        const sorted = [...withinIncrement].sort((a, b) => Math.abs(a.calibratedWatts - targetCalibratedWatts) - Math.abs(b.calibratedWatts - targetCalibratedWatts) ||
            a.calibratedWatts - b.calibratedWatts);
        const chosen = sorted[0];
        const provenance = {
            provenance_version: VO2_ADAPTIVE_PLANNER_VERSION,
            prior_eligible_stage_count: 0,
            hard_hr_ceiling_bpm: hard,
            planning_hr_ceiling_bpm: planning,
            planning_margin_bpm: policy.safety_margin_bpm,
            selected_target_watts: targetCalibratedWatts,
            selected_calibrated_watts: chosen.calibratedWatts,
            selected_resistance: chosen.resistance,
            decision: "next",
            reason_code: "bootstrap_first_stage",
        };
        return {
            decision: "next",
            reason_code: "bootstrap_first_stage",
            target_watts: targetCalibratedWatts,
            prescribed_resistance: chosen.resistance,
            calibrated_watts: chosen.calibratedWatts,
            provenance,
        };
    }
    const baseCalibratedWatts = (_f = (_e = last === null || last === void 0 ? void 0 : last.calibratedWatts) !== null && _e !== void 0 ? _e : lastCompleted === null || lastCompleted === void 0 ? void 0 : lastCompleted.calibratedWatts) !== null && _f !== void 0 ? _f : input.warmupCalibratedWatts;
    const headroomHr = (_g = last === null || last === void 0 ? void 0 : last.steadyHrBpm) !== null && _g !== void 0 ? _g : lastCompleted === null || lastCompleted === void 0 ? void 0 : lastCompleted.steadyHrBpm;
    if (headroomHr != null && headroomHr > planning - policy.fallback_min_headroom_bpm) {
        return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
            last_measured_watts: (_h = last === null || last === void 0 ? void 0 : last.estimatorWatts) !== null && _h !== void 0 ? _h : lastCompleted === null || lastCompleted === void 0 ? void 0 : lastCompleted.estimatorWatts,
            last_steady_hr_bpm: headroomHr,
        });
    }
    // Runway preservation. With one eligible point the athlete is inside the
    // eligible HR band, but the slope is unknown, so any step spends band
    // headroom at an unknown rate. While this stage is not the last eligible
    // stage still required, take the smallest distinguishable step: the
    // ladder only ascends, so a larger step would discard calibrated levels
    // the remaining required stages may need. Without an in-band anchor
    // (below-floor or otherwise ineligible history) keep the fallback step.
    const eligibleStillNeededAfterThis = VO2_MIN_ELIGIBLE_STAGES - input.eligible.length - 1;
    const preserveRunway = last != null && eligibleStillNeededAfterThis >= 1;
    const targetCalibratedWatts = baseCalibratedWatts + (preserveRunway ? minIncrement : policy.fallback_watt_step);
    const aboveBase = listCandidates(input.calibration, policy, input.usedResistances).filter((entry) => entry.calibratedWatts > baseCalibratedWatts + 1e-9);
    if (aboveBase.length === 0) {
        return cannot("workload_bounds_exhausted", "insufficient_calibrated_workloads", input, policy, hard, planning);
    }
    const withinIncrement = aboveBase.filter((entry) => entry.calibratedWatts >= baseCalibratedWatts + minIncrement - 1e-9 &&
        entry.calibratedWatts <= baseCalibratedWatts + maxIncrement + 1e-9);
    if (withinIncrement.length === 0) {
        const nearestAbove = aboveBase[0];
        if (nearestAbove && nearestAbove.calibratedWatts < baseCalibratedWatts + minIncrement - 1e-9) {
            return cannot("insufficient_separation", "insufficient_eligible_stages", input, policy, hard, planning, {
                last_measured_watts: (_j = last === null || last === void 0 ? void 0 : last.estimatorWatts) !== null && _j !== void 0 ? _j : lastCompleted === null || lastCompleted === void 0 ? void 0 : lastCompleted.estimatorWatts,
                last_steady_hr_bpm: headroomHr,
            });
        }
        return cannot("workload_bounds_exhausted", "insufficient_calibrated_workloads", input, policy, hard, planning);
    }
    const sorted = [...withinIncrement].sort((a, b) => Math.abs(a.calibratedWatts - targetCalibratedWatts) - Math.abs(b.calibratedWatts - targetCalibratedWatts) ||
        a.calibratedWatts - b.calibratedWatts);
    const chosen = sorted[0];
    const provenance = {
        provenance_version: VO2_ADAPTIVE_PLANNER_VERSION,
        prior_eligible_stage_count: input.eligible.length,
        hard_hr_ceiling_bpm: hard,
        planning_hr_ceiling_bpm: planning,
        planning_margin_bpm: policy.safety_margin_bpm,
        selected_target_watts: targetCalibratedWatts,
        selected_calibrated_watts: chosen.calibratedWatts,
        selected_resistance: chosen.resistance,
        decision: "next",
        reason_code: "conservative_step_insufficient_evidence",
    };
    if (last) {
        provenance.previous_measured_watts = last.estimatorWatts;
        provenance.previous_steady_hr_bpm = last.steadyHrBpm;
    }
    else if ((lastCompleted === null || lastCompleted === void 0 ? void 0 : lastCompleted.steadyHrBpm) != null) {
        provenance.previous_steady_hr_bpm = lastCompleted.steadyHrBpm;
        if (lastCompleted.estimatorWatts != null) {
            provenance.previous_measured_watts = lastCompleted.estimatorWatts;
        }
    }
    return {
        decision: "next",
        reason_code: "conservative_step_insufficient_evidence",
        target_watts: targetCalibratedWatts,
        prescribed_resistance: chosen.resistance,
        calibrated_watts: chosen.calibratedWatts,
        provenance,
    };
}
/**
 * Validate an adaptive policy, including cross-field increment coherence
 * and the advertised duration bound. Rejects policies that could exceed
 * 30 minutes or prescribe incoherent increments.
 */
export function isValidVo2AdaptivePolicy(value) {
    if (!value || typeof value !== "object")
        return false;
    const policy = value;
    if (policy.policy_version !== 1)
        return false;
    const numbers = [
        [policy.safety_margin_bpm, 0, 30],
        [policy.min_watt_separation, 1, 50],
        [policy.normal_watt_increment, 1, 100],
        [policy.max_watt_increment, 1, 100],
        [policy.min_watt_increment, 1, 50],
        [policy.bootstrap_watt_step, 1, 100],
        [policy.fallback_watt_step, 1, 100],
        [policy.fallback_min_headroom_bpm, 0, 40],
        [policy.near_ceiling_threshold_bpm, 0, 40],
    ];
    for (const [entry, lo, hi] of numbers) {
        if (typeof entry !== "number" || !Number.isFinite(entry) || entry < lo || entry > hi)
            return false;
    }
    if (!Number.isInteger(policy.max_work_stages) ||
        policy.max_work_stages < 1 ||
        policy.max_work_stages > VO2_ADAPTIVE_MAX_WORK_STAGES) {
        return false;
    }
    if (VO2_WARMUP_DURATION_SEC + policy.max_work_stages * VO2_MAX_STAGE_DURATION_SEC + VO2_COOLDOWN_DURATION_SEC >
        VO2_ADAPTIVE_ADVERTISED_MAX_TOTAL_DURATION_SEC) {
        return false;
    }
    if (!Number.isInteger(policy.max_retries_after_above_ceiling) ||
        policy.max_retries_after_above_ceiling < 0 ||
        policy.max_retries_after_above_ceiling > 3) {
        return false;
    }
    if (!Number.isInteger(policy.min_resistance) ||
        !Number.isInteger(policy.max_resistance) ||
        policy.min_resistance < AUTOMATIC_RESISTANCE_MIN ||
        policy.max_resistance > VO2_PROTOCOL_MAX_RESISTANCE ||
        policy.min_resistance > policy.max_resistance) {
        return false;
    }
    // Increment coherence: minimum <= normal <= maximum; separation and
    // bootstrap/fallback steps must fit inside the same controllable bounds.
    if (policy.min_watt_increment > policy.normal_watt_increment)
        return false;
    if (policy.normal_watt_increment > policy.max_watt_increment)
        return false;
    if (policy.min_watt_separation > policy.max_watt_increment)
        return false;
    if (policy.bootstrap_watt_step < policy.min_watt_increment)
        return false;
    if (policy.bootstrap_watt_step > policy.max_watt_increment)
        return false;
    if (policy.fallback_watt_step < policy.min_watt_increment)
        return false;
    if (policy.fallback_watt_step > policy.max_watt_increment)
        return false;
    return true;
}
/** Maximum end-to-end seconds allowed under a policy (warmup + work + cooldown). */
export function vo2AdaptiveMaxTotalDurationSec(policy) {
    return VO2_WARMUP_DURATION_SEC + policy.max_work_stages * VO2_MAX_STAGE_DURATION_SEC + VO2_COOLDOWN_DURATION_SEC;
}
