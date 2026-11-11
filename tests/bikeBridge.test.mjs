import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  parseBikeBridgeBaseUrl,
  joinBikeBridgeUrl,
  loadBikeBridgeSettings,
  saveBikeBridgeSettings,
  parseBikeBridgePairingToken,
  NATIVE_PROFORM_BRIDGE_ORIGIN,
  BIKE_BRIDGE_STORAGE_KEY,
} from "../dist/platform/bikeBridgeConfig.js";
import {
  parseBikeTelemetry,
  parseBridgeStatus,
  parseResistanceAccepted,
  toBridgeBrightness,
  toBridgeHeartRateBpm,
  toBridgeResistanceLevel,
  createBikeBridgeClient,
} from "../dist/platform/bikeBridgeClient.js";
import {
  createBikeBridgeSession,
  describeBikeBridgeCommandStatus,
  formatBikeBridgeHeartRateDelivery,
  formatBikeBridgeControl,
  formatBikeBridgeReadiness,
  BRIDGE_HEART_RATE_DISPLAY_FRESH_MS,
  setBikeBridgeSessionForTests,
  startBikeBridgeRuntime,
} from "../dist/platform/bikeBridgeRuntime.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return {
    promise,
    resolve() {
      resolve();
    },
  };
}

async function waitUntil(predicate, ms = 250) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("timed out waiting for condition");
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function metric(value) {
  return {
    value,
    observedAt: value === null ? null : "2026-08-28T12:00:00.000Z",
    current: value !== null,
  };
}

function createFakeBikeBridge(initial = {}) {
  const state = {
    connected: true,
    initialized: true,
    controlAvailable: true,
    requested: null,
    observed: 3,
    rpm: 56,
    watts: 42,
    latencyMs: 0,
    failNext: null,
    postInFlight: 0,
    maxPostInFlight: 0,
    posts: [],
    heartratePosts: [],
    brightnessPosts: [],
    pollInFlight: 0,
    maxPollInFlight: 0,
    ...initial,
  };

  const transport = {
    async request(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const isPost = req.method === "POST";
      const isPoll = req.method === "GET";
      state.requestHeaders = state.requestHeaders ?? [];
      state.requestHeaders.push({ method: req.method, path, headers: req.headers ?? null });
      if (isPost && state.pairingToken !== undefined) {
        const presented = req.headers?.["X-Fitbaus-Token"];
        if (presented !== state.pairingToken) {
          state.rejectedPosts = (state.rejectedPosts ?? 0) + 1;
          return { status: 401, text: JSON.stringify({ error: "pairing required" }) };
        }
      }
      if (isPost) {
        if (path === "/api/v1/resistance") {
          state.postInFlight += 1;
          state.maxPostInFlight = Math.max(state.maxPostInFlight, state.postInFlight);
          state.posts.push(req.jsonBody);
        }
        if (path === "/api/v1/heartrate") state.heartratePosts.push(req.jsonBody);
        if (path === "/api/v1/brightness") state.brightnessPosts.push(req.jsonBody);
      }
      if (isPoll) {
        state.pollInFlight += 1;
        state.maxPollInFlight = Math.max(state.maxPollInFlight, state.pollInFlight);
      }
      try {
        if (state.latencyMs) await delay(state.latencyMs);
        const pathLatency = state.latencyByPath?.[path];
        if (pathLatency) await delay(pathLatency);
        if (state.holdByPath?.[path]) await state.holdByPath[path];
        const failMatches = state.failNext && (!state.failNext.path || state.failNext.path === path);
        if (failMatches && state.failNext.timeout) {
          if (state.failNext.once) state.failNext = null;
          const error = new Error("timeout");
          error.name = "AbortError";
          throw error;
        }
        if (failMatches && state.failNext.drop) {
          if (state.failNext.once) state.failNext = null;
          throw new Error("Failed to fetch");
        }
        if (failMatches) {
          const fail = state.failNext;
          if (fail.once) state.failNext = null;
          return {
            status: fail.status ?? 500,
            text: fail.text ?? JSON.stringify({ error: fail.error || "failed" }),
          };
        }
        if (req.method === "GET" && path === "/api/v1/status") {
          if (state.statusText !== undefined) return { status: 200, text: state.statusText };
          return {
            status: 200,
            text: JSON.stringify({
              status: "ok",
              bridgeVersion: "0.1.0-poc",
              connected: state.connected,
              initialized: state.initialized,
              resistanceControlAvailable: state.controlAvailable,
              resistance: {
                requested: state.requested,
                requestedAt: state.requested == null ? null : "2026-08-28T12:00:00.000Z",
                observed: state.observed,
                observedAt: state.observed == null ? null : "2026-08-28T12:00:00.000Z",
              },
            }),
          };
        }
        if (req.method === "GET" && path === "/api/v1/telemetry") {
          if (state.telemetryText !== undefined) return { status: 200, text: state.telemetryText };
          return {
            status: 200,
            text: JSON.stringify({
              connected: state.connected,
              initialized: state.initialized,
              snapshotAt: "2026-08-28T12:00:00.000Z",
              resistance: metric(state.observed),
              rpm: metric(state.rpm),
              watts: metric(state.watts),
              machine: null,
            }),
          };
        }
        if (req.method === "POST" && path === "/api/v1/resistance") {
          const value = req.jsonBody.value;
          state.requested = value;
          return { status: 200, text: JSON.stringify({ requested: value }) };
        }
        if (req.method === "POST" && path === "/api/v1/heartrate") {
          const value = req.jsonBody.value;
          return { status: 200, text: JSON.stringify({ requested: value }) };
        }
        if (req.method === "POST" && path === "/api/v1/brightness") {
          const value = req.jsonBody.value;
          return { status: 200, text: JSON.stringify({ requested: value }) };
        }
        return { status: 404, text: JSON.stringify({ error: "not found" }) };
      } finally {
        if (isPost && path === "/api/v1/resistance") state.postInFlight -= 1;
        if (isPoll) state.pollInFlight -= 1;
      }
    },
  };

  return { state, transport };
}

// Sessions that call beginPolling() are always stopped after each test, even when
// assertions fail before an explicit session.stop() — otherwise the poll interval
// keeps Node alive and CI hangs until the job is cancelled.
const livePollingSessions = new Set();

function beginPolling(session) {
  livePollingSessions.add(session);
  session.start();
}

afterEach(() => {
  for (const session of livePollingSessions) {
    session.stop();
  }
  livePollingSessions.clear();
});

async function waitForControl(session) {
  beginPolling(session);
  await waitUntil(() => session.getViewState().readiness === "control_ready");
}

// overrides.automaticControlEnabled seeds a legacy persisted value (as older installs stored it).
// It must never change command behavior.
function readySession(fake, overrides = {}) {
  const storage = overrides.storage ?? memoryStorage(
    overrides.automaticControlEnabled === undefined
      ? {}
      : { [BIKE_BRIDGE_STORAGE_KEY]: JSON.stringify({ baseUrl: "", automaticControlEnabled: overrides.automaticControlEnabled }) }
  );
  const session = createBikeBridgeSession({
    storage,
    transport: fake.transport,
    pollIntervalMs: overrides.pollIntervalMs ?? 1000,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 50,
    freestyleLatchDebounceMs: overrides.freestyleLatchDebounceMs,
    freestyleHoldMismatchConfirmPolls: overrides.freestyleHoldMismatchConfirmPolls,
    freestyleHoldMinCorrectionSpacingMs: overrides.freestyleHoldMinCorrectionSpacingMs,
    freestyleHoldMaxCorrectionAttempts: overrides.freestyleHoldMaxCorrectionAttempts,
    freestyleHoldBackoffMs: overrides.freestyleHoldBackoffMs,
    freestyleHoldActivePedalRpmMin: overrides.freestyleHoldActivePedalRpmMin,
    freestyleHoldFailureWindowMs: overrides.freestyleHoldFailureWindowMs,
    freestyleHoldStableClearMs: overrides.freestyleHoldStableClearMs,
    now: overrides.now,
    getCurrentBpm: overrides.getCurrentBpm,
    subscribeBpm: overrides.subscribeBpm,
  });
  const configured = session.configure({
    baseUrl: "http://192.168.1.10:8765",
  });
  assert.equal(configured.ok, true);
  return session;
}

test("bike bridge URL trims whitespace and trailing slash", () => {
  const parsed = parseBikeBridgeBaseUrl("  http://192.168.1.10:8765/  ");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.normalized, "http://192.168.1.10:8765");
  assert.equal(joinBikeBridgeUrl(parsed.normalized, "/api/v1/status"), "http://192.168.1.10:8765/api/v1/status");
});

test("bike bridge URL rejects missing, invalid, and non-http values", () => {
  assert.equal(parseBikeBridgeBaseUrl("").ok, false);
  assert.equal(parseBikeBridgeBaseUrl("   ").ok, false);
  assert.equal(parseBikeBridgeBaseUrl("not-a-url").ok, false);
  assert.equal(parseBikeBridgeBaseUrl("ftp://192.168.1.10:8765").ok, false);
  assert.equal(parseBikeBridgeBaseUrl("http://192.168.1.10:8765/api").ok, false);
});

test("missing configuration is a typed not_configured outcome", async () => {
  const fake = createFakeBikeBridge();
  const client = createBikeBridgeClient(() => "", fake.transport, 50);
  const result = await client.getStatus();
  assert.equal(result.ok, false);
  assert.equal(result.kind, "not_configured");
});

test("unset storage defaults to the native ProForm origin with no automatic-control setting", () => {
  const loaded = loadBikeBridgeSettings(memoryStorage());
  assert.equal(loaded.baseUrl, NATIVE_PROFORM_BRIDGE_ORIGIN);
  assert.equal("automaticControlEnabled" in loaded, false, "automatic resistance is not an opt-in");
});

test("readiness labels distinguish telemetry-only from control-ready", () => {
  assert.equal(formatBikeBridgeReadiness("telemetry_ready"), "Telemetry only");
  assert.equal(formatBikeBridgeReadiness("control_ready"), "Control ready");
  assert.equal(formatBikeBridgeReadiness("reachable_disconnected"), "Bike disconnected");
  assert.equal(formatBikeBridgeReadiness("unreachable"), "Unreachable");
});

test("app start adopts the native ProForm origin when the stored URL is empty", async () => {
  const fake = createFakeBikeBridge({ controlAvailable: false });
  const session = createBikeBridgeSession({
    storage: memoryStorage({
      [BIKE_BRIDGE_STORAGE_KEY]: JSON.stringify({
        baseUrl: "",
        automaticControlEnabled: false,
      }),
    }),
    transport: fake.transport,
    pollIntervalMs: 40,
    requestTimeoutMs: 50,
  });
  setBikeBridgeSessionForTests(session);
  try {
    assert.equal(session.getViewState().configuredUrl, "");
    startBikeBridgeRuntime();
    assert.equal(session.getViewState().configuredUrl, NATIVE_PROFORM_BRIDGE_ORIGIN);
    await waitUntil(() => session.getViewState().readiness === "telemetry_ready");
    assert.equal("automaticControlEnabled" in session.getViewState(), false);
    assert.equal(session.getViewState().controlAvailable, false);
  } finally {
    session.stop();
    setBikeBridgeSessionForTests(null);
  }
});

test("telemetry-only recovery clears lastError after an unreachable poll", async () => {
  const fake = createFakeBikeBridge({ controlAvailable: false });
  const session = readySession(fake, { automaticControlEnabled: false, pollIntervalMs: 40 });
  try {
    beginPolling(session);
    await waitUntil(() => session.getViewState().readiness === "telemetry_ready");
    fake.state.failNext = { drop: true };
    await waitUntil(() => session.getViewState().readiness === "unreachable");
    assert.ok(session.getViewState().lastError);
    fake.state.failNext = null;
    await waitUntil(() => session.getViewState().readiness === "telemetry_ready");
    assert.equal(session.getViewState().lastError, null);
  } finally {
    session.stop();
  }
});

test("status ready, disconnected, not initialized, and control unavailable", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  try {
    beginPolling(session);
    await waitUntil(() => session.getViewState().readiness === "control_ready");
    assert.equal(session.getViewState().controlAvailable, true);

    fake.state.controlAvailable = false;
    await delay(5);
    session.stop();
    beginPolling(session);
    await waitUntil(() => session.getViewState().readiness === "telemetry_ready");
    assert.equal(session.getViewState().controlAvailable, false);

    fake.state.initialized = false;
    session.stop();
    beginPolling(session);
    await waitUntil(() => session.getViewState().readiness === "reachable_not_initialized");

    fake.state.connected = false;
    session.stop();
    beginPolling(session);
    await waitUntil(() => session.getViewState().readiness === "reachable_disconnected");
  } finally {
    session.stop();
  }
});

test("malformed status becomes invalid_response", async () => {
  const fake = createFakeBikeBridge({ statusText: "{\"nope\":true}" });
  const session = readySession(fake, { automaticControlEnabled: false });
  try {
    beginPolling(session);
    await waitUntil(() => session.getViewState().readiness === "invalid_response");
  } finally {
    session.stop();
  }
});

