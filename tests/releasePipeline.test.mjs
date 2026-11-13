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
const { verifyApk } = require("../scripts/release/verify-apk.cjs");
const { signApk } = require("../scripts/release/sign-apk.cjs");
const { publicArtifactNames, redactArg, sha256File } = require("../scripts/release/common.cjs");
const {
  classifyGhFailure,
  uploadGithubReleaseAssets,
  releaseGhArgs,
} = require("../scripts/release/upload-github-release-assets.cjs");
const { writeReleaseCandidate } = require("../scripts/release/write-release-candidate.cjs");
const { validateReleaseCandidate } = require("../scripts/release/validate-release-candidate.cjs");
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

test("verifyApk sidecar fallback is opt-in only", () => {
  const dir = tempDir("fitbaus-apk-meta-");
  const apk = path.join(dir, "app.apk");
  fs.writeFileSync(apk, "PK\u0005\u0006" + "0".repeat(64));
  fs.writeFileSync(
    `${apk}.meta.json`,
    JSON.stringify({
      applicationId: "com.example.wrong",
      versionName: "1.0.0",
      versionCode: 10000,
      minSdk: 22,
    }),
  );
  fs.writeFileSync(
    `${apk}.cert.json`,
    JSON.stringify({ signed: true, v1: true, v2: true, certSha256: "D".repeat(64) }),
  );
  assert.throws(
    () =>
      verifyApk({
        apkPath: apk,
        expectedApplicationId: "com.fitbaus.bikebridge",
        expectedVersionName: "1.0.0",
        expectedMinSdk: 22,
      }),
    /apksigner unavailable|aapt\/aapt2 unavailable/,
  );
  assert.throws(
    () =>
      verifyApk({
        apkPath: apk,
        expectedApplicationId: "com.fitbaus.bikebridge",
        expectedVersionName: "1.0.0",
        expectedMinSdk: 22,
        allowSidecarFallback: true,
      }),
    /applicationId/,
  );
});

test("verifyApk rejects unsigned sidecar when explicitly allowed", () => {
  const dir = tempDir("fitbaus-apk-unsigned-");
  const apk = path.join(dir, "app.apk");
  fs.writeFileSync(apk, "unsigned");
  fs.writeFileSync(
    `${apk}.meta.json`,
    JSON.stringify({
      applicationId: "com.markrai.fitbaus.trainer",
      versionName: "1.0.0",
      versionCode: 10000,
      minSdk: 24,
    }),
  );
  fs.writeFileSync(`${apk}.cert.json`, JSON.stringify({ signed: false, certSha256: null }));
  assert.throws(
    () =>
      verifyApk({
        apkPath: apk,
        expectedApplicationId: "com.markrai.fitbaus.trainer",
        expectedVersionName: "1.0.0",
        allowSidecarFallback: true,
      }),
    /unsigned/,
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
  assert.match(yml, /sdkmanager "build-tools;35\.0\.0"/);
  assert.match(yml, /local\.properties/);
  assert.match(yml, /env:FITBAUS_APKSIGNER|env:\$\{|sign-apk\.cjs/);
  assert.match(yml, /--min-sdk 22/);
  assert.match(yml, /--require-v1/);
  assert.match(yml, /contents:\s*write/);
  assert.match(yml, /actions:\s*read/);
});
