using System;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Listen options for the trusted-LAN HTTP service (telemetry + bounded control).
    /// Trusted local LAN only. Not for public Internet exposure.
    /// </summary>
    public sealed class TelemetryListenOptions
    {
        public const string DefaultAddress = "0.0.0.0";
        public const int DefaultPort = 8765;

        public static readonly TelemetryListenOptions Default = new TelemetryListenOptions(DefaultAddress, DefaultPort);

        public TelemetryListenOptions(string address, int port)
        {
            if (string.IsNullOrEmpty(address))
            {
                throw new ArgumentException("Listen address is required.", "address");
            }

            if (port < 0 || port > 65535)
            {
                throw new ArgumentOutOfRangeException("port", "Port must be 0 (ephemeral) or 1024-65535.");
            }

            if (port > 0 && port < 1024)
            {
                throw new ArgumentOutOfRangeException("port", "Use an unprivileged port in 1024-65535.");
            }

            Address = address;
            Port = port;
        }

        public string Address { get; private set; }

        public int Port { get; private set; }

        public string DisplayEndpoint
        {
            get { return Address + ":" + Port; }
        }
    }
}
