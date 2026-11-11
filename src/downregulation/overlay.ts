/**
 * Downregulation overlay: tap-to-stop, play icon (1s fade), and session stats panel.
 * Keeps UI and behavior in one place so the main index stays clean.
 */

import type { DownregulationSessionStats } from "./sessionStats.js";
import {
  getParticleSizeScale,
  setParticleSizeScale,
  getParticleStyle,
  setParticleStyle,
  getMovementScale,
  getNoiseEntropyScale,
  getNoiseEntropyMinBpm,
  setNoiseEntropyMinBpm,
  type ParticleStyle,
} from "./renderer.js";
import { SimplexNoise } from "./simplexNoise.js";
import { getSoundStyle, setSoundStyle, restartCalmAudioIfRunning, type SoundStyle } from "./calmAudio.js";

const PLAY_ICON_DURATION_MS = 1000;
const FADE_DURATION_MS = 400;
const SESSION_HINT_FADE_MS = 3000;
const GOO_Y_MAX = 260; // vertical travel; kept lower so with scale(2) blobs stay on screen (bottom ~viewBox 600)
const GOO_TIME_SCALE = 2;
const GOO_SEEK = 120;

function getGooSvgMarkup(): string {
  return `<svg class="downregulation-goo-svg" viewBox="0 0 600 600" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
<defs>
  <filter id="gooFilter">
    <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur"/>
    <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 21 -9" result="cm"/>
  </filter>
  <!-- Greenish-blue relaxing palette (matches downregulation circle/particles) -->
  <radialGradient id="gooBlobGrad0" cx="292" cy="171.5" r="56.5" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#5ba8c2"/><stop offset="0.35" stop-color="#4a8fa8"/><stop offset="0.65" stop-color="#3a6d82"/><stop offset="1" stop-color="#245257"/>
  </radialGradient>
  <radialGradient id="gooBlobGrad1" cx="297" cy="167.5" r="37.2" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#5ba8c2"/><stop offset="0.35" stop-color="#4a8fa8"/><stop offset="0.65" stop-color="#3a6d82"/><stop offset="1" stop-color="#245257"/>
  </radialGradient>
  <radialGradient id="gooBlobGrad2" cx="294" cy="157" r="23" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#5ba8c2"/><stop offset="0.35" stop-color="#4a8fa8"/><stop offset="0.65" stop-color="#3a6d82"/><stop offset="1" stop-color="#245257"/>
  </radialGradient>
  <radialGradient id="gooBlobGrad3" cx="291.94" cy="167.46" r="41.08" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#5ba8c2"/><stop offset="0.35" stop-color="#4a8fa8"/><stop offset="0.65" stop-color="#3a6d82"/><stop offset="1" stop-color="#245257"/>
  </radialGradient>
  <radialGradient id="gooBlobGrad4" cx="306.5" cy="155" r="14.1" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#5ba8c2"/><stop offset="0.35" stop-color="#4a8fa8"/><stop offset="0.65" stop-color="#3a6d82"/><stop offset="1" stop-color="#245257"/>
  </radialGradient>
</defs>
<rect fill="#05060a" width="600" height="600"/>
<g filter="url(#gooFilter)" transform="translate(300,300) scale(2) translate(-300,-300)">
  <path id="gooBlob0" fill="url(#gooBlobGrad0)" d="M326.2,149.5c-5,19.2-21.4,29.2-37.8,26.6c-16.5-2.9-33.4-12.9-37.1-26.6c-3.8-13.6,12.5-32.1,37.8-34.9C314.4,111.8,331.3,130.4,326.2,149.5z"/>
  <path id="gooBlob1" fill="url(#gooBlobGrad1)" d="M320.5,146.4c-4.4,10.1-16.4,20.2-26.8,25.3c-10.4,5.2-22.4-2.9-26.8-15.2c-4.4-11.6,7.6-20.4,26.8-25.3C312.9,126.3,324.9,135.6,320.5,146.4z"/>
  <path id="gooBlob2" fill="url(#gooBlobGrad2)" d="M278,147.7c2.7-7.1,9.4-15.7,15.4-16.4c5.9-0.4,12.6,8.5,15.4,16.9c2.7,8.4-4.2,14.9-15.4,14.2C282.2,161.5,275.3,154.8,278,147.7z"/>
  <path id="gooBlob3" fill="url(#gooBlobGrad3)" d="M312.7,147.3c-2.1,16.4-15.3,27.2-23.2,25.3c-8.1-1.8-12.6-13-14.8-24.9c-1.9-11.8,2.7-22.7,14.8-25.3C301.5,119.6,314.7,130.8,312.7,147.3z"/>
  <path id="gooBlob4" fill="url(#gooBlobGrad4)" d="M317.8,147.4c-1,8.2-9.8,10.3-13.8,9.3c-4-0.9-6.5-3-7.6-8.9c-1-5.9,2.3-8.5,8.4-9.8C310.8,136.6,318.8,139.1,317.8,147.4z"/>
</g>
</svg>`;
}

