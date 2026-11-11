import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  BLANK_PROFILE,
  ATHLETE_IDENTITY_STORAGE_KEY,
  ATHLETE_PROFILE_STORAGE_KEY,
  LEGACY_PROFILE_STORAGE_KEY,
  athleteProfileToLegacyProfile,
  getProfile,
  loadAthleteProfile,
  migrateLegacyProfile,
  parseAthleteProfile,
  parseExplicitVo2ProfileInputs,
  PROFILE_WEIGHT_LBS_TO_KG,
  storeAthleteProfile,
  updateAthleteProfileFromLegacy,
} from "../dist/profile.js";
import { calculateZoneMinutes, mapHrToZone } from "../dist/zoneCalculator.js";
import { adjustedBlockLengths } from "../dist/workoutLogic.js";
import { assessVo2 } from "../dist/vo2Estimator.js";
import { ATHLETE_PROFILE_SCHEMA_VERSION_V1 } from "../dist/types.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("unset profile stays blank and is not an explicit VO2 input", () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const profile = getProfile();
    assert.deepEqual(profile, BLANK_PROFILE);
    assert.equal(profile.age, "");
    assert.equal(profile.weight, "");
    assert.equal(profile.height, "");
    assert.equal(profile.sex, "");
    assert.equal(profile.vo2, "");
    assert.deepEqual(parseExplicitVo2ProfileInputs(profile), {});
    assert.deepEqual(parseExplicitVo2ProfileInputs(BLANK_PROFILE), {});
  } finally {
    globalThis.localStorage = previous;
  }
});

test("saved user-confirmed age and weight remain explicit VO2 inputs", () => {
  const parsed = parseExplicitVo2ProfileInputs({ age: "40", weight: "176.37", sex: "female", height: "66", vo2: "" });
  assert.equal(parsed.age_years, 40);
  assert.ok(Math.abs(parsed.weight_kg - 176.37 * PROFILE_WEIGHT_LBS_TO_KG) < 1e-6);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "sex"), false);
});

test("placeholder-like numbers would become VO2 inputs only if actually stored", () => {
  const storedDefaults = parseExplicitVo2ProfileInputs({ age: 25, weight: 150, sex: "male", height: 70, vo2: "" });
  assert.equal(storedDefaults.age_years, 25);
  assert.ok(storedDefaults.weight_kg > 0);
  assert.deepEqual(parseExplicitVo2ProfileInputs(BLANK_PROFILE), {});
});

test("blank legacy profile migrates once to a stable versioned athlete without fabricating demographics", () => {
  const storage = memoryStorage({
    [LEGACY_PROFILE_STORAGE_KEY]: JSON.stringify(BLANK_PROFILE),
  });
  let generated = 0;
  const options = {
    now: "2026-09-21T12:00:00.000Z",
    generateAthleteId: () => `athlete-${++generated}`,
  };
  const first = loadAthleteProfile(storage, options);
  const second = loadAthleteProfile(storage, {
    now: "2026-09-22T12:00:00.000Z",
    generateAthleteId: () => `athlete-${++generated}`,
  });
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.athleteId, "athlete-1");
  assert.deepEqual(first.demographics, {});
  assert.equal(first.userEnteredVo2, undefined);
  assert.deepEqual(second, first);
  assert.equal(generated, 1);
  assert.equal(storage.getItem(LEGACY_PROFILE_STORAGE_KEY), JSON.stringify(BLANK_PROFILE));
  assert.deepEqual(JSON.parse(storage.getItem(ATHLETE_PROFILE_STORAGE_KEY)), first);
});

test("legacy migration retains valid explicit form units and marks entered VO2 unverified", () => {
  const timestamp = "2026-09-21T12:00:00.000Z";
  const migrated = migrateLegacyProfile(
    { age: "40", weight: "176.37", height: "66", sex: "female", vo2: "47.2" },
    "athlete-valid",
    timestamp
  );
  assert.deepEqual(migrated.demographics, {
    ageYears: 40,
    bodyMassLbs: 176.37,
    heightInches: 66,
    sex: "female",
  });
  assert.deepEqual(migrated.userEnteredVo2, {
    value: 47.2,
    source: "user_entered",
    quality: "unverified",
    observedAt: timestamp,
    updatedAt: timestamp,
  });
  assert.deepEqual(athleteProfileToLegacyProfile(migrated), {
    age: 40,
    weight: 176.37,
    height: 66,
    sex: "female",
    vo2: 47.2,
  });
  const inputs = parseExplicitVo2ProfileInputs(migrated);
  assert.equal(inputs.age_years, 40);
  assert.ok(Math.abs(inputs.weight_kg - 176.37 * PROFILE_WEIGHT_LBS_TO_KG) < 1e-9);
});

