/**
 * Adaptive VO2 bike protocol v3 (explicit opt-in; default writer stays v2).
 *
 * Control objective: collect at least the estimator-required number of
 * estimator-eligible, steady-state, submaximal workload/HR observations
 * while respecting the estimator validity envelope. After each completed
 * stage, the pure planner (vo2AdaptivePlanner) decides Complete | Next |
 * CannotContinue. Fixed v1/v2 workload ladders are preserved untouched.
 *
 * Reuses v2 timing, steady-state HR, workload summarization, and estimator
 * classification verbatim (same constants/functions); only workload
 * selection and termination provenance are adaptive.
 */
import {
  VO2_PROTOCOL_ID,
  VO2_PROTOCOL_VERSION_V3,
  type AdaptiveVo2ProtocolEvidence,
  type CurrentVo2ProtocolEvidence,
  type Vo2AdaptiveStageProvenance,
  type Vo2AdaptiveTerminationProvenance,
  type Vo2ProtocolStageEvidence,
  type Vo2ProtocolStageHrEvidence,
  type Vo2ProtocolStageStatus,
  type Vo2ProtocolStageWorkloadEvidence,
  type Vo2ProtocolTerminationReasonV3,
  type WorkoutMetadata,
  type WorkoutPhaseState,
  type PlanBlock,
} from "./types.js";
import {
  VO2_CALIBRATION_MACHINE_ID,
  VO2_COOLDOWN_DURATION_SEC,
  VO2_EVAL_RELATIVE_SECONDS,
  VO2_HR_FRESHNESS_MS,
  VO2_MAX_EXTENSION_MINUTES,
  VO2_MAX_STAGE_DURATION_SEC,
  VO2_NOMINAL_STAGE_DURATION_SEC,
  VO2_PRESCRIBED_CADENCE_RPM,
  VO2_PROTOCOL_MAX_RESISTANCE,
  VO2_TARGET_WORK_STAGES,
  VO2_UPCOMING_RESISTANCE_LEAD_SEC,
  VO2_WARMUP_DURATION_SEC,
  VO2_WORKOUT_INTENT,
  VO2_WORKOUT_LABEL,
  VO2_WORKOUT_SELECTOR_ID,
  advanceVo2Protocol,
  buildVo2ProtocolEvidence,
  evaluateStageHr,
  getVo2ProtocolPhase,
  isValidStageWorkload,
  isValidVo2ResolvedWorkload,
  listCalibrated70RpmWorkloads,
  vo2ProtocolHoldForPhase,
  vo2ProtocolNeedsHrEvaluation,
  vo2ProtocolUiTargets,
  type Vo2ProtocolRuntime,
  type Vo2ResolvedWorkload,
  type Vo2WattsLookup,
} from "./vo2Protocol.js";
import { AUTOMATIC_RESISTANCE_MIN } from "./machines/proformSmartPower10.js";
import { getEstimatedWattsAt70Rpm } from "./machines/proformSmartPower10.js";
import type { MachineId } from "./machines/trace.js";
import { getMachineDefinition } from "./machines/registry.js";
import { getSelectedMachineId } from "./machines/selection.js";
import { readExplicitVo2ProfileInputs } from "./profile.js";
import { summarizeVo2StageWorkload, type BikeTelemetrySample } from "./vo2Workload.js";
import {
  VO2_AGE_YEARS_MAX,
  VO2_AGE_YEARS_MIN,
  VO2_WEIGHT_KG_MAX,
  VO2_WEIGHT_KG_MIN,
  classifyVo2ProtocolStage,
  estimatorSubmaxHrCeilingBpm,
  predictedHrMaxBpm,
  type Vo2ProfileInputs,
} from "./vo2Estimator.js";
import {
  DEFAULT_VO2_ADAPTIVE_POLICY,
  VO2_ACQUISITION_EXPERIMENT_POLICY_OVERRIDE,
  VO2_ADAPTIVE_ADVERTISED_MAX_TOTAL_DURATION_SEC,
  isValidVo2AdaptivePolicy,
  planNextVo2Stage,
  vo2AdaptiveMaxTotalDurationSec,
  type Vo2AdaptivePolicy,
  type Vo2EligibleObservation,
} from "./vo2AdaptivePlanner.js";

export const VO2_PROTOCOL_V3_ID = VO2_PROTOCOL_ID;
export const VO2_PROTOCOL_V3_VERSION = VO2_PROTOCOL_VERSION_V3;

const VO2_V3_TERMINATION_REASONS: readonly Vo2ProtocolTerminationReasonV3[] = [
  "protocol_complete",
  "submax_hr_ceiling",
  "insufficient_eligible_stages",
  "early_cooldown",
  "limit_reached",
  "user_cancelled",
  "hr_lost",
  "insufficient_calibrated_workloads",
  "other",
];

export interface Vo2ProtocolPlanV3 {
  protocol_id: typeof VO2_PROTOCOL_ID;
  protocol_version: typeof VO2_PROTOCOL_VERSION_V3;
  prescribed_cadence_rpm: typeof VO2_PRESCRIBED_CADENCE_RPM;
  warmup_resistance: number;
  warmup_calibrated_watts_at_70rpm: number;
  warmup_duration_sec: number;
  cooldown_duration_sec: number;
  /** Adaptively appended as the planner decides; starts empty. */
  workloads: Vo2ResolvedWorkload[];
  adaptive_policy: Vo2AdaptivePolicy;
}

export interface Vo2ProtocolStageRuntimeV3 {
  stage_id: string;
  workloadIndex: number;
  active_start_sec: number;
  active_end_sec: number | null;
  extensions: number;
  status: Vo2ProtocolStageStatus | "open";
  last_eval_relative_sec: number;
  hr?: Vo2ProtocolStageHrEvidence;
  workload?: Vo2ProtocolStageWorkloadEvidence;
  upcoming_announced: boolean;
  extension_announced: boolean;
  adaptive?: Vo2AdaptiveStageProvenance;
}

export interface Vo2ProtocolRuntimeV3 {
  plan: Vo2ProtocolPlanV3;
  segment: "warmup" | "work" | "cooldown" | "complete";
  stages: Vo2ProtocolStageRuntimeV3[];
  cooldown_start_sec: number | null;
  termination?: { reason: Vo2ProtocolTerminationReasonV3 };
  start_announced: boolean;
  upcoming_warmup_announced: boolean;
  assessment_profile: Required<Vo2ProfileInputs>;
  retry_count_after_above_ceiling: number;
  adaptive_termination?: Vo2AdaptiveTerminationProvenance;
  /**
   * Sticky: fresh live HR was observed during a work segment, so the live
   * hard-ceiling guard was armed. Evidence availability derives from this.
   */
  live_hr_guard_armed?: boolean;
}

