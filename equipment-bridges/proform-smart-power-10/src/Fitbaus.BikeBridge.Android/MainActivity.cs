using System;
using Android.App;
using Android.Content.PM;
using Android.Graphics;
using Android.OS;
using Android.Views;
using Android.Widget;
using Fitbaus.BikeBridge.Core;

namespace Fitbaus.BikeBridge.AndroidApp
{
    [Activity(
        Label = "FitBaus Bike Bridge",
        MainLauncher = true,
        Theme = "@android:style/Theme.DeviceDefault.NoActionBar",
        ScreenOrientation = ScreenOrientation.Landscape,
        ConfigurationChanges = ConfigChanges.Orientation | ConfigChanges.ScreenSize | ConfigChanges.KeyboardHidden)]
    public class MainActivity : Activity
    {
        private static readonly Color Background = Color.Black;
        private static readonly Color Primary = Color.White;
        private static readonly Color LabelColor = Color.Rgb(180, 180, 180);
        private static readonly Color Mute = Color.Rgb(140, 140, 140);
        private static readonly Color Divider = Color.Rgb(48, 48, 48);
        private static readonly Color RpmColor = Color.Rgb(255, 0, 255);
        private static readonly Color WattsColor = Color.Rgb(0, 150, 255);
        private static readonly Color ResistanceColor = Color.Rgb(255, 140, 0);
        private static readonly Color HrColor = Color.Rgb(255, 40, 40);

        private TextView _rpmValue;
        private TextView _wattsValue;
        private TextView _resistanceValue;
        private TextView _hrValue;
        private TextView _statusValue;
        private TextView _usbValue;
        private TextView _shireValue;
        private TextView _bikeValue;
        private TextView _controlValue;
        private TextView _requestedValue;
        private TextView _observedValue;
        private TextView _machineValue;
        private TextView _bridgeValue;
        private TextView _httpValue;
        private IBridgeUiRuntime _runtime;

        protected override void OnCreate(Bundle savedInstanceState)
        {
            base.OnCreate(savedInstanceState);
            Android.Util.Log.Info(Diagnostics.LogTag, "main activity onCreate");
            SetContentView(BuildUi());
            Android.Util.Log.Info(Diagnostics.LogTag, "before BridgeRuntime.EnsureStarted");
            StartBridgeRuntime();
        }

        protected override void OnResume()
        {
            base.OnResume();
            if (_runtime != null)
            {
                _runtime.ApplyStoredBrightness();
            }

            BindHttpEndpoint();
        }

        private void StartBridgeRuntime()
        {
            _runtime = BridgeRuntime.EnsureStarted(this);
            _runtime.SetUiCallback(ApplyState);
            _runtime.AttachDisplay(this);
        }

        protected override void OnDestroy()
        {
            Android.Util.Log.Info(Diagnostics.LogTag, "main activity onDestroy");
            if (_runtime != null)
            {
                _runtime.DetachDisplay(this);
                _runtime.SetUiCallback(null);
            }

            base.OnDestroy();
        }

        private void ApplyState(BridgeUiState state)
        {
            if (state == null)
            {
                return;
            }

            RunOnUiThread(delegate
            {
                BikeTelemetrySnapshot telemetry = _runtime != null
                    ? _runtime.Telemetry.GetSnapshot()
                    : state.Telemetry;
                int? requested = null;
                if (_runtime != null && _runtime.Commands != null)
                {
                    requested = _runtime.Commands.GetSnapshot().Requested;
                }

                BindGridValue(_rpmValue, telemetry != null ? telemetry.Rpm : null, RpmColor);
                BindGridValue(_wattsValue, telemetry != null ? telemetry.Watts : null, WattsColor);
                BindGridValue(_resistanceValue, telemetry != null ? telemetry.Resistance : null, ResistanceColor);
                BindGridValue(_hrValue, DisplayHeartRateBpm(), HrColor);

                string status = state.StatusText;
                if (!string.IsNullOrEmpty(state.Detail) && state.Status != BridgeStatus.StreamingTelemetry)
                {
                    status = state.StatusText + " - " + state.Detail;
                }

                _statusValue.Text = status;
                _usbValue.Text = state.UsbText;
                _shireValue.Text = state.ShireText;
                _bikeValue.Text = FormatBike(telemetry);
                _controlValue.Text = FormatControl(telemetry);
                _requestedValue.Text = TelemetryDisplay.FormatGridValue(requested);
                _observedValue.Text = TelemetryDisplay.FormatGridValue(
                    telemetry != null ? telemetry.Resistance : null);
                _machineValue.Text = state.MachineText;
                _bridgeValue.Text = BridgeInfo.Version;
                BindHttpEndpoint();
            });
        }