test("timeout and unreachable status are distinguished", async () => {
  const timeoutFake = createFakeBikeBridge({ failNext: { timeout: true } });
  const timeoutSession = readySession(timeoutFake, { automaticControlEnabled: false });
  try {
    timeoutSession.start();
    await waitUntil(() => timeoutSession.getViewState().lastError === "timeout");
    assert.equal(timeoutSession.getViewState().readiness, "unreachable");
  } finally {
    timeoutSession.stop();
  }

  const dropFake = createFakeBikeBridge({ failNext: { drop: true } });
  const dropSession = readySession(dropFake, { automaticControlEnabled: false });
  try {
    dropSession.start();
    await waitUntil(() => dropSession.getViewState().readiness === "unreachable");
    assert.match(dropSession.getViewState().lastError ?? "", /Failed to fetch|unreachable/i);
  } finally {
    dropSession.stop();
  }
});

test("telemetry preserves null, observed zero, and normal values", async () => {
  const fake = createFakeBikeBridge({ observed: null, rpm: 0, watts: 42 });
  const session = readySession(fake, { automaticControlEnabled: false });
  try {
    beginPolling(session);
    await waitUntil(() => session.getViewState().rpm === 0);
    const state = session.getViewState();
    assert.equal(state.observedResistance, null);
    assert.equal(state.observedResistanceCurrent, false);
    assert.equal(state.rpm, 0);
    assert.equal(state.rpmCurrent, true);
    assert.equal(state.watts, 42);
    assert.equal(state.wattsCurrent, true);
    assert.equal(state.telemetrySnapshotAt, "2026-08-28T12:00:00.000Z");
    assert.equal(typeof state.telemetryReceivedAtMs, "number");
  } finally {
    session.stop();
  }
});

test("failed telemetry poll keeps the last valid sample and marks it stale", async () => {
  const fake = createFakeBikeBridge({ observed: 5, rpm: 60, watts: 100 });
  const session = readySession(fake, { automaticControlEnabled: false });
  try {
    beginPolling(session);
    await waitUntil(() => session.getViewState().observedResistance === 5);
    fake.state.failNext = { path: "/api/v1/telemetry", status: 500, error: "boom" };
    session.stop();
    beginPolling(session);
    await waitUntil(() => session.getViewState().telemetryStale === true);
    const state = session.getViewState();
    assert.equal(state.observedResistance, 5);
    assert.equal(state.rpm, 60);
    assert.equal(state.watts, 100);
  } finally {
    session.stop();
  }
});

test("malformed telemetry does not fabricate values", () => {
  assert.equal(parseBikeTelemetry({ connected: true }), undefined);
  assert.equal(parseBridgeStatus({ status: "ok" }), undefined);
  assert.equal(parseResistanceAccepted({ requested: "4" }), undefined);
});

test("controller sends exactly one absolute POST body and does not mutate observed", async () => {
  const fake = createFakeBikeBridge({ observed: 3, latencyMs: 5 });
  const session = readySession(fake);
  try {
    beginPolling(session);
    await waitUntil(() => session.getViewState().observedResistance === 3);
    session.onGuidance({
      desiredResistance: 4,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
    });
    await waitUntil(() => fake.state.posts.length === 1);
    await delay(20);
    assert.equal(fake.state.posts.length, 1);
    assert.deepEqual(fake.state.posts[0], { value: 4 });
    assert.equal(JSON.stringify(fake.state.posts[0]), "{\"value\":4}");
    assert.equal(session.getViewState().requestedResistance, 4);
    assert.equal(session.getViewState().observedResistance, 3);
    fake.state.observed = 4;
    session.stop();
    beginPolling(session);
    await waitUntil(() => session.getViewState().observedResistance === 4);
    assert.equal(session.getViewState().desiredResistance, 4);
  } finally {
    session.stop();
  }
});

test("redundant identical requests are suppressed after accept", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  try {
    await waitForControl(session);
    session.onGuidance({
      desiredResistance: 5,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
    });
    await waitUntil(() => fake.state.posts.length === 1);
    session.onGuidance({
      desiredResistance: 5,
      recommendationChanged: false,
      workoutActive: true,
      paused: false,
    });
    await delay(20);
    assert.equal(fake.state.posts.length, 1);
  } finally {
    session.stop();
  }
});

test("failed request does not mark resistance observed and 503 does not retry-storm", async () => {
  const fake = createFakeBikeBridge({
    failNext: { path: "/api/v1/resistance", status: 503, error: "setter unavailable" },
    observed: 3,
  });
  const session = readySession(fake, { pollIntervalMs: 15 });
  try {
    await waitForControl(session);
    session.onGuidance({
      desiredResistance: 6,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
    });
    await waitUntil(() => fake.state.posts.length === 1);
    await delay(80);
    assert.equal(fake.state.posts.length, 1);
    assert.equal(session.getViewState().observedResistance, 3);
    assert.notEqual(session.getViewState().lastCommandOutcome, "accepted");
  } finally {
    session.stop();
  }
});

test("timeout leaves delivery unknown and does not treat target as observed", async () => {
  const fake = createFakeBikeBridge({
    failNext: { path: "/api/v1/resistance", timeout: true },
    observed: 3,
  });
  const session = readySession(fake);
  try {
    await waitForControl(session);
    session.onGuidance({
      desiredResistance: 7,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
    });
    await waitUntil(() => session.getViewState().lastCommandOutcome === "timeout");
    assert.equal(session.getViewState().observedResistance, 3);
    assert.equal(session.getViewState().lastCommandOutcome, "timeout");
  } finally {
    session.stop();
  }
});

test("overlapping controller decisions do not create overlapping POSTs", async () => {
  const fake = createFakeBikeBridge({ latencyMs: 30 });
  const session = readySession(fake);
  try {
    await waitForControl(session);
    session.onGuidance({
      desiredResistance: 4,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
    });
    session.onGuidance({
      desiredResistance: 5,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
    });
    await waitUntil(() => fake.state.posts.length === 2);
    assert.equal(fake.state.maxPostInFlight, 1);
    assert.deepEqual(fake.state.posts, [{ value: 4 }, { value: 5 }]);
  } finally {
    session.stop();
  }
});

test("polling starts once, does not overlap, and stops cleanly", async () => {
  const fake = createFakeBikeBridge({ latencyMs: 25 });
  const session = readySession(fake, { pollIntervalMs: 10, automaticControlEnabled: false });
  try {
    beginPolling(session);
    beginPolling(session);
    assert.equal(session.isPolling(), true);
    await delay(40);
    assert.equal(fake.state.maxPollInFlight, 1);
    session.stop();
    assert.equal(session.isPolling(), false);
  } finally {
    session.stop();
  }
});

test("reconnection resumes telemetry and sends only the current desired target", async () => {
  const fake = createFakeBikeBridge({ failNext: { drop: true } });
  const session = readySession(fake, { pollIntervalMs: 20 });
  try {
    session.onGuidance({
      desiredResistance: 4,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
    });
    session.onGuidance({
      desiredResistance: 6,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
    });
    beginPolling(session);
    await waitUntil(() => session.getViewState().readiness === "unreachable");
    assert.equal(fake.state.posts.length, 0);
    fake.state.failNext = null;
    await waitUntil(() => fake.state.posts.length === 1);
    assert.deepEqual(fake.state.posts, [{ value: 6 }]);
    await waitUntil(() => session.getViewState().rpm === 56);
  } finally {
    session.stop();
  }
});

test("a legacy persisted automaticControlEnabled=false cannot block authorized structured control", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { automaticControlEnabled: false });
  try {
    beginPolling(session);
    await waitUntil(() => session.getViewState().readiness === "control_ready");
    session.onGuidance({
      desiredResistance: 4,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
    });
    await waitUntil(() => fake.state.posts.length === 1);
    assert.deepEqual(fake.state.posts, [{ value: 4 }]);
    session.configure({ automaticControlEnabled: false });
    session.onGuidance({
      desiredResistance: 5,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
    });
    await waitUntil(() => fake.state.posts.length === 2);
    assert.deepEqual(fake.state.posts.at(-1), { value: 5 }, "configure() no longer accepts a control switch");
  } finally {
    session.stop();
  }
});

test("guidance posts physical ProForm resistance unchanged", async () => {
  assert.equal(toBridgeResistanceLevel(11), 11);
  assert.equal(toBridgeResistanceLevel(12), 12);
  assert.equal(toBridgeResistanceLevel(13), 13);
  assert.equal(toBridgeResistanceLevel(14), 14);
  assert.equal(toBridgeResistanceLevel(15), 15);
  assert.equal(toBridgeResistanceLevel(0), undefined);
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  try {
    await waitForControl(session);
    for (const level of [11, 12, 13, 14, 15]) {
      session.onGuidance({
        desiredResistance: level,
        recommendationChanged: true,
        workoutActive: true,
        paused: false,
      });
      await waitUntil(() => fake.state.posts.length >= level - 10);
    }
    assert.deepEqual(
      fake.state.posts.map((body) => body.value),
      [11, 12, 13, 14, 15]
    );
    assert.equal(session.getViewState().desiredResistance, 15);
  } finally {
    session.stop();
  }
});

test("inactive workout does not send resistance", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  session.onGuidance({
    desiredResistance: 4,
    recommendationChanged: true,
    workoutActive: false,
    paused: false,
  });
  await delay(20);
  assert.equal(fake.state.posts.length, 0);
});

test("toBridgeHeartRateBpm accepts 30-250 integers", () => {
  assert.equal(toBridgeHeartRateBpm(142), 142);
  assert.equal(toBridgeHeartRateBpm(30), 30);
  assert.equal(toBridgeHeartRateBpm(250), 250);
  assert.equal(toBridgeHeartRateBpm(29), undefined);
  assert.equal(toBridgeHeartRateBpm(251), undefined);
  assert.equal(toBridgeHeartRateBpm(Number.NaN), undefined);
});

test("client postHeartRate posts value and parses requested", async () => {
  const fake = createFakeBikeBridge();
  const client = createBikeBridgeClient(() => "http://192.168.1.10:8765", fake.transport, 50);
  const result = await client.postHeartRate(142);
  assert.equal(result.ok, true);
  assert.equal(result.value.requested, 142);
  assert.deepEqual(fake.state.heartratePosts, [{ value: 142 }]);
});

test("session posts HR on strap BPM without waiting for the next poll", async () => {
  const fake = createFakeBikeBridge();
  const bpmListeners = [];
  const session = readySession(fake, {
    pollIntervalMs: 10_000,
    getCurrentBpm: () => 142,
    subscribeBpm: (listener) => {
      bpmListeners.push(listener);
      return () => {
        const index = bpmListeners.indexOf(listener);
        if (index >= 0) bpmListeners.splice(index, 1);
      };
    },
  });
  try {
    beginPolling(session);
    await waitUntil(() => fake.state.heartratePosts.length >= 1, 500);
    assert.deepEqual(fake.state.heartratePosts, [{ value: 142 }]);
    for (const listener of bpmListeners) listener(150);
    await waitUntil(() => fake.state.heartratePosts.some((body) => body.value === 150), 500);
  } finally {
    session.stop();
  }
});

test("session forwards the latest strap BPM after an in-flight HR POST completes", async () => {
  const hrHold = deferred();
  const fake = createFakeBikeBridge({
    holdByPath: { "/api/v1/heartrate": hrHold.promise },
  });
  const bpmListeners = [];
  const session = readySession(fake, {
    pollIntervalMs: 10_000,
    requestTimeoutMs: 1000,
    getCurrentBpm: () => 142,
    subscribeBpm: (listener) => {
      bpmListeners.push(listener);
      return () => {};
    },
  });
  try {
    beginPolling(session);
    await waitUntil(() => fake.state.heartratePosts.length === 1, 500);
    for (const listener of bpmListeners) listener(148);
    for (const listener of bpmListeners) listener(151);
    await delay(40);
    assert.equal(fake.state.heartratePosts.length, 1);
    hrHold.resolve();
    await waitUntil(() => fake.state.heartratePosts.some((body) => body.value === 151), 500);
    assert.equal(
      fake.state.heartratePosts.some((body) => body.value === 148),
      false
    );
  } finally {
    session.stop();
  }
});

test("session posts 1 Hz HR heartbeat including unchanged BPM", async () => {
  const fake = createFakeBikeBridge();
  let bpm = 142;
  const session = readySession(fake, {
    pollIntervalMs: 40,
    getCurrentBpm: () => bpm,
  });
  try {
    beginPolling(session);
    await waitUntil(() => fake.state.heartratePosts.length >= 3, 500);
    assert.ok(fake.state.heartratePosts.every((body) => body.value === 142));
    bpm = 150;
    const before = fake.state.heartratePosts.length;
    await waitUntil(() => fake.state.heartratePosts.some((body, i) => i >= before && body.value === 150), 500);
  } finally {
    session.stop();
  }
});

