using System;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Coalesces high-frequency Shire metric events for UI/logcat without changing
    /// Shire's own 100 ms periodic poll or the telemetry store update rate.
    /// </summary>
    public sealed class TelemetryThrottle
    {
        private readonly TimeSpan _minLogInterval;
        private readonly TimeSpan _minUiInterval;
        private DateTime _lastLogUtc = DateTime.MinValue;
        private DateTime _lastUiUtc = DateTime.MinValue;
        private BikeTelemetrySnapshot _lastLogged;
        private BikeTelemetrySnapshot _lastUi;

        public TelemetryThrottle(TimeSpan minLogInterval, TimeSpan minUiInterval)
        {
            _minLogInterval = minLogInterval;
            _minUiInterval = minUiInterval;
        }

        public static TelemetryThrottle Default()
        {
            return new TelemetryThrottle(TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(200));
        }

        public bool ShouldUpdateUi(BikeTelemetrySnapshot snapshot, DateTime utcNow)
        {
            if (snapshot == null)
            {
                return false;
            }

            if (_lastUi != null && _lastUi.ValuesEqual(snapshot))
            {
                return false;
            }

            if (_lastUiUtc != DateTime.MinValue && utcNow - _lastUiUtc < _minUiInterval)
            {
                return false;
            }

            _lastUi = snapshot;
            _lastUiUtc = utcNow;
            return true;
        }

        public bool ShouldLog(BikeTelemetrySnapshot snapshot, DateTime utcNow)
        {
            if (snapshot == null)
            {
                return false;
            }

            bool changed = _lastLogged == null || !_lastLogged.ValuesEqual(snapshot);
            if (!changed && utcNow - _lastLogUtc < _minLogInterval)
            {
                return false;
            }

            if (changed && _lastLogUtc != DateTime.MinValue && utcNow - _lastLogUtc < _minLogInterval)
            {
                return false;
            }

            _lastLogged = snapshot;
            _lastLogUtc = utcNow;
            return true;
        }
    }
}
