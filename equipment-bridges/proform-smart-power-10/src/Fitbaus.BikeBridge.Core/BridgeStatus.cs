using System;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Operator-visible connection/initialization states for the console UI.
    /// </summary>
    public enum BridgeStatus
    {
        Starting,
        UsbDeviceNotFound,
        UsbPermissionRequired,
        UsbConnected,
        ShireInitializing,
        ShireInitializationFailed,
        ShireInitialized,
        StreamingTelemetry,
        ConsoleDisconnected
    }
}
