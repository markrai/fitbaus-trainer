export function isFreestyleWorkoutSummary(summary: unknown): boolean {
  if (!summary || typeof summary !== "object") return false;
  const s = summary as Record<string, unknown>;
  return (
    s.intent === "freestyle" ||
    s.day === "Freestyle" ||
    (s.open_ended_timing != null && typeof s.open_ended_timing === "object")
  );
}

export function buildFreestyleHistoryCompact(summary: any): string {
  const fr = summary?.freestyle_ride_response;
  if (!fr || !isFreestyleWorkoutSummary(summary)) return "";
  const incomplete = summary.evidence_incomplete === true
    ? '<span class="workout-item-detail" style="color:#e6a700;">⚠ Incomplete evidence</span>'
    : "";
  const kj = fr.workload?.observedWorkKj;
  const status = fr.workload?.workStatus;
  const kjText = typeof kj === "number" && Number.isFinite(kj)
    ? (status === "partial" ? `${Math.round(kj)} kJ observed` : `${Math.round(kj)} kJ`)
    : "Unavailable";
  return `<div class="workout-item-detail">Work: ${kjText}</div>${incomplete}`;
}

export function buildFreestyleAnalyticsHtml(summary: any): string {
  if (!isFreestyleWorkoutSummary(summary)) return "";
  const fr = summary?.freestyle_ride_response;
  if (!fr) {
    return [
      '<div class="freestyle-analytics" style="margin-top:12px;">',
      '<div class="label" style="font-weight:600;margin-bottom:6px;">Freestyle Analytics</div>',
      '<div class="label">Unavailable for this record</div>',
      "</div>",
    ].join("\n");
  }

  const sections: string[] = [];
  sections.push('<div class="freestyle-analytics" style="margin-top:12px;">');
  sections.push('<div class="label" style="font-weight:600;margin-bottom:6px;">Freestyle Analytics</div>');

  const wl = fr.workload;
  if (wl) {
    const kjText = typeof wl.observedWorkKj === "number" && Number.isFinite(wl.observedWorkKj)
      ? (wl.workStatus === "partial"
          ? `${wl.observedWorkKj.toFixed(1)} kJ (partial — observed intervals only)`
          : `${wl.observedWorkKj.toFixed(1)} kJ (${wl.workStatus})`)
      : "Unavailable";
    sections.push(`<div class="label">Observed Work: ${kjText}</div>`);
    if (wl.watts) {
      const w = wl.watts;
      const provenanceLabel = w.provenance === "measured_watts"
        ? "equipment-derived"
        : w.provenance === "calibrated_watts"
          ? "calibrated estimate"
          : w.provenance === "mixed"
            ? "mixed provenance"
            : String(w.provenance || "").replace(/_/g, " ");
      sections.push(`<div class="label">Power: mean ${w.mean}W, median ${w.median}W, min ${w.min}W, max ${w.max}W, IQR ${w.distribution.iqr}W (${provenanceLabel})</div>`);
    }
    if (wl.cadenceRpm) {
      const c = wl.cadenceRpm;
      sections.push(`<div class="label">Cadence: mean ${c.mean} rpm, median ${c.median} rpm, min ${c.min} rpm, max ${c.max} rpm</div>`);
    }
    if (wl.observedResistance) {
      const r = wl.observedResistance;
      const levels = r.levelsUsed.map((l: any) => `L${l.level} ${l.activeSeconds}s`).join(", ");
      const medianText = r.medianLevel != null ? `, median L${r.medianLevel}` : "";
      sections.push(`<div class="label">Resistance: ${levels}${medianText} (coverage ${(r.coverageRatio * 100).toFixed(0)}%)</div>`);
    }
    sections.push(`<div class="label">Power Coverage: ${(wl.powerCoverageRatio * 100).toFixed(0)}%</div>`);
  } else {
    sections.push('<div class="label">Workload: Unavailable</div>');
  }

  const hr = fr.evidence?.hr;
  if (hr && hr.source === "ble_chest_strap" && hr.validSampleCount > 0) {
    const parts = [];
    if (hr.meanBpm != null) parts.push(`mean ${hr.meanBpm} bpm`);
    if (hr.medianBpm != null) parts.push(`median ${hr.medianBpm} bpm`);
    if (hr.minBpm != null) parts.push(`min ${hr.minBpm} bpm`);
    if (hr.maxBpm != null) parts.push(`max ${hr.maxBpm} bpm`);
    sections.push(`<div class="label">HR: ${parts.join(", ")} (coverage ${(hr.coverageRatio * 100).toFixed(0)}%)</div>`);
  } else {
    sections.push('<div class="label">HR: Unavailable</div>');
  }

  const bike = fr.evidence?.bike;
  if (bike) {
    const missing = bike.implicitMissingCount + bike.staleSampleCount + bike.unavailableSampleCount;
    if (missing > 0) {
      sections.push(`<div class="label" style="color:#888;">Missing/Stale: ${missing}s (stale ${bike.staleSampleCount}s, unavailable ${bike.unavailableSampleCount}s, implicit ${bike.implicitMissingCount}s)</div>`);
    }
  }
  if (fr.evidence?.f1EvidenceIncomplete || summary.evidence_incomplete === true) {
    sections.push('<div class="label" style="color:#e6a700;">⚠ Evidence collection was incomplete</div>');
  }

  sections.push("</div>");
  return sections.join("\n");
}

export interface FreestyleAnalyticsDocumentLike {
  getElementById(id: string): { style: { display: string }; innerHTML: string } | null;
}

export function renderFreestyleWorkoutSummaryPanel(
  summary: unknown,
  documentRef: FreestyleAnalyticsDocumentLike = document
): void {
  const freestyleEl = documentRef.getElementById("workoutSummaryFreestyle");
  if (!freestyleEl) return;
  const analyticsHtml = buildFreestyleAnalyticsHtml(summary);
  if (analyticsHtml) {
    freestyleEl.style.display = "";
    freestyleEl.innerHTML = analyticsHtml;
  } else {
    freestyleEl.style.display = "none";
    freestyleEl.innerHTML = "";
  }
}
