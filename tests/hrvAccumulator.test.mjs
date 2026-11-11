import assert from "node:assert/strict";
import test from "node:test";
import {
  RollingHrvAccumulator,
  HRV_LIVE_MIN_DURATION_MS,
  HRV_STABLE_MIN_DURATION_MS,
  HRV_LIVE_MIN_DIFFS,
  HRV_MAX_ARTIFACT_PERCENT,
  HRV_MAX_SUSPECT_PERCENT,
  HRV_MAX_NEIGHBOR_GAP_MS,
} from "../dist/platform/hrvAccumulator.js";

test("rejects impossible RR as out_of_range", () => {
  const h = new RollingHrvAccumulator();
  assert.equal(h.pushRr(200).reason, "out_of_range");
  assert.equal(h.pushRr(2500).reason, "out_of_range");
  assert.equal(h.getSnapshot().rejectedTotal, 2);
  assert.equal(h.getSnapshot().acceptedInWindow, 0);
});

test("rejects Magene-style retransmit of same RR", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({ now: () => t });
  assert.equal(h.pushRr(500, t).accepted, true);
  t += 200;
  const dup = h.pushRr(500, t);
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, "retransmit");
  const snap = h.getSnapshot();
  assert.equal(snap.acceptedInWindow, 1);
  assert.equal(snap.rejectedInWindow, 1);
  assert.equal(snap.retransmitInWindow, 1);
  assert.equal(snap.artifactPercent, 0);
  assert.equal(snap.retransmitPercent, 50);
});

test("accepts successive nearly-equal RR when spaced like real beats", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({ now: () => t });
  assert.equal(h.pushRr(500, t).accepted, true);
  t += 500;
  assert.equal(h.pushRr(500, t).accepted, true);
  assert.equal(h.getSnapshot().acceptedInWindow, 2);
  assert.equal(h.getSnapshot().nnDiffCount, 1);
});

test("genuine sustained HR transition does not cascade-reject", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({ now: () => t });
  assert.equal(h.pushRr(800, t).reason, "accepted");
  t += 800;
  const first = h.pushRr(1100, t);
  assert.equal(first.accepted, true);
  assert.equal(first.reason, "accepted_suspect");
  t += 1100;
  const second = h.pushRr(1050, t);
  assert.equal(second.accepted, true);
  t += 1050;
  const third = h.pushRr(1000, t);
  assert.equal(third.accepted, true);
  assert.equal(h.getSnapshot().acceptedInWindow, 4);
  assert.equal(h.getSnapshot().rejectedInWindow, 0);
  assert.ok(h.getSnapshot().suspectInWindow >= 1);
  assert.equal(h.getSnapshot().nnDiffCount, 3);
});

test("respiratory-style alternating RR variability remains represented", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({
    now: () => t,
    liveMinDurationMs: 2_000,
    liveMinDiffs: 3,
  });
  const seq = [900, 1000, 900, 1000, 900, 1000];
  for (const rr of seq) {
    assert.equal(h.pushRr(rr, t).accepted, true);
    t += rr;
  }
  const snap = h.getSnapshot();
  assert.equal(snap.acceptedInWindow, 6);
  assert.equal(snap.suspectInWindow, 0);
  assert.equal(snap.nnDiffCount, 5);
  assert.ok(Math.abs(snap.rmssdMs - 100) < 1e-9);
});

test("large but plausible jump is accepted_suspect, not discarded", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({ now: () => t });
  h.pushRr(500, t);
  t += 500;
  const r = h.pushRr(700, t);
  assert.equal(r.accepted, true);
  assert.equal(r.reason, "accepted_suspect");
  assert.equal(h.getSnapshot().acceptedInWindow, 2);
  assert.equal(h.getSnapshot().suspectInWindow, 1);
});

test("accepted -> out_of_range -> accepted does not create cross-gap RMSSD diff", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({
    now: () => t,
    liveMinDurationMs: 1,
    liveMinDiffs: 1,
  });
  assert.equal(h.pushRr(800, t).accepted, true);
  t += 800;
  assert.equal(h.pushRr(2500, t).reason, "out_of_range");
  t += 500;
  assert.equal(h.pushRr(810, t).accepted, true);
  const snap = h.getSnapshot();
  assert.equal(snap.acceptedInWindow, 2);
  assert.equal(snap.nnDiffCount, 0);
  assert.equal(snap.continuityBreaksInWindow, 1);
  // Not ready via nn diffs; rmssd null while collecting
  assert.equal(snap.readiness, "collecting");
  assert.equal(snap.rmssdMs, null);
});

