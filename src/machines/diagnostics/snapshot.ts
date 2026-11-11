import { APP_VERSION } from "../../version.js";
import { resolveSelectedMachine } from "../selection.js";
import { listLearnedStarts, type LearningKeyParts } from "../learning/index.js";
import {
  DEFAULT_LONG_COOLDOWN_SECONDS,
  DEFAULT_LONG_INITIAL_SECONDS,
  DEFAULT_MEDIUM_INITIAL_SECONDS,
  getDynamicsEntry,
  highConfidenceRecentDelayEstimate,
  listHrDynamics,
  responseDetectionRate,
  trustedDelayMedian,
} from "../dynamics/index.js";
import type { StoredDynamicsEntry } from "../dynamics/types.js";
import {
  getShadowPredictionEntry,
  listShadowPredictions,
  loadShadowPredictionStore,
  MAX_SHADOW_VALIDATION_ABS_MEDIAN_BIAS_BPM,
  MAX_SHADOW_VALIDATION_MEDIAN_ABSOLUTE_ERROR_BPM,
  MIN_SHADOW_VALIDATION_DIRECTION_MATCH_RATE,
  MIN_SHADOW_VALIDATION_DISTINCT_SESSIONS,
  MIN_SHADOW_VALIDATION_REALIZATION_RATE,
  MIN_SHADOW_VALIDATION_REALIZED_PREDICTIONS,
  MIN_SHADOW_VALIDATION_WITHIN_TOLERANCE_RATE,
  usableShadowSessionId,
} from "../prediction/index.js";
import type { WorkDurationClass } from "../learning/types.js";
import type { MachineShadowResistancePrediction, ShadowDirectionDiagnostics } from "../prediction/types.js";
import {
  MACHINE_DIAGNOSTICS_SNAPSHOT_VERSION,
  type BuildMachineDiagnosticsSnapshotOptions,
  type MachineDiagnosticsExport,
  type MachineDiagnosticsHrDynamics,
  type MachineDiagnosticsLearnedStart,
  type MachineDiagnosticsMaximumProgress,
  type MachineDiagnosticsRateProgress,
  type MachineDiagnosticsShadowDirection,
  type MachineDiagnosticsShadowEntry,
  type MachineDiagnosticsSnapshot,
  type MachineDiagnosticsTiming,
  type MachineDiagnosticsValidationProgress,
} from "./types.js";

export function shadowValidationProgress(
  diagnostics: Pick<
    ShadowDirectionDiagnostics,
    | "realizedPredictionCount"
    | "distinctSessionCount"
    | "realizationRate"
    | "medianAbsolutePredictionErrorBpm"
    | "medianSignedPredictionErrorBpm"
    | "directionMatchRate"
    | "withinToleranceRate"
  >
): MachineDiagnosticsValidationProgress {
  const absoluteMedianBiasBpm =
    diagnostics.medianSignedPredictionErrorBpm === undefined
      ? undefined
      : Math.abs(diagnostics.medianSignedPredictionErrorBpm);
  return {
    realized: {
      current: diagnostics.realizedPredictionCount,
      required: MIN_SHADOW_VALIDATION_REALIZED_PREDICTIONS,
    },
    sessions: {
      current: diagnostics.distinctSessionCount,
      required: MIN_SHADOW_VALIDATION_DISTINCT_SESSIONS,
    },
    realizationRate: rateProgress(diagnostics.realizationRate, MIN_SHADOW_VALIDATION_REALIZATION_RATE),
    medianAbsoluteErrorBpm: maximumProgress(
      diagnostics.medianAbsolutePredictionErrorBpm,
      MAX_SHADOW_VALIDATION_MEDIAN_ABSOLUTE_ERROR_BPM
    ),
    absoluteMedianBiasBpm: maximumProgress(absoluteMedianBiasBpm, MAX_SHADOW_VALIDATION_ABS_MEDIAN_BIAS_BPM),
    directionMatchRate: rateProgress(diagnostics.directionMatchRate, MIN_SHADOW_VALIDATION_DIRECTION_MATCH_RATE),
    withinToleranceRate: rateProgress(diagnostics.withinToleranceRate, MIN_SHADOW_VALIDATION_WITHIN_TOLERANCE_RATE),
  };
}

function rateProgress(current: number | undefined, required: number): MachineDiagnosticsRateProgress {
  const progress: MachineDiagnosticsRateProgress = {
    required,
    passes: current !== undefined && current >= required,
  };
  if (current !== undefined) progress.current = current;
  return progress;
}

