using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Fitbaus.BikeBridge.Core;
using Xunit;

namespace Fitbaus.BikeBridge.Core.Tests
{
    public class ResistanceRequestTests
    {
        private static readonly DateTime T0 = new DateTime(2026, 8, 28, 12, 0, 0, DateTimeKind.Utc);
        private const string ResistancePath = "/api/v1/resistance";

        [Fact]
        public void ValidRequest_ReturnsRequestedAndDoesNotTouchTelemetry()
        {
            BikeTelemetryStore store = SeededStore();
            RecordingHandler handler = new RecordingHandler();
            TelemetryHttpResponder responder = CreateResponder(store, handler);

            TelemetryHttpResult result = responder.Handle("POST", ResistancePath, "{\"value\":4}");

            Assert.Equal(200, result.StatusCode);
            Assert.StartsWith("application/json", result.ContentType);
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                Assert.Equal(4, doc.RootElement.GetProperty("requested").GetInt32());
                Assert.False(doc.RootElement.TryGetProperty("observed", out _));
            }

            Assert.Equal(1, handler.Calls);
            Assert.Equal(4, handler.LastLevel);
            AssertUnchangedTelemetry(store);
        }

        [Fact]
        public void MalformedJson_IsRejected()
        {
            AssertBadRequest("not-json", "malformed json");
            AssertBadRequest("{", "malformed json");
            AssertBadRequest("{\"value\":4,\"extra\":1}", "malformed json");
        }

        [Fact]
        public void MissingValue_IsRejected()
        {
            AssertBadRequest("", "missing body");
            AssertBadRequest("{}", "missing value");
            AssertBadRequest("{\"other\":4}", "missing value");
        }

        [Fact]
        public void NonInteger_IsRejected()
        {
            AssertBadRequest("{\"value\":4.5}", "value must be an integer");
            AssertBadRequest("{\"value\":\"4\"}", "value must be an integer");
            AssertBadRequest("{\"value\":true}", "value must be an integer");
            AssertBadRequest("{\"value\":null}", "value must be an integer");
        }

        [Fact]
        public void BelowMinimum_IsRejectedWithoutCallingSetter()
        {
            RecordingHandler handler = new RecordingHandler();
            TelemetryHttpResult result = CreateResponder(SeededStore(), handler)
                .Handle("POST", ResistancePath, "{\"value\":0}");
            Assert.Equal(400, result.StatusCode);
            Assert.Contains("1", ErrorOf(result));
            Assert.Equal(0, handler.Calls);
        }

        [Fact]
        public void AboveMaximum_IsRejectedWithoutCallingSetter()
        {
            RecordingHandler handler = new RecordingHandler();
            TelemetryHttpResult result = CreateResponder(SeededStore(), handler)
                .Handle("POST", ResistancePath, "{\"value\":16}");
            Assert.Equal(400, result.StatusCode);
            Assert.Contains("15", ErrorOf(result));
            Assert.Equal(0, handler.Calls);
        }

        [Fact]
        public void PhysicalUpperRange_IsAccepted()
        {
            RecordingHandler handler = new RecordingHandler();
            TelemetryHttpResponder responder = CreateResponder(SeededStore(), handler);
            Assert.Equal(200, responder.Handle("POST", ResistancePath, "{\"value\":11}").StatusCode);
            Assert.Equal(200, responder.Handle("POST", ResistancePath, "{\"value\":15}").StatusCode);
            Assert.Equal(new[] { 11, 15 }, handler.Order.ToArray());
        }

        [Fact]
        public void UnsupportedHttpMethod_IsRejected()
        {
            BikeTelemetryStore store = SeededStore();
            TelemetryHttpResponder responder = CreateResponder(store, new RecordingHandler());
            Assert.Equal(405, responder.Handle("GET", ResistancePath).StatusCode);
            Assert.Equal(405, responder.Handle("PUT", ResistancePath, "{\"value\":4}").StatusCode);
            Assert.Equal(405, responder.Handle("PATCH", ResistancePath, "{\"value\":4}").StatusCode);
            Assert.Equal(405, responder.Handle("DELETE", ResistancePath).StatusCode);
            AssertUnchangedTelemetry(store);
        }

        [Fact]
        public void LegacyResistancePath_IsRemoved()
        {
            TelemetryHttpResult result = CreateResponder(SeededStore(), new RecordingHandler())
                .Handle("POST", "/resistance", "{\"value\":4}");
            Assert.Equal(404, result.StatusCode);
            Assert.Contains("/api/v1/resistance", ErrorOf(result));
        }