function gooAnimationLoop(): void {
  if (getParticleStyle() !== "goo") {
    gooRafId = null;
    return;
  }
  const now = performance.now() / 1000;
  if (gooLastFrameTime === 0) gooLastFrameTime = now;
  const deltaTime = Math.min(0.1, now - gooLastFrameTime);
  gooLastFrameTime = now;
  const movementScale = getMovementScale();
  gooAccumulatedTime += deltaTime * movementScale * GOO_TIME_SCALE;
  const T = gooAccumulatedTime + GOO_SEEK;
  for (let i = 0; i < gooBlobElements.length && i < gooBlobParams.length; i++) {
    const el = gooBlobElements[i];
    const p = gooBlobParams[i];
    const cycle = 2 * p.duration + p.repeatDelay;
    let localT = ((T - p.startOffset) % cycle + cycle) % cycle;
    let y: number;
    if (localT < p.duration) {
      y = GOO_Y_MAX * (localT / p.duration);
    } else if (localT < 2 * p.duration) {
      y = GOO_Y_MAX * (2 - localT / p.duration);
    } else {
      y = 0;
    }
    el.setAttribute("transform", `translate(0, ${y})`);
  }
  gooRafId = requestAnimationFrame(gooAnimationLoop);
}

function updateGooVisibility(): void {
  if (!gooLayer) return;
  if (getParticleStyle() === "goo") {
    gooLayer.style.display = "block";
    gooLayer.setAttribute("aria-hidden", "false");
    if (gooRafId == null) gooAnimationLoop();
  } else {
    gooLayer.style.display = "none";
    gooLayer.setAttribute("aria-hidden", "true");
    if (gooRafId != null) {
      cancelAnimationFrame(gooRafId);
      gooRafId = null;
    }
  }
}

// Noise visualization (concentric warped circles). Based on Johan Karlsson (DonKarlssonSan) 2018; credit: Luke Smetham.
let noiseLayer: HTMLElement | null = null;
let noiseCanvas: HTMLCanvasElement | null = null;
let noiseRafId: number | null = null;
let noiseW = 0;
let noiseH = 0;
let noiseM = 0;
let noiseSimplex: SimplexNoise | null = null;

function noiseReset(): void {
  noiseSimplex = new SimplexNoise();
  if (!noiseCanvas) return;
  noiseW = noiseCanvas.width;
  noiseH = noiseCanvas.height;
  noiseM = Math.min(noiseW, noiseH);
}

/** Entropy 0–1 from HR (40 bpm → 0, 150 bpm → 1). Drives warp amount and zoom. */
function noiseCalcPoint(angle: number, r: number, timeSec: number, entropy: number): [number, number] {
  if (!noiseSimplex) return [noiseW / 2 + Math.cos(angle) * r, noiseH / 2 + Math.sin(angle) * r];
  const noiseFactor = entropy * 50;
  const zoom = 50 + entropy * 150;
  const x = Math.cos(angle) * r + noiseW / 2;
  const y = Math.sin(angle) * r + noiseH / 2;
  const n = noiseSimplex.noise3D(x / zoom, y / zoom, timeSec / 2) * noiseFactor;
  const x2 = Math.cos(angle) * (r + n) + noiseW / 2;
  const y2 = Math.sin(angle) * (r + n) + noiseH / 2;
  return [x2, y2];
}

function noiseDrawCircle(ctx: CanvasRenderingContext2D, r: number, timeSec: number, entropy: number): void {
  ctx.beginPath();
  const deltaAngle = (Math.PI * 2) / 400;
  for (let angle = 0; angle < Math.PI * 2; angle += deltaAngle) {
    const [x, y] = noiseCalcPoint(angle, r, timeSec, entropy);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
}

function noiseDraw(timestamp: number): void {
  if (getParticleStyle() !== "noise") {
    noiseRafId = null;
    return;
  }
  if (!noiseCanvas || !noiseSimplex) {
    noiseRafId = requestAnimationFrame(noiseDraw);
    return;
  }
  const ctx = noiseCanvas.getContext("2d");
  if (!ctx) {
    noiseRafId = requestAnimationFrame(noiseDraw);
    return;
  }
  const entropy = getNoiseEntropyScale();
  const movementScale = getMovementScale();
  const timeSec = (timestamp / 1000) * (0.3 + 0.7 * movementScale);
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, noiseW, noiseH);
  ctx.strokeStyle = "white";
  for (let i = 10; i < noiseM / 2 - 40; i += 10) {
    noiseDrawCircle(ctx, i, timeSec, entropy);
  }
  noiseRafId = requestAnimationFrame(noiseDraw);
}

function updateNoiseVisibility(): void {
  if (!noiseLayer || !noiseCanvas) return;
  if (getParticleStyle() === "noise") {
    noiseLayer.style.display = "block";
    noiseLayer.setAttribute("aria-hidden", "false");
    if (noiseRafId == null) {
      noiseReset();
      noiseRafId = requestAnimationFrame(noiseDraw);
    }
  } else {
    noiseLayer.style.display = "none";
    noiseLayer.setAttribute("aria-hidden", "true");
    if (noiseRafId != null) {
      cancelAnimationFrame(noiseRafId);
      noiseRafId = null;
    }
  }
}

