
import {
  adjustedBlockLengths,
  beginWorkout,
  formatTime,
  getPhase,
  getPausedElapsed,
  getStartTime,
  isPaused,
  pauseWorkout,
  restartWorkout,
  resumeWorkout,
  requestEarlyCooldown,
  planEarlyCooldownTransition,
  lastPersistedElapsedFromHrSamples,
  workoutRelativeHrSample,
  recordVo2ActiveBikeTelemetry,
  ordinaryActiveBikeTelemetrySample,
  startWorkout,
  todayName,
  updateRing,
  tickVo2ProtocolWithCanonicalHr,
  requestVo2LimitReached,
} from "./workoutLogic.js";
import { getPlan, getWorkoutMetadata, getHrTargets } from "./workoutData.js";
import {
  getAllWorkoutSummaries,
  deleteWorkoutSummary,
  getHrSamples,
  getOrdinaryBikeTelemetrySamples,
  queueOrdinaryBikeTelemetrySample,
} from "./workoutStorage.js";
import { sendWorkoutToSisu } from "./sisuSync.js";
import { handleWorkoutCompletion } from "./workoutLifecycle.js";
import { connect as hrConnect, disconnect as hrDisconnect, onBpm, onHrvUpdate } from "./hrMonitor.js";
import { formatHrvDisplay, type HrvDisplayModel } from "./platform/hrvDisplay.js";
import { getSession } from "./sessionStore.js";
import { assessmentBasedWorkloadForPhase } from "./personalizedPrescription.js";
import { createActuationProvenanceObserver } from "./actuationProvenanceObserver.js";
import { buildScientificSessionEvidenceV2Contexts, type RawWorkoutTelemetry } from "./scientificSessionEvidence.js";
import {
  isVo2WorkoutSelector,
  vo2ProtocolDisplayName,
  VO2_WORKOUT_SELECTOR_ID,
} from "./vo2Protocol.js";
import { vo2ProtocolHoldForPhaseForRuntime, vo2ProtocolUiTargetsForRuntime } from "./vo2ProtocolV3.js";
import {
  genericWorkoutBlocksText,
  vo2AssessmentPresentation,
  vo2CancelModalBody,
  vo2CancelModalTitle,
  vo2EndWorkoutButtonLabel,
  vo2HistoryOutcomeText,
  vo2LimitReachedButtonVisible,
  vo2SelectorOptionText,
  vo2WorkoutBlocksText,
} from "./vo2AssessmentView.js";
import { startDownregulationView, stopDownregulationView } from "./downregulation/index.js";
import { listMachinesForActivity, isMachineId } from "./machines/registry.js";
import {
  formatBikeBridgeControl,
  formatBikeBridgeNumber,
  formatBikeBridgeReadiness,
  getBikeBridgeSession,
} from "./platform/bikeBridgeRuntime.js";
import { getEquipmentSelection, setSelectedMachine } from "./machines/selection.js";
import {
  recordMachineHeartRateSample,
  updateMachineGuidanceRuntime,
  type MachineGuidanceRuntimeUpdate,
} from "./machines/runtime.js";
import {
  formatLearnedGuidanceLabel,
  listLearnedStarts,
  resetLearnedGuidanceForMachine,
} from "./machines/learning/index.js";
import {
  listHrDynamics,
  resetHrDynamicsForMachine,
  type LearnedHrDynamics,
} from "./machines/dynamics/index.js";
import {
  listShadowPredictions,
  resetShadowPredictionsForMachine,
  shadowValidationStatusLabel,
  type ShadowResistanceDiagnostics,
} from "./machines/prediction/index.js";
import {
  buildMachineDiagnosticsSnapshot,
  prepareMachineDiagnosticsExport,
} from "./machines/diagnostics/index.js";
import { loadAthleteProfile } from "./profile.js";
import { buildPersonalizationHistoryDetail } from "./personalizationStatus.js";
import {
  EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS,
  buildPersonalizationDiagnosticsModel,
  extractTrustedPersonalizationAssessmentContexts,
  extractTrustedPersonalizationCharacterizations,
  extractTrustedPersonalizationPerformedLoadContexts,
  extractTrustedExecutionProvenanceContexts,
  extractTrustedPersonalizationWorkoutContexts,
  personalizationDiagnosticDetailHtml,
  personalizationDiagnosticsExportJson,
  personalizationDiagnosticsHtml,
  type PersonalizationDiagnosticsFilters,
  type PersonalizationDiagnosticsModel,
} from "./personalizationDiagnosticsView.js";
import {
  PERFORMED_LOAD_DIAGNOSTICS_RECENT_LIMIT,
  buildPerformedLoadWorkoutView,
} from "./performedLoad.js";
import { performedLoadDiagnosticsHtml } from "./performedLoadDiagnosticsView.js";
import type {
  Activity,
  ResolvedHeartRateTarget,
  ResolvedWorkoutPhaseTarget,
  ResolvedWorkoutPrescription,
  WorkoutPhaseState,
} from "./types.js";
import { ACTIVITY_LABELS, getActiveWorkoutActivity } from "./workoutActivity.js";
import {
  findResolvedPhaseTarget,
  formatResolvedHeartRateTarget,
  machineHeartRateTargetFromResolved,
  resolveWorkoutPrescription,
} from "./workoutPrescription.js";

let selectedDay: string | null = null;
let liveBpm: number | null = null;
let lastBpmUpdateTime: number | null = null;
const BPM_TIMEOUT_MS = 3000;
let showElapsedInRing = false;
let pendingVo2Cues: string[] = [];
let personalizationDiagnosticsRecords: ReturnType<typeof extractTrustedPersonalizationCharacterizations> = [];
let personalizationAssessmentContexts: ReturnType<typeof extractTrustedPersonalizationAssessmentContexts> = {};
let personalizationWorkoutContexts: ReturnType<typeof extractTrustedPersonalizationWorkoutContexts> = {};
let personalizationPerformedLoadContexts: ReturnType<typeof extractTrustedPersonalizationPerformedLoadContexts> = {};
let personalizationExecutionProvenanceContexts: ReturnType<typeof extractTrustedExecutionProvenanceContexts> = {};
let personalizationScientificSessionContexts: ReturnType<typeof buildScientificSessionEvidenceV2Contexts> = {};
let personalizationDiagnosticsModel: PersonalizationDiagnosticsModel | null = null;

let heartPulseTargetBpm: number | null = null;
let heartPulseRafId: number | null = null;
let currentExpectedHeartRate: ResolvedHeartRateTarget | null = null;
const HEART_PULSE_SCALE = 1.15;

function heartPulseLoop() {
  heartPulseRafId = null;
  const heartIcon = document.getElementById("heartIcon");
  if (!heartIcon || heartPulseTargetBpm === null) {
    if (heartIcon) heartIcon.style.setProperty("transform", "scale(1)", "important");
    return;
  }
  const durationSec = 60 / heartPulseTargetBpm;
  const phase = ((Date.now() / 1000) % durationSec) / durationSec;
  const scale = 1 + (HEART_PULSE_SCALE - 1) * Math.sin(phase * Math.PI);
  heartIcon.style.setProperty("transform", `scale(${scale})`, "important");
  heartPulseRafId = requestAnimationFrame(heartPulseLoop);
}

function getShowElapsed() {
  return showElapsedInRing;
}

(window as any).liveBpm = liveBpm;
(window as any).lastBpmUpdateTime = lastBpmUpdateTime;

let phaseDisplayEl: HTMLElement | null = null;
let settingsModalEscHandler: ((e: KeyboardEvent) => void) | null = null;
function getSelectedDay() {
  return selectedDay || todayName();
}

function setSelectedDay(day: string) {
  selectedDay = day;
}

function ensureWorkoutDayDropdown() {
  const select = document.getElementById("workoutDaySelect") as HTMLSelectElement | null;
  if (!select) return;
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const plan = typeof getPlan === "function" ? getPlan() : {};
  const metadata = typeof getWorkoutMetadata === "function" ? getWorkoutMetadata() : {};
  if (select.options.length === 0) {
    days.forEach((day) => {
      const opt = document.createElement("option");
      opt.value = day;
      const meta = (metadata as any)[day];
      opt.textContent = meta && meta.type ? day + ": " + meta.type : day;
      select.appendChild(opt);
    });
    const vo2Opt = document.createElement("option");
    vo2Opt.value = VO2_WORKOUT_SELECTOR_ID;
    vo2Opt.textContent = vo2SelectorOptionText();
    select.appendChild(vo2Opt);
    const downregOpt = document.createElement("option");
    downregOpt.value = "Downregulation";
    downregOpt.textContent = "Downregulation";
    select.appendChild(downregOpt);
    select.addEventListener("change", function () {
      selectedDay = this.value;
      updateDisplay();
    });
  }
  const hasVo2 = Array.from(select.options).some((o) => o.value === VO2_WORKOUT_SELECTOR_ID);
  if (!hasVo2) {
    const vo2Opt = document.createElement("option");
    vo2Opt.value = VO2_WORKOUT_SELECTOR_ID;
    vo2Opt.textContent = vo2SelectorOptionText();
    const downreg = Array.from(select.options).find((o) => o.value === "Downregulation");
    if (downreg) select.insertBefore(vo2Opt, downreg);
    else select.appendChild(vo2Opt);
  }
  const hasDownreg = Array.from(select.options).some((o) => o.value === "Downregulation");
  if (!hasDownreg) {
    const downregOpt = document.createElement("option");
    downregOpt.value = "Downregulation";
    downregOpt.textContent = "Downregulation";
    select.appendChild(downregOpt);
  }
  const current = getSelectedDay();
  if (select.value !== current) select.value = current;
}

function connectHr() {
  const connected = !!(window as any).hrDeviceName;
  if (connected) {
    hrDisconnect();
  } else {
    hrConnect();
  }
}

function applyBatteryToElement(batteryEl: HTMLElement | null, battery: number | null | undefined) {
  if (!batteryEl) return;
  if (typeof battery === "number" && battery >= 0 && battery <= 100) {
    batteryEl.classList.add("battery-pill");
    batteryEl.style.setProperty("--battery-pct", String(battery));
    const state = battery <= 15 ? "low" : battery <= 35 ? "med" : "good";
    batteryEl.setAttribute("data-battery-state", state);
    batteryEl.style.display = "";
    let pctSpan = batteryEl.querySelector(".battery-pill-pct");
    if (!pctSpan) {
      pctSpan = document.createElement("span");
      pctSpan.className = "battery-pill-pct";
      batteryEl.appendChild(pctSpan);
    }
    pctSpan.textContent = battery + "%";
  } else {
    batteryEl.textContent = "";
    batteryEl.style.display = "none";
    batteryEl.classList.remove("battery-pill");
    batteryEl.removeAttribute("data-battery-state");
    batteryEl.style.removeProperty("--battery-pct");
  }
}

function updateHrMonitorLabel() {
  const labelEl = document.getElementById("hrMonitorLabel");
  const batteryEl = document.getElementById("hrMonitorBattery");
  const btnEl = document.getElementById("connectHrButton");
  const name = (window as any).hrDeviceName as string | null | undefined;
  const battery = (window as any).hrBatteryPercent as number | null | undefined;
  if (labelEl) {
    if (name) {
      labelEl.textContent = name + " connected";
      labelEl.style.color = "#22c55e";
      labelEl.style.opacity = "1";
    } else {
      labelEl.textContent = "Heart Rate Monitor";
      labelEl.style.color = "";
      labelEl.style.opacity = "0.7";
    }
  }
  if (btnEl) {
    if (name) {
      btnEl.textContent = "Disconnect HR Strap";
      btnEl.classList.add("hr-connected");
    } else {
      btnEl.textContent = "Connect HR Strap";
      btnEl.classList.remove("hr-connected");
    }
  }
  applyBatteryToElement(batteryEl as HTMLElement | null, battery);
}

function updateHrDisplay(hr: number | null) {
  const hrNowEl = document.getElementById("hrNow");
  if (hrNowEl) {
    if (hr && hr > 0) {
      hrNowEl.textContent = hr.toString();
    } else {
      hrNowEl.textContent = "";
    }
  }
}

