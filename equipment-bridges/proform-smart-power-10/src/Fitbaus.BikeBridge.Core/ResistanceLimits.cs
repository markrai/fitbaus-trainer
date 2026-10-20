using System;
using System.Globalization;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Single source of truth for application-accepted integer resistance.
    /// Usable physical range for this ProForm is 1-15. Phase 3 physically
    /// proved writes of 3, 4, 5, 6; that does not limit the API window.
    /// Shire ConsoleInfo.MaxResistanceLevel is not used as the application max.
    /// </summary>
    public static class ResistanceLimits
    {
        public const int MinLevel = 1;

        public const int MaxLevel = 15;

        public static bool TryValidate(int level, out string error)
        {
            if (level < MinLevel || level > MaxLevel)
            {
                error = "value must be an integer from "
                    + MinLevel.ToString(CultureInfo.InvariantCulture)
                    + " to "
                    + MaxLevel.ToString(CultureInfo.InvariantCulture);
                return false;
            }

            error = null;
            return true;
        }
    }
}
