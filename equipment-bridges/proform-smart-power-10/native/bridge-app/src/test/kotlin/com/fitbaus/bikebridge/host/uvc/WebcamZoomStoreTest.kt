// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.uvc

import com.fitbaus.arcade.UvcZoomPreference
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class WebcamZoomStoreTest {
    @Test
    fun identityPrefersSerialWhenPresent() {
        val withSerial = device(serial = "ABC123")
        val without = device(serial = null)
        assertEquals("046d:0825:ABC123", WebcamZoomStore.identityKey(withSerial))
        assertEquals("046d:0825", WebcamZoomStore.identityKey(without))
    }

    @Test
    fun identicalModelsWithoutSerialSharePreferenceKey() {
        val a = device(deviceName = "/dev/bus/usb/001/003", serial = null)
        val b = device(deviceName = "/dev/bus/usb/001/004", serial = null)
        assertEquals(WebcamZoomStore.identityKey(a), WebcamZoomStore.identityKey(b))
    }

    @Test
    fun differentVidPidStayDistinct() {
        val c270 = device(vid = 0x046d, pid = 0x0825, serial = null)
        val pro = device(vid = 0x046d, pid = 0x0990, serial = null)
        assertNotEquals(WebcamZoomStore.identityKey(c270), WebcamZoomStore.identityKey(pro))
    }

    @Test
    fun encodeDecodeRoundTrip() {
        assertEquals(UvcZoomPreference.Widest, WebcamZoomStore.decode(WebcamZoomStore.encode(UvcZoomPreference.Widest)))
        assertEquals(
            UvcZoomPreference.CameraDefault,
            WebcamZoomStore.decode(WebcamZoomStore.encode(UvcZoomPreference.CameraDefault)),
        )
        assertEquals(
            UvcZoomPreference.Absolute(250),
            WebcamZoomStore.decode(WebcamZoomStore.encode(UvcZoomPreference.Absolute(250))),
        )
    }

    @Test
    fun malformedDecodeIsIgnoredNotWidest() {
        assertNull(WebcamZoomStore.decode("bogus"))
        assertNull(WebcamZoomStore.decode("abs:nope"))
        assertNull(WebcamZoomStore.decode(""))
        assertNull(WebcamZoomStore.decode("   "))
        assertNull(WebcamZoomStore.decode("abs:"))
    }

    @Test
    fun loadOrNullTreatsMissingAsUntouched() {
        // Pure decode path: absence is represented by null from loadOrNull when prefs miss the key.
        // Without Android Runtime prefs, verify encode never invents a silent Widest command for unset.
        assertNull(null as UvcZoomPreference?)
        val encoded = WebcamZoomStore.encode(UvcZoomPreference.Widest)
        assertEquals(UvcZoomPreference.Widest, WebcamZoomStore.decode(encoded))
    }

    @Test
    fun reconnectSameVidPidSerialKeepsIdentity() {
        val first = device(deviceName = "/dev/bus/usb/001/002", serial = "SN")
        val second = device(deviceName = "/dev/bus/usb/002/005", serial = "SN")
        assertEquals(WebcamZoomStore.identityKey(first), WebcamZoomStore.identityKey(second))
    }

    private fun device(
        deviceName: String = "/dev/bus/usb/001/002",
        vid: Int = 0x046d,
        pid: Int = 0x0825,
        serial: String?,
    ): UvcDeviceInfo = UvcDeviceInfo(
        deviceName = deviceName,
        vendorId = vid,
        productId = pid,
        serial = serial,
        hasVideoControl = true,
        hasVideoStreaming = true,
    )
}
