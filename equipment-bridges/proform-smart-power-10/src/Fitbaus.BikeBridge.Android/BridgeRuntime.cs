using System;
using System.Threading;
using Android.App;
using Android.Content;
using Android.Views;
using Fitbaus.BikeBridge.Core;

namespace Fitbaus.BikeBridge.AndroidApp
{
    /// <summary>
    /// UI/telemetry surface used by MainActivity so the Activity type does not
    /// load BridgeRuntime (or sockets) at JNI construction time.
    /// </summary>
    public interface IBridgeUiRuntime
    {
        BikeTelemetryStore Telemetry { get; }

        ResistanceCommandStore Commands { get; }

        HeartRateStore HeartRate { get; }

        BrightnessStore Brightness { get; }

        void AttachDisplay(Activity activity);

        void DetachDisplay(Activity activity);

        void ApplyStoredBrightness();

        void SetUiCallback(Action<BridgeUiState> callback);
    }

    /// <summary>
    /// Process-wide owner of telemetry state, Shire adapter, and the LAN HTTP listener.
    /// Started from MainActivity after the first managed Activity log and SetContentView.
    /// Activity recreation reuses the same process instance and does not bind a second listener.
    /// </summary>
    public sealed class BridgeRuntime : IBridgeUiRuntime
    {
        private static readonly object Gate = new object();
        private static BridgeRuntime _current;

        private readonly object _uiGate = new object();
        private readonly object _hrTimerGate = new object();
        private readonly object _displayGate = new object();
        private readonly Context _appContext;
        private Action<BridgeUiState> _uiCallback;
        private BridgeUiState _latestUi = BridgeUiState.Starting();
        private Timer _hrExpiryTimer;
        private bool _hrExpiryArmed;
        private WeakReference _displayActivity;

        private BridgeRuntime(Context context)
        {
            _appContext = context.ApplicationContext ?? context;
        }

        public BikeTelemetryStore Telemetry { get; private set; }

        public ResistanceCommandStore Commands { get; private set; }

        public HeartRateStore HeartRate { get; private set; }

        public BrightnessStore Brightness { get; private set; }

        public TelemetryHttpResponder Responder { get; private set; }

        public ITelemetryHttpServer Server { get; private set; }

        public ShireRuntimeHost Host { get; private set; }

        public BridgeUiState LatestUi
        {
            get
            {
                lock (_uiGate)
                {
                    return _latestUi;
                }
            }
        }

        public static BridgeRuntime Current
        {
            get { return _current; }
        }

        public static BridgeRuntime EnsureStarted(Context context)
        {
            if (context == null)
            {
                throw new ArgumentNullException("context");
            }

            lock (Gate)
            {
                if (_current == null)
                {
                    _current = new BridgeRuntime(context);
                    _current.Initialize();
                }

                return _current;
            }
        }

        public void SetUiCallback(Action<BridgeUiState> callback)
        {
            BridgeUiState latest;
            lock (_uiGate)
            {
                _uiCallback = callback;
                latest = _latestUi;
            }

            if (callback != null)
            {
                callback(latest);
            }
        }

        public void AttachDisplay(Activity activity)
        {
            lock (_displayGate)
            {
                _displayActivity = activity == null ? null : new WeakReference(activity);
            }

            ApplyStoredBrightness();
        }

        public void DetachDisplay(Activity activity)
        {
            lock (_displayGate)
            {
                Activity current = CurrentDisplayActivity();
                if (current == activity)
                {
                    _displayActivity = null;
                }
            }
        }

        public void ApplyStoredBrightness()
        {
            BrightnessSnapshot snap = Brightness != null ? Brightness.GetSnapshot() : null;
            if (snap == null || !snap.Percent.HasValue)
            {
                return;
            }

            Activity activity;
            lock (_displayGate)
            {
                activity = CurrentDisplayActivity();
            }

            if (activity == null || activity.IsFinishing)
            {
                return;
            }

            float level = BrightnessLimits.ToWindowBrightness(snap.Percent.Value);
            activity.RunOnUiThread(delegate
            {
                ApplyWindowBrightness(activity, level);
            });
        }

