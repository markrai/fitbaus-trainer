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
        var disappearOnRequest = false
        var requestBlockMs = 0L
        var openBlockMs = 0L
        var lastRequestId = -1L
        var listDevicesHook: (() -> Unit)? = null
        var gatewayListener: UvcUsbGateway.Listener? = null
        val fd = FakeFd()

        override fun listDevices(): List<UvcDeviceInfo> {
            listDevicesHook?.invoke()
            listDevicesHook = null
            return devices
        }
        override fun hasPermission(deviceName: String) = permitted
        override fun requestPermission(deviceName: String, requestId: Long): Boolean {
            lastRequestId = requestId
            if (requestBlockMs > 0) Thread.sleep(requestBlockMs)
            if (disappearOnRequest) return false
            requests += 1
            if (failRequest) throw IllegalStateException("requestPermission failed")
            return true
        }
        override fun openDevice(deviceName: String): AuthorizedCameraFd? {
            if (openBlockMs > 0) Thread.sleep(openBlockMs)
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

        fun broadcast(
            grantedExtra: Boolean,
            deviceName: String = devices.first().deviceName,
            requestId: Long = lastRequestId,
        ) {
            gatewayListener?.onPermissionBroadcast(deviceName, grantedExtra, requestId)
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

        // After pending clears, a second broadcast must not flip sticky denial.
        gateway.permitted = true
        gateway.broadcast(grantedExtra = false)
        assertEquals(UvcPermissionPhase.Denied, host.phaseForTest(gateway.devices.first().key))

        // Live hasPermission on a later open overrides sticky denial without another broadcast.
        assertTrue(host.openAuthorizedCamera() != null)
        assertEquals(UvcPermissionPhase.Granted, host.phaseForTest(gateway.devices.first().key))
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
        assertEquals("046d:0825:/dev/bus/usb/001/009", withoutSerial.key)
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
    fun pro9000AndGenericUvcFollowSamePermissionFlow() {
        val gateway = FakeGateway().also {
            it.devices = listOf(
                UvcDeviceInfo(
                    "/dev/bus/usb/001/012",
                    UvcDeviceSelector.PRO9000_VID,
                    UvcDeviceSelector.PRO9000_PID,
                    "0C965CD3",
                    true,
                    true,
                ),
            )
        }
        val host = UvcCameraHost(gateway)
        assertNull(host.openAuthorizedCamera())
        assertEquals(1, gateway.requests)
        gateway.permitted = true
        gateway.broadcast(grantedExtra = true)
        assertEquals(UvcPermissionPhase.Granted, host.phaseForTest(gateway.devices.first().key))
        assertTrue(host.openAuthorizedCamera() != null)
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
        val key = "046d:0825:/dev/bus/usb/001/009"
        val threads = 8
        val barrier = CyclicBarrier(threads)
        val errors = AtomicInteger(0)
        val workers = (1..threads).map {
            Thread {
                try {
                    barrier.await(5, TimeUnit.SECONDS)
                    repeat(500) { n ->
                        when (n % 5) {
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

    @Test
    fun closeDuringOpenDeviceDropsFdAndReturnsNull() {
        val gateway = FakeGateway().also {
            it.permitted = true
            it.openBlockMs = 80
        }
        val host = UvcCameraHost(gateway)
        val started = CountDownLatch(1)
        val result = arrayOfNulls<AuthorizedCameraFd>(1)
        Thread {
            started.countDown()
            result[0] = host.openAuthorizedCamera()
        }.start()
        assertTrue(started.await(2, TimeUnit.SECONDS))
        Thread.sleep(15)
        host.close()
        Thread.sleep(120)
        assertNull(result[0])
        assertEquals(1, gateway.fd.closed)
        assertNull(host.openAuthorizedCamera())
    }

    @Test
    fun closeDuringPermissionRequestDropsLateBroadcast() {
        val gateway = FakeGateway().also { it.requestBlockMs = 80 }
        val host = UvcCameraHost(gateway)
        val started = CountDownLatch(1)
        val done = CountDownLatch(1)
        Thread {
            started.countDown()
            host.openAuthorizedCamera()
            done.countDown()
        }.start()
        assertTrue(started.await(2, TimeUnit.SECONDS))
        Thread.sleep(15)
        host.close()
        assertTrue(done.await(5, TimeUnit.SECONDS))
        gateway.permitted = true
        gateway.broadcast(grantedExtra = true)
        assertEquals(UvcPermissionPhase.Unknown, host.phaseForTest(gateway.devices.first().key))
        assertNull(host.openAuthorizedCamera())
    }

    @Test
    fun reusedDeviceNameIgnoresStaleBroadcastFromPriorRequest() {
        val gateway = FakeGateway()
        val host = UvcCameraHost(gateway)
        host.openAuthorizedCamera()
        val staleRequestId = gateway.lastRequestId
        val path = gateway.devices.first().deviceName
        assertEquals(UvcPermissionPhase.Requesting, host.phaseForTest(gateway.devices.first().key))

        // Detach clears pending; a later plug reuses the same bus path / key.
        gateway.detach()
        gateway.devices = listOf(
            UvcDeviceInfo(path, UvcDeviceSelector.C270_VID, UvcDeviceSelector.C270_PID, "NEW", true, true),
        )
        assertNull(host.openAuthorizedCamera())
        val freshRequestId = gateway.lastRequestId
        assertTrue(freshRequestId != staleRequestId)

        // Late result for the first prompt must not authorize the new attachment.
        gateway.permitted = true
        gateway.broadcast(grantedExtra = true, requestId = staleRequestId)
        assertEquals(UvcPermissionPhase.Requesting, host.phaseForTest(gateway.devices.first().key))

        gateway.broadcast(grantedExtra = true, requestId = freshRequestId)
        assertEquals(UvcPermissionPhase.Granted, host.phaseForTest(gateway.devices.first().key))
    }

    @Test
    fun unsolicitedBroadcastWithoutPendingRequestIsIgnored() {
        val gateway = FakeGateway().also { it.permitted = true }
        val host = UvcCameraHost(gateway)
        // No open yet → no pending request; broadcast must not invent Granted state.
        gateway.broadcast(grantedExtra = true, requestId = 99L)
        assertEquals(UvcPermissionPhase.Unknown, host.phaseForTest(gateway.devices.first().key))
        // Authorized open still works via live hasPermission.
        assertTrue(host.openAuthorizedCamera() != null)
    }

    @Test
    fun gatewayPermissionIntentCarriesRequestIdContract() {
        val src = java.io.File(
            "src/main/kotlin/com/fitbaus/bikebridge/host/uvc/AndroidUvcUsbGateway.kt",
        ).readText()
        assertTrue(src.contains("EXTRA_REQUEST_ID"))
        assertTrue(src.contains("putExtra(EXTRA_REQUEST_ID, requestId)"))
        assertTrue(src.contains("getLongExtra(EXTRA_REQUEST_ID"))
        assertTrue(src.contains("fun requestPermission(deviceName: String, requestId: Long): Boolean"))
        assertTrue(src.contains("val device = usbManager.deviceList[deviceName] ?: return false"))
    }

    @Test
    fun deviceGoneDuringRequestPermissionLeavesUnknownNotStuckRequesting() {
        val gateway = FakeGateway().also { it.disappearOnRequest = true }
        val host = UvcCameraHost(gateway)
        assertNull(host.openAuthorizedCamera())
        assertEquals(0, gateway.requests)
        assertEquals(UvcPermissionPhase.Unknown, host.phaseForTest(gateway.devices.first().key))
        gateway.disappearOnRequest = false
        assertNull(host.openAuthorizedCamera())
        assertEquals(1, gateway.requests)
        assertEquals(UvcPermissionPhase.Requesting, host.phaseForTest(gateway.devices.first().key))
    }

    @Test
    fun detachDuringBroadcastDoesNotApplyStalePermissionState() {
        val gateway = FakeGateway()
        val host = UvcCameraHost(gateway)
        host.openAuthorizedCamera()
        val key = gateway.devices.first().key
        val requestId = gateway.lastRequestId
        assertEquals(UvcPermissionPhase.Requesting, host.phaseForTest(key))

        // Detach clears pending; a racing late grant must not resurrect Granted/Denied.
        gateway.detach()
        assertEquals(UvcPermissionPhase.Unknown, host.phaseForTest(key))
        gateway.devices = listOf(
            UvcDeviceInfo("/dev/bus/usb/001/009", UvcDeviceSelector.C270_VID, UvcDeviceSelector.C270_PID, "SN", true, true),
        )
        gateway.permitted = true
        gateway.broadcast(grantedExtra = true, requestId = requestId)
        assertEquals(UvcPermissionPhase.Unknown, host.phaseForTest(key))
    }

    @Test
    fun detachMidPermissionLookupDropsResultAfterRevalidation() {
        val gateway = FakeGateway()
        val host = UvcCameraHost(gateway)
        host.openAuthorizedCamera()
        val key = gateway.devices.first().key
        val requestId = gateway.lastRequestId
        // Claim pending, then detach during listDevices before machine update.
        gateway.listDevicesHook = { gateway.detach() }
        gateway.permitted = true
        gateway.broadcast(grantedExtra = true, requestId = requestId)
        assertEquals(UvcPermissionPhase.Unknown, host.phaseForTest(key))
    }

    @Test
    fun closeDuringBroadcastDoesNotMutateMachine() {
        val gateway = FakeGateway()
        val host = UvcCameraHost(gateway)
        host.openAuthorizedCamera()
        val key = gateway.devices.first().key
        val requestId = gateway.lastRequestId
        host.close()
        gateway.permitted = true
        gateway.broadcast(grantedExtra = true, requestId = requestId)
        assertEquals(UvcPermissionPhase.Unknown, host.phaseForTest(key))
    }

    @Test
    fun closeMidPermissionLookupDropsResultAfterRevalidation() {
        val gateway = FakeGateway()
        val host = UvcCameraHost(gateway)
        host.openAuthorizedCamera()
        val key = gateway.devices.first().key
        val requestId = gateway.lastRequestId
        gateway.listDevicesHook = { host.close() }
        gateway.permitted = true
        gateway.broadcast(grantedExtra = true, requestId = requestId)
        assertEquals(UvcPermissionPhase.Unknown, host.phaseForTest(key))
    }

    @Test
    fun requestIdsDoNotCollideAcrossHostRecreation() {
        val first = FakeGateway()
        val host1 = UvcCameraHost(first)
        host1.openAuthorizedCamera()
        val staleId = first.lastRequestId
        host1.close()

        val second = FakeGateway()
        val host2 = UvcCameraHost(second)
        host2.openAuthorizedCamera()
        val freshId = second.lastRequestId
        assertTrue(freshId > staleId, "recreated host must not reuse prior PendingIntent request ids")

        second.permitted = true
        second.broadcast(grantedExtra = true, requestId = staleId)
        assertEquals(UvcPermissionPhase.Requesting, host2.phaseForTest(second.devices.first().key))
        second.broadcast(grantedExtra = true, requestId = freshId)
        assertEquals(UvcPermissionPhase.Granted, host2.phaseForTest(second.devices.first().key))
    }
}
