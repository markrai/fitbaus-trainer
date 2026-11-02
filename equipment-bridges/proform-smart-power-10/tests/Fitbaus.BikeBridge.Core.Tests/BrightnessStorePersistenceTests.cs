using System;
using Fitbaus.BikeBridge.Core;
using Xunit;

namespace Fitbaus.BikeBridge.Core.Tests
{
    public class BrightnessStorePersistenceTests
    {
        private static readonly DateTime T0 = new DateTime(2026, 8, 28, 12, 0, 0, DateTimeKind.Utc);

        [Fact]
        public void DefaultConstructor_HasNoPercent()
        {
            BrightnessStore store = new BrightnessStore();
            BrightnessSnapshot snap = store.GetSnapshot();
            Assert.Null(snap.Percent);
            Assert.Null(snap.RequestedAt);
        }

        [Fact]
        public void Construct_HydratesValidPersistedPercentWithoutRequestedAt()
        {
            MemoryBrightnessPersistence persistence = new MemoryBrightnessPersistence();
            persistence.Stored = 42;

            BrightnessStore store = new BrightnessStore(persistence);
            BrightnessSnapshot snap = store.GetSnapshot();

            Assert.Equal(42, snap.Percent);
            Assert.Null(snap.RequestedAt);
        }

        [Theory]
        [InlineData(-1)]
        [InlineData(101)]
        public void Construct_DoesNotHydrateInvalidPersistedPercent(int invalid)
        {
            MemoryBrightnessPersistence persistence = new MemoryBrightnessPersistence();
            persistence.Stored = invalid;

            BrightnessStore store = new BrightnessStore(persistence);
            BrightnessSnapshot snap = store.GetSnapshot();

            Assert.Null(snap.Percent);
            Assert.Null(snap.RequestedAt);
        }

        [Fact]
        public void Record_WritesThroughToPersistence()
        {
            MemoryBrightnessPersistence persistence = new MemoryBrightnessPersistence();
            BrightnessStore store = new BrightnessStore(persistence);

            store.Record(80, T0);

            Assert.Equal(80, persistence.Stored);
            Assert.Equal(1, persistence.SaveCount);
            BrightnessSnapshot snap = store.GetSnapshot();
            Assert.Equal(80, snap.Percent);
            Assert.Equal(T0, snap.RequestedAt);
        }

        [Fact]
        public void NewStore_HydratesLastRecordedValue_SimulatingProcessRestart()
        {
            MemoryBrightnessPersistence persistence = new MemoryBrightnessPersistence();
            BrightnessStore first = new BrightnessStore(persistence);
            first.Record(25, T0);

            BrightnessStore restarted = new BrightnessStore(persistence);
            BrightnessSnapshot snap = restarted.GetSnapshot();

            Assert.Equal(25, snap.Percent);
            Assert.Null(snap.RequestedAt);
        }

        [Fact]
        public void Clear_IsMemoryOnly_DoesNotErasePersistence()
        {
            MemoryBrightnessPersistence persistence = new MemoryBrightnessPersistence();
            BrightnessStore store = new BrightnessStore(persistence);
            store.Record(60, T0);
            store.Clear();

            Assert.Null(store.GetSnapshot().Percent);
            Assert.Equal(60, persistence.Stored);

            BrightnessStore restarted = new BrightnessStore(persistence);
            Assert.Equal(60, restarted.GetSnapshot().Percent);
        }

        private sealed class MemoryBrightnessPersistence : IBrightnessPersistence
        {
            public int? Stored;
            public int SaveCount;

            public bool TryLoad(out int percent)
            {
                if (!Stored.HasValue)
                {
                    percent = 0;
                    return false;
                }

                percent = Stored.Value;
                return true;
            }

            public void Save(int percent)
            {
                Stored = percent;
                SaveCount++;
            }
        }
    }
}
