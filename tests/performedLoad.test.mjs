import assert from "node:assert/strict";
import test from "node:test";

import {
  ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
  WORKOUT_RESPONSE_SCHEMA_VERSION_V1,
} from "../dist/types.js";
import { canonicalMedian } from "../dist/stats.js";
import {
  buildPerformedLoadWorkoutView,
  buildPhasePerformedLoadViews,
  discreteResistanceMode,
  medianAbsoluteDeviation,
  observedVsDesiredAgreement,
} from "../dist/performedLoad.js";
import { performedLoadDiagnosticsHtml } from "../dist/performedLoadDiagnosticsView.js";
import {
  deriveWorkoutResponse,
  parseWorkoutResponse,
} from "../dist/workoutResponse.js";
import { resolveWorkoutPrescription } from "../dist/workoutPrescription.js";

function rawSample(overrides = {}) {
  return {
    schemaVersion: ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1,
    athleteId: "athlete-a",
    sessionId: "session-a",
    activeSec: 1,
    observedAt: "2026-09-21T12:00:01.000Z",
    availability: "fresh",
    sourceSampleId: `snapshot-${overrides.activeSec ?? 1}`,
    freshnessMs: 10,
    watts: { value: 108, source: "measured_watts", freshnessMs: 10 },
    cadenceRpm: { value: 70, source: "measured", freshnessMs: 10 },
    observedResistance: { value: 7, source: "observed", freshnessMs: 10 },
    desiredResistance: 8,
    commandedResistance: 8,
    ...overrides,
  };
}

function intervalFixture() {
  const blocks = { warm: 0.1, sustain: 0.2, cool: 0.1 };
  const hrTargets = {
    warmup: "100-110",
    warmup_intensity_id: "warmup_easy",
    cooldown: "95-105",
    cooldown_intensity_id: "cooldown",
    intervals: {
      phases: [
        { phase: "Work", kind: "work", duration: 0.05, target_hr_bpm: "150-160", intensity_id: "vo2_short" },
        { phase: "Recovery", kind: "recovery", duration: 0.05, target_hr_bpm: "110-120", intensity_id: "recovery" },
      ],
      repetitions: 2,
      isSequence: false,
    },
  };
  return {
    blocks,
    prescription: resolveWorkoutPrescription({
      workoutSelector: "Tuesday",
      blocks,
      hrTargets,
      resolvedAt: "2026-09-21T12:00:00.000Z",
    }),
  };
}

function responseFromSamples(bikeSamples, completedActiveSec = 24) {
  const { blocks, prescription } = intervalFixture();
  const hrSamples = Array.from({ length: completedActiveSec }, (_, second) => ({
    session_id: "session-a",
    timestamp_sec: second,
    hr: 100 + second,
  }));
  return deriveWorkoutResponse({
    athleteId: "athlete-a",
    sessionId: "session-a",
    blocks,
    resolvedPrescription: prescription,
    completedActiveSec,
    cancelled: false,
    hrSamples,
    bikeSamples,
  });
}

test("resistance mode uses the dominant integer", () => {
  assert.equal(discreteResistanceMode([7, 7, 7, 8, 8]), 7);
});

test("resistance mode tie closest to median wins", () => {
  assert.equal(discreteResistanceMode([5, 5, 8, 8, 7]), 8);
});

test("resistance mode equidistant tie picks the lower value", () => {
  assert.equal(discreteResistanceMode([6, 6, 8, 8]), 6);
});

test("resistance mode ignores non-integers and fabricates nothing when empty", () => {
  assert.equal(discreteResistanceMode([7.5, 8.2, Number.NaN]), undefined);
  assert.equal(discreteResistanceMode([]), undefined);
});

test("canonical median and MAD share even-length averaging", () => {
  assert.equal(canonicalMedian([1, 2, 3, 4]), 2.5);
  assert.equal(medianAbsoluteDeviation([1, 2, 3, 4]), 1);
  assert.equal(medianAbsoluteDeviation([68, 70, 71, 69, 72]), 1);
  assert.equal(medianAbsoluteDeviation([100, 108, 104, 110, 106]), 2);
  assert.equal(medianAbsoluteDeviation([]), undefined);
});