        private Activity CurrentDisplayActivity()
        {
            if (_displayActivity == null)
            {
                return null;
            }

            return _displayActivity.Target as Activity;
        }

        private static void ApplyWindowBrightness(Activity activity, float level)
        {
            if (activity == null || activity.IsFinishing || activity.Window == null)
            {
                return;
            }

            WindowManagerLayoutParams attrs = activity.Window.Attributes;
            attrs.ScreenBrightness = level;
            activity.Window.Attributes = attrs;
        }

        private void OnBrightnessAccepted()
        {
            ApplyStoredBrightness();
        }

        private void Initialize()
        {
            Log("BridgeRuntime constructing");
            ConstructTelemetryStore();
            ConstructShireHost();
            ConstructHttpResponder();
            ConstructHttpServerObject();
            StartShire();
            StartHttpListener();
        }

        private void ConstructTelemetryStore()
        {
            Telemetry = new BikeTelemetryStore();
            Commands = new ResistanceCommandStore();
            HeartRate = new HeartRateStore();
            Brightness = new BrightnessStore();
            Log("BikeTelemetryStore constructed");
        }

        private void ConstructShireHost()
        {
            Log("before ShireRuntimeHost construction");
            Host = new ShireRuntimeHost(_appContext, Telemetry, Commands, PublishUi);
        }

        private void ConstructHttpResponder()
        {
            Responder = new TelemetryHttpResponder(
                Telemetry,
                null,
                BridgeInfo.Version,
                Host,
                Commands,
                Log,
                HeartRate,
                OnHeartRateAccepted,
                Brightness,
                OnBrightnessAccepted);
            Log("TelemetryHttpResponder constructed");
        }

        private void ConstructHttpServerObject()
        {
            Server = new TelemetryHttpServer(
                Responder,
                TelemetryListenOptions.Default,
                Log);
            Log("TelemetryHttpServer constructed");
        }

        private void StartShire()
        {
            Log("before Shire Host.Start");
            Host.Start();
        }

        private void StartHttpListener()
        {
            Log("before HTTP TryStart");
            string error;
            if (!Server.TryStart(out error) && !string.IsNullOrEmpty(error))
            {
                Android.Util.Log.Warn(Diagnostics.LogTag, "HTTP service unavailable: " + error);
            }
        }

        private void OnHeartRateAccepted()
        {
            EnsureHeartRateExpiryTimer();
            RepublishLatestUi();
        }

        private void EnsureHeartRateExpiryTimer()
        {
            lock (_hrTimerGate)
            {
                if (_hrExpiryArmed)
                {
                    return;
                }

                _hrExpiryTimer = new Timer(
                    OnHeartRateExpiryTick,
                    null,
                    TimeSpan.FromSeconds(1),
                    TimeSpan.FromSeconds(1));
                _hrExpiryArmed = true;
            }
        }

        private void StopHeartRateExpiryTimer()
        {
            lock (_hrTimerGate)
            {
                if (_hrExpiryTimer != null)
                {
                    _hrExpiryTimer.Dispose();
                    _hrExpiryTimer = null;
                }

                _hrExpiryArmed = false;
            }
        }

        private void OnHeartRateExpiryTick(object state)
        {
            HeartRateSnapshot snap = HeartRate.GetSnapshot();
            if (HeartRateFreshness.IsFresh(snap, DateTime.UtcNow))
            {
                RepublishLatestUi();
                return;
            }

            // Become stale once: publish — then stop the timer until new HR arrives.
            RepublishLatestUi();
            StopHeartRateExpiryTimer();
        }

        private void RepublishLatestUi()
        {
            BridgeUiState latest;
            lock (_uiGate)
            {
                latest = _latestUi;
            }

            PublishUi(latest);
        }

        private void PublishUi(BridgeUiState state)
        {
            if (state == null)
            {
                return;
            }

            Action<BridgeUiState> callback;
            lock (_uiGate)
            {
                _latestUi = state;
                callback = _uiCallback;
            }

            if (callback != null)
            {
                callback(state);
            }
        }

        private static void Log(string line)
        {
            Android.Util.Log.Info(Diagnostics.LogTag, line);
        }
    }
}
