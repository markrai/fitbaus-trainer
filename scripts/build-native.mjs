import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const webDir = path.join(rootDir, "www");
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

await build({
  entryPoints: [path.join(rootDir, "src", "main.ts")],
  outfile: path.join(webDir, "dist", "main.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  logLevel: "info",
});

await Promise.all(
  staticFiles.map((file) => cp(path.join(rootDir, file), path.join(webDir, file)))
);

console.log(`Native web assets written to ${webDir}`);
