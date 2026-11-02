using System;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Most recently accepted console brightness request. Not bike telemetry.
    /// </summary>
    public sealed class BrightnessSnapshot
    {
        public BrightnessSnapshot(int? percent, DateTime? requestedAt)
        {
            Percent = percent;
            RequestedAt = requestedAt;
        }

        public int? Percent { get; private set; }

        public DateTime? RequestedAt { get; private set; }
    }

    /// <summary>
    /// Thread-safe owner of last accepted console brightness.
    /// Never writes BikeTelemetryStore or resistance state.
    /// Optional persistence hydrates across process restarts.
    /// </summary>
    public sealed class BrightnessStore
    {
        private readonly object _gate = new object();
        private readonly IBrightnessPersistence _persistence;
        private int? _percent;
        private DateTime? _requestedAt;

        public BrightnessStore()
            : this(null)
        {
        }

        public BrightnessStore(IBrightnessPersistence persistence)
        {
            _persistence = persistence;
            HydrateFromPersistence();
        }

        public BrightnessSnapshot GetSnapshot()
        {
            lock (_gate)
            {
                return new BrightnessSnapshot(_percent, _requestedAt);
            }
        }

        public void Record(int percent, DateTime utcNow)
        {
            lock (_gate)
            {
                _percent = percent;
                _requestedAt = utcNow.Kind == DateTimeKind.Utc
                    ? utcNow
                    : utcNow.ToUniversalTime();
                PersistUnlocked(percent);
            }
        }

        public void Clear()
        {
            lock (_gate)
            {
                _percent = null;
                _requestedAt = null;
            }
        }

        private void HydrateFromPersistence()
        {
            if (_persistence == null)
            {
                return;
            }

            int percent;
            if (!_persistence.TryLoad(out percent))
            {
                return;
            }

            string error;
            if (!BrightnessLimits.TryValidate(percent, out error))
            {
                return;
            }

            _percent = percent;
        }

        private void PersistUnlocked(int percent)
        {
            if (_persistence == null)
            {
                return;
            }

            _persistence.Save(percent);
        }
    }
}