export function vo2PlanBlocksV3(policy: Vo2AdaptivePolicy = DEFAULT_VO2_ADAPTIVE_POLICY): PlanBlock {
  return {
    warm: VO2_WARMUP_DURATION_SEC / 60,
    sustain: (policy.max_work_stages * VO2_MAX_STAGE_DURATION_SEC) / 60,
    cool: VO2_COOLDOWN_DURATION_SEC / 60,
  };
}

/** Maximum end-to-end seconds allowed under a v3 policy (warmup + work + cooldown). */
export function vo2V3MaxTotalDurationSec(policy: Vo2AdaptivePolicy = DEFAULT_VO2_ADAPTIVE_POLICY): number {
  return vo2AdaptiveMaxTotalDurationSec(policy);
}

export { VO2_ADAPTIVE_ADVERTISED_MAX_TOTAL_DURATION_SEC };

export function vo2WorkoutMetadataV3(): WorkoutMetadata {
  return { type: VO2_WORKOUT_LABEL, intent: VO2_WORKOUT_INTENT, activities: ["bike"] };
}

export { VO2_WORKOUT_SELECTOR_ID };

export function buildVo2ProtocolPlanV3(
  getWatts: Vo2WattsLookup = getEstimatedWattsAt70Rpm,
  policy: Partial<Vo2AdaptivePolicy> = {}
): Vo2ProtocolPlanV3 | undefined {
  const calibrated = listCalibrated70RpmWorkloads(getWatts);
  if (calibrated.length === 0) return undefined;
  const easiest = calibrated[0];
  const increasingAboveWarmup = calibrated.filter(
    (entry) => entry.calibrated_watts_at_70rpm > easiest.calibrated_watts_at_70rpm
  );
  if (increasingAboveWarmup.length < VO2_TARGET_WORK_STAGES) return undefined;
  const adaptive_policy = { ...DEFAULT_VO2_ADAPTIVE_POLICY, ...policy };
  if (!isValidVo2AdaptivePolicy(adaptive_policy)) return undefined;
  return {
    protocol_id: VO2_PROTOCOL_ID,
    protocol_version: VO2_PROTOCOL_VERSION_V3,
    prescribed_cadence_rpm: VO2_PRESCRIBED_CADENCE_RPM,
    warmup_resistance: easiest.prescribed_resistance,
    warmup_calibrated_watts_at_70rpm: easiest.calibrated_watts_at_70rpm,
    warmup_duration_sec: VO2_WARMUP_DURATION_SEC,
    cooldown_duration_sec: VO2_COOLDOWN_DURATION_SEC,
    workloads: [],
    adaptive_policy,
  };
}

export function createVo2ProtocolRuntimeV3(
  plan: Vo2ProtocolPlanV3,
  assessmentProfile: Required<Vo2ProfileInputs>
): Vo2ProtocolRuntimeV3 {
  if (
    !Number.isFinite(assessmentProfile?.age_years) ||
    assessmentProfile.age_years < VO2_AGE_YEARS_MIN ||
    assessmentProfile.age_years > VO2_AGE_YEARS_MAX ||
    !Number.isFinite(assessmentProfile?.weight_kg) ||
    assessmentProfile.weight_kg < VO2_WEIGHT_KG_MIN ||
    assessmentProfile.weight_kg > VO2_WEIGHT_KG_MAX
  ) {
    throw new Error("Protocol v3 requires valid frozen age and body weight");
  }
  return {
    plan: JSON.parse(JSON.stringify(plan)) as Vo2ProtocolPlanV3,
    segment: "warmup",
    stages: [],
    cooldown_start_sec: null,
    start_announced: false,
    upcoming_warmup_announced: false,
    assessment_profile: { ...assessmentProfile },
    retry_count_after_above_ceiling: 0,
  };
}

export type Vo2PreflightV3Ok = {
  ok: true;
  plan: Vo2ProtocolPlanV3;
  assessmentProfile: Required<Vo2ProfileInputs>;
};
export type Vo2PreflightV3Fail = { ok: false; reason: string; message: string };
export type Vo2PreflightV3Result = Vo2PreflightV3Ok | Vo2PreflightV3Fail;

export function evaluateVo2PreflightV3(input: {
  hrDeviceConnected: boolean;
  liveBpm: number | null | undefined;
  lastBpmUpdateTime: number | null | undefined;
  now?: number;
  activityMachineId?: MachineId;
  getWatts?: Vo2WattsLookup;
  profile?: Vo2ProfileInputs;
  policy?: Partial<Vo2AdaptivePolicy>;
}): Vo2PreflightV3Result {
  const now = input.now ?? Date.now();
  const hrFresh =
    input.hrDeviceConnected &&
    input.liveBpm != null &&
    input.liveBpm > 0 &&
    input.lastBpmUpdateTime != null &&
    now - input.lastBpmUpdateTime <= VO2_HR_FRESHNESS_MS;
  if (!hrFresh) {
    return { ok: false, reason: "hr_required", message: "Heart-rate strap required" };
  }
  const machineId = input.activityMachineId;
  if (!machineId) {
    return { ok: false, reason: "no_machine", message: "No calibrated 70 RPM bike profile selected" };
  }
  const machine = getMachineDefinition(machineId);
  if (!machine || machine.activity !== "bike" || machine.id !== VO2_CALIBRATION_MACHINE_ID) {
    return { ok: false, reason: "no_machine", message: "No calibrated 70 RPM bike profile selected" };
  }
  const age = input.profile?.age_years;
  const weight = input.profile?.weight_kg;
  if (!(typeof age === "number" && Number.isFinite(age) && age >= VO2_AGE_YEARS_MIN && age <= VO2_AGE_YEARS_MAX)) {
    return { ok: false, reason: "profile_required", message: "Add a valid age in Settings → Profile before starting the test" };
  }
  if (!(typeof weight === "number" && Number.isFinite(weight) && weight >= VO2_WEIGHT_KG_MIN && weight <= VO2_WEIGHT_KG_MAX)) {
    return { ok: false, reason: "profile_required", message: "Add a valid body weight in Settings → Profile before starting the test" };
  }
  const plan = buildVo2ProtocolPlanV3(input.getWatts, input.policy);
  if (!plan) {
    return { ok: false, reason: "insufficient_workloads", message: "Not enough calibrated workload levels for this test" };
  }
  return { ok: true, plan, assessmentProfile: { age_years: age, weight_kg: weight } };
}

