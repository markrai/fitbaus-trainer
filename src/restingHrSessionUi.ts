/**
 * Profile-local resting-session HR measurement UI. Reuses hrMonitor BPM
 * notifications as the sole observation source; the 1 Hz timer refreshes UI
 * only. Does not own BLE or change workout control.
 */

import { onBpm, onDisconnect } from "./hrMonitor.js";
import {
  abandonRestingHrOnDisconnect,
  cancelRestingHrAcquisition,
  createRestingHrAcquisition,
  evaluateRestingHrStartReadiness,
  finalizeRestingHrAcquisition,
  ingestRestingHrBpmNotification,
  refreshRestingHrAcquisitionUi,
  rejectReasonText,
  RESTING_HR_SESSION_POLICY_V1,
  type RestingHrAcquisitionState,
  type RestingHrLiveStatus,
} from "./restingHrAcquisition.js";
import { loadProfileFitness } from "./profileFitnessView.js";
import { storeRestingHeartRateSession } from "./fitnessState.js";
import { loadAthleteProfile } from "./profile.js";
import { readActiveSessionOwner } from "./freestyleRide.js";
import { getSession } from "./sessionStore.js";
import { generateUUID } from "./utils/uuid.js";

let acquisition: RestingHrAcquisitionState | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let bpmUnsubscribeReady = false;

function monoNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function setHidden(id: string, hidden: boolean): void {
  const element = document.getElementById(id);
  if (element) element.hidden = hidden;
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function formatElapsed(elapsedSec: number): string {
  const minutes = Math.floor(elapsedSec / 60);
  const seconds = elapsedSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function phaseText(status: RestingHrLiveStatus): string {
  if (status.phase === "settling") return "Settling";
  if (status.phase === "observing") return "Measuring";
  if (status.phase === "completed") return "Complete";
  if (status.phase === "rejected") return "Not accepted";
  if (status.phase === "cancelled") return "Cancelled";
  return "";
}

function strapConnected(): boolean {
  return !!(window as any).hrDeviceName;
}

function workoutInProgress(): boolean {
  const owner = readActiveSessionOwner();
  if (!owner) return false;
  const session = getSession(owner.selector);
  return !!(session.sessionId && session.startTime && session.sessionId === owner.sessionId);
}

function showToast(message: string, kind: "info" | "error" = "info"): void {
  if (typeof (window as any).showToast === "function") {
    (window as any).showToast(message, kind);
  }
}

function renderLive(status: RestingHrLiveStatus): void {
  setText("restingHrLiveBpm", status.liveBpm != null ? String(status.liveBpm) : "—");
  setText("restingHrElapsed", formatElapsed(status.elapsedSec));
  setText("restingHrPhase", phaseText(status));
  setText("restingHrSignal", status.qualityLine);
}

function stopTimer(): void {
  if (tickTimer != null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function setMeasuringUi(measuring: boolean): void {
  setHidden("restingHrSession", !measuring);
  setHidden("restingHrMeasureButton", measuring);
  setHidden("restingHrCancelButton", !measuring);
  if (measuring) {
    setHidden("restingHrEmpty", true);
    setHidden("restingHrContent", true);
    setHidden("restingHrResult", true);
  }
}

function endMeasurement(): void {
  stopTimer();
  acquisition = null;
  setMeasuringUi(false);
  loadProfileFitness();
}

function interruptIfWorkoutBecameActive(monoMs: number): boolean {
  if (!acquisition || acquisition.status !== "measuring") return false;
  if (!workoutInProgress()) return false;
  cancelRestingHrAcquisition(acquisition, monoMs, "interrupted");
  setHidden("restingHrResult", false);
  setText(
    "restingHrResult",
    "Measurement interrupted because a workout became active. Saved resting-session evidence was not changed."
  );
  endMeasurement();
  return true;
}

function endForDisconnect(monoMs: number): void {
  if (!acquisition) return;
  if (acquisition.status === "measuring") {
    abandonRestingHrOnDisconnect(acquisition, monoMs);
  }
  if (acquisition.status !== "rejected" || acquisition.rejectReason !== "disconnected") return;
  setHidden("restingHrResult", false);
  setText(
    "restingHrResult",
    `${rejectReasonText("disconnected")} Saved resting-session evidence was not changed.`
  );
  endMeasurement();
}

function handleDisconnectAbandoned(status: RestingHrLiveStatus, monoMs: number): boolean {
  if (status.status !== "rejected" || status.rejectReason !== "disconnected") return false;
  endForDisconnect(monoMs);
  return true;
}

function completeMeasurement(monoMs: number): void {
  if (!acquisition) return;
  const owningAthleteId = acquisition.athleteId;
  const observedAt = new Date().toISOString();
  const result = finalizeRestingHrAcquisition(acquisition, monoMs, {
    observedAt,
    updatedAt: observedAt,
  });
  stopTimer();
  setMeasuringUi(false);
  if (result.outcome === "cancelled") {
    setHidden("restingHrResult", false);
    setText("restingHrResult", "Measurement cancelled. Saved resting-session evidence was not changed.");
    acquisition = null;
    loadProfileFitness();
    return;
  }
  if (result.outcome === "rejected") {
    setHidden("restingHrResult", false);
    setText(
      "restingHrResult",
      `${rejectReasonText(result.reason)} Saved resting-session evidence was not changed.`
    );
    acquisition = null;
    loadProfileFitness();
    return;
  }
  const currentAthleteId = loadAthleteProfile().athleteId;
  if (currentAthleteId !== owningAthleteId) {
    setHidden("restingHrResult", false);
    setText(
      "restingHrResult",
      "The athlete identity changed before save. The measurement was discarded and existing evidence was not changed."
    );
    acquisition = null;
    loadProfileFitness();
    return;
  }
  const stored = storeRestingHeartRateSession(result.metric, undefined, {
    expectedAthleteId: owningAthleteId,
  });
  if (stored.outcome === "retained_higher_quality") {
    setHidden("restingHrResult", false);
    setText(
      "restingHrResult",
      `This ${result.metric.quality} measurement was not saved. The existing higher-quality resting-session result was kept.`
    );
  } else if (stored.outcome === "applied") {
    setHidden("restingHrResult", false);
    setText(
      "restingHrResult",
      `Accepted resting-session HR: ${result.metric.value.heartRateBpm} bpm (${result.metric.quality} quality). This is a seated resting-session observation, not a clinical baseline, and it does not change workouts.`
    );
  } else if (stored.outcome === "storage_conflict") {
    setHidden("restingHrResult", false);
    setText(
      "restingHrResult",
      "Existing fitness data could not be read safely, so the measurement was not saved."
    );
  } else if (stored.outcome === "athlete_mismatch") {
    setHidden("restingHrResult", false);
    setText(
      "restingHrResult",
      "Athlete identity did not match stored fitness data. The measurement was not saved."
    );
  } else {
    setHidden("restingHrResult", false);
    setText("restingHrResult", "The measurement could not be saved. Existing evidence was not changed.");
  }
  acquisition = null;
  loadProfileFitness();
}

function maybeComplete(status: RestingHrLiveStatus, monoMs: number): void {
  if (status.elapsedSec >= RESTING_HR_SESSION_POLICY_V1.totalDurationSec) {
    completeMeasurement(monoMs);
  }
}

function uiPulse(): void {
  if (!acquisition) return;
  const monoMs = monoNow();
  if (interruptIfWorkoutBecameActive(monoMs)) return;
  const status = refreshRestingHrAcquisitionUi(acquisition, {
    monoMs,
    connected: strapConnected(),
  });
  renderLive(status);
  if (handleDisconnectAbandoned(status, monoMs)) return;
  maybeComplete(status, monoMs);
}

function onBpmNotification(bpm: number): void {
  if (!acquisition) return;
  const monoMs = monoNow();
  if (interruptIfWorkoutBecameActive(monoMs)) return;
  const status = ingestRestingHrBpmNotification(acquisition, {
    monoMs,
    bpm,
    connected: strapConnected(),
  });
  renderLive(status);
  if (handleDisconnectAbandoned(status, monoMs)) return;
  maybeComplete(status, monoMs);
}

function onHrStrapDisconnect(): void {
  if (!acquisition || acquisition.status !== "measuring") return;
  endForDisconnect(monoNow());
}

export function startRestingHrMeasurement(): void {
  const readiness = evaluateRestingHrStartReadiness({
    connected: strapConnected(),
    workoutInProgress: workoutInProgress(),
    measurementInProgress: acquisition != null,
  });
  if (readiness.ok === false) {
    if (readiness.reason === "not_connected") {
      showToast("Connect a chest strap before measuring resting HR.", "error");
    } else if (readiness.reason === "workout_in_progress") {
      showToast("Finish or discard the active workout before measuring resting HR.", "error");
    }
    return;
  }
  const athleteId = loadAthleteProfile().athleteId;
  acquisition = createRestingHrAcquisition({
    startedAtMonoMs: monoNow(),
    measurementId: generateUUID(),
    athleteId,
  });
  setMeasuringUi(true);
  setHidden("restingHrResult", true);
  uiPulse();
  tickTimer = setInterval(() => uiPulse(), 1000);
}

export function cancelRestingHrMeasurement(): void {
  if (!acquisition) return;
  cancelRestingHrAcquisition(acquisition, monoNow(), "cancelled");
  setHidden("restingHrResult", false);
  setText("restingHrResult", "Measurement cancelled. Saved resting-session evidence was not changed.");
  endMeasurement();
}

export function registerRestingHrSessionGlobals(): void {
  (window as any).startRestingHrMeasurement = startRestingHrMeasurement;
  (window as any).cancelRestingHrMeasurement = cancelRestingHrMeasurement;
  if (!bpmUnsubscribeReady) {
    onBpm((bpm) => onBpmNotification(bpm));
    onDisconnect(() => onHrStrapDisconnect());
    bpmUnsubscribeReady = true;
  }
}
