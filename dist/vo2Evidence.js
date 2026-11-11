import { VO2_EVIDENCE_SCHEMA_VERSION } from "./types.js";
import { getPhase } from "./workoutLogic.js";
import { findResolvedPhaseTarget, resolveWorkoutPrescription } from "./workoutPrescription.js";
function naturalWorkEndSec(blocks) {
    return (blocks.warm + blocks.sustain) * 60;
}
function cooldownMarkers(input) {
    const early = input.earlyCooldownElapsed != null &&
        Number.isFinite(input.earlyCooldownElapsed) &&
        input.earlyCooldownElapsed >= 0;
    if (early) {
        const mark = Math.floor(input.earlyCooldownElapsed);
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
function prescriptionFromPlan(phaseId, elapsedSec, prescription) {
    const target = findResolvedPhaseTarget(prescription, phaseId, elapsedSec);
    if ((target === null || target === void 0 ? void 0 : target.displayTargetHrBpm) === undefined)
        return undefined;
    const prescribed = {
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
export function deriveVo2EvidencePhases(input) {
    var _a, _b, _c;
    const activeDurationSec = Math.max(0, Math.floor(input.activeDurationSec));
    if (activeDurationSec <= 0)
        return [];
    const phases = [];
    const prescription = (_a = input.resolvedPrescription) !== null && _a !== void 0 ? _a : resolveWorkoutPrescription({
        workoutSelector: input.day,
        blocks: input.blocks,
        hrTargets: (_b = input.hrTargets) !== null && _b !== void 0 ? _b : null,
        resolvedAt: "historical-evidence-replay",
    });
    let open = null;
    const closeOpen = (endSec) => {
        if (!open)
            return;
        const end = Math.max(open.active_start_sec, endSec);
        const prescribed = prescriptionFromPlan(open.phase_id, open.active_start_sec, prescription);
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
    const phaseOptions = { day: input.day, hrTargets: input.hrTargets };
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
        const detailName = (_c = resolvedTarget === null || resolvedTarget === void 0 ? void 0 : resolvedTarget.detailName) !== null && _c !== void 0 ? _c : state.detailName;
        if (!open) {
            open = {
                phase_id: state.phaseId,
                kind: state.kind,
                detail_name: detailName,
                interval_index: state.intervalIndex,
                active_start_sec: t,
                resolved_detail_name: resolvedTarget === null || resolvedTarget === void 0 ? void 0 : resolvedTarget.detailName,
            };
            continue;
        }
        if (open.phase_id !== state.phaseId ||
            open.kind !== state.kind ||
            open.resolved_detail_name !== (resolvedTarget === null || resolvedTarget === void 0 ? void 0 : resolvedTarget.detailName)) {
            closeOpen(t);
            open = {
                phase_id: state.phaseId,
                kind: state.kind,
                detail_name: detailName,
                interval_index: state.intervalIndex,
                active_start_sec: t,
                resolved_detail_name: resolvedTarget === null || resolvedTarget === void 0 ? void 0 : resolvedTarget.detailName,
            };
        }
    }
    closeOpen(activeDurationSec);
    return phases;
}
export function buildVo2EvidenceHr(samples) {
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
function buildMachineEvidence(input) {
    if (input.machineId == null &&
        input.machineProfileVersion == null &&
        input.machineGuidanceTraceEntryCount == null) {
        return undefined;
    }
    const machine = {};
    if (input.machineId != null)
        machine.machine_id = input.machineId;
    if (input.machineProfileVersion != null)
        machine.machine_profile_version = input.machineProfileVersion;
    if (input.machineGuidanceTraceEntryCount != null) {
        machine.guidance_trace_entry_count = input.machineGuidanceTraceEntryCount;
    }
    return machine;
}
export function buildVo2Evidence(input) {
    const activeDurationSec = Math.max(0, Math.floor(input.activeDurationSec));
    const pausedDurationSec = Math.max(0, Math.floor(input.pausedDurationSec));
    const phases = input.blocks != null
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
    const evidence = {
        schema_version: VO2_EVIDENCE_SCHEMA_VERSION,
        active_duration_sec: activeDurationSec,
        paused_duration_sec: pausedDurationSec,
        work_end_active_sec: markers.work_end_active_sec,
        cooldown_start_active_sec: markers.cooldown_start_active_sec,
        early_cooldown: markers.early_cooldown,
        phases,
        hr: buildVo2EvidenceHr(input.hrSamples),
    };
    if (input.activity)
        evidence.activity = input.activity;
    if (input.intent)
        evidence.intent = input.intent;
    if (input.day)
        evidence.day = input.day;
    if (input.cancelled)
        evidence.cancelled = true;
    const machine = buildMachineEvidence(input);
    if (machine)
        evidence.machine = machine;
    if (input.protocol)
        evidence.protocol = input.protocol;
    return evidence;
}
export function attachVo2Evidence(summary, evidence) {
    summary.vo2_evidence = evidence;
    return summary;
}