/**
 * TEMPORARY developer-only experiment flag. Set
 * `window.__VO2_ACQUISITION_EXPERIMENT__ = true` in the dev console before
 * starting the VO2 test to run one session under
 * VO2_ACQUISITION_EXPERIMENT_POLICY_OVERRIDE. Absent or any other value:
 * the currently staged defaults apply unchanged. Delete with the override
 * constant.
 */
export const VO2_ACQUISITION_EXPERIMENT_FLAG = "__VO2_ACQUISITION_EXPERIMENT__" as const;

export function isVo2AcquisitionExperimentEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return (window as unknown as Record<string, unknown>)[VO2_ACQUISITION_EXPERIMENT_FLAG] === true;
}

/**
 * TEMPORARY experiment seam. Returns the experimental policy override only
 * when the developer flag is explicitly enabled; otherwise undefined, which
 * preserves production defaults exactly.
 */
export function resolveVo2PreflightPolicyOverride(): Partial<Vo2AdaptivePolicy> | undefined {
  return isVo2AcquisitionExperimentEnabled()
    ? { ...VO2_ACQUISITION_EXPERIMENT_POLICY_OVERRIDE }
    : undefined;
}

export function evaluateVo2PreflightV3ForUi(
  now = Date.now(),
  policy?: Partial<Vo2AdaptivePolicy>
): Vo2PreflightV3Result {
  return evaluateVo2PreflightV3({
    hrDeviceConnected: Boolean((window as unknown as Record<string, unknown>).hrDeviceName),
    liveBpm: (window as unknown as Record<string, unknown>).liveBpm as number | null,
    lastBpmUpdateTime: (window as unknown as Record<string, unknown>).lastBpmUpdateTime as number | null,
    now,
    activityMachineId: getSelectedMachineId("bike"),
    profile: readExplicitVo2ProfileInputs(),
    policy,
  });
}

function cloneRuntimeV3(runtime: Vo2ProtocolRuntimeV3): Vo2ProtocolRuntimeV3 {
  return JSON.parse(JSON.stringify(runtime)) as Vo2ProtocolRuntimeV3;
}

function openStageV3(runtime: Vo2ProtocolRuntimeV3): Vo2ProtocolStageRuntimeV3 | undefined {
  return runtime.stages.find((stage) => stage.status === "open");
}

function enterCooldownV3(
  runtime: Vo2ProtocolRuntimeV3,
  elapsedSec: number,
  reason: Vo2ProtocolTerminationReasonV3,
  adaptiveTermination?: Vo2AdaptiveTerminationProvenance
): void {
  const open = openStageV3(runtime);
  if (open && open.active_end_sec == null) {
    open.active_end_sec = Math.max(open.active_start_sec, elapsedSec);
    if (open.status === "open") open.status = "incomplete";
  }
  runtime.segment = "cooldown";
  runtime.cooldown_start_sec = elapsedSec;
  if (!runtime.termination) runtime.termination = { reason };
  if (adaptiveTermination && !runtime.adaptive_termination) {
    runtime.adaptive_termination = adaptiveTermination;
  }
}

function evidenceForRuntimeStageV3(
  runtime: Vo2ProtocolRuntimeV3,
  stage: Vo2ProtocolStageRuntimeV3
): Vo2ProtocolStageEvidence | undefined {
  const workload = runtime.plan.workloads[stage.workloadIndex];
  if (!workload) return undefined;
  const end = stage.active_end_sec ?? stage.active_start_sec;
  const evidence: Vo2ProtocolStageEvidence = {
    stage_id: stage.stage_id,
    active_start_sec: stage.active_start_sec,
    active_end_sec: end,
    requested_watts: workload.requested_watts,
    prescribed_resistance: workload.prescribed_resistance,
    calibrated_watts_at_70rpm: workload.calibrated_watts_at_70rpm,
    status: stage.status === "open" ? "incomplete" : stage.status,
    nominal_duration_sec: VO2_NOMINAL_STAGE_DURATION_SEC,
    actual_duration_sec: Math.max(0, end - stage.active_start_sec),
  };
  if (stage.hr) evidence.hr = stage.hr;
  if (stage.workload) evidence.workload = stage.workload;
  if (stage.adaptive) evidence.adaptive = stage.adaptive;
  return evidence;
}

function runtimePredictedHrMaxV3(runtime: Vo2ProtocolRuntimeV3): number | undefined {
  const age = runtime.assessment_profile?.age_years;
  if (!(typeof age === "number" && Number.isFinite(age) && age >= VO2_AGE_YEARS_MIN && age <= VO2_AGE_YEARS_MAX)) {
    return undefined;
  }
  return predictedHrMaxBpm(age);
}

function eligibleObservationsV3(runtime: Vo2ProtocolRuntimeV3): Vo2EligibleObservation[] {
  const predictedHrMax = runtimePredictedHrMaxV3(runtime);
  const out: Vo2EligibleObservation[] = [];
  for (const stage of runtime.stages) {
    const evidence = evidenceForRuntimeStageV3(runtime, stage);
    if (!evidence) continue;
    const point = classifyVo2ProtocolStage(evidence, predictedHrMax, stage.workloadIndex + 1);
    if (!point.estimator_eligible) continue;
    if (point.watts == null || point.steady_state_bpm == null) continue;
    out.push({
      estimatorWatts: point.watts,
      steadyHrBpm: point.steady_state_bpm,
      calibratedWatts: evidence.calibrated_watts_at_70rpm,
      resistance: evidence.prescribed_resistance,
    });
  }
  return out;
}

