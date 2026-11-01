import { formatBikeBridgeNumber, } from "./platform/bikeBridgeRuntime.js";
const PANEL_ID = "machineGuidance";
const NAME_ID = "machineGuidanceName";
const RESISTANCE_ID = "machineGuidanceResistance";
const CADENCE_ID = "machineGuidanceCadence";
const WATTS_ID = "machineGuidanceWatts";
const LIVE_ID = "machineGuidanceBikeLive";
const LIVE_MODE_ATTR = "data-freestyle-live";
const LIVE_STATUS_ATTR = "data-freestyle-live-status";
const LIVE_LABEL = "Live telemetry";
const NAME_LABEL = "Freestyle observation";
function setTextIfChanged(el, value) {
    if (!el)
        return;
    if (el.textContent === value)
        return;
    el.textContent = value;
}
function currentMetricText(value, current, telemetryStale) {
    if (telemetryStale || !current)
        return "-";
    return formatBikeBridgeNumber(value);
}
function cadenceText(value, current, telemetryStale) {
    const metric = currentMetricText(value, current, telemetryStale);
    return metric === "-" ? "- RPM" : `${metric} RPM`;
}
function wattsText(value, current, telemetryStale) {
    const metric = currentMetricText(value, current, telemetryStale);
    return metric === "-" ? "- W" : `${metric} W`;
}
function liveStatusText(state) {
    if (state.readiness === "not_configured")
        return " · Bike Bridge not configured";
    if (state.readiness === "unreachable")
        return " · Bridge unreachable";
    if (state.readiness === "reachable_disconnected")
        return " · Bike disconnected";
    if (state.readiness === "reachable_not_initialized")
        return " · Bike not initialized";
    if (state.readiness === "invalid_response")
        return " · Invalid bridge response";
    if (state.telemetryStale)
        return " · waiting for fresh sample";
    return "";
}
function ensureLiveShell(live, documentRef) {
    if (live.getAttribute(LIVE_MODE_ATTR) === "1") {
        const existing = live.querySelector(`[${LIVE_STATUS_ATTR}]`);
        if (existing)
            return existing;
    }
    live.setAttribute(LIVE_MODE_ATTR, "1");
    live.textContent = "";
    const label = documentRef.createElement("span");
    label.textContent = LIVE_LABEL;
    const status = documentRef.createElement("span");
    status.setAttribute(LIVE_STATUS_ATTR, "1");
    live.append(label, status);
    return status;
}
export function clearFreestyleObservationHudOwnership(documentRef = document) {
    const live = documentRef.getElementById(LIVE_ID);
    if (!live)
        return;
    if (live.getAttribute(LIVE_MODE_ATTR) !== "1")
        return;
    live.removeAttribute(LIVE_MODE_ATTR);
    live.textContent = "";
}
export function freestyleObservationHudOwnsLiveElement(documentRef = document) {
    const live = documentRef.getElementById(LIVE_ID);
    return !!live && live.getAttribute(LIVE_MODE_ATTR) === "1";
}
export function renderFreestyleObservationHud(state, documentRef = document) {
    const panel = documentRef.getElementById(PANEL_ID);
    const live = documentRef.getElementById(LIVE_ID);
    if (!panel || !live)
        return;
    panel.hidden = false;
    setTextIfChanged(documentRef.getElementById(NAME_ID), NAME_LABEL);
    setTextIfChanged(documentRef.getElementById(RESISTANCE_ID), currentMetricText(state.observedResistance, state.observedResistanceCurrent, state.telemetryStale));
    setTextIfChanged(documentRef.getElementById(CADENCE_ID), cadenceText(state.rpm, state.rpmCurrent, state.telemetryStale));
    const watts = documentRef.getElementById(WATTS_ID);
    if (watts) {
        watts.hidden = false;
        setTextIfChanged(watts, wattsText(state.watts, state.wattsCurrent, state.telemetryStale));
    }
    live.hidden = false;
    const status = ensureLiveShell(live, documentRef);
    setTextIfChanged(status, liveStatusText(state));
}
export function hideFreestyleObservationHud(documentRef = document) {
    const panel = documentRef.getElementById(PANEL_ID);
    const live = documentRef.getElementById(LIVE_ID);
    clearFreestyleObservationHudOwnership(documentRef);
    if (live) {
        live.hidden = true;
        live.textContent = "";
    }
    if (panel)
        panel.hidden = true;
}
