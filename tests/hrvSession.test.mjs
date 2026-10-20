import assert from "node:assert/strict";
import test from "node:test";
import { HrvSession } from "../dist/platform/hrvSession.js";
import { formatHrvDisplay, isHrvUnavailable } from "../dist/platform/hrvDisplay.js";
import { HRV_UNAVAILABLE_MIN_CONNECTED_MS, HRV_UNAVAILABLE_MIN_CLEAN_MEASUREMENTS } from "../dist/platform/hrvDisplay.js";

function sessionAt(tRef) {
  return new HrvSession({ now: () => tRef.t });
}

test("connection attempt is not considered connected", () => {
  const tRef = { t: 1_000 };
  const session = sessionAt(tRef);
  const snap = session.prepareConnectAttempt();
  assert.equal(snap.connected, false);
  assert.equal(snap.connectedDurationMs, 0);
  assert.equal(snap.rrSeenThisSession, false);
  assert.equal(formatHrvDisplay(snap).state, "disconnected");

  tRef.t += 8_000;
  const later = session.getSnapshot();
  assert.equal(later.connected, false);
  assert.equal(later.connectedDurationMs, 0);
  assert.equal(isHrvUnavailable(later), false);
});

test("successful connect starts session duration from actual connection", () => {
  const tRef = { t: 10_000 };
  const session = sessionAt(tRef);
  session.prepareConnectAttempt();
  tRef.t = 18_000;
  assert.equal(session.getSnapshot().connectedDurationMs, 0);

  session.activateConnected();
  tRef.t = 21_500;
  const snap = session.getSnapshot();
  assert.equal(snap.connected, true);
  assert.equal(snap.connectedDurationMs, 3_500);
  assert.equal(formatHrvDisplay(snap).state, "collecting");
});

test("canceled/failed connection ends disconnected with no unavailable timer", () => {
  const tRef = { t: 5_000 };
  const session = sessionAt(tRef);
  session.prepareConnectAttempt();
  tRef.t = 9_000;
  const snap = session.deactivate();
  assert.equal(snap.connected, false);
  assert.equal(snap.connectedDurationMs, 0);
  assert.equal(formatHrvDisplay(snap).state, "disconnected");

  tRef.t += HRV_UNAVAILABLE_MIN_CONNECTED_MS + 5_000;
  for (let i = 0; i < HRV_UNAVAILABLE_MIN_CLEAN_MEASUREMENTS; i++) {
    session.noteOptionalFieldsOk();
  }
  const after = session.getSnapshot();
  assert.equal(after.connected, false);
  assert.equal(after.connectedDurationMs, 0);
  assert.equal(isHrvUnavailable(after), false);
  assert.equal(formatHrvDisplay(after).state, "disconnected");
});

test("reconnect starts a fresh session", () => {
  const tRef = { t: 0 };
  const session = sessionAt(tRef);
  session.activateConnected();
  session.ingestRrPacket([800]);
  tRef.t = 12_000;
  const live = session.getSnapshot();
  assert.equal(live.connected, true);
  assert.equal(live.rrSeenThisSession, true);
  assert.ok(live.acceptedInWindow >= 1);

  session.deactivate();
  session.prepareConnectAttempt();
  tRef.t = 40_000;
  const attempting = session.getSnapshot();
  assert.equal(attempting.connected, false);
  assert.equal(attempting.rrSeenThisSession, false);
  assert.equal(attempting.acceptedInWindow, 0);
  assert.equal(attempting.physiologicalDurationMs, 0);
  assert.equal(formatHrvDisplay(attempting).primary, "HRV —");

  session.activateConnected();
  const fresh = session.getSnapshot();
  assert.equal(fresh.connected, true);
  assert.equal(fresh.connectedDurationMs, 0);
  assert.equal(fresh.rrSeenThisSession, false);
  assert.equal(fresh.acceptedInWindow, 0);
  assert.equal(fresh.cleanMeasurementCountThisSession, 0);
  assert.equal(formatHrvDisplay(fresh).state, "collecting");
  assert.equal(formatHrvDisplay(fresh).secondary, "Collecting · 0s");
});

test("decoded but rejected RR does not satisfy rrSeenThisSession", () => {
  const tRef = { t: 1_000 };
  const session = sessionAt(tRef);
  session.activateConnected();
  const { results, snapshot } = session.ingestRrPacket([200, 2500]);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => !r.accepted));
  assert.equal(snapshot.rrSeenThisSession, false);
  assert.equal(snapshot.acceptedInWindow, 0);
  assert.equal(snapshot.cleanMeasurementCountThisSession, 1);
  assert.equal(snapshot.rejectedInWindow, 2);
});

test("first accepted RR satisfies rrSeenThisSession", () => {
  const tRef = { t: 1_000 };
  const session = sessionAt(tRef);
  session.activateConnected();
  session.ingestRrPacket([200]);
  assert.equal(session.getSnapshot().rrSeenThisSession, false);

  const { results, snapshot } = session.ingestRrPacket([800]);
  assert.equal(results.length, 1);
  assert.equal(results[0].accepted, true);
  assert.equal(snapshot.rrSeenThisSession, true);
  assert.equal(snapshot.acceptedInWindow, 1);
});

test("accepted RR after unavailable returns UI to collecting", () => {
  const tRef = { t: 0 };
  const session = sessionAt(tRef);
  session.activateConnected();
  tRef.t = HRV_UNAVAILABLE_MIN_CONNECTED_MS;
  for (let i = 0; i < HRV_UNAVAILABLE_MIN_CLEAN_MEASUREMENTS; i++) {
    session.noteOptionalFieldsOk();
  }
  const unavailable = session.getSnapshot();
  assert.equal(isHrvUnavailable(unavailable), true);
  assert.equal(formatHrvDisplay(unavailable).state, "unavailable");
  assert.equal(unavailable.rrSeenThisSession, false);

  tRef.t += 800;
  const { snapshot } = session.ingestRrPacket([800]);
  assert.equal(snapshot.rrSeenThisSession, true);
  assert.equal(isHrvUnavailable(snapshot), false);
  const model = formatHrvDisplay(snapshot);
  assert.equal(model.state, "collecting");
  assert.equal(model.primary, "HRV —");
  assert.match(model.secondary, /^Collecting · \d+s$/);
});

test("once accepted, later rejected packets keep rrSeenThisSession", () => {
  const tRef = { t: 1_000 };
  const session = sessionAt(tRef);
  session.activateConnected();
  session.ingestRrPacket([800]);
  tRef.t += 800;
  session.ingestRrPacket([2500]);
  const snap = session.getSnapshot();
  assert.equal(snap.rrSeenThisSession, true);
  assert.equal(snap.acceptedInWindow, 1);
});
