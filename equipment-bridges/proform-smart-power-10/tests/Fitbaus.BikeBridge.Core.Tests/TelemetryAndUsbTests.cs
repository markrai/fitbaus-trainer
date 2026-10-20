using System;
using Fitbaus.BikeBridge.Core;
using Xunit;

namespace Fitbaus.BikeBridge.Core.Tests
{
    public class TelemetrySnapshotTests
    {
        private static readonly DateTime T0 = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        [Fact]
        public void ValuesEqual_ComparesObservedFieldsOnly()
        {
            BikeTelemetrySnapshot a = Observed(4, 78, 126, T0);
            BikeTelemetrySnapshot b = Observed(4, 78, 126, T0.AddSeconds(1));
            BikeTelemetrySnapshot c = Observed(5, 78, 126, T0);
            Assert.True(a.ValuesEqual(b));
            Assert.False(a.ValuesEqual(c));
            Assert.False(a.ValuesEqual(null));
        }

        private static BikeTelemetrySnapshot Observed(int resistance, int rpm, int watts, DateTime at)
        {
            return new BikeTelemetrySnapshot(true, true, resistance, rpm, watts, at, at, at, at, null);
        }
    }

    public class UsbProbeResultTests
    {
        [Fact]
        public void BrainBoardPid_IsDetected()
        {
            UsbProbeResult probe = new UsbProbeResult(true, true, 8508, 2, "usb", "ok");
            Assert.True(probe.IsBrainBoard);
            Assert.False(probe.IsBootloader);
        }

        [Fact]
        public void BootloaderPid_IsDetected()
        {
            UsbProbeResult probe = new UsbProbeResult(true, true, 8508, 153, "usb", "boot");
            Assert.True(probe.IsBootloader);
            Assert.False(probe.IsBrainBoard);
        }
    }

    public class DiagnosticsTests
    {
        private static readonly DateTime T0 = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        [Fact]
        public void FormatTelemetry_IncludesNativeFields()
        {
            BikeTelemetrySnapshot snap = new BikeTelemetrySnapshot(true, true, 4, 78, 126, T0, T0, T0, T0, null);
            string text = Diagnostics.FormatTelemetry(snap);
            Assert.Contains("resistance=4", text);
            Assert.Contains("rpm=78", text);
            Assert.Contains("watts=126", text);
        }

        [Fact]
        public void FormatTelemetry_UnknownIsDash()
        {
            BikeTelemetrySnapshot snap = new BikeTelemetrySnapshot(true, true, null, null, null, null, null, null, T0, null);
            string text = Diagnostics.FormatTelemetry(snap);
            Assert.Contains("resistance=-", text);
            Assert.Contains("rpm=-", text);
            Assert.Contains("watts=-", text);
        }

        [Fact]
        public void FormatMachine_IncludesCapabilityFields()
        {
            MachineInfo machine = new MachineInfo("Bike", "Bike", true, 20, 9, 8, 7);
            string text = Diagnostics.FormatMachine(machine);
            Assert.Contains("canSetResistance=True", text);
            Assert.Contains("maxResistanceLevel=20", text);
        }
    }
}
