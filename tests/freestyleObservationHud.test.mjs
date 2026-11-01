import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  clearFreestyleObservationHudOwnership,
  freestyleObservationHudOwnsLiveElement,
  hideFreestyleObservationHud,
  renderFreestyleObservationHud,
} from "../dist/freestyleObservationHud.js";

function el(tag = "div") {
  const attrs = new Map();
  const children = [];
  const node = {
    tagName: tag.toUpperCase(),
    hidden: true,
    innerHTML: "",
    childNodes: children,
    _text: "",
    setAttribute(name, value) {
      attrs.set(String(name), String(value));
    },
    getAttribute(name) {
      return attrs.has(String(name)) ? attrs.get(String(name)) : null;
    },
    removeAttribute(name) {
      attrs.delete(String(name));
    },
    append(...nodes) {
      for (const child of nodes) children.push(child);
    },
    querySelector(selector) {
      const match = /^\[([^\]]+)\]$/.exec(String(selector));
      if (!match) return null;
      const attr = match[1];
      return children.find((child) => child.getAttribute(attr) !== null) ?? null;
    },
  };
  Object.defineProperty(node, "textContent", {
    get() {
      if (children.length > 0) {
        return children.map((child) => child.textContent ?? "").join("");
      }
      return node._text;
    },
    set(value) {
      children.length = 0;
      node._text = String(value);
    },
  });
  return node;
}

function fakeDocument() {
  const elements = {
    machineGuidance: el("section"),
    machineGuidanceName: el("div"),
    machineGuidanceResistance: el("div"),
    machineGuidanceCadence: el("div"),
    machineGuidanceWatts: el("div"),
    machineGuidanceBikeLive: el("div"),
  };
  return {
    elements,
    getElementById(id) {
      return elements[id] ?? null;
    },
    createElement(tag) {
      return el(tag);
    },
  };
}

function freshState(overrides = {}) {
  return {
    readiness: "telemetry_ready",
    observedResistance: 7,
    observedResistanceCurrent: true,
    rpm: 80,
    rpmCurrent: true,
    watts: 150,
    wattsCurrent: true,
    telemetryStale: false,
    ...overrides,
  };
}

test("Freestyle observation HUD mounts once and keeps Live telemetry label stable", () => {
  const doc = fakeDocument();
  renderFreestyleObservationHud(freshState(), doc);
  assert.equal(doc.elements.machineGuidance.hidden, false);
  assert.equal(doc.elements.machineGuidanceName.textContent, "Freestyle observation");
  assert.equal(doc.elements.machineGuidanceResistance.textContent, "7");
  assert.equal(doc.elements.machineGuidanceCadence.textContent, "80 RPM");
  assert.equal(doc.elements.machineGuidanceWatts.textContent, "150 W");
  assert.equal(doc.elements.machineGuidanceWatts.hidden, false);
  assert.equal(doc.elements.machineGuidanceBikeLive.hidden, false);
  assert.equal(freestyleObservationHudOwnsLiveElement(doc), true);
  assert.equal(doc.elements.machineGuidanceBikeLive.textContent, "Live telemetry");
  const labelNode = doc.elements.machineGuidanceBikeLive.childNodes[0];
  const statusNode = doc.elements.machineGuidanceBikeLive.childNodes[1];
  assert.equal(labelNode.textContent, "Live telemetry");
  assert.equal(statusNode.textContent, "");

  for (let i = 0; i < 5; i++) {
    renderFreestyleObservationHud(freshState({
      observedResistance: 7 + i,
      rpm: 80 + i,
      watts: 150 + i,
    }), doc);
  }
  assert.equal(doc.elements.machineGuidanceBikeLive.childNodes[0], labelNode);
  assert.equal(doc.elements.machineGuidanceBikeLive.childNodes[1], statusNode);
  assert.equal(labelNode.textContent, "Live telemetry");
  assert.equal(doc.elements.machineGuidanceResistance.textContent, "11");
  assert.equal(doc.elements.machineGuidanceCadence.textContent, "84 RPM");
  assert.equal(doc.elements.machineGuidanceWatts.textContent, "154 W");
  assert.equal(doc.elements.machineGuidance.hidden, false);
});

