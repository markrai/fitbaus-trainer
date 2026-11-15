// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.uvc

import com.fitbaus.arcade.AuthorizedCameraFd
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class UvcProcessLifetimeTest {
    private class FakeFd : AuthorizedCameraFd {
        override fun fileDescriptor(): Int = 7
        override fun close() = Unit
    }

    private class FakeGateway : UvcUsbGateway {
        var closed = false
        override fun listDevices(): Collection<UvcDeviceInfo> = emptyList()
        override fun hasPermission(deviceName: String) = false
        override fun requestPermission(deviceName: String, requestId: Long) = false
        override fun openDevice(deviceName: String): AuthorizedCameraFd? = FakeFd()
        override fun setListener(listener: UvcUsbGateway.Listener?) = Unit
        override fun close() {
            closed = true
        }
    }

    @AfterEach
    fun tearDown() {
        UvcProcess.closeForTests()
    }

    @Test
    fun destroyingOneOwnerLeavesHostAliveForOther() {
        val gateway = FakeGateway()
        val host = UvcCameraHost(gateway)
        UvcProcess.installHostForTests(host)
        val bridge = Any()
        val settings = Any()
        UvcProcess.addOwnerForTests(bridge)
        UvcProcess.addOwnerForTests(settings)
        assertEquals(2, UvcProcess.ownerCountForTests())

        UvcProcess.release(bridge)
        assertNotNull(UvcProcess.hostOrNull())
        assertEquals(1, UvcProcess.ownerCountForTests())
        assertTrue(!gateway.closed)

        UvcProcess.release(settings)
        assertNull(UvcProcess.hostOrNull())
        assertTrue(gateway.closed)
        assertEquals(0, UvcProcess.ownerCountForTests())
    }

    @Test
    fun openAuthorizedCameraBindsZoomIdentityFromOpenedDevice() {
        val device = UvcDeviceInfo(
            deviceName = "/dev/bus/usb/001/009",
            vendorId = UvcDeviceSelector.C270_VID,
            productId = UvcDeviceSelector.C270_PID,
            serial = "SN-1",
            hasVideoControl = true,
            hasVideoStreaming = true,
        )
        val gateway = object : UvcUsbGateway {
            override fun listDevices() = listOf(device)
            override fun hasPermission(deviceName: String) = true
            override fun requestPermission(deviceName: String, requestId: Long) = false
            override fun openDevice(deviceName: String): AuthorizedCameraFd = FakeFd()
            override fun setListener(listener: UvcUsbGateway.Listener?) = Unit
            override fun close() = Unit
        }
        val host = UvcCameraHost(gateway)
        val fd = host.openAuthorizedCamera()
        assertNotNull(fd)
        assertEquals("046d:0825:SN-1", fd!!.zoomIdentity())
        fd.close()
        host.close()
    }

    @Test
    fun promptUsbPermissionDoesNotOpenDevice() {
        val device = UvcDeviceInfo(
            deviceName = "/dev/bus/usb/001/009",
            vendorId = UvcDeviceSelector.C270_VID,
            productId = UvcDeviceSelector.C270_PID,
            serial = null,
            hasVideoControl = true,
            hasVideoStreaming = true,
        )
        var opens = 0
        var requests = 0
        val gateway = object : UvcUsbGateway {
            override fun listDevices() = listOf(device)
            override fun hasPermission(deviceName: String) = false
            override fun requestPermission(deviceName: String, requestId: Long): Boolean {
                requests += 1
                return true
            }
            override fun openDevice(deviceName: String): AuthorizedCameraFd? {
                opens += 1
                return FakeFd()
            }
            override fun setListener(listener: UvcUsbGateway.Listener?) = Unit
            override fun close() = Unit
        }
        val host = UvcCameraHost(gateway)
        assertTrue(host.promptUsbPermission())
        assertEquals(1, requests)
        assertEquals(0, opens)
        host.close()
    }

    @Test
    fun lastOwnerReleaseDoesNotCloseOutstandingCameraFd() {
        val device = UvcDeviceInfo(
            deviceName = "/dev/bus/usb/001/009",
            vendorId = UvcDeviceSelector.C270_VID,
            productId = UvcDeviceSelector.C270_PID,
            serial = "SN",
            hasVideoControl = true,
            hasVideoStreaming = true,
        )
        val fd = object : AuthorizedCameraFd {
            var closed = 0
            override fun fileDescriptor(): Int = 7
            override fun close() {
                closed += 1
            }
        }
        var gatewayClosed = false
        val gateway = object : UvcUsbGateway {
            override fun listDevices() = listOf(device)
            override fun hasPermission(deviceName: String) = true
            override fun requestPermission(deviceName: String, requestId: Long) = false
            override fun openDevice(deviceName: String): AuthorizedCameraFd = fd
            override fun setListener(listener: UvcUsbGateway.Listener?) = Unit
            override fun close() {
                gatewayClosed = true
            }
        }
        val host = UvcCameraHost(gateway)
        UvcProcess.installHostForTests(host)
        val owner = Any()
        UvcProcess.addOwnerForTests(owner)
        val opened = host.openAuthorizedCamera()
        assertNotNull(opened)
        // Preview still holds the FD while the Activity releases the host token.
        UvcProcess.release(owner)
        assertTrue(gatewayClosed)
        assertNull(UvcProcess.hostOrNull())
        assertEquals(0, fd.closed)
        opened!!.close()
        assertEquals(1, fd.closed)
    }

    @Test
    fun resolveExternalCameraMatchesOpenAcrossMultipleDevicesAndOrder() {
        val later = UvcDeviceInfo("/dev/bus/usb/002/010", 0x046d, 0x0990, "B", true, true)
        val earlier = UvcDeviceInfo("/dev/bus/usb/001/003", 0x046d, 0x0825, "A", true, true)
        // Insertion order puts later first; authoritative select is by deviceName.
        val devices = listOf(later, earlier)
        assertEquals(earlier, UvcProcess.resolveExternalCamera(devices))

        var openedName = ""
        val gateway = object : UvcUsbGateway {
            override fun listDevices() = devices
            override fun hasPermission(deviceName: String) = true
            override fun requestPermission(deviceName: String, requestId: Long) = false
            override fun openDevice(deviceName: String): AuthorizedCameraFd {
                openedName = deviceName
                return FakeFd()
            }
            override fun setListener(listener: UvcUsbGateway.Listener?) = Unit
            override fun close() = Unit
        }
        val host = UvcCameraHost(gateway)
        UvcProcess.installHostForTests(host)
        assertEquals(earlier, UvcProcess.resolveExternalCamera(host.listDevices()))
        val fd = host.openAuthorizedCamera()
        assertEquals(earlier.deviceName, openedName)
        assertEquals(earlier.key, fd!!.attachmentKey())
        assertEquals(WebcamZoomStore.identityKey(earlier), fd.zoomIdentity())
        // UI selection and open agree under reversed attachment enumeration order.
        assertEquals(UvcProcess.resolveExternalCamera(host.listDevices())!!.key, fd.attachmentKey())
        fd.close()
        UvcProcess.closeForTests()
    }

    @Test
    fun detachAffectsOnlyOpenedAttachment() {
        val opened = "046d:0825:/dev/bus/usb/001/003"
        assertTrue(
            UvcProcess.detachAffectsOpened(opened, "/dev/bus/usb/001/003", opened),
        )
        assertFalse(
            UvcProcess.detachAffectsOpened(
                opened,
                "/dev/bus/usb/002/010",
                "046d:0990:/dev/bus/usb/002/010",
            ),
        )
        assertTrue(
            UvcProcess.detachAffectsOpened(opened, "/dev/bus/usb/001/003", null),
        )
        assertFalse(
            UvcProcess.detachAffectsOpened(opened, "/dev/bus/usb/002/010", null),
        )
        assertFalse(UvcProcess.detachAffectsOpened(null, "/dev/bus/usb/001/003", opened))
    }

    @Test
    fun unrelatedDetachDoesNotNotifyAsOpenedStreamLoss() {
        val a = UvcDeviceInfo("/dev/bus/usb/001/003", 0x046d, 0x0825, "A", true, true)
        val b = UvcDeviceInfo("/dev/bus/usb/002/010", 0x046d, 0x0990, "B", true, true)
        var devices = listOf(a, b)
        var gatewayListener: UvcUsbGateway.Listener? = null
        val gateway = object : UvcUsbGateway {
            override fun listDevices() = devices
            override fun hasPermission(deviceName: String) = true
            override fun requestPermission(deviceName: String, requestId: Long) = false
            override fun openDevice(deviceName: String): AuthorizedCameraFd = FakeFd()
            override fun setListener(listener: UvcUsbGateway.Listener?) {
                gatewayListener = listener
            }
            override fun close() = Unit
        }
        val host = UvcCameraHost(gateway)
        val fd = host.openAuthorizedCamera()
        assertEquals(a.key, fd!!.attachmentKey())
        var stopped = 0
        host.addDetachListener { name, key ->
            if (UvcProcess.detachAffectsOpened(fd.attachmentKey(), name, key)) stopped += 1
        }
        // Detach unrelated camera B.
        devices = listOf(a)
        gatewayListener?.onDeviceDetached(b.deviceName)
        assertEquals(0, stopped)
        // Detach the opened camera A.
        devices = emptyList()
        gatewayListener?.onDeviceDetached(a.deviceName)
        assertEquals(1, stopped)
        fd.close()
        host.close()
    }
}
