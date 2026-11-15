"use strict";

const path = require("path");
const { fail, normalizeCertSha256, normalizeCommitSha, readJson } = require("./common.cjs");

function loadQualification(filePath) {
  const doc = readJson(filePath);
  if (doc.schemaVersion !== 1 && doc.schemaVersion !== 2) {
    fail(`Unsupported physical-qualification schemaVersion: ${doc.schemaVersion}`);
  }
  if (!Array.isArray(doc.records)) fail("physical-qualification records must be an array");
  return doc;
}

function normalizeApkSha(value) {
  const sha = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) fail(`apkSha256 must be 64 hex chars, got: ${value}`);
  return sha;
}

/**
 * Bind a public Bridge installer to the exact qualified binary + source commit + cert.
 * CI packaging never auto-qualifies a build.
 */
function assertBridgeQualified({
  qualificationPath,
  versionName,
  applicationId = "com.fitbaus.bikebridge",
  certSha256,
  apkSha256,
  sourceCommit,
}) {
  if (!certSha256) fail("certSha256 is required for physical qualification checks");
  if (!apkSha256) fail("apkSha256 is required for physical qualification checks");
  if (!sourceCommit) fail("sourceCommit is required for physical qualification checks");

  const doc = loadQualification(qualificationPath);
  const wantCert = normalizeCertSha256(certSha256);
  const wantApk = normalizeApkSha(apkSha256);
  const wantCommit = normalizeCommitSha(sourceCommit);

  const matches = doc.records.filter((row) => {
    if (!row || row.status !== "qualified") return false;
    if (row.versionName !== versionName) return false;
    if (row.applicationId !== applicationId) return false;
    if (normalizeCertSha256(row.certSha256) !== wantCert) return false;
    if (normalizeApkSha(row.apkSha256) !== wantApk) return false;
    if (normalizeCommitSha(row.sourceCommit) !== wantCommit) return false;
    return true;
  });

  if (matches.length === 0) {
    fail(
      `No physical qualification record for exact Bridge candidate ` +
        `(${applicationId} ${versionName} commit=${wantCommit} apk=${wantApk} cert=${wantCert}). ` +
        `Update .github/release/physical-qualification.json after console acceptance of that exact APK.`,
    );
  }

  const row = matches[0];
  if (!row.evidenceRef || String(row.evidenceRef).trim().length === 0) {
    fail(`Qualification record for ${versionName} is missing evidenceRef`);
  }
  return row;
}

function parseArgs(argv) {
  const options = {
    file: path.resolve(__dirname, "../../.github/release/physical-qualification.json"),
    versionName: null,
    applicationId: "com.fitbaus.bikebridge",
    certSha256: null,
    apkSha256: null,
    sourceCommit: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") options.file = path.resolve(argv[++i]);
    else if (arg === "--version-name") options.versionName = argv[++i];
    else if (arg === "--application-id") options.applicationId = argv[++i];
    else if (arg === "--cert-sha256") options.certSha256 = argv[++i];
    else if (arg === "--apk-sha256") options.apkSha256 = argv[++i];
    else if (arg === "--source-commit") options.sourceCommit = argv[++i];
    else fail(`Unknown argument: ${arg}`);
  }
  if (!options.versionName) fail("--version-name is required");
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const row = assertBridgeQualified({
    qualificationPath: options.file,
    versionName: options.versionName,
    applicationId: options.applicationId,
    certSha256: options.certSha256,
    apkSha256: options.apkSha256,
    sourceCommit: options.sourceCommit,
  });
  process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
}

module.exports = { loadQualification, assertBridgeQualified, normalizeApkSha };
