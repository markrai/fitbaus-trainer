import assert from "node:assert/strict";
import test from "node:test";
import { parseHeartRateMeasurement } from "../dist/platform/heartRateMeasurement.js";
import { dispatchHeartRateMeasurement } from "../dist/platform/heartRateDispatch.js";
import { RollingHrvAccumulator } from "../dist/platform/hrvAccumulator.js";

function dv(...bytes) {
  return new DataView(Uint8Array.from(bytes).buffer);
}

function simulateSharedPath(acc, diag, value) {
  const bpms = [];
  const hrvUpdates = [];
  dispatchHeartRateMeasurement(value, {
    onBpm: (bpm) => bpms.push(bpm),
    onClearOptionalFieldError: () => {
      diag.lastOptionalFieldError = null;
    },
    onRrIntervals: (rrs) => {
      acc.pushRrPacket(rrs);
      hrvUpdates.push("rr");
    },
    onOptionalFieldError: (message) => {
      diag.lastOptionalFieldError = message;
      diag.optionalFieldErrorTotalThisSession += 1;
      acc.markContinuityBreak("optional_field_error");
      hrvUpdates.push("error");
    },
    onOptionalFieldsOk: () => {
      const hadError = diag.lastOptionalFieldError !== null;
      diag.lastOptionalFieldError = null;
      if (hadError) hrvUpdates.push("cleared");
    },
  });
  return { bpms, hrvUpdates };
}

test("accepted -> malformed optional RR -> accepted does not create cross-hole NN diff", () => {
  let t = 1_000_000;
  const acc = new RollingHrvAccumulator({ now: () => t, liveMinDurationMs: 1, liveMinDiffs: 1 });
  const diag = { lastOptionalFieldError: null, optionalFieldErrorTotalThisSession: 0 };

  acc.pushRr(800, t);
  t += 800;
  const { bpms } = simulateSharedPath(acc, diag, dv(0x10, 90, 0x00));
  assert.deepEqual(bpms, [90]);
  t += 500;
  const next = acc.pushRr(810, t);
  assert.equal(next.accepted, true);
  assert.equal(next.reason, "accepted");

  const snap = acc.getSnapshot();
  assert.equal(snap.acceptedInWindow, 2);
  assert.equal(snap.nnDiffCount, 0);
  assert.ok(snap.continuityBreaksInWindow >= 1);
  assert.ok(snap.continuityBreakReasonsInWindow.optional_field_error >= 1);
  assert.equal(snap.rejectedTotal, 0);
  assert.equal(snap.rejectedInWindow, 0);
});

test("malformed optional packet preserves BPM and does not reject an RR", () => {
  const m = parseHeartRateMeasurement(dv(0x10, 72, 0x00));
  assert.equal(m.bpm, 72);
  assert.deepEqual(m.rrIntervalsMs, []);
  assert.ok(m.optionalFieldError);

  const acc = new RollingHrvAccumulator();
  const before = acc.getSnapshot().rejectedTotal;
  acc.markContinuityBreak("optional_field_error");
  assert.equal(acc.getSnapshot().rejectedTotal, before);
  assert.equal(acc.getSnapshot().rejectedInWindow, 0);
});

test("continuity-break count reflects optional-field hole; next RR starts fresh NN segment", () => {
  let t = 2_000_000;
  const acc = new RollingHrvAccumulator({ now: () => t });
  acc.pushRr(500, t);
  t += 500;
  acc.markContinuityBreak("optional_field_error", t);
  t += 500;
  const r = acc.pushRr(700, t);
  assert.equal(r.reason, "accepted");
  assert.equal(acc.getSnapshot().nnDiffCount, 0);
  assert.equal(acc.getSnapshot().continuityBreaksInWindow, 1);
});

