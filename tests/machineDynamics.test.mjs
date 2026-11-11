import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCompletedWorkoutDynamics,
  appendBoundedSample,
  deriveHrDynamicsObservations,
  DYNAMICS_SAMPLE_LIMIT,
  DYNAMICS_STORAGE_KEY,
  learnHrDynamicsFromSamples,
  listHrDynamics,
  loadDynamicsStore,
  mergeObservationIntoEntry,
  putDynamicsEntry,
  RECENT_OPPORTUNITY_LIMIT,
  resetHrDynamicsForMachine,
  responseDetectionRate,
  recentDetectedDelays,
  recentDetectionRate,
  delayConcentrationNearMedian,
} from "../dist/machines/dynamics/index.js";
import {
  applyCompletedWorkoutLearning,
  LEARNING_STORAGE_KEY,
  learningKey,
  loadLearnedStore,
  putLearnedStart,
} from "../dist/machines/learning/index.js";
import { EQUIPMENT_STORAGE_KEY, setSelectedMachine } from "../dist/machines/selection.js";

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

function fillRange(start, end, bpm) {
  const samples = [];
  for (let elapsed = start; elapsed < end; elapsed++) {
    samples.push({ elapsedSeconds: elapsed, bpm });
  }
  return samples;
}

function setBpm(samples, elapsed, bpm) {
  const existing = samples.find((sample) => sample.elapsedSeconds === elapsed);
  if (existing) existing.bpm = bpm;
  else samples.push({ elapsedSeconds: elapsed, bpm });
}

