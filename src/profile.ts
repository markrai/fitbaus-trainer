import {
  ATHLETE_PROFILE_SCHEMA_VERSION,
  ATHLETE_PROFILE_SCHEMA_VERSION_V1,
  type AthleteIdentity,
  type AthleteProfile,
  type FitnessMetric,
  type Profile,
} from "./types.js";
import {
  VO2_AGE_YEARS_MAX,
  VO2_AGE_YEARS_MIN,
  VO2_ESTIMATE_MAX_ML_KG_MIN,
  VO2_ESTIMATE_MIN_ML_KG_MIN,
  VO2_WEIGHT_KG_MAX,
  VO2_WEIGHT_KG_MIN,
  type Vo2ProfileInputs,
} from "./vo2Estimator.js";
import { generateUUID } from "./utils/uuid.js";

/** Unset physiological fields. Placeholders must not become VO2 estimator inputs. */
export const BLANK_PROFILE: Profile = {
  weight: "",
  height: "",
  age: "",
  sex: "",
  vo2: "",
};

/** Profile weight is entered and retained in pounds. Estimator snapshots kilograms. */
export const PROFILE_WEIGHT_LBS_TO_KG = 0.45359237;
export const ATHLETE_PROFILE_STORAGE_KEY = "athlete_profile_v1";
export const ATHLETE_IDENTITY_STORAGE_KEY = "athlete_identity_v1";
export const LEGACY_PROFILE_STORAGE_KEY = "profile";

const HEIGHT_INCHES_MIN = 24;
const HEIGHT_INCHES_MAX = 108;
const ATHLETE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ProfileStorage {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
}

export interface WritableProfileStorage extends ProfileStorage {
  setItem(key: string, value: string): void;
}

export interface AthleteProfileLoadOptions {
  now?: string;
  generateAthleteId?: () => string;
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isAthleteId(value: unknown): value is string {
  return typeof value === "string" && ATHLETE_ID_PATTERN.test(value);
}

function inRange(value: number | undefined, min: number, max: number): value is number {
  return value != null && value >= min && value <= max;
}

function parseLegacyAge(value: unknown): number | undefined {
  const age = parseFiniteNumber(value);
  return inRange(age, VO2_AGE_YEARS_MIN, VO2_AGE_YEARS_MAX) ? age : undefined;
}

function parseLegacyBodyMassLbs(value: unknown): number | undefined {
  const pounds = parseFiniteNumber(value);
  if (pounds == null) return undefined;
  const kg = pounds * PROFILE_WEIGHT_LBS_TO_KG;
  return inRange(kg, VO2_WEIGHT_KG_MIN, VO2_WEIGHT_KG_MAX) ? pounds : undefined;
}

function parseLegacyHeightInches(value: unknown): number | undefined {
  const height = parseFiniteNumber(value);
  return inRange(height, HEIGHT_INCHES_MIN, HEIGHT_INCHES_MAX) ? height : undefined;
}

function parseLegacySex(value: unknown): "male" | "female" | undefined {
  return value === "male" || value === "female" ? value : undefined;
}

function parseLegacyVo2(value: unknown): number | undefined {
  const vo2 = parseFiniteNumber(value);
  return inRange(vo2, VO2_ESTIMATE_MIN_ML_KG_MIN, VO2_ESTIMATE_MAX_ML_KG_MIN)
    ? vo2
    : undefined;
}

function parseUserEnteredVo2Metric(value: unknown): FitnessMetric<number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Partial<FitnessMetric<number>>;
  if (!isFiniteNumber(row.value) || !inRange(row.value, VO2_ESTIMATE_MIN_ML_KG_MIN, VO2_ESTIMATE_MAX_ML_KG_MIN)) {
    return undefined;
  }
  if (row.source !== "user_entered" || row.quality !== "unverified") return undefined;
  if (!isIsoTimestamp(row.observedAt) || !isIsoTimestamp(row.updatedAt)) return undefined;
  if (Date.parse(row.updatedAt) < Date.parse(row.observedAt)) return undefined;
  return {
    value: row.value,
    source: "user_entered",
    quality: "unverified",
    observedAt: row.observedAt,
    updatedAt: row.updatedAt,
  };
}

