// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.uvc

import com.fitbaus.bikebridge.host.usb.BikeUsbConstants
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class UvcDeviceSelectorTest {
    private fun uvc(
        name: String,
        vid: Int,
        pid: Int,
        serial: String? = "SN",
        vc: Boolean = true,
        vs: Boolean = true,
    ) = UvcDeviceInfo(name, vid, pid, serial, vc, vs)

    @Test
    fun selectAcceptsC270AndPro9000AndSkipsForbiddenPeers() {
        val bike = uvc(
            "/dev/bus/usb/001/008",
            BikeUsbConstants.VENDOR_ID,
            BikeUsbConstants.PRODUCT_ID,
            null,
            vc = false,
            vs = false,
        )
        val androidBike = uvc(
            "/dev/bus/usb/001/008b",
            UvcDeviceSelector.BIKE_ANDROID_VID,
            UvcDeviceSelector.BIKE_ANDROID_PID,
            null,
            vc = false,
            vs = false,
        )
        val onboard = uvc(
            "/dev/bus/usb/001/006",
            UvcDeviceSelector.ONBOARD_VID,
            UvcDeviceSelector.ONBOARD_PID,
            null,
        )
        val c270 = uvc("/dev/bus/usb/001/009", UvcDeviceSelector.C270_VID, UvcDeviceSelector.C270_PID)
        val selected = UvcDeviceSelector.select(listOf(bike, androidBike, onboard, c270))
        assertEquals(c270.deviceName, selected?.deviceName)

        val pro9000 = uvc("/dev/bus/usb/001/012", UvcDeviceSelector.PRO9000_VID, UvcDeviceSelector.PRO9000_PID)
        assertEquals(pro9000.deviceName, UvcDeviceSelector.select(listOf(bike, onboard, pro9000))?.deviceName)
    }

    @Test
    fun selectAcceptsUnfamiliarStandardsCompliantUvc() {
        val generic = uvc("/dev/bus/usb/001/020", 0x1234, 0x5678, serial = null)
        assertEquals(generic.deviceName, UvcDeviceSelector.select(listOf(generic))?.deviceName)
    }

    @Test
    fun selectRejectsWithoutUvcInterfaces() {
        val incomplete = uvc("/dev/bus/usb/001/009", UvcDeviceSelector.C270_VID, UvcDeviceSelector.C270_PID, vs = false)
        assertNull(UvcDeviceSelector.select(listOf(incomplete)))
    }

    @Test
    fun selectIsDeterministicAcrossMultipleExternalCameras() {
        val a = uvc("/dev/bus/usb/001/010", 0xaaaa, 0x0001)
        val b = uvc("/dev/bus/usb/001/009", 0xbbbb, 0x0002)
        // Lexicographic deviceName: 001/009 before 001/010
        assertEquals(b.deviceName, UvcDeviceSelector.select(listOf(a, b))?.deviceName)
        assertEquals(b.deviceName, UvcDeviceSelector.select(listOf(b, a))?.deviceName)
    }

    @Test
    fun forbiddenMatrix() {
        assertTrue(UvcDeviceSelector.isForbidden(BikeUsbConstants.VENDOR_ID, BikeUsbConstants.PRODUCT_ID))
        assertTrue(UvcDeviceSelector.isForbidden(BikeUsbConstants.VENDOR_ID, BikeUsbConstants.BOOTLOADER_PRODUCT_ID))
        assertTrue(UvcDeviceSelector.isForbidden(UvcDeviceSelector.BIKE_ANDROID_VID, UvcDeviceSelector.BIKE_ANDROID_PID))
        assertTrue(UvcDeviceSelector.isForbidden(UvcDeviceSelector.ONBOARD_VID, UvcDeviceSelector.ONBOARD_PID))
        assertFalse(UvcDeviceSelector.isForbidden(UvcDeviceSelector.C270_VID, UvcDeviceSelector.C270_PID))
        assertFalse(UvcDeviceSelector.isForbidden(UvcDeviceSelector.PRO9000_VID, UvcDeviceSelector.PRO9000_PID))
    }

    @Test
    fun identityKeyStableWhenSerialAppearsAndIncludesBusPath() {
        val a = uvc("/dev/bus/usb/001/009", UvcDeviceSelector.C270_VID, UvcDeviceSelector.C270_PID, serial = null)
        val b = a.copy(serial = "47515500")
        assertEquals(a.key, b.key)
        assertTrue(a.key.contains("/dev/bus/usb/001/009"))
        assertTrue(a.key.startsWith("046d:0825:"))
        val otherPath = a.copy(deviceName = "/dev/bus/usb/001/010")
        assertTrue(a.key != otherPath.key)
    }
}
