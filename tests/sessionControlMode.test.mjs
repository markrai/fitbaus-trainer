import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  freezeSessionControlMode,
  inspectFrozenSessionControlMode,
  isSessionControlMode,
  parseFrozenSessionControlMode,
  resolveSessionControlAuthority,
  SESSION_CONTROL_MODES,
  sessionControlModeKey,
} from "../dist/sessionControlMode.js";
import { getSession, persistVo2ProtocolRuntime, startSession } from "../dist/sessionStore.js";
import { buildVo2ProtocolPlan, createVo2ProtocolRuntime, VO2_WORKOUT_SELECTOR_ID } from "../dist/vo2Protocol.js";
import { controlModeForUserFacingWorkout } from "../dist/workoutLogic.js";
import { ACTUATION_ORIGINS } from "../dist/executionProvenance.js";
import { setSelectedMachine } from "../dist/machines/selection.js";
import {
  classifyRecommendationOrigin,
  recordMachineHeartRateSample,
  resetMachineGuidanceRuntime,
  updateMachineGuidanceRuntime,
} from "../dist/machines/runtime.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}

function authority(sessionId, mode, source = "frozen") {
  return { sessionId, mode, source };
}

function prospectiveInput(sessionId, heartRateBpm, holdResistance = 8) {
  return {
    sessionId,
    activity: "bike",
    phaseKind: "work",
    phaseId: "challenge:1",
    phaseDisplayName: "Fixed load",
    phaseElapsedSeconds: 120,
    phaseDurationSeconds: 300,
    workoutElapsedSeconds: 120,
    heartRateBpm,
    targetHeartRateMin: 120,
    targetHeartRateMax: 130,
    intent: "aerobic_base",
    holdResistance,
    holdCadenceRpm: 70,
    controlAuthority: authority(sessionId, "prospective_fixed_load"),
  };
}

function compatibilityWorkInput(sessionId, heartRateBpm, overrides = {}) {
  return {
    sessionId,
    activity: "bike",
    phaseKind: "work",
    phaseId: "sustain",
    phaseDisplayName: "Sustain",
    phaseElapsedSeconds: 200,
    phaseDurationSeconds: 600,
    workoutElapsedSeconds: 200,
    heartRateBpm,
    targetHeartRateMin: 120,
    targetHeartRateMax: 130,
    intent: "aerobic_base",
    ...overrides,
  };
}

function finalLegacyUpdate(bpm, explicit) {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  const sessionId = `legacy-${bpm}-${explicit ? "frozen" : "compat"}`;
  resetMachineGuidanceRuntime(sessionId);
  let update = null;
  for (let second = 0; second <= 100; second += 1) {
    recordMachineHeartRateSample(sessionId, second, bpm);
    update = updateMachineGuidanceRuntime(compatibilityWorkInput(sessionId, bpm, {
      phaseElapsedSeconds: second,
      workoutElapsedSeconds: second,
      ...(explicit ? { controlAuthority: authority(sessionId, "legacy_hr_control") } : {}),
    }), storage);
  }
  return update;
}

test("session control-mode v1 reader is strict", () => {
  const valid = { schemaVersion: 1, sessionId: "s-1", mode: "legacy_hr_control" };
  assert.deepEqual(parseFrozenSessionControlMode(valid), valid);
  for (const value of [
    { ...valid, schemaVersion: 2 },
    { ...valid, sessionId: "" },
    { ...valid, mode: "manual" },
    { ...valid, extra: true },
    null,
  ]) assert.equal(parseFrozenSessionControlMode(value), null);
});

test("same-session same-mode freeze is idempotent and a conflicting freeze is rejected", () => {
  const storage = memoryStorage();
  const first = freezeSessionControlMode("Monday", "s-1", "legacy_hr_control", storage);
  const retry = freezeSessionControlMode("Monday", "s-1", "legacy_hr_control", storage);
  assert.deepEqual(retry, first);
  assert.throws(
    () => freezeSessionControlMode("Monday", "s-1", "prospective_fixed_load", storage),
    /conflicting/
  );
  assert.deepEqual(inspectFrozenSessionControlMode("Monday", "s-1", storage), { status: "valid", record: first });
});

