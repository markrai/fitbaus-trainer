import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const REQUIRED_VO2_RUNTIME_MODULES = [
  "/dist/vo2Estimator.js",
  "/dist/vo2AssessmentView.js",
  "/dist/vo2Protocol.js",
  "/dist/vo2Evidence.js",
  "/dist/vo2Workload.js",
  "/dist/bikeTelemetryTrace.js",
  "/dist/workoutLifecycle.js",
  "/dist/types.js",
  "/dist/workoutTemplate.js",
  "/dist/workoutPrescription.js",
  "/dist/sessionControlMode.js",
  "/dist/fitnessState.js",
  "/dist/fitnessRefinement.js",
  "/dist/ordinaryWorkoutTelemetry.js",
  "/dist/workoutResponse.js",
  "/dist/stats.js",
  "/dist/performedLoad.js",
  "/dist/performedLoadDiagnosticsView.js",
  "/dist/utils/uuid.js",
];

test("service worker precache includes VO2 runtime modules", async () => {
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  const match = sw.match(/const urlsToCache = \[([\s\S]*?)\];/);
  assert.ok(match, "urlsToCache list should exist");
  for (const url of REQUIRED_VO2_RUNTIME_MODULES) {
    assert.equal(sw.includes("'" + url + "'") || sw.includes('"' + url + '"'), true, url);
  }
});
