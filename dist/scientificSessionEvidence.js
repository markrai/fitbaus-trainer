import { analyzeHeldWorkloadForwardResponseInternal, } from "./personalizedPrescriptionCharacterization.js";
import { calibrationIdentityFromE1Snapshot, calibrationIdentityKey } from "./calibrationMachineProvenance.js";
/**
 * Who established the held resistance of one qualifying E2 v3 window.
 * `no_app_selector_observed` means only that no captured app command was
 * established as the selector; console-knob changes are not observable, so it
 * never means manual, athlete-selected, or open-loop.
 */
/** Canonical vocabularies (E4A v2 mirrors them at its trust boundary; kept in step by test). */
export const MACHINE_COMPARABILITY_REASONS_V2 = [
    "same_machine_and_profile",
    "execution_provenance_unavailable",
    "workout_machine_unavailable",
    "workout_machine_selection_changed",
    "calibration_unavailable",
    "calibration_machine_unavailable",
    "calibration_machine_integrity_failure",
    "calibration_identity_mismatch",
    "different_machine",
    "same_machine_different_profile",
];
export const TIMED_ACTUATION_JOINS_V2 = [
    "available",
    "not_applicable",
    "execution_provenance_unavailable",
    "raw_telemetry_unavailable",
    "reconstruction_mismatch",
];
const PROGRAMMATIC_ORIGINS = new Set([
    "learned_starting_resistance",
    "default_starting_resistance",
    "controller_carryover",
    "scripted_phase_program",
    "vo2_protocol_fixed_resistance",
]);
/** Exact machine/profile/calibration-instance comparability. No model-level normalization. */
export function compareSessionMachines(summary) {
    const provenance = summary.execution_provenance;
    const fail = (reason) => ({ comparable: false, reason });
    if (!provenance || provenance.sessionId !== summary.external_session_id)
        return fail("execution_provenance_unavailable");
    if (provenance.machine.status !== "selected")
        return fail("workout_machine_unavailable");
    if (provenance.machine.selectionChangedDuringWorkout)
        return fail("workout_machine_selection_changed");
    const e1 = summary.shadow_prescription_evaluation;
    const e1Identity = e1 ? calibrationIdentityFromE1Snapshot(e1.athleteId, e1.fitnessEvidenceSnapshot) : null;
    if (!e1Identity)
        return fail("calibration_unavailable");
    const calibration = provenance.calibrationMachine;
    if (calibration.status === "no_frozen_calibration")
        return fail("calibration_identity_mismatch");
    if (calibrationIdentityKey(calibration.calibration) !== calibrationIdentityKey(e1Identity)) {
        return fail("calibration_identity_mismatch");
    }
    if (calibration.status === "integrity_failure")
        return fail("calibration_machine_integrity_failure");
    if (calibration.status === "unavailable")
        return fail("calibration_machine_unavailable");
    if (calibration.machineId !== provenance.machine.machineId)
        return fail("different_machine");
    if (calibration.machineProfileVersion !== provenance.machine.machineProfileVersion) {
        return fail("same_machine_different_profile");
    }
    return { comparable: true, reason: "same_machine_and_profile" };
}
/**
 * Conservative selector classification for one qualifying held window.
 *
 * The selector is the most recent accepted app command at or before the
 * window's first stable second. It establishes the hold only if its requested
 * resistance equals the observed held resistance and nothing after it (up to
 * the window end) is unresolved, rejected, unclassified, or a new decision.
 * A later event is a harmless re-send only when its trigger is
 * `reconciliation_resend` and it repeats the selector's decision ID and
 * resistance; it is counted but never becomes a new selector. With complete capture and no accepted command before the hold,
 * the window is `no_app_selector_observed`. Everything else is `unknown`.
 */
