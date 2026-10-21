import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as types from "../dist/types.js";

const contractsDir = new URL("../dist/contracts/", import.meta.url);
const contractFiles = readdirSync(contractsDir).filter((name) => name.endsWith(".js"));

test("types.js facade runtime export surface is unchanged (names and literal values)", () => {
  assert.deepEqual({ ...types }, {
    ATHLETE_PROFILE_SCHEMA_VERSION: 1,
    ATHLETE_PROFILE_SCHEMA_VERSION_V1: 1,
    FITNESS_STATE_SCHEMA_VERSION: 3,
    FITNESS_STATE_SCHEMA_VERSION_V1: 1,
    FITNESS_STATE_SCHEMA_VERSION_V2: 2,
    FITNESS_STATE_SCHEMA_VERSION_V3: 3,
    FORMAL_CALIBRATION_MACHINE_PROVENANCE_SCHEMA_VERSION_V1: 1,
    LEGACY_HR_TARGET_RESOLVER_ID: "legacy-hr-target-resolver",
    LEGACY_HR_TARGET_RESOLVER_VERSION: 1,
    LEGACY_VO2_PROTOCOL_ID: "bike-submax-70rpm",
    LEGACY_VO2_PROTOCOL_VERSION: 1,
    LEGACY_VO2_PROTOCOL_VERSION_V1: 1,
    ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION: 1,
    ORDINARY_BIKE_TELEMETRY_SCHEMA_VERSION_V1: 1,
    PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION: 3,
    PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V1: 1,
    PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V2: 2,
    PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V3: 3,
    PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1: "personalized-prescription-characterization",
    PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION: 3,
    PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V1: 1,
    PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V2: 2,
    PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V3: 3,
    PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1: 1,
    PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1: "personalized-prescription-resolver",
    PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1: 1,
    VO2_ASSESSMENT_SCHEMA_VERSION: 2,
    VO2_ASSESSMENT_SCHEMA_VERSION_V1: 1,
    VO2_ASSESSMENT_SCHEMA_VERSION_V2: 2,
    VO2_EVIDENCE_SCHEMA_VERSION: 2,
    VO2_EVIDENCE_SCHEMA_VERSION_V1: 1,
    VO2_EVIDENCE_SCHEMA_VERSION_V2: 2,
    VO2_PROTOCOL_ID: "bike-submax-70rpm",
    VO2_PROTOCOL_VERSION: 2,
    VO2_PROTOCOL_VERSION_V2: 2,
    VO2_PROTOCOL_VERSION_V3: 3,
    WORKOUT_EXECUTION_PROVENANCE_SCHEMA_VERSION_V1: 1,
    WORKOUT_PRESCRIPTION_RESOLVER_ID: "legacy-hr-target-resolver",
    WORKOUT_PRESCRIPTION_RESOLVER_VERSION: 1,
    WORKOUT_PRESCRIPTION_SCHEMA_VERSION: 1,
    WORKOUT_RESPONSE_SCHEMA_VERSION: 1,
    WORKOUT_RESPONSE_SCHEMA_VERSION_V1: 1,
  });
});

test("historical _V<n> and legacy identities are pinned literals, never derived from current aliases", () => {
  const derived = [];
  let historical = 0;
  for (const file of contractFiles) {
    const source = readFileSync(new URL(file, contractsDir), "utf8");
    for (const [, name, initializer] of source.matchAll(/export const ([A-Z0-9_]+) = ([^;]+);/g)) {
      if (!/_V\d+$/.test(name)) continue;
      historical += 1;
      if (!/^(\d+|"[^"]*")$/.test(initializer.trim())) derived.push(`${file}: ${name} = ${initializer}`);
    }
  }
  assert.ok(historical >= 25, "expected the historical identity constants to be found");
  assert.deepEqual(derived, []);
  // Current aliases that deliberately trail the newest historical version must not drift.
  assert.equal(types.VO2_PROTOCOL_VERSION, types.VO2_PROTOCOL_VERSION_V2);
  assert.notEqual(types.VO2_PROTOCOL_VERSION, types.VO2_PROTOCOL_VERSION_V3);
  assert.notEqual(types.LEGACY_VO2_PROTOCOL_VERSION, types.VO2_PROTOCOL_VERSION);
});

test("contract modules never import the types.js facade, and the facade only re-exports", () => {
  // Type-only imports are erased from dist, so check the TypeScript sources.
  const sourceDir = new URL("../src/contracts/", import.meta.url);
  const sources = readdirSync(sourceDir).filter((name) => name.endsWith(".ts"));
  assert.ok(sources.length > 0);
  for (const file of sources) {
    const source = readFileSync(new URL(file, sourceDir), "utf8");
    for (const [, specifier] of source.matchAll(/from\s+"([^"]+)"/g)) {
      assert.ok(specifier !== "../types.js", `${file} imports the facade`);
    }
  }
  // Modules that contracts import must not route back through the facade (no contracts -> X -> types.ts -> contracts loop).
  const srcRoot = new URL("../src/", import.meta.url);
  const visited = new Set();
  const pending = sources.map((file) => new URL(file, sourceDir));
  while (pending.length) {
    const url = pending.pop();
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    const source = readFileSync(url, "utf8");
    for (const [, specifier] of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = new URL(specifier.replace(/\.js$/, ".ts"), url);
      assert.notEqual(target.href, new URL("types.ts", srcRoot).href, `${url.pathname} (reachable from contracts) imports the types.ts facade`);
      pending.push(target);
    }
  }
  const facade = readFileSync(new URL("../dist/types.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/export \{[^}]*\} from "\.\/contracts\/[A-Za-z0-9]+\.js";/g, "")
    .trim();
  assert.equal(facade, "", "dist/types.js should contain only re-exports from ./contracts/");
});