function maximumProgress(current: number | undefined, maximum: number): MachineDiagnosticsMaximumProgress {
  const progress: MachineDiagnosticsMaximumProgress = {
    maximum,
    passes: current !== undefined && current <= maximum,
  };
  if (current !== undefined) progress.current = current;
  return progress;
}

function needed(current: number, required: number): number {
  return Math.max(0, required - current);
}

function hasLaterTimingEvidence(entry: StoredDynamicsEntry, durationClass: WorkDurationClass): boolean {
  if (trustedDelayMedian(entry.workStartDelays) !== undefined) return true;
  if (durationClass !== "long") return false;
  return (
    trustedDelayMedian(entry.increaseDelays) !== undefined || trustedDelayMedian(entry.decreaseDelays) !== undefined
  );
}

function hasEarlyTimingEvidence(entry: StoredDynamicsEntry, durationClass: WorkDurationClass): boolean {
  if (highConfidenceRecentDelayEstimate(entry.workStartRecentResponses) !== undefined) return true;
  if (durationClass !== "long") return false;
  return (
    highConfidenceRecentDelayEstimate(entry.increaseRecentResponses) !== undefined ||
    highConfidenceRecentDelayEstimate(entry.decreaseRecentResponses) !== undefined
  );
}

function timingDiagnostics(
  entry: ReturnType<typeof listHrDynamics>[number],
  storage: BuildMachineDiagnosticsSnapshotOptions["storage"]
): MachineDiagnosticsTiming | undefined {
  if (entry.durationClass !== "medium" && entry.durationClass !== "long") return undefined;
  const parts: LearningKeyParts = {
    machineId: entry.machineId,
    machineProfileVersion: entry.machineProfileVersion,
    activity: entry.activity,
    intent: entry.intent,
    durationClass: entry.durationClass,
  };
  const stored = getDynamicsEntry(parts, storage);
  const timing: MachineDiagnosticsTiming = {
    durationClass: entry.durationClass,
    defaultInitialEvaluationSeconds:
      entry.durationClass === "medium" ? DEFAULT_MEDIUM_INITIAL_SECONDS : DEFAULT_LONG_INITIAL_SECONDS,
    laterTimingEvidenceQualifies: stored ? hasLaterTimingEvidence(stored, entry.durationClass) : false,
    earlyTimingEvidenceQualifies: stored ? hasEarlyTimingEvidence(stored, entry.durationClass) : false,
  };
  if (entry.durationClass === "long") timing.defaultCooldownSeconds = DEFAULT_LONG_COOLDOWN_SECONDS;
  if (entry.timingMode) timing.timingMode = entry.timingMode;
  return timing;
}

function learnedStartDiagnostics(entry: MachineDiagnosticsLearnedStart): MachineDiagnosticsLearnedStart {
  return {
    machineId: entry.machineId,
    machineProfileVersion: entry.machineProfileVersion,
    activity: entry.activity,
    intent: entry.intent,
    durationClass: entry.durationClass,
    resistance: entry.resistance,
    sampleCount: entry.sampleCount,
    updatedAt: entry.updatedAt,
  };
}

