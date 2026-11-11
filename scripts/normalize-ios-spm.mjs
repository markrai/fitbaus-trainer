import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageFile = path.resolve(scriptDir, "..", "ios", "App", "CapApp-SPM", "Package.swift");

try {
  const source = await readFile(packageFile, "utf8");
  const normalized = source.replace(/path: "([^"]+)"/g, (_match, value) => {
    return `path: "${value.replaceAll("\\", "/")}"`;
  });
  if (normalized !== source) await writeFile(packageFile, normalized, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
