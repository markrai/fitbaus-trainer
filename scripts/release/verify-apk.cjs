"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { fail, normalizeCertSha256, run, which } = require("./common.cjs");

function findTool(name, envName) {
  if (process.env[envName]) return process.env[envName];
  const fromPath = which(name);
  if (fromPath) return fromPath;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) return null;
  const buildTools = path.join(sdk, "build-tools");
  if (!fs.existsSync(buildTools)) return null;
  const versions = fs.readdirSync(buildTools).sort().reverse();
  for (const version of versions) {
    const candidate = path.join(
      buildTools,
      version,
      process.platform === "win32" ? `${name}.bat` : name,
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function allowSidecar(explicit) {
  if (explicit === true) return true;
  if (explicit === false) return false;
  return process.env.FITBAUS_RELEASE_ALLOW_SIDECAR === "1";
}

function unzipList(apkPath) {
  const result = spawnSync("unzip", ["-l", apkPath], { encoding: "utf8" });
  if (result.status !== 0) {
    const tar = spawnSync("tar", ["-tf", apkPath], { encoding: "utf8" });
    if (tar.status !== 0) fail(`Could not list APK contents: ${apkPath}`);
    return String(tar.stdout || "");
  }
  return String(result.stdout || "");
}

function parseBadging(text) {
  const appId = /package: name='([^']+)'/.exec(text);
  const versionName = /versionName='([^']+)'/.exec(text);
  const versionCode = /versionCode='([^']+)'/.exec(text);
  const minSdk = /sdkVersion:'([^']+)'/.exec(text) || /minSdkVersion:'([^']+)'/.exec(text);
  if (!appId || !versionName || !versionCode) {
    fail(`Could not parse aapt badging output`);
  }
  return {
    applicationId: appId[1],
    versionName: versionName[1],
    versionCode: Number(versionCode[1]),
    minSdk: minSdk ? Number(minSdk[1]) : null,
  };
}

function readMetadata(apkPath, { allowSidecarFallback = false } = {}) {
  const aapt = findTool("aapt", "AAPT") || findTool("aapt2", "AAPT2");
  if (aapt) {
    const result = spawnSync(aapt, ["dump", "badging", apkPath], { encoding: "utf8" });
    if (result.status === 0) return parseBadging(String(result.stdout || ""));
  }
  if (allowSidecar(allowSidecarFallback)) {
    const sidecar = `${apkPath}.meta.json`;
    if (fs.existsSync(sidecar)) {
      return JSON.parse(fs.readFileSync(sidecar, "utf8"));
    }
  }
  fail(`aapt/aapt2 unavailable for production verification of ${apkPath}`);
}

function parseVerifyText(text) {
  const v1 = /Verified using v1 scheme \(JAR signing\):\s*(true|false)/i.exec(text);
  const v2 = /Verified using v2 scheme \(APK Signature Scheme v2\):\s*(true|false)/i.exec(text);
  const cert =
    /Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F:]+)/.exec(text) ||
    /SHA-256 digest:\s*([0-9a-fA-F:]+)/.exec(text);
  return {
    v1: v1 ? v1[1].toLowerCase() === "true" : false,
    v2: v2 ? v2[1].toLowerCase() === "true" : false,
    certSha256: cert ? normalizeCertSha256(cert[1]) : null,
    raw: text,
  };
}

function assertSigned(apkPath, { minSdkVersion = null, allowSidecarFallback = false, requireV1 = false } = {}) {
  const apksigner = findTool("apksigner", "APKSIGNER");
  if (!apksigner) {
    if (allowSidecar(allowSidecarFallback)) {
      const sidecar = `${apkPath}.cert.json`;
      if (fs.existsSync(sidecar)) {
        const parsed = JSON.parse(fs.readFileSync(sidecar, "utf8"));
        if (parsed.signed === false) fail(`APK is unsigned: ${apkPath}`);
        if (requireV1 && parsed.v1 !== true) fail(`APK missing v1 signature (sidecar): ${apkPath}`);
        return {
          v1: parsed.v1 === true,
          v2: parsed.v2 === true,
          certSha256: normalizeCertSha256(parsed.certSha256),
        };
      }
    }
    fail(`apksigner unavailable; cannot verify signature for ${apkPath}`);
  }
  const args = ["verify", "--verbose", "--print-certs"];
  if (minSdkVersion != null) args.push("--min-sdk-version", String(minSdkVersion));
  args.push(apkPath);
  const result = run(apksigner, args);
  const parsed = parseVerifyText(`${result.stdout || ""}\n${result.stderr || ""}`);
  if (requireV1 && !parsed.v1) {
    fail(`APK lacks verified APK Signature Scheme v1 (needed for minSdk ${minSdkVersion}): ${apkPath}`);
  }
  if (!parsed.certSha256) fail(`Could not parse certificate SHA-256 from apksigner for ${apkPath}`);
  return parsed;
}

