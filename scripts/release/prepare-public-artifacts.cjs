"use strict";

const fs = require("fs");
const path = require("path");
const { fail, publicArtifactNames, sha256File, writeText } = require("./common.cjs");

function writeChecksums(artifactDir, files) {
  const lines = files.map((name) => {
    const hash = sha256File(path.join(artifactDir, name));
    return `${hash}  ${name}`;
  });
  writeText(path.join(artifactDir, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
}

function writeArtifactsMarkdown({
  artifactDir,
  versionName,
  versionCode,
  edition,
  sourceTag,
  sourceCommit,
  toolingRef,
  trainerCert,
  bridgeCert,
  bridgeQualified,
}) {
  const names = publicArtifactNames(versionName, edition);
  const text = `# FitBaus ${versionName} (${edition}) distribution

These are the public installer artifacts for tag \`${sourceTag}\` (commit \`${sourceCommit}\`).
Release tooling revision: \`${toolingRef}\`.

Product version: **${versionName}** (versionCode **${versionCode}**)
Edition: **FitBaus Lite ${versionName}** — compact edition for supported, storage-constrained
ProForm Smart Power 10.0 consoles. Lite is maintained on \`lite/1.x\` without external UVC webcam support.

| File | Package / contents | Notes |
| --- | --- | --- |
| \`${names.trainerApk}\` | \`com.markrai.fitbaus.trainer\` | Release-signed Trainer Android APK |
| \`${names.bridgeApk}\` | \`com.fitbaus.bikebridge\` | Release-signed production Bike Bridge (Lite filename; same package ID) |
| \`${names.webZip}\` | static web/PWA | Host on HTTPS; not signed |
| \`${names.checksums}\` | SHA-256 | Verify downloads |
| \`${names.manifest}\` | this file | |

Trainer certificate SHA-256: \`${trainerCert}\`
Bike Bridge certificate SHA-256: \`${bridgeCert}\`

**Candidate provenance** (inspect/build): signed binaries and hashes are recorded in
\`release-candidate.json\`. That file identifies the exact Bridge APK (\`apkSha256\`) for
console acceptance and later publication checks. Candidate provenance is not the same as
publication qualification.

**Physical qualification** is a separate publication gate recorded in
\`.github/release/physical-qualification.json\`. \`mode=publish\` verifies that binding against
this exact Bridge APK before undrafting the GitHub Release. A published Release means that
gate passed for these binaries; an inspect candidate alone does not.
${bridgeQualified ? "\nA matching qualification record may already exist for this Bridge identity.\n" : ""}
End users should install only from a **published** GitHub Release. Users never handle signing keys.

Unsigned APKs, staging package IDs (\`com.fitbaus.bikebridge.native\`), and debug-signed builds
are engineering inspection outputs only — not the normal public installer selection.
`;
  writeText(path.join(artifactDir, names.manifest), text);
}

function preparePublicArtifacts({
  artifactDir,
  versionName,
  versionCode,
  edition,
  sourceTag,
  sourceCommit,
  toolingRef,
  trainerApkPath,
  bridgeApkPath,
  webZipPath,
  trainerCert,
  bridgeCert,
  bridgeQualified,
}) {
  const names = publicArtifactNames(versionName, edition);
  fs.mkdirSync(artifactDir, { recursive: true });

  const mapping = [
    [trainerApkPath, names.trainerApk],
    [bridgeApkPath, names.bridgeApk],
    [webZipPath, names.webZip],
  ];
  for (const [src, destName] of mapping) {
    if (!fs.existsSync(src)) fail(`Missing artifact source: ${src}`);
    fs.copyFileSync(src, path.join(artifactDir, destName));
  }

  writeArtifactsMarkdown({
    artifactDir,
    versionName,
    versionCode,
    edition,
    sourceTag,
    sourceCommit,
    toolingRef,
    trainerCert,
    bridgeCert,
    bridgeQualified,
  });

  writeChecksums(artifactDir, [names.trainerApk, names.bridgeApk, names.webZip, names.manifest]);

  // Guard against shipping staging/unsigned names in the public directory.
  for (const name of fs.readdirSync(artifactDir)) {
    if (/unsigned|staging|debug/i.test(name)) {
      fail(`Public artifact directory contains non-public file name: ${name}`);
    }
  }

  return names;
}

function parseArgs(argv) {
  const options = {
    dir: null,
    versionName: null,
    versionCode: null,
    edition: "lite",
    sourceTag: null,
    sourceCommit: null,
    toolingRef: "local",
    trainerApk: null,
    bridgeApk: null,
    webZip: null,
    trainerCert: null,
    bridgeCert: null,
    bridgeQualified: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") options.dir = argv[++i];
    else if (arg === "--version-name") options.versionName = argv[++i];
    else if (arg === "--version-code") options.versionCode = argv[++i];
    else if (arg === "--edition") options.edition = argv[++i];
    else if (arg === "--source-tag") options.sourceTag = argv[++i];
    else if (arg === "--source-commit") options.sourceCommit = argv[++i];
    else if (arg === "--tooling-ref") options.toolingRef = argv[++i];
    else if (arg === "--trainer-apk") options.trainerApk = argv[++i];
    else if (arg === "--bridge-apk") options.bridgeApk = argv[++i];
    else if (arg === "--web-zip") options.webZip = argv[++i];
    else if (arg === "--trainer-cert") options.trainerCert = argv[++i];
    else if (arg === "--bridge-cert") options.bridgeCert = argv[++i];
    else if (arg === "--bridge-qualified") options.bridgeQualified = true;
    else fail(`Unknown argument: ${arg}`);
  }
  const required = {
    "--dir": options.dir,
    "--version-name": options.versionName,
    "--version-code": options.versionCode,
    "--source-tag": options.sourceTag,
    "--source-commit": options.sourceCommit,
    "--trainer-apk": options.trainerApk,
    "--bridge-apk": options.bridgeApk,
    "--web-zip": options.webZip,
    "--trainer-cert": options.trainerCert,
    "--bridge-cert": options.bridgeCert,
  };
  for (const [flag, value] of Object.entries(required)) {
    if (value == null || value === "") fail(`Missing ${flag}`);
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const names = preparePublicArtifacts({
    artifactDir: options.dir,
    versionName: options.versionName,
    versionCode: Number(options.versionCode),
    edition: options.edition,
    sourceTag: options.sourceTag,
    sourceCommit: options.sourceCommit,
    toolingRef: options.toolingRef,
    trainerApkPath: options.trainerApk,
    bridgeApkPath: options.bridgeApk,
    webZipPath: options.webZip,
    trainerCert: options.trainerCert,
    bridgeCert: options.bridgeCert,
    bridgeQualified: options.bridgeQualified,
  });
  process.stdout.write(`${JSON.stringify(names, null, 2)}\n`);
}

module.exports = { preparePublicArtifacts, writeChecksums, writeArtifactsMarkdown };