function bikeSummary(overrides = {}) {
  return {
    external_session_id: "dyn-1",
    startedAt: "2026-08-26T12:00:00.000Z",
    endedAt: "2026-08-26T12:40:00.000Z",
    category: "cardio",
    intent: "vo2_primer",
    duration_minutes: 40,
    primary_zone: 4,
    stress_profile: "high",
    zone_minutes: { z1: 5, z2: 5, z3: 5, z4: 20, z5: 5 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    activity: "bike",
    machine_id: "proform-smart-power-10",
    machine_profile_version: 1,
    machine_guidance_trace: [],
    ...overrides,
  };
}

function workEntry(elapsed, resistance, extras = {}) {
  return {
    elapsedSeconds: elapsed,
    resistance,
    cadenceRpm: extras.cadenceRpm ?? 70,
    estimatedWatts: extras.estimatedWatts ?? 134,
    phaseKind: "work",
    phaseId: extras.phaseId ?? "work:1",
    intervalIndex: extras.intervalIndex ?? 1,
    phaseDurationSeconds: extras.work ?? 60,
    phaseElapsedSeconds: extras.phaseElapsedSeconds ?? 0,
    targetHeartRateMin: extras.omitTargets ? undefined : extras.targetMin ?? 160,
    targetHeartRateMax: extras.omitTargets ? undefined : extras.targetMax ?? 170,
    reason: extras.reason ?? "work",
  };
}

function recoveryEntry(elapsed, extras = {}) {
  return {
    elapsedSeconds: elapsed,
    resistance: extras.resistance ?? 2,
    cadenceRpm: 63,
    phaseKind: "recovery",
    phaseId: extras.phaseId ?? "recovery:1",
    phaseDurationSeconds: extras.recovery ?? 60,
    phaseElapsedSeconds: 0,
    targetHeartRateMin: 120,
    targetHeartRateMax: 135,
    reason: "recovery",
  };
}

function risingWorkStartHr() {
  return [
    ...fillRange(85, 100, 130),
    ...fillRange(100, 120, 131),
    { elapsedSeconds: 120, bpm: 131 },
    { elapsedSeconds: 121, bpm: 132 },
    { elapsedSeconds: 122, bpm: 132 },
    { elapsedSeconds: 123, bpm: 133 },
    { elapsedSeconds: 124, bpm: 134 },
    ...fillRange(125, 145, 135),
    ...fillRange(145, 160, 147),
  ];
}

const vo2ShortKey = {
  machineId: "proform-smart-power-10",
  machineProfileVersion: 1,
  activity: "bike",
  intent: "vo2_primer",
  durationClass: "short",
};

test("work-start observation uses pre-work baseline and persistent onset", () => {
  const summary = bikeSummary({
    machine_guidance_trace: [
      recoveryEntry(40, { phaseId: "recovery:0" }),
      workEntry(100, 11),
      recoveryEntry(160),
    ],
  });
  const samples = [...risingWorkStartHr(), ...fillRange(160, 180, 180)];
  const observations = deriveHrDynamicsObservations(summary, samples);
  const start = observations.find((observation) => observation.kind === "work_start");
  assert.ok(start);
  assert.equal(start.toResistance, 11);
  assert.equal(start.resistanceDelta, undefined);
  assert.equal(start.baselineHr, 130);
  assert.equal(start.responseDelaySeconds, 25);
  assert.equal(start.settledHr, 147);
  assert.equal(start.hrDelta, 17);
  assert.equal(start.windowObservable, true);
  assert.equal(start.responseDetected, true);
  assert.equal(observations.some((observation) => observation.kind !== "work_start"), false);
});

test("a single HR spike does not count as response onset", () => {
  const summary = bikeSummary({
    machine_guidance_trace: [workEntry(100, 11), recoveryEntry(160)],
  });
  const samples = [...fillRange(85, 100, 130), ...fillRange(100, 160, 131)];
  setBpm(samples, 110, 135);
  const start = deriveHrDynamicsObservations(summary, samples).find((observation) => observation.kind === "work_start");
  assert.equal(start?.baselineHr, 130);
  assert.equal(start?.responseDelaySeconds, undefined);
  assert.equal(start?.windowObservable, true);
  assert.equal(start?.responseDetected, false);
});

test("in-work resistance increase is a +1 observation", () => {
  const summary = bikeSummary({
    intent: "vo2_priority",
    machine_guidance_trace: [
      workEntry(0, 8, { work: 240, phaseElapsedSeconds: 0 }),
      workEntry(100, 9, { work: 240, phaseElapsedSeconds: 100, estimatedWatts: 114 }),
    ],
  });
  const samples = [
    ...fillRange(90, 100, 150),
    ...fillRange(100, 120, 151),
    { elapsedSeconds: 120, bpm: 151 },
    { elapsedSeconds: 121, bpm: 152 },
    { elapsedSeconds: 122, bpm: 152 },
    { elapsedSeconds: 123, bpm: 153 },
    { elapsedSeconds: 124, bpm: 154 },
    ...fillRange(125, 175, 155),
    ...fillRange(175, 190, 160),
  ];
  const increase = deriveHrDynamicsObservations(summary, samples).find(
    (observation) => observation.kind === "resistance_increase"
  );
  assert.ok(increase);
  assert.equal(increase.fromResistance, 8);
  assert.equal(increase.toResistance, 9);
  assert.equal(increase.resistanceDelta, 1);
  assert.equal(increase.responseDelaySeconds, 25);
  assert.equal(increase.baselineHr, 150);
  assert.equal(increase.settledHr, 160);
  assert.equal(increase.hrDelta, 10);
});

test("in-work resistance decrease detects a falling HR response", () => {
  const summary = bikeSummary({
    intent: "threshold",
    machine_guidance_trace: [
      workEntry(0, 10, { work: 240, phaseElapsedSeconds: 0 }),
      workEntry(100, 9, { work: 240, phaseElapsedSeconds: 100, estimatedWatts: 114 }),
    ],
  });
  const samples = [
    ...fillRange(90, 100, 160),
    ...fillRange(100, 120, 159),
    { elapsedSeconds: 120, bpm: 159 },
    { elapsedSeconds: 121, bpm: 158 },
    { elapsedSeconds: 122, bpm: 158 },
    { elapsedSeconds: 123, bpm: 157 },
    { elapsedSeconds: 124, bpm: 156 },
    ...fillRange(125, 190, 155),
  ];
  const decrease = deriveHrDynamicsObservations(summary, samples).find(
    (observation) => observation.kind === "resistance_decrease"
  );
  assert.ok(decrease);
  assert.equal(decrease.fromResistance, 10);
  assert.equal(decrease.toResistance, 9);
  assert.equal(decrease.resistanceDelta, -1);
  assert.equal(decrease.responseDelaySeconds, 25);
  assert.equal(decrease.hrDelta, -5);
});

test("the next resistance recommendation truncates the observation window", () => {
  const summary = bikeSummary({
    intent: "vo2_priority",
    machine_guidance_trace: [
      workEntry(0, 8, { work: 240, phaseElapsedSeconds: 0 }),
      workEntry(100, 9, { work: 240, phaseElapsedSeconds: 100, estimatedWatts: 114 }),
      workEntry(140, 10, { work: 240, phaseElapsedSeconds: 140, estimatedWatts: 123 }),
    ],
  });
  const samples = [
    ...fillRange(90, 100, 150),
    ...fillRange(100, 140, 151),
    ...fillRange(140, 190, 180),
  ];
  const increase = deriveHrDynamicsObservations(summary, samples).find(
    (observation) => observation.kind === "resistance_increase" && observation.toResistance === 9
  );
  assert.ok(increase);
  assert.equal(increase.observationWindowSeconds, 40);
  assert.equal(increase.responseDelaySeconds, undefined);
  assert.equal(increase.settledHr, 151);
  assert.equal(increase.hrDelta, 1);
});

test("work-start observation stops at recovery and does not use recovery HR", () => {
  const summary = bikeSummary({
    machine_guidance_trace: [workEntry(100, 11), recoveryEntry(160)],
  });
  const samples = [
    ...fillRange(85, 100, 130),
    ...fillRange(100, 160, 140),
    ...fillRange(160, 180, 180),
  ];
  const start = deriveHrDynamicsObservations(summary, samples).find((observation) => observation.kind === "work_start");
  assert.equal(start?.observationWindowSeconds, 60);
  assert.equal(start?.settledHr, 140);
  assert.notEqual(start?.settledHr, 180);
});

test("recovery R2 to work R12 is a work_start, not a +10 step", () => {
  const summary = bikeSummary({
    machine_guidance_trace: [recoveryEntry(40), workEntry(100, 12)],
  });
  const observations = deriveHrDynamicsObservations(summary, [
    ...fillRange(85, 100, 130),
    ...fillRange(100, 160, 140),
  ]);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].kind, "work_start");
  assert.equal(observations[0].toResistance, 12);
  assert.equal(observations[0].resistanceDelta, undefined);
  assert.equal(observations[0].fromResistance, undefined);
});

