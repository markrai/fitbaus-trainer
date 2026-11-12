"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  APP_VERSION_PATTERN,
  NATIVE_VERSION_MANIFEST_NAME,
  parseAppVersionFromText,
  parseNativeVersionManifest,
  readAppVersion,
} = require("./fitbaus-version.cjs");

const SW_CACHE_REGEX_SOURCE = String.raw`text.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/)`;

function fail(errors, message) {
  errors.push(message);
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function extractQuotedVersion(text, label, errors) {
  const match = text.match(APP_VERSION_PATTERN);
  if (!match) {
    fail(errors, `${label} does not contain APP_VERSION`);
    return null;
  }
  return match[1];
}

function parseGradleOutput(stdout, label, errors) {
  const name = stdout.match(/FITBAUS_VERSION_NAME=(\S+)/);
  const code = stdout.match(/FITBAUS_VERSION_CODE=(\S+)/);
  if (!name) {
    fail(errors, `${label} did not print FITBAUS_VERSION_NAME`);
  }
  if (!code && !stdout.includes("FITBAUS_PROTOCOL_VERSION=")) {
    fail(errors, `${label} did not print FITBAUS_VERSION_CODE`);
  }
  return {
    name: name ? name[1] : null,
    code: code ? Number(code[1]) : null,
    protocol: (stdout.match(/FITBAUS_PROTOCOL_VERSION=(\S+)/) || [])[1] || null,
  };
}

function runGradle(wrapperDir, args, errors) {
  const isWindows = process.platform === "win32";
  const wrapper = path.join(wrapperDir, isWindows ? "gradlew.bat" : "gradlew");
  if (!fs.existsSync(wrapper)) {
    fail(errors, `Gradle wrapper missing: ${wrapper}`);
    return null;
  }
  const gradleArgs = args.concat("--no-daemon");
  const result = spawnSync(
    isWindows ? process.env.ComSpec || "cmd.exe" : wrapper,
    isWindows ? ["/c", wrapper, ...gradleArgs] : gradleArgs,
    {
      cwd: wrapperDir,
      encoding: "utf8",
      env: process.env,
    },
  );
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0) {
    fail(errors, `Gradle ${args.join(" ")} failed in ${wrapperDir} (exit ${result.status})\n${output}`);
    return null;
  }
  return output;
}

