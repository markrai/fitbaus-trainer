using System;
using System.Globalization;
using System.Text;

namespace Fitbaus.BikeBridge.Core
{
    public static class TelemetryHttpRoutes
    {
        public const string Health = "/health";
        public const string Telemetry = "/api/v1/telemetry";
        public const string Status = "/api/v1/status";
        public const string Resistance = "/api/v1/resistance";
        public const string ResistanceLegacy = "/resistance";
        public const string Heartrate = "/api/v1/heartrate";
        public const string Brightness = "/api/v1/brightness";
    }

    public sealed class HealthResponseDto
    {
        public string Status { get; set; }

        public string BridgeVersion { get; set; }

        public bool Connected { get; set; }

        public bool Initialized { get; set; }
    }

    public sealed class MetricObservationDto
    {
        public int? Value { get; set; }

        public DateTime? ObservedAt { get; set; }

        public bool Current { get; set; }
    }

    public sealed class MachineMetadataDto
    {
        public string Type { get; set; }

        public string ModelNumber { get; set; }

        public string PartNumber { get; set; }

        public string SerialNumber { get; set; }

        public bool CanSetResistance { get; set; }

        public double MaxResistanceLevel { get; set; }
    }

    public sealed class BridgeStatusResponseDto
    {
        public string Status { get; set; }

        public string BridgeVersion { get; set; }

        public bool Connected { get; set; }

        public bool Initialized { get; set; }

        public bool ResistanceControlAvailable { get; set; }

        public int? RequestedResistance { get; set; }

        public DateTime? RequestedAt { get; set; }

        public int? ObservedResistance { get; set; }

        public DateTime? ObservedAt { get; set; }
    }

    public sealed class TelemetryResponseDto
    {
        public bool Connected { get; set; }

        public bool Initialized { get; set; }

        public DateTime SnapshotAt { get; set; }

        public MetricObservationDto Resistance { get; set; }

        public MetricObservationDto Rpm { get; set; }

        public MetricObservationDto Watts { get; set; }

        public MachineMetadataDto Machine { get; set; }
    }

    public static class TelemetryApiMapper
    {
        public static HealthResponseDto ToHealth(BikeTelemetrySnapshot snapshot, string version)
        {
            BikeTelemetrySnapshot snap = snapshot ?? EmptyDisconnected();
            return new HealthResponseDto
            {
                Status = "ok",
                BridgeVersion = version ?? BridgeInfo.Version,
                Connected = snap.Connected,
                Initialized = snap.Initialized
            };
        }

        public static TelemetryResponseDto ToTelemetry(BikeTelemetrySnapshot snapshot)
        {
            BikeTelemetrySnapshot snap = snapshot ?? EmptyDisconnected();
            return new TelemetryResponseDto
            {
                Connected = snap.Connected,
                Initialized = snap.Initialized,
                SnapshotAt = snap.SnapshotAt,
                Resistance = ToMetric(snap.Resistance, snap.ResistanceObservedAt, snap.IsResistanceCurrent()),
                Rpm = ToMetric(snap.Rpm, snap.RpmObservedAt, snap.IsRpmCurrent()),
                Watts = ToMetric(snap.Watts, snap.WattsObservedAt, snap.IsWattsCurrent()),
                Machine = ToMachine(snap.Machine)
            };
        }

        public static BridgeStatusResponseDto ToStatus(
            BikeTelemetrySnapshot snapshot,
            ResistanceCommandSnapshot requested,
            string version,
            bool resistanceHandlerPresent)
        {
            BikeTelemetrySnapshot snap = snapshot ?? EmptyDisconnected();
            ResistanceCommandSnapshot cmd = requested ?? new ResistanceCommandSnapshot(null, null);
            return new BridgeStatusResponseDto
            {
                Status = "ok",
                BridgeVersion = version ?? BridgeInfo.Version,
                Connected = snap.Connected,
                Initialized = snap.Initialized,
                ResistanceControlAvailable = snap.Connected && snap.Initialized && resistanceHandlerPresent,
                RequestedResistance = cmd.Requested,
                RequestedAt = cmd.RequestedAt,
                ObservedResistance = snap.Resistance,
                ObservedAt = snap.ResistanceObservedAt
            };
        }

