import { isNativeRuntime } from "./runtime.js";
import { joinBikeBridgeUrl, parseBikeBridgeBaseUrl } from "./bikeBridgeConfig.js";
import { AUTOMATIC_RESISTANCE_MAX, AUTOMATIC_RESISTANCE_MIN, clampAutomaticResistance } from "../machines/proformSmartPower10.js";
export const BIKE_BRIDGE_REQUEST_TIMEOUT_MS = 4000;
export const BRIDGE_HEART_RATE_MIN_BPM = 30;
export const BRIDGE_HEART_RATE_MAX_BPM = 250;
export const BRIDGE_BRIGHTNESS_MIN = 0;
export const BRIDGE_BRIGHTNESS_MAX = 100;
export function toBridgeResistanceLevel(desired) {
    if (!Number.isFinite(desired))
        return undefined;
    const rounded = Math.round(desired);
    if (rounded < AUTOMATIC_RESISTANCE_MIN)
        return undefined;
    return clampAutomaticResistance(rounded);
}
export function toBridgeHeartRateBpm(bpm) {
    if (!Number.isFinite(bpm))
        return undefined;
    const rounded = Math.round(bpm);
    if (rounded < BRIDGE_HEART_RATE_MIN_BPM || rounded > BRIDGE_HEART_RATE_MAX_BPM)
        return undefined;
    return rounded;
}
export function toBridgeBrightness(value) {
    if (!Number.isFinite(value))
        return undefined;
    const rounded = Math.round(value);
    if (rounded < BRIDGE_BRIGHTNESS_MIN || rounded > BRIDGE_BRIGHTNESS_MAX)
        return undefined;
    return rounded;
}
export function createWebBikeBridgeTransport() {
    return {
        async request(request) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), request.timeoutMs);
            try {
                const init = {
                    method: request.method,
                    mode: "cors",
                    signal: controller.signal,
                };
                if (request.jsonBody !== undefined) {
                    init.headers = { "Content-Type": "application/json" };
                    init.body = JSON.stringify(request.jsonBody);
                }
                const response = await fetch(request.url, init);
                return { status: response.status, text: await response.text() };
            }
            finally {
                clearTimeout(timeoutId);
            }
        },
    };
}
async function nativeBikeBridgeRequest(request) {
    const { CapacitorHttp } = await import("@capacitor/core");
    const payload = {
        url: request.url,
        method: request.method,
        connectTimeout: request.timeoutMs,
        readTimeout: request.timeoutMs,
    };
    if (request.jsonBody !== undefined) {
        payload.headers = { "Content-Type": "application/json" };
        payload.data = request.jsonBody;
    }
    const response = await CapacitorHttp.request(payload);
    const data = response.data;
    const text = typeof data === "string" ? data : data == null ? "" : JSON.stringify(data);
    return { status: response.status, text };
}
export function createDefaultBikeBridgeTransport() {
    if (!isNativeRuntime())
        return createWebBikeBridgeTransport();
    return { request: nativeBikeBridgeRequest };
}
export function createBikeBridgeClient(getBaseUrl, transport, timeoutMs = BIKE_BRIDGE_REQUEST_TIMEOUT_MS) {
    async function send(method, path, parse, jsonBody) {
        const parsedUrl = parseBikeBridgeBaseUrl(getBaseUrl());
        if (!isBikeBridgeUrlOk(parsedUrl)) {
            return { ok: false, kind: "not_configured", message: parsedUrl.error };
        }
        try {
            const response = await transport.request({
                method,
                url: joinBikeBridgeUrl(parsedUrl.normalized, path),
                jsonBody,
                timeoutMs,
            });
            const data = parseJsonText(response.text);
            if (response.status < 200 || response.status >= 300) {
                return {
                    ok: false,
                    kind: "http_error",
                    status: response.status,
                    message: errorMessage(data, response.text, response.status),
                };
            }
            const value = parse(data);
            if (value === undefined) {
                return { ok: false, kind: "malformed", status: response.status, message: "malformed response" };
            }
            return { ok: true, value };
        }
        catch (error) {
            return classifyTransportFailure(error);
        }
    }
    return {
        getStatus() {
            return send("GET", "/api/v1/status", parseBridgeStatus);
        },
        getTelemetry() {
            return send("GET", "/api/v1/telemetry", parseBikeTelemetry);
        },
        setResistance(value) {
            const level = toBridgeResistanceLevel(value);
            if (level === undefined) {
                return Promise.resolve({
                    ok: false,
                    kind: "malformed",
                    message: "value must be an integer from " + AUTOMATIC_RESISTANCE_MIN + " to " + AUTOMATIC_RESISTANCE_MAX,
                });
            }
            const body = { value: level };
            return send("POST", "/api/v1/resistance", parseResistanceAccepted, body);
        },
        postHeartRate(value) {
            const bpm = toBridgeHeartRateBpm(value);
            if (bpm === undefined) {
                return Promise.resolve({
                    ok: false,
                    kind: "malformed",
                    message: "value must be an integer from " +
                        BRIDGE_HEART_RATE_MIN_BPM +
                        " to " +
                        BRIDGE_HEART_RATE_MAX_BPM,
                });
            }
            const body = { value: bpm };
            return send("POST", "/api/v1/heartrate", parseResistanceAccepted, body);
        },
        setBrightness(value) {
            const level = toBridgeBrightness(value);
            if (level === undefined) {
                return Promise.resolve({
                    ok: false,
                    kind: "malformed",
                    message: "value must be an integer from " + BRIDGE_BRIGHTNESS_MIN + " to " + BRIDGE_BRIGHTNESS_MAX,
                });
            }
            const body = { value: level };
            return send("POST", "/api/v1/brightness", parseResistanceAccepted, body);
        },
    };
}
export function isBikeBridgeUrlOk(parsed) {
    return parsed.ok === true;
}
export function isBikeBridgeClientOk(result) {
    return result.ok === true;
}
function parseJsonText(text) {
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function errorMessage(data, text, status) {
    if (data && typeof data === "object" && typeof data.error === "string") {
        return data.error;
    }
    if (typeof text === "string" && text.trim())
        return text.trim();
    return "http " + String(status);
}
function classifyTransportFailure(error) {
    const message = error instanceof Error ? error.message : String(error !== null && error !== void 0 ? error : "request failed");
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError" || /timeout/i.test(message)) {
        return { ok: false, kind: "timeout", message: "timeout" };
    }
    return { ok: false, kind: "unreachable", message: message || "unreachable" };
}
function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function optionalInt(value) {
    if (value === null)
        return null;
    if (typeof value === "number" && Number.isInteger(value))
        return value;
    return undefined;
}
function optionalString(value) {
    if (value === null)
        return null;
    if (typeof value === "string")
        return value;
    return undefined;
}
function parseMetric(value) {
    if (!isObject(value))
        return undefined;
    const metricValue = optionalInt(value.value);
    const observedAt = optionalString(value.observedAt);
    if (metricValue === undefined || observedAt === undefined || typeof value.current !== "boolean") {
        return undefined;
    }
    return { value: metricValue, observedAt, current: value.current };
}
export function parseBridgeStatus(data) {
    if (!isObject(data) || !isObject(data.resistance))
        return undefined;
    if (typeof data.status !== "string" || typeof data.bridgeVersion !== "string")
        return undefined;
    if (typeof data.connected !== "boolean" || typeof data.initialized !== "boolean")
        return undefined;
    if (typeof data.resistanceControlAvailable !== "boolean")
        return undefined;
    const requested = optionalInt(data.resistance.requested);
    const requestedAt = optionalString(data.resistance.requestedAt);
    const observed = optionalInt(data.resistance.observed);
    const observedAt = optionalString(data.resistance.observedAt);
    if (requested === undefined ||
        requestedAt === undefined ||
        observed === undefined ||
        observedAt === undefined) {
        return undefined;
    }
    return {
        status: data.status,
        bridgeVersion: data.bridgeVersion,
        connected: data.connected,
        initialized: data.initialized,
        resistanceControlAvailable: data.resistanceControlAvailable,
        resistance: { requested, requestedAt, observed, observedAt },
    };
}
export function parseBikeTelemetry(data) {
    if (!isObject(data))
        return undefined;
    if (typeof data.connected !== "boolean" || typeof data.initialized !== "boolean")
        return undefined;
    if (typeof data.snapshotAt !== "string")
        return undefined;
    const resistance = parseMetric(data.resistance);
    const rpm = parseMetric(data.rpm);
    const watts = parseMetric(data.watts);
    if (!resistance || !rpm || !watts)
        return undefined;
    return {
        connected: data.connected,
        initialized: data.initialized,
        snapshotAt: data.snapshotAt,
        resistance,
        rpm,
        watts,
    };
}
export function parseResistanceAccepted(data) {
    if (!isObject(data))
        return undefined;
    const requested = optionalInt(data.requested);
    if (requested === undefined || requested === null)
        return undefined;
    return { requested };
}
