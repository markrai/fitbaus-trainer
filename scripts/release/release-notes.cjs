"use strict";

const fs = require("node:fs");
const { parseProductVersion } = require("../fitbaus-version.cjs");

function releaseNotes(version, changelog, manifest) {
  parseProductVersion(version, "release notes");
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const heading = /^## \[([^\]]+)\](?:\s+.*)?$/;
  const matches = lines.map((line, index) => heading.exec(line)?.[1] === version ? index : -1)
    .filter((index) => index >= 0);
  if (matches.length !== 1) throw new Error("Expected one changelog section for " + version);
  const start = matches[0] + 1;
  const next = lines.findIndex((line, index) => index >= start && /^##\s/.test(line));
  const notes = lines.slice(start, next < 0 ? undefined : next).join("\n").trim();
  if (!notes) throw new Error("Empty changelog section for " + version);
  return notes + "\n\n---\n\n" + manifest.trim() + "\n";
}

if (require.main === module) {
  const [version, changelogPath, manifestPath] = process.argv.slice(2);
  process.stdout.write(releaseNotes(version, fs.readFileSync(changelogPath, "utf8"), fs.readFileSync(manifestPath, "utf8")));
}

module.exports = { releaseNotes };
