import {
  formatBikeBridgeNumber,
  type BikeBridgeViewState,
} from "./platform/bikeBridgeRuntime.js";

export type FreestyleObservationHudDocument = {
  getElementById(id: string): HTMLElement | null;
  createElement(tagName: string): HTMLElement;
};

export type FreestyleObservationHudState = Pick<
  BikeBridgeViewState,
  | "readiness"
  | "observedResistance"
  | "observedResistanceCurrent"
  | "rpm"
  | "rpmCurrent"
  | "watts"
  | "wattsCurrent"
  | "telemetryStale"
>;

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

function setTextIfChanged(el: HTMLElement | null, value: string): void {
  if (!el) return;
  if (el.textContent === value) return;
  el.textContent = value;
}

function currentMetricText(
  value: number | null | undefined,
  current: boolean,
  telemetryStale: boolean
): string {
  if (telemetryStale || !current) return "-";
  return formatBikeBridgeNumber(value);
}

function cadenceText(
  value: number | null | undefined,
  current: boolean,
  telemetryStale: boolean
): string {
  const metric = currentMetricText(value, current, telemetryStale);
  return metric === "-" ? "- RPM" : `${metric} RPM`;
}

function wattsText(
  value: number | null | undefined,
  current: boolean,
  telemetryStale: boolean
): string {
  const metric = currentMetricText(value, current, telemetryStale);
  return metric === "-" ? "- W" : `${metric} W`;
}

function liveStatusText(state: FreestyleObservationHudState): string {
  if (state.readiness === "not_configured") return " · Bike Bridge not configured";
  if (state.readiness === "unreachable") return " · Bridge unreachable";
  if (state.readiness === "reachable_disconnected") return " · Bike disconnected";
  if (state.readiness === "reachable_not_initialized") return " · Bike not initialized";
  if (state.readiness === "invalid_response") return " · Invalid bridge response";
  if (state.telemetryStale) return " · waiting for fresh sample";
  return "";
}

function ensureLiveShell(
  live: HTMLElement,
  documentRef: FreestyleObservationHudDocument
): HTMLElement {
  if (live.getAttribute(LIVE_MODE_ATTR) === "1") {
    const existing = live.querySelector(`[${LIVE_STATUS_ATTR}]`);
    if (existing) return existing as HTMLElement;
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

export function clearFreestyleObservationHudOwnership(
  documentRef: FreestyleObservationHudDocument = document
): void {
  const live = documentRef.getElementById(LIVE_ID);
  if (!live) return;
  if (live.getAttribute(LIVE_MODE_ATTR) !== "1") return;
  live.removeAttribute(LIVE_MODE_ATTR);
  live.textContent = "";
}

export function freestyleObservationHudOwnsLiveElement(
  documentRef: FreestyleObservationHudDocument = document
): boolean {
  const live = documentRef.getElementById(LIVE_ID);
  return !!live && live.getAttribute(LIVE_MODE_ATTR) === "1";
}

export function renderFreestyleObservationHud(
  state: FreestyleObservationHudState,
  documentRef: FreestyleObservationHudDocument = document
): void {
  const panel = documentRef.getElementById(PANEL_ID);
  const live = documentRef.getElementById(LIVE_ID);
  if (!panel || !live) return;
  panel.hidden = false;
  setTextIfChanged(documentRef.getElementById(NAME_ID), NAME_LABEL);
  setTextIfChanged(
    documentRef.getElementById(RESISTANCE_ID),
    currentMetricText(
      state.observedResistance,
      state.observedResistanceCurrent,
      state.telemetryStale
    )
  );
  setTextIfChanged(
    documentRef.getElementById(CADENCE_ID),
    cadenceText(state.rpm, state.rpmCurrent, state.telemetryStale)
  );
  const watts = documentRef.getElementById(WATTS_ID);
  if (watts) {
    watts.hidden = false;
    setTextIfChanged(
      watts,
      wattsText(state.watts, state.wattsCurrent, state.telemetryStale)
    );
  }
  live.hidden = false;
  const status = ensureLiveShell(live, documentRef);
  setTextIfChanged(status, liveStatusText(state));
}

export function hideFreestyleObservationHud(
  documentRef: FreestyleObservationHudDocument = document
): void {
  const panel = documentRef.getElementById(PANEL_ID);
  const live = documentRef.getElementById(LIVE_ID);
  clearFreestyleObservationHudOwnership(documentRef);
  if (live) {
    live.hidden = true;
    live.textContent = "";
  }
  if (panel) panel.hidden = true;
}
