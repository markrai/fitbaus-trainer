using System;
using System.Collections.Generic;
using System.Reactive.Linq;
using System.Threading;
using System.Threading.Tasks;
using Android.Content;
using Android.Hardware.Usb;
using Fitbaus.BikeBridge.Core;
using MvvmCross.Platform;
using MvvmCross.Platform.IoC;
using Shire.Android.Usb.Connection;
using Shire.Android.Usb.FitPro;
using Shire.Core.FitPro.Console;
using Shire.Core.FitPro.Equipment;
using Shire.Core.Log;
using Shire.Core.Services;
using Shire.Core.Usb.Connection;

namespace Fitbaus.BikeBridge.AndroidApp
{
    /// <summary>
    /// Minimal Wolf-equivalent USB bootstrap:
    /// CustomUsbDevice -> FitProUsbConsoleFactory.Create -> FitProConsole / EquipmentConsole.Init.
    /// Resistance writes go only through IEquipmentConsole.SetResistance.
    /// Does not call FitProConsole.SetResistance (clamps to MaxResistanceLevel),
    /// SetGrade / SetIncline / SetKph / SetValues, raw USB, or bootloader APIs.
    /// _setterGate defensively prevents concurrent hardware setter entry; it does not
    /// own LAN accepted-state. ResistanceCommandCoordinator serializes the LAN
    /// transaction (setter invocation + requested-state recording).
    /// </summary>
    public sealed class ShireRuntimeHost : IDisposable, IResistanceRequestHandler
    {
        private static readonly TimeSpan UsbTimeout = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan InitTimeout = TimeSpan.FromSeconds(30);

        private static bool _runtimeInitialized;
        private readonly Context _context;
        private readonly BikeTelemetryStore _telemetry;
        private readonly Action<BridgeUiState> _onState;
        private readonly TelemetryThrottle _throttle = TelemetryThrottle.Default();
        private readonly object _gate = new object();
        private readonly object _setterGate = new object();
        private readonly ResistanceCommandStore _commands;
        private readonly List<IDisposable> _subscriptions = new List<IDisposable>();

        private CustomUsbDevice _device;
        private IFitProConsole _console;
        private UsbProbeResult _probe = UsbProbeResult.None();
        private BridgeUiState _state = BridgeUiState.Starting();
        private CancellationTokenSource _cts;
        private bool _disposed;

        public ShireRuntimeHost(Context context, BikeTelemetryStore telemetry, Action<BridgeUiState> onState)
            : this(context, telemetry, null, onState)
        {
        }

        public ShireRuntimeHost(
            Context context,
            BikeTelemetryStore telemetry,
            ResistanceCommandStore commands,
            Action<BridgeUiState> onState)
        {
            if (context == null)
            {
                throw new ArgumentNullException("context");
            }

            if (telemetry == null)
            {
                throw new ArgumentNullException("telemetry");
            }

            if (onState == null)
            {
                throw new ArgumentNullException("onState");
            }

            _context = context.ApplicationContext ?? context;
            _telemetry = telemetry;
            _commands = commands ?? new ResistanceCommandStore();
            _onState = onState;
        }

        public void Start()
        {
            Log("Shire host start");
            Log(BridgeControlPolicy.Statement);
            lock (typeof(ShireRuntimeHost))
            {
                if (!_runtimeInitialized)
                {
                    InitializeShireLogger();
                    InitializeRxPlatformServices();
                    InitializeMvxFatality();
                    _runtimeInitialized = true;
                }
                else
                {
                    Log("Shire runtime already initialized in this process");
                }
            }

            _cts = new CancellationTokenSource();
            Task.Run(() => RunAsync(_cts.Token));
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            Log("host dispose / disconnect");
            try
            {
                if (_cts != null)
                {
                    _cts.Cancel();
                }
            }
            catch
            {
            }

            lock (_gate)
            {
                foreach (IDisposable sub in _subscriptions)
                {
                    try
                    {
                        sub.Dispose();
                    }
                    catch
                    {
                    }
                }

                _subscriptions.Clear();

                try
                {
                    if (_console != null)
                    {
                        _console.Dispose();
                    }
                }
                catch (Exception ex)
                {
                    Log("console dispose error: " + ex.Message);
                }

                _console = null;

                try
                {
                    if (_device != null)
                    {
                        _device.Disconnect();
                        _device.Dispose();
                    }
                }
                catch (Exception ex)
                {
                    Log("usb dispose error: " + ex.Message);
                }

                _device = null;
            }

            _telemetry.OnUsbDisconnected();
            _commands.Clear();
            Publish(BridgeStateMapper.Disconnected("host dispose", _telemetry.GetSnapshot()));
        }

