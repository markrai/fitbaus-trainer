"use strict";

const path = require("path");
const { fail, normalizeCertSha256, readJson } = require("./common.cjs");

function loadSigningPolicy(policyPath) {
  const policy = readJson(policyPath);
  if (policy.schemaVersion !== 1) fail(`Unsupported signing-policy schemaVersion: ${policy.schemaVersion}`);
  if (!policy.packages || typeof policy.packages !== "object") fail("signing-policy packages missing");
  return policy;
}

function policyEntry(policy, applicationId) {
  const entry = policy.packages[applicationId];
  if (!entry) fail(`No signing-policy entry for ${applicationId}`);
  return entry;
}

function requiredPin(policy, applicationId, { allowUnset = false } = {}) {
  const entry = policyEntry(policy, applicationId);
  const pin = normalizeCertSha256(entry.expectedCertSha256);
  if (!pin) {
    if (allowUnset) return null;
    fail(
      `signing-policy expectedCertSha256 is unset for ${applicationId}. ` +
        `Record the persistent certificate fingerprint before publish. ${entry.notes || ""}`,
    );
  }
  return pin;
}

function assertCertMatchesPolicy({
  policyPath,
  applicationId,
  actualCertSha256,
  allowUnset = false,
}) {
  const policy = loadSigningPolicy(policyPath);
  const expected = requiredPin(policy, applicationId, { allowUnset });
  const actual = normalizeCertSha256(actualCertSha256);
  if (!expected) {
    return { pinned: false, actual };
  }
  if (actual !== expected) {
    fail(`Wrong signing identity for ${applicationId}: actual ${actual} != pinned ${expected}`);
  }
  return { pinned: true, actual, expected };
}

function parseArgs(argv) {
  const options = {
    policy: path.resolve(__dirname, "../../.github/release/signing-policy.json"),
    applicationId: null,
    certSha256: null,
    allowUnset: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--policy") options.policy = path.resolve(argv[++i]);
    else if (arg === "--application-id") options.applicationId = argv[++i];
    else if (arg === "--cert-sha256") options.certSha256 = argv[++i];
    else if (arg === "--allow-unset") options.allowUnset = true;
    else fail(`Unknown argument: ${arg}`);
  }
  if (!options.applicationId || !options.certSha256) {
    fail("--application-id and --cert-sha256 are required");
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const result = assertCertMatchesPolicy(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { loadSigningPolicy, requiredPin, assertCertMatchesPolicy };