test("legacy migration keeps valid partial profiles and drops malformed or placeholder-looking values", () => {
  const timestamp = "2026-09-21T12:00:00.000Z";
  assert.deepEqual(
    migrateLegacyProfile({ age: "40", weight: "" }, "age-only", timestamp).demographics,
    { ageYears: 40 }
  );
  assert.deepEqual(
    migrateLegacyProfile({ age: "", weight: "176.37" }, "weight-only", timestamp).demographics,
    { bodyMassLbs: 176.37 }
  );
  assert.deepEqual(
    migrateLegacyProfile({ age: "40", weight: "176.37" }, "both", timestamp).demographics,
    { ageYears: 40, bodyMassLbs: 176.37 }
  );
  const malformed = migrateLegacyProfile(
    { age: "years", weight: "lbs", height: "inches", sex: "select", vo2: "optional" },
    "malformed",
    timestamp
  );
  assert.deepEqual(malformed.demographics, {});
  assert.equal(malformed.userEnteredVo2, undefined);
  assert.deepEqual(parseExplicitVo2ProfileInputs({ age: "years", weight: "lbs" }), {});
});

test("canonical athlete parser rejects unknown schemas and malformed metrics", () => {
  const valid = migrateLegacyProfile(
    { age: 40, weight: 176.37, vo2: 45 },
    "athlete-parser",
    "2026-09-21T12:00:00.000Z"
  );
  assert.deepEqual(parseAthleteProfile(valid), valid);
  assert.equal(parseAthleteProfile({ ...valid, schemaVersion: 2 }), null);
  assert.equal(parseAthleteProfile({ ...valid, athleteId: "" }), null);
  assert.equal(
    parseAthleteProfile({ ...valid, demographics: { ...valid.demographics, ageYears: "40" } }),
    null
  );
  assert.equal(
    parseAthleteProfile({
      ...valid,
      userEnteredVo2: { ...valid.userEnteredVo2, source: "formal_assessment" },
    }),
    null
  );
});

test("historical athlete reader preserves the permanent v1 schema identity", () => {
  const persistedV1 = {
    ...migrateLegacyProfile(
      { age: 40, weight: 176.37, vo2: 45 },
      "athlete-historical-v1",
      "2026-09-20T12:00:00.000Z"
    ),
    schemaVersion: ATHLETE_PROFILE_SCHEMA_VERSION_V1,
  };
  const parsed = parseAthleteProfile(persistedV1);
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, ATHLETE_PROFILE_SCHEMA_VERSION_V1);
  assert.equal(parseAthleteProfile({ ...persistedV1, schemaVersion: 2 }), null);
  assert.equal(parseAthleteProfile({ ...persistedV1, schemaVersion: 999 }), null);
});

test("user-entered VO2 provenance requires updatedAt to be at or after observedAt", () => {
  const base = migrateLegacyProfile(
    { age: 40, weight: 176.37, vo2: 45 },
    "athlete-vo2-order",
    "2026-09-20T12:00:00.000Z"
  );
  const chronological = {
    ...base,
    updatedAt: "2026-09-21T12:00:00.000Z",
    userEnteredVo2: {
      ...base.userEnteredVo2,
      observedAt: "2026-09-20T12:00:00.000Z",
      updatedAt: "2026-09-21T12:00:00.000Z",
    },
  };
  assert.ok(parseAthleteProfile(chronological));
  assert.equal(
    parseAthleteProfile({
      ...chronological,
      userEnteredVo2: {
        ...chronological.userEnteredVo2,
        observedAt: "2026-09-21T12:00:00.000Z",
        updatedAt: "2026-09-20T12:00:00.000Z",
      },
    }),
    null
  );
});

test("malformed profile data cannot rotate an established athlete identity", () => {
  const original = migrateLegacyProfile(
    { age: 40, weight: 176.37, vo2: 45 },
    "athlete-stable-a",
    "2026-09-01T12:00:00.000Z"
  );
  const storage = memoryStorage();
  assert.equal(storeAthleteProfile(original, storage), true);
  storage.removeItem(ATHLETE_IDENTITY_STORAGE_KEY);

  const malformed = { ...original, demographics: { ageYears: "not-an-age" } };
  storage.setItem(ATHLETE_PROFILE_STORAGE_KEY, JSON.stringify(malformed));
  let generated = 0;
  const recovered = loadAthleteProfile(storage, {
    now: "2026-09-21T12:00:00.000Z",
    generateAthleteId: () => `unexpected-${++generated}`,
  });
  assert.equal(recovered.athleteId, original.athleteId);
  assert.equal(generated, 0);

  const conflicting = { ...original, athleteId: "athlete-conflicting-b", demographics: { ageYears: "bad" } };
  storage.setItem(ATHLETE_PROFILE_STORAGE_KEY, JSON.stringify(conflicting));
  const dedicatedWins = loadAthleteProfile(storage, {
    now: "2026-09-22T12:00:00.000Z",
    generateAthleteId: () => `unexpected-${++generated}`,
  });
  assert.equal(
    JSON.parse(storage.getItem(ATHLETE_IDENTITY_STORAGE_KEY)).athleteId,
    original.athleteId
  );
  assert.equal(dedicatedWins.athleteId, original.athleteId);
  assert.equal(generated, 0);
});

