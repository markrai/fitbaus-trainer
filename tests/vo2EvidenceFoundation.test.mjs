import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import {
  actualElapsedSeconds,
  activeElapsedSeconds,
  adjustedBlockLengths,
  capturePhasePlanSnapshot,
  getPhase,
  requestEarlyCooldown,
  workoutRelativeHrSample,
} from "../dist/workoutLogic.js";
import {
  getSession,
  pauseSession,
  resumeSession,
  startSession,
  totalPausedDurationSec,
} from "../dist/sessionStore.js";
import {
  buildVo2Evidence,
  buildVo2EvidenceHr,
  deriveVo2EvidencePhases,
} from "../dist/vo2Evidence.js";
import { VO2_EVIDENCE_SCHEMA_VERSION } from "../dist/types.js";
import {
  getAllWorkoutSummaries,
  resetWorkoutStorageForTests,
  storeWorkoutSummary,
} from "../dist/workoutStorage.js";
import { getHrTargets, getPlan } from "../dist/workoutData.js";

const blocks = { warm: 5, sustain: 25, cool: 5 };

if (typeof globalThis.window === "undefined") {
  globalThis.window = {};
}
globalThis.window.getSelectedDay = () => "Monday";

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

test("active clock advances uninterrupted", () => {
  const start = 3_000_000_000_000;
  const sessionStart = String(start);
  assert.equal(activeElapsedSeconds(sessionStart, false, 0, start + 10_000), 10);
  assert.equal(actualElapsedSeconds(sessionStart, false, 0, start + 90_000), 90);
});

test("pause freezes active elapsed", () => {
  const start = 3_000_000_100_000;
  const pauseAt = start + 480_000;
  assert.equal(activeElapsedSeconds(String(start), true, 480, pauseAt + 60_000), 480);
});

test("resume continues without rewind", () => {
  const storage = memoryStorage();
  const start = 3_000_000_200_000;
  const pauseNow = start + 480_000;
  const resumeNow = pauseNow + 45_000;
  startSession("Monday", start, "clock-resume", "bike", storage);
  pauseSession("Monday", 480, storage, pauseNow);
  resumeSession("Monday", storage, resumeNow);
  const session = getSession("Monday", storage);
  assert.equal(activeElapsedSeconds(session.startTime, false, 0, resumeNow), 480);
  assert.equal(activeElapsedSeconds(session.startTime, false, 0, resumeNow + 5_000), 485);
});

test("multiple pause/resume cycles remain monotonic", () => {
  const storage = memoryStorage();
  const start = 3_000_000_300_000;
  startSession("Tuesday", start, "clock-multi", "bike", storage);
  const marks = [];
  let now = start + 100_000;
  marks.push(activeElapsedSeconds(getSession("Tuesday", storage).startTime, false, 0, now));
  pauseSession("Tuesday", 100, storage, now);
  now += 30_000;
  resumeSession("Tuesday", storage, now);
  now += 50_000;
  marks.push(activeElapsedSeconds(getSession("Tuesday", storage).startTime, false, 0, now));
  pauseSession("Tuesday", 150, storage, now);
  now += 20_000;
  resumeSession("Tuesday", storage, now);
  now += 10_000;
  marks.push(activeElapsedSeconds(getSession("Tuesday", storage).startTime, false, 0, now));
  assert.deepEqual(marks, [100, 150, 160]);
  for (let i = 1; i < marks.length; i++) {
    assert.ok(marks[i] >= marks[i - 1]);
  }
});

test("final active duration excludes paused duration", () => {
  const storage = memoryStorage();
  const start = 3_000_000_400_000;
  startSession("Wednesday", start, "clock-paused-total", "bike", storage);
  const pauseNow = start + 200_000;
  const resumeNow = pauseNow + 90_000;
  const endNow = resumeNow + 100_000;
  pauseSession("Wednesday", 200, storage, pauseNow);
  resumeSession("Wednesday", storage, resumeNow);
  const session = getSession("Wednesday", storage);
  assert.equal(activeElapsedSeconds(session.startTime, false, 0, endNow), 300);
  assert.equal(totalPausedDurationSec(session, endNow), 90);
  assert.equal(session.pausedDurationSec, 90);
});