        [Fact]
        public void SetterException_MapsTo500()
        {
            RecordingHandler handler = new RecordingHandler
            {
                Throw = new InvalidOperationException("native boom")
            };
            ResistanceCommandStore commands = new ResistanceCommandStore();
            TelemetryHttpResult result = CreateResponder(SeededStore(), handler, commands)
                .Handle("POST", ResistancePath, "{\"value\":4}");
            Assert.Equal(500, result.StatusCode);
            Assert.Equal("setter failure", ErrorOf(result));
            Assert.Equal(1, handler.Calls);
            Assert.Null(commands.GetSnapshot().Requested);
        }

        [Fact]
        public void SetterFailure_MapsTo500()
        {
            RecordingHandler handler = new RecordingHandler
            {
                Result = ResistanceRequestOutcome.Fail("enqueue failed")
            };
            TelemetryHttpResult result = CreateResponder(SeededStore(), handler)
                .Handle("POST", ResistancePath, "{\"value\":3}");
            Assert.Equal(500, result.StatusCode);
            Assert.Equal("enqueue failed", ErrorOf(result));
        }

        [Fact]
        public void ConsoleNotReady_MapsTo503()
        {
            RecordingHandler handler = new RecordingHandler
            {
                Result = ResistanceRequestOutcome.Fail("console not initialized")
            };
            TelemetryHttpResult result = CreateResponder(SeededStore(), handler)
                .Handle("POST", ResistancePath, "{\"value\":3}");
            Assert.Equal(503, result.StatusCode);
        }

        [Fact]
        public void AcceptedRequest_UpdatesRequestedState_NotObserved()
        {
            BikeTelemetryStore store = SeededStore();
            ResistanceCommandStore commands = new ResistanceCommandStore();
            TelemetryHttpResponder responder = new TelemetryHttpResponder(
                store,
                () => T0.AddSeconds(9),
                BridgeInfo.Version,
                new RecordingHandler(),
                commands,
                null);

            responder.Handle("POST", ResistancePath, "{\"value\":4}");

            ResistanceCommandSnapshot cmd = commands.GetSnapshot();
            Assert.Equal(4, cmd.Requested);
            Assert.Equal(T0.AddSeconds(9), cmd.RequestedAt);
            AssertUnchangedTelemetry(store);
        }

        [Fact]
        public void LaterTelemetry_UpdatesObservedIndependently()
        {
            BikeTelemetryStore store = SeededStore();
            ResistanceCommandStore commands = new ResistanceCommandStore();
            TelemetryHttpResponder responder = new TelemetryHttpResponder(
                store,
                () => T0.AddSeconds(1),
                BridgeInfo.Version,
                new RecordingHandler(),
                commands,
                null);

            responder.Handle("POST", ResistancePath, "{\"value\":4}");
            DateTime observed = T0.AddSeconds(2);
            store.OnResistanceObserved(4, observed);

            BikeTelemetrySnapshot snap = store.GetSnapshot();
            Assert.Equal(4, snap.Resistance);
            Assert.Equal(observed, snap.ResistanceObservedAt);
            Assert.Equal(4, commands.GetSnapshot().Requested);
            Assert.Equal(T0.AddSeconds(1), commands.GetSnapshot().RequestedAt);
        }