test("Bridge-style repeated polls do not hide the Freestyle panel or rewrite the label", () => {
  const doc = fakeDocument();
  renderFreestyleObservationHud(freshState(), doc);
  const live = doc.elements.machineGuidanceBikeLive;
  const labelNode = live.childNodes[0];
  for (let i = 0; i < 20; i++) {
    renderFreestyleObservationHud(freshState({
      rpm: 70 + (i % 3),
      watts: 140 + (i % 4),
      observedResistance: 5,
    }), doc);
    assert.equal(doc.elements.machineGuidance.hidden, false);
    assert.equal(live.hidden, false);
    assert.equal(live.childNodes[0], labelNode);
    assert.equal(labelNode.textContent, "Live telemetry");
    assert.equal(freestyleObservationHudOwnsLiveElement(doc), true);
  }
  assert.equal(doc.elements.machineGuidanceResistance.textContent, "5");
});

test("stale or non-current telemetry stays honest without clearing the panel", () => {
  const doc = fakeDocument();
  renderFreestyleObservationHud(freshState(), doc);
  renderFreestyleObservationHud(freshState({
    telemetryStale: true,
    observedResistance: 7,
    rpm: 80,
    watts: 150,
  }), doc);
  assert.equal(doc.elements.machineGuidance.hidden, false);
  assert.equal(doc.elements.machineGuidanceResistance.textContent, "-");
  assert.equal(doc.elements.machineGuidanceCadence.textContent, "- RPM");
  assert.equal(doc.elements.machineGuidanceWatts.textContent, "- W");
  assert.match(doc.elements.machineGuidanceBikeLive.textContent, /^Live telemetry/);
  assert.match(doc.elements.machineGuidanceBikeLive.textContent, /waiting for fresh sample/);

  renderFreestyleObservationHud(freshState({
    telemetryStale: false,
    observedResistanceCurrent: false,
    rpmCurrent: false,
    wattsCurrent: false,
    observedResistance: 9,
    rpm: 90,
    watts: 180,
  }), doc);
  assert.equal(doc.elements.machineGuidanceResistance.textContent, "-");
  assert.equal(doc.elements.machineGuidanceCadence.textContent, "- RPM");
  assert.equal(doc.elements.machineGuidanceWatts.textContent, "- W");
  assert.equal(doc.elements.machineGuidanceBikeLive.childNodes[0].textContent, "Live telemetry");
});

test("readiness problems update status text without dismantling the HUD", () => {
  const doc = fakeDocument();
  renderFreestyleObservationHud(freshState({ readiness: "unreachable" }), doc);
  assert.equal(doc.elements.machineGuidance.hidden, false);
  assert.match(doc.elements.machineGuidanceBikeLive.textContent, /Bridge unreachable/);
  const labelNode = doc.elements.machineGuidanceBikeLive.childNodes[0];
  renderFreestyleObservationHud(freshState({ readiness: "reachable_disconnected" }), doc);
  assert.equal(doc.elements.machineGuidanceBikeLive.childNodes[0], labelNode);
  assert.match(doc.elements.machineGuidanceBikeLive.textContent, /Bike disconnected/);
});

test("clearing ownership and hide restore a blank live element for normal guidance", () => {
  const doc = fakeDocument();
  renderFreestyleObservationHud(freshState(), doc);
  assert.equal(freestyleObservationHudOwnsLiveElement(doc), true);
  clearFreestyleObservationHudOwnership(doc);
  assert.equal(freestyleObservationHudOwnsLiveElement(doc), false);
  assert.equal(doc.elements.machineGuidanceBikeLive.textContent, "");
  renderFreestyleObservationHud(freshState({ observedResistance: 3 }), doc);
  hideFreestyleObservationHud(doc);
  assert.equal(doc.elements.machineGuidance.hidden, true);
  assert.equal(doc.elements.machineGuidanceBikeLive.hidden, true);
  assert.equal(freestyleObservationHudOwnsLiveElement(doc), false);
});

test("active Freestyle UI path owns telemetry without hiding via machine guidance null", async () => {
  const source = await readFile(new URL("../src/uiControls.ts", import.meta.url), "utf8");
  assert.match(source, /function renderLiveBikeTelemetryHud/);
  assert.match(source, /renderFreestyleObservationHud\(getBikeBridgeSession\(\)\.getViewState\(\)\)/);
  assert.match(source, /getBikeBridgeSession\(\)\.subscribe\(\(\) => \{\s*renderLiveBikeTelemetryHud\(\);/s);
  const freestyleBranch = source.slice(
    source.indexOf("if (isFreestyleActive) {"),
    source.indexOf("} else {\n    syncBikeBridgeGuidance(machineUpdate")
  );
  assert.match(freestyleBranch, /renderFreestyleObservationHud\(/);
  assert.doesNotMatch(freestyleBranch, /renderMachineGuidance\(null\)/);
});
