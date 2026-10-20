using System;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Most recently ingested external heart-rate observation. Not bike telemetry.
    /// Freshness is evaluated by HeartRateFreshness; this store only holds values.
    /// </summary>
    public sealed class HeartRateSnapshot
    {
        public HeartRateSnapshot(int? bpm, DateTime? observedAt)
        {
            Bpm = bpm;
            ObservedAt = observedAt;
        }

        public int? Bpm { get; private set; }

        public DateTime? ObservedAt { get; private set; }
    }

    /// <summary>
    /// Thread-safe owner of last accepted external heart-rate ingest.
    /// Never writes BikeTelemetryStore or resistance state.
    /// </summary>
    public sealed class HeartRateStore
    {
        private readonly object _gate = new object();
        private int? _bpm;
        private DateTime? _observedAt;

        public HeartRateSnapshot GetSnapshot()
        {
            lock (_gate)
            {
                return new HeartRateSnapshot(_bpm, _observedAt);
            }
        }

        public void Record(int bpm, DateTime utcNow)
        {
            lock (_gate)
            {
                _bpm = bpm;
                _observedAt = utcNow.Kind == DateTimeKind.Utc
                    ? utcNow
                    : utcNow.ToUniversalTime();
            }
        }

        public void Clear()
        {
            lock (_gate)
            {
                _bpm = null;
                _observedAt = null;
            }
        }
    }
}
