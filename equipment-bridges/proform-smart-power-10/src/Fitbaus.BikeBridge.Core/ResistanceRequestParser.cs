using System;
using System.Globalization;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Parses the Phase 3 proof body: {"value":4}
    /// Integer JSON numbers only. Does not write telemetry.
    /// </summary>
    public static class ResistanceRequestParser
    {
        public static bool TryParse(string body, out int value, out string error)
        {
            value = 0;
            if (body == null || body.Trim().Length == 0)
            {
                error = "missing body";
                return false;
            }

            string text = body.Trim();
            if (text.Length < 2 || text[0] != '{' || text[text.Length - 1] != '}')
            {
                error = "malformed json";
                return false;
            }

            string inner = text.Substring(1, text.Length - 2).Trim();
            if (inner.Length == 0)
            {
                error = "missing value";
                return false;
            }

            if (!inner.StartsWith("\"value\"", StringComparison.Ordinal))
            {
                error = "missing value";
                return false;
            }

            string afterKey = inner.Substring(7).TrimStart();
            if (afterKey.Length == 0 || afterKey[0] != ':')
            {
                error = "malformed json";
                return false;
            }

            string raw = afterKey.Substring(1).Trim();
            if (raw.Length == 0)
            {
                error = "missing value";
                return false;
            }

            if (raw.IndexOf(',') >= 0)
            {
                error = "malformed json";
                return false;
            }

            if (!IsJsonInteger(raw))
            {
                error = "value must be an integer";
                return false;
            }

            int parsed;
            if (!int.TryParse(raw, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out parsed))
            {
                error = "value must be an integer";
                return false;
            }

            value = parsed;
            error = null;
            return true;
        }

        private static bool IsJsonInteger(string raw)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return false;
            }

            int i = 0;
            if (raw[0] == '-')
            {
                i = 1;
            }

            if (i >= raw.Length)
            {
                return false;
            }

            for (; i < raw.Length; i++)
            {
                if (raw[i] < '0' || raw[i] > '9')
                {
                    return false;
                }
            }

            return true;
        }
    }
}
