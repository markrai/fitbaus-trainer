using System;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Most recently accepted resistance request. Not telemetry.
    /// </summary>
    public sealed class ResistanceCommandSnapshot
    {
        public ResistanceCommandSnapshot(int? requested, DateTime? requestedAt)
        {
            Requested = requested;
            RequestedAt = requestedAt;
        }

        public int? Requested { get; private set; }

        public DateTime? RequestedAt { get; private set; }
    }

    /// <summary>
    /// Thread-safe owner of last accepted resistance request.
    /// Never writes observed telemetry.
    /// </summary>
    public sealed class ResistanceCommandStore
    {
        private readonly object _gate = new object();
        private int? _requested;
        private DateTime? _requestedAt;

        public ResistanceCommandSnapshot GetSnapshot()
        {
            lock (_gate)
            {
                return new ResistanceCommandSnapshot(_requested, _requestedAt);
            }
        }

        public void RecordAccepted(int requested, DateTime utcNow)
        {
            lock (_gate)
            {
                _requested = requested;
                _requestedAt = utcNow;
            }
        }

        public void Clear()
        {
            lock (_gate)
            {
                _requested = null;
                _requestedAt = null;
            }
        }
    }
}
