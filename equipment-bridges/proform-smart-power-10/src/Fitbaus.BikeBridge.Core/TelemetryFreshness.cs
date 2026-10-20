using System;

namespace Fitbaus.BikeBridge.Core
{
    public enum MetricStatus
    {
        Unobserved,
        Current
    }

    /// <summary>
    /// Session-current policy for native Resistance / RPM / Watts.
    /// A genuine observation stays current for the connected+initialized USB
    /// session even if WhenMetricChanged does not fire again. ObservedAt is the
    /// last change/observation event, not a 100 ms poll heartbeat. Disconnect
    /// clears values. There is no elapsed-time stale timeout.
    /// </summary>
    public static class TelemetryPresence
    {
        public static MetricStatus Classify(
            bool connected,
            bool initialized,
            int? value,
            DateTime? observedAtUtc)
        {
            if (!connected || !initialized || !value.HasValue || !observedAtUtc.HasValue)
            {
                return MetricStatus.Unobserved;
            }

            return MetricStatus.Current;
        }

        public static bool IsCurrent(
            bool connected,
            bool initialized,
            int? value,
            DateTime? observedAtUtc)
        {
            return Classify(connected, initialized, value, observedAtUtc) == MetricStatus.Current;
        }
    }
}
