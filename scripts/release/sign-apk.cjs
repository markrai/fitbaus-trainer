"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { fail, run, which } = require("./common.cjs");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`Missing required environment variable: ${name}`);
  return value;
}

function findBuildTool(name) {
  const envName = name.toUpperCase();
  if (process.env[envName]) return process.env[envName];
  const fromPath = which(name);
  if (fromPath) return fromPath;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) fail(`${name} not found; set ${envName} or ANDROID_HOME`);
  const buildTools = path.join(sdk, "build-tools");
  if (!fs.existsSync(buildTools)) fail(`No build-tools under ${sdk}`);
  const versions = fs
    .readdirSync(buildTools)
    .filter((version) =>
      fs.existsSync(path.join(buildTools, version, process.platform === "win32" ? `${name}.bat` : name)),
    )
    .sort()
    .reverse();
  if (versions.length === 0) fail(`${name} not found under ${buildTools}`);
  return path.join(buildTools, versions[0], process.platform === "win32" ? `${name}.bat` : name);
}

function findApksigner() {
  return findBuildTool("apksigner");
}

function findZipalign() {
  return findBuildTool("zipalign");
}

/**
 * Sign an APK with apksigner using env: password references (never pass:<secret>).
 * Aligns before signing. Fails closed when credentials are missing.
 */
function signApk({
  inputApk,
  outputApk,
  keystore,
  storePassword,
  keyAlias,
  keyPassword,
  apksigner = findApksigner(),
  zipalign = findZipalign(),
  minSdkVersion = null,
}) {
  if (!fs.existsSync(inputApk)) fail(`Input APK missing: ${inputApk}`);
  if (!fs.existsSync(keystore)) fail(`Keystore missing: ${keystore}`);
  if (!storePassword) fail("storePassword is required");
  if (!keyAlias) fail("keyAlias is required");
  if (!keyPassword) fail("keyPassword is required");

  fs.mkdirSync(path.dirname(outputApk), { recursive: true });
  if (path.resolve(inputApk) === path.resolve(outputApk)) {
    fail("inputApk and outputApk must differ");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fitbaus-sign-"));
  const aligned = path.join(tmpDir, "aligned.apk");
  const ksPassEnv = "FITBAUS_APKSIGNER_KS_PASS";
  const keyPassEnv = "FITBAUS_APKSIGNER_KEY_PASS";
  try {
    run(zipalign, ["-f", "4", inputApk, aligned]);
    run(
      apksigner,
      [
        "sign",
        "--ks",
        keystore,
        "--ks-key-alias",
        keyAlias,
        "--ks-pass",
        `env:${ksPassEnv}`,
        "--key-pass",
        `env:${keyPassEnv}`,
        "--v1-signing-enabled",
        "true",
        "--v2-signing-enabled",
        "true",
        "--out",
        outputApk,
        aligned,
      ],
      {
        env: {
          [ksPassEnv]: storePassword,
          [keyPassEnv]: keyPassword,
        },
      },
    );

    const verifyArgs = ["verify", "--verbose"];
    if (minSdkVersion != null) {
      verifyArgs.push("--min-sdk-version", String(minSdkVersion));
    }
    verifyArgs.push(outputApk);
    const verified = run(apksigner, verifyArgs);
    const text = `${verified.stdout || ""}\n${verified.stderr || ""}`;
    if (!/Verified using v1 scheme \(JAR signing\):\s*true/i.test(text)) {
      fail(`APK lacks verified APK Signature Scheme v1 (required for API 22 installs): ${outputApk}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return outputApk;
}

function parseArgs(argv) {
  const options = {
    input: null,
    output: null,
    keystore: null,
    envPrefix: null,
    minSdk: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--in") options.input = argv[++i];
    else if (arg === "--out") options.output = argv[++i];
    else if (arg === "--keystore") options.keystore = argv[++i];
    else if (arg === "--env-prefix") options.envPrefix = argv[++i];
    else if (arg === "--min-sdk") options.minSdk = Number(argv[++i]);
    else fail(`Unknown argument: ${arg}`);
  }
  if (!options.input || !options.output || !options.keystore || !options.envPrefix) {
    fail("Usage: sign-apk.cjs --in apk --out apk --keystore file --env-prefix TRAINER_SIGNING [--min-sdk N]");
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const prefix = options.envPrefix;
  signApk({
    inputApk: options.input,
    outputApk: options.output,
    keystore: options.keystore,
    storePassword: requireEnv(`${prefix}_STORE_PASSWORD`),
    keyAlias: requireEnv(`${prefix}_KEY_ALIAS`),
    keyPassword: requireEnv(`${prefix}_KEY_PASSWORD`),
    minSdkVersion: options.minSdk,
  });
  process.stdout.write(`Signed ${options.output}\n`);
}

module.exports = { signApk, findApksigner, findZipalign };
