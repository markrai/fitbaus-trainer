/**
 * Soothing audio for downregulation sessions.
 *
 * Algorithm:
 * - Slow rhythmic pulse at 6–12 CPM (0.1–0.2 Hz) to support relaxation / parasympathetic activation.
 * - Pulse = amplitude modulation of a low-frequency carrier (soft swell), no sharp attacks.
 * - HR drives pulse tempo: high HR → 12 CPM, low HR → 6 CPM. Smoothed over 30–60 s.
 * - One-way guidance: pulse only slows as HR drops; we never increase tempo when HR goes up.
 * - getSmoothedHR() is sampled every 2–5 s; target period is smoothed with long time constant;
 *   "current" period only increases (pulse only slows), never decreases on HR increase.
 *
 * Parameters (calming effect):
 * - Pulse: 6–12 CPM; carrier 50–80 Hz sine; lowpass 300–500 Hz.
 * - Envelope per pulse: attack 0.4–0.8 s, sustain 0–0.2 s, release 0.8–1.2 s.
 * - HR mapping: 40 bpm → 6 CPM, 100+ bpm → 12 CPM (linear in between).
 * - Master gain low (~0.15–0.25) for safe listening (~60–70 dB SPL equivalent).
 */

import { getSmoothedHR } from "./hrController.js";

export type SoundStyle = "binaural" | "whale" | "none";
const SOUND_STYLE_STORAGE_KEY = "downregulationSoundStyle";
const SOUND_STYLE_DEFAULT: SoundStyle = "binaural";

let soundStyle: SoundStyle = SOUND_STYLE_DEFAULT;
(function loadSoundStyle() {
  try {
    const stored = localStorage.getItem(SOUND_STYLE_STORAGE_KEY);
    if (stored === "binaural" || stored === "whale" || stored === "none") soundStyle = stored;
  } catch {
    /* ignore */
  }
})();

export function getSoundStyle(): SoundStyle {
  return soundStyle;
}