test("profile edits preserve unchanged user-entered VO2 provenance and timestamp changed values", () => {
  const originalObservedAt = "2026-09-01T12:00:00.000Z";
  const editTime = "2026-09-21T12:00:00.000Z";
  const original = migrateLegacyProfile(
    { age: 40, weight: 176.37, height: 66, sex: "female", vo2: 47.2 },
    "athlete-vo2-provenance",
    originalObservedAt
  );

  const unrelatedEdit = updateAthleteProfileFromLegacy(
    { age: 41, weight: 176.37, height: 67, sex: "female", vo2: 47.2 },
    original,
    editTime
  );
  assert.deepEqual(unrelatedEdit.userEnteredVo2, original.userEnteredVo2);

  const changedVo2 = updateAthleteProfileFromLegacy(
    { age: 41, weight: 176.37, height: 67, sex: "female", vo2: 48.1 },
    unrelatedEdit,
    editTime
  );
  assert.equal(changedVo2.userEnteredVo2.value, 48.1);
  assert.equal(changedVo2.userEnteredVo2.source, "user_entered");
  assert.equal(changedVo2.userEnteredVo2.quality, "unverified");
  assert.equal(changedVo2.userEnteredVo2.observedAt, editTime);
  assert.equal(changedVo2.userEnteredVo2.updatedAt, editTime);
});

test("HR zones do not use profile age, weight, height, or sex", () => {
  assert.equal(mapHrToZone(100), 1);
  assert.equal(mapHrToZone(120), 2);
  assert.equal(mapHrToZone(140), 3);
  const minutes = calculateZoneMinutes([
    { session_id: "zones", timestamp_sec: 0, hr: 120 },
    { session_id: "zones", timestamp_sec: 1, hr: 120 },
  ]);
  assert.deepEqual(Object.keys(minutes).sort(), ["z1", "z2", "z3", "z4", "z5"]);
  assert.equal(typeof minutes.z1, "number");
  assert.equal(typeof minutes.z2, "number");
});

test("ordinary workout length is independent of blank profile", () => {
  const blocks = { warm: 5, sustain: 25, cool: 5 };
  assert.deepEqual(adjustedBlockLengths(blocks, null), blocks);
  assert.deepEqual(adjustedBlockLengths(blocks, { hrv: 80 }), blocks);
});

test("blank profile cannot produce a VO2 estimate", () => {
  const result = assessVo2(
    {
      schema_version: 1,
      active_duration_sec: 900,
      paused_duration_sec: 0,
      work_end_active_sec: 840,
      cooldown_start_active_sec: 840,
      early_cooldown: false,
      phases: [],
      hr: { source: "ble_chest_strap", sample_count: 10 },
      protocol: {
        protocol_id: "bike-submax-70rpm",
        protocol_version: 1,
        prescribed_cadence_rpm: 70,
        stages: [],
        termination: { reason: "protocol_complete" },
        automatic_submax_hr_ceiling_available: false,
      },
    },
    parseExplicitVo2ProfileInputs(BLANK_PROFILE)
  );
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.reason_codes.includes("missing_profile_age"), true);
  assert.equal(result.reason_codes.includes("missing_profile_weight"), true);
});

test("profile consumers do not use the legacy getProfile accessor", async () => {
  const files = [
    "zoneCalculator.ts",
    "workoutData.ts",
    "workoutLogic.ts",
    "workoutActivity.ts",
    "machines/guidance.ts",
    "machines/runtime.ts",
    "downregulation/index.ts",
    "sisuSync.ts",
  ];
  for (const relative of files) {
    const src = await readFile(new URL("../src/" + relative, import.meta.url), "utf8");
    assert.equal(src.includes("getProfile("), false, relative);
  }
  const workoutLogic = await readFile(new URL("../src/workoutLogic.ts", import.meta.url), "utf8");
  assert.equal(workoutLogic.includes("loadAthleteProfile"), true);
  assert.equal(workoutLogic.includes("getProfile("), false);
  const summary = await readFile(new URL("../src/workoutSummary.ts", import.meta.url), "utf8");
  assert.equal(summary.includes("readExplicitVo2ProfileInputs"), true);
  assert.match(summary, /if \(isVo2WorkoutSelector\(day\)\) \{[\s\S]*readExplicitVo2ProfileInputs/);
});