function checkVersionConsistency(root, options = {}) {
  const errors = [];
  const requireGradle = options.requireGradle || "none";
  const versionJsPath = path.join(root, "version.js");
  let expected;
  try {
    expected = readAppVersion(versionJsPath);
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }

  const pkgPath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const srcPath = path.join(root, "src", "version.ts");
  const distPath = path.join(root, "dist", "version.js");
  const pbxPath = path.join(root, "ios", "App", "App.xcodeproj", "project.pbxproj");
  const swPath = path.join(root, "sw.js");
  const androidAppGradle = path.join(root, "android", "app", "build.gradle");
  const androidRootGradle = path.join(root, "android", "build.gradle");
  const bridgeAppGradle = path.join(root, "equipment-bridges", "proform-smart-power-10", "native", "bridge-app", "build.gradle.kts");
  const protocolKt = path.join(
    root,
    "equipment-bridges",
    "proform-smart-power-10",
    "native",
    "equipment-protocol",
    "src",
    "main",
    "kotlin",
    "com",
    "fitbaus",
    "bikebridge",
    "protocol",
    "BridgeHttpJson.kt",
  );
  const fakeBridge = path.join(
    root,
    "equipment-bridges",
    "proform-smart-power-10",
    "scripts",
    "native-resistance-actuation-fake-bridge.mjs",
  );

  const pkg = JSON.parse(readUtf8(pkgPath));
  if (pkg.version !== expected.name) {
    fail(errors, `package.json version ${pkg.version} != ${expected.name}`);
  }

  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(readUtf8(lockPath));
    if (lock.version !== expected.name) {
      fail(errors, `package-lock.json version ${lock.version} != ${expected.name}`);
    }
    if (lock.packages && lock.packages[""] && lock.packages[""].version !== expected.name) {
      fail(errors, `package-lock.json packages[""].version ${lock.packages[""].version} != ${expected.name}`);
    }
  }

  const srcVersion = extractQuotedVersion(readUtf8(srcPath), "src/version.ts", errors);
  if (srcVersion && srcVersion !== expected.name) {
    fail(errors, `src/version.ts APP_VERSION ${srcVersion} != ${expected.name}`);
  }

  if (!fs.existsSync(distPath)) {
    fail(errors, "dist/version.js is missing; run npm run build");
  } else {
    let distParsed;
    try {
      distParsed = parseAppVersionFromText(readUtf8(distPath), distPath);
    } catch (err) {
      fail(errors, err.message);
    }
    if (distParsed && distParsed.name !== expected.name) {
      fail(errors, `dist/version.js APP_VERSION ${distParsed.name} != ${expected.name}`);
    }
  }

  const pbx = readUtf8(pbxPath);
  const marketing = [...pbx.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1].trim());
  const builds = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = ([^;]+);/g)].map((m) => m[1].trim());
  if (marketing.length === 0 || marketing.some((value) => value !== expected.name)) {
    fail(errors, `iOS MARKETING_VERSION ${marketing.join(",")} != ${expected.name}`);
  }
  const expectedBuild = String(expected.versionCode);
  if (builds.length === 0 || builds.some((value) => value !== expectedBuild)) {
    fail(errors, `iOS CURRENT_PROJECT_VERSION ${builds.join(",")} != ${expectedBuild}`);
  }

  const sw = readUtf8(swPath);
  if (!sw.includes(SW_CACHE_REGEX_SOURCE)) {
    fail(errors, "sw.js cache parser does not use the expected APP_VERSION regex");
  }
  if (fs.existsSync(distPath)) {
    const distText = readUtf8(distPath);
    const matched = distText.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (!matched || matched[1] !== expected.name) {
      fail(errors, `sw.js APP_VERSION regex does not match dist/version.js (${expected.name})`);
    }
  }

  const androidApp = readUtf8(androidAppGradle);
  const androidRoot = readUtf8(androidRootGradle);
  if (!androidRoot.includes('rootProject.file("../version.js")')) {
    fail(errors, 'android/build.gradle must resolve version.js via rootProject.file("../version.js")');
  }
  if (!androidApp.includes("rootProject.ext.fitbausVersionName") || !androidApp.includes("rootProject.ext.fitbausVersionCode")) {
    fail(errors, "android/app/build.gradle must use rootProject.ext FitBaus version properties");
  }
  if (/versionName\s+"1\.0"/.test(androidApp) || /versionCode\s+1\b/.test(androidApp)) {
    fail(errors, "android/app/build.gradle still contains hardcoded stock Capacitor versions");
  }

  const bridgeApp = readUtf8(bridgeAppGradle);
  if (!bridgeApp.includes('rootProject.extra["fitbausVersionName"]') || !bridgeApp.includes('rootProject.extra["fitbausVersionCode"]')) {
    fail(errors, "bridge-app/build.gradle.kts must use rootProject.extra FitBaus version properties");
  }

  const protocol = readUtf8(protocolKt);
  if (!protocol.includes("FitbausProductVersion.NAME")) {
    fail(errors, "BridgeHttpJson.VERSION must use generated FitbausProductVersion.NAME");
  }
  if (/public const val VERSION: String = "0\./.test(protocol)) {
    fail(errors, "BridgeHttpJson still hardcodes a product version");
  }

  const fake = readUtf8(fakeBridge);
  if (!fake.includes("readAppVersion") || fake.includes('bridgeVersion: "0.2.0"')) {
    fail(errors, "fake bridge must read version.js instead of hardcoding bridgeVersion");
  }

  const wwwDir = path.join(root, "www");
  const wwwManifest = path.join(wwwDir, NATIVE_VERSION_MANIFEST_NAME);
  const wwwBundle = path.join(wwwDir, "dist", "main.js");
  if (fs.existsSync(wwwBundle) && !fs.existsSync(wwwManifest)) {
    fail(errors, `www/dist/main.js exists but ${NATIVE_VERSION_MANIFEST_NAME} is missing`);
  }
  if (fs.existsSync(wwwManifest)) {
    try {
      const nativeParsed = parseNativeVersionManifest(readUtf8(wwwManifest), wwwManifest);
      if (nativeParsed.name !== expected.name || nativeParsed.versionCode !== expected.versionCode) {
        fail(
          errors,
          `www/${NATIVE_VERSION_MANIFEST_NAME} is ${nativeParsed.name}/${nativeParsed.versionCode} != ${expected.name}/${expected.versionCode}`
        );
      }
    } catch (err) {
      fail(errors, err.message);
    }
  }

  const wantAndroid = requireGradle === "android" || requireGradle === "all";
  const wantBridge = requireGradle === "bridge" || requireGradle === "all";

  if (wantAndroid) {
    const output = runGradle(path.join(root, "android"), [":app:printFitbausVersion"], errors);
    if (output) {
      const parsed = parseGradleOutput(output, "android :app:printFitbausVersion", errors);
      if (parsed.name && parsed.name !== expected.name) {
        fail(errors, `Android Gradle versionName ${parsed.name} != ${expected.name}`);
      }
      if (parsed.code != null && parsed.code !== expected.versionCode) {
        fail(errors, `Android Gradle versionCode ${parsed.code} != ${expected.versionCode}`);
      }
    }
  }

  if (wantBridge) {
    const nativeRoot = path.join(root, "equipment-bridges", "proform-smart-power-10", "native");
    const rootOut = runGradle(nativeRoot, [":printFitbausVersion"], errors);
    if (rootOut) {
      const parsed = parseGradleOutput(rootOut, "native :printFitbausVersion", errors);
      if (parsed.name && parsed.name !== expected.name) {
        fail(errors, `Bike Bridge Gradle versionName ${parsed.name} != ${expected.name}`);
      }
      if (parsed.code != null && parsed.code !== expected.versionCode) {
        fail(errors, `Bike Bridge Gradle versionCode ${parsed.code} != ${expected.versionCode}`);
      }
    }
    const appOut = runGradle(nativeRoot, [":bridge-app:printFitbausVersion"], errors);
    if (appOut) {
      const parsed = parseGradleOutput(appOut, "native :bridge-app:printFitbausVersion", errors);
      if (parsed.name && parsed.name !== expected.name) {
        fail(errors, `bridge-app versionName ${parsed.name} != ${expected.name}`);
      }
      if (parsed.code != null && parsed.code !== expected.versionCode) {
        fail(errors, `bridge-app versionCode ${parsed.code} != ${expected.versionCode}`);
      }
    }
    const protoOut = runGradle(nativeRoot, [":equipment-protocol:printFitbausVersion"], errors);
    if (protoOut) {
      const parsed = parseGradleOutput(protoOut, "native :equipment-protocol:printFitbausVersion", errors);
      const protocolVersion = parsed.protocol || parsed.name;
      if (protocolVersion && protocolVersion !== expected.name) {
        fail(errors, `equipment-protocol generated version ${protocolVersion} != ${expected.name}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, expected };
}

function parseArgs(argv) {
  const options = { requireGradle: "none", root: path.resolve(__dirname, "..") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      options.root = path.resolve(argv[++i]);
    } else if (arg.startsWith("--require-gradle=")) {
      options.requireGradle = arg.slice("--require-gradle=".length);
    } else if (arg === "--require-gradle") {
      options.requireGradle = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["none", "android", "bridge", "all"].includes(options.requireGradle)) {
    throw new Error("--require-gradle must be none, android, bridge, or all");
  }
  return options;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = checkVersionConsistency(options.root, options);
    if (!result.ok) {
      console.error("FitBaus version consistency failed:");
      for (const message of result.errors) {
        console.error(" -", message);
      }
      process.exit(1);
    }
    console.log(
      "FitBaus version consistency ok:",
      result.expected.name,
      "build",
      result.expected.versionCode,
      `(gradle=${options.requireGradle})`,
    );
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

module.exports = {
  SW_CACHE_REGEX_SOURCE,
  checkVersionConsistency,
};
