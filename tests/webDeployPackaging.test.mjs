import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { OPTIONAL_ROOT_FILES, ROOT_FILES, packageWebDeploy } = require("../scripts/package-web-deploy.cjs");

function uniqueTmp(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeMinimalWebTree(root, extras = {}) {
  await mkdir(path.join(root, "dist", "nested"), { recursive: true });
  for (const file of ROOT_FILES) {
    await writeFile(path.join(root, file), file);
  }
  await writeFile(path.join(root, "dist", "main.js"), "dist-main");
  await writeFile(path.join(root, "dist", "nested", "leaf.js"), "leaf");
  if (extras.logo) await writeFile(path.join(root, "logo.png"), "logo");
  if (extras.manifest) await writeFile(path.join(root, "manifest.json"), "{}");
}

test("web deploy packager requires favicon.ico and treats logo/manifest as optional", () => {
  assert.ok(ROOT_FILES.includes("favicon.ico"));
  assert.ok(!ROOT_FILES.includes("logo.png"));
  assert.ok(!ROOT_FILES.includes("manifest.json"));
  assert.ok(OPTIONAL_ROOT_FILES.includes("logo.png"));
  assert.ok(OPTIONAL_ROOT_FILES.includes("manifest.json"));
});

test("web deploy packager copies required files and dist without optional assets", async () => {
  const root = await uniqueTmp("fitbaus-web-deploy-");
  await writeMinimalWebTree(root);
  const deployDir = path.join(root, "deploy");
  const result = packageWebDeploy(root, { deployDir });
  assert.equal(result.deployDir, deployDir);
  for (const file of ROOT_FILES) {
    assert.equal(await readFile(path.join(deployDir, file), "utf8"), file);
  }
  assert.equal(existsSync(path.join(deployDir, "logo.png")), false);
  assert.equal(existsSync(path.join(deployDir, "manifest.json")), false);
  assert.equal(await readFile(path.join(deployDir, "dist", "main.js"), "utf8"), "dist-main");
  assert.equal(await readFile(path.join(deployDir, "dist", "nested", "leaf.js"), "utf8"), "leaf");
});

test("web deploy packager copies optional logo and manifest when present", async () => {
  const root = await uniqueTmp("fitbaus-web-deploy-optional-");
  await writeMinimalWebTree(root, { logo: true, manifest: true });
  const deployDir = path.join(root, "deploy");
  packageWebDeploy(root, { deployDir });
  assert.equal(await readFile(path.join(deployDir, "logo.png"), "utf8"), "logo");
  assert.equal(await readFile(path.join(deployDir, "manifest.json"), "utf8"), "{}");
});

test("web deploy packager fails when a required asset is absent", async () => {
  const root = await uniqueTmp("fitbaus-web-deploy-missing-");
  await writeMinimalWebTree(root);
  await (await import("node:fs/promises")).rm(path.join(root, "favicon.ico"));
  assert.throws(
    () => packageWebDeploy(root, { deployDir: path.join(root, "deploy") }),
    /Required web deploy file is missing: favicon\.ico/,
  );
});
