// Allowed equipment writes for this process, and the HTTP surface that may
// reach them. Requested resistance must not be copied into telemetry;
// WhenMetricChanged remains the only observation path.
//
// Allowed write:
//   IEquipmentConsole.SetResistance(double) with a FitBaus-validated integer 1-15
//
// Forbidden (exist on IFitProConsole / EquipmentConsole but must not be called):
//   IFitProConsole.SetResistance (BoundResistance uses MaxResistanceLevel)
//   SetGrade / SetIncline
//   SetKph
//   SetValues / SetBasicValues constructed by our code
//   ResistanceGoal writes
//   ReadWriteDataCmd constructed by our code
//   arbitrary USB bulk writes
//   BrainBoardUpdater / BootLoader / EnterBootloaderCmd / ResetBrainboard
//   StartCalibrateIncline / CalibrateIncline
//
// HTTP may expose only:
//   GET /health
//   GET /api/v1/telemetry
//   GET /api/v1/status
//   POST /api/v1/resistance
//   POST /api/v1/heartrate   (display ingest only; never controls the bike)
//   POST /api/v1/brightness  (console window brightness; never controls the bike)
//
// HTTP must not expose:
//   /command /shire /usb or any generic write surface
//   incline, calibration, firmware, or bootloader endpoints
//   relative +/- resistance, ramping, or workout control
//
// Heart-rate ingest and brightness must never initialize USB, alter resistance,
// mutate BikeTelemetryStore, change connection/health, or keep a bike session alive.
//
// Shire's own EquipmentConsole.Init() still runs the manufacturer's sequence.
// Do not kill Wolf/ERU from application code.

namespace Fitbaus.BikeBridge.AndroidApp
{
    internal static class BridgeControlPolicy
    {
        public const string Statement = "LAN resistance control via POST /api/v1/resistance. Display-only HR via POST /api/v1/heartrate. Console brightness via POST /api/v1/brightness. Requested resistance, HR, and brightness do not mutate bike telemetry. No SetGrade/SetKph/SetValues, no raw USB, no bootloader.";
    }
}
