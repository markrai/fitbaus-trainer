"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT_FILES = [
  "index.html",
  "styles.css",
  "favicon.ico",
  "settings.svg",
  "sw.js",
  "data.json",
  "heart.png",
  "bike.png",
  "dumbbell.png",
  "elliptical.png",
];
const OPTIONAL_ROOT_FILES = ["logo.png", "manifest.json"];

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(source, dest);
    } else if (entry.isFile()) {
      copyFile(source, dest);
    }
  }
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function zipDirectory(sourceDir, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) {
    fs.rmSync(zipPath);
  }
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${sourceDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "Compress-Archive failed");
    }
    return;
  }
  const zipResult = spawnSync("zip", ["-r", "-q", zipPath, "."], {
    cwd: sourceDir,
    encoding: "utf8",
  });
  if (zipResult.status === 0) {
    return;
  }
  const py = spawnSync(
    "python3",
    [
      "-c",
      "import os, sys, zipfile\nroot, dest = sys.argv[1], sys.argv[2]\nwith zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:\n    for dirpath, _, files in os.walk(root):\n        for name in files:\n            path = os.path.join(dirpath, name)\n            z.write(path, os.path.relpath(path, root))\n",
      sourceDir,
      zipPath,
    ],
    { encoding: "utf8" },
  );
  if (py.status !== 0) {
    throw new Error(zipResult.stderr || zipResult.stdout || py.stderr || py.stdout || "zip failed");
  }
}

function packageWebDeploy(root, options = {}) {
  const deployDir = options.deployDir || path.join(root, "deploy");
  const distDir = path.join(root, "dist");
  if (!fs.existsSync(distDir)) {
    throw new Error("dist/ is missing; run npm run build before packaging web assets");
  }

  rmrf(deployDir);
  fs.mkdirSync(path.join(deployDir, "dist"), { recursive: true });

  for (const file of ROOT_FILES) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) {
      throw new Error(`Required web deploy file is missing: ${file}`);
    }
    copyFile(source, path.join(deployDir, file));
  }
  for (const file of OPTIONAL_ROOT_FILES) {
    const source = path.join(root, file);
    if (fs.existsSync(source)) {
      copyFile(source, path.join(deployDir, file));
    }
  }
  copyDir(distDir, path.join(deployDir, "dist"));

  let zipPath = null;
  if (options.zipPath) {
    zipPath = path.resolve(options.zipPath);
    zipDirectory(deployDir, zipPath);
  }
  return { deployDir, zipPath };
}

function parseArgs(argv) {
  const options = { zipPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--zip") {
      options.zipPath = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, "..");
    const options = parseArgs(process.argv.slice(2));
    const result = packageWebDeploy(root, options);
    console.log("Web deploy folder ready:", result.deployDir);
    if (result.zipPath) {
      console.log("Web deploy zip:", result.zipPath);
    }
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

module.exports = {
  OPTIONAL_ROOT_FILES,
  ROOT_FILES,
  packageWebDeploy,
};
