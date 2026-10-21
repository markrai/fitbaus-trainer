/**
 * Developer diagnostics HTML rendering from the projected view model.
 * Presentation only: it reads model data and formats it, never persistence,
 * science, or control.
 */
import { scientificSubjectKey, } from "../../personalizationScientificAssessment.js";
import { LEGACY_HR_TARGET_RESOLVER_ID, LEGACY_HR_TARGET_RESOLVER_VERSION, } from "../../types.js";
import { PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS, } from "./model.js";
import { calibrationWorkoutMachineComparison, heldWorkloadResponseOf } from "./projection.js";
import { ACTUATION_MODE_LABELS, HELD_CONTEXT_LABELS, formatBoundHeartRate, formatOptionalNumber, formatOptionalPercent, formatOptionalRpm, formatOptionalWatts, formatRatio, formatSigned, formatWattsBand, machineLabel, percent, personalizationDiagnosticLabel } from "./formatting.js";
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
        var _a;
        return (_a = ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        })[character]) !== null && _a !== void 0 ? _a : character;
    });
}
function metric(value, count, suffix) {
    return `<strong>${value === undefined ? "n/a" : `${Math.round(value * 10) / 10}${suffix}`}</strong><span>n = ${count} phases</span>`;
}
function optionMarkup(values, selected) {
    return [`<option value="all"${selected === "all" ? " selected" : ""}>All</option>`, ...values.map((value) => `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(personalizationDiagnosticLabel(value))}</option>`)].join("");
}
function thresholdLongitudinalHtml(analysis) {
    const note = `<p class="developer-diagnostics-note">Signed error is transfer error under legacy heart-rate control. The live controller searches for the prescribed HR band, so settled watts near the candidate can reflect that search rather than independent prescription quality. This series does not use inside-candidate rate as a success score, and it does not authorize control.</p>`;
    const exclusions = analysis.exclusions.length === 0 ? "" : `<div class="personalization-table-scroll" tabindex="0"><table class="personalization-table"><thead><tr><th>Excluded session</th><th>Date</th><th>Longitudinal reason</th></tr></thead><tbody>${analysis.exclusions.map((exclusion) => `<tr><td>${escapeHtml(exclusion.workoutSessionId)}</td><td>${escapeHtml(new Date(exclusion.createdAt).toLocaleDateString())}</td><td>${escapeHtml(personalizationDiagnosticLabel(exclusion.reason))}</td></tr>`).join("")}</tbody></table></div><p class="developer-diagnostics-note">Excluded sessions remain available in phase-level E2 diagnostics; incomplete identities are never pooled.</p>`;
    if (analysis.sessionCount === 0) {
        return `<section class="personalization-longitudinal" id="personalizationThresholdLongitudinal"><h4>Threshold transfer series</h4>${note}<div class="personalization-diagnostics-empty"><strong>No comparable bike threshold work sessions yet.</strong><span>A session requires exactly one characterized threshold phase plus complete frozen calibration and machine identity.</span></div>${exclusions}</section>`;
    }
    const cohorts = analysis.cohorts.map((cohort) => {
        const domains = [...new Set(cohort.sessions.map((session) => session.domainBucket))];
        const rows = cohort.sessions.map((session) => `<tr>
      <td>${escapeHtml(new Date(session.createdAt).toLocaleDateString())}</td>
      <td>${escapeHtml(session.workoutSessionId)}</td>
      <td>${session.assessmentAgeDays === null ? "n/a" : `${session.assessmentAgeDays} d`}</td>
      <td>${escapeHtml(`${session.machineId} @ profile ${session.machineProfileVersion}`)}</td>
      <td>${escapeHtml(personalizationDiagnosticLabel(session.domainBucket))}</td>
      <td>${formatOptionalNumber(session.candidateWidthWatts)} W</td>
      <td>${formatOptionalNumber(session.candidateMidpointWatts)} W</td>
      <td>${formatOptionalNumber(session.observedSettledWatts)} W</td>
      <td>${formatSigned(session.signedDifferenceWatts, " W")}</td>
      <td>${formatOptionalNumber(session.absoluteDifferenceWatts)} W</td>
      <td>${formatRatio(session.widthNormalizedAbsoluteError)}</td>
      <td>${percent(session.saturationRatio)}</td>
    </tr>`).join("");
        return `<article class="personalization-cohort">
      <h4>Calibration ${escapeHtml(cohort.key.calibration.evidenceSessionIds.join(", "))}</h4>
      <div class="personalization-cohort-tags"><span>${escapeHtml(`${cohort.key.calibration.estimator.id}@${cohort.key.calibration.estimator.version}`)} estimator</span><span>${escapeHtml(`${cohort.key.calibration.protocol.id}@${cohort.key.calibration.protocol.version}`)} protocol</span><span>${escapeHtml(personalizationDiagnosticLabel(cohort.key.calibration.workloadProvenance))} calibration</span><span>${escapeHtml(personalizationDiagnosticLabel(cohort.key.observedPowerProvenance))} observed</span><span>${escapeHtml(`${cohort.key.machineId} @ profile ${cohort.key.machineProfileVersion}`)}</span>${domains.map((bucket) => `<span>${escapeHtml(personalizationDiagnosticLabel(bucket))} domain</span>`).join("")}</div>
      <div class="personalization-metric-grid">
        <div><label>Sessions</label><strong>${cohort.sessionCount}</strong><span>unique bike threshold workouts</span></div>
        <div><label>Median signed error</label><strong>${formatSigned(cohort.medianSignedDifferenceWatts, " W")}</strong><span>candidate midpoint vs settled watts</span></div>
        <div><label>Median absolute error</label><strong>${cohort.medianAbsoluteDifferenceWatts === undefined ? "n/a" : `${formatOptionalNumber(cohort.medianAbsoluteDifferenceWatts)} W`}</strong><span>n = ${cohort.sessionCount} sessions</span></div>
        <div><label>Median candidate width</label><strong>${cohort.medianCandidateWidthWatts === undefined ? "n/a" : `${formatOptionalNumber(cohort.medianCandidateWidthWatts)} W`}</strong><span>max − min candidate watts</span></div>
        <div><label>Median width-normalized error</label><strong>${formatRatio(cohort.medianWidthNormalizedAbsoluteError)}</strong><span>absolute error / candidate width</span></div>
        <div><label>Observed settled watts CV</label><strong>${cohort.observedSettledWattsCv === undefined ? "n/a" : percent(cohort.observedSettledWattsCv)}</strong><span>descriptive population variability</span></div>
        <div><label>Sessions with any boundary saturation</label><strong>${cohort.saturationIncidence === undefined ? "n/a" : percent(cohort.saturationIncidence)}</strong><span>saturationRatio &gt; 0</span></div>
        <div><label>Median assessment age</label><strong>${cohort.medianAssessmentAgeDays === undefined ? "n/a" : `${Math.round(cohort.medianAssessmentAgeDays)} d`}</strong><span>workout createdAt − frozen E1 observedAt</span></div>
      </div>
      <div class="personalization-table-scroll" tabindex="0"><table class="personalization-table"><thead><tr><th>Date</th><th>Session</th><th>Assessment age</th><th>Machine</th><th>Domain</th><th>Candidate width</th><th>Candidate midpoint</th><th>Settled watts</th><th>Signed error</th><th>Abs error</th><th>Width-norm error</th><th>Saturation</th></tr></thead><tbody>${rows}</tbody></table></div>
    </article>`;
    }).join("");
    return `<section class="personalization-longitudinal" id="personalizationThresholdLongitudinal"><h4>Threshold transfer series</h4>${note}<div class="personalization-count-grid"><div><strong>${analysis.sessionCount}</strong><span>Comparable bike threshold sessions</span></div><div><strong>${analysis.cohorts.length}</strong><span>Calibration × provenance × machine cohorts</span></div></div><div class="personalization-cohorts">${cohorts}</div>${exclusions}</section>`;
}
const HELD_WORKLOAD_NOTE = `<p class="developer-diagnostics-note">Held-workload forward-response evidence: observed watts while observed resistance stays unchanged, after a settling interval, are mapped through the frozen formal calibration to a predicted heart rate (signed error = observed HR − predicted HR). It is not filtered by legacy heart-rate target occupancy. The live controller may have chosen the held resistance, so this is not independent open-loop evidence, and it does not authorize control.</p>`;
function executionProvenanceHtml(summary) {
    const note = `<p class="developer-diagnostics-note">Machine provenance is frozen at workout start; calibration machine provenance is copied at start from an exact formal-calibration record. Actuation provenance lists captured app resistance commands with their recorded origin; console resistance changes are not observable. Descriptive only: it does not change any assessment.</p>`;
    return `<section class="personalization-longitudinal" id="personalizationExecutionProvenance"><h4>Machine and actuation provenance</h4>${note}<div class="personalization-count-grid">
      <div><strong>${summary.workoutsWithProvenance} / ${summary.workoutsWithE2}</strong><span>Workouts with execution provenance</span></div>
      <div><strong>${summary.frozenMachineSelected}</strong><span>Frozen workout machine recorded</span></div>
      <div><strong>${summary.selectionChangedDuringWorkout}</strong><span>Machine selection changed mid-workout</span></div>
      <div><strong>${summary.calibrationMachineAvailable} / ${summary.calibrationMachineUnavailable} / ${summary.calibrationMachineIntegrityFailures}</strong><span>Calibration machine available / unavailable / conflicting</span></div>
      <div><strong>${summary.sameMachineAndProfile} / ${summary.differentMachine} / ${summary.sameMachineDifferentProfile}</strong><span>Calibration vs workout: same / other machine / other profile</span></div>
      <div><strong>${summary.incompleteActuationCapture}</strong><span>Incomplete actuation capture</span></div>
    </div></section>`;
}
function provenanceDetailHtml(provenance, phase) {
    var _a;
    if (!provenance) {
        return `<section><h5>Machine provenance</h5><dl>${detailRow("Availability", "not recorded (historical workout)")}${detailRow("Actuation provenance", "unknown")}</dl></section>`;
    }
    const machine = provenance.machine;
    const calibration = provenance.calibrationMachine;
    const phaseSummary = (_a = provenance.actuation.phases) === null || _a === void 0 ? void 0 : _a.find((item) => item.phaseId === phase.phaseId && item.intervalIndex === phase.intervalIndex &&
        (phase.activeStartSec === undefined || item.activeStartSec === phase.activeStartSec));
    const events = phaseSummary
        ? provenance.actuation.events.filter((event) => event.activeSec >= phaseSummary.activeStartSec && event.activeSec < phaseSummary.activeEndSec)
        : [];
    const eventRows = events.map((event) => `<tr><td>${event.activeSec} s</td><td>${escapeHtml(personalizationDiagnosticLabel(event.origin))}</td><td>${escapeHtml(personalizationDiagnosticLabel(event.trigger))}</td><td>R${event.requestedResistance}</td><td>${escapeHtml(event.outcome)}</td></tr>`).join("");
    return `<section><h5>Machine provenance</h5><dl>${detailRow("Frozen workout machine", machine.status === "selected" ? machineLabel(machine) : "none selected at start")}${detailRow("Selection changed mid-workout", machine.selectionChangedDuringWorkout ? "yes" : "no")}${detailRow("Calibration machine", calibration.status === "available" ? machineLabel(calibration) : personalizationDiagnosticLabel(calibration.status))}${detailRow("Calibration vs workout", personalizationDiagnosticLabel(calibrationWorkoutMachineComparison(provenance)))}</dl></section>
    <section><h5>Actuation provenance</h5><dl>${detailRow("Capture", `${personalizationDiagnosticLabel(provenance.actuation.coverage)} app resistance commands; console changes not observable`)}${detailRow("Phase actuation mode", phaseSummary ? ACTUATION_MODE_LABELS[phaseSummary.mode] : "unavailable")}${detailRow("Captured automatic / programmatic resistance events", phaseSummary ? `${phaseSummary.automaticAcceptedCount} / ${phaseSummary.programmaticAcceptedCount}` : "n/a")}${detailRow("Rejected / ambiguous commands", phaseSummary ? `${phaseSummary.rejectedCount} / ${phaseSummary.ambiguousCount}` : "n/a")}${detailRow("Distinct decisions", phaseSummary === null || phaseSummary === void 0 ? void 0 : phaseSummary.decisionCount)}</dl>${eventRows ? `<div class="personalization-table-scroll" tabindex="0"><table class="personalization-table"><thead><tr><th>Active time</th><th>Origin</th><th>Trigger</th><th>Requested</th><th>Outcome</th></tr></thead><tbody>${eventRows}</tbody></table></div>` : ""}</section>`;
}
function heldActuationContextHtml(rows) {
    const note = `<p class="developer-diagnostics-note">E4A v2 joins each qualifying held-workload window to the captured app resistance commands. "No app selector observed" does not establish manual or open-loop resistance because console changes are not observable. Independent open-loop evidence: unavailable.</p>`;
    if (rows.length === 0) {
        return `<section class="personalization-longitudinal" id="personalizationHeldActuationContext"><h4>Held-workload actuation context (E4A v2)</h4>${note}<div class="personalization-diagnostics-empty"><strong>No E4A v2 joins yet.</strong><span>Joins need E2 v3 held-workload evidence and execution provenance.</span></div></section>`;
    }
    const durations = (row) => row.contexts
        ? Object.keys(HELD_CONTEXT_LABELS).map((key) => `${row.contexts[key].durationSec} s`).join(" / ")
        : "unavailable";
    const body = rows.map((row) => `<tr><td>${escapeHtml(new Date(row.createdAt).toLocaleDateString())}</td><td>${escapeHtml(row.workoutSessionId)}</td><td>${escapeHtml(personalizationDiagnosticLabel(row.machineComparison.reason))}</td><td>${escapeHtml(personalizationDiagnosticLabel(row.timedJoin))}</td><td>${row.qualifyingWindowCount} / ${row.qualifyingDurationSec} s</td><td>${escapeHtml(durations(row))}</td><td>unavailable</td></tr>`).join("");
    return `<section class="personalization-longitudinal" id="personalizationHeldActuationContext"><h4>Held-workload actuation context (E4A v2)</h4>${note}<div class="personalization-table-scroll" tabindex="0"><table class="personalization-table"><thead><tr><th>Date</th><th>Session</th><th>Machine comparability</th><th>Timed join</th><th>Qualifying windows / duration</th><th>Duration by context (controller / programmatic / no captured app selector / unknown)</th><th>Independent open-loop evidence</th></tr></thead><tbody>${body}</tbody></table></div><p class="developer-diagnostics-note">Each workout is one longitudinal session; window counts and durations are descriptive.</p></section>`;
}
function heldWorkloadForwardHtml(summary) {
    if (summary.phasesWithHeldWorkloadSummary === 0) {
        return `<section class="personalization-longitudinal" id="personalizationHeldWorkloadForward"><h4>Held-workload forward-response evidence</h4>${HELD_WORKLOAD_NOTE}<div class="personalization-diagnostics-empty"><strong>No E2 v3 held-workload evidence yet.</strong><span>Workouts characterized before E2 v3 carry closed-loop transfer evidence only.</span></div></section>`;
    }
    return `<section class="personalization-longitudinal" id="personalizationHeldWorkloadForward"><h4>Held-workload forward-response evidence</h4>${HELD_WORKLOAD_NOTE}<div class="personalization-count-grid">
      <div><strong>${summary.recordsWithHeldWorkloadEvidence}</strong><span>Workouts with E2 v3 held-workload summaries</span></div>
      <div><strong>${summary.characterizedPhases} / ${summary.phasesWithHeldWorkloadSummary}</strong><span>Characterized / summarized phases</span></div>
      <div><strong>${summary.qualifyingWindowCount} / ${summary.stableWindowCount}</strong><span>Qualifying / stable observed-resistance windows</span></div>
      <div><strong>${summary.qualifyingDurationSec} s</strong><span>Post-settling qualifying duration</span></div>
      <div><strong>${formatSigned(summary.medianPhaseSignedErrorBpm, " bpm")}</strong><span>Median phase forward HR signed error</span></div>
      <div><strong>${summary.medianPhaseAbsoluteErrorBpm === undefined ? "n/a" : `${formatOptionalNumber(summary.medianPhaseAbsoluteErrorBpm)} bpm`}</strong><span>Median phase forward HR absolute error</span></div>
      <div><strong>${summary.measuredWattsCharacterizedPhases} / ${summary.calibratedWattsCharacterizedPhases}</strong><span>Measured / calibrated watts characterized phases</span></div>
      <div><strong>${summary.outsideCalibrationDomainSeconds} s</strong><span>Excluded outside calibration watt domain</span></div>
    </div></section>`;
}
function heldWorkloadDetailHtml(response) {
    var _a;
    if (!response) {
        return `<section><h5>Held-workload forward-response evidence</h5><dl>${detailRow("Availability", "not recorded (pre-E2 v3 record)")}</dl></section>`;
    }
    const stable = response.stableResistance;
    const forward = response.forwardHeartRate;
    const excluded = stable === null || stable === void 0 ? void 0 : stable.excludedPostSettlingSeconds;
    const signed = (value) => `${value > 0 ? "+" : ""}${formatOptionalNumber(value)}`;
    return `<section><h5>Held-workload forward-response evidence</h5><dl>${detailRow("Outcome", personalizationDiagnosticLabel(response.outcome))}${detailRow("Exclusion", personalizationDiagnosticLabel((_a = response.exclusionReason) !== null && _a !== void 0 ? _a : "none"))}${detailRow("Observed power", personalizationDiagnosticLabel(response.observedPowerProvenance))}${detailRow("Stable / qualifying windows", stable ? `${stable.stableWindowCount} / ${stable.qualifyingWindowCount}` : "n/a")}${detailRow("Stable / post-settling / qualifying duration", stable ? `${stable.stableDurationSec} / ${stable.postSettlingDurationSec} / ${stable.qualifyingDurationSec} sec` : "n/a")}${detailRow("Observed resistance changes", stable === null || stable === void 0 ? void 0 : stable.observedResistanceChangeCount)}${detailRow("Excluded: gap / no watts / outside domain / no HR", excluded ? `${excluded.observationGap} / ${excluded.wattsUnavailable} / ${excluded.outsideCalibrationDomain} / ${excluded.heartRateUnavailable} sec` : "n/a")}${detailRow("Observed / predicted HR median", forward ? `${formatOptionalNumber(forward.observedHeartRateMedianBpm)} / ${formatOptionalNumber(forward.predictedHeartRateMedianBpm)} bpm` : "n/a")}${detailRow("Forward HR signed error median / IQR", forward ? `${signed(forward.signedErrorBpm.median)} bpm / ${signed(forward.signedErrorBpm.q1)}–${signed(forward.signedErrorBpm.q3)} bpm` : "n/a")}${detailRow("Forward HR absolute error median / max", forward ? `${formatOptionalNumber(forward.absoluteErrorBpm.median)} / ${formatOptionalNumber(forward.absoluteErrorBpm.max)} bpm` : "n/a")}${detailRow("Cadence median / IQR", response.cadenceRpm ? `${formatOptionalNumber(response.cadenceRpm.median)} rpm / ${formatOptionalNumber(response.cadenceRpm.q1)}–${formatOptionalNumber(response.cadenceRpm.q3)} rpm` : "n/a")}</dl></section>`;
}
function scientificAssessmentsHtml(assessments) {
    const note = `<p class="developer-diagnostics-note">E4A scientific assessment over comparable frozen E1/E2 evidence. Scientific state is not product authorization and has no runtime authority. Under the production policy (v2), only exactly machine-comparable sessions are evidence and held-workload actuation context is reported from captured provenance; independent open-loop evidence is required but unavailable, so eligible is unreachable.</p>`;
    if (assessments.length === 0) {
        return `<section class="personalization-longitudinal" id="personalizationScientificAssessments"><h4>Scientific assessment (E4A)</h4>${note}<div class="personalization-diagnostics-empty"><strong>No assessable subjects yet.</strong><span>A subject needs a frozen E1 candidate with complete calibration and machine identity.</span></div></section>`;
    }
    const cards = assessments.map((assessment) => {
        const subject = assessment.subject;
        const digest = assessment.evidenceDigest;
        const gates = assessment.gates.map((gate) => { var _a; return `<tr><td>${escapeHtml(gate.id)}</td><td>${escapeHtml(gate.status)}</td><td>${escapeHtml((_a = gate.reasonCode) !== null && _a !== void 0 ? _a : "")}</td></tr>`; }).join("");
        return `<article class="personalization-cohort">
      <h4>${escapeHtml(scientificSubjectKey(subject))} · ${escapeHtml(personalizationDiagnosticLabel(assessment.state))}</h4>
      <dl>${detailRow("Scientific state", assessment.state)}${detailRow("Runtime authority", assessment.runtimeAuthority ? "yes" : "no")}${detailRow("Subject", `${subject.athleteId} · ${subject.activity} ${subject.phaseKind} · ${subject.intensityId} · ${subject.modality} · ${subject.legacyHrBand.minBpm}–${subject.legacyHrBand.maxBpm} bpm`)}${detailRow("Calibration", `${digest.calibrationInstanceId} · ${subject.calibration.estimatorId}@${subject.calibration.estimatorVersion} · ${subject.calibration.protocolId}@${subject.calibration.protocolVersion}`)}${detailRow("Assessor", `${assessment.assessor.id}@${assessment.assessor.version}`)}${detailRow("Policy", `${assessment.policy.id}@${assessment.policy.version}`)}${detailRow("Reason codes", assessment.reasonCodes.length === 0 ? "none" : assessment.reasonCodes.join(", "))}${detailRow("Sessions / distinct dates", `${digest.sessionCount} / ${digest.distinctDateCount}`)}${detailRow("Excluded (identity / multi-phase / invalid)", `${digest.excludedIncompleteIdentitySessions} / ${digest.excludedMultiPhaseSessions} / ${digest.ignoredInvalidSessions}`)}${detailRow("Machine / profile", `${subject.machineId} / v${subject.machineProfileVersion}`)}${detailRow("Power provenance (calibration / observed)", `${personalizationDiagnosticLabel(subject.calibration.workloadProvenance)} / ${personalizationDiagnosticLabel(subject.observedPowerProvenance)}`)}${digest.provenanceV2 ? `${detailRow("Machine-comparable closed-loop transfer sessions", `${digest.provenanceV2.transferComparableSessionCount} (excluded: ${Object.entries(digest.provenanceV2.excludedTransferMachineIncomparableSessions).map(([reason, count]) => `${personalizationDiagnosticLabel(reason)} ${count}`).join(", ") || "none"})`)}${detailRow("Machine-comparable held-response sessions", `${digest.provenanceV2.heldComparableSessionCount} (excluded: ${Object.entries(digest.provenanceV2.excludedHeldMachineIncomparableSessions).map(([reason, count]) => `${personalizationDiagnosticLabel(reason)} ${count}`).join(", ") || "none"})`)}${detailRow("Held evidence / timed join sessions", `${digest.provenanceV2.sessionsWithHeldWorkloadEvidence} / ${digest.provenanceV2.sessionsWithTimedActuationJoin}`)}${detailRow("Held duration by context (controller / programmatic / no captured app selector / unknown)", Object.values(digest.provenanceV2.heldContexts).map((item) => `${item.durationSec} s`).join(" / "))}${detailRow("Independent open-loop evidence", "unavailable")}` : ""}${detailRow("Held-workload forward sessions (descriptive, not open-loop)", `${digest.heldWorkloadForwardSessionCount} · signed ${digest.medianHeldWorkloadForwardSignedErrorBpm === null ? "n/a" : formatSigned(digest.medianHeldWorkloadForwardSignedErrorBpm, " bpm")} · absolute ${digest.medianHeldWorkloadForwardAbsoluteErrorBpm === null ? "n/a" : `${digest.medianHeldWorkloadForwardAbsoluteErrorBpm} bpm`}`)}</dl>
      <div class="personalization-table-scroll" tabindex="0"><table class="personalization-table"><thead><tr><th>Gate</th><th>Status</th><th>Reason</th></tr></thead><tbody>${gates}</tbody></table></div>
    </article>`;
    }).join("");
    return `<section class="personalization-longitudinal" id="personalizationScientificAssessments"><h4>Scientific assessment (E4A)</h4>${note}<div class="personalization-cohorts">${cards}</div></section>`;
}
/** Responsive developer presentation only; every number comes from E2 helpers or frozen fields. */
export function personalizationDiagnosticsHtml(model) {
    if (model.sourceRecordCount === 0) {
        return `<div class="personalization-diagnostics-empty"><strong>No personalization characterization data yet.</strong><span>Complete a qualifying bike threshold workout after a formal VO₂ assessment to begin collecting shadow workload validation data. Candidate watts do not control the workout.</span></div>`;
    }
    const aggregate = model.aggregate;
    const evidence = model.evidenceCollectionSummary;
    const filters = model.filters;
    const filterOptions = model.filterOptions;
    const filtersHtml = [
        ["personalizationIntentFilter", "Workout intent", "workoutIntent", filterOptions.workoutIntent],
        ["personalizationIntensityFilter", "Intensity", "intensity", filterOptions.intensity],
        ["personalizationCalibrationFilter", "Formal calibration", "calibrationProvenance", filterOptions.calibrationProvenance],
        ["personalizationObservedPowerFilter", "Observed power", "observedPowerProvenance", filterOptions.observedPowerProvenance],
        ["personalizationQualityFilter", "Assessment quality", "assessmentQuality", filterOptions.assessmentQuality],
        ["personalizationDomainFilter", "Assessment domain", "domainBucket", filterOptions.domainBucket],
    ].map(([id, label, key, values]) => `<label><span>${label}</span><select id="${id}" class="modal-input personalization-filter" onchange="applyPersonalizationDiagnosticsFilters()">${optionMarkup(values, filters[key])}</select></label>`).join("");
    const cohortHtml = aggregate.groups.map((group) => `<article class="personalization-cohort">
    <h4>${escapeHtml(personalizationDiagnosticLabel(group.workoutIntent))} · ${escapeHtml(personalizationDiagnosticLabel(group.intensityId))}</h4>
    <div class="personalization-cohort-tags"><span>${escapeHtml(personalizationDiagnosticLabel(group.calibrationWorkloadProvenance))}</span><span>${escapeHtml(personalizationDiagnosticLabel(group.observedPowerProvenance))} observed</span><span>${escapeHtml(group.formalAssessmentAlgorithm)}</span><span>${escapeHtml(group.formalAssessmentProtocol)}</span><span>${escapeHtml(personalizationDiagnosticLabel(group.formalAssessmentQuality))} quality</span><span>${escapeHtml(personalizationDiagnosticLabel(group.candidateDomainMarginBucket))} domain</span></div>
    <div class="personalization-metric-grid">
      <div><label>Median signed difference</label>${metric(group.signedDifferenceWatts.median, group.signedDifferenceWatts.count, " W")}</div>
      <div><label>Median absolute difference</label>${metric(group.absoluteDifferenceWatts.median, group.absoluteDifferenceWatts.count, " W")}</div>
      <div><label>Observed median inside candidate</label><strong>${group.observedMedianInsideCandidate.count} / ${group.observedMedianInsideCandidate.total}${group.observedMedianInsideCandidate.proportion === undefined ? "" : ` · ${percent(group.observedMedianInsideCandidate.proportion)}`}</strong><span>n = ${group.observedMedianInsideCandidate.total} phases</span></div>
      <div><label>Median HR coverage</label>${metric(group.hrCoverageRatio.median === undefined ? undefined : group.hrCoverageRatio.median * 100, group.hrCoverageRatio.count, "%")}</div>
      <div><label>Median power coverage</label>${metric(group.powerCoverageRatio.median === undefined ? undefined : group.powerCoverageRatio.median * 100, group.powerCoverageRatio.count, "%")}</div>
      <div><label>Median joint coverage</label>${metric(group.jointCoverageRatio.median === undefined ? undefined : group.jointCoverageRatio.median * 100, group.jointCoverageRatio.count, "%")}</div>
      <div><label>Controller saturation incidence</label><strong>${group.controllerSaturationIncidence.count} / ${group.controllerSaturationIncidence.total}${group.controllerSaturationIncidence.proportion === undefined ? "" : ` · ${percent(group.controllerSaturationIncidence.proportion)}`}</strong><span>n = ${group.controllerSaturationIncidence.total} candidate phases</span></div>
    </div>
  </article>`).join("");
    const exclusions = PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS.map((reason) => `<div><span>${escapeHtml(personalizationDiagnosticLabel(reason))}</span><strong>${model.exclusionCounts[reason]}</strong></div>`).join("");
    const allEvidenceExclusions = PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS.map((reason) => `<div><span>${escapeHtml(personalizationDiagnosticLabel(reason))}</span><strong>${evidence.exclusionCounts[reason]}</strong></div>`).join("");
    const rows = model.rows.map((row) => `<tr>
    <td>${escapeHtml(new Date(row.date).toLocaleDateString())}</td><td>${escapeHtml(row.workout)}</td><td>${escapeHtml(row.phase)}</td>
    <td>${escapeHtml(row.legacyHeartRate)}</td><td>${escapeHtml(row.candidateWatts)}</td><td>${row.observedInBandWatts === null ? "n/a" : `${Math.round(row.observedInBandWatts)} W`}</td><td>${row.deltaWatts === null ? "n/a" : `${row.deltaWatts > 0 ? "+" : ""}${Math.round(row.deltaWatts)} W`}</td>
    <td>${percent(row.hrCoveragePercent / 100)}</td><td>${percent(row.powerCoveragePercent / 100)}</td><td>${row.hrInsideTargetPercent === null ? "n/a" : percent(row.hrInsideTargetPercent / 100)}</td><td>${percent(row.saturationPercent / 100)}</td>
    <td>${escapeHtml(personalizationDiagnosticLabel(row.calibrationProvenance))}</td><td>${escapeHtml(personalizationDiagnosticLabel(row.observedPowerProvenance))}</td><td>${escapeHtml(personalizationDiagnosticLabel(row.outcome))}</td><td>${escapeHtml(personalizationDiagnosticLabel(row.exclusion))}</td>
    <td><button type="button" class="button secondary personalization-detail-button" onclick="openPersonalizationDiagnostic(${row.index})">Inspect</button></td>
  </tr>`).join("");
    return `<p class="developer-diagnostics-note">Active prescription is the legacy heart-rate band. Shadow athlete-relative prescription is candidate watts from formal VO₂ calibration. Bike work + threshold is the primary validated scope. These candidates have no live authority.</p>
    <section class="personalization-evidence-summary"><h4>All persisted E2 evidence</h4>
    <div class="personalization-count-grid">
      <div><strong>${evidence.completedWorkoutsWithE2}</strong><span>Completed workouts with E2</span></div>
      <div><strong>${evidence.candidatePhases}</strong><span>Candidate phases</span></div>
      <div><strong>${evidence.evaluableCandidatePhases}</strong><span>Evaluable candidate phases</span></div>
      <div><strong>${evidence.measuredToMeasuredObservations}</strong><span>Measured → measured observations</span></div>
      <div><strong>${evidence.cadenceCalibratedObservations}</strong><span>Any cadence-calibrated observations</span></div>
      <div><strong>${evidence.aerobicBaseCandidatePhases}</strong><span>Aerobic-base candidate phases</span></div>
      <div><strong>${evidence.aerobicVolumeCandidatePhases}</strong><span>Aerobic-volume candidate phases</span></div>
      <div><strong>${evidence.interiorCandidatePhases}</strong><span>Interior candidate phases</span></div>
      <div><strong>${evidence.edgeCandidatePhases}</strong><span>Edge candidate phases</span></div>
      <div><strong>${evidence.saturatedCandidatePhases} / ${evidence.saturationDeterminateCandidatePhases}${evidence.saturationIncidence === undefined ? "" : ` · ${percent(evidence.saturationIncidence)}`}</strong><span>Saturated / saturation-determinate candidates</span></div>
    </div>
    <div class="personalization-exclusions"><h4>Exclusions in all persisted evidence</h4>${allEvidenceExclusions}</div>
  </section>
    ${thresholdLongitudinalHtml(model.thresholdLongitudinal)}
    ${heldWorkloadForwardHtml(model.heldWorkloadForward)}
    ${executionProvenanceHtml(model.executionProvenance)}
    ${heldActuationContextHtml(model.heldActuationContext)}
    ${scientificAssessmentsHtml(model.scientificAssessments)}
    <div class="personalization-filter-grid">${filtersHtml}</div>
    <div class="personalization-count-grid"><div><strong>${aggregate.workoutCount}</strong><span>Completed workouts with E2 data</span></div><div><strong>${aggregate.candidatePhases}</strong><span>Candidate phases</span></div><div><strong>${aggregate.evaluableCandidatePhases}</strong><span>Evaluable candidate phases</span></div><div><strong>${aggregate.fallbackPhases}</strong><span>Fallback phases</span></div></div>
    ${aggregate.groups.length > 0 ? `<div class="personalization-cohorts">${cohortHtml}</div>` : `<div class="personalization-diagnostics-empty"><strong>No phases match these filters.</strong><span>Change a filter to inspect another cohort.</span></div>`}
    <div class="personalization-exclusions"><h4>Exclusions in visible cohort</h4>${exclusions}</div>
    <div class="personalization-table-scroll" tabindex="0"><table class="personalization-table"><thead><tr><th>Date</th><th>Workout</th><th>Phase</th><th>Legacy HR</th><th>Candidate watts</th><th>Observed in-band</th><th>Difference</th><th>HR coverage</th><th>Power coverage</th><th>HR in target</th><th>Saturation</th><th>Formal calibration</th><th>Observed power</th><th>Outcome</th><th>Exclusion</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div id="personalizationDiagnosticDetail" class="personalization-diagnostic-detail" hidden></div>`;
}
function detailRow(label, value) {
    return `<div><dt>${escapeHtml(label)}</dt><dd>${value === undefined ? "n/a" : escapeHtml(value)}</dd></div>`;
}
export function personalizationDiagnosticDetailHtml(row) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    const phase = row.phaseRecord;
    const record = row.record;
    const coverage = phase.evidenceCoverage;
    const heartRate = phase.observedHeartRate;
    const power = phase.observedPower;
    const stable = phase.stableInBandWorkload;
    const comparison = phase.comparison;
    const controller = phase.controllerContext;
    const assessment = row.assessmentContext;
    const workout = row.workoutContext;
    const performed = row.performedLoadPhase;
    const signed = (value, suffix) => value === undefined ? "n/a" : `${value > 0 ? "+" : ""}${Math.round(value * 10) / 10}${suffix}`;
    const shadowWorkload = phase.candidatePower
        ? formatWattsBand(phase.candidatePower)
        : phase.fallbackReason
            ? personalizationDiagnosticLabel(phase.fallbackReason)
            : "unavailable";
    const activeHeartRate = formatBoundHeartRate(phase.legacyHeartRate);
    return `<div class="personalization-detail-heading"><div><h4>${escapeHtml(row.workout)} · ${escapeHtml(row.phase)}</h4><span>${escapeHtml(new Date(row.date).toLocaleString())}</span></div><button type="button" class="button secondary" onclick="closePersonalizationDiagnostic()">Close</button></div>
    <section><h5>Active prescription</h5><dl>${detailRow("Heart rate", activeHeartRate)}${detailRow("Resolver", `${LEGACY_HR_TARGET_RESOLVER_ID}@${LEGACY_HR_TARGET_RESOLVER_VERSION}`)}${detailRow("Live authority", "yes")}</dl></section>
    <section><h5>Shadow athlete-relative prescription</h5><dl>${detailRow("Workload", shadowWorkload)}${detailRow("Source", "formal VO₂ calibration")}${detailRow("Mode", "shadow")}${detailRow("Live authority", "no")}${detailRow("Outcome", personalizationDiagnosticLabel(row.outcome))}</dl></section>
    <section><h5>Observed response</h5><dl>${detailRow("Planned / observed duration", `${coverage.plannedDurationSec} / ${coverage.observedDurationSec} sec`)}${detailRow("HR / power / joint coverage", `${percent(coverage.hrCoverageRatio)} / ${percent(coverage.powerCoverageRatio)} / ${percent(coverage.jointCoverageRatio)}`)}${detailRow("HR median / min / max", heartRate ? `${heartRate.medianBpm} / ${heartRate.minBpm} / ${heartRate.maxBpm} bpm` : "n/a")}${detailRow("HR seconds below / inside / above", heartRate ? `${heartRate.belowBandSeconds} / ${heartRate.insideBandSeconds} / ${heartRate.aboveBandSeconds}` : "n/a")}${detailRow("Power median / IQR / min / max", power ? `${power.medianWatts} / ${power.q1Watts}–${power.q3Watts} / ${power.minWatts}–${power.maxWatts} W` : "n/a")}${detailRow("Power seconds below / inside / above candidate", power ? `${power.belowCandidateSeconds} / ${power.insideCandidateSeconds} / ${power.aboveCandidateSeconds}` : "n/a")}${detailRow("Settled in-band samples", stable === null || stable === void 0 ? void 0 : stable.sampleCount)}${detailRow("Settled median / IQR", stable ? `${stable.medianWatts} W / ${stable.q1Watts}–${stable.q3Watts} W` : "n/a")}${detailRow("Late vs early HR", signed(heartRate === null || heartRate === void 0 ? void 0 : heartRate.heartRateChangeLateVsEarlyBpm, " bpm"))}${detailRow("Controller saturation", `${percent(controller.saturationRatio)} · lower ${controller.lowerBoundaryDecisionCount}, upper ${controller.upperBoundaryDecisionCount} decisions`)}${detailRow("Observed watts (response)", formatOptionalWatts(performed === null || performed === void 0 ? void 0 : performed.wattsMedian))}${detailRow("Observed resistance (response)", (performed === null || performed === void 0 ? void 0 : performed.observedResistanceMedian) === undefined ? "unavailable" : String(performed.observedResistanceMedian))}${detailRow("Cadence (response)", formatOptionalRpm(performed === null || performed === void 0 ? void 0 : performed.cadenceMedianRpm))}${detailRow("Bike-row coverage (response)", formatOptionalPercent((_a = performed === null || performed === void 0 ? void 0 : performed.observedResistanceCoverageRatio) !== null && _a !== void 0 ? _a : performed === null || performed === void 0 ? void 0 : performed.freshBikeRowCoverageRatio))}</dl></section>
    <section><h5>Frozen evidence provenance</h5><dl>${detailRow("App version", (_b = workout === null || workout === void 0 ? void 0 : workout.appVersion) !== null && _b !== void 0 ? _b : "unavailable")}${detailRow("Machine", (_c = workout === null || workout === void 0 ? void 0 : workout.machineId) !== null && _c !== void 0 ? _c : "unavailable")}${detailRow("Machine profile version", (_d = workout === null || workout === void 0 ? void 0 : workout.machineProfileVersion) !== null && _d !== void 0 ? _d : "unavailable")}${detailRow("Active / E1 / E2 schema", workout ? `${(_e = workout.activePrescriptionSchemaVersion) !== null && _e !== void 0 ? _e : "n/a"} / ${(_f = workout.shadowSchemaVersion) !== null && _f !== void 0 ? _f : "n/a"} / ${workout.characterizationSchemaVersion}` : "n/a")}${detailRow("Assessment evidence sessions", (_h = (_g = assessment === null || assessment === void 0 ? void 0 : assessment.evidenceSessionIds) === null || _g === void 0 ? void 0 : _g.join(", ")) !== null && _h !== void 0 ? _h : "n/a")}${detailRow("Assessment algorithm", (assessment === null || assessment === void 0 ? void 0 : assessment.algorithm) ? `${assessment.algorithm.id}@${assessment.algorithm.version}` : "n/a")}${detailRow("Assessment protocol", (assessment === null || assessment === void 0 ? void 0 : assessment.protocol) ? `${assessment.protocol.id}@${assessment.protocol.version}` : "n/a")}</dl></section>
    <section><h5>Frozen assessment context</h5><dl>${detailRow("Assessment date", assessment ? new Date(assessment.observedAt).toLocaleDateString() : "n/a")}${detailRow("Assessment quality", personalizationDiagnosticLabel((_k = (_j = assessment === null || assessment === void 0 ? void 0 : assessment.quality) !== null && _j !== void 0 ? _j : record.formalAssessmentQuality) !== null && _k !== void 0 ? _k : "unavailable"))}${detailRow("Calibration provenance", personalizationDiagnosticLabel((_m = (_l = assessment === null || assessment === void 0 ? void 0 : assessment.calibrationProvenance) !== null && _l !== void 0 ? _l : record.calibrationWorkloadProvenance) !== null && _m !== void 0 ? _m : "unavailable"))}${detailRow("Calibration HR range", assessment ? `${assessment.observedMinHeartRateBpm}–${assessment.observedMaxHeartRateBpm} bpm` : "n/a")}${detailRow("Calibration watt range", assessment ? `${assessment.observedMinWatts}–${assessment.observedMaxWatts} W` : "n/a")}${detailRow("Candidate watts", row.candidateWatts)}${detailRow("Assessment domain", personalizationDiagnosticLabel(row.assessmentDomain))}${detailRow("Domain HR margins", phase.candidateDomainMargins ? `${phase.candidateDomainMargins.heartRateToLowerBoundaryBpm} / ${phase.candidateDomainMargins.heartRateToUpperBoundaryBpm} bpm` : "n/a")}${detailRow("Domain watt margins", phase.candidateDomainMargins ? `${phase.candidateDomainMargins.wattsToLowerBoundary} / ${phase.candidateDomainMargins.wattsToUpperBoundary} W` : "n/a")}</dl></section>
    <section><h5>Closed-loop transfer evidence</h5><dl>${detailRow("Candidate midpoint", comparison ? `${comparison.candidateMidpointWatts} W` : "n/a")}${detailRow("Observed settled median", comparison ? `${comparison.observedInBandMedianWatts} W` : "n/a")}${detailRow("Signed / absolute difference", comparison ? `${signed(comparison.signedDifferenceWatts, " W")} / ${comparison.absoluteDifferenceWatts} W` : "n/a")}${detailRow("Percentage difference", comparison ? signed(comparison.signedDifferencePercent, "%") : "n/a")}${detailRow("Candidate contains observed median", comparison ? (comparison.candidateContainsObservedMedian ? "Yes" : "No") : "n/a")}${detailRow("Observed IQR overlap", comparison ? `${comparison.candidateObservedOverlapWatts} W · ${percent(comparison.candidateObservedOverlapRatio)}` : "n/a")}${detailRow("Descriptive agreement", personalizationDiagnosticLabel(row.agreement))}${detailRow("Outcome", personalizationDiagnosticLabel(row.outcome))}${detailRow("Exclusion", personalizationDiagnosticLabel(row.exclusion))}</dl></section>
    ${heldWorkloadDetailHtml(heldWorkloadResponseOf(phase))}
    ${provenanceDetailHtml(row.executionProvenance, phase)}`;
}
