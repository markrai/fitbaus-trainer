import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

import {
  findResolvedPhaseTarget,
  formatResolvedHeartRateTarget,
  machineHeartRateTargetFromResolved,
  parseLegacyHeartRateTarget,
  parsePersistedHrTargetsForDay,
  parseResolvedWorkoutPrescription,
  resolveWorkoutPrescription,
  SUPPORTED_WORKOUT_PRESCRIPTION_RESOLVERS,
} from "../dist/workoutPrescription.js";
import { parseWorkoutTemplateDocument } from "../dist/workoutTemplate.js";
import { getHrTargets, getPlan, getWorkoutMetadata, transformWorkoutData } from "../dist/workoutData.js";
import { capturePhasePlanSnapshot } from "../dist/workoutLogic.js";
import { getSession, startSession } from "../dist/sessionStore.js";
import { VO2_WORKOUT_SELECTOR_ID, vo2PlanBlocks } from "../dist/vo2Protocol.js";
import { deriveVo2EvidencePhases } from "../dist/vo2Evidence.js";
import { createMachineGuidanceState } from "../dist/machines/guidance.js";
import { getProFormSmartPower10Guidance } from "../dist/machines/proformSmartPower10.js";
import { generateWorkoutSummary } from "../dist/workoutSummary.js";
import { resetWorkoutStorageForTests } from "../dist/workoutStorage.js";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const rawData = JSON.parse(readFileSync(new URL("../data.json", import.meta.url), "utf8"));

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function allTargetBearingPhases(document) {
  const phases = [];
  for (const day of document.weekly_plan) {
    for (const workout of day.variants ?? [day]) {
      for (const phase of [workout.warmup, workout.main_set, workout.cooldown]) {
        if (phase?.target_hr_bpm !== undefined) phases.push(phase);
      }
      for (const subsection of workout.warmup?.subsections ?? []) phases.push(subsection);
      for (const interval of workout.main_set?.intervals ?? []) phases.push(interval);
    }
  }
  return phases;
}

test("active seven-day template validates and every legacy target has semantic intensity", () => {
  const document = parseWorkoutTemplateDocument(rawData);
  assert.equal(document.weekly_plan.length, 7);
  const phases = allTargetBearingPhases(document);
  assert.ok(phases.length > 20);
  assert.ok(phases.every((phase) => typeof phase.intensity_id === "string"));
});

test("template validation rejects unknown intensity, malformed duration, and invalid repetitions", () => {
  const invalidIntensity = structuredClone(rawData);
  invalidIntensity.weekly_plan[0].warmup.intensity_id = "mystery";
  assert.throws(() => parseWorkoutTemplateDocument(invalidIntensity), /unknown intensity_id/);
  const invalidDuration = structuredClone(rawData);
  invalidDuration.weekly_plan[1].warmup.duration_min = "later";
  assert.throws(() => parseWorkoutTemplateDocument(invalidDuration), /duration_min/);
  const invalidRepetitions = structuredClone(rawData);
  invalidRepetitions.weekly_plan[0].main_set.repetitions = 0;
  assert.throws(() => parseWorkoutTemplateDocument(invalidRepetitions), /positive integer/);
  const invalidTarget = structuredClone(rawData);
  invalidTarget.weekly_plan[0].warmup.target_hr_bpm = { min: 130, max: 140 };
  assert.throws(() => parseWorkoutTemplateDocument(invalidTarget), /target_hr_bpm/);
});

test("legacy resolver preserves every existing parse rule exactly", () => {
  assert.deepEqual(parseLegacyHeartRateTarget("130–140"), { min: 130, max: 140 });
  assert.deepEqual(parseLegacyHeartRateTarget("130-140"), { min: 130, max: 140 });
  assert.deepEqual(parseLegacyHeartRateTarget("≥160 (cap 170)"), { min: 160, max: 170 });
  assert.deepEqual(parseLegacyHeartRateTarget("≥160"), { min: 160, max: 200 });
  assert.deepEqual(parseLegacyHeartRateTarget("<120"), { min: 0, max: 119 });
  assert.deepEqual(parseLegacyHeartRateTarget("150"), { min: 145, max: 155 });
  assert.deepEqual(parseLegacyHeartRateTarget("70 RPM prescribed"), { min: 65, max: 75 });
});

