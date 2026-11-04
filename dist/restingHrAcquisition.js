/**
 * Pure resting-session HR acquisition. Chest-strap BPM notifications are the
 * only observation source. UI timers may refresh elapsed/freshness/gap
 * diagnostics but must never manufacture or overwrite observation samples.
 * RR/HRV is not a substitute for resting HR.
 */
import { RESTING_HR_SESSION_ALGORITHM_ID, RESTING_HR_SESSION_ALGORITHM_VERSION, RESTING_HR_SESSION_MAX_BPM, RESTING_HR_SESSION_MIN_BPM, RESTING_HR_SESSION_OBSERVATION_DURATION_SEC, RESTING_HR_SESSION_SETTLE_DURATION_SEC, RESTING_HR_SESSION_TOTAL_DURATION_SEC, } from "./types.js";
import { integerMedian, integerMedianAbsoluteDeviation } from "./machines/hrQuality.js";
export const RESTING_HR_SESSION_POLICY_V1 = {
    algorithmId: RESTING_HR_SESSION_ALGORITHM_ID,
    algorithmVersion: RESTING_HR_SESSION_ALGORITHM_VERSION,
    totalDurationSec: RESTING_HR_SESSION_TOTAL_DURATION_SEC,
    settleDurationSec: RESTING_HR_SESSION_SETTLE_DURATION_SEC,
    observationDurationSec: RESTING_HR_SESSION_OBSERVATION_DURATION_SEC,
    bpmFreshnessMs: 3000,
    minPlausibleBpm: RESTING_HR_SESSION_MIN_BPM,
    maxPlausibleBpm: RESTING_HR_SESSION_MAX_BPM,
    abruptChangeBpm: 20,
    minAcceptedObservationSamples: 60,
    minCoverageRatio: 0.8,
    maxMadBpm: 5,
    /**
     * Reject when any run of consecutive observation seconds lacks an accepted
     * sample, even if overall coverage still meets minCoverageRatio. Chosen as
     * ~10% of the 210 s observation window: long enough to catch disconnects or
     * sustained outages, short enough not to fail brief single-second dropouts.
     */
    maxContinuousUnacceptedSec: 20,
    highCoverageRatio: 0.9,
    highMaxMadBpm: 3,
};
export function evaluateRestingHrStartReadiness(input) {
    if (input.measurementInProgress)
        return { ok: false, reason: "measurement_in_progress" };
    if (input.workoutInProgress)
        return { ok: false, reason: "workout_in_progress" };
    if (!input.connected)
        return { ok: false, reason: "not_connected" };
    return { ok: true };
}
export function createRestingHrAcquisition(input) {
    return {
        status: "measuring",
        startedAtMonoMs: input.startedAtMonoMs,
        measurementId: input.measurementId,
        athleteId: input.athleteId,
        lastAcceptedBpm: undefined,
        lastLiveBpm: null,
        lastBpmArrivalMonoMs: null,
        lastConnected: true,
        observationSlots: new Map(),
    };
}
function elapsedSeconds(state, monoMs) {
    return Math.max(0, Math.floor((monoMs - state.startedAtMonoMs) / 1000));
}
function observationIndex(elapsedSec) {
    if (elapsedSec < RESTING_HR_SESSION_POLICY_V1.settleDurationSec)
        return null;
    if (elapsedSec >= RESTING_HR_SESSION_POLICY_V1.totalDurationSec)
        return null;
    return elapsedSec - RESTING_HR_SESSION_POLICY_V1.settleDurationSec;
}
function classifyNotification(state, bpmRaw) {
    const bpm = Math.round(bpmRaw);
    if (!Number.isFinite(bpmRaw) ||
        bpm < RESTING_HR_SESSION_POLICY_V1.minPlausibleBpm ||
        bpm > RESTING_HR_SESSION_POLICY_V1.maxPlausibleBpm) {
        return { kind: "rejected" };
    }
    if (state.lastAcceptedBpm !== undefined &&
        Math.abs(bpm - state.lastAcceptedBpm) > RESTING_HR_SESSION_POLICY_V1.abruptChangeBpm) {
        return { kind: "rejected" };
    }
    return { kind: "accepted", bpm };
}
function slotCounts(state) {
    const expected = RESTING_HR_SESSION_POLICY_V1.observationDurationSec;
    const acceptedBpms = [];
    let accepted = 0;
    let rejected = 0;
    let longest = 0;
    let run = 0;
    for (let index = 0; index < expected; index += 1) {
        const slot = state.observationSlots.get(index);
        if ((slot === null || slot === void 0 ? void 0 : slot.kind) === "accepted") {
            accepted += 1;
            acceptedBpms.push(slot.bpm);
            run = 0;
        }
        else {
            if ((slot === null || slot === void 0 ? void 0 : slot.kind) === "rejected")
                rejected += 1;
            run += 1;
            if (run > longest)
                longest = run;
        }
    }
    return {
        accepted,
        rejected,
        gap: Math.max(0, expected - accepted - rejected),
        acceptedBpms,
        longestContinuousUnaccepted: longest,
    };
}
function phaseFor(state, elapsedSec) {
    if (state.status === "cancelled")
        return "cancelled";
    if (state.status === "rejected")
        return "rejected";
    if (state.status === "completed")
        return "completed";
    if (state.status !== "measuring")
        return "idle";
    if (elapsedSec < RESTING_HR_SESSION_POLICY_V1.settleDurationSec)
        return "settling";
    return "observing";
}
function liveBpmFresh(state, monoMs) {
    return (state.lastBpmArrivalMonoMs != null &&
        monoMs - state.lastBpmArrivalMonoMs <= RESTING_HR_SESSION_POLICY_V1.bpmFreshnessMs &&
        state.lastLiveBpm != null);
}
function qualityLine(state, elapsedSec, connected, monoMs) {
    var _a;
    if (state.status === "cancelled") {
        return state.rejectReason === "interrupted"
            ? "Measurement interrupted because a workout became active."
            : "Measurement cancelled.";
    }
    if (state.status === "rejected") {
        return rejectReasonText((_a = state.rejectReason) !== null && _a !== void 0 ? _a : "insufficient_coverage");
    }
    if (state.status === "completed")
        return "Measurement complete.";
    if (!connected)
        return "Chest strap disconnected.";
    if (!liveBpmFresh(state, monoMs))
        return "Waiting for a fresh heart-rate reading.";
    const counts = slotCounts(state);
    if (elapsedSec < RESTING_HR_SESSION_POLICY_V1.settleDurationSec) {
        return "Settling — stay seated and still.";
    }
    if (counts.rejected > 0) {
        return `Measuring — ${counts.accepted} stable samples, ${counts.rejected} artifacts ignored.`;
    }
    return `Measuring — ${counts.accepted} stable samples.`;
}
export function rejectReasonText(reason) {
    switch (reason) {
        case "incomplete":
            return "Measurement ended before five minutes.";
        case "disconnected":
            return "Chest strap disconnected during measurement. The attempt was abandoned.";
        case "insufficient_coverage":
            return "Too many missing or stale readings to accept a result.";
        case "insufficient_samples":
            return "Not enough stable readings to accept a result.";
        case "excessive_dispersion":
            return "Heart rate was too variable to accept a resting-session result.";
        case "excessive_continuous_gap":
            return "Heart-rate signal had a continuous outage that was too long to accept a result.";
        case "cancelled":
            return "Measurement cancelled.";
        case "interrupted":
            return "Measurement interrupted because a workout became active.";
    }
}
function liveStatus(state, monoMs) {
    const elapsedSec = elapsedSeconds(state, monoMs);
    const counts = slotCounts(state);
    const fresh = liveBpmFresh(state, monoMs);
    return {
        status: state.status,
        phase: phaseFor(state, elapsedSec),
        elapsedSec: Math.min(elapsedSec, RESTING_HR_SESSION_POLICY_V1.totalDurationSec),
        liveBpm: fresh ? state.lastLiveBpm : null,
        liveBpmFresh: fresh,
        acceptedObservationCount: counts.accepted,
        rejectedObservationCount: counts.rejected,
        gapCount: counts.gap,
        longestContinuousUnacceptedSec: counts.longestContinuousUnaccepted,
        qualityLine: qualityLine(state, elapsedSec, state.lastConnected, monoMs),
        ...(state.rejectReason ? { rejectReason: state.rejectReason } : {}),
    };
}
/**
 * Abandon the active measurement when the chest strap disconnects.
 * Reconnection before five minutes does not resume the attempt. Previously
 * collected observation slots are left intact for diagnostics; nothing is saved.
 */
