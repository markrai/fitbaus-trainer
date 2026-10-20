using System.Globalization;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Accepted integer percent window for console screen brightness.
    /// Window brightness is this Activity only; 0 is mapped to a tiny non-zero
    /// so the OEM does not black out the display.
    /// </summary>
    public static class BrightnessLimits
    {
        public const int MinPercent = 0;

        public const int MaxPercent = 100;

        public const float MinimumWindowBrightness = 0.01f;

        public static bool TryValidate(int percent, out string error)
        {
            if (percent < MinPercent || percent > MaxPercent)
            {
                error = "value must be an integer from "
                    + MinPercent.ToString(CultureInfo.InvariantCulture)
                    + " to "
                    + MaxPercent.ToString(CultureInfo.InvariantCulture);
                return false;
            }

            error = null;
            return true;
        }

        public static float ToWindowBrightness(int percent)
        {
            if (percent <= MinPercent)
            {
                return MinimumWindowBrightness;
            }

            if (percent >= MaxPercent)
            {
                return 1f;
            }

            float level = percent / 100f;
            return level < MinimumWindowBrightness ? MinimumWindowBrightness : level;
        }
    }
}
