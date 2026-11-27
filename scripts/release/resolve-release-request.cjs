"use strict";

const { execFileSync } = require("node:child_process");
const { fail, normalizeCommitSha } = require("./common.cjs");
const { resolveRelease, versionFromTag } = require("./edition.cjs");

function releaseIdentity(tag) {
  const version = versionFromTag(tag);
  const major = version.split(".")[0];
  if (major !== "1" && major !== "2") fail("Unsupported release major version");
  return resolveRelease({ edition: major === "1" ? "lite" : "full", tag });
}

function resolveReleaseRequest({ tag, expectedCommit = "", repoDir = process.cwd() }) {
  const release = releaseIdentity(tag);
  const git = (...args) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
  const tagRef = "refs/tags/" + release.tag;
  const branchRef = "refs/remotes/origin/" + release.branch;
  git("fetch", "--no-tags", "origin", tagRef + ":" + tagRef);
  git("fetch", "--no-tags", "origin", "+refs/heads/" + release.branch + ":" + branchRef);
  const commit = normalizeCommitSha(git("rev-parse", "--verify", tagRef + "^{commit}"));
  if (expectedCommit && commit !== normalizeCommitSha(expectedCommit)) {
    fail("Release tag no longer resolves to the triggering CI commit");
  }
  try {
    git("merge-base", "--is-ancestor", commit, branchRef);
  } catch {
    fail("Release source must be an ancestor of " + release.branch);
  }
  return { tag: release.tag, edition: release.edition, title: release.title, commit };
}

if (require.main === module) {
  const [tag, expectedCommit] = process.argv.slice(2);
  const result = resolveReleaseRequest({ tag, expectedCommit });
  for (const [key, value] of Object.entries(result)) process.stdout.write(key + "=" + value + "\n");
}

module.exports = { releaseIdentity, resolveReleaseRequest };