test("session does not post HR when bridge URL is missing", async () => {
  const fake = createFakeBikeBridge();
  const session = createBikeBridgeSession({
    storage: memoryStorage(),
    transport: fake.transport,
    pollIntervalMs: 40,
    requestTimeoutMs: 50,
    getCurrentBpm: () => 142,
  });
  assert.equal(session.configure({ baseUrl: "" }).ok, true);
  try {
    beginPolling(session);
    await delay(120);
    assert.equal(fake.state.heartratePosts.length, 0);
  } finally {
    session.stop();
  }
});

test("HR POST failure does not mark session unhealthy or stop polling", async () => {
  const fake = createFakeBikeBridge();
  fake.state.failNext = { path: "/api/v1/heartrate", status: 500, error: "hr failed", once: false };
  const session = readySession(fake, {
    pollIntervalMs: 40,
    getCurrentBpm: () => 142,
  });
  try {
    beginPolling(session);
    await waitUntil(() => session.getViewState().readiness === "control_ready", 500);
    await waitUntil(() => fake.state.heartratePosts.length >= 2, 500);
    await waitUntil(() => session.getViewState().heartRateDelivery === "http_error", 500);
    const view = session.getViewState();
    assert.equal(view.readiness, "control_ready");
    assert.equal(view.lastError, null);
    assert.equal(view.rpm, 56);
    assert.equal(view.heartRateDelivery, "http_error");
    assert.equal(view.heartRateLastHttpStatus, 500);
    assert.equal(formatBikeBridgeHeartRateDelivery(view), "Console HR: HTTP 500");
  } finally {
    session.stop();
  }
});

test("HR heartbeat posts while sequential status/telemetry remain in flight", async () => {
  const statusHold = deferred();
  const fake = createFakeBikeBridge({
    holdByPath: { "/api/v1/status": statusHold.promise },
  });
  const session = readySession(fake, {
    pollIntervalMs: 40,
    requestTimeoutMs: 1000,
    getCurrentBpm: () => 142,
  });
  try {
    beginPolling(session);
    await waitUntil(() => fake.state.heartratePosts.length >= 2, 500);
    assert.ok(fake.state.pollInFlight >= 1, "status GET should still be held");
    assert.equal(session.getViewState().heartRateDelivery, "accepted");
    assert.equal(session.getViewState().lastError, null);
    assert.equal(formatBikeBridgeHeartRateDelivery(session.getViewState()), "Console HR: HTTP accepted");
  } finally {
    session.stop();
    statusHold.resolve();
    await waitUntil(() => fake.state.pollInFlight === 0, 250);
  }
});

test("HR forwarding keeps a single in-flight POST", async () => {
  const hrHold = deferred();
  const fake = createFakeBikeBridge({
    holdByPath: { "/api/v1/heartrate": hrHold.promise },
  });
  const session = readySession(fake, {
    pollIntervalMs: 40,
    requestTimeoutMs: 1000,
    getCurrentBpm: () => 142,
  });
  try {
    beginPolling(session);
    await waitUntil(() => fake.state.heartratePosts.length === 1, 500);
    await delay(120);
    assert.equal(fake.state.heartratePosts.length, 1);
  } finally {
    session.stop();
    hrHold.resolve();
    await waitUntil(() => fake.state.pollInFlight === 0, 250);
  }
});

test("missing live BPM is distinct from a healthy console HR connection", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, {
    pollIntervalMs: 40,
    getCurrentBpm: () => null,
  });
  try {
    beginPolling(session);
    await waitUntil(() => session.getViewState().readiness === "control_ready", 500);
    await waitUntil(() => session.getViewState().heartRateDelivery === "no_bpm", 500);
    assert.equal(fake.state.heartratePosts.length, 0);
    const view = session.getViewState();
    assert.equal(view.lastError, null);
    assert.equal(formatBikeBridgeHeartRateDelivery(view), "Console HR: no live BPM");
  } finally {
    session.stop();
  }
});

test("HR pairing rejection is visible without marking telemetry unhealthy", async () => {
  const fake = createFakeBikeBridge({ pairingToken: "XB5G5132" });
  const session = readySession(fake, {
    pollIntervalMs: 40,
    getCurrentBpm: () => 142,
  });
  try {
    beginPolling(session);
    await waitUntil(() => session.getViewState().readiness === "control_ready", 500);
    await waitUntil(() => session.getViewState().heartRateDelivery === "pairing_required", 500);
    const view = session.getViewState();
    assert.equal(view.lastError, null);
    assert.equal(view.heartRateLastHttpStatus, 401);
    assert.equal(formatBikeBridgeHeartRateDelivery(view), "Console HR: pairing rejected");
    const hrPosts = (fake.state.requestHeaders ?? []).filter(
      (r) => r.method === "POST" && r.path === "/api/v1/heartrate"
    );
    assert.ok(hrPosts.length >= 1);
  } finally {
    session.stop();
  }
});

test("accepted console HR older than the Native window is inferred, not claimed blank", () => {
  assert.equal(BRIDGE_HEART_RATE_DISPLAY_FRESH_MS, 3000);
  const accepted = formatBikeBridgeHeartRateDelivery({
    heartRateDelivery: "accepted",
    heartRateLastAcceptedAtMs: 1_000,
    heartRateLastHttpStatus: 200,
  }, 1_000 + BRIDGE_HEART_RATE_DISPLAY_FRESH_MS);
  assert.equal(accepted, "Console HR: HTTP accepted");
  const stale = formatBikeBridgeHeartRateDelivery({
    heartRateDelivery: "accepted",
    heartRateLastAcceptedAtMs: 1_000,
    heartRateLastHttpStatus: 200,
  }, 1_000 + BRIDGE_HEART_RATE_DISPLAY_FRESH_MS + 1);
  assert.equal(stale, "Console HR: HTTP accepted; last accept older than 3s console window");
  assert.ok(!stale.toLowerCase().includes("expired"));
});

test("HR delivery warnings omit pairing tokens and stay bounded across fail/success flaps", async () => {
  const fake = createFakeBikeBridge();
  fake.state.failNext = { path: "/api/v1/heartrate", status: 503, error: "too many connections", once: true };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };
  const session = readySession(fake, {
    pollIntervalMs: 40,
    getCurrentBpm: () => 142,
  });
  try {
    beginPolling(session);
    await waitUntil(() => session.getViewState().heartRateDelivery === "http_error", 500);
    await waitUntil(() => session.getViewState().heartRateDelivery === "accepted", 500);
    fake.state.failNext = { path: "/api/v1/heartrate", status: 503, error: "too many connections", once: true };
    await waitUntil(() => session.getViewState().heartRateDelivery === "http_error", 500);
    assert.ok(warnings.some((line) => line.includes("console heart-rate not delivered") && line.includes("http_error")));
    assert.equal(warnings.filter((line) => line.includes("console heart-rate not delivered")).length, 1);
    assert.ok(warnings.every((line) => !/XB5G5132|X-Fitbaus-Token|token|\b142\b|\bbpm\b/i.test(line)));
    assert.ok(!warnings.some((line) => /heartbeat|accepted/i.test(line) && !line.includes("not delivered")));
  } finally {
    console.warn = originalWarn;
    session.stop();
  }
});

test("settings persist consoleBrightness with default 80", () => {
  const storage = memoryStorage();
  const loaded = loadBikeBridgeSettings(storage);
  assert.equal(loaded.consoleBrightness, 80);
  const saved = saveBikeBridgeSettings(
    { baseUrl: "", automaticControlEnabled: false, consoleBrightness: 12 },
    storage
  );
  assert.equal(saved.consoleBrightness, 12);
  assert.equal(loadBikeBridgeSettings(storage).consoleBrightness, 12);
  assert.equal(
    saveBikeBridgeSettings({ baseUrl: "", automaticControlEnabled: false, consoleBrightness: 140 }, storage)
      .consoleBrightness,
    100
  );
});

test("toBridgeBrightness accepts 0-100 integers", () => {
  assert.equal(toBridgeBrightness(0), 0);
  assert.equal(toBridgeBrightness(80), 80);
  assert.equal(toBridgeBrightness(100), 100);
  assert.equal(toBridgeBrightness(-1), undefined);
  assert.equal(toBridgeBrightness(101), undefined);
  assert.equal(toBridgeBrightness(Number.NaN), undefined);
});

test("client setBrightness posts value and parses requested", async () => {
  const fake = createFakeBikeBridge();
  const client = createBikeBridgeClient(() => "http://192.168.1.10:8765", fake.transport, 50);
  const result = await client.setBrightness(42);
  assert.equal(result.ok, true);
  assert.equal(result.value.requested, 42);
  assert.deepEqual(fake.state.brightnessPosts, [{ value: 42 }]);
});

test("session setConsoleBrightness persists and posts without any resistance command", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { automaticControlEnabled: false });
  const result = await session.setConsoleBrightness(25);
  assert.equal(result.ok, true);
  assert.equal(session.getViewState().consoleBrightness, 25);
  assert.deepEqual(fake.state.brightnessPosts, [{ value: 25 }]);
  assert.equal(fake.state.posts.length, 0);
});

test("configure preserves brightness and URL change does not post it", async () => {
  const fake = createFakeBikeBridge();
  const session = createBikeBridgeSession({
    storage: memoryStorage(),
    transport: fake.transport,
    requestTimeoutMs: 50,
  });
  session.configure({ consoleBrightness: 33 });
  assert.equal(session.getViewState().consoleBrightness, 33);
  assert.equal(fake.state.brightnessPosts.length, 0);
  const configured = session.configure({ baseUrl: "http://192.168.1.10:8765" });
  assert.equal(configured.ok, true);
  await delay(30);
  assert.equal(fake.state.brightnessPosts.length, 0);
  assert.equal(session.getViewState().consoleBrightness, 33);
  const posted = await session.setConsoleBrightness(33);
  assert.equal(posted.ok, true);
  assert.deepEqual(fake.state.brightnessPosts, [{ value: 33 }]);
});


// ---------------------------------------------------------------------------
// F0: manual_freestyle_ride - Bike Bridge authority boundary tests
// ---------------------------------------------------------------------------

// Helpers for Freestyle tests

function freestyleSession(fake, overrides = {}) {
  const session = readySession(fake, overrides);
  session.bindSession({ sessionId: "fs-bridge-001", controlMode: "manual_freestyle_ride" });
  return session;
}

async function waitForTelemetry(session) {
  beginPolling(session);
  await waitUntil(() => session.getViewState().telemetrySnapshotAt !== null);
}

// --- bindSession / getSessionBinding / isDisarmed ---

test("bindSession(freestyle) sets binding and isDisarmed returns false", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  session.bindSession({ sessionId: "fs-001", controlMode: "manual_freestyle_ride" });
  const binding = session.getSessionBinding();
  assert.ok(binding);
  assert.equal(binding.sessionId, "fs-001");
  assert.equal(binding.controlMode, "manual_freestyle_ride");
  assert.equal(session.isDisarmed(), false);
});

test("bindSession(null) sets disarmed and getSessionBinding returns null", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  session.bindSession(null);
  assert.equal(session.isDisarmed(), true);
  assert.equal(session.getSessionBinding(), null);
});

test("initial_unbound state: getSessionBinding returns null and isDisarmed returns false", () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  assert.equal(session.getSessionBinding(), null);
  assert.equal(session.isDisarmed(), false);
});

// --- Scenario 1: No POST commands after Freestyle binding ---

test("F0-1: Freestyle binding prevents any resistance POST during active guidance", async () => {
  const fake = createFakeBikeBridge();
  const session = freestyleSession(fake);
  await waitForControl(session);
  session.onGuidance({
    workoutActive: true,
    paused: false,
    desiredResistance: 8,
    recommendationChanged: true,
    workout: { day: "", sessionId: "fs-bridge-001" },
  });
  await delay(30);
  assert.equal(fake.state.posts.length, 0, "Freestyle must not POST any resistance commands");
  session.stop();
});

// --- Scenario 2: Telemetry polling continues after Freestyle binding ---

test("F0-2: Freestyle binding preserves telemetry polling", async () => {
  const fake = createFakeBikeBridge();
  const session = freestyleSession(fake, { pollIntervalMs: 20 });
  await waitForTelemetry(session);
  const vs = session.getViewState();
  assert.ok(vs.watts !== null || vs.rpm !== null || vs.observedResistance !== null,
    "Telemetry should arrive during Freestyle");
  assert.equal(fake.state.posts.length, 0, "No resistance POSTs during telemetry-only mode");
  session.stop();
});

// --- Scenario 3: Disarmed blocks commands and does not silently restore control ---

test("F0-3: bindSession(null) disarm prevents commands; does not auto-restore on next guidance", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  await waitForControl(session);
  // Prime an active workout first
  session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 5, recommendationChanged: true });
  await delay(20);
  const postsBeforeDisarm = fake.state.posts.length;
  // Disarm
  session.bindSession(null);
  // Send more guidance - must not result in any new POSTs
  session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 9, recommendationChanged: true });
  await delay(30);
  assert.equal(fake.state.posts.length, postsBeforeDisarm, "Disarm must block all subsequent commands");
  assert.equal(session.isDisarmed(), true);
  session.stop();
});

// --- Scenario 4: Stale prior-session guidance rejected ---