let playIconWrap: HTMLElement | null = null;
let sessionHintEl: HTMLElement | null = null;
let statsPanel: HTMLElement | null = null;
let statsContent: HTMLElement | null = null;
let doneButton: HTMLElement | null = null;
let playHideTimeoutId: ReturnType<typeof setTimeout> | null = null;
let sessionHintFadeTimeoutId: ReturnType<typeof setTimeout> | null = null;
let sessionHintHideTimeoutId: ReturnType<typeof setTimeout> | null = null;
let tapHandler: ((e: MouseEvent | TouchEvent) => void) | null = null;
let onDismissCallback: (() => void) | null = null;
let startClickHandler: ((e: MouseEvent | TouchEvent) => void) | null = null;
let settingsBtn: HTMLElement | null = null;
let prefsModal: HTMLElement | null = null;
let gooLayer: HTMLElement | null = null;
let gooBlobElements: SVGElement[] = [];
/** Per-blob: duration (s), repeatDelay (s), startOffset (timeline seconds). CodePen: duration 14–50, repeatDelay 1–3, stagger (i+1)/0.6 */
const gooBlobParams: { duration: number; repeatDelay: number; startOffset: number }[] = [];
let gooRafId: number | null = null;
/** Accumulated timeline time (advances at rate proportional to HR) so HR changes only change speed, no jerk */
let gooAccumulatedTime = 0;
let gooLastFrameTime = 0;

