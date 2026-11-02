import {
  formatBikeBridgeNumber,
  type BikeBridgeViewState,
  type FreestyleResistanceHoldStatus,
} from "./platform/bikeBridgeRuntime.js";

export type FreestyleObservationHudDocument = {
  getElementById(id: string): HTMLElement | null;
  createElement(tagName: string): HTMLElement;
};

type HoldHost = HTMLElement & {
  querySelector(selectors: string): HTMLElement | null;
  append(...nodes: HTMLElement[]): void;
};

type HoldButton = HTMLElement & {
  addEventListener?(type: string, listener: () => void): void;
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
  | "freestyleHoldStatus"
  | "freestyleHoldTarget"
>;

export type FreestyleObservationHudOptions = {
  onReleaseHold?: () => void;
  onEnableHold?: () => void;
};

const PANEL_ID = "machineGuidance";
const NAME_ID = "machineGuidanceName";
const RESISTANCE_ID = "machineGuidanceResistance";
const CADENCE_ID = "machineGuidanceCadence";
const WATTS_ID = "machineGuidanceWatts";
const LIVE_ID = "machineGuidanceBikeLive";
const HOLD_ID = "machineGuidanceHold";
const LIVE_MODE_ATTR = "data-freestyle-live";
const LIVE_STATUS_ATTR = "data-freestyle-live-status";
const HOLD_STATUS_ATTR = "data-freestyle-hold-status";
const HOLD_RELEASE_ATTR = "data-freestyle-hold-release";
const HOLD_ENABLE_ATTR = "data-freestyle-hold-enable";
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

export function formatFreestyleHoldStatusText(
  status: FreestyleResistanceHoldStatus,
  target: number | null | undefined
): string {
  if (status === "holding" && target !== null && target !== undefined) {
    return `Hold R${target}`;
  }
  if (status === "released") return "Hold released";
  if (status === "unavailable" && target !== null && target !== undefined) {
    return `Hold R${target} unavailable`;
  }
  if (status === "suspended") {
    return target !== null && target !== undefined
      ? `Hold R${target} suspended — bike not retaining`
      : "Hold suspended — bike not retaining";
  }
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

function ensureHoldShell(
  panel: HoldHost,
  documentRef: FreestyleObservationHudDocument,
  options: FreestyleObservationHudOptions
): { root: HTMLElement; status: HTMLElement; release: HTMLElement; enable: HTMLElement } {
  let hold = documentRef.getElementById(HOLD_ID) as HoldHost | null;
  if (!hold) {
    hold = documentRef.createElement("div") as HoldHost;
    hold.id = HOLD_ID;
    hold.className = "machine-guidance-hold";
    panel.append(hold);
  }
  let status = hold.querySelector(`[${HOLD_STATUS_ATTR}]`) as HTMLElement | null;
  let release = hold.querySelector(`[${HOLD_RELEASE_ATTR}]`) as HoldButton | null;
  let enable = hold.querySelector(`[${HOLD_ENABLE_ATTR}]`) as HoldButton | null;
  if (!status || !release || !enable) {
    hold.textContent = "";
    status = documentRef.createElement("div");
    status.setAttribute(HOLD_STATUS_ATTR, "1");
    status.className = "machine-guidance-hold-status";
    release = documentRef.createElement("button") as HoldButton;
    release.setAttribute(HOLD_RELEASE_ATTR, "1");
    release.setAttribute("type", "button");
    release.className = "machine-guidance-hold-release";
    release.textContent = "Release hold";
    enable = documentRef.createElement("button") as HoldButton;
    enable.setAttribute(HOLD_ENABLE_ATTR, "1");
    enable.setAttribute("type", "button");
    enable.className = "machine-guidance-hold-enable";
    enable.textContent = "Enable hold";
    hold.append(status, release, enable);
    if (options.onReleaseHold && typeof release.addEventListener === "function") {
      release.addEventListener("click", () => {
        options.onReleaseHold?.();
      });
    }
    if (options.onEnableHold && typeof enable.addEventListener === "function") {
      enable.addEventListener("click", () => {
        options.onEnableHold?.();
      });
    }
  }
  return { root: hold, status, release, enable };
}

export function clearFreestyleObservationHudOwnership(
  documentRef: FreestyleObservationHudDocument = document
): void {
  const live = documentRef.getElementById(LIVE_ID);
  if (live && live.getAttribute(LIVE_MODE_ATTR) === "1") {
    live.removeAttribute(LIVE_MODE_ATTR);
    live.textContent = "";
  }
  const hold = documentRef.getElementById(HOLD_ID);
  if (hold) {
    hold.hidden = true;
    hold.textContent = "";
  }
}

export function freestyleObservationHudOwnsLiveElement(
  documentRef: FreestyleObservationHudDocument = document
): boolean {
  const live = documentRef.getElementById(LIVE_ID);
  return !!live && live.getAttribute(LIVE_MODE_ATTR) === "1";
}

export function renderFreestyleObservationHud(
  state: FreestyleObservationHudState,
  documentRef: FreestyleObservationHudDocument = document,
  options: FreestyleObservationHudOptions = {}
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

  const holdText = formatFreestyleHoldStatusText(
    state.freestyleHoldStatus ?? "inactive",
    state.freestyleHoldTarget ?? null
  );
  const showRelease =
    state.freestyleHoldStatus === "holding" ||
    state.freestyleHoldStatus === "suspended" ||
    (state.freestyleHoldStatus === "unavailable" &&
      state.freestyleHoldTarget !== null &&
      state.freestyleHoldTarget !== undefined);
  const showEnable = state.freestyleHoldStatus === "released";
  if (holdText || showRelease || showEnable) {
    const hold = ensureHoldShell(panel as HoldHost, documentRef, options);
    hold.status.hidden = !holdText;
    setTextIfChanged(hold.status, holdText);
    hold.release.hidden = !showRelease;
    hold.enable.hidden = !showEnable;
    hold.root.hidden = false;
  } else {
    const holdRoot = documentRef.getElementById(HOLD_ID);
    if (holdRoot) holdRoot.hidden = true;
  }
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
