using System;
using System.Globalization;

namespace Fitbaus.BikeBridge.Core
{
    public sealed class TelemetryHttpResult
    {
        public TelemetryHttpResult(int statusCode, string reasonPhrase, string contentType, string body)
        {
            StatusCode = statusCode;
            ReasonPhrase = reasonPhrase ?? string.Empty;
            ContentType = contentType;
            Body = body ?? string.Empty;
        }

        public int StatusCode { get; private set; }

        public string ReasonPhrase { get; private set; }

        public string ContentType { get; private set; }

        public string Body { get; private set; }

        public static TelemetryHttpResult Json(int statusCode, string reasonPhrase, string body)
        {
            return new TelemetryHttpResult(statusCode, reasonPhrase, "application/json; charset=utf-8", body);
        }

        public static TelemetryHttpResult JsonError(int statusCode, string reasonPhrase, string error)
        {
            return Json(statusCode, reasonPhrase, TelemetryJson.SerializeError(error));
        }

        public static TelemetryHttpResult Text(int statusCode, string reasonPhrase, string body)
        {
            return new TelemetryHttpResult(statusCode, reasonPhrase, "text/plain; charset=utf-8", body);
        }
    }

    /// <summary>
    /// Maps HTTP method/path onto telemetry, status, absolute resistance control,
    /// display-only heart-rate ingest, and console screen brightness.
    /// Requested resistance, HR, and brightness are never written into the
    /// telemetry store. HR ingest and brightness must not initialize USB, alter
    /// resistance, connection/health, or keep a bike session alive.
    /// Resistance setter invocation and accepted-state recording are one serialized
    /// transaction. Mutual exclusion only; simultaneous-request order is unspecified.
    /// Clients should wait for one request to complete before issuing the next.
    /// </summary>
    public sealed class TelemetryHttpResponder
    {
        private readonly BikeTelemetryStore _store;
        private readonly ResistanceCommandCoordinator _coordinator;
        private readonly HeartRateStore _heartRate;
        private readonly BrightnessStore _brightness;
        private readonly Func<DateTime> _utcNow;
        private readonly Action _onHeartRateAccepted;
        private readonly Action _onBrightnessAccepted;
        private readonly string _version;
        private readonly Action<string> _log;

        public TelemetryHttpResponder(BikeTelemetryStore store)
            : this(store, null, BridgeInfo.Version, null, null, null, null, null, null, null)
        {
        }

        public TelemetryHttpResponder(BikeTelemetryStore store, Func<DateTime> utcNow, string version)
            : this(store, utcNow, version, null, null, null, null, null, null, null)
        {
        }

        public TelemetryHttpResponder(
            BikeTelemetryStore store,
            Func<DateTime> utcNow,
            string version,
            IResistanceRequestHandler resistanceHandler,
            Action<string> log)
            : this(store, utcNow, version, resistanceHandler, null, log, null, null, null, null)
        {
        }

        public TelemetryHttpResponder(
            BikeTelemetryStore store,
            Func<DateTime> utcNow,
            string version,
            IResistanceRequestHandler resistanceHandler,
            ResistanceCommandStore commands,
            Action<string> log)
            : this(store, utcNow, version, resistanceHandler, commands, log, null, null, null, null)
        {
        }

        public TelemetryHttpResponder(
            BikeTelemetryStore store,
            Func<DateTime> utcNow,
            string version,
            IResistanceRequestHandler resistanceHandler,
            ResistanceCommandStore commands,
            Action<string> log,
            HeartRateStore heartRate,
            Action onHeartRateAccepted)
            : this(store, utcNow, version, resistanceHandler, commands, log, heartRate, onHeartRateAccepted, null, null)
        {
        }