function ensureElements(container: HTMLElement): void {
  if (playIconWrap) return;
  playIconWrap = container.querySelector("#downregulationPlayIconWrap") as HTMLElement | null;
  statsPanel = container.querySelector("#downregulationStatsPanel") as HTMLElement | null;
  statsContent = container.querySelector("#downregulationStatsContent") as HTMLElement | null;
  doneButton = container.querySelector("#downregulationStatsDone") as HTMLElement | null;
  if (!playIconWrap) {
    playIconWrap = document.createElement("div");
    playIconWrap.id = "downregulationPlayIconWrap";
    playIconWrap.className = "downregulation-play-wrap";
    playIconWrap.setAttribute("aria-hidden", "true");
    playIconWrap.innerHTML = '<span class="downregulation-play-icon" aria-hidden="true"></span><span class="downregulation-play-label" aria-hidden="true">click to begin session</span>';
    container.appendChild(playIconWrap);
  }
  if (!statsPanel) {
    statsPanel = document.createElement("div");
    statsPanel.id = "downregulationStatsPanel";
    statsPanel.className = "downregulation-stats-panel";
    statsPanel.setAttribute("aria-live", "polite");
    statsPanel.innerHTML = `
      <h3 class="downregulation-stats-title">Session summary</h3>
      <div id="downregulationStatsContent" class="downregulation-stats-content"></div>
      <button type="button" id="downregulationStatsDone" class="button downregulation-stats-done">Done</button>
    `;
    statsContent = statsPanel.querySelector("#downregulationStatsContent");
    doneButton = statsPanel.querySelector("#downregulationStatsDone");
    container.appendChild(statsPanel);
  } else {
    statsContent = statsPanel.querySelector("#downregulationStatsContent");
    doneButton = statsPanel.querySelector("#downregulationStatsDone");
  }
  if (!container.querySelector("#downregulationSessionHint")) {
    sessionHintEl = document.createElement("div");
    sessionHintEl.id = "downregulationSessionHint";
    sessionHintEl.className = "downregulation-session-hint";
    sessionHintEl.setAttribute("aria-hidden", "true");
    sessionHintEl.textContent = "Try to calm the motion";
    container.appendChild(sessionHintEl);
  } else {
    sessionHintEl = container.querySelector("#downregulationSessionHint");
  }
  if (!container.querySelector("#downregulationSettingsBtn")) {
    settingsBtn = document.createElement("button");
    settingsBtn.setAttribute("type", "button");
    settingsBtn.id = "downregulationSettingsBtn";
    settingsBtn.className = "downregulation-settings-btn";
    settingsBtn.setAttribute("aria-label", "Downregulation preferences");
    settingsBtn.innerHTML = '<img src="settings.svg" alt="" width="28" height="28">';
    settingsBtn.onclick = openDownregulationPrefsModal;
    container.appendChild(settingsBtn);
  } else {
    settingsBtn = container.querySelector("#downregulationSettingsBtn");
  }
  if (!container.querySelector("#downregulationGooLayer")) {
    gooLayer = document.createElement("div");
    gooLayer.id = "downregulationGooLayer";
    gooLayer.className = "downregulation-goo-layer";
    gooLayer.setAttribute("aria-hidden", "true");
    // Lava lamp SVG from CodePen: goo filter (feGaussianBlur + feColorMatrix), lamp clip path, orange blob paths
    gooLayer.innerHTML = getGooSvgMarkup();
    container.appendChild(gooLayer);
    for (let i = 0; i < 5; i++) {
      const el = gooLayer.querySelector("#gooBlob" + i) as SVGElement | null;
      if (el) gooBlobElements.push(el);
    }
    if (gooBlobParams.length === 0) {
      const rand = (min: number, max: number) => min + Math.random() * (max - min);
      for (let i = 0; i < 5; i++) {
        gooBlobParams.push({
          duration: rand(14, 50),
          repeatDelay: rand(1, 3),
          startOffset: (i + 1) / 0.6,
        });
      }
    }
  } else {
    gooLayer = container.querySelector("#downregulationGooLayer");
    gooBlobElements = [];
    for (let i = 0; i < 5; i++) {
      const el = gooLayer?.querySelector("#gooBlob" + i) as SVGElement | null;
      if (el) gooBlobElements.push(el);
    }
  }
  if (!container.querySelector("#downregulationNoiseLayer")) {
    noiseLayer = document.createElement("div");
    noiseLayer.id = "downregulationNoiseLayer";
    noiseLayer.className = "downregulation-noise-layer";
    noiseLayer.setAttribute("aria-hidden", "true");
    noiseCanvas = document.createElement("canvas");
    noiseCanvas.id = "downregulationNoiseCanvas";
    noiseCanvas.className = "downregulation-noise-canvas";
    noiseLayer.appendChild(noiseCanvas);
    container.appendChild(noiseLayer);
    const onNoiseResize = () => {
      if (!noiseCanvas) return;
      const rect = container.getBoundingClientRect();
      noiseCanvas.width = rect.width;
      noiseCanvas.height = rect.height;
      noiseReset();
    };
    window.addEventListener("resize", onNoiseResize);
    onNoiseResize();
  } else {
    noiseLayer = container.querySelector("#downregulationNoiseLayer");
    noiseCanvas = container.querySelector("#downregulationNoiseCanvas");
  }
  if (!document.getElementById("downregulationPrefsModal")) {
    prefsModal = document.createElement("div");
    prefsModal.id = "downregulationPrefsModal";
    prefsModal.className = "modal-bg downregulation-prefs-modal-bg";
    prefsModal.style.display = "none";
    prefsModal.innerHTML = `
      <div class="modal downregulation-prefs-modal">
        <div class="close-btn" id="downregulationPrefsClose" aria-label="Close">✕</div>
        <h3 class="downregulation-stats-title">Downregulation preferences</h3>
        <div class="tab-buttons downregulation-prefs-tabs" role="tablist">
          <button type="button" class="tab-button active" role="tab" aria-selected="true" aria-controls="downregulationPrefsVizTab" id="downregulationPrefsVizTabBtn" data-tab="viz">Visualization</button>
          <button type="button" class="tab-button" role="tab" aria-selected="false" aria-controls="downregulationPrefsSoundTab" id="downregulationPrefsSoundTabBtn" data-tab="sound">Sound</button>
        </div>
        <div id="downregulationPrefsVizTab" class="tab-content active" role="tabpanel">
          <div class="modal-field modal-field-column">
            <span class="modal-label">Particle style</span>
            <div class="downregulation-style-toggle" role="group" aria-label="Particle style">
              <label class="downregulation-style-option">
                <input type="radio" name="downregulationParticleStyle" value="beads" checked>
                <span>Beads</span>
              </label>
              <label class="downregulation-style-option">
                <input type="radio" name="downregulationParticleStyle" value="starfield">
                <span>Starfield</span>
              </label>
              <label class="downregulation-style-option">
                <input type="radio" name="downregulationParticleStyle" value="goo">
                <span>Goo</span>
              </label>
              <label class="downregulation-style-option">
                <input type="radio" name="downregulationParticleStyle" value="noise">
                <span>Noise</span>
              </label>
            </div>
          </div>
          <p id="downregulationVizCredit" class="downregulation-goo-credit" style="display: none;">Credit: Luke Smetham</p>
          <div id="downregulationNoiseTargetHrWrap" class="modal-field-column" style="display: none;">
            <div class="modal-field">
              <label class="modal-label" for="downregulationNoiseTargetHr">Target HR:</label>
              <input type="number" id="downregulationNoiseTargetHr" class="modal-input downregulation-noise-target-hr" min="30" max="149" step="1" value="40" aria-label="Target HR (circles stop below this)">
            </div>
          </div>
          <div id="downregulationParticleSizeWrap" class="modal-field-column">
            <div class="modal-field">
              <label class="modal-label" for="downregulationParticleSizeSlider">Increase size of particles</label>
              <input type="range" id="downregulationParticleSizeSlider" min="1" max="3" step="0.05" value="1">
            </div>
            <p class="label downregulation-particle-size-value" id="downregulationParticleSizeValue" style="margin-top: 0.5rem; opacity: 0.8;"></p>
          </div>
        </div>
        <div id="downregulationPrefsSoundTab" class="tab-content" role="tabpanel">
          <div class="modal-field modal-field-column">
            <span class="modal-label">Sound</span>
            <div class="downregulation-style-toggle" role="group" aria-label="Sound style">
              <label class="downregulation-style-option">
                <input type="radio" name="downregulationSoundStyle" value="binaural" checked>
                <span>Binaural</span>
              </label>
              <label class="downregulation-style-option">
                <input type="radio" name="downregulationSoundStyle" value="whale">
                <span>Whale</span>
              </label>
              <label class="downregulation-style-option">
                <input type="radio" name="downregulationSoundStyle" value="none">
                <span>None</span>
              </label>
            </div>
          </div>
        </div>
        <button type="button" class="button" id="downregulationPrefsCloseBtn">Close</button>
      </div>
    `;
    document.body.appendChild(prefsModal);
    const closeEl = prefsModal.querySelector("#downregulationPrefsClose");
    const closeBtn = prefsModal.querySelector("#downregulationPrefsCloseBtn");
    const slider = prefsModal.querySelector("#downregulationParticleSizeSlider") as HTMLInputElement;
    const valueEl = prefsModal.querySelector("#downregulationParticleSizeValue") as HTMLElement;
    const styleRadios = prefsModal.querySelectorAll<HTMLInputElement>('input[name="downregulationParticleStyle"]');
    const updateValueLabel = () => {
      if (valueEl && slider) valueEl.textContent = String(Math.round(parseFloat(slider.value) * 100) / 100);
    };
    const applyAndClose = () => {
      if (slider) {
        const v = parseFloat(slider.value);
        setParticleSizeScale(v);
      }
      if (noiseTargetHrInput) {
        const v = parseInt(noiseTargetHrInput.value, 10);
        if (Number.isFinite(v)) setNoiseEntropyMinBpm(v);
      }
      const checkedStyle = prefsModal.querySelector<HTMLInputElement>('input[name="downregulationParticleStyle"]:checked');
      if (checkedStyle && (checkedStyle.value === "beads" || checkedStyle.value === "starfield" || checkedStyle.value === "goo" || checkedStyle.value === "noise")) {
        setParticleStyle(checkedStyle.value as ParticleStyle);
        updateGooVisibility();
        updateNoiseVisibility();
      }
      const checkedSound = prefsModal.querySelector<HTMLInputElement>('input[name="downregulationSoundStyle"]:checked');
      if (checkedSound && (checkedSound.value === "binaural" || checkedSound.value === "whale" || checkedSound.value === "none")) {
        setSoundStyle(checkedSound.value as SoundStyle);
      }
      prefsModal!.style.display = "none";
    };
    closeEl?.addEventListener("click", applyAndClose);
    closeBtn?.addEventListener("click", applyAndClose);
    const vizCreditEl = prefsModal.querySelector("#downregulationVizCredit") as HTMLElement | null;
    const particleSizeWrap = prefsModal.querySelector("#downregulationParticleSizeWrap") as HTMLElement | null;
    const noiseTargetHrWrap = prefsModal.querySelector("#downregulationNoiseTargetHrWrap") as HTMLElement | null;
    const noiseTargetHrInput = prefsModal.querySelector("#downregulationNoiseTargetHr") as HTMLInputElement | null;
    const updateVizCreditVisibility = () => {
      const checked = prefsModal?.querySelector<HTMLInputElement>('input[name="downregulationParticleStyle"]:checked');
      const showCredit = checked?.value === "goo" || checked?.value === "noise";
      if (vizCreditEl) vizCreditEl.style.display = showCredit ? "block" : "none";
    };
    const updateParticleSizeVisibility = () => {
      const checked = prefsModal?.querySelector<HTMLInputElement>('input[name="downregulationParticleStyle"]:checked');
      const showSlider = checked?.value === "beads" || checked?.value === "starfield";
      if (particleSizeWrap) particleSizeWrap.style.display = showSlider ? "block" : "none";
    };
    const updateNoiseTargetHrVisibility = () => {
      const checked = prefsModal?.querySelector<HTMLInputElement>('input[name="downregulationParticleStyle"]:checked');
      const show = checked?.value === "noise";
      if (noiseTargetHrWrap) noiseTargetHrWrap.style.display = show ? "block" : "none";
    };
    styleRadios.forEach((radio) => {
      radio.addEventListener("change", () => {
        if (radio.checked && (radio.value === "beads" || radio.value === "starfield" || radio.value === "goo" || radio.value === "noise")) {
          setParticleStyle(radio.value as ParticleStyle);
          updateGooVisibility();
          updateNoiseVisibility();
          updateVizCreditVisibility();
          updateParticleSizeVisibility();
          updateNoiseTargetHrVisibility();
        }
      });
    });
    noiseTargetHrInput?.addEventListener("input", () => {
      const v = parseInt(noiseTargetHrInput?.value ?? "", 10);
      if (Number.isFinite(v)) setNoiseEntropyMinBpm(v);
    });
    updateVizCreditVisibility();
    updateParticleSizeVisibility();
    updateNoiseTargetHrVisibility();
    const vizTabBtn = prefsModal.querySelector("#downregulationPrefsVizTabBtn");
    const soundTabBtn = prefsModal.querySelector("#downregulationPrefsSoundTabBtn");
    const vizTab = prefsModal.querySelector("#downregulationPrefsVizTab");
    const soundTab = prefsModal.querySelector("#downregulationPrefsSoundTab");
    const switchPrefsTab = (tab: "viz" | "sound") => {
      vizTabBtn?.classList.toggle("active", tab === "viz");
      soundTabBtn?.classList.toggle("active", tab === "sound");
      vizTab?.classList.toggle("active", tab === "viz");
      soundTab?.classList.toggle("active", tab === "sound");
      (vizTabBtn as HTMLElement)?.setAttribute("aria-selected", String(tab === "viz"));
      (soundTabBtn as HTMLElement)?.setAttribute("aria-selected", String(tab === "sound"));
    };
    vizTabBtn?.addEventListener("click", () => switchPrefsTab("viz"));
    soundTabBtn?.addEventListener("click", () => switchPrefsTab("sound"));
    const soundRadios = prefsModal.querySelectorAll<HTMLInputElement>('input[name="downregulationSoundStyle"]');
    soundRadios.forEach((radio) => {
      radio.addEventListener("change", () => {
        if (radio.checked && (radio.value === "binaural" || radio.value === "whale" || radio.value === "none")) {
          setSoundStyle(radio.value as SoundStyle);
          restartCalmAudioIfRunning();
        }
      });
    });
    slider?.addEventListener("input", () => {
      updateValueLabel();
      const v = parseFloat((slider as HTMLInputElement).value);
      setParticleSizeScale(v);
    });
    prefsModal.addEventListener("click", (e) => {
      if (e.target === prefsModal) applyAndClose();
    });
    if (slider) slider.value = String(getParticleSizeScale());
    updateValueLabel();
  } else {
    prefsModal = document.getElementById("downregulationPrefsModal");
  }
  updateGooVisibility();
  updateNoiseVisibility();
}

