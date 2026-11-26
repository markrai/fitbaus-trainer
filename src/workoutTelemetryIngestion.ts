import {
  lastPersistedElapsedFromHrSamples,
  workoutRelativeHrSample,
  recordVo2ActiveBikeTelemetry,
  ordinaryActiveBikeTelemetrySample,
} from "./workoutLogic.js";
import { getHrSamplesStrict, queueOrdinaryBikeTelemetrySample, queueWorkoutHrSample } from "./workoutStorage.js";
import { getSession } from "./sessionStore.js";
import { isVo2WorkoutSelector } from "./vo2Protocol.js";
import { readSessionFinalization, readFreestyleAuthorityFault } from "./freestyleRide.js";
import { getBikeBridgeSession } from "./platform/bikeBridgeRuntime.js";
import { recordMachineHeartRateSample } from "./machines/runtime.js";

const defaultDependencies = {
  getSession,
  getHrSamples: getHrSamplesStrict,
  getBikeBridgeSession,
  readSessionFinalization,
  readFreestyleAuthorityFault,
  recordVo2ActiveBikeTelemetry,
  ordinaryActiveBikeTelemetrySample,
  queueOrdinaryBikeTelemetrySample,
  recordMachineHeartRateSample,
  now: () => Date.now(),
  storeHrSample: queueWorkoutHrSample,
};

export function createWorkoutTelemetryIngestion(
  resolveOwnedWorkoutDay: () => string,
  overrides: Partial<typeof defaultDependencies> = {}
) {
  const { getSession, getHrSamples, getBikeBridgeSession, readSessionFinalization, readFreestyleAuthorityFault, recordVo2ActiveBikeTelemetry, ordinaryActiveBikeTelemetrySample, queueOrdinaryBikeTelemetrySample, recordMachineHeartRateSample, now, storeHrSample } = { ...defaultDependencies, ...overrides };

  let lastAcceptedWorkoutHrElapsed: number | undefined;
  let lastAcceptedWorkoutHrSessionId: string | null = null;
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
        if (lastAcceptedWorkoutHrSessionId !== sessionId) {
          lastAcceptedWorkoutHrSessionId = sessionId;
          lastAcceptedWorkoutHrElapsed = max;
        } else if (
          max !== undefined &&
          (lastAcceptedWorkoutHrElapsed === undefined || max > lastAcceptedWorkoutHrElapsed)
        ) {
          lastAcceptedWorkoutHrElapsed = max;
        }
        lastPersistedHydratedSessionId = sessionId;
      })
      .finally(() => {
        if (lastPersistedHydrate && lastPersistedHydrate.promise === promise) lastPersistedHydrate = null;
      });
    lastPersistedHydrate = { sessionId, promise };
    await promise;
  }

  async function persistWorkoutRelativeHr(bpm: number): Promise<void> {
    const session = getSession(resolveOwnedWorkoutDay());
    if (!session.sessionId || session.summaryEmitted === "true" || readSessionFinalization(resolveOwnedWorkoutDay())) return;
    try {
      await ensureLastPersistedHydrated(session.sessionId);
    } catch (error) {
      console.error("Error hydrating persisted HR elapsed:", error);
      return;
    }
    const latest = getSession(resolveOwnedWorkoutDay());
    if (latest.sessionId !== session.sessionId || latest.summaryEmitted === "true") return;
    if (latest.sessionId && readSessionFinalization(resolveOwnedWorkoutDay())) return;
    const lastElapsed =
      latest.sessionId === lastAcceptedWorkoutHrSessionId ? lastAcceptedWorkoutHrElapsed : undefined;
    const sample = workoutRelativeHrSample(latest, now(), lastElapsed);
    if (!sample || !latest.sessionId) return;
    if (!storeHrSample(latest.sessionId, sample.elapsedSec, bpm)) return;
    lastAcceptedWorkoutHrSessionId = latest.sessionId;
    lastAcceptedWorkoutHrElapsed = sample.elapsedSec;
    recordMachineHeartRateSample(latest.sessionId, sample.elapsedSec, bpm);
  }

  function recordVo2BikeTelemetryIfActive(): void {
    const day = resolveOwnedWorkoutDay();
    if (!isVo2WorkoutSelector(day)) return;
    const session = getSession(day);
    if (!session.sessionId || !session.startTime || session.summaryEmitted === "true" || readSessionFinalization(day)) return;
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
    const day = resolveOwnedWorkoutDay();
    if (isVo2WorkoutSelector(day)) return;
    const session = getSession(day);
    if (
      !session.sessionId ||
      !session.startTime ||
      !session.athleteId ||
      session.activity !== "bike" ||
      session.summaryEmitted === "true"
    ) {
      return;
    }
    if (readSessionFinalization(day)) return;
    if (readFreestyleAuthorityFault(day)) return;
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

  function recordBikeTelemetry(): void {
    recordVo2BikeTelemetryIfActive();
    recordOrdinaryBikeTelemetryIfActive();
  }

  return { recordBikeTelemetry, persistWorkoutRelativeHr };
}
