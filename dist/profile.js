import { ATHLETE_PROFILE_SCHEMA_VERSION, ATHLETE_PROFILE_SCHEMA_VERSION_V1, } from "./types.js";
import { VO2_AGE_YEARS_MAX, VO2_AGE_YEARS_MIN, VO2_ESTIMATE_MAX_ML_KG_MIN, VO2_ESTIMATE_MIN_ML_KG_MIN, VO2_WEIGHT_KG_MAX, VO2_WEIGHT_KG_MIN, } from "./vo2Estimator.js";
import { generateUUID } from "./utils/uuid.js";
/** Unset physiological fields. Placeholders must not become VO2 estimator inputs. */
export const BLANK_PROFILE = {
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
function parseFiniteNumber(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function isIsoTimestamp(value) {
    if (typeof value !== "string" || value === "")
        return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function isAthleteId(value) {
    return typeof value === "string" && ATHLETE_ID_PATTERN.test(value);
}
function inRange(value, min, max) {
    return value != null && value >= min && value <= max;
}
function parseLegacyAge(value) {
    const age = parseFiniteNumber(value);
    return inRange(age, VO2_AGE_YEARS_MIN, VO2_AGE_YEARS_MAX) ? age : undefined;
}
function parseLegacyBodyMassLbs(value) {
    const pounds = parseFiniteNumber(value);
    if (pounds == null)
        return undefined;
    const kg = pounds * PROFILE_WEIGHT_LBS_TO_KG;
    return inRange(kg, VO2_WEIGHT_KG_MIN, VO2_WEIGHT_KG_MAX) ? pounds : undefined;
}
function parseLegacyHeightInches(value) {
    const height = parseFiniteNumber(value);
    return inRange(height, HEIGHT_INCHES_MIN, HEIGHT_INCHES_MAX) ? height : undefined;
}
function parseLegacySex(value) {
    return value === "male" || value === "female" ? value : undefined;
}
function parseLegacyVo2(value) {
    const vo2 = parseFiniteNumber(value);
    return inRange(vo2, VO2_ESTIMATE_MIN_ML_KG_MIN, VO2_ESTIMATE_MAX_ML_KG_MIN)
        ? vo2
        : undefined;
}
function parseUserEnteredVo2Metric(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const row = value;
    if (!isFiniteNumber(row.value) || !inRange(row.value, VO2_ESTIMATE_MIN_ML_KG_MIN, VO2_ESTIMATE_MAX_ML_KG_MIN)) {
        return undefined;
    }
    if (row.source !== "user_entered" || row.quality !== "unverified")
        return undefined;
    if (!isIsoTimestamp(row.observedAt) || !isIsoTimestamp(row.updatedAt))
        return undefined;
    if (Date.parse(row.updatedAt) < Date.parse(row.observedAt))
        return undefined;
    return {
        value: row.value,
        source: "user_entered",
        quality: "unverified",
        observedAt: row.observedAt,
        updatedAt: row.updatedAt,
    };
}
/** Strict reader for the permanent v1 athlete profile schema. */
function parseAthleteProfileV1(value) {
    const row = value;
    if (!isAthleteId(row.athleteId))
        return null;
    if (!isIsoTimestamp(row.createdAt) || !isIsoTimestamp(row.updatedAt))
        return null;
    if (Date.parse(row.updatedAt) < Date.parse(row.createdAt))
        return null;
    if (!row.demographics || typeof row.demographics !== "object" || Array.isArray(row.demographics))
        return null;
    const demographics = {};
    const source = row.demographics;
    if (source.ageYears != null) {
        if (!isFiniteNumber(source.ageYears) || !inRange(source.ageYears, VO2_AGE_YEARS_MIN, VO2_AGE_YEARS_MAX)) {
            return null;
        }
        demographics.ageYears = source.ageYears;
    }
    if (source.bodyMassLbs != null) {
        if (!isFiniteNumber(source.bodyMassLbs) ||
            !inRange(source.bodyMassLbs * PROFILE_WEIGHT_LBS_TO_KG, VO2_WEIGHT_KG_MIN, VO2_WEIGHT_KG_MAX)) {
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
        if (source.sex !== "male" && source.sex !== "female")
            return null;
        demographics.sex = source.sex;
    }
    let userEnteredVo2;
    if (row.userEnteredVo2 != null) {
        userEnteredVo2 = parseUserEnteredVo2Metric(row.userEnteredVo2);
        if (!userEnteredVo2)
            return null;
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
export function parseAthleteProfile(value) {
    if (!isObject(value))
        return null;
    switch (value.schemaVersion) {
        case ATHLETE_PROFILE_SCHEMA_VERSION_V1:
            return parseAthleteProfileV1(value);
        default:
            return null;
    }
}
export function parseAthleteIdentity(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const row = value;
    if (row.schemaVersion !== 1 || !isAthleteId(row.athleteId) || !isIsoTimestamp(row.createdAt))
        return null;
    return { schemaVersion: 1, athleteId: row.athleteId, createdAt: row.createdAt };
}
export function generateAthleteId() {
    return generateUUID();
}
/**
 * Migrate only explicit, valid legacy values. Empty strings, UI placeholders,
 * malformed values, and out-of-domain values remain absent.
 */
export function migrateLegacyProfile(legacy, athleteId, timestamp) {
    const row = legacy && typeof legacy === "object" && !Array.isArray(legacy)
        ? legacy
        : {};
    const demographics = {};
    const ageYears = parseLegacyAge(row.age);
    const bodyMassLbs = parseLegacyBodyMassLbs(row.weight);
    const heightInches = parseLegacyHeightInches(row.height);
    const sex = parseLegacySex(row.sex);
    if (ageYears != null)
        demographics.ageYears = ageYears;
    if (bodyMassLbs != null)
        demographics.bodyMassLbs = bodyMassLbs;
    if (heightInches != null)
        demographics.heightInches = heightInches;
    if (sex != null)
        demographics.sex = sex;
    const userVo2 = parseLegacyVo2(row.vo2);
    return {
        schemaVersion: ATHLETE_PROFILE_SCHEMA_VERSION,
        athleteId,
        demographics,
        ...(userVo2 != null
            ? {
                userEnteredVo2: {
                    value: userVo2,
                    source: "user_entered",
                    quality: "unverified",
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
export function updateAthleteProfileFromLegacy(legacy, current, timestamp) {
    const updated = migrateLegacyProfile(legacy, current.athleteId, timestamp);
    updated.createdAt = current.createdAt;
    if (updated.userEnteredVo2 &&
        current.userEnteredVo2 &&
        updated.userEnteredVo2.value === current.userEnteredVo2.value) {
        updated.userEnteredVo2 = { ...current.userEnteredVo2 };
    }
    return updated;
}
function parseStoredJson(raw) {
    if (!raw)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
/** Recover identity from a canonical envelope even when demographics or metrics are malformed. */
function recoverIdentityFromProfileEnvelope(value, fallbackCreatedAt) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const row = value;
    if (!isAthleteId(row.athleteId))
        return null;
    return {
        schemaVersion: 1,
        athleteId: row.athleteId,
        createdAt: isIsoTimestamp(row.createdAt) ? row.createdAt : fallbackCreatedAt,
    };
}
function laterTimestamp(...values) {
    return values.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest);
}
function persistIdentity(identity, storage) {
    if (!(storage === null || storage === void 0 ? void 0 : storage.setItem))
        return false;
    try {
        storage.setItem(ATHLETE_IDENTITY_STORAGE_KEY, JSON.stringify(identity));
        return true;
    }
    catch {
        return false;
    }
}
/** Load the canonical athlete, or perform one idempotent legacy migration. */
export function loadAthleteProfile(storage, options = {}) {
    var _a, _b, _c, _d, _e, _f, _g;
    const store = storage !== null && storage !== void 0 ? storage : (typeof localStorage !== "undefined" ? localStorage : undefined);
    const now = (_a = options.now) !== null && _a !== void 0 ? _a : new Date().toISOString();
    const canonicalValue = parseStoredJson((_b = store === null || store === void 0 ? void 0 : store.getItem(ATHLETE_PROFILE_STORAGE_KEY)) !== null && _b !== void 0 ? _b : null);
    const current = parseAthleteProfile(canonicalValue);
    const storedIdentity = parseAthleteIdentity(parseStoredJson((_c = store === null || store === void 0 ? void 0 : store.getItem(ATHLETE_IDENTITY_STORAGE_KEY)) !== null && _c !== void 0 ? _c : null));
    const envelopeIdentity = recoverIdentityFromProfileEnvelope(canonicalValue, now);
    const identity = (_d = storedIdentity !== null && storedIdentity !== void 0 ? storedIdentity : envelopeIdentity) !== null && _d !== void 0 ? _d : {
        schemaVersion: 1,
        athleteId: (_f = (_e = options.generateAthleteId) === null || _e === void 0 ? void 0 : _e.call(options)) !== null && _f !== void 0 ? _f : generateAthleteId(),
        createdAt: now,
    };
    if (current) {
        persistIdentity(identity, store);
        if (current.athleteId === identity.athleteId)
            return current;
        const repaired = {
            ...current,
            athleteId: identity.athleteId,
            createdAt: identity.createdAt,
            updatedAt: laterTimestamp(current.updatedAt, identity.createdAt, now),
        };
        if (store === null || store === void 0 ? void 0 : store.setItem) {
            try {
                store.setItem(ATHLETE_PROFILE_STORAGE_KEY, JSON.stringify(repaired));
            }
            catch {
                // The dedicated identity remains authoritative if demographic repair cannot persist.
            }
        }
        return repaired;
    }
    const legacy = parseStoredJson((_g = store === null || store === void 0 ? void 0 : store.getItem(LEGACY_PROFILE_STORAGE_KEY)) !== null && _g !== void 0 ? _g : null);
    const migrated = migrateLegacyProfile(legacy, identity.athleteId, now);
    migrated.createdAt = identity.createdAt;
    migrated.updatedAt = laterTimestamp(migrated.updatedAt, identity.createdAt);
    persistIdentity(identity, store);
    if (store === null || store === void 0 ? void 0 : store.setItem) {
        try {
            store.setItem(ATHLETE_PROFILE_STORAGE_KEY, JSON.stringify(migrated));
        }
        catch {
            // Callers can still use the in-memory migration; no legacy data is deleted.
        }
    }
    return migrated;
}
export function storeAthleteProfile(profile, storage) {
    const parsed = parseAthleteProfile(profile);
    if (!parsed)
        return false;
    const store = storage !== null && storage !== void 0 ? storage : (typeof localStorage !== "undefined" ? localStorage : undefined);
    if (!store)
        return false;
    try {
        const existingIdentity = parseAthleteIdentity(parseStoredJson(store.getItem(ATHLETE_IDENTITY_STORAGE_KEY)));
        if (existingIdentity && existingIdentity.athleteId !== parsed.athleteId)
            return false;
        if (!existingIdentity) {
            store.setItem(ATHLETE_IDENTITY_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, athleteId: parsed.athleteId, createdAt: parsed.createdAt }));
        }
        store.setItem(ATHLETE_PROFILE_STORAGE_KEY, JSON.stringify(parsed));
        return true;
    }
    catch {
        return false;
    }
}
export function athleteProfileToLegacyProfile(profile) {
    var _a, _b, _c, _d, _e, _f;
    return {
        weight: (_a = profile.demographics.bodyMassLbs) !== null && _a !== void 0 ? _a : "",
        height: (_b = profile.demographics.heightInches) !== null && _b !== void 0 ? _b : "",
        age: (_c = profile.demographics.ageYears) !== null && _c !== void 0 ? _c : "",
        sex: (_d = profile.demographics.sex) !== null && _d !== void 0 ? _d : "",
        vo2: (_f = (_e = profile.userEnteredVo2) === null || _e === void 0 ? void 0 : _e.value) !== null && _f !== void 0 ? _f : "",
    };
}
/** Explicit canonical or legacy age/weight only. Never uses unsaved form defaults. */
export function parseExplicitVo2ProfileInputs(profile) {
    const canonical = parseAthleteProfile(profile);
    const inputs = {};
    if (canonical) {
        if (canonical.demographics.ageYears != null)
            inputs.age_years = canonical.demographics.ageYears;
        if (canonical.demographics.bodyMassLbs != null) {
            inputs.weight_kg = canonical.demographics.bodyMassLbs * PROFILE_WEIGHT_LBS_TO_KG;
        }
        return inputs;
    }
    if (!profile || typeof profile !== "object" || Array.isArray(profile))
        return inputs;
    const row = profile;
    const age = parseLegacyAge(row.age);
    const weightLbs = parseLegacyBodyMassLbs(row.weight);
    if (age != null)
        inputs.age_years = age;
    if (weightLbs != null)
        inputs.weight_kg = weightLbs * PROFILE_WEIGHT_LBS_TO_KG;
    return inputs;
}
export function readExplicitVo2ProfileInputs(storage) {
    const store = storage !== null && storage !== void 0 ? storage : (typeof localStorage !== "undefined" ? localStorage : undefined);
    if (!store)
        return {};
    return parseExplicitVo2ProfileInputs(loadAthleteProfile(store));
}
function getProfile() {
    const store = typeof localStorage !== "undefined" ? localStorage : undefined;
    if (!store)
        return { ...BLANK_PROFILE };
    return athleteProfileToLegacyProfile(loadAthleteProfile(store));
}
function saveProfile() {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    const feet = (_b = (_a = document.getElementById("heightFeet")) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : "";
    const inches = (_d = (_c = document.getElementById("heightInches")) === null || _c === void 0 ? void 0 : _c.value) !== null && _d !== void 0 ? _d : "";
    const totalInches = feet !== "" && inches !== "" ? parseInt(feet) * 12 + parseInt(inches) : "";
    const legacy = {
        weight: (_f = (_e = document.getElementById("weight")) === null || _e === void 0 ? void 0 : _e.value) !== null && _f !== void 0 ? _f : "",
        height: totalInches,
        age: (_h = (_g = document.getElementById("age")) === null || _g === void 0 ? void 0 : _g.value) !== null && _h !== void 0 ? _h : "",
        sex: (_k = (_j = document.getElementById("sex")) === null || _j === void 0 ? void 0 : _j.value) !== null && _k !== void 0 ? _k : "",
        vo2: (_m = (_l = document.getElementById("vo2")) === null || _l === void 0 ? void 0 : _l.value) !== null && _m !== void 0 ? _m : "",
    };
    const current = loadAthleteProfile(localStorage);
    const updatedAt = new Date().toISOString();
    const updated = updateAthleteProfileFromLegacy(legacy, current, updatedAt);
    if (storeAthleteProfile(updated, localStorage)) {
        // Retain a compatibility mirror; canonical reads always prefer the versioned record.
        localStorage.setItem(LEGACY_PROFILE_STORAGE_KEY, JSON.stringify(legacy));
    }
    if (typeof window.closeModal === "function") {
        window.closeModal();
    }
}
function loadProfile() {
    var _a, _b, _c, _d, _e, _f, _g;
    const stored = getProfile();
    const weightEl = document.getElementById("weight");
    if (weightEl)
        weightEl.value = (_b = (_a = stored.weight) === null || _a === void 0 ? void 0 : _a.toString()) !== null && _b !== void 0 ? _b : "";
    const totalInches = stored.height ? parseInt(stored.height) : 0;
    const feetEl = document.getElementById("heightFeet");
    const inchesEl = document.getElementById("heightInches");
    if (feetEl && inchesEl) {
        if (totalInches > 0) {
            feetEl.value = String(Math.floor(totalInches / 12));
            inchesEl.value = String(totalInches % 12);
        }
        else {
            feetEl.value = "";
            inchesEl.value = "";
        }
    }
    const ageEl = document.getElementById("age");
    if (ageEl)
        ageEl.value = (_d = (_c = stored.age) === null || _c === void 0 ? void 0 : _c.toString()) !== null && _d !== void 0 ? _d : "";
    const sexEl = document.getElementById("sex");
    if (sexEl)
        sexEl.value = (_e = stored.sex) !== null && _e !== void 0 ? _e : "";
    const vo2El = document.getElementById("vo2");
    if (vo2El)
        vo2El.value = (_g = (_f = stored.vo2) === null || _f === void 0 ? void 0 : _f.toString()) !== null && _g !== void 0 ? _g : "";
}
export function registerProfileGlobals() {
    window.saveProfile = saveProfile;
    window.loadProfile = loadProfile;
}
export { getProfile, saveProfile, loadProfile };