test("insufficient HR leaves response metrics undefined and does not update storage", () => {
  const summary = bikeSummary({
    machine_guidance_trace: [workEntry(100, 11), recoveryEntry(160)],
  });
  const cases = [
    [{ elapsedSeconds: 110, bpm: 140 }],
    [
      { elapsedSeconds: 110, bpm: 140 },
      { elapsedSeconds: 110, bpm: 141 },
      { elapsedSeconds: 110, bpm: 142 },
    ],
    fillRange(110, 113, 140),
  ];
  const storage = memoryStorage();
  for (const samples of cases) {
    const start = deriveHrDynamicsObservations(summary, samples).find((observation) => observation.kind === "work_start");
    assert.equal(start?.responseDelaySeconds, undefined);
    assert.equal(start?.baselineHr, undefined);
    assert.equal(start?.hrDelta, undefined);
    assert.equal(start?.windowObservable, false);
    assert.equal(start?.responseDetected, false);
    assert.deepEqual(applyCompletedWorkoutDynamics(summary, samples, storage), []);
  }
  assert.deepEqual(loadDynamicsStore(storage).entries, {});
});

test("dynamics store starts empty and round-trips", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadDynamicsStore(storage), { version: 1, entries: {} });
  putDynamicsEntry(
    vo2ShortKey,
    {
      workStartDelays: [29],
      workStartHrDeltas: [17],
      increaseDelays: [],
      increaseHrPerLevel: [],
      decreaseDelays: [],
      decreaseHrPerLevel: [],
      updatedAt: "2026-08-26T12:00:00.000Z",
    },
    storage
  );
  const loaded = loadDynamicsStore(storage);
  assert.equal(loaded.version, 1);
  assert.deepEqual(loaded.entries[learningKey(vo2ShortKey)].workStartDelays, [29]);
  assert.equal(loaded.entries[learningKey(vo2ShortKey)].workStartObservationCount, 0);
  assert.equal(loaded.entries[learningKey(vo2ShortKey)].workStartDetectedResponseCount, 0);
  assert.equal(JSON.parse(storage.getItem(DYNAMICS_STORAGE_KEY)).version, 1);
});

test("malformed dynamics JSON and invalid entries are discarded", () => {
  assert.deepEqual(loadDynamicsStore(memoryStorage({ [DYNAMICS_STORAGE_KEY]: "{not json" })), { version: 1, entries: {} });
  assert.deepEqual(
    loadDynamicsStore(memoryStorage({ [DYNAMICS_STORAGE_KEY]: JSON.stringify({ version: 2, entries: { x: {} } }) })),
    { version: 1, entries: {} }
  );
  const storage = memoryStorage({
    [DYNAMICS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      entries: {
        "unknown-bike|1|bike|vo2_primer|short": {
          workStartDelays: [20],
          workStartHrDeltas: [10],
          increaseDelays: [],
          increaseHrPerLevel: [],
          decreaseDelays: [],
          decreaseHrPerLevel: [],
          updatedAt: "t",
        },
        "proform-smart-power-10|0|bike|vo2_primer|short": {
          workStartDelays: [20],
          workStartHrDeltas: [10],
          increaseDelays: [],
          increaseHrPerLevel: [],
          decreaseDelays: [],
          decreaseHrPerLevel: [],
          updatedAt: "t",
        },
        [learningKey(vo2ShortKey)]: {
          workStartDelays: [29, "bad", null, 91, -1, 24],
          workStartHrDeltas: [17, 99, 16.4, 18],
          increaseDelays: "nope",
          increaseHrPerLevel: [5, 21, 4],
          decreaseDelays: [22],
          decreaseHrPerLevel: [-5],
          updatedAt: "2026-08-26T12:00:00.000Z",
        },
      },
    }),
  });
  const loaded = loadDynamicsStore(storage);
  assert.deepEqual(Object.keys(loaded.entries), [learningKey(vo2ShortKey)]);
  assert.deepEqual(loaded.entries[learningKey(vo2ShortKey)].workStartDelays, [29, 24]);
  assert.deepEqual(loaded.entries[learningKey(vo2ShortKey)].workStartHrDeltas, [17, 18]);
  assert.deepEqual(loaded.entries[learningKey(vo2ShortKey)].increaseDelays, []);
  assert.deepEqual(loaded.entries[learningKey(vo2ShortKey)].increaseHrPerLevel, [5, 4]);
});