export function abandonRestingHrOnDisconnect(state, monoMs) {
    if (state.status === "measuring") {
        state.status = "rejected";
        state.rejectReason = "disconnected";
        state.lastConnected = false;
    }
    return liveStatus(state, monoMs);
}
/**
 * Ingest one new hrMonitor BPM notification. This is the only path that may
 * create or fill an observation-second bucket. At most one classification is
 * kept per elapsed-second bucket; later notifications in the same second do
 * not replace an existing slot.
 */
export function ingestRestingHrBpmNotification(state, input) {
    if (state.status !== "measuring")
        return liveStatus(state, input.monoMs);
    state.lastConnected = input.connected;
    if (!input.connected) {
        return abandonRestingHrOnDisconnect(state, input.monoMs);
    }
    if (!Number.isFinite(input.bpm)) {
        return liveStatus(state, input.monoMs);
    }
    const bpm = Math.round(input.bpm);
    state.lastLiveBpm = bpm;
    state.lastBpmArrivalMonoMs = input.monoMs;
    const elapsedSec = elapsedSeconds(state, input.monoMs);
    const index = observationIndex(elapsedSec);
    if (index != null && !state.observationSlots.has(index)) {
        const classified = classifyNotification(state, input.bpm);
        state.observationSlots.set(index, classified);
        if (classified.kind === "accepted") {
            state.lastAcceptedBpm = classified.bpm;
        }
    }
    return liveStatus(state, input.monoMs);
}
/**
 * UI / timer refresh only. Updates connection and elapsed presentation.
 * Never creates observation samples and never overwrites an accepted slot.
 * A disconnect here abandons the attempt immediately.
 */