let lastHrvDisplayKey = "";

function renderHrvDisplay(model: HrvDisplayModel): void {
  const key = `${model.state}|${model.primary}|${model.secondary}`;
  if (key === lastHrvDisplayKey) return;
  lastHrvDisplayKey = key;
  const primaryEl = document.getElementById("hrvPrimary");
  const secondaryEl = document.getElementById("hrvSecondary");
  if (primaryEl) primaryEl.textContent = model.primary;
  if (secondaryEl) secondaryEl.textContent = model.secondary;
}
const PHASE_STYLE_MAP: Record<string, { stroke: string; background: string; text: string }> = {
  "Warm-Up": { stroke: "#ffad5c", background: "rgba(255,173,92,0.18)", text: "#ffe9cc" },
  Sustain: { stroke: "#3d7cff", background: "rgba(61,124,255,0.18)", text: "#dbe5ff" },
  "Cool-Down": { stroke: "#eab308", background: "rgba(234,179,8,0.18)", text: "#fef9c3" },
  Rest: { stroke: "#888", background: "#1c1c1c", text: "#fff" },
  idle: { stroke: "#3d7cff", background: "#232323", text: "#fff" },
  completed: { stroke: "#fff", background: "rgba(255,255,255,0.2)", text: "#fff" },
};
const COMPLETED_LIGHT_MODE = { stroke: "#000", background: "rgba(0,0,0,0.08)", text: "#000" };
const DEFAULT_PHASE_STYLE = { stroke: "#3d7cff", background: "#232323", text: "#fff" };

function getPhaseStyle(key: string): { stroke: string; background: string; text: string } {
  const base = PHASE_STYLE_MAP[key] || DEFAULT_PHASE_STYLE;
  if (key === "completed" || key === "Completed") {
    const light = window.matchMedia("(prefers-color-scheme: light)").matches;
    return light ? COMPLETED_LIGHT_MODE : base;
  }
  return base;
}

function applyPhaseStyle(key: string) {
  const style = getPhaseStyle(key);
  const ringEl = document.getElementById("ringProgress");
  if (ringEl instanceof SVGCircleElement) {
    ringEl.style.stroke = style.stroke;
  }
  if (phaseDisplayEl) {
    phaseDisplayEl.style.background = style.background;
    phaseDisplayEl.style.color = style.text;
  }
}

function openModal() {
  if (typeof (window as any).loadProfile === "function") (window as any).loadProfile();
  if (typeof (window as any).loadProfileFitness === "function") (window as any).loadProfileFitness();
  const bg = document.getElementById("modalBg");
  if (bg) bg.style.display = "flex";
  settingsModalEscHandler = (e) => {
    if (e.key === "Escape" || e.keyCode === 27) closeModal();
  };
  document.addEventListener("keydown", settingsModalEscHandler);
}

function closeModal() {
  const bg = document.getElementById("modalBg");
  if (bg) bg.style.display = "none";
  if (settingsModalEscHandler) {
    document.removeEventListener("keydown", settingsModalEscHandler);
    settingsModalEscHandler = null;
  }
}

function openCancelModal() {
  const day = getSelectedDay();
  const isVo2 = isVo2WorkoutSelector(day);
  const session = getSession(day);
  const plan = getPlan();
  const base = (plan as any)[day];
  const blocks = session.phasePlan?.blocks ?? (base ? adjustedBlockLengths(base, null) : null);
  const elapsedSec = session.paused
    ? session.pausedElapsed
    : session.startTime
      ? Math.floor((Date.now() - parseInt(session.startTime, 10)) / 1000)
      : 0;
  const decision = planEarlyCooldownTransition({
    blocks,
    hasSession: Boolean(session.startTime),
    elapsedSec,
    paused: session.paused,
    earlyCooldownElapsed: session.earlyCooldownElapsed,
    vo2Protocol: session.vo2ProtocolRuntime,
  });
  const workStillActive = decision.type === "enter-early-cooldown";
  const cooldownBtn = document.getElementById("earlyCooldownButton") as HTMLButtonElement | null;
  if (cooldownBtn) {
    cooldownBtn.style.display = workStillActive ? "" : "none";
    cooldownBtn.disabled = !workStillActive;
  }
  const limitBtn = document.getElementById("vo2LimitReachedButton") as HTMLButtonElement | null;
  if (limitBtn) {
    const showLimit = vo2LimitReachedButtonVisible(isVo2, workStillActive);
    limitBtn.style.display = showLimit ? "" : "none";
    limitBtn.disabled = !showLimit;
  }
  const endBtn = document.getElementById("endWorkoutConfirmButton") as HTMLButtonElement | null;
  if (endBtn) endBtn.textContent = vo2EndWorkoutButtonLabel(isVo2);
  const titleEl = document.getElementById("cancelModalTitle");
  if (titleEl) titleEl.textContent = vo2CancelModalTitle(isVo2);
  const bodyEl = document.getElementById("cancelModalBody");
  if (bodyEl) bodyEl.textContent = vo2CancelModalBody(isVo2);
  const bg = document.getElementById("cancelModalBg");
  if (bg) bg.style.display = "flex";
}

function closeCancelModal() {
  const bg = document.getElementById("cancelModalBg");
  if (bg) bg.style.display = "none";
}

let activitySelectEscHandler: ((e: KeyboardEvent) => void) | null = null;

function closeActivitySelectModal() {
  const bg = document.getElementById("activitySelectModalBg");
  if (bg) bg.style.display = "none";
  if (activitySelectEscHandler) {
    document.removeEventListener("keydown", activitySelectEscHandler);
    activitySelectEscHandler = null;
  }
}

function promptWorkoutActivitySelection(activities: Activity[]) {
  const bg = document.getElementById("activitySelectModalBg");
  const options = document.getElementById("activitySelectOptions");
  if (!bg || !options) return;
  options.innerHTML = "";
  for (const activity of activities) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.textContent = ACTIVITY_LABELS[activity];
    button.addEventListener("click", () => {
      closeActivitySelectModal();
      beginWorkout(activity);
    });
    options.appendChild(button);
  }
  bg.style.display = "flex";
  activitySelectEscHandler = (e) => {
    if (e.key === "Escape" || e.keyCode === 27) closeActivitySelectModal();
  };
  document.addEventListener("keydown", activitySelectEscHandler);
}

function confirmCancelWorkout() {
  restartWorkout();
  closeCancelModal();
}

function confirmEarlyCooldownWorkout() {
  const btn = document.getElementById("earlyCooldownButton") as HTMLButtonElement | null;
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  closeCancelModal();
  const decision = requestEarlyCooldown();
  if (decision.type === "unavailable" && btn) btn.disabled = false;
}

function confirmVo2LimitReached() {
  const btn = document.getElementById("vo2LimitReachedButton") as HTMLButtonElement | null;
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  closeCancelModal();
  const decision = requestVo2LimitReached();
  if (decision.type !== "enter-limit-reached" && btn) btn.disabled = false;
}

function promptCancelWorkout() {
  if (!phaseDisplayEl) return;
  if (phaseDisplayEl.dataset.phaseState === "active") openCancelModal();
}
function updateHeartColor(liveBpm: number | null, target: ResolvedHeartRateTarget | null) {
  const heartIcon = document.getElementById("heartIcon");
  const hrNowEl = document.getElementById("hrNow");
  if (!heartIcon) return;
  const setHeartWhite = () => {
    heartIcon.style.setProperty("filter", "brightness(0) invert(1)", "important");
    if (hrNowEl) hrNowEl.style.setProperty("color", "black", "important");
  };
  const setHeartColored = (filter: string) => {
    heartIcon.style.setProperty("filter", filter, "important");
    if (hrNowEl) hrNowEl.style.setProperty("color", "white", "important");
  };
  if (!liveBpm || liveBpm <= 0) {
    setHeartWhite();
    return;
  }
  if (!target) {
    setHeartWhite();
    return;
  }
  let hueRotate = 0;
  if (target.max !== undefined && liveBpm > target.max) hueRotate = 270;
  else if (target.min !== undefined && liveBpm < target.min) hueRotate = 45;
  setHeartColored(
    `brightness(0) saturate(100%) invert(27%) sepia(100%) saturate(10000%) hue-rotate(${hueRotate}deg)`
  );
}

function updateHeartPulse(bpmValue?: number | null) {
  const heartIcon = document.getElementById("heartIcon");
  if (!heartIcon) return;
  const currentLiveBpm = (window as any).liveBpm;
  const currentLastUpdate = (window as any).lastBpmUpdateTime;
  const now = Date.now();
  if (currentLastUpdate && now - currentLastUpdate > BPM_TIMEOUT_MS) {
    heartPulseTargetBpm = null;
    if (heartPulseRafId !== null) cancelAnimationFrame(heartPulseRafId);
    heartPulseRafId = null;
    heartIcon.style.setProperty("transform", "scale(1)", "important");
    (window as any).liveBpm = null;
    updateHrDisplay(null);
    updateHeartColor(null, currentExpectedHeartRate);
    return;
  }
  const bpm = bpmValue !== undefined && bpmValue !== null ? bpmValue : currentLiveBpm;
  if (bpm && bpm > 0) {
    heartPulseTargetBpm = bpm;
    if (heartPulseRafId === null) heartPulseRafId = requestAnimationFrame(heartPulseLoop);
    updateHeartColor(bpm, currentExpectedHeartRate);
  } else {
    heartPulseTargetBpm = null;
    if (heartPulseRafId !== null) cancelAnimationFrame(heartPulseRafId);
    heartPulseRafId = null;
    heartIcon.style.setProperty("transform", "scale(1)", "important");
    updateHeartColor(null, currentExpectedHeartRate);
  }
}

function resolvedPrescriptionForSession(
  day: string,
  blocks: { warm: number; sustain: number; cool: number },
  session: ReturnType<typeof getSession>
): ResolvedWorkoutPrescription {
  if (session.phasePlan?.resolvedPrescription) return session.phasePlan.resolvedPrescription;
  const rawResolvedAt = Number(session.sessionStart ?? session.startTime);
  return resolveWorkoutPrescription({
    workoutSelector: day,
    blocks,
    hrTargets: session.phasePlan ? session.phasePlan.hrTargets : getHrTargets()[day] ?? null,
    resolvedAt: Number.isFinite(rawResolvedAt) && rawResolvedAt > 0
      ? new Date(rawResolvedAt).toISOString()
      : "historical-session",
  });
}

type WorkoutDisplayState =
  | { screen: "rest"; day: string; plan: any; workoutMetadata: any }
  | { screen: "downregulation"; day: "Downregulation"; plan: any; workoutMetadata: any }
  | {
      screen: "idle";
      day: string;
      plan: any;
      workoutMetadata: any;
      base: any;
      blocks: any;
      workoutBlocksText: string;
    }
  | {
      screen: "completed";
      day: string;
      plan: any;
      workoutMetadata: any;
      base: any;
      blocks: any;
      workoutBlocksText: string;
      elapsedSec: number;
    }
  | {
      screen: "vo2_restart_required";
      day: string;
      plan: any;
      workoutMetadata: any;
      base: any;
      blocks: any;
      workoutBlocksText: string;
    }
  | {
      screen: "active";
      day: string;
      plan: any;
      workoutMetadata: any;
      base: any;
      blocks: any;
      workoutBlocksText: string;
      elapsedSec: number;
      phase: WorkoutPhaseState;
      phaseDisplayName: string;
      activity: Activity | null;
      paused: boolean;
      hrTargetTextValue: string;
      assessmentBasedWorkload: { minWatts: number; maxWatts: number } | null;
      resolvedPhaseTarget?: ResolvedWorkoutPhaseTarget;
      liveBpm: number | null;
      liveBpmStale: boolean;
    };