test("accepted -> retransmit duplicate -> accepted preserves continuity", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({
    now: () => t,
    liveMinDurationMs: 900,
    liveMinDiffs: 1,
  });
  assert.equal(h.pushRr(500, t).accepted, true);
  t += 200;
  assert.equal(h.pushRr(500, t).reason, "retransmit");
  t += 400; // total +600 from first end → next real beat
  assert.equal(h.pushRr(520, t).accepted, true);
  const snap = h.getSnapshot();
  assert.equal(snap.acceptedInWindow, 2);
  assert.equal(snap.nnDiffCount, 1);
  assert.equal(snap.continuityBreaksInWindow, 0);
  assert.ok(Math.abs(snap.rmssdMs - 20) < 1e-9);
});

test("readiness counts usable NN differences only", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({
    now: () => t,
    liveMinDurationMs: 1_000,
    liveMinDiffs: 2,
  });
  // Three accepts with one physiological break → only 1 usable NN diff
  h.pushRr(500, t);
  t += 500;
  h.pushRr(510, t); // nn diff #1
  t += 510;
  h.pushRr(100, t); // break
  t += 100;
  h.pushRr(520, t); // new segment, no nn diff across break
  t += 520;
  h.pushRr(530, t); // nn diff #2 within new segment
  let snap = h.getSnapshot();
  assert.equal(snap.acceptedInWindow, 4);
  assert.equal(snap.nnDiffCount, 2);
  assert.ok(snap.continuityBreaksInWindow >= 1);
  assert.equal(snap.readiness, "live");

  // With liveMinDiffs=3, same data stays collecting despite 4 accepts
  const h2 = new RollingHrvAccumulator({
    now: () => t,
    liveMinDurationMs: 1_000,
    liveMinDiffs: 3,
  });
  let t2 = 1_000_000;
  h2.pushRr(500, t2);
  t2 += 500;
  h2.pushRr(510, t2);
  t2 += 510;
  h2.pushRr(100, t2);
  t2 += 100;
  h2.pushRr(520, t2);
  t2 += 520;
  h2.pushRr(530, t2);
  snap = h2.getSnapshot();
  assert.equal(snap.nnDiffCount, 2);
  assert.equal(snap.readiness, "collecting");
});

test("stale neighbor after long gap starts a fresh sequence", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({
    now: () => t,
    maxNeighborGapMs: HRV_MAX_NEIGHBOR_GAP_MS,
    liveMinDurationMs: 500,
    liveMinDiffs: 1,
  });
  assert.equal(h.pushRr(500, t).accepted, true);
  t += HRV_MAX_NEIGHBOR_GAP_MS + 100;
  const next = h.pushRr(700, t); // would be suspect if compared to 500
  assert.equal(next.accepted, true);
  assert.equal(next.reason, "accepted"); // not suspect — no neighbor
  const snap = h.getSnapshot();
  assert.equal(snap.nnDiffCount, 0);
  assert.ok(snap.continuityBreaksInWindow >= 1);
  assert.equal(snap.suspectInWindow, 0);
});

test("RMSSD from successive RR differences, not BPM", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({
    now: () => t,
    liveMinDurationMs: 1_500,
    liveMinDiffs: 3,
  });
  const rrs = [500, 510, 500, 510];
  for (const rr of rrs) {
    assert.equal(h.pushRr(rr, t).accepted, true);
    t += rr;
  }
  const snap = h.getSnapshot();
  assert.equal(snap.readiness, "live");
  assert.equal(snap.nnDiffCount, 3);
  assert.ok(Math.abs(snap.rmssdMs - 10) < 1e-9);
});

