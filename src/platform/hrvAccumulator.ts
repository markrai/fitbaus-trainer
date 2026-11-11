/**
 * Portable rolling RMSSD calculator from genuine RR intervals (ms).
 *
 * Artifact / quality rules (minimize false rejection):
 *
 * 1. invalid — non-finite or ≤ 0. Discarded. Breaks NN continuity.
 *
 * 2. out_of_range — outside [RR_MIN_MS, RR_MAX_MS]
 *    (272 ms ≈ 220 bpm … 2000 ms ≈ 30 bpm). Discarded. Breaks NN continuity.
 *
 * 3. retransmit — nearly identical to the last *accepted* RR and its
 *    physiological end-time advances by less than 75% of that RR.
 *    Duplicate transport notification. Discarded. Does NOT break NN continuity.
 *
 * 4. accepted_suspect — |ΔRR| / prev > SUSPECT_RELATIVE_JUMP (30%) vs the
 *    previous contiguous accepted interval, but still accepted into RMSSD.
 *    Suspect is quality metadata, not an automatic discard.
 *
 * NN continuity / RMSSD:
 *   RMSSD uses only successive accepted pairs where the later sample is marked
 *   continuesFromPrevious. A physiological reject (invalid / out_of_range) or a
 *   stale-neighbor gap clears the neighbor and starts a new NN segment — so
 *   accepted → gap/reject/optional-field hole → accepted never contributes
 *   (810−800) across the hole. Retransmits leave the neighbor in place so the
 *   next real beat still pairs. Use {@link RollingHrvAccumulator.markContinuityBreak}
 *   when expected RR data was lost without a concrete RR value to reject.
 *
 * Timing model (batched BLE RR):
 *   pushRrPacket anchors the last RR's end to packetArrivedAtMs and walks
 *   earlier RRs backward by cumulative duration.
 *
 * Readiness uses physiological duration (sum of accepted RR ms) plus the count
 * of RMSSD-contributing NN differences (not acceptedInWindow−1).
 *
 * Reliability:
 *   artifactPercent — physiological rejects (invalid / out_of_range) /
 *                     (accepted + physiological rejects) in window.
 *                     Retransmits are transport duplicates, not artifacts.
 *   retransmitPercent — retransmits / (accepted + physiological rejects +
 *                       retransmits) in window. Diagnostic only; does not
 *                       mark RMSSD unreliable.
 *   suspectPercent  — suspect accepted / accepted in window
 *   reliable — ready AND artifactPercent ≤ MAX_ARTIFACT AND
 *              suspectPercent ≤ MAX_SUSPECT_PERCENT
 *   Extreme suspect density alone can mark unreliable without treating every
 *   large physiological transition as an artifact.
 *
 * Clock: default now() uses performance.now() when available (monotonic),
 * falling back to Date.now(). Injectable for tests; do not mix domains.
 */

export const HRV_DEFAULT_WINDOW_MS = 60_000;
export const HRV_RR_MIN_MS = 272;
export const HRV_RR_MAX_MS = 2000;
export const HRV_RETRANSMIT_FRACTION = 0.75;
/** Mark as suspect (still accepted). Not used to discard. */
export const HRV_SUSPECT_RELATIVE_JUMP = 0.3;
export const HRV_LIVE_MIN_DURATION_MS = 15_000;
export const HRV_STABLE_MIN_DURATION_MS = 60_000;
export const HRV_LIVE_MIN_DIFFS = 8;
export const HRV_STABLE_MIN_DIFFS = 15;
/** Above this physiological-reject share of (accepted + physiological rejects), mark RMSSD unreliable. */
export const HRV_MAX_ARTIFACT_PERCENT = 25;
/**
 * Above this share of accepted intervals marked suspect, mark unreliable.
 * Does not discard suspect beats from RMSSD.
 */
export const HRV_MAX_SUSPECT_PERCENT = 50;
/**
 * If the physiological end-time gap from lastAccepted exceeds this, the
 * neighbor is stale (missed beats / suspend / delayed delivery). Fresh sequence.
 */
export const HRV_MAX_NEIGHBOR_GAP_MS = 3_000;

export type HrvReadiness = "collecting" | "live" | "stable";

export type HrvDispositionReason =
  | "accepted"
  | "accepted_suspect"
  | "invalid"
  | "out_of_range"
  | "retransmit";

export type HrvPhysiologicalRejectReason = "invalid" | "out_of_range";

function isPhysiologicalRejectReason(reason: string): reason is HrvPhysiologicalRejectReason {
  return reason === "invalid" || reason === "out_of_range";
}

export interface HrvPushResult {
  accepted: boolean;
  reason: HrvDispositionReason;
  /** Physiological end-time assigned to this interval (ms, accumulator clock). */
  endedAtMs: number;
}