function deriveWorkoutState(
  day: string,
  plan: any,
  workoutMetadata: any,
  base: any,
  startTime: string | null,
  paused: boolean,
  pausedElapsed: number,
  liveBpm: number | null,
  lastBpmUpdateTime: number | null
): WorkoutDisplayState {
  if (day === "Downregulation") {
    return { screen: "downregulation", day: "Downregulation", plan, workoutMetadata };
  }
  if (!base) {
    return { screen: "rest", day, plan, workoutMetadata };
  }

  const session = getSession(day);
  const blocks = session.phasePlan?.blocks ?? adjustedBlockLengths(base, null);
  const workoutBlocksText = isVo2WorkoutSelector(day)
    ? vo2WorkoutBlocksText(blocks)
    : genericWorkoutBlocksText(blocks);

  if (!startTime) {
    return { screen: "idle", day, plan, workoutMetadata, base, blocks, workoutBlocksText };
  }

  if (isVo2WorkoutSelector(day) && session.vo2ProtocolRestartRequired) {
    return { screen: "vo2_restart_required", day, plan, workoutMetadata, base, blocks, workoutBlocksText };
  }

  const elapsedSec = paused ? pausedElapsed : Math.floor((Date.now() - parseInt(startTime)) / 1000);
  const phase = getPhase(elapsedSec, blocks, session.earlyCooldownElapsed, {
    day,
    hrTargets: session.phasePlan ? session.phasePlan.hrTargets : undefined,
    vo2Protocol: session.vo2ProtocolRuntime,
  });

  if (phase.done) {
    return { screen: "completed", day, plan, workoutMetadata, base, blocks, workoutBlocksText, elapsedSec };
  }

  const prescription = resolvedPrescriptionForSession(day, blocks, session);
  const resolvedPhaseTarget = isVo2WorkoutSelector(day)
    ? undefined
    : findResolvedPhaseTarget(prescription, phase.phaseId, elapsedSec);

  let phaseDisplayName: string = phase.phase;
  if (isVo2WorkoutSelector(day)) {
    phaseDisplayName = vo2ProtocolDisplayName(phase);
  } else if (phase.kind === "warmup") {
    const subsectionName = resolvedPhaseTarget?.detailName;
    if (subsectionName) phaseDisplayName = "Warm-Up (" + subsectionName + ")";
  } else if (phase.detailName) {
    phaseDisplayName = phase.detailName;
  } else if (phase.kind === "work" || phase.kind === "recovery") {
    phaseDisplayName = "Workout";
  }

  const hrTargetTextValue = formatResolvedHeartRateTarget(resolvedPhaseTarget);
  const assessmentBasedWorkload = isVo2WorkoutSelector(day)
    ? null
    : assessmentBasedWorkloadForPhase(
        session.phasePlan?.shadowPrescriptionEvaluation,
        phase.phaseId
      );
  const nowTime = Date.now();
  const liveBpmStale =
    lastBpmUpdateTime != null && nowTime - lastBpmUpdateTime > BPM_TIMEOUT_MS;

  return {
    screen: "active",
    day,
    plan,
    workoutMetadata,
    base,
    blocks,
    workoutBlocksText,
    elapsedSec,
    phase,
    phaseDisplayName,
    activity: getActiveWorkoutActivity(workoutMetadata[day]?.activities, session.activity) ?? null,
    paused,
    hrTargetTextValue,
    assessmentBasedWorkload,
    resolvedPhaseTarget,
    liveBpm: liveBpm ?? null,
    liveBpmStale,
  };
}

function renderMachineGuidance(update: MachineGuidanceRuntimeUpdate | null) {
  const panel = document.getElementById("machineGuidance");
  if (!panel) return;
  if (!update || update.guidance.resistance === undefined || update.guidance.cadenceRpm === undefined) {
    panel.hidden = true;
    const bikeLive = document.getElementById("machineGuidanceBikeLive");
    if (bikeLive) bikeLive.hidden = true;
    return;
  }
  panel.hidden = false;
  const name = document.getElementById("machineGuidanceName");
  const resistance = document.getElementById("machineGuidanceResistance");
  const cadence = document.getElementById("machineGuidanceCadence");
  const watts = document.getElementById("machineGuidanceWatts");
  if (name) name.textContent = update.machine.name;
  if (resistance) resistance.textContent = String(update.guidance.resistance);
  if (cadence) cadence.textContent = `${update.guidance.cadenceRpm} RPM`;
  if (watts) {
    if (update.guidance.estimatedWatts !== undefined) {
      watts.textContent = `~${update.guidance.estimatedWatts} W @ 70 RPM`;
      watts.hidden = false;
    } else {
      watts.textContent = "";
      watts.hidden = true;
    }
  }
  renderBikeBridgeHud();
}

function renderAssessmentBasedWorkloadAdvice(
  workload: { minWatts: number; maxWatts: number } | null
) {
  const advice = document.getElementById("assessmentWorkloadAdvice");
  if (!advice) return;
  if (!workload) {
    advice.textContent = "";
    advice.hidden = true;
    return;
  }
  advice.textContent =
    `Your assessment-based workload: ${workload.minWatts}\u2013${workload.maxWatts} W`;
  advice.hidden = false;
}

function renderBikeBridgeHud() {
  const live = document.getElementById("machineGuidanceBikeLive");
  if (!live) return;
  const panel = document.getElementById("machineGuidance");
  const state = getBikeBridgeSession().getViewState();
  if (!panel || panel.hidden || state.readiness === "not_configured") {
    live.hidden = true;
    live.textContent = "";
    return;
  }
  live.hidden = false;
  const observed = formatBikeBridgeNumber(state.observedResistance);
  const rpm = formatBikeBridgeNumber(state.rpm);
  const watts = formatBikeBridgeNumber(state.watts);
  const stale = state.telemetryStale ? " (stale)" : "";
  // Live resistance/RPM/watts use Bike Bridge colors when measurements are present.
  const observedHtml =
    observed === "-"
      ? observed
      : `<span class="machine-guidance-resistance">${observed}</span>`;
  const rpmHtml =
    rpm === "-"
      ? `${rpm} RPM`
      : `<span class="machine-guidance-rpm">${rpm} RPM</span>`;
  const wattsHtml =
    watts === "-"
      ? `${watts} W`
      : `<span class="machine-guidance-power">${watts} W</span>`;
  live.innerHTML = `Bike observed ${observedHtml} · ${rpmHtml} · ${wattsHtml}${stale}`;
}

function recordVo2BikeTelemetryIfActive(): void {
  const day = getSelectedDay();
  if (!isVo2WorkoutSelector(day)) return;
  const session = getSession(day);
  if (!session.sessionId || !session.startTime) return;
  const state = getBikeBridgeSession().getViewState();
  if (state.telemetryStale) return;
  const metrics: { rpm?: number; watts?: number; observed_resistance?: number } = {};
  if (typeof state.rpm === "number" && Number.isFinite(state.rpm) && state.rpm > 0) metrics.rpm = state.rpm;
  if (typeof state.watts === "number" && Number.isFinite(state.watts) && state.watts > 0) {
    metrics.watts = state.watts;
  }
  if (
    typeof state.observedResistance === "number" &&
    Number.isFinite(state.observedResistance) &&
    state.observedResistance > 0
  ) {
    metrics.observed_resistance = state.observedResistance;
  }
  recordVo2ActiveBikeTelemetry(session, metrics);
}

function recordOrdinaryBikeTelemetryIfActive(): void {
  const day = getSelectedDay();
  if (isVo2WorkoutSelector(day)) return;
  const session = getSession(day);
  if (
    !session.sessionId ||
    !session.startTime ||
    !session.athleteId ||
    session.activity !== "bike"
  ) {
    return;
  }
  const state = getBikeBridgeSession().getViewState();
  const sample = ordinaryActiveBikeTelemetrySample(session, {
    telemetryStale: state.telemetryStale,
    telemetryReceivedAtMs: state.telemetryReceivedAtMs,
    telemetrySnapshotAt: state.telemetrySnapshotAt,
    watts: { value: state.watts, current: state.wattsCurrent },
    cadenceRpm: { value: state.rpm, current: state.rpmCurrent },
    observedResistance: {
      value: state.observedResistance,
      current: state.observedResistanceCurrent,
    },
    desiredResistance: state.desiredResistance,
    commandedResistance: state.commandedResistance,
  });
  if (sample) queueOrdinaryBikeTelemetrySample(sample);
}

function escapeBikeBridgeHudText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderBikeBridgeSettingsStatus() {
  const el = document.getElementById("bikeBridgeStatus");
  if (!el) return;
  const state = getBikeBridgeSession().getViewState();
  const observedResistance = formatBikeBridgeNumber(state.observedResistance);
  const resistanceLine =
    observedResistance === "-"
      ? `Resistance: ${observedResistance}`
      : `Resistance: <span class="machine-guidance-resistance">${observedResistance}</span>`;
  const rpm = formatBikeBridgeNumber(state.rpm);
  const rpmLine =
    rpm === "-"
      ? `RPM: ${rpm}`
      : `RPM: <span class="machine-guidance-rpm">${rpm}</span>`;
  const watts = formatBikeBridgeNumber(state.watts);
  const wattsLine =
    watts === "-"
      ? `Watts: ${watts}`
      : `Watts: <span class="machine-guidance-power">${watts}</span>`;
  const lines = [
    `Bike Bridge: ${escapeBikeBridgeHudText(formatBikeBridgeReadiness(state.readiness))}`,
    `Control: ${escapeBikeBridgeHudText(formatBikeBridgeControl(state))}`,
    resistanceLine,
    `Target: ${formatBikeBridgeNumber(state.desiredResistance ?? state.commandedResistance ?? state.requestedResistance)}`,
    rpmLine,
    wattsLine,
  ];
  if (state.lastError) lines.push(escapeBikeBridgeHudText(state.lastError));
  el.innerHTML = lines.join("\n");
}

function syncBikeBridgeGuidance(
  update: MachineGuidanceRuntimeUpdate | null,
  workoutActive: boolean,
  paused: boolean,
  workout?: { day: string; sessionId: string }
) {
  getBikeBridgeSession().onGuidance({
    desiredResistance: update?.guidance.resistance,
    recommendationChanged: update?.recommendationChanged === true,
    workoutActive,
    paused,
    actuationOrigin: update?.actuationOrigin,
    workout,
  });
  renderBikeBridgeHud();
  const equipmentTab = document.getElementById("equipmentTab");
  if (equipmentTab?.classList.contains("active")) renderBikeBridgeSettingsStatus();
}

