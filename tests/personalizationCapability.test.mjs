import test from "node:test";
import assert from "node:assert/strict";

import {
  PERSONALIZATION_CAPABILITIES_V1,
  PERSONALIZATION_INTENT_CAPABILITIES_V1,
  personalizationShadowPrescriptionEnabledForIntensity,
  personalizationShadowPrescriptionEnabledForIntent,
  personalizationShadowPrescriptionEnabledIntensities,
  personalizationShadowPrescriptionEnabledIntents,
  CROSS_INTENT_SAME_INTENSITY_EVIDENCE_SHARING_V1,
} from "../dist/personalizationCapability.js";
import { PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES } from "../dist/personalizedPrescription.js";

test("shadow prescription is enabled only for aerobic_base and threshold", () => {
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("aerobic_base"), true);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("threshold"), true);

  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("warmup_easy"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("vo2_short"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("vo2_long"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("recovery"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("strength_support"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("cooldown"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity(""), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("unknown_intensity"), false);
});

test("enabled intensities derive from capability rows, not a second allowlist", () => {
  const enabledFromTable = PERSONALIZATION_CAPABILITIES_V1.filter((row) => row.shadowPrescription).map(
    (row) => row.intensityId
  );
  assert.deepEqual(personalizationShadowPrescriptionEnabledIntensities(), enabledFromTable);
  for (const intensityId of personalizationShadowPrescriptionEnabledIntensities()) {
    assert.equal(personalizationShadowPrescriptionEnabledForIntensity(intensityId), true);
  }
});

test("current shadow capability set equals immutable E1 schema-v1 allowedIntensities", () => {
  // Tripwire: if PERSONALIZATION_CAPABILITIES_V1 enables another shadow intensity,
  // current capability behavior no longer fits E1 schema v1 — version the
  // policy/evaluation contract deliberately before widening writes.
  assert.deepEqual(PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES, ["aerobic_base", "threshold"]);
  assert.deepEqual(
    personalizationShadowPrescriptionEnabledIntensities(),
    [...PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES]
  );
});

test("shadow prescription intents enable aerobic_base, aerobic_volume, and threshold only", () => {
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("aerobic_base"), true);
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("aerobic_volume"), true);
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("threshold"), true);

  assert.equal(personalizationShadowPrescriptionEnabledForIntent("vo2_primer"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("vo2_priority"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("support_strength"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("recovery"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("vo2_short"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("vo2_long"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntent(""), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("unknown_intent"), false);

  assert.deepEqual(personalizationShadowPrescriptionEnabledIntents(), [
    "aerobic_base",
    "aerobic_volume",
    "threshold",
  ]);
  const enabledFromTable = PERSONALIZATION_INTENT_CAPABILITIES_V1.filter((row) => row.shadowPrescription).map(
    (row) => row.workoutIntent
  );
  assert.deepEqual(personalizationShadowPrescriptionEnabledIntents(), enabledFromTable);
});

test("intent and intensity shadow capabilities remain orthogonal dimensions", () => {
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("aerobic_volume"), true);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("aerobic_volume"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntent("vo2_short"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("vo2_short"), false);
  assert.equal(CROSS_INTENT_SAME_INTENSITY_EVIDENCE_SHARING_V1, "unresolved");
});