        /// <summary>
        /// Defensive hardware entry lock. Callers that also record accepted LAN
        /// state must serialize that recording with this invocation (see
        /// ResistanceCommandCoordinator); this gate does not own requested-state.
        /// </summary>
        public ResistanceRequestOutcome Request(int level)
        {
            lock (_setterGate)
            {
                return RequestLocked(level);
            }
        }

        private ResistanceRequestOutcome RequestLocked(int level)
        {
            string rangeError;
            if (!ResistanceLimits.TryValidate(level, out rangeError))
            {
                Log("resistance request rejected: " + rangeError);
                return ResistanceRequestOutcome.Fail(rangeError);
            }

            IFitProConsole console;
            lock (_gate)
            {
                console = _console;
            }

            if (console == null || !console.IsInitialized)
            {
                Log("resistance setter invocation skipped: console not initialized");
                return ResistanceRequestOutcome.Fail("console not initialized");
            }

            IEquipmentConsole equipment = console.EquipmentConsole;
            if (equipment == null || !equipment.Initialized)
            {
                Log("resistance setter invocation skipped: equipment console unavailable");
                return ResistanceRequestOutcome.Fail("equipment console unavailable");
            }

            IConsoleInfo info = console.ConsoleInfo;
            Log("resistance setter invocation requested=" + level
                + " via=IEquipmentConsole.SetResistance"
                + " canSetResistance=" + (info != null && info.CanSetResistance)
                + " maxResistanceLevel=" + (info != null ? info.MaxResistanceLevel.ToString() : string.Empty)
                + " equipmentInitialized=" + equipment.Initialized);

            try
            {
                equipment.SetResistance((double)level);
            }
            catch (Exception ex)
            {
                Log("resistance setter failure: " + ex);
                return ResistanceRequestOutcome.Fail(ex.Message);
            }

            Log("resistance request accepted requested=" + level);
            return ResistanceRequestOutcome.Ok(level);
        }

        private async Task RunAsync(CancellationToken token)
        {
            try
            {
                _probe = ProbeUsb();
                Log(Diagnostics.FormatUsb(_probe));
                Publish(BridgeStateMapper.FromUsbProbe(_probe, _telemetry.GetSnapshot()));

                if (!_probe.Found || _probe.IsBootloader)
                {
                    return;
                }

                CustomUsbDevice device = new CustomUsbDevice();
                lock (_gate)
                {
                    _device = device;
                }

                TaskCompletionSource<bool> connected = new TaskCompletionSource<bool>();
                IDisposable usbSub = device.WhenConnectionStateChanged.Subscribe(delegate(bool isConnected)
                {
                    Log("USB connection state=" + isConnected);
                    if (isConnected)
                    {
                        connected.TrySetResult(true);
                        OnUsbConnected(device);
                    }
                    else
                    {
                        _telemetry.OnUsbDisconnected();
                        _commands.Clear();
                        Publish(BridgeStateMapper.Disconnected("USB detached", _telemetry.GetSnapshot()));
                    }
                });
                Track(usbSub);

                Log("USB connecting / claiming interface 0");
                device.Connect();

                Task timeout = Task.Delay(UsbTimeout, token);
                Task winner = await Task.WhenAny(connected.Task, timeout).ConfigureAwait(false);
                if (winner != connected.Task)
                {
                    UsbProbeResult again = ProbeUsb();
                    _probe = again;
                    Log("USB connect timeout. " + Diagnostics.FormatUsb(again));
                    if (!again.Found)
                    {
                        Publish(BridgeStateMapper.FromUsbProbe(again, _telemetry.GetSnapshot()));
                    }
                    else if (!again.HasPermission)
                    {
                        Publish(BridgeStateMapper.FromUsbProbe(again, _telemetry.GetSnapshot()));
                    }
                    else
                    {
                        Publish(BridgeStateMapper.ShireFailed(again, "USB claim/connect timed out", _telemetry.GetSnapshot()));
                    }
                }
            }
            catch (Exception ex)
            {
                Log("host error: " + ex);
                Publish(BridgeStateMapper.ShireFailed(_probe, ex.Message, _telemetry.GetSnapshot()));
            }
        }