function renderWorkout(state: WorkoutDisplayState) {
  const downregEl = document.getElementById("downregulationContainer");
  const workoutMainContent = document.getElementById("workoutMainContent");
  const workoutBlocksEl = document.getElementById("workoutBlocks");
  renderAssessmentBasedWorkloadAdvice(null);

  if (state.screen === "downregulation") {
    if (workoutMainContent) (workoutMainContent as HTMLElement).style.display = "none";
    if (workoutBlocksEl) (workoutBlocksEl as HTMLElement).style.display = "none";
    const mainSection = document.getElementById("workoutMainSection");
    if (mainSection) {
      (mainSection as HTMLElement).style.background = "transparent";
    }
    if (downregEl) {
      (downregEl as HTMLElement).style.display = "block";
      const canvas = document.getElementById("downregulationCanvas") as HTMLCanvasElement | null;
      if (canvas) {
        startDownregulationView(downregEl as HTMLElement, canvas);
      }
    }
    syncBikeBridgeGuidance(null, false, false);
    return;
  }

  stopDownregulationView();
  if (downregEl) (downregEl as HTMLElement).style.display = "none";
  if (workoutMainContent) (workoutMainContent as HTMLElement).style.display = "";
  if (workoutBlocksEl) (workoutBlocksEl as HTMLElement).style.display = "";
  const mainSection = document.getElementById("workoutMainSection");
  if (mainSection) {
    (mainSection as HTMLElement).style.background = "";
  }

  ensureWorkoutDayDropdown();

  const activityIcon = document.getElementById("activityIcon") as HTMLImageElement | null;
  const dayMeta = state.workoutMetadata[state.day];
  const hasBase = state.screen !== "rest" && (state as any).base;
  if (activityIcon) {
    if (hasBase && dayMeta) {
      const selectedActivity = state.screen === "active" || state.screen === "completed" || state.screen === "vo2_restart_required"
        ? getSession(state.day).activity
        : undefined;
      const activity = getActiveWorkoutActivity(dayMeta.activities, selectedActivity);
      const iconByActivity: Partial<Record<Activity, string>> = {
        bike: "bike.png",
        elliptical: "elliptical.png",
        strength: "dumbbell.png",
      };
      const iconSrc = activity ? iconByActivity[activity] || "" : "";
      if (iconSrc) {
        activityIcon.src = iconSrc;
        activityIcon.style.display = "block";
      } else {
        activityIcon.style.display = "none";
      }
    } else {
      activityIcon.style.display = "none";
    }
  }

  const hrTargetEl = document.getElementById("hrTarget");
  const startBtnEl = document.getElementById("startButton") as HTMLButtonElement | null;
  const cancelBtnEl = document.getElementById("cancelWorkoutButton") as HTMLButtonElement | null;
  const startButtonRowEl = document.getElementById("startButtonRow") as HTMLElement | null;

  if (state.screen === "rest") {
    renderMachineGuidance(null);
    syncBikeBridgeGuidance(null, false, false);
    if (workoutBlocksEl) workoutBlocksEl.textContent = "Rest Day";
    if (phaseDisplayEl) {
      phaseDisplayEl.innerHTML = '<span class="phase-name">Rest Day</span>';
      phaseDisplayEl.dataset.phaseState = "rest";
    }
    if (startButtonRowEl) startButtonRowEl.style.display = "none";
    if (cancelBtnEl) cancelBtnEl.style.display = "none";
    updateRing(0, { warm: 1, sustain: 1, cool: 1 } as any);
    if (hrTargetEl) hrTargetEl.textContent = "";
    updateHeartPulse(null);
    currentExpectedHeartRate = null;
    updateHeartColor(null, null);
    applyPhaseStyle("Rest");
    return;
  }

  if (workoutBlocksEl) workoutBlocksEl.textContent = state.workoutBlocksText;

  if (state.screen === "idle") {
    renderMachineGuidance(null);
    syncBikeBridgeGuidance(null, false, false);
    if (phaseDisplayEl) {
      phaseDisplayEl.innerHTML = '<span class="phase-name">Not Started</span>';
      phaseDisplayEl.dataset.phaseState = "idle";
    }
    if (typeof (window as any).resetVoiceState === "function") (window as any).resetVoiceState();
    if (startButtonRowEl) startButtonRowEl.style.display = "flex";
    if (startBtnEl) {
      startBtnEl.innerText = "Start Workout";
      startBtnEl.onclick = startWorkout;
      startBtnEl.style.display = "block";
    }
    if (cancelBtnEl) cancelBtnEl.style.display = "none";
    updateRing(0, state.blocks as any);
    if (hrTargetEl) hrTargetEl.textContent = "";
    updateHeartPulse(null);
    currentExpectedHeartRate = null;
    updateHeartColor(null, null);
    applyPhaseStyle("idle");
    return;
  }

  if (state.screen === "vo2_restart_required") {
    renderMachineGuidance(null);
    syncBikeBridgeGuidance(null, false, false);
    if (phaseDisplayEl) {
      phaseDisplayEl.innerHTML = '<span class="phase-name">Assessment update requires restart</span>';
      phaseDisplayEl.dataset.phaseState = "completed";
    }
    if (startButtonRowEl) startButtonRowEl.style.display = "flex";
    if (startBtnEl) {
      startBtnEl.innerText = "Restart Test";
      startBtnEl.onclick = restartWorkout;
      startBtnEl.style.display = "block";
    }
    if (cancelBtnEl) cancelBtnEl.style.display = "none";
    if (hrTargetEl) {
      hrTargetEl.textContent = "This saved protocol-v1 test cannot continue under protocol-v2 rules.";
    }
    updateHeartPulse(null);
    currentExpectedHeartRate = null;
    updateHeartColor(null, null);
    applyPhaseStyle("completed");
    return;
  }

  if (state.screen === "completed") {
    renderMachineGuidance(null);
    syncBikeBridgeGuidance(null, false, false);
    updateRing(state.elapsedSec, state.blocks as any);
    if (typeof (window as any).releaseWakeLock === "function") (window as any).releaseWakeLock();
    handleWorkoutCompletion(state.day);
    if (phaseDisplayEl) {
      phaseDisplayEl.innerHTML = '<span class="phase-name">Completed</span>';
      phaseDisplayEl.dataset.phaseState = "completed";
    }
    const completedPhrase = isVo2WorkoutSelector(state.day) ? "Test complete" : "Completed";
    if (typeof (window as any).announceWorkoutGuidance === "function") {
      (window as any).announceWorkoutGuidance(completedPhrase, null, pendingVo2Cues);
    } else if (typeof (window as any).announcePhaseIfChanged === "function") {
      (window as any).announcePhaseIfChanged(completedPhrase);
    }
    pendingVo2Cues = [];
    if (startButtonRowEl) startButtonRowEl.style.display = "flex";
    if (startBtnEl) {
      startBtnEl.innerText = "Restart Workout";
      startBtnEl.onclick = restartWorkout;
      startBtnEl.style.display = "block";
    }
    if (cancelBtnEl) cancelBtnEl.style.display = "none";
    if (hrTargetEl) hrTargetEl.textContent = "";
    updateHeartPulse(null);
    currentExpectedHeartRate = null;
    updateHeartColor(null, null);
    applyPhaseStyle("completed");
    return;
  }

  // state.screen === "active"
  updateRing(state.elapsedSec, state.blocks as any);
  const active = state;
  if (startButtonRowEl) startButtonRowEl.style.display = "flex";
  if (startBtnEl) {
    if (active.paused) {
      startBtnEl.innerText = "Resume";
      startBtnEl.onclick = function () {
        resumeWorkout(active.day);
        if (typeof (window as any).requestWakeLock === "function") (window as any).requestWakeLock();
        updateDisplay();
      };
      startBtnEl.style.display = "block";
    } else {
      startBtnEl.innerText = "Pause";
      startBtnEl.onclick = function () {
        pauseWorkout(active.day, active.elapsedSec);
        if (typeof (window as any).releaseWakeLock === "function") (window as any).releaseWakeLock();
        updateDisplay();
      };
      startBtnEl.style.display = "block";
    }
  }
  if (cancelBtnEl) cancelBtnEl.style.display = active.paused ? "block" : "none";

  if (phaseDisplayEl) {
    phaseDisplayEl.innerHTML =
      '<span class="phase-name">' +
      active.phaseDisplayName +
      '</span><span class="phase-time">' +
      formatTime(active.phase.timeLeft) +
      "</span>";
    phaseDisplayEl.dataset.phaseState = "active";
  }
  if (hrTargetEl) hrTargetEl.textContent = active.hrTargetTextValue;
  renderAssessmentBasedWorkloadAdvice(active.assessmentBasedWorkload);
  currentExpectedHeartRate = active.resolvedPhaseTarget?.expectedHeartRate ?? null;
  updateHeartPulse();
  if (active.liveBpmStale) {
    updateHrDisplay(null);
  }
  if (active.liveBpm != null && active.liveBpm > 0 && !active.liveBpmStale) {
    updateHeartColor(active.liveBpm, currentExpectedHeartRate);
  } else {
    updateHeartColor(null, currentExpectedHeartRate);
  }
  const session = getSession(active.day);
  const vo2Targets = isVo2WorkoutSelector(active.day)
    ? vo2ProtocolUiTargetsForRuntime(session.vo2ProtocolRuntime, active.phase.phaseId)
    : null;
  const hold = vo2Targets
    ? { resistance: vo2Targets.holdResistance, cadenceRpm: vo2Targets.holdCadenceRpm }
    : vo2ProtocolHoldForPhaseForRuntime(session.vo2ProtocolRuntime, active.phase.phaseId);
  const machineHeartRateTarget = machineHeartRateTargetFromResolved(active.resolvedPhaseTarget);
  const machineUpdate = session.sessionId && active.activity
    ? updateMachineGuidanceRuntime({
        sessionId: session.sessionId,
        activity: active.activity,
        phaseKind: active.phase.kind as Exclude<WorkoutPhaseState["kind"], "completed">,
        phaseId: active.phase.phaseId,
        phaseDisplayName: active.phaseDisplayName,
        phaseElapsedSeconds: active.phase.phaseElapsedSeconds,
        phaseDurationSeconds: active.phase.phaseDurationSeconds,
        workoutElapsedSeconds: active.elapsedSec,
        intervalIndex: active.phase.intervalIndex,
        heartRateBpm: active.liveBpm ?? undefined,
        targetHeartRateMin: vo2Targets ? vo2Targets.targetHeartRateMin : machineHeartRateTarget.targetHeartRateMin,
        targetHeartRateMax: vo2Targets ? vo2Targets.targetHeartRateMax : machineHeartRateTarget.targetHeartRateMax,
        intent: active.workoutMetadata[active.day]?.intent,
        holdResistance: hold?.resistance,
        holdCadenceRpm: hold?.cadenceRpm,
        controlAuthority: session.controlAuthority,
      })
    : null;
  syncBikeBridgeGuidance(machineUpdate, true, active.paused,
    session.sessionId ? { day: active.day, sessionId: session.sessionId } : undefined);
  renderMachineGuidance(machineUpdate);
  if (typeof (window as any).announceWorkoutGuidance === "function") {
    (window as any).announceWorkoutGuidance(
      active.phaseDisplayName,
      machineUpdate?.voiceEvent ?? null,
      pendingVo2Cues
    );
  } else if (typeof (window as any).announcePhaseIfChanged === "function") {
    (window as any).announcePhaseIfChanged(active.phaseDisplayName);
  }
  pendingVo2Cues = [];
  applyPhaseStyle(active.phase.phase);
}

let updateDisplaySeq = 0;

function updateDisplay() {
  void updateDisplayAsync();
}

