/**
 * E4A scientific assessment — pure, versioned, no authority.
 *
 * E4A evaluates hardened E1/E2 threshold (and future aerobic-base) transfer
 * evidence and derives a per-subject scientific state with explicit reason
 * codes and named gate results. It is the first E4 slice:
 *
 * ```text
 * E3 evidence
 *     ↓
 * E4A policy
 *     ↓
 * scientific state + reasons + gates
 * ```
 *
 * E4A scientific assessment ≠ product authorization ≠ runtime authority.
 * E4B (explicit product + athlete authorization) and E4C (session-start
 * runtime compatibility) do not exist. This module has no knowledge of any
 * authorization record.
 *
 * Purity contract: the core evaluator is deterministic, reads no storage,
 * samples no clock (caller-supplied ISO strings are parsed, never read from
 * a live time source), reads no global profile, touches no machine runtime,
 * imports no control code, mutates no FitnessState, and never recomputes
 * E1/E2 values. `evaluatedAt` is supplied by the caller. E4A output is
 * derived and runtime-only: no
 * store, no workout-summary field, no FitnessState field, no export field.
 *
 * Controller-circularity caveat:
 *
 * ```text
 * E1 candidate: calibration inverse at the legacy HR region.
 * E2/E3 observed settled watts: measured while the legacy HR controller was
 * actively seeking that same HR region.
 * ```
 *
 * Current candidate-vs-observed agreement is therefore transfer evidence,
 * not independent proof of prescription quality. In particular the assessor
 * never treats HR-in-band occupancy, inside-candidate agreement, or perfect
 * closed-loop error as success: without truly independent open-loop evidence
 * and trustworthy actuation-mode evidence, `eligible` is unreachable under the
 * production policy. E2 v3 held-workload forward-response evidence (forward HR
 * prediction error at held observed resistance) removes HR-band conditioning
 * but not controller selection of the held resistance, so it is surfaced
 * descriptively in the digest and never satisfies the open-loop gate.
 *
 * Modality semantics: the current E1 threshold candidate is athlete-relative
 * workload associated with the prescribed legacy threshold HR region. It is
 * not a personal physiological threshold (no FTP / lactate / ventilatory
 * threshold evidence exists). The subject modality is named accordingly:
 * `legacy_hr_region_workload`.
 *
 * E3/E4A layering:
 *
 * ```text
 * E3 longitudinal evidence = read-only analysis
 * E4A                      = scientific policy assessment over comparable evidence
 * ```
 *
 * E4A does not import E3 or any other module: its implementation lives in
 * src/personalization/scientific/, which imports nothing outside itself, and
 * this file is only its public facade. The only permitted consumer is the
 * read-only developer diagnostics projection, which imports E4A (never the
 * reverse). E4A therefore independently verifies identity at its own trust
 * boundary instead of trusting upstream grouping. The E4A evidence builder
 * applies the full cohort key over frozen E2 fields:
 * athlete × evidence session IDs × estimator id/version × protocol id/version
 * × formal observedAt × calibration workload provenance × observed-power
 * provenance × machine ID × machine profile version × legacy HR band.
 * Sessions with incomplete identity are excluded with counts (fail closed);
 * they are never pooled into an "unavailable" cohort. Sessions carrying more
 * than one characterized threshold/aerobic-base phase for the subject
 * intensity are excluded rather than silently reduced to one phase.
 */
export { E4A_CURRENT_SCIENTIFIC_ASSESSMENT_POLICY, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1, E4A_SCIENTIFIC_ASSESSMENT_POLICY_V2, SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1, SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1, SCIENTIFIC_ASSESSMENT_POLICY_ID_V1, SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V1, SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V2, SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1, SCIENTIFIC_ASSESSMENT_STATES, SCIENTIFIC_MACHINE_COMPARABILITY_REASONS_V2, SCIENTIFIC_TIMED_ACTUATION_JOINS_V2, } from "./personalization/scientific/policy.js";
export { assessPersonalizedWorkloadEvidence } from "./personalization/scientific/assessment.js";
export { buildSubjectEvidence } from "./personalization/scientific/evidence.js";
export { discoverDiagnosticSubjects } from "./personalization/scientific/cohort.js";
export { scientificSubjectKey } from "./personalization/scientific/report.js";