export function classifyHeldWindowActuation(window, actuation) {
    const base = {
        firstActiveSec: window.firstActiveSec,
        lastActiveSec: window.lastActiveSec,
        observedResistance: window.observedResistance,
        qualifyingDurationSec: window.qualifyingDurationSec,
        sameDecisionResendsDuringHold: 0,
        newDecisionsDuringHold: { automatic: 0, programmatic: 0, other: 0 },
    };
    if (actuation.coverage !== "complete")
        return { ...base, context: "unknown", reason: "capture_incomplete" };
    const events = [...actuation.events].sort((a, b) => a.commandId - b.commandId);
    const selector = events
        .filter((event) => event.outcome === "accepted" && event.activeSec <= window.firstActiveSec)
        .pop();
    const relevant = events.filter((event) => { var _a; return event.commandId >= ((_a = selector === null || selector === void 0 ? void 0 : selector.commandId) !== null && _a !== void 0 ? _a : 0) && event.activeSec <= window.lastActiveSec; });
    const selectorFields = selector ? {
        selectorOrigin: selector.origin,
        selectorDecisionId: selector.decisionId,
        selectorActiveSec: selector.activeSec,
    } : {};
    if (relevant.some((event) => event.outcome !== "accepted")) {
        return { ...base, ...selectorFields, context: "unknown", reason: "unresolved_or_rejected_command" };
    }
    if (relevant.some((event) => event.origin === "unclassified")) {
        return { ...base, ...selectorFields, context: "unknown", reason: "unclassified_command" };
    }
    const after = relevant.filter((event) => event !== selector);
    for (const event of after) {
        // Only a genuine reconciliation re-send of the selector's own decision at the
        // same resistance is harmless; anything else is a new decision or ambiguity.
        if (selector && event.trigger === "reconciliation_resend" && event.decisionId === selector.decisionId &&
            event.requestedResistance === selector.requestedResistance) {
            base.sameDecisionResendsDuringHold += 1;
        }
        else if (event.origin === "automatic_hr_control") {
            base.newDecisionsDuringHold.automatic += 1;
        }
        else if (PROGRAMMATIC_ORIGINS.has(event.origin)) {
            base.newDecisionsDuringHold.programmatic += 1;
        }
        else {
            base.newDecisionsDuringHold.other += 1;
        }
    }
    const newDecisions = base.newDecisionsDuringHold;
    if (newDecisions.automatic + newDecisions.programmatic + newDecisions.other > 0) {
        return { ...base, ...selectorFields, context: "unknown", reason: "new_decision_during_hold" };
    }
    if (!selector)
        return { ...base, context: "no_app_selector_observed", reason: "no_accepted_app_command_before_hold" };
    if (selector.requestedResistance !== window.observedResistance) {
        return { ...base, ...selectorFields, context: "unknown", reason: "app_request_differs_from_observed_hold" };
    }
    if (selector.origin === "automatic_hr_control") {
        return { ...base, ...selectorFields, context: "automatic_selected", reason: "automatic_hr_control_selector" };
    }
    if (PROGRAMMATIC_ORIGINS.has(selector.origin)) {
        return { ...base, ...selectorFields, context: "programmatic_selected", reason: "programmatic_selector" };
    }
    return { ...base, ...selectorFields, context: "unknown", reason: "unclassifiable_selector_origin" };
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        const record = value;
        return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
/**
 * Re-run the canonical E2 v3 reducer over retained raw telemetry with the
 * record's own frozen inputs. The windows are trusted only if the reducer
 * reproduces the durable record exactly; otherwise the timed join is unavailable.
 */
function reconstructHeldWindows(summary, raw) {
    const record = summary.shadow_prescription_characterization;
    if (!record || record.schemaVersion !== 3)
        return { join: "not_applicable", phases: [] };
    if (!raw || (raw.hrSamples.length === 0 && raw.bikeSamples.length === 0)) {
        return { join: "raw_telemetry_unavailable", phases: [] };
    }
    const analysis = analyzeHeldWorkloadForwardResponseInternal({
        summary: {
            external_session_id: summary.external_session_id,
            athlete_id: summary.athlete_id,
            day: summary.day,
            intent: summary.intent,
            activity: summary.activity,
        },
        shadowEvaluation: summary.shadow_prescription_evaluation,
        workoutResponse: summary.workout_response,
        hrSamples: raw.hrSamples,
        bikeSamples: raw.bikeSamples,
        machineDecisionAudit: summary.machine_decision_audit,
        policy: record.policy,
        heldWorkloadPolicy: record.heldWorkloadPolicy,
        createdAt: record.createdAt,
    });
    if (!analysis.record || canonicalJson(analysis.record) !== canonicalJson(record)) {
        return { join: "reconstruction_mismatch", phases: [] };
    }
    return { join: "available", phases: analysis.phases };
}
function emptyContexts() {
    return {
        automatic_selected: { windowCount: 0, durationSec: 0 },
        programmatic_selected: { windowCount: 0, durationSec: 0 },
        no_app_selector_observed: { windowCount: 0, durationSec: 0 },
        unknown: { windowCount: 0, durationSec: 0 },
    };
}
/** Per-window details for diagnostics; transient. Empty when the timed join is unavailable. */
export function heldWindowActuationDetails(summary, raw) {
    const provenance = summary.execution_provenance;
    if (!provenance || provenance.sessionId !== summary.external_session_id)
        return [];
    const reconstructed = reconstructHeldWindows(summary, raw);
    if (reconstructed.join !== "available")
        return [];
    return reconstructed.phases.map((phase) => ({
        phaseId: phase.phaseId,
        ...(phase.intervalIndex !== undefined ? { intervalIndex: phase.intervalIndex } : {}),
        windows: phase.windows
            .filter((window) => window.qualifyingDurationSec > 0)
            .map((window) => classifyHeldWindowActuation(window, provenance.actuation)),
    }));
}
/** Pure join for one trusted workout summary (from the strict history readers). */
export function buildScientificSessionEvidenceV2(summary, raw) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const provenance = ((_a = summary.execution_provenance) === null || _a === void 0 ? void 0 : _a.sessionId) === summary.external_session_id ? summary.execution_provenance : undefined;
    const record = summary.shadow_prescription_characterization;
    const reconstructed = !provenance
        ? { join: ((record === null || record === void 0 ? void 0 : record.schemaVersion) === 3 ? "execution_provenance_unavailable" : "not_applicable"),
            phases: [] }
        : reconstructHeldWindows(summary, raw);
    const phases = [];
    if (record && record.schemaVersion === 3) {
        for (const phase of record.phases) {
            const held = phase.heldWorkloadForwardResponse;
            const analysis = reconstructed.phases.find((item) => item.phaseId === phase.phaseId &&
                item.intervalIndex === phase.intervalIndex && item.activeStartSec === phase.activeStartSec);
            let contexts = null;
            if (reconstructed.join === "available" && analysis && provenance) {
                contexts = emptyContexts();
                for (const window of analysis.windows.filter((item) => item.qualifyingDurationSec > 0)) {
                    const detail = classifyHeldWindowActuation(window, provenance.actuation);
                    contexts[detail.context].windowCount += 1;
                    contexts[detail.context].durationSec += detail.qualifyingDurationSec;
                }
            }
            phases.push({
                phaseId: phase.phaseId,
                ...(phase.intervalIndex !== undefined ? { intervalIndex: phase.intervalIndex } : {}),
                ...(phase.activeStartSec !== undefined ? { activeStartSec: phase.activeStartSec } : {}),
                heldWorkload: {
                    available: held.outcome === "characterized",
                    timedJoin: reconstructed.join === "available" && !analysis ? "reconstruction_mismatch" : reconstructed.join,
                    qualifyingWindowCount: (_c = (_b = held.stableResistance) === null || _b === void 0 ? void 0 : _b.qualifyingWindowCount) !== null && _c !== void 0 ? _c : 0,
                    qualifyingDurationSec: (_e = (_d = held.stableResistance) === null || _d === void 0 ? void 0 : _d.qualifyingDurationSec) !== null && _e !== void 0 ? _e : 0,
                    medianSignedErrorBpm: (_g = (_f = held.forwardHeartRate) === null || _f === void 0 ? void 0 : _f.signedErrorBpm.median) !== null && _g !== void 0 ? _g : null,
                    medianAbsoluteErrorBpm: (_j = (_h = held.forwardHeartRate) === null || _h === void 0 ? void 0 : _h.absoluteErrorBpm.median) !== null && _j !== void 0 ? _j : null,
                    contexts,
                },
            });
        }
    }
    return {
        workoutSessionId: summary.external_session_id,
        machineComparison: compareSessionMachines(summary),
        actuationCapture: provenance ? provenance.actuation.coverage : "unavailable",
        phases,
        independentOpenLoopEvidence: false,
    };
}
/** Contexts for the read-only diagnostics projection, keyed by workout session. */
export function buildScientificSessionEvidenceV2Contexts(history, athleteId, rawBySession) {
    var _a;
    const contexts = {};
    for (const { summary } of history) {
        if (summary.athlete_id !== athleteId || !summary.shadow_prescription_characterization)
            continue;
        contexts[summary.external_session_id] =
            buildScientificSessionEvidenceV2(summary, (_a = rawBySession[summary.external_session_id]) !== null && _a !== void 0 ? _a : null);
    }
    return contexts;
}
