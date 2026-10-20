using System;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Serializes one LAN resistance transaction: equipment setter plus
    /// accepted-state recording. Mutual exclusion only; simultaneous-request
    /// order is unspecified. Clients should wait for one request to complete
    /// before issuing the next. Does not retry. Does not write telemetry.
    /// </summary>
    public sealed class ResistanceCommandCoordinator
    {
        private readonly IResistanceRequestHandler _handler;
        private readonly ResistanceCommandStore _commands;
        private readonly Func<DateTime> _utcNow;
        private readonly object _gate = new object();

        public ResistanceCommandCoordinator(
            IResistanceRequestHandler handler,
            ResistanceCommandStore commands,
            Func<DateTime> utcNow)
        {
            if (commands == null)
            {
                throw new ArgumentNullException("commands");
            }

            _handler = handler;
            _commands = commands;
            _utcNow = utcNow ?? new Func<DateTime>(GetUtcNow);
        }

        public bool HasSetter
        {
            get { return _handler != null; }
        }

        public ResistanceCommandStore Commands
        {
            get { return _commands; }
        }

        public ResistanceRequestOutcome TryAccept(int level)
        {
            if (_handler == null)
            {
                return ResistanceRequestOutcome.Fail("setter unavailable");
            }

            lock (_gate)
            {
                ResistanceRequestOutcome outcome = _handler.Request(level);
                if (outcome != null && outcome.Accepted)
                {
                    _commands.RecordAccepted(level, _utcNow());
                }

                return outcome;
            }
        }

        private static DateTime GetUtcNow()
        {
            return DateTime.UtcNow;
        }
    }
}