        [Fact]
        public void Status_NullObservedAtStartup_StillReportsControlAvailable()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            TelemetryHttpResponder responder = CreateResponder(store, new RecordingHandler());
            TelemetryHttpResult result = responder.Handle("GET", "/api/v1/status");
            Assert.Equal(200, result.StatusCode);
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                JsonElement root = doc.RootElement;
                Assert.True(root.GetProperty("connected").GetBoolean());
                Assert.True(root.GetProperty("initialized").GetBoolean());
                Assert.True(root.GetProperty("resistanceControlAvailable").GetBoolean());
                JsonElement resistance = root.GetProperty("resistance");
                Assert.Equal(JsonValueKind.Null, resistance.GetProperty("requested").ValueKind);
                Assert.Equal(JsonValueKind.Null, resistance.GetProperty("observed").ValueKind);
                Assert.Equal(JsonValueKind.Null, resistance.GetProperty("observedAt").ValueKind);
            }
        }

        [Fact]
        public void Status_DoesNotTreatShireCanSetFlagAsAvailability()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            MachineInfo machine = new MachineInfo("", "Bike", false, 0, 16718, 402450, 3);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(machine, T0);
            TelemetryHttpResult result = CreateResponder(store, new RecordingHandler())
                .Handle("GET", "/api/v1/status");
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                Assert.True(doc.RootElement.GetProperty("resistanceControlAvailable").GetBoolean());
            }
        }

        [Fact]
        public void SequentialCommands_ExecuteInCallOrder()
        {
            RecordingHandler handler = new RecordingHandler();
            TelemetryHttpResponder responder = CreateResponder(SeededStore(), handler);
            responder.Handle("POST", ResistancePath, "{\"value\":4}");
            responder.Handle("POST", ResistancePath, "{\"value\":5}");
            responder.Handle("POST", ResistancePath, "{\"value\":6}");
            Assert.Equal(new[] { 4, 5, 6 }, handler.Order.ToArray());
        }

        [Fact]
        public void OverlappingRequests_CannotEnterSetterConcurrently()
        {
            ManualResetEventSlim firstEntered = new ManualResetEventSlim(false);
            ManualResetEventSlim releaseFirst = new ManualResetEventSlim(false);
            OrderedBlockingHandler inner = new OrderedBlockingHandler(firstEntered, releaseFirst);
            BikeTelemetryStore store = SeededStore();
            TelemetryHttpResponder responder = CreateResponder(store, inner);

            TelemetryHttpResult second = null;
            Thread t1 = new Thread(() =>
            {
                responder.Handle("POST", ResistancePath, "{\"value\":4}");
            });
            Thread t2 = new Thread(() =>
            {
                firstEntered.Wait(TimeSpan.FromSeconds(5));
                second = responder.Handle("POST", ResistancePath, "{\"value\":5}");
            });
            t1.Start();
            Assert.True(firstEntered.Wait(TimeSpan.FromSeconds(5)));
            t2.Start();
            Thread.Sleep(100);
            Assert.Equal(1, inner.Calls);
            releaseFirst.Set();
            Assert.True(t1.Join(TimeSpan.FromSeconds(5)));
            Assert.True(t2.Join(TimeSpan.FromSeconds(5)));
            Assert.Equal(new[] { 4, 5 }, inner.Order.ToArray());
            Assert.Equal(200, second.StatusCode);
        }

        [Fact]
        public void OverlappingRequests_CannotLeaveRequestedAsOlderCommand()
        {
            ManualResetEventSlim firstEntered = new ManualResetEventSlim(false);
            ManualResetEventSlim releaseFirst = new ManualResetEventSlim(false);
            OrderedBlockingHandler inner = new OrderedBlockingHandler(firstEntered, releaseFirst);
            ResistanceCommandStore commands = new ResistanceCommandStore();
            TelemetryHttpResponder responder = CreateResponder(SeededStore(), inner, commands);

            Thread t1 = new Thread(() =>
            {
                responder.Handle("POST", ResistancePath, "{\"value\":4}");
            });
            Thread t2 = new Thread(() =>
            {
                firstEntered.Wait(TimeSpan.FromSeconds(5));
                responder.Handle("POST", ResistancePath, "{\"value\":5}");
            });
            t1.Start();
            Assert.True(firstEntered.Wait(TimeSpan.FromSeconds(5)));
            t2.Start();
            Thread.Sleep(100);
            Assert.Equal(1, inner.Calls);
            Assert.Null(commands.GetSnapshot().Requested);
            releaseFirst.Set();
            Assert.True(t1.Join(TimeSpan.FromSeconds(5)));
            Assert.True(t2.Join(TimeSpan.FromSeconds(5)));
            Assert.Equal(new[] { 4, 5 }, inner.Order.ToArray());
            Assert.Equal(5, commands.GetSnapshot().Requested);
        }

        [Fact]
        public void Status_MissingSetter_ReportsControlUnavailable()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            store.OnUsbConnected(T0);
            store.OnConsoleInitialized(null, T0);
            TelemetryHttpResponder responder = new TelemetryHttpResponder(store, () => T0, BridgeInfo.Version);
            TelemetryHttpResult status = responder.Handle("GET", "/api/v1/status");
            using (JsonDocument doc = JsonDocument.Parse(status.Body))
            {
                Assert.True(doc.RootElement.GetProperty("connected").GetBoolean());
                Assert.True(doc.RootElement.GetProperty("initialized").GetBoolean());
                Assert.False(doc.RootElement.GetProperty("resistanceControlAvailable").GetBoolean());
            }

            TelemetryHttpResult post = responder.Handle("POST", ResistancePath, "{\"value\":4}");
            Assert.Equal(503, post.StatusCode);
            Assert.Equal("setter unavailable", ErrorOf(post));
        }

        [Fact]
        public void BadRequest_DoesNotStopSubsequentValidRequest()
        {
            RecordingHandler handler = new RecordingHandler();
            TelemetryHttpResponder responder = CreateResponder(SeededStore(), handler);
            Assert.Equal(400, responder.Handle("POST", ResistancePath, "nope").StatusCode);
            TelemetryHttpResult ok = responder.Handle("POST", ResistancePath, "{\"value\":5}");
            Assert.Equal(200, ok.StatusCode);
            Assert.Equal(1, handler.Calls);
            Assert.Equal(5, handler.LastLevel);
        }

        [Fact]
        public void DisconnectedStatus_ReportsControlUnavailable()
        {
            BikeTelemetryStore store = new BikeTelemetryStore(() => T0);
            TelemetryHttpResult result = CreateResponder(store, new RecordingHandler())
                .Handle("GET", "/api/v1/status");
            using (JsonDocument doc = JsonDocument.Parse(result.Body))
            {
                Assert.False(doc.RootElement.GetProperty("connected").GetBoolean());
                Assert.False(doc.RootElement.GetProperty("resistanceControlAvailable").GetBoolean());
            }
        }

        [Fact]
        public async Task TcpServer_PostCanonicalResistance_UsesBodyAndLeavesTelemetryAlone()
        {
            BikeTelemetryStore store = SeededStore();
            RecordingHandler handler = new RecordingHandler();
            TelemetryHttpResponder responder = CreateResponder(store, handler);
            TelemetryListenOptions options = new TelemetryListenOptions("127.0.0.1", 0);
            using (TelemetryHttpServer server = new TelemetryHttpServer(responder, options, null))
            {
                string error;
                Assert.True(server.TryStart(out error), error);
                using (HttpClient client = new HttpClient())
                {
                    client.Timeout = TimeSpan.FromSeconds(5);
                    string url = "http://127.0.0.1:" + server.BoundPort + ResistancePath;
                    HttpResponseMessage response = await client.PostAsync(
                        url,
                        new StringContent("{\"value\":4}", Encoding.UTF8, "application/json"));
                    Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
                    Assert.Contains("application/json", response.Content.Headers.ContentType.ToString());
                    string json = await response.Content.ReadAsStringAsync();
                    using (JsonDocument doc = JsonDocument.Parse(json))
                    {
                        Assert.Equal(4, doc.RootElement.GetProperty("requested").GetInt32());
                    }

                    HttpResponseMessage bad = await client.PostAsync(
                        url,
                        new StringContent("not-json", Encoding.UTF8, "application/json"));
                    Assert.Equal(System.Net.HttpStatusCode.BadRequest, bad.StatusCode);
                    HttpResponseMessage again = await client.PostAsync(
                        url,
                        new StringContent("{\"value\":5}", Encoding.UTF8, "application/json"));
                    Assert.Equal(System.Net.HttpStatusCode.OK, again.StatusCode);
                }
            }

            Assert.Equal(new[] { 4, 5 }, handler.Order.ToArray());
            AssertUnchangedTelemetry(store);
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
            IResistanceRequestHandler handler)
        {
            return CreateResponder(store, handler, null);
        }

        private static TelemetryHttpResponder CreateResponder(
            BikeTelemetryStore store,
            IResistanceRequestHandler handler,
            ResistanceCommandStore commands)
        {
            return new TelemetryHttpResponder(store, () => T0, BridgeInfo.Version, handler, commands, null);
        }

        private static void AssertBadRequest(string body, string expected)
        {
            RecordingHandler handler = new RecordingHandler();
            TelemetryHttpResult result = CreateResponder(SeededStore(), handler)
                .Handle("POST", ResistancePath, body);
            Assert.Equal(400, result.StatusCode);
            Assert.StartsWith("application/json", result.ContentType);
            Assert.Equal(expected, ErrorOf(result));
            Assert.Equal(0, handler.Calls);
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

        private sealed class RecordingHandler : IResistanceRequestHandler
        {
            public int Calls;

            public int LastLevel;

            public List<int> Order = new List<int>();

            public ResistanceRequestOutcome Result;

            public Exception Throw;

            public ResistanceRequestOutcome Request(int level)
            {
                Calls++;
                LastLevel = level;
                Order.Add(level);
                if (Throw != null)
                {
                    throw Throw;
                }

                if (Result != null)
                {
                    return Result;
                }

                return ResistanceRequestOutcome.Ok(level);
            }
        }

        private sealed class OrderedBlockingHandler : IResistanceRequestHandler
        {
            private readonly ManualResetEventSlim _entered;
            private readonly ManualResetEventSlim _release;
            private readonly object _gate = new object();

            public OrderedBlockingHandler(ManualResetEventSlim entered, ManualResetEventSlim release)
            {
                _entered = entered;
                _release = release;
            }

            public int Calls;

            public List<int> Order = new List<int>();

            public ResistanceRequestOutcome Request(int level)
            {
                lock (_gate)
                {
                    Calls++;
                }

                if (level == 4)
                {
                    _entered.Set();
                    _release.Wait();
                }

                lock (_gate)
                {
                    Order.Add(level);
                }

                return ResistanceRequestOutcome.Ok(level);
            }
        }
    }
}