test("ordinary and VO2 starts freeze and reload their exact control modes", () => {
  const storage = memoryStorage();
  startSession("Monday", 1000, "ordinary-1", "bike", storage, null, undefined, undefined, "legacy_hr_control");
  assert.deepEqual(getSession("Monday", storage).controlAuthority,
    authority("ordinary-1", "legacy_hr_control"));

  startSession(VO2_WORKOUT_SELECTOR_ID, 2000, "vo2-1", "bike", storage, null, undefined, undefined, "vo2_protocol");
  assert.deepEqual(getSession(VO2_WORKOUT_SELECTOR_ID, storage).controlAuthority,
    authority("vo2-1", "vo2_protocol"));
});

test("startSession rejects a same-session conflicting mode before changing session state", () => {
  const storage = memoryStorage();
  startSession("Tuesday", 1000, "same", "bike", storage, null, undefined, undefined, "legacy_hr_control");
  assert.throws(
    () => startSession("Tuesday", 2000, "same", "bike", storage, null, undefined, undefined, "prospective_fixed_load"),
    /conflicting/
  );
  assert.equal(getSession("Tuesday", storage).startTime, "1000");
  assert.equal(getSession("Tuesday", storage).controlAuthority.mode, "legacy_hr_control");
});

test("historical missing-mode compatibility preserves ordinary and VO2 behavior without inventing prospective", () => {
  const ordinary = memoryStorage();
  startSession("Wednesday", 1000, "old-ordinary", "bike", ordinary);
  assert.deepEqual(getSession("Wednesday", ordinary).controlAuthority,
    authority("old-ordinary", "legacy_hr_control", "historical_compatibility"));

  const vo2 = memoryStorage();
  startSession(VO2_WORKOUT_SELECTOR_ID, 1000, "old-vo2", "bike", vo2);
  persistVo2ProtocolRuntime(
    VO2_WORKOUT_SELECTOR_ID,
    createVo2ProtocolRuntime(buildVo2ProtocolPlan(), { age_years: 40, weight_kg: 75 }),
    vo2
  );
  assert.deepEqual(getSession(VO2_WORKOUT_SELECTOR_ID, vo2).controlAuthority,
    authority("old-vo2", "vo2_protocol", "historical_compatibility"));
  assert.notEqual(getSession("Wednesday", ordinary).controlAuthority.mode, "prospective_fixed_load");
  assert.notEqual(getSession(VO2_WORKOUT_SELECTOR_ID, vo2).controlAuthority.mode, "prospective_fixed_load");
});

test("a stale, mismatched, or malformed mode sidecar fails closed", () => {
  for (const raw of [
    JSON.stringify({ schemaVersion: 1, sessionId: "other", mode: "prospective_fixed_load" }),
    JSON.stringify({ schemaVersion: 1, sessionId: "active", mode: "prospective_fixed_load", extra: true }),
    "not-json",
  ]) {
    const storage = memoryStorage();
    startSession("Thursday", 1000, "active", "bike", storage);
    storage.setItem(sessionControlModeKey("Thursday"), raw);
    assert.equal(getSession("Thursday", storage).controlAuthority, null);
  }
});

test("prospective fixed load holds R8 for low, high, and in-band HR", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  for (const [index, bpm] of [80, 125, 190].entries()) {
    const sessionId = `fixed-${index}`;
    resetMachineGuidanceRuntime(sessionId);
    const update = updateMachineGuidanceRuntime(prospectiveInput(sessionId, bpm), storage);
    assert.ok(update);
    assert.equal(update.guidance.resistance, 8);
    assert.equal(update.actuationOrigin, "scripted_phase_program");
  }
});