/**
 * Show the play icon as "tap to start" — stays visible until the user taps it. On tap, hides the icon and calls onTapToStart (workout begins).
 */
export function showPlayIconForStart(container: HTMLElement, onTapToStart: () => void): void {
  ensureElements(container);
  if (!playIconWrap) return;
  if (startClickHandler) {
    playIconWrap.removeEventListener("click", startClickHandler);
    playIconWrap.removeEventListener("touchend", startClickHandler);
    startClickHandler = null;
  }
  playIconWrap.classList.remove("downregulation-play-wrap--fade");
  playIconWrap.classList.add("downregulation-play-wrap--clickable");
  playIconWrap.style.display = "flex";
  playIconWrap.style.opacity = "1";
  playIconWrap.style.visibility = "visible";
  const handler = (e: MouseEvent | TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    playIconWrap?.classList.remove("downregulation-play-wrap--clickable");
    playIconWrap?.removeEventListener("click", handler);
    playIconWrap?.removeEventListener("touchend", handler);
    startClickHandler = null;
    playIconWrap?.classList.add("downregulation-play-wrap--fade");
    onTapToStart();
    if (playHideTimeoutId != null) {
      window.clearTimeout(playHideTimeoutId);
      playHideTimeoutId = null;
    }
    playHideTimeoutId = window.setTimeout(() => {
      playHideTimeoutId = null;
      hidePlayIcon();
    }, FADE_DURATION_MS);
  };
  startClickHandler = handler;
  playIconWrap.addEventListener("click", handler);
  playIconWrap.addEventListener("touchend", handler, { passive: false });
}

