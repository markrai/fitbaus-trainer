"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { fail, sha256File } = require("./common.cjs");

/**
 * Build argv for `gh release ...` with command-local `--repo`.
 * Do not prepend `--repo` before the command — that is not a global gh flag
 * (and `gh api` rejects it entirely).
 */
function releaseGhArgs(baseArgs, { repo = null } = {}) {
  if (!Array.isArray(baseArgs) || baseArgs[0] !== "release") {
    fail(`releaseGhArgs expects ["release", ...], got: ${JSON.stringify(baseArgs)}`);
  }
  if (baseArgs.includes("--repo") || baseArgs.includes("-R")) {
    fail("pass repo via options.repo; do not embed --repo in baseArgs");
  }
  const args = [...baseArgs];
  if (repo) args.push("--repo", repo);
  return args;
}

function classifyGhFailure(stderr, stdout) {
  const text = `${stderr || ""}\n${stdout || ""}`.toLowerCase();
  if (
    text.includes("release not found") ||
    text.includes("could not find release") ||
    text.includes("http 404") ||
    /\b404\b/.test(text)
  ) {
    return "not_found";
  }
  if (
    text.includes("http 401") ||
    text.includes("http 403") ||
    text.includes("bad credentials") ||
    text.includes("resource not accessible") ||
    text.includes("permission")
  ) {
    return "auth";
  }
  if (text.includes("could not resolve host") || text.includes("network") || text.includes("timeout")) {
    return "network";
  }
  return "other";
}

function defaultGhRunner(args) {
  return spawnSync("gh", args, { encoding: "utf8" });
}