test("prospective fixed load fails closed for missing/invalid targets and mismatched authority", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  for (const target of [undefined, 0, 7.5, 16, Number.NaN]) {
    const sessionId = `invalid-${String(target)}`;
    resetMachineGuidanceRuntime(sessionId);
    const input = prospectiveInput(sessionId, 80, target);
    if (target === undefined) delete input.holdResistance;
    assert.equal(updateMachineGuidanceRuntime(input, storage), null);
  }
  const mismatched = prospectiveInput("active", 80);
  mismatched.controlAuthority = authority("stale", "prospective_fixed_load");
  assert.equal(updateMachineGuidanceRuntime(mismatched, storage), null);
  const inferred = prospectiveInput("active", 80);
  inferred.controlAuthority = authority("active", "prospective_fixed_load", "historical_compatibility");
  assert.equal(updateMachineGuidanceRuntime(inferred, storage), null);
  assert.equal(updateMachineGuidanceRuntime({ ...prospectiveInput("active", 80), controlAuthority: null }, storage), null);
});

test("explicit frozen legacy authority preserves low, in-band, and high-HR controller behavior", () => {
  for (const bpm of [80, 125, 190]) {
    assert.deepEqual(finalLegacyUpdate(bpm, true), finalLegacyUpdate(bpm, false));
  }
});

test("explicit frozen VO2 authority preserves the existing fixed-hold behavior", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  const evaluate = (sessionId, explicit) => {
    resetMachineGuidanceRuntime(sessionId);
    return updateMachineGuidanceRuntime(compatibilityWorkInput(sessionId, 190, {
      holdResistance: 10,
      holdCadenceRpm: 70,
      ...(explicit ? { controlAuthority: authority(sessionId, "vo2_protocol") } : {}),
    }), storage);
  };
  const frozen = evaluate("vo2-explicit", true);
  const historical = evaluate("vo2-historical", false);
  assert.ok(frozen);
  assert.ok(historical);
  assert.equal(frozen.actuationOrigin, "vo2_protocol_fixed_resistance");
  assert.deepEqual(frozen, historical);
  resetMachineGuidanceRuntime("vo2-no-hold");
  assert.equal(updateMachineGuidanceRuntime(compatibilityWorkInput("vo2-no-hold", 190, {
    controlAuthority: authority("vo2-no-hold", "vo2_protocol"),
  }), storage), null);
});

test("origin classification follows frozen authority without widening provenance v1", () => {
  const work = { phaseKind: "work", guidancePhaseChanged: false };
  assert.equal(classifyRecommendationOrigin({ ...work, controlMode: "legacy_hr_control" }), "automatic_hr_control");
  assert.equal(classifyRecommendationOrigin({ ...work, controlMode: "legacy_hr_control", holdResistance: 8 }),
    "scripted_phase_program");
  assert.equal(classifyRecommendationOrigin({ ...work, controlMode: "vo2_protocol", holdResistance: 8 }),
    "vo2_protocol_fixed_resistance");
  assert.equal(classifyRecommendationOrigin({ ...work, controlMode: "prospective_fixed_load", holdResistance: 8 }),
    "scripted_phase_program");
  assert.equal(ACTUATION_ORIGINS.includes("prospective_fixed_load"), false);
});

test("prospective dispatch precedes learned-start and HR-timing lookup sites", async () => {
  const source = await readFile(new URL("../src/machines/runtime.ts", import.meta.url), "utf8");
  const branch = source.indexOf("const prospectiveFixedLoad");
  assert.ok(branch >= 0);
  assert.ok(branch < source.indexOf("lookupLearnedWorkStart(", branch));
  assert.ok(branch < source.indexOf("lookupPersonalizedTiming(", branch));
  assert.match(source, /!prospectiveFixedLoad && input\.phaseKind === "work"/);
});

test("no current product workout entry point can select prospective mode", () => {
  assert.equal(controlModeForUserFacingWorkout("Monday"), "legacy_hr_control");
  assert.equal(controlModeForUserFacingWorkout(VO2_WORKOUT_SELECTOR_ID), "vo2_protocol");
  for (const selector of ["Monday", "Tuesday", VO2_WORKOUT_SELECTOR_ID]) {
    assert.notEqual(controlModeForUserFacingWorkout(selector), "prospective_fixed_load");
  }
});