        private static MetricObservationDto ToMetric(int? value, DateTime? observedAt, bool current)
        {
            return new MetricObservationDto
            {
                Value = value,
                ObservedAt = observedAt,
                Current = current
            };
        }

        private static MachineMetadataDto ToMachine(MachineInfo machine)
        {
            if (machine == null)
            {
                return null;
            }

            return new MachineMetadataDto
            {
                Type = machine.MachineType,
                ModelNumber = machine.ModelNumber.ToString(CultureInfo.InvariantCulture),
                PartNumber = machine.PartNumber.ToString(CultureInfo.InvariantCulture),
                SerialNumber = machine.SerialNumber.ToString(CultureInfo.InvariantCulture),
                CanSetResistance = machine.CanSetResistance,
                MaxResistanceLevel = machine.MaxResistanceLevel
            };
        }

        private static BikeTelemetrySnapshot EmptyDisconnected()
        {
            return new BikeTelemetrySnapshot(
                false,
                false,
                null,
                null,
                null,
                null,
                null,
                null,
                DateTime.SpecifyKind(DateTime.MinValue, DateTimeKind.Utc),
                null);
        }
    }

    /// <summary>
    /// Explicit JSON writer for the Phase 2 HTTP contract (camelCase).
    /// Does not serialize internal runtime objects.
    /// </summary>
    public static class TelemetryJson
    {
        public static string SerializeHealth(HealthResponseDto dto)
        {
            if (dto == null)
            {
                throw new ArgumentNullException("dto");
            }

            StringBuilder sb = new StringBuilder();
            sb.Append('{');
            WriteString(sb, "status", dto.Status ?? "ok");
            sb.Append(',');
            WriteString(sb, "bridgeVersion", dto.BridgeVersion ?? BridgeInfo.Version);
            sb.Append(',');
            WriteBool(sb, "connected", dto.Connected);
            sb.Append(',');
            WriteBool(sb, "initialized", dto.Initialized);
            sb.Append('}');
            return sb.ToString();
        }

        public static string SerializeError(string error)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append('{');
            WriteString(sb, "error", error ?? string.Empty);
            sb.Append('}');
            return sb.ToString();
        }

