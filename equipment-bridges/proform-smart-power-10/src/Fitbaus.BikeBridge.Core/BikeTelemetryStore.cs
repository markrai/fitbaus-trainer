using System;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Thread-safe owner of current native telemetry. Produces immutable snapshots.
    /// Does not talk to Shire, Android, or the network.
    /// </summary>
    public sealed class BikeTelemetryStore
    {
        private readonly object _gate = new object();
        private readonly Func<DateTime> _utcNow;

        private bool _connected;
        private bool _initialized;
        private int? _resistance;
        private int? _rpm;
        private int? _watts;
        private DateTime? _resistanceObservedAt;
        private DateTime? _rpmObservedAt;
        private DateTime? _wattsObservedAt;
        private MachineInfo _machine;
        private BikeTelemetrySnapshot _current;

        public BikeTelemetryStore()
            : this(null)
        {
        }

        public BikeTelemetryStore(Func<DateTime> utcNow)
        {
            _utcNow = utcNow ?? new Func<DateTime>(GetUtcNow);
            _current = Build(_utcNow());
        }

        public BikeTelemetrySnapshot GetSnapshot()
        {
            lock (_gate)
            {
                return _current;
            }
        }

        public void OnUsbConnected()
        {
            OnUsbConnected(_utcNow());
        }

        public void OnUsbConnected(DateTime utcNow)
        {
            lock (_gate)
            {
                _connected = true;
                _current = Build(utcNow);
            }
        }

        public void OnUsbDisconnected()
        {
            OnUsbDisconnected(_utcNow());
        }

        public void OnUsbDisconnected(DateTime utcNow)
        {
            lock (_gate)
            {
                _connected = false;
                _initialized = false;
                _machine = null;
                ClearMetricsLocked();
                _current = Build(utcNow);
            }
        }

        public void OnConsoleInitialized(MachineInfo machine)
        {
            OnConsoleInitialized(machine, _utcNow());
        }

        public void OnConsoleInitialized(MachineInfo machine, DateTime utcNow)
        {
            lock (_gate)
            {
                _connected = true;
                _initialized = true;
                _machine = machine;
                _current = Build(utcNow);
            }
        }

        public void OnResistanceObserved(int resistance, DateTime utcNow)
        {
            lock (_gate)
            {
                _resistance = resistance;
                _resistanceObservedAt = utcNow;
                _current = Build(utcNow);
            }
        }

        public void OnRpmObserved(int rpm, DateTime utcNow)
        {
            lock (_gate)
            {
                _rpm = rpm;
                _rpmObservedAt = utcNow;
                _current = Build(utcNow);
            }
        }

        public void OnWattsObserved(int watts, DateTime utcNow)
        {
            lock (_gate)
            {
                _watts = watts;
                _wattsObservedAt = utcNow;
                _current = Build(utcNow);
            }
        }

        private void ClearMetricsLocked()
        {
            _resistance = null;
            _rpm = null;
            _watts = null;
            _resistanceObservedAt = null;
            _rpmObservedAt = null;
            _wattsObservedAt = null;
        }

        private BikeTelemetrySnapshot Build(DateTime snapshotAt)
        {
            return new BikeTelemetrySnapshot(
                _connected,
                _initialized,
                _resistance,
                _rpm,
                _watts,
                _resistanceObservedAt,
                _rpmObservedAt,
                _wattsObservedAt,
                snapshotAt,
                _machine);
        }

        private static DateTime GetUtcNow()
        {
            return DateTime.UtcNow;
        }
    }
}