test("F0-4: guidance from a different sessionId is rejected after Freestyle bind", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  await waitForControl(session);
  session.bindSession({ sessionId: "fs-current", controlMode: "manual_freestyle_ride" });
  // Simulate stale guidance from a previous session
  session.onGuidance({
    workoutActive: true,
    paused: false,
    desiredResistance: 10,
    recommendationChanged: true,
    workout: { day: "Monday", sessionId: "old-session-id" },
  });
  await delay(30);
  assert.equal(fake.state.posts.length, 0, "Stale foreign session guidance must be rejected");
  session.stop();
});

// --- Scenario 5: Global automatic control toggle cannot re-enable commands during Freestyle ---

test("F0-5: always-on structured control never sends structured commands during Freestyle", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { automaticControlEnabled: true });
  await waitForControl(session);
  session.bindSession({ sessionId: "fs-toggle", controlMode: "manual_freestyle_ride" });
  session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 7, recommendationChanged: true,
    workout: { day: "", sessionId: "fs-toggle" } });
  await delay(10);
  session.configure({ pairingToken: "XB5G5132" });
  await delay(30);
  assert.equal(fake.state.posts.length, 0,
    "Freestyle must not follow structured recommendations even though automatic control is standard");
  assert.equal(session.getViewState().commandAuthorization, "freestyle_policy");
  session.stop();
});

// --- Scenario 6: No reconciliation send after reconnect during Freestyle ---

test("F0-6: bridge reconnect does not trigger reconciliation send during Freestyle", async () => {
  const fake = createFakeBikeBridge({ connected: false });
  const session = freestyleSession(fake, { pollIntervalMs: 20 });
  beginPolling(session);
  session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 6, recommendationChanged: true,
    workout: { day: "", sessionId: "fs-bridge-001" } });
  // Simulate reconnect
  await delay(30);
  fake.state.connected = true;
  fake.state.initialized = true;
  fake.state.controlAvailable = true;
  await delay(60);
  assert.equal(fake.state.posts.length, 0,
    "Reconnect reconciliation must not send resistance during Freestyle");
  session.stop();
});

// --- Scenario 7: Freestyle binding clears stale pending/desired state ---

test("F0-7: bindSession(freestyle) clears desiredResistance and pendingLevel from previous session", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  await waitForControl(session);
  // Prime state with previous session guidance
  session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 8, recommendationChanged: true });
  await delay(20);
  const postsBefore = fake.state.posts.length;
  // Bind Freestyle - must clear stale desired resistance
  session.bindSession({ sessionId: "new-freestyle", controlMode: "manual_freestyle_ride" });
  const vs = session.getViewState();
  assert.equal(vs.desiredResistance, undefined, "Freestyle bind must clear desiredResistance");
  // Send Freestyle guidance - no command must fire
  session.onGuidance({ workoutActive: true, paused: false, recommendationChanged: false,
    workout: { day: "", sessionId: "new-freestyle" } });
  await delay(30);
  assert.equal(fake.state.posts.length, postsBefore, "No new commands after Freestyle rebind");
  session.stop();
});

// --- Scenario 8: Rebinding to a structured session after disarm restores commands ---

test("F0-8: binding a controllable session after disarm re-enables resistance commands", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  await waitForControl(session);
  session.bindSession(null); // disarm
  assert.equal(session.isDisarmed(), true);
  // Bind a new structured session
  session.bindSession({ sessionId: "legacy-after-disarm", controlMode: "legacy_hr_control" });
  assert.equal(session.isDisarmed(), false);
  const binding = session.getSessionBinding();
  assert.ok(binding);
  assert.equal(binding.controlMode, "legacy_hr_control");
  // Send guidance - now commands should be allowed
  session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 5, recommendationChanged: true,
    workout: { day: "Monday", sessionId: "legacy-after-disarm" } });
  await delay(30);
  assert.ok(fake.state.posts.length > 0, "Structured session after disarm should send resistance commands");
  session.stop();
});

// --- Scenario 9: Freestyle viewState shows no desiredResistance or commandedResistance ---

test("F0-9: Freestyle guidance never sets desiredResistance or commandedResistance", async () => {
  const fake = createFakeBikeBridge();
  const session = freestyleSession(fake);
  await waitForControl(session);
  session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 9, recommendationChanged: true,
    workout: { day: "", sessionId: "fs-bridge-001" } });
  await delay(30);
  const vs = session.getViewState();
  assert.equal(vs.desiredResistance, undefined, "desiredResistance must be absent after Freestyle guidance");
  assert.equal(vs.commandedResistance, undefined, "commandedResistance must stay unset without an observed latch");
  session.stop();
});

// --- Scenario 10: Freestyle guidance alone never posts resistance ---

test("F0-10: Freestyle guidance alone does not POST resistance", async () => {
  const fake = createFakeBikeBridge();
  const session = freestyleSession(fake, { pollIntervalMs: 20 });
  await waitForTelemetry(session);
  for (let i = 0; i < 5; i++) {
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: i + 1,
      recommendationChanged: true, workout: { day: "", sessionId: "fs-bridge-001" } });
    await delay(10);
  }
  assert.equal(session.postedResistanceBodies().length, 0,
    "Freestyle guidance/reconcile paths must not POST resistance");
  session.stop();
});

// --- Scenario 11: In-flight command completed before Freestyle bind does not trigger retry ---

test("F0-11a: freestyle bind after dispatch sends zero additional posts on success", async () => {
  const deferred = createDeferredBridge();
  const session = readySession(deferred);
  const resolved = completionWatcher(session);
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "f0-11a", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 5,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "f0-11a" } });
    assert.equal(deferred.state.posts.length, 1);
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 7,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "f0-11a" } });
    assert.equal(deferred.state.posts.length, 1);
    session.bindSession({ sessionId: "f0-11a-fs", controlMode: "manual_freestyle_ride" });
    deferred.state.pending[0].resolve({ status: 200, text: JSON.stringify({ requested: 5 }) });
    await waitUntil(() => resolved.length === 1);
    assert.equal(resolved[0], "accepted");
    assert.equal(deferred.state.posts.length, 1);
    assert.equal(session.getViewState().desiredResistance, undefined);
    assert.equal(session.getViewState().lastCommandOutcome, null);
  } finally {
    session.stop();
  }
});

test("F0-11b: freestyle bind after dispatch sends zero additional posts on failure", async () => {
  const deferred = createDeferredBridge();
  const session = readySession(deferred);
  const resolved = completionWatcher(session);
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "f0-11b", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 5,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "f0-11b" } });
    assert.equal(deferred.state.posts.length, 1);
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 7,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "f0-11b" } });
    assert.equal(deferred.state.posts.length, 1);
    session.bindSession({ sessionId: "f0-11b-fs", controlMode: "manual_freestyle_ride" });
    deferred.state.pending[0].resolve({ status: 500, text: JSON.stringify({ error: "setter unavailable" }) });
    await waitUntil(() => resolved.length === 1);
    assert.equal(resolved[0], "failed");
    assert.equal(deferred.state.posts.length, 1);
    assert.equal(session.getViewState().desiredResistance, undefined);
    assert.equal(session.getViewState().lastCommandOutcome, null);
    assert.equal(session.getViewState().lastError, null);
  } finally {
    session.stop();
  }
});

test("F0-11c: freestyle bind after dispatch sends zero additional posts on timeout", async () => {
  const deferred = createDeferredBridge();
  const session = readySession(deferred);
  const resolved = completionWatcher(session);
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "f0-11c", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 5,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "f0-11c" } });
    assert.equal(deferred.state.posts.length, 1);
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 7,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "f0-11c" } });
    assert.equal(deferred.state.posts.length, 1);
    session.bindSession({ sessionId: "f0-11c-fs", controlMode: "manual_freestyle_ride" });
    const timeout = new Error("timeout");
    timeout.name = "AbortError";
    deferred.state.pending[0].reject(timeout);
    await waitUntil(() => resolved.length === 1);
    assert.equal(resolved[0], "timeout");
    assert.equal(deferred.state.posts.length, 1);
    assert.equal(session.getViewState().desiredResistance, undefined);
    assert.equal(session.getViewState().lastCommandOutcome, null);
  } finally {
    session.stop();
  }
});

// --- Scenario 12: Freestyle binding does not affect telemetry readiness classification ---

test("F0-12: readiness classification is unaffected by Freestyle binding", async () => {
  const fake = createFakeBikeBridge();
  const session = freestyleSession(fake, { pollIntervalMs: 20 });
  await waitForTelemetry(session);
  const vs = session.getViewState();
  // Readiness should still reflect the physical bridge state
  assert.ok(
    vs.readiness === "control_ready" || vs.readiness === "telemetry_ready",
    `Expected control_ready or telemetry_ready but got ${vs.readiness}`
  );
  session.stop();
});

// --- Scenario 13: Disarmed bridge reports why it is not commanding ---

test("F0-13: disarmed bridge never sends and reports disarmed authorization", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { automaticControlEnabled: true });
  await waitForControl(session);
  session.bindSession(null);
  session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 4, recommendationChanged: true });
  await delay(30);
  assert.equal(fake.state.posts.length, 0, "Disarmed session must not send commands");
  assert.equal(session.getViewState().commandAuthorization, "disarmed");
  assert.equal(describeBikeBridgeCommandStatus(session.getViewState()), "Disarmed");
  session.stop();
});

// F0 hardening: deferred resistance transport. GETs answer immediately;
// resistance POSTs stay pending until the test settles them explicitly.
function createDeferredBridge() {
  const state = {
    posts: [],
    pending: [],
    connected: true,
    initialized: true,
    controlAvailable: true,
    observed: 3,
    rpm: 56,
    watts: 42,
  };
  const transport = {
    async request(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method === "POST" && path === "/api/v1/resistance") {
        state.posts.push(req.jsonBody);
        return new Promise((resolve, reject) => {
          state.pending.push({ resolve, reject });
        });
      }
      if (req.method === "GET" && path === "/api/v1/status") {
        return {
          status: 200,
          text: JSON.stringify({
            status: "ok",
            bridgeVersion: "0.1.0-poc",
            connected: state.connected,
            initialized: state.initialized,
            resistanceControlAvailable: state.controlAvailable,
            resistance: {
              requested: null,
              requestedAt: null,
              observed: state.observed,
              observedAt: "2026-08-28T12:00:00.000Z",
            },
          }),
        };
      }
      if (req.method === "GET" && path === "/api/v1/telemetry") {
        return {
          status: 200,
          text: JSON.stringify({
            connected: state.connected,
            initialized: state.initialized,
            snapshotAt: "2026-08-28T12:00:00.000Z",
            resistance: metric(state.observed),
            rpm: metric(state.rpm),
            watts: metric(state.watts),
            machine: null,
          }),
        };
      }
      return { status: 404, text: JSON.stringify({ error: "not found" }) };
    },
  };
  return { state, transport };
}

// Records actuation outcomes so tests can wait for a completion deterministically.
function completionWatcher(session) {
  const resolved = [];
  session.setActuationObserver({
    requested() {
      return {};
    },
    resolved(token, outcome) {
      resolved.push(outcome);
    },
  });
  return resolved;
}

function abortTimeout() {
  const error = new Error("timeout");
  error.name = "AbortError";
  return error;
}

// Task 1: same-session authority is immutable.

test("F0-bind-1: frozen freestyle session cannot rebind to a controllable mode", async () => {
  for (const mode of ["legacy_hr_control", "vo2_protocol", "prospective_fixed_load"]) {
    const fake = createFakeBikeBridge();
    const session = readySession(fake);
    try {
      await waitForControl(session);
      session.bindSession({ sessionId: "fs-frozen", controlMode: "manual_freestyle_ride" });
      assert.throws(
        () => session.bindSession({ sessionId: "fs-frozen", controlMode: mode }),
        /conflicting/
      );
      assert.deepEqual(session.getSessionBinding(),
        { sessionId: "fs-frozen", controlMode: "manual_freestyle_ride" });
      // Same-mode retry stays idempotent.
      session.bindSession({ sessionId: "fs-frozen", controlMode: "manual_freestyle_ride" });
      assert.deepEqual(session.getSessionBinding(),
        { sessionId: "fs-frozen", controlMode: "manual_freestyle_ride" });
      // The frozen session stays observation-only.
      session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 9,
        recommendationChanged: true, workout: { day: "", sessionId: "fs-frozen" } });
      await delay(20);
      assert.equal(fake.state.posts.length, 0);
    } finally {
      session.stop();
    }
  }
});

test("F0-bind-2: same-session same-mode rebind is idempotent and preserves state", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "stable", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 5,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "stable" } });
    await waitUntil(() => fake.state.posts.length === 1);
    await waitUntil(() => session.getViewState().lastCommandOutcome === "accepted");
    session.bindSession({ sessionId: "stable", controlMode: "legacy_hr_control" });
    assert.deepEqual(session.getSessionBinding(),
      { sessionId: "stable", controlMode: "legacy_hr_control" });
    assert.equal(session.getViewState().desiredResistance, 5);
    assert.equal(session.getViewState().requestedResistance, 5);
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 5,
      recommendationChanged: false, workout: { day: "Monday", sessionId: "stable" } });
    await delay(20);
    assert.equal(fake.state.posts.length, 1);
  } finally {
    session.stop();
  }
});

