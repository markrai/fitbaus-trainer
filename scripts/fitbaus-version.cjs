"use strict";

const fs = require("fs");
const path = require("path");

const APP_VERSION_PATTERN = /APP_VERSION\s*=\s*["']([^"']+)["']/;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const MIN_VERSION_CODE = 1;
const MAX_VERSION_CODE = 2100000000;

function parseAppVersionFromText(text, sourceLabel) {
  const match = text.match(APP_VERSION_PATTERN);
  if (!match) {
    throw new Error(`Could not find APP_VERSION in ${sourceLabel}`);
  }
  return parseProductVersion(match[1], sourceLabel);
}

function parseProductVersion(version, sourceLabel) {
  const match = version.match(SEMVER_PATTERN);
  if (!match) {
    throw new Error(
      `FitBaus product version must be major.minor.patch with no prerelease, got '${version}' (${sourceLabel})`
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isInteger(major) || major < 0) {
    throw new Error(`FitBaus major version is invalid in '${version}' (${sourceLabel})`);
  }
  if (!Number.isInteger(minor) || minor < 0 || minor > 99) {
    throw new Error(`FitBaus minor version must be 0..99, got '${version}' (${sourceLabel})`);
  }
  if (!Number.isInteger(patch) || patch < 0 || patch > 99) {
    throw new Error(`FitBaus patch version must be 0..99, got '${version}' (${sourceLabel})`);
  }
  const versionCode = major * 10000 + minor * 100 + patch;
  if (!Number.isSafeInteger(versionCode) || versionCode < MIN_VERSION_CODE || versionCode > MAX_VERSION_CODE) {
    throw new Error(
      `FitBaus versionCode ${versionCode} for '${version}' is outside Android's permitted range ${MIN_VERSION_CODE}..${MAX_VERSION_CODE} (${sourceLabel})`
    );
  }
  return {
    name: version,
    major,
    minor,
    patch,
    versionCode,
  };
}

function readAppVersion(versionJsPath) {
  const resolved = path.resolve(versionJsPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`FitBaus version file is missing: ${resolved}`);
  }
  const text = fs.readFileSync(resolved, "utf8");
  return parseAppVersionFromText(text, resolved);
}

function repoRootFrom(scriptDir) {
  return path.resolve(scriptDir, "..");
}

const NATIVE_VERSION_MANIFEST_NAME = "fitbaus-version.json";

function nativeVersionManifestObject(parsed) {
  return {
    version: parsed.name,
    versionCode: parsed.versionCode,
  };
}

function nativeVersionManifestJson(parsed) {
  return JSON.stringify(nativeVersionManifestObject(parsed), null, 2) + "\n";
}

function parseNativeVersionManifest(text, sourceLabel) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid native version manifest in ${sourceLabel}: ${err.message}`);
  }
  if (!data || typeof data.version !== "string" || !Number.isInteger(data.versionCode)) {
    throw new Error(`Native version manifest in ${sourceLabel} must contain version and integer versionCode`);
  }
  const parsed = parseProductVersion(data.version, sourceLabel);
  if (parsed.versionCode !== data.versionCode) {
    throw new Error(
      `Native version manifest in ${sourceLabel} has versionCode ${data.versionCode}, expected ${parsed.versionCode} for ${parsed.name}`
    );
  }
  return parsed;
}

function bundleContainsVersion(bundleText, version) {
  return bundleText.includes(`"${version}"`) || bundleText.includes(`'${version}'`);
}

module.exports = {
  APP_VERSION_PATTERN,
  MAX_VERSION_CODE,
  MIN_VERSION_CODE,
  NATIVE_VERSION_MANIFEST_NAME,
  bundleContainsVersion,
  nativeVersionManifestJson,
  nativeVersionManifestObject,
  parseAppVersionFromText,
  parseNativeVersionManifest,
  parseProductVersion,
  readAppVersion,
  repoRootFrom,
};