test("resolver is deterministic and emits stable repeated interval phase ids", () => {
  const input = {
    workoutSelector: "Monday",
    blocks: { warm: 12, sustain: 4, cool: 5 },
    hrTargets: {
      warmup: "130–140", warmup_intensity_id: "warmup_easy",
      cooldown: "<120", cooldown_intensity_id: "cooldown", main_set_kind: "work",
      intervals: { repetitions: 2, isSequence: false, phases: [
        { phase: "hard", kind: "work", duration: 1, target_hr_bpm: "≥160 (cap 170)", intensity_id: "vo2_short" },
        { phase: "easy", kind: "recovery", duration: 1, target_hr_bpm: "120–135", intensity_id: "recovery" },
      ] },
    },
    resolvedAt: "2026-01-01T00:00:00.000Z",
  };
  const first = resolveWorkoutPrescription(input);
  assert.deepEqual(first, resolveWorkoutPrescription(input));
  assert.deepEqual(first.phases.map((phase) => phase.phaseId), ["warmup", "cycle:0:0", "cycle:0:1", "cycle:1:0", "cycle:1:1", "cooldown"]);
  const hard = findResolvedPhaseTarget(first, "cycle:1:0", 850);
  assert.equal(hard.intensityId, "vo2_short");
  assert.deepEqual(hard.expectedHeartRate, { min: 160, max: 170 });
  assert.equal(formatResolvedHeartRateTarget(hard), "≥160 (cap 170) bpm");
  assert.deepEqual(machineHeartRateTargetFromResolved(hard), { targetHeartRateMin: 160, targetHeartRateMax: 170 });
});

test("persisted parser recognizes historical legacy v1 independently and rebuilds sanitized data", () => {
  const prescription = resolveWorkoutPrescription({
    workoutSelector: "Thursday",
    blocks: { warm: 10, sustain: 20, cool: 5 },
    hrTargets: {
      warmup: "135–145", warmup_intensity_id: "warmup_easy",
      main_set: "155–162", main_set_intensity_id: "threshold", main_set_kind: "work",
      cooldown: "<120", cooldown_intensity_id: "cooldown", intervals: null,
    },
    resolvedAt: "2026-01-01T00:00:00.000Z",
  });
  const persisted = JSON.parse(JSON.stringify(prescription));
  persisted.untrustedExtra = "discard me";
  persisted.phases[0].untrustedExtra = "discard me";
  const parsed = parseResolvedWorkoutPrescription(persisted);
  assert.ok(parsed);
  assert.notEqual(parsed, persisted);
  assert.equal(parsed.resolver.id, "legacy-hr-target-resolver");
  assert.equal(parsed.resolver.version, 1);
  assert.equal(parsed.untrustedExtra, undefined);
  assert.equal(parsed.phases[0].untrustedExtra, undefined);
  assert.deepEqual(SUPPORTED_WORKOUT_PRESCRIPTION_RESOLVERS, [
    { schemaVersion: 1, id: "legacy-hr-target-resolver", version: 1 },
  ]);

  const unknownResolver = structuredClone(persisted);
  unknownResolver.resolver = { id: "future-adaptive-resolver", version: 1 };
  assert.equal(parseResolvedWorkoutPrescription(unknownResolver), null);
  const unknownLegacyVersion = structuredClone(persisted);
  unknownLegacyVersion.resolver.version = 2;
  assert.equal(parseResolvedWorkoutPrescription(unknownLegacyVersion), null);
  const unknownSchema = structuredClone(persisted);
  unknownSchema.schemaVersion = 2;
  assert.equal(parseResolvedWorkoutPrescription(unknownSchema), null);
});

