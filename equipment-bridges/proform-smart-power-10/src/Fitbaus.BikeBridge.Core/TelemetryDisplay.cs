namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Console UI formatting for native measurements.
    /// Unknown is "-" in logs/HTTP helpers and an em dash in the rider grid.
    /// Observed zero is "0". Stable observed values stay numeric for the
    /// current USB session; they do not gain a stale suffix merely because
    /// WhenMetricChanged has not fired again.
    /// </summary>
    public static class TelemetryDisplay
    {
        public const string UnknownPlaceholder = "-";

        /// <summary>
        /// Console rider-grid placeholder. Visually distinct from measured zero.
        /// HTTP/log formatting continues to use <see cref="UnknownPlaceholder"/>.
        /// </summary>
        public const string GridUnknownPlaceholder = "\u2014";

        public static string FormatMetric(int? value)
        {
            if (!value.HasValue)
            {
                return UnknownPlaceholder;
            }

            return value.Value.ToString();
        }

        public static string FormatGridValue(int? value)
        {
            if (!value.HasValue)
            {
                return GridUnknownPlaceholder;
            }

            return value.Value.ToString();
        }

        public static string FormatResistance(BikeTelemetrySnapshot snapshot)
        {
            if (snapshot == null)
            {
                return UnknownPlaceholder;
            }

            return FormatMetric(snapshot.Resistance);
        }

        public static string FormatRpm(BikeTelemetrySnapshot snapshot)
        {
            if (snapshot == null)
            {
                return UnknownPlaceholder;
            }

            if (!snapshot.Rpm.HasValue)
            {
                return UnknownPlaceholder;
            }

            return snapshot.Rpm.Value + " RPM";
        }

        public static string FormatWatts(BikeTelemetrySnapshot snapshot)
        {
            if (snapshot == null)
            {
                return UnknownPlaceholder;
            }

            if (!snapshot.Watts.HasValue)
            {
                return UnknownPlaceholder;
            }

            return snapshot.Watts.Value + " W";
        }
    }
}
