import { DURABLE_LOCAL_STORAGE_KEYS } from "../persistence/localStorageKeys.js";

export const BIKE_BRIDGE_STORAGE_KEY = DURABLE_LOCAL_STORAGE_KEYS.bikeBridge;
/** Native ProForm console HTTP origin. Primary daily backend; not Legacy, not iFIT. */
export const NATIVE_PROFORM_BRIDGE_ORIGIN = "http://192.168.1.226:8765";
export const DEFAULT_CONSOLE_BRIGHTNESS = 80;
export const CONSOLE_BRIGHTNESS_MIN = 0;
export const CONSOLE_BRIGHTNESS_MAX = 100;
export const BIKE_BRIDGE_PAIRING_TOKEN_LENGTH = 8;

/**
 * Persisted Bike Bridge settings. Automatic resistance control is not a setting: an authorized,
 * active structured bike workout always controls resistance. A legacy persisted
 * `automaticControlEnabled` value is ignored on load and dropped on the next save.
 */
export interface BikeBridgeSettings {
  baseUrl: string;
  consoleBrightness: number;
  pairingToken: string;
}

export interface BikeBridgeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BikeBridgeUrlParseResult {
  ok: true;
  normalized: string;
  configured: string;
}

export interface BikeBridgeUrlParseError {
  ok: false;
  error: string;
}

const DEFAULT_SETTINGS: BikeBridgeSettings = {
  baseUrl: NATIVE_PROFORM_BRIDGE_ORIGIN,
  consoleBrightness: DEFAULT_CONSOLE_BRIGHTNESS,
  pairingToken: "",
};

export function clampConsoleBrightness(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONSOLE_BRIGHTNESS;
  const rounded = Math.round(value);
  if (rounded < CONSOLE_BRIGHTNESS_MIN) return CONSOLE_BRIGHTNESS_MIN;
  if (rounded > CONSOLE_BRIGHTNESS_MAX) return CONSOLE_BRIGHTNESS_MAX;
  return rounded;
}

export function parseBikeBridgePairingToken(
  raw: unknown
): { ok: true; token: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "invalid pairing token" };
  const token = raw.replace(/[\s-]+/g, "").toUpperCase();
  if (!token) return { ok: true, token: "" };
  if (token.length !== BIKE_BRIDGE_PAIRING_TOKEN_LENGTH || !/^[0-9A-Z]+$/.test(token)) {
    return { ok: false, error: "pairing code must be 8 letters or digits" };
  }
  return { ok: true, token };
}

function storedPairingToken(raw: unknown): string {
  const parsed = parseBikeBridgePairingToken(raw);
  return parsed.ok ? parsed.token : "";
}

export function defaultBikeBridgeStorage(): BikeBridgeStorage {
  if (typeof localStorage !== "undefined") return localStorage;
  const values = new Map<string, string>();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

export function parseBikeBridgeBaseUrl(raw: string): BikeBridgeUrlParseResult | BikeBridgeUrlParseError {
  const configured = (raw ?? "").trim();
  if (!configured) {
    return { ok: false, error: "missing url" };
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return { ok: false, error: "invalid url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "url must be http or https" };
  }
  if (!parsed.hostname) {
    return { ok: false, error: "invalid url" };
  }
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    return { ok: false, error: "url must be an origin (no path)" };
  }
  const normalized = parsed.origin;
  return { ok: true, normalized, configured };
}

export function joinBikeBridgeUrl(baseUrl: string, path: string): string {
  return String(baseUrl || "").replace(/\/+$/, "") + path;
}

export function loadBikeBridgeSettings(storage?: BikeBridgeStorage): BikeBridgeSettings {
  try {
    const raw = (storage ?? defaultBikeBridgeStorage()).getItem(BIKE_BRIDGE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
    const baseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "";
    return {
      baseUrl,
      consoleBrightness: clampConsoleBrightness(parsed.consoleBrightness),
      pairingToken: storedPairingToken(parsed.pairingToken),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveBikeBridgeSettings(
  settings: BikeBridgeSettings,
  storage?: BikeBridgeStorage
): BikeBridgeSettings {
  const baseUrl = typeof settings.baseUrl === "string" ? settings.baseUrl.trim() : "";
  const clean: BikeBridgeSettings = {
    baseUrl,
    consoleBrightness: clampConsoleBrightness(settings.consoleBrightness),
    pairingToken: storedPairingToken(settings.pairingToken),
  };
  (storage ?? defaultBikeBridgeStorage()).setItem(BIKE_BRIDGE_STORAGE_KEY, JSON.stringify(clean));
  return clean;
}