test("F0-bind-3: different session id starts a new binding and invalidates prior state", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "session-a", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 5,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "session-a" } });
    await waitUntil(() => session.getViewState().lastCommandOutcome === "accepted");
    session.bindSession({ sessionId: "session-b", controlMode: "legacy_hr_control" });
    assert.equal(session.getViewState().desiredResistance, undefined);
    assert.equal(session.getViewState().commandedResistance, undefined);
    // Delayed guidance from session A is rejected and changes nothing.
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 9,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "session-a" } });
    await delay(20);
    assert.equal(fake.state.posts.length, 1);
    assert.equal(session.getViewState().desiredResistance, undefined);
    // Session B commands with matching identity.
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 6,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "session-b" } });
    await waitUntil(() => fake.state.posts.length === 2);
    assert.deepEqual(fake.state.posts[1], { value: 6 });
  } finally {
    session.stop();
  }
});

test("F0-bind-4: invalid bindings fail closed without changing state", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  try {
    await waitForControl(session);
    assert.throws(() => session.bindSession({ sessionId: "", controlMode: "legacy_hr_control" }), /Invalid/);
    assert.throws(() => session.bindSession({ sessionId: "x", controlMode: "bogus" }), /Invalid/);
    assert.equal(session.getSessionBinding(), null);
    assert.equal(session.isDisarmed(), false);
    session.bindSession({ sessionId: "kept", controlMode: "legacy_hr_control" });
    assert.throws(() => session.bindSession({ sessionId: "", controlMode: "legacy_hr_control" }), /Invalid/);
    assert.throws(() => session.bindSession({ sessionId: "kept", controlMode: "bogus" }), /Invalid/);
    assert.deepEqual(session.getSessionBinding(),
      { sessionId: "kept", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 5,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "kept" } });
    await waitUntil(() => fake.state.posts.length === 1);
  } finally {
    session.stop();
  }
});

// Task 2: bound sessions require matching identity.

test("F0-id-1: controllable binding ignores missing and foreign identity", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "id-a", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 5,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "id-a" } });
    await waitUntil(() => fake.state.posts.length === 1);
    await waitUntil(() => session.getViewState().lastCommandOutcome === "accepted");
    // Foreign identity authorizes nothing and preserves live state.
    session.onGuidance({ workoutActive: false, paused: false, desiredResistance: 9,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "foreign" } });
    await delay(20);
    assert.equal(fake.state.posts.length, 1);
    assert.equal(session.getViewState().desiredResistance, 5);
    assert.equal(session.getViewState().commandedResistance, 5);
    // Missing identity authorizes nothing and preserves live state.
    session.onGuidance({ workoutActive: false, paused: false, desiredResistance: 9, recommendationChanged: true });
    await delay(20);
    assert.equal(fake.state.posts.length, 1);
    assert.equal(session.getViewState().desiredResistance, 5);
    assert.equal(session.getViewState().commandedResistance, 5);
    assert.equal(session.getViewState().lastCommandOutcome, "accepted");
  } finally {
    session.stop();
  }
});

test("F0-id-2: freestyle binding ignores missing, foreign, and delayed identity", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "fs-id", controlMode: "manual_freestyle_ride" });
    session.onGuidance({ workoutActive: true, paused: false, recommendationChanged: false,
      workout: { day: "", sessionId: "fs-id" } });
    await delay(10);
    assert.equal(fake.state.posts.length, 0);
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 9, recommendationChanged: true });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 9,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "other" } });
    await delay(20);
    assert.equal(fake.state.posts.length, 0);
    assert.equal(session.getViewState().desiredResistance, undefined);
    assert.equal(session.getSessionBinding().controlMode, "manual_freestyle_ride");
    // Delayed guidance from a superseded freestyle session changes nothing.
    session.bindSession({ sessionId: "fs-next", controlMode: "manual_freestyle_ride" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 9,
      recommendationChanged: true, workout: { day: "", sessionId: "fs-id" } });
    await delay(20);
    assert.equal(fake.state.posts.length, 0);
    assert.equal(session.getViewState().desiredResistance, undefined);
    assert.equal(session.getSessionBinding().sessionId, "fs-next");
  } finally {
    session.stop();
  }
});

// Task 3: stale completions cannot contaminate the new session.

test("F0-stale-1: late success from session A does not touch session B", async () => {
  const deferred = createDeferredBridge();
  const session = readySession(deferred);
  const resolved = completionWatcher(session);
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "stale-a", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 5,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "stale-a" } });
    assert.equal(deferred.state.posts.length, 1);
    session.bindSession({ sessionId: "stale-b", controlMode: "legacy_hr_control" });
    deferred.state.pending[0].resolve({ status: 200, text: JSON.stringify({ requested: 5 }) });
    await waitUntil(() => resolved.length === 1);
    assert.equal(resolved[0], "accepted");
    assert.equal(deferred.state.posts.length, 1);
    assert.equal(session.getViewState().lastCommandOutcome, null);
    assert.equal(session.getViewState().requestedResistance, null);
    // Session B issues its own command and it completes normally.
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 9,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "stale-b" } });
    await waitUntil(() => deferred.state.posts.length === 2);
    assert.deepEqual(deferred.state.posts[1], { value: 9 });
    deferred.state.pending[1].resolve({ status: 200, text: JSON.stringify({ requested: 9 }) });
    await waitUntil(() => session.getViewState().lastCommandOutcome === "accepted");
    assert.equal(session.getViewState().requestedResistance, 9);
  } finally {
    session.stop();
  }
});

test("F0-stale-2: late failure from session A does not touch session B, queued B command survives", async () => {
  const deferred = createDeferredBridge();
  const session = readySession(deferred);
  const resolved = completionWatcher(session);
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "fail-a", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 5,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "fail-a" } });
    assert.equal(deferred.state.posts.length, 1);
    session.bindSession({ sessionId: "fail-b", controlMode: "legacy_hr_control" });
    // Session B queues its command while A's request is still in flight.
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 8,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "fail-b" } });
    assert.equal(deferred.state.posts.length, 1);
    deferred.state.pending[0].resolve({ status: 500, text: JSON.stringify({ error: "setter unavailable" }) });
    await waitUntil(() => deferred.state.posts.length === 2);
    assert.deepEqual(deferred.state.posts[1], { value: 8 });
    assert.equal(resolved[0], "failed");
    assert.equal(session.getViewState().lastCommandOutcome, null);
    assert.equal(session.getViewState().lastError, null);
    deferred.state.pending[1].resolve({ status: 200, text: JSON.stringify({ requested: 8 }) });
    await waitUntil(() => session.getViewState().lastCommandOutcome === "accepted");
    assert.equal(session.getViewState().requestedResistance, 8);
  } finally {
    session.stop();
  }
});

test("F0-stale-3: late timeout from session A does not touch session B", async () => {
  const deferred = createDeferredBridge();
  const session = readySession(deferred);
  const resolved = completionWatcher(session);
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "timeout-a", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 5,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "timeout-a" } });
    assert.equal(deferred.state.posts.length, 1);
    session.bindSession({ sessionId: "timeout-b", controlMode: "legacy_hr_control" });
    deferred.state.pending[0].reject(abortTimeout());
    await waitUntil(() => resolved.length === 1);
    assert.equal(resolved[0], "timeout");
    assert.equal(deferred.state.posts.length, 1);
    assert.equal(session.getViewState().lastCommandOutcome, null);
    assert.equal(session.getViewState().lastError, null);
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 6,
      recommendationChanged: true, workout: { day: "Monday", sessionId: "timeout-b" } });
    await waitUntil(() => deferred.state.posts.length === 2);
    assert.deepEqual(deferred.state.posts[1], { value: 6 });
    deferred.state.pending[1].resolve({ status: 200, text: JSON.stringify({ requested: 6 }) });
    await waitUntil(() => session.getViewState().lastCommandOutcome === "accepted");
    assert.equal(session.getViewState().requestedResistance, 6);
  } finally {
    session.stop();
  }
});

// ---------------------------------------------------------------------------
// Freestyle observed-resistance latch
// ---------------------------------------------------------------------------

function freestyleLatchSession(fake, overrides = {}) {
  const session = freestyleSession(fake, {
    pollIntervalMs: 20,
    freestyleLatchDebounceMs: 40,
    freestyleHoldMismatchConfirmPolls: 2,
    freestyleHoldMinCorrectionSpacingMs: 40,
    freestyleHoldMaxCorrectionAttempts: 3,
    freestyleHoldBackoffMs: 40,
    freestyleHoldActivePedalRpmMin: 1,
    ...overrides,
  });
  return session;
}

async function activateFreestyle(session, sessionId = "fs-bridge-001") {
  session.onGuidance({
    workoutActive: true,
    paused: false,
    recommendationChanged: false,
    workout: { day: "Freestyle", sessionId },
  });
}

