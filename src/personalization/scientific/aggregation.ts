/**
 * E4A aggregation: pure descriptive statistics over admitted cohorts
 * (medians, coefficient of variation, calendar spread, saturation incidence,
 * held-response and window-level context totals). No gate decisions here.
 */

import { isFiniteNumber, isNonEmptyString, isRecord, utcDateKey } from "./guards.js";
import { HELD_CONTEXTS, heldWorkloadForwardSessionValid } from "./qualification.js";
import type {
  ScientificAssessmentHeldWorkloadForwardSession,
  ScientificAssessmentProvenanceDigestV2,
  ScientificAssessmentSessionEvidence,
  ScientificHeldSessionEvidenceV2,
} from "./model.js";

export function sortedMedian(values: readonly number[]): number | null {
  const finite = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0
    ? (finite[middle - 1] + finite[middle]) / 2
    : finite[middle];
}

export function coefficientOfVariation(values: readonly number[]): number | null {
  const finite = values.filter(isFiniteNumber);
  if (finite.length < 2) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  if (mean === 0) return null;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

/** One entry per workout; malformed or duplicated entries are dropped (fail closed). */
export function heldWorkloadForwardDigest(
  entries: readonly ScientificAssessmentHeldWorkloadForwardSession[] | undefined,
  comparable: boolean
): { count: number; signed: number | null; absolute: number | null } {
  if (!comparable || !Array.isArray(entries)) return { count: 0, signed: null, absolute: null };
  const ids = new Map<string, number>();
  for (const entry of entries) {
    if (isRecord(entry) && isNonEmptyString(entry.workoutSessionId)) {
      ids.set(entry.workoutSessionId, (ids.get(entry.workoutSessionId) ?? 0) + 1);
    }
  }
  const valid = entries.filter((entry) =>
    heldWorkloadForwardSessionValid(entry) && ids.get(entry.workoutSessionId) === 1);
  const signed = sortedMedian(valid.map((entry) => entry.medianSignedErrorBpm));
  const absolute = sortedMedian(valid.map((entry) => entry.medianAbsoluteErrorBpm));
  return {
    count: valid.length,
    signed: signed === null ? null : Math.round(signed * 10) / 10,
    absolute: absolute === null ? null : Math.round(absolute * 10) / 10,
  };
}

export function emptyHeldContextDigest(): ScientificAssessmentProvenanceDigestV2["heldContexts"] {
  return {
    automatic_selected: { sessions: 0, windows: 0, durationSec: 0 },
    programmatic_selected: { sessions: 0, windows: 0, durationSec: 0 },
    no_app_selector_observed: { sessions: 0, windows: 0, durationSec: 0 },
    unknown: { sessions: 0, windows: 0, durationSec: 0 },
  };
}

/** Descriptive statistics over the admitted transfer cohort (canonical session order). */
export function summarizeTransferSessions(
  sessions: readonly ScientificAssessmentSessionEvidence[],
  evaluatedAt: string
): {
  distinctDateCount: number;
  calendarSpanDays: number | null;
  interiorCount: number;
  saturationIncidence: number | null;
  medianSigned: number | null;
  medianAbsolute: number | null;
  medianWidth: number | null;
  settledCv: number | null;
  newestAgeDays: number | null;
} {
  const dateKeys = new Map<string, number>();
  for (const session of sessions) {
    const key = utcDateKey(session.createdAt);
    if (key !== null) dateKeys.set(key, (dateKeys.get(key) ?? 0) + 1);
  }
  const distinctDateCount = dateKeys.size;
  const orderedTimes = sessions
    .map((session) => Date.parse(session.createdAt))
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);
  const calendarSpanDays = orderedTimes.length === 0
    ? null
    : (orderedTimes[orderedTimes.length - 1] - orderedTimes[0]) / (24 * 60 * 60 * 1000);
  const interiorCount = sessions.filter((session) => session.domainBucket === "interior").length;
  const saturatedCount = sessions.filter((session) => session.saturationRatio > 0).length;
  const saturationIncidence = sessions.length === 0 ? null : saturatedCount / sessions.length;
  const signedValues = sessions.map((session) => session.signedDifferenceWatts);
  const absoluteValues = sessions.map((session) => session.absoluteDifferenceWatts);
  const widthValues = sessions.map((session) => session.candidateWidthWatts);
  const medianSigned = sortedMedian(signedValues);
  const medianAbsolute = sortedMedian(absoluteValues);
  const medianWidth = sortedMedian(widthValues);
  const settledCv = coefficientOfVariation(sessions.map((session) => session.observedSettledWatts));
  // Pure timestamp arithmetic only, parsed from caller-supplied ISO strings.
  // The evaluator never samples the clock; timestamps arrive as arguments.
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const newestAgeDays = orderedTimes.length === 0 || !Number.isFinite(evaluatedAtMs)
    ? null
    : (evaluatedAtMs - orderedTimes[orderedTimes.length - 1]) / (24 * 60 * 60 * 1000);
  return {
    distinctDateCount,
    calendarSpanDays,
    interiorCount,
    saturationIncidence,
    medianSigned,
    medianAbsolute,
    medianWidth,
    settledCv,
    newestAgeDays,
  };
}

/** Policy v2 held-response channel: held/joined sessions and window-level context totals. */
export function summarizeHeldSessions(sessions: readonly ScientificHeldSessionEvidenceV2[]) {
  const held = sessions.filter((session) => session.provenanceV2?.heldWorkload?.available === true);
  const joined = held.filter((session) =>
    session.provenanceV2!.heldWorkload!.timedJoin === "available" && session.provenanceV2!.heldWorkload!.contexts !== null);
  const contexts = emptyHeldContextDigest();
  for (const session of joined) {
    const totals = session.provenanceV2!.heldWorkload!.contexts!;
    for (const context of HELD_CONTEXTS) {
      if (totals[context].windowCount > 0) contexts[context].sessions += 1;
      contexts[context].windows += totals[context].windowCount;
      contexts[context].durationSec += totals[context].durationSec;
    }
  }
  const digest = {
    sessionsWithHeldWorkloadEvidence: held.length,
    sessionsWithTimedActuationJoin: joined.length,
    heldContexts: contexts,
    independentOpenLoopEvidence: "unavailable" as const,
  };
  return { held, joined, contexts, digest };
}