        private void BindHttpEndpoint()
        {
            if (_httpValue == null)
            {
                return;
            }

            _httpValue.Text = LanEndpointDisplay.Format(TelemetryListenOptions.Default.Port);
        }

        private int? DisplayHeartRateBpm()
        {
            if (_runtime == null || _runtime.HeartRate == null)
            {
                return null;
            }

            return HeartRateFreshness.DisplayBpm(_runtime.HeartRate.GetSnapshot(), DateTime.UtcNow);
        }

        private static void BindGridValue(TextView view, int? value, Color live)
        {
            view.Text = TelemetryDisplay.FormatGridValue(value);
            view.SetTextColor(value.HasValue ? live : Mute);
        }

        private static string FormatBike(BikeTelemetrySnapshot telemetry)
        {
            bool connected = telemetry != null && telemetry.Connected;
            bool initialized = telemetry != null && telemetry.Initialized;
            return (connected ? "Connected" : "Not connected")
                + " / "
                + (initialized ? "Initialized" : "Not initialized");
        }

        private static string FormatControl(BikeTelemetrySnapshot telemetry)
        {
            if (telemetry != null && telemetry.Connected && telemetry.Initialized)
            {
                return "Available";
            }

            return "Unavailable";
        }

        private View BuildUi()
        {
            LinearLayout root = new LinearLayout(this);
            root.Orientation = Orientation.Vertical;
            root.SetBackgroundColor(Background);
            int pad = Dp(16);
            root.SetPadding(pad, Dp(10), pad, Dp(10));

            TextView title = Label("FITBAUS", 16, Primary);
            title.SetTypeface(Typeface.DefaultBold, TypefaceStyle.Bold);
            title.LetterSpacing = 0.18f;
            LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MatchParent,
                ViewGroup.LayoutParams.WrapContent);
            titleLp.BottomMargin = Dp(4);
            title.LayoutParameters = titleLp;
            root.AddView(title);

            root.AddView(BuildStatGrid(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MatchParent,
                0,
                1f));

            View rule = new View(this);
            rule.SetBackgroundColor(Divider);
            LinearLayout.LayoutParams ruleLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MatchParent,
                Dp(1));
            ruleLp.TopMargin = Dp(8);
            ruleLp.BottomMargin = Dp(8);
            root.AddView(rule, ruleLp);

            root.AddView(BuildDiagnostics());

