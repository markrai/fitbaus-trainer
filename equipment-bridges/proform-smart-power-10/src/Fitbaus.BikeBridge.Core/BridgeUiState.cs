using System;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Immutable UI/view-model snapshot. Android binds TextViews to this.
    /// Telemetry comes from BikeTelemetryStore; unknown measurements are null.
    /// </summary>
    public sealed class BridgeUiState
    {
        public static BridgeUiState Starting()
        {
            return new BridgeUiState(
                BridgeStatus.Starting,
                "Starting",
                "Disconnected",
                "Not initialized",
                MachineInfo.Unknown.DisplayName,
                DisconnectedSnapshot(),
                "Application starting");
        }

        public BridgeUiState(
            BridgeStatus status,
            string statusText,
            string usbText,
            string shireText,
            string machineText,
            BikeTelemetrySnapshot telemetry,
            string detail)
        {
            Status = status;
            StatusText = statusText ?? string.Empty;
            UsbText = usbText ?? string.Empty;
            ShireText = shireText ?? string.Empty;
            MachineText = machineText ?? string.Empty;
            Telemetry = telemetry ?? DisconnectedSnapshot();
            Detail = detail ?? string.Empty;
        }

        public BridgeStatus Status { get; private set; }

        public string StatusText { get; private set; }

        public string UsbText { get; private set; }

        public string ShireText { get; private set; }

        public string MachineText { get; private set; }

        public BikeTelemetrySnapshot Telemetry { get; private set; }

        public string Detail { get; private set; }

        public BridgeUiState WithTelemetry(BikeTelemetrySnapshot telemetry)
        {
            return new BridgeUiState(
                Status,
                StatusText,
                UsbText,
                ShireText,
                MachineText,
                telemetry,
                Detail);
        }

        public BridgeUiState WithDetail(string detail)
        {
            return new BridgeUiState(
                Status,
                StatusText,
                UsbText,
                ShireText,
                MachineText,
                Telemetry,
                detail);
        }

        public static BikeTelemetrySnapshot DisconnectedSnapshot()
        {
            return new BikeTelemetrySnapshot(
                false,
                false,
                null,
                null,
                null,
                null,
                null,
                null,
                DateTime.SpecifyKind(DateTime.MinValue, DateTimeKind.Utc),
                null);
        }
    }
}