function lastCompletedInfoV3(runtime: Vo2ProtocolRuntimeV3): {
  calibratedWatts: number;
  estimatorWatts?: number;
  steadyHrBpm?: number;
  resistance: number;
  aboveCeiling: boolean;
  eligible: boolean;
} | undefined {
  const completed = [...runtime.stages].reverse().find((stage) => stage.status !== "open");
  if (!completed) return undefined;
  const evidence = evidenceForRuntimeStageV3(runtime, completed);
  if (!evidence) return undefined;
  const point = classifyVo2ProtocolStage(
    evidence,
    runtimePredictedHrMaxV3(runtime),
    completed.workloadIndex + 1
  );
  return {
    calibratedWatts: evidence.calibrated_watts_at_70rpm,
    estimatorWatts: point.watts,
    steadyHrBpm: point.steady_state_bpm,
    resistance: evidence.prescribed_resistance,
    aboveCeiling: point.ineligibility_reasons.includes("hr_above_submax_ceiling"),
    eligible: point.estimator_eligible,
  };
}

function usedResistancesV3(runtime: Vo2ProtocolRuntimeV3): Set<number> {
  const used = new Set<number>([runtime.plan.warmup_resistance]);
  for (const workload of runtime.plan.workloads) used.add(workload.prescribed_resistance);
  return used;
}

function workloadAtStageCloseV3(
  runtime: Vo2ProtocolRuntimeV3,
  stage: Vo2ProtocolStageRuntimeV3,
  elapsedSec: number,
  telemetrySamples: readonly BikeTelemetrySample[]
): Vo2ProtocolStageWorkloadEvidence | undefined {
  const planned = runtime.plan.workloads[stage.workloadIndex];
  if (!planned) return undefined;
  return summarizeVo2StageWorkload(
    {
      active_start_sec: stage.active_start_sec,
      active_end_sec: Math.max(stage.active_start_sec, elapsedSec),
      calibrated_watts_at_70rpm: planned.calibrated_watts_at_70rpm,
    },
    telemetrySamples,
    runtime.plan.prescribed_cadence_rpm
  );
}

function evalAtRelativeV3(relative: number): number {
  if (relative >= VO2_MAX_STAGE_DURATION_SEC) return VO2_MAX_STAGE_DURATION_SEC;
  if (relative >= 240) return 240;
  if (relative >= VO2_NOMINAL_STAGE_DURATION_SEC) return VO2_NOMINAL_STAGE_DURATION_SEC;
  return 0;
}

export function vo2ProtocolV3NeedsHrEvaluation(
  runtime: Vo2ProtocolRuntimeV3 | null | undefined,
  elapsedSec: number,
  paused: boolean
): boolean {
  if (!runtime || paused || runtime.segment !== "work") return false;
  const open = openStageV3(runtime);
  if (!open) return false;
  const relative = Math.max(0, Math.floor(elapsedSec) - open.active_start_sec);
  const evalAt = evalAtRelativeV3(relative);
  return evalAt > 0 && evalAt > open.last_eval_relative_sec;
}

function startNextStageV3(
  runtime: Vo2ProtocolRuntimeV3,
  elapsedSec: number,
  getWatts: Vo2WattsLookup
): { started: boolean; termination?: Vo2ProtocolTerminationReasonV3 } {
  const predictedHrMax = runtimePredictedHrMaxV3(runtime);
  if (predictedHrMax == null) {
    return { started: false, termination: "other" };
  }
  const decision = planNextVo2Stage({
    eligible: eligibleObservationsV3(runtime),
    predictedHrMax,
    warmupCalibratedWatts: runtime.plan.warmup_calibrated_watts_at_70rpm,
    warmupResistance: runtime.plan.warmup_resistance,
    lastCompleted: lastCompletedInfoV3(runtime),
    usedResistances: usedResistancesV3(runtime),
    calibration: getWatts,
    completedWorkStages: runtime.stages.length,
    retryCount: runtime.retry_count_after_above_ceiling,
    policy: runtime.plan.adaptive_policy,
  });
  if (decision.decision === "complete") {
    return { started: false, termination: "protocol_complete" };
  }
  if (decision.decision === "cannot") {
    runtime.adaptive_termination = decision.provenance;
    return { started: false, termination: decision.termination_reason };
  }
  const workloadIndex = runtime.plan.workloads.length;
  runtime.plan.workloads.push({
    requested_watts: decision.target_watts,
    prescribed_resistance: decision.prescribed_resistance,
    calibrated_watts_at_70rpm: decision.calibrated_watts,
  });
  if (decision.provenance.decision === "retry") {
    runtime.retry_count_after_above_ceiling += 1;
  }
  runtime.segment = "work";
  runtime.stages.push({
    stage_id: `vo2-stage:${runtime.stages.length + 1}`,
    workloadIndex,
    active_start_sec: elapsedSec,
    active_end_sec: null,
    extensions: 0,
    status: "open",
    last_eval_relative_sec: 0,
    upcoming_announced: false,
    extension_announced: false,
    adaptive: decision.provenance,
  });
  return { started: true };
}

function closeOpenStageV3(
  runtime: Vo2ProtocolRuntimeV3,
  elapsedSec: number,
  status: Vo2ProtocolStageStatus,
  hr?: Vo2ProtocolStageHrEvidence,
  workload?: Vo2ProtocolStageWorkloadEvidence
): void {
  const open = openStageV3(runtime);
  if (!open) return;
  open.active_end_sec = Math.max(open.active_start_sec, elapsedSec);
  open.status = status;
  if (hr) open.hr = hr;
  if (workload) open.workload = workload;
}

export interface AdvanceVo2ProtocolV3Input {
  elapsedSec: number;
  paused: boolean;
  samples: readonly { timestamp_sec: number; hr: number }[];
  telemetrySamples?: readonly BikeTelemetrySample[];
  earlyCooldownElapsed?: number | null;
  cancelled?: boolean;
  limitReached?: boolean;
  getWatts?: Vo2WattsLookup;
  /**
   * Fresh live-HR spot reading (bpm) when the caller has a trustworthy one;
   * null/omitted when unknown, stale, or invalid. V3 work stages arm the
   * live hard-ceiling guard from this and stop promptly on a breach.
   * Paused ticks and non-work segments ignore it.
   */
  liveHrBpm?: number | null;
}