            ApplyState(BridgeUiState.Starting());
            return root;
        }

        private View BuildStatGrid()
        {
            LinearLayout grid = new LinearLayout(this);
            grid.Orientation = Orientation.Horizontal;
            grid.SetGravity(GravityFlags.CenterVertical);

            float valueSp = GridValueSp();
            float labelSp = 16f;
            _rpmValue = AddStatTile(grid, "RPM", valueSp, labelSp, true);
            _wattsValue = AddStatTile(grid, "WATTS", valueSp, labelSp, true);
            _resistanceValue = AddStatTile(grid, "RESISTANCE", valueSp, labelSp, true);
            _hrValue = AddStatTile(grid, "HR", valueSp, labelSp, false);
            return grid;
        }

        private TextView AddStatTile(
            LinearLayout grid,
            string caption,
            float valueSp,
            float labelSp,
            bool showDivider)
        {
            LinearLayout tile = new LinearLayout(this);
            tile.Orientation = Orientation.Vertical;
            tile.SetGravity(GravityFlags.Center);
            LinearLayout.LayoutParams tileLp = new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.MatchParent,
                1f);
            tile.LayoutParameters = tileLp;

            TextView value = Label(TelemetryDisplay.GridUnknownPlaceholder, valueSp, Mute);
            value.SetTypeface(Typeface.Monospace, TypefaceStyle.Bold);
            value.SetIncludeFontPadding(false);
            value.Gravity = GravityFlags.Center;
            value.SetMaxLines(1);
            tile.AddView(value);

            TextView label = Label(caption, labelSp, LabelColor);
            label.SetTypeface(Typeface.DefaultBold, TypefaceStyle.Normal);
            label.Gravity = GravityFlags.CenterHorizontal;
            label.SetIncludeFontPadding(false);
            LinearLayout.LayoutParams labelLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WrapContent,
                ViewGroup.LayoutParams.WrapContent);
            labelLp.TopMargin = Dp(6);
            labelLp.Gravity = GravityFlags.CenterHorizontal;
            tile.AddView(label, labelLp);

            grid.AddView(tile);

            if (showDivider)
            {
                View divider = new View(this);
                divider.SetBackgroundColor(Divider);
                grid.AddView(divider, new LinearLayout.LayoutParams(
                    Dp(1),
                    ViewGroup.LayoutParams.MatchParent));
            }

            return value;
        }

        private View BuildDiagnostics()
        {
            LinearLayout block = new LinearLayout(this);
            block.Orientation = Orientation.Vertical;
            block.LayoutParameters = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MatchParent,
                ViewGroup.LayoutParams.WrapContent);

            TextView heading = Label("DIAGNOSTICS", 11, Mute);
            heading.SetTypeface(Typeface.DefaultBold, TypefaceStyle.Bold);
            heading.LetterSpacing = 0.12f;
            LinearLayout.LayoutParams headingLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MatchParent,
                ViewGroup.LayoutParams.WrapContent);
            headingLp.BottomMargin = Dp(4);
            heading.LayoutParameters = headingLp;
            block.AddView(heading);

            LinearLayout columns = new LinearLayout(this);
            columns.Orientation = Orientation.Horizontal;

            LinearLayout left = new LinearLayout(this);
            left.Orientation = Orientation.Vertical;
            LinearLayout right = new LinearLayout(this);
            right.Orientation = Orientation.Vertical;
            LinearLayout.LayoutParams colLp = new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WrapContent,
                1f);
            left.LayoutParameters = colLp;
            LinearLayout.LayoutParams rightLp = new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WrapContent,
                1f);
            rightLp.LeftMargin = Dp(16);
            right.LayoutParameters = rightLp;

            _statusValue = AddDiagRow(left, "STATUS");
            _usbValue = AddDiagRow(left, "USB");
            _shireValue = AddDiagRow(left, "SHIRE");
            _bikeValue = AddDiagRow(left, "BIKE");
            _controlValue = AddDiagRow(left, "CONTROL");

            _requestedValue = AddDiagRow(right, "REQUESTED");
            _observedValue = AddDiagRow(right, "OBSERVED");
            _machineValue = AddDiagRow(right, "MACHINE");
            _bridgeValue = AddDiagRow(right, "BRIDGE");
            _httpValue = AddDiagRow(right, "HTTP");

            columns.AddView(left);
            columns.AddView(right);
            block.AddView(columns);
            return block;
        }

        private TextView AddDiagRow(LinearLayout column, string caption)
        {
            LinearLayout row = new LinearLayout(this);
            row.Orientation = Orientation.Horizontal;
            row.SetGravity(GravityFlags.CenterVertical);
            LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MatchParent,
                ViewGroup.LayoutParams.WrapContent);
            rowLp.BottomMargin = Dp(2);
            row.LayoutParameters = rowLp;

            TextView cap = Label(caption, 12, Mute);
            cap.SetTypeface(Typeface.DefaultBold, TypefaceStyle.Normal);
            LinearLayout.LayoutParams capLp = new LinearLayout.LayoutParams(
                Dp(108),
                ViewGroup.LayoutParams.WrapContent);
            cap.LayoutParameters = capLp;
            row.AddView(cap);

            TextView value = Label(TelemetryDisplay.GridUnknownPlaceholder, 12, Primary);
            value.SetTypeface(Typeface.Monospace, TypefaceStyle.Normal);
            value.SetMaxLines(2);
            row.AddView(value, new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WrapContent,
                1f));

            column.AddView(row);
            return value;
        }

        private TextView Label(string text, float sizeSp, Color color)
        {
            TextView view = new TextView(this);
            view.Text = text;
            view.TextSize = sizeSp;
            view.SetTextColor(color);
            return view;
        }

        private float GridValueSp()
        {
            float density = Resources.DisplayMetrics.Density;
            if (density <= 0f)
            {
                density = 1f;
            }

            float scaled = Resources.DisplayMetrics.ScaledDensity;
            if (scaled <= 0f)
            {
                scaled = density;
            }

            int heightPx = Resources.DisplayMetrics.HeightPixels;
            float fromHeight = (heightPx * 0.32f) / density;
            if (fromHeight < 56f)
            {
                fromHeight = 56f;
            }

            if (fromHeight > 168f)
            {
                fromHeight = 168f;
            }

            const int tileCount = 4;
            const int dividerCount = 3;
            int usablePx = Resources.DisplayMetrics.WidthPixels - Dp(16) * 2 - Dp(1) * dividerCount;
            if (usablePx < tileCount)
            {
                return fromHeight;
            }

            // 3 monospace digits at ~0.6em each; keep inside 92% of one of four tiles.
            // Avoid Paint/Typeface.Create: API 22 + XA Full-link JNI is fragile.
            float maxTextPx = (usablePx / (float)tileCount) * 0.92f;
            float fromWidth = (maxTextPx / 1.8f) / scaled;
            if (fromWidth < 24f)
            {
                fromWidth = 24f;
            }

            return fromWidth < fromHeight ? fromWidth : fromHeight;
        }

        private int Dp(int dp)
        {
            float density = Resources.DisplayMetrics.Density;
            return (int)(dp * density + 0.5f);
        }
    }
}