test("reset removes HR dynamics without changing learned starts or equipment", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putLearnedStart(vo2ShortKey, { resistance: 12, sampleCount: 1, updatedAt: "t" }, storage);
  putDynamicsEntry(
    vo2ShortKey,
    {
      workStartDelays: [29],
      workStartHrDeltas: [17],
      increaseDelays: [],
      increaseHrPerLevel: [],
      decreaseDelays: [],
      decreaseHrPerLevel: [],
      updatedAt: "t",
    },
    storage
  );
  resetHrDynamicsForMachine("proform-smart-power-10", storage);
  assert.deepEqual(loadDynamicsStore(storage).entries, {});
  assert.equal(loadLearnedStore(storage).entries[learningKey(vo2ShortKey)].resistance, 12);
  assert.equal(JSON.parse(storage.getItem(EQUIPMENT_STORAGE_KEY)).bike, "proform-smart-power-10");
  assert.ok(storage.getItem(LEARNING_STORAGE_KEY));
});

test("aggregation uses a robust median and bounds sample arrays", () => {
  let entry;
  for (const delay of [22, 25, 24, 60, 23]) {
    entry = mergeObservationIntoEntry(
      entry,
      {
        machineId: "proform-smart-power-10",
        machineProfileVersion: 1,
        activity: "bike",
        intent: "vo2_primer",
        durationClass: "short",
        phaseId: "work:1",
        toResistance: 11,
        changeElapsedSeconds: 100,
        observationWindowSeconds: 60,
        kind: "work_start",
        responseDelaySeconds: delay,
        hrDelta: 17,
      },
      "t"
    );
  }
  assert.equal(entry.workStartDelays.length, 5);
  const listed = listHrDynamics("proform-smart-power-10", memoryStorage({
    [DYNAMICS_STORAGE_KEY]: JSON.stringify({ version: 1, entries: { [learningKey(vo2ShortKey)]: entry } }),
  }))[0];
  assert.equal(listed.medianWorkStartDelaySeconds, 24);
  let bounded = [];
  for (let i = 0; i < 25; i++) bounded = appendBoundedSample(bounded, i);
  assert.equal(bounded.length, DYNAMICS_SAMPLE_LIMIT);
  assert.deepEqual(bounded, Array.from({ length: 20 }, (_, index) => index + 5));
});