export function refreshRestingHrAcquisitionUi(state, input) {
    if (state.status !== "measuring")
        return liveStatus(state, input.monoMs);
    state.lastConnected = input.connected;
    if (!input.connected) {
        return abandonRestingHrOnDisconnect(state, input.monoMs);
    }
    return liveStatus(state, input.monoMs);
}
export function cancelRestingHrAcquisition(state, monoMs, reason = "cancelled") {
    if (state.status === "measuring") {
        state.status = "cancelled";
        state.rejectReason = reason;
    }
    return liveStatus(state, monoMs);
}
function coverageRatio(accepted) {
    return Number((accepted / RESTING_HR_SESSION_POLICY_V1.observationDurationSec).toFixed(3));
}
export function finalizeRestingHrAcquisition(state, monoMs, timestamps) {
    if (state.status === "cancelled")
        return { outcome: "cancelled" };
    // Disconnect abandon is terminal: reconnection / later finalize cannot accept.
    if (state.status === "rejected" && state.rejectReason === "disconnected") {
        return { outcome: "rejected", reason: "disconnected" };
    }
    if (state.status !== "measuring" && state.status !== "completed" && state.status !== "rejected") {
        return { outcome: "rejected", reason: "incomplete" };
    }
    const elapsedSec = elapsedSeconds(state, monoMs);
    if (elapsedSec < RESTING_HR_SESSION_POLICY_V1.totalDurationSec) {
        state.status = "rejected";
        state.rejectReason = "incomplete";
        return { outcome: "rejected", reason: "incomplete" };
    }
    if (!state.lastConnected) {
        state.status = "rejected";
        state.rejectReason = "disconnected";
        return { outcome: "rejected", reason: "disconnected" };
    }
    const counts = slotCounts(state);
    const coverage = coverageRatio(counts.accepted);
    if (counts.accepted < RESTING_HR_SESSION_POLICY_V1.minAcceptedObservationSamples) {
        state.status = "rejected";
        state.rejectReason = "insufficient_samples";
        return { outcome: "rejected", reason: "insufficient_samples" };
    }
    if (coverage < RESTING_HR_SESSION_POLICY_V1.minCoverageRatio) {
        state.status = "rejected";
        state.rejectReason = "insufficient_coverage";
        return { outcome: "rejected", reason: "insufficient_coverage" };
    }
    if (counts.longestContinuousUnaccepted > RESTING_HR_SESSION_POLICY_V1.maxContinuousUnacceptedSec) {
        state.status = "rejected";
        state.rejectReason = "excessive_continuous_gap";
        return { outcome: "rejected", reason: "excessive_continuous_gap" };
    }
    const mad = integerMedianAbsoluteDeviation(counts.acceptedBpms);
    const median = integerMedian(counts.acceptedBpms);
    if (median === undefined || mad === undefined || mad > RESTING_HR_SESSION_POLICY_V1.maxMadBpm) {
        state.status = "rejected";
        state.rejectReason = "excessive_dispersion";
        return { outcome: "rejected", reason: "excessive_dispersion" };
    }
    const quality = coverage >= RESTING_HR_SESSION_POLICY_V1.highCoverageRatio &&
        mad <= RESTING_HR_SESSION_POLICY_V1.highMaxMadBpm
        ? "high"
        : "moderate";
    state.status = "completed";
    return {
        outcome: "accepted",
        metric: {
            value: {
                metric: "resting_session_heart_rate",
                interpretation: "resting_session_observation_only",
                eligibleForPrescription: false,
                heartRateBpm: median,
                measurementDurationSec: RESTING_HR_SESSION_TOTAL_DURATION_SEC,
                settleDurationSec: RESTING_HR_SESSION_SETTLE_DURATION_SEC,
                observationDurationSec: RESTING_HR_SESSION_OBSERVATION_DURATION_SEC,
                acceptedSampleCount: counts.accepted,
                rejectedSampleCount: counts.rejected,
                expectedObservationSamples: RESTING_HR_SESSION_POLICY_V1.observationDurationSec,
                coverageRatio: coverage,
                medianAbsoluteDeviationBpm: mad,
                observedMinBpm: Math.min(...counts.acceptedBpms),
                observedMaxBpm: Math.max(...counts.acceptedBpms),
            },
            source: "resting_session",
            quality,
            observedAt: timestamps.observedAt,
            updatedAt: timestamps.updatedAt,
            algorithm: {
                id: RESTING_HR_SESSION_ALGORITHM_ID,
                version: RESTING_HR_SESSION_ALGORITHM_VERSION,
            },
            measurementId: state.measurementId,
        },
    };
}
/** Test helper: drive a session from explicit BPM notifications and optional UI refreshes. */
export function runRestingHrSession(events, options = {}) {
    var _a, _b, _c, _d, _e, _f;
    const startedAtMonoMs = (_a = options.startedAtMonoMs) !== null && _a !== void 0 ? _a : 1000000;
    const state = createRestingHrAcquisition({
        startedAtMonoMs,
        measurementId: (_b = options.measurementId) !== null && _b !== void 0 ? _b : "measurement-test",
        athleteId: (_c = options.athleteId) !== null && _c !== void 0 ? _c : "athlete-test",
    });
    let lastMono = startedAtMonoMs;
    for (const event of events) {
        lastMono = startedAtMonoMs + event.elapsedSec * 1000;
        if (event.type === "bpm") {
            ingestRestingHrBpmNotification(state, {
                monoMs: lastMono,
                bpm: event.bpm,
                connected: (_d = event.connected) !== null && _d !== void 0 ? _d : true,
            });
        }
        else {
            refreshRestingHrAcquisitionUi(state, {
                monoMs: lastMono,
                connected: (_e = event.connected) !== null && _e !== void 0 ? _e : true,
            });
        }
    }
    const finalizeAt = Math.max(lastMono, startedAtMonoMs + RESTING_HR_SESSION_POLICY_V1.totalDurationSec * 1000);
    const observedAt = (_f = options.observedAt) !== null && _f !== void 0 ? _f : "2026-11-03T12:05:00.000Z";
    return {
        state,
        result: finalizeRestingHrAcquisition(state, finalizeAt, { observedAt, updatedAt: observedAt }),
    };
}
/** Convenience: one BPM notification per second for the full five minutes. */
export function bpmNotificationsAround(bpm, map = {}) {
    var _a;
    const events = [];
    for (let elapsedSec = 0; elapsedSec < RESTING_HR_SESSION_POLICY_V1.totalDurationSec; elapsedSec += 1) {
        const override = (_a = map[elapsedSec]) !== null && _a !== void 0 ? _a : {};
        if (override.skip)
            continue;
        events.push({
            type: "bpm",
            elapsedSec,
            bpm: override.bpm === undefined ? bpm : override.bpm,
            connected: override.connected,
        });
    }
    return events;
}
