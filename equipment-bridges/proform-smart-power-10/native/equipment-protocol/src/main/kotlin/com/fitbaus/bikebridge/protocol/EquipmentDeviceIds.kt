// SPDX-License-Identifier: AGPL-3.0-only
// Numeric values confirmed on this bike (F2.1/F2.3 DeviceInfo) and against the
// published STRIDE subset (MAIN/TREADMILL/ELLIPTICAL). Bike addresses are not
// in the STRIDE published table; FITNESS_BIKE=7 is a physical observation.

package com.fitbaus.bikebridge.protocol

/**
 * Brainboard device-address catalog.
 *
 * These are addressable device IDs on the equipment bus — not USB VID/PID.
 * Presence in this catalog does **not** authorize transmit; the read-only
 * gate remains MAIN-only until an explicit, evidence-backed policy change.
 */
public object EquipmentDeviceIds {
    public const val NONE: Int = 0
    public const val MULTIPLE_DEVICES: Int = 1
    public const val MAIN: Int = 2
    public const val PORTAL: Int = 3
    public const val TREADMILL: Int = 4
    public const val INCLINE_TRAINER: Int = 5
    public const val ELLIPTICAL: Int = 6
    /** Upright / fitness bike controller. Legacy HTTP reports machine.type=Bike. */
    public const val FITNESS_BIKE: Int = 7
    /** Spin bike controller. */
    public const val SPIN_BIKE: Int = 8
    public const val VERTICAL_ELLIPTICAL: Int = 9
    /** Strength machine catalog id; unused on this bike. */
    public const val FITNESS_WEIGHT_MACHINE: Int = 13
    public const val FREE_STRIDER: Int = 19
    public const val ROWER: Int = 20
    public const val HEART_RATE_MONITOR: Int = 55

    private val NAMES: Map<Int, String> = mapOf(
        NONE to "NONE",
        MULTIPLE_DEVICES to "MULTIPLE_DEVICES",
        MAIN to "MAIN",
        PORTAL to "PORTAL",
        TREADMILL to "TREADMILL",
        INCLINE_TRAINER to "INCLINE_TRAINER",
        ELLIPTICAL to "ELLIPTICAL",
        FITNESS_BIKE to "FITNESS_BIKE",
        SPIN_BIKE to "SPIN_BIKE",
        VERTICAL_ELLIPTICAL to "VERTICAL_ELLIPTICAL",
        FITNESS_WEIGHT_MACHINE to "FITNESS_WEIGHT_MACHINE",
        FREE_STRIDER to "FREE_STRIDER",
        ROWER to "ROWER",
        HEART_RATE_MONITOR to "HEART_RATE_MONITOR",
    )

    public fun nameOrNull(id: Int): String? = NAMES[id]

    public fun describe(id: Int): String = nameOrNull(id)?.let { "$id ($it)" } ?: id.toString()

    public fun isBikeController(id: Int): Boolean = id == FITNESS_BIKE || id == SPIN_BIKE
}
