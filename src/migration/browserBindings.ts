/** Profile > Data legacy-import card: file selection, preview, and Confirm import. */

import { MigrationError, type MigrationBundle } from "./contracts.js";
import {
  isMigrationBundleImportable,
  parseMigrationBundleJson,
  summarizeMigrationBundle,
  type MigrationBundleSummary,
} from "./bundle.js";
import { browserMigrationLocalStorage } from "./destination.js";
import { importMigrationBundle } from "./importer.js";
import { verifyMigrationBundleIntegrity } from "./integrity.js";

interface PendingImport {
  bundle: MigrationBundle;
  summary: MigrationBundleSummary;
}

export function registerDataMigrationGlobals(): void {
  const win = window as unknown as Record<string, unknown>;
  let pending: PendingImport | null = null;

  const byId = (id: string) => document.getElementById(id);

  function renderSummary(element: HTMLElement, summary: MigrationBundleSummary): void {
    const counts = summary.storeCounts;
    element.innerHTML = "";
    const lines = [
      `Source: ${summary.sourcePackageId}${summary.appVersion ? ` (app ${summary.appVersion})` : ""}`,
      `Exported: ${summary.exportedAt}`,
      `Workouts: ${counts.workouts} · HR samples: ${counts.hr_samples} · Bike telemetry: ${counts.ordinary_bike_telemetry} · Sync settings: ${counts.sisu_settings}`,
      `Settings & profile keys: ${summary.localStorageCount}`,
      ...(summary.undefinedPropertiesDropped
        ? [`${summary.undefinedPropertiesDropped} undefined-valued legacy properties were treated as absent (JSON has no undefined; reading them yields undefined either way).`]
        : []),
      ...(summary.unknownLocalKeys.length
        ? [`Unrecognized legacy keys (import blocked): ${summary.unknownLocalKeys.join(", ")}`]
        : []),
      ...(summary.unknownStores.length
        ? [`Unrecognized legacy stores (import blocked): ${summary.unknownStores.map((s) => `${s.name} (${s.record_count} records)`).join(", ")}`]
        : []),
      "Import is allowed only into a fresh FitBaus Trainer installation. Existing FitBaus data will not be merged or overwritten.",
    ];
    for (const line of lines) {
      const div = document.createElement("div");
      div.textContent = line;
      element.appendChild(div);
    }
  }

  win.selectLegacyMigrationFile = async (input: HTMLInputElement): Promise<void> => {
    const status = byId("legacyImportStatus");
    const preview = byId("legacyImportPreview");
    const confirmButton = byId("legacyImportConfirmButton") as HTMLButtonElement | null;
    pending = null;
    if (confirmButton) confirmButton.hidden = true;
    const file = input.files?.[0];
    if (!file || !status || !preview) return;
    try {
      const text = await file.text();
      const bundle = parseMigrationBundleJson(text);
      await verifyMigrationBundleIntegrity(bundle);
      const summary = summarizeMigrationBundle(bundle);
      renderSummary(preview, summary);
      preview.hidden = false;
      if (!isMigrationBundleImportable(bundle)) {
        pending = null;
        if (confirmButton) confirmButton.hidden = true;
        status.textContent =
          "Migration file is intact, but it contains unrecognized legacy state that has not been approved for migration. No data was changed.";
        return;
      }
      pending = { bundle, summary };
      if (confirmButton) confirmButton.hidden = false;
      status.textContent = "Migration file verified. Review the summary, then confirm import.";
    } catch (error) {
      preview.hidden = true;
      status.textContent =
        error instanceof MigrationError
          ? `Migration file rejected (${error.code}): ${error.message} No data was changed.`
          : "Migration file could not be read. No data was changed.";
    }
  };

  win.confirmLegacyMigrationImport = async (): Promise<void> => {
    const status = byId("legacyImportStatus");
    const confirmButton = byId("legacyImportConfirmButton") as HTMLButtonElement | null;
    if (!pending || !status) return;
    if (confirmButton) confirmButton.disabled = true;
    try {
      const result = await importMigrationBundle(pending.bundle, {
        storage: browserMigrationLocalStorage(),
      });
      if (result.status === "IMPORTED_VERIFIED" && result.verification) {
        const v = result.verification;
        status.textContent =
          `Import verified: ${v.workouts.actual} workouts, ${v.hrSamples.actual} HR samples, ` +
          `${v.ordinaryBikeTelemetry.actual} bike telemetry records. ` +
          `Profile: ${v.profilePresent ? "present" : "absent"} · Fitness state: ${v.fitnessStatePresent ? "present" : "absent"} · ` +
          `Verification: VERIFIED_MATCH. Keep the legacy app installed until you have checked your history here.`;
        pending = null;
        if (confirmButton) confirmButton.hidden = true;
      } else if (result.status === "ALREADY_IMPORTED") {
        status.textContent = "This exact migration file was already imported. Nothing was changed.";
        pending = null;
        if (confirmButton) confirmButton.hidden = true;
      } else if (result.status === "EXISTING_IMPORT_MISMATCH") {
        status.textContent =
          "A prior import receipt exists for this migration file, but stored data no longer matches that bundle and manual review is required. Nothing was changed.";
        pending = null;
        if (confirmButton) confirmButton.hidden = true;
      } else if (result.status === "PRIOR_MIGRATION_DIFFERENT_BUNDLE") {
        status.textContent =
          "Import stopped: a prior migration receipt for a different migration file exists, so nothing was merged or overwritten. Manual review is required.";
      } else if (result.status === "DESTINATION_NOT_EMPTY") {
        status.textContent =
          "Import stopped: this FitBaus Trainer installation already contains data, so nothing was merged or overwritten. " +
          (result.destinationPreflight?.reasons.join("; ") ?? "");
      } else if (result.status === "ROLLBACK_UNVERIFIED") {
        status.textContent =
          "Import failed and automatic rollback could not be verified. Do not continue using this new installation until it is inspected/reset. The legacy app remains untouched.";
      } else if (result.status === "FAILED_ROLLED_BACK") {
        status.textContent = `Import failed and rollback was verified against the pre-import state. (${result.error?.code ?? "IMPORT_FAILED"})`;
      } else {
        status.textContent = `Import failed (${result.error?.code ?? "IMPORT_FAILED"}): ${result.error?.message ?? "unknown error"}`;
      }
    } catch (error) {
      status.textContent =
        error instanceof MigrationError
          ? `Import rejected (${error.code}): ${error.message} No data was changed.`
          : "Import failed before any data was changed.";
    } finally {
      if (confirmButton) confirmButton.disabled = false;
    }
  };
}