test("observed-vs-desired agreement is paired-row and 0.75 on the canonical fixture", () => {
  const samples = [
    rawSample({ activeSec: 1, desiredResistance: 8, observedResistance: { value: 8, source: "observed", freshnessMs: 10 } }),
    rawSample({ activeSec: 2, desiredResistance: 8, observedResistance: { value: 7, source: "observed", freshnessMs: 10 } }),
    rawSample({ activeSec: 3, desiredResistance: 8, observedResistance: { value: 8, source: "observed", freshnessMs: 10 } }),
    rawSample({ activeSec: 4, desiredResistance: 8, observedResistance: { value: 8, source: "observed", freshnessMs: 10 } }),
  ];
  assert.equal(observedVsDesiredAgreement(samples), 0.75);
});

test("agreement excludes missing desired, missing observed, and stale rows", () => {
  const samples = [
    rawSample({ activeSec: 1, desiredResistance: 8, observedResistance: { value: 8, source: "observed", freshnessMs: 10 } }),
    rawSample({ activeSec: 2, desiredResistance: undefined, observedResistance: { value: 8, source: "observed", freshnessMs: 10 } }),
    rawSample({ activeSec: 3, desiredResistance: 8, observedResistance: undefined }),
    rawSample({
      activeSec: 4,
      availability: "stale",
      watts: undefined,
      cadenceRpm: undefined,
      observedResistance: undefined,
      desiredResistance: 8,
    }),
  ];
  assert.equal(observedVsDesiredAgreement(samples), 1);
});

test("agreement is unavailable without comparable rows", () => {
  assert.equal(observedVsDesiredAgreement([]), undefined);
  assert.equal(observedVsDesiredAgreement([
    rawSample({ availability: "unavailable", watts: undefined, cadenceRpm: undefined, observedResistance: undefined }),
  ]), undefined);
});

test("uneven sampling agreement is sample-weighted not time-weighted", () => {
  const samples = [
    rawSample({ activeSec: 1, desiredResistance: 8, observedResistance: { value: 8, source: "observed", freshnessMs: 10 } }),
    rawSample({ activeSec: 2, desiredResistance: 8, observedResistance: { value: 7, source: "observed", freshnessMs: 10 } }),
    rawSample({ activeSec: 10, desiredResistance: 8, observedResistance: { value: 8, source: "observed", freshnessMs: 10 } }),
  ];
  assert.equal(observedVsDesiredAgreement(samples), 2 / 3);
});

test("recommend R8 observe mostly R7 keeps desired distinct from observed mode", () => {
  const bikeSamples = [6, 7, 8].map((activeSec, index) => rawSample({
    activeSec,
    sourceSampleId: `s-${activeSec}`,
    desiredResistance: 8,
    commandedResistance: 8,
    observedResistance: { value: index === 0 ? 8 : 7, source: "observed", freshnessMs: 10 },
  }));
  const response = responseFromSamples(bikeSamples);
  assert.ok(response);
  const work = buildPhasePerformedLoadViews(response, bikeSamples).find((phase) => phase.kind === "work");
  assert.ok(work);
  assert.equal(work.desiredResistanceMedian, 8);
  assert.equal(work.observedResistanceMode, 7);
});

test("manual control observation remains usable without a command", () => {
  const bikeSamples = [6, 7, 8].map((activeSec) => rawSample({
    activeSec,
    sourceSampleId: `manual-${activeSec}`,
    desiredResistance: 8,
    commandedResistance: undefined,
    observedResistance: { value: 7, source: "observed", freshnessMs: 10 },
  }));
  const response = responseFromSamples(bikeSamples);
  assert.ok(response);
  const work = buildPhasePerformedLoadViews(response, bikeSamples).find((phase) => phase.kind === "work");
  assert.ok(work);
  assert.equal(work.desiredResistanceMedian, 8);
  assert.equal(work.commandedResistanceMedian, undefined);
  assert.equal(work.observedResistanceMode, 7);
});

test("automatic control keeps desired, commanded, and observed independent", () => {
  const bikeSamples = [6, 7, 8].map((activeSec, index) => rawSample({
    activeSec,
    sourceSampleId: `auto-${activeSec}`,
    desiredResistance: 8,
    commandedResistance: 8,
    observedResistance: { value: index < 2 ? 7 : 8, source: "observed", freshnessMs: 10 },
  }));
  const response = responseFromSamples(bikeSamples);
  assert.ok(response);
  const work = buildPhasePerformedLoadViews(response, bikeSamples).find((phase) => phase.kind === "work");
  assert.ok(work);
  assert.equal(work.desiredResistanceMedian, 8);
  assert.equal(work.commandedResistanceMedian, 8);
  assert.equal(work.observedResistanceMode, 7);
  assert.notEqual(work.observedResistanceMode, work.commandedResistanceMedian);
});

