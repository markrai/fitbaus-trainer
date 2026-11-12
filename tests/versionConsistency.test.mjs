import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  nativeVersionManifestJson,
  parseNativeVersionManifest,
  parseProductVersion,
  readAppVersion,
} = require("../scripts/fitbaus-version.cjs");
const { checkVersionConsistency } = require("../scripts/check-version-consistency.cjs");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONSISTENCY_FILES = [
  "version.js",
  "package.json",
  "package-lock.json",
  "src/version.ts",
  "dist/version.js",
  "sw.js",
  "ios/App/App.xcodeproj/project.pbxproj",
  "android/build.gradle",
  "android/app/build.gradle",
  "equipment-bridges/proform-smart-power-10/native/bridge-app/build.gradle.kts",
  "equipment-bridges/proform-smart-power-10/native/equipment-protocol/src/main/kotlin/com/fitbaus/bikebridge/protocol/BridgeHttpJson.kt",
  "equipment-bridges/proform-smart-power-10/scripts/native-resistance-actuation-fake-bridge.mjs",
];

async function copyConsistencyTree(tmp) {
  const dest = (file) => path.join(tmp, file);
  for (const file of CONSISTENCY_FILES) {
    await mkdir(path.dirname(dest(file)), { recursive: true });
    await cp(path.join(repoRoot, file), dest(file));
  }
}

async function writeSyncedVersion(tmp, versionName) {
  const parsed = parseProductVersion(versionName, "test");
  const dest = (file) => path.join(tmp, file);
  await writeFile(dest("version.js"), `const APP_VERSION = "${parsed.name}";\n`);
  await writeFile(dest("src/version.ts"), `export const APP_VERSION = "${parsed.name}";\n`);
  await writeFile(dest("dist/version.js"), `export const APP_VERSION = "${parsed.name}";\n`);
  const pkg = JSON.parse(await readFile(dest("package.json"), "utf8"));
  pkg.version = parsed.name;
  await writeFile(dest("package.json"), JSON.stringify(pkg, null, 2) + "\n");
  const lock = JSON.parse(await readFile(dest("package-lock.json"), "utf8"));
  lock.version = parsed.name;
  if (lock.packages && lock.packages[""]) {
    lock.packages[""].version = parsed.name;
  }
  await writeFile(dest("package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
  let pbx = await readFile(dest("ios/App/App.xcodeproj/project.pbxproj"), "utf8");
  pbx = pbx.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${parsed.name};`);
  pbx = pbx.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${parsed.versionCode};`);
  await writeFile(dest("ios/App/App.xcodeproj/project.pbxproj"), pbx);
  return parsed;
}

test("product version helper accepts 1.0.0 as versionCode 10000", () => {
  const parsed = parseProductVersion("1.0.0", "test");
  assert.equal(parsed.name, "1.0.0");
  assert.equal(parsed.versionCode, 10000);
});

test("product version helper accepts 1.0.1 as versionCode 10001", () => {
  const parsed = parseProductVersion("1.0.1", "test");
  assert.equal(parsed.versionCode, 10001);
});

test("product version helper rejects overlapping minor/patch values", () => {
  assert.throws(() => parseProductVersion("1.0.100", "test"), /patch version must be 0\.\.99/);
  assert.throws(() => parseProductVersion("1.100.0", "test"), /minor version must be 0\.\.99/);
  assert.throws(() => parseProductVersion("0.0.0", "test"), /outside Android's permitted range/);
  assert.throws(() => parseProductVersion("1.0", "test"), /major\.minor\.patch/);
});

test("native version manifest round-trips the canonical product version", () => {
  const parsed = parseProductVersion("1.0.1", "test");
  const json = nativeVersionManifestJson(parsed);
  const loaded = parseNativeVersionManifest(json, "test-manifest");
  assert.equal(loaded.name, "1.0.1");
  assert.equal(loaded.versionCode, 10001);
  assert.throws(
    () => parseNativeVersionManifest(JSON.stringify({ version: "1.0.1", versionCode: 10000 }), "stale"),
    /versionCode 10000, expected 10001/,
  );
});

test("canonical version.js is a valid product version", () => {
  const parsed = readAppVersion(path.join(repoRoot, "version.js"));
  assert.match(parsed.name, /^\d+\.\d+\.\d+$/);
  assert.equal(parsed.versionCode, parsed.major * 10000 + parsed.minor * 100 + parsed.patch);
});

test("repository versions are consistent after build", () => {
  const canonical = readAppVersion(path.join(repoRoot, "version.js"));
  const result = checkVersionConsistency(repoRoot, { requireGradle: "none" });
  assert.equal(result.ok, true, (result.errors || []).join("\n"));
  assert.equal(result.expected.name, canonical.name);
  assert.equal(result.expected.versionCode, canonical.versionCode);
});

test("version consistency checker accepts a synchronized future version", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "fitbaus-version-future-"));
  await copyConsistencyTree(tmp);
  const parsed = await writeSyncedVersion(tmp, "1.0.1");
  const result = checkVersionConsistency(tmp, { requireGradle: "none" });
  assert.equal(result.ok, true, (result.errors || []).join("\n"));
  assert.equal(result.expected.name, "1.0.1");
  assert.equal(result.expected.versionCode, parsed.versionCode);
});

test("version consistency checker fails on drifted package.json", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "fitbaus-version-drift-"));
  await copyConsistencyTree(tmp);
  const pkg = JSON.parse(await readFile(path.join(tmp, "package.json"), "utf8"));
  pkg.version = "9.9.9";
  await writeFile(path.join(tmp, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  const result = checkVersionConsistency(tmp, { requireGradle: "none" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes("package.json version 9.9.9")));
});