test("persisted parser fails closed on malformed controller-facing phase fields", () => {
  const valid = JSON.parse(JSON.stringify(resolveWorkoutPrescription({
    workoutSelector: "Monday",
    blocks: { warm: 1, sustain: 2, cool: 1 },
    hrTargets: {
      warmup: "130–140", warmup_intensity_id: "warmup_easy",
      cooldown: "<120", cooldown_intensity_id: "cooldown", main_set_kind: "work",
      intervals: { repetitions: 1, isSequence: false, phases: [
        { phase: "hard", kind: "work", duration: 1, target_hr_bpm: "≥160 (cap 170)", intensity_id: "vo2_short" },
        { phase: "easy", kind: "recovery", duration: 1, target_hr_bpm: "120–135", intensity_id: "recovery" },
      ] },
    },
    resolvedAt: "2026-01-01T00:00:00.000Z",
  })));
  assert.ok(parseResolvedWorkoutPrescription(valid));

  const invalidMutations = [
    (value) => { value.phases[0].expectedHeartRate.min = "potato"; },
    (value) => { value.phases[0].expectedHeartRate.max = -900; },
    (value) => { value.phases[0].expectedHeartRate = { min: 150, max: 140 }; },
    (value) => { value.phases[0].expectedHeartRate = { min: 131, max: 140 }; },
    (value) => { delete value.phases[0].expectedHeartRate.min; },
    (value) => { value.phases[0].expectedHeartRate.min = Number.POSITIVE_INFINITY; },
    (value) => { value.phases[1].activeEndSec = value.phases[1].activeStartSec; },
    (value) => { delete value.phases[1].activeEndSec; },
    (value) => { value.phases[1].intervalIndex = 0; },
    (value) => { value.phases[1].intensityId = "mystery"; },
    (value) => { value.phases[1].displayTargetHrBpm = { min: 160, max: 170 }; },
    (value) => { value.phases[1].explanationCode = "trust_me"; },
    (value) => { value.phases[1].quality = "high"; },
    (value) => { value.phases[1].source = "no_numeric_target"; },
    (value) => { value.phases[1].phaseId = ""; },
    (value) => { value.phases[1].kind = "sprint"; },
    (value) => { value.workoutSelector = ""; },
    (value) => { value.resolvedAt = ""; },
  ];
  for (const mutate of invalidMutations) {
    const malformed = structuredClone(valid);
    mutate(malformed);
    assert.equal(parseResolvedWorkoutPrescription(malformed), null);
  }
});

test("persisted normalized HR targets are sanitized and reject unsafe controller inputs", () => {
  const valid = {
    warmup: "130–140",
    warmup_intensity_id: "warmup_easy",
    main_set: "",
    main_set_kind: "work",
    intervals: {
      repetitions: 2,
      isSequence: false,
      phases: [
        { phase: "hard", kind: "work", duration: 1, target_hr_bpm: "≥160 (cap 170)", intensity_id: "vo2_short" },
        { phase: "easy", kind: "recovery", duration: 1, target_hr_bpm: "120–135", intensity_id: "recovery" },
      ],
    },
    cooldown: "<120",
    cooldown_intensity_id: "cooldown",
  };
  const parsed = parsePersistedHrTargetsForDay(valid);
  assert.ok(parsed);
  assert.equal(parsed.main_set, undefined);
  assert.notEqual(parsed, valid);

  const invalidMutations = [
    (value) => { value.warmup = "999"; },
    (value) => { value.cooldown = "<999"; },
    (value) => { value.warmup_intensity_id = "mystery"; },
    (value) => { value.main_set_kind = "sprint"; },
    (value) => { value.intervals.phases[0].kind = "sprint"; },
    (value) => { value.intervals.phases[0].duration = -1; },
    (value) => { value.intervals.phases[0].target_hr_bpm = { min: 160, max: 170 }; },
    (value) => { value.intervals.repetitions = 0; },
    (value) => { value.intervals.isSequence = "yes"; },
    (value) => { value.intervals.phases = {}; },
  ];
  for (const mutate of invalidMutations) {
    const malformed = structuredClone(valid);
    mutate(malformed);
    assert.equal(parsePersistedHrTargetsForDay(malformed), null);
  }

  const badSubsections = structuredClone(valid);
  badSubsections.warmup_subsections = [
    { name: "one", start_min: 0, end_min: 3, target_hr_bpm: "110–120" },
    { name: "overlap", start_min: 2, end_min: 4, target_hr_bpm: "120–130" },
  ];
  assert.equal(parsePersistedHrTargetsForDay(badSubsections), null);
});