/** Strict reader for the permanent v1 athlete profile schema. */
function parseAthleteProfileV1(value: Record<string, unknown>): AthleteProfile | null {
  const row = value as Partial<AthleteProfile>;
  if (!isAthleteId(row.athleteId)) return null;
  if (!isIsoTimestamp(row.createdAt) || !isIsoTimestamp(row.updatedAt)) return null;
  if (Date.parse(row.updatedAt) < Date.parse(row.createdAt)) return null;
  if (!row.demographics || typeof row.demographics !== "object" || Array.isArray(row.demographics)) return null;

  const demographics: AthleteProfile["demographics"] = {};
  const source = row.demographics;
  if (source.ageYears != null) {
    if (!isFiniteNumber(source.ageYears) || !inRange(source.ageYears, VO2_AGE_YEARS_MIN, VO2_AGE_YEARS_MAX)) {
      return null;
    }
    demographics.ageYears = source.ageYears;
  }
  if (source.bodyMassLbs != null) {
    if (
      !isFiniteNumber(source.bodyMassLbs) ||
      !inRange(source.bodyMassLbs * PROFILE_WEIGHT_LBS_TO_KG, VO2_WEIGHT_KG_MIN, VO2_WEIGHT_KG_MAX)
    ) {
      return null;
    }
    demographics.bodyMassLbs = source.bodyMassLbs;
  }
  if (source.heightInches != null) {
    if (!isFiniteNumber(source.heightInches) || !inRange(source.heightInches, HEIGHT_INCHES_MIN, HEIGHT_INCHES_MAX)) {
      return null;
    }
    demographics.heightInches = source.heightInches;
  }
  if (source.sex != null) {
    if (source.sex !== "male" && source.sex !== "female") return null;
    demographics.sex = source.sex;
  }

  let userEnteredVo2: FitnessMetric<number> | undefined;
  if (row.userEnteredVo2 != null) {
    userEnteredVo2 = parseUserEnteredVo2Metric(row.userEnteredVo2);
    if (!userEnteredVo2) return null;
  }

  return {
    schemaVersion: ATHLETE_PROFILE_SCHEMA_VERSION_V1,
    athleteId: row.athleteId,
    demographics,
    ...(userEnteredVo2 ? { userEnteredVo2 } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Dispatch persisted profiles by historical schema, never by the current writer alias. */
export function parseAthleteProfile(value: unknown): AthleteProfile | null {
  if (!isObject(value)) return null;
  switch (value.schemaVersion) {
    case ATHLETE_PROFILE_SCHEMA_VERSION_V1:
      return parseAthleteProfileV1(value);
    default:
      return null;
  }
}

export function parseAthleteIdentity(value: unknown): AthleteIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<AthleteIdentity>;
  if (row.schemaVersion !== 1 || !isAthleteId(row.athleteId) || !isIsoTimestamp(row.createdAt)) return null;
  return { schemaVersion: 1, athleteId: row.athleteId, createdAt: row.createdAt };
}

export function generateAthleteId(): string {
  return generateUUID();
}

/**
 * Migrate only explicit, valid legacy values. Empty strings, UI placeholders,
 * malformed values, and out-of-domain values remain absent.
 */
export function migrateLegacyProfile(
  legacy: unknown,
  athleteId: string,
  timestamp: string
): AthleteProfile {
  const row = legacy && typeof legacy === "object" && !Array.isArray(legacy)
    ? legacy as Partial<Profile>
    : {};
  const demographics: AthleteProfile["demographics"] = {};
  const ageYears = parseLegacyAge(row.age);
  const bodyMassLbs = parseLegacyBodyMassLbs(row.weight);
  const heightInches = parseLegacyHeightInches(row.height);
  const sex = parseLegacySex(row.sex);
  if (ageYears != null) demographics.ageYears = ageYears;
  if (bodyMassLbs != null) demographics.bodyMassLbs = bodyMassLbs;
  if (heightInches != null) demographics.heightInches = heightInches;
  if (sex != null) demographics.sex = sex;

  const userVo2 = parseLegacyVo2(row.vo2);
  return {
    schemaVersion: ATHLETE_PROFILE_SCHEMA_VERSION,
    athleteId,
    demographics,
    ...(userVo2 != null
      ? {
          userEnteredVo2: {
            value: userVo2,
            source: "user_entered" as const,
            quality: "unverified" as const,
            observedAt: timestamp,
            updatedAt: timestamp,
          },
        }
      : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Apply a form edit without changing provenance for an unchanged user-entered VO2 value. */
export function updateAthleteProfileFromLegacy(
  legacy: unknown,
  current: AthleteProfile,
  timestamp: string
): AthleteProfile {
  const updated = migrateLegacyProfile(legacy, current.athleteId, timestamp);
  updated.createdAt = current.createdAt;
  if (
    updated.userEnteredVo2 &&
    current.userEnteredVo2 &&
    updated.userEnteredVo2.value === current.userEnteredVo2.value
  ) {
    updated.userEnteredVo2 = { ...current.userEnteredVo2 };
  }
  return updated;
}

function parseStoredJson(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Recover identity from a canonical envelope even when demographics or metrics are malformed. */
function recoverIdentityFromProfileEnvelope(value: unknown, fallbackCreatedAt: string): AthleteIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<AthleteProfile>;
  if (!isAthleteId(row.athleteId)) return null;
  return {
    schemaVersion: 1,
    athleteId: row.athleteId,
    createdAt: isIsoTimestamp(row.createdAt) ? row.createdAt : fallbackCreatedAt,
  };
}

function laterTimestamp(...values: string[]): string {
  return values.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest);
}

function persistIdentity(identity: AthleteIdentity, storage: ProfileStorage | undefined): boolean {
  if (!storage?.setItem) return false;
  try {
    storage.setItem(ATHLETE_IDENTITY_STORAGE_KEY, JSON.stringify(identity));
    return true;
  } catch {
    return false;
  }
}

/** Load the canonical athlete, or perform one idempotent legacy migration. */
export function loadAthleteProfile(
  storage?: ProfileStorage,
  options: AthleteProfileLoadOptions = {}
): AthleteProfile {
  const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  const now = options.now ?? new Date().toISOString();
  const canonicalValue = parseStoredJson(store?.getItem(ATHLETE_PROFILE_STORAGE_KEY) ?? null);
  const current = parseAthleteProfile(canonicalValue);
  const storedIdentity = parseAthleteIdentity(
    parseStoredJson(store?.getItem(ATHLETE_IDENTITY_STORAGE_KEY) ?? null)
  );
  const envelopeIdentity = recoverIdentityFromProfileEnvelope(canonicalValue, now);
  const identity = storedIdentity ?? envelopeIdentity ?? {
    schemaVersion: 1 as const,
    athleteId: options.generateAthleteId?.() ?? generateAthleteId(),
    createdAt: now,
  };

  if (current) {
    persistIdentity(identity, store);
    if (current.athleteId === identity.athleteId) return current;
    const repaired: AthleteProfile = {
      ...current,
      athleteId: identity.athleteId,
      createdAt: identity.createdAt,
      updatedAt: laterTimestamp(current.updatedAt, identity.createdAt, now),
    };
    if (store?.setItem) {
      try {
        store.setItem(ATHLETE_PROFILE_STORAGE_KEY, JSON.stringify(repaired));
      } catch {
        // The dedicated identity remains authoritative if demographic repair cannot persist.
      }
    }
    return repaired;
  }

  const legacy = parseStoredJson(store?.getItem(LEGACY_PROFILE_STORAGE_KEY) ?? null);
  const migrated = migrateLegacyProfile(legacy, identity.athleteId, now);
  migrated.createdAt = identity.createdAt;
  migrated.updatedAt = laterTimestamp(migrated.updatedAt, identity.createdAt);
  persistIdentity(identity, store);
  if (store?.setItem) {
    try {
      store.setItem(ATHLETE_PROFILE_STORAGE_KEY, JSON.stringify(migrated));
    } catch {
      // Callers can still use the in-memory migration; no legacy data is deleted.
    }
  }
  return migrated;
}

export function storeAthleteProfile(profile: AthleteProfile, storage?: WritableProfileStorage): boolean {
  const parsed = parseAthleteProfile(profile);
  if (!parsed) return false;
  const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  if (!store) return false;
  try {
    const existingIdentity = parseAthleteIdentity(
      parseStoredJson(store.getItem(ATHLETE_IDENTITY_STORAGE_KEY))
    );
    if (existingIdentity && existingIdentity.athleteId !== parsed.athleteId) return false;
    if (!existingIdentity) {
      store.setItem(
        ATHLETE_IDENTITY_STORAGE_KEY,
        JSON.stringify({ schemaVersion: 1, athleteId: parsed.athleteId, createdAt: parsed.createdAt })
      );
    }
    store.setItem(ATHLETE_PROFILE_STORAGE_KEY, JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}

export function athleteProfileToLegacyProfile(profile: AthleteProfile): Profile {
  return {
    weight: profile.demographics.bodyMassLbs ?? "",
    height: profile.demographics.heightInches ?? "",
    age: profile.demographics.ageYears ?? "",
    sex: profile.demographics.sex ?? "",
    vo2: profile.userEnteredVo2?.value ?? "",
  };
}

/** Explicit canonical or legacy age/weight only. Never uses unsaved form defaults. */
export function parseExplicitVo2ProfileInputs(profile: unknown): Vo2ProfileInputs {
  const canonical = parseAthleteProfile(profile);
  const inputs: Vo2ProfileInputs = {};
  if (canonical) {
    if (canonical.demographics.ageYears != null) inputs.age_years = canonical.demographics.ageYears;
    if (canonical.demographics.bodyMassLbs != null) {
      inputs.weight_kg = canonical.demographics.bodyMassLbs * PROFILE_WEIGHT_LBS_TO_KG;
    }
    return inputs;
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return inputs;
  const row = profile as Partial<Profile>;
  const age = parseLegacyAge(row.age);
  const weightLbs = parseLegacyBodyMassLbs(row.weight);
  if (age != null) inputs.age_years = age;
  if (weightLbs != null) inputs.weight_kg = weightLbs * PROFILE_WEIGHT_LBS_TO_KG;
  return inputs;
}

export function readExplicitVo2ProfileInputs(storage?: ProfileStorage): Vo2ProfileInputs {
  const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  if (!store) return {};
  return parseExplicitVo2ProfileInputs(loadAthleteProfile(store));
}

function getProfile(): Profile {
  const store = typeof localStorage !== "undefined" ? localStorage : undefined;
  if (!store) return { ...BLANK_PROFILE };
  return athleteProfileToLegacyProfile(loadAthleteProfile(store));
}

function saveProfile() {
  const feet = (document.getElementById("heightFeet") as HTMLSelectElement | null)?.value ?? "";
  const inches = (document.getElementById("heightInches") as HTMLSelectElement | null)?.value ?? "";
  const totalInches = feet !== "" && inches !== "" ? parseInt(feet) * 12 + parseInt(inches) : "";

  const legacy: Profile = {
    weight: (document.getElementById("weight") as HTMLInputElement | null)?.value ?? "",
    height: totalInches,
    age: (document.getElementById("age") as HTMLInputElement | null)?.value ?? "",
    sex: (document.getElementById("sex") as HTMLSelectElement | null)?.value ?? "",
    vo2: (document.getElementById("vo2") as HTMLInputElement | null)?.value ?? "",
  };
  const current = loadAthleteProfile(localStorage);
  const updatedAt = new Date().toISOString();
  const updated = updateAthleteProfileFromLegacy(legacy, current, updatedAt);
  if (storeAthleteProfile(updated, localStorage)) {
    // Retain a compatibility mirror; canonical reads always prefer the versioned record.
    localStorage.setItem(LEGACY_PROFILE_STORAGE_KEY, JSON.stringify(legacy));
  }
  if (typeof (window as any).closeModal === "function") {
    (window as any).closeModal();
  }
}

function loadProfile() {
  const stored = getProfile();
  const weightEl = document.getElementById("weight") as HTMLInputElement | null;
  if (weightEl) weightEl.value = stored.weight?.toString() ?? "";

  const totalInches = stored.height ? parseInt(stored.height as any) : 0;
  const feetEl = document.getElementById("heightFeet") as HTMLSelectElement | null;
  const inchesEl = document.getElementById("heightInches") as HTMLSelectElement | null;
  if (feetEl && inchesEl) {
    if (totalInches > 0) {
      feetEl.value = String(Math.floor(totalInches / 12));
      inchesEl.value = String(totalInches % 12);
    } else {
      feetEl.value = "";
      inchesEl.value = "";
    }
  }

  const ageEl = document.getElementById("age") as HTMLInputElement | null;
  if (ageEl) ageEl.value = stored.age?.toString() ?? "";
  const sexEl = document.getElementById("sex") as HTMLSelectElement | null;
  if (sexEl) sexEl.value = stored.sex ?? "";
  const vo2El = document.getElementById("vo2") as HTMLInputElement | null;
  if (vo2El) vo2El.value = stored.vo2?.toString() ?? "";
}

export function registerProfileGlobals() {
  (window as any).saveProfile = saveProfile;
  (window as any).loadProfile = loadProfile;
}

export { getProfile, saveProfile, loadProfile };
