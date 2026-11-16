"use strict";

const { parseProductVersion } = require("../fitbaus-version.cjs");

const PACKAGES = Object.freeze({
  trainer: Object.freeze({ applicationId: "com.markrai.fitbaus.trainer", minSdk: 24 }),
  bridge: Object.freeze({ applicationId: "com.fitbaus.bikebridge", minSdk: 22 }),
});

const EDITIONS = Object.freeze({
  lite: Object.freeze({
    id: "lite",
    major: 1,
    productName: "FitBaus Lite",
    bridgeLabel: "lite",
    branch: "lite/1.x",
    summary: [
      "compact edition for supported, storage-constrained",
      "ProForm Smart Power 10.0 consoles. Lite is maintained on `lite/1.x` without external UVC webcam support.",
    ].join("\n"),
    bridgeNote: "Release-signed production Bike Bridge (Lite filename; same package ID)",
  }),
  full: Object.freeze({
    id: "full",
    major: 2,
    productName: "FitBaus Full",
    bridgeLabel: "full",
    branch: "main",
    summary: [
      "ongoing feature edition for ProForm Smart Power 10.0",
      "consoles, developed on `main`, with external USB (UVC) webcam support and native YouTube playback in",
      "the Bike Bridge. Full uses the same package IDs and signing certificates as Lite, so it installs over a",
      "Lite 1.x installation without uninstalling or clearing Bike Bridge pairing.",
    ].join("\n"),
    bridgeNote: "Release-signed production Bike Bridge (Full filename; same package ID)",
  }),
});

function editionError(message) {
  throw new Error(message);
}

function resolveEdition(edition) {
  if (typeof edition !== "string" || !Object.prototype.hasOwnProperty.call(EDITIONS, edition)) {
    editionError(`Unsupported edition: ${edition} (expected one of: ${Object.keys(EDITIONS).join(", ")})`);
  }
  return EDITIONS[edition];
}

function versionFromTag(tag) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(String(tag || ""));
  if (!match) editionError(`Cannot derive version from tag: ${tag}`);
  return match[1];
}

function resolveRelease({ edition, versionName = null, tag = null }) {
  const policy = resolveEdition(edition);
  const fromTag = tag == null ? null : versionFromTag(tag);
  const name = versionName == null ? fromTag : String(versionName);
  if (name == null) editionError("versionName or tag is required to resolve a release");
  if (fromTag != null && fromTag !== name) {
    editionError(`Release tag ${tag} requires version ${fromTag}, got ${name}`);
  }
  const parsed = parseProductVersion(name, `${policy.id} release`);
  if (parsed.major !== policy.major) {
    editionError(
      `${policy.productName} requires major version ${policy.major}.x.x, got ${name}. ` +
        `Lite is 1.x.x and Full is 2.x.x.`,
    );
  }
  return Object.freeze({
    edition: policy.id,
    productName: policy.productName,
    branch: policy.branch,
    summary: policy.summary,
    bridgeNote: policy.bridgeNote,
    versionName: parsed.name,
    versionCode: parsed.versionCode,
    major: parsed.major,
    tag: `v${parsed.name}`,
    title: `${policy.productName} ${parsed.name}`,
    artifacts: artifactNamesFor(policy, parsed.name),
  });
}

function artifactNamesFor(policy, versionName) {
  return Object.freeze({
    trainerApk: `fitbaus-trainer-android-${versionName}.apk`,
    bridgeApk: `fitbaus-bikebridge-${policy.bridgeLabel}-${versionName}.apk`,
    webZip: `fitbaus-trainer-web-${versionName}.zip`,
    checksums: "SHA256SUMS.txt",
    manifest: "ARTIFACTS.md",
    candidate: "release-candidate.json",
  });
}

function releaseAssetNames(names) {
  return [names.trainerApk, names.bridgeApk, names.webZip, names.checksums, names.manifest, names.candidate];
}

function parseArgs(argv) {
  const options = { edition: null, versionName: null, tag: null, field: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--edition") options.edition = argv[++i];
    else if (arg === "--version-name") options.versionName = argv[++i];
    else if (arg === "--tag") options.tag = argv[++i];
    else if (arg === "--field") options.field = argv[++i];
    else editionError(`Unknown argument: ${arg}`);
  }
  if (!options.edition) editionError("--edition is required");
  if (!options.versionName && !options.tag) editionError("--version-name or --tag is required");
  return options;
}

function render(release, field) {
  if (field == null) return `${JSON.stringify({ ...release, assets: releaseAssetNames(release.artifacts) }, null, 2)}\n`;
  if (field === "assets") return `${releaseAssetNames(release.artifacts).join("\n")}\n`;
  if (Object.prototype.hasOwnProperty.call(release.artifacts, field)) return `${release.artifacts[field]}\n`;
  if (Object.prototype.hasOwnProperty.call(release, field) && field !== "artifacts") return `${release[field]}\n`;
  editionError(`Unknown field: ${field}`);
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const release = resolveRelease({ edition: options.edition, versionName: options.versionName, tag: options.tag });
    process.stdout.write(render(release, options.field));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  EDITIONS,
  PACKAGES,
  resolveEdition,
  resolveRelease,
  releaseAssetNames,
  versionFromTag,
};
