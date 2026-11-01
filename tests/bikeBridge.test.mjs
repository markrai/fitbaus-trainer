import assert from "node:assert/strict";
import test from "node:test";
import { parseBikeBridgeBaseUrl, joinBikeBridgeUrl, loadBikeBridgeSettings, saveBikeBridgeSettings } from "../dist/platform/bikeBridgeConfig.js";
import {
  parseBikeTelemetry,
  parseBridgeStatus,
  parseResistanceAccepted,
  toBridgeBrightness,
  toBridgeHeartRateBpm,
  toBridgeResistanceLevel,
  createBikeBridgeClient,
} from "../dist/platform/bikeBridgeClient.js";
import { createBikeBridgeSession } from "../dist/platform/bikeBridgeRuntime.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForControl(session) {
  session.start();
  await waitUntil(() => session.getViewState().readiness === "control_ready");
}

function readySession(fake, overrides = {}) {
  const session = createBikeBridgeSession({
    storage: memoryStorage(),
    transport: fake.transport,
    pollIntervalMs: overrides.pollIntervalMs ?? 1000,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 50,
    getCurrentBpm: overrides.getCurrentBpm,
  });
  const configured = session.configure({
    baseUrl: "http://192.168.1.10:8765",
    automaticControlEnabled: overrides.automaticControlEnabled ?? true,
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

test("status ready, disconnected, not initialized, and control unavailable", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake);
  try {
    session.start();
    await waitUntil(() => session.getViewState().readiness === "control_ready");
    assert.equal(session.getViewState().controlAvailable, true);

    fake.state.controlAvailable = false;
    await delay(5);
    session.stop();
    session.start();
    await waitUntil(() => session.getViewState().readiness === "telemetry_ready");
    assert.equal(session.getViewState().controlAvailable, false);

    fake.state.initialized = false;
    session.stop();
    session.start();
    await waitUntil(() => session.getViewState().readiness === "reachable_not_initialized");

    fake.state.connected = false;
    session.stop();
    session.start();
    await waitUntil(() => session.getViewState().readiness === "reachable_disconnected");
  } finally {
    session.stop();
  }
});

test("malformed status becomes invalid_response", async () => {
  const fake = createFakeBikeBridge({ statusText: "{\"nope\":true}" });
  const session = readySession(fake, { automaticControlEnabled: false });
  try {
    session.start();
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
    session.start();
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
    session.start();
    await waitUntil(() => session.getViewState().observedResistance === 5);
    fake.state.failNext = { path: "/api/v1/telemetry", status: 500, error: "boom" };
    session.stop();
    session.start();
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
    session.start();
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
    session.start();
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
    session.start();
    session.start();
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
    session.start();
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

test("disabling automatic control stops resistance writes", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { automaticControlEnabled: false });
  try {
    session.start();
    await waitUntil(() => session.getViewState().readiness === "control_ready");
    session.onGuidance({
      desiredResistance: 4,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
    });
    await delay(20);
    assert.equal(fake.state.posts.length, 0);
    session.configure({ automaticControlEnabled: true });
    session.onGuidance({
      desiredResistance: 4,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
    });
    await waitUntil(() => fake.state.posts.length === 1);
    session.configure({ automaticControlEnabled: false });
    session.onGuidance({
      desiredResistance: 8,
      recommendationChanged: true,
      workoutActive: true,
      paused: false,
    });
    await delay(20);
    assert.equal(fake.state.posts.length, 1);
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

test("session posts 1 Hz HR heartbeat including unchanged BPM", async () => {
  const fake = createFakeBikeBridge();
  let bpm = 142;
  const session = readySession(fake, {
    pollIntervalMs: 40,
    getCurrentBpm: () => bpm,
  });
  try {
    session.start();
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
  try {
    session.start();
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
    session.start();
    await waitUntil(() => session.getViewState().readiness === "control_ready", 500);
    await waitUntil(() => fake.state.heartratePosts.length >= 2, 500);
    const view = session.getViewState();
    assert.equal(view.readiness, "control_ready");
    assert.equal(view.lastError, null);
    assert.equal(view.rpm, 56);
  } finally {
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

test("session setConsoleBrightness persists and posts without automatic control", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { automaticControlEnabled: false });
  const result = await session.setConsoleBrightness(25);
  assert.equal(result.ok, true);
  assert.equal(session.getViewState().consoleBrightness, 25);
  assert.equal(session.getViewState().automaticControlEnabled, false);
  assert.deepEqual(fake.state.brightnessPosts, [{ value: 25 }]);
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
  session.start();
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

test("F0-5: enabling automaticControl via configure does not send commands during Freestyle", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { automaticControlEnabled: false });
  await waitForControl(session);
  session.bindSession({ sessionId: "fs-toggle", controlMode: "manual_freestyle_ride" });
  session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 7, recommendationChanged: true,
    workout: { day: "", sessionId: "fs-toggle" } });
  await delay(10);
  // Re-enable global automatic control
  session.configure({ automaticControlEnabled: true });
  await delay(30);
  assert.equal(fake.state.posts.length, 0,
    "configure(automaticControlEnabled: true) must not dispatch commands during Freestyle");
  session.stop();
});

// --- Scenario 6: No reconciliation send after reconnect during Freestyle ---

test("F0-6: bridge reconnect does not trigger reconciliation send during Freestyle", async () => {
  const fake = createFakeBikeBridge({ connected: false });
  const session = freestyleSession(fake, { pollIntervalMs: 20 });
  session.start();
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

test("F0-9: Freestyle viewState never exposes desiredResistance or commandedResistance", async () => {
  const fake = createFakeBikeBridge();
  const session = freestyleSession(fake);
  await waitForControl(session);
  session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 9, recommendationChanged: true,
    workout: { day: "", sessionId: "fs-bridge-001" } });
  await delay(30);
  const vs = session.getViewState();
  assert.equal(vs.desiredResistance, undefined, "desiredResistance must be absent in Freestyle viewState");
  assert.equal(vs.commandedResistance, undefined, "commandedResistance must be absent in Freestyle viewState");
  session.stop();
});

// --- Scenario 10: postedResistanceBodies stays empty after Freestyle guidance ---

test("F0-10: postedResistanceBodies stays empty for entire Freestyle session", async () => {
  const fake = createFakeBikeBridge();
  const session = freestyleSession(fake, { pollIntervalMs: 20 });
  await waitForTelemetry(session);
  for (let i = 0; i < 5; i++) {
    session.onGuidance({ workoutActive: true, paused: false, desiredResistance: i + 1,
      recommendationChanged: true, workout: { day: "", sessionId: "fs-bridge-001" } });
    await delay(10);
  }
  assert.equal(session.postedResistanceBodies().length, 0,
    "postedResistanceBodies must remain empty for Freestyle");
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

// --- Scenario 13: Disarmed bridge correctly renders automaticControlEnabled from storage ---

test("F0-13: disarmed bridge reflects automaticControlEnabled from settings without sending commands", async () => {
  const fake = createFakeBikeBridge();
  const session = readySession(fake, { automaticControlEnabled: true });
  await waitForControl(session);
  session.bindSession(null);
  // Even though automatic control is enabled in settings, no command should fire
  session.onGuidance({ workoutActive: true, paused: false, desiredResistance: 4, recommendationChanged: true });
  await delay(30);
  assert.equal(fake.state.posts.length, 0, "Disarmed session must not send commands");
  // View should still reflect the stored automatic control setting
  assert.equal(session.getViewState().automaticControlEnabled, true,
    "automaticControlEnabled viewState should still reflect storage");
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
