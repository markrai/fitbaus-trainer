"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) fail(`Missing JSON file: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function redactArg(arg) {
  const text = String(arg);
  if (/^pass:/i.test(text)) return "pass:<redacted>";
  if (/password/i.test(text) && text.includes("=")) {
    return text.replace(/=.*/, "=<redacted>");
  }
  return text;
}

function run(command, args, options = {}) {
  const { redact = [], env, ...rest } = options;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    ...rest,
  });
  if (result.status !== 0) {
    const safeArgs = args.map((arg) => (redact.includes(arg) ? "<redacted>" : redactArg(arg)));
    const stderr = String(result.stderr || "");
    const stdout = String(result.stdout || "");
    // Never echo env-derived secrets; keep tool diagnostics short.
    fail(
      `${command} ${safeArgs.join(" ")} failed` +
        (stderr ? `\n${stderr.slice(0, 2000)}` : "") +
        (stdout ? `\n${stdout.slice(0, 2000)}` : ""),
    );
  }
  return result;
}

function which(command) {
  const probe = process.platform === "win32" ? ["where.exe", command] : ["which", command];
  const result = spawnSync(probe[0], probe.slice(1), { encoding: "utf8" });
  if (result.status !== 0) return null;
  return String(result.stdout || "")
    .trim()
    .split(/\r?\n/)[0];
}

function normalizeCertSha256(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (cleaned.length === 0) return null;
  if (cleaned.length !== 64) fail(`Certificate SHA-256 must be 64 hex chars, got ${cleaned.length}`);
  return cleaned;
}

function normalizeCommitSha(value) {
  const sha = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`Commit SHA must be 40 hex chars, got: ${value}`);
  return sha;
}

function publicArtifactNames(versionName, edition) {
  if (edition !== "lite") fail(`Unsupported edition: ${edition}`);
  return {
    trainerApk: `fitbaus-trainer-android-${versionName}.apk`,
    bridgeApk: `fitbaus-bikebridge-lite-${versionName}.apk`,
    webZip: `fitbaus-trainer-web-${versionName}.zip`,
    checksums: "SHA256SUMS.txt",
    manifest: "ARTIFACTS.md",
    candidate: "release-candidate.json",
  };
}

module.exports = {
  fail,
  readJson,
  writeText,
  sha256File,
  run,
  which,
  normalizeCertSha256,
  normalizeCommitSha,
  publicArtifactNames,
  redactArg,
};