test("missing telemetry does not copy recommendation into observation", () => {
  const response = responseFromSamples([]);
  assert.ok(response);
  const views = buildPhasePerformedLoadViews(response, []);
  for (const phase of views) {
    assert.equal(phase.observedResistanceMedian, undefined);
    assert.equal(phase.observedResistanceMode, undefined);
    assert.equal(phase.observedVsDesiredAgreement, undefined);
    assert.equal(phase.desiredResistanceMedian, undefined);
  }
});

test("phase assignment uses frozen half-open bounds and distinct interval ids", () => {
  const bikeSamples = [6, 7, 8, 12, 13, 14].map((activeSec) => rawSample({
    activeSec,
    sourceSampleId: `phase-${activeSec}`,
    observedResistance: { value: activeSec < 10 ? 7 : 9, source: "observed", freshnessMs: 10 },
    desiredResistance: 8,
  }));
  const response = responseFromSamples(bikeSamples);
  assert.ok(response);
  const views = buildPhasePerformedLoadViews(response, bikeSamples);
  const works = views.filter((phase) => phase.kind === "work");
  assert.equal(works.length, 2);
  assert.notEqual(works[0].phaseInstanceId, works[1].phaseInstanceId);
  assert.equal(works[0].observedResistanceMode, 7);
  assert.equal(works[1].observedResistanceMode, 9);
  const ownerOfSix = views.find((phase) => phase.activeStartSec <= 6 && 6 < phase.activeEndSec);
  assert.ok(ownerOfSix);
  assert.equal(ownerOfSix.kind, "work");
});

test("pause gaps do not invent agreement occupancy", () => {
  const samples = [
    rawSample({ activeSec: 6, observedResistance: { value: 8, source: "observed", freshnessMs: 10 } }),
    rawSample({ activeSec: 7, observedResistance: { value: 7, source: "observed", freshnessMs: 10 } }),
    rawSample({ activeSec: 8, observedResistance: { value: 8, source: "observed", freshnessMs: 10 } }),
  ];
  const response = responseFromSamples(samples);
  assert.ok(response);
  const work = buildPhasePerformedLoadViews(response, samples).find((phase) => phase.kind === "work");
  assert.equal(work.observedVsDesiredAgreement, 2 / 3);
});

test("schema v1 response still parses identically", () => {
  const response = responseFromSamples([rawSample({ activeSec: 6 })]);
  assert.ok(response);
  assert.equal(response.schemaVersion, WORKOUT_RESPONSE_SCHEMA_VERSION_V1);
  const roundTrip = parseWorkoutResponse(JSON.parse(JSON.stringify(response)));
  assert.deepEqual(roundTrip, response);
});

test("historical workout without workout_response still loads as unavailable evidence", () => {
  assert.equal(parseWorkoutResponse(undefined), null);
  const html = performedLoadDiagnosticsHtml([]);
  assert.match(html, /No ordinary bike performed-load evidence yet/);
});

test("response-only diagnostics keep durable fields and omit distribution stats", () => {
  const bikeSamples = [6, 7, 8].map((activeSec) => rawSample({
    activeSec,
    sourceSampleId: `durable-${activeSec}`,
    desiredResistance: 8,
    commandedResistance: 8,
    observedResistance: { value: 7, source: "observed", freshnessMs: 10 },
  }));
  const response = responseFromSamples(bikeSamples);
  assert.ok(response);
  const workout = buildPerformedLoadWorkoutView({
    response,
    samples: [],
    startedAt: "2026-09-21T12:00:00.000Z",
    day: "Tuesday",
    intent: "test",
  });
  const work = workout.phases.find((phase) => phase.kind === "work");
  assert.ok(work);
  assert.equal(work.desiredResistanceMedian, 8);
  assert.equal(work.commandedResistanceMedian, 8);
  assert.equal(work.observedResistanceMedian, 7);
  assert.equal(work.hr?.median, 107);
  assert.equal(work.observedResistanceMode, undefined);
  assert.equal(work.cadenceMadRpm, undefined);
  assert.equal(work.wattsMad, undefined);
  assert.equal(work.observedVsDesiredAgreement, undefined);
  const html = performedLoadDiagnosticsHtml([workout]);
  assert.match(html, /Observed mode/);
  assert.match(html, /unavailable/);
  assert.match(html, /Desired/);
  assert.doesNotMatch(html, /No ordinary bike performed-load evidence yet/);
});