        private void OnUsbConnected(CustomUsbDevice device)
        {
            try
            {
                _telemetry.OnUsbConnected();
                _probe = ProbeUsb();
                if (_probe.Found && _probe.HasPermission)
                {
                    Publish(BridgeStateMapper.FromUsbProbe(_probe, _telemetry.GetSnapshot()));
                }
                else
                {
                    Publish(new BridgeUiState(
                        BridgeStatus.UsbConnected,
                        BridgeStateMapper.FormatStatus(BridgeStatus.UsbConnected),
                        "Connected",
                        "Not initialized",
                        MachineInfo.Unknown.DisplayName,
                        _telemetry.GetSnapshot(),
                        "USB interface claimed"));
                }

                Log("FitProConsole creation");
                IFitProConsole console = FitProUsbConsoleFactory.Create((IUsbDevice)device);
                lock (_gate)
                {
                    _console = console;
                }

                Publish(BridgeStateMapper.ShireInitializing(_probe, _telemetry.GetSnapshot()));
                Log("console initialization start");

                TaskCompletionSource<IConsoleInfo> initialized = new TaskCompletionSource<IConsoleInfo>();
                IDisposable initSub = console.WhenConsoleInitialized.Take(1).Subscribe(delegate(IConsoleInfo info)
                {
                    initialized.TrySetResult(info);
                    OnConsoleInitialized(info);
                }, delegate(Exception ex)
                {
                    Log("console initialization failed: " + ex);
                    initialized.TrySetException(ex);
                    Publish(BridgeStateMapper.ShireFailed(_probe, ex.Message, _telemetry.GetSnapshot()));
                });
                Track(initSub);

                IDisposable metricSub = console.WhenMetricChanged.Subscribe(delegate(MetricChange change)
                {
                    OnMetricChanged(console, change);
                }, delegate(Exception ex)
                {
                    Log("metric subscription error: " + ex);
                });
                Track(metricSub);

                Task.Run(async delegate
                {
                    Task delay = Task.Delay(InitTimeout);
                    Task done = initialized.Task;
                    Task winner = await Task.WhenAny(done, delay).ConfigureAwait(false);
                    if (winner != done && !initialized.Task.IsCompleted)
                    {
                        Log("console initialization failed: timeout");
                        Publish(BridgeStateMapper.ShireFailed(_probe, "Shire initialization timed out", _telemetry.GetSnapshot()));
                    }
                });
            }
            catch (Exception ex)
            {
                Log("FitProConsole creation/init error: " + ex);
                Publish(BridgeStateMapper.ShireFailed(_probe, ex.Message, _telemetry.GetSnapshot()));
            }
        }

        private void OnConsoleInitialized(IConsoleInfo info)
        {
            try
            {
                Log("console initialization success");
                MachineInfo machine = ToMachineInfo(info);
                _telemetry.OnConsoleInitialized(machine);
                Log(Diagnostics.FormatMachine(machine));
                if (info != null)
                {
                    Log("primary/machine type=" + info.MachineType
                        + " canSetResistance=" + info.CanSetResistance
                        + " maxResistanceLevel=" + info.MaxResistanceLevel
                        + " name=" + info.Name);
                }

                BikeTelemetrySnapshot telemetry = _telemetry.GetSnapshot();
                Log(Diagnostics.FormatTelemetry(telemetry));
                Publish(BridgeStateMapper.ShireReady(_probe, machine, telemetry));
            }
            catch (Exception ex)
            {
                Log("post-init mapping error: " + ex);
                Publish(BridgeStateMapper.ShireFailed(_probe, ex.Message, _telemetry.GetSnapshot()));
            }
        }

        private void OnMetricChanged(IFitProConsole console, MetricChange change)
        {
            if (change == null)
            {
                return;
            }

            if (change.Metric != MetricChange.MetricType.Resistance
                && change.Metric != MetricChange.MetricType.Rpm
                && change.Metric != MetricChange.MetricType.Watts)
            {
                return;
            }

            IConsoleBasicInfo basic = console != null ? console.LatestBasicInfo : null;
            if (basic == null)
            {
                return;
            }

            DateTime now = DateTime.UtcNow;
            int native;
            if (change.Metric == MetricChange.MetricType.Resistance && TryToNativeInt(basic.Resistance, out native))
            {
                _telemetry.OnResistanceObserved(native, now);
            }
            else if (change.Metric == MetricChange.MetricType.Rpm && TryToNativeInt(basic.Rpm, out native))
            {
                _telemetry.OnRpmObserved(native, now);
            }
            else if (change.Metric == MetricChange.MetricType.Watts && TryToNativeInt(basic.Watts, out native))
            {
                _telemetry.OnWattsObserved(native, now);
            }
            else
            {
                return;
            }

            BikeTelemetrySnapshot snapshot = _telemetry.GetSnapshot();
            if (_throttle.ShouldLog(snapshot, now))
            {
                Log(Diagnostics.FormatTelemetry(snapshot));
            }

            if (_throttle.ShouldUpdateUi(snapshot, now))
            {
                Publish(BridgeStateMapper.Streaming(_state, snapshot));
            }
        }

