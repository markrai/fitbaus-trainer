/**
 * Downregulation view lifecycle.
 * Canonical flow (all visualization modes):
 * 1) Ready: play button visible
 * 2) Play pressed: start one session and bind tap-to-end
 * 3) Tap during session: end session, save summary, show stats
 * 4) Done on stats: return to ready state (play visible again)
 */

import { onBpm, getCurrentBpm } from "../hrMonitor.js";
import { setCurrentHR, reset as resetHrController, getSmoothedHR } from "./hrController.js";
import { initRenderer, startRenderLoop, stopRenderLoop, disposeRenderer, resize } from "./renderer.js";
import { startSession, endSession, cancelSession } from "./sessionStats.js";
import {
  showPlayIconForStart,
  showStats,
  hideStats,
  bindTap,
  unbindTap,
  showSessionHint,
  hideSessionHint,
  teardownOverlay,
} from "./overlay.js";
import { generateUUID, emitWorkoutSummary } from "../workoutSummary.js";
import { startSession as startStorageSession, clearSession } from "../sessionStore.js";
import { storeHrSample, getHrSamples } from "../workoutStorage.js";
import { generateDownregulationSummary } from "./workoutSummary.js";
import { startCalmAudio, stopCalmAudio } from "./calmAudio.js";

const DOWNREGULATION_DAY = "Downregulation";

type DownregulationUiState = "ready" | "active" | "summary";

let container: HTMLElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let running = false;
let uiState: DownregulationUiState = "ready";
let hrDisplayIntervalId: ReturnType<typeof setInterval> | null = null;
let resizeHandler: (() => void) | null = null;
let downregulationSessionId: string | null = null;
let downregulationSessionStartTime: number | null = null;

function onBpmCallback(bpm: number): void {
  if (!running) return;
  setCurrentHR(bpm);
  if (uiState !== "active") return;
  if (downregulationSessionId == null || downregulationSessionStartTime == null) return;
  const elapsedSec = Math.floor((Date.now() - downregulationSessionStartTime) / 1000);
  storeHrSample(downregulationSessionId, elapsedSec, bpm).catch((err: unknown) =>
    console.error("[Downregulation] Error storing HR sample:", err)
  );
}

function resetSessionContext(): void {
  downregulationSessionId = null;
  downregulationSessionStartTime = null;
  clearSession(DOWNREGULATION_DAY);
}

function showReadyState(): void {
  if (!running || !container) return;
  uiState = "ready";
  unbindTap(container);
  hideStats();
  hideSessionHint();
  showPlayIconForStart(container, startSessionFromPlay);
}

function startSessionFromPlay(): void {
  if (!running || !container) return;
  if (uiState !== "ready") return;

  const startedAt = Date.now();
  const sessionId = generateUUID();
  startStorageSession(DOWNREGULATION_DAY, startedAt, sessionId);
  downregulationSessionId = sessionId;
  downregulationSessionStartTime = startedAt;
  startSession();
  uiState = "active";
  showSessionHint(container);
  startCalmAudio();
  bindTap(container, () => {
    void endSessionFromTap();
  });
}

async function endSessionFromTap(): Promise<void> {
  if (!running || !container) return;
  if (uiState !== "active") return;

  const activeContainer = container;
  uiState = "summary";
  unbindTap(activeContainer);
  hideSessionHint();
  stopCalmAudio();

  const stats = endSession();
  const sessionId = downregulationSessionId;
  const startedAt = downregulationSessionStartTime;
  downregulationSessionId = null;
  downregulationSessionStartTime = null;

  let hrSamples: { timestamp_sec: number; hr: number }[] = [];
  if (sessionId != null && startedAt != null) {
    const endedAt = Date.now();
    try {
      const summary = await generateDownregulationSummary(sessionId, startedAt, endedAt, stats);
      await emitWorkoutSummary(summary);
    } catch (err) {
      console.error("[Downregulation] Failed to save workout summary:", err);
    }
    try {
      const samples = await getHrSamples(sessionId);
      hrSamples = samples.map((s) => ({ timestamp_sec: s.timestamp_sec, hr: s.hr }));
    } catch (err) {
      console.error("[Downregulation] Failed to load HR samples for graph:", err);
    }
  }
  clearSession(DOWNREGULATION_DAY);

  if (!running || container !== activeContainer) return;
  showStats(activeContainer, stats, () => {
    if (!running || container !== activeContainer) return;
    showReadyState();
  }, hrSamples);
}

/**
 * Start the Downregulation view: initialize renderer, keep HR display updated, and enter ready state.
 * Idempotent: if already running for this container, no-op.
 */
export function startDownregulationView(containerEl: HTMLElement, canvasEl: HTMLCanvasElement): void {
  if (running && container === containerEl) return;
  if (running && container !== containerEl) stopDownregulationView();

  container = containerEl;
  canvas = canvasEl;
  running = true;
  uiState = "ready";
  resetHrController();
  cancelSession();
  resetSessionContext();

  if (!initRenderer(canvasEl)) {
    running = false;
    container = null;
    canvas = null;
    return;
  }

  onBpm(onBpmCallback);
  const currentBpm = getCurrentBpm();
  if (currentBpm != null && currentBpm > 0) setCurrentHR(currentBpm);

  resizeHandler = () => {
    if (canvas) resize(canvas);
  };
  window.addEventListener("resize", resizeHandler);

  const hrEl = containerEl.querySelector("#downregulationHrDisplay") as HTMLElement | null;
  if (hrEl) {
    const updateHrDisplay = () => {
      if (!running) return;
      const liveBpm = getCurrentBpm();
      if (liveBpm == null || liveBpm <= 0) {
        hrEl.textContent = "-";
        return;
      }
      const bpm = getSmoothedHR();
      hrEl.textContent = bpm != null ? `${Math.round(bpm)} bpm` : "-";
    };
    updateHrDisplay();
    hrDisplayIntervalId = setInterval(updateHrDisplay, 1000);
  }

  startRenderLoop(canvasEl);
  showReadyState();
}

/**
 * Stop the Downregulation view and tear down all session/overlay/renderer resources.
 */
export function stopDownregulationView(): void {
  running = false;
  uiState = "ready";
  cancelSession();
  resetSessionContext();
  stopCalmAudio();

  if (container) teardownOverlay(container);
  else teardownOverlay();

  if (hrDisplayIntervalId != null) {
    clearInterval(hrDisplayIntervalId);
    hrDisplayIntervalId = null;
  }
  const hrEl = container?.querySelector("#downregulationHrDisplay") as HTMLElement | null;
  if (hrEl) hrEl.textContent = "";

  if (resizeHandler) {
    window.removeEventListener("resize", resizeHandler);
    resizeHandler = null;
  }

  stopRenderLoop();
  disposeRenderer();
  resetHrController();
  container = null;
  canvas = null;
}