test("multiple RRs in one packet preserve physiological timing", () => {
  const packetTime = 2_000_000;
  const h = new RollingHrvAccumulator({ now: () => packetTime });
  const rrs = [500, 520, 540];
  const results = h.pushRrPacket(rrs, packetTime);
  assert.equal(results.length, 3);
  assert.equal(results[0].endedAtMs, packetTime - 540 - 520);
  assert.equal(results[1].endedAtMs, packetTime - 540);
  assert.equal(results[2].endedAtMs, packetTime);
  assert.equal(results.every((r) => r.accepted), true);
  const snap = h.getSnapshot();
  assert.equal(snap.acceptedInWindow, 3);
  assert.equal(snap.nnDiffCount, 2);
  assert.equal(snap.physiologicalDurationMs, 500 + 520 + 540);
});

test("rolling expiry uses physiological end-times, not callback fan-out", () => {
  let now = 5_000_000;
  const h = new RollingHrvAccumulator({
    now: () => now,
    windowMs: 2_000,
    liveMinDurationMs: 500,
    liveMinDiffs: 1,
  });
  h.pushRrPacket([600, 700, 800], now);
  assert.equal(h.getSnapshot().acceptedInWindow, 3);
  now += 1_200;
  const snap = h.getSnapshot();
  assert.ok(snap.acceptedInWindow < 3);
  assert.ok(snap.physiologicalDurationMs < 600 + 700 + 800);
});

test("readiness uses physiological duration, not beat count alone", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({ now: () => t });

  for (let i = 0; i < 20; i++) {
    assert.equal(h.pushRr(400, t).accepted, true);
    t += 400;
  }
  let snap = h.getSnapshot();
  assert.ok(snap.physiologicalDurationMs < HRV_LIVE_MIN_DURATION_MS);
  assert.equal(snap.readiness, "collecting");
  assert.equal(snap.rmssdMs, null);

  while (h.getSnapshot().physiologicalDurationMs < HRV_LIVE_MIN_DURATION_MS) {
    assert.equal(h.pushRr(400, t).accepted, true);
    t += 400;
  }
  while (h.getSnapshot().nnDiffCount < HRV_LIVE_MIN_DIFFS) {
    assert.equal(h.pushRr(400, t).accepted, true);
    t += 400;
  }
  snap = h.getSnapshot();
  assert.equal(snap.readiness, "live");
  assert.ok(snap.rmssdMs !== null);
});

test("stable requires ~60s of accepted RR duration", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({ now: () => t });
  while (h.getSnapshot().physiologicalDurationMs < HRV_STABLE_MIN_DURATION_MS) {
    assert.equal(h.pushRr(500, t).accepted, true);
    t += 500;
  }
  const snap = h.getSnapshot();
  assert.ok(snap.physiologicalDurationMs >= HRV_STABLE_MIN_DURATION_MS);
  assert.equal(snap.readiness, "stable");
  assert.equal(snap.reliable, true);
});

test("artifact and quality counters age out with the rolling window", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({ now: () => t, windowMs: 3_000 });
  h.pushRr(500, t);
  t += 100;
  h.pushRr(500, t);
  assert.equal(h.getSnapshot().rejectedInWindow, 1);
  assert.equal(h.getSnapshot().rejectedTotal, 1);

  t += 4_000;
  const snap = h.getSnapshot();
  assert.equal(snap.acceptedInWindow, 0);
  assert.equal(snap.rejectedInWindow, 0);
  assert.equal(snap.continuityBreaksInWindow, 0);
  assert.equal(snap.artifactPercent, 0);
  assert.equal(snap.rejectedTotal, 1);
});

test("excessive window contamination marks RMSSD unreliable", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({
    now: () => t,
    liveMinDurationMs: 2_000,
    liveMinDiffs: 2,
    maxArtifactPercent: HRV_MAX_ARTIFACT_PERCENT,
  });
  for (let i = 0; i < 5; i++) {
    h.pushRr(500, t);
    t += 500;
  }
  for (let i = 0; i < 10; i++) {
    h.pushRr(100, t);
    t += 50;
  }
  const snap = h.getSnapshot();
  assert.ok(snap.artifactPercent > HRV_MAX_ARTIFACT_PERCENT);
  assert.equal(snap.readiness, "live");
  assert.equal(snap.reliable, false);
});

