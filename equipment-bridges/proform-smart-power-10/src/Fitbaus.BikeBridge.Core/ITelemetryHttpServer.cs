using System;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Socket-free surface for the GET-only telemetry listener.
    /// Keeping TcpListener off this type lets early Android JIT load the
    /// runtime shell without resolving System.Net.Sockets.
    /// </summary>
    public interface ITelemetryHttpServer : IDisposable
    {
        bool IsRunning { get; }

        int BoundPort { get; }

        string BoundEndpoint { get; }

        bool TryStart(out string error);

        void Stop();
    }
}
