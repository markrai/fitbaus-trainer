import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { resolveSourceRef } = require("../scripts/release/resolve-source-ref.cjs");
const { assertCertMatchesPolicy } = require("../scripts/release/check-signing-policy.cjs");
const { assertBridgeQualified } = require("../scripts/release/check-physical-qualification.cjs");
const { preparePublicArtifacts } = require("../scripts/release/prepare-public-artifacts.cjs");
const {
  verifyApk,
  findTool,
  parseVerifyText,
  signatureSchemeRequirements,
  assertSignatureSchemes,
} = require("../scripts/release/verify-apk.cjs");
const { signApk } = require("../scripts/release/sign-apk.cjs");
const { publicArtifactNames, redactArg, sha256File } = require("../scripts/release/common.cjs");
const {
  classifyGhFailure,
  uploadGithubReleaseAssets,
  releaseGhArgs,
} = require("../scripts/release/upload-github-release-assets.cjs");
const { writeReleaseCandidate } = require("../scripts/release/write-release-candidate.cjs");
const {
  validateReleaseCandidate,
  expectedVersionFromTag,
  parseSha256Sums,
} = require("../scripts/release/validate-release-candidate.cjs");
const { assertTagMatchesSourceVersion } = require("../scripts/release/assert-tag-source-version.cjs");
const { parseProductVersion } = require("../scripts/fitbaus-version.cjs");
const {
  assertCandidateRun,
  parseWorkflowRunPath,
} = require("../scripts/release/assert-candidate-run.cjs");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitOk(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || "").trim();
}

/** Isolated annotated-tag fixture — independent of the developer's local tags/branches. */
function makeAnnotatedTagFixture({ tag = "v1.0.0" } = {}) {
  const dir = tempDir("fitbaus-tag-fixture-");
  gitOk(dir, ["init", "-b", "main"]);
  gitOk(dir, ["config", "user.email", "release-test@example.com"]);
  gitOk(dir, ["config", "user.name", "FitBaus Release Test"]);
  fs.writeFileSync(path.join(dir, "README"), "annotated-tag fixture\n");
  gitOk(dir, ["add", "README"]);
  gitOk(dir, ["commit", "-m", "fixture commit for tag peeling"]);
  const commit = gitOk(dir, ["rev-parse", "HEAD"]);
  gitOk(dir, ["tag", "-a", tag, "-m", `annotated ${tag}`]);
  assert.equal(gitOk(dir, ["cat-file", "-t", tag]), "tag");
  return { dir, tag, commit };
}

test("resolveSourceRef peels an annotated tag to the expected commit", () => {
  const fixture = makeAnnotatedTagFixture();
  const resolved = resolveSourceRef({
    repoDir: fixture.dir,
    tag: fixture.tag,
    expectedCommit: fixture.commit,
    fetch: false,
  });
  assert.equal(resolved.commit, fixture.commit);
  assert.equal(resolved.tagType, "tag");
});

test("resolveSourceRef requires expected commit and rejects mismatches", () => {
  const fixture = makeAnnotatedTagFixture();
  assert.throws(
    () => resolveSourceRef({ repoDir: fixture.dir, tag: fixture.tag, fetch: false }),
    /expect-commit is required|--expect-commit is required|expectedCommit/,
  );
  assert.throws(
    () =>
      resolveSourceRef({
        repoDir: fixture.dir,
        tag: fixture.tag,
        expectedCommit: "0000000000000000000000000000000000000000",
        fetch: false,
      }),
    /expected 0000000000000000000000000000000000000000/,
  );
});

test("signing policy unset pin fails closed unless allowUnset", () => {
  const dir = tempDir("fitbaus-sign-unset-");
  const policyPath = path.join(dir, "signing-policy.json");
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      schemaVersion: 1,
      packages: {
        "com.fitbaus.bikebridge": {
          role: "bikebridge-production",
          expectedCertSha256: null,
        },
      },
    }),
  );
  assert.throws(
    () =>
      assertCertMatchesPolicy({
        policyPath,
        applicationId: "com.fitbaus.bikebridge",
        actualCertSha256: "A".repeat(64),
      }),
    /expectedCertSha256 is unset/,
  );
  const soft = assertCertMatchesPolicy({
    policyPath,
    applicationId: "com.fitbaus.bikebridge",
    actualCertSha256: "A".repeat(64),
    allowUnset: true,
  });
  assert.equal(soft.pinned, false);
});

test("signing policy accepts matching pin and rejects wrong identity", () => {
  const dir = tempDir("fitbaus-sign-pinned-");
  const policyPath = path.join(dir, "signing-policy.json");
  const pin = "B".repeat(64);
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      schemaVersion: 1,
      packages: {
        "com.fitbaus.bikebridge": {
          role: "bikebridge-production",
          expectedCertSha256: pin,
        },
      },
    }),
  );
  const ok = assertCertMatchesPolicy({
    policyPath,
    applicationId: "com.fitbaus.bikebridge",
    actualCertSha256: pin,
  });
  assert.equal(ok.pinned, true);
  assert.throws(
    () =>
      assertCertMatchesPolicy({
        policyPath,
        applicationId: "com.fitbaus.bikebridge",
        actualCertSha256: "A".repeat(64),
      }),
    /Wrong signing identity/,
  );
});

test("qualified production release evidence remains tracked with the release policy", () => {
  const policy = JSON.parse(fs.readFileSync(path.join(root, ".github/release/physical-qualification.json"), "utf8"));
  for (const record of policy.records) {
    assert.match(record.evidenceRef, /^\.github\/release\/evidence\/[a-z0-9.-]+\.md$/);
    assert.ok(fs.existsSync(path.join(root, record.evidenceRef)), record.evidenceRef);
  }
});

test("physical qualification requires exact apk/commit/cert/evidence binding", () => {
  assert.throws(
    () =>
      assertBridgeQualified({
        qualificationPath: path.join(root, ".github/release/physical-qualification.json"),
        versionName: "1.0.0",
        certSha256: "C".repeat(64),
        apkSha256: "d".repeat(64),
        sourceCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
      }),
    /No physical qualification record/,
  );

  const dir = tempDir("fitbaus-qual-");
  const file = path.join(dir, "physical-qualification.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 2,
      records: [
        {
          versionName: "1.0.0",
          applicationId: "com.fitbaus.bikebridge",
          status: "qualified",
          certSha256: "C".repeat(64),
          apkSha256: "d".repeat(64),
          sourceCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
          evidenceRef: "agent-store/uvc-physical-evidence/README.txt",
          console: "ProForm Smart Power 10.0",
        },
      ],
    }),
  );
  assert.throws(
    () =>
      assertBridgeQualified({
        qualificationPath: file,
        versionName: "1.0.0",
        certSha256: "C".repeat(64),
        apkSha256: "e".repeat(64),
        sourceCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
      }),
    /exact Bridge candidate/,
  );
  const row = assertBridgeQualified({
    qualificationPath: file,
    versionName: "1.0.0",
    certSha256: "C".repeat(64),
    apkSha256: "d".repeat(64),
    sourceCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
  });
  assert.equal(row.evidenceRef, "agent-store/uvc-physical-evidence/README.txt");
});

test("preparePublicArtifacts writes canonical names and separates qualification wording", () => {
  const dir = tempDir("fitbaus-public-");
  const trainer = path.join(dir, "t.apk");
  const bridge = path.join(dir, "b.apk");
  const web = path.join(dir, "w.zip");
  fs.writeFileSync(trainer, "trainer");
  fs.writeFileSync(bridge, "bridge");
  fs.writeFileSync(web, "web");
  const out = path.join(dir, "public");
  const names = preparePublicArtifacts({
    artifactDir: out,
    versionName: "1.0.0",
    versionCode: 10000,
    edition: "lite",
    sourceTag: "v1.0.0",
    sourceCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
    toolingRef: "tooling",
    trainerApkPath: trainer,
    bridgeApkPath: bridge,
    webZipPath: web,
    trainerCert: "A".repeat(64),
    bridgeCert: "B".repeat(64),
    bridgeQualified: false,
  });
  assert.equal(names.trainerApk, publicArtifactNames("1.0.0", "lite").trainerApk);
  const md = fs.readFileSync(path.join(out, names.manifest), "utf8");
  assert.match(md, /Candidate provenance/);
  assert.match(md, /Physical qualification/);
  assert.match(md, /published Release means that\s+gate passed/i);
  assert.doesNotMatch(md, /bridgeQualified=false|qualification was not recorded/i);
  assert.doesNotMatch(md, /does \*\*not\*\* claim the Bridge APK has already been/);
  const candidate = writeReleaseCandidate({
    artifactDir: out,
    versionName: "1.0.0",
    versionCode: 10000,
    edition: "lite",
    sourceTag: "v1.0.0",
    sourceCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
    toolingRef: "tooling",
    trainerCert: "A".repeat(64),
    bridgeCert: "B".repeat(64),
    workflowRunId: "4242",
  });
  assert.equal(candidate.artifacts.bridgeApk.sha256, sha256File(path.join(out, names.bridgeApk)));
  const validated = validateReleaseCandidate({
    candidateDir: out,
    expectedTag: "v1.0.0",
    expectedCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
    expectedEdition: "lite",
    expectedWorkflowRunId: "4242",
  });
  assert.equal(validated.versionName, "1.0.0");
});