/**
 * Hide the play icon (e.g. after user tapped to start the workout).
 */
export function hidePlayIcon(): void {
  if (playHideTimeoutId != null) {
    window.clearTimeout(playHideTimeoutId);
    playHideTimeoutId = null;
  }
  if (playIconWrap) {
    playIconWrap.style.display = "none";
    playIconWrap.classList.remove("downregulation-play-wrap--clickable", "downregulation-play-wrap--fade");
  }
}

/**
 * Show the session hint "Try to calm the motion" with a 3s fade-in, then 3s fade-out.
 * Call when the session has just begun.
 */
export function showSessionHint(container: HTMLElement): void {
  ensureElements(container);
  if (!sessionHintEl) return;
  if (sessionHintFadeTimeoutId != null) {
    window.clearTimeout(sessionHintFadeTimeoutId);
    sessionHintFadeTimeoutId = null;
  }
  if (sessionHintHideTimeoutId != null) {
    window.clearTimeout(sessionHintHideTimeoutId);
    sessionHintHideTimeoutId = null;
  }
  sessionHintEl.style.display = "flex";
  sessionHintEl.style.transition = `opacity ${SESSION_HINT_FADE_MS}ms ease`;
  sessionHintEl.style.opacity = "0";
  sessionHintEl.offsetHeight;
  sessionHintEl.style.opacity = "1";
  sessionHintFadeTimeoutId = window.setTimeout(() => {
    sessionHintFadeTimeoutId = null;
    if (!sessionHintEl) return;
    sessionHintEl.style.opacity = "0";
    sessionHintHideTimeoutId = window.setTimeout(() => {
      sessionHintHideTimeoutId = null;
      if (sessionHintEl) {
        sessionHintEl.style.display = "none";
        sessionHintEl.style.opacity = "";
        sessionHintEl.style.transition = "";
      }
    }, SESSION_HINT_FADE_MS);
  }, SESSION_HINT_FADE_MS);
}

export function hideSessionHint(): void {
  if (sessionHintFadeTimeoutId != null) {
    window.clearTimeout(sessionHintFadeTimeoutId);
    sessionHintFadeTimeoutId = null;
  }
  if (sessionHintHideTimeoutId != null) {
    window.clearTimeout(sessionHintHideTimeoutId);
    sessionHintHideTimeoutId = null;
  }
  if (sessionHintEl) {
    sessionHintEl.style.display = "none";
    sessionHintEl.style.opacity = "";
    sessionHintEl.style.transition = "";
  }
}

