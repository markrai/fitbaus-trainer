/**
 * Versioned personalization diagnostics export (schemas v1-v3, each explicit).
 * Exports durable E2 records and rows only; runtime projections (E3, held
 * workload, execution provenance, E4A) are never exported.
 */

import type { PersonalizedPrescriptionCharacterizationAggregateV1, PersonalizedPrescriptionCharacterizationAggregateV2 } from "../../personalizedPrescriptionCharacterization.js";
import type { PersonalizedPrescriptionCharacterization, PersonalizedPrescriptionCharacterizationV1, PersonalizedPrescriptionCharacterizationV2 } from "../../types.js";
import type { PersonalizationDiagnosticPresentationRow, PersonalizationDiagnosticsFilters, PersonalizationDiagnosticsModel } from "./model.js";
import { withPhases } from "./projection.js";

export const PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V1 = 1 as const;
export const PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V2 = 2 as const;
export const PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V3 = 3 as const;
export const PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION =
  PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V3;
export interface PersonalizationDiagnosticsExportV1 {
  schemaVersion: typeof PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V1;
  filters: PersonalizationDiagnosticsFilters;
  aggregate: PersonalizedPrescriptionCharacterizationAggregateV1;
  diagnosticRows: Array<Omit<PersonalizationDiagnosticPresentationRow,
    "record" | "phaseRecord" | "formalAssessmentProvenance" | "performedLoadPhase">>;
  characterizationRecords: PersonalizedPrescriptionCharacterizationV1[];
}

type ExportedDiagnosticRow = Omit<PersonalizationDiagnosticPresentationRow,
  "record" | "phaseRecord" | "performedLoadPhase" | "executionProvenance">;

/**
 * Permanent historical export contract. Its record contract is exactly the E2
 * versions that existed when it was current (v1 and v2); it can never carry an
 * E2 v3 record.
 */
export interface PersonalizationDiagnosticsExportV2 {
  schemaVersion: typeof PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V2;
  filters: PersonalizationDiagnosticsFilters;
  aggregate: PersonalizedPrescriptionCharacterizationAggregateV2;
  diagnosticRows: ExportedDiagnosticRow[];
  characterizationRecords: Array<PersonalizedPrescriptionCharacterizationV1 | PersonalizedPrescriptionCharacterizationV2>;
}

/**
 * Current export. Same durable fields as v2; the bump only admits E2 v3
 * records. Runtime projections (E3 series, held-workload summary, E4A) stay
 * unexported.
 */
export interface PersonalizationDiagnosticsExportV3 {
  schemaVersion: typeof PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V3;
  filters: PersonalizationDiagnosticsFilters;
  aggregate: PersonalizedPrescriptionCharacterizationAggregateV2;
  diagnosticRows: ExportedDiagnosticRow[];
  characterizationRecords: PersonalizedPrescriptionCharacterization[];
}

export type PersonalizationDiagnosticsExport =
  | PersonalizationDiagnosticsExportV1
  | PersonalizationDiagnosticsExportV2
  | PersonalizationDiagnosticsExportV3;
export type CurrentPersonalizationDiagnosticsExport = PersonalizationDiagnosticsExportV3;

function exportBody(model: PersonalizationDiagnosticsModel) {
  return {
    filters: { ...model.filters },
    aggregate: model.aggregate,
    diagnosticRows: model.rows.map(({
      record: _record,
      phaseRecord: _phaseRecord,
      performedLoadPhase: _performedLoadPhase,
      executionProvenance: _executionProvenance,
      ...row
    }) => row),
    characterizationRecords: [...model.records]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.workoutSessionId.localeCompare(b.workoutSessionId))
      .map((record) => withPhases(record, record.phases)),
  };
}

/**
 * Stable local export. It includes immutable E2 records, never profile data or raw HR traces.
 * The contract is exactly schemaVersion, filters, aggregate, diagnosticRows,
 * characterizationRecords; runtime-only analyses (E3 series, held-workload
 * summary, E4A) are never exported.
 */
export function createPersonalizationDiagnosticsExport(
  model: PersonalizationDiagnosticsModel
): PersonalizationDiagnosticsExportV3 {
  return { schemaVersion: PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V3, ...exportBody(model) };
}

/**
 * Historical export-v2 writer. Fails closed (null) when the model holds any
 * record outside the v2 record contract, rather than widening or relabeling it.
 */
export function createHistoricalPersonalizationDiagnosticsExportV2(
  model: PersonalizationDiagnosticsModel
): PersonalizationDiagnosticsExportV2 | null {
  const body = exportBody(model);
  const records = body.characterizationRecords.filter(
    (record): record is PersonalizedPrescriptionCharacterizationV1 | PersonalizedPrescriptionCharacterizationV2 =>
      record.schemaVersion === 1 || record.schemaVersion === 2);
  if (records.length !== body.characterizationRecords.length) return null;
  return { schemaVersion: PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V2, ...body, characterizationRecords: records };
}

export function personalizationDiagnosticsExportJson(model: PersonalizationDiagnosticsModel): string {
  return `${JSON.stringify(createPersonalizationDiagnosticsExport(model), null, 2)}\n`;
}