test("active HR evidence timestamps are monotonic and pause-safe", () => {
  const storage = memoryStorage();
  const start = 3_000_000_500_000;
  startSession("Thursday", start, "hr-mono", "bike", storage);
  const timestamps = [];
  for (let t = 0; t <= 5; t++) {
    const sample = workoutRelativeHrSample(getSession("Thursday", storage), start + t * 1000, timestamps.at(-1));
    if (sample) timestamps.push(sample.elapsedSec);
  }
  pauseSession("Thursday", 5, storage, start + 5_000);
  assert.equal(workoutRelativeHrSample(getSession("Thursday", storage), start + 20_000), null);
  resumeSession("Thursday", storage, start + 35_000);
  const resumed = getSession("Thursday", storage);
  assert.equal(workoutRelativeHrSample(resumed, start + 35_000, 5), null);
  const next = workoutRelativeHrSample(resumed, start + 36_000, 5);
  assert.deepEqual(next, { elapsedSec: 6 });
  timestamps.push(next.elapsedSec);
  for (let i = 1; i < timestamps.length; i++) {
    assert.ok(timestamps[i] > timestamps[i - 1]);
  }
});

test("pause-era HR cannot be mistaken for active stage HR", () => {
  const session = {
    startTime: String(3_000_000_600_000),
    sessionId: "pause-hr",
    paused: true,
    pausedElapsed: 400,
  };
  assert.equal(workoutRelativeHrSample(session, 3_000_000_600_000 + 500_000), null);
});

test("missing HR remains absent and is not interpolated", () => {
  assert.deepEqual(buildVo2EvidenceHr([]), { source: "absent", sample_count: 0 });
  assert.deepEqual(
    buildVo2EvidenceHr([
      { session_id: "s", timestamp_sec: 10, hr: 0 },
      { session_id: "s", timestamp_sec: 11, hr: -1 },
    ]),
    { source: "absent", sample_count: 0 }
  );
});

test("phase start/end boundaries share the active clock", () => {
  const phases = deriveVo2EvidencePhases({
    day: "Monday",
    blocks,
    activeDurationSec: (5 + 25 + 5) * 60,
  });
  assert.ok(phases.length >= 3);
  assert.equal(phases[0].kind, "warmup");
  assert.equal(phases[0].active_start_sec, 0);
  assert.equal(phases[0].active_end_sec, 300);
  const sustain = phases.find((phase) => phase.phase_id === "sustain" || phase.kind === "work");
  assert.ok(sustain);
  assert.equal(sustain.active_start_sec, 300);
  const cooldown = phases.find((phase) => phase.kind === "cooldown");
  assert.ok(cooldown);
  assert.equal(cooldown.active_start_sec, sustain.active_end_sec);
  assert.equal(cooldown.active_start_sec, 1800);
  assert.equal(cooldown.active_end_sec, 2100);
  for (let i = 1; i < phases.length; i++) {
    assert.equal(phases[i].active_start_sec, phases[i - 1].active_end_sec);
  }
});