function openDownregulationPrefsModal(): void {
  if (!prefsModal) return;
  const slider = prefsModal.querySelector("#downregulationParticleSizeSlider") as HTMLInputElement;
  const valueEl = prefsModal.querySelector("#downregulationParticleSizeValue") as HTMLElement;
  const styleRadios = prefsModal.querySelectorAll<HTMLInputElement>('input[name="downregulationParticleStyle"]');
  const vizCreditEl = prefsModal.querySelector("#downregulationVizCredit") as HTMLElement | null;
  const particleSizeWrap = prefsModal.querySelector("#downregulationParticleSizeWrap") as HTMLElement | null;
  if (slider) slider.value = String(getParticleSizeScale());
  if (valueEl && slider) valueEl.textContent = String(Math.round(parseFloat(slider.value) * 100) / 100);
  const currentStyle = getParticleStyle();
  styleRadios.forEach((radio) => {
    radio.checked = radio.value === currentStyle;
  });
  if (vizCreditEl) vizCreditEl.style.display = currentStyle === "goo" || currentStyle === "noise" ? "block" : "none";
  if (particleSizeWrap) particleSizeWrap.style.display = currentStyle === "beads" || currentStyle === "starfield" ? "block" : "none";
  const noiseTargetHrWrapOpen = prefsModal.querySelector("#downregulationNoiseTargetHrWrap") as HTMLElement | null;
  const noiseTargetHrInputOpen = prefsModal.querySelector("#downregulationNoiseTargetHr") as HTMLInputElement | null;
  if (noiseTargetHrWrapOpen) noiseTargetHrWrapOpen.style.display = currentStyle === "noise" ? "block" : "none";
  if (noiseTargetHrInputOpen) noiseTargetHrInputOpen.value = String(getNoiseEntropyMinBpm());
  const soundRadiosOpen = prefsModal.querySelectorAll<HTMLInputElement>('input[name="downregulationSoundStyle"]');
  const currentSound = getSoundStyle();
  soundRadiosOpen.forEach((radio) => {
    radio.checked = radio.value === currentSound;
  });
  prefsModal.style.display = "flex";
}

/**
 * Show the white play icon in the center for 1s, then fade out. Calls onComplete when done.
 */
export function showPlayIcon(container: HTMLElement, onComplete: () => void): void {
  ensureElements(container);
  if (!playIconWrap) {
    onComplete();
    return;
  }
  playIconWrap.style.display = "flex";
  playIconWrap.style.opacity = "1";
  playIconWrap.classList.remove("downregulation-play-wrap--fade");
  const fadeStart = PLAY_ICON_DURATION_MS - FADE_DURATION_MS;
  const fadeTimer = window.setTimeout(() => {
    playIconWrap?.classList.add("downregulation-play-wrap--fade");
  }, fadeStart);
  const endTimer = window.setTimeout(() => {
    window.clearTimeout(fadeTimer);
    if (playIconWrap) {
      playIconWrap.style.display = "none";
      playIconWrap.classList.remove("downregulation-play-wrap--fade");
    }
    onComplete();
  }, PLAY_ICON_DURATION_MS);
}

/** HR sample for the session graph: time in seconds from start, BPM */
export type HrSampleForGraph = { timestamp_sec: number; hr: number };

function drawHrGraph(canvas: HTMLCanvasElement, samples: HrSampleForGraph[]): void {
  if (samples.length < 2) return;
  const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  const width = rect.width;
  const height = rect.height;
  const padding = { top: 10, right: 8, bottom: 20, left: 36 };
  const chartLeft = padding.left;
  const chartTop = padding.top;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  if (chartWidth <= 0 || chartHeight <= 0) return;

  const maxT = Math.max(...samples.map((s) => s.timestamp_sec), 1);
  const hrs = samples.map((s) => s.hr);
  const minHr = Math.min(...hrs);
  const maxHr = Math.max(...hrs);
  const hrRange = maxHr - minHr || 1;
  const hrMin = Math.max(0, minHr - hrRange * 0.1);
  const hrMax = maxHr + hrRange * 0.1;

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const y = chartTop + (chartHeight * i) / yTicks;
    ctx.beginPath();
    ctx.moveTo(chartLeft, y);
    ctx.lineTo(chartLeft + chartWidth, y);
    ctx.stroke();
    const bpm = Math.round(hrMax - (hrMax - hrMin) * (i / yTicks));
    ctx.fillText(String(bpm), 2, y + 4);
  }
  const xTicks = 4;
  for (let i = 0; i <= xTicks; i++) {
    const x = chartLeft + (chartWidth * i) / xTicks;
    ctx.beginPath();
    ctx.moveTo(x, chartTop);
    ctx.lineTo(x, chartTop + chartHeight);
    ctx.stroke();
    const t = (maxT * i) / xTicks;
    const label = t >= 60 ? `${Math.round(t / 60)}m` : `${Math.round(t)}s`;
    ctx.fillText(label, x - 10, chartTop + chartHeight + 14);
  }

  ctx.beginPath();
  const first = samples[0];
  const x0 = chartLeft + (first.timestamp_sec / maxT) * chartWidth;
  const y0 = chartTop + chartHeight - ((first.hr - hrMin) / (hrMax - hrMin)) * chartHeight;
  ctx.moveTo(x0, y0);
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    const x = chartLeft + (s.timestamp_sec / maxT) * chartWidth;
    const y = chartTop + chartHeight - ((s.hr - hrMin) / (hrMax - hrMin)) * chartHeight;
    ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "rgba(61, 124, 255, 0.9)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * Show the stats panel with the given stats. Done button calls onDismiss.
 * If hrSamples is provided and non-empty, an HR-over-time graph is shown above the stats.
 */
