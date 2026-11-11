/**
 * Personalization diagnostics: stable public entry point. Developer-only and
 * read-only. The implementation lives in src/personalization/diagnostics/:
 * trusted history inputs and projection decide what the diagnostics mean;
 * formatting and rendering decide how they look. DOM event handlers stay in
 * uiControls. Nothing here has a path into prescription or control.
 */

export {
  PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS,
  EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS,
} from "./personalization/diagnostics/model.js";
export type {
  PersonalizationDiagnosticsFilters,
  PersonalizationDiagnosticsFilterOptions,
  PersonalizationDiagnosticPresentationRow,
  PersonalizationEvidenceCollectionSummary,
  PersonalizationHeldWorkloadForwardSummary,
  PersonalizationExecutionProvenanceSummary,
  PersonalizationHeldActuationContextRow,
  PersonalizationDiagnosticsModel,
  TrustedWorkoutHistoryRow,
  FrozenAssessmentDiagnosticContext,
  FrozenWorkoutDiagnosticContext,
  ThresholdCalibrationIdentity,
  ThresholdLongitudinalCohortKey,
  ThresholdLongitudinalExclusionReason,
  ThresholdLongitudinalExclusion,
  ThresholdLongitudinalSession,
  ThresholdLongitudinalCohort,
  ThresholdLongitudinalAnalysis,
} from "./personalization/diagnostics/model.js";
export {
  buildThresholdLongitudinalAnalysis,
} from "./personalization/diagnostics/longitudinal.js";
export {
  extractTrustedPersonalizationCharacterizations,
  extractTrustedPersonalizationAssessmentContexts,
  extractTrustedPersonalizationWorkoutContexts,
  extractTrustedExecutionProvenanceContexts,
  extractTrustedPersonalizationPerformedLoadContexts,
} from "./personalization/diagnostics/trustedHistory.js";
export {
  personalizationDiagnosticsFilterOptions,
  calibrationWorkoutMachineComparison,
  summarizeExecutionProvenance,
  summarizeHeldActuationContext,
  summarizePersonalizationEvidenceCollection,
  summarizeHeldWorkloadForwardEvidence,
  filterPersonalizationCharacterizations,
  buildPersonalizationDiagnosticsModel,
  buildDiagnosticScientificAssessments,
} from "./personalization/diagnostics/projection.js";
export {
  PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V1,
  PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V2,
  PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V3,
  PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION,
  createPersonalizationDiagnosticsExport,
  createHistoricalPersonalizationDiagnosticsExportV2,
  personalizationDiagnosticsExportJson,
} from "./personalization/diagnostics/export.js";
export type {
  PersonalizationDiagnosticsExportV1,
  PersonalizationDiagnosticsExportV2,
  PersonalizationDiagnosticsExportV3,
  PersonalizationDiagnosticsExport,
  CurrentPersonalizationDiagnosticsExport,
} from "./personalization/diagnostics/export.js";
export {
  personalizationDiagnosticLabel,
} from "./personalization/diagnostics/formatting.js";
export {
  personalizationDiagnosticsHtml,
  personalizationDiagnosticDetailHtml,
} from "./personalization/diagnostics/rendering.js";
