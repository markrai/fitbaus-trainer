using System;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Maps USB/Shire lifecycle events onto operator-visible UI state.
    /// Does not talk to hardware. Does not fabricate metric zeros.
    /// </summary>
    public static class BridgeStateMapper
    {
        public static string FormatStatus(BridgeStatus status)
        {
            switch (status)
            {
                case BridgeStatus.Starting:
                    return "Starting";
                case BridgeStatus.UsbDeviceNotFound:
                    return "USB device not found";
                case BridgeStatus.UsbPermissionRequired:
                    return "USB permission required";
                case BridgeStatus.UsbConnected:
                    return "USB connected";
                case BridgeStatus.ShireInitializing:
                    return "Shire initializing";
                case BridgeStatus.ShireInitializationFailed:
                    return "Shire initialization failed";
                case BridgeStatus.ShireInitialized:
                    return "Shire initialized";
                case BridgeStatus.StreamingTelemetry:
                    return "Streaming telemetry";
                case BridgeStatus.ConsoleDisconnected:
                    return "Console disconnected";
                default:
                    return status.ToString();
            }
        }

        public static BridgeUiState FromUsbProbe(UsbProbeResult probe, BikeTelemetrySnapshot telemetry)
        {
            BikeTelemetrySnapshot snap = telemetry ?? BridgeUiState.DisconnectedSnapshot();
            if (probe == null || !probe.Found)
            {
                return new BridgeUiState(
                    BridgeStatus.UsbDeviceNotFound,
                    FormatStatus(BridgeStatus.UsbDeviceNotFound),
                    "Not found",
                    "Not initialized",
                    MachineInfo.Unknown.DisplayName,
                    snap,
                    probe != null ? probe.Detail : "USB device not found");
            }

            if (probe.IsBootloader)
            {
                return new BridgeUiState(
                    BridgeStatus.UsbDeviceNotFound,
                    FormatStatus(BridgeStatus.UsbDeviceNotFound),
                    "Bootloader VID " + probe.VendorId + " PID " + probe.ProductId,
                    "Not initialized",
                    MachineInfo.Unknown.DisplayName,
                    snap,
                    "Brainboard is in bootloader mode. Phase 1 will not open the bootloader.");
            }

            if (!probe.HasPermission)
            {
                return new BridgeUiState(
                    BridgeStatus.UsbPermissionRequired,
                    FormatStatus(BridgeStatus.UsbPermissionRequired),
                    "Permission required (VID " + probe.VendorId + " PID " + probe.ProductId + ")",
                    "Not initialized",
                    MachineInfo.Unknown.DisplayName,
                    snap,
                    probe.Detail);
            }

            return new BridgeUiState(
                BridgeStatus.UsbConnected,
                FormatStatus(BridgeStatus.UsbConnected),
                "Connected (VID " + probe.VendorId + " PID " + probe.ProductId + ")",
                "Not initialized",
                MachineInfo.Unknown.DisplayName,
                snap,
                probe.Detail);
        }

        public static BridgeUiState FromUsbProbe(UsbProbeResult probe)
        {
            return FromUsbProbe(probe, BridgeUiState.DisconnectedSnapshot());
        }

        public static BridgeUiState ShireInitializing(UsbProbeResult probe, BikeTelemetrySnapshot telemetry)
        {
            BridgeUiState usb = FromUsbProbe(probe, telemetry);
            return new BridgeUiState(
                BridgeStatus.ShireInitializing,
                FormatStatus(BridgeStatus.ShireInitializing),
                usb.UsbText,
                "Initializing",
                MachineInfo.Unknown.DisplayName,
                telemetry ?? usb.Telemetry,
                "FitProConsole created; waiting for EquipmentConsole.Init()");
        }

        public static BridgeUiState ShireInitializing(UsbProbeResult probe)
        {
            return ShireInitializing(probe, BridgeUiState.DisconnectedSnapshot());
        }

        public static BridgeUiState ShireFailed(UsbProbeResult probe, string error, BikeTelemetrySnapshot telemetry)
        {
            BridgeUiState usb = FromUsbProbe(probe, telemetry);
            return new BridgeUiState(
                BridgeStatus.ShireInitializationFailed,
                FormatStatus(BridgeStatus.ShireInitializationFailed),
                usb.UsbText,
                "Initialization failed",
                MachineInfo.Unknown.DisplayName,
                telemetry ?? usb.Telemetry,
                error ?? "Shire initialization failed");
        }

        public static BridgeUiState ShireFailed(UsbProbeResult probe, string error)
        {
            return ShireFailed(probe, error, BridgeUiState.DisconnectedSnapshot());
        }

        public static BridgeUiState ShireReady(UsbProbeResult probe, MachineInfo machine, BikeTelemetrySnapshot telemetry)
        {
            BridgeUiState usb = FromUsbProbe(probe, telemetry);
            MachineInfo info = machine ?? MachineInfo.Unknown;
            return new BridgeUiState(
                BridgeStatus.ShireInitialized,
                FormatStatus(BridgeStatus.ShireInitialized),
                usb.UsbText,
                "Initialized",
                info.DisplayName,
                telemetry ?? usb.Telemetry,
                "Primary device ready");
        }

        public static BridgeUiState Streaming(BridgeUiState current, BikeTelemetrySnapshot telemetry)
        {
            if (current == null)
            {
                throw new ArgumentNullException("current");
            }

            return new BridgeUiState(
                BridgeStatus.StreamingTelemetry,
                FormatStatus(BridgeStatus.StreamingTelemetry),
                current.UsbText,
                "Initialized",
                current.MachineText,
                telemetry ?? current.Telemetry,
                "Streaming native Resistance / RPM / Watts");
        }

        public static BridgeUiState Disconnected(string detail, BikeTelemetrySnapshot telemetry)
        {
            return new BridgeUiState(
                BridgeStatus.ConsoleDisconnected,
                FormatStatus(BridgeStatus.ConsoleDisconnected),
                "Disconnected",
                "Disconnected",
                MachineInfo.Unknown.DisplayName,
                telemetry ?? BridgeUiState.DisconnectedSnapshot(),
                detail ?? "Console disconnected");
        }

        public static BridgeUiState Disconnected(string detail)
        {
            return Disconnected(detail, BridgeUiState.DisconnectedSnapshot());
        }
    }
}
