import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPhase,
  planEarlyCooldownTransition,
  requestEarlyCooldown,
} from "../dist/workoutLogic.js";
import {
  clearSession,
  getEarlyCooldownElapsed,
  getSession,
  pauseSession,
  setEarlyCooldownElapsed,
  startSession,
} from "../dist/sessionStore.js";
import {
  resetMachineGuidanceRuntime,
  updateMachineGuidanceRuntime,
} from "../dist/machines/runtime.js";
import { setSelectedMachine } from "../dist/machines/selection.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const blocks = { warm: 5, sustain: 25, cool: 5 };
const naturalCooldownStart = (blocks.warm + blocks.sustain) * 60;
const coolSeconds = blocks.cool * 60;

if (typeof globalThis.window === "undefined") {
  globalThis.window = {};
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function modalActionButtons(html) {
  const actions = html.match(/id="cancelModalBg"[\s\S]*?<div class="modal-actions[^"]*">([\s\S]*?)<\/div>/);
  assert.ok(actions, "End workout modal actions are missing");
  return [...actions[1].matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map((match) => ({
    attrs: match[1],
    label: match[2].trim(),
  }));
}

function functionBody(source, name) {
  const match = source.match(new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `${name} is missing`);
  return match[0];
}

test("End workout modal exposes Cooldown, Yes end and save, and Keep going", async () => {
  const html = await readFile(path.join(rootDir, "index.html"), "utf8");
  const buttons = modalActionButtons(html);
  assert.deepEqual(
    buttons.map((button) => button.label),
    ["Cooldown", "Reached my limit", "Yes, end and save", "Keep going"]
  );
  assert.match(buttons[0].attrs, /confirmEarlyCooldownWorkout\(\)/);
  assert.match(buttons[1].attrs, /confirmVo2LimitReached\(\)/);
  assert.match(buttons[1].attrs, /display:\s*none/);
  assert.match(buttons[2].attrs, /confirmCancelWorkout\(\)/);
  assert.match(buttons[3].attrs, /closeCancelModal\(\)/);
  assert.match(html, /You can cool down first, end and save now, or keep going\./);
  assert.doesNotMatch(html, /marked as cancelled/);

  const ui = await readFile(path.join(rootDir, "src", "uiControls.ts"), "utf8");
  assert.match(functionBody(ui, "confirmCancelWorkout"), /restartWorkout\(\)/);
  assert.match(functionBody(ui, "closeCancelModal"), /display = "none"/);
  assert.doesNotMatch(functionBody(ui, "closeCancelModal"), /requestEarlyCooldown/);
  assert.match(functionBody(ui, "confirmEarlyCooldownWorkout"), /requestEarlyCooldown\(\)/);
  assert.doesNotMatch(functionBody(ui, "confirmEarlyCooldownWorkout"), /restartWorkout/);
  assert.match(functionBody(ui, "confirmVo2LimitReached"), /requestVo2LimitReached\(\)/);
  assert.doesNotMatch(functionBody(ui, "confirmVo2LimitReached"), /restartWorkout/);
});

test("paused Early Cooldown persists actual elapsed and resumes without seeking", () => {
  const storage = memoryStorage();
  const now = 1_700_000_000_000;
  const originalStart = now - 480 * 1000;
  startSession("Monday", originalStart, "session-early", "bike", storage);
  pauseSession("Monday", 480, storage);

  const decision = requestEarlyCooldown("Monday", { storage, now, blocks });
  assert.equal(decision.type, "enter-early-cooldown");
  assert.equal(decision.elapsedSec, 480);

  const session = getSession("Monday", storage);
  assert.equal(session.earlyCooldownElapsed, 480);
  assert.equal(session.paused, false);
  assert.equal(storage.getItem("paused_elapsed_Monday"), null);
  assert.equal(session.startTime, String(now - 480 * 1000));
  assert.equal(session.sessionId, "session-early");
  assert.equal(session.sessionStart, String(originalStart));
  assert.equal(session.summaryEmitted, "false");
  assert.equal(session.activity, "bike");

  const elapsed = Math.floor((now - parseInt(session.startTime, 10)) / 1000);
  assert.equal(elapsed, 480);
  assert.notEqual(elapsed, naturalCooldownStart);

  const phase = getPhase(elapsed, blocks, session.earlyCooldownElapsed);
  assert.equal(phase.phase, "Cool-Down");
  assert.equal(phase.kind, "cooldown");
  assert.equal(phase.phaseId, "cooldown");
  assert.equal(phase.phaseElapsedSeconds, 0);
  assert.equal(phase.done, false);
});

test("Early Cooldown does not jump elapsed to the natural cooldown boundary", () => {
  const storage = memoryStorage();
  const now = 2_000_000_000_000;
  startSession("Tuesday", now - 480 * 1000, "session-no-jump", "bike", storage);
  pauseSession("Tuesday", 480, storage);
  requestEarlyCooldown("Tuesday", { storage, now, blocks });
  const session = getSession("Tuesday", storage);
  const elapsed = Math.floor((now - parseInt(session.startTime, 10)) / 1000);
  assert.equal(elapsed, 480);
  assert.notEqual(elapsed, (blocks.warm + blocks.sustain) * 60);
  assert.notEqual(session.earlyCooldownElapsed, naturalCooldownStart);
});

test("early-entered cooldown progresses by actual elapsed and completes after cool duration", () => {
  const marker = 480;
  assert.equal(getPhase(480, blocks, marker).phaseElapsedSeconds, 0);
  assert.equal(getPhase(540, blocks, marker).phase, "Cool-Down");
  assert.equal(getPhase(540, blocks, marker).phaseElapsedSeconds, 60);
  const completed = getPhase(marker + coolSeconds, blocks, marker);
  assert.equal(completed.phase, "Completed");
  assert.equal(completed.kind, "completed");
  assert.equal(completed.done, true);
});

test("Early Cooldown skips remaining warm-up, sustain, and interval phases", () => {
  const marker = 480;
  for (let elapsed = marker; elapsed < marker + coolSeconds; elapsed += 30) {
    const phase = getPhase(elapsed, blocks, marker);
    assert.equal(phase.phase, "Cool-Down");
    assert.equal(phase.phaseId, "cooldown");
    assert.notEqual(phase.phase, "Warm-Up");
    assert.notEqual(phase.phase, "Sustain");
    assert.equal(phase.phaseId.startsWith("cycle:"), false);
    assert.equal(phase.phaseId.startsWith("sequence:"), false);
  }
});

test("natural workouts without a marker still enter cooldown at warm+sustain", () => {
  assert.equal(getPhase(0, blocks).phase, "Warm-Up");
  assert.equal(getPhase(blocks.warm * 60 - 1, blocks).phase, "Warm-Up");
  const sustain = getPhase(blocks.warm * 60, blocks);
  assert.equal(sustain.phase, "Sustain");
  assert.equal(sustain.phaseId, "sustain");
  const cooldown = getPhase(naturalCooldownStart, blocks);
  assert.equal(cooldown.phase, "Cool-Down");
  assert.equal(cooldown.kind, "cooldown");
  assert.equal(cooldown.phaseId, "cooldown");
  assert.equal(cooldown.phaseElapsedSeconds, 0);
  const completed = getPhase(naturalCooldownStart + coolSeconds, blocks);
  assert.equal(completed.done, true);
  assert.equal(completed.phase, "Completed");
});

test("Keep going leaves a paused workout unchanged", () => {
  const storage = memoryStorage();
  const now = 1_800_000_000_000;
  startSession("Wednesday", now - 480 * 1000, "session-keep", "bike", storage);
  pauseSession("Wednesday", 480, storage);
  const before = getSession("Wednesday", storage);
  const phaseBefore = getPhase(480, blocks, before.earlyCooldownElapsed);
  assert.equal(before.paused, true);
  assert.equal(before.earlyCooldownElapsed, null);
  assert.equal(phaseBefore.phase, "Sustain");
  const after = getSession("Wednesday", storage);
  assert.equal(after.paused, true);
  assert.equal(after.pausedElapsed, 480);
  assert.equal(after.earlyCooldownElapsed, null);
  assert.equal(after.sessionId, "session-keep");
  assert.equal(getPhase(480, blocks, after.earlyCooldownElapsed).phase, "Sustain");
});

test("already in natural cooldown does not create or rewind a marker", () => {
  const storage = memoryStorage();
  const now = 1_900_000_000_000;
  const elapsed = naturalCooldownStart + 60;
  startSession("Thursday", now - elapsed * 1000, "session-natural-cool", "bike", storage);
  pauseSession("Thursday", elapsed, storage);
  const decision = requestEarlyCooldown("Thursday", { storage, now, blocks });
  assert.equal(decision.type, "already-in-cooldown");
  assert.equal(getEarlyCooldownElapsed("Thursday", storage), null);
  const session = getSession("Thursday", storage);
  assert.equal(session.paused, false);
  const reconstructed = Math.floor((now - parseInt(session.startTime, 10)) / 1000);
  assert.equal(reconstructed, elapsed);
  const phase = getPhase(reconstructed, blocks, session.earlyCooldownElapsed);
  assert.equal(phase.kind, "cooldown");
  assert.equal(phase.phaseElapsedSeconds, 60);
});

test("repeated Early Cooldown keeps the original marker and phase elapsed", () => {
  const storage = memoryStorage();
  const firstNow = 2_100_000_000_000;
  startSession("Friday", firstNow - 480 * 1000, "session-repeat", "bike", storage);
  pauseSession("Friday", 480, storage);
  assert.equal(requestEarlyCooldown("Friday", { storage, now: firstNow, blocks }).type, "enter-early-cooldown");

  const later = firstNow + 60 * 1000;
  const again = requestEarlyCooldown("Friday", { storage, now: later, blocks });
  assert.equal(again.type, "already-in-cooldown");
  assert.equal(getEarlyCooldownElapsed("Friday", storage), 480);
  const session = getSession("Friday", storage);
  const elapsed = Math.floor((later - parseInt(session.startTime, 10)) / 1000);
  assert.equal(elapsed, 540);
  assert.equal(getPhase(elapsed, blocks, session.earlyCooldownElapsed).phaseElapsedSeconds, 60);
});

test("workouts without cooldown are unavailable and leave session untouched", () => {
  const storage = memoryStorage();
  const now = 2_200_000_000_000;
  startSession("Saturday", now - 120 * 1000, "session-no-cool", "bike", storage);
  pauseSession("Saturday", 120, storage);
  const noCool = { warm: 5, sustain: 25, cool: 0 };
  const decision = requestEarlyCooldown("Saturday", { storage, now, blocks: noCool });
  assert.equal(decision.type, "unavailable");
  const session = getSession("Saturday", storage);
  assert.equal(session.earlyCooldownElapsed, null);
  assert.equal(session.paused, true);
  assert.equal(session.pausedElapsed, 120);
  assert.equal(session.startTime, String(now - 120 * 1000));
});

test("missing plan or session is unavailable", () => {
  assert.equal(planEarlyCooldownTransition({
    blocks: null,
    hasSession: true,
    elapsedSec: 120,
    paused: true,
  }).type, "unavailable");
  assert.equal(planEarlyCooldownTransition({
    blocks,
    hasSession: false,
    elapsedSec: 120,
    paused: false,
  }).type, "unavailable");
  const storage = memoryStorage();
  const decision = requestEarlyCooldown("Sunday", { storage, now: Date.now(), blocks });
  assert.equal(decision.type, "unavailable");
  assert.equal(getEarlyCooldownElapsed("Sunday", storage), null);
});

test("reloading persisted Early Cooldown reconstructs Cool-Down from the marker", () => {
  const now = 2_300_000_000_000;
  const start = now - 540 * 1000;
  const storage = memoryStorage({
    start_Monday: String(start),
    session_id_Monday: "session-reload",
    session_start_Monday: String(start - 60 * 1000),
    summary_emitted_Monday: "false",
    activity_Monday: "bike",
    early_cooldown_elapsed_Monday: "480",
  });
  const session = getSession("Monday", storage);
  assert.equal(session.earlyCooldownElapsed, 480);
  assert.equal(session.sessionId, "session-reload");
  const elapsed = Math.floor((now - parseInt(session.startTime, 10)) / 1000);
  assert.equal(elapsed, 540);
  const phase = getPhase(elapsed, blocks, session.earlyCooldownElapsed);
  assert.equal(phase.phase, "Cool-Down");
  assert.equal(phase.phaseElapsedSeconds, 60);
});

test("Early Cooldown preserves session identity and does not clear session state", () => {
  const storage = memoryStorage();
  const now = 2_400_000_000_000;
  startSession("Monday", now - 480 * 1000, "session-preserve", "bike", storage);
  pauseSession("Monday", 480, storage);
  const hrKey = "hr_samples:session-preserve";
  const hrState = JSON.stringify([
    { session_id: "session-preserve", timestamp_sec: 478, hr: 148 },
    { session_id: "session-preserve", timestamp_sec: 479, hr: 150 },
    { session_id: "session-preserve", timestamp_sec: 480, hr: 151 },
  ]);
  storage.setItem(hrKey, hrState);
  const hrBefore = storage.getItem(hrKey);
  requestEarlyCooldown("Monday", { storage, now, blocks });
  const session = getSession("Monday", storage);
  assert.equal(session.sessionId, "session-preserve");
  assert.equal(session.sessionStart, String(now - 480 * 1000));
  assert.equal(session.summaryEmitted, "false");
  assert.equal(session.activity, "bike");
  assert.ok(session.startTime);
  assert.equal(getEarlyCooldownElapsed("Monday", storage), 480);
  assert.equal(storage.getItem(hrKey), hrBefore);
  assert.equal(storage.getItem(hrKey), hrState);
  clearSession("Monday", storage);
  assert.equal(getEarlyCooldownElapsed("Monday", storage), null);
  assert.equal(getSession("Monday", storage).sessionId, null);
  assert.equal(storage.getItem(hrKey), hrState);
});

test("setEarlyCooldownElapsed is idempotent", () => {
  const storage = memoryStorage();
  setEarlyCooldownElapsed("Monday", 480, storage);
  setEarlyCooldownElapsed("Monday", 900, storage);
  assert.equal(getEarlyCooldownElapsed("Monday", storage), 480);
});

test("elapsed below a malformed future marker uses normal phase resolution", () => {
  const phase = getPhase(120, blocks, 480);
  assert.equal(phase.phase, "Warm-Up");
  assert.equal(phase.phaseElapsedSeconds, 120);
});

test("machine runtime still applies ProForm cooldown guidance on phaseId cooldown", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("session-machine");
  const work = updateMachineGuidanceRuntime({
    sessionId: "session-machine",
    activity: "bike",
    phaseKind: "work",
    phaseId: "sustain",
    phaseDisplayName: "Workout",
    phaseElapsedSeconds: 180,
    phaseDurationSeconds: 1500,
    workoutElapsedSeconds: 480,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
  }, storage);
  assert.ok(work);
  const cooldown = updateMachineGuidanceRuntime({
    sessionId: "session-machine",
    activity: "bike",
    phaseKind: "cooldown",
    phaseId: "cooldown",
    phaseDisplayName: "Cool-Down",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 300,
    workoutElapsedSeconds: 480,
    targetHeartRateMin: 0,
    targetHeartRateMax: 114,
  }, storage);
  assert.equal(cooldown?.phaseChanged, true);
  assert.equal(cooldown?.guidance.reason, "Conservative cooldown");
  assert.equal(cooldown?.guidance.resistance, 2);
  assert.equal(cooldown?.guidance.cadenceRpm, 63);
});
