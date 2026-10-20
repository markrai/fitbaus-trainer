using System;
using Fitbaus.BikeBridge.Core;
using Xunit;

namespace Fitbaus.BikeBridge.Core.Tests
{
    public class BridgeStateMapperTests
    {
        [Fact]
        public void UsbMissing_MapsToNotFound()
        {
            BridgeUiState state = BridgeStateMapper.FromUsbProbe(UsbProbeResult.None());
            Assert.Equal(BridgeStatus.UsbDeviceNotFound, state.Status);
            Assert.Equal("USB device not found", state.StatusText);
            Assert.Equal("Not found", state.UsbText);
        }

        [Fact]
        public void UsbWithoutPermission_MapsToPermissionRequired()
        {
            UsbProbeResult probe = new UsbProbeResult(true, false, BikeUsbIds.VendorId, BikeUsbIds.BrainBoardProductId, "/dev/bus/usb/001/002", "permission missing");
            BridgeUiState state = BridgeStateMapper.FromUsbProbe(probe);
            Assert.Equal(BridgeStatus.UsbPermissionRequired, state.Status);
            Assert.Contains("Permission required", state.UsbText);
            Assert.Contains("8508", state.UsbText);
        }

        [Fact]
        public void BrainBoardWithPermission_MapsToUsbConnected()
        {
            UsbProbeResult probe = BrainBoard();
            BridgeUiState state = BridgeStateMapper.FromUsbProbe(probe);
            Assert.Equal(BridgeStatus.UsbConnected, state.Status);
            Assert.Equal("USB connected", state.StatusText);
            Assert.Contains("Connected", state.UsbText);
        }

        [Fact]
        public void BootloaderPid_IsRejectedWithoutOpeningBootloader()
        {
            UsbProbeResult probe = new UsbProbeResult(true, true, BikeUsbIds.VendorId, BikeUsbIds.BootloaderProductId, "boot", "bootloader");
            BridgeUiState state = BridgeStateMapper.FromUsbProbe(probe);
            Assert.Equal(BridgeStatus.UsbDeviceNotFound, state.Status);
            Assert.Contains("bootloader", state.Detail, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void ShireInitializing_KeepsUsbConnectedText()
        {
            BridgeUiState state = BridgeStateMapper.ShireInitializing(BrainBoard());
            Assert.Equal(BridgeStatus.ShireInitializing, state.Status);
            Assert.Equal("Shire initializing", state.StatusText);
            Assert.Equal("Initializing", state.ShireText);
            Assert.Contains("Connected", state.UsbText);
        }

        [Fact]
        public void ShireFailed_ExposesErrorDetail()
        {
            BridgeUiState state = BridgeStateMapper.ShireFailed(BrainBoard(), "Init timed out");
            Assert.Equal(BridgeStatus.ShireInitializationFailed, state.Status);
            Assert.Equal("Shire initialization failed", state.StatusText);
            Assert.Equal("Init timed out", state.Detail);
        }

        [Fact]
        public void ShireReady_ShowsMachineWithoutFabricatingTelemetry()
        {
            MachineInfo machine = new MachineInfo("Smart Power 10", "Bike", true, 20.0, 1, 2, 3);
            DateTime t0 = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            BikeTelemetrySnapshot telemetry = new BikeTelemetrySnapshot(true, true, null, null, null, null, null, null, t0, machine);
            BridgeUiState state = BridgeStateMapper.ShireReady(BrainBoard(), machine, telemetry);
            Assert.Equal(BridgeStatus.ShireInitialized, state.Status);
            Assert.Equal("Initialized", state.ShireText);
            Assert.Equal("Smart Power 10 (Bike)", state.MachineText);
            Assert.Null(state.Telemetry.Resistance);
            Assert.Null(state.Telemetry.Rpm);
            Assert.Null(state.Telemetry.Watts);
        }

        [Fact]
        public void Streaming_PreservesMachineAndUpdatesTelemetry()
        {
            MachineInfo machine = new MachineInfo("Smart Power 10", "Bike", true, 20.0, 1, 2, 3);
            BridgeUiState ready = BridgeStateMapper.ShireReady(BrainBoard(), machine, BridgeUiState.DisconnectedSnapshot());
            DateTime t0 = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            BikeTelemetrySnapshot telemetry = new BikeTelemetrySnapshot(true, true, 4, 78, 126, t0, t0, t0, t0, machine);
            BridgeUiState streaming = BridgeStateMapper.Streaming(ready, telemetry);
            Assert.Equal(BridgeStatus.StreamingTelemetry, streaming.Status);
            Assert.Equal("Streaming telemetry", streaming.StatusText);
            Assert.Equal("Smart Power 10 (Bike)", streaming.MachineText);
            Assert.Equal(78, streaming.Telemetry.Rpm);
            Assert.Equal(126, streaming.Telemetry.Watts);
        }

        [Fact]
        public void Disconnected_ClearsMachineAndTelemetry()
        {
            BridgeUiState state = BridgeStateMapper.Disconnected("USB detached");
            Assert.Equal(BridgeStatus.ConsoleDisconnected, state.Status);
            Assert.Equal("Console disconnected", state.StatusText);
            Assert.Null(state.Telemetry.Rpm);
            Assert.False(state.Telemetry.Connected);
        }

        private static UsbProbeResult BrainBoard()
        {
            return new UsbProbeResult(true, true, BikeUsbIds.VendorId, BikeUsbIds.BrainBoardProductId, "usb", "claimed");
        }
    }
}