export function setSoundStyle(value: SoundStyle): void {
  if (value !== "binaural" && value !== "whale" && value !== "none") return;
  soundStyle = value;
  try {
    localStorage.setItem(SOUND_STYLE_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
}

// --- Constants (within spec ranges) ---
const PULSE_CPM_MIN = 6;
const PULSE_CPM_MAX = 12;
const CARRIER_HZ = 60;
const LOWPASS_FREQ = 400;
const LOWPASS_Q = 0.5;
const ENVELOPE_ATTACK_S = 0.6;
const ENVELOPE_SUSTAIN_S = 0.1;
const ENVELOPE_RELEASE_S = 1.0;
const PULSE_PEAK_GAIN = 0.35;
const MASTER_GAIN = 0.2;
const HR_BPM_LOW = 40;
const HR_BPM_HIGH = 100;
const PULSE_UPDATE_INTERVAL_MS = 3000;
const PULSE_SMOOTH_TC_S = 45;
const SCHEDULER_TICK_MS = 100;
const BINAURAL_BASE_HZ = 200;
const BINAURAL_DELTA_HZ = 8;
const BINAURAL_GAIN = 0.02;
const STEREO_LFO_HZ = 0.02;
const STEREO_PAN_DEPTH = 0.15;

let audioContext: AudioContext | null = null;
let masterGain: GainNode | null = null;
let pulseCarrier: OscillatorNode | null = null;
let lowpass: BiquadFilterNode | null = null;
let pulseGain: GainNode | null = null;
let stereoPanner: StereoPannerNode | null = null;
let panLfo: OscillatorNode | null = null;
let binOscL: OscillatorNode | null = null;
let binOscR: OscillatorNode | null = null;
let binGainL: GainNode | null = null;
let binGainR: GainNode | null = null;
let merger: ChannelMergerNode | null = null;
let schedulerIntervalId: ReturnType<typeof setInterval> | null = null;
let hrUpdateIntervalId: ReturnType<typeof setInterval> | null = null;

let nextPulseTime = 0;
let currentPeriodSec = 60 / PULSE_CPM_MAX;
let smoothedTargetPeriodSec = 60 / PULSE_CPM_MAX;
let running = false;

function hrToTargetPeriodSec(hr: number | null): number {
  if (hr == null || hr < HR_BPM_LOW) return 60 / PULSE_CPM_MIN;
  const t = Math.min(1, (hr - HR_BPM_LOW) / (HR_BPM_HIGH - HR_BPM_LOW));
  const cpm = PULSE_CPM_MIN + (PULSE_CPM_MAX - PULSE_CPM_MIN) * t;
  return 60 / cpm;
}

function updatePulsePeriodFromHR(): void {
  const hr = getSmoothedHR();
  const targetSec = hrToTargetPeriodSec(hr);
  const now = performance.now() / 1000;
  const alpha = 1 - Math.exp(-PULSE_UPDATE_INTERVAL_MS / 1000 / PULSE_SMOOTH_TC_S);
  smoothedTargetPeriodSec = smoothedTargetPeriodSec + (targetSec - smoothedTargetPeriodSec) * alpha;
  if (smoothedTargetPeriodSec > currentPeriodSec) {
    currentPeriodSec = smoothedTargetPeriodSec;
  }
}

const WHALE_PITCH_START_HZ = 110;
const WHALE_PITCH_END_HZ = 72;
const WHALE_PITCH_GLIDE_S = 0.22;
/** Whale mode: fixed 10 pulses per minute (repeat every 6 s). Lower gain and smooth release to avoid clipping. */
const WHALE_PERIOD_SEC = 60 / 5;
const WHALE_PEAK_GAIN = 0.22;
const WHALE_ATTACK_S = 1.5;
const WHALE_RELEASE_TC = 0.7;
const SCHEDULER_LOOKAHEAD_SEC = 30;

function scheduleEnvelope(atTime: number): void {
  if (!pulseGain || !audioContext) return;
  const isWhale = getSoundStyle() === "whale";
  const peak = isWhale ? WHALE_PEAK_GAIN : PULSE_PEAK_GAIN;
  const attackS = isWhale ? WHALE_ATTACK_S : ENVELOPE_ATTACK_S;
  const t0 = atTime;
  const t1 = t0 + attackS;
  const t2 = t1 + ENVELOPE_SUSTAIN_S;
  const t3 = t2 + ENVELOPE_RELEASE_S;
  pulseGain.gain.setValueAtTime(0, t0);
  pulseGain.gain.linearRampToValueAtTime(peak, t1);
  pulseGain.gain.setValueAtTime(peak, t2);
  if (isWhale) {
    pulseGain.gain.setTargetAtTime(0, t2, WHALE_RELEASE_TC);
  } else {
    pulseGain.gain.linearRampToValueAtTime(0, t3);
  }
  if (isWhale && pulseCarrier) {
    pulseCarrier.frequency.setValueAtTime(WHALE_PITCH_START_HZ, t0);
    pulseCarrier.frequency.linearRampToValueAtTime(WHALE_PITCH_END_HZ, t0 + WHALE_PITCH_GLIDE_S);
  }
}

function getCurrentPeriodSec(): number {
  return getSoundStyle() === "whale" ? WHALE_PERIOD_SEC : currentPeriodSec;
}

function schedulerTick(): void {
  if (!audioContext || !running) return;
  const now = audioContext.currentTime;
  const period = getCurrentPeriodSec();
  while (nextPulseTime <= now + SCHEDULER_LOOKAHEAD_SEC) {
    scheduleEnvelope(nextPulseTime);
    nextPulseTime += period;
  }
}

function buildGraph(): boolean {
  if (typeof window === "undefined" || !window.AudioContext && !(window as any).webkitAudioContext) return false;
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx();
  audioContext = ctx;

  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(ctx.destination);
  masterGain = master;

  const pan = ctx.createStereoPanner();
  pan.pan.value = 0;
  pan.connect(master);
  stereoPanner = pan;

  const carrier = ctx.createOscillator();
  carrier.type = "sine";
  carrier.frequency.value = CARRIER_HZ;
  carrier.start(0);

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = LOWPASS_FREQ;
  lp.Q.value = LOWPASS_Q;
  carrier.connect(lp);

  const pGain = ctx.createGain();
  pGain.gain.value = 0;
  lp.connect(pGain);
  pGain.connect(pan);
  pulseCarrier = carrier;
  lowpass = lp;
  pulseGain = pGain;

  const useBinaural = getSoundStyle() === "binaural";
  if (useBinaural) {
    const merge = ctx.createChannelMerger(2);
    merger = merge;
    merge.connect(pan);

    const oscL = ctx.createOscillator();
    oscL.type = "sine";
    oscL.frequency.value = BINAURAL_BASE_HZ;
    oscL.start(0);
    const gL = ctx.createGain();
    gL.gain.value = BINAURAL_GAIN;
    oscL.connect(gL);
    gL.connect(merge, 0, 0);

    const oscR = ctx.createOscillator();
    oscR.type = "sine";
    oscR.frequency.value = BINAURAL_BASE_HZ + BINAURAL_DELTA_HZ;
    oscR.start(0);
    const gR = ctx.createGain();
    gR.gain.value = BINAURAL_GAIN;
    oscR.connect(gR);
    gR.connect(merge, 0, 1);

    binOscL = oscL;
    binOscR = oscR;
    binGainL = gL;
    binGainR = gR;
  }
  if (getSoundStyle() === "whale" && pulseCarrier) {
    pulseCarrier.frequency.value = WHALE_PITCH_START_HZ;
  }

  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = STEREO_LFO_HZ;
  lfo.start(0);
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = STEREO_PAN_DEPTH;
  lfo.connect(lfoGain);
  lfoGain.connect(pan.pan);
  panLfo = lfo;
  return true;
}

function disconnectAndClear(): void {
  if (schedulerIntervalId != null) {
    clearInterval(schedulerIntervalId);
    schedulerIntervalId = null;
  }
  if (hrUpdateIntervalId != null) {
    clearInterval(hrUpdateIntervalId);
    hrUpdateIntervalId = null;
  }
  pulseCarrier?.stop();
  pulseCarrier = null;
  lowpass = null;
  pulseGain = null;
  panLfo?.stop();
  panLfo = null;
  binOscL?.stop();
  binOscR?.stop();
  binOscL = null;
  binOscR = null;
  binGainL = null;
  binGainR = null;
  merger = null;
  stereoPanner = null;
  masterGain = null;
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  running = false;
}

/**
 * Start soothing pulse audio. Call when the downregulation session becomes active (after user presses Play).
 * Resumes AudioContext on first run (user gesture already occurred via Play button).
 */
export function startCalmAudio(): void {
  if (running) return;
  if (getSoundStyle() === "none") return;
  if (!buildGraph()) return;
  running = true;
  const ctx = audioContext!;
  ctx.resume().then(() => {
    if (!audioContext) return;
    nextPulseTime = ctx.currentTime;
    currentPeriodSec = 60 / PULSE_CPM_MAX;
    smoothedTargetPeriodSec = 60 / PULSE_CPM_MAX;
    updatePulsePeriodFromHR();
    const period = getCurrentPeriodSec();
    scheduleEnvelope(nextPulseTime);
    nextPulseTime += period;
    schedulerIntervalId = setInterval(schedulerTick, SCHEDULER_TICK_MS);
    hrUpdateIntervalId = setInterval(updatePulsePeriodFromHR, PULSE_UPDATE_INTERVAL_MS);
  }).catch(() => {
    disconnectAndClear();
  });
}

/**
 * Stop soothing audio and release Web Audio resources. Call when session ends (tap) or view stops.
 */
export function stopCalmAudio(): void {
  running = false;
  disconnectAndClear();
}

/**
 * If audio is currently running, restart it with the current sound style (e.g. after user switches Binaural/Whale in prefs).
 * Call after setSoundStyle() when the user changes the sound radio. No-op if no session is active.
 */
export function restartCalmAudioIfRunning(): void {
  stopCalmAudio();
  if (getSoundStyle() !== "none") startCalmAudio();
}