        private static bool TryToNativeInt(double value, out int result)
        {
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                result = 0;
                return false;
            }

            result = Convert.ToInt32(value);
            return true;
        }

        private static MachineInfo ToMachineInfo(IConsoleInfo info)
        {
            if (info == null)
            {
                return MachineInfo.Unknown;
            }

            return new MachineInfo(
                info.Name,
                info.MachineType.ToString(),
                info.CanSetResistance,
                info.MaxResistanceLevel,
                info.ModelNumber,
                info.PartNumber,
                info.SerialNumber);
        }

        private UsbProbeResult ProbeUsb()
        {
            try
            {
                UsbManager usbManager = (UsbManager)_context.GetSystemService("usb");
                if (usbManager == null || usbManager.DeviceList == null)
                {
                    Log("USB discovery: UsbManager unavailable");
                    return UsbProbeResult.None();
                }

                Log("USB discovery: " + usbManager.DeviceList.Count + " device(s)");
                UsbDevice bootloader = null;
                foreach (KeyValuePair<string, UsbDevice> pair in usbManager.DeviceList)
                {
                    UsbDevice device = pair.Value;
                    Log("USB device name=" + device.DeviceName
                        + " vid=" + device.VendorId
                        + " pid=" + device.ProductId
                        + " interfaces=" + device.InterfaceCount
                        + " permission=" + usbManager.HasPermission(device));

                    if (device.VendorId != BikeUsbIds.VendorId)
                    {
                        continue;
                    }

                    if (device.ProductId == BikeUsbIds.BrainBoardProductId)
                    {
                        bool permitted = usbManager.HasPermission(device);
                        return new UsbProbeResult(
                            true,
                            permitted,
                            device.VendorId,
                            device.ProductId,
                            device.DeviceName,
                            permitted ? "brainboard present" : "USB permission required");
                    }

                    if (device.ProductId == BikeUsbIds.BootloaderProductId)
                    {
                        bootloader = device;
                    }
                }

                if (bootloader != null)
                {
                    return new UsbProbeResult(
                        true,
                        usbManager.HasPermission(bootloader),
                        bootloader.VendorId,
                        bootloader.ProductId,
                        bootloader.DeviceName,
                        "bootloader PID detected; Phase 1 will not open it");
                }

                return UsbProbeResult.None();
            }
            catch (Exception ex)
            {
                Log("USB discovery error: " + ex);
                return UsbProbeResult.None();
            }
        }

        private void InitializeShireLogger()
        {
            if (LogInstance.IsInitialized)
            {
                Log("Shire logger already initialized");
                return;
            }

            ConsoleLogger logger = ConsoleLogger.Create(delegate(string line)
            {
                Android.Util.Log.Info(Diagnostics.LogTag, "shire " + line);
            });
            logger.EnableLogTag(LogTag.Usb);
            logger.EnableLogTag(LogTag.Startup);
            logger.EnableLogTag(LogTag.Connection);
            logger.EnableLogTag(LogTag.Workout);
            logger.EnableLogTag(LogTag.Error);
            logger.EnableLogTag(LogTag.Fatal);
            LogInstance.Logger = logger;
            Log("Shire logger initialization complete (ConsoleLogger -> logcat " + Diagnostics.LogTag + ")");
        }

        private static void InitializeRxPlatformServices()
        {
            Type type = Type.GetType("System.Reactive.PlatformServices.CurrentPlatformEnlightenmentProvider, System.Reactive.PlatformServices");
            Log("Rx PlatformServices loaded=" + (type != null));
        }

        private static void InitializeMvxFatality()
        {
            MvxSimpleIoCContainer.Initialize();
            if (!Mvx.CanResolve<IFatalityService>())
            {
                Mvx.RegisterSingleton<IFatalityService>(new FatalityService());
            }

            Log("MvvmCross IFatalityService registered");
        }

        private void Track(IDisposable subscription)
        {
            if (subscription == null)
            {
                return;
            }

            lock (_gate)
            {
                _subscriptions.Add(subscription);
            }
        }

        private void Publish(BridgeUiState state)
        {
            if (state == null)
            {
                return;
            }

            _state = state;
            Log("ui status=" + state.Status + " usb=" + state.UsbText + " shire=" + state.ShireText);
            _onState(state);
        }

        private static void Log(string message)
        {
            Android.Util.Log.Info(Diagnostics.LogTag, message ?? string.Empty);
        }
    }
}
