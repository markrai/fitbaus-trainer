import type {
  Activity,
  HrSample,
  HrTargetsForDay,
  PlanBlock,
  Vo2Evidence,
  CurrentVo2Evidence,
  Vo2EvidenceHr,
  Vo2EvidenceMachine,
  Vo2EvidencePhase,
  Vo2EvidencePhasePrescription,
  WorkoutPhaseKind,
  WorkoutSummary,
  CurrentVo2ProtocolEvidence,
  AdaptiveVo2ProtocolEvidence,
  ResolvedWorkoutPrescription,
} from "./types.js";
import { VO2_EVIDENCE_SCHEMA_VERSION } from "./types.js";
import type { MachineId } from "./machines/trace.js";
import { getPhase, type GetPhaseOptions } from "./workoutLogic.js";
import type { Vo2ProtocolRuntime } from "./vo2Protocol.js";
import type { Vo2ProtocolRuntimeV3 } from "./vo2ProtocolV3.js";
import { findResolvedPhaseTarget, resolveWorkoutPrescription } from "./workoutPrescription.js";

export interface Vo2EvidenceBuildInput {
  day?: string;
  activity?: Activity;
  intent?: string;
  blocks?: PlanBlock | null;
  hrTargets?: HrTargetsForDay | null;
  resolvedPrescription?: ResolvedWorkoutPrescription | null;
  activeDurationSec: number;
  pausedDurationSec: number;
  earlyCooldownElapsed?: number | null;
  cancelled?: boolean;
  hrSamples: readonly HrSample[];
  machineId?: MachineId;
  machineProfileVersion?: number;
  /** Count-only provenance; full trace stays on WorkoutSummary. */
  machineGuidanceTraceEntryCount?: number;
  vo2Protocol?: Vo2ProtocolRuntime | Vo2ProtocolRuntimeV3 | null;
  protocol?: CurrentVo2ProtocolEvidence | AdaptiveVo2ProtocolEvidence;
}

function naturalWorkEndSec(blocks: PlanBlock): number {
  return (blocks.warm + blocks.sustain) * 60;
}

function cooldownMarkers(input: {
  blocks?: PlanBlock | null;
  earlyCooldownElapsed?: number | null;
  activeDurationSec: number;
  phases: readonly Vo2EvidencePhase[];
}): {
  work_end_active_sec: number | null;
  cooldown_start_active_sec: number | null;
  early_cooldown: boolean;
} {
  const early =
    input.earlyCooldownElapsed != null &&
    Number.isFinite(input.earlyCooldownElapsed) &&
    input.earlyCooldownElapsed >= 0;
  if (early) {
    const mark = Math.floor(input.earlyCooldownElapsed as number);
    const reachedCooldown = input.activeDurationSec >= mark;
    return {
      work_end_active_sec: reachedCooldown ? mark : null,
      cooldown_start_active_sec: reachedCooldown ? mark : null,
      early_cooldown: true,
    };
  }

  const cooldownPhase = input.phases.find((phase) => phase.kind === "cooldown");
  if (cooldownPhase) {
    return {
      work_end_active_sec: cooldownPhase.active_start_sec,
      cooldown_start_active_sec: cooldownPhase.active_start_sec,
      early_cooldown: false,
    };
  }

  if (input.blocks && input.blocks.cool > 0) {
    const natural = naturalWorkEndSec(input.blocks);
    if (input.activeDurationSec >= natural) {
      return {
        work_end_active_sec: natural,
        cooldown_start_active_sec: natural,
        early_cooldown: false,
      };
    }
  }

  return {
    work_end_active_sec: null,
    cooldown_start_active_sec: null,
    early_cooldown: false,
  };
}

function prescriptionFromPlan(
  phaseId: string,
  elapsedSec: number,
  prescription: ResolvedWorkoutPrescription
): Vo2EvidencePhasePrescription | undefined {
  const target = findResolvedPhaseTarget(prescription, phaseId, elapsedSec);
  if (target?.displayTargetHrBpm === undefined) return undefined;
  const prescribed: Vo2EvidencePhasePrescription = {
    target_hr_bpm: target.displayTargetHrBpm,
  };
  if (target.expectedHeartRate) {
    prescribed.target_hr_min = target.expectedHeartRate.min;
    prescribed.target_hr_max = target.expectedHeartRate.max;
  }
  return prescribed;
}

/**
 * Walk the authoritative active clock and record contiguous phase segments.
 * Adjacent transitions share the same active second as end/start.
 */
