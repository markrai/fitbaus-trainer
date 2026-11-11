// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

internal object ProbeConstants {
    const val LOG_TAG: String = "FITBAUS_EQUIPMENT_PROBE"
    const val USB_PERMISSION_ACTION: String = "com.fitbaus.bikebridge.equipmentprobe.USB_PERMISSION"
    const val OUT_TIMEOUT_MS: Int = 200
    const val IN_TIMEOUT_MS: Int = 1000
    const val MIN_REQUEST_SPACING_MS: Long = 100L
    const val EXTENDED_REQUEST_SPACING_MS: Long = 500L
    const val BASIC_REQUEST_BUDGET: Int = 12
    const val EXTENDED_REQUEST_BUDGET: Int = 120
    const val EXTENDED_DURATION_MS: Long = 60_000L
    /** F2.4 dynamic observation: ~2 Hz overall across WattsRpm / Resistance / ActualResistance. */
    const val DYNAMIC_REQUEST_SPACING_MS: Long = 500L
    const val DYNAMIC_REQUEST_BUDGET: Int = 200
    const val DYNAMIC_DURATION_MS: Long = 90_000L
    const val DYNAMIC_DURATION_MS_MIN: Long = 5_000L
    const val DYNAMIC_DURATION_MS_MAX: Long = 180_000L
    /** Samples after STAGE_START are marked inStabilize until this elapses. */
    const val DYNAMIC_STAGE_STABILIZE_MS: Long = 5_000L
    const val CONSECUTIVE_TRANSPORT_FAILURE_LIMIT: Int = 2

    /** Clamp operator / Intent duration into the safe F2.4 observation window. */
    fun clampDynamicDurationMs(durationMs: Long): Long {
        if (durationMs <= 0L) return DYNAMIC_DURATION_MS
        return durationMs.coerceIn(DYNAMIC_DURATION_MS_MIN, DYNAMIC_DURATION_MS_MAX)
    }

    /** Board MaxResistanceLevel observed on Smart Power 10 (not the Fitbaus app write window). */
    const val BOARD_MAX_RESISTANCE_LEVEL_OBSERVED: Int = 22
    /** Fitbaus application resistance acceptance window (HTTP / writes 1..15). */
    const val APPLICATION_RESISTANCE_MIN: Int = 1
    const val APPLICATION_RESISTANCE_MAX: Int = 15
}