function hrDynamicsDiagnostics(
  entry: ReturnType<typeof listHrDynamics>[number],
  storage: BuildMachineDiagnosticsSnapshotOptions["storage"]
): MachineDiagnosticsHrDynamics {
  const listed: MachineDiagnosticsHrDynamics = {
    machineId: entry.machineId,
    machineProfileVersion: entry.machineProfileVersion,
    activity: entry.activity,
    intent: entry.intent,
    durationClass: entry.durationClass,
    workStartObservationCount: entry.workStartObservationCount,
    workStartDetectedResponseCount: entry.workStartDetectedResponseCount,
    increaseObservationCount: entry.increaseObservationCount,
    increaseDetectedResponseCount: entry.increaseDetectedResponseCount,
    decreaseObservationCount: entry.decreaseObservationCount,
    decreaseDetectedResponseCount: entry.decreaseDetectedResponseCount,
    workStartRecentObservationCount: entry.workStartRecentObservationCount,
    workStartRecentDetectedResponseCount: entry.workStartRecentDetectedResponseCount,
    increaseRecentObservationCount: entry.increaseRecentObservationCount,
    increaseRecentDetectedResponseCount: entry.increaseRecentDetectedResponseCount,
    decreaseRecentObservationCount: entry.decreaseRecentObservationCount,
    decreaseRecentDetectedResponseCount: entry.decreaseRecentDetectedResponseCount,
    updatedAt: entry.updatedAt,
  };
  if (entry.medianWorkStartDelaySeconds !== undefined) {
    listed.medianWorkStartDelaySeconds = entry.medianWorkStartDelaySeconds;
  }
  if (entry.medianIncreaseDelaySeconds !== undefined) listed.medianIncreaseDelaySeconds = entry.medianIncreaseDelaySeconds;
  if (entry.medianDecreaseDelaySeconds !== undefined) listed.medianDecreaseDelaySeconds = entry.medianDecreaseDelaySeconds;
  if (entry.medianIncreaseHrDeltaPerStep !== undefined) {
    listed.medianIncreaseHrDeltaPerStep = entry.medianIncreaseHrDeltaPerStep;
  }
  if (entry.medianDecreaseHrDeltaPerStep !== undefined) {
    listed.medianDecreaseHrDeltaPerStep = entry.medianDecreaseHrDeltaPerStep;
  }
  const workStartRecentRate = responseDetectionRate(
    entry.workStartRecentDetectedResponseCount,
    entry.workStartRecentObservationCount
  );
  const increaseRecentRate = responseDetectionRate(
    entry.increaseRecentDetectedResponseCount,
    entry.increaseRecentObservationCount
  );
  const decreaseRecentRate = responseDetectionRate(
    entry.decreaseRecentDetectedResponseCount,
    entry.decreaseRecentObservationCount
  );
  if (workStartRecentRate !== undefined) listed.workStartRecentDetectionRate = workStartRecentRate;
  if (increaseRecentRate !== undefined) listed.increaseRecentDetectionRate = increaseRecentRate;
  if (decreaseRecentRate !== undefined) listed.decreaseRecentDetectionRate = decreaseRecentRate;
  if (entry.timingPersonalized) listed.timingPersonalized = true;
  const timing = timingDiagnostics(entry, storage);
  if (timing) listed.timing = timing;
  return listed;
}

function shadowDirectionDiagnostics(
  diagnostics: ShadowDirectionDiagnostics,
  events: readonly MachineShadowResistancePrediction[] | undefined,
  includeRawShadowEvents: boolean
): MachineDiagnosticsShadowDirection {
  const progress = shadowValidationProgress(diagnostics);
  const direction: MachineDiagnosticsShadowDirection = {
    modelMedianHrPerLevel: diagnostics.modelMedianHrPerLevel,
    predictionCount: diagnostics.predictionCount,
    validationStatus: diagnostics.validationStatus,
    validationHighConfidence: diagnostics.validationHighConfidence,
    validationOpportunityCount: diagnostics.validationOpportunityCount,
    realizedPredictionCount: diagnostics.realizedPredictionCount,
    distinctSessionCount: diagnostics.distinctSessionCount,
    directionMatchCount: diagnostics.directionMatchCount,
    directionEvaluatedCount: diagnostics.directionEvaluatedCount,
    withinToleranceCount: diagnostics.withinToleranceCount,
    progress,
    evidence: {
      status: diagnostics.validationStatus,
      realizedNeeded: needed(diagnostics.realizedPredictionCount, MIN_SHADOW_VALIDATION_REALIZED_PREDICTIONS),
      sessionsNeeded: needed(diagnostics.distinctSessionCount, MIN_SHADOW_VALIDATION_DISTINCT_SESSIONS),
    },
  };
  if (diagnostics.realizationRate !== undefined) direction.realizationRate = diagnostics.realizationRate;
  if (diagnostics.medianAbsolutePredictionErrorBpm !== undefined) {
    direction.medianAbsolutePredictionErrorBpm = diagnostics.medianAbsolutePredictionErrorBpm;
  }
  if (diagnostics.medianSignedPredictionErrorBpm !== undefined) {
    direction.medianSignedPredictionErrorBpm = diagnostics.medianSignedPredictionErrorBpm;
  }
  if (diagnostics.directionMatchRate !== undefined) direction.directionMatchRate = diagnostics.directionMatchRate;
  if (diagnostics.withinToleranceRate !== undefined) direction.withinToleranceRate = diagnostics.withinToleranceRate;
  if (includeRawShadowEvents && events) direction.events = [...events];
  return direction;
}