test("Freestyle latch: R0 to R5 sends exactly one matching command", async () => {
  const fake = createFakeBikeBridge({ observed: 0 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(50);
  assert.equal(fake.state.posts.length, 0, "baseline observation must not latch");
  fake.state.observed = 5;
  await waitUntil(() => fake.state.posts.length === 1);
  assert.deepEqual(fake.state.posts, [{ value: 5 }]);
  await delay(120);
  assert.equal(fake.state.posts.length, 1, "stable R5 must not duplicate");
  session.stop();
});

test("Freestyle latch: R5 to R4 sends exactly one matching command", async () => {
  const fake = createFakeBikeBridge({ observed: 5 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(50);
  assert.equal(fake.state.posts.length, 0);
  fake.state.observed = 4;
  await waitUntil(() => fake.state.posts.length === 1);
  assert.deepEqual(fake.state.posts, [{ value: 4 }]);
  await delay(120);
  assert.equal(fake.state.posts.length, 1);
  session.stop();
});

test("Freestyle latch: rapid increments only latch the final stabilized level", async () => {
  const fake = createFakeBikeBridge({ observed: 0 });
  const session = freestyleLatchSession(fake, { freestyleLatchDebounceMs: 80 });
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  fake.state.observed = 2;
  await delay(20);
  fake.state.observed = 3;
  await delay(20);
  fake.state.observed = 5;
  await waitUntil(() => fake.state.posts.length === 1);
  await delay(120);
  assert.deepEqual(fake.state.posts, [{ value: 5 }]);
  session.stop();
});

test("Freestyle latch: repeated identical R5 polls do not duplicate commands", async () => {
  const fake = createFakeBikeBridge({ observed: 0 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  fake.state.observed = 5;
  await waitUntil(() => fake.state.posts.length === 1);
  for (let i = 0; i < 8; i++) await delay(30);
  assert.equal(fake.state.posts.length, 1);
  session.stop();
});

test("Freestyle latch: R5 to R0 cancels pending latch and does not restore", async () => {
  const fake = createFakeBikeBridge({ observed: 5 });
  const session = freestyleLatchSession(fake, { freestyleLatchDebounceMs: 80 });
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  fake.state.observed = 7;
  await delay(30);
  fake.state.observed = 0;
  await delay(150);
  assert.equal(fake.state.posts.length, 0, "transition to R0 must not command or restore");
  session.stop();
});

test("Freestyle latch: temporary telemetry loss does not latch", async () => {
  const fake = createFakeBikeBridge({ observed: 0 });
  const session = freestyleLatchSession(fake, { freestyleLatchDebounceMs: 80 });
  try {
    await waitForTelemetry(session);
    await activateFreestyle(session);
    await delay(40);
    fake.state.observed = 6;
    await delay(30);
    fake.state.failNext = { path: "/api/v1/telemetry", drop: true };
    await delay(200);
    assert.equal(fake.state.posts.length, 0, "stale/missing telemetry must not latch");
  } finally {
    session.stop();
  }
});

test("Freestyle latch: disconnect then reconnect does not automatically resend", async () => {
  const fake = createFakeBikeBridge({ observed: 0 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  fake.state.observed = 5;
  await waitUntil(() => fake.state.posts.length === 1);
  fake.state.connected = false;
  fake.state.controlAvailable = false;
  await delay(60);
  fake.state.connected = true;
  fake.state.initialized = true;
  fake.state.controlAvailable = true;
  await delay(120);
  assert.equal(fake.state.posts.length, 1, "reconnect must not resend Freestyle latch");
  session.stop();
});

test("Freestyle latch: pause then resume does not automatically resend", async () => {
  const fake = createFakeBikeBridge({ observed: 0 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  fake.state.observed = 5;
  await waitUntil(() => fake.state.posts.length === 1);
  session.onGuidance({
    workoutActive: true,
    paused: true,
    recommendationChanged: false,
    workout: { day: "Freestyle", sessionId: "fs-bridge-001" },
  });
  await delay(40);
  session.onGuidance({
    workoutActive: true,
    paused: false,
    recommendationChanged: false,
    workout: { day: "Freestyle", sessionId: "fs-bridge-001" },
  });
  await delay(120);
  assert.equal(fake.state.posts.length, 1, "resume must not resend Freestyle latch");
  session.stop();
});

test("Freestyle latch: finish cancels a pending latch", async () => {
  const fake = createFakeBikeBridge({ observed: 0 });
  const session = freestyleLatchSession(fake, { freestyleLatchDebounceMs: 120 });
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  fake.state.observed = 8;
  await delay(40);
  session.onGuidance({
    workoutActive: false,
    paused: false,
    recommendationChanged: false,
    workout: { day: "Freestyle", sessionId: "fs-bridge-001" },
  });
  await delay(180);
  assert.equal(fake.state.posts.length, 0, "finish must cancel pending latch");
  session.stop();
});

test("Freestyle latch: invalid session authority never commands", async () => {
  const fake = createFakeBikeBridge({ observed: 0 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  session.bindSession(null);
  session.onGuidance({
    workoutActive: true,
    paused: false,
    recommendationChanged: false,
    workout: { day: "Freestyle", sessionId: "fs-bridge-001" },
  });
  fake.state.observed = 5;
  await delay(150);
  assert.equal(fake.state.posts.length, 0);
  session.stop();
});

test("Freestyle latch works with a legacy automatic-control=false setting", async () => {
  const fake = createFakeBikeBridge({ observed: 0 });
  const session = freestyleLatchSession(fake, { automaticControlEnabled: false });
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  fake.state.observed = 5;
  await waitUntil(() => fake.state.posts.length === 1);
  assert.deepEqual(fake.state.posts, [{ value: 5 }]);
  session.stop();
});

test("structured workout control is unchanged by Freestyle latch support", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { pollIntervalMs: 20 });
  await waitForControl(session);
  session.bindSession({ sessionId: "structured-1", controlMode: "legacy_hr_control" });
  session.onGuidance({
    workoutActive: true,
    paused: false,
    desiredResistance: 8,
    recommendationChanged: true,
    workout: { day: "Monday", sessionId: "structured-1" },
  });
  await waitUntil(() => fake.state.posts.length >= 1);
  assert.deepEqual(fake.state.posts[0], { value: 8 });
  session.stop();
});

// ---------------------------------------------------------------------------
// Freestyle active resistance hold
// ---------------------------------------------------------------------------

async function establishHoldTarget(session, fake, level) {
  fake.state.observed = level;
  fake.state.rpm = 60;
  await waitUntil(() => fake.state.posts.some((body) => body.value === level));
  assert.equal(session.getViewState().freestyleHoldTarget, level);
  assert.equal(session.getViewState().freestyleHoldStatus, "holding");
}

test("Freestyle hold: R0 to R5 establishes target R5", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 55 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(50);
  await establishHoldTarget(session, fake, 5);
  assert.deepEqual(fake.state.posts, [{ value: 5 }]);
  session.stop();
});

test("Freestyle hold: stable R5 causes no additional POSTs", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 55 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  const count = fake.state.posts.length;
  for (let i = 0; i < 8; i++) await delay(30);
  assert.equal(fake.state.posts.length, count);
  session.stop();
});

test("Freestyle hold: unexpected R5 to R0 while pedaling triggers one bounded R5 correction", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake);
  try {
    await waitForTelemetry(session);
    await activateFreestyle(session);
    await delay(40);
    await establishHoldTarget(session, fake, 5);
    const postsAfterLatch = fake.state.posts.length;
    fake.state.observed = 0;
    fake.state.rpm = 68;
    await waitUntil(() => fake.state.posts.length >= postsAfterLatch + 1);
    assert.deepEqual(fake.state.posts.slice(-1)[0], { value: 5 });
    assert.equal(
      fake.state.posts.filter((body) => body.value === 5).length,
      postsAfterLatch + 1,
      "exactly one correction after unexpected R0"
    );

    // Successful restoration: bike reports R5 again so bounded retries must stop.
    fake.state.observed = 5;
    await waitUntil(() => session.getViewState().observedResistance === 5);
    const postsAfterRecovery = fake.state.posts.length;
    for (let i = 0; i < 8; i++) await delay(30);
    assert.equal(
      fake.state.posts.length,
      postsAfterRecovery,
      "no additional correction after recovery stabilizes"
    );
    assert.equal(
      fake.state.posts.filter((body) => body.value === 5).length,
      postsAfterLatch + 1,
      "recovery must not trigger further corrections"
    );
    assert.equal(session.getViewState().freestyleHoldTarget, 5);
    assert.equal(session.getViewState().freestyleHoldStatus, "holding");
  } finally {
    session.stop();
  }
});

test("Freestyle hold: R5 to R0 to R5 recovery does not loop or repeatedly POST", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  fake.state.observed = 0;
  fake.state.rpm = 70;
  await waitUntil(() => fake.state.posts.length >= 2);
  fake.state.observed = 5;
  await delay(150);
  assert.equal(fake.state.posts.length, 2);
  session.stop();
});

test("Freestyle hold: another reset after recovery can trigger a subsequent correction", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  fake.state.observed = 0;
  await waitUntil(() => fake.state.posts.length >= 2);
  fake.state.observed = 5;
  await delay(80);
  fake.state.observed = 0;
  await waitUntil(() => fake.state.posts.length >= 3);
  assert.equal(fake.state.posts.filter((body) => body.value === 5).length, 3);
  session.stop();
});

test("Freestyle hold: physical R5 to R4 adopts R4 rather than restoring R5", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  fake.state.observed = 4;
  await waitUntil(() => fake.state.posts.some((body) => body.value === 4));
  assert.equal(session.getViewState().freestyleHoldTarget, 4);
  await delay(100);
  assert.equal(fake.state.posts.filter((body) => body.value === 5).length, 1);
  assert.equal(fake.state.posts.filter((body) => body.value === 4).length, 1);
  session.stop();
});

test("Freestyle hold: rapid physical adjustments do not cause competing commands", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake, { freestyleLatchDebounceMs: 80 });
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  fake.state.observed = 3;
  await delay(20);
  fake.state.observed = 4;
  await delay(20);
  fake.state.observed = 6;
  await waitUntil(() => fake.state.posts.some((body) => body.value === 6));
  await delay(120);
  assert.deepEqual(
    fake.state.posts.filter((body) => body.value !== 5),
    [{ value: 6 }]
  );
  assert.equal(session.getViewState().freestyleHoldTarget, 6);
  session.stop();
});

test("Freestyle hold: release hold cancels corrections", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  session.releaseFreestyleHold();
  assert.equal(session.getViewState().freestyleHoldStatus, "released");
  assert.equal(session.getViewState().freestyleHoldTarget, null);
  fake.state.observed = 0;
  fake.state.rpm = 70;
  await delay(160);
  assert.equal(fake.state.posts.length, 1);
  session.stop();
});

test("Freestyle hold: after release, R4→R1→R5 issues zero commands until Enable hold", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake, { freestyleLatchDebounceMs: 40 });
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 4);
  const postsAfterLatch = fake.state.posts.length;
  session.releaseFreestyleHold();
  assert.equal(session.getViewState().freestyleHoldStatus, "released");
  for (const level of [3, 2, 1]) {
    fake.state.observed = level;
    fake.state.rpm = 55;
    await delay(80);
  }
  fake.state.observed = 5;
  fake.state.rpm = 60;
  await delay(160);
  assert.equal(
    fake.state.posts.length,
    postsAfterLatch,
    "physical descent/ascent after release must not command resistance"
  );
  assert.equal(session.getViewState().freestyleHoldTarget, null);
  assert.equal(session.getViewState().freestyleHoldStatus, "released");

  const enabled = session.enableFreestyleHold();
  assert.equal(enabled.ok, true);
  await waitUntil(() => fake.state.posts.some((body) => body.value === 5));
  assert.equal(session.getViewState().freestyleHoldTarget, 5);
  assert.equal(session.getViewState().freestyleHoldStatus, "holding");
  assert.ok(!fake.state.posts.some((body) => body.value === 0), "must never command R0");
  session.stop();
});

test("Freestyle hold: Enable hold activates at R1 without ever observing R0", async () => {
  const fake = createFakeBikeBridge({ observed: 1, rpm: 60 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  assert.equal(session.getViewState().freestyleHoldStatus, "inactive");
  assert.equal(fake.state.posts.length, 0);

  const enabled = session.enableFreestyleHold();
  assert.equal(enabled.ok, true);
  await waitUntil(() => fake.state.posts.some((body) => body.value === 1));
  assert.equal(session.getViewState().freestyleHoldTarget, 1);
  assert.equal(session.getViewState().freestyleHoldStatus, "holding");
  assert.deepEqual(fake.state.posts, [{ value: 1 }]);
  assert.ok(!fake.state.posts.some((body) => body.value === 0), "must never command R0");
  session.stop();
});

test("Freestyle hold: Enable hold refuses when telemetry reports R0", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 4);
  const postsAfterLatch = fake.state.posts.length;
  session.releaseFreestyleHold();
  fake.state.observed = 0;
  await delay(80);
  const refused = session.enableFreestyleHold();
  assert.equal(refused.ok, false);
  assert.match(refused.error, /R1–R15|rider-selectable/);
  assert.equal(fake.state.posts.length, postsAfterLatch);
  assert.equal(session.getViewState().freestyleHoldStatus, "released");
  assert.equal(session.getViewState().freestyleHoldTarget, null);

  fake.state.observed = 3;
  await delay(80);
  const enabled = session.enableFreestyleHold();
  assert.equal(enabled.ok, true);
  await waitUntil(() => fake.state.posts.some((body) => body.value === 3));
  assert.equal(session.getViewState().freestyleHoldTarget, 3);
  assert.equal(session.getViewState().freestyleHoldStatus, "holding");
  session.stop();
});

test("Freestyle hold: pause clears hold and resume does not resurrect target", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  session.onGuidance({
    workoutActive: true,
    paused: true,
    recommendationChanged: false,
    workout: { day: "Freestyle", sessionId: "fs-bridge-001" },
  });
  assert.equal(session.getViewState().freestyleHoldTarget, null);
  fake.state.observed = 0;
  session.onGuidance({
    workoutActive: true,
    paused: false,
    recommendationChanged: false,
    workout: { day: "Freestyle", sessionId: "fs-bridge-001" },
  });
  await delay(160);
  assert.equal(fake.state.posts.length, 1);
  assert.equal(session.getViewState().freestyleHoldTarget, null);
  session.stop();
});

test("Freestyle hold: released state survives pause/resume until Enable hold", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake, { freestyleLatchDebounceMs: 40 });
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  const postsAfterLatch = fake.state.posts.length;
  session.releaseFreestyleHold();
  assert.equal(session.getViewState().freestyleHoldStatus, "released");
  session.onGuidance({
    workoutActive: true,
    paused: true,
    recommendationChanged: false,
    workout: { day: "Freestyle", sessionId: "fs-bridge-001" },
  });
  assert.equal(session.getViewState().freestyleHoldStatus, "released");
  session.onGuidance({
    workoutActive: true,
    paused: false,
    recommendationChanged: false,
    workout: { day: "Freestyle", sessionId: "fs-bridge-001" },
  });
  assert.equal(session.getViewState().freestyleHoldStatus, "released");
  fake.state.observed = 7;
  fake.state.rpm = 65;
  await delay(160);
  assert.equal(fake.state.posts.length, postsAfterLatch, "resume must not relatch without Enable");
  assert.equal(session.getViewState().freestyleHoldTarget, null);
  assert.equal(session.getViewState().freestyleHoldStatus, "released");
  const enabled = session.enableFreestyleHold();
  assert.equal(enabled.ok, true);
  await waitUntil(() => fake.state.posts.some((body) => body.value === 7));
  assert.equal(session.getViewState().freestyleHoldTarget, 7);
  assert.equal(session.getViewState().freestyleHoldStatus, "holding");
  session.stop();
});

test("Freestyle hold: deferred restore response cannot mutate a newer hold", async () => {
  const deferred = createDeferredBridge();
  deferred.state.observed = 0;
  deferred.state.rpm = 60;
  const session = freestyleLatchSession(deferred, {
    freestyleHoldMaxCorrectionAttempts: 1,
    freestyleHoldMismatchConfirmPolls: 1,
    freestyleHoldMinCorrectionSpacingMs: 10,
    freestyleHoldBackoffMs: 10,
    freestyleHoldFailureWindowMs: 60_000,
    freestyleHoldStableClearMs: 60_000,
  });
  try {
    await waitForTelemetry(session);
    await activateFreestyle(session);
    await delay(40);
    deferred.state.observed = 5;
    await waitUntil(() => deferred.state.posts.some((body) => body.value === 5));
    assert.equal(deferred.state.pending.length, 1);
    deferred.state.pending[0].resolve({ status: 200, text: JSON.stringify({ requested: 5 }) });
    await waitUntil(() => session.getViewState().freestyleHoldStatus === "holding");
    assert.equal(session.getViewState().freestyleHoldTarget, 5);

    deferred.state.observed = 0;
    deferred.state.rpm = 70;
    await waitUntil(() => deferred.state.posts.length >= 2);
    assert.equal(deferred.state.pending.length, 2, "restore must remain in flight");

    session.releaseFreestyleHold();
    deferred.state.observed = 3;
    await waitUntil(() => session.getViewState().observedResistance === 3);
    const enabled = session.enableFreestyleHold();
    assert.equal(enabled.ok, true);
    assert.equal(deferred.state.posts.length, 2, "Enable must queue while restore is in flight");

    deferred.state.pending[1].resolve({
      status: 503,
      text: JSON.stringify({ error: "setter unavailable" }),
    });
    await waitUntil(() => deferred.state.posts.some((body) => body.value === 3));
    assert.equal(deferred.state.pending.length, 3);
    deferred.state.pending[2].resolve({ status: 200, text: JSON.stringify({ requested: 3 }) });
    await waitUntil(() => session.getViewState().freestyleHoldStatus === "holding");
    assert.equal(session.getViewState().freestyleHoldTarget, 3);
    assert.notEqual(
      session.getViewState().freestyleHoldStatus,
      "suspended",
      "stale restore failure must not consume the new hold's failure budget"
    );
  } finally {
    session.stop();
  }
});

