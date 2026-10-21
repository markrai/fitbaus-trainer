/**
 * Migration JSON serialization domain: deterministic canonical JSON, the
 * supported-value validator (with the single undefined-object-property
 * normalization), and its undefined-property counter.
 */

import { MigrationError } from "./contracts.js";

/**
 * Deterministic code-unit string order for all migration ordering. Never
 * locale collation (localeCompare), whose order varies by runtime/ICU.
 */
export function compareCanonicalText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value) ?? "null";
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalStringify(item ?? null)).join(",") + "]";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(record[k])).join(",") + "}";
  }
  return "null";
}

/**
 * JSON serialization-domain validation. A value is in the supported
 * migration domain if it is null, a boolean, a finite number, a string, an
 * array of such values, or a plain object (Object.prototype / null
 * prototype) of such values — with the single explicit normalization that
 * undefined-valued object properties are treated as absent (counted via
 * countUndefinedProperties and reported as undefined_properties_dropped).
 * Everything else (undefined array elements/keys, NaN/Infinity, bigint,
 * symbol, function, Date, Map/Set, Blob/File, ArrayBuffer/typed
 * arrays/DataView, class instances, cyclic references) is rejected
 * UNSUPPORTED_STORED_VALUE with only the store/primary-key location —
 * never payload contents — and is never coerced.
 */
export function assertMigrationJsonLossless(
  value: unknown,
  location: string,
  ancestors: Set<object> = new Set()
): void {
  const fail = (kind: string): never => {
    throw new MigrationError(
      "UNSUPPORTED_STORED_VALUE",
      `Unsupported stored value (${kind}) at ${location}; export/import blocked without coercion.`
    );
  };
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("non-finite number");
    return;
  }
  if (value === undefined) fail("undefined");
  if (typeof value === "bigint") fail("bigint");
  if (typeof value === "symbol") fail("symbol");
  if (typeof value === "function") fail("function");
  if (typeof value !== "object") fail(typeof value);
  const obj = value as object;
  if (ancestors.has(obj)) fail("cyclic reference");
  if (typeof Date !== "undefined" && obj instanceof Date) fail("Date");
  if (typeof Map !== "undefined" && obj instanceof Map) fail("Map");
  if (typeof Set !== "undefined" && obj instanceof Set) fail("Set");
  if (typeof Blob !== "undefined" && obj instanceof Blob) fail("Blob/File");
  if (typeof ArrayBuffer !== "undefined" && (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj))) {
    fail("ArrayBuffer/typed array/DataView");
  }
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) fail(`undefined array element at index ${i}`);
        assertMigrationJsonLossless(obj[i], location, ancestors);
      }
      return;
    }
    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) fail("non-plain object");
    if (Object.getOwnPropertySymbols(obj).length > 0) fail("symbol-keyed property");
    for (const key of Object.keys(obj)) {
      const child = (obj as Record<string, unknown>)[key];
      // Explicit normalization (Slice 1.1 amendment, real-device data):
      // an undefined-valued object property is treated as ABSENT. JSON has
      // no undefined; reading the property yields undefined either way, and
      // every legacy consumer reads such optional fields by truthiness.
      // The count is reported in the bundle (undefined_properties_dropped),
      // never silently dropped. Undefined array elements, undefined primary
      // keys, and all non-plain/non-finite types below remain hard failures.
      if (child === undefined) continue;
      assertMigrationJsonLossless(child, location, ancestors);
    }
  } finally {
    ancestors.delete(obj);
  }
}

/** Count undefined-valued object properties (normalized to absent, reported). */
export function countUndefinedProperties(value: unknown, ancestors: Set<object> = new Set()): number {
  if (typeof value !== "object" || value === null) return 0;
  if (ancestors.has(value)) return 0;
  ancestors.add(value);
  let count = 0;
  try {
    if (Array.isArray(value)) {
      for (const item of value) count += countUndefinedProperties(item, ancestors);
      return count;
    }
    for (const key of Object.keys(value)) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) count += 1;
      else count += countUndefinedProperties(child, ancestors);
    }
    return count;
  } finally {
    ancestors.delete(value);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
