// Reads version from version.js (single source of truth) and syncs to
// src/version.ts, package.json, and package-lock.json root metadata.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const versionJsPath = path.join(root, "version.js");
const versionTsPath = path.join(root, "src", "version.ts");
const packageJsonPath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");

const versionJs = fs.readFileSync(versionJsPath, "utf8");
const match = versionJs.match(/APP_VERSION\s*=\s*["']([^"']+)["']/);
if (!match) {
  console.error("sync-version: could not find APP_VERSION in version.js");
  process.exit(1);
}
const version = match[1];

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

console.log("Synced version", version, "to src/version.ts, package.json, and package-lock.json");