function emptySnapshot(generatedAt: string): MachineDiagnosticsSnapshot {
  return {
    version: MACHINE_DIAGNOSTICS_SNAPSHOT_VERSION,
    generatedAt,
    appVersion: APP_VERSION,
    summary: {
      learnedStartEntries: 0,
      hrDynamicsEntries: 0,
      shadowPredictionEntries: 0,
      processedShadowSessions: 0,
      validatedDirections: 0,
    },
    learnedStarts: [],
    hrDynamics: [],
    shadowPrediction: {
      processedSessionCount: 0,
      predictionEventSessionCount: 0,
      entries: [],
    },
  };
}

function predictionEventSessionCountForMachine(
  machineId: string,
  storage: BuildMachineDiagnosticsSnapshotOptions["storage"]
): number {
  const sessionIds = new Set<string>();
  for (const listed of listShadowPredictions(machineId, storage)) {
    const stored = getShadowPredictionEntry(listed, storage);
    if (!stored) continue;
    for (const event of [...stored.increase, ...stored.decrease]) {
      if (usableShadowSessionId(event.sessionId)) sessionIds.add(event.sessionId);
    }
  }
  return sessionIds.size;
}

export function buildMachineDiagnosticsSnapshot(
  options: BuildMachineDiagnosticsSnapshotOptions = {}
): MachineDiagnosticsSnapshot {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const includeRawShadowEvents = options.includeRawShadowEvents === true;
  const snapshot = emptySnapshot(generatedAt);
  const machine = resolveSelectedMachine("bike", options.storage);
  if (!machine) return snapshot;
  snapshot.machine = {
    machineId: machine.id,
    machineName: machine.name,
    activity: machine.activity,
    machineProfileVersion: machine.profileVersion,
  };
  snapshot.learnedStarts = listLearnedStarts(machine.id, options.storage).map(learnedStartDiagnostics);
  snapshot.hrDynamics = listHrDynamics(machine.id, options.storage).map((entry) =>
    hrDynamicsDiagnostics(entry, options.storage)
  );
  const listedShadows = listShadowPredictions(machine.id, options.storage);
  const shadowEntries: MachineDiagnosticsShadowEntry[] = [];
  let validatedDirections = 0;
  for (const listed of listedShadows) {
    const stored = getShadowPredictionEntry(listed, options.storage);
    const entry: MachineDiagnosticsShadowEntry = {
      machineId: listed.machineId,
      machineProfileVersion: listed.machineProfileVersion,
      activity: listed.activity,
      intent: listed.intent,
      durationClass: listed.durationClass,
      updatedAt: listed.updatedAt,
    };
    if (listed.increase) {
      entry.increase = shadowDirectionDiagnostics(listed.increase, stored?.increase, includeRawShadowEvents);
      if (listed.increase.validationStatus === "validated") validatedDirections += 1;
    }
    if (listed.decrease) {
      entry.decrease = shadowDirectionDiagnostics(listed.decrease, stored?.decrease, includeRawShadowEvents);
      if (listed.decrease.validationStatus === "validated") validatedDirections += 1;
    }
    shadowEntries.push(entry);
  }
  const processedSessionCount = loadShadowPredictionStore(options.storage).processedSessions.length;
  snapshot.shadowPrediction = {
    processedSessionCount,
    predictionEventSessionCount: predictionEventSessionCountForMachine(machine.id, options.storage),
    entries: shadowEntries,
  };
  snapshot.summary = {
    learnedStartEntries: snapshot.learnedStarts.length,
    hrDynamicsEntries: snapshot.hrDynamics.length,
    shadowPredictionEntries: snapshot.shadowPrediction.entries.length,
    processedShadowSessions: processedSessionCount,
    validatedDirections,
  };
  return snapshot;
}

export function serializeMachineDiagnosticsSnapshot(snapshot: MachineDiagnosticsSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function diagnosticsExportFilename(snapshot: MachineDiagnosticsSnapshot): string {
  const date = snapshot.generatedAt.slice(0, 10);
  if (snapshot.machine?.machineId) {
    return `fitbaus-${snapshot.machine.machineId}-diagnostics-${date}.json`;
  }
  return `fitbaus-machine-diagnostics-${date}.json`;
}

export function prepareMachineDiagnosticsExport(snapshot: MachineDiagnosticsSnapshot): MachineDiagnosticsExport {
  return {
    filename: diagnosticsExportFilename(snapshot),
    mimeType: "application/json",
    body: serializeMachineDiagnosticsSnapshot(snapshot),
  };
}
