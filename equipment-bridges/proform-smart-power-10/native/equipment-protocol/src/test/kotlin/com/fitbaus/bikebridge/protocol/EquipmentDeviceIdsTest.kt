// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class EquipmentDeviceIdsTest {
    @Test
    fun catalogMatchesObservedBikeAddresses() {
        assertEquals(2, EquipmentDeviceIds.MAIN)
        assertEquals(4, EquipmentDeviceIds.TREADMILL)
        assertEquals(6, EquipmentDeviceIds.ELLIPTICAL)
        assertEquals(7, EquipmentDeviceIds.FITNESS_BIKE)
        assertEquals(8, EquipmentDeviceIds.SPIN_BIKE)
        assertEquals(19, EquipmentDeviceIds.FREE_STRIDER)
        assertEquals("FITNESS_BIKE", EquipmentDeviceIds.nameOrNull(7))
        assertTrue(EquipmentDeviceIds.isBikeController(7))
        assertTrue(EquipmentDeviceIds.isBikeController(8))
        assertFalse(EquipmentDeviceIds.isBikeController(4))
        assertEquals("7 (FITNESS_BIKE)", EquipmentDeviceIds.describe(7))
        assertEquals(EquipmentDevice.FITNESS_BIKE, EquipmentDevice.of(7))
    }

    @Test
    fun fitnessBikeIsTheSmartPower10Controller() {
        // F2.3 DeviceInfo(MAIN) adopted address 7; Legacy HTTP machine.type=Bike.
        assertEquals("FITNESS_BIKE", EquipmentDeviceIds.nameOrNull(EquipmentDeviceIds.FITNESS_BIKE))
    }
}