test("resolved numeric inputs preserve representative ProForm controller decisions", () => {
  const target = resolveWorkoutPrescription({
    workoutSelector: "parity",
    blocks: { warm: 0, sustain: 4, cool: 0 },
    hrTargets: { main_set: "155–162", main_set_kind: "work", intervals: null },
    resolvedAt: "2026-01-01T00:00:00.000Z",
  }).phases[0];
  const structured = machineHeartRateTargetFromResolved(target);
  const recent = (bpm, count = 11) => Array.from({ length: count }, (_, index) => ({ elapsedSeconds: index, bpm }));
  const cases = [
    { phaseKind: "work", phaseDurationSeconds: 60, phaseElapsedSeconds: 59, recentHeartRates: recent(145) },
    { phaseKind: "work", phaseDurationSeconds: 120, phaseElapsedSeconds: 60, recentHeartRates: recent(158) },
    { phaseKind: "work", phaseDurationSeconds: 240, phaseElapsedSeconds: 90, recentHeartRates: recent(170) },
    { phaseKind: "recovery", phaseDurationSeconds: 60, phaseElapsedSeconds: 45, recentHeartRates: recent(170) },
    { phaseKind: "work", phaseDurationSeconds: 240, phaseElapsedSeconds: 90, recentHeartRates: recent(145, 2) },
  ];
  for (const [index, scenario] of cases.entries()) {
    const base = {
      machineId: "proform-smart-power-10", activity: "bike", phaseId: `parity:${index}`,
      workoutElapsedSeconds: 90, intervalIndex: 1, ...scenario,
    };
    const explicit = getProFormSmartPower10Guidance(
      { ...base, targetHeartRateMin: 155, targetHeartRateMax: 162 }, createMachineGuidanceState()
    );
    const throughSeam = getProFormSmartPower10Guidance(
      { ...base, ...structured }, createMachineGuidanceState()
    );
    assert.deepEqual(throughSeam, explicit);
  }
  const missing = machineHeartRateTargetFromResolved(undefined);
  assert.deepEqual(missing, { targetHeartRateMin: undefined, targetHeartRateMax: undefined });
});

test("Friday warm-up subsections and variants resolve from frozen structured data", () => {
  const document = parseWorkoutTemplateDocument(rawData);
  transformWorkoutData(document, new Date("2024-01-01T12:00:00Z").getTime());
  const snapshot = capturePhasePlanSnapshot("Friday", "2026-01-01T00:00:00.000Z");
  assert.ok(snapshot);
  assert.equal(findResolvedPhaseTarget(snapshot.resolvedPrescription, "warmup", 60).detailName, "Very Easy");
  const preload = findResolvedPhaseTarget(snapshot.resolvedPrescription, "warmup", 600);
  assert.equal(preload.detailName, "Controlled Pre-Load");
  assert.equal(preload.intensityId, "threshold");
  assert.ok(snapshot.resolvedPrescription.phases.some((phase) => phase.phaseId === "sequence:6"));
  const sessionStorage = memoryStorage();
  startSession("Friday", 1000, "friday-a", "bike", sessionStorage, snapshot);
  const evidence = deriveVo2EvidencePhases({
    day: "Friday",
    blocks: snapshot.blocks,
    activeDurationSec: 12 * 60,
    hrTargets: snapshot.hrTargets,
    resolvedPrescription: snapshot.resolvedPrescription,
  });
  assert.deepEqual(evidence.map((phase) => phase.detail_name), [
    "Very Easy", "Easy Steady", "Moderate Build", "Controlled Pre-Load",
  ]);
  assert.deepEqual(evidence.map((phase) => phase.prescribed.target_hr_bpm), [
    "105–120", "120–130", "130–140", "140–150",
  ]);
  transformWorkoutData(document, new Date("2024-01-08T12:00:00Z").getTime());
  assert.equal(getPlan().Friday.sustain, 24);
  assert.equal(snapshot.blocks.sustain, 25);
  assert.equal(findResolvedPhaseTarget(snapshot.resolvedPrescription, "warmup", 60).detailName, "Very Easy");
  assert.equal(getHrTargets().Friday.intervals.isSequence, false);
  const resumed = getSession("Friday", sessionStorage);
  assert.equal(resumed.phasePlan.blocks.sustain, 25);
  assert.equal(findResolvedPhaseTarget(resumed.phasePlan.resolvedPrescription, "warmup", 60).detailName, "Very Easy");
});

