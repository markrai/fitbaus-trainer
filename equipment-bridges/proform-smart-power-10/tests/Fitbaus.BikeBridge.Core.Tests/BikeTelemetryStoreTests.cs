using System;
using System.Threading.Tasks;
using Fitbaus.BikeBridge.Core;
using Xunit;

namespace Fitbaus.BikeBridge.Core.Tests
{
    public class BikeTelemetryStoreTests
    {
        private static readonly DateTime T0 = new DateTime(2026, 8, 28, 0, 0, 0, DateTimeKind.Utc);

        [Fact]
        public void InitialState_IsDisconnectedAndUnobserved()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            BikeTelemetrySnapshot snap = store.GetSnapshot();
            Assert.False(snap.Connected);
            Assert.False(snap.Initialized);
            Assert.Null(snap.Resistance);
            Assert.Null(snap.Rpm);
            Assert.Null(snap.Watts);
            Assert.Null(snap.ResistanceObservedAt);
            Assert.Null(snap.RpmObservedAt);
            Assert.Null(snap.WattsObservedAt);
            Assert.Null(snap.Machine);
        }

        [Fact]
        public void UsbConnect_SetsConnectedWithoutFabricatingMetrics()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            BikeTelemetrySnapshot snap = store.GetSnapshot();
            Assert.True(snap.Connected);
            Assert.False(snap.Initialized);
            Assert.Null(snap.Resistance);
            Assert.Null(snap.Rpm);
            Assert.Null(snap.Watts);
        }

        [Fact]
        public void ConsoleInitialized_DoesNotFabricateMetricValues()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            MachineInfo machine = new MachineInfo("Bike", "Bike", false, 0, 16718, 402450, 3);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(machine, T0);
            BikeTelemetrySnapshot snap = store.GetSnapshot();
            Assert.True(snap.Connected);
            Assert.True(snap.Initialized);
            Assert.Null(snap.Resistance);
            Assert.Null(snap.Rpm);
            Assert.Null(snap.Watts);
            Assert.Equal("Bike", snap.Machine.MachineType);
            Assert.False(snap.Machine.CanSetResistance);
            Assert.Equal(0, snap.Machine.MaxResistanceLevel);
        }

        [Fact]
        public void FirstZeroObservation_IsDistinctFromUnobserved()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            Assert.Null(store.GetSnapshot().Rpm);
            store.OnRpmObserved(0, T0);
            BikeTelemetrySnapshot snap = store.GetSnapshot();
            Assert.Equal(0, snap.Rpm);
            Assert.Equal(T0, snap.RpmObservedAt);
            Assert.Null(snap.Watts);
            Assert.Null(snap.Resistance);
        }

        [Fact]
        public void FirstZeroObservation_AppliesToWattsAndResistance()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnWattsObserved(0, T0);
            store.OnResistanceObserved(0, T0.AddMilliseconds(10));
            BikeTelemetrySnapshot snap = store.GetSnapshot();
            Assert.Equal(0, snap.Watts);
            Assert.Equal(0, snap.Resistance);
            Assert.NotNull(snap.WattsObservedAt);
            Assert.NotNull(snap.ResistanceObservedAt);
        }

        [Fact]
        public void ResistanceObservation_RecordsNativeValue()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnResistanceObserved(5, T0);
            Assert.Equal(5, store.GetSnapshot().Resistance);
        }

        [Fact]
        public void IndependentTimestamps_RpmDoesNotTouchOthers()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            DateTime tRes = T0;
            DateTime tRpm = T0.AddSeconds(1);
            DateTime tWatts = T0.AddSeconds(2);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnResistanceObserved(5, tRes);
            store.OnRpmObserved(56, tRpm);
            store.OnWattsObserved(42, tWatts);
            BikeTelemetrySnapshot snap = store.GetSnapshot();
            Assert.Equal(tRes, snap.ResistanceObservedAt);
            Assert.Equal(tRpm, snap.RpmObservedAt);
            Assert.Equal(tWatts, snap.WattsObservedAt);
        }

        [Fact]
        public void LatestObservationWins()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnRpmObserved(31, T0);
            store.OnRpmObserved(56, T0.AddSeconds(1));
            Assert.Equal(56, store.GetSnapshot().Rpm);
            Assert.Equal(T0.AddSeconds(1), store.GetSnapshot().RpmObservedAt);
        }

        [Fact]
        public void Disconnect_ClearsLiveMetrics()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(new MachineInfo("Bike", "Bike", false, 0, 1, 2, 3), T0);
            store.OnRpmObserved(56, T0);
            store.OnWattsObserved(42, T0);
            store.OnUsbDisconnected(T0.AddSeconds(3));
            BikeTelemetrySnapshot snap = store.GetSnapshot();
            Assert.False(snap.Connected);
            Assert.False(snap.Initialized);
            Assert.Null(snap.Resistance);
            Assert.Null(snap.Rpm);
            Assert.Null(snap.Watts);
            Assert.Null(snap.RpmObservedAt);
            Assert.Null(snap.WattsObservedAt);
            Assert.Null(snap.ResistanceObservedAt);
            Assert.Null(snap.Machine);
            Assert.Equal(MetricStatus.Unobserved, snap.RpmStatus());
            Assert.False(snap.IsRpmCurrent());
        }

        [Fact]
        public void ObservedZero_IsCurrentWhileConnected()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnRpmObserved(0, T0);
            store.OnWattsObserved(0, T0);
            store.OnResistanceObserved(0, T0);
            BikeTelemetrySnapshot snap = store.GetSnapshot();
            Assert.Equal(0, snap.Rpm);
            Assert.True(snap.IsRpmCurrent());
            Assert.True(snap.IsWattsCurrent());
            Assert.True(snap.IsResistanceCurrent());
        }

        [Fact]
        public void StableValue_DoesNotExpireAfterMinutes()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnResistanceObserved(5, T0);
            store.OnRpmObserved(56, T0);
            store.OnWattsObserved(42, T0);
            BikeTelemetrySnapshot snap = store.GetSnapshot();
            DateTime[] later = { T0.AddSeconds(2), T0.AddSeconds(30), T0.AddMinutes(10) };
            for (int i = 0; i < later.Length; i++)
            {
                Assert.Equal(5, snap.Resistance);
                Assert.Equal(T0, snap.ResistanceObservedAt);
                Assert.True(snap.IsResistanceCurrent());
                Assert.True(snap.IsRpmCurrent());
                Assert.True(snap.IsWattsCurrent());
                Assert.Equal(MetricStatus.Current, snap.ResistanceStatus());
            }
        }

        [Fact]
        public void Unobserved_IsNotCurrent()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            BikeTelemetrySnapshot snap = store.GetSnapshot();
            Assert.Null(snap.Rpm);
            Assert.Equal(MetricStatus.Unobserved, snap.RpmStatus());
            Assert.False(snap.IsRpmCurrent());
        }

        [Fact]
        public void Reconnect_DoesNotResurrectOldObservations()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnResistanceObserved(5, T0);
            store.OnRpmObserved(56, T0);
            store.OnWattsObserved(42, T0);
            store.OnUsbDisconnected(T0.AddSeconds(1));
            store.OnUsbConnected(T0.AddSeconds(2));
            store.OnConsoleInitialized(new MachineInfo("Bike", "Bike", false, 0, 16718, 402450, 3), T0.AddSeconds(3));
            BikeTelemetrySnapshot snap = store.GetSnapshot();
            Assert.True(snap.Connected);
            Assert.True(snap.Initialized);
            Assert.Null(snap.Resistance);
            Assert.Null(snap.Rpm);
            Assert.Null(snap.Watts);
            Assert.Null(snap.ResistanceObservedAt);
            Assert.Null(snap.RpmObservedAt);
            Assert.Null(snap.WattsObservedAt);
            Assert.False(snap.IsResistanceCurrent());
            Assert.False(snap.IsRpmCurrent());
            Assert.False(snap.IsWattsCurrent());
        }

        [Fact]
        public void SnapshotIsolation_PreviousSnapshotDoesNotMutate()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnRpmObserved(10, T0);
            BikeTelemetrySnapshot first = store.GetSnapshot();
            store.OnRpmObserved(20, T0.AddSeconds(1));
            Assert.Equal(10, first.Rpm);
            Assert.Equal(20, store.GetSnapshot().Rpm);
        }

        [Fact]
        public async Task ConcurrentUpdatesAndReads_RemainCoherent()
        {
            BikeTelemetryStore store = new BikeTelemetryStore();
            store.OnUsbConnected();
            store.OnConsoleInitialized(null);
            Task[] tasks = new Task[8];
            for (int i = 0; i < tasks.Length; i++)
            {
                int seed = i;
                tasks[i] = Task.Run(() =>
                {
                    for (int n = 0; n < 200; n++)
                    {
                        DateTime now = DateTime.UtcNow;
                        if (n % 3 == 0)
                        {
                            store.OnRpmObserved(seed + n, now);
                        }
                        else if (n % 3 == 1)
                        {
                            store.OnWattsObserved(seed, now);
                        }
                        else
                        {
                            BikeTelemetrySnapshot snap = store.GetSnapshot();
                            Assert.True(snap.Initialized);
                            Assert.True(snap.Connected);
                        }
                    }
                });
            }

            await Task.WhenAll(tasks);
            BikeTelemetrySnapshot finalSnap = store.GetSnapshot();
            Assert.True(finalSnap.Connected);
            Assert.True(finalSnap.Initialized);
            Assert.True(finalSnap.Rpm.HasValue || finalSnap.Watts.HasValue);
        }
    }

    public class TelemetryDisplayTests
    {
        private static readonly DateTime T0 = new DateTime(2026, 8, 28, 0, 0, 0, DateTimeKind.Utc);

        [Fact]
        public void Unknown_DisplaysDashNotZero()
        {
            Assert.Equal("-", TelemetryDisplay.FormatMetric(null));
            BikeTelemetrySnapshot snap = new BikeTelemetrySnapshot(true, true, null, null, null, null, null, null, T0, null);
            Assert.Equal("-", TelemetryDisplay.FormatResistance(snap));
            Assert.Equal("-", TelemetryDisplay.FormatRpm(snap));
            Assert.Equal("-", TelemetryDisplay.FormatWatts(snap));
            Assert.Equal(TelemetryDisplay.GridUnknownPlaceholder, TelemetryDisplay.FormatGridValue(null));
            Assert.NotEqual("0", TelemetryDisplay.FormatGridValue(null));
        }

        [Fact]
        public void ObservedZero_DisplaysZero()
        {
            Assert.Equal("0", TelemetryDisplay.FormatMetric(0));
            BikeTelemetrySnapshot snap = new BikeTelemetrySnapshot(true, true, 0, 0, 0, T0, T0, T0, T0, null);
            Assert.Equal("0", TelemetryDisplay.FormatResistance(snap));
            Assert.Equal("0 RPM", TelemetryDisplay.FormatRpm(snap));
            Assert.Equal("0 W", TelemetryDisplay.FormatWatts(snap));
            Assert.Equal("0", TelemetryDisplay.FormatGridValue(0));
        }

        [Fact]
        public void GridValue_MultiDigitDoesNotAddUnits()
        {
            Assert.Equal("123", TelemetryDisplay.FormatGridValue(123));
            Assert.Equal("15", TelemetryDisplay.FormatGridValue(15));
        }

        [Fact]
        public void StableObservedValues_DoNotGainStaleSuffix()
        {
            BikeTelemetrySnapshot snap = new BikeTelemetrySnapshot(true, true, 5, 56, 42, T0, T0, T0, T0, null);
            Assert.Equal("5", TelemetryDisplay.FormatResistance(snap));
            Assert.Equal("56 RPM", TelemetryDisplay.FormatRpm(snap));
            Assert.Equal("42 W", TelemetryDisplay.FormatWatts(snap));
        }
    }
}