test("dynamics keys keep intent, duration class, and profile version separate", () => {
  const storage = memoryStorage();
  const summaryShort = bikeSummary({
    intent: "vo2_primer",
    machine_guidance_trace: [workEntry(100, 11), recoveryEntry(160)],
  });
  applyCompletedWorkoutDynamics(summaryShort, risingWorkStartHr(), storage);
  const summaryLong = bikeSummary({
    intent: "vo2_priority",
    machine_guidance_trace: [
      workEntry(0, 8, { work: 240, phaseElapsedSeconds: 0 }),
      workEntry(100, 9, { work: 240, phaseElapsedSeconds: 100 }),
    ],
  });
  applyCompletedWorkoutDynamics(
    summaryLong,
    [
      ...fillRange(90, 100, 150),
      ...fillRange(100, 120, 151),
      { elapsedSeconds: 120, bpm: 151 },
      { elapsedSeconds: 121, bpm: 152 },
      { elapsedSeconds: 122, bpm: 152 },
      { elapsedSeconds: 123, bpm: 153 },
      { elapsedSeconds: 124, bpm: 154 },
      ...fillRange(125, 190, 155),
    ],
    storage
  );
  const summaryThreshold = bikeSummary({
    intent: "threshold",
    machine_guidance_trace: [workEntry(0, 8, { work: 1200, phaseId: "sustain", phaseElapsedSeconds: 0 })],
  });
  applyCompletedWorkoutDynamics(
    summaryThreshold,
    [...fillRange(0, 15, 130).map((sample) => ({ ...sample, elapsedSeconds: sample.elapsedSeconds - 15 })), ...fillRange(0, 90, 140)],
    storage
  );
  const keys = Object.keys(loadDynamicsStore(storage).entries).sort();
  assert.deepEqual(keys, [
    "proform-smart-power-10|1|bike|threshold|long",
    "proform-smart-power-10|1|bike|vo2_primer|short",
    "proform-smart-power-10|1|bike|vo2_priority|long",
  ]);
  putDynamicsEntry(
    { ...vo2ShortKey, machineProfileVersion: 2 },
    {
      workStartDelays: [40],
      workStartHrDeltas: [12],
      increaseDelays: [],
      increaseHrPerLevel: [],
      decreaseDelays: [],
      decreaseHrPerLevel: [],
      updatedAt: "t",
    },
    storage
  );
  assert.equal(loadDynamicsStore(storage).entries[learningKey(vo2ShortKey)].workStartDelays[0] !== 40, true);
  assert.ok(loadDynamicsStore(storage).entries["proform-smart-power-10|2|bike|vo2_primer|short"]);
});

test("qualifying completed workouts update dynamics; cancelled, elliptical, and unusable HR do not", () => {
  const storage = memoryStorage();
  const summary = bikeSummary({
    machine_guidance_trace: [workEntry(100, 11), recoveryEntry(160)],
  });
  const saved = applyCompletedWorkoutDynamics(summary, risingWorkStartHr(), storage);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].workStartSampleCount, 1);
  assert.equal(saved[0].medianWorkStartDelaySeconds, 25);
  assert.equal(saved[0].workStartObservationCount, 1);
  assert.equal(saved[0].workStartDetectedResponseCount, 1);
  assert.equal(
    applyCompletedWorkoutDynamics(bikeSummary({ cancelled: true, machine_guidance_trace: [workEntry(100, 11)] }), risingWorkStartHr(), storage).length,
    0
  );
  assert.equal(
    applyCompletedWorkoutDynamics(
      bikeSummary({ activity: "elliptical", machine_guidance_trace: [workEntry(100, 11)] }),
      risingWorkStartHr(),
      storage
    ).length,
    0
  );
  const before = JSON.stringify(loadDynamicsStore(storage));
  applyCompletedWorkoutDynamics(summary, [{ elapsedSeconds: 110, bpm: 140 }], storage);
  assert.equal(JSON.stringify(loadDynamicsStore(storage)), before);
});

test("dynamics write failure is isolated from learned-start storage", () => {
  const storage = memoryStorage();
  putLearnedStart(vo2ShortKey, { resistance: 12, sampleCount: 1, updatedAt: "t" }, storage);
  const throwing = {
    getItem(key) {
      return storage.getItem(key);
    },
    setItem(key, value) {
      if (key === DYNAMICS_STORAGE_KEY) throw new Error("quota");
      storage.setItem(key, value);
    },
  };
  assert.deepEqual(
    learnHrDynamicsFromSamples(
      bikeSummary({ machine_guidance_trace: [workEntry(100, 11), recoveryEntry(160)] }),
      risingWorkStartHr(),
      throwing
    ),
    []
  );
  assert.equal(loadLearnedStore(storage).entries[learningKey(vo2ShortKey)].resistance, 12);
});

test("a +3 resistance jump is not treated as a dose-response observation", () => {
  const summary = bikeSummary({
    intent: "vo2_priority",
    machine_guidance_trace: [
      workEntry(0, 8, { work: 240, phaseElapsedSeconds: 0 }),
      workEntry(100, 11, { work: 240, phaseElapsedSeconds: 100 }),
    ],
  });
  const observations = deriveHrDynamicsObservations(summary, fillRange(90, 190, 150));
  assert.equal(observations.some((observation) => observation.kind === "resistance_increase"), false);
  assert.equal(observations[0].kind, "work_start");
});

test("target HR is not required to record a response observation", () => {
  const summary = bikeSummary({
    machine_guidance_trace: [workEntry(100, 11, { omitTargets: true }), recoveryEntry(160)],
  });
  const start = deriveHrDynamicsObservations(summary, risingWorkStartHr())[0];
  assert.equal(start.kind, "work_start");
  assert.equal(start.responseDelaySeconds, 25);
});