test("Phase B athlete capture leaves the Phase A legacy prescription byte-for-byte unchanged", () => {
  const document = parseWorkoutTemplateDocument(rawData);
  transformWorkoutData(document, new Date("2024-01-01T12:00:00Z").getTime());
  const before = capturePhasePlanSnapshot("Monday", "2026-09-21T12:00:00.000Z");
  const storage = memoryStorage({
    profile: JSON.stringify({ age: 40, weight: 176.37, height: 70, sex: "female", vo2: 55 }),
  });
  startSession("Monday", 1_758_456_000_000, "phase-b-parity", "bike", storage, before);
  const restored = getSession("Monday", storage);
  assert.equal(typeof restored.athleteId, "string");
  assert.equal(restored.athleteFitnessSnapshot.athleteId, restored.athleteId);
  assert.deepEqual(restored.phasePlan.resolvedPrescription, before.resolvedPrescription);
  assert.equal(restored.phasePlan.resolvedPrescription.resolver.id, "legacy-hr-target-resolver");
  assert.equal(restored.phasePlan.resolvedPrescription.resolver.version, 1);
});

test("profile and FitnessState changes leave ordinary resolved prescription byte-for-byte unchanged", () => {
  const document = parseWorkoutTemplateDocument(rawData);
  transformWorkoutData(document, new Date("2024-01-01T12:00:00Z").getTime());
  const before = capturePhasePlanSnapshot("Monday", "2026-09-22T12:00:00.000Z").resolvedPrescription;
  const previousStorage = globalThis.localStorage;
  const storage = memoryStorage({
    athlete_profile_v1: JSON.stringify({
      schemaVersion: 1,
      athleteId: "prescription-boundary",
      demographics: { ageYears: 70, bodyMassLbs: 220 },
      userEnteredVo2: {
        value: 62,
        source: "user_entered",
        quality: "unverified",
        observedAt: "2026-09-22T11:00:00.000Z",
        updatedAt: "2026-09-22T11:00:00.000Z",
      },
      createdAt: "2026-09-22T11:00:00.000Z",
      updatedAt: "2026-09-22T11:00:00.000Z",
    }),
    fitness_state_v1: JSON.stringify({
      schemaVersion: 3,
      athleteId: "prescription-boundary",
      vo2Max: { value: 64 },
      passiveAerobicObservation: { value: { guardedTrendWorkloadWatts: 300, eligibleForPrescription: false } },
      updatedAt: "2026-09-22T11:30:00.000Z",
    }),
  });
  globalThis.localStorage = storage;
  try {
    const after = capturePhasePlanSnapshot("Monday", "2026-09-22T12:00:00.000Z").resolvedPrescription;
    assert.deepEqual(after, before);
    assert.equal(after.resolver.id, "legacy-hr-target-resolver");
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test("resolved prescription survives session serialization and old snapshots remain readable", () => {
  const document = parseWorkoutTemplateDocument(rawData);
  transformWorkoutData(document, new Date("2024-01-01T12:00:00Z").getTime());
  const snapshot = capturePhasePlanSnapshot("Monday", "2026-01-01T00:00:00.000Z");
  const storage = memoryStorage();
  startSession("Monday", 1000, "session-a", "bike", storage, snapshot);
  assert.deepEqual(getSession("Monday", storage).phasePlan.resolvedPrescription, snapshot.resolvedPrescription);
  const oldStorage = memoryStorage({ phase_plan_Monday: JSON.stringify({ blocks: snapshot.blocks, hrTargets: snapshot.hrTargets }) });
  const historical = getSession("Monday", oldStorage);
  assert.ok(historical.phasePlan);
  assert.equal(historical.phasePlan.resolvedPrescription, undefined);

  const malformedPrescription = structuredClone(snapshot.resolvedPrescription);
  malformedPrescription.phases[0].expectedHeartRate.min = "potato";
  const malformedStorage = memoryStorage({
    phase_plan_Monday: JSON.stringify({
      blocks: snapshot.blocks,
      hrTargets: snapshot.hrTargets,
      resolvedPrescription: malformedPrescription,
    }),
  });
  const rejected = getSession("Monday", malformedStorage);
  assert.ok(rejected.phasePlan);
  assert.equal(rejected.phasePlan.resolvedPrescription, undefined);
  const reconstructed = resolveWorkoutPrescription({
    workoutSelector: "Monday",
    blocks: rejected.phasePlan.blocks,
    hrTargets: rejected.phasePlan.hrTargets,
    resolvedAt: "historical-session",
  });
  const reconstructedWork = findResolvedPhaseTarget(reconstructed, "cycle:0:0", 12 * 60);
  assert.deepEqual(machineHeartRateTargetFromResolved(reconstructedWork), {
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
  });

  const unsafeHrTargets = structuredClone(snapshot.hrTargets);
  unsafeHrTargets.intervals.phases[0].target_hr_bpm = "999";
  const doublyMalformedStorage = memoryStorage({
    phase_plan_Monday: JSON.stringify({
      blocks: snapshot.blocks,
      hrTargets: unsafeHrTargets,
      resolvedPrescription: malformedPrescription,
    }),
  });
  const failClosed = getSession("Monday", doublyMalformedStorage);
  assert.ok(failClosed.phasePlan);
  assert.equal(failClosed.phasePlan.resolvedPrescription, undefined);
  assert.equal(failClosed.phasePlan.hrTargets, null);
  const noTargetPrescription = resolveWorkoutPrescription({
    workoutSelector: "Monday",
    blocks: failClosed.phasePlan.blocks,
    hrTargets: failClosed.phasePlan.hrTargets,
    resolvedAt: "historical-session",
  });
  const noControllerTarget = findResolvedPhaseTarget(noTargetPrescription, "sustain", 12 * 60);
  assert.deepEqual(machineHeartRateTargetFromResolved(noControllerTarget), {
    targetHeartRateMin: undefined,
    targetHeartRateMax: undefined,
  });
});

test("ordinary workout summary persists complete frozen resolver provenance", async () => {
  const document = parseWorkoutTemplateDocument(rawData);
  transformWorkoutData(document, new Date("2024-01-01T12:00:00Z").getTime());
  const snapshot = capturePhasePlanSnapshot("Monday", "2026-01-01T00:00:00.000Z");
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  globalThis.window = { getWorkoutMetadata };
  await resetWorkoutStorageForTests();
  const startedAt = Date.now() - 60_000;
  startSession("Monday", startedAt, "prescription-summary", "bike", storage, snapshot);
  const summary = await generateWorkoutSummary("prescription-summary", startedAt, Date.now(), "Monday");
  assert.equal(summary.resolved_prescription.schemaVersion, 1);
  assert.equal(summary.resolved_prescription.resolver.id, "legacy-hr-target-resolver");
  assert.equal(summary.resolved_prescription.resolver.version, 1);
  const work = summary.resolved_prescription.phases.find((phase) => phase.phaseId === "cycle:0:0");
  assert.equal(work.intensityId, "vo2_short");
  assert.deepEqual(work.expectedHeartRate, { min: 160, max: 170 });
  assert.equal(work.source, "legacy_fallback");
  assert.equal(work.quality, "unverified");
  assert.equal(work.explanationCode, "legacy_target_hr_bpm");
});

test("standalone VO2 prescription has no ordinary numeric heart-rate target", () => {
  const prescription = resolveWorkoutPrescription({
    workoutSelector: VO2_WORKOUT_SELECTOR_ID, blocks: vo2PlanBlocks(), hrTargets: null,
    resolvedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(prescription.phases.length > 0);
  assert.ok(prescription.phases.every((phase) => phase.source === "no_numeric_target"));
  assert.ok(prescription.phases.every((phase) => phase.expectedHeartRate === undefined));
});