        public TelemetryHttpResponder(
            BikeTelemetryStore store,
            Func<DateTime> utcNow,
            string version,
            IResistanceRequestHandler resistanceHandler,
            ResistanceCommandStore commands,
            Action<string> log,
            HeartRateStore heartRate,
            Action onHeartRateAccepted,
            BrightnessStore brightness,
            Action onBrightnessAccepted)
        {
            if (store == null)
            {
                throw new ArgumentNullException("store");
            }

            _store = store;
            _utcNow = utcNow ?? new Func<DateTime>(GetUtcNow);
            _version = version ?? BridgeInfo.Version;
            _coordinator = new ResistanceCommandCoordinator(
                resistanceHandler,
                commands ?? new ResistanceCommandStore(),
                _utcNow);
            _heartRate = heartRate ?? new HeartRateStore();
            _onHeartRateAccepted = onHeartRateAccepted;
            _brightness = brightness ?? new BrightnessStore();
            _onBrightnessAccepted = onBrightnessAccepted;
            _log = log ?? new Action<string>(Ignore);
        }

        public HeartRateStore HeartRate
        {
            get { return _heartRate; }
        }

        public BrightnessStore Brightness
        {
            get { return _brightness; }
        }

        public TelemetryHttpResult Handle(string method, string rawPath)
        {
            return Handle(method, rawPath, null);
        }

        public TelemetryHttpResult Handle(string method, string rawPath, string body)
        {
            string verb = method == null ? string.Empty : method.Trim().ToUpperInvariant();
            string path = NormalizePath(rawPath);

            if (path == TelemetryHttpRoutes.Health)
            {
                if (verb != "GET")
                {
                    return TelemetryHttpResult.JsonError(405, "Method Not Allowed", "method not allowed");
                }

                HealthResponseDto dto = TelemetryApiMapper.ToHealth(_store.GetSnapshot(), _version);
                return TelemetryHttpResult.Json(200, "OK", TelemetryJson.SerializeHealth(dto));
            }

            if (path == TelemetryHttpRoutes.Telemetry)
            {
                if (verb != "GET")
                {
                    return TelemetryHttpResult.JsonError(405, "Method Not Allowed", "method not allowed");
                }

                TelemetryResponseDto dto = TelemetryApiMapper.ToTelemetry(_store.GetSnapshot());
                return TelemetryHttpResult.Json(200, "OK", TelemetryJson.SerializeTelemetry(dto));
            }

            if (path == TelemetryHttpRoutes.Status)
            {
                if (verb != "GET")
                {
                    return TelemetryHttpResult.JsonError(405, "Method Not Allowed", "method not allowed");
                }

                BridgeStatusResponseDto dto = TelemetryApiMapper.ToStatus(
                    _store.GetSnapshot(),
                    _coordinator.Commands.GetSnapshot(),
                    _version,
                    _coordinator.HasSetter);
                return TelemetryHttpResult.Json(200, "OK", TelemetryJson.SerializeStatus(dto));
            }

            if (path == TelemetryHttpRoutes.Resistance)
            {
                return HandleResistance(verb, body);
            }

            if (path == TelemetryHttpRoutes.Heartrate)
            {
                return HandleHeartrate(verb, body);
            }

            if (path == TelemetryHttpRoutes.Brightness)
            {
                return HandleBrightness(verb, body);
            }

            if (path == TelemetryHttpRoutes.ResistanceLegacy)
            {
                return TelemetryHttpResult.JsonError(404, "Not Found", "use POST /api/v1/resistance");
            }

            if (verb != "GET")
            {
                return TelemetryHttpResult.JsonError(405, "Method Not Allowed", "method not allowed");
            }

            return TelemetryHttpResult.JsonError(404, "Not Found", "not found");
        }

