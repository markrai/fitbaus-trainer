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