async function updateDisplayAsync() {
  const seq = ++updateDisplaySeq;
  try {
    if (typeof getPlan !== "function" || typeof getWorkoutMetadata !== "function") return;
    const day = getSelectedDay();
    const plan = getPlan();
    const workoutMetadata = getWorkoutMetadata();
    const base = (plan as any)[day];
    const startTime = getStartTime(day);
    const paused = typeof isPaused === "function" && isPaused(day);
    const pausedElapsed = typeof getPausedElapsed === "function" ? getPausedElapsed(day) : 0;
    const liveBpm = (window as any).liveBpm as number | null;
    const lastBpmUpdateTime = (window as any).lastBpmUpdateTime as number | null;
    // Live-HR guard contract: the v3 ceiling guard evaluates inside the tick below, so this
    // call must stay unconditional (every refresh, any elapsed) -- never gate it on checkpoints.
    if (startTime && isVo2WorkoutSelector(day)) {
      const elapsedSec = paused ? pausedElapsed : Math.floor((Date.now() - parseInt(startTime, 10)) / 1000);
      const tick = await tickVo2ProtocolWithCanonicalHr(day, elapsedSec, paused);
      if (seq !== updateDisplaySeq) return;
      pendingVo2Cues = tick?.cues ?? [];
    } else {
      pendingVo2Cues = [];
    }

    const state = deriveWorkoutState(
      day,
      plan,
      workoutMetadata,
      base,
      startTime,
      paused,
      pausedElapsed,
      liveBpm,
      lastBpmUpdateTime
    );

    if (state.screen === "active" && state.liveBpmStale) {
      (window as any).liveBpm = null;
    }

    renderWorkout(state);
  } catch (e: any) {
    if (e instanceof TypeError && e.message && e.message.includes("null")) {
      console.warn("updateDisplay: DOM element missing", e.message);
    } else {
      throw e;
    }
  }
}
function switchTab(tabName: string) {
  const tabs = ["personal", "preferences", "equipment", "workouts", "sisu", "install"];
  tabs.forEach((name) => {
    const tabEl = document.getElementById(name + "Tab");
    if (tabEl) tabEl.classList.remove("active");
  });
  const buttons = document.querySelectorAll(".tab-button");
  buttons.forEach((btn) => btn.classList.remove("active"));
  const tabIndex: Record<string, number> = { personal: 0, preferences: 1, equipment: 2, workouts: 3, sisu: 4, install: 5 };
  if (tabName === "personal") {
    document.getElementById("personalTab")?.classList.add("active");
    (buttons[tabIndex.personal] as HTMLElement | undefined)?.classList.add("active");
    if (typeof (window as any).loadProfile === "function") (window as any).loadProfile();
    if (typeof (window as any).loadProfileFitness === "function") (window as any).loadProfileFitness();
  } else if (tabName === "preferences") {
    document.getElementById("preferencesTab")?.classList.add("active");
    (buttons[tabIndex.preferences] as HTMLElement | undefined)?.classList.add("active");
    loadPreferences();
  } else if (tabName === "equipment") {
    document.getElementById("equipmentTab")?.classList.add("active");
    (buttons[tabIndex.equipment] as HTMLElement | undefined)?.classList.add("active");
    loadEquipmentSettings();
  } else if (tabName === "workouts") {
    document.getElementById("workoutsTab")?.classList.add("active");
    (buttons[tabIndex.workouts] as HTMLElement | undefined)?.classList.add("active");
    loadWorkoutSummaries();
  } else if (tabName === "sisu") {
    document.getElementById("sisuTab")?.classList.add("active");
    (buttons[tabIndex.sisu] as HTMLElement | undefined)?.classList.add("active");
    if (typeof (window as any).loadSisuSettings === "function") (window as any).loadSisuSettings();
    updateHrMonitorLabel();
  } else if (tabName === "install") {
    document.getElementById("installTab")?.classList.add("active");
    (buttons[tabIndex.install] as HTMLElement | undefined)?.classList.add("active");
    if (typeof (window as any).refreshInstallTabContent === "function") (window as any).refreshInstallTabContent();
  }
}

function getShowSecondsCountdown() {
  return localStorage.getItem("showSecondsCountdown") === "true";
}

function getVoicePromptsEnabled() {
  return localStorage.getItem("voicePromptsEnabled") !== "false";
}

function loadPreferences() {
  const cb = document.getElementById("showSecondsCountdown") as HTMLInputElement | null;
  if (cb) cb.checked = getShowSecondsCountdown();
  const voiceCb = document.getElementById("voicePromptsEnabled") as HTMLInputElement | null;
  if (voiceCb) voiceCb.checked = getVoicePromptsEnabled();
}

function savePreferenceShowSeconds(checked: boolean) {
  localStorage.setItem("showSecondsCountdown", checked ? "true" : "false");
}

function savePreferenceVoicePrompts(checked: boolean) {
  localStorage.setItem("voicePromptsEnabled", checked ? "true" : "false");
}

function loadEquipmentSettings() {
  const select = document.getElementById("bikeMachineSelect") as HTMLSelectElement | null;
  if (!select) return;
  select.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No machine";
  select.appendChild(none);
  for (const machine of listMachinesForActivity("bike")) {
    const option = document.createElement("option");
    option.value = machine.id;
    option.textContent = machine.name;
    select.appendChild(option);
  }
  select.value = getEquipmentSelection().bike ?? "";
  loadBikeBridgeSettingsForm();
  renderLearnedGuidancePanel();
  renderHrDynamicsPanel();
  renderShadowPredictionPanel();
  void loadPersonalizationDiagnostics();
  void loadPerformedLoadDiagnostics();
}

function renderPersonalizationDiagnostics(model: PersonalizationDiagnosticsModel) {
  personalizationDiagnosticsModel = model;
  const content = document.getElementById("personalizationDiagnosticsContent");
  if (content) content.innerHTML = personalizationDiagnosticsHtml(model);
  const exportButton = document.getElementById("exportPersonalizationDiagnosticsButton") as HTMLButtonElement | null;
  if (exportButton) exportButton.disabled = model.sourceRecordCount === 0;
}

async function loadPerformedLoadDiagnostics() {
  const content = document.getElementById("performedLoadDiagnosticsContent");
  if (!content) return;
  content.innerHTML = '<div class="personalization-diagnostics-empty"><span>Loading ordinary bike performed-load evidence…</span></div>';
  try {
    const history = await getAllWorkoutSummaries();
    const athleteId = loadAthleteProfile(localStorage).athleteId;
    const rows = history.filter((row) => {
      const summary = row.summary;
      return (
        summary?.activity === "bike" &&
        summary.athlete_id === athleteId &&
        summary.workout_response != null
      );
    }).slice(0, PERFORMED_LOAD_DIAGNOSTICS_RECENT_LIMIT);
    const workouts = [];
    for (const row of rows) {
      const samples = await getOrdinaryBikeTelemetrySamples(row.summary.external_session_id);
      workouts.push(buildPerformedLoadWorkoutView({
        response: row.summary.workout_response!,
        samples,
        startedAt: row.summary.startedAt,
        day: typeof row.summary.day === "string" ? row.summary.day : undefined,
        intent: row.summary.intent,
        cancelled: row.summary.cancelled,
      }));
    }
    content.innerHTML = performedLoadDiagnosticsHtml(workouts);
  } catch (error) {
    console.error("Error loading performed-load diagnostics:", error);
    content.innerHTML = '<div class="personalization-diagnostics-empty personalization-diagnostics-error"><strong>Performed-load diagnostics could not be loaded.</strong><span>Workout data was not changed.</span></div>';
  }
}

async function loadPersonalizationDiagnostics() {
  const content = document.getElementById("personalizationDiagnosticsContent");
  if (!content) return;
  content.innerHTML = '<div class="personalization-diagnostics-empty"><span>Loading trusted workout history…</span></div>';
  try {
    const history = await getAllWorkoutSummaries();
    const athleteId = loadAthleteProfile(localStorage).athleteId;
    personalizationDiagnosticsRecords = extractTrustedPersonalizationCharacterizations(history, athleteId);
    personalizationAssessmentContexts = extractTrustedPersonalizationAssessmentContexts(history, athleteId);
    personalizationWorkoutContexts = extractTrustedPersonalizationWorkoutContexts(history, athleteId);
    personalizationPerformedLoadContexts = extractTrustedPersonalizationPerformedLoadContexts(history, athleteId);
    personalizationExecutionProvenanceContexts = extractTrustedExecutionProvenanceContexts(history, athleteId);
    // Retained raw telemetry lets the canonical E2 v3 reducer re-derive held windows for the E4A v2 join.
    const rawBySession: Record<string, RawWorkoutTelemetry> = {};
    for (const { summary } of history) {
      if (summary.athlete_id !== athleteId || !summary.execution_provenance ||
          summary.shadow_prescription_characterization?.schemaVersion !== 3) continue;
      const [hrSamples, bikeSamples] = await Promise.all([
        getHrSamples(summary.external_session_id),
        getOrdinaryBikeTelemetrySamples(summary.external_session_id),
      ]);
      rawBySession[summary.external_session_id] = { hrSamples, bikeSamples };
    }
    personalizationScientificSessionContexts = buildScientificSessionEvidenceV2Contexts(history, athleteId, rawBySession);
    renderPersonalizationDiagnostics(buildPersonalizationDiagnosticsModel(
      personalizationDiagnosticsRecords,
      EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS,
      personalizationAssessmentContexts,
      personalizationWorkoutContexts,
      personalizationPerformedLoadContexts,
      new Date().toISOString(),
      personalizationExecutionProvenanceContexts,
      personalizationScientificSessionContexts
    ));
  } catch (error) {
    console.error("Error loading personalization diagnostics:", error);
    content.innerHTML = '<div class="personalization-diagnostics-empty personalization-diagnostics-error"><strong>Personalization diagnostics could not be loaded.</strong><span>Workout data was not changed.</span></div>';
  }
}

function currentPersonalizationDiagnosticsFilters(): PersonalizationDiagnosticsFilters {
  const value = (id: string) => (document.getElementById(id) as HTMLSelectElement | null)?.value ?? "all";
  return {
    workoutIntent: value("personalizationIntentFilter"),
    intensity: value("personalizationIntensityFilter"),
    calibrationProvenance: value("personalizationCalibrationFilter"),
    observedPowerProvenance: value("personalizationObservedPowerFilter"),
    assessmentQuality: value("personalizationQualityFilter"),
    domainBucket: value("personalizationDomainFilter"),
  };
}

function applyPersonalizationDiagnosticsFilters() {
  renderPersonalizationDiagnostics(buildPersonalizationDiagnosticsModel(
    personalizationDiagnosticsRecords,
    currentPersonalizationDiagnosticsFilters(),
    personalizationAssessmentContexts,
    personalizationWorkoutContexts,
    personalizationPerformedLoadContexts,
    new Date().toISOString(),
    personalizationExecutionProvenanceContexts,
    personalizationScientificSessionContexts
  ));
}

function resetPersonalizationDiagnosticsFilters() {
  renderPersonalizationDiagnostics(buildPersonalizationDiagnosticsModel(
    personalizationDiagnosticsRecords,
    EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS,
    personalizationAssessmentContexts,
    personalizationWorkoutContexts,
    personalizationPerformedLoadContexts,
    new Date().toISOString(),
    personalizationExecutionProvenanceContexts,
    personalizationScientificSessionContexts
  ));
}

