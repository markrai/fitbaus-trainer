"use strict";

const { spawnSync } = require("child_process");
const { fail, normalizeCommitSha } = require("./common.cjs");

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || "").trim();
}

function assertTagName(tag) {
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    fail(`Tag must look like v1.2.3, got: ${tag}`);
  }
}

/**
 * Fetch a single tag into repoDir, then peel and verify expectedCommit.
 * expectedCommit is required — no hardcoded version defaults.
 */
function resolveSourceRef({
  repoDir,
  tag,
  expectedCommit,
  remote = "origin",
  fetch = true,
}) {
  assertTagName(tag);
  if (!expectedCommit) fail("--expect-commit is required");
  const want = normalizeCommitSha(expectedCommit);

  if (fetch) {
    // Explicit tag fetch so shallow Actions checkouts still resolve refs/tags/<tag>.
    const fetchResult = spawnSync(
      "git",
      ["fetch", "--no-tags", "--depth", "1", remote, `refs/tags/${tag}:refs/tags/${tag}`],
      { cwd: repoDir, encoding: "utf8" },
    );
    if (fetchResult.status !== 0) {
      // Retry with full tag object for annotated tags on some remotes.
      const retry = spawnSync("git", ["fetch", "--tags", "--depth", "1", remote, `tag`, tag], {
        cwd: repoDir,
        encoding: "utf8",
      });
      if (retry.status !== 0) {
        fail(
          `Failed to fetch tag ${tag} from ${remote}: ${fetchResult.stderr || retry.stderr || retry.stdout}`,
        );
      }
    }
  }

  const exists = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (exists.status !== 0) fail(`Tag not found after fetch: ${tag}`);

  const tagType = git(["cat-file", "-t", tag], repoDir);
  const commit = normalizeCommitSha(git(["rev-list", "-n", "1", tag], repoDir));
  if (commit !== want) {
    fail(`Tag ${tag} peels to ${commit}, expected ${want}`);
  }

  let annotatedTagObject = null;
  if (tagType === "tag") {
    annotatedTagObject = git(["rev-parse", tag], repoDir);
  }

  return { tag, commit, annotatedTagObject, tagType, remote };
}

function parseArgs(argv) {
  const options = {
    repoDir: process.cwd(),
    tag: null,
    expectedCommit: null,
    remote: "origin",
    fetch: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") options.repoDir = argv[++i];
    else if (arg === "--tag") options.tag = argv[++i];
    else if (arg === "--expect-commit") options.expectedCommit = argv[++i];
    else if (arg === "--remote") options.remote = argv[++i];
    else if (arg === "--no-fetch") options.fetch = false;
    else if (arg === "--json") options.json = true;
    else fail(`Unknown argument: ${arg}`);
  }
  if (!options.tag) fail("--tag is required");
  if (!options.expectedCommit) fail("--expect-commit is required");
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const resolved = resolveSourceRef(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  } else {
    process.stdout.write(`${resolved.commit}\n`);
  }
}

module.exports = { resolveSourceRef, assertTagName };
