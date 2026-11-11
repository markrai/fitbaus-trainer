// SPDX-License-Identifier: AGPL-3.0-only
// Portions adapted from STRIDE (https://github.com/keranm/strideApp, commit d9e1b53),
// Copyright 2026 The Idea Works, Apache License 2.0. Modified by Fitbaus. See NOTICE.

package com.fitbaus.bikebridge.protocol

/**
 * Continuous native telemetry polling plan (N2).
 *
 * Not the F2.4 diagnostic rotation. Watts+RPM are requested every cycle.
 * Resistance (field 2) and ActualResistance (field 18) are sampled less often.
 *
 * [CYCLE_SPACING_MS] is the minimum gap between USB requests (init and poll).
 * It is a request-spacing bound, not a measured refresh rate.
 */
public object ContinuousReadPlan {
    public const val CYCLE_SPACING_MS: Long = 100L
    public const val RESISTANCE_EVERY: Int = 4
    public const val ACTUAL_RESISTANCE_EVERY: Int = 8

    public fun fieldsForCycle(cycle: Int): List<BikeField> {
        val fields = ArrayList<BikeField>(4)
        fields.add(BikeField.WATTS)
        fields.add(BikeField.RPM)
        val safeCycle = if (cycle < 0) 0 else cycle
        if (safeCycle % ACTUAL_RESISTANCE_EVERY == ACTUAL_RESISTANCE_EVERY - 1) {
            fields.add(BikeField.ACTUAL_RESISTANCE)
        } else if (safeCycle % RESISTANCE_EVERY == RESISTANCE_EVERY - 1) {
            fields.add(BikeField.RESISTANCE)
        }
        return fields
    }

    public fun applyReadings(
        previous: NativeTelemetrySnapshot,
        readings: Map<BikeField, FieldValue>,
        nowIso: String,
        maxResistanceLevel: Int?,
        identity: BridgeMachineJson,
        requested: Collection<BikeField>,
    ): NativeTelemetrySnapshot {
        val asked = requested.toSet()
        val watts = metricFrom(readings[BikeField.WATTS], previous.watts, nowIso, asked.contains(BikeField.WATTS))
        val rpm = metricFrom(readings[BikeField.RPM], previous.rpm, nowIso, asked.contains(BikeField.RPM))
        val resistance = metricFromResistance(
            readings[BikeField.RESISTANCE],
            previous.resistance,
            nowIso,
            maxResistanceLevel,
            asked.contains(BikeField.RESISTANCE),
        )
        val actual = metricFromResistance(
            readings[BikeField.ACTUAL_RESISTANCE],
            previous.actualResistance,
            nowIso,
            maxResistanceLevel,
            asked.contains(BikeField.ACTUAL_RESISTANCE),
        )
        val resolvedMax = maxResistanceLevel?.toDouble() ?: identity.maxResistanceLevel
        val machine = identity.copy(
            canSetResistance = identity.canSetResistance && resolvedMax > 0.0,
            maxResistanceLevel = resolvedMax,
        )
        return NativeTelemetrySnapshot(
            connected = true,
            initialized = true,
            snapshotAt = nowIso,
            resistance = resistance,
            rpm = rpm,
            watts = watts,
            machine = machine,
            actualResistance = actual,
            requestedResistance = previous.requestedResistance,
            requestedAt = previous.requestedAt,
            lastResistanceOutcome = previous.lastResistanceOutcome,
        )
    }

    /** Fresh Watts and RPM from this decode: numeric values, not missing/sentinel/malformed. */
    public fun hasFreshWattsAndRpm(readings: Map<BikeField, FieldValue>): Boolean =
        readings[BikeField.WATTS] is FieldValue.Number &&
            readings[BikeField.RPM] is FieldValue.Number

    /** Failed, missing, detached, or stale: values stay, but they are not current. [snapshotAt] is unchanged. */
    public fun afterUnsuccessfulRead(
        previous: NativeTelemetrySnapshot,
        connected: Boolean,
    ): NativeTelemetrySnapshot =
        previous.copy(
            connected = connected,
            resistance = previous.resistance.copy(current = false),
            rpm = previous.rpm.copy(current = false),
            watts = previous.watts.copy(current = false),
            actualResistance = previous.actualResistance.copy(current = false),
        )

    private fun metricFrom(
        value: FieldValue?,
        previous: BridgeMetricJson,
        nowIso: String,
        requested: Boolean,
    ): BridgeMetricJson {
        if (!requested) return previous
        val number = (value as? FieldValue.Number)?.value?.toInt()
            ?: return previous.copy(current = false)
        return BridgeMetricJson(number, nowIso, true)
    }

    private fun metricFromResistance(
        value: FieldValue?,
        previous: BridgeMetricJson,
        nowIso: String,
        maxResistanceLevel: Int?,
        requested: Boolean,
    ): BridgeMetricJson {
        if (!requested) return previous
        when (value) {
            is FieldValue.Number ->
                return BridgeMetricJson(value.value.toInt(), nowIso, true)
            is FieldValue.Undecoded -> {
                val max = maxResistanceLevel ?: return previous.copy(current = false)
                val level = try {
                    ResistanceCodec.decodeLevel(value.bytes(), max)
                } catch (_: Exception) {
                    return previous.copy(current = false)
                }
                return BridgeMetricJson(level.toInt(), nowIso, true)
            }
            else -> return previous.copy(current = false)
        }
    }
}
