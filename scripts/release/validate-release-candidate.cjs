"use strict";

const fs = require("fs");
const path = require("path");
const { fail, normalizeCommitSha, publicArtifactNames, readJson, sha256File } = require("./common.cjs");

function parseSha256Sums(text) {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) fail(`Invalid SHA256SUMS line: ${line}`);
    map.set(match[2], match[1]);
  }
  return map;
}

function expectedVersionFromTag(tag) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!match) fail(`Cannot derive version from tag: ${tag}`);
  return match[1];
}

/**
 * Validate release-candidate.json identity + on-disk binary hashes before any Release mutation.
 */
function validateReleaseCandidate({
  candidateDir,
  expectedTag,
  expectedCommit,
  expectedEdition,
  expectedWorkflowRunId,
  expectedVersionName = null,
}) {
  const candidatePath = path.join(candidateDir, "release-candidate.json");
  if (!fs.existsSync(candidatePath)) fail(`Missing release-candidate.json in ${candidateDir}`);
  const candidate = readJson(candidatePath);

  if (candidate.sourceTag !== expectedTag) {
    fail(`Candidate sourceTag ${candidate.sourceTag} != ${expectedTag}`);
  }
  if (normalizeCommitSha(candidate.sourceCommit) !== normalizeCommitSha(expectedCommit)) {
    fail(`Candidate sourceCommit ${candidate.sourceCommit} != ${expectedCommit}`);
  }
  if (candidate.edition !== expectedEdition) {
    fail(`Candidate edition ${candidate.edition} != ${expectedEdition}`);
  }
  if (String(candidate.workflowRunId) !== String(expectedWorkflowRunId)) {
    fail(`Candidate workflowRunId ${candidate.workflowRunId} != ${expectedWorkflowRunId}`);
  }

  const wantVersion = expectedVersionName || expectedVersionFromTag(expectedTag);
  if (candidate.versionName !== wantVersion) {
    fail(`Candidate versionName ${candidate.versionName} != ${wantVersion}`);
  }

  const names = publicArtifactNames(candidate.versionName, candidate.edition);
  const sumsPath = path.join(candidateDir, names.checksums);
  if (!fs.existsSync(sumsPath)) fail(`Missing ${names.checksums}`);
  const sums = parseSha256Sums(fs.readFileSync(sumsPath, "utf8"));

  const binaries = [
    ["trainerApk", names.trainerApk],
    ["bridgeApk", names.bridgeApk],
    ["webZip", names.webZip],
  ];
  for (const [key, fileName] of binaries) {
    const full = path.join(candidateDir, fileName);
    if (!fs.existsSync(full)) fail(`Missing distribution binary: ${fileName}`);
    const actual = sha256File(full);
    const declared = candidate.artifacts?.[key]?.sha256;
    if (!declared) fail(`Candidate missing artifacts.${key}.sha256`);
    if (actual !== declared) {
      fail(`Hash mismatch for ${fileName}: disk=${actual} candidate=${declared}`);
    }
    const summed = sums.get(fileName);
    if (!summed) fail(`${names.checksums} missing entry for ${fileName}`);
    if (summed !== actual) {
      fail(`Hash mismatch for ${fileName}: disk=${actual} SHA256SUMS=${summed}`);
    }
  }

  const candidateSum = sums.get(names.candidate);
  if (!candidateSum) fail(`${names.checksums} missing entry for ${names.candidate}`);
  const candidateActual = sha256File(candidatePath);
  if (candidateSum !== candidateActual) {
    fail(`Hash mismatch for ${names.candidate}: disk=${candidateActual} SHA256SUMS=${candidateSum}`);
  }

  return candidate;
}

function parseArgs(argv) {
  const options = {
    dir: null,
    tag: null,
    commit: null,
    edition: null,
    runId: null,
    versionName: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") options.dir = argv[++i];
    else if (arg === "--tag") options.tag = argv[++i];
    else if (arg === "--commit") options.commit = argv[++i];
    else if (arg === "--edition") options.edition = argv[++i];
    else if (arg === "--workflow-run-id") options.runId = argv[++i];
    else if (arg === "--version-name") options.versionName = argv[++i];
    else fail(`Unknown argument: ${arg}`);
  }
  if (!options.dir || !options.tag || !options.commit || !options.edition || !options.runId) {
    fail("Usage: validate-release-candidate.cjs --dir ... --tag ... --commit ... --edition ... --workflow-run-id ...");
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const candidate = validateReleaseCandidate({
    candidateDir: options.dir,
    expectedTag: options.tag,
    expectedCommit: options.commit,
    expectedEdition: options.edition,
    expectedWorkflowRunId: options.runId,
    expectedVersionName: options.versionName,
  });
  process.stdout.write(`${JSON.stringify(candidate, null, 2)}\n`);
}

module.exports = { validateReleaseCandidate, parseSha256Sums, expectedVersionFromTag };