        public static string SerializeResistanceAccepted(int requested)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"requested\":");
            sb.Append(requested.ToString(CultureInfo.InvariantCulture));
            sb.Append('}');
            return sb.ToString();
        }

        public static string SerializeStatus(BridgeStatusResponseDto dto)
        {
            if (dto == null)
            {
                throw new ArgumentNullException("dto");
            }

            StringBuilder sb = new StringBuilder();
            sb.Append('{');
            WriteString(sb, "status", dto.Status ?? "ok");
            sb.Append(',');
            WriteString(sb, "bridgeVersion", dto.BridgeVersion ?? BridgeInfo.Version);
            sb.Append(',');
            WriteBool(sb, "connected", dto.Connected);
            sb.Append(',');
            WriteBool(sb, "initialized", dto.Initialized);
            sb.Append(',');
            WriteBool(sb, "resistanceControlAvailable", dto.ResistanceControlAvailable);
            sb.Append(',');
            sb.Append("\"resistance\":{");
            WriteNullableInt(sb, "requested", dto.RequestedResistance);
            sb.Append(',');
            WriteNullableTime(sb, "requestedAt", dto.RequestedAt);
            sb.Append(',');
            WriteNullableInt(sb, "observed", dto.ObservedResistance);
            sb.Append(',');
            WriteNullableTime(sb, "observedAt", dto.ObservedAt);
            sb.Append('}');
            sb.Append('}');
            return sb.ToString();
        }

        public static string SerializeTelemetry(TelemetryResponseDto dto)
        {
            if (dto == null)
            {
                throw new ArgumentNullException("dto");
            }

            StringBuilder sb = new StringBuilder();
            sb.Append('{');
            WriteBool(sb, "connected", dto.Connected);
            sb.Append(',');
            WriteBool(sb, "initialized", dto.Initialized);
            sb.Append(',');
            WriteTime(sb, "snapshotAt", dto.SnapshotAt);
            sb.Append(',');
            WriteMetric(sb, "resistance", dto.Resistance);
            sb.Append(',');
            WriteMetric(sb, "rpm", dto.Rpm);
            sb.Append(',');
            WriteMetric(sb, "watts", dto.Watts);
            sb.Append(',');
            WriteMachine(sb, dto.Machine);
            sb.Append('}');
            return sb.ToString();
        }

        public static string FormatUtc(DateTime utc)
        {
            DateTime t = utc.Kind == DateTimeKind.Utc ? utc : utc.ToUniversalTime();
            return t.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
        }

        private static void WriteMetric(StringBuilder sb, string name, MetricObservationDto metric)
        {
            MetricObservationDto m = metric ?? new MetricObservationDto();
            sb.Append('"').Append(name).Append("\":{");
            WriteNullableInt(sb, "value", m.Value);
            sb.Append(',');
            WriteNullableTime(sb, "observedAt", m.ObservedAt);
            sb.Append(',');
            WriteBool(sb, "current", m.Current);
            sb.Append('}');
        }

        private static void WriteMachine(StringBuilder sb, MachineMetadataDto machine)
        {
            sb.Append("\"machine\":");
            if (machine == null)
            {
                sb.Append("null");
                return;
            }

            sb.Append('{');
            WriteString(sb, "type", machine.Type ?? string.Empty);
            sb.Append(',');
            WriteString(sb, "modelNumber", machine.ModelNumber ?? string.Empty);
            sb.Append(',');
            WriteString(sb, "partNumber", machine.PartNumber ?? string.Empty);
            sb.Append(',');
            WriteString(sb, "serialNumber", machine.SerialNumber ?? string.Empty);
            sb.Append(',');
            WriteBool(sb, "canSetResistance", machine.CanSetResistance);
            sb.Append(',');
            WriteNumber(sb, "maxResistanceLevel", machine.MaxResistanceLevel);
            sb.Append('}');
        }

        private static void WriteString(StringBuilder sb, string name, string value)
        {
            sb.Append('"').Append(name).Append("\":");
            AppendQuoted(sb, value ?? string.Empty);
        }

        private static void WriteBool(StringBuilder sb, string name, bool value)
        {
            sb.Append('"').Append(name).Append("\":").Append(value ? "true" : "false");
        }

        private static void WriteNumber(StringBuilder sb, string name, double value)
        {
            sb.Append('"').Append(name).Append("\":").Append(value.ToString("0.###############", CultureInfo.InvariantCulture));
        }

        private static void WriteNullableInt(StringBuilder sb, string name, int? value)
        {
            sb.Append('"').Append(name).Append("\":");
            if (value.HasValue)
            {
                sb.Append(value.Value.ToString(CultureInfo.InvariantCulture));
            }
            else
            {
                sb.Append("null");
            }
        }

        private static void WriteTime(StringBuilder sb, string name, DateTime utc)
        {
            sb.Append('"').Append(name).Append("\":");
            AppendQuoted(sb, FormatUtc(utc));
        }

        private static void WriteNullableTime(StringBuilder sb, string name, DateTime? utc)
        {
            sb.Append('"').Append(name).Append("\":");
            if (!utc.HasValue)
            {
                sb.Append("null");
                return;
            }

            AppendQuoted(sb, FormatUtc(utc.Value));
        }

        private static void AppendQuoted(StringBuilder sb, string value)
        {
            sb.Append('"');
            if (value != null)
            {
                for (int i = 0; i < value.Length; i++)
                {
                    char c = value[i];
                    switch (c)
                    {
                        case '"':
                            sb.Append("\\\"");
                            break;
                        case '\\':
                            sb.Append("\\\\");
                            break;
                        case '\n':
                            sb.Append("\\n");
                            break;
                        case '\r':
                            sb.Append("\\r");
                            break;
                        case '\t':
                            sb.Append("\\t");
                            break;
                        default:
                            if (c < ' ')
                            {
                                sb.Append("\\u");
                                sb.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                            }
                            else
                            {
                                sb.Append(c);
                            }

                            break;
                    }
                }
            }

            sb.Append('"');
        }
    }
}
