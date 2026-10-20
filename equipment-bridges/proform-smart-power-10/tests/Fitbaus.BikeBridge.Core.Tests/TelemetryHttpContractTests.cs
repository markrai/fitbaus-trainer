using System;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Fitbaus.BikeBridge.Core;
using Xunit;

namespace Fitbaus.BikeBridge.Core.Tests
{
    public class TelemetryHttpContractTests
    {
        private static readonly DateTime T0 = new DateTime(2026, 8, 28, 0, 0, 0, DateTimeKind.Utc);

        [Fact]
        public void Health_Disconnected_StillOk()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            TelemetryHttpResponder responder = new TelemetryHttpResponder(store, () => T0, BridgeInfo.Version);
            TelemetryHttpResult result = responder.Handle("GET", "/health");
            Assert.Equal(200, result.StatusCode);
            Assert.StartsWith("application/json", result.ContentType);
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                JsonElement root = doc.RootElement;
                Assert.Equal("ok", root.GetProperty("status").GetString());
                Assert.Equal("0.1.0-poc", root.GetProperty("bridgeVersion").GetString());
                Assert.False(root.GetProperty("connected").GetBoolean());
                Assert.False(root.GetProperty("initialized").GetBoolean());
            }
        }

        [Fact]
        public void Telemetry_CompletelyUnobserved_StableSchemaWithNulls()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            TelemetryHttpResponder responder = new TelemetryHttpResponder(store, () => T0, BridgeInfo.Version);
            TelemetryHttpResult result = responder.Handle("GET", "/api/v1/telemetry");
            Assert.Equal(200, result.StatusCode);
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                JsonElement root = doc.RootElement;
                Assert.True(root.GetProperty("connected").GetBoolean());
                Assert.True(root.GetProperty("initialized").GetBoolean());
                AssertEqualNullMetric(root.GetProperty("resistance"));
                AssertEqualNullMetric(root.GetProperty("rpm"));
                AssertEqualNullMetric(root.GetProperty("watts"));
                Assert.Equal(JsonValueKind.Null, root.GetProperty("machine").ValueKind);
            }
        }

        [Fact]
        public void Telemetry_ObservedZero_IsJsonZeroNotNull()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnResistanceObserved(0, T0);
            store.OnRpmObserved(0, T0);
            store.OnWattsObserved(0, T0);
            TelemetryHttpResponder responder = new TelemetryHttpResponder(store, () => T0, BridgeInfo.Version);
            TelemetryHttpResult result = responder.Handle("GET", "/api/v1/telemetry");
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                JsonElement root = doc.RootElement;
                AssertObserved(root.GetProperty("resistance"), 0, true);
                AssertObserved(root.GetProperty("rpm"), 0, true);
                AssertObserved(root.GetProperty("watts"), 0, true);
            }
        }

        [Fact]
        public void Telemetry_NonZeroNativeValues()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            MachineInfo machine = new MachineInfo("", "Bike", false, 0, 16718, 402450, 3);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(machine, T0);
            store.OnResistanceObserved(5, T0);
            store.OnRpmObserved(56, T0);
            store.OnWattsObserved(42, T0);
            TelemetryHttpResponder responder = new TelemetryHttpResponder(store, () => T0, BridgeInfo.Version);
            TelemetryHttpResult result = responder.Handle("GET", "/api/v1/telemetry");
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                JsonElement root = doc.RootElement;
                AssertObserved(root.GetProperty("resistance"), 5, true);
                AssertObserved(root.GetProperty("rpm"), 56, true);
                AssertObserved(root.GetProperty("watts"), 42, true);
                JsonElement machineEl = root.GetProperty("machine");
                Assert.Equal("Bike", machineEl.GetProperty("type").GetString());
                Assert.Equal("16718", machineEl.GetProperty("modelNumber").GetString());
                Assert.Equal("402450", machineEl.GetProperty("partNumber").GetString());
                Assert.Equal("3", machineEl.GetProperty("serialNumber").GetString());
                Assert.False(machineEl.GetProperty("canSetResistance").GetBoolean());
                Assert.Equal(0, machineEl.GetProperty("maxResistanceLevel").GetDouble());
            }
        }

        [Fact]
        public void Telemetry_StableResistance_RemainsCurrentThirtySecondsLater()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnResistanceObserved(5, T0);
            DateTime later = T0.AddSeconds(30);
            TelemetryHttpResponder responder = new TelemetryHttpResponder(store, () => later, BridgeInfo.Version);
            TelemetryHttpResult result = responder.Handle("GET", "/api/v1/telemetry");
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                JsonElement resistance = doc.RootElement.GetProperty("resistance");
                Assert.Equal(5, resistance.GetProperty("value").GetInt32());
                Assert.Equal("2026-08-28T00:00:00.000Z", resistance.GetProperty("observedAt").GetString());
                Assert.True(resistance.GetProperty("current").GetBoolean());
                Assert.False(resistance.TryGetProperty("fresh", out _));
            }
        }

        [Fact]
        public void Telemetry_Reconnect_DoesNotResurrectOldObservations()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnRpmObserved(56, T0);
            store.OnUsbDisconnected(T0.AddSeconds(1));
            store.OnUsbConnected(T0.AddSeconds(2));
            store.OnConsoleInitialized(null, T0.AddSeconds(3));
            TelemetryHttpResponder responder = new TelemetryHttpResponder(store, () => T0.AddSeconds(3), BridgeInfo.Version);
            TelemetryHttpResult result = responder.Handle("GET", "/api/v1/telemetry");
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                JsonElement root = doc.RootElement;
                Assert.True(root.GetProperty("connected").GetBoolean());
                Assert.True(root.GetProperty("initialized").GetBoolean());
                AssertEqualNullMetric(root.GetProperty("rpm"));
            }
        }

        [Fact]
        public void Telemetry_Disconnected_DoesNotPresentOldValues()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnRpmObserved(56, T0);
            store.OnUsbDisconnected(T0.AddSeconds(1));
            TelemetryHttpResponder responder = new TelemetryHttpResponder(store, () => T0.AddSeconds(1), BridgeInfo.Version);
            TelemetryHttpResult result = responder.Handle("GET", "/api/v1/telemetry");
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                JsonElement root = doc.RootElement;
                Assert.False(root.GetProperty("connected").GetBoolean());
                Assert.False(root.GetProperty("initialized").GetBoolean());
                AssertEqualNullMetric(root.GetProperty("rpm"));
            }
        }

        [Fact]
        public void MutationMethodsAndControlPaths_AreRejected()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            TelemetryHttpResponder responder = new TelemetryHttpResponder(store, () => T0, BridgeInfo.Version);
            string[] methods = { "POST", "PUT", "PATCH", "DELETE" };
            string[] paths =
            {
                "/health",
                "/api/v1/telemetry",
                "/command",
                "/shire",
                "/usb",
                "/api/v1/command"
            };
            foreach (string method in methods)
            {
                foreach (string path in paths)
                {
                    TelemetryHttpResult result = responder.Handle(method, path);
                    Assert.Equal(405, result.StatusCode);
                    Assert.DoesNotContain("SetResistance", result.Body, StringComparison.OrdinalIgnoreCase);
                }
            }

            TelemetryHttpResult missing = responder.Handle("GET", "/command");
            Assert.Equal(404, missing.StatusCode);
        }

        [Fact]
        public async Task TcpServer_ServesHealthAndTelemetry()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            store.OnRpmObserved(0, T0);
            TelemetryHttpResponder responder = new TelemetryHttpResponder(store, () => T0, BridgeInfo.Version);
            TelemetryListenOptions options = new TelemetryListenOptions("127.0.0.1", 0);
            using (TelemetryHttpServer server = new TelemetryHttpServer(responder, options, null))
            {
                string error;
                Assert.True(server.TryStart(out error), error);
                using (HttpClient client = new HttpClient())
                {
                    client.Timeout = TimeSpan.FromSeconds(5);
                    string baseUrl = "http://127.0.0.1:" + server.BoundPort;
                    HttpResponseMessage health = await client.GetAsync(baseUrl + "/health");
                    Assert.Equal(System.Net.HttpStatusCode.OK, health.StatusCode);
                    Assert.Contains("application/json", health.Content.Headers.ContentType.ToString());
                    string healthJson = await health.Content.ReadAsStringAsync();
                    using (JsonDocument doc = JsonDocument.Parse(healthJson))
                    {
                        Assert.Equal("ok", doc.RootElement.GetProperty("status").GetString());
                        Assert.True(doc.RootElement.GetProperty("connected").GetBoolean());
                    }

                    HttpResponseMessage telemetry = await client.GetAsync(baseUrl + "/api/v1/telemetry");
                    string telemetryJson = await telemetry.Content.ReadAsStringAsync();
                    using (JsonDocument doc = JsonDocument.Parse(telemetryJson))
                    {
                        Assert.Equal(0, doc.RootElement.GetProperty("rpm").GetProperty("value").GetInt32());
                    }

                    HttpResponseMessage post = await client.PostAsync(baseUrl + "/api/v1/telemetry", new StringContent("{}"));
                    Assert.Equal(System.Net.HttpStatusCode.MethodNotAllowed, post.StatusCode);
                }
            }
        }

        [Fact]
        public void HttpServer_CanBeHeldAsSocketFreeInterfaceWithoutStarting()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            TelemetryHttpResponder responder = new TelemetryHttpResponder(store, () => T0, BridgeInfo.Version);
            ITelemetryHttpServer server = new TelemetryHttpServer(
                responder,
                new TelemetryListenOptions("127.0.0.1", 0),
                null);
            using (server)
            {
                Assert.False(server.IsRunning);
            }
        }

        private static void AssertEqualNullMetric(JsonElement metric)
        {
            Assert.Equal(JsonValueKind.Null, metric.GetProperty("value").ValueKind);
            Assert.Equal(JsonValueKind.Null, metric.GetProperty("observedAt").ValueKind);
            Assert.False(metric.GetProperty("current").GetBoolean());
        }

        private static void AssertObserved(JsonElement metric, int value, bool current)
        {
            Assert.Equal(value, metric.GetProperty("value").GetInt32());
            Assert.Equal(JsonValueKind.String, metric.GetProperty("observedAt").ValueKind);
            Assert.Equal(current, metric.GetProperty("current").GetBoolean());
        }
    }
}
