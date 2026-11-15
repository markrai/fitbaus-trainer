"use strict";

const fs = require("fs");
const path = require("path");
const { fail, publicArtifactNames, sha256File, writeText } = require("./common.cjs");

function writeReleaseCandidate({
  artifactDir,
  versionName,
  versionCode,
  edition,
  sourceTag,
  sourceCommit,
  toolingRef,
  trainerCert,
  bridgeCert,
  workflowRunId = null,
}) {
  const names = publicArtifactNames(versionName, edition);
  const required = [names.trainerApk, names.bridgeApk, names.webZip, names.checksums, names.manifest];
  for (const name of required) {
    if (!fs.existsSync(path.join(artifactDir, name))) fail(`Missing public artifact: ${name}`);
  }

  const candidate = {
    schemaVersion: 1,
    edition,
    versionName,
    versionCode: Number(versionCode),
    sourceTag,
    sourceCommit,
    toolingRef,
    workflowRunId,
    createdAt: new Date().toISOString(),
    artifacts: {
      trainerApk: {
        name: names.trainerApk,
        sha256: sha256File(path.join(artifactDir, names.trainerApk)),
        applicationId: "com.markrai.fitbaus.trainer",
        certSha256: trainerCert,
        minSdk: 24,
      },
      bridgeApk: {
        name: names.bridgeApk,
        sha256: sha256File(path.join(artifactDir, names.bridgeApk)),
        applicationId: "com.fitbaus.bikebridge",
        certSha256: bridgeCert,
        minSdk: 22,
      },
      webZip: {
        name: names.webZip,
        sha256: sha256File(path.join(artifactDir, names.webZip)),
      },
    },
  };

  const candidatePath = path.join(artifactDir, names.candidate);
  writeText(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  const sumsPath = path.join(artifactDir, names.checksums);
  const line = `${sha256File(candidatePath)}  ${names.candidate}\n`;
  fs.appendFileSync(sumsPath, line, "utf8");
  return candidate;
}

function parseArgs(argv) {
  const options = {
    dir: null,
    versionName: null,
    versionCode: null,
    edition: "lite",
    sourceTag: null,
    sourceCommit: null,
    toolingRef: null,
    trainerCert: null,
    bridgeCert: null,
    workflowRunId: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") options.dir = argv[++i];
    else if (arg === "--version-name") options.versionName = argv[++i];
    else if (arg === "--version-code") options.versionCode = argv[++i];
    else if (arg === "--edition") options.edition = argv[++i];
    else if (arg === "--source-tag") options.sourceTag = argv[++i];
    else if (arg === "--source-commit") options.sourceCommit = argv[++i];
    else if (arg === "--tooling-ref") options.toolingRef = argv[++i];
    else if (arg === "--trainer-cert") options.trainerCert = argv[++i];
    else if (arg === "--bridge-cert") options.bridgeCert = argv[++i];
    else if (arg === "--workflow-run-id") options.workflowRunId = argv[++i];
    else fail(`Unknown argument: ${arg}`);
  }
  for (const key of [
    "dir",
    "versionName",
    "versionCode",
    "sourceTag",
    "sourceCommit",
    "toolingRef",
    "trainerCert",
    "bridgeCert",
  ]) {
    if (!options[key]) fail(`Missing required option for ${key}`);
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const candidate = writeReleaseCandidate({
    artifactDir: options.dir,
    versionName: options.versionName,
    versionCode: options.versionCode,
    edition: options.edition,
    sourceTag: options.sourceTag,
    sourceCommit: options.sourceCommit,
    toolingRef: options.toolingRef,
    trainerCert: options.trainerCert,
    bridgeCert: options.bridgeCert,
    workflowRunId: options.workflowRunId,
  });
  process.stdout.write(`${JSON.stringify(candidate, null, 2)}\n`);
}

module.exports = { writeReleaseCandidate };