test("extreme suspect density marks unreliable without discarding suspects", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({
    now: () => t,
    liveMinDurationMs: 2_000,
    liveMinDiffs: 3,
    maxSuspectPercent: HRV_MAX_SUSPECT_PERCENT,
  });
  // Alternating large jumps → most intervals after the first are suspect
  const seq = [500, 700, 480, 720, 490, 710, 500, 730];
  for (const rr of seq) {
    h.pushRr(rr, t);
    t += rr;
  }
  const snap = h.getSnapshot();
  assert.ok(snap.suspectPercent > HRV_MAX_SUSPECT_PERCENT);
  assert.ok(snap.artifactPercent === 0);
  assert.equal(snap.acceptedInWindow, seq.length);
  assert.equal(snap.ready, true);
  assert.equal(snap.reliable, false);
  assert.ok(snap.rmssdMs !== null);
});

test("reset clears history and rejected counts", () => {
  const h = new RollingHrvAccumulator();
  h.pushRr(500);
  h.pushRr(100);
  h.reset();
  const snap = h.getSnapshot();
  assert.equal(snap.acceptedInWindow, 0);
  assert.equal(snap.rejectedInWindow, 0);
  assert.equal(snap.rejectedTotal, 0);
  assert.equal(snap.retransmitTotal, 0);
  assert.equal(snap.retransmitInWindow, 0);
  assert.equal(snap.nnDiffCount, 0);
  assert.equal(snap.continuityBreaksInWindow, 0);
  assert.equal(snap.latestRrMs, null);
  assert.equal(snap.readiness, "collecting");
});

test("batched packet with mixed valid and invalid intervals breaks continuity", () => {
  const t = 3_000_000;
  const h = new RollingHrvAccumulator({ now: () => t });
  const results = h.pushRrPacket([500, 100, 520], t);
  assert.equal(results[0].accepted, true);
  assert.equal(results[1].reason, "out_of_range");
  assert.equal(results[2].accepted, true);
  const snap = h.getSnapshot();
  assert.equal(snap.acceptedInWindow, 2);
  assert.equal(snap.nnDiffCount, 0);
  assert.ok(snap.continuityBreaksInWindow >= 1);
});

test("many retransmits do not increase physiological artifactPercent", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({ now: () => t });
  h.pushRr(700, t);
  t += 700;
  const acceptedAt = t;
  h.pushRr(710, acceptedAt);
  for (let i = 1; i <= 20; i++) {
    assert.equal(h.pushRr(710, acceptedAt + i * 10).reason, "retransmit");
  }
  t = acceptedAt + 200;
  const snap = h.getSnapshot();
  assert.equal(snap.acceptedInWindow, 2);
  assert.equal(snap.retransmitInWindow, 20);
  assert.equal(snap.rejectReasonsInWindow.retransmit, 20);
  assert.equal(snap.artifactPercent, 0);
  assert.ok(snap.retransmitPercent > 25);
});

test("many retransmits alone do not make a ready RMSSD unreliable", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({
    now: () => t,
    liveMinDurationMs: 2_000,
    liveMinDiffs: 3,
  });
  const seq = [700, 710, 700, 710, 700, 710];
  for (const rr of seq) {
    h.pushRr(rr, t);
    t += 200;
    h.pushRr(rr, t);
    t += rr - 200;
  }
  const snap = h.getSnapshot();
  assert.equal(snap.ready, true);
  assert.ok(snap.retransmitPercent > 25);
  assert.equal(snap.artifactPercent, 0);
  assert.equal(snap.reliable, true);
});

test("retransmits remain excluded from RMSSD", () => {
  let t = 1_000_000;
  const clean = new RollingHrvAccumulator({
    now: () => t,
    liveMinDurationMs: 1_000,
    liveMinDiffs: 2,
  });
  clean.pushRr(700, t);
  t += 700;
  clean.pushRr(720, t);
  t += 720;
  clean.pushRr(700, t);
  const cleanRmssd = clean.getSnapshot().rmssdMs;

  t = 1_000_000;
  const withDups = new RollingHrvAccumulator({
    now: () => t,
    liveMinDurationMs: 1_000,
    liveMinDiffs: 2,
  });
  withDups.pushRr(700, t);
  t += 200;
  withDups.pushRr(700, t);
  t += 500;
  withDups.pushRr(720, t);
  t += 200;
  withDups.pushRr(720, t);
  t += 520;
  withDups.pushRr(700, t);
  const snap = withDups.getSnapshot();
  assert.equal(snap.nnDiffCount, 2);
  assert.ok(Math.abs(snap.rmssdMs - cleanRmssd) < 1e-9);
  assert.equal(snap.retransmitInWindow, 2);
});

