using System;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Immutable application-owned native machine telemetry.
    /// Unknown measurements are null; observed zero is 0. Not a Shire type.
    /// </summary>
    public sealed class BikeTelemetrySnapshot
    {
        public BikeTelemetrySnapshot(
            bool connected,
            bool initialized,
            int? resistance,
            int? rpm,
            int? watts,
            DateTime? resistanceObservedAt,
            DateTime? rpmObservedAt,
            DateTime? wattsObservedAt,
            DateTime snapshotAt,
            MachineInfo machine)
        {
            Connected = connected;
            Initialized = initialized;
            Resistance = resistance;
            Rpm = rpm;
            Watts = watts;
            ResistanceObservedAt = resistanceObservedAt;
            RpmObservedAt = rpmObservedAt;
            WattsObservedAt = wattsObservedAt;
            SnapshotAt = snapshotAt;
            Machine = machine;
        }

        public bool Connected { get; private set; }

        public bool Initialized { get; private set; }

        public int? Resistance { get; private set; }

        public int? Rpm { get; private set; }

        public int? Watts { get; private set; }

        /// <summary>
        /// Time of the last WhenMetricChanged observation for this field during
        /// the current USB session. Not a QueueManager poll heartbeat.
        /// </summary>
        public DateTime? ResistanceObservedAt { get; private set; }

        /// <summary>
        /// Time of the last WhenMetricChanged observation for this field during
        /// the current USB session. Not a QueueManager poll heartbeat.
        /// </summary>
        public DateTime? RpmObservedAt { get; private set; }

        /// <summary>
        /// Time of the last WhenMetricChanged observation for this field during
        /// the current USB session. Not a QueueManager poll heartbeat.
        /// </summary>
        public DateTime? WattsObservedAt { get; private set; }

        public DateTime SnapshotAt { get; private set; }

        /// <summary>
        /// Capability/identity metadata from IConsoleInfo. Null when unavailable.
        /// Not used to gate telemetry. Not treated as physically authoritative.
        /// </summary>
        public MachineInfo Machine { get; private set; }

        public MetricStatus ResistanceStatus()
        {
            return TelemetryPresence.Classify(Connected, Initialized, Resistance, ResistanceObservedAt);
        }

        public MetricStatus RpmStatus()
        {
            return TelemetryPresence.Classify(Connected, Initialized, Rpm, RpmObservedAt);
        }

        public MetricStatus WattsStatus()
        {
            return TelemetryPresence.Classify(Connected, Initialized, Watts, WattsObservedAt);
        }

        public bool IsResistanceCurrent()
        {
            return ResistanceStatus() == MetricStatus.Current;
        }

        public bool IsRpmCurrent()
        {
            return RpmStatus() == MetricStatus.Current;
        }

        public bool IsWattsCurrent()
        {
            return WattsStatus() == MetricStatus.Current;
        }

        public bool ValuesEqual(BikeTelemetrySnapshot other)
        {
            if (other == null)
            {
                return false;
            }

            return Resistance == other.Resistance
                && Rpm == other.Rpm
                && Watts == other.Watts;
        }
    }
}