test("learning starting resistance and HR dynamics can update from the same workout independently", () => {
  const storage = memoryStorage();
  const trace = [];
  for (let index = 0; index < 6; index++) {
    const elapsed = 100 + index * 120;
    trace.push(workEntry(elapsed, 12, { phaseId: `work:${index + 1}`, intervalIndex: index + 1, phaseElapsedSeconds: 0 }));
    if (index < 5) {
      trace.push(recoveryEntry(elapsed + 60, { phaseId: `recovery:${index + 1}` }));
    }
  }
  const samples = [];
  for (let index = 0; index < 6; index++) {
    const start = 100 + index * 120;
    samples.push(...fillRange(start - 15, start, 130));
    samples.push(...fillRange(start, start + 20, 131));
    samples.push(
      { elapsedSeconds: start + 20, bpm: 131 },
      { elapsedSeconds: start + 21, bpm: 132 },
      { elapsedSeconds: start + 22, bpm: 132 },
      { elapsedSeconds: start + 23, bpm: 133 },
      { elapsedSeconds: start + 24, bpm: 134 }
    );
    samples.push(...fillRange(start + 25, start + 45, 135));
    samples.push(...fillRange(start + 45, start + 60, 164));
  }
  const summary = bikeSummary({ machine_guidance_trace: trace });
  const learned = applyCompletedWorkoutLearning(summary, samples, storage);
  const dynamics = applyCompletedWorkoutDynamics(summary, samples, storage);
  assert.equal(learned?.resistance, 12);
  assert.equal(dynamics[0].workStartSampleCount, 6);
  assert.equal(dynamics[0].workStartObservationCount, 6);
  assert.equal(dynamics[0].workStartDetectedResponseCount, 6);
  assert.equal(loadLearnedStore(storage).entries[learningKey(vo2ShortKey)].resistance, 12);
  assert.equal(loadDynamicsStore(storage).entries[learningKey(vo2ShortKey)].workStartDelays.length, 6);
});

test("an observable window with no persistent HR response is censored, not dropped", () => {
  const summary = bikeSummary({
    machine_guidance_trace: [workEntry(100, 11), recoveryEntry(160)],
  });
  const samples = [...fillRange(85, 100, 130), ...fillRange(100, 160, 131)];
  const start = deriveHrDynamicsObservations(summary, samples).find((observation) => observation.kind === "work_start");
  assert.equal(start?.windowObservable, true);
  assert.equal(start?.responseDetected, false);
  assert.equal(start?.responseDelaySeconds, undefined);
  const storage = memoryStorage();
  const saved = applyCompletedWorkoutDynamics(summary, samples, storage);
  assert.equal(saved[0].workStartObservationCount, 1);
  assert.equal(saved[0].workStartDetectedResponseCount, 0);
  assert.equal(saved[0].workStartRecentObservationCount, 1);
  assert.equal(saved[0].workStartRecentDetectedResponseCount, 0);
  assert.deepEqual(saved[0].workStartDelaySampleCount, 0);
  assert.deepEqual(
    loadDynamicsStore(storage).entries[learningKey(vo2ShortKey)].workStartRecentResponses,
    [null]
  );
  assert.equal(responseDetectionRate(saved[0].workStartDetectedResponseCount, saved[0].workStartObservationCount), 0);
});

test("HR dropout is not counted as a non-response opportunity", () => {
  const summary = bikeSummary({
    machine_guidance_trace: [workEntry(100, 11), recoveryEntry(160)],
  });
  const samples = [...fillRange(85, 100, 130), { elapsedSeconds: 101, bpm: 131 }];
  const start = deriveHrDynamicsObservations(summary, samples)[0];
  assert.equal(start.windowObservable, false);
  assert.equal(start.responseDetected, false);
  const storage = memoryStorage();
  assert.deepEqual(applyCompletedWorkoutDynamics(summary, samples, storage), []);
  assert.deepEqual(loadDynamicsStore(storage).entries, {});
});

test("three non-consecutive evaluable rolling seconds are not an observation opportunity", () => {
  const summary = bikeSummary({
    machine_guidance_trace: [workEntry(100, 11), recoveryEntry(160)],
  });
  const samples = [
    ...fillRange(85, 100, 130),
    ...fillRange(106, 111, 131),
    ...fillRange(126, 131, 131),
    ...fillRange(146, 151, 131),
  ];
  const start = deriveHrDynamicsObservations(summary, samples)[0];
  assert.equal(start.windowObservable, false);
  assert.equal(start.responseDetected, false);
  const storage = memoryStorage();
  applyCompletedWorkoutDynamics(summary, samples, storage);
  assert.equal(
    loadDynamicsStore(storage).entries[learningKey(vo2ShortKey)]?.workStartObservationCount ?? 0,
    0
  );
  assert.equal(
    loadDynamicsStore(storage).entries[learningKey(vo2ShortKey)]?.workStartRecentResponses?.length ?? 0,
    0
  );
});

