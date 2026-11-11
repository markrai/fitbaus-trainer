function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function formatNumber(value, digits = 1) {
    if (value === undefined)
        return "unavailable";
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 10 ** digits) / 10 ** digits);
}
function formatPercent(value) {
    if (value === undefined)
        return "unavailable";
    return `${Math.round(value * 100)}%`;
}
function formatHeartRate(target) {
    var _a;
    if (!target)
        return "unavailable";
    if (target.min !== undefined && target.max !== undefined)
        return `${target.min}–${target.max} bpm`;
    if (target.min !== undefined)
        return `≥${target.min} bpm`;
    if (target.max !== undefined)
        return `<${((_a = target.max) !== null && _a !== void 0 ? _a : 0) + 1} bpm`;
    return "unavailable";
}
function phaseTitle(phase) {
    var _a;
    const name = (_a = phase.detailName) !== null && _a !== void 0 ? _a : phase.kind;
    const interval = phase.intervalIndex !== undefined ? ` ${phase.intervalIndex + 1}` : "";
    return `${name}${interval} · ${phase.completedDurationSec} s`;
}
function field(label, value) {
    return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}
function phaseHtml(phase) {
    var _a, _b;
    const hr = phase.hr
        ? `${formatNumber(phase.hr.median)} bpm (min ${formatNumber(phase.hr.min)}, max ${formatNumber(phase.hr.max)})`
        : "unavailable";
    return `<article class="performed-load-phase">
    <h4>${escapeHtml(phaseTitle(phase))}</h4>
    <p class="performed-load-hr-target">Target HR ${escapeHtml(formatHeartRate(phase.expectedHeartRate))}</p>
    <dl>
      <div><dt>Resistance</dt><dd>
        ${field("Desired", formatNumber(phase.desiredResistanceMedian, 0))}
        ${field("Commanded", formatNumber(phase.commandedResistanceMedian, 0))}
        ${field("Observed mode", formatNumber(phase.observedResistanceMode, 0))}
        ${field("Observed median", formatNumber(phase.observedResistanceMedian, 0))}
        ${field("Desired agreement", formatPercent(phase.observedVsDesiredAgreement))}
      </dd></div>
      <div><dt>Cadence</dt><dd>
        ${field("Median", phase.cadenceMedianRpm === undefined ? "unavailable" : `${formatNumber(phase.cadenceMedianRpm)} rpm`)}
        ${field("MAD", phase.cadenceMadRpm === undefined ? "unavailable" : `${formatNumber(phase.cadenceMadRpm)} rpm`)}
      </dd></div>
      <div><dt>Power</dt><dd>
        ${field("Median", phase.wattsMedian === undefined ? "unavailable" : `${formatNumber(phase.wattsMedian)} W`)}
        ${field("MAD", phase.wattsMad === undefined ? "unavailable" : `${formatNumber(phase.wattsMad)} W`)}
      </dd></div>
      <div><dt>Telemetry</dt><dd>
        ${field("Coverage", formatPercent((_a = phase.observedResistanceCoverageRatio) !== null && _a !== void 0 ? _a : phase.freshBikeRowCoverageRatio))}
        ${field("Observed samples", String(phase.observedSampleCount))}
      </dd></div>
      <div><dt>Heart rate</dt><dd>
        ${field("Median (min–max)", hr)}
        ${field("HR coverage", formatPercent((_b = phase.hr) === null || _b === void 0 ? void 0 : _b.coverageRatio))}
      </dd></div>
    </dl>
  </article>`;
}
/** Formats an already-derived performed-load model. Does not compute statistics. */
export function performedLoadDiagnosticsHtml(workouts) {
    if (workouts.length === 0) {
        return `<div class="personalization-diagnostics-empty"><strong>No ordinary bike performed-load evidence yet.</strong><span>Complete a bike workout with Bike Bridge telemetry to inspect observed workload. Recommendation is intent; observation is what physically happened.</span></div>`;
    }
    return workouts.map((workout) => {
        const date = escapeHtml(new Date(workout.startedAt).toLocaleString());
        const cancelled = workout.cancelled ? " · cancelled" : "";
        return `<section class="performed-load-workout">
      <h3>${escapeHtml(workout.label)} <span>${date}${cancelled}</span></h3>
      <p class="developer-diagnostics-note">Disagreement is evidence, not a failed workout. Session bike-row coverage ${escapeHtml(formatPercent(workout.freshBikeRowCoverageRatio))}.</p>
      ${workout.phases.map(phaseHtml).join("")}
    </section>`;
    }).join("");
}
