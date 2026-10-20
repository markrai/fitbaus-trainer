using System;
using Fitbaus.BikeBridge.Core;
using Xunit;

namespace Fitbaus.BikeBridge.Core.Tests
{
    public class TelemetryThrottleTests
    {
        private static readonly DateTime T0 = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        [Fact]
        public void FirstSnapshot_UpdatesUiAndLog()
        {
            TelemetryThrottle throttle = TelemetryThrottle.Default();
            BikeTelemetrySnapshot snap = Observed(4, 0, 0);
            Assert.True(throttle.ShouldUpdateUi(snap, T0));
            Assert.True(throttle.ShouldLog(snap, T0));
        }

        [Fact]
        public void UnchangedSnapshot_DoesNotUpdateUi()
        {
            TelemetryThrottle throttle = TelemetryThrottle.Default();
            BikeTelemetrySnapshot snap = Observed(4, 10, 20);
            Assert.True(throttle.ShouldUpdateUi(snap, T0));
            Assert.False(throttle.ShouldUpdateUi(snap, T0.AddMilliseconds(500)));
        }

        [Fact]
        public void RapidChanges_AreCoalescedForUi()
        {
            TelemetryThrottle throttle = new TelemetryThrottle(TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(200));
            Assert.True(throttle.ShouldUpdateUi(Observed(4, 10, 20), T0));
            Assert.False(throttle.ShouldUpdateUi(Observed(4, 11, 22), T0.AddMilliseconds(50)));
            Assert.True(throttle.ShouldUpdateUi(Observed(4, 12, 24), T0.AddMilliseconds(200)));
        }

        [Fact]
        public void RapidChanges_AreCoalescedForLog()
        {
            TelemetryThrottle throttle = new TelemetryThrottle(TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(200));
            Assert.True(throttle.ShouldLog(Observed(4, 10, 20), T0));
            Assert.False(throttle.ShouldLog(Observed(4, 40, 80), T0.AddMilliseconds(200)));
            Assert.True(throttle.ShouldLog(Observed(4, 50, 90), T0.AddSeconds(1)));
        }

        [Fact]
        public void StaticValues_EmitLogHeartbeatAfterInterval()
        {
            TelemetryThrottle throttle = new TelemetryThrottle(TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(200));
            BikeTelemetrySnapshot snap = Observed(4, 0, 0);
            Assert.True(throttle.ShouldLog(snap, T0));
            Assert.False(throttle.ShouldLog(snap, T0.AddMilliseconds(200)));
            Assert.True(throttle.ShouldLog(snap, T0.AddSeconds(1)));
        }

        [Fact]
        public void NullSnapshot_IsIgnored()
        {
            TelemetryThrottle throttle = TelemetryThrottle.Default();
            Assert.False(throttle.ShouldUpdateUi(null, DateTime.UtcNow));
            Assert.False(throttle.ShouldLog(null, DateTime.UtcNow));
        }

        private static BikeTelemetrySnapshot Observed(int resistance, int rpm, int watts)
        {
            return new BikeTelemetrySnapshot(true, true, resistance, rpm, watts, T0, T0, T0, T0, null);
        }
    }
}