test("three consecutive evaluable rolling seconds make a window observable", () => {
  const summary = bikeSummary({
    machine_guidance_trace: [workEntry(100, 11), recoveryEntry(160)],
  });
  const samples = [...fillRange(85, 100, 130), ...fillRange(110, 117, 131)];
  const start = deriveHrDynamicsObservations(summary, samples)[0];
  assert.equal(start.windowObservable, true);
  assert.equal(start.responseDetected, false);
  const storage = memoryStorage();
  const saved = applyCompletedWorkoutDynamics(summary, samples, storage);
  assert.equal(saved[0].workStartObservationCount, 1);
  assert.equal(saved[0].workStartDetectedResponseCount, 0);
  assert.equal(saved[0].workStartRecentObservationCount, 1);
  assert.equal(saved[0].workStartRecentDetectedResponseCount, 0);
});

test("a truncated window too short to observe a response is not an opportunity", () => {
  const summary = bikeSummary({
    machine_guidance_trace: [workEntry(100, 11, { work: 12 }), recoveryEntry(112)],
  });
  const samples = [...fillRange(85, 100, 130), ...fillRange(100, 112, 140)];
  const start = deriveHrDynamicsObservations(summary, samples)[0];
  assert.equal(start.observationWindowSeconds, 12);
  assert.equal(start.windowObservable, false);
  const storage = memoryStorage();
  const saved = applyCompletedWorkoutDynamics(summary, samples, storage);
  if (saved.length > 0) {
    assert.equal(saved[0].workStartObservationCount, 0);
    assert.equal(saved[0].workStartDetectedResponseCount, 0);
    assert.equal(saved[0].workStartRecentObservationCount, 0);
    assert.equal(saved[0].workStartRecentDetectedResponseCount, 0);
  }
});

test("increase and decrease reliability counts stay independent", () => {
  const summary = bikeSummary({
    intent: "vo2_priority",
    machine_guidance_trace: [
      workEntry(0, 8, { work: 240, phaseElapsedSeconds: 0 }),
      workEntry(100, 9, { work: 240, phaseElapsedSeconds: 100, estimatedWatts: 114 }),
    ],
  });
  const samples = [
    ...fillRange(0, 15, 130).map((sample) => ({ ...sample, elapsedSeconds: sample.elapsedSeconds - 15 })),
    ...fillRange(0, 90, 140),
    ...fillRange(90, 100, 150),
    ...fillRange(100, 190, 151),
  ];
  const observations = deriveHrDynamicsObservations(summary, samples);
  const start = observations.find((observation) => observation.kind === "work_start");
  const increase = observations.find((observation) => observation.kind === "resistance_increase");
  assert.equal(start?.windowObservable, true);
  assert.equal(start?.responseDetected, true);
  assert.equal(increase?.windowObservable, true);
  assert.equal(increase?.responseDetected, false);
  const storage = memoryStorage();
  const saved = applyCompletedWorkoutDynamics(summary, samples, storage)[0];
  assert.equal(saved.workStartObservationCount, 1);
  assert.equal(saved.workStartDetectedResponseCount, 1);
  assert.equal(saved.workStartRecentObservationCount, 1);
  assert.equal(saved.workStartRecentDetectedResponseCount, 1);
  assert.equal(saved.increaseObservationCount, 1);
  assert.equal(saved.increaseDetectedResponseCount, 0);
  assert.equal(saved.increaseRecentObservationCount, 1);
  assert.equal(saved.increaseRecentDetectedResponseCount, 0);
  assert.equal(saved.decreaseObservationCount, 0);
  assert.equal(responseDetectionRate(1, 2), 0.5);
  assert.equal(responseDetectionRate(10, 20), 0.5);
  assert.equal(responseDetectionRate(10, 10), 1);
  assert.equal(responseDetectionRate(0, 0), undefined);
});

