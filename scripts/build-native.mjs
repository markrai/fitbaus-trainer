import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const {
  bundleContainsVersion,
  nativeVersionManifestJson,
  NATIVE_VERSION_MANIFEST_NAME,
  readAppVersion,
} = require("./fitbaus-version.cjs");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const webDir = path.join(rootDir, "www");
const parsedVersion = readAppVersion(path.join(rootDir, "version.js"));
const staticFiles = [
  "index.html",
  "styles.css",
  "manifest.json",
  "data.json",
  "logo.png",
  "favicon.ico",
  "heart.png",
  "bike.png",
  "elliptical.png",
  "dumbbell.png",
  "settings.svg",
];

await rm(webDir, { recursive: true, force: true });
await mkdir(path.join(webDir, "dist"), { recursive: true });

const outfile = path.join(webDir, "dist", "main.js");
await build({
  entryPoints: [path.join(rootDir, "src", "main.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  logLevel: "info",
});

const bundleText = await readFile(outfile, "utf8");
if (!bundleContainsVersion(bundleText, parsedVersion.name)) {
  throw new Error(`Native bundle ${outfile} does not contain product version ${parsedVersion.name}`);
}

await writeFile(
  path.join(webDir, NATIVE_VERSION_MANIFEST_NAME),
  nativeVersionManifestJson(parsedVersion),
  "utf8"
);

await Promise.all(
  staticFiles.map((file) => cp(path.join(rootDir, file), path.join(webDir, file)))
);

console.log(`Native web assets written to ${webDir} (${parsedVersion.name})`);