/** CRC-32 for uncompressed ZIP local/central headers (deterministic, no deps). */
function zipCrc32(buf) {
  let crc = ~0;
  const table = zipCrc32.table || (zipCrc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (~crc) >>> 0;
}

/**
 * Build a minimal valid ZIP with one stored entry. EOCD-only archives make
 * `unzip -l` exit 1 on Ubuntu; a single harmless entry is listable everywhere.
 */
function buildStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zipCrc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localFull = Buffer.concat([local, nameBuf, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    locals.push(localFull);
    offset += localFull.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

/** Structurally valid unsigned ZIP/APK fixture (not signed; for sidecar / listing tests). */
function writeListableZipApk(apkPath) {
  fs.writeFileSync(apkPath, buildStoredZip([["fixture.txt", Buffer.alloc(0)]]));
}

function assertArchiveListable(apkPath) {
  const unzip = spawnSync("unzip", ["-l", apkPath], { encoding: "utf8" });
  if (unzip.status === 0) {
    assert.match(String(unzip.stdout || ""), /fixture\.txt/);
    return;
  }
  const tar = spawnSync("tar", ["-tf", apkPath], { encoding: "utf8" });
  if (tar.status === 0) {
    assert.match(String(tar.stdout || ""), /fixture\.txt/);
    return;
  }
  assert.fail(
    `Archive listing unavailable or fixture not listable ` +
      `(unzip=${unzip.status}, tar=${tar.status}): ${apkPath}`,
  );
}

function writeVerifySidecars(apkPath, { applicationId, signed = true, certSha256 = "D".repeat(64) }) {
  fs.writeFileSync(
    `${apkPath}.meta.json`,
    JSON.stringify({
      applicationId,
      versionName: "1.0.0",
      versionCode: 10000,
      minSdk: 22,
    }),
  );
  fs.writeFileSync(
    `${apkPath}.cert.json`,
    JSON.stringify({
      signed,
      v1: signed,
      v2: signed,
      certSha256: signed ? certSha256 : null,
    }),
  );
}

/** Simulate host with no Android SDK build-tools / PATH entries. */
const absentSdkFindTool = () => null;

/**
 * Simulate discoverable SDK tools. runTool rejects malformed APKs the same way
 * real apksigner does on CI (ApkFormatException), without requiring a local SDK.
 */
function presentSdkHarness() {
  return {
    findTool: (name) => `/fake-sdk/build-tools/35.0.0/${name}`,
    runTool: (command, args) => {
      throw new Error(
        `${command} ${args.join(" ")} failed\n` +
          `Exception in thread "main" com.android.apksig.apk.ApkFormatException: ` +
          `Malformed APK: not a ZIP archive`,
      );
    },
  };
}

test("verifyApk fails closed when SDK tools are absent and sidecar is disabled", () => {
  const dir = tempDir("fitbaus-apk-no-sdk-");
  const apk = path.join(dir, "app.apk");
  writeListableZipApk(apk);
  writeVerifySidecars(apk, { applicationId: "com.fitbaus.bikebridge" });
  assert.throws(
    () =>
      verifyApk({
        apkPath: apk,
        expectedApplicationId: "com.fitbaus.bikebridge",
        expectedVersionName: "1.0.0",
        expectedMinSdk: 22,
        findTool: absentSdkFindTool,
      }),
    /apksigner unavailable/,
  );
});

test("verifyApk uses sidecar metadata when SDK tools are absent and fallback is enabled", () => {
  const dir = tempDir("fitbaus-apk-sidecar-ok-");
  const apk = path.join(dir, "app.apk");
  writeListableZipApk(apk);
  assertArchiveListable(apk);
  const cert = "E".repeat(64);
  writeVerifySidecars(apk, { applicationId: "com.fitbaus.bikebridge", certSha256: cert });
  const result = verifyApk({
    apkPath: apk,
    expectedApplicationId: "com.fitbaus.bikebridge",
    expectedVersionName: "1.0.0",
    expectedVersionCode: 10000,
    expectedMinSdk: 22,
    allowSidecarFallback: true,
    findTool: absentSdkFindTool,
  });
  assert.equal(result.applicationId, "com.fitbaus.bikebridge");
  assert.equal(result.certSha256, cert);
  assert.equal(result.v1, true);
});

test("verifyApk ignores sidecars and rejects malformed APK when SDK tools are present", () => {
  const dir = tempDir("fitbaus-apk-sdk-present-");
  const apk = path.join(dir, "app.apk");
  // Deliberately not a ZIP — matches the CI failure mode for the old test fixture.
  fs.writeFileSync(apk, "not-a-zip-apk");
  writeVerifySidecars(apk, { applicationId: "com.fitbaus.bikebridge" });
  const harness = presentSdkHarness();
  assert.throws(
    () =>
      verifyApk({
        apkPath: apk,
        expectedApplicationId: "com.fitbaus.bikebridge",
        expectedVersionName: "1.0.0",
        expectedMinSdk: 22,
        allowSidecarFallback: true,
        findTool: harness.findTool,
        runTool: harness.runTool,
      }),
    /Malformed APK|not a ZIP archive/,
  );

  // When the host actually has SDK tools, the production discovery path must behave the same.
  const realApksigner = findTool("apksigner", "APKSIGNER");
  if (realApksigner) {
    assert.throws(
      () =>
        verifyApk({
          apkPath: apk,
          expectedApplicationId: "com.fitbaus.bikebridge",
          expectedVersionName: "1.0.0",
          expectedMinSdk: 22,
          allowSidecarFallback: true,
        }),
      /Malformed APK|not a ZIP archive|failed/,
    );
  }
});

test("verifyApk rejects unsigned sidecar when fallback is explicitly allowed", () => {
  const dir = tempDir("fitbaus-apk-unsigned-");
  const apk = path.join(dir, "app.apk");
  writeListableZipApk(apk);
  writeVerifySidecars(apk, {
    applicationId: "com.markrai.fitbaus.trainer",
    signed: false,
  });
  assert.throws(
    () =>
      verifyApk({
        apkPath: apk,
        expectedApplicationId: "com.markrai.fitbaus.trainer",
        expectedVersionName: "1.0.0",
        allowSidecarFallback: true,
        findTool: absentSdkFindTool,
      }),
    /unsigned/,
  );
});

test("verifyApk rejects wrong application ID from an allowed sidecar", () => {
  const dir = tempDir("fitbaus-apk-wrong-id-");
  const apk = path.join(dir, "app.apk");
  writeListableZipApk(apk);
  writeVerifySidecars(apk, { applicationId: "com.example.wrong" });
  assert.throws(
    () =>
      verifyApk({
        apkPath: apk,
        expectedApplicationId: "com.fitbaus.bikebridge",
        expectedVersionName: "1.0.0",
        expectedMinSdk: 22,
        allowSidecarFallback: true,
        findTool: absentSdkFindTool,
      }),
    /applicationId/,
  );
});

function schemeStatus(v1, v2) {
  return {
    v1,
    v2,
    v1Reported: true,
    v2Reported: true,
    certSha256: "F".repeat(64),
    raw: `Verified using v1 scheme (JAR signing): ${v1}\nVerified using v2 scheme (APK Signature Scheme v2): ${v2}\n`,
  };
}

test("signatureSchemeRequirements are API-aware", () => {
  assert.deepEqual(signatureSchemeRequirements({ minSdkVersion: 24 }), {
    requireV1: false,
    requireV2: true,
  });
  assert.deepEqual(signatureSchemeRequirements({ minSdkVersion: 22 }), {
    requireV1: true,
    requireV2: false,
  });
  assert.deepEqual(signatureSchemeRequirements({ minSdkVersion: null }), {
    requireV1: true,
    requireV2: true,
  });
  assert.deepEqual(signatureSchemeRequirements({ minSdkVersion: 24, requireV1: true }), {
    requireV1: true,
    requireV2: true,
  });
});

test("assertSignatureSchemes enforces the release v1/v2 matrix", () => {
  const apk = "trainer-or-bridge.apk";
  const cases = [
    { minSdk: 24, v1: false, v2: true, ok: true },
    { minSdk: 24, v1: true, v2: true, ok: true },
    { minSdk: 24, v1: false, v2: false, ok: false, err: /Scheme v2/ },
    { minSdk: 24, v1: true, v2: false, ok: false, err: /Scheme v2/ },
    { minSdk: 22, v1: true, v2: false, ok: true },
    { minSdk: 22, v1: true, v2: true, ok: true },
    { minSdk: 22, v1: false, v2: true, ok: false, err: /Scheme v1/ },
    { minSdk: 22, v1: false, v2: false, ok: false, err: /Scheme v1/ },
  ];
  for (const row of cases) {
    const parsed = schemeStatus(row.v1, row.v2);
    if (row.ok) {
      assert.doesNotThrow(() =>
        assertSignatureSchemes(parsed, { minSdkVersion: row.minSdk, apkPath: apk }),
      );
    } else {
      assert.throws(
        () => assertSignatureSchemes(parsed, { minSdkVersion: row.minSdk, apkPath: apk }),
        row.err,
      );
    }
  }

  assert.doesNotThrow(() =>
    assertSignatureSchemes(schemeStatus(true, true), { minSdkVersion: null, apkPath: apk }),
  );
  assert.throws(
    () => assertSignatureSchemes(schemeStatus(true, false), { minSdkVersion: null, apkPath: apk }),
    /Scheme v2/,
  );
  assert.throws(
    () => assertSignatureSchemes(schemeStatus(false, true), { minSdkVersion: null, apkPath: apk }),
    /Scheme v1/,
  );

  const unparseable = {
    v1: false,
    v2: false,
    v1Reported: false,
    v2Reported: false,
    certSha256: null,
    raw: "no scheme lines",
  };
  assert.throws(
    () => assertSignatureSchemes(unparseable, { minSdkVersion: 24, apkPath: apk }),
    /Unparseable APK Signature Scheme v2/,
  );
  assert.throws(
    () => assertSignatureSchemes(unparseable, { minSdkVersion: 22, apkPath: apk }),
    /Unparseable APK Signature Scheme v1/,
  );
  assert.throws(
    () => assertSignatureSchemes(unparseable, { minSdkVersion: null, apkPath: apk }),
    /Unparseable APK Signature Scheme v1/,
  );

  const parsedFromVerify = parseVerifyText(
    "Verified using v1 scheme (JAR signing): false\nVerified using v2 scheme (APK Signature Scheme v2): true\n",
  );
  assert.equal(parsedFromVerify.v1, false);
  assert.equal(parsedFromVerify.v2, true);
  assert.doesNotThrow(() =>
    assertSignatureSchemes(parsedFromVerify, { minSdkVersion: 24, apkPath: apk }),
  );
});

test("verifyApk API 24 accepts v2-only sidecar and rejects v1-only", () => {
  const dir = tempDir("fitbaus-apk-api24-");
  const apk = path.join(dir, "app.apk");
  writeListableZipApk(apk);
  fs.writeFileSync(
    `${apk}.meta.json`,
    JSON.stringify({
      applicationId: "com.markrai.fitbaus.trainer",
      versionName: "1.0.0",
      versionCode: 10000,
      minSdk: 24,
    }),
  );
  fs.writeFileSync(
    `${apk}.cert.json`,
    JSON.stringify({ signed: true, v1: false, v2: true, certSha256: "A".repeat(64) }),
  );
  const ok = verifyApk({
    apkPath: apk,
    expectedApplicationId: "com.markrai.fitbaus.trainer",
    expectedVersionName: "1.0.0",
    expectedMinSdk: 24,
    allowSidecarFallback: true,
    findTool: absentSdkFindTool,
  });
  assert.equal(ok.v2, true);
  assert.equal(ok.v1, false);

  fs.writeFileSync(
    `${apk}.cert.json`,
    JSON.stringify({ signed: true, v1: true, v2: false, certSha256: "A".repeat(64) }),
  );
  assert.throws(
    () =>
      verifyApk({
        apkPath: apk,
        expectedApplicationId: "com.markrai.fitbaus.trainer",
        expectedVersionName: "1.0.0",
        expectedMinSdk: 24,
        allowSidecarFallback: true,
        findTool: absentSdkFindTool,
      }),
    /Scheme v2/,
  );
});

test("verifyApk API 22 still requires verified v1 even when v2 is present", () => {
  const dir = tempDir("fitbaus-apk-api22-");
  const apk = path.join(dir, "app.apk");
  writeListableZipApk(apk);
  writeVerifySidecars(apk, { applicationId: "com.fitbaus.bikebridge" });
  fs.writeFileSync(
    `${apk}.cert.json`,
    JSON.stringify({ signed: true, v1: false, v2: true, certSha256: "B".repeat(64) }),
  );
  assert.throws(
    () =>
      verifyApk({
        apkPath: apk,
        expectedApplicationId: "com.fitbaus.bikebridge",
        expectedVersionName: "1.0.0",
        expectedMinSdk: 22,
        requireV1: true,
        allowSidecarFallback: true,
        findTool: absentSdkFindTool,
      }),
    /Scheme v1/,
  );
});

function makeSignApkRunTool({ verifyStdout = "", verifyFailMessage = null } = {}) {
  return (command, args) => {
    if (args[0] === "-f" && args[1] === "4") {
      fs.copyFileSync(args[2], args[3]);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "sign") {
      const outIdx = args.indexOf("--out");
      assert.ok(outIdx >= 0);
      fs.copyFileSync(args[args.length - 1], args[outIdx + 1]);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "verify") {
      if (verifyFailMessage) {
        throw new Error(`${command} ${args.join(" ")} failed\n${verifyFailMessage}`);
      }
      return { status: 0, stdout: verifyStdout, stderr: "" };
    }
    throw new Error(`unexpected mock command: ${command} ${args.join(" ")}`);
  };
}

function signApkFixture(prefix) {
  const dir = tempDir(prefix);
  const inputApk = path.join(dir, "in.apk");
  const outputApk = path.join(dir, "out.apk");
  const keystore = path.join(dir, "test.jks");
  fs.writeFileSync(inputApk, "unsigned-apk-bytes");
  fs.writeFileSync(keystore, "keystore-bytes");
  return {
    dir,
    inputApk,
    outputApk,
    keystore,
    base: {
      inputApk,
      outputApk,
      keystore,
      storePassword: "store-pass",
      keyAlias: "alias",
      keyPassword: "key-pass",
      apksigner: "mock-apksigner",
      zipalign: "mock-zipalign",
    },
  };
}

const v1FalseV2TrueVerify = [
  "Verified using v1 scheme (JAR signing): false",
  "Verified using v2 scheme (APK Signature Scheme v2): true",
  "",
].join("\n");

test("signApk post-sign verify accepts API 24 when v1=false and v2=true", () => {
  const fx = signApkFixture("fitbaus-sign-api24-ok-");
  const out = signApk({
    ...fx.base,
    minSdkVersion: 24,
    runTool: makeSignApkRunTool({ verifyStdout: v1FalseV2TrueVerify }),
  });
  assert.equal(out, fx.outputApk);
  assert.ok(fs.existsSync(fx.outputApk));
});

test("signApk post-sign verify rejects API 22 when v1=false and v2=true", () => {
  const fx = signApkFixture("fitbaus-sign-api22-reject-");
  assert.throws(
    () =>
      signApk({
        ...fx.base,
        minSdkVersion: 22,
        runTool: makeSignApkRunTool({ verifyStdout: v1FalseV2TrueVerify }),
      }),
    /Scheme v1/,
  );
});

test("signApk treats nonzero apksigner verify exit as fatal", () => {
  const fx = signApkFixture("fitbaus-sign-verify-fail-");
  assert.throws(
    () =>
      signApk({
        ...fx.base,
        minSdkVersion: 24,
        runTool: makeSignApkRunTool({
          verifyFailMessage: "DOES NOT VERIFY\nMalformed APK: not a ZIP archive",
        }),
      }),
    /DOES NOT VERIFY|failed/,
  );
});

test("signApk treats missing required signature-scheme status as fatal", () => {
  const fx = signApkFixture("fitbaus-sign-unparseable-");
  assert.throws(
    () =>
      signApk({
        ...fx.base,
        minSdkVersion: 24,
        runTool: makeSignApkRunTool({
          verifyStdout: "Verified using v1 scheme (JAR signing): false\n",
        }),
      }),
    /Unparseable APK Signature Scheme v2/,
  );
});

test("signApk fails closed without credentials and redacts pass args", () => {
  assert.match(redactArg("pass:super-secret"), /redacted/);
  const dir = tempDir("fitbaus-sign-missing-");
  const input = path.join(dir, "in.apk");
  const output = path.join(dir, "out.apk");
  fs.writeFileSync(input, "apk");
  assert.throws(
    () =>
      signApk({
        inputApk: input,
        outputApk: output,
        keystore: path.join(dir, "missing.jks"),
        storePassword: "x",
        keyAlias: "y",
        keyPassword: "z",
        apksigner: "apksigner-does-not-exist",
        zipalign: "zipalign-does-not-exist",
      }),
    /Keystore missing/,
  );
});

test("upload helper requires explicit repo and classifies not_found", () => {
  assert.equal(classifyGhFailure("HTTP 404: Not Found\nrelease not found", ""), "not_found");
  assert.equal(classifyGhFailure("HTTP 403: Resource not accessible by integration", ""), "auth");
  assert.throws(
    () =>
      uploadGithubReleaseAssets({
        tag: "v1.0.0",
        title: "x",
        notesFile: "notes",
        artifactDir: tempDir("fitbaus-upload-"),
        assetNames: ["a"],
        dryRun: true,
      }),
    /--repo|required/,
  );
  const dir = tempDir("fitbaus-upload-ok-");
  fs.writeFileSync(path.join(dir, "a.txt"), "hi");
  fs.writeFileSync(path.join(dir, "notes.md"), "notes");
  const dry = uploadGithubReleaseAssets({
    tag: "v1.0.0",
    title: "x",
    notesFile: path.join(dir, "notes.md"),
    artifactDir: dir,
    assetNames: ["a.txt"],
    repo: "markrai/fitbaus-trainer",
    dryRun: true,
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.repo, "markrai/fitbaus-trainer");
});

function makeAssetBundle(prefix) {
  const dir = tempDir(prefix);
  const assets = ["a.apk", "b.apk", "web.zip", "SHA256SUMS.txt", "ARTIFACTS.md", "release-candidate.json"];
  for (const name of assets) {
    fs.writeFileSync(path.join(dir, name), `${name}-bytes`);
  }
  fs.writeFileSync(path.join(dir, "ARTIFACTS.md"), "# FitBaus Lite 1.0.0\n");
  return { dir, assets, notes: path.join(dir, "ARTIFACTS.md") };
}

function assertReleaseGhArgv(args, { repo = "markrai/fitbaus-trainer" } = {}) {
  assert.notEqual(args[0], "--repo", "must not prepend --repo before the gh command");
  assert.notEqual(args[0], "-R", "must not prepend -R before the gh command");
  assert.equal(args[0], "release");
  const repoIdx = args.lastIndexOf("--repo");
  assert.ok(repoIdx > 1, `command-local --repo required in ${args.join(" ")}`);
  assert.equal(args[repoIdx + 1], repo);
  assert.ok(repoIdx > args.indexOf(args[1]), "--repo must follow the release subcommand");
}

function createMockGh({ initialRelease = null, repo = "markrai/fitbaus-trainer" } = {}) {
  const state = {
    release: initialRelease
      ? {
          id: initialRelease.id || "1",
          tagName: initialRelease.tagName || "v1.0.0",
          isDraft: initialRelease.isDraft !== false,
          url: initialRelease.url || "https://example.test/release",
          title: initialRelease.title || "",
          notesFile: initialRelease.notesFile || null,
          assets: (initialRelease.assets || []).map((asset) => ({
            name: asset.name,
            content: asset.content,
          })),
        }
      : null,
    calls: [],
    failNextUpload: false,
  };

  function runner(args) {
    state.calls.push([...args]);
    assertReleaseGhArgv(args, { repo });
    const join = args.join(" ");

    if (args[0] === "release" && args[1] === "view") {
      const tag = args[2];
      if (!state.release || state.release.tagName !== tag) {
        return { status: 1, stdout: "", stderr: "release not found\nHTTP 404" };
      }
      if (args.includes("--json")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            id: state.release.id,
            tagName: state.release.tagName,
            isDraft: state.release.isDraft,
            url: state.release.url,
            assets: state.release.assets.map((a) => ({ name: a.name })),
          }),
          stderr: "",
        };
      }
    }

    if (args[0] === "release" && args[1] === "create") {
      const tag = args[2];
      const titleIdx = args.indexOf("--title");
      const notesIdx = args.indexOf("--notes-file");
      state.release = {
        id: "new",
        tagName: tag,
        isDraft: true,
        url: "https://example.test/release",
        title: titleIdx >= 0 ? args[titleIdx + 1] : "",
        notesFile: notesIdx >= 0 ? args[notesIdx + 1] : null,
        assets: [],
      };
      return { status: 0, stdout: state.release.url, stderr: "" };
    }

    if (args[0] === "release" && args[1] === "edit") {
      if (!state.release) return { status: 1, stdout: "", stderr: "release not found" };
      const titleIdx = args.indexOf("--title");
      const notesIdx = args.indexOf("--notes-file");
      if (titleIdx >= 0) state.release.title = args[titleIdx + 1];
      if (notesIdx >= 0) state.release.notesFile = args[notesIdx + 1];
      if (args.includes("--draft=false")) state.release.isDraft = false;
      return { status: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "release" && args[1] === "upload") {
      if (state.failNextUpload) {
        state.failNextUpload = false;
        return { status: 1, stdout: "", stderr: "upload failed: network timeout" };
      }
      const filePath = args[3];
      const name = path.basename(filePath);
      state.release.assets.push({
        name,
        content: fs.readFileSync(filePath),
      });
      return { status: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "release" && args[1] === "download") {
      const patternIdx = args.indexOf("--pattern");
      const dirIdx = args.indexOf("--dir");
      const pattern = patternIdx >= 0 ? args[patternIdx + 1] : null;
      const dest = dirIdx >= 0 ? args[dirIdx + 1] : null;
      const asset = state.release.assets.find((a) => a.name === pattern);
      if (!asset || !dest) {
        return { status: 1, stdout: "", stderr: `asset ${pattern} not found` };
      }
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, asset.name), asset.content);
      return { status: 0, stdout: "", stderr: "" };
    }

    return { status: 1, stdout: "", stderr: `unexpected gh mock call: ${join}` };
  }

  return { state, runner };
}

test("mocked gh: creates new draft, uploads assets, then publishes", () => {
  const { dir, assets, notes } = makeAssetBundle("fitbaus-pub-new-");
  const { state, runner } = createMockGh();
  const result = uploadGithubReleaseAssets({
    tag: "v1.0.0",
    title: "FitBaus Lite 1.0.0",
    notesFile: notes,
    artifactDir: dir,
    assetNames: assets,
    repo: "markrai/fitbaus-trainer",
    runner,
  });
  assert.equal(result.createdDraft, true);
  assert.equal(result.updatedDraftMetadata, true);
  assert.equal(result.published, true);
  assert.equal(result.isDraft, false);
  assert.equal(result.uploaded.length, assets.length);
  assert.equal(state.release.isDraft, false);
  assert.equal(state.release.title, "FitBaus Lite 1.0.0");
  assert.ok(state.calls.some((c) => c.includes("create") && c.includes("--draft")));
  assert.ok(state.calls.some((c) => c.includes("--draft=false")));
  const publishIdx = state.calls.findIndex((c) => c.includes("--draft=false"));
  const lastUploadIdx = state.calls.map((c) => c[1]).lastIndexOf("upload");
  assert.ok(lastUploadIdx < publishIdx, "publish must happen after uploads");
});

test("mocked gh: existing empty draft gets Lite metadata before assets", () => {
  const { dir, assets, notes } = makeAssetBundle("fitbaus-pub-draft-");
  const { state, runner } = createMockGh({
    initialRelease: {
      tagName: "v1.0.0",
      isDraft: true,
      title: "Old unsigned notes",
      assets: [],
    },
  });
  const result = uploadGithubReleaseAssets({
    tag: "v1.0.0",
    title: "FitBaus Lite 1.0.0",
    notesFile: notes,
    artifactDir: dir,
    assetNames: assets,
    repo: "markrai/fitbaus-trainer",
    runner,
  });
  assert.equal(result.createdDraft, false);
  assert.equal(result.updatedDraftMetadata, true);
  assert.equal(state.release.title, "FitBaus Lite 1.0.0");
  assert.equal(state.release.notesFile, notes);
  const editIdx = state.calls.findIndex((c) => c[1] === "edit" && c.includes("--title"));
  const uploadIdx = state.calls.findIndex((c) => c[1] === "upload");
  assert.ok(editIdx >= 0 && editIdx < uploadIdx);
});

test("mocked gh: failed upload leaves release as draft", () => {
  const { dir, assets, notes } = makeAssetBundle("fitbaus-pub-fail-");
  const { state, runner } = createMockGh();
  state.failNextUpload = true;
  assert.throws(
    () =>
      uploadGithubReleaseAssets({
        tag: "v1.0.0",
        title: "FitBaus Lite 1.0.0",
        notesFile: notes,
        artifactDir: dir,
        assetNames: assets,
        repo: "markrai/fitbaus-trainer",
        runner,
      }),
    /upload failed|network/,
  );
  assert.equal(state.release.isDraft, true);
  assert.ok(!state.calls.some((c) => c.includes("--draft=false")));
});

test("mocked gh: identical asset retry is skipped; conflicting asset rejected", () => {
  const { dir, assets, notes } = makeAssetBundle("fitbaus-pub-retry-");
  const firstContent = fs.readFileSync(path.join(dir, "a.apk"));
  const { state, runner } = createMockGh({
    initialRelease: {
      tagName: "v1.0.0",
      isDraft: true,
      assets: [{ name: "a.apk", content: firstContent }],
    },
  });
  const ok = uploadGithubReleaseAssets({
    tag: "v1.0.0",
    title: "FitBaus Lite 1.0.0",
    notesFile: notes,
    artifactDir: dir,
    assetNames: assets,
    repo: "markrai/fitbaus-trainer",
    runner,
  });
  assert.equal(ok.skippedSameHash.length, 1);
  assert.equal(ok.skippedSameHash[0].name, "a.apk");

  fs.writeFileSync(path.join(dir, "a.apk"), "different-bytes");
  const { runner: runner2 } = createMockGh({
    initialRelease: {
      tagName: "v1.0.0",
      isDraft: true,
      assets: [{ name: "a.apk", content: firstContent }],
    },
  });
  assert.throws(
    () =>
      uploadGithubReleaseAssets({
        tag: "v1.0.0",
        title: "FitBaus Lite 1.0.0",
        notesFile: notes,
        artifactDir: dir,
        assetNames: ["a.apk"],
        repo: "markrai/fitbaus-trainer",
        runner: runner2,
      }),
    /different content|Refusing to overwrite/,
  );
});

test("mocked gh: already-published release refuses missing or mutating assets", () => {
  const { dir, notes } = makeAssetBundle("fitbaus-pub-published-");
  const { runner } = createMockGh({
    initialRelease: {
      tagName: "v1.0.0",
      isDraft: false,
      assets: [{ name: "a.apk", content: Buffer.from("a.apk-bytes") }],
    },
  });
  assert.throws(
    () =>
      uploadGithubReleaseAssets({
        tag: "v1.0.0",
        title: "FitBaus Lite 1.0.0",
        notesFile: notes,
        artifactDir: dir,
        assetNames: ["a.apk", "b.apk"],
        repo: "markrai/fitbaus-trainer",
        runner,
      }),
    /already published|Refusing to mutate/,
  );
  const { state, runner: runnerView } = createMockGh({
    initialRelease: {
      tagName: "v1.0.0",
      isDraft: false,
      title: "Keep me",
      assets: [{ name: "a.apk", content: Buffer.from("a.apk-bytes") }],
    },
  });
  assert.throws(
    () =>
      uploadGithubReleaseAssets({
        tag: "v1.0.0",
        title: "FitBaus Lite 1.0.0",
        notesFile: notes,
        artifactDir: dir,
        assetNames: ["a.apk", "b.apk"],
        repo: "markrai/fitbaus-trainer",
        runner: runnerView,
      }),
    /already published/,
  );
  assert.equal(state.release.title, "Keep me");
  assert.ok(!state.calls.some((c) => c[1] === "edit"));
});

test("validateReleaseCandidate rejects wrong tag, edition, or mismatched hashes", () => {
  const dir = tempDir("fitbaus-cand-");
  const trainer = path.join(dir, "t.apk");
  const bridge = path.join(dir, "b.apk");
  const web = path.join(dir, "w.zip");
  fs.writeFileSync(trainer, "trainer");
  fs.writeFileSync(bridge, "bridge");
  fs.writeFileSync(web, "web");
  const out = path.join(dir, "public");
  preparePublicArtifacts({
    artifactDir: out,
    versionName: "1.0.0",
    versionCode: 10000,
    edition: "lite",
    sourceTag: "v1.0.0",
    sourceCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
    toolingRef: "tooling",
    trainerApkPath: trainer,
    bridgeApkPath: bridge,
    webZipPath: web,
    trainerCert: "A".repeat(64),
    bridgeCert: "B".repeat(64),
    bridgeQualified: false,
  });
  writeReleaseCandidate({
    artifactDir: out,
    versionName: "1.0.0",
    versionCode: 10000,
    edition: "lite",
    sourceTag: "v1.0.0",
    sourceCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
    toolingRef: "tooling",
    trainerCert: "A".repeat(64),
    bridgeCert: "B".repeat(64),
    workflowRunId: "99",
  });

  assert.throws(
    () =>
      validateReleaseCandidate({
        candidateDir: out,
        expectedTag: "v9.9.9",
        expectedCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
        expectedEdition: "lite",
        expectedWorkflowRunId: "99",
      }),
    /sourceTag/,
  );
  assert.throws(
    () =>
      validateReleaseCandidate({
        candidateDir: out,
        expectedTag: "v1.0.0",
        expectedCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
        expectedEdition: "full",
        expectedWorkflowRunId: "99",
      }),
    /edition/,
  );

  const names = publicArtifactNames("1.0.0", "lite");
  fs.writeFileSync(path.join(out, names.bridgeApk), "tampered-bridge");
  assert.throws(
    () =>
      validateReleaseCandidate({
        candidateDir: out,
        expectedTag: "v1.0.0",
        expectedCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
        expectedEdition: "lite",
        expectedWorkflowRunId: "99",
      }),
    /Hash mismatch/,
  );
});

test("releaseGhArgs places --repo after the release subcommand", () => {
  const args = releaseGhArgs(["release", "view", "v1.0.0", "--json", "tagName"], {
    repo: "markrai/fitbaus-trainer",
  });
  assert.deepEqual(args, [
    "release",
    "view",
    "v1.0.0",
    "--json",
    "tagName",
    "--repo",
    "markrai/fitbaus-trainer",
  ]);
  assert.throws(
    () => releaseGhArgs(["--repo", "x", "release", "view", "v1.0.0"], { repo: "x" }),
    /expects \["release"/,
  );
});

test("parseWorkflowRunPath accepts path@ref and bare paths", () => {
  assert.deepEqual(parseWorkflowRunPath(".github/workflows/release.yml@main"), {
    workflowFile: ".github/workflows/release.yml",
    ref: "main",
    raw: ".github/workflows/release.yml@main",
  });
  assert.deepEqual(parseWorkflowRunPath(".github/workflows/release.yml"), {
    workflowFile: ".github/workflows/release.yml",
    ref: null,
    raw: ".github/workflows/release.yml",
  });
});

test("assertCandidateRun accepts path@main and rejects bad path/ref/api argv", () => {
  const fixtures = {
    55: {
      run: {
        id: 55,
        conclusion: "success",
        status: "completed",
        event: "workflow_dispatch",
        head_branch: "main",
        path: ".github/workflows/release.yml@main",
        name: "Release",
        html_url: "https://example.test/55",
      },
      jobs: { jobs: [{ name: "inspect v1.0.0", conclusion: "success" }] },
    },
    56: {
      run: {
        id: 56,
        conclusion: "success",
        status: "completed",
        event: "workflow_dispatch",
        head_branch: "main",
        path: ".github/workflows/release.yml",
        name: "Release",
      },
      jobs: { jobs: [{ name: "publish v1.0.0", conclusion: "success" }] },
    },
    57: {
      run: {
        id: 57,
        conclusion: "success",
        status: "completed",
        event: "workflow_dispatch",
        head_branch: "main",
        path: ".github/workflows/release.yml@chore/release-pipeline",
        name: "Release",
      },
      jobs: { jobs: [{ name: "inspect v1.0.0", conclusion: "success" }] },
    },
    58: {
      run: {
        id: 58,
        conclusion: "success",
        status: "completed",
        event: "workflow_dispatch",
        head_branch: "main",
        path: ".github/workflows/ci.yml@main",
        name: "CI",
      },
      jobs: { jobs: [{ name: "inspect v1.0.0", conclusion: "success" }] },
    },
  };
  const seen = [];
  const runner = (args) => {
    seen.push([...args]);
    assert.equal(args[0], "api");
    assert.ok(!args.includes("--repo") && !args.includes("-R"), `gh api must not get --repo: ${args.join(" ")}`);
    assert.match(args[1], /^repos\/markrai\/fitbaus-trainer\/actions\/runs\/\d+/);
    const match = /^repos\/markrai\/fitbaus-trainer\/actions\/runs\/(\d+)(\/jobs)?$/.exec(args[1]);
    assert.ok(match, `unexpected endpoint ${args[1]}`);
    const id = match[1];
    const payload = match[2] ? fixtures[id].jobs : fixtures[id].run;
    return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
  };

  const ok = assertCandidateRun({
    repo: "markrai/fitbaus-trainer",
    runId: "55",
    defaultBranch: "main",
    runner,
  });
  assert.equal(ok.inspectJobName, "inspect v1.0.0");
  assert.equal(ok.workflowFile, ".github/workflows/release.yml");
  assert.equal(ok.workflowRef, "main");
  assert.deepEqual(seen[0], ["api", "repos/markrai/fitbaus-trainer/actions/runs/55"]);
  assert.deepEqual(seen[1], ["api", "repos/markrai/fitbaus-trainer/actions/runs/55/jobs"]);

  assert.throws(
    () =>
      assertCandidateRun({
        repo: "markrai/fitbaus-trainer",
        runId: "56",
        defaultBranch: "main",
        runner,
      }),
    /no inspect job/,
  );
  assert.throws(
    () =>
      assertCandidateRun({
        repo: "markrai/fitbaus-trainer",
        runId: "57",
        defaultBranch: "main",
        runner,
      }),
    /workflow path ref chore\/release-pipeline/,
  );
  assert.throws(
    () =>
      assertCandidateRun({
        repo: "markrai/fitbaus-trainer",
        runId: "58",
        defaultBranch: "main",
        runner,
      }),
    /workflow file \.github\/workflows\/ci\.yml/,
  );
});

test("mocked gh: records command-local --repo vectors", () => {
  const { dir, assets, notes } = makeAssetBundle("fitbaus-pub-argv-");
  const { state, runner } = createMockGh();
  uploadGithubReleaseAssets({
    tag: "v1.0.0",
    title: "FitBaus Lite 1.0.0",
    notesFile: notes,
    artifactDir: dir,
    assetNames: assets,
    repo: "markrai/fitbaus-trainer",
    runner,
  });
  assert.ok(state.calls.length > 0);
  for (const args of state.calls) {
    assertReleaseGhArgv(args);
  }
  assert.deepEqual(state.calls[0].slice(0, 3), ["release", "view", "v1.0.0"]);
  assert.deepEqual(state.calls[0].slice(-2), ["--repo", "markrai/fitbaus-trainer"]);
});

test("workflow trusts default branch and requires expected_commit", () => {
  const yml = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(yml, /environment:\s*release/);
  assert.match(yml, /DEFAULT_BRANCH:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
  assert.match(yml, /test "\$GITHUB_REF" = "refs\/heads\/\$\{DEFAULT_BRANCH\}"/);
  assert.match(yml, /persist-credentials:\s*false/);
  assert.match(yml, /GH_REPO:\s*\$\{\{\s*github\.repository\s*\}\}/);
  assert.match(yml, /expected_commit:/);
  assert.doesNotMatch(yml, /default:\s*"9847e9f/);
  assert.match(yml, /candidate_run_id/);
  assert.match(yml, /assert-candidate-run\.cjs/);
  assert.match(yml, /validate-release-candidate\.cjs/);
  assert.match(yml, /assert-tag-source-version\.cjs/);
  assert.match(yml, /sdkmanager "build-tools;35\.0\.0"/);
  assert.match(yml, /local\.properties/);
  assert.match(yml, /env:FITBAUS_APKSIGNER|env:\$\{|sign-apk\.cjs/);
  assert.match(yml, /--min-sdk 22/);
  assert.match(yml, /--require-v1/);
  assert.match(yml, /contents:\s*write/);
  assert.match(yml, /actions:\s*read/);
});

function writeVersionJs(dir, version) {
  const file = path.join(dir, "version.js");
  fs.writeFileSync(
    file,
    `const APP_VERSION = "${version}";\nif (typeof window !== 'undefined') {\n  window.APP_VERSION = APP_VERSION;\n}\n`,
    "utf8",
  );
  return file;
}

test("assertTagMatchesSourceVersion accepts matching tag and source versions", () => {
  const dir = tempDir("fitbaus-tagver-ok-");
  const versionJs = writeVersionJs(dir, "1.0.1");
  const matched = assertTagMatchesSourceVersion({ tag: "v1.0.1", versionJsPath: versionJs });
  assert.equal(matched.versionName, "1.0.1");
  assert.equal(matched.versionCode, 10001);
  assert.equal(matched.tag, "v1.0.1");

  const two = writeVersionJs(dir, "2.0.0");
  assert.equal(assertTagMatchesSourceVersion({ tag: "v2.0.0", versionJsPath: two }).versionName, "2.0.0");
  assert.equal(assertTagMatchesSourceVersion({ tag: "v1.0.0", versionJsPath: writeVersionJs(dir, "1.0.0") }).versionCode, 10000);
});

test("assertTagMatchesSourceVersion rejects mismatched, missing, or malformed source versions", () => {
  const dir = tempDir("fitbaus-tagver-bad-");
  const mismatched = writeVersionJs(dir, "1.0.0");
  assert.throws(
    () => assertTagMatchesSourceVersion({ tag: "v1.0.1", versionJsPath: mismatched }),
    /Release version mismatch: tag v1\.0\.1 requires 1\.0\.1, but source version\.js declares 1\.0\.0/,
  );
  assert.throws(
    () => assertTagMatchesSourceVersion({ tag: "v2.0.0", versionJsPath: writeVersionJs(dir, "1.0.1") }),
    /tag v2\.0\.0 requires 2\.0\.0, but source version\.js declares 1\.0\.1/,
  );
  assert.throws(
    () => assertTagMatchesSourceVersion({ tag: "v1.0.1", versionJsPath: path.join(dir, "missing-version.js") }),
    /version file is missing/,
  );
  fs.writeFileSync(path.join(dir, "broken.js"), "const APP_VERSION = \"not-a-semver\";\n", "utf8");
  assert.throws(
    () => assertTagMatchesSourceVersion({ tag: "v1.0.1", versionJsPath: path.join(dir, "broken.js") }),
    /major\.minor\.patch/,
  );
  fs.writeFileSync(path.join(dir, "empty.js"), "const OTHER = \"1.0.1\";\n", "utf8");
  assert.throws(
    () => assertTagMatchesSourceVersion({ tag: "v1.0.1", versionJsPath: path.join(dir, "empty.js") }),
    /Could not find APP_VERSION/,
  );
});

test("matching expected_commit cannot bypass tag/source version mismatch", () => {
  const fixture = (() => {
    const dir = tempDir("fitbaus-tagver-commit-");
    gitOk(dir, ["init", "-b", "main"]);
    gitOk(dir, ["config", "user.email", "release-test@example.com"]);
    gitOk(dir, ["config", "user.name", "Release Test"]);
    writeVersionJs(dir, "1.0.0");
    gitOk(dir, ["add", "version.js"]);
    gitOk(dir, ["commit", "-m", "source still at 1.0.0"]);
    const commit = gitOk(dir, ["rev-parse", "HEAD"]);
    gitOk(dir, ["tag", "-a", "v1.0.1", "-m", "wrong source version"]);
    return { dir, commit, tag: "v1.0.1" };
  })();

  const resolved = resolveSourceRef({
    repoDir: fixture.dir,
    tag: fixture.tag,
    expectedCommit: fixture.commit,
    fetch: false,
  });
  assert.equal(resolved.commit, fixture.commit);
  assert.throws(
    () =>
      assertTagMatchesSourceVersion({
        tag: fixture.tag,
        versionJsPath: path.join(fixture.dir, "version.js"),
      }),
    /Release version mismatch/,
  );
});

test("expectedVersionFromTag and version-code derivation remain stable", () => {
  assert.equal(expectedVersionFromTag("v1.0.1"), "1.0.1");
  assert.equal(expectedVersionFromTag("v2.12.35"), "2.12.35");
  assert.throws(() => expectedVersionFromTag("1.0.1"), /Cannot derive version from tag/);
  assert.equal(parseProductVersion("1.0.1", "fixture").versionCode, 10001);
  assert.equal(parseProductVersion("2.0.0", "fixture").versionCode, 20000);
});

test("validateReleaseCandidate rejects candidate versionName that disagrees with the tag", () => {
  const dir = tempDir("fitbaus-cand-ver-");
  const trainer = path.join(dir, "t.apk");
  const bridge = path.join(dir, "b.apk");
  const web = path.join(dir, "w.zip");
  fs.writeFileSync(trainer, "trainer");
  fs.writeFileSync(bridge, "bridge");
  fs.writeFileSync(web, "web");
  const out = path.join(dir, "public");
  preparePublicArtifacts({
    artifactDir: out,
    versionName: "1.0.0",
    versionCode: 10000,
    edition: "lite",
    sourceTag: "v1.0.1",
    sourceCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
    toolingRef: "tooling",
    trainerApkPath: trainer,
    bridgeApkPath: bridge,
    webZipPath: web,
    trainerCert: "A".repeat(64),
    bridgeCert: "B".repeat(64),
    bridgeQualified: false,
  });
  writeReleaseCandidate({
    artifactDir: out,
    versionName: "1.0.0",
    versionCode: 10000,
    edition: "lite",
    sourceTag: "v1.0.1",
    sourceCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
    toolingRef: "tooling",
    trainerCert: "A".repeat(64),
    bridgeCert: "B".repeat(64),
    workflowRunId: "77",
  });
  assert.throws(
    () =>
      validateReleaseCandidate({
        candidateDir: out,
        expectedTag: "v1.0.1",
        expectedCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
        expectedEdition: "lite",
        expectedWorkflowRunId: "77",
      }),
    /versionName 1\.0\.0 != 1\.0\.1/,
  );
});

test("release inspect runs tag/source version guard before builds and signing", () => {
  const yml = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  const guard = yml.indexOf("Require tag matches source version.js");
  const helper = yml.indexOf("assert-tag-source-version.cjs");
  const appTests = yml.indexOf("Install and test application source");
  const bridgeTests = yml.indexOf("Bike Bridge unit tests");
  const secrets = yml.indexOf("Require signing secrets");
  assert.ok(guard > 0, "missing inspect version-guard step");
  assert.ok(helper > guard, "helper must be invoked by the guard step");
  assert.ok(appTests > helper, "version guard must precede application builds");
  assert.ok(bridgeTests > helper, "version guard must precede Bridge builds");
  assert.ok(secrets > helper, "version guard must precede signing");
  assert.match(
    yml.slice(guard, helper + 80),
    /SOURCE_VERSION_JS:\s*\$\{\{\s*github\.workspace\s*\}\}\/source\/version\.js/,
  );
});

function parseCiTriggerPolicy(yml) {
  const onMatch = /^on:\r?\n([\s\S]*?)(?=^permissions:|^jobs:)/m.exec(yml);
  if (!onMatch) throw new Error("ci.yml is missing a top-level on: block");
  const block = onMatch[1];
  const hasPush = /^\s{2}push:\s*$/m.test(block);
  const hasPullRequest = /^\s{2}pull_request:\s*$/m.test(block);
  const branches = [];
  const branchBlock = /branches:\r?\n((?:\s{6}-\s+.+\r?\n)+)/.exec(block);
  if (branchBlock) {
    for (const line of branchBlock[1].split(/\r?\n/)) {
      const m = /^\s{6}-\s+(.+)$/.exec(line);
      if (m) branches.push(m[1].replace(/^["']|["']$/g, ""));
    }
  }
  const tags = [];
  const tagBlock = /tags:\r?\n((?:\s{6}-\s+.+\r?\n)+)/.exec(block);
  if (tagBlock) {
    for (const line of tagBlock[1].split(/\r?\n/)) {
      const m = /^\s{6}-\s+(.+)$/.exec(line);
      if (m) tags.push(m[1].replace(/^["']|["']$/g, ""));
    }
  }
  const unfilteredPush = /^\s{2}push:\s*$/m.test(block) && !/^\s{4}branches:/m.test(block);
  return {
    hasPush,
    hasPullRequest,
    branches,
    tags,
    unfilteredPush,
    includesFeatureBranchPush: unfilteredPush || branches.some((b) => b.includes("*") && !b.startsWith("v")),
  };
}

test("ci workflow triggers avoid duplicate feature-branch push and PR runs", () => {
  const yml = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const policy = parseCiTriggerPolicy(yml);
  assert.equal(policy.hasPush, true);
  assert.equal(policy.hasPullRequest, true);
  assert.equal(policy.unfilteredPush, false);
  assert.deepEqual([...policy.branches].sort(), ["lite/1.x", "main"]);
  assert.deepEqual(policy.tags, ["v*"]);
  assert.equal(policy.includesFeatureBranchPush, false);
  assert.doesNotMatch(yml, /^on:\r?\n {2}push:\r?\n {2}pull_request:\r?\n/m);
  assert.match(yml, /name:\s*Trainer/);
  assert.match(yml, /name:\s*Native Bike Bridge/);
  assert.match(yml, /npm run check:version/);
  assert.match(
    yml,
    /:equipment-protocol:test :bridge-app:testReleaseUnitTest :equipment-usb-probe:testDebugUnitTest :arcade:testDebugUnitTest/,
  );
  assert.match(yml, /node-version:\s*22/);
  assert.match(yml, /java-version:\s*21/);
  assert.match(yml, /permissions:\s*\r?\n\s*contents:\s*read/);
});

const {
  EDITIONS,
  PACKAGES,
  resolveEdition,
  resolveRelease,
  releaseAssetNames,
} = require("../scripts/release/edition.cjs");

const SIGNING_POLICY_PATH = path.join(root, ".github/release/signing-policy.json");
const SIGNING_POLICY = JSON.parse(fs.readFileSync(SIGNING_POLICY_PATH, "utf8"));
const TRAINER_PIN = SIGNING_POLICY.packages["com.markrai.fitbaus.trainer"].expectedCertSha256;
const BRIDGE_PIN = SIGNING_POLICY.packages["com.fitbaus.bikebridge"].expectedCertSha256;
const FULL_COMMIT = "a588c45783c55c0c102c4061fa7d8176d33eb314";
const LITE_COMMIT = "cf91c7d32fe54315cb5e1ec5488e8f477abe9a50";

const PUBLISHED_LITE_1_0_1_ARTIFACTS_MD = [
  "# FitBaus 1.0.1 (lite) distribution",
  "",
  "These are the public installer artifacts for tag `v1.0.1` (commit `cf91c7d32fe54315cb5e1ec5488e8f477abe9a50`).",
  "Release tooling revision: `8815635bc1032a64bbb1d98f476f032991760372`.",
  "",
  "Product version: **1.0.1** (versionCode **10001**)",
  "Edition: **FitBaus Lite 1.0.1** — compact edition for supported, storage-constrained",
  "ProForm Smart Power 10.0 consoles. Lite is maintained on `lite/1.x` without external UVC webcam support.",
  "",
  "| File | Package / contents | Notes |",
  "| --- | --- | --- |",
  "| `fitbaus-trainer-android-1.0.1.apk` | `com.markrai.fitbaus.trainer` | Release-signed Trainer Android APK |",
  "| `fitbaus-bikebridge-lite-1.0.1.apk` | `com.fitbaus.bikebridge` | Release-signed production Bike Bridge (Lite filename; same package ID) |",
  "| `fitbaus-trainer-web-1.0.1.zip` | static web/PWA | Host on HTTPS; not signed |",
  "| `SHA256SUMS.txt` | SHA-256 | Verify downloads |",
  "| `ARTIFACTS.md` | this file | |",
  "",
  "Trainer certificate SHA-256: `38A830D320081E59BBDA44CD52BFEF10D6CD7473E31281A27C0D010CF4FE8DAA`",
  "Bike Bridge certificate SHA-256: `5B2C6916536EBA269F9F47C925CC2B16A455CD80340A4F95C3E3CBBBFC42AF0C`",
  "",
  "**Candidate provenance** (inspect/build): signed binaries and hashes are recorded in",
  "`release-candidate.json`. That file identifies the exact Bridge APK (`apkSha256`) for",
  "console acceptance and later publication checks. Candidate provenance is not the same as",
  "publication qualification.",
  "",
  "**Physical qualification** is a separate publication gate recorded in",
  "`.github/release/physical-qualification.json`. `mode=publish` verifies that binding against",
  "this exact Bridge APK before undrafting the GitHub Release. A published Release means that",
  "gate passed for these binaries; an inspect candidate alone does not.",
  "",
  "End users should install only from a **published** GitHub Release. Users never handle signing keys.",
  "",
  "Unsigned APKs, staging package IDs (`com.fitbaus.bikebridge.native`), and debug-signed builds",
  "are engineering inspection outputs only — not the normal public installer selection.",
  "",
].join("\n");

function buildEditionCandidate({
  edition,
  versionName,
  sourceTag = `v${versionName}`,
  sourceCommit = edition === "full" ? FULL_COMMIT : LITE_COMMIT,
  workflowRunId = "5150",
  toolingRef = "tooling-sha",
}) {
  const dir = tempDir(`fitbaus-${edition}-cand-`);
  const trainer = path.join(dir, "trainer-signed.apk");
  const bridge = path.join(dir, "bridge-production-signed.apk");
  const web = path.join(dir, "web.zip");
  fs.writeFileSync(trainer, `trainer-${edition}-${versionName}`);
  fs.writeFileSync(bridge, `bridge-${edition}-${versionName}`);
  fs.writeFileSync(web, `web-${edition}-${versionName}`);
  const out = path.join(dir, "public");
  const versionCode = resolveRelease({ edition, versionName }).versionCode;
  const names = preparePublicArtifacts({
    artifactDir: out,
    versionName,
    versionCode,
    edition,
    sourceTag,
    sourceCommit,
    toolingRef,
    trainerApkPath: trainer,
    bridgeApkPath: bridge,
    webZipPath: web,
    trainerCert: TRAINER_PIN,
    bridgeCert: BRIDGE_PIN,
    bridgeQualified: false,
  });
  const candidate = writeReleaseCandidate({
    artifactDir: out,
    versionName,
    versionCode,
    edition,
    sourceTag,
    sourceCommit,
    toolingRef,
    trainerCert: TRAINER_PIN,
    bridgeCert: BRIDGE_PIN,
    workflowRunId,
  });
  const expectations = {
    candidateDir: out,
    expectedTag: sourceTag,
    expectedCommit: sourceCommit,
    expectedEdition: edition,
    expectedWorkflowRunId: workflowRunId,
  };
  return { out, names, candidate, expectations };
}

function rewriteSums(out, updates) {
  const sumsPath = path.join(out, "SHA256SUMS.txt");
  const lines = fs
    .readFileSync(sumsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, name] = line.split("  ");
      if (Object.prototype.hasOwnProperty.call(updates, name)) {
        const next = updates[name];
        return next == null ? null : `${next.hash}  ${next.name || name}`;
      }
      return `${hash}  ${name}`;
    })
    .filter(Boolean);
  fs.writeFileSync(sumsPath, `${lines.join("\n")}\n`);
}

function tamperCandidate(out, mutate) {
  const candidatePath = path.join(out, "release-candidate.json");
  const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  mutate(candidate);
  fs.writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  rewriteSums(out, { "release-candidate.json": { hash: sha256File(candidatePath) } });
}

function writeQualificationFixture(records) {
  const file = path.join(tempDir("fitbaus-qual-fixture-"), "physical-qualification.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, records }, null, 2));
  return file;
}

test("edition policy maps Lite to 1.x.x and Full to 2.x.x with shared identities", () => {
  const lite = resolveRelease({ edition: "lite", versionName: "1.0.1" });
  assert.equal(lite.title, "FitBaus Lite 1.0.1");
  assert.equal(lite.tag, "v1.0.1");
  assert.equal(lite.versionCode, 10001);
  assert.equal(lite.branch, "lite/1.x");
  const full = resolveRelease({ edition: "full", tag: "v2.1.0" });
  assert.equal(full.title, "FitBaus Full 2.1.0");
  assert.equal(full.versionName, "2.1.0");
  assert.equal(full.versionCode, 20100);
  assert.equal(full.tag, "v2.1.0");
  assert.equal(full.branch, "main");
  assert.equal(resolveRelease({ edition: "full", versionName: "2.12.35" }).versionCode, 21235);
  assert.deepEqual(Object.keys(EDITIONS).sort(), ["full", "lite"]);
  assert.equal(PACKAGES.trainer.applicationId, "com.markrai.fitbaus.trainer");
  assert.equal(PACKAGES.bridge.applicationId, "com.fitbaus.bikebridge");
  assert.equal(PACKAGES.bridge.minSdk, 22);
  assert.equal(resolveEdition("full").major, 2);
});

test("edition policy rejects unknown editions, cross-major versions, and tag mismatches", () => {
  for (const edition of ["", "Full", "LITE", "pro", " lite", undefined, null, "lite/1.x", "__proto__", "toString"]) {
    assert.throws(() => resolveRelease({ edition, versionName: "1.0.1" }), /Unsupported edition/, String(edition));
  }
  assert.throws(() => resolveRelease({ edition: "lite", versionName: "2.1.0" }), /FitBaus Lite requires major version 1/);
  assert.throws(() => resolveRelease({ edition: "full", versionName: "1.0.1" }), /FitBaus Full requires major version 2/);
  assert.throws(() => resolveRelease({ edition: "full", versionName: "3.0.0" }), /FitBaus Full requires major version 2/);
  assert.throws(() => resolveRelease({ edition: "lite", versionName: "0.10.14" }), /FitBaus Lite requires major version 1/);
  assert.throws(() => resolveRelease({ edition: "full", versionName: "2.1" }), /major\.minor\.patch/);
  assert.throws(() => resolveRelease({ edition: "full", versionName: "2.1.0-rc1" }), /major\.minor\.patch/);
  assert.throws(() => resolveRelease({ edition: "full", versionName: "2.1.0", tag: "v2.1.1" }), /requires version 2\.1\.1/);
  assert.throws(() => resolveRelease({ edition: "full", tag: "2.1.0" }), /Cannot derive version from tag/);
  assert.throws(() => resolveRelease({ edition: "full" }), /versionName or tag is required/);
});

test("public artifact names: Lite 1.0.1 unchanged and Full 2.1.0 canonical", () => {
  assert.deepEqual(publicArtifactNames("1.0.1", "lite"), {
    trainerApk: "fitbaus-trainer-android-1.0.1.apk",
    bridgeApk: "fitbaus-bikebridge-lite-1.0.1.apk",
    webZip: "fitbaus-trainer-web-1.0.1.zip",
    checksums: "SHA256SUMS.txt",
    manifest: "ARTIFACTS.md",
    candidate: "release-candidate.json",
  });
  const full = publicArtifactNames("2.1.0", "full");
  assert.deepEqual(full, {
    trainerApk: "fitbaus-trainer-android-2.1.0.apk",
    bridgeApk: "fitbaus-bikebridge-full-2.1.0.apk",
    webZip: "fitbaus-trainer-web-2.1.0.zip",
    checksums: "SHA256SUMS.txt",
    manifest: "ARTIFACTS.md",
    candidate: "release-candidate.json",
  });
  assert.deepEqual(releaseAssetNames(full), [
    "fitbaus-trainer-android-2.1.0.apk",
    "fitbaus-bikebridge-full-2.1.0.apk",
    "fitbaus-trainer-web-2.1.0.zip",
    "SHA256SUMS.txt",
    "ARTIFACTS.md",
    "release-candidate.json",
  ]);
  assert.throws(() => publicArtifactNames("2.1.0", "lite"), /FitBaus Lite requires major version 1/);
  assert.throws(() => publicArtifactNames("1.0.1", "full"), /FitBaus Full requires major version 2/);
  assert.throws(() => publicArtifactNames("2.1.0", "beta"), /Unsupported edition/);
});

test("edition CLI resolves the workflow's release title and assets and fails closed", () => {
  const cli = path.join(root, "scripts/release/edition.cjs");
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  const title = run(["--edition", "full", "--tag", "v2.1.0", "--field", "title"]);
  assert.equal(title.status, 0, title.stderr);
  assert.equal(title.stdout, "FitBaus Full 2.1.0\n");
  const assets = run(["--edition", "full", "--version-name", "2.1.0", "--tag", "v2.1.0", "--field", "assets"]);
  assert.equal(assets.status, 0, assets.stderr);
  assert.deepEqual(assets.stdout.trim().split("\n"), releaseAssetNames(publicArtifactNames("2.1.0", "full")));
  const liteTitle = run(["--edition", "lite", "--tag", "v1.0.1", "--field", "title"]);
  assert.equal(liteTitle.stdout, "FitBaus Lite 1.0.1\n");
  const liteBridge = run(["--edition", "lite", "--version-name", "1.0.1", "--field", "bridgeApk"]);
  assert.equal(liteBridge.stdout, "fitbaus-bikebridge-lite-1.0.1.apk\n");
  const plan = JSON.parse(run(["--edition", "full", "--tag", "v2.1.0"]).stdout);
  assert.equal(plan.versionCode, 20100);
  assert.equal(plan.artifacts.bridgeApk, "fitbaus-bikebridge-full-2.1.0.apk");
  for (const bad of [
    ["--edition", "lite", "--tag", "v2.1.0"],
    ["--edition", "full", "--tag", "v1.0.1"],
    ["--edition", "pro", "--tag", "v2.1.0"],
    ["--edition", "full", "--version-name", "2.1.0", "--tag", "v2.0.0"],
    ["--edition", "full", "--tag", "v2.1.0", "--field", "secrets"],
    ["--tag", "v2.1.0"],
  ]) {
    const result = run(bad);
    assert.notEqual(result.status, 0, bad.join(" "));
    assert.equal(result.stdout, "", bad.join(" "));
  }
});

test("Lite 1.0.1 ARTIFACTS.md is byte-identical to the published release notes", () => {
  const { out } = buildEditionCandidate({ edition: "lite", versionName: "1.0.1" });
  const dir = path.join(out, "regen");
  const { writeArtifactsMarkdown } = require("../scripts/release/prepare-public-artifacts.cjs");
  writeArtifactsMarkdown({
    artifactDir: dir,
    versionName: "1.0.1",
    versionCode: 10001,
    edition: "lite",
    sourceTag: "v1.0.1",
    sourceCommit: LITE_COMMIT,
    toolingRef: "8815635bc1032a64bbb1d98f476f032991760372",
    trainerCert: TRAINER_PIN,
    bridgeCert: BRIDGE_PIN,
    bridgeQualified: false,
  });
  assert.equal(fs.readFileSync(path.join(dir, "ARTIFACTS.md"), "utf8"), PUBLISHED_LITE_1_0_1_ARTIFACTS_MD);
});

test("Full 2.1.0 ARTIFACTS.md describes the Full edition without claiming qualification", () => {
  const { out, names } = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  const md = fs.readFileSync(path.join(out, names.manifest), "utf8");
  assert.match(md, /^# FitBaus 2\.1\.0 \(full\) distribution$/m);
  assert.match(md, /Product version: \*\*2\.1\.0\*\* \(versionCode \*\*20100\*\*\)/);
  assert.match(md, /Edition: \*\*FitBaus Full 2\.1\.0\*\* — ongoing feature edition/);
  assert.match(md, /external USB \(UVC\) webcam support/);
  assert.match(md, /native YouTube playback/);
  assert.match(md, /installs over a\nLite 1\.x installation without uninstalling or clearing Bike Bridge pairing/);
  assert.match(md, /\| `fitbaus-bikebridge-full-2\.1\.0\.apk` \| `com\.fitbaus\.bikebridge` \| Release-signed production Bike Bridge \(Full filename; same package ID\) \|/);
  assert.match(md, /\| `fitbaus-trainer-android-2\.1\.0\.apk` \| `com\.markrai\.fitbaus\.trainer` \|/);
  assert.match(md, new RegExp(`Bike Bridge certificate SHA-256: \`${BRIDGE_PIN}\``));
  assert.match(md, /Candidate provenance/);
  assert.match(md, /A published Release means that\s+gate passed for these binaries; an inspect candidate alone does not\./);
  assert.match(md, /End users should install only from a \*\*published\*\* GitHub Release/);
  assert.match(md, /staging package IDs \(`com\.fitbaus\.bikebridge\.native`\)/);
  assert.doesNotMatch(md, /FitBaus Lite|Lite filename|Lite is maintained|fitbaus-bikebridge-lite/);
  assert.doesNotMatch(md, /has been (physically )?qualified|already (been )?(qualified|published)|qualification (passed|complete)/i);
});

test("Full 2.1.0 candidate metadata is canonical and passes integrity validation", () => {
  const { out, names, candidate, expectations } = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  assert.equal(candidate.schemaVersion, 1);
  assert.equal(candidate.edition, "full");
  assert.equal(candidate.versionName, "2.1.0");
  assert.equal(candidate.versionCode, 20100);
  assert.equal(candidate.sourceTag, "v2.1.0");
  assert.equal(candidate.sourceCommit, FULL_COMMIT);
  assert.equal(candidate.workflowRunId, "5150");
  assert.equal(candidate.artifacts.trainerApk.name, "fitbaus-trainer-android-2.1.0.apk");
  assert.equal(candidate.artifacts.bridgeApk.name, "fitbaus-bikebridge-full-2.1.0.apk");
  assert.equal(candidate.artifacts.webZip.name, "fitbaus-trainer-web-2.1.0.zip");
  assert.equal(candidate.artifacts.bridgeApk.applicationId, "com.fitbaus.bikebridge");
  assert.equal(candidate.artifacts.bridgeApk.minSdk, 22);
  assert.equal(candidate.artifacts.bridgeApk.certSha256, BRIDGE_PIN);
  assert.equal(candidate.artifacts.trainerApk.applicationId, "com.markrai.fitbaus.trainer");
  assert.equal(candidate.artifacts.trainerApk.certSha256, TRAINER_PIN);
  assert.equal(candidate.artifacts.bridgeApk.sha256, sha256File(path.join(out, names.bridgeApk)));
  const sums = fs.readFileSync(path.join(out, "SHA256SUMS.txt"), "utf8").trim().split("\n").map((line) => line.split("  ")[1]);
  assert.deepEqual(sums, [names.trainerApk, names.bridgeApk, names.webZip, names.manifest, names.candidate]);
  assert.deepEqual(fs.readdirSync(out).sort(), releaseAssetNames(names).sort());
  const validated = validateReleaseCandidate(expectations);
  assert.equal(validated.edition, "full");
  assert.equal(validated.versionCode, 20100);
});

test("Lite 1.0.1 candidate keeps its names and still validates", () => {
  const { out, candidate, expectations } = buildEditionCandidate({ edition: "lite", versionName: "1.0.1" });
  assert.equal(candidate.artifacts.bridgeApk.name, "fitbaus-bikebridge-lite-1.0.1.apk");
  assert.equal(candidate.versionCode, 10001);
  assert.ok(fs.existsSync(path.join(out, "fitbaus-bikebridge-lite-1.0.1.apk")));
  assert.equal(validateReleaseCandidate(expectations).edition, "lite");
});

test("candidate writers refuse invalid edition, version, and version-code combinations", () => {
  const { out } = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  const base = {
    artifactDir: out,
    sourceTag: "v2.1.0",
    sourceCommit: FULL_COMMIT,
    toolingRef: "tooling-sha",
    trainerCert: TRAINER_PIN,
    bridgeCert: BRIDGE_PIN,
    workflowRunId: "5150",
  };
  assert.throws(() => writeReleaseCandidate({ ...base, edition: "lite", versionName: "2.1.0", versionCode: 20100 }), /FitBaus Lite requires major version 1/);
  assert.throws(() => writeReleaseCandidate({ ...base, edition: "full", versionName: "2.1.0", versionCode: 20000 }), /versionCode 20000 does not match 20100/);
  assert.throws(() => writeReleaseCandidate({ ...base, edition: "enterprise", versionName: "2.1.0", versionCode: 20100 }), /Unsupported edition/);
  const { writeArtifactsMarkdown } = require("../scripts/release/prepare-public-artifacts.cjs");
  assert.throws(
    () =>
      writeArtifactsMarkdown({
        artifactDir: path.join(out, "md"),
        versionName: "1.0.1",
        versionCode: 10001,
        edition: "full",
        sourceTag: "v1.0.1",
        sourceCommit: FULL_COMMIT,
        toolingRef: "t",
        trainerCert: TRAINER_PIN,
        bridgeCert: BRIDGE_PIN,
      }),
    /FitBaus Full requires major version 2/,
  );
});

test("Full candidate validation rejects identity mismatches before publication", () => {
  const { expectations } = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  assert.throws(() => validateReleaseCandidate({ ...expectations, expectedTag: "v2.1.1" }), /sourceTag/);
  assert.throws(() => validateReleaseCandidate({ ...expectations, expectedEdition: "lite" }), /edition full != lite/);
  assert.throws(() => validateReleaseCandidate({ ...expectations, expectedEdition: "pro" }), /Unsupported edition/);
  assert.throws(
    () => validateReleaseCandidate({ ...expectations, expectedCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126" }),
    /sourceCommit/,
  );
  assert.throws(() => validateReleaseCandidate({ ...expectations, expectedWorkflowRunId: "5151" }), /workflowRunId/);
  assert.throws(() => validateReleaseCandidate({ ...expectations, expectedVersionName: "2.0.0" }), /versionName 2\.1\.0 != 2\.0\.0/);
});

test("candidate validation rejects consistent-looking edition/version combinations that break the contract", () => {
  const liteClaimingTwo = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  tamperCandidate(liteClaimingTwo.out, (c) => {
    c.edition = "lite";
  });
  assert.throws(
    () => validateReleaseCandidate({ ...liteClaimingTwo.expectations, expectedEdition: "lite" }),
    /FitBaus Lite requires major version 1/,
  );

  const fullClaimingOne = buildEditionCandidate({ edition: "lite", versionName: "1.0.1" });
  tamperCandidate(fullClaimingOne.out, (c) => {
    c.edition = "full";
  });
  assert.throws(
    () => validateReleaseCandidate({ ...fullClaimingOne.expectations, expectedEdition: "full" }),
    /FitBaus Full requires major version 2/,
  );
});

test("candidate validation rejects artifact names that disagree with the edition and version", () => {
  const { out, names, expectations } = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  const liteName = "fitbaus-bikebridge-lite-2.1.0.apk";
  fs.renameSync(path.join(out, names.bridgeApk), path.join(out, liteName));
  rewriteSums(out, { [names.bridgeApk]: { hash: sha256File(path.join(out, liteName)), name: liteName } });
  tamperCandidate(out, (c) => {
    c.artifacts.bridgeApk.name = liteName;
  });
  assert.throws(() => validateReleaseCandidate(expectations), /artifacts\.bridgeApk\.name=fitbaus-bikebridge-lite-2\.1\.0\.apk != canonical fitbaus-bikebridge-full-2\.1\.0\.apk/);
});

test("candidate validation rejects tampered package identity, version code, and schema", () => {
  const cases = [
    [(c) => { c.artifacts.bridgeApk.applicationId = "com.fitbaus.bikebridge.native"; }, /applicationId com\.fitbaus\.bikebridge\.native != com\.fitbaus\.bikebridge/],
    [(c) => { c.artifacts.trainerApk.applicationId = "com.example.trainer"; }, /trainerApk\.applicationId/],
    [(c) => { c.artifacts.bridgeApk.minSdk = 24; }, /bridgeApk\.minSdk 24 != 22/],
    [(c) => { c.artifacts.bridgeApk.certSha256 = null; }, /bridgeApk\.certSha256 is missing/],
    [(c) => { c.artifacts.trainerApk.certSha256 = "not-a-cert"; }, /Certificate SHA-256 must be 64 hex/],
    [(c) => { c.versionCode = 20000; }, /versionCode 20000 != 20100/],
    [(c) => { c.versionCode = "20100"; }, /versionCode 20100 != 20100/],
    [(c) => { c.schemaVersion = 2; }, /schemaVersion: 2/],
    [(c) => { delete c.artifacts.webZip; }, /artifacts\.webZip\.name=undefined/],
  ];
  for (const [mutate, expected] of cases) {
    const { out, expectations } = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
    tamperCandidate(out, mutate);
    assert.throws(() => validateReleaseCandidate(expectations), expected);
  }
});

test("candidate validation rejects tampered binaries, manifests, and checksum lists", () => {
  const binary = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  fs.writeFileSync(path.join(binary.out, binary.names.bridgeApk), "swapped-bridge");
  assert.throws(() => validateReleaseCandidate(binary.expectations), /Hash mismatch for fitbaus-bikebridge-full-2\.1\.0\.apk: disk=/);

  const manifest = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  fs.appendFileSync(path.join(manifest.out, "ARTIFACTS.md"), "\nThis build is physically qualified.\n");
  assert.throws(() => validateReleaseCandidate(manifest.expectations), /Hash mismatch for ARTIFACTS\.md/);

  const extra = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  fs.appendFileSync(path.join(extra.out, "SHA256SUMS.txt"), `${"0".repeat(64)}  fitbaus-bikebridge-lite-2.1.0.apk\n`);
  assert.throws(() => validateReleaseCandidate(extra.expectations), /lists unexpected file fitbaus-bikebridge-lite-2\.1\.0\.apk/);

  const missing = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  rewriteSums(missing.out, { "ARTIFACTS.md": null });
  assert.throws(() => validateReleaseCandidate(missing.expectations), /missing entry for ARTIFACTS\.md/);

  const absent = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  fs.rmSync(path.join(absent.out, absent.names.webZip));
  assert.throws(() => validateReleaseCandidate(absent.expectations), /Missing distribution binary: fitbaus-trainer-web-2\.1\.0\.zip/);
});

test("a substituted Full Bridge APK with the same declared version cannot pass qualification", () => {
  const { out, names, candidate, expectations } = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  const qualifiedSha = candidate.artifacts.bridgeApk.sha256;
  const qualificationPath = writeQualificationFixture([
    {
      versionName: "2.1.0",
      applicationId: "com.fitbaus.bikebridge",
      status: "qualified",
      certSha256: BRIDGE_PIN,
      apkSha256: qualifiedSha,
      sourceCommit: FULL_COMMIT,
      evidenceRef: "fixture/full-2.1.0-evidence.md",
    },
  ]);
  const qualify = (apkSha256) =>
    assertBridgeQualified({
      qualificationPath,
      versionName: "2.1.0",
      certSha256: BRIDGE_PIN,
      apkSha256,
      sourceCommit: FULL_COMMIT,
    });
  assert.equal(qualify(qualifiedSha).evidenceRef, "fixture/full-2.1.0-evidence.md");

  const bridgePath = path.join(out, names.bridgeApk);
  fs.writeFileSync(bridgePath, "rebuilt-bridge-with-same-version");
  const substituted = sha256File(bridgePath);
  rewriteSums(out, { [names.bridgeApk]: { hash: substituted } });
  tamperCandidate(out, (c) => {
    c.artifacts.bridgeApk.sha256 = substituted;
  });
  const consistent = validateReleaseCandidate(expectations);
  assert.equal(consistent.artifacts.bridgeApk.sha256, substituted, "a self-consistent substitution passes integrity");
  assert.throws(() => qualify(substituted), /No physical qualification record for exact Bridge candidate/);
});

test("qualification fixtures: Lite cannot authorize Full; only an exactly qualified Full candidate passes", () => {
  const { candidate } = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  const fullBridge = candidate.artifacts.bridgeApk;
  const liteRecord = {
    versionName: "1.0.1",
    applicationId: "com.fitbaus.bikebridge",
    status: "qualified",
    certSha256: BRIDGE_PIN,
    apkSha256: "f9ec401394d11a27cda3cb88417769734263a4a551e1d9c9fab7fd469f600a61",
    sourceCommit: LITE_COMMIT,
    evidenceRef: "fixture/lite-v1.0.1.md",
  };
  const fullRecord = {
    versionName: "2.1.0",
    applicationId: "com.fitbaus.bikebridge",
    status: "qualified",
    certSha256: fullBridge.certSha256,
    apkSha256: fullBridge.sha256,
    sourceCommit: candidate.sourceCommit,
    evidenceRef: "fixture/full-v2.1.0.md",
  };
  const qualifyFull = (qualificationPath, overrides = {}) =>
    assertBridgeQualified({
      qualificationPath,
      versionName: candidate.versionName,
      applicationId: fullBridge.applicationId,
      certSha256: fullBridge.certSha256,
      apkSha256: fullBridge.sha256,
      sourceCommit: candidate.sourceCommit,
      ...overrides,
    });

  const liteOnly = writeQualificationFixture([liteRecord]);
  assert.equal(
    assertBridgeQualified({
      qualificationPath: liteOnly,
      versionName: "1.0.1",
      certSha256: liteRecord.certSha256,
      apkSha256: liteRecord.apkSha256,
      sourceCommit: liteRecord.sourceCommit,
    }).evidenceRef,
    "fixture/lite-v1.0.1.md",
  );
  assert.throws(() => qualifyFull(liteOnly), /No physical qualification record/, "an unqualified Full candidate is rejected");
  assert.throws(
    () =>
      qualifyFull(liteOnly, {
        apkSha256: liteRecord.apkSha256,
        sourceCommit: liteRecord.sourceCommit,
      }),
    /No physical qualification record/,
    "the Lite binary binding cannot authorize version 2.1.0",
  );
  const liteRelabelled = writeQualificationFixture([liteRecord, { ...liteRecord, versionName: "2.1.0" }]);
  assert.throws(() => qualifyFull(liteRelabelled), /No physical qualification record/, "a relabelled Lite record does not match the Full binary");

  for (const [label, mutate] of [
    ["pending status", (row) => ({ ...row, status: "pending" })],
    ["other APK", (row) => ({ ...row, apkSha256: "e".repeat(64) })],
    ["other commit", (row) => ({ ...row, sourceCommit: "9847e9f5dd828cf28f1a85320b2142ec4d3f5126" })],
    ["other certificate", (row) => ({ ...row, certSha256: "C".repeat(64) })],
    ["staging package", (row) => ({ ...row, applicationId: "com.fitbaus.bikebridge.native" })],
    ["other version", (row) => ({ ...row, versionName: "2.1.1" })],
  ]) {
    const file = writeQualificationFixture([liteRecord, mutate(fullRecord)]);
    assert.throws(() => qualifyFull(file), /No physical qualification record/, label);
  }
  const missingEvidence = writeQualificationFixture([liteRecord, { ...fullRecord, evidenceRef: "  " }]);
  assert.throws(() => qualifyFull(missingEvidence), /missing evidenceRef/);

  const qualified = writeQualificationFixture([liteRecord, fullRecord]);
  const row = qualifyFull(qualified);
  assert.equal(row.versionName, "2.1.0");
  assert.equal(row.evidenceRef, "fixture/full-v2.1.0.md");
  assert.equal(
    assertBridgeQualified({
      qualificationPath: qualified,
      versionName: "1.0.1",
      certSha256: liteRecord.certSha256,
      apkSha256: liteRecord.apkSha256,
      sourceCommit: liteRecord.sourceCommit,
    }).versionName,
    "1.0.1",
    "adding a Full record leaves the Lite binding intact",
  );
});

test("parseSha256Sums rejects duplicate file entries", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  assert.equal(parseSha256Sums(`${a}  one.apk\n${b}  two.apk\n`).get("two.apk"), b);
  assert.throws(() => parseSha256Sums(`${a}  one.apk\n${a}  one.apk\n`), /Duplicate SHA256SUMS entry for one\.apk/);
  assert.throws(() => parseSha256Sums(`${a}  one.apk\n${b}  two.apk\n${b}  one.apk\n`), /Duplicate SHA256SUMS entry for one\.apk/);
  assert.throws(() => parseSha256Sums(`${a}  one.apk\r\n${b}  one.apk\r\n`), /Duplicate SHA256SUMS entry/);
});

test("candidate validation rejects duplicate or conflicting SHA256SUMS entries", () => {
  const conflicting = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  const bridgeName = conflicting.names.bridgeApk;
  const sumsPath = path.join(conflicting.out, "SHA256SUMS.txt");
  const original = fs.readFileSync(sumsPath, "utf8");
  fs.writeFileSync(sumsPath, `${"f".repeat(64)}  ${bridgeName}\n${original}`);
  assert.throws(
    () => validateReleaseCandidate(conflicting.expectations),
    new RegExp(`Duplicate SHA256SUMS entry for ${bridgeName.replace(/\./g, "\\.")}`),
    "a conflicting earlier entry cannot be shadowed by the correct one",
  );
  fs.writeFileSync(sumsPath, `${original}${"f".repeat(64)}  ${bridgeName}\n`);
  assert.throws(() => validateReleaseCandidate(conflicting.expectations), /Duplicate SHA256SUMS entry/);

  const identical = buildEditionCandidate({ edition: "lite", versionName: "1.0.1" });
  const liteSums = path.join(identical.out, "SHA256SUMS.txt");
  const liteBridge = identical.names.bridgeApk;
  fs.appendFileSync(liteSums, `${sha256File(path.join(identical.out, liteBridge))}  ${liteBridge}\n`);
  assert.throws(() => validateReleaseCandidate(identical.expectations), /Duplicate SHA256SUMS entry for fitbaus-bikebridge-lite-1\.0\.1\.apk/);
});

test("Full candidate signing identities must match the existing pinned certificates", () => {
  const { candidate } = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  assert.equal(BRIDGE_PIN, "5B2C6916536EBA269F9F47C925CC2B16A455CD80340A4F95C3E3CBBBFC42AF0C");
  assert.equal(
    assertCertMatchesPolicy({
      policyPath: SIGNING_POLICY_PATH,
      applicationId: candidate.artifacts.bridgeApk.applicationId,
      actualCertSha256: candidate.artifacts.bridgeApk.certSha256,
    }).pinned,
    true,
  );
  assert.equal(
    assertCertMatchesPolicy({
      policyPath: SIGNING_POLICY_PATH,
      applicationId: candidate.artifacts.trainerApk.applicationId,
      actualCertSha256: candidate.artifacts.trainerApk.certSha256,
    }).pinned,
    true,
  );
  assert.throws(
    () =>
      assertCertMatchesPolicy({
        policyPath: SIGNING_POLICY_PATH,
        applicationId: "com.fitbaus.bikebridge",
        actualCertSha256: "C".repeat(64),
      }),
    /Wrong signing identity for com\.fitbaus\.bikebridge/,
  );
  assert.throws(
    () =>
      assertCertMatchesPolicy({
        policyPath: SIGNING_POLICY_PATH,
        applicationId: "com.fitbaus.bikebridge.full",
        actualCertSha256: BRIDGE_PIN,
      }),
    /com\.fitbaus\.bikebridge\.full/,
  );
});

test("tag/source guard enforces the edition contract on the source version", () => {
  const dir = tempDir("fitbaus-tagver-edition-");
  const two = writeVersionJs(dir, "2.1.0");
  const full = assertTagMatchesSourceVersion({ tag: "v2.1.0", versionJsPath: two, edition: "full" });
  assert.equal(full.title, "FitBaus Full 2.1.0");
  assert.equal(full.versionCode, 20100);
  assert.throws(() => assertTagMatchesSourceVersion({ tag: "v2.1.0", versionJsPath: two, edition: "lite" }), /FitBaus Lite requires major version 1/);
  const one = writeVersionJs(dir, "1.0.1");
  assert.equal(assertTagMatchesSourceVersion({ tag: "v1.0.1", versionJsPath: one, edition: "lite" }).title, "FitBaus Lite 1.0.1");
  assert.throws(() => assertTagMatchesSourceVersion({ tag: "v1.0.1", versionJsPath: one, edition: "full" }), /FitBaus Full requires major version 2/);
  assert.throws(() => assertTagMatchesSourceVersion({ tag: "v2.1.0", versionJsPath: one, edition: "full" }), /Release version mismatch/);
  assert.equal(assertTagMatchesSourceVersion({ tag: "v1.0.1", versionJsPath: one }).edition, null);
});

test("mocked gh: Full publication uses the edition title and canonical assets", () => {
  const { out, names } = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  const release = resolveRelease({ edition: "full", versionName: "2.1.0", tag: "v2.1.0" });
  const { state, runner } = createMockGh();
  const result = uploadGithubReleaseAssets({
    tag: "v2.1.0",
    title: release.title,
    notesFile: path.join(out, names.manifest),
    artifactDir: out,
    assetNames: releaseAssetNames(release.artifacts),
    repo: "markrai/fitbaus-trainer",
    runner,
  });
  assert.equal(result.published, true);
  assert.equal(state.release.title, "FitBaus Full 2.1.0");
  assert.equal(state.release.tagName, "v2.1.0");
  assert.deepEqual(
    state.release.assets.map((asset) => asset.name).sort(),
    releaseAssetNames(names).sort(),
  );
  for (const asset of state.release.assets) {
    assert.ok(fs.readFileSync(path.join(out, asset.name)).equals(asset.content), asset.name);
  }
  const createIdx = state.calls.findIndex((c) => c[1] === "create");
  assert.ok(state.calls[createIdx].includes("--draft"), "draft first");
  const publishIdx = state.calls.findIndex((c) => c.includes("--draft=false"));
  const lastDownloadIdx = state.calls.map((c) => c[1]).lastIndexOf("download");
  assert.ok(lastDownloadIdx < publishIdx, "remote hashes are verified before publication");
});

test("mocked gh: a published Full release refuses changed assets without editing it", () => {
  const { out, names } = buildEditionCandidate({ edition: "full", versionName: "2.1.0" });
  const assets = releaseAssetNames(names);
  const { state, runner } = createMockGh({
    initialRelease: {
      tagName: "v2.1.0",
      isDraft: false,
      title: "FitBaus Full 2.1.0",
      assets: assets.map((name) => ({
        name,
        content: name === names.bridgeApk ? Buffer.from("previously-published-bridge") : fs.readFileSync(path.join(out, name)),
      })),
    },
  });
  assert.throws(
    () =>
      uploadGithubReleaseAssets({
        tag: "v2.1.0",
        title: "FitBaus Full 2.1.0",
        notesFile: path.join(out, names.manifest),
        artifactDir: out,
        assetNames: assets,
        repo: "markrai/fitbaus-trainer",
        runner,
      }),
    /already has asset fitbaus-bikebridge-full-2\.1\.0\.apk with different content/,
  );
  assert.ok(!state.calls.some((c) => c[1] === "edit" || c[1] === "upload"), "no mutation of the published release");
  assert.equal(state.release.isDraft, false);
});

function workflowSteps(yml) {
  const body = yml.slice(yml.indexOf("    steps:\n"));
  return body
    .split(/\n      - /)
    .slice(1)
    .map((block) => {
      const name = /^(?:name:\s*(.+)|uses:\s*(.+))/.exec(block);
      return { name: name ? (name[1] || name[2]).trim() : "", block };
    });
}

test("release workflow offers Full, validates the edition early, and keeps trust gates", () => {
  const yml = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  const editionInput = yml.slice(yml.indexOf("      edition:"), yml.indexOf("      mode:"));
  assert.match(editionInput, /options:\n\s+- lite\n\s+- full\n/);
  assert.match(editionInput, /default: lite/);

  const steps = workflowSteps(yml);
  const index = (name) => {
    const i = steps.findIndex((step) => step.name === name);
    assert.ok(i >= 0, `missing step ${name}`);
    return i;
  };
  const editionStep = index("Validate edition against release tag");
  assert.match(steps[editionStep].block, /node scripts\/release\/edition\.cjs --edition "\$EDITION" --tag "\$RELEASE_TAG"/);
  assert.ok(editionStep < index("Resolve and verify source tag"), "edition check precedes source resolution");
  assert.ok(editionStep < index("Install and test application source"), "edition check precedes builds");
  assert.ok(editionStep < index("Require signing secrets (fail closed)"), "edition check precedes signing");
  assert.match(steps[index("Validate inputs")].block, /lite\|full\) ;;/);
  assert.match(steps[index("Require tag matches source version.js")].block, /--edition "\$EDITION"/);

  const publish = steps[index("Publish GitHub Release from exact candidate")].block;
  assert.doesNotMatch(publish, /FitBaus Lite|bikebridge-lite|fitbaus-trainer-android-\$version/);
  assert.match(publish, /edition\.cjs" --edition "\$EDITION" --version-name "\$version" --tag "\$RELEASE_TAG"/);
  assert.match(publish, /--field title/);
  assert.match(publish, /--field assets/);
  assert.match(publish, /test "\$title" = "\$EDITION_TITLE"/);
  assert.match(publish, /EDITION_TITLE: \$\{\{ steps\.edition\.outputs\.title \}\}/);
  assert.doesNotMatch(yml, /FitBaus Lite \$version|fitbaus-bikebridge-lite-\$version/);

  const assertRun = index("Assert candidate run is a trusted successful inspect");
  const download = index("Download exact release candidate");
  const validate = index("Validate candidate identity and binary integrity");
  const qualify = index("Verify candidate APKs, pins, and physical qualification");
  const publishIdx = index("Publish GitHub Release from exact candidate");
  assert.ok(assertRun < download && download < validate && validate < qualify && qualify < publishIdx);
  assert.match(steps[validate].block, /--edition "\$EDITION"/);
  assert.match(steps[qualify].block, /check-physical-qualification\.cjs/);
  assert.match(steps[qualify].block, /--require-v1 \\\n\s+--require-x86 \\\n\s+--forbid-non-x86/);
  for (const step of steps.filter((s) => /mode == 'publish'/.test(s.block))) {
    assert.doesNotMatch(step.block, /gradlew|sign-apk|SIGNING_STORE/, `publish step rebuilds or signs: ${step.name}`);
  }
  assert.doesNotMatch(yml, /debug\.keystore|signingConfigs\.debug|--allow-sidecar/);
  assert.match(yml, /environment: release/);
  assert.match(yml, /^permissions:\n  contents: read$/m);
});