export interface HrvAcceptedSample {
  rrMs: number;
  /** End of this RR interval on the reconstructed beat timeline. */
  endedAtMs: number;
  suspect: boolean;
  /**
   * True when this sample continues an unbroken NN sequence from the previous
   * accepted sample (retransmits in between are OK; physiological rejects are not).
   */
  continuesFromPrevious: boolean;
}

export interface HrvRejectedSample {
  rrMs: number;
  endedAtMs: number;
  reason: Exclude<HrvDispositionReason, "accepted" | "accepted_suspect">;
}

export interface HrvSnapshot {
  latestRrMs: number | null;
  rmssdMs: number | null;
  readiness: HrvReadiness;
  /** True when readiness is live or stable. */
  ready: boolean;
  /**
   * False when physiological artifact contamination or extreme suspect density
   * makes the live RMSSD a poor representation of clean NN variability.
   * Transport retransmits do not affect this flag.
   */
  reliable: boolean;
  acceptedInWindow: number;
  rejectedInWindow: number;
  /** Retransmit dispositions still in the rolling window. */
  retransmitInWindow: number;
  suspectInWindow: number;
  /** Number of accepted pairs that currently contribute to RMSSD. */
  nnDiffCount: number;
  /** Continuity breaks (physiological rejects + stale gaps + optional-field holes) still in window. */
  continuityBreaksInWindow: number;
  /** Counts of continuity-break reasons still in the rolling window. */
  continuityBreakReasonsInWindow: Readonly<Record<string, number>>;
  /**
   * Physiological contamination: invalid+out_of_range /
   * (accepted + invalid + out_of_range) * 100 in the current window.
   * Retransmits are excluded. 0 if that denominator is empty.
   */
  artifactPercent: number;
  /**
   * Transport-duplicate share: retransmits /
   * (accepted + physiological rejects + retransmits) * 100 in the window.
   * Diagnostic only; 0 if that denominator is empty.
   */
  retransmitPercent: number;
  /** suspectInWindow / acceptedInWindow * 100; 0 if no accepted. */
  suspectPercent: number;
  rejectedTotal: number;
  /** Lifetime retransmit dispositions since last reset (does not age with the window). */
  retransmitTotal: number;
  /** Sum of accepted RR durations currently in the window (ms). */
  physiologicalDurationMs: number;
  windowMs: number;
  /** Counts of non-accepted dispositions still in the rolling window. */
  rejectReasonsInWindow: Readonly<Record<string, number>>;
}

export interface RollingHrvOptions {
  windowMs?: number;
  rrMinMs?: number;
  rrMaxMs?: number;
  retransmitFraction?: number;
  suspectRelativeJump?: number;
  liveMinDurationMs?: number;
  stableMinDurationMs?: number;
  liveMinDiffs?: number;
  stableMinDiffs?: number;
  maxArtifactPercent?: number;
  maxSuspectPercent?: number;
  maxNeighborGapMs?: number;
  /** Injectable clock for tests (same domain for all timestamps). */
  now?: () => number;
}

function defaultNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export class RollingHrvAccumulator {
  private readonly windowMs: number;
  private readonly rrMinMs: number;
  private readonly rrMaxMs: number;
  private readonly retransmitFraction: number;
  private readonly suspectRelativeJump: number;
  private readonly liveMinDurationMs: number;
  private readonly stableMinDurationMs: number;
  private readonly liveMinDiffs: number;
  private readonly stableMinDiffs: number;
  private readonly maxArtifactPercent: number;
  private readonly maxSuspectPercent: number;
  private readonly maxNeighborGapMs: number;
  private readonly now: () => number;

  private accepted: HrvAcceptedSample[] = [];
  private rejected: HrvRejectedSample[] = [];
  private continuityBreaks: { endedAtMs: number; reason: string }[] = [];
  private lastAccepted: HrvAcceptedSample | null = null;
  private rejectedTotal = 0;
  private retransmitTotal = 0;
  private latestRrMs: number | null = null;

  constructor(options: RollingHrvOptions = {}) {
    this.windowMs = options.windowMs ?? HRV_DEFAULT_WINDOW_MS;
    this.rrMinMs = options.rrMinMs ?? HRV_RR_MIN_MS;
    this.rrMaxMs = options.rrMaxMs ?? HRV_RR_MAX_MS;
    this.retransmitFraction = options.retransmitFraction ?? HRV_RETRANSMIT_FRACTION;
    this.suspectRelativeJump = options.suspectRelativeJump ?? HRV_SUSPECT_RELATIVE_JUMP;
    this.liveMinDurationMs = options.liveMinDurationMs ?? HRV_LIVE_MIN_DURATION_MS;
    this.stableMinDurationMs = options.stableMinDurationMs ?? HRV_STABLE_MIN_DURATION_MS;
    this.liveMinDiffs = options.liveMinDiffs ?? HRV_LIVE_MIN_DIFFS;
    this.stableMinDiffs = options.stableMinDiffs ?? HRV_STABLE_MIN_DIFFS;
    this.maxArtifactPercent = options.maxArtifactPercent ?? HRV_MAX_ARTIFACT_PERCENT;
    this.maxSuspectPercent = options.maxSuspectPercent ?? HRV_MAX_SUSPECT_PERCENT;
    this.maxNeighborGapMs = options.maxNeighborGapMs ?? HRV_MAX_NEIGHBOR_GAP_MS;
    this.now = options.now ?? defaultNowMs;
  }

  reset(): void {
    this.accepted = [];
    this.rejected = [];
    this.continuityBreaks = [];
    this.lastAccepted = null;
    this.rejectedTotal = 0;
    this.retransmitTotal = 0;
    this.latestRrMs = null;
  }

  /**
   * Ingest one RR using `endedAtMs` as the physiological end of the interval.
   * Prefer {@link pushRrPacket} when multiple RRs arrive in one BLE notification.
   */
  pushRr(rrMs: number, endedAtMs?: number): HrvPushResult {
    const t = endedAtMs ?? this.now();
    return this.ingestOne(rrMs, t);
  }

  /**
   * Ingest RR intervals from one Heart Rate Measurement notification.
   * Intervals are chronological; the last ends at `packetArrivedAtMs`.
   */
  pushRrPacket(rrIntervalsMs: readonly number[], packetArrivedAtMs?: number): HrvPushResult[] {
    if (rrIntervalsMs.length === 0) return [];
    const packetTime = packetArrivedAtMs ?? this.now();
    const endTimes = new Array<number>(rrIntervalsMs.length);
    let cursor = packetTime;
    for (let i = rrIntervalsMs.length - 1; i >= 0; i--) {
      endTimes[i] = cursor;
      cursor -= rrIntervalsMs[i];
    }
    const results: HrvPushResult[] = [];
    for (let i = 0; i < rrIntervalsMs.length; i++) {
      results.push(this.ingestOne(rrIntervalsMs[i], endTimes[i]));
    }
    return results;
  }

  /**
   * Mark a hole in the NN sequence without ingesting or rejecting an RR value.
   * Clears the neighbor used for suspect/retransmit/RMSSD pairing.
   * Does not increment rejectedTotal / rejectedInWindow.
   */
  markContinuityBreak(reason = "unspecified", atMs?: number): void {
    const t = atMs ?? this.now();
    this.lastAccepted = null;
    this.continuityBreaks.push({ endedAtMs: t, reason });
    this.prune(Math.max(t, this.now()));
  }

  getSnapshot(): HrvSnapshot {
    this.prune(this.now());
    const acceptedInWindow = this.accepted.length;
    const rejectedInWindow = this.rejected.length;
    const retransmitInWindow = this.rejected.filter((s) => s.reason === "retransmit").length;
    const physiologicalRejectedInWindow = this.rejected.filter((s) =>
      isPhysiologicalRejectReason(s.reason)
    ).length;
    const suspectInWindow = this.accepted.filter((s) => s.suspect).length;
    const physiologicalDurationMs = this.accepted.reduce((sum, s) => sum + s.rrMs, 0);
    const artifactDenom = acceptedInWindow + physiologicalRejectedInWindow;
    const artifactPercent =
      artifactDenom === 0 ? 0 : (physiologicalRejectedInWindow / artifactDenom) * 100;
    const retransmitDenom = acceptedInWindow + physiologicalRejectedInWindow + retransmitInWindow;
    const retransmitPercent =
      retransmitDenom === 0 ? 0 : (retransmitInWindow / retransmitDenom) * 100;
    const suspectPercent = acceptedInWindow === 0 ? 0 : (suspectInWindow / acceptedInWindow) * 100;
    const { rmssdMs, nnDiffCount } = this.computeRmssd();
    const continuityBreaksInWindow = this.continuityBreaks.length;
    const continuityBreakReasonsInWindow: Record<string, number> = {};
    for (const br of this.continuityBreaks) {
      continuityBreakReasonsInWindow[br.reason] = (continuityBreakReasonsInWindow[br.reason] || 0) + 1;
    }

    let readiness: HrvReadiness = "collecting";
    if (
      physiologicalDurationMs >= this.stableMinDurationMs &&
      nnDiffCount >= this.stableMinDiffs &&
      rmssdMs !== null
    ) {
      readiness = "stable";
    } else if (
      physiologicalDurationMs >= this.liveMinDurationMs &&
      nnDiffCount >= this.liveMinDiffs &&
      rmssdMs !== null
    ) {
      readiness = "live";
    }

    const qualityOk =
      artifactPercent <= this.maxArtifactPercent && suspectPercent <= this.maxSuspectPercent;

    const rejectReasonsInWindow: Record<string, number> = {};
    for (const sample of this.rejected) {
      rejectReasonsInWindow[sample.reason] = (rejectReasonsInWindow[sample.reason] || 0) + 1;
    }

    return {
      latestRrMs: this.latestRrMs,
      rmssdMs: readiness === "collecting" ? null : rmssdMs,
      readiness,
      ready: readiness !== "collecting",
      reliable: readiness !== "collecting" && qualityOk,
      acceptedInWindow,
      rejectedInWindow,
      retransmitInWindow,
      suspectInWindow,
      nnDiffCount,
      continuityBreaksInWindow,
      continuityBreakReasonsInWindow,
      artifactPercent,
      retransmitPercent,
      suspectPercent,
      rejectedTotal: this.rejectedTotal,
      retransmitTotal: this.retransmitTotal,
      physiologicalDurationMs,
      windowMs: this.windowMs,
      rejectReasonsInWindow,
    };
  }

  private ingestOne(rrMs: number, endedAtMs: number): HrvPushResult {
    this.prune(Math.max(endedAtMs, this.now()));
    this.expireStaleNeighbor(endedAtMs);

    if (!Number.isFinite(rrMs) || rrMs <= 0) {
      return this.recordReject(rrMs, endedAtMs, "invalid");
    }
    if (rrMs < this.rrMinMs || rrMs > this.rrMaxMs) {
      return this.recordReject(rrMs, endedAtMs, "out_of_range");
    }

    const prev = this.lastAccepted;
    if (prev) {
      const dt = endedAtMs - prev.endedAtMs;
      const nearlySame = Math.abs(rrMs - prev.rrMs) < 0.5;
      if (nearlySame && dt >= 0 && dt < prev.rrMs * this.retransmitFraction) {
        return this.recordReject(rrMs, endedAtMs, "retransmit");
      }
    }

    let suspect = false;
    const continuesFromPrevious = prev !== null;
    if (prev) {
      const rel = Math.abs(rrMs - prev.rrMs) / prev.rrMs;
      if (rel > this.suspectRelativeJump) suspect = true;
    }

    const sample: HrvAcceptedSample = { rrMs, endedAtMs, suspect, continuesFromPrevious };
    this.accepted.push(sample);
    this.lastAccepted = sample;
    this.latestRrMs = rrMs;
    this.prune(Math.max(endedAtMs, this.now()));
    return {
      accepted: true,
      reason: suspect ? "accepted_suspect" : "accepted",
      endedAtMs,
    };
  }

  private expireStaleNeighbor(endedAtMs: number): void {
    const prev = this.lastAccepted;
    if (!prev) return;
    if (endedAtMs - prev.endedAtMs > this.maxNeighborGapMs) {
      this.markContinuityBreak("stale_neighbor", prev.endedAtMs);
    }
  }

  private recordReject(
    rrMs: number,
    endedAtMs: number,
    reason: Exclude<HrvDispositionReason, "accepted" | "accepted_suspect">
  ): HrvPushResult {
    this.rejectedTotal += 1;
    if (reason === "retransmit") this.retransmitTotal += 1;
    this.rejected.push({ rrMs, endedAtMs, reason });
    if (reason === "invalid" || reason === "out_of_range") {
      this.markContinuityBreak(reason, endedAtMs);
    } else {
      this.prune(Math.max(endedAtMs, this.now()));
    }
    return { accepted: false, reason, endedAtMs };
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.accepted.length > 0 && this.accepted[0].endedAtMs < cutoff) {
      this.accepted.shift();
    }
    while (this.rejected.length > 0 && this.rejected[0].endedAtMs < cutoff) {
      this.rejected.shift();
    }
    while (this.continuityBreaks.length > 0 && this.continuityBreaks[0].endedAtMs < cutoff) {
      this.continuityBreaks.shift();
    }
    if (this.lastAccepted && this.lastAccepted.endedAtMs < cutoff) {
      this.lastAccepted = null;
    }
  }

  private computeRmssd(): { rmssdMs: number | null; nnDiffCount: number } {
    let sumSq = 0;
    let nnDiffCount = 0;
    for (let i = 1; i < this.accepted.length; i++) {
      const curr = this.accepted[i];
      if (!curr.continuesFromPrevious) continue;
      const prev = this.accepted[i - 1];
      const d = curr.rrMs - prev.rrMs;
      sumSq += d * d;
      nnDiffCount += 1;
    }
    if (nnDiffCount === 0) return { rmssdMs: null, nnDiffCount: 0 };
    return { rmssdMs: Math.sqrt(sumSq / nnDiffCount), nnDiffCount };
  }
}
