// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.uvc

import com.fitbaus.arcade.AuthorizedCameraFd
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class UvcPermissionFlowTest {
    private class FakeFd : AuthorizedCameraFd {
        var closed = 0
        override fun fileDescriptor(): Int = 7
        override fun close() {
            closed += 1
        }
    }

    private class FakeGateway : UvcUsbGateway {
        var devices = listOf(
            UvcDeviceInfo("/dev/bus/usb/001/009", UvcDeviceSelector.C270_VID, UvcDeviceSelector.C270_PID, "SN", true, true),
        )
        var permitted = false
        var requests = 0
        var opens = 0
        var closed = false
        var failRequest = false
        var requestBlockMs = 0L
        var gatewayListener: UvcUsbGateway.Listener? = null
        val fd = FakeFd()

        override fun listDevices() = devices
        override fun hasPermission(deviceName: String) = permitted
        override fun requestPermission(deviceName: String) {
            if (requestBlockMs > 0) Thread.sleep(requestBlockMs)
            requests += 1
            if (failRequest) throw IllegalStateException("requestPermission failed")
        }
        override fun openDevice(deviceName: String): AuthorizedCameraFd? {
            opens += 1
            return if (permitted) fd else null
        }
        override fun setListener(listener: UvcUsbGateway.Listener?) {
            gatewayListener = listener
        }
        override fun close() {
            closed = true
            gatewayListener = null
        }

        fun broadcast(grantedExtra: Boolean, deviceName: String = devices.first().deviceName) {
            gatewayListener?.onPermissionBroadcast(deviceName, grantedExtra)
        }

        fun detach() {
            val name = devices.first().deviceName
            devices = emptyList()
            gatewayListener?.onDeviceDetached(name)
        }
    }

    @Test
    fun alreadyAuthorizedOpensImmediatelyWithoutPrompt() {
        val gateway = FakeGateway().also { it.permitted = true }
        val host = UvcCameraHost(gateway)
        val fd = host.openAuthorizedCamera()
        assertTrue(fd != null)
        assertEquals(0, gateway.requests)
        assertEquals(1, gateway.opens)
    }

    @Test
    fun firstNeedRequestsOnceAndFallsBack() {
        val gateway = FakeGateway()
        val host = UvcCameraHost(gateway)
        assertNull(host.openAuthorizedCamera())
        assertEquals(1, gateway.requests)
        assertEquals(0, gateway.opens)
        assertEquals(UvcPermissionPhase.Requesting, host.phaseForTest(gateway.devices.first().key))
        // Second enter while still requesting: no repeat prompt.
        assertNull(host.openAuthorizedCamera())
        assertEquals(1, gateway.requests)
    }

    @Test
    fun lateGrantUsesLiveHasPermissionNotBroadcastExtra() {
        val gateway = FakeGateway()
        val host = UvcCameraHost(gateway)
        host.openAuthorizedCamera()
        // Broadcast says granted but UsbManager still denies.
        gateway.broadcast(grantedExtra = true)
        assertEquals(UvcPermissionPhase.Denied, host.phaseForTest(gateway.devices.first().key))
        assertNull(host.openAuthorizedCamera())
        assertEquals(1, gateway.requests)

        gateway.permitted = true
        gateway.broadcast(grantedExtra = false) // extra lies; live wins
        assertEquals(UvcPermissionPhase.Granted, host.phaseForTest(gateway.devices.first().key))
        assertTrue(host.openAuthorizedCamera() != null)
    }

    @Test
    fun denialIsStickyUntilDetach() {
        val gateway = FakeGateway()
        val host = UvcCameraHost(gateway)
        host.openAuthorizedCamera()
        gateway.broadcast(grantedExtra = false)
        assertEquals(UvcPermissionPhase.Denied, host.phaseForTest(gateway.devices.first().key))
        assertNull(host.openAuthorizedCamera())
        assertEquals(1, gateway.requests)

        val priorKey = gateway.devices.first().key
        gateway.detach()
        assertEquals(UvcPermissionPhase.Unknown, host.phaseForTest(priorKey))
        // After detach, a new attachment can prompt again.
        gateway.devices = listOf(
            UvcDeviceInfo("/dev/bus/usb/001/010", UvcDeviceSelector.C270_VID, UvcDeviceSelector.C270_PID, "SN2", true, true),
        )
        assertEquals(UvcPermissionPhase.Unknown, host.phaseForTest(gateway.devices.first().key))
        assertNull(host.openAuthorizedCamera())
        assertEquals(2, gateway.requests)
    }

    @Test
    fun abandonedRequestDoesNotBlockLaterAuthorizedOpen() {
        val gateway = FakeGateway()
        val host = UvcCameraHost(gateway)
        host.openAuthorizedCamera() // starts Requesting
        gateway.permitted = true // user granted elsewhere / already authorized on re-check
        val fd = host.openAuthorizedCamera()
        assertTrue(fd != null)
        assertEquals(1, gateway.requests)
    }

    @Test
    fun deviceKeyStableWhenSerialAppearsAfterPermission() {
        val withoutSerial = UvcDeviceInfo(
            "/dev/bus/usb/001/009",
            UvcDeviceSelector.C270_VID,
            UvcDeviceSelector.C270_PID,
            null,
            true,
            true,
        )
        val withSerial = withoutSerial.copy(serial = "47515500")
        assertEquals(withoutSerial.key, withSerial.key)
        assertEquals("046d:0825", withoutSerial.key)
    }

    @Test
    fun requestPermissionFailureLeavesUnknownNotStuckRequesting() {
        val gateway = FakeGateway().also { it.failRequest = true }
        val host = UvcCameraHost(gateway)
        assertNull(host.openAuthorizedCamera())
        assertEquals(UvcPermissionPhase.Unknown, host.phaseForTest(gateway.devices.first().key))
        gateway.failRequest = false
        assertNull(host.openAuthorizedCamera())
        assertEquals(2, gateway.requests)
        assertEquals(UvcPermissionPhase.Requesting, host.phaseForTest(gateway.devices.first().key))
    }

    @Test
    fun staleBroadcastForUnrelatedDeviceNameIsIgnored() {
        val gateway = FakeGateway()
        val host = UvcCameraHost(gateway)
        host.openAuthorizedCamera()
        assertEquals(UvcPermissionPhase.Requesting, host.phaseForTest(gateway.devices.first().key))
        gateway.broadcast(grantedExtra = true, deviceName = "/dev/bus/usb/001/099")
        assertEquals(UvcPermissionPhase.Requesting, host.phaseForTest(gateway.devices.first().key))
        gateway.permitted = true
        gateway.broadcast(grantedExtra = true)
        assertEquals(UvcPermissionPhase.Granted, host.phaseForTest(gateway.devices.first().key))
    }

    @Test
    fun closeUnregistersAndBlocksFurtherOpens() {
        val gateway = FakeGateway()
        val host = UvcCameraHost(gateway)
        host.openAuthorizedCamera()
        assertEquals(UvcPermissionPhase.Requesting, host.phaseForTest(gateway.devices.first().key))
        host.close()
        assertTrue(gateway.closed)
        assertNull(gateway.gatewayListener)
        assertNull(host.openAuthorizedCamera())
        assertEquals(1, gateway.requests)
        assertEquals(UvcPermissionPhase.Unknown, host.phaseForTest(gateway.devices.first().key))
    }

    @Test
    fun machineSurvivesConcurrentMutations() {
        val machine = UvcPermissionMachine()
        val key = "046d:0825"
        val threads = 8
        val barrier = CyclicBarrier(threads)
        val errors = AtomicInteger(0)
        val workers = (1..threads).map {
            Thread {
                try {
                    barrier.await(5, TimeUnit.SECONDS)
                    repeat(500) {
                        when (it % 5) {
                            0 -> machine.onOpenAttempt(key, false)
                            1 -> machine.onOpenAttempt(key, true)
                            2 -> machine.onPermissionResult(key, false)
                            3 -> machine.onPermissionResult(key, true)
                            else -> {
                                machine.onRequestFailed(key)
                                machine.onDetached(key)
                            }
                        }
                    }
                } catch (t: Throwable) {
                    errors.incrementAndGet()
                    t.printStackTrace()
                }
            }
        }
        workers.forEach { it.start() }
        workers.forEach { it.join(10_000) }
        assertEquals(0, errors.get())
        assertTrue(machine.phase(key) in UvcPermissionPhase.entries.toSet())
    }

    @Test
    fun hostConcurrentOpenAndBroadcastDoNotDeadlock() {
        val gateway = FakeGateway().also { it.requestBlockMs = 40 }
        val host = UvcCameraHost(gateway)
        val started = CountDownLatch(1)
        val done = CountDownLatch(1)
        Thread {
            started.countDown()
            host.openAuthorizedCamera()
            done.countDown()
        }.start()
        assertTrue(started.await(2, TimeUnit.SECONDS))
        Thread.sleep(10)
        gateway.permitted = true
        gateway.broadcast(grantedExtra = true)
        assertTrue(done.await(5, TimeUnit.SECONDS))
        // Subsequent open with permission succeeds.
        assertTrue(host.openAuthorizedCamera() != null)
    }
}
