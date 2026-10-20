export const BIKE_BRIDGE_STORAGE_KEY = "fitbaus_trainer_bike_bridge";
export const DEFAULT_CONSOLE_BRIGHTNESS = 80;
export const CONSOLE_BRIGHTNESS_MIN = 0;
export const CONSOLE_BRIGHTNESS_MAX = 100;

export interface BikeBridgeSettings {
  baseUrl: string;
  automaticControlEnabled: boolean;
  consoleBrightness: number;
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
  baseUrl: "",
  automaticControlEnabled: false,
  consoleBrightness: DEFAULT_CONSOLE_BRIGHTNESS,
};

export function clampConsoleBrightness(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONSOLE_BRIGHTNESS;
  const rounded = Math.round(value);
  if (rounded < CONSOLE_BRIGHTNESS_MIN) return CONSOLE_BRIGHTNESS_MIN;
  if (rounded > CONSOLE_BRIGHTNESS_MAX) return CONSOLE_BRIGHTNESS_MAX;
  return rounded;
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
      automaticControlEnabled: parsed.automaticControlEnabled === true,
      consoleBrightness: clampConsoleBrightness(parsed.consoleBrightness),
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
    automaticControlEnabled: settings.automaticControlEnabled === true,
    consoleBrightness: clampConsoleBrightness(settings.consoleBrightness),
  };
  (storage ?? defaultBikeBridgeStorage()).setItem(BIKE_BRIDGE_STORAGE_KEY, JSON.stringify(clean));
  return clean;
}