test("Freestyle hold: finish clears hold", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  session.onGuidance({
    workoutActive: false,
    paused: false,
    recommendationChanged: false,
    workout: { day: "Freestyle", sessionId: "fs-bridge-001" },
  });
  assert.equal(session.getViewState().freestyleHoldStatus, "inactive");
  assert.equal(session.getViewState().freestyleHoldTarget, null);
  session.stop();
});

test("Freestyle hold: disconnect clears hold and reconnect does not resurrect", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  fake.state.connected = false;
  fake.state.controlAvailable = false;
  await waitUntil(() => session.getViewState().freestyleHoldTarget === null);
  fake.state.connected = true;
  fake.state.initialized = true;
  fake.state.controlAvailable = true;
  fake.state.observed = 0;
  fake.state.rpm = 70;
  await delay(160);
  assert.equal(fake.state.posts.length, 1);
  session.stop();
});

test("Freestyle hold: stale telemetry prohibits correction", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  fake.state.observed = 0;
  fake.state.failNext = { path: "/api/v1/telemetry", drop: true };
  await delay(160);
  assert.equal(fake.state.posts.length, 1);
  session.stop();
});

test("Freestyle hold: stopped pedaling prohibits correction", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake);
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  fake.state.observed = 0;
  fake.state.rpm = 0;
  await delay(160);
  assert.equal(fake.state.posts.length, 1);
  session.stop();
});

test("Freestyle hold: persistent reset failure suspends after bounded attempts", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake, {
    freestyleHoldMaxCorrectionAttempts: 2,
    freestyleHoldMismatchConfirmPolls: 1,
    freestyleHoldMinCorrectionSpacingMs: 20,
    freestyleHoldBackoffMs: 20,
    freestyleHoldFailureWindowMs: 60_000,
    freestyleHoldStableClearMs: 60_000,
  });
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  fake.state.observed = 0;
  fake.state.rpm = 70;
  await waitUntil(() => session.getViewState().freestyleHoldStatus === "suspended", 800);
  const restoreCount = fake.state.posts.filter((body) => body.value === 5).length;
  assert.ok(restoreCount >= 2);
  const afterSuspend = fake.state.posts.length;
  await delay(120);
  assert.equal(fake.state.posts.length, afterSuspend);
  session.stop();
});

test("Freestyle hold: brief observed recovery does not clear failure budget", async () => {
  let clock = 1_000_000;
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake, {
    now: () => clock,
    freestyleHoldMaxCorrectionAttempts: 2,
    freestyleHoldMismatchConfirmPolls: 1,
    freestyleHoldMinCorrectionSpacingMs: 20,
    freestyleHoldBackoffMs: 20,
    freestyleHoldFailureWindowMs: 10_000,
    freestyleHoldStableClearMs: 5_000,
  });
  try {
    await waitForTelemetry(session);
    await activateFreestyle(session);
    await delay(40);
    await establishHoldTarget(session, fake, 5);
    const latchPosts = fake.state.posts.length;
    fake.state.observed = 0;
    fake.state.rpm = 70;
    fake.state.failNext = { path: "/api/v1/resistance", status: 500, once: true };
    await waitUntil(() => fake.state.posts.length >= latchPosts + 1);
    clock += 100;
    fake.state.observed = 5;
    await delay(40);
    clock += 100;
    fake.state.observed = 0;
    fake.state.failNext = { path: "/api/v1/resistance", status: 500, once: true };
    await waitUntil(() => session.getViewState().freestyleHoldStatus === "suspended", 800);
    assert.equal(session.getViewState().freestyleHoldStatus, "suspended");
    const afterSuspend = fake.state.posts.length;
    clock += 100;
    await delay(120);
    assert.equal(fake.state.posts.length, afterSuspend, "brief R5 flash must not clear the failure budget");
  } finally {
    session.stop();
  }
});

test("Freestyle hold: sustained stability clears failure budget so later restores continue", async () => {
  let clock = 2_000_000;
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake, {
    now: () => clock,
    freestyleHoldMaxCorrectionAttempts: 2,
    freestyleHoldMismatchConfirmPolls: 1,
    freestyleHoldMinCorrectionSpacingMs: 20,
    freestyleHoldBackoffMs: 20,
    freestyleHoldFailureWindowMs: 60_000,
    freestyleHoldStableClearMs: 1_000,
  });
  try {
    await waitForTelemetry(session);
    await activateFreestyle(session);
    await delay(40);
    await establishHoldTarget(session, fake, 5);
    const latchPosts = fake.state.posts.length;
    fake.state.observed = 0;
    fake.state.rpm = 70;
    fake.state.failNext = { path: "/api/v1/resistance", status: 500, once: true };
    await waitUntil(() => fake.state.posts.length >= latchPosts + 1);
    fake.state.observed = 5;
    clock += 1_100;
    await delay(80);
    clock += 50;
    await delay(40);
    fake.state.observed = 0;
    await waitUntil(() => fake.state.posts.length >= latchPosts + 2);
    assert.notEqual(session.getViewState().freestyleHoldStatus, "suspended");
    assert.equal(fake.state.posts.at(-1).value, 5);
  } finally {
    session.stop();
  }
});

test("Freestyle hold: successful restores minutes apart do not suspend", async () => {
  let clock = 3_000_000;
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake, {
    now: () => clock,
    freestyleHoldMaxCorrectionAttempts: 2,
    freestyleHoldMismatchConfirmPolls: 1,
    freestyleHoldMinCorrectionSpacingMs: 20,
    freestyleHoldBackoffMs: 20,
    freestyleHoldFailureWindowMs: 60_000,
    freestyleHoldStableClearMs: 500,
  });
  try {
    await waitForTelemetry(session);
    await activateFreestyle(session);
    await delay(40);
    await establishHoldTarget(session, fake, 5);
    for (let cycle = 0; cycle < 3; cycle++) {
      fake.state.observed = 0;
      fake.state.rpm = 70;
      await waitUntil(() => fake.state.posts.length >= 2 + cycle);
      fake.state.observed = 5;
      clock += 600;
      await delay(60);
      clock += 50;
      await delay(40);
      clock += 120_000;
    }
    assert.notEqual(session.getViewState().freestyleHoldStatus, "suspended");
    assert.equal(fake.state.posts.filter((body) => body.value === 5).length, 4);
  } finally {
    session.stop();
  }
});

test("Freestyle hold: three rapid failed restorations suspend within the failure window", async () => {
  let clock = 4_000_000;
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake, {
    now: () => clock,
    freestyleHoldMaxCorrectionAttempts: 3,
    freestyleHoldMismatchConfirmPolls: 1,
    freestyleHoldMinCorrectionSpacingMs: 10,
    freestyleHoldBackoffMs: 10,
    freestyleHoldFailureWindowMs: 5_000,
    freestyleHoldStableClearMs: 60_000,
  });
  try {
    await waitForTelemetry(session);
    await activateFreestyle(session);
    await delay(40);
    await establishHoldTarget(session, fake, 5);
    fake.state.observed = 0;
    fake.state.rpm = 70;
    const start = Date.now();
    while (Date.now() - start < 1500) {
      if (session.getViewState().freestyleHoldStatus === "suspended") break;
      clock += 25;
      await delay(10);
    }
    assert.equal(session.getViewState().freestyleHoldStatus, "suspended");
    const restoreCount = fake.state.posts.filter((body) => body.value === 5).length;
    assert.equal(restoreCount, 4, "latch + three failed restores then suspend");
    const afterSuspend = fake.state.posts.length;
    clock += 100;
    await delay(120);
    assert.equal(fake.state.posts.length, afterSuspend);
  } finally {
    session.stop();
  }
});

test("Freestyle hold works with a legacy automatic-control=false setting", async () => {
  const fake = createFakeBikeBridge({ observed: 0, rpm: 60 });
  const session = freestyleLatchSession(fake, { automaticControlEnabled: false });
  await waitForTelemetry(session);
  await activateFreestyle(session);
  await delay(40);
  await establishHoldTarget(session, fake, 5);
  fake.state.observed = 0;
  await waitUntil(() => fake.state.posts.length >= 2);
  assert.equal(fake.state.posts.at(-1).value, 5);
  session.stop();
});

test("structured workout control is unchanged by Freestyle hold support", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { pollIntervalMs: 20 });
  await waitForControl(session);
  session.bindSession({ sessionId: "structured-2", controlMode: "legacy_hr_control" });
  session.onGuidance({
    workoutActive: true,
    paused: false,
    desiredResistance: 9,
    recommendationChanged: true,
    workout: { day: "Tuesday", sessionId: "structured-2" },
  });
  await waitUntil(() => fake.state.posts.length >= 1);
  assert.deepEqual(fake.state.posts[0], { value: 9 });
  session.stop();
});

const PAIRING_TOKEN = "XB5G5132";

test("pairing token defaults empty and legacy stored settings load without it", () => {
  const storage = memoryStorage({
    [BIKE_BRIDGE_STORAGE_KEY]: JSON.stringify({
      baseUrl: "http://192.168.1.226:8765",
      automaticControlEnabled: true,
      consoleBrightness: 55,
    }),
  });
  const loaded = loadBikeBridgeSettings(storage);
  assert.equal(loaded.pairingToken, "");
  assert.equal(loaded.baseUrl, "http://192.168.1.226:8765");
  assert.equal("automaticControlEnabled" in loaded, false);
  assert.equal(loaded.consoleBrightness, 55);
  assert.equal(loadBikeBridgeSettings(memoryStorage()).pairingToken, "");
});

test("pairing token is normalized and malformed tokens are rejected", () => {
  for (const entered of ["XB5G 5132", "XB5G5132", "XB5G-5132", "xb5g-5132", " xb5g 5132 "]) {
    assert.deepEqual(parseBikeBridgePairingToken(entered), { ok: true, token: PAIRING_TOKEN }, entered);
  }
  assert.deepEqual(parseBikeBridgePairingToken(""), { ok: true, token: "" });
  for (const bad of ["abc", "XB5G513", "XB5G51322", "XB5G_5132", "XB5G513!", "00112233445566778899aabbccddeeff"]) {
    assert.equal(parseBikeBridgePairingToken(bad).ok, false, bad);
  }
  assert.equal(parseBikeBridgePairingToken("XB5G51").error, "pairing code must be 8 letters or digits");
  const storage = memoryStorage({
    [BIKE_BRIDGE_STORAGE_KEY]: JSON.stringify({ baseUrl: "", pairingToken: "not-a-token" }),
  });
  assert.equal(loadBikeBridgeSettings(storage).pairingToken, "");
});

test("client sends the pairing header on POSTs only", async () => {
  const fake = createFakeBikeBridge({ pairingToken: PAIRING_TOKEN });
  const client = createBikeBridgeClient(
    () => "http://192.168.1.10:8765",
    fake.transport,
    50,
    () => PAIRING_TOKEN
  );
  assert.equal((await client.getStatus()).ok, true);
  assert.equal((await client.getTelemetry()).ok, true);
  assert.equal((await client.setResistance(4)).ok, true);
  assert.equal((await client.postHeartRate(140)).ok, true);
  assert.equal((await client.setBrightness(30)).ok, true);
  const gets = fake.state.requestHeaders.filter((r) => r.method === "GET");
  const posts = fake.state.requestHeaders.filter((r) => r.method === "POST");
  assert.equal(gets.length, 2);
  assert.ok(gets.every((r) => r.headers === null));
  assert.equal(posts.length, 3);
  assert.ok(posts.every((r) => r.headers["X-Fitbaus-Token"] === PAIRING_TOKEN));
});

test("unpaired client keeps read-only telemetry and reports 401 as pairing required", async () => {
  const fake = createFakeBikeBridge({ pairingToken: PAIRING_TOKEN });
  const client = createBikeBridgeClient(() => "http://192.168.1.10:8765", fake.transport, 50);
  assert.equal((await client.getStatus()).ok, true);
  assert.equal((await client.getTelemetry()).ok, true);
  const result = await client.setResistance(4);
  assert.equal(result.ok, false);
  assert.equal(result.kind, "http_error");
  assert.equal(result.status, 401);
  assert.equal(result.message, "bridge pairing required");
  assert.deepEqual(fake.state.posts, []);
});

