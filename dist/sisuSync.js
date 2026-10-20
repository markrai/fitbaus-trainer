import { getSisuSettings, storeSisuSettings, clearSisuSettings, initDB } from "./workoutStorage.js";
import { isNativeRuntime } from "./platform/runtime.js";
import { requestSisu } from "./platform/sisuHttp.js";
const SISU_HEALTH_TIMEOUT_MS = 5000;
const SISU_INGEST_TIMEOUT_MS = 10000;
const sisuConnectionState = {
    connected: false,
    lastSync: null,
    hrvBaseline: null,
    syncError: null,
    protocol: null,
    host: null,
    port: null,
};
function isSisuProtocol(value) {
    return value === "https" || value === "http";
}
function getLegacyProtocolFallback() {
    if (isNativeRuntime())
        return "https";
    return window.location.protocol === "https:" ? "https" : "http";
}
function defaultPort(protocol) {
    return protocol === "https" ? 443 : 80;
}
function parsePort(value) {
    const port = typeof value === "number" ? value : parseInt(String(value || ""), 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}
function parseSisuEndpoint(rawHost, rawPort, selectedProtocol, completeUrlUsesDefaultPort) {
    const value = String(rawHost || "").trim();
    if (!value)
        return null;
    const hasCompleteUrl = /^https?:\/\//i.test(value);
    try {
        const parsed = new URL(hasCompleteUrl ? value : `${selectedProtocol}://${value}`);
        const protocolValue = parsed.protocol.replace(":", "").toLowerCase();
        if (!isSisuProtocol(protocolValue) || !parsed.hostname)
            return null;
        const urlPort = parsePort(parsed.port);
        const inputPort = parsePort(rawPort);
        const port = urlPort || (hasCompleteUrl && completeUrlUsesDefaultPort ? null : inputPort) || defaultPort(protocolValue);
        return {
            protocol: protocolValue,
            host: parsed.hostname,
            port,
        };
    }
    catch {
        return null;
    }
}
function formatEndpoint(endpoint) {
    return `${endpoint.protocol}://${endpoint.host}:${endpoint.port}`;
}
function responseData(response) {
    if (typeof response.data !== "string")
        return response.data;
    try {
        return JSON.parse(response.data);
    }
    catch {
        return response.data;
    }
}
function formatConnectionError(error) {
    const err = error;
    if ((err === null || err === void 0 ? void 0 : err.name) === "AbortError" || /timed?\s*out|timeout/i.test((err === null || err === void 0 ? void 0 : err.message) || "")) {
        return "Connection timed out";
    }
    if ((err === null || err === void 0 ? void 0 : err.message) === "Failed to fetch") {
        return "Cannot reach SISU. Check host/port, that SISU is running, and that it allows CORS from this origin.";
    }
    return (err === null || err === void 0 ? void 0 : err.message) || String(error);
}
async function testSisuConnection(endpoint) {
    const url = `${formatEndpoint(endpoint)}/health`;
    try {
        const response = await requestSisu({
            url,
            method: "GET",
            timeoutMs: SISU_HEALTH_TIMEOUT_MS,
        });
        if (!response.ok)
            return { ok: false, error: `HTTP ${response.status}` };
        const data = responseData(response);
        return { ok: (data === null || data === void 0 ? void 0 : data.status) === "ok", error: (data === null || data === void 0 ? void 0 : data.status) === "ok" ? undefined : "Unexpected SISU health response" };
    }
    catch (error) {
        console.error("SISU connection test error:", error);
        return { ok: false, error: formatConnectionError(error) };
    }
}
async function updateSISUStatus(message, connected) {
    const statusEl = document.getElementById("sisuStatus");
    const buttonEl = document.getElementById("sisuConnectButton");
    if (statusEl) {
        statusEl.textContent = message || (connected ? "Connected" : "Not connected");
        statusEl.style.color = connected ? "#3d7cff" : "#888";
    }
    if (buttonEl) {
        buttonEl.textContent = connected ? "Disconnect from SISU" : "Connect to SISU";
        buttonEl.onclick = connected ? disconnectSISU : connectSISU;
    }
    sisuConnectionState.connected = connected;
    sisuConnectionState.lastSync = connected ? new Date() : null;
}
function setEndpointInputs(endpoint) {
    const protocolInput = document.getElementById("sisuProtocol");
    const hostInput = document.getElementById("sisuHost");
    const portInput = document.getElementById("sisuPort");
    if (protocolInput)
        protocolInput.value = endpoint.protocol;
    if (hostInput)
        hostInput.value = endpoint.host;
    if (portInput)
        portInput.value = endpoint.port.toString();
}
function normalizePastedSisuUrl() {
    const protocolInput = document.getElementById("sisuProtocol");
    const hostInput = document.getElementById("sisuHost");
    const portInput = document.getElementById("sisuPort");
    if (!hostInput || !/^https?:\/\//i.test(hostInput.value.trim()))
        return;
    const selectedProtocol = isSisuProtocol(protocolInput === null || protocolInput === void 0 ? void 0 : protocolInput.value) ? protocolInput.value : getLegacyProtocolFallback();
    const endpoint = parseSisuEndpoint(hostInput.value, portInput === null || portInput === void 0 ? void 0 : portInput.value, selectedProtocol, true);
    if (endpoint)
        setEndpointInputs(endpoint);
}
async function loadSisuSettings() {
    try {
        const settings = await getSisuSettings();
        if (!settings) {
            const protocolInput = document.getElementById("sisuProtocol");
            if (protocolInput)
                protocolInput.value = getLegacyProtocolFallback();
            await updateSISUStatus("Not connected", false);
            return null;
        }
        const fallbackProtocol = isSisuProtocol(settings.protocol) ? settings.protocol : getLegacyProtocolFallback();
        const endpoint = parseSisuEndpoint(settings.host, settings.port, fallbackProtocol, false);
        if (!endpoint) {
            await updateSISUStatus("Saved SISU endpoint is invalid", false);
            return settings;
        }
        sisuConnectionState.protocol = endpoint.protocol;
        sisuConnectionState.host = endpoint.host;
        sisuConnectionState.port = endpoint.port;
        setEndpointInputs(endpoint);
        const result = await testSisuConnection(endpoint);
        const statusMessage = result.ok
            ? `Connected to ${formatEndpoint(endpoint)}`
            : result.error || "Settings saved but not connected";
        await updateSISUStatus(statusMessage, result.ok);
        return settings;
    }
    catch (error) {
        console.error("Error loading SISU settings:", error);
        await updateSISUStatus("Error loading settings", false);
        return null;
    }
}
async function connectSISU() {
    normalizePastedSisuUrl();
    const protocolInput = document.getElementById("sisuProtocol");
    const hostInput = document.getElementById("sisuHost");
    const portInput = document.getElementById("sisuPort");
    if (!protocolInput || !hostInput || !portInput) {
        await updateSISUStatus("Input fields not found", false);
        return;
    }
    const protocol = isSisuProtocol(protocolInput.value) ? protocolInput.value : getLegacyProtocolFallback();
    const endpoint = parseSisuEndpoint(hostInput.value, portInput.value, protocol, true);
    if (!endpoint) {
        await updateSISUStatus("Please enter a valid SISU URL, host, and port", false);
        return;
    }
    setEndpointInputs(endpoint);
    const currentHost = window.location.hostname;
    if (endpoint.host === currentHost || (endpoint.host.includes("vo2") && !endpoint.host.includes("sisu"))) {
        await updateSISUStatus(`That looks like this app's host (${endpoint.host}). Enter your SISU host (e.g. sisu.example.com).`, false);
        return;
    }
    try {
        await updateSISUStatus(`Testing ${formatEndpoint(endpoint)}/health ...`, false);
        const result = await testSisuConnection(endpoint);
        if (!result.ok) {
            await updateSISUStatus(result.error || "Connection failed - check host and port", false);
            return;
        }
        const stored = await storeSisuSettings(endpoint.host, endpoint.port, endpoint.protocol);
        if (!stored) {
            await updateSISUStatus("Connection successful but failed to save settings", false);
            return;
        }
        sisuConnectionState.protocol = endpoint.protocol;
        sisuConnectionState.host = endpoint.host;
        sisuConnectionState.port = endpoint.port;
        await updateSISUStatus(`Connected to ${formatEndpoint(endpoint)}`, true);
        const infoEl = document.getElementById("sisuConnectionInfo");
        if (infoEl) {
            infoEl.textContent = `Connected to ${formatEndpoint(endpoint)}`;
            infoEl.style.display = "block";
        }
    }
    catch (error) {
        console.error("SISU connection error:", error);
        await updateSISUStatus("Connection failed: " + formatConnectionError(error), false);
    }
}
async function disconnectSISU() {
    await clearSisuSettings();
    sisuConnectionState.connected = false;
    sisuConnectionState.protocol = null;
    sisuConnectionState.host = null;
    sisuConnectionState.port = null;
    sisuConnectionState.hrvBaseline = null;
    sisuConnectionState.syncError = null;
    const protocolInput = document.getElementById("sisuProtocol");
    const hostInput = document.getElementById("sisuHost");
    const portInput = document.getElementById("sisuPort");
    if (protocolInput)
        protocolInput.value = getLegacyProtocolFallback();
    if (hostInput)
        hostInput.value = "";
    if (portInput)
        portInput.value = "";
    const infoEl = document.getElementById("sisuConnectionInfo");
    if (infoEl)
        infoEl.style.display = "none";
    await updateSISUStatus("Disconnected", false);
}
async function syncHRVBaseline() {
    if (!sisuConnectionState.connected)
        return null;
    return null;
}
async function getTodayHRVFromSISU() {
    if (!sisuConnectionState.connected)
        return null;
    return null;
}
function adjustedBlockLengthsFromSISU(base, todayHRV, baselineHRV) {
    if (!todayHRV || !baselineHRV)
        return base;
    return base;
}
function buildSisuWorkoutPayload(summary) {
    const payload = { ...summary };
    delete payload.app_version;
    delete payload.machine_id;
    delete payload.machine_profile_version;
    delete payload.machine_guidance_trace;
    delete payload.machine_decision_audit;
    delete payload.activity;
    delete payload.shadow_predictions;
    delete payload.shadow_resistance_predictions;
    delete payload.vo2_evidence;
    delete payload.vo2_assessment;
    delete payload.resolved_prescription;
    delete payload.shadow_prescription_evaluation;
    delete payload.shadow_prescription_characterization;
    delete payload.athlete_id;
    delete payload.athlete_fitness_snapshot;
    delete payload.workout_response;
    delete payload.execution_provenance;
    if (typeof payload.day !== "string" || payload.day.trim() === "")
        delete payload.day;
    return payload;
}
async function syncWithSISU() {
    if (!sisuConnectionState.connected)
        return;
    try {
        await syncHRVBaseline();
        sisuConnectionState.lastSync = new Date();
    }
    catch (error) {
        console.error("SISU sync error:", error);
        sisuConnectionState.syncError = error.message;
    }
}
async function sendWorkoutToSisu(sessionId) {
    try {
        const settings = await getSisuSettings();
        if (!settings || !settings.host || !settings.port) {
            return { success: false, message: "SISU not configured. Please connect in Settings > Sync tab." };
        }
        const fallbackProtocol = isSisuProtocol(settings.protocol) ? settings.protocol : getLegacyProtocolFallback();
        const endpoint = parseSisuEndpoint(settings.host, settings.port, fallbackProtocol, false);
        if (!endpoint)
            return { success: false, message: "Saved SISU endpoint is invalid" };
        const database = await initDB();
        const tx = database.transaction(["workouts"], "readonly");
        const store = tx.objectStore("workouts");
        const workoutData = await new Promise((resolve, reject) => {
            const request = store.get(sessionId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        if (!workoutData || !workoutData.summary) {
            return { success: false, message: "Workout not found" };
        }
        const payload = buildSisuWorkoutPayload(workoutData.summary);
        const response = await requestSisu({
            url: `${formatEndpoint(endpoint)}/workout/ingest`,
            method: "POST",
            data: payload,
            timeoutMs: SISU_INGEST_TIMEOUT_MS,
        });
        if (response.ok) {
            const data = responseData(response);
            await storeSisuSettings(endpoint.host, endpoint.port, endpoint.protocol);
            return { success: true, message: `Workout sent to SISU (Load: ${data === null || data === void 0 ? void 0 : data.acuteLoadPoints} points)` };
        }
        const data = responseData(response);
        const message = data && typeof data === "object" && data.message
            ? data.message
            : response.text || `SISU error (${response.status})`;
        return { success: false, message };
    }
    catch (error) {
        console.error("Error sending workout to SISU:", error);
        if (error.name === "AbortError" || /timed?\s*out|timeout/i.test(error.message || "")) {
            return { success: false, message: "Connection timeout - check SISU server" };
        }
        return { success: false, message: "Network error: " + formatConnectionError(error) };
    }
}
export function registerSisuGlobals() {
    window.connectSISU = connectSISU;
    window.disconnectSISU = disconnectSISU;
    window.updateSISUStatus = updateSISUStatus;
    window.syncWithSISU = syncWithSISU;
    window.getTodayHRVFromSISU = getTodayHRVFromSISU;
    window.adjustedBlockLengthsFromSISU = adjustedBlockLengthsFromSISU;
    window.loadSisuSettings = loadSisuSettings;
    window.sendWorkoutToSisu = sendWorkoutToSisu;
    const hostInput = document.getElementById("sisuHost");
    hostInput === null || hostInput === void 0 ? void 0 : hostInput.addEventListener("change", normalizePastedSisuUrl);
    hostInput === null || hostInput === void 0 ? void 0 : hostInput.addEventListener("blur", normalizePastedSisuUrl);
}
export { loadSisuSettings, connectSISU, disconnectSISU, updateSISUStatus, syncWithSISU, getTodayHRVFromSISU, adjustedBlockLengthsFromSISU, buildSisuWorkoutPayload, sendWorkoutToSisu, };
