// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.controller

import android.hardware.usb.UsbConstants
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class ExclusiveHidTest {
    @Test
    fun usbClaimPolicyExcludesBikeCameraAndMixedClassDevices() {
        val hid = UsbConstants.USB_CLASS_HID
        assertFalse(ExclusiveHidPolicy.permittedDevice(0x213C, 0x0002, listOf(hid)))
        assertFalse(ExclusiveHidPolicy.permittedDevice(0x10C4, 0xEA60, listOf(hid)))
        assertFalse(ExclusiveHidPolicy.permittedDevice(0x1234, 0x5678, emptyList()))
        assertFalse(ExclusiveHidPolicy.permittedDevice(0x1234, 0x5678, listOf(hid, UsbConstants.USB_CLASS_VIDEO)))
        assertTrue(ExclusiveHidPolicy.permittedDevice(0x1234, 0x5678, listOf(hid)))
    }

    @Test
    fun selectionFailsClosedOnDuplicateUsbDevices() {
        val a = HidCandidate("/dev/bus/usb/001/003", 123, 456, 0, 0, 0, 16)
        val b = a.copy(deviceName = "/dev/bus/usb/001/004")
        assertNull(ExclusiveHidPolicy.unique(listOf(a, b), a.key))
        assertNull(ExclusiveHidPolicy.unique(listOf(a), "wrong"))
        assertNull(ExclusiveHidPolicy.unique(listOf(a), null))
        assertEquals(a, ExclusiveHidPolicy.unique(listOf(a), a.key))
    }

    @Test
    fun learnsDigitalButtonMaskAndIgnoresUnrelatedBits() {
        val binding = HidBinding.learn(byteArrayOf(1, 0, 8), byteArrayOf(1, 4, 8))!!
        assertEquals(HidBinding(1, 4, 4), binding)
        assertTrue(binding.matches(byteArrayOf(1, 5, 8)))
        assertFalse(binding.matches(byteArrayOf(1, 1, 8)))
        assertEquals(binding, HidBinding.decode(binding.encode()))
        assertNull(HidBinding.decode("1:0:0"))
        assertNull(HidBinding.decode("999:1:1"))
        assertNull(HidBinding.decode("1:1:4"))
    }

    @Test
    fun learnsHatDirectionsWithoutBothDirectionsMatching() {
        val neutral = byteArrayOf(0x01, 0x08)
        val left = HidBinding.learn(neutral, byteArrayOf(0x01, 0x06))!!
        val right = HidBinding.learn(neutral, byteArrayOf(0x01, 0x02))!!
        assertEquals(15, left.mask)
        assertEquals(15, right.mask)
        assertTrue(left.matches(byteArrayOf(0x01, 0x06)))
        assertFalse(right.matches(byteArrayOf(0x01, 0x06)))
        assertTrue(right.matches(byteArrayOf(0x01, 0x02)))
        assertFalse(left.matches(byteArrayOf(0x01, 0x02)))
        assertFalse(left.matches(neutral))
        assertFalse(right.matches(neutral))
        assertNull(HidBinding.learn(byteArrayOf(1, 2, 3), byteArrayOf(4, 5, 3)))
        assertNull(HidBinding.learn(byteArrayOf(1, 2), byteArrayOf(1)))
    }

    @Test
    fun rawHidBindingsStayWithTheSourceInterfaceAndEndpoint() {
        val neutral = HidReport(byteArrayOf(0x08, 0x00), 1L, 0, 1)
        val pressed = HidReport(byteArrayOf(0x06, 0x00), 2L, 0, 1)
        val anotherInterface = HidReport(byteArrayOf(0x06, 0x00), 3L, 1, 1)
        val anotherEndpoint = HidReport(byteArrayOf(0x06, 0x00), 4L, 0, 2)
        val binding = HidBinding.learn(neutral, pressed)!!
        assertEquals(0, binding.interfaceIndex)
        assertEquals(1, binding.endpointIndex)
        assertTrue(binding.matches(pressed))
        assertFalse(binding.matches(neutral))
        assertFalse(binding.matches(anotherInterface))
        assertFalse(binding.matches(anotherEndpoint))
        assertNull(HidBinding.learn(neutral, anotherInterface))
        assertNull(HidBinding.learn(neutral, anotherEndpoint))
        assertEquals(binding, HidBinding.decode(binding.encode()))
        assertNull(HidBinding.decode("0:15:6:256:1"))
        assertNull(HidBinding.decode("0:15:6:0:256"))
        assertNull(HidBinding.decode("0:15:6:0"))
        assertEquals(HidBinding(0, 15, 6), HidBinding.decode("0:15:6"))
    }

    @Test
    fun automaticRawClaimWaitsForBothCalibratedDirectionsOnTheSameDevice() {
        val candidate = HidCandidate("/dev/bus/usb/001/004", 123, 456, 0, 0, 0, 16)
        val otherDevice = candidate.copy(productId = 457)
        val left = HidBinding(0, 15, 6, 0, 0)
        val right = HidBinding(0, 15, 2, 0, 0)
        val endpoints = setOf(0 to 0)
        assertTrue(BricksRawHidReadiness.canDecode(candidate, candidate.key, left, right, endpoints))
        assertFalse(BricksRawHidReadiness.canDecode(candidate, null, left, right, endpoints))
        assertFalse(BricksRawHidReadiness.canDecode(candidate, otherDevice.key, left, right, endpoints))
        assertFalse(BricksRawHidReadiness.canDecode(candidate, candidate.key, null, right, endpoints))
        assertFalse(BricksRawHidReadiness.canDecode(candidate, candidate.key, left, null, endpoints))
        assertFalse(BricksRawHidReadiness.canDecode(candidate, candidate.key, left, right, emptySet()))
        assertFalse(BricksRawHidReadiness.canDecode(candidate, candidate.key, left.copy(endpointIndex = 1), right, endpoints))
        assertFalse(BricksRawHidReadiness.canDecode(candidate, candidate.key, HidBinding(0, 15, 6), right, endpoints))
        assertFalse(BricksRawHidReadiness.canDecode(null, candidate.key, left, right, endpoints))
    }

    @Test
    @org.junit.jupiter.api.Disabled("Temporary showcase replaces production host wiring; see ShowcaseIsolationTest")
    fun claimLifecycleIsScopedAndDoesNotModifyBikeUsbStack() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/controller/ExclusiveHid.kt").readText()
        val activity = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        val autoClaim = File("src/main/kotlin/com/fitbaus/bikebridge/host/controller/AutoControllerOwnership.kt").readText()
        assertTrue(source.contains("claimInterface(usbInterface, true)"))
        assertTrue(source.contains("reader.initialize(handle, endpoint)"))
        assertTrue(source.contains("handle.requestWait()"))
        assertTrue(source.contains("it.request.cancel()"))
        assertTrue(source.contains("oldConnection.releaseInterface(it)"))
        assertTrue(source.contains("oldConnection.close()"))
        assertTrue(source.contains("for (i in 0 until device.interfaceCount)"))
        assertTrue(source.contains("sources.map { it.interfaceIndex }.distinct().size != device.interfaceCount"))
        assertFalse(source.contains("device.interfaceCount != 1"))
        assertTrue(autoClaim.contains("manager.requestPermission(device, pending)"))
        assertTrue(autoClaim.contains("deniedDevices.add(device.deviceName)"))
        assertTrue(autoClaim.contains("context.registerReceiver(receiver, filter)"))
        assertTrue(autoClaim.contains("context.unregisterReceiver(receiver)"))
        assertTrue(autoClaim.contains("hid.stop()"))
        assertTrue(activity.contains("controllerOwnership.onHostResume()"))
        assertTrue(activity.contains("controllerOwnership.onHostPause()"))
        assertTrue(activity.contains("override fun deactivateArcade(reason: ArcadeStopReason)"))
        assertFalse(source.contains("NativeBridgeService"))
        assertFalse(source.contains("requestResistance"))
    }
}
