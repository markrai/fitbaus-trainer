/**
 * Versioned personalization diagnostics export (schemas v1-v3, each explicit).
 * Exports durable E2 records and rows only; runtime projections (E3, held
 * workload, execution provenance, E4A) are never exported.
 */
import { withPhases } from "./projection.js";
export const PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V1 = 1;
export const PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V2 = 2;
export const PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V3 = 3;
export const PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION = PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V3;
function exportBody(model) {
    return {
        filters: { ...model.filters },
        aggregate: model.aggregate,
        diagnosticRows: model.rows.map(({ record: _record, phaseRecord: _phaseRecord, performedLoadPhase: _performedLoadPhase, executionProvenance: _executionProvenance, ...row }) => row),
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
export function createPersonalizationDiagnosticsExport(model) {
    return { schemaVersion: PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V3, ...exportBody(model) };
}
/**
 * Historical export-v2 writer. Fails closed (null) when the model holds any
 * record outside the v2 record contract, rather than widening or relabeling it.
 */
export function createHistoricalPersonalizationDiagnosticsExportV2(model) {
    const body = exportBody(model);
    const records = body.characterizationRecords.filter((record) => record.schemaVersion === 1 || record.schemaVersion === 2);
    if (records.length !== body.characterizationRecords.length)
        return null;
    return { schemaVersion: PERSONALIZATION_DIAGNOSTICS_EXPORT_SCHEMA_VERSION_V2, ...body, characterizationRecords: records };
}
export function personalizationDiagnosticsExportJson(model) {
    return `${JSON.stringify(createPersonalizationDiagnosticsExport(model), null, 2)}\n`;
}