export function advanceVo2ProtocolV3(
  runtime: Vo2ProtocolRuntimeV3,
  input: AdvanceVo2ProtocolV3Input
): Vo2ProtocolRuntimeV3 {
  const next = cloneRuntimeV3(runtime);
  const elapsed = Math.max(0, Math.floor(input.elapsedSec));
  const getWatts = input.getWatts ?? getEstimatedWattsAt70Rpm;
  if (!input.paused && !next.start_announced) next.start_announced = true;
  if (
    next.segment === "warmup" &&
    elapsed >= Math.max(0, next.plan.warmup_duration_sec - VO2_UPCOMING_RESISTANCE_LEAD_SEC)
  ) {
    next.upcoming_warmup_announced = true;
  }
  if (input.cancelled) {
    if (next.segment !== "complete") {
      const open = openStageV3(next);
      if (open && open.active_end_sec == null) {
        open.active_end_sec = Math.max(open.active_start_sec, elapsed);
        if (open.status === "open") open.status = "incomplete";
      }
      if (!next.termination) next.termination = { reason: "user_cancelled" };
      if (next.segment === "warmup" || next.segment === "work") {
        next.segment = "complete";
      }
    }
    return next;
  }
  if (input.limitReached && next.segment !== "cooldown" && next.segment !== "complete") {
    enterCooldownV3(next, elapsed, "limit_reached");
    return next;
  }
  if (
    input.earlyCooldownElapsed != null &&
    Number.isFinite(input.earlyCooldownElapsed) &&
    next.segment !== "cooldown" &&
    next.segment !== "complete"
  ) {
    enterCooldownV3(next, Math.floor(input.earlyCooldownElapsed), "early_cooldown");
    return next;
  }
  if (next.segment === "complete" || input.paused) return next;

  // Live hard-ceiling guard (v3 work stages only): a trustworthy fresh spot
  // reading at/above the estimator's own hard ceiling stops the test now
  // instead of waiting for the next 180/240/300s checkpoint. Runs after the
  // explicit cancel/limit/early-cooldown intents above, so those keep their
  // own termination reasons. Engages once the work segment is established.
  if (input.liveHrBpm != null && next.segment === "work") {
    next.live_hr_guard_armed = true;
    const breachHrMax = runtimePredictedHrMaxV3(next);
    if (breachHrMax != null && input.liveHrBpm >= estimatorSubmaxHrCeilingBpm(breachHrMax)) {
      const hard = estimatorSubmaxHrCeilingBpm(breachHrMax);
      enterCooldownV3(next, elapsed, "submax_hr_ceiling", {
        provenance_version: 1,
        eligible_stage_count: eligibleObservationsV3(next).length,
        completed_work_stage_count: next.stages.filter((stage) => stage.status !== "open").length,
        retry_count: next.retry_count_after_above_ceiling,
        hard_hr_ceiling_bpm: hard,
        planning_hr_ceiling_bpm: hard - next.plan.adaptive_policy.safety_margin_bpm,
        planning_margin_bpm: next.plan.adaptive_policy.safety_margin_bpm,
        reason_code: "observed_hr_above_ceiling",
        termination_reason: "submax_hr_ceiling",
      });
      return next;
    }
  }

  if (next.segment === "warmup") {
    if (elapsed >= next.plan.warmup_duration_sec) {
      const started = startNextStageV3(next, elapsed, getWatts);
      if (!started.started) {
        enterCooldownV3(next, elapsed, started.termination ?? "insufficient_calibrated_workloads");
      }
    }
    return next;
  }

  if (next.segment === "work") {
    const open = openStageV3(next);
    if (!open) {
      const predictedHrMax = runtimePredictedHrMaxV3(next);
      const eligibleCount =
        predictedHrMax == null ? 0 : eligibleObservationsV3(next).length;
      enterCooldownV3(
        next,
        elapsed,
        eligibleCount >= VO2_TARGET_WORK_STAGES ? "protocol_complete" : "insufficient_eligible_stages"
      );
      return next;
    }
    const relative = elapsed - open.active_start_sec;
    const plannedDuration = VO2_NOMINAL_STAGE_DURATION_SEC + open.extensions * 60;
    if (relative >= plannedDuration - VO2_UPCOMING_RESISTANCE_LEAD_SEC) {
      open.upcoming_announced = true;
    }
    const evalAt = evalAtRelativeV3(relative);
    if (evalAt > 0 && evalAt > open.last_eval_relative_sec) {
      open.last_eval_relative_sec = evalAt;
      const evaluation = evaluateStageHr(input.samples, open.active_start_sec, open.active_start_sec + evalAt);
      const hr: Vo2ProtocolStageHrEvidence = {
        sample_count: evaluation.sample_count,
      };
      if (evaluation.minute_2_mean_bpm != null) hr.minute_2_mean_bpm = evaluation.minute_2_mean_bpm;
      if (evaluation.minute_3_mean_bpm != null) hr.minute_3_mean_bpm = evaluation.minute_3_mean_bpm;
      if (evaluation.final_two_window_delta_bpm != null) {
        hr.final_two_window_delta_bpm = evaluation.final_two_window_delta_bpm;
      }
      if (evaluation.steady_state_bpm != null) hr.steady_state_bpm = evaluation.steady_state_bpm;
      if (evaluation.steady) {
        const workload = workloadAtStageCloseV3(next, open, elapsed, input.telemetrySamples ?? []);
        closeOpenStageV3(next, elapsed, "accepted", hr, workload);
        const started = startNextStageV3(next, elapsed, getWatts);
        if (!started.started) {
          enterCooldownV3(next, elapsed, started.termination ?? "insufficient_eligible_stages");
        }
      } else if (evalAt >= VO2_MAX_STAGE_DURATION_SEC) {
        const status: Vo2ProtocolStageStatus = evaluation.coverage_ok ? "unstable_hr" : "insufficient_hr";
        const workload = workloadAtStageCloseV3(next, open, elapsed, input.telemetrySamples ?? []);
        closeOpenStageV3(next, elapsed, status, hr, workload);
        const started = startNextStageV3(next, elapsed, getWatts);
        if (!started.started) {
          enterCooldownV3(next, elapsed, started.termination ?? "insufficient_eligible_stages");
        }
      } else {
        open.extensions = evalAt === VO2_NOMINAL_STAGE_DURATION_SEC ? 1 : 2;
        open.hr = hr;
        open.extension_announced = true;
      }
    }
    return next;
  }

  if (next.segment === "cooldown" && next.cooldown_start_sec != null) {
    if (elapsed >= next.cooldown_start_sec + next.plan.cooldown_duration_sec) {
      next.segment = "complete";
      if (!next.termination) next.termination = { reason: "protocol_complete" };
    }
  }
  return next;
}