// ---------------------------------------------------------------------------
// F0: manual_freestyle_ride — session control mode and machine guidance tests
// ---------------------------------------------------------------------------
// Note: SESSION_CONTROL_MODES, isSessionControlMode, freezeSessionControlMode,
// parseFrozenSessionControlMode, resolveSessionControlAuthority, and all machine
// runtime helpers are already imported at the top of this file.

// --- Parsing and schema ---

test("manual_freestyle_ride is a recognized SessionControlMode", () => {
  assert.ok(SESSION_CONTROL_MODES.includes("manual_freestyle_ride"));
  assert.ok(isSessionControlMode("manual_freestyle_ride"));
});

test("parseFrozenSessionControlMode accepts manual_freestyle_ride", () => {
  const record = parseFrozenSessionControlMode({
    schemaVersion: 1,
    sessionId: "fs-session-1",
    mode: "manual_freestyle_ride",
  });
  assert.ok(record);
  assert.equal(record.mode, "manual_freestyle_ride");
  assert.equal(record.sessionId, "fs-session-1");
});

test("parseFrozenSessionControlMode rejects unknown modes", () => {
  assert.equal(parseFrozenSessionControlMode({
    schemaVersion: 1,
    sessionId: "fs-session-1",
    mode: "unknown_future_mode",
  }), null);
});

// --- Freeze / idempotency ---

test("freezeSessionControlMode freezes manual_freestyle_ride and is idempotent", () => {
  const storage = memoryStorage();
  const r1 = freezeSessionControlMode("freestyle-day", "fs-001", "manual_freestyle_ride", storage);
  assert.equal(r1.mode, "manual_freestyle_ride");
  // Idempotent same-value retry
  const r2 = freezeSessionControlMode("freestyle-day", "fs-001", "manual_freestyle_ride", storage);
  assert.deepEqual(r1, r2);
});

test("freezeSessionControlMode rejects conflicting mode on same day", () => {
  const storage = memoryStorage();
  freezeSessionControlMode("freestyle-day", "fs-001", "manual_freestyle_ride", storage);
  assert.throws(
    () => freezeSessionControlMode("freestyle-day", "fs-001", "legacy_hr_control", storage),
    /conflicting/
  );
});

test("freezeSessionControlMode rejects conflicting session on same day", () => {
  const storage = memoryStorage();
  freezeSessionControlMode("freestyle-day", "fs-001", "manual_freestyle_ride", storage);
  assert.throws(
    () => freezeSessionControlMode("freestyle-day", "fs-999", "manual_freestyle_ride", storage),
    /conflicting/
  );
});

// --- Historical compatibility: Freestyle never inferred ---

test("resolveSessionControlAuthority never infers manual_freestyle_ride from missing record", () => {
  const storage = memoryStorage(); // no stored record
  const authority = resolveSessionControlAuthority("freestyle-day", "fs-001", false, storage);
  // Returns historical_compatibility fallback, which must be legacy_hr_control or vo2_protocol
  assert.ok(authority);
  assert.notEqual(authority.mode, "manual_freestyle_ride");
  assert.equal(authority.source, "historical_compatibility");
});

test("resolveSessionControlAuthority returns frozen freestyle when record is valid", () => {
  const storage = memoryStorage();
  freezeSessionControlMode("fs-day", "fs-abc", "manual_freestyle_ride", storage);
  const authority = resolveSessionControlAuthority("fs-day", "fs-abc", false, storage);
  assert.ok(authority);
  assert.equal(authority.mode, "manual_freestyle_ride");
  assert.equal(authority.source, "frozen");
  assert.equal(authority.sessionId, "fs-abc");
});

// --- Machine guidance bypass ---

