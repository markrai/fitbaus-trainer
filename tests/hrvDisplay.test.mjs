import assert from "node:assert/strict";
import test from "node:test";
import {
  formatHrvDisplay,
  isHrvUnavailable,
  HRV_UNAVAILABLE_MIN_CONNECTED_MS,
  HRV_UNAVAILABLE_MIN_CLEAN_MEASUREMENTS,
} from "../dist/platform/hrvDisplay.js";

function base(overrides = {}) {
  return {
    connected: true,
    connectedDurationMs: 5_000,
    cleanMeasurementCountThisSession: 5,
    rrSeenThisSession: true,
    readiness: "collecting",
    ready: false,
    reliable: false,
    rmssdMs: null,
    physiologicalDurationMs: 9_400,
    ...overrides,
  };
}

test("disconnected HRV display shows em dash and no stale value", () => {
  const model = formatHrvDisplay(
    base({
      connected: false,
      readiness: "stable",
      ready: true,
      reliable: true,
      rmssdMs: 42.7,
      physiologicalDurationMs: 60_000,
      rrSeenThisSession: true,
    })
  );
  assert.equal(model.state, "disconnected");
  assert.equal(model.primary, "HRV —");
  assert.equal(model.secondary, "");
});

test("collecting state uses physiological duration seconds", () => {
  const model = formatHrvDisplay(base({ physiologicalDurationMs: 9_400 }));
  assert.equal(model.state, "collecting");
  assert.equal(model.primary, "HRV —");
  assert.equal(model.secondary, "Collecting · 9s");
});

test("collecting → live", () => {
  const collecting = formatHrvDisplay(base({ readiness: "collecting", ready: false }));
  assert.equal(collecting.state, "collecting");
  const live = formatHrvDisplay(
    base({
      readiness: "live",
      ready: true,
      reliable: true,
      rmssdMs: 42.4,
      physiologicalDurationMs: 27_200,
    })
  );
  assert.equal(live.state, "live");
  assert.equal(live.primary, "HRV 42 ms");
  assert.equal(live.secondary, "Live · 27s");
});

test("live → stable", () => {
  const stable = formatHrvDisplay(
    base({
      readiness: "stable",
      ready: true,
      reliable: true,
      rmssdMs: 38.6,
      physiologicalDurationMs: 60_000,
    })
  );
  assert.equal(stable.state, "stable");
  assert.equal(stable.primary, "HRV 39 ms");
  assert.equal(stable.secondary, "60s RMSSD");
});

test("unreliable / signal noisy keeps value visible", () => {
  const model = formatHrvDisplay(
    base({
      readiness: "live",
      ready: true,
      reliable: false,
      rmssdMs: 47.2,
    })
  );
  assert.equal(model.state, "noisy");
  assert.equal(model.primary, "HRV 47 ms");
  assert.equal(model.secondary, "Signal noisy");
});

test("whole-ms RMSSD formatting does not mutate the input", () => {
  const input = base({
    readiness: "stable",
    ready: true,
    reliable: true,
    rmssdMs: 38.6,
  });
  formatHrvDisplay(input);
  assert.equal(input.rmssdMs, 38.6);
  assert.equal(formatHrvDisplay(input).primary, "HRV 39 ms");
});

test("disconnect clears old value", () => {
  const connected = formatHrvDisplay(
    base({
      readiness: "stable",
      ready: true,
      reliable: true,
      rmssdMs: 40,
    })
  );
  assert.equal(connected.primary, "HRV 40 ms");
  const disconnected = formatHrvDisplay(base({ connected: false, rmssdMs: 40, ready: true }));
  assert.equal(disconnected.state, "disconnected");
  assert.equal(disconnected.primary, "HRV —");
});

test("reconnect starts collecting", () => {
  const model = formatHrvDisplay(
    base({
      connected: true,
      connectedDurationMs: 100,
      cleanMeasurementCountThisSession: 0,
      rrSeenThisSession: false,
      readiness: "collecting",
      ready: false,
      rmssdMs: null,
      physiologicalDurationMs: 0,
    })
  );
  assert.equal(model.state, "collecting");
  assert.equal(model.primary, "HRV —");
  assert.equal(model.secondary, "Collecting · 0s");
});

test("BPM-only sensor eventually reports HRV unavailable", () => {
  const input = base({
    rrSeenThisSession: false,
    connectedDurationMs: HRV_UNAVAILABLE_MIN_CONNECTED_MS,
    cleanMeasurementCountThisSession: HRV_UNAVAILABLE_MIN_CLEAN_MEASUREMENTS,
    readiness: "collecting",
    ready: false,
    rmssdMs: null,
    physiologicalDurationMs: 0,
  });
  assert.equal(isHrvUnavailable(input), true);
  const model = formatHrvDisplay(input);
  assert.equal(model.state, "unavailable");
  assert.equal(model.primary, "HRV —");
  assert.equal(model.secondary, "Not provided by sensor");
});

test("late RR arrival prevents/clears unavailable state", () => {
  const before = base({
    rrSeenThisSession: false,
    connectedDurationMs: 25_000,
    cleanMeasurementCountThisSession: 20,
    physiologicalDurationMs: 0,
  });
  assert.equal(formatHrvDisplay(before).state, "unavailable");

  const after = { ...before, rrSeenThisSession: true, physiologicalDurationMs: 1_200 };
  const model = formatHrvDisplay(after);
  assert.equal(model.state, "collecting");
  assert.equal(model.secondary, "Collecting · 1s");
});

test("unavailable rule is not triggered early", () => {
  assert.equal(
    isHrvUnavailable(
      base({
        rrSeenThisSession: false,
        connectedDurationMs: 10_000,
        cleanMeasurementCountThisSession: 20,
      })
    ),
    false
  );
  assert.equal(
    isHrvUnavailable(
      base({
        rrSeenThisSession: false,
        connectedDurationMs: 25_000,
        cleanMeasurementCountThisSession: 5,
      })
    ),
    false
  );
});
