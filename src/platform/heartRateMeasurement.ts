/**
 * Standard BLE Heart Rate Measurement (UUID 0x2A37) parser.
 *
 * Flags (byte 0):
 *   bit 0  – Heart Rate Value Format (0 = UINT8, 1 = UINT16)
 *   bit 1–2 – Sensor Contact Status
 *   bit 3  – Energy Expended present
 *   bit 4  – RR-Interval values present
 *
 * Mandatory HR (flags + BPM) is decoded first. If that succeeds, BPM is always
 * returned. Malformed optional Energy/RR fields set `optionalFieldError` and
 * yield empty RR rather than throwing, so BPM consumers are not starved.
 *
 * RR intervals are UINT16 little-endian in units of 1/1024 second.
 * Conversion: rrMs = raw * 1000 / 1024
 */

export interface HeartRateMeasurement {
  bpm: number;
  flags: number;
  /** Decoded RR intervals in milliseconds, in packet order. Empty if none or optional parse failed. */
  rrIntervalsMs: number[];
  /** Energy expended in kilo Joules when flags bit 3 is set and fully parsed. */
  energyExpendedKj?: number;
  /**
   * Present when flags claim optional EE/RR bytes that are truncated or
   * incomplete. BPM remains valid; RR must not enter HRV.
   */
  optionalFieldError?: string;
}

const FLAG_HR_UINT16 = 0x01;
const FLAG_ENERGY_EXPENDED = 0x08;
const FLAG_RR_INTERVALS = 0x10;

export function parseHeartRateMeasurement(value: DataView): HeartRateMeasurement {
  if (!(value instanceof DataView)) {
    throw new Error("Invalid Heart Rate Measurement value");
  }
  if (value.byteLength < 2) {
    throw new Error("Invalid Heart Rate Measurement value");
  }

  const flags = value.getUint8(0);
  let offset = 1;

  let bpm: number;
  if ((flags & FLAG_HR_UINT16) !== 0) {
    if (value.byteLength < offset + 2) {
      throw new Error("Invalid 16-bit Heart Rate Measurement value");
    }
    bpm = value.getUint16(offset, true);
    offset += 2;
  } else {
    if (value.byteLength < offset + 1) {
      throw new Error("Invalid Heart Rate Measurement value");
    }
    bpm = value.getUint8(offset);
    offset += 1;
  }

  const result: HeartRateMeasurement = {
    bpm,
    flags,
    rrIntervalsMs: [],
  };

  let energyExpendedKj: number | undefined;
  if ((flags & FLAG_ENERGY_EXPENDED) !== 0) {
    if (value.byteLength < offset + 2) {
      result.optionalFieldError = "Truncated Heart Rate Measurement: Energy Expended missing";
      return result;
    }
    energyExpendedKj = value.getUint16(offset, true);
    offset += 2;
    result.energyExpendedKj = energyExpendedKj;
  }

  if ((flags & FLAG_RR_INTERVALS) !== 0) {
    const remaining = value.byteLength - offset;
    if (remaining <= 0 || remaining % 2 !== 0) {
      result.optionalFieldError = "Truncated Heart Rate Measurement: RR-Interval field incomplete";
      return result;
    }
    const rrIntervalsMs: number[] = [];
    while (offset + 1 < value.byteLength) {
      const raw = value.getUint16(offset, true);
      offset += 2;
      rrIntervalsMs.push((raw * 1000) / 1024);
    }
    result.rrIntervalsMs = rrIntervalsMs;
  }

  return result;
}
