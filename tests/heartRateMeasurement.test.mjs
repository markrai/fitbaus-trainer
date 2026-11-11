import assert from "node:assert/strict";
import test from "node:test";
import { parseHeartRateMeasurement } from "../dist/platform/heartRateMeasurement.js";

function dv(...bytes) {
  return new DataView(Uint8Array.from(bytes).buffer);
}

test("8-bit HR with no RR", () => {
  const m = parseHeartRateMeasurement(dv(0x00, 72));
  assert.equal(m.bpm, 72);
  assert.equal(m.flags, 0x00);
  assert.deepEqual(m.rrIntervalsMs, []);
  assert.equal(m.energyExpendedKj, undefined);
  assert.equal(m.optionalFieldError, undefined);
});

test("16-bit HR without RR", () => {
  const m = parseHeartRateMeasurement(dv(0x01, 0x2c, 0x01));
  assert.equal(m.bpm, 300);
  assert.deepEqual(m.rrIntervalsMs, []);
});

test("8-bit HR with one RR", () => {
  const m = parseHeartRateMeasurement(dv(0x10, 60, 0x00, 0x04));
  assert.equal(m.bpm, 60);
  assert.equal(m.rrIntervalsMs.length, 1);
  assert.equal(m.rrIntervalsMs[0], 1000);
});

test("8-bit HR with multiple RR values", () => {
  const m = parseHeartRateMeasurement(dv(0x10, 120, 0x00, 0x02, 0x08, 0x02));
  assert.equal(m.bpm, 120);
  assert.equal(m.rrIntervalsMs.length, 2);
  assert.equal(m.rrIntervalsMs[0], (512 * 1000) / 1024);
  assert.equal(m.rrIntervalsMs[1], (520 * 1000) / 1024);
});

test("Energy Expended followed by RR", () => {
  const m = parseHeartRateMeasurement(dv(0x18, 80, 0x2a, 0x00, 0x20, 0x03));
  assert.equal(m.bpm, 80);
  assert.equal(m.energyExpendedKj, 42);
  assert.equal(m.rrIntervalsMs.length, 1);
  assert.equal(m.rrIntervalsMs[0], (800 * 1000) / 1024);
});

test("real observed H613 packet 16 76 FC 01", () => {
  const m = parseHeartRateMeasurement(dv(0x16, 0x76, 0xfc, 0x01));
  assert.equal(m.flags, 0x16);
  assert.equal(m.bpm, 118);
  assert.equal(m.rrIntervalsMs.length, 1);
  assert.equal(m.rrIntervalsMs[0], (508 * 1000) / 1024);
  assert.ok(Math.abs(m.rrIntervalsMs[0] - 496.09375) < 1e-9);
});

test("truncated packet: too short overall fails mandatory HR", () => {
  assert.throws(() => parseHeartRateMeasurement(dv(0x00)), /Invalid Heart Rate Measurement/);
});

test("truncated packet: 16-bit HR missing byte fails mandatory HR", () => {
  assert.throws(() => parseHeartRateMeasurement(dv(0x01, 0x2c)), /Invalid 16-bit/);
});

test("valid BPM + malformed Energy Expended keeps BPM, no RR", () => {
  const m = parseHeartRateMeasurement(dv(0x08, 70, 0x01));
  assert.equal(m.bpm, 70);
  assert.deepEqual(m.rrIntervalsMs, []);
  assert.equal(m.energyExpendedKj, undefined);
  assert.match(m.optionalFieldError, /Energy Expended missing/);
});

test("valid BPM + malformed RR keeps BPM, excludes RR from HRV input", () => {
  const m = parseHeartRateMeasurement(dv(0x10, 70, 0x00));
  assert.equal(m.bpm, 70);
  assert.deepEqual(m.rrIntervalsMs, []);
  assert.match(m.optionalFieldError, /RR-Interval field incomplete/);
});

test("valid BPM + RR flag with zero RR bytes keeps BPM", () => {
  const m = parseHeartRateMeasurement(dv(0x10, 70));
  assert.equal(m.bpm, 70);
  assert.deepEqual(m.rrIntervalsMs, []);
  assert.match(m.optionalFieldError, /RR-Interval field incomplete/);
});

test("does not infer RR from BPM when RR flag clear", () => {
  const m = parseHeartRateMeasurement(dv(0x06, 100));
  assert.equal(m.bpm, 100);
  assert.deepEqual(m.rrIntervalsMs, []);
});