test("subsequent clean BPM-only measurement clears lastOptionalFieldError", () => {
  const acc = new RollingHrvAccumulator();
  const diag = { lastOptionalFieldError: "stale", optionalFieldErrorTotalThisSession: 1 };
  simulateSharedPath(acc, diag, dv(0x10, 80));
  assert.ok(diag.lastOptionalFieldError);
  assert.equal(diag.optionalFieldErrorTotalThisSession, 2);

  simulateSharedPath(acc, diag, dv(0x00, 75));
  assert.equal(diag.lastOptionalFieldError, null);
  assert.equal(diag.optionalFieldErrorTotalThisSession, 2);
});

test("subsequent clean RR measurement clears lastOptionalFieldError", () => {
  const acc = new RollingHrvAccumulator();
  const diag = { lastOptionalFieldError: null, optionalFieldErrorTotalThisSession: 0 };
  simulateSharedPath(acc, diag, dv(0x10, 80));
  assert.ok(diag.lastOptionalFieldError);

  simulateSharedPath(acc, diag, dv(0x10, 80, 0x00, 0x02));
  assert.equal(diag.lastOptionalFieldError, null);
  assert.equal(acc.getSnapshot().acceptedInWindow, 1);
});

test("native and web share dispatchHeartRateMeasurement semantics", () => {
  const events = [];
  dispatchHeartRateMeasurement(dv(0x10, 88, 0x01), {
    onBpm: (bpm) => events.push(["bpm", bpm]),
    onRrIntervals: (rrs) => events.push(["rr", rrs.length]),
    onOptionalFieldError: (msg) => events.push(["err", msg]),
    onOptionalFieldsOk: () => events.push(["ok"]),
    onClearOptionalFieldError: () => events.push(["clear"]),
  });
  assert.deepEqual(events[0], ["bpm", 88]);
  assert.equal(events[1][0], "err");
  assert.ok(!events.some((e) => e[0] === "rr"));
  assert.ok(!events.some((e) => e[0] === "ok"));

  const events2 = [];
  dispatchHeartRateMeasurement(dv(0x00, 70), {
    onBpm: (bpm) => events2.push(["bpm", bpm]),
    onRrIntervals: (rrs) => events2.push(["rr", rrs.length]),
    onOptionalFieldError: (msg) => events2.push(["err", msg]),
    onOptionalFieldsOk: () => events2.push(["ok"]),
    onClearOptionalFieldError: () => events2.push(["clear"]),
  });
  assert.deepEqual(events2, [["bpm", 70], ["ok"]]);
});

test("one clean RR notification causes one HRV subscriber update", () => {
  const acc = new RollingHrvAccumulator();
  const diag = { lastOptionalFieldError: null, optionalFieldErrorTotalThisSession: 0 };
  const { hrvUpdates, bpms } = simulateSharedPath(acc, diag, dv(0x10, 80, 0x00, 0x02));
  assert.deepEqual(bpms, [80]);
  assert.deepEqual(hrvUpdates, ["rr"]);
});

test("optional-field diagnostic clearing on BPM-only notifies once, not with a following RR", () => {
  const acc = new RollingHrvAccumulator();
  const diag = { lastOptionalFieldError: "stale", optionalFieldErrorTotalThisSession: 0 };
  const bpmOnly = simulateSharedPath(acc, diag, dv(0x00, 70));
  assert.deepEqual(bpmOnly.hrvUpdates, ["cleared"]);

  const cleanRr = simulateSharedPath(acc, diag, dv(0x10, 80, 0x00, 0x02));
  assert.deepEqual(cleanRr.hrvUpdates, ["rr"]);
});

test("clean RR after stale diagnostic does not emit a separate clear update", () => {
  const acc = new RollingHrvAccumulator();
  const diag = { lastOptionalFieldError: "stale", optionalFieldErrorTotalThisSession: 0 };
  const { hrvUpdates } = simulateSharedPath(acc, diag, dv(0x10, 80, 0x00, 0x02));
  assert.equal(diag.lastOptionalFieldError, null);
  assert.deepEqual(hrvUpdates, ["rr"]);
});