function completedPhaseV3(): WorkoutPhaseState {
  return {
    phase: "Completed",
    kind: "completed",
    phaseId: "completed",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 0,
    timeLeft: 0,
    done: true,
  };
}

export function getVo2ProtocolPhaseV3(
  elapsedSec: number,
  runtime: Vo2ProtocolRuntimeV3,
  earlyCooldownElapsed?: number | null
): WorkoutPhaseState {
  const elapsed = Math.max(0, Math.floor(elapsedSec));
  const cool = runtime.plan.cooldown_duration_sec;
  const early =
    earlyCooldownElapsed != null && Number.isFinite(earlyCooldownElapsed) && earlyCooldownElapsed >= 0
      ? Math.floor(earlyCooldownElapsed)
      : runtime.termination?.reason === "early_cooldown"
        ? runtime.cooldown_start_sec
        : null;
  const cooldownStart = early != null ? early : runtime.cooldown_start_sec;

  if (cooldownStart != null && elapsed >= cooldownStart) {
    const phaseElapsed = elapsed - cooldownStart;
    if (phaseElapsed >= cool) return completedPhaseV3();
    return {
      phase: "Cool-Down",
      kind: "cooldown",
      phaseId: "cooldown",
      phaseElapsedSeconds: phaseElapsed,
      phaseDurationSeconds: cool,
      timeLeft: cool - phaseElapsed,
      done: false,
      detailName: "VO2 cooldown",
    };
  }

  if (elapsed < runtime.plan.warmup_duration_sec && runtime.stages.length === 0) {
    return {
      phase: "Warm-Up",
      kind: "warmup",
      phaseId: "warmup",
      phaseElapsedSeconds: elapsed,
      phaseDurationSeconds: runtime.plan.warmup_duration_sec,
      timeLeft: runtime.plan.warmup_duration_sec - elapsed,
      done: false,
      detailName: "VO2 warmup",
    };
  }

  for (const stage of runtime.stages) {
    const end = stage.active_end_sec ?? Number.POSITIVE_INFINITY;
    if (elapsed >= stage.active_start_sec && elapsed < end) {
      const plannedEnd =
        stage.status === "open"
          ? stage.active_start_sec + VO2_NOMINAL_STAGE_DURATION_SEC + stage.extensions * 60
          : end;
      const phaseDuration = Math.max(VO2_NOMINAL_STAGE_DURATION_SEC, plannedEnd - stage.active_start_sec);
      const phaseElapsed = elapsed - stage.active_start_sec;
      return {
        phase: "Sustain",
        kind: "work",
        phaseId: stage.stage_id,
        phaseElapsedSeconds: phaseElapsed,
        phaseDurationSeconds: phaseDuration,
        timeLeft: Math.max(0, phaseDuration - phaseElapsed),
        done: false,
        detailName: stage.extensions > 0 ? `VO2 stage ${stage.workloadIndex + 1} extension` : `VO2 stage ${stage.workloadIndex + 1}`,
        intervalIndex: stage.workloadIndex + 1,
      };
    }
  }

  if (runtime.segment === "complete") return completedPhaseV3();
  if (elapsed < runtime.plan.warmup_duration_sec) {
    return {
      phase: "Warm-Up",
      kind: "warmup",
      phaseId: "warmup",
      phaseElapsedSeconds: elapsed,
      phaseDurationSeconds: runtime.plan.warmup_duration_sec,
      timeLeft: runtime.plan.warmup_duration_sec - elapsed,
      done: false,
      detailName: "VO2 warmup",
    };
  }
  return completedPhaseV3();
}

export function vo2ProtocolHoldForPhaseV3(
  runtime: Vo2ProtocolRuntimeV3 | null | undefined,
  phaseId: string
): { resistance: number; cadenceRpm: number } | undefined {
  if (!runtime) return undefined;
  if (phaseId === "warmup" || phaseId === "cooldown") {
    return {
      resistance: runtime.plan.warmup_resistance,
      cadenceRpm: runtime.plan.prescribed_cadence_rpm,
    };
  }
  const stage = runtime.stages.find((entry) => entry.stage_id === phaseId);
  if (!stage) return undefined;
  const workload = runtime.plan.workloads[stage.workloadIndex];
  if (!workload) return undefined;
  return {
    resistance: workload.prescribed_resistance,
    cadenceRpm: runtime.plan.prescribed_cadence_rpm,
  };
}

function isPositiveFiniteValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFiniteValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isProtocolResistanceValue(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= AUTOMATIC_RESISTANCE_MIN &&
    (value as number) <= VO2_PROTOCOL_MAX_RESISTANCE
  );
}