export function showStats(
  container: HTMLElement,
  stats: DownregulationSessionStats,
  onDismiss: () => void,
  hrSamples?: HrSampleForGraph[]
): void {
  ensureElements(container);
  onDismissCallback = onDismiss;
  if (statsContent) {
    const hasGraph = hrSamples != null && hrSamples.length >= 2;
    const graphHtml = hasGraph
      ? `<div class="downregulation-hr-graph-wrap" aria-hidden="true"><canvas class="downregulation-hr-graph" width="400" height="120"></canvas></div>`
      : "";
    const linesHtml = stats.summaryLines.map((line) => `<p class="downregulation-stats-line">${escapeHtml(line)}</p>`).join("");
    statsContent.innerHTML = graphHtml + linesHtml;
    if (hasGraph) {
      const canvas = statsContent.querySelector(".downregulation-hr-graph") as HTMLCanvasElement | null;
      if (canvas) {
        requestAnimationFrame(() => drawHrGraph(canvas, hrSamples!));
      }
    }
  }
  if (statsPanel) {
    statsPanel.style.display = "block";
    statsPanel.setAttribute("aria-hidden", "false");
  }
  if (doneButton && !(doneButton as any).__downregDoneBound) {
    (doneButton as any).__downregDoneBound = true;
    let dismissScheduled = false;
    const runDismiss = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (dismissScheduled) return;
      dismissScheduled = true;
      const cb = onDismissCallback;
      onDismissCallback = null;
      hideStats();
      if (cb) {
        requestAnimationFrame(() => {
          cb();
          dismissScheduled = false;
        });
      } else {
        dismissScheduled = false;
      }
    };
    doneButton.addEventListener("click", runDismiss);
    doneButton.addEventListener("touchend", runDismiss, { passive: false });
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/**
 * Hide the stats panel (e.g. when leaving the view).
 */
export function hideStats(): void {
  if (statsPanel) {
    statsPanel.style.display = "none";
    statsPanel.setAttribute("aria-hidden", "true");
  }
  if (statsContent) statsContent.innerHTML = "";
  onDismissCallback = null;
}

/**
 * Bind tap/click on the container. When fired: calls onTap(). Use onTap to end session, show play icon, then show stats and pass onDismiss.
 * Ignores taps on the stats panel (e.g. Done button) or play icon so they don't re-trigger the session-end flow.
 */
export function bindTap(container: HTMLElement, onTap: () => void): void {
  unbindTap(container);
  const handler = (e: MouseEvent | TouchEvent) => {
    const target = e.target as Node;
    if (statsPanel?.contains(target) || playIconWrap?.contains(target) || settingsBtn?.contains(target)) return;
    e.preventDefault();
    onTap();
  };
  tapHandler = handler;
  container.addEventListener("click", handler, { passive: false });
  container.addEventListener("touchend", handler, { passive: false });
}

/**
 * Stop goo animation and hide the lava lamp layer (e.g. when leaving downregulation view).
 */
export function stopGooLayer(): void {
  if (gooRafId != null) {
    cancelAnimationFrame(gooRafId);
    gooRafId = null;
  }
  gooLastFrameTime = 0;
  if (gooLayer) {
    gooLayer.style.display = "none";
    gooLayer.setAttribute("aria-hidden", "true");
  }
}

/**
 * Stop noise animation and hide the noise canvas layer (e.g. when leaving downregulation view).
 */
export function stopNoiseLayer(): void {
  if (noiseRafId != null) {
    cancelAnimationFrame(noiseRafId);
    noiseRafId = null;
  }
  if (noiseLayer) {
    noiseLayer.style.display = "none";
    noiseLayer.setAttribute("aria-hidden", "true");
  }
}

/**
 * Unbind only the session tap-to-end handler.
 */
export function unbindTap(container: HTMLElement): void {
  if (tapHandler) {
    container.removeEventListener("click", tapHandler);
    container.removeEventListener("touchend", tapHandler);
    tapHandler = null;
  }
}

/**
 * Fully hide/reset overlay UI and stop style-specific layers (used when leaving the view).
 */
export function teardownOverlay(container?: HTMLElement): void {
  if (container) unbindTap(container);
  if (startClickHandler && playIconWrap) {
    playIconWrap.removeEventListener("click", startClickHandler);
    playIconWrap.removeEventListener("touchend", startClickHandler);
    startClickHandler = null;
  }
  hideStats();
  hidePlayIcon();
  hideSessionHint();
  stopGooLayer();
  stopNoiseLayer();
  if (prefsModal) prefsModal.style.display = "none";
  playIconWrap = null;
  sessionHintEl = null;
  statsPanel = null;
  statsContent = null;
  doneButton = null;
  settingsBtn = null;
  gooLayer = null;
  gooBlobElements = [];
  noiseLayer = null;
  noiseCanvas = null;
  prefsModal = null;
}
