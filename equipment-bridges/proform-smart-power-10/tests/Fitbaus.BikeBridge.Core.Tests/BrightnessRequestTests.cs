using System;
using System.Text.Json;
using Fitbaus.BikeBridge.Core;
using Xunit;

namespace Fitbaus.BikeBridge.Core.Tests
{
    public class BrightnessRequestTests
    {
        private static readonly DateTime T0 = new DateTime(2026, 8, 28, 12, 0, 0, DateTimeKind.Utc);
        private const string BrightnessPath = "/api/v1/brightness";

        [Fact]
        public void ValidRequest_ReturnsRequestedAndDoesNotTouchTelemetry()
        {
            BikeTelemetryStore store = SeededStore();
            BrightnessStore brightness = new BrightnessStore();
            int acceptedCalls = 0;
            TelemetryHttpResponder responder = CreateResponder(store, brightness, () => acceptedCalls++);

            TelemetryHttpResult result = responder.Handle("POST", BrightnessPath, "{\"value\":80}");

            Assert.Equal(200, result.StatusCode);
            Assert.StartsWith("application/json", result.ContentType);
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                Assert.Equal(80, doc.RootElement.GetProperty("requested").GetInt32());
            }

            BrightnessSnapshot snap = brightness.GetSnapshot();
            Assert.Equal(80, snap.Percent);
            Assert.Equal(T0, snap.RequestedAt);
            Assert.Equal(1, acceptedCalls);
            AssertUnchangedTelemetry(store);
        }

        [Fact]
        public void ZeroAndOneHundred_AreAccepted()
        {
            BrightnessStore brightness = new BrightnessStore();
            TelemetryHttpResponder responder = CreateResponder(SeededStore(), brightness, null);

            Assert.Equal(200, responder.Handle("POST", BrightnessPath, "{\"value\":0}").StatusCode);
            Assert.Equal(0, brightness.GetSnapshot().Percent);
            Assert.Equal(200, responder.Handle("POST", BrightnessPath, "{\"value\":100}").StatusCode);
            Assert.Equal(100, brightness.GetSnapshot().Percent);
        }

        [Fact]
        public void ToWindowBrightness_MapsZeroToTinyNonZero()
        {
            Assert.Equal(BrightnessLimits.MinimumWindowBrightness, BrightnessLimits.ToWindowBrightness(0));
            Assert.Equal(0.5f, BrightnessLimits.ToWindowBrightness(50));
            Assert.Equal(1f, BrightnessLimits.ToWindowBrightness(100));
        }

        [Fact]
        public void BelowMinimum_IsRejected()
        {
            BrightnessStore brightness = new BrightnessStore();
            TelemetryHttpResult result = CreateResponder(SeededStore(), brightness, null)
                .Handle("POST", BrightnessPath, "{\"value\":-1}");
            Assert.Equal(400, result.StatusCode);
            Assert.Contains("0", ErrorOf(result));
            Assert.Null(brightness.GetSnapshot().Percent);
        }

        [Fact]
        public void AboveMaximum_IsRejected()
        {
            BrightnessStore brightness = new BrightnessStore();
            TelemetryHttpResult result = CreateResponder(SeededStore(), brightness, null)
                .Handle("POST", BrightnessPath, "{\"value\":101}");
            Assert.Equal(400, result.StatusCode);
            Assert.Contains("100", ErrorOf(result));
            Assert.Null(brightness.GetSnapshot().Percent);
        }

        [Fact]
        public void MalformedJson_IsRejected()
        {
            BrightnessStore brightness = new BrightnessStore();
            TelemetryHttpResult result = CreateResponder(SeededStore(), brightness, null)
                .Handle("POST", BrightnessPath, "not-json");
            Assert.Equal(400, result.StatusCode);
            Assert.Equal("malformed json", ErrorOf(result));
            Assert.Null(brightness.GetSnapshot().Percent);
        }

        [Fact]
        public void UnsupportedHttpMethod_IsRejected()
        {
            BikeTelemetryStore store = SeededStore();
            BrightnessStore brightness = new BrightnessStore();
            TelemetryHttpResponder responder = CreateResponder(store, brightness, null);
            Assert.Equal(405, responder.Handle("GET", BrightnessPath).StatusCode);
            Assert.Equal(405, responder.Handle("DELETE", BrightnessPath).StatusCode);
            AssertUnchangedTelemetry(store);
            Assert.Null(brightness.GetSnapshot().Percent);
        }

        [Fact]
        public void HealthTelemetryAndStatusRemainBikeOnly()
        {
            BikeTelemetryStore store = SeededStore();
            BrightnessStore brightness = new BrightnessStore();
            TelemetryHttpResponder responder = CreateResponder(store, brightness, null);
            Assert.Equal(200, responder.Handle("POST", BrightnessPath, "{\"value\":40}").StatusCode);

            using (JsonDocument health = JsonDocument.Parse(responder.Handle("GET", "/health").Body))
            {
                Assert.True(health.RootElement.GetProperty("connected").GetBoolean());
                Assert.False(health.RootElement.TryGetProperty("brightness", out _));
            }

            using (JsonDocument telemetry = JsonDocument.Parse(responder.Handle("GET", "/api/v1/telemetry").Body))
            {
                Assert.Equal(3, telemetry.RootElement.GetProperty("resistance").GetProperty("value").GetInt32());
                Assert.False(telemetry.RootElement.TryGetProperty("brightness", out _));
            }

            using (JsonDocument status = JsonDocument.Parse(responder.Handle("GET", "/api/v1/status").Body))
            {
                Assert.False(status.RootElement.TryGetProperty("brightness", out _));
            }
        }

        private static BikeTelemetryStore SeededStore()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnResistanceObserved(3, T0);
            return store;
        }

        private static TelemetryHttpResponder CreateResponder(
            BikeTelemetryStore store,
            BrightnessStore brightness,
            Action onAccepted)
        {
            return new TelemetryHttpResponder(
                store,
                () => T0,
                BridgeInfo.Version,
                null,
                null,
                null,
                null,
                null,
                brightness,
                onAccepted);
        }

        private static string ErrorOf(TelemetryHttpResult result)
        {
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                return doc.RootElement.GetProperty("error").GetString();
            }
        }

        private static void AssertUnchangedTelemetry(BikeTelemetryStore store)
        {
            BikeTelemetrySnapshot snap = store.GetSnapshot();
            Assert.Equal(3, snap.Resistance);
            Assert.Equal(T0, snap.ResistanceObservedAt);
            Assert.Equal(T0, snap.SnapshotAt);
        }
    }
}