function verifyApk({
  apkPath,
  expectedApplicationId,
  expectedVersionName,
  expectedVersionCode = null,
  expectedMinSdk = null,
  expectedCertSha256 = null,
  requireX86Only = false,
  forbidNonX86 = false,
  requireV1 = false,
  allowSidecarFallback = false,
}) {
  if (!fs.existsSync(apkPath)) fail(`APK missing: ${apkPath}`);
  const signature = assertSigned(apkPath, {
    minSdkVersion: expectedMinSdk,
    allowSidecarFallback,
    requireV1: requireV1 || expectedMinSdk === 22,
  });
  const meta = readMetadata(apkPath, { allowSidecarFallback });
  if (meta.applicationId !== expectedApplicationId) {
    fail(`applicationId ${meta.applicationId} != ${expectedApplicationId}`);
  }
  if (meta.versionName !== expectedVersionName) {
    fail(`versionName ${meta.versionName} != ${expectedVersionName}`);
  }
  if (expectedVersionCode != null && meta.versionCode !== Number(expectedVersionCode)) {
    fail(`versionCode ${meta.versionCode} != ${expectedVersionCode}`);
  }
  if (expectedMinSdk != null && meta.minSdk !== Number(expectedMinSdk)) {
    fail(`minSdk ${meta.minSdk} != ${expectedMinSdk}`);
  }

  const listing = unzipList(apkPath);
  if (requireX86Only) {
    if (!/lib\/x86\//.test(listing)) fail(`APK missing lib/x86 native libraries: ${apkPath}`);
  }
  if (forbidNonX86) {
    if (/lib\/(armeabi|armeabi-v7a|arm64-v8a|x86_64)\//.test(listing)) {
      fail(`APK contains non-x86 native libraries: ${apkPath}`);
    }
  }

  const certSha256 = signature.certSha256;
  const expected = normalizeCertSha256(expectedCertSha256);
  if (expected && certSha256 !== expected) {
    fail(`Certificate SHA-256 ${certSha256} != pinned ${expected}`);
  }

  return { ...meta, certSha256, v1: signature.v1, v2: signature.v2 };
}

function parseArgs(argv) {
  const options = {
    apk: null,
    applicationId: null,
    versionName: null,
    versionCode: null,
    minSdk: null,
    certSha256: null,
    requireX86Only: false,
    forbidNonX86: false,
    requireV1: false,
    allowSidecarFallback: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apk") options.apk = argv[++i];
    else if (arg === "--application-id") options.applicationId = argv[++i];
    else if (arg === "--version-name") options.versionName = argv[++i];
    else if (arg === "--version-code") options.versionCode = argv[++i];
    else if (arg === "--min-sdk") options.minSdk = argv[++i];
    else if (arg === "--cert-sha256") options.certSha256 = argv[++i];
    else if (arg === "--require-x86") options.requireX86Only = true;
    else if (arg === "--forbid-non-x86") options.forbidNonX86 = true;
    else if (arg === "--require-v1") options.requireV1 = true;
    else if (arg === "--allow-sidecar") options.allowSidecarFallback = true;
    else fail(`Unknown argument: ${arg}`);
  }
  if (!options.apk || !options.applicationId || !options.versionName) {
    fail("--apk --application-id --version-name are required");
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const result = verifyApk({
    apkPath: options.apk,
    expectedApplicationId: options.applicationId,
    expectedVersionName: options.versionName,
    expectedVersionCode: options.versionCode,
    expectedMinSdk: options.minSdk,
    expectedCertSha256: options.certSha256,
    requireX86Only: options.requireX86Only,
    forbidNonX86: options.forbidNonX86,
    requireV1: options.requireV1,
    allowSidecarFallback: options.allowSidecarFallback,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = { verifyApk, readMetadata, assertSigned, parseVerifyText };
