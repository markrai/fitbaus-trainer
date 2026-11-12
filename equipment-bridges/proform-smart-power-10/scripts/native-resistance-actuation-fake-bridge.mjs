// SPDX-License-Identifier: AGPL-3.0-only

import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { readAppVersion } = require("../../../scripts/fitbaus-version.cjs");
const APP_VERSION = readAppVersion(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../version.js")
).name;

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const scenario = args.get("scenario") ?? "pass";
const token = args.get("token") ?? "";

const baselineFor = {
  baseline0: 0,
  baselineHigh: 8,
};

const state = {
  r: baselineFor[scenario] ?? 2,
  baseline: baselineFor[scenario] ?? 2,
  requested: null,
  requestedAt: null,
  posts: [],
  telemetryCalls: 0,
  phase: "baseline",
  lastClock: 0,
  frozenAt: null,
};

function tick() {
  const now = Date.now();
  state.lastClock = now > state.lastClock ? now : state.lastClock + 1;
  return new Date(state.lastClock).toISOString();
}

function metric(value, at, current = true) {
  return { value, observedAt: at, current };
}

function wattsFor(r) {
  if (scenario === "wattsFlat") return 80;
  if (scenario === "fieldNotFollowing" && state.phase === "after") return 110;
  return 50 + 15 * r;
}

function telemetry() {
  state.telemetryCalls += 1;
  let at = tick();
  let r = state.r;
  if (scenario === "baselineUnstable" && state.phase === "baseline") {
    r = state.telemetryCalls % 2 === 0 ? 3 : 2;
  }
  const body = {
    connected: true,
    initialized: true,
    snapshotAt: at,
    resistance: metric(r, at),
    rpm: metric(60, at),
    watts: metric(wattsFor(r), at),
    machine: { type: "Bike", canSetResistance: true, maxResistanceLevel: 22 },
  };
  if (scenario === "baselineStale" && state.phase === "baseline") {
    body.rpm.current = false;
  }
  if (state.phase === "after") {
    if (scenario === "staleAfterWrite" || scenario === "rejected502Stale") {
      body.watts.current = false;
      body.rpm.current = false;
    }
    if (scenario === "frozenSnapshot") {
      state.frozenAt = state.frozenAt ?? at;
      body.snapshotAt = state.frozenAt;
      body.rpm.observedAt = state.frozenAt;
      body.watts.observedAt = state.frozenAt;
      body.resistance.observedAt = state.frozenAt;
    }
    if (scenario === "staleMetricAge") {
      body.resistance.observedAt = new Date(state.lastClock - 10_000).toISOString();
    }
    if (scenario === "nullWatts") {
      body.watts.value = null;
    }
  }
  return body;
}

function status() {
  const at = tick();
  return {
    status: "ok",
    bridgeVersion: APP_VERSION,
    connected: true,
    initialized: true,
    resistanceControlAvailable: true,
    resistance: {
      requested: state.requested,
      requestedAt: state.requestedAt,
      observed: state.r,
      observedAt: at,
    },
  };
}

function accept(level, apply = true) {
  state.requested = level;
  state.requestedAt = tick();
  if (apply) state.r = level;
  return [200, { requested: level }];
}

function handleWrite(level) {
  const index = state.posts.length;
  const isRestore = index > 0;
  if (!isRestore) {
    state.phase = "after";
    switch (scenario) {
      case "rejected503":
        return [503, { error: "resistance write not transmitted (detached_before_out)" }];
      case "rejected502Unchanged":
        return [502, { error: "resistance write rejected after transmit (FAILED/4)" }];
      case "rejected502Applied":
        state.r = level;
        return [502, { error: "resistance write rejected after transmit (IN_PROGRESS/3)" }];
      case "rejected502Stale":
        return [502, { error: "security block after transmit; VerifySecurity is not enabled" }];
      case "uncertainUnresolved":
        return [504, { error: "resistance command outcome uncertain" }];
      case "uncertainLateDone":
        setTimeout(() => accept(level), 1500);
        return [504, { error: "resistance command outcome uncertain" }];
      case "networkTimeout":
        return null;
      case "fieldNotFollowing":
        return accept(level, false);
      default:
        return accept(level);
    }
  }
  state.phase = "restored";
  switch (scenario) {
    case "restoreRejected":
      return [503, { error: "resistance write not transmitted (detached_before_out)" }];
    case "restoreRejectedAfterTransmit":
      return [502, { error: "resistance write rejected after transmit (FAILED/4)" }];
    case "restoreUncertain":
      return [504, { error: "resistance command outcome uncertain" }];
    case "restoreUnconfirmed":
      return accept(level, false);
    case "restoreInFlightThenOk":
      if (index === 1) return [503, { error: "resistance command in flight" }];
      return accept(level);
    default:
      return accept(level);
  }
}

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/__posts") return send(res, 200, state.posts);
    if (req.method === "GET" && path === "/api/v1/telemetry") return send(res, 200, telemetry());
    if (req.method === "GET" && path === "/api/v1/status") return send(res, 200, status());
    if (req.method === "POST" && path === "/api/v1/resistance") {
      if (req.headers["x-fitbaus-token"] !== token) {
        state.posts.push({ level: null, status: 401 });
        return send(res, 401, { error: "pairing required" });
      }
      const level = JSON.parse(raw).value;
      const outcome = handleWrite(level);
      if (outcome === null) {
        state.posts.push({ level, status: 0 });
        return;
      }
      state.posts.push({ level, status: outcome[0] });
      return send(res, outcome[0], outcome[1]);
    }
    return send(res, 404, { error: "not found" });
  });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});