test("phase evidence does not treat dynamic machine guidance as a phase-wide prescription", () => {
  const phases = deriveVo2EvidencePhases({
    day: "Monday",
    blocks,
    activeDurationSec: 400,
  });
  const work = phases.find((phase) => phase.active_start_sec === 300);
  assert.ok(work);
  assert.equal(work.prescribed?.cadence_rpm, undefined);
  assert.equal(work.prescribed?.resistance, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(work.prescribed || {}, "cadence_rpm"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(work.prescribed || {}, "resistance"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(work, "measured_cadence_rpm"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(work, "measured_resistance"), false);
});

test("normal work to cooldown records work-end and cooldown-start", () => {
  const evidence = buildVo2Evidence({
    day: "Monday",
    activity: "bike",
    intent: "aerobic",
    blocks,
    activeDurationSec: 2100,
    pausedDurationSec: 0,
    hrSamples: [
      { session_id: "s", timestamp_sec: 100, hr: 120 },
      { session_id: "s", timestamp_sec: 400, hr: 150 },
      { session_id: "s", timestamp_sec: 1900, hr: 130 },
    ],
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    machineGuidanceTraceEntryCount: 1,
  });
  assert.equal(evidence.schema_version, VO2_EVIDENCE_SCHEMA_VERSION);
  assert.equal(evidence.work_end_active_sec, 1800);
  assert.equal(evidence.cooldown_start_active_sec, 1800);
  assert.equal(evidence.early_cooldown, false);
  assert.equal(evidence.active_duration_sec, 2100);
  assert.equal(evidence.hr.source, "ble_chest_strap");
  assert.equal(evidence.hr.sample_count, 3);
  assert.equal(evidence.machine?.machine_id, "proform-smart-power-10");
  assert.equal(evidence.machine?.guidance_trace_entry_count, 1);
});

test("Early Cooldown records markers and keeps later HR out of work phase", () => {
  const storage = memoryStorage();
  const start = 3_000_000_700_000;
  const pauseNow = start + 480_000;
  const cooldownNow = pauseNow + 15_000;
  startSession("Friday", start, "early-ev", "bike", storage);
  pauseSession("Friday", 480, storage, pauseNow);
  const decision = requestEarlyCooldown("Friday", { storage, now: cooldownNow, blocks });
  assert.equal(decision.type, "enter-early-cooldown");
  const session = getSession("Friday", storage);
  const activeDurationSec = 480 + 300;
  const evidence = buildVo2Evidence({
    day: "Friday",
    activity: "bike",
    blocks,
    activeDurationSec,
    pausedDurationSec: totalPausedDurationSec(session, cooldownNow + 300_000),
    earlyCooldownElapsed: session.earlyCooldownElapsed,
    hrSamples: [
      { session_id: "early-ev", timestamp_sec: 480, hr: 155 },
      { session_id: "early-ev", timestamp_sec: 481, hr: 140 },
      { session_id: "early-ev", timestamp_sec: 500, hr: 128 },
    ],
  });
  assert.equal(evidence.early_cooldown, true);
  assert.equal(evidence.work_end_active_sec, 480);
  assert.equal(evidence.cooldown_start_active_sec, 480);
  const workish = evidence.phases.filter((phase) => phase.kind === "work" || phase.kind === "recovery");
  for (const phase of workish) {
    assert.ok(phase.active_end_sec <= 480);
  }
  const cooldown = evidence.phases.find((phase) => phase.kind === "cooldown");
  assert.ok(cooldown);
  assert.equal(cooldown.active_start_sec, 480);
  assert.ok(cooldown.active_end_sec > 480);
  const phaseAt500 = getPhase(500, blocks, session.earlyCooldownElapsed);
  assert.equal(phaseAt500.kind, "cooldown");
});

test("vo2_evidence survives IndexedDB workout-storage round trip", async () => {
  await resetWorkoutStorageForTests();
  const evidence = buildVo2Evidence({
    day: "Saturday",
    blocks,
    activeDurationSec: 600,
    pausedDurationSec: 12,
    hrSamples: [{ session_id: "persist-idb", timestamp_sec: 10, hr: 110 }],
  });
  const summary = {
    external_session_id: "persist-idb",
    startedAt: "2026-08-28T00:00:00.000Z",
    endedAt: "2026-08-28T00:10:12.000Z",
    category: "cardio",
    intent: "test",
    duration_minutes: 10,
    primary_zone: 2,
    stress_profile: "low",
    zone_minutes: { z1: 0, z2: 10, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Saturday",
    vo2_evidence: evidence,
  };
  await storeWorkoutSummary(summary);
  const loadedRows = await getAllWorkoutSummaries();
  const loaded = loadedRows.find((row) => row.summary?.external_session_id === "persist-idb");
  assert.ok(loaded);
  assert.deepEqual(loaded.summary.vo2_evidence, evidence);
  await resetWorkoutStorageForTests();
});

test("historical workouts without vo2_evidence still deserialize from workout storage", async () => {
  await resetWorkoutStorageForTests();
  const historical = {
    external_session_id: "old-idb",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:30:00.000Z",
    category: "cardio",
    intent: "legacy",
    duration_minutes: 30,
    primary_zone: 2,
    stress_profile: "low",
    zone_minutes: { z1: 0, z2: 30, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Monday",
  };
  await storeWorkoutSummary(historical);
  const loadedRows = await getAllWorkoutSummaries();
  const loaded = loadedRows.find((row) => row.summary?.external_session_id === "old-idb");
  assert.ok(loaded);
  assert.equal(loaded.summary.vo2_evidence, undefined);
  assert.equal(loaded.summary.athlete_id, undefined);
  assert.equal(loaded.summary.athlete_fitness_snapshot, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(loaded.summary, "vo2_evidence"), false);
  await resetWorkoutStorageForTests();
});

test("cancelled mid-work leaves cooldown markers null", () => {
  const evidence = buildVo2Evidence({
    day: "Sunday",
    blocks,
    activeDurationSec: 400,
    pausedDurationSec: 0,
    cancelled: true,
    hrSamples: [],
  });
  assert.equal(evidence.cancelled, true);
  assert.equal(evidence.work_end_active_sec, null);
  assert.equal(evidence.cooldown_start_active_sec, null);
  assert.equal(evidence.early_cooldown, false);
  assert.equal(evidence.hr.source, "absent");
});

test("SISU payload strips vo2_evidence without changing local summary shape", async () => {
  const { buildSisuWorkoutPayload } = await import("../dist/sisuSync.js");
  const evidence = buildVo2Evidence({
    day: "Monday",
    blocks,
    activeDurationSec: 2100,
    pausedDurationSec: 0,
    hrSamples: [{ session_id: "s", timestamp_sec: 1, hr: 100 }],
  });
  const summary = {
    external_session_id: "sisu-strip",
    startedAt: "2026-08-28T00:00:00.000Z",
    endedAt: "2026-08-28T00:35:00.000Z",
    category: "cardio",
    intent: "test",
    duration_minutes: 35,
    primary_zone: 2,
    stress_profile: "low",
    zone_minutes: { z1: 0, z2: 35, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    activity: "bike",
    machine_id: "proform-smart-power-10",
    vo2_evidence: evidence,
    vo2_assessment: { status: "estimated", estimate_ml_kg_min: 40.75 },
  };
  const payload = buildSisuWorkoutPayload(summary);
  assert.equal(payload.vo2_evidence, undefined);
  assert.equal(payload.vo2_assessment, undefined);
  assert.equal(payload.activity, undefined);
  assert.equal(payload.machine_id, undefined);
  assert.equal(summary.vo2_evidence.schema_version, VO2_EVIDENCE_SCHEMA_VERSION);
  assert.equal(summary.vo2_assessment.status, "estimated");
});

test("adjustedBlockLengths is currently identity for live runtime HRV input", () => {
  const base = { warm: 12, sustain: 20, cool: 5 };
  assert.deepEqual(adjustedBlockLengths(base, null), base);
  assert.deepEqual(adjustedBlockLengths(base, { fake: true }), base);
});

test("phase plan snapshot freezes blocks used by evidence when live plan later changes", () => {
  const storage = memoryStorage();
  const startBlocks = { warm: 5, sustain: 10, cool: 5 };
  const startHr = {
    warmup: "120-130",
    cooldown: "<120",
    main_set: "140-150",
    main_set_kind: "work",
    intervals: null,
  };
  startSession(
    "Monday",
    3_000_001_000_000,
    "phase-snap",
    "bike",
    storage,
    { blocks: startBlocks, hrTargets: startHr }
  );
  const session = getSession("Monday", storage);
  assert.deepEqual(session.phasePlan?.blocks, startBlocks);
  assert.equal(session.phasePlan?.hrTargets?.main_set_kind, "work");

  const liveChangedBlocks = { warm: 99, sustain: 99, cool: 5 };
  const withSnapshot = getPhase(301, session.phasePlan.blocks, null, {
    day: "Monday",
    hrTargets: session.phasePlan.hrTargets,
  });
  const withLiveChanged = getPhase(301, liveChangedBlocks, null);
  const evidencePhases = deriveVo2EvidencePhases({
    day: "Monday",
    blocks: session.phasePlan.blocks,
    hrTargets: session.phasePlan.hrTargets,
    activeDurationSec: 600,
  });
  assert.equal(withSnapshot.kind, "work");
  assert.equal(withLiveChanged.kind, "warmup");
  assert.notEqual(withSnapshot.kind, withLiveChanged.kind);
  assert.equal(evidencePhases[0].kind, "warmup");
  assert.equal(evidencePhases[0].active_end_sec, 300);
  assert.equal(evidencePhases[1].kind, "work");
  assert.equal(evidencePhases[1].active_start_sec, 300);
});

test("capturePhasePlanSnapshot matches getPlan plus adjustedBlockLengths plus getHrTargets", () => {
  const day = "Monday";
  const plan = getPlan();
  // Without loaded plan data, snapshot is null; with injected module state prove shape parity.
  if (!plan[day]) {
    assert.equal(capturePhasePlanSnapshot(day), null);
    return;
  }
  const expectedBlocks = adjustedBlockLengths(plan[day], null);
  const expectedHr = getHrTargets()[day] ?? null;
  const snap = capturePhasePlanSnapshot(day);
  assert.deepEqual(snap.blocks, {
    warm: expectedBlocks.warm,
    sustain: expectedBlocks.sustain,
    cool: expectedBlocks.cool,
  });
  assert.deepEqual(snap.hrTargets, expectedHr);
});

test("frozen null hrTargets does not acquire later live intervals", () => {
  const live = getHrTargets();
  const previous = live.Monday;
  live.Monday = {
    warmup: "130-140",
    cooldown: "<120",
    main_set: "",
    main_set_kind: "work",
    intervals: {
      phases: [
        { phase: "hard", kind: "work", duration: 1, target_hr_bpm: ">=160" },
        { phase: "easy", kind: "recovery", duration: 1, target_hr_bpm: "120-135" },
      ],
      repetitions: 10,
      isSequence: false,
    },
  };
  try {
    const leaked = getPhase(330, blocks, null, { day: "Monday" });
    assert.equal(leaked.kind, "work");
    assert.equal(leaked.phaseId, "cycle:0:0");
    const frozen = getPhase(330, blocks, null, { day: "Monday", hrTargets: null });
    assert.equal(frozen.kind, "work");
    assert.equal(frozen.phaseId, "sustain");
    assert.equal(frozen.detailName, undefined);
    assert.equal(frozen.intervalIndex, undefined);
  } finally {
    if (previous === undefined) delete live.Monday;
    else live.Monday = previous;
  }
});

test("evidence prescribed HR stays on the frozen snapshot when live plan mutates", () => {
  const live = getHrTargets();
  const previous = live.Monday;
  const snapshotHr = {
    warmup: "120-130",
    cooldown: "<120",
    main_set: "140-150",
    main_set_kind: "work",
    intervals: null,
  };
  live.Monday = {
    warmup: "170-180",
    cooldown: "<100",
    main_set: "180-190",
    main_set_kind: "work",
    intervals: null,
  };
  try {
    const phases = deriveVo2EvidencePhases({
      day: "Monday",
      blocks,
      hrTargets: snapshotHr,
      activeDurationSec: 400,
    });
    const work = phases.find((phase) => phase.active_start_sec === 300);
    assert.ok(work);
    assert.equal(work.prescribed?.target_hr_bpm, "140-150");
    assert.notEqual(work.prescribed?.target_hr_bpm, "180-190");

    const absent = deriveVo2EvidencePhases({
      day: "Monday",
      blocks,
      hrTargets: null,
      activeDurationSec: 400,
    });
    const absentWork = absent.find((phase) => phase.active_start_sec === 300);
    assert.ok(absentWork);
    assert.equal(absentWork.prescribed, undefined);
  } finally {
    if (previous === undefined) delete live.Monday;
    else live.Monday = previous;
  }
});