test("updateMachineGuidanceRuntime returns null for frozen manual_freestyle_ride authority", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("fs-machine-test");
  const result = updateMachineGuidanceRuntime({
    sessionId: "fs-machine-test",
    activity: "bike",
    phaseId: "p1",
    phaseKind: "work",
    workoutElapsedSeconds: 60,
    controlAuthority: authority("fs-machine-test", "manual_freestyle_ride", "frozen"),
  }, storage);
  assert.equal(result, null, "Freestyle must emit no guidance update");
});

test("updateMachineGuidanceRuntime returns null for freestyle even if holdResistance is provided", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("fs-machine-test-hold");
  const result = updateMachineGuidanceRuntime({
    sessionId: "fs-machine-test-hold",
    activity: "bike",
    phaseId: "p1",
    phaseKind: "work",
    workoutElapsedSeconds: 10,
    holdResistance: 8,
    controlAuthority: authority("fs-machine-test-hold", "manual_freestyle_ride", "frozen"),
  }, storage);
  assert.equal(result, null, "Freestyle with holdResistance must still produce no guidance");
});

test("updateMachineGuidanceRuntime returns null for freestyle with historical_compatibility source", () => {
  // historical_compatibility can never produce manual_freestyle_ride (resolveSessionControlAuthority
  // never infers it), but if a caller somehow passes one it must be rejected not acted upon.
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("fs-historical");
  const result = updateMachineGuidanceRuntime({
    sessionId: "fs-historical",
    activity: "bike",
    phaseId: "p1",
    phaseKind: "work",
    workoutElapsedSeconds: 10,
    controlAuthority: authority("fs-historical", "manual_freestyle_ride", "historical_compatibility"),
  }, storage);
  assert.equal(result, null, "Freestyle with non-frozen source must produce no guidance");
});

test("updateMachineGuidanceRuntime still produces guidance for legacy_hr_control after freestyle reset", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  // First: freestyle session produces no guidance
  resetMachineGuidanceRuntime("fs-then-legacy");
  assert.equal(updateMachineGuidanceRuntime({
    sessionId: "fs-then-legacy",
    activity: "bike",
    phaseId: "p1",
    phaseKind: "work",
    workoutElapsedSeconds: 10,
    controlAuthority: authority("fs-then-legacy", "manual_freestyle_ride", "frozen"),
  }, storage), null);
  // Then: a new legacy session must still work
  resetMachineGuidanceRuntime("legacy-after-fs");
  recordMachineHeartRateSample("legacy-after-fs", 140, 20);
  const result = updateMachineGuidanceRuntime({
    sessionId: "legacy-after-fs",
    activity: "bike",
    phaseId: "p2",
    phaseKind: "work",
    workoutElapsedSeconds: 20,
    heartRateBpm: 140,
    controlAuthority: authority("legacy-after-fs", "legacy_hr_control", "frozen"),
  }, storage);
  assert.ok(result, "Legacy session after freestyle must still produce guidance");
});

// --- controlModeForUserFacingWorkout never returns manual_freestyle_ride ---

test("no user-facing workout selector produces manual_freestyle_ride", () => {
  for (const selector of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", VO2_WORKOUT_SELECTOR_ID]) {
    assert.notEqual(controlModeForUserFacingWorkout(selector), "manual_freestyle_ride",
      `${selector} must not map to manual_freestyle_ride`);
  }
});

// --- Source code structural test: freestyle bypass precedes learned-start lookup ---

test("freestyle bypass guard precedes learned-start and HR-timing in runtime.ts", async () => {
  const source = await readFile(new URL("../src/machines/runtime.ts", import.meta.url), "utf8");
  const freestyleGuard = source.indexOf("manual_freestyle_ride");
  const prospectiveBranch = source.indexOf("const prospectiveFixedLoad");
  const learnedStart = source.indexOf("lookupLearnedWorkStart(");
  assert.ok(freestyleGuard >= 0, "Freestyle guard must exist in runtime.ts");
  assert.ok(freestyleGuard < prospectiveBranch,
    "Freestyle guard must appear before prospectiveFixedLoad branch");
  assert.ok(freestyleGuard < learnedStart,
    "Freestyle guard must appear before lookupLearnedWorkStart call site");
});
