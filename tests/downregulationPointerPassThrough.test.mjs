import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DOWNREGULATION_ACTIVE_CLASS,
  setWorkoutMainSectionDownregulationActive,
} from "../dist/downregulationPointerPassThrough.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeElement() {
  const classes = new Set();
  return {
    classes,
    classList: {
      toggle(token, force) {
        if (force) classes.add(token);
        else classes.delete(token);
        return force === true;
      },
      contains(token) {
        return classes.has(token);
      },
    },
  };
}

test("downregulation-active class is added for the downregulation screen and removed otherwise", () => {
  const mainSection = fakeElement();

  setWorkoutMainSectionDownregulationActive(mainSection, true);
  assert.equal(mainSection.classList.contains(DOWNREGULATION_ACTIVE_CLASS), true);
  assert.equal(DOWNREGULATION_ACTIVE_CLASS, "downregulation-active");

  setWorkoutMainSectionDownregulationActive(mainSection, false);
  assert.equal(mainSection.classList.contains(DOWNREGULATION_ACTIVE_CLASS), false);
});

test("repeated downregulation transitions do not accumulate class tokens", () => {
  const mainSection = fakeElement();
  for (let i = 0; i < 5; i += 1) {
    setWorkoutMainSectionDownregulationActive(mainSection, true);
    setWorkoutMainSectionDownregulationActive(mainSection, false);
  }
  assert.equal(mainSection.classes.size, 0);
  setWorkoutMainSectionDownregulationActive(mainSection, true);
  assert.deepEqual([...mainSection.classes], ["downregulation-active"]);
});

test("null main section is a no-op", () => {
  assert.doesNotThrow(() => setWorkoutMainSectionDownregulationActive(null, true));
});

test("styles.css passes pointer events through the inactive workout section while keeping the day row interactive", () => {
  const css = fs.readFileSync(path.join(repoRoot, "styles.css"), "utf8");
  assert.match(
    css,
    /\.workout-main-section\.downregulation-active\s*\{\s*pointer-events:\s*none;/s
  );
  assert.match(
    css,
    /\.workout-main-section\.downregulation-active\s+\.workout-day-row\s*\{\s*pointer-events:\s*auto;/s
  );
});

test("renderWorkout toggles downregulation-active from the existing render lifecycle", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/uiControls.ts"), "utf8");
  assert.match(source, /setWorkoutMainSectionDownregulationActive\(mainSection,\s*true\)/);
  assert.match(source, /setWorkoutMainSectionDownregulationActive\(mainSection,\s*false\)/);
  assert.match(source, /state\.screen === "downregulation"/);
});
