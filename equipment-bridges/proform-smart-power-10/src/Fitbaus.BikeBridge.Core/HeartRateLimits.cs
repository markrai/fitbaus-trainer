using System.Globalization;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Accepted integer BPM window for display ingest. Not a clinical bound.
    /// </summary>
    public static class HeartRateLimits
    {
        public const int MinBpm = 30;

        public const int MaxBpm = 250;

        public static bool TryValidate(int bpm, out string error)
        {
            if (bpm < MinBpm || bpm > MaxBpm)
            {
                error = "value must be an integer from "
                    + MinBpm.ToString(CultureInfo.InvariantCulture)
                    + " to "
                    + MaxBpm.ToString(CultureInfo.InvariantCulture);
                return false;
            }

            error = null;
            return true;
        }
    }
}