export function deriveVo2EvidencePhases(input: {
  day: string;
  blocks: PlanBlock;
  activeDurationSec: number;
  earlyCooldownElapsed?: number | null;
  hrTargets?: HrTargetsForDay | null;
  resolvedPrescription?: ResolvedWorkoutPrescription | null;
  vo2Protocol?: Vo2ProtocolRuntime | Vo2ProtocolRuntimeV3 | null;
}): Vo2EvidencePhase[] {
  const activeDurationSec = Math.max(0, Math.floor(input.activeDurationSec));
  if (activeDurationSec <= 0) return [];

  const phases: Vo2EvidencePhase[] = [];
  const prescription = input.resolvedPrescription ?? resolveWorkoutPrescription({
    workoutSelector: input.day,
    blocks: input.blocks,
    hrTargets: input.hrTargets ?? null,
    resolvedAt: "historical-evidence-replay",
  });
  let open: {
    phase_id: string;
    kind: WorkoutPhaseKind;
    detail_name?: string;
    interval_index?: number;
    active_start_sec: number;
    resolved_detail_name?: string;
  } | null = null;

  const closeOpen = (endSec: number) => {
    if (!open) return;
    const end = Math.max(open.active_start_sec, endSec);
    const prescribed = prescriptionFromPlan(
      open.phase_id,
      open.active_start_sec,
      prescription
    );
    phases.push({
      phase_id: open.phase_id,
      kind: open.kind,
      detail_name: open.detail_name,
      interval_index: open.interval_index,
      active_start_sec: open.active_start_sec,
      active_end_sec: end,
      prescribed,
    });
    open = null;
  };

  const phaseOptions: GetPhaseOptions = { day: input.day, hrTargets: input.hrTargets };
  if (Object.prototype.hasOwnProperty.call(input, "vo2Protocol")) {
    phaseOptions.vo2Protocol = input.vo2Protocol;
  }
  for (let t = 0; t < activeDurationSec; t++) {
    const state = getPhase(t, input.blocks, input.earlyCooldownElapsed, phaseOptions);
    if (state.done || state.kind === "completed") {
      closeOpen(t);
      break;
    }
    const resolvedTarget = findResolvedPhaseTarget(prescription, state.phaseId, t);
    const detailName = resolvedTarget?.detailName ?? state.detailName;
    if (!open) {
      open = {
        phase_id: state.phaseId,
        kind: state.kind,
        detail_name: detailName,
        interval_index: state.intervalIndex,
        active_start_sec: t,
        resolved_detail_name: resolvedTarget?.detailName,
      };
      continue;
    }
    if (
      open.phase_id !== state.phaseId ||
      open.kind !== state.kind ||
      open.resolved_detail_name !== resolvedTarget?.detailName
    ) {
      closeOpen(t);
      open = {
        phase_id: state.phaseId,
        kind: state.kind,
        detail_name: detailName,
        interval_index: state.intervalIndex,
        active_start_sec: t,
        resolved_detail_name: resolvedTarget?.detailName,
      };
    }
  }
  closeOpen(activeDurationSec);
  return phases;
}

export function buildVo2EvidenceHr(samples: readonly HrSample[]): Vo2EvidenceHr {
  const valid = samples
    .filter((sample) => Number.isFinite(sample.timestamp_sec) && Number.isFinite(sample.hr) && sample.hr > 0)
    .map((sample) => sample.timestamp_sec)
    .sort((a, b) => a - b);
  if (valid.length === 0) {
    return { source: "absent", sample_count: 0 };
  }
  return {
    source: "ble_chest_strap",
    sample_count: valid.length,
    first_active_elapsed_sec: valid[0],
    last_active_elapsed_sec: valid[valid.length - 1],
  };
}

function buildMachineEvidence(input: Vo2EvidenceBuildInput): Vo2EvidenceMachine | undefined {
  if (
    input.machineId == null &&
    input.machineProfileVersion == null &&
    input.machineGuidanceTraceEntryCount == null
  ) {
    return undefined;
  }
  const machine: Vo2EvidenceMachine = {};
  if (input.machineId != null) machine.machine_id = input.machineId;
  if (input.machineProfileVersion != null) machine.machine_profile_version = input.machineProfileVersion;
  if (input.machineGuidanceTraceEntryCount != null) {
    machine.guidance_trace_entry_count = input.machineGuidanceTraceEntryCount;
  }
  return machine;
}

export function buildVo2Evidence(input: Vo2EvidenceBuildInput): CurrentVo2Evidence {
  const activeDurationSec = Math.max(0, Math.floor(input.activeDurationSec));
  const pausedDurationSec = Math.max(0, Math.floor(input.pausedDurationSec));
  const phases =
    input.blocks != null
      ? deriveVo2EvidencePhases({
          day: input.day || "",
          blocks: input.blocks,
          activeDurationSec,
          earlyCooldownElapsed: input.earlyCooldownElapsed,
          hrTargets: input.hrTargets,
          resolvedPrescription: input.resolvedPrescription,
          vo2Protocol: input.vo2Protocol,
        })
      : [];
  const markers = cooldownMarkers({
    blocks: input.blocks,
    earlyCooldownElapsed: input.earlyCooldownElapsed,
    activeDurationSec,
    phases,
  });
  const evidence: CurrentVo2Evidence = {
    schema_version: VO2_EVIDENCE_SCHEMA_VERSION,
    active_duration_sec: activeDurationSec,
    paused_duration_sec: pausedDurationSec,
    work_end_active_sec: markers.work_end_active_sec,
    cooldown_start_active_sec: markers.cooldown_start_active_sec,
    early_cooldown: markers.early_cooldown,
    phases,
    hr: buildVo2EvidenceHr(input.hrSamples),
  };
  if (input.activity) evidence.activity = input.activity;
  if (input.intent) evidence.intent = input.intent;
  if (input.day) evidence.day = input.day;
  if (input.cancelled) evidence.cancelled = true;
  const machine = buildMachineEvidence(input);
  if (machine) evidence.machine = machine;
  if (input.protocol) evidence.protocol = input.protocol;
  return evidence;
}

export function attachVo2Evidence(
  summary: WorkoutSummary,
  evidence: Vo2Evidence
): WorkoutSummary {
  summary.vo2_evidence = evidence;
  return summary;
}
