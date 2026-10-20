using System;
using System.Text.Json;
using Fitbaus.BikeBridge.Core;
using Xunit;

namespace Fitbaus.BikeBridge.Core.Tests
{
    public class HeartRateRequestTests
    {
        private static readonly DateTime T0 = new DateTime(2026, 8, 28, 12, 0, 0, DateTimeKind.Utc);
        private const string HeartratePath = "/api/v1/heartrate";

        [Fact]
        public void ValidRequest_ReturnsRequestedAndDoesNotTouchTelemetry()
        {
            BikeTelemetryStore store = SeededStore();
            HeartRateStore hr = new HeartRateStore();
            int acceptedCalls = 0;
            TelemetryHttpResponder responder = CreateResponder(store, hr, () => acceptedCalls++);

            TelemetryHttpResult result = responder.Handle("POST", HeartratePath, "{\"value\":142}");

            Assert.Equal(200, result.StatusCode);
            Assert.StartsWith("application/json", result.ContentType);
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                Assert.Equal(142, doc.RootElement.GetProperty("requested").GetInt32());
            }

            HeartRateSnapshot snap = hr.GetSnapshot();
            Assert.Equal(142, snap.Bpm);
            Assert.Equal(T0, snap.ObservedAt);
            Assert.Equal(1, acceptedCalls);
            AssertUnchangedTelemetry(store);
        }

        [Fact]
        public void Freshness_IsPureQueryOverSnapshot()
        {
            HeartRateStore hr = new HeartRateStore();
            hr.Record(140, T0);

            Assert.True(HeartRateFreshness.IsFresh(hr.GetSnapshot(), T0));
            Assert.True(HeartRateFreshness.IsFresh(hr.GetSnapshot(), T0.AddSeconds(3)));
            Assert.False(HeartRateFreshness.IsFresh(hr.GetSnapshot(), T0.AddSeconds(3).AddMilliseconds(1)));
            Assert.Equal(140, HeartRateFreshness.DisplayBpm(hr.GetSnapshot(), T0.AddSeconds(2)));
            Assert.Null(HeartRateFreshness.DisplayBpm(hr.GetSnapshot(), T0.AddSeconds(4)));
            Assert.False(HeartRateFreshness.IsFresh(new HeartRateSnapshot(null, null), T0));
        }

        [Fact]
        public void BelowMinimum_IsRejected()
        {
            HeartRateStore hr = new HeartRateStore();
            TelemetryHttpResult result = CreateResponder(SeededStore(), hr, null)
                .Handle("POST", HeartratePath, "{\"value\":29}");
            Assert.Equal(400, result.StatusCode);
            Assert.Contains("30", ErrorOf(result));
            Assert.Null(hr.GetSnapshot().Bpm);
        }

        [Fact]
        public void AboveMaximum_IsRejected()
        {
            HeartRateStore hr = new HeartRateStore();
            TelemetryHttpResult result = CreateResponder(SeededStore(), hr, null)
                .Handle("POST", HeartratePath, "{\"value\":251}");
            Assert.Equal(400, result.StatusCode);
            Assert.Contains("250", ErrorOf(result));
            Assert.Null(hr.GetSnapshot().Bpm);
        }

        [Fact]
        public void MalformedJson_IsRejected()
        {
            HeartRateStore hr = new HeartRateStore();
            TelemetryHttpResult result = CreateResponder(SeededStore(), hr, null)
                .Handle("POST", HeartratePath, "not-json");
            Assert.Equal(400, result.StatusCode);
            Assert.Equal("malformed json", ErrorOf(result));
            Assert.Null(hr.GetSnapshot().Bpm);
        }

        [Fact]
        public void UnsupportedHttpMethod_IsRejected()
        {
            BikeTelemetryStore store = SeededStore();
            HeartRateStore hr = new HeartRateStore();
            TelemetryHttpResponder responder = CreateResponder(store, hr, null);
            Assert.Equal(405, responder.Handle("GET", HeartratePath).StatusCode);
            Assert.Equal(405, responder.Handle("DELETE", HeartratePath).StatusCode);
            AssertUnchangedTelemetry(store);
            Assert.Null(hr.GetSnapshot().Bpm);
        }

        [Fact]
        public void HealthAndTelemetryRemainBikeOnly()
        {
            BikeTelemetryStore store = SeededStore();
            HeartRateStore hr = new HeartRateStore();
            TelemetryHttpResponder responder = CreateResponder(store, hr, null);
            Assert.Equal(200, responder.Handle("POST", HeartratePath, "{\"value\":120}").StatusCode);

            using (JsonDocument health = JsonDocument.Parse(responder.Handle("GET", "/health").Body))
            {
                Assert.True(health.RootElement.GetProperty("connected").GetBoolean());
                Assert.False(health.RootElement.TryGetProperty("heartRate", out _));
                Assert.False(health.RootElement.TryGetProperty("bpm", out _));
            }

            using (JsonDocument telemetry = JsonDocument.Parse(responder.Handle("GET", "/api/v1/telemetry").Body))
            {
                Assert.Equal(3, telemetry.RootElement.GetProperty("resistance").GetProperty("value").GetInt32());
                Assert.False(telemetry.RootElement.TryGetProperty("heartRate", out _));
                Assert.False(telemetry.RootElement.TryGetProperty("heartrate", out _));
                Assert.False(telemetry.RootElement.TryGetProperty("bpm", out _));
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
            HeartRateStore heartRate,
            Action onAccepted)
        {
            return new TelemetryHttpResponder(
                store,
                () => T0,
                BridgeInfo.Version,
                null,
                null,
                null,
                heartRate,
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
