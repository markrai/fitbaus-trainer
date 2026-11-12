// Reads version from version.js (single source of truth) and syncs to
// src/version.ts, package.json, package-lock.json root metadata, and iOS
// marketing/build numbers.
const fs = require("fs");
const path = require("path");
const { readAppVersion } = require("./fitbaus-version.cjs");

const root = path.join(__dirname, "..");
const versionJsPath = path.join(root, "version.js");
const versionTsPath = path.join(root, "src", "version.ts");
const packageJsonPath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");
const pbxprojPath = path.join(root, "ios", "App", "App.xcodeproj", "project.pbxproj");

const parsed = readAppVersion(versionJsPath);
const version = parsed.name;
const versionCode = String(parsed.versionCode);

const versionTsContent = `export const APP_VERSION = "${version}";

export function setVersionOnDom() {
  const versionEl = document.getElementById("appVersion");
  if (versionEl) {
    versionEl.textContent = "v" + APP_VERSION;
  }
  (window as any).APP_VERSION = APP_VERSION;
}
`;

fs.writeFileSync(versionTsPath, versionTsContent, "utf8");

const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
pkg.version = version;
fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

if (fs.existsSync(packageLockPath)) {
  const lock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
  lock.version = version;
  if (lock.packages && lock.packages[""]) {
    lock.packages[""].version = version;
  }
  fs.writeFileSync(packageLockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
}

if (!fs.existsSync(pbxprojPath)) {
  console.error("sync-version: missing iOS project file", pbxprojPath);
  process.exit(1);
}

let pbx = fs.readFileSync(pbxprojPath, "utf8");
const marketingMatches = pbx.match(/MARKETING_VERSION = [^;]+;/g) || [];
const buildMatches = pbx.match(/CURRENT_PROJECT_VERSION = [^;]+;/g) || [];
if (marketingMatches.length === 0 || buildMatches.length === 0) {
  console.error("sync-version: iOS project is missing MARKETING_VERSION or CURRENT_PROJECT_VERSION");
  process.exit(1);
}
pbx = pbx.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`);
pbx = pbx.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${versionCode};`);
fs.writeFileSync(pbxprojPath, pbx, "utf8");

console.log(
  "Synced version",
  version,
  "(build",
  versionCode + ")",
  "to src/version.ts, package.json, package-lock.json, and iOS project versions"
);
