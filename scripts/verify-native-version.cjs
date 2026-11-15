"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  bundleContainsVersion,
  NATIVE_VERSION_MANIFEST_NAME,
  parseNativeVersionManifest,
  readAppVersion,
} = require("./fitbaus-version.cjs");

function fail(message) {
  throw new Error(message);
}

function assertManifest(filePath, expected) {
  if (!fs.existsSync(filePath)) {
    fail(`Native version manifest missing: ${filePath}`);
  }
  const parsed = parseNativeVersionManifest(fs.readFileSync(filePath, "utf8"), filePath);
  if (parsed.name !== expected.name || parsed.versionCode !== expected.versionCode) {
    fail(
      `Native version manifest ${filePath} is ${parsed.name}/${parsed.versionCode}, expected ${expected.name}/${expected.versionCode}`
    );
  }
}

function assertBundle(filePath, expected) {
  if (!fs.existsSync(filePath)) {
    fail(`Native bundle missing: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, "utf8");
  if (!bundleContainsVersion(text, expected.name)) {
    fail(`Native bundle ${filePath} does not contain product version ${expected.name}`);
  }
}

function readZipEntry(zipPath, entryName) {
  const maxBuffer = 16 * 1024 * 1024;
  const unzip = spawnSync("unzip", ["-p", zipPath, entryName], { encoding: "buffer", maxBuffer });
  if (unzip.status === 0 && unzip.stdout && unzip.stdout.length > 0) {
    return unzip.stdout.toString("utf8");
  }
  const tar = spawnSync("tar", ["-xOf", zipPath, entryName], { encoding: "buffer", maxBuffer });
  if (tar.status === 0 && tar.stdout && tar.stdout.length > 0) {
    return tar.stdout.toString("utf8");
  }
  const py = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-c", "import sys, zipfile; z=zipfile.ZipFile(sys.argv[1]); sys.stdout.buffer.write(z.read(sys.argv[2]))", zipPath, entryName],
    { encoding: "buffer", maxBuffer },
  );
  if (py.status === 0 && py.stdout && py.stdout.length > 0) {
    return Buffer.isBuffer(py.stdout) ? py.stdout.toString("utf8") : py.stdout;
  }
  fail(`Could not read ${entryName} from ${zipPath}`);
}

function assertApk(apkPath, expected) {
  if (!fs.existsSync(apkPath)) {
    fail(`APK missing: ${apkPath}`);
  }
  const manifestEntry = `assets/public/${NATIVE_VERSION_MANIFEST_NAME}`;
  const parsed = parseNativeVersionManifest(readZipEntry(apkPath, manifestEntry), `${apkPath}:${manifestEntry}`);
  if (parsed.name !== expected.name || parsed.versionCode !== expected.versionCode) {
    fail(
      `APK ${apkPath} native version is ${parsed.name}/${parsed.versionCode}, expected ${expected.name}/${expected.versionCode}`
    );
  }
  const bundleText = readZipEntry(apkPath, "assets/public/dist/main.js");
  if (!bundleContainsVersion(bundleText, expected.name)) {
    fail(`APK ${apkPath} bundled main.js does not contain product version ${expected.name}`);
  }
}

function parseArgs(argv) {
  const options = {
    root: path.resolve(__dirname, ".."),
    www: null,
    assets: null,
    apk: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") options.root = path.resolve(argv[++i]);
    else if (arg === "--www") options.www = path.resolve(argv[++i]);
    else if (arg === "--assets") options.assets = path.resolve(argv[++i]);
    else if (arg === "--apk") options.apk = path.resolve(argv[++i]);
    else fail(`Unknown argument: ${arg}`);
  }
  return options;
}

function findSoleApk(directory) {
  if (!fs.existsSync(directory)) {
    fail(`APK output directory missing: ${directory}`);
  }
  const apks = fs.readdirSync(directory).filter((name) => name.endsWith(".apk")).sort();
  if (apks.length !== 1) {
    fail(`Expected exactly one APK in ${directory}, found ${apks.length}: ${apks.join(", ")}`);
  }
  return path.join(directory, apks[0]);
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const expected = readAppVersion(path.join(options.root, "version.js"));
    if (options.www) {
      assertManifest(path.join(options.www, NATIVE_VERSION_MANIFEST_NAME), expected);
      assertBundle(path.join(options.www, "dist", "main.js"), expected);
    }
    if (options.assets) {
      assertManifest(path.join(options.assets, NATIVE_VERSION_MANIFEST_NAME), expected);
      assertBundle(path.join(options.assets, "dist", "main.js"), expected);
    }
    if (options.apk) {
      const apkPath = fs.existsSync(options.apk) && fs.statSync(options.apk).isDirectory()
        ? findSoleApk(options.apk)
        : options.apk;
      assertApk(apkPath, expected);
      console.log("Native APK version ok:", apkPath, expected.name, expected.versionCode);
    } else {
      console.log("Native version evidence ok:", expected.name, expected.versionCode);
    }
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

module.exports = {
  assertApk,
  assertBundle,
  assertManifest,
  findSoleApk,
};