function makeGh(runner) {
  const run = runner || defaultGhRunner;
  function ghRaw(args, { repo = null } = {}) {
    return run(releaseGhArgs(args, { repo }));
  }
  function gh(args, options = {}) {
    const full = releaseGhArgs(args, options);
    const result = run(full);
    if (result.status !== 0) {
      fail(`gh ${full.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    return String(result.stdout || "").trim();
  }
  function ghJson(args, options = {}) {
    return JSON.parse(gh(args, options) || "null");
  }
  function viewRelease(tag, { repo = null } = {}) {
    const result = ghRaw(["release", "view", tag, "--json", "id,tagName,isDraft,assets,url"], { repo });
    if (result.status === 0) {
      return { ok: true, release: JSON.parse(result.stdout || "null") };
    }
    const kind = classifyGhFailure(result.stderr, result.stdout);
    if (kind === "not_found") return { ok: false, kind };
    fail(`gh release view failed (${kind}): ${result.stderr || result.stdout}`);
  }
  return { gh, ghJson, ghRaw, viewRelease };
}

/**
 * Draft-first publication with metadata reconciliation for existing drafts.
 */
function uploadGithubReleaseAssets({
  tag,
  title,
  notesFile,
  artifactDir,
  assetNames,
  repo,
  dryRun = false,
  publish = true,
  runner = null,
}) {
  if (!repo) fail("GitHub --repo (owner/name) is required; do not rely on cwd detection");
  if (!fs.existsSync(artifactDir)) fail(`Artifact dir missing: ${artifactDir}`);
  if (!fs.existsSync(notesFile)) fail(`Notes file missing: ${notesFile}`);
  for (const name of assetNames) {
    const full = path.join(artifactDir, name);
    if (!fs.existsSync(full)) fail(`Missing asset to upload: ${full}`);
  }

  if (dryRun) {
    return { dryRun: true, uploaded: [], skippedSameHash: [], tag, repo, published: false };
  }

  const { gh, ghJson, viewRelease } = makeGh(runner);

  let viewed = viewRelease(tag, { repo });
  let createdDraft = false;
  let updatedDraftMetadata = false;
  if (!viewed.ok) {
    gh(
      [
        "release",
        "create",
        tag,
        "--draft",
        "--title",
        title,
        "--notes-file",
        notesFile,
        "--verify-tag",
      ],
      { repo },
    );
    createdDraft = true;
    viewed = viewRelease(tag, { repo });
    if (!viewed.ok) fail(`Created draft for ${tag} but could not re-read it`);
  }

  let release = viewed.release;
  const wasPublished = release.isDraft === false;

  // Existing drafts (e.g. empty v1.0.0 draft with outdated unsigned notes) get corrected
  // title/notes before assets are attached. Never rewrite notes on an already-published release.
  if (!wasPublished) {
    gh(["release", "edit", tag, "--title", title, "--notes-file", notesFile], { repo });
    updatedDraftMetadata = true;
    viewed = viewRelease(tag, { repo });
    if (!viewed.ok) fail(`Updated draft ${tag} but could not re-read it`);
    release = viewed.release;
  }

  const existing = new Map((release.assets || []).map((asset) => [asset.name, asset]));
  const uploaded = [];
  const skippedSameHash = [];

  for (const name of assetNames) {
    const full = path.join(artifactDir, name);
    const localHash = sha256File(full);
    if (existing.has(name)) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fitbaus-release-asset-"));
      try {
        gh(["release", "download", tag, "--pattern", name, "--dir", tmpDir], { repo });
        const downloaded = path.join(tmpDir, name);
        if (!fs.existsSync(downloaded)) {
          fail(`Could not download existing release asset ${name} for comparison`);
        }
        const existingHash = sha256File(downloaded);
        if (existingHash === localHash) {
          skippedSameHash.push({ name, sha256: localHash });
          continue;
        }
        fail(
          `Release ${tag} already has asset ${name} with different content ` +
            `(existing=${existingHash}, local=${localHash}). Refusing to overwrite.`,
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } else if (wasPublished) {
      fail(
        `Release ${tag} is already published and missing asset ${name}. ` +
          `Refusing to mutate a public release; create a new tag/release instead.`,
      );
    } else {
      gh(["release", "upload", tag, full], { repo });
      uploaded.push({ name, sha256: localHash });
    }
  }

  const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), "fitbaus-release-verify-"));
  try {
    for (const name of assetNames) {
      gh(["release", "download", tag, "--pattern", name, "--dir", verifyDir, "--clobber"], { repo });
      const remotePath = path.join(verifyDir, name);
      if (!fs.existsSync(remotePath)) fail(`Remote release missing asset after upload: ${name}`);
      const remoteHash = sha256File(remotePath);
      const localHash = sha256File(path.join(artifactDir, name));
      if (remoteHash !== localHash) {
        fail(`Remote asset ${name} hash ${remoteHash} != local ${localHash}`);
      }
    }
  } finally {
    fs.rmSync(verifyDir, { recursive: true, force: true });
  }

  if (publish && !wasPublished) {
    gh(["release", "edit", tag, "--draft=false"], { repo });
  }

  const finalRelease = ghJson(["release", "view", tag, "--json", "assets,url,isDraft"], { repo });
  if (publish && finalRelease.isDraft) {
    fail(`Release ${tag} is still a draft after publish step`);
  }
  const finalNames = new Set((finalRelease.assets || []).map((asset) => asset.name));
  for (const name of assetNames) {
    if (!finalNames.has(name)) fail(`After upload, release ${tag} is missing asset ${name}`);
  }

  return {
    dryRun: false,
    url: finalRelease.url,
    uploaded,
    skippedSameHash,
    isDraft: finalRelease.isDraft,
    published: publish ? finalRelease.isDraft === false : false,
    createdDraft,
    updatedDraftMetadata,
    wasPublished,
    repo,
  };
}

function parseArgs(argv) {
  const options = {
    tag: null,
    title: null,
    notes: null,
    dir: null,
    assets: [],
    repo: process.env.GH_REPO || null,
    dryRun: false,
    publish: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") options.tag = argv[++i];
    else if (arg === "--title") options.title = argv[++i];
    else if (arg === "--notes") options.notes = argv[++i];
    else if (arg === "--dir") options.dir = argv[++i];
    else if (arg === "--asset") options.assets.push(argv[++i]);
    else if (arg === "--repo") options.repo = argv[++i];
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-publish") options.publish = false;
    else fail(`Unknown argument: ${arg}`);
  }
  if (!options.tag || !options.title || !options.notes || !options.dir || options.assets.length === 0) {
    fail(
      "Usage: upload-github-release-assets.cjs --repo owner/name --tag v1.0.0 --title ... --notes file --dir dir --asset name",
    );
  }
  if (!options.repo) fail("--repo or GH_REPO is required");
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const result = uploadGithubReleaseAssets({
    tag: options.tag,
    title: options.title,
    notesFile: options.notes,
    artifactDir: options.dir,
    assetNames: options.assets,
    repo: options.repo,
    dryRun: options.dryRun,
    publish: options.publish,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = {
  uploadGithubReleaseAssets,
  classifyGhFailure,
  releaseGhArgs,
  viewRelease: null,
  makeGh,
};
