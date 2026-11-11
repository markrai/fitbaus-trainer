// SPDX-License-Identifier: AGPL-3.0-only
// Portions adapted from STRIDE (https://github.com/keranm/strideApp, commit d9e1b53),
// Copyright 2026 The Idea Works, Apache License 2.0. Modified by Fitbaus. See NOTICE.

package com.fitbaus.bikebridge.protocol

public class EquipmentDevice private constructor(public val id: Int) {

    override fun equals(other: Any?): Boolean = other is EquipmentDevice && other.id == id

    override fun hashCode(): Int = id

    override fun toString(): String = "EquipmentDevice($id)"

    public companion object {
        public const val MIN_ADDRESSABLE_ID: Int = 2
        public const val MAX_ADDRESSABLE_ID: Int = 255

        public val MAIN: EquipmentDevice = EquipmentDevice(EquipmentDeviceIds.MAIN)

        /** Catalog alias; TX requires session CONFIRMED (or DeviceInfo under AWAITING_CONFIRMATION). */
        public val FITNESS_BIKE: EquipmentDevice = EquipmentDevice(EquipmentDeviceIds.FITNESS_BIKE)

        public fun of(id: Int): EquipmentDevice {
            require(id in MIN_ADDRESSABLE_ID..MAX_ADDRESSABLE_ID) {
                "device id must be in $MIN_ADDRESSABLE_ID..$MAX_ADDRESSABLE_ID, was $id"
            }
            return when (id) {
                MAIN.id -> MAIN
                FITNESS_BIKE.id -> FITNESS_BIKE
                else -> EquipmentDevice(id)
            }
        }
    }
}