        private TelemetryHttpResult HandleResistance(string verb, string body)
        {
            if (verb != "POST")
            {
                return TelemetryHttpResult.JsonError(405, "Method Not Allowed", "method not allowed");
            }

            int requested;
            string parseError;
            if (!ResistanceRequestParser.TryParse(body, out requested, out parseError))
            {
                _log("resistance request rejected: " + parseError);
                return TelemetryHttpResult.JsonError(400, "Bad Request", parseError);
            }

            string rangeError;
            if (!ResistanceLimits.TryValidate(requested, out rangeError))
            {
                _log("resistance request rejected: " + rangeError);
                return TelemetryHttpResult.JsonError(400, "Bad Request", rangeError);
            }

            _log("resistance requested value=" + requested.ToString(CultureInfo.InvariantCulture));

            ResistanceRequestOutcome outcome;
            try
            {
                outcome = _coordinator.TryAccept(requested);
            }
            catch (Exception ex)
            {
                _log("resistance setter failure: " + ex.Message);
                return TelemetryHttpResult.JsonError(500, "Internal Server Error", "setter failure");
            }

            if (outcome == null || !outcome.Accepted)
            {
                string fail = outcome != null ? outcome.Error : "resistance request failed";
                _log("resistance request failed: " + fail);
                if (IsUnavailable(fail))
                {
                    return TelemetryHttpResult.JsonError(503, "Service Unavailable", fail);
                }

                return TelemetryHttpResult.JsonError(500, "Internal Server Error", fail);
            }

            _log("resistance request accepted requested=" + requested.ToString(CultureInfo.InvariantCulture));
            return TelemetryHttpResult.Json(200, "OK", TelemetryJson.SerializeResistanceAccepted(requested));
        }

        private TelemetryHttpResult HandleHeartrate(string verb, string body)
        {
            if (verb != "POST")
            {
                return TelemetryHttpResult.JsonError(405, "Method Not Allowed", "method not allowed");
            }

            int requested;
            string parseError;
            if (!ResistanceRequestParser.TryParse(body, out requested, out parseError))
            {
                _log("heartrate request rejected: " + parseError);
                return TelemetryHttpResult.JsonError(400, "Bad Request", parseError);
            }

            string rangeError;
            if (!HeartRateLimits.TryValidate(requested, out rangeError))
            {
                _log("heartrate request rejected: " + rangeError);
                return TelemetryHttpResult.JsonError(400, "Bad Request", rangeError);
            }

            _heartRate.Record(requested, _utcNow());
            _log("heartrate accepted requested=" + requested.ToString(CultureInfo.InvariantCulture));
            if (_onHeartRateAccepted != null)
            {
                _onHeartRateAccepted();
            }

            return TelemetryHttpResult.Json(200, "OK", TelemetryJson.SerializeResistanceAccepted(requested));
        }

        private TelemetryHttpResult HandleBrightness(string verb, string body)
        {
            if (verb != "POST")
            {
                return TelemetryHttpResult.JsonError(405, "Method Not Allowed", "method not allowed");
            }

            int requested;
            string parseError;
            if (!ResistanceRequestParser.TryParse(body, out requested, out parseError))
            {
                _log("brightness request rejected: " + parseError);
                return TelemetryHttpResult.JsonError(400, "Bad Request", parseError);
            }

            string rangeError;
            if (!BrightnessLimits.TryValidate(requested, out rangeError))
            {
                _log("brightness request rejected: " + rangeError);
                return TelemetryHttpResult.JsonError(400, "Bad Request", rangeError);
            }

            _brightness.Record(requested, _utcNow());
            _log("brightness accepted requested=" + requested.ToString(CultureInfo.InvariantCulture));
            if (_onBrightnessAccepted != null)
            {
                _onBrightnessAccepted();
            }

            return TelemetryHttpResult.Json(200, "OK", TelemetryJson.SerializeResistanceAccepted(requested));
        }

        private static bool IsUnavailable(string error)
        {
            if (string.IsNullOrEmpty(error))
            {
                return false;
            }

            return error.IndexOf("not initialized", StringComparison.OrdinalIgnoreCase) >= 0
                || error.IndexOf("unavailable", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static void Ignore(string message)
        {
        }

        public static string NormalizePath(string rawPath)
        {
            if (string.IsNullOrEmpty(rawPath))
            {
                return "/";
            }

            string path = rawPath.Trim();
            int query = path.IndexOf('?');
            if (query >= 0)
            {
                path = path.Substring(0, query);
            }

            if (path.Length > 1 && path.EndsWith("/", StringComparison.Ordinal))
            {
                path = path.Substring(0, path.Length - 1);
            }

            return path;
        }

        private static DateTime GetUtcNow()
        {
            return DateTime.UtcNow;
        }
    }
}