test("reliability counts do not use UI sample-count maxima and missing counts sanitize to zero", () => {
  const storage = memoryStorage({
    [DYNAMICS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      entries: {
        [learningKey(vo2ShortKey)]: {
          workStartDelays: [29, 30],
          workStartHrDeltas: [17, 16, 18, 15, 19],
          increaseDelays: [],
          increaseHrPerLevel: [],
          decreaseDelays: [],
          decreaseHrPerLevel: [],
          workStartObservationCount: 20,
          workStartDetectedResponseCount: 10,
          increaseObservationCount: -4,
          increaseDetectedResponseCount: 99,
          updatedAt: "t",
        },
      },
    }),
  });
  const listed = listHrDynamics("proform-smart-power-10", storage)[0];
  assert.equal(listed.workStartSampleCount, 5);
  assert.equal(listed.workStartDelaySampleCount, 2);
  assert.equal(listed.workStartObservationCount, 20);
  assert.equal(listed.workStartDetectedResponseCount, 10);
  assert.equal(listed.increaseObservationCount, 0);
  assert.equal(listed.increaseDetectedResponseCount, 0);
  assert.equal(listed.workStartRecentObservationCount, 0);
  assert.equal(listed.workStartRecentDetectedResponseCount, 0);
  assert.deepEqual(loadDynamicsStore(storage).entries[learningKey(vo2ShortKey)].workStartRecentResponses, []);
  assert.equal(responseDetectionRate(listed.workStartDetectedResponseCount, listed.workStartObservationCount), 0.5);
});

test("observation counts are lifetime and are not capped at the delay sample limit", () => {
  let entry;
  for (let index = 0; index < 25; index++) {
    entry = mergeObservationIntoEntry(
      entry,
      {
        machineId: "proform-smart-power-10",
        machineProfileVersion: 1,
        activity: "bike",
        intent: "vo2_primer",
        durationClass: "short",
        phaseId: "work:1",
        toResistance: 11,
        changeElapsedSeconds: 100,
        observationWindowSeconds: 60,
        kind: "work_start",
        responseDelaySeconds: 30,
        hrDelta: 12,
        windowObservable: true,
        responseDetected: true,
      },
      "t"
    );
  }
  assert.equal(entry.workStartDelays.length, DYNAMICS_SAMPLE_LIMIT);
  assert.equal(entry.workStartObservationCount, 25);
  assert.equal(entry.workStartDetectedResponseCount, 25);
  assert.equal(entry.workStartRecentResponses.length, RECENT_OPPORTUNITY_LIMIT);
  assert.equal(entry.workStartRecentResponses.every((value) => value === 30), true);
});

function workStartObservation(overrides = {}) {
  return {
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    activity: "bike",
    intent: "vo2_primer",
    durationClass: "short",
    phaseId: "work:1",
    toResistance: 11,
    changeElapsedSeconds: 100,
    observationWindowSeconds: 60,
    kind: "work_start",
    windowObservable: true,
    responseDetected: false,
    ...overrides,
  };
}

test("the 21st recent opportunity drops the oldest slot including a null", () => {
  let entry = mergeObservationIntoEntry(undefined, workStartObservation(), "t");
  for (let index = 0; index < 20; index++) {
    entry = mergeObservationIntoEntry(
      entry,
      workStartObservation({ responseDetected: true, responseDelaySeconds: 30 }),
      "t"
    );
  }
  assert.equal(entry.workStartRecentResponses.length, RECENT_OPPORTUNITY_LIMIT);
  assert.equal(entry.workStartRecentResponses[0], 30);
  assert.equal(entry.workStartRecentResponses.includes(null), false);
});

test("recent detection rate uses the bounded opportunity population, not lifetime counts", () => {
  const recent = [...Array(15).fill(null), 29, 30, 31, 28, 30];
  const storage = memoryStorage({
    [DYNAMICS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      entries: {
        [learningKey(vo2ShortKey)]: {
          workStartDelays: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 29, 30, 31, 28, 30],
          workStartHrDeltas: [],
          increaseDelays: [],
          increaseHrPerLevel: [],
          decreaseDelays: [],
          decreaseHrPerLevel: [],
          workStartObservationCount: 120,
          workStartDetectedResponseCount: 100,
          workStartRecentResponses: recent,
          updatedAt: "t",
        },
      },
    }),
  });
  const listed = listHrDynamics("proform-smart-power-10", storage)[0];
  assert.equal(listed.workStartObservationCount, 120);
  assert.equal(listed.workStartDetectedResponseCount, 100);
  assert.equal(listed.workStartDelaySampleCount, 20);
  assert.equal(listed.workStartRecentObservationCount, 20);
  assert.equal(listed.workStartRecentDetectedResponseCount, 5);
  assert.equal(recentDetectionRate(recent), 0.25);
  assert.deepEqual(recentDetectedDelays(recent), [29, 30, 31, 28, 30]);
  assert.equal(responseDetectionRate(listed.workStartDetectedResponseCount, listed.workStartObservationCount), 100 / 120);
});

test("delay concentration near the median is independent of detection rate", () => {
  assert.equal(delayConcentrationNearMedian([20, 21, 22, 23, 24, 25, 26, 50, 51, 52], 10), 0.7);
  assert.equal(delayConcentrationNearMedian([], 10), undefined);
});