test("session configure stores pairing token and brightness save preserves it", async () => {
  const fake = createFakeBikeBridge({ pairingToken: PAIRING_TOKEN });
  const storage = memoryStorage();
  const session = createBikeBridgeSession({ storage, transport: fake.transport, requestTimeoutMs: 50 });
  assert.equal(session.configure({ baseUrl: "http://192.168.1.10:8765" }).ok, true);
  assert.equal(session.getViewState().pairingConfigured, false);
  const rejected = session.configure({ pairingToken: "nope" });
  assert.equal(rejected.ok, false);
  assert.equal(session.getViewState().pairingConfigured, false);
  assert.equal(session.configure({ pairingToken: PAIRING_TOKEN.toLowerCase() }).ok, true);
  assert.equal(session.getViewState().pairingConfigured, true);
  assert.equal(loadBikeBridgeSettings(storage).pairingToken, PAIRING_TOKEN);
  const brightness = await session.setConsoleBrightness(40);
  assert.equal(brightness.ok, true);
  assert.equal(loadBikeBridgeSettings(storage).pairingToken, PAIRING_TOKEN);
  assert.equal(session.configure({ automaticControlEnabled: true }).ok, true);
  assert.equal(loadBikeBridgeSettings(storage).pairingToken, PAIRING_TOKEN);
  assert.equal(session.configure({ baseUrl: "http://192.168.1.226:8765" }).ok, true);
  assert.equal(loadBikeBridgeSettings(storage).pairingToken, PAIRING_TOKEN);
  assert.deepEqual(fake.state.brightnessPosts, [{ value: 40 }]);
  session.stop();
});


// --- Always-on structured resistance control (automatic control is standard) ---

function deferredStatusBridge(initial = {}) {
  const fake = createFakeBikeBridge(initial);
  let releaseFirstStatus;
  const firstStatus = new Promise((resolve) => {
    releaseFirstStatus = resolve;
  });
  let statusCalls = 0;
  const transport = {
    async request(request) {
      if (request.method === "GET" && request.url.endsWith("/api/v1/status")) {
        statusCalls += 1;
        if (statusCalls === 1) await firstStatus;
      }
      return fake.transport.request(request);
    },
  };
  return { fake, transport, releaseFirstStatus: () => releaseFirstStatus() };
}

test("AC-1: a fresh install needs no opt-in: the first recommendation of an authorized workout is sent", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { pollIntervalMs: 20 });
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "ac-1", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 3, recommendationChanged: true,
      workout: { day: "Monday", sessionId: "ac-1" } });
    await waitUntil(() => fake.state.posts.length === 1);
    assert.deepEqual(fake.state.posts, [{ value: 3 }]);
    assert.equal(session.getViewState().commandAuthorization, "authorized");
  } finally {
    session.stop();
  }
});

test("AC-2: legacy stored automaticControlEnabled=false is ignored and dropped on the next save", async () => {
  const storage = memoryStorage({
    [BIKE_BRIDGE_STORAGE_KEY]: JSON.stringify({
      baseUrl: "http://192.168.1.10:8765",
      automaticControlEnabled: false,
      consoleBrightness: 40,
      pairingToken: "XB5G5132",
    }),
  });
  const loaded = loadBikeBridgeSettings(storage);
  assert.equal(loaded.baseUrl, "http://192.168.1.10:8765", "URL preserved");
  assert.equal(loaded.consoleBrightness, 40, "brightness preserved");
  assert.equal(loaded.pairingToken, "XB5G5132", "pairing preserved");
  const fake = createFakeBikeBridge();
  const session = createBikeBridgeSession({ storage, transport: fake.transport, pollIntervalMs: 20, requestTimeoutMs: 50 });
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "ac-2", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 3, recommendationChanged: true,
      workout: { day: "Monday", sessionId: "ac-2" } });
    await waitUntil(() => fake.state.posts.length === 1);
    assert.deepEqual(fake.state.posts, [{ value: 3 }]);
    await session.setConsoleBrightness(41);
    const saved = JSON.parse(storage.getItem(BIKE_BRIDGE_STORAGE_KEY));
    assert.equal("automaticControlEnabled" in saved, false);
    assert.equal(saved.pairingToken, "XB5G5132");
    assert.equal(saved.baseUrl, "http://192.168.1.10:8765");
  } finally {
    session.stop();
  }
});

test("AC-3: a recommendation that arrives before the first status poll is sent once control is ready", async () => {
  const bridge = deferredStatusBridge();
  const session = createBikeBridgeSession({ storage: memoryStorage(), transport: bridge.transport, pollIntervalMs: 20, requestTimeoutMs: 500 });
  session.configure({ baseUrl: "http://192.168.1.10:8765" });
  try {
    beginPolling(session);
    session.bindSession({ sessionId: "ac-3", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 3, recommendationChanged: true,
      workout: { day: "Monday", sessionId: "ac-3" } });
    await delay(30);
    assert.equal(bridge.fake.state.posts.length, 0, "nothing can be sent before the Bridge reports control");
    assert.equal(session.getViewState().commandAuthorization, "bridge_unavailable");
    bridge.releaseFirstStatus();
    await waitUntil(() => bridge.fake.state.posts.length === 1);
    assert.deepEqual(bridge.fake.state.posts, [{ value: 3 }]);
    await delay(80);
    assert.equal(bridge.fake.state.posts.length, 1, "exactly one startup synchronization");
  } finally {
    session.stop();
  }
});

test("AC-4/5: recommendation changes are sent; unchanged recommendations do not flood", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { pollIntervalMs: 20 });
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "ac-4", controlMode: "legacy_hr_control" });
    const guide = (level, changed) => session.onGuidance({ workoutActive: true, paused: false, desiredResistance: level,
      recommendationChanged: changed, workout: { day: "Monday", sessionId: "ac-4" } });
    guide(3, true);
    await waitUntil(() => fake.state.posts.length === 1);
    for (let i = 0; i < 30; i += 1) guide(3, false);
    await delay(100);
    assert.equal(fake.state.posts.length, 1, "repeated unchanged recommendations send nothing");
    guide(5, true);
    await waitUntil(() => fake.state.posts.length === 2);
    assert.deepEqual(fake.state.posts, [{ value: 3 }, { value: 5 }]);
  } finally {
    session.stop();
  }
});

test("AC-6/7: paused, finished and disarmed workouts send nothing; resume reconciles once", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { pollIntervalMs: 20 });
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "ac-6", controlMode: "legacy_hr_control" });
    const guide = (level, changed, paused, active = true) => session.onGuidance({ workoutActive: active, paused, desiredResistance: level,
      recommendationChanged: changed, workout: { day: "Monday", sessionId: "ac-6" } });
    guide(3, true, false);
    await waitUntil(() => fake.state.posts.length === 1);
    guide(6, true, true);
    await delay(80);
    assert.equal(fake.state.posts.length, 1, "no command while paused");
    assert.equal(session.getViewState().commandAuthorization, "paused");
    guide(6, false, false);
    await waitUntil(() => fake.state.posts.length === 2);
    assert.deepEqual(fake.state.posts.at(-1), { value: 6 }, "resume sends the current target");
    guide(undefined, false, false, false);
    await delay(60);
    assert.equal(fake.state.posts.length, 2, "finishing sends no synthetic zero");
    session.bindSession(null);
    guide(8, true, false);
    await delay(60);
    assert.equal(fake.state.posts.length, 2, "disarmed sends nothing");
    assert.ok(fake.state.posts.every((p) => p.value !== 0), "never a synthetic R0");
  } finally {
    session.stop();
  }
});

test("AC-8: guidance for a different session id never commands", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { pollIntervalMs: 20 });
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "ac-8", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 4, recommendationChanged: true,
      workout: { day: "Monday", sessionId: "someone-else" } });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 4, recommendationChanged: true });
    await delay(60);
    assert.equal(fake.state.posts.length, 0);
  } finally {
    session.stop();
  }
});

test("AC-9/10: no dispatch while the Bridge is down; reconnection reconciles the current target once", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { pollIntervalMs: 20 });
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "ac-9", controlMode: "legacy_hr_control" });
    fake.state.controlAvailable = false;
    await waitUntil(() => session.getViewState().controlAvailable === false);
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 4, recommendationChanged: true,
      workout: { day: "Monday", sessionId: "ac-9" } });
    await delay(60);
    assert.equal(fake.state.posts.length, 0, "control unavailable: nothing sent");
    assert.equal(session.getViewState().commandAuthorization, "control_unavailable");
    fake.state.controlAvailable = true;
    await waitUntil(() => fake.state.posts.length === 1);
    assert.deepEqual(fake.state.posts, [{ value: 4 }]);
    await delay(80);
    assert.equal(fake.state.posts.length, 1, "one reconciliation, no retry loop");
  } finally {
    session.stop();
  }
});

test("AC-11: a pairing rejection is reported, not retried in a loop, and re-pairing reconciles", async () => {
  const fake = createFakeBikeBridge({ pairingToken: "XB5G5132" });
  const session = readySession(fake, { pollIntervalMs: 20 });
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "ac-11", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 3, recommendationChanged: true,
      workout: { day: "Monday", sessionId: "ac-11" } });
    await waitUntil(() => session.getViewState().lastCommandOutcome === "failed");
    const failed = session.getViewState();
    assert.equal(failed.pairingRequired, true);
    assert.equal(failed.bridgeAcceptedResistance, null);
    assert.equal(describeBikeBridgeCommandStatus(failed), "Pairing required");
    const attempts = fake.state.rejectedPosts;
    assert.equal(attempts, 1);
    await delay(100);
    assert.equal(fake.state.rejectedPosts, attempts, "no automatic retry storm");
    session.configure({ pairingToken: "XB5G5132" });
    await waitUntil(() => session.getViewState().lastCommandOutcome === "accepted");
    assert.equal(session.getViewState().bridgeAcceptedResistance, 3);
    assert.equal(session.getViewState().pairingRequired, false);
    assert.deepEqual(fake.state.posts, [{ value: 3 }], "only the authenticated command reached the bike");
  } finally {
    session.stop();
  }
});

test("AC-12: Bridge acceptance is distinct from physically observed resistance", async () => {
  const fake = createFakeBikeBridge({ observed: 0 });
  const session = readySession(fake, { pollIntervalMs: 20 });
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "ac-12", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 3, recommendationChanged: true,
      workout: { day: "Monday", sessionId: "ac-12" } });
    await waitUntil(() => session.getViewState().bridgeAcceptedResistance === 3);
    await delay(40);
    const pending = session.getViewState();
    assert.equal(pending.desiredResistance, 3);
    assert.equal(pending.commandedResistance, 3);
    assert.equal(pending.observedResistance, 0);
    assert.equal(describeBikeBridgeCommandStatus(pending), "Bridge accepted R3 - awaiting physical confirmation");
    fake.state.observed = 3;
    await waitUntil(() => session.getViewState().observedResistance === 3);
    assert.equal(describeBikeBridgeCommandStatus(session.getViewState()), "Confirmed by bike telemetry");
  } finally {
    session.stop();
  }
});

test("AC-14: vo2 and fixed-load structured modes keep their prescription commands", async () => {
  for (const mode of ["vo2_protocol", "prospective_fixed_load"]) {
    const fake = createFakeBikeBridge();
    const session = readySession(fake, { pollIntervalMs: 20 });
    try {
      await waitForControl(session);
      session.bindSession({ sessionId: "ac-14-" + mode, controlMode: mode });
      session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 7, recommendationChanged: true,
        workout: { day: "Monday", sessionId: "ac-14-" + mode } });
      await waitUntil(() => fake.state.posts.length === 1);
      assert.deepEqual(fake.state.posts, [{ value: 7 }], mode);
    } finally {
      session.stop();
    }
  }
});

test("AC-15: an old in-flight completion cannot authorize commands for a newer session", async () => {
  const bridge = createDeferredBridge();
  const session = readySession(bridge, { pollIntervalMs: 20 });
  try {
    await waitForControl(session);
    session.bindSession({ sessionId: "old", controlMode: "legacy_hr_control" });
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 4, recommendationChanged: true,
      workout: { day: "Monday", sessionId: "old" } });
    await waitUntil(() => bridge.state.pending.length === 1);
    session.bindSession({ sessionId: "new", controlMode: "legacy_hr_control" });
    bridge.state.pending[0].resolve({ status: 200, text: JSON.stringify({ requested: 4 }) });
    await delay(40);
    const view = session.getViewState();
    assert.equal(view.bridgeAcceptedResistance, null, "the old session's acceptance is not recorded for the new one");
    assert.equal(bridge.state.posts.length, 1, "nothing new was sent on the old completion");
  } finally {
    session.stop();
  }
});

test("control label no longer reports a disabled setting", () => {
  assert.equal(formatBikeBridgeControl({ controlAvailable: true }), "Ready");
  assert.equal(formatBikeBridgeControl({ controlAvailable: false }), "Unavailable");
});
