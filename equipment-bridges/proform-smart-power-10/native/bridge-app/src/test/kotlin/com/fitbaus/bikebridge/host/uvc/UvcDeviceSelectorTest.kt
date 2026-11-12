// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.uvc

import com.fitbaus.bikebridge.host.usb.BikeUsbConstants
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class UvcDeviceSelectorTest {
    private fun c270(name: String = "/dev/bus/usb/001/009") = UvcDeviceInfo(
        deviceName = name,
        vendorId = UvcDeviceSelector.C270_VID,
        productId = UvcDeviceSelector.C270_PID,
        serial = "47515500",
        hasVideoControl = true,
        hasVideoStreaming = true,
    )

    @Test
    fun selectReturnsC270AndSkipsForbiddenPeers() {
        val bike = UvcDeviceInfo(
            "/dev/bus/usb/001/008",
            BikeUsbConstants.VENDOR_ID,
            BikeUsbConstants.PRODUCT_ID,
            null,
            false,
            false,
        )
        val androidBike = UvcDeviceInfo(
            "/dev/bus/usb/001/008b",
            UvcDeviceSelector.BIKE_ANDROID_VID,
            UvcDeviceSelector.BIKE_ANDROID_PID,
            null,
            false,
            false,
        )
        val onboard = UvcDeviceInfo(
            "/dev/bus/usb/001/006",
            UvcDeviceSelector.ONBOARD_VID,
            UvcDeviceSelector.ONBOARD_PID,
            null,
            true,
            true,
        )
        val selected = UvcDeviceSelector.select(listOf(bike, androidBike, onboard, c270()))
        assertEquals(c270().deviceName, selected?.deviceName)
    }

    @Test
    fun selectRejectsC270WithoutUvcInterfaces() {
        val incomplete = c270().copy(hasVideoControl = true, hasVideoStreaming = false)
        assertNull(UvcDeviceSelector.select(listOf(incomplete)))
    }

    @Test
    fun forbiddenMatrix() {
        assertTrue(UvcDeviceSelector.isForbidden(BikeUsbConstants.VENDOR_ID, BikeUsbConstants.PRODUCT_ID))
        assertTrue(UvcDeviceSelector.isForbidden(BikeUsbConstants.VENDOR_ID, BikeUsbConstants.BOOTLOADER_PRODUCT_ID))
        assertTrue(UvcDeviceSelector.isForbidden(UvcDeviceSelector.BIKE_ANDROID_VID, UvcDeviceSelector.BIKE_ANDROID_PID))
        assertTrue(UvcDeviceSelector.isForbidden(UvcDeviceSelector.ONBOARD_VID, UvcDeviceSelector.ONBOARD_PID))
        assertFalse(UvcDeviceSelector.isForbidden(UvcDeviceSelector.C270_VID, UvcDeviceSelector.C270_PID))
    }

    @Test
    fun identityKeyIgnoresSerialAndDevicePath() {
        val a = c270("/dev/bus/usb/001/009").copy(serial = null)
        val b = c270("/dev/bus/usb/001/010").copy(serial = "XYZ")
        assertEquals(a.key, b.key)
        assertEquals("046d:0825", a.key)
    }
}