function openPersonalizationDiagnostic(index: number) {
  const row = personalizationDiagnosticsModel?.rows[index];
  const detail = document.getElementById("personalizationDiagnosticDetail");
  if (!row || !detail) return;
  detail.innerHTML = personalizationDiagnosticDetailHtml(row);
  detail.hidden = false;
  detail.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function closePersonalizationDiagnostic() {
  const detail = document.getElementById("personalizationDiagnosticDetail");
  if (!detail) return;
  detail.hidden = true;
  detail.innerHTML = "";
}

function exportPersonalizationDiagnostics() {
  if (!personalizationDiagnosticsModel || personalizationDiagnosticsModel.sourceRecordCount === 0) return;
  const unfiltered = buildPersonalizationDiagnosticsModel(
    personalizationDiagnosticsRecords,
    EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS,
    personalizationAssessmentContexts,
    personalizationWorkoutContexts,
    personalizationPerformedLoadContexts
  );
  const blob = new Blob([personalizationDiagnosticsExportJson(unfiltered)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "fitbaus-personalization-diagnostics.json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function renderLearnedGuidancePanel() {
  const section = document.getElementById("learnedGuidanceSection");
  const list = document.getElementById("learnedGuidanceList");
  if (!section || !list) return;
  const machineId = getEquipmentSelection().bike;
  const entries = machineId ? listLearnedStarts(machineId) : [];
  if (!machineId || entries.length === 0) {
    section.hidden = true;
    list.innerHTML = "";
    return;
  }
  section.hidden = false;
  list.innerHTML = entries
    .map(
      (entry) =>
        `<div class="learned-guidance-row"><span>${formatLearnedGuidanceLabel(entry.intent, entry.durationClass)}</span><span>R${entry.resistance}</span></div>`
    )
    .join("");
}

function metricRow(label: string, value: string): string {
  return `<div class="learned-guidance-row"><span>${label}</span><span>${value}</span></div>`;
}

function sampleCountLabel(count: number): string {
  return count === 1 ? "1 sample" : `${count} samples`;
}

function signedBpm(value: number): string {
  return `${value > 0 ? "+" : ""}${value} bpm`;
}

function reliabilityRows(
  observationCount: number,
  detectedCount: number,
  recentObservationCount: number,
  recentDetectedCount: number,
  fallbackLabel: string,
  fallbackCount: number
): string[] {
  const rows: string[] = [];
  if (observationCount > 0) {
    rows.push(metricRow("Response observed", `${detectedCount} of ${observationCount}`));
  } else if (fallbackCount > 0) {
    rows.push(metricRow(fallbackLabel, sampleCountLabel(fallbackCount)));
  }
  if (recentObservationCount > 0) {
    rows.push(metricRow("Recent", `${recentDetectedCount} of ${recentObservationCount}`));
  }
  return rows;
}

function renderHrDynamicsGroup(entry: LearnedHrDynamics): string {
  const blocks: string[] = [];
  if (entry.workStartSampleCount > 0 || entry.workStartObservationCount > 0 || entry.workStartRecentObservationCount > 0) {
    const rows: string[] = ['<div class="hr-dynamics-subhead">Work start</div>'];
    if (entry.medianWorkStartDelaySeconds !== undefined) {
      rows.push(metricRow("Typical rise delay", `${entry.medianWorkStartDelaySeconds} s`));
    }
    if (entry.medianWorkStartHrDelta !== undefined) {
      rows.push(metricRow("Observed HR rise", signedBpm(entry.medianWorkStartHrDelta)));
    }
    rows.push(
      ...reliabilityRows(
        entry.workStartObservationCount,
        entry.workStartDetectedResponseCount,
        entry.workStartRecentObservationCount,
        entry.workStartRecentDetectedResponseCount,
        "Based on",
        entry.workStartSampleCount
      )
    );
    blocks.push(rows.join(""));
  }
  if (entry.increaseSampleCount > 0 || entry.increaseObservationCount > 0 || entry.increaseRecentObservationCount > 0) {
    const rows: string[] = ['<div class="hr-dynamics-subhead">+1 resistance</div>'];
    if (entry.medianIncreaseDelaySeconds !== undefined) {
      rows.push(metricRow("Typical response delay", `${entry.medianIncreaseDelaySeconds} s`));
    }
    if (entry.medianIncreaseHrDeltaPerStep !== undefined) {
      rows.push(metricRow("Observed HR change", signedBpm(entry.medianIncreaseHrDeltaPerStep)));
    }
    rows.push(
      ...reliabilityRows(
        entry.increaseObservationCount,
        entry.increaseDetectedResponseCount,
        entry.increaseRecentObservationCount,
        entry.increaseRecentDetectedResponseCount,
        "Samples",
        entry.increaseSampleCount
      )
    );
    blocks.push(rows.join(""));
  }
  if (entry.decreaseSampleCount > 0 || entry.decreaseObservationCount > 0 || entry.decreaseRecentObservationCount > 0) {
    const rows: string[] = ['<div class="hr-dynamics-subhead">-1 resistance</div>'];
    if (entry.medianDecreaseDelaySeconds !== undefined) {
      rows.push(metricRow("Typical response delay", `${entry.medianDecreaseDelaySeconds} s`));
    }
    if (entry.medianDecreaseHrDeltaPerStep !== undefined) {
      rows.push(metricRow("Observed HR change", signedBpm(entry.medianDecreaseHrDeltaPerStep)));
    }
    rows.push(
      ...reliabilityRows(
        entry.decreaseObservationCount,
        entry.decreaseDetectedResponseCount,
        entry.decreaseRecentObservationCount,
        entry.decreaseRecentDetectedResponseCount,
        "Samples",
        entry.decreaseSampleCount
      )
    );
    blocks.push(rows.join(""));
  }
  if (blocks.length === 0) return "";
  if (entry.timingMode || entry.timingPersonalized) {
    const status =
      entry.timingMode === "earlier"
        ? "Earlier"
        : entry.timingMode === "extended"
          ? "Extended"
          : "Personalized";
    blocks.push(
      `<div class="hr-dynamics-subhead">Controller timing</div>${metricRow("Status", status)}`
    );
  }
  return `<div class="hr-dynamics-block"><div class="hr-dynamics-heading">${formatLearnedGuidanceLabel(entry.intent, entry.durationClass)}</div>${blocks.join("")}</div>`;
}

function renderHrDynamicsPanel() {
  const section = document.getElementById("hrDynamicsSection");
  const list = document.getElementById("hrDynamicsList");
  if (!section || !list) return;
  const machineId = getEquipmentSelection().bike;
  const entries = machineId ? listHrDynamics(machineId).filter((entry) =>
    entry.workStartSampleCount > 0 ||
    entry.increaseSampleCount > 0 ||
    entry.decreaseSampleCount > 0 ||
    entry.workStartObservationCount > 0 ||
    entry.increaseObservationCount > 0 ||
    entry.decreaseObservationCount > 0 ||
    entry.workStartRecentObservationCount > 0 ||
    entry.increaseRecentObservationCount > 0 ||
    entry.decreaseRecentObservationCount > 0
  ) : [];
  if (!machineId || entries.length === 0) {
    section.hidden = true;
    list.innerHTML = "";
    return;
  }
  section.hidden = false;
  list.innerHTML = entries.map(renderHrDynamicsGroup).join("");
}

function signedBpmPerLevel(value: number): string {
  return `${value > 0 ? "+" : ""}${value} bpm / level`;
}

function renderShadowDirectionBlock(label: string, diagnostics: NonNullable<ShadowResistanceDiagnostics["increase"]>): string {
  const rows = [`<div class="hr-dynamics-subhead">${label}</div>`];
  rows.push(metricRow("Model", signedBpmPerLevel(diagnostics.modelMedianHrPerLevel)));
  rows.push(metricRow("Predictions", String(diagnostics.predictionCount)));
  rows.push(metricRow("Validation", shadowValidationStatusLabel(diagnostics.validationStatus)));
  if (diagnostics.validationOpportunityCount > 0) {
    rows.push(
      metricRow("Realized", `${diagnostics.realizedPredictionCount} of ${diagnostics.validationOpportunityCount}`)
    );
  }
  if (diagnostics.distinctSessionCount > 0) {
    rows.push(metricRow("Sessions", String(diagnostics.distinctSessionCount)));
  }
  if (diagnostics.medianAbsolutePredictionErrorBpm !== undefined) {
    rows.push(metricRow("Median error", `${diagnostics.medianAbsolutePredictionErrorBpm} bpm`));
  }
  if (diagnostics.medianSignedPredictionErrorBpm !== undefined) {
    rows.push(metricRow("Bias", signedBpm(diagnostics.medianSignedPredictionErrorBpm)));
  }
  if (diagnostics.directionEvaluatedCount > 0) {
    rows.push(
      metricRow("Direction matched", `${diagnostics.directionMatchCount} of ${diagnostics.directionEvaluatedCount}`)
    );
  }
  if (diagnostics.directionEvaluatedCount > 0) {
    rows.push(
      metricRow("Within 5 bpm", `${diagnostics.withinToleranceCount} of ${diagnostics.directionEvaluatedCount}`)
    );
  }
  return rows.join("");
}

function renderShadowPredictionGroup(entry: ShadowResistanceDiagnostics): string {
  const blocks: string[] = [];
  if (entry.increase) blocks.push(renderShadowDirectionBlock("+1 resistance", entry.increase));
  if (entry.decrease) blocks.push(renderShadowDirectionBlock("-1 resistance", entry.decrease));
  if (blocks.length === 0) return "";
  return `<div class="hr-dynamics-block"><div class="hr-dynamics-heading">${formatLearnedGuidanceLabel(entry.intent, entry.durationClass)}</div>${blocks.join("")}</div>`;
}

function renderShadowPredictionPanel() {
  const section = document.getElementById("shadowPredictionSection");
  const list = document.getElementById("shadowPredictionList");
  if (!section || !list) return;
  const machineId = getEquipmentSelection().bike;
  const entries = machineId
    ? listShadowPredictions(machineId).filter((entry) => entry.increase || entry.decrease)
    : [];
  if (!machineId || entries.length === 0) {
    section.hidden = true;
    list.innerHTML = "";
    return;
  }
  section.hidden = false;
  list.innerHTML = entries.map(renderShadowPredictionGroup).join("");
}

function exportMachineDiagnostics() {
  const prepared = prepareMachineDiagnosticsExport(buildMachineDiagnosticsSnapshot());
  const blob = new Blob([prepared.body], { type: prepared.mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = prepared.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function promptResetShadowPredictions() {
  const machineId = getEquipmentSelection().bike;
  if (!machineId) return;
  const bg = document.getElementById("resetShadowPredictionsModalBg");
  if (bg) bg.style.display = "flex";
}

function closeResetShadowPredictionsModal() {
  const bg = document.getElementById("resetShadowPredictionsModalBg");
  if (bg) bg.style.display = "none";
}

function confirmResetShadowPredictions() {
  const machineId = getEquipmentSelection().bike;
  if (machineId) resetShadowPredictionsForMachine(machineId);
  closeResetShadowPredictionsModal();
  renderShadowPredictionPanel();
  renderHrDynamicsPanel();
  renderLearnedGuidancePanel();
}

function promptResetHrDynamics() {
  const machineId = getEquipmentSelection().bike;
  if (!machineId) return;
  const bg = document.getElementById("resetHrDynamicsModalBg");
  if (bg) bg.style.display = "flex";
}

function closeResetHrDynamicsModal() {
  const bg = document.getElementById("resetHrDynamicsModalBg");
  if (bg) bg.style.display = "none";
}

function confirmResetHrDynamics() {
  const machineId = getEquipmentSelection().bike;
  if (machineId) resetHrDynamicsForMachine(machineId);
  closeResetHrDynamicsModal();
  renderHrDynamicsPanel();
  renderLearnedGuidancePanel();
  renderShadowPredictionPanel();
}

function promptResetLearnedGuidance() {
  const machineId = getEquipmentSelection().bike;
  if (!machineId) return;
  const bg = document.getElementById("resetLearnedModalBg");
  if (bg) bg.style.display = "flex";
}

function closeResetLearnedModal() {
  const bg = document.getElementById("resetLearnedModalBg");
  if (bg) bg.style.display = "none";
}

function confirmResetLearnedGuidance() {
  const machineId = getEquipmentSelection().bike;
  if (machineId) resetLearnedGuidanceForMachine(machineId);
  closeResetLearnedModal();
  renderLearnedGuidancePanel();
  renderHrDynamicsPanel();
  renderShadowPredictionPanel();
}

function loadBikeBridgeSettingsForm() {
  const state = getBikeBridgeSession().getViewState();
  const urlInput = document.getElementById("bikeBridgeUrl") as HTMLInputElement | null;
  if (urlInput && document.activeElement !== urlInput) urlInput.value = state.configuredUrl;
  const control = document.getElementById("bikeBridgeAutomaticControl") as HTMLInputElement | null;
  if (control) control.checked = state.automaticControlEnabled;
  const slider = document.getElementById("bikeBridgeBrightness") as HTMLInputElement | null;
  if (slider && document.activeElement !== slider) {
    slider.value = String(state.consoleBrightness);
    slider.setAttribute("aria-valuenow", slider.value);
  }
  updateBikeBridgeBrightnessLabel(state.consoleBrightness);
  renderBikeBridgeSettingsStatus();
}

function updateBikeBridgeBrightnessLabel(value: string | number) {
  const label = document.getElementById("bikeBridgeBrightnessValue");
  if (label) label.textContent = String(value);
  const slider = document.getElementById("bikeBridgeBrightness") as HTMLInputElement | null;
  if (slider) slider.setAttribute("aria-valuenow", String(value));
}

function saveBikeBridgeBrightness(value: string | number) {
  updateBikeBridgeBrightnessLabel(value);
  void getBikeBridgeSession().setConsoleBrightness(Number(value));
}

function saveBikeBridgeUrl(value: string) {
  const result = getBikeBridgeSession().configure({ baseUrl: value });
  const urlInput = document.getElementById("bikeBridgeUrl") as HTMLInputElement | null;
  if (result.ok) {
    if (urlInput) urlInput.value = getBikeBridgeSession().getViewState().configuredUrl;
  } else {
    showToast(result.error || "Invalid bike bridge URL");
    if (urlInput) urlInput.value = getBikeBridgeSession().getViewState().configuredUrl;
  }
  renderBikeBridgeSettingsStatus();
}

function saveBikeBridgeAutomaticControl(enabled: boolean) {
  getBikeBridgeSession().configure({ automaticControlEnabled: enabled });
  renderBikeBridgeSettingsStatus();
}

function saveBikeEquipmentSelection(value: string) {
  if (value && !isMachineId(value)) return;
  setSelectedMachine("bike", value && isMachineId(value) ? value : undefined);
  renderLearnedGuidancePanel();
  renderHrDynamicsPanel();
  renderShadowPredictionPanel();
  updateDisplay();
}
async function loadWorkoutSummaries() {
  const listContainer = document.getElementById("workoutSummaryList");
  if (!listContainer) return;
  listContainer.innerHTML = '<div class="label" style="text-align: center; margin-bottom: 16px;">Loading workouts...</div>';
  try {
    const workouts = await getAllWorkoutSummaries();
    displayWorkoutSummaries(workouts as any);
  } catch (error) {
    console.error("Error loading workouts:", error);
    listContainer.innerHTML = '<div class="label" style="text-align: center; color: #ff4444;">Error loading workouts</div>';
  }
}

function createSwipeHandler(onSwipeLeft: () => void, onSwipeRight: () => void) {
  const state: any = {
    active: false,
    pointer: "none",
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    startT: 0,
    movedX: 0,
    movedY: 0,
    armed: false,
    swiped: false,
    targetEl: null,
  };
  const threshold = 72;
  const velocity = 0.3;
  const armThreshold = 48;
  const applyDragStyle = (dx: number) => {
    const el = state.targetEl as HTMLElement | null;
    if (!el) return;
    el.style.setProperty("--drag-x", `${dx}px`);
    if (dx < 0) el.dataset.dragDirection = "left";
    else if (dx > 0) el.dataset.dragDirection = "right";
    else delete el.dataset.dragDirection;
  };
  const clearDragStyle = () => {
    const el = state.targetEl as HTMLElement | null;
    if (!el) return;
    el.style.setProperty("--drag-x", "0px");
    delete el.dataset.dragDirection;
    delete el.dataset.swipeArmed;
    el.classList.remove("dragging");
  };
  const onStart = (el: HTMLElement, x: number, y: number, pointer: string) => {
    const now = performance.now();
    state.active = true;
    state.pointer = pointer;
    state.startX = x;
    state.startY = y;
    state.lastX = x;
    state.lastY = y;
    state.startT = now;
    state.movedX = 0;
    state.movedY = 0;
    state.armed = false;
    state.swiped = false;
    state.targetEl = el;
    el.classList.add("dragging");
  };
  const onMove = (x: number, y: number) => {
    if (!state.active) return;
    const dx = x - state.startX;
    const dy = y - state.startY;
    state.lastX = x;
    state.lastY = y;
    state.movedX = dx;
    state.movedY = dy;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 16) {
      clearDragStyle();
      return;
    }
    if (Math.abs(dx) > 0) applyDragStyle(dx);
    else {
      clearDragStyle();
      return;
    }
    const shouldArm = Math.abs(dx) >= armThreshold;
    if (shouldArm !== state.armed) {
      state.armed = shouldArm;
      const el = state.targetEl as HTMLElement | null;
      if (el) el.dataset.swipeArmed = shouldArm ? "true" : "false";
      if (shouldArm && navigator.vibrate) navigator.vibrate(10);
    }
  };
  const onEnd = () => {
    if (!state.active || !state.targetEl) return;
    const dt = Math.max(1, performance.now() - state.startT);
    const dx = state.movedX;
    const absX = Math.abs(dx);
    const speed = absX / dt;
    let didSwipe = false;
    let swipeDirection: "left" | "right" | null = null;
    if (absX >= threshold || (absX >= 24 && speed >= velocity)) {
      if (dx < 0) {
        didSwipe = true;
        swipeDirection = "left";
      } else if (dx > 0) {
        didSwipe = true;
        swipeDirection = "right";
      }
    }
    const el = state.targetEl as HTMLElement;
    if (didSwipe && el) {
      state.swiped = true;
      if (swipeDirection === "left" && onSwipeLeft) onSwipeLeft();
      else if (swipeDirection === "right" && onSwipeRight) onSwipeRight();
      el.classList.add("swipe-complete");
      clearDragStyle();
      setTimeout(() => el.classList.remove("swipe-complete"), 400);
    } else {
      clearDragStyle();
    }
    state.active = false;
    state.pointer = "none";
  };
  return {
    onTouchStart: (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      onStart(e.currentTarget as HTMLElement, t.clientX, t.clientY, "touch");
    },
    onTouchMove: (e: TouchEvent) => {
      if (!state.active || state.pointer !== "touch") return;
      const t = e.touches[0];
      if (!t) return;
      onMove(t.clientX, t.clientY);
    },
    onTouchEnd: () => {
      if (state.pointer !== "touch") return;
      onEnd();
    },
    onMouseDown: (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (window.getSelection) window.getSelection()?.removeAllRanges();
      onStart(e.currentTarget as HTMLElement, e.clientX, e.clientY, "mouse");
    },
    onMouseMove: (e: MouseEvent) => {
      if (!state.active || state.pointer !== "mouse") return;
      onMove(e.clientX, e.clientY);
    },
    onMouseUp: () => {
      if (state.pointer !== "mouse") return;
      onEnd();
    },
    onClick: (e: MouseEvent) => {
      if (Math.abs(state.movedX) > 6 || state.swiped) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}
let pendingDeleteSessionId: string | null = null;

function openDeleteWorkoutModal(sessionId: string) {
  pendingDeleteSessionId = sessionId;
  const bg = document.getElementById("deleteWorkoutModalBg");
  if (bg) bg.style.display = "flex";
}

function closeDeleteWorkoutModal() {
  const bg = document.getElementById("deleteWorkoutModalBg");
  if (bg) bg.style.display = "none";
  pendingDeleteSessionId = null;
}

async function confirmDeleteWorkout() {
  if (pendingDeleteSessionId) {
    const success = await deleteWorkoutSummary(pendingDeleteSessionId);
    if (success) await loadWorkoutSummaries();
    closeDeleteWorkoutModal();
  }
}

async function deleteWorkout(sessionId: string) {
  const success = await deleteWorkoutSummary(sessionId);
  if (success) await loadWorkoutSummaries();
  return success;
}
let currentWorkoutSummary: any = null;

function viewWorkoutSummary(sessionId: string) {
  (window as any).initDB().then((db: IDBDatabase) => {
    const transaction = db.transaction(["workouts"], "readonly");
    const store = transaction.objectStore("workouts");
    const request = store.get(sessionId);
    request.onsuccess = () => {
      const workout = request.result;
      if (workout && workout.summary) {
        const summaryForEmission = { ...workout.summary };
        delete summaryForEmission.day;
        showWorkoutSummaryModal(summaryForEmission);
      }
    };
  });
}

function showWorkoutSummaryModal(summary: any) {
  currentWorkoutSummary = summary;
  const jsonElement = document.getElementById("workoutSummaryJson");
  if (jsonElement) jsonElement.textContent = JSON.stringify(summary, null, 2);
  const vo2El = document.getElementById("workoutSummaryVo2");
  if (vo2El) {
    const view = summary?.vo2_assessment ? vo2AssessmentPresentation(summary.vo2_assessment) : null;
    if (view) {
      vo2El.style.display = "";
      vo2El.innerHTML =
        `<div class="vo2-summary-title">${view.title}</div>` +
        (view.valueText ? `<div class="vo2-assessment-value">${view.valueText}</div>` : "") +
        `<div class="label">${view.body}</div>` +
        (view.detail ? `<div class="label" style="margin-top:8px;">${view.detail}</div>` : "");
      renderVo2StageDiagnostics(vo2El, view.stages);
    } else {
      vo2El.style.display = "none";
      vo2El.innerHTML = "";
    }
  }
  const bg = document.getElementById("workoutSummaryModalBg");
  if (bg) bg.style.display = "flex";
}

function renderVo2StageDiagnostics(
  container: HTMLElement,
  stages: ReturnType<typeof vo2AssessmentPresentation>["stages"]
) {
  const existing = container.querySelector(".vo2-stage-diagnostics");
  if (existing) existing.remove();
  if (stages.length === 0) return;
  const list = document.createElement("div");
  list.className = "vo2-stage-diagnostics";
  for (const stage of stages) {
    const row = document.createElement("div");
    row.className = `vo2-stage-diagnostic ${stage.eligible ? "eligible" : "ineligible"}`;
    const headline = document.createElement("strong");
    headline.textContent = stage.headline;
    const detail = document.createElement("span");
    detail.textContent = stage.detail;
    row.append(headline, detail);
    list.appendChild(row);
  }
  container.appendChild(list);
}

function presentVo2Assessment(summary: { vo2_assessment?: import("./types.js").Vo2AssessmentResult }) {
  const view = vo2AssessmentPresentation(summary?.vo2_assessment);
  const titleEl = document.getElementById("vo2AssessmentTitle");
  const valueEl = document.getElementById("vo2AssessmentValue");
  const bodyEl = document.getElementById("vo2AssessmentBody");
  const detailEl = document.getElementById("vo2AssessmentDetail");
  if (titleEl) titleEl.textContent = view.title;
  if (valueEl) {
    valueEl.textContent = view.valueText;
    valueEl.style.display = view.valueText ? "" : "none";
  }
  if (bodyEl) bodyEl.textContent = view.body;
  if (detailEl) {
    detailEl.textContent = view.detail;
    detailEl.style.display = view.detail ? "" : "none";
  }
  const stagesEl = document.getElementById("vo2AssessmentStages");
  if (stagesEl) renderVo2StageDiagnostics(stagesEl, view.stages);
  const bg = document.getElementById("vo2AssessmentModalBg");
  if (bg) bg.style.display = "flex";
}

function closeVo2AssessmentModal() {
  const bg = document.getElementById("vo2AssessmentModalBg");
  if (bg) bg.style.display = "none";
}

function closeWorkoutSummaryModal() {
  const bg = document.getElementById("workoutSummaryModalBg");
  if (bg) bg.style.display = "none";
  currentWorkoutSummary = null;
}

function downloadJsonFile(filename: string, data: any) {
  const payload = { ...data };
  delete payload.day;
  const jsonStr = JSON.stringify(payload, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadWorkoutSummaryFile(summary: any) {
  if (!summary) {
    showToast("Workout summary not available", "error");
    return;
  }
  const sessionId = summary.external_session_id || "workout";
  downloadJsonFile(`workout-${sessionId}.json`, summary);
  showToast("Workout JSON downloaded", "success");
}

function downloadWorkoutSummaryJson() {
  downloadWorkoutSummaryFile(currentWorkoutSummary);
}

function showToast(message: string, type: "info" | "success" | "error" = "info") {
  const existingToast = document.getElementById("toast");
  if (existingToast) existingToast.remove();
  const toast = document.createElement("div");
  toast.id = "toast";
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add("show"), 10);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
function displayWorkoutSummaries(workouts: any[]) {
  const listContainer = document.getElementById("workoutSummaryList");
  if (!listContainer) return;
  if (workouts.length === 0) {
    listContainer.innerHTML = '<div class="label" style="text-align: center; margin-bottom: 16px;">No workouts recorded yet</div>';
    return;
  }
  listContainer.innerHTML = "";
  workouts.forEach((workout) => {
    const summary = workout.summary;
    const workoutItem = document.createElement("div");
    workoutItem.className = "workout-item";
    workoutItem.dataset.sessionId = summary.external_session_id;
    const date = new Date(summary.startedAt);
    const dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const cancelledLabel = summary.cancelled ? '<span class="workout-item-cancelled">cancelled</span>' : "";
    const vo2Outcome = vo2HistoryOutcomeText(summary.vo2_assessment);
    const vo2Detail = vo2Outcome
      ? `<div class="workout-item-detail workout-item-vo2">${vo2Outcome}</div>`
      : "";
    const personalizationHistory = buildPersonalizationHistoryDetail(
      summary.shadow_prescription_characterization
    );
    const personalizationDetail = personalizationHistory
      ? `<div class="workout-item-detail workout-item-personalization"><strong>${personalizationHistory.title}</strong><span>${personalizationHistory.body}</span></div>`
      : "";
    workoutItem.innerHTML = `
      <div class="swipe-left-indicator"></div>
      <div class="swipe-right-indicator"></div>
      <div class="workout-item-header">
        <div>
          <div class="workout-item-title">${summary.intent || "Workout"}</div>
          <div class="workout-item-date">${dateStr}</div>
        </div>
        ${cancelledLabel}
      </div>
      <div class="workout-item-details">
        <div class="workout-item-detail">Duration: ${summary.duration_minutes} min</div>
        <div class="workout-item-detail">Primary Zone: ${summary.primary_zone}</div>
        <div class="workout-item-detail">Stress: ${summary.stress_profile}</div>
        ${vo2Detail}
        ${personalizationDetail}
      </div>
      <div class="workout-item-actions">
        <button class="button" onclick="viewWorkoutSummary('${summary.external_session_id}')">View</button>
        <button type="button" class="button secondary" data-download-json>Download JSON</button>
      </div>
    `;
    const downloadBtn = workoutItem.querySelector("[data-download-json]");
    if (downloadBtn) {
      downloadBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        downloadWorkoutSummaryFile(summary);
      });
    }
    const swipe = createSwipeHandler(
      () => {
        const sessionId = workoutItem.dataset.sessionId;
        if (sessionId) {
          workoutItem.classList.add("deleting");
          setTimeout(() => {
            workoutItem.classList.remove("deleting");
            openDeleteWorkoutModal(sessionId);
          }, 300);
        }
      },
      async () => {
        const sessionId = workoutItem.dataset.sessionId;
        if (sessionId) {
          workoutItem.classList.add("sending");
          try {
            const result = await sendWorkoutToSisu(sessionId);
            workoutItem.classList.remove("sending");
            if (result.success) showToast(result.message, "success");
            else showToast(result.message, "error");
          } catch (error: any) {
            workoutItem.classList.remove("sending");
            showToast("Error sending to SISU: " + error.message, "error");
          }
        }
      }
    );
    workoutItem.addEventListener("touchstart", swipe.onTouchStart);
    workoutItem.addEventListener("touchmove", swipe.onTouchMove);
    workoutItem.addEventListener("touchend", swipe.onTouchEnd);
    workoutItem.addEventListener("mousedown", swipe.onMouseDown);
    workoutItem.addEventListener("mousemove", swipe.onMouseMove);
    workoutItem.addEventListener("mouseup", swipe.onMouseUp);
    workoutItem.addEventListener(
      "click",
      (e) => {
        if (swipe.onClick) swipe.onClick(e as any);
      },
      true
    );
    listContainer.appendChild(workoutItem);
  });
}

let lastPersistedWorkoutHrElapsed: number | undefined;
let lastPersistedWorkoutHrSessionId: string | null = null;
let lastPersistedHydratedSessionId: string | null = null;
let lastPersistedHydrate: { sessionId: string; promise: Promise<void> } | null = null;

async function ensureLastPersistedHydrated(sessionId: string): Promise<void> {
  if (lastPersistedHydratedSessionId === sessionId) return;
  if (lastPersistedHydrate?.sessionId === sessionId) {
    await lastPersistedHydrate.promise;
    return;
  }
  const promise = getHrSamples(sessionId)
    .then((samples) => {
      if (lastPersistedHydrate?.sessionId !== sessionId) return;
      const max = lastPersistedElapsedFromHrSamples(samples);
      if (lastPersistedWorkoutHrSessionId !== sessionId) {
        lastPersistedWorkoutHrSessionId = sessionId;
        lastPersistedWorkoutHrElapsed = max;
      } else if (
        max !== undefined &&
        (lastPersistedWorkoutHrElapsed === undefined || max > lastPersistedWorkoutHrElapsed)
      ) {
        lastPersistedWorkoutHrElapsed = max;
      }
      lastPersistedHydratedSessionId = sessionId;
    })
    .catch((err: unknown) => console.error("Error hydrating persisted HR elapsed:", err));
  lastPersistedHydrate = { sessionId, promise };
  await promise;
}

async function persistWorkoutRelativeHr(
  session: ReturnType<typeof getSession>,
  bpm: number
): Promise<void> {
  if (!session.sessionId) return;
  await ensureLastPersistedHydrated(session.sessionId);
  const latest = getSession(getSelectedDay());
  if (latest.sessionId !== session.sessionId) return;
  const lastElapsed =
    latest.sessionId === lastPersistedWorkoutHrSessionId ? lastPersistedWorkoutHrElapsed : undefined;
  const sample = workoutRelativeHrSample(latest, Date.now(), lastElapsed);
  if (!sample || !latest.sessionId) return;
  lastPersistedWorkoutHrSessionId = latest.sessionId;
  lastPersistedWorkoutHrElapsed = sample.elapsedSec;
  recordMachineHeartRateSample(latest.sessionId, sample.elapsedSec, bpm);
  if (typeof (window as any).storeHrSample === "function") {
    (window as any).storeHrSample(latest.sessionId, sample.elapsedSec, bpm).catch((err: any) => console.error("Error storing HR sample:", err));
  }
}

function registerUiGlobals(phaseBoxEl: HTMLElement | null) {
  phaseDisplayEl = phaseBoxEl;
  // Record explicit resistance-actuation provenance at the Bike Bridge command site.
  getBikeBridgeSession().setActuationObserver(createActuationProvenanceObserver());

  onBpm((bpm) => {
    liveBpm = bpm;
    lastBpmUpdateTime = Date.now();
    (window as any).liveBpm = liveBpm;
    (window as any).lastBpmUpdateTime = lastBpmUpdateTime;
    updateHrDisplay(bpm);
    updateHeartPulse(bpm);
    updateHeartColor(bpm, currentExpectedHeartRate);
    const day = getSelectedDay();
    const session = getSession(day);
    void persistWorkoutRelativeHr(session, bpm);
  });

  onHrvUpdate((snapshot) => {
    renderHrvDisplay(formatHrvDisplay(snapshot));
  });
  renderHrvDisplay(formatHrvDisplay({
    connected: false,
    connectedDurationMs: 0,
    cleanMeasurementCountThisSession: 0,
    rrSeenThisSession: false,
    readiness: "collecting",
    ready: false,
    reliable: false,
    rmssdMs: null,
    physiologicalDurationMs: 0,
  }));

  if (phaseDisplayEl) {
    phaseDisplayEl.dataset.phaseState = "idle";
    phaseDisplayEl.addEventListener("click", promptCancelWorkout);
  }
  const ringCenter = document.getElementById("ringCenter");
  if (ringCenter) {
    ringCenter.addEventListener("click", () => {
      showElapsedInRing = !showElapsedInRing;
      updateDisplay();
    });
  }
  (window as any).getSelectedDay = getSelectedDay;
  (window as any).getShowElapsed = getShowElapsed;
  (window as any).setSelectedDay = setSelectedDay;
  (window as any).connectHr = connectHr;
  (window as any).updateHrMonitorStatus = updateHrMonitorLabel;
  (window as any).updateHrDisplay = updateHrDisplay;
  (window as any).openModal = openModal;
  (window as any).closeModal = closeModal;
  (window as any).openCancelModal = openCancelModal;
  (window as any).closeCancelModal = closeCancelModal;
  (window as any).closeActivitySelectModal = closeActivitySelectModal;
  (window as any).promptWorkoutActivitySelection = promptWorkoutActivitySelection;
  (window as any).confirmCancelWorkout = confirmCancelWorkout;
  (window as any).confirmEarlyCooldownWorkout = confirmEarlyCooldownWorkout;
  (window as any).confirmVo2LimitReached = confirmVo2LimitReached;
  (window as any).promptCancelWorkout = promptCancelWorkout;
  (window as any).switchTab = switchTab;
  (window as any).getShowSecondsCountdown = getShowSecondsCountdown;
  (window as any).getVoicePromptsEnabled = getVoicePromptsEnabled;
  (window as any).savePreferenceShowSeconds = savePreferenceShowSeconds;
  (window as any).savePreferenceVoicePrompts = savePreferenceVoicePrompts;
  (window as any).loadEquipmentSettings = loadEquipmentSettings;
  (window as any).saveBikeEquipmentSelection = saveBikeEquipmentSelection;
  (window as any).saveBikeBridgeUrl = saveBikeBridgeUrl;
  (window as any).saveBikeBridgeAutomaticControl = saveBikeBridgeAutomaticControl;
  (window as any).saveBikeBridgeBrightness = saveBikeBridgeBrightness;
  (window as any).updateBikeBridgeBrightnessLabel = updateBikeBridgeBrightnessLabel;
  (window as any).promptResetLearnedGuidance = promptResetLearnedGuidance;
  (window as any).closeResetLearnedModal = closeResetLearnedModal;
  (window as any).confirmResetLearnedGuidance = confirmResetLearnedGuidance;
  (window as any).promptResetHrDynamics = promptResetHrDynamics;
  (window as any).closeResetHrDynamicsModal = closeResetHrDynamicsModal;
  (window as any).confirmResetHrDynamics = confirmResetHrDynamics;
  (window as any).promptResetShadowPredictions = promptResetShadowPredictions;
  (window as any).closeResetShadowPredictionsModal = closeResetShadowPredictionsModal;
  (window as any).confirmResetShadowPredictions = confirmResetShadowPredictions;
  (window as any).exportMachineDiagnostics = exportMachineDiagnostics;
  (window as any).loadPersonalizationDiagnostics = loadPersonalizationDiagnostics;
  (window as any).loadPerformedLoadDiagnostics = loadPerformedLoadDiagnostics;
  (window as any).applyPersonalizationDiagnosticsFilters = applyPersonalizationDiagnosticsFilters;
  (window as any).resetPersonalizationDiagnosticsFilters = resetPersonalizationDiagnosticsFilters;
  (window as any).openPersonalizationDiagnostic = openPersonalizationDiagnostic;
  (window as any).closePersonalizationDiagnostic = closePersonalizationDiagnostic;
  (window as any).exportPersonalizationDiagnostics = exportPersonalizationDiagnostics;
  (window as any).loadWorkoutSummaries = loadWorkoutSummaries;
  (window as any).viewWorkoutSummary = viewWorkoutSummary;
  (window as any).showWorkoutSummaryModal = showWorkoutSummaryModal;
  (window as any).closeWorkoutSummaryModal = closeWorkoutSummaryModal;
  (window as any).presentVo2Assessment = presentVo2Assessment;
  (window as any).closeVo2AssessmentModal = closeVo2AssessmentModal;
  (window as any).downloadWorkoutSummaryJson = downloadWorkoutSummaryJson;
  (window as any).showToast = showToast;
  (window as any).openDeleteWorkoutModal = openDeleteWorkoutModal;
  (window as any).closeDeleteWorkoutModal = closeDeleteWorkoutModal;
  (window as any).confirmDeleteWorkout = confirmDeleteWorkout;
  (window as any).deleteWorkout = deleteWorkout;
  (window as any).updateHeartPulse = updateHeartPulse;
  (window as any).updateHeartColor = updateHeartColor;
  (window as any).updateDisplay = updateDisplay;
  getBikeBridgeSession().subscribe(() => {
    renderBikeBridgeHud();
    recordVo2BikeTelemetryIfActive();
    recordOrdinaryBikeTelemetryIfActive();
    const equipmentTab = document.getElementById("equipmentTab");
    if (equipmentTab?.classList.contains("active")) renderBikeBridgeSettingsStatus();
  });
}

export {
  getSelectedDay,
  setSelectedDay,
  connectHr,
  updateHrDisplay,
  updateHeartPulse,
  updateHeartColor,
  updateDisplay,
  switchTab,
  savePreferenceShowSeconds,
  savePreferenceVoicePrompts,
  loadEquipmentSettings,
  saveBikeEquipmentSelection,
  loadWorkoutSummaries,
  registerUiGlobals,
};