function isBooleanFlagValue(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isEvalRelativeSecValue(value: unknown): boolean {
  return (VO2_EVAL_RELATIVE_SECONDS as readonly number[]).some((allowed) => allowed === value);
}

function isTerminationReasonV3(value: unknown): value is Vo2ProtocolTerminationReasonV3 {
  return typeof value === "string" && (VO2_V3_TERMINATION_REASONS as readonly string[]).includes(value);
}

function isValidAdaptivePolicyValue(value: unknown): value is Vo2AdaptivePolicy {
  return isValidVo2AdaptivePolicy(value);
}

function isValidAdaptiveStageProvenance(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const provenance = value as Vo2AdaptiveStageProvenance;
  if (provenance.provenance_version !== 1) return false;
  if (!Number.isInteger(provenance.prior_eligible_stage_count) || provenance.prior_eligible_stage_count < 0) {
    return false;
  }
  if (provenance.previous_measured_watts != null && !isPositiveFiniteValue(provenance.previous_measured_watts)) {
    return false;
  }
  if (provenance.previous_steady_hr_bpm != null && !isPositiveFiniteValue(provenance.previous_steady_hr_bpm)) {
    return false;
  }
  if (!isPositiveFiniteValue(provenance.hard_hr_ceiling_bpm)) return false;
  if (!isPositiveFiniteValue(provenance.planning_hr_ceiling_bpm)) return false;
  if (!Number.isFinite(provenance.planning_margin_bpm)) return false;
  if (provenance.predicted_next_hr_bpm != null && !isPositiveFiniteValue(provenance.predicted_next_hr_bpm)) {
    return false;
  }
  if (!isPositiveFiniteValue(provenance.selected_target_watts)) return false;
  if (!isPositiveFiniteValue(provenance.selected_calibrated_watts)) return false;
  if (!isProtocolResistanceValue(provenance.selected_resistance)) return false;
  if (provenance.decision !== "next" && provenance.decision !== "retry") return false;
  return typeof provenance.reason_code === "string" && provenance.reason_code.length > 0;
}

function isValidAdaptiveTerminationProvenance(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const provenance = value as Vo2AdaptiveTerminationProvenance;
  if (provenance.provenance_version !== 1) return false;
  if (!Number.isInteger(provenance.eligible_stage_count) || provenance.eligible_stage_count < 0) return false;
  if (!Number.isInteger(provenance.completed_work_stage_count) || provenance.completed_work_stage_count < 0) {
    return false;
  }
  if (!Number.isInteger(provenance.retry_count) || provenance.retry_count < 0) return false;
  if (!Number.isFinite(provenance.hard_hr_ceiling_bpm)) return false;
  if (!Number.isFinite(provenance.planning_hr_ceiling_bpm)) return false;
  if (!Number.isFinite(provenance.planning_margin_bpm)) return false;
  if (provenance.last_measured_watts != null && !isPositiveFiniteValue(provenance.last_measured_watts)) {
    return false;
  }
  if (provenance.last_steady_hr_bpm != null && !isPositiveFiniteValue(provenance.last_steady_hr_bpm)) {
    return false;
  }
  if (provenance.predicted_hr_bpm != null && !isPositiveFiniteValue(provenance.predicted_hr_bpm)) return false;
  if (typeof provenance.reason_code !== "string" || provenance.reason_code.length === 0) return false;
  return isTerminationReasonV3(provenance.termination_reason);
}

export function isValidVo2ProtocolPlanV3(value: unknown): value is Vo2ProtocolPlanV3 {
  if (!value || typeof value !== "object") return false;
  const plan = value as Vo2ProtocolPlanV3;
  if (plan.protocol_id !== VO2_PROTOCOL_ID) return false;
  if (plan.protocol_version !== VO2_PROTOCOL_VERSION_V3) return false;
  if (plan.prescribed_cadence_rpm !== VO2_PRESCRIBED_CADENCE_RPM) return false;
  if (!isProtocolResistanceValue(plan.warmup_resistance) || !isPositiveFiniteValue(plan.warmup_calibrated_watts_at_70rpm)) {
    return false;
  }
  if (plan.warmup_duration_sec !== VO2_WARMUP_DURATION_SEC) return false;
  if (plan.cooldown_duration_sec !== VO2_COOLDOWN_DURATION_SEC) return false;
  if (!Array.isArray(plan.workloads)) return false;
  if (!isValidAdaptivePolicyValue(plan.adaptive_policy)) return false;
  if (plan.workloads.length > plan.adaptive_policy.max_work_stages) return false;
  if (vo2AdaptiveMaxTotalDurationSec(plan.adaptive_policy) > VO2_ADAPTIVE_ADVERTISED_MAX_TOTAL_DURATION_SEC) {
    return false;
  }
  const resistances = new Set<number>([plan.warmup_resistance]);
  for (const workload of plan.workloads) {
    if (!isValidVo2ResolvedWorkload(workload)) return false;
    if (resistances.has(workload.prescribed_resistance)) return false;
    resistances.add(workload.prescribed_resistance);
  }
  return true;
}

export function isValidVo2ProtocolRuntimeV3(value: unknown): value is Vo2ProtocolRuntimeV3 {
  if (!value || typeof value !== "object") return false;
  const runtime = value as Vo2ProtocolRuntimeV3;
  if (!isValidVo2ProtocolPlanV3(runtime.plan)) return false;
  if (!["warmup", "work", "cooldown", "complete"].includes(runtime.segment)) return false;
  if (runtime.cooldown_start_sec != null && !isNonNegativeFiniteValue(runtime.cooldown_start_sec)) return false;
  if (!isBooleanFlagValue(runtime.start_announced) || !isBooleanFlagValue(runtime.upcoming_warmup_announced)) {
    return false;
  }
  if (runtime.assessment_profile == null || typeof runtime.assessment_profile !== "object") return false;
  const age = runtime.assessment_profile.age_years;
  const weight = runtime.assessment_profile.weight_kg;
  if (!(Number.isFinite(age) && (age as number) >= VO2_AGE_YEARS_MIN && (age as number) <= VO2_AGE_YEARS_MAX)) {
    return false;
  }
  if (!(Number.isFinite(weight) && (weight as number) >= VO2_WEIGHT_KG_MIN && (weight as number) <= VO2_WEIGHT_KG_MAX)) {
    return false;
  }
  if (
    !Number.isInteger(runtime.retry_count_after_above_ceiling) ||
    runtime.retry_count_after_above_ceiling < 0 ||
    runtime.retry_count_after_above_ceiling > runtime.plan.adaptive_policy.max_retries_after_above_ceiling
  ) {
    return false;
  }
  if (runtime.termination != null) {
    if (typeof runtime.termination !== "object" || !isTerminationReasonV3(runtime.termination.reason)) return false;
  }
  if (runtime.adaptive_termination != null && !isValidAdaptiveTerminationProvenance(runtime.adaptive_termination)) {
    return false;
  }
  if (runtime.live_hr_guard_armed != null && !isBooleanFlagValue(runtime.live_hr_guard_armed)) return false;
  if (!Array.isArray(runtime.stages)) return false;
  if (runtime.stages.length > runtime.plan.adaptive_policy.max_work_stages) return false;
  for (const stage of runtime.stages) {
    if (!stage || typeof stage !== "object") return false;
    if (typeof stage.stage_id !== "string" || !stage.stage_id) return false;
    if (!Number.isInteger(stage.workloadIndex) || stage.workloadIndex < 0) return false;
    if (stage.workloadIndex >= runtime.plan.workloads.length) return false;
    if (!isNonNegativeFiniteValue(stage.active_start_sec)) return false;
    if (stage.active_end_sec != null && !isNonNegativeFiniteValue(stage.active_end_sec)) return false;
    if (stage.active_end_sec != null && stage.active_end_sec < stage.active_start_sec) return false;
    if (!Number.isInteger(stage.extensions) || stage.extensions < 0 || stage.extensions > VO2_MAX_EXTENSION_MINUTES) {
      return false;
    }
    if (!isEvalRelativeSecValue(stage.last_eval_relative_sec)) return false;
    if (!isBooleanFlagValue(stage.upcoming_announced) || !isBooleanFlagValue(stage.extension_announced)) return false;
    if (!["accepted", "unstable_hr", "insufficient_hr", "incomplete", "open"].includes(stage.status)) return false;
    if (stage.workload != null && !isValidStageWorkload(stage.workload)) return false;
    if (stage.adaptive != null && !isValidAdaptiveStageProvenance(stage.adaptive)) return false;
  }
  return true;
}

export function buildVo2ProtocolEvidenceV3(
  runtime: Vo2ProtocolRuntimeV3,
  telemetrySamples: readonly BikeTelemetrySample[] = []
): AdaptiveVo2ProtocolEvidence | undefined {
  if (!isValidVo2ProtocolRuntimeV3(runtime)) return undefined;
  const stages: Vo2ProtocolStageEvidence[] = [];
  for (const stage of runtime.stages) {
    const evidence = evidenceForRuntimeStageV3(runtime, stage);
    if (!evidence) return undefined;
    evidence.workload ??= summarizeVo2StageWorkload(evidence, telemetrySamples, runtime.plan.prescribed_cadence_rpm);
    if (evidence.prescribed_resistance > VO2_PROTOCOL_MAX_RESISTANCE) return undefined;
    stages.push(evidence);
  }
  const evidence: AdaptiveVo2ProtocolEvidence = {
    protocol_id: runtime.plan.protocol_id,
    protocol_version: runtime.plan.protocol_version,
    prescribed_cadence_rpm: runtime.plan.prescribed_cadence_rpm,
    stages,
    termination: {
      reason: runtime.termination?.reason ?? "other",
    },
    automatic_submax_hr_ceiling_available:
      runtimePredictedHrMaxV3(runtime) != null && runtime.live_hr_guard_armed === true,
  };
  if (runtime.adaptive_termination) {
    evidence.adaptive_termination = runtime.adaptive_termination;
  }
  return evidence;
}

export function parseVo2ProtocolRuntimeV3(raw: unknown): Vo2ProtocolRuntimeV3 | null {
  if (!isValidVo2ProtocolRuntimeV3(raw)) return null;
  return raw;
}

/**
 * Live-session version routing. New athlete-started sessions are v3; a
 * persisted v2 runtime keeps v2 semantics on every path below. Anything
 * that is not v3 takes the v2 branch, preserving historical behavior.
 */
export function isVo2ProtocolRuntimeV3(
  runtime: Vo2ProtocolRuntime | Vo2ProtocolRuntimeV3 | null | undefined
): runtime is Vo2ProtocolRuntimeV3 {
  return (runtime as Vo2ProtocolRuntimeV3 | null | undefined)?.plan?.protocol_version === VO2_PROTOCOL_VERSION_V3;
}

export function advanceVo2ProtocolRuntime(
  runtime: Vo2ProtocolRuntime | Vo2ProtocolRuntimeV3,
  input: AdvanceVo2ProtocolV3Input
): Vo2ProtocolRuntime | Vo2ProtocolRuntimeV3 {
  if (isVo2ProtocolRuntimeV3(runtime)) return advanceVo2ProtocolV3(runtime, input);
  return advanceVo2Protocol(runtime, input);
}

export function getVo2ProtocolPhaseForRuntime(
  elapsedSec: number,
  runtime: Vo2ProtocolRuntime | Vo2ProtocolRuntimeV3,
  earlyCooldownElapsed?: number | null
): WorkoutPhaseState {
  if (isVo2ProtocolRuntimeV3(runtime)) return getVo2ProtocolPhaseV3(elapsedSec, runtime, earlyCooldownElapsed);
  return getVo2ProtocolPhase(elapsedSec, runtime, earlyCooldownElapsed);
}

export function vo2ProtocolNeedsHrEvaluationForRuntime(
  runtime: Vo2ProtocolRuntime | Vo2ProtocolRuntimeV3 | null | undefined,
  elapsedSec: number,
  paused: boolean
): boolean {
  if (isVo2ProtocolRuntimeV3(runtime)) return vo2ProtocolV3NeedsHrEvaluation(runtime, elapsedSec, paused);
  return vo2ProtocolNeedsHrEvaluation(runtime, elapsedSec, paused);
}

export interface Vo2ProtocolUiTargetsShape {
  hrTargetTextValue: string;
  targetHeartRateMin: undefined;
  targetHeartRateMax: undefined;
  holdResistance: number | undefined;
  holdCadenceRpm: number | undefined;
}

export function vo2ProtocolUiTargetsV3(
  runtime: Vo2ProtocolRuntimeV3 | null | undefined,
  phaseId: string
): Vo2ProtocolUiTargetsShape {
  const hold = vo2ProtocolHoldForPhaseV3(runtime, phaseId);
  return {
    hrTargetTextValue: "",
    targetHeartRateMin: undefined,
    targetHeartRateMax: undefined,
    holdResistance: hold?.resistance,
    holdCadenceRpm: hold?.cadenceRpm,
  };
}

export function vo2ProtocolUiTargetsForRuntime(
  runtime: Vo2ProtocolRuntime | Vo2ProtocolRuntimeV3 | null | undefined,
  phaseId: string
): Vo2ProtocolUiTargetsShape {
  if (isVo2ProtocolRuntimeV3(runtime)) return vo2ProtocolUiTargetsV3(runtime, phaseId);
  return vo2ProtocolUiTargets(runtime, phaseId);
}

export function vo2ProtocolHoldForPhaseForRuntime(
  runtime: Vo2ProtocolRuntime | Vo2ProtocolRuntimeV3 | null | undefined,
  phaseId: string
): { resistance: number; cadenceRpm: number } | undefined {
  if (isVo2ProtocolRuntimeV3(runtime)) return vo2ProtocolHoldForPhaseV3(runtime, phaseId);
  return vo2ProtocolHoldForPhase(runtime, phaseId);
}

export function buildVo2ProtocolEvidenceForRuntime(
  runtime: Vo2ProtocolRuntime | Vo2ProtocolRuntimeV3,
  telemetrySamples: readonly BikeTelemetrySample[] = []
): CurrentVo2ProtocolEvidence | AdaptiveVo2ProtocolEvidence | undefined {
  if (isVo2ProtocolRuntimeV3(runtime)) return buildVo2ProtocolEvidenceV3(runtime, telemetrySamples);
  return buildVo2ProtocolEvidence(runtime, telemetrySamples);
}