test("retransmits remain visible in diagnostic counts", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({ now: () => t, windowMs: 3_000 });
  h.pushRr(500, t);
  t += 100;
  h.pushRr(500, t);
  t += 100;
  h.pushRr(500, t);
  let snap = h.getSnapshot();
  assert.equal(snap.retransmitInWindow, 2);
  assert.equal(snap.retransmitTotal, 2);
  assert.equal(snap.rejectedInWindow, 2);
  assert.equal(snap.rejectReasonsInWindow.retransmit, 2);
  assert.ok(snap.retransmitPercent > 0);

  t += 4_000;
  snap = h.getSnapshot();
  assert.equal(snap.retransmitInWindow, 0);
  assert.equal(snap.retransmitTotal, 2);
  assert.equal(snap.retransmitPercent, 0);
});

test("invalid/out_of_range RR still increase artifactPercent", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({ now: () => t });
  h.pushRr(800, t);
  t += 800;
  h.pushRr(100, t);
  t += 100;
  h.pushRr(2500, t);
  const snap = h.getSnapshot();
  assert.equal(snap.acceptedInWindow, 1);
  assert.equal(snap.retransmitInWindow, 0);
  assert.equal(snap.artifactPercent, (2 / 3) * 100);
  assert.ok(snap.rejectReasonsInWindow.out_of_range >= 1);
});

test("physiological contamination above threshold still causes reliable: false", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({
    now: () => t,
    liveMinDurationMs: 2_000,
    liveMinDiffs: 2,
    maxArtifactPercent: HRV_MAX_ARTIFACT_PERCENT,
  });
  for (let i = 0; i < 5; i++) {
    h.pushRr(500, t);
    t += 500;
  }
  for (let i = 0; i < 10; i++) {
    h.pushRr(100, t);
    t += 50;
  }
  const snap = h.getSnapshot();
  assert.ok(snap.artifactPercent > HRV_MAX_ARTIFACT_PERCENT);
  assert.equal(snap.retransmitInWindow, 0);
  assert.equal(snap.readiness, "live");
  assert.equal(snap.reliable, false);
});

test("suspect threshold behavior remains unchanged", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({
    now: () => t,
    liveMinDurationMs: 2_000,
    liveMinDiffs: 3,
    maxSuspectPercent: HRV_MAX_SUSPECT_PERCENT,
  });
  const seq = [500, 700, 480, 720, 490, 710, 500, 730];
  for (const rr of seq) {
    h.pushRr(rr, t);
    t += rr;
  }
  const snap = h.getSnapshot();
  assert.ok(snap.suspectPercent > HRV_MAX_SUSPECT_PERCENT);
  assert.equal(snap.artifactPercent, 0);
  assert.equal(snap.retransmitPercent, 0);
  assert.equal(snap.acceptedInWindow, seq.length);
  assert.equal(snap.reliable, false);
  assert.ok(snap.rmssdMs !== null);
});

test("H613-like >25% transport retransmits stay stable and reliable", () => {
  let t = 1_000_000;
  const h = new RollingHrvAccumulator({ now: () => t });
  while (h.getSnapshot().physiologicalDurationMs < HRV_STABLE_MIN_DURATION_MS) {
    const rr = 500;
    assert.equal(h.pushRr(rr, t).accepted, true);
    t += 100;
    assert.equal(h.pushRr(rr, t).reason, "retransmit");
    t += rr - 100;
  }
  const snap = h.getSnapshot();
  assert.equal(snap.readiness, "stable");
  assert.ok(snap.retransmitPercent > 25);
  assert.equal(snap.artifactPercent, 0);
  assert.equal(snap.suspectPercent, 0);
  assert.equal(snap.continuityBreaksInWindow, 0);
  assert.equal(snap.suspectInWindow, 0);
  assert.ok(snap.rejectReasonsInWindow.retransmit > 0);
  assert.equal(snap.reliable, true);
  assert.ok(snap.rmssdMs !== null);
});
