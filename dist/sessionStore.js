import { isActivity } from "./workoutActivity.js";
import { isValidVo2ProtocolRuntime, readPersistedVo2ProtocolRuntime, } from "./vo2Protocol.js";
import { isValidVo2ProtocolRuntimeV3, isVo2ProtocolRuntimeV3, parseVo2ProtocolRuntimeV3, } from "./vo2ProtocolV3.js";
import { captureAthleteFitnessSnapshot, parseAthleteFitnessSnapshot } from "./fitnessState.js";
import { parsePersistedHrTargetsForDay, parseResolvedWorkoutPrescription, persistedHrTargetsFitBlocks, } from "./workoutPrescription.js";
import { parsePersonalizedPrescriptionEvaluation } from "./personalizedPrescription.js";
import { captureWorkoutMachineProvenance, createInProgressExecutionProvenance, executionProvenanceKey, readInProgressExecutionProvenance, writeInProgressExecutionProvenance, } from "./executionProvenance.js";
import { calibrationIdentityFromE1Snapshot, resolveWorkoutCalibrationMachine } from "./calibrationMachineProvenance.js";
import { clearFrozenSessionControlMode, freezeSessionControlMode, resolveSessionControlAuthority, sessionControlModeKey, } from "./sessionControlMode.js";
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
function storageOrBrowser(storage) {
    return storage !== null && storage !== void 0 ? storage : localStorage;
}
function parseStoredActivity(raw) {
    return isActivity(raw) ? raw : undefined;
}
function earlyCooldownKey(day) {
    return "early_cooldown_elapsed_" + day;
}
function pausedDurationKey(day) {
    return "paused_duration_" + day;
}
function pauseWallStartKey(day) {
    return "pause_wall_start_" + day;
}
function phasePlanKey(day) {
    return "phase_plan_" + day;
}
function athleteIdKey(day) {
    return "athlete_id_" + day;
}
function athleteFitnessSnapshotKey(day) {
    return "athlete_fitness_snapshot_" + day;
}
function vo2ProtocolRuntimeKey(day) {
    return "vo2_protocol_runtime_" + day;
}
function legacyVo2ProtocolPlanKey(day) {
    return "vo2_protocol_plan_" + day;
}
function parseEarlyCooldownElapsed(raw) {
    if (raw == null || raw === "")
        return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0)
        return null;
    return value;
}
function parseNonNegativeInt(raw) {
    const value = parseInt(raw || "0", 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
}
function parseOptionalWallMs(raw) {
    if (raw == null || raw === "")
        return null;
    const value = parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
}
function parsePhasePlan(raw) {
    var _a, _b, _c, _d, _e;
    if (raw == null || raw === "")
        return null;
    try {
        const parsed = JSON.parse(raw);
        const warm = Number((_a = parsed === null || parsed === void 0 ? void 0 : parsed.blocks) === null || _a === void 0 ? void 0 : _a.warm);
        const sustain = Number((_b = parsed === null || parsed === void 0 ? void 0 : parsed.blocks) === null || _b === void 0 ? void 0 : _b.sustain);
        const cool = Number((_c = parsed === null || parsed === void 0 ? void 0 : parsed.blocks) === null || _c === void 0 ? void 0 : _c.cool);
        if (![warm, sustain, cool].every((n) => Number.isFinite(n) && n >= 0))
            return null;
        const blocks = { warm, sustain, cool };
        const parsedHrTargets = (parsed === null || parsed === void 0 ? void 0 : parsed.hrTargets) == null
            ? null
            : parsePersistedHrTargetsForDay(parsed.hrTargets);
        const hrTargets = parsedHrTargets && persistedHrTargetsFitBlocks(parsedHrTargets, blocks)
            ? parsedHrTargets
            : null;
        return {
            blocks,
            hrTargets,
            resolvedPrescription: (_d = parseResolvedWorkoutPrescription(parsed === null || parsed === void 0 ? void 0 : parsed.resolvedPrescription)) !== null && _d !== void 0 ? _d : undefined,
            shadowPrescriptionEvaluation: (_e = parsePersonalizedPrescriptionEvaluation(parsed === null || parsed === void 0 ? void 0 : parsed.shadowPrescriptionEvaluation)) !== null && _e !== void 0 ? _e : undefined,
        };
    }
    catch {
        return null;
    }
}
function parseStoredAthleteFitnessSnapshot(raw) {
    var _a;
    if (!raw)
        return undefined;
    try {
        return (_a = parseAthleteFitnessSnapshot(JSON.parse(raw))) !== null && _a !== void 0 ? _a : undefined;
    }
    catch {
        return undefined;
    }
}
/** Total paused seconds including an open pause through `now`. */
export function totalPausedDurationSec(session, now = Date.now()) {
    let total = session.pausedDurationSec;
    if (session.paused && session.pauseWallStart != null) {
        total += Math.max(0, Math.floor((now - session.pauseWallStart) / 1000));
    }
    return total;
}
export function getEarlyCooldownElapsed(day, storage) {
    return parseEarlyCooldownElapsed(storageOrBrowser(storage).getItem(earlyCooldownKey(day)));
}
export function setEarlyCooldownElapsed(day, elapsedSec, storage) {
    if (getEarlyCooldownElapsed(day, storage) != null)
        return;
    if (!Number.isFinite(elapsedSec) || elapsedSec < 0)
        return;
    storageOrBrowser(storage).setItem(earlyCooldownKey(day), String(Math.floor(elapsedSec)));
}
export function getSession(day, storage) {
    const store = storageOrBrowser(storage);
    const athleteFitnessSnapshot = parseStoredAthleteFitnessSnapshot(store.getItem(athleteFitnessSnapshotKey(day)));
    const storedAthleteId = store.getItem(athleteIdKey(day));
    const athleteId = athleteFitnessSnapshot && storedAthleteId === athleteFitnessSnapshot.athleteId
        ? storedAthleteId
        : undefined;
    const persistedVo2Runtime = (() => {
        const raw = store.getItem(vo2ProtocolRuntimeKey(day));
        if (!raw)
            return readPersistedVo2ProtocolRuntime(null);
        let parsedVo2 = null;
        try {
            parsedVo2 = JSON.parse(raw);
        }
        catch {
            return readPersistedVo2ProtocolRuntime(null);
        }
        const persisted = readPersistedVo2ProtocolRuntime(parsedVo2);
        if (persisted.runtime || persisted.restartRequired)
            return persisted;
        const v3 = parseVo2ProtocolRuntimeV3(parsedVo2);
        if (v3) {
            return {
                runtime: v3,
                restartRequired: false,
                observedProtocolVersion: v3.plan.protocol_version,
            };
        }
        return persisted;
    })();
    const sessionId = store.getItem("session_id_" + day);
    const executionProvenance = readInProgressExecutionProvenance(day, store);
    const controlAuthority = resolveSessionControlAuthority(day, sessionId, persistedVo2Runtime.runtime !== null, store);
    return {
        startTime: store.getItem("start_" + day),
        sessionId,
        sessionStart: store.getItem("session_start_" + day),
        summaryEmitted: store.getItem("summary_emitted_" + day),
        paused: store.getItem("paused_" + day) === "true",
        pausedElapsed: parseInt(store.getItem("paused_elapsed_" + day) || "0", 10),
        pausedDurationSec: parseNonNegativeInt(store.getItem(pausedDurationKey(day))),
        pauseWallStart: parseOptionalWallMs(store.getItem(pauseWallStartKey(day))),
        earlyCooldownElapsed: parseEarlyCooldownElapsed(store.getItem(earlyCooldownKey(day))),
        activity: parseStoredActivity(store.getItem("activity_" + day)),
        athleteId,
        athleteFitnessSnapshot: athleteId ? athleteFitnessSnapshot : undefined,
        phasePlan: parsePhasePlan(store.getItem(phasePlanKey(day))),
        vo2ProtocolRuntime: persistedVo2Runtime.runtime,
        vo2ProtocolRestartRequired: persistedVo2Runtime.restartRequired,
        ...(persistedVo2Runtime.observedProtocolVersion != null && persistedVo2Runtime.restartRequired
            ? { blockedVo2ProtocolVersion: persistedVo2Runtime.observedProtocolVersion }
            : {}),
        executionProvenance: executionProvenance && executionProvenance.sessionId === sessionId ? executionProvenance : null,
        controlAuthority,
    };
}
export function startSession(day, startTime, sessionId, activity, storage, phasePlan, athleteFitnessSnapshotOverride, machineProvenanceOverride, controlMode) {
    var _a;
    const store = storageOrBrowser(storage);
    const previousSessionId = store.getItem("session_id_" + day);
    if (sessionId != null && controlMode && previousSessionId === sessionId && store.getItem(sessionControlModeKey(day)) != null) {
        // Validate a same-session retry before any session-owned state is cleared.
        freezeSessionControlMode(day, sessionId, controlMode, store);
    }
    store.removeItem(earlyCooldownKey(day));
    store.removeItem(pausedDurationKey(day));
    store.removeItem(pauseWallStartKey(day));
    store.removeItem("paused_" + day);
    store.removeItem("paused_elapsed_" + day);
    store.removeItem(phasePlanKey(day));
    store.removeItem(athleteIdKey(day));
    store.removeItem(athleteFitnessSnapshotKey(day));
    store.removeItem(legacyVo2ProtocolPlanKey(day));
    store.removeItem(vo2ProtocolRuntimeKey(day));
    store.removeItem(executionProvenanceKey(day));
    clearFrozenSessionControlMode(day, store);
    store.setItem("start_" + day, String(startTime));
    if (sessionId != null) {
        store.setItem("session_id_" + day, sessionId);
        store.setItem("session_start_" + day, String(startTime));
        store.setItem("summary_emitted_" + day, "false");
    }
    if (activity)
        store.setItem("activity_" + day, activity);
    else
        store.removeItem("activity_" + day);
    const athleteFitnessSnapshot = athleteFitnessSnapshotOverride !== null && athleteFitnessSnapshotOverride !== void 0 ? athleteFitnessSnapshotOverride : captureAthleteFitnessSnapshot(store);
    store.setItem(athleteIdKey(day), athleteFitnessSnapshot.athleteId);
    store.setItem(athleteFitnessSnapshotKey(day), JSON.stringify(athleteFitnessSnapshot));
    if (phasePlan === null || phasePlan === void 0 ? void 0 : phasePlan.blocks) {
        store.setItem(phasePlanKey(day), JSON.stringify({
            blocks: phasePlan.blocks,
            hrTargets: (_a = phasePlan.hrTargets) !== null && _a !== void 0 ? _a : null,
            resolvedPrescription: phasePlan.resolvedPrescription,
            shadowPrescriptionEvaluation: phasePlan.shadowPrescriptionEvaluation,
        }));
    }
    if (sessionId != null) {
        if (controlMode)
            freezeSessionControlMode(day, sessionId, controlMode, store);
        // Freeze provenance once, at start. Reload reads it back; finalization never re-reads selection.
        const evaluation = phasePlan === null || phasePlan === void 0 ? void 0 : phasePlan.shadowPrescriptionEvaluation;
        const calibrationIdentity = evaluation
            ? calibrationIdentityFromE1Snapshot(evaluation.athleteId, evaluation.fitnessEvidenceSnapshot)
            : null;
        writeInProgressExecutionProvenance(day, createInProgressExecutionProvenance(sessionId, machineProvenanceOverride !== null && machineProvenanceOverride !== void 0 ? machineProvenanceOverride : captureWorkoutMachineProvenance(activity, store), resolveWorkoutCalibrationMachine(calibrationIdentity, store)), store);
    }
}
export function pauseSession(day, elapsedSec, storage, now = Date.now()) {
    const store = storageOrBrowser(storage);
    store.setItem("paused_" + day, "true");
    store.setItem("paused_elapsed_" + day, String(elapsedSec));
    if (store.getItem(pauseWallStartKey(day)) == null) {
        store.setItem(pauseWallStartKey(day), String(now));
    }
}
export function resumeSession(day, storage, now = Date.now()) {
    const store = storageOrBrowser(storage);
    const pausedElapsed = parseInt(store.getItem("paused_elapsed_" + day) || "0", 10);
    const pauseWallStart = parseOptionalWallMs(store.getItem(pauseWallStartKey(day)));
    if (pauseWallStart != null) {
        const add = Math.max(0, Math.floor((now - pauseWallStart) / 1000));
        const prev = parseNonNegativeInt(store.getItem(pausedDurationKey(day)));
        store.setItem(pausedDurationKey(day), String(prev + add));
    }
    const newStart = now - pausedElapsed * 1000;
    store.setItem("start_" + day, String(newStart));
    store.removeItem("paused_" + day);
    store.removeItem("paused_elapsed_" + day);
    store.removeItem(pauseWallStartKey(day));
}
export function clearSession(day, storage) {
    const store = storageOrBrowser(storage);
    store.removeItem("start_" + day);
    store.removeItem("session_id_" + day);
    store.removeItem("session_start_" + day);
    store.removeItem("summary_emitted_" + day);
    store.removeItem("paused_" + day);
    store.removeItem("paused_elapsed_" + day);
    store.removeItem(pausedDurationKey(day));
    store.removeItem(pauseWallStartKey(day));
    store.removeItem(earlyCooldownKey(day));
    store.removeItem("activity_" + day);
    store.removeItem(phasePlanKey(day));
    store.removeItem(athleteIdKey(day));
    store.removeItem(athleteFitnessSnapshotKey(day));
    store.removeItem(executionProvenanceKey(day));
    clearFrozenSessionControlMode(day, store);
    store.removeItem(legacyVo2ProtocolPlanKey(day));
    store.removeItem(vo2ProtocolRuntimeKey(day));
}
export function persistVo2ProtocolRuntime(day, runtime, storage) {
    const valid = isVo2ProtocolRuntimeV3(runtime)
        ? isValidVo2ProtocolRuntimeV3(runtime)
        : isValidVo2ProtocolRuntime(runtime);
    if (!valid)
        return;
    storageOrBrowser(storage).setItem(vo2ProtocolRuntimeKey(day), JSON.stringify(runtime));
}
export function markSummaryEmitted(day) {
    localStorage.setItem("summary_emitted_" + day, "true");
}
export function isSessionStale(day) {
    const sessionStart = localStorage.getItem("session_start_" + day);
    if (!sessionStart)
        return true;
    const sessionAge = Date.now() - parseInt(sessionStart);
    return sessionAge > MAX_SESSION_AGE_MS;
}
