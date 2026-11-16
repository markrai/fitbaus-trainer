"use strict";

const path = require("path");
const { readAppVersion } = require("../fitbaus-version.cjs");
const { fail } = require("./common.cjs");
const { expectedVersionFromTag } = require("./validate-release-candidate.cjs");
const { resolveRelease } = require("./edition.cjs");

/**
 * Fail closed when an immutable release tag does not match source version.js.
 * Reads the application checkout's version.js, not tooling-tree metadata.
 */
function assertTagMatchesSourceVersion({ tag, versionJsPath, edition = null }) {
  if (!tag) fail("tag is required for tag/source version checks");
  if (!versionJsPath) fail("versionJsPath is required for tag/source version checks");

  const want = expectedVersionFromTag(tag);
  const source = readAppVersion(versionJsPath);
  if (source.name !== want) {
    fail(
      `Release version mismatch: tag ${tag} requires ${want}, but source version.js declares ${source.name}`,
    );
  }
  const release = edition == null ? null : resolveRelease({ edition, versionName: source.name, tag });
  return {
    tag,
    versionName: source.name,
    versionCode: source.versionCode,
    edition: release ? release.edition : null,
    title: release ? release.title : null,
  };
}

function parseArgs(argv) {
  const options = {
    tag: null,
    versionJs: null,
    edition: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") options.tag = argv[++i];
    else if (arg === "--version-js") options.versionJs = argv[++i];
    else if (arg === "--edition") options.edition = argv[++i];
    else fail(`Unknown argument: ${arg}`);
  }
  if (!options.tag || !options.versionJs) {
    fail("Usage: assert-tag-source-version.cjs --tag vX.Y.Z --version-js <path-to-version.js> [--edition lite|full]");
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const result = assertTagMatchesSourceVersion({
    tag: options.tag,
    versionJsPath: path.resolve(options.versionJs),
    edition: options.edition,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = { assertTagMatchesSourceVersion };
