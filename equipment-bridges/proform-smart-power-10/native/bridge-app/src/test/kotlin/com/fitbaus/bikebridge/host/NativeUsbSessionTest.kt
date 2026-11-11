// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import com.fitbaus.bikebridge.host.usb.BikeUsbConstants
import com.fitbaus.bikebridge.host.usb.OpenResult
import com.fitbaus.bikebridge.host.usb.ProbeTransport
import com.fitbaus.bikebridge.host.usb.TransportFailureClass
import com.fitbaus.bikebridge.host.usb.TransportResult
import com.fitbaus.bikebridge.host.usb.UsbDeviceSnapshot
import com.fitbaus.bikebridge.host.usb.UsbEndpointSnapshot
import com.fitbaus.bikebridge.host.usb.UsbHostGateway
import com.fitbaus.bikebridge.host.usb.UsbInterfaceSnapshot
import com.fitbaus.bikebridge.host.usb.UsbQualificationResult
import com.fitbaus.bikebridge.host.usb.ValidatedProbeTransport
import com.fitbaus.bikebridge.host.policy.TransmitAllowlist
import com.fitbaus.bikebridge.protocol.BridgeHttpJson
import com.fitbaus.bikebridge.protocol.EquipmentCommand
import com.fitbaus.bikebridge.protocol.EquipmentDevice
import com.fitbaus.bikebridge.protocol.EquipmentDeviceIds
import com.fitbaus.bikebridge.protocol.EquipmentFrameCodec
import com.fitbaus.bikebridge.protocol.EquipmentRequests
import com.fitbaus.bikebridge.protocol.EquipmentStatus
import com.fitbaus.bikebridge.protocol.IdentityResult
import com.fitbaus.bikebridge.protocol.MachineIdentity
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.ArrayDeque
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class NativeUsbSessionTest {
    @Test
    fun failedExchangeDoesNotRefreshSnapshotAtOrKeepMetricsCurrent() {
        val clock = TestClock()
        val transport = ScriptedBikeTransport()
        val session = sessionFor(transport, clock)
        session.start()
        waitUntil(session) { session.snapshot().watts.current }
        val afterOk = session.snapshot()
        transport.failRemaining = true
        waitUntil(session) { !session.snapshot().watts.current }
        val nAtFail = clock.get()
        Thread.sleep(40)
        val failed = session.snapshot()
        session.stop()
        assertFalse(failed.connected)
        assertFalse(failed.watts.current)
        assertFalse(failed.rpm.current)
        assertEquals(afterOk.watts.value, failed.watts.value)
        assertEquals(failed.watts.observedAt, failed.snapshotAt)
        assertEquals(nAtFail, clock.get())
    }

    @Test
    fun detachReconnectsWithinBound() {
        val first = ScriptedBikeTransport()
        val second = ScriptedBikeTransport()
        val queue = ArrayDeque(listOf(first, second))
        val gateway = FakeUsbGateway(listOf(matchingBrainboard())) {
            OpenResult.Opened(ValidatedProbeTransport(queue.removeFirst()))
        }
        gateway.grant("bike0")
        val session = NativeUsbSession(
            gateway = gateway,
            requestPermission = { false },
            sleeper = {},
            minRequestSpacingMs = 0,
            maxReconnectAttempts = 5,
            reconnectDelayMs = 0,
        )
        session.start()
        waitUntil(session) { session.snapshot().connected }
        first.detach()
        waitUntil(session) { second.sent.isNotEmpty() }
        session.stop()
        assertTrue(first.closed)
        assertTrue(gateway.openCalls >= 2)
        assertTrue(second.sent.isNotEmpty())
    }

    @Test
    fun stopReleasesUsbBeforeReturning() {
        val transport = ScriptedBikeTransport()
        val session = sessionFor(transport, TestClock())
        session.start()
        waitUntil(session) { session.snapshot().connected }
        assertEquals(SessionStopResult.Released, session.stop())
        assertTrue(transport.closed)
        assertTrue(transport.closeLatch.await(0, TimeUnit.MILLISECONDS))
        assertFalse(session.snapshot().watts.current)
        assertFalse(session.usbWorkerAlive())
    }

    @Test
    fun terminalFailureReasonsAreNotOverwrittenWithStopped() {
        val security = ScriptedBikeTransport()
        val securitySession = sessionFor(security, TestClock())
        securitySession.start()
        waitUntil(securitySession) { securitySession.snapshot().connected }
        security.locked = true
        waitUntil(securitySession) { !securitySession.usbWorkerAlive() }
        assertTrue(securitySession.statusLine().contains("identity incomplete"), securitySession.statusLine())
        assertFalse(securitySession.statusLine() == "stopped")
        assertEquals(SessionStopResult.Released, securitySession.stop())
        assertTrue(securitySession.statusLine().contains("identity incomplete"), securitySession.statusLine())

        val bootstrap = ScriptedBikeTransport()
        bootstrap.failDeviceInfo = true
        val bootstrapSession = sessionFor(bootstrap, TestClock())
        bootstrapSession.start()
        waitUntil(bootstrapSession) { !bootstrapSession.usbWorkerAlive() }
        assertTrue(bootstrapSession.statusLine().contains("bootstrap DeviceInfo(MAIN) failed"), bootstrapSession.statusLine())
        assertFalse(bootstrapSession.statusLine() == "stopped")
        bootstrapSession.stop()
        assertTrue(bootstrapSession.statusLine().contains("bootstrap DeviceInfo(MAIN) failed"), bootstrapSession.statusLine())

        val gateway = FakeUsbGateway(emptyList()) { OpenResult.Failed("none") }
        val exhausted = NativeUsbSession(
            gateway = gateway,
            requestPermission = { false },
            sleeper = {},
            minRequestSpacingMs = 0,
            maxReconnectAttempts = 0,
            reconnectDelayMs = 0,
        )
        exhausted.start()
        waitUntil(exhausted) { !exhausted.usbWorkerAlive() }
        assertEquals("usb reconnect exhausted", exhausted.statusLine())
        exhausted.stop()
        assertEquals("usb reconnect exhausted", exhausted.statusLine())
    }

    @Test
    fun stopJoinTimeoutDoesNotClaimUsbReleased() {
        val transport = ScriptedBikeTransport()
        val session = NativeUsbSession(
            gateway = gatewayFor(transport),
            requestPermission = { false },
            sleeper = {},
            minRequestSpacingMs = 0,
            reconnectDelayMs = 0,
            stopJoinMs = 80,
        )
        session.start()
        waitUntil(session) { session.snapshot().connected }
        transport.hangExchangeMs = 400
        assertTrue(transport.hangEntered.await(2, TimeUnit.SECONDS), "worker never entered hung USB exchange")
        val result = session.stop()
        assertEquals(SessionStopResult.TimedOut, result)
        assertTrue(session.usbWorkerAlive())
        assertFalse(transport.closed)
        assertTrue(session.statusLine().contains("USB may still be held"), session.statusLine())
        waitUntil(session) { transport.closed }
        assertEquals(SessionStopResult.Released, session.stop())
        assertFalse(session.usbWorkerAlive())
    }

    @Test
    fun terminalClaimFailureDoesNotReconnect() {
        val gateway = FakeUsbGateway(listOf(matchingBrainboard())) {
            OpenResult.Failed(
                "claimInterface(force=true) failed for qualified 0x213C:0x0002 interface 0; not retrying",
                retryable = false,
            )
        }
        gateway.grant("bike0")
        val session = NativeUsbSession(
            gateway = gateway,
            requestPermission = { false },
            sleeper = {},
            minRequestSpacingMs = 0,
            maxReconnectAttempts = 5,
            reconnectDelayMs = 0,
        )
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        assertEquals(1, gateway.openCalls)
        assertTrue(session.statusLine().contains("claimInterface(force=true)"), session.statusLine())
        assertFalse(session.statusLine().contains("usb reconnect exhausted"), session.statusLine())
        session.stop()
        assertEquals(1, gateway.openCalls)
        assertTrue(session.statusLine().contains("claimInterface(force=true)"), session.statusLine())
    }

    @Test
    fun retryableOpenFailureStillReconnectsUntilExhausted() {
        val gateway = FakeUsbGateway(listOf(matchingBrainboard())) {
            OpenResult.Failed("openDevice returned null", retryable = true)
        }
        gateway.grant("bike0")
        val session = NativeUsbSession(
            gateway = gateway,
            requestPermission = { false },
            sleeper = {},
            minRequestSpacingMs = 0,
            maxReconnectAttempts = 2,
            reconnectDelayMs = 0,
        )
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        assertEquals(3, gateway.openCalls)
        assertEquals("usb reconnect exhausted", session.statusLine())
        session.stop()
    }

    @Test
    fun missingUsbPublishesDisconnectedAndKeepsRetryingWhenUnlimited() {
        val gateway = FakeUsbGateway(emptyList()) { OpenResult.Failed("none") }
        val session = NativeUsbSession(
            gateway = gateway,
            requestPermission = { false },
            sleeper = {},
            minRequestSpacingMs = 0,
            maxReconnectAttempts = HostConstants.UNLIMITED_USB_RECONNECT,
            reconnectDelayMs = 0,
        )
        session.start()
        waitUntil(session) { session.statusLine().contains("usb rejected") }
        assertTrue(session.usbWorkerAlive(), session.statusLine())
        assertFalse(session.snapshot().connected)
        assertEquals(0, gateway.openCalls)
        session.stop()
        assertFalse(session.usbWorkerAlive())
    }

    @Test
    fun field2WriteIsAcceptedAfterUsbDoneAndDoesNotSendVerifySecurity() {
        val transport = ScriptedBikeTransport()
        val session = sessionFor(transport, TestClock())
        session.start()
        waitUntil(session) { session.snapshot().connected && session.snapshot().machine.canSetResistance }
        val result = session.setResistance(2)
        assertEquals(200, result.statusCode, result.body)
        assertTrue(result.body.contains("\"requested\":2"), result.body)
        assertEquals(2, session.snapshot().requestedResistance)
        assertEquals(0, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        val writes = transport.snapshotSent().filter {
            it.size > 4 &&
                it[2].toInt() == EquipmentCommand.READ_WRITE_DATA.id &&
                (it[3].toInt() and 0xFF) != 0
        }
        assertEquals(1, writes.size, "expected one field-2 write")
        assertEquals(0x04, writes[0][4].toInt() and 0xFF)
        session.stop()
    }

    @Test
    fun resistanceWriteSecurityBlockDoesNotSendVerifySecurity() {
        val transport = ScriptedBikeTransport()
        transport.securityBlockResistanceWrite = true
        val session = sessionFor(transport, TestClock())
        session.start()
        waitUntil(session) { session.snapshot().machine.canSetResistance }
        val result = session.setResistance(3)
        assertEquals(502, result.statusCode, result.body)
        assertTrue(result.body.contains("security block after transmit"), result.body)
        assertTrue(result.body.contains("write authorization blocked"), result.body)
        assertFalse(result.body.contains("VerifySecurity is not enabled"), result.body)
        assertEquals(0, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertEquals(null, session.snapshot().requestedResistance)
        assertFalse(session.snapshot().machine.canSetResistance)
        assertTrue(
            session.lastResistanceOutcome()!!.contains("rejected after transmit: security block"),
            session.lastResistanceOutcome(),
        )
        assertTrue(session.statusLine().contains("write security block"), session.statusLine())
        waitUntil(session) { session.snapshot().watts.current }
        assertTrue(session.snapshot().connected)
        assertTrue(session.snapshot().initialized)
        assertFalse(session.snapshot().machine.canSetResistance)
        assertTrue(
            BridgeHttpJson.status(session.snapshot()).contains("\"resistanceControlAvailable\":false"),
        )
        assertTrue(
            BridgeHttpJson.status(session.snapshot()).contains("lastResistanceOutcome"),
        )
        val retry = session.setResistance(4)
        assertEquals(503, retry.statusCode, retry.body)
        assertTrue(retry.body.contains("resistance control unavailable"), retry.body)
        val writes = transport.snapshotSent().filter {
            it.size > 4 &&
                it[2].toInt() == EquipmentCommand.READ_WRITE_DATA.id &&
                (it[3].toInt() and 0xFF) != 0
        }
        assertEquals(1, writes.size, "security-blocked write must not be retried")
        session.stop()
    }

    @Test
    fun bikeStatusRejectionAfterTransmitIsNotReportedAsNotTransmitted() {
        for (status in listOf(EquipmentStatus.FAILED, EquipmentStatus.IN_PROGRESS, EquipmentStatus.COMMUNICATION_FAILED)) {
            val transport = ScriptedBikeTransport()
            transport.rejectResistanceWriteWith = status
            val session = sessionFor(transport, TestClock())
            session.start()
            waitUntil(session) { session.snapshot().machine.canSetResistance }
            val result = session.setResistance(3)
            assertEquals(502, result.statusCode, "$status ${result.body}")
            assertTrue(result.body.contains("rejected after transmit ($status/"), result.body)
            assertFalse(result.body.contains("not transmitted"), result.body)
            assertEquals(1, transport.writesSeen.get())
            assertEquals(null, session.snapshot().requestedResistance)
            Thread.sleep(50)
            assertEquals(1, transport.writesSeen.get())
            session.stop()
        }
    }

    @Test
    fun resistanceWriteRejectedOutOfRangeWithoutUsbWrite() {
        val transport = ScriptedBikeTransport()
        val session = sessionFor(transport, TestClock())
        session.start()
        waitUntil(session) { session.snapshot().connected }
        fun writeCount() = transport.snapshotSent().count {
            it.size > 3 &&
                it[2].toInt() == EquipmentCommand.READ_WRITE_DATA.id &&
                (it[3].toInt() and 0xFF) != 0
        }
        val before = writeCount()
        val result = session.setResistance(0)
        assertEquals(400, result.statusCode, result.body)
        assertEquals(before, writeCount())
        session.stop()
    }

    @Test
    fun httpBindFailureDoesNotOpenUsb() {
        val transport = ScriptedBikeTransport()
        val session = sessionFor(transport, TestClock())
        val blocker = NativeHttpServer(
            bindAddress = "127.0.0.1",
            port = 0,
            snapshot = { session.snapshot() },
        )
        blocker.start()
        val occupied = blocker.boundPort()
        val second = NativeHttpServer(
            bindAddress = "127.0.0.1",
            port = occupied,
            snapshot = { session.snapshot() },
        )
        val started = startHttpThenUsb(second, session)
        Thread.sleep(80)
        assertFalse(started)
        assertEquals(0, transport.sent.size)
        assertFalse(transport.closed)
        session.stop()
        second.stop()
        blocker.stop()
    }

    @Test
    fun requestSpacingAppliesDuringInit() {
        val times = ArrayList<Long>()
        val transport = ScriptedBikeTransport(onExchange = { times += System.nanoTime() })
        val session = NativeUsbSession(
            gateway = gatewayFor(transport),
            requestPermission = { false },
            sleeper = { Thread.sleep(it) },
            minRequestSpacingMs = 40,
            reconnectDelayMs = 0,
        )
        session.start()
        waitUntil(session) { times.size >= 3 }
        session.stop()
        assertTrue(times.size >= 3)
        for (i in 1 until times.size) {
            val gapMs = (times[i] - times[i - 1]) / 1_000_000L
            assertTrue(gapMs >= 30, "init/poll gap $gapMs ms between exchanges $i and ${i - 1}")
        }
    }

    @Test
    fun warmStateN2DoesNotAuthenticate() {
        val transport = ScriptedBikeTransport()
        val session = sessionFor(transport, TestClock())
        session.start()
        waitUntil(session) { session.snapshot().connected && session.snapshot().watts.current }
        assertTrue(session.statusLine().contains("polling warm-state"), session.statusLine())
        session.stop()
        assertEquals(0, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertEquals(0, commandCount(transport, EquipmentCommand.SYSTEM_INFO))
        assertEquals(0, commandCount(transport, EquipmentCommand.VERSION_INFO))
        assertTrue(commandCount(transport, EquipmentCommand.DEVICE_INFO) >= 2)
        assertTrue(commandCount(transport, EquipmentCommand.READ_WRITE_DATA) >= 2)
        assertFalse(sentCommands(transport).contains(128))
        assertFalse(sentCommands(transport).contains(136))
    }

    @Test
    fun authOnlyColdStartSendsOneVerifySecurityThenAcceptsField2Write() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        val session = sessionFor(transport, TestClock(), plan = ColdStartWritePlan.AuthOnly)
        session.start()
        waitUntil(session) { session.snapshot().connected && session.snapshot().machine.canSetResistance }
        assertTrue(session.statusLine().contains("polling cold-start-auth"), session.statusLine())
        val result = session.setResistance(3)
        assertEquals(200, result.statusCode, result.body)
        session.stop()
        assertEquals(1, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertTrue(commandCount(transport, EquipmentCommand.SYSTEM_INFO) >= 1)
        assertTrue(commandCount(transport, EquipmentCommand.VERSION_INFO) >= 1)
        assertEquals(0, idleModeLockoutWriteCount(transport))
        assertEquals(1, field2WriteCount(transport))
        assertFalse(sentCommands(transport).contains(128))
        assertFalse(sentCommands(transport).contains(136))
        assertEquals(setOf(EquipmentDeviceIds.MAIN), devicesFor(transport, EquipmentCommand.SYSTEM_INFO))
        assertEquals(setOf(EquipmentDeviceIds.MAIN), devicesFor(transport, EquipmentCommand.VERSION_INFO))
        assertEquals(setOf(EquipmentDeviceIds.FITNESS_BIKE), devicesFor(transport, EquipmentCommand.VERIFY_SECURITY))
        assertTrue(nonemptyWritePackets(transport).all { (it[0].toInt() and 0xFF) == EquipmentDeviceIds.FITNESS_BIKE })
        assertFalse(statusLeaksIdentity(session.statusLine()))
    }

    @Test
    fun authOnlyHashesMainIdentityWhenPrimarySystemInfoDiffers() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        transport.divergentPrimaryIdentity = true
        val session = sessionFor(transport, TestClock(), plan = ColdStartWritePlan.AuthOnly)
        session.start()
        waitUntil(session) { session.snapshot().connected && session.snapshot().machine.canSetResistance }
        val result = session.setResistance(3)
        assertEquals(200, result.statusCode, result.body)
        session.stop()
        val vs = transport.snapshotSent().single { (it[2].toInt() and 0xFF) == EquipmentCommand.VERIFY_SECURITY.id }
        assertEquals(EquipmentDeviceIds.FITNESS_BIKE, vs[0].toInt() and 0xFF)
        assertEquals(expectedAuthOnlyVerifySecurity().toList(), vs.toList())
        assertTrue(vs.toList() != decoyPrimaryVerifySecurity().toList())
        assertEquals(setOf(EquipmentDeviceIds.MAIN), devicesFor(transport, EquipmentCommand.SYSTEM_INFO))
        assertEquals(1, field2WriteCount(transport))
        assertTrue(nonemptyWritePackets(transport).all { (it[0].toInt() and 0xFF) == EquipmentDeviceIds.FITNESS_BIKE })
        assertFalse(statusLeaksIdentity(session.statusLine()))
    }

    @Test
    fun authPlusIdleLockoutWritesField95ThenAcceptsField2Write() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        val session = sessionFor(transport, TestClock(), plan = ColdStartWritePlan.AuthPlusIdleLockout)
        session.start()
        waitUntil(session) { session.snapshot().connected && session.snapshot().machine.canSetResistance }
        assertTrue(session.statusLine().contains("polling cold-start-auth-lockout"), session.statusLine())
        val result = session.setResistance(3)
        assertEquals(200, result.statusCode, result.body)
        session.stop()
        assertEquals(1, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertEquals(1, idleModeLockoutWriteCount(transport))
        assertEquals(1, field2WriteCount(transport))
        assertFalse(statusLeaksIdentity(session.statusLine()))
    }

    @Test
    fun authOnlyWriteSecurityBlockDoesNotSendSecondVerifySecurity() {
        val transport = ScriptedBikeTransport()
        transport.identityMode = IdentityMode.Valid
        transport.securityBlockResistanceWrite = true
        val session = sessionFor(transport, TestClock(), plan = ColdStartWritePlan.AuthOnly)
        session.start()
        waitUntil(session) { session.snapshot().machine.canSetResistance }
        val result = session.setResistance(3)
        assertEquals(502, result.statusCode, result.body)
        assertTrue(result.body.contains("write authorization blocked"), result.body)
        assertEquals(1, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertFalse(session.snapshot().machine.canSetResistance)
        val retry = session.setResistance(4)
        assertEquals(503, retry.statusCode, retry.body)
        assertEquals(1, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertEquals(1, field2WriteCount(transport))
        session.stop()
    }

    @Test
    fun authOnlyVerifySecurityRejectedStopsWithoutResistanceWriteOrLockout() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        transport.verifySecurityReply = VerifySecurityReply.StillLocked
        val session = sessionFor(transport, TestClock(), plan = ColdStartWritePlan.AuthOnly)
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        session.stop()
        assertTrue(session.statusLine().contains("VerifySecurity rejected"), session.statusLine())
        assertEquals(1, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertEquals(0, idleModeLockoutWriteCount(transport))
        assertEquals(0, field2WriteCount(transport))
        assertFalse(session.snapshot().connected)
        assertFalse(session.statusLine().contains("VerifySecurity controller Unlocked"), session.statusLine())
    }

    @Test
    fun authOnlyWithoutIdentityFailsClosedWithoutVerifySecurity() {
        val transport = ScriptedBikeTransport()
        transport.identityMode = IdentityMode.None
        val session = sessionFor(transport, TestClock(), plan = ColdStartWritePlan.AuthOnly)
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        session.stop()
        assertTrue(session.statusLine().contains("identity incomplete"), session.statusLine())
        assertEquals(0, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertFalse(session.snapshot().connected)
    }

    @Test
    fun authOnlyReconnectReauthenticatesOncePerUsbSession() {
        val first = ScriptedBikeTransport()
        first.locked = true
        first.identityMode = IdentityMode.Valid
        val second = ScriptedBikeTransport()
        second.locked = true
        second.identityMode = IdentityMode.Valid
        val queue = ArrayDeque(listOf(first, second))
        val gateway = FakeUsbGateway(listOf(matchingBrainboard())) {
            OpenResult.Opened(ValidatedProbeTransport(queue.removeFirst()))
        }
        gateway.grant("bike0")
        val session = NativeUsbSession(
            gateway = gateway,
            requestPermission = { false },
            sleeper = {},
            minRequestSpacingMs = 0,
            maxReconnectAttempts = 5,
            reconnectDelayMs = 0,
            coldStartWritePlan = ColdStartWritePlan.AuthOnly,
            resistanceQueueWaitMs = 0,
        )
        session.start()
        waitUntil(session) { session.snapshot().connected && session.snapshot().machine.canSetResistance }
        assertEquals(1, commandCount(first, EquipmentCommand.VERIFY_SECURITY))
        first.detach()
        waitUntil(session) {
            commandCount(second, EquipmentCommand.VERIFY_SECURITY) == 1 &&
                session.snapshot().connected &&
                session.snapshot().machine.canSetResistance
        }
        session.stop()
        assertEquals(1, commandCount(first, EquipmentCommand.VERIFY_SECURITY))
        assertEquals(1, commandCount(second, EquipmentCommand.VERIFY_SECURITY))
        assertFalse(session.statusLine().contains("authentication already attempted this process"), session.statusLine())
    }

    @Test
    fun authOnlySkipsVerifySecurityWhenUnlockNotRequired() {
        val transport = ScriptedBikeTransport(softwareVersion = 75)
        transport.identityMode = IdentityMode.Valid
        val session = sessionFor(transport, TestClock(), plan = ColdStartWritePlan.AuthOnly)
        session.start()
        waitUntil(session) { session.snapshot().connected && session.snapshot().machine.canSetResistance }
        val result = session.setResistance(3)
        assertEquals(200, result.statusCode, result.body)
        session.stop()
        assertEquals(0, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertEquals(0, commandCount(transport, EquipmentCommand.SYSTEM_INFO))
        assertEquals(0, commandCount(transport, EquipmentCommand.VERSION_INFO))
        assertTrue(session.snapshot().machine.canSetResistance)
    }

    @Test
    fun securityBlockTriggersGuardedN1WithoutLiveHash() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        val session = sessionFor(transport, TestClock())
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        session.stop()
        assertTrue(session.statusLine().contains("security hash unverified"), session.statusLine())
        assertTrue(commandCount(transport, EquipmentCommand.SYSTEM_INFO) >= 1)
        assertTrue(commandCount(transport, EquipmentCommand.VERSION_INFO) >= 1)
        assertEquals(0, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertFalse(session.snapshot().connected)
        assertFalse(statusLeaksIdentity(session.statusLine()))
    }

    @Test
    fun missingIdentityStopsWithoutVerifySecurity() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.None
        val session = sessionFor(transport, TestClock())
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        session.stop()
        assertTrue(session.statusLine().contains("identity incomplete"), session.statusLine())
        assertTrue(session.statusLine().contains("SYSTEM_INFO"), session.statusLine())
        assertEquals(0, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertFalse(session.snapshot().connected)
    }

    @Test
    fun malformedIdentityStopsWithoutVerifySecurity() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Malformed
        val session = sessionFor(transport, TestClock())
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        session.stop()
        assertTrue(session.statusLine().contains("identity incomplete"), session.statusLine())
        assertEquals(0, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertFalse(session.snapshot().connected)
    }

    @Test
    fun missingIdentityNumbersAreRejected() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Missing
        val session = sessionFor(transport, TestClock())
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        session.stop()
        assertTrue(session.statusLine().contains("identity incomplete"), session.statusLine())
        assertTrue(session.statusLine().contains("MISSING_IDENTITY"), session.statusLine())
        assertEquals(0, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
    }

    @Test
    fun unlockNotRequiredStopsWithoutIdentityReads() {
        val transport = ScriptedBikeTransport(softwareVersion = 75)
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        val session = sessionFor(transport, TestClock())
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        session.stop()
        assertTrue(session.statusLine().contains("unlock not required"), session.statusLine())
        assertEquals(0, commandCount(transport, EquipmentCommand.SYSTEM_INFO))
        assertEquals(0, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertFalse(session.snapshot().connected)
    }

    @Test
    fun n1DoesNotInventSupportedCommandsForProtocolV1() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        val session = sessionFor(transport, TestClock(), SecurityHashCompatibility.IndependentlyEstablished)
        session.start()
        waitUntil(session) { session.snapshot().connected }
        session.stop()
        assertFalse(sentCommands(transport).contains(128), sentCommands(transport).toString())
        assertFalse(sentCommands(transport).contains(136), sentCommands(transport).toString())
        assertEquals(1, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
    }

    @Test
    fun verifySecurityCommandNotSupportedIsAuthenticationUnsupported() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        transport.verifySecurityReply = VerifySecurityReply.NotSupported
        val session = sessionFor(transport, TestClock(), SecurityHashCompatibility.IndependentlyEstablished)
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        session.stop()
        assertTrue(session.statusLine().contains("authentication unsupported"), session.statusLine())
        assertEquals(1, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertFalse(session.snapshot().connected)
        assertTrue(session.statusLine().contains("authentication unsupported"), session.statusLine())
    }

    @Test
    fun incorrectVerifySecurityPreservesTerminalDiagnostics() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        transport.verifySecurityReply = VerifySecurityReply.StillLocked
        val session = sessionFor(transport, TestClock(), SecurityHashCompatibility.IndependentlyEstablished)
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        assertTrue(session.statusLine().contains("VerifySecurity rejected"), session.statusLine())
        assertFalse(session.snapshot().connected)
        assertEquals(1, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertFalse(statusLeaksIdentity(session.statusLine()))
        session.stop()
        assertTrue(session.statusLine().contains("VerifySecurity rejected"), session.statusLine())
        assertFalse(session.statusLine() == "stopped")
    }

    @Test
    fun malformedVerifySecurityIsRejected() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        transport.verifySecurityReply = VerifySecurityReply.Malformed
        val session = sessionFor(transport, TestClock(), SecurityHashCompatibility.IndependentlyEstablished)
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        session.stop()
        assertTrue(session.statusLine().contains("VerifySecurity rejected"), session.statusLine())
        assertTrue(session.statusLine().contains("Malformed"), session.statusLine())
        assertEquals(1, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertFalse(session.snapshot().connected)
    }

    @Test
    fun successfulAuthenticationRequiresPostUnlockTelemetry() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        val session = sessionFor(transport, TestClock(), SecurityHashCompatibility.IndependentlyEstablished)
        session.start()
        waitUntil(session) {
            session.snapshot().connected &&
                session.snapshot().initialized &&
                session.snapshot().watts.current &&
                session.snapshot().rpm.current
        }
        val live = session.snapshot()
        assertTrue(live.initialized)
        assertTrue(live.watts.current)
        assertTrue(live.rpm.current)
        session.stop()
        assertEquals(1, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        val vs = transport.snapshotSent().single { (it[2].toInt() and 0xFF) == EquipmentCommand.VERIFY_SECURITY.id }
        assertEquals(EquipmentDeviceIds.FITNESS_BIKE, vs[0].toInt() and 0xFF)
        assertEquals(40, vs.size)
        assertFalse(statusLeaksIdentity(session.statusLine()))
    }

    @Test
    fun postUnlockTelemetryFailureIsNotInitialized() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        transport.stayLockedAfterVerify = true
        val session = sessionFor(transport, TestClock(), SecurityHashCompatibility.IndependentlyEstablished)
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        session.stop()
        assertTrue(session.statusLine().contains("post-unlock telemetry failed"), session.statusLine())
        assertEquals(1, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertFalse(session.snapshot().connected)
        assertFalse(session.snapshot().initialized)
    }

    @Test
    fun postUnlockWattsSentinelIsNotInitialized() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        transport.postUnlockTelemetry = PostUnlockTelemetry.WattsSentinel
        assertPostUnlockTelemetryRejected(transport)
    }

    @Test
    fun postUnlockRpmSentinelIsNotInitialized() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        transport.postUnlockTelemetry = PostUnlockTelemetry.RpmSentinel
        assertPostUnlockTelemetryRejected(transport)
    }

    @Test
    fun postUnlockTruncatedTelemetryIsNotInitialized() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        transport.postUnlockTelemetry = PostUnlockTelemetry.Truncated
        assertPostUnlockTelemetryRejected(transport)
    }

    @Test
    fun postUnlockFailedReadIsNotInitialized() {
        val transport = ScriptedBikeTransport()
        transport.locked = true
        transport.identityMode = IdentityMode.Valid
        transport.postUnlockTelemetry = PostUnlockTelemetry.Failed
        assertPostUnlockTelemetryRejected(transport)
    }

    private fun assertPostUnlockTelemetryRejected(transport: ScriptedBikeTransport) {
        val session = sessionFor(transport, TestClock(), SecurityHashCompatibility.IndependentlyEstablished)
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        session.stop()
        assertTrue(session.statusLine().contains("post-unlock telemetry failed"), session.statusLine())
        assertEquals(1, commandCount(transport, EquipmentCommand.VERIFY_SECURITY))
        assertFalse(session.snapshot().connected)
        assertFalse(session.snapshot().initialized)
        assertFalse(session.snapshot().watts.current)
        assertFalse(session.snapshot().rpm.current)
    }

    @Test
    fun productionSourcesDoNotEnableHashCompatibility() {
        val main = java.io.File("src/main/kotlin")
        assertTrue(main.isDirectory, "run from the bridge-app module directory")
        val assignment = Regex("""(?<![!<>])=\s*SecurityHashCompatibility\.IndependentlyEstablished""")
        val offenders = main.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filter { assignment.containsMatchIn(it.readText()) }
            .map { it.name }
            .toList()
        assertEquals(emptyList<String>(), offenders)
        val service = java.io.File(main, "com/fitbaus/bikebridge/host/NativeBridgeService.kt").readText()
        assertTrue(!service.contains("IndependentlyEstablished"))
        assertTrue(!service.contains("securityHashCompatibility"))
        assertTrue(!service.contains("AuthOnly"))
        assertTrue(!service.contains("AuthPlusIdleLockout"))
        assertTrue(service.contains("UnlockQualification.plan()"))
        val http = java.io.File(main, "com/fitbaus/bikebridge/host/NativeHttpServer.kt").readText()
        assertTrue(!http.contains("IndependentlyEstablished"))
        assertTrue(!http.contains("SecurityHashCompatibility"))
        val unlock = java.io.File(main, "com/fitbaus/bikebridge/host/UnlockQualification.kt").readText()
        assertTrue(unlock.contains("if (productionIdentity)"))
        assertTrue(unlock.contains("ColdStartWritePlan.AuthOnly"))
        assertTrue(unlock.contains("ColdStartWritePlan.WarmState"))
        assertTrue(!unlock.contains("IndependentlyEstablished"))
    }

    @Test
    fun n1ReconnectReauthenticatesOncePerUsbSession() {
        val first = ScriptedBikeTransport()
        first.locked = true
        first.identityMode = IdentityMode.Valid
        val second = ScriptedBikeTransport()
        second.locked = true
        second.identityMode = IdentityMode.Valid
        val queue = ArrayDeque(listOf(first, second))
        val gateway = FakeUsbGateway(listOf(matchingBrainboard())) {
            OpenResult.Opened(ValidatedProbeTransport(queue.removeFirst()))
        }
        gateway.grant("bike0")
        val session = NativeUsbSession(
            gateway = gateway,
            requestPermission = { false },
            sleeper = {},
            minRequestSpacingMs = 0,
            maxReconnectAttempts = 5,
            reconnectDelayMs = 0,
            securityHashCompatibility = SecurityHashCompatibility.IndependentlyEstablished,
            resistanceQueueWaitMs = 0,
        )
        session.start()
        waitUntil(session) { session.snapshot().connected }
        assertEquals(1, commandCount(first, EquipmentCommand.VERIFY_SECURITY))
        first.detach()
        waitUntil(session) {
            session.snapshot().connected && commandCount(second, EquipmentCommand.VERIFY_SECURITY) == 1
        }
        session.stop()
        assertEquals(1, commandCount(first, EquipmentCommand.VERIFY_SECURITY))
        assertEquals(1, commandCount(second, EquipmentCommand.VERIFY_SECURITY))
        assertFalse(session.statusLine().contains("authentication already attempted this process"), session.statusLine())
    }

    @Test
    fun repeatedExchangeFailuresWhileAttachedReopenUsb() {
        val first = ScriptedBikeTransport()
        val second = ScriptedBikeTransport()
        val queue = ArrayDeque(listOf(first, second))
        val gateway = FakeUsbGateway(listOf(matchingBrainboard())) {
            OpenResult.Opened(ValidatedProbeTransport(if (queue.isEmpty()) second else queue.removeFirst()))
        }
        gateway.grant("bike0")
        val session = NativeUsbSession(
            gateway = gateway,
            requestPermission = { false },
            sleeper = {},
            minRequestSpacingMs = 0,
            reconnectDelayMs = 0,
            maxConsecutiveExchangeFailures = 3,
        )
        session.start()
        waitUntil(session) { session.phase() == UsbPhase.Streaming }
        first.failRemaining = true
        waitUntil(session) { first.closed }
        waitUntil(session) { session.snapshot().connected && second.sent.isNotEmpty() }
        assertEquals(2, gateway.openCalls)
        assertEquals(UsbPhase.Streaming, session.phase())
        session.stop()
    }

    @Test
    fun singleFailedExchangeDoesNotReopen() {
        val transport = ScriptedBikeTransport()
        val gateway = gatewayFor(transport)
        val session = NativeUsbSession(
            gateway = gateway,
            requestPermission = { false },
            sleeper = { Thread.sleep(it) },
            minRequestSpacingMs = 5,
            reconnectDelayMs = 0,
            maxConsecutiveExchangeFailures = 200,
        )
        session.start()
        waitUntil(session) { session.snapshot().connected }
        transport.failRemaining = true
        waitUntil(session) { !session.snapshot().connected }
        transport.failRemaining = false
        waitUntil(session) { session.snapshot().connected }
        assertEquals(1, gateway.openCalls)
        assertFalse(transport.closed)
        session.stop()
    }

    @Test
    fun permissionDenialWaitsWithoutRepromptingAndRecoversWhenGranted() {
        val transport = ScriptedBikeTransport()
        val gateway = FakeUsbGateway(listOf(matchingBrainboard())) {
            OpenResult.Opened(ValidatedProbeTransport(transport))
        }
        val prompts = AtomicInteger(0)
        val session = NativeUsbSession(
            gateway = gateway,
            requestPermission = {
                prompts.incrementAndGet()
                false
            },
            sleeper = { Thread.sleep(it) },
            minRequestSpacingMs = 0,
            reconnectDelayMs = 0,
            permissionPollMs = 5,
        )
        session.start()
        waitUntil(session) { session.phase() == UsbPhase.PermissionRequired }
        Thread.sleep(80)
        assertTrue(session.usbWorkerAlive(), session.statusLine())
        assertEquals(1, prompts.get())
        assertEquals(0, gateway.openCalls)
        assertFalse(session.snapshot().connected)
        session.requestPermissionAgain()
        waitUntil(session) { prompts.get() == 2 }
        Thread.sleep(40)
        assertEquals(2, prompts.get())
        gateway.grant("bike0")
        waitUntil(session) { session.snapshot().connected }
        assertEquals(2, prompts.get())
        session.stop()
    }

    @Test
    fun ensureRunningRestartsAfterTerminalStop() {
        val broken = ScriptedBikeTransport()
        broken.failDeviceInfo = true
        val healthy = ScriptedBikeTransport()
        val queue = ArrayDeque(listOf(broken, healthy))
        val gateway = FakeUsbGateway(listOf(matchingBrainboard())) {
            OpenResult.Opened(ValidatedProbeTransport(if (queue.isEmpty()) healthy else queue.removeFirst()))
        }
        gateway.grant("bike0")
        val session = NativeUsbSession(
            gateway = gateway,
            requestPermission = { false },
            sleeper = {},
            minRequestSpacingMs = 0,
            reconnectDelayMs = 0,
        )
        session.start()
        waitUntil(session) { !session.usbWorkerAlive() }
        assertEquals(UsbPhase.InitializationFailed, session.phase())
        assertTrue(broken.closed)
        assertTrue(session.ensureRunning())
        waitUntil(session) { session.snapshot().connected }
        assertFalse(session.ensureRunning())
        session.stop()
    }

    @Test
    fun phasesProgressFromStartingToStreaming() {
        val transport = ScriptedBikeTransport()
        val session = NativeUsbSession(
            gateway = gatewayFor(transport),
            requestPermission = { false },
            sleeper = { Thread.sleep(it) },
            minRequestSpacingMs = 0,
            reconnectDelayMs = 100,
        )
        assertEquals(UsbPhase.Starting, session.phase())
        session.start()
        waitUntil(session) { session.phase() == UsbPhase.Streaming }
        transport.detach()
        waitUntil(session) {
            session.phase() == UsbPhase.Disconnected || session.phase() == UsbPhase.InitializationFailed
        }
        session.stop()
    }

    @Test
    fun abandonedQueuedResistanceIsCancelledAndNeverTransmitted() {
        val transport = ScriptedBikeTransport()
        val session = sessionFor(transport, TestClock(), queueWaitMs = 60, transmitWaitMs = 60)
        session.start()
        waitUntil(session) { session.snapshot().machine.canSetResistance }
        transport.hangExchangeMs = 400
        assertTrue(transport.hangEntered.await(2, TimeUnit.SECONDS))
        val result = session.setResistance(3)
        assertEquals(503, result.statusCode, result.body)
        assertTrue(result.body.contains("before transmit"), result.body)
        transport.hangExchangeMs = 0
        Thread.sleep(600)
        waitUntil(session) { session.snapshot().connected }
        assertEquals(0, transport.writesSeen.get())
        assertEquals(null, session.snapshot().requestedResistance)
        val next = session.setResistance(4)
        assertEquals(200, next.statusCode, next.body)
        assertEquals(1, transport.writesSeen.get())
        session.stop()
    }

    @Test
    fun callerTimeoutDuringTransmitReportsUncertainAndLateDoneIsRecorded() {
        val transport = ScriptedBikeTransport()
        transport.hangWriteMs = 300
        val session = sessionFor(transport, TestClock(), queueWaitMs = 40, transmitWaitMs = 40)
        session.start()
        waitUntil(session) { session.snapshot().machine.canSetResistance }
        val result = session.setResistance(4)
        assertEquals(504, result.statusCode, result.body)
        assertTrue(result.body.contains("uncertain"), result.body)
        waitUntil(session) {
            session.snapshot().requestedResistance == 4 &&
                session.lastResistanceOutcome()?.contains("accepted level=4") == true
        }
        assertEquals(1, transport.writesSeen.get())
        session.stop()
    }

    @Test
    fun writeTransportFailureAfterSendIsUncertainNotFailed() {
        val transport = ScriptedBikeTransport()
        transport.failResistanceWrite = true
        val session = sessionFor(transport, TestClock())
        session.start()
        waitUntil(session) { session.snapshot().machine.canSetResistance }
        val result = session.setResistance(5)
        assertEquals(504, result.statusCode, result.body)
        assertTrue(result.body.contains("uncertain"), result.body)
        assertEquals(null, session.snapshot().requestedResistance)
        assertTrue(session.lastResistanceOutcome()!!.contains("uncertain"), session.lastResistanceOutcome())
        session.stop()
    }

    @Test
    fun detachBeforeOutIsDefinitelyNotTransmitted() {
        val first = ScriptedBikeTransport()
        first.writeDetach = WriteDetach.BeforeOut
        val second = ScriptedBikeTransport()
        val session = reconnectingSession(first, second)
        session.start()
        waitUntil(session) { session.snapshot().machine.canSetResistance }
        val result = session.setResistance(5)
        assertEquals(503, result.statusCode, result.body)
        assertTrue(result.body.contains("not transmitted (detached_before_out)"), result.body)
        assertEquals(0, first.writesSeen.get())
        assertTrue(session.lastResistanceOutcome()!!.contains("not transmitted"), session.lastResistanceOutcome())
        waitUntil(session) { second.sent.isNotEmpty() && session.snapshot().connected }
        assertEquals(null, session.snapshot().requestedResistance)
        assertEquals(0, second.writesSeen.get())
        session.stop()
    }

    @Test
    fun detachDuringOutIsUncertainAndNeverRetransmitted() {
        assertDetachAfterTransmitStartIsUncertain(WriteDetach.DuringOut, "out_transfer_failed")
    }

    @Test
    fun detachAfterOutIsUncertainAndNeverRetransmitted() {
        assertDetachAfterTransmitStartIsUncertain(WriteDetach.AfterOut, "in_timeout_or_failure")
    }

    private fun assertDetachAfterTransmitStartIsUncertain(mode: WriteDetach, token: String) {
        val first = ScriptedBikeTransport()
        first.writeDetach = mode
        val second = ScriptedBikeTransport()
        val session = reconnectingSession(first, second)
        session.start()
        waitUntil(session) { session.snapshot().machine.canSetResistance }
        val result = session.setResistance(5)
        assertEquals(504, result.statusCode, result.body)
        assertTrue(result.body.contains("uncertain"), result.body)
        assertEquals(1, first.writesSeen.get())
        assertTrue(session.lastResistanceOutcome()!!.contains("uncertain: $token"), session.lastResistanceOutcome())
        waitUntil(session) { second.sent.isNotEmpty() && session.snapshot().connected }
        Thread.sleep(100)
        assertEquals(null, session.snapshot().requestedResistance)
        assertEquals(0, second.writesSeen.get())
        session.stop()
    }

    @Test
    fun onlyPreOutFailuresAreDefinitelyNotTransmitted() {
        val definite = TransportFailureClass.values().filter { it.definitelyNotTransmitted() }.toSet()
        assertEquals(setOf(TransportFailureClass.POLICY_REJECTED, TransportFailureClass.DETACHED_BEFORE_OUT), definite)
    }

    @Test
    fun androidTransportReportsDetachedBeforeOutOnlyBeforeBulkTransfer() {
        val source = java.io.File("src/main/kotlin/com/fitbaus/bikebridge/host/usb/AndroidUsbHostGateway.kt").readText()
        val exchange = source.substring(source.indexOf("override fun exchange(request: ByteArray)"))
        val firstOut = exchange.indexOf("bulkTransfer(")
        assertTrue(firstOut > 0)
        assertTrue(exchange.lastIndexOf("DETACHED_BEFORE_OUT") in 0 until firstOut)
        assertFalse(exchange.substring(firstOut).contains("POLICY_REJECTED"))
    }

    @Test
    fun exceptionDuringTransmitIsUncertainAndDoesNotStrandOrRepeatTheWrite() {
        val first = ScriptedBikeTransport()
        first.throwOnWrite = true
        val second = ScriptedBikeTransport()
        val session = reconnectingSession(first, second)
        session.start()
        waitUntil(session) { session.snapshot().machine.canSetResistance }
        val result = session.setResistance(5)
        assertEquals(504, result.statusCode, result.body)
        assertTrue(result.body.contains("uncertain"), result.body)
        assertTrue(
            session.lastResistanceOutcome()!!.contains("uncertain: IllegalStateException during transmit"),
            session.lastResistanceOutcome(),
        )
        waitUntil(session) { !session.usbWorkerAlive() }
        assertEquals(1, first.writesSeen.get())
        assertEquals(null, session.snapshot().requestedResistance)
        assertTrue(session.ensureRunning())
        waitUntil(session) { session.snapshot().connected && session.snapshot().machine.canSetResistance }
        Thread.sleep(100)
        assertEquals(0, second.writesSeen.get())
        val next = session.setResistance(6)
        assertEquals(200, next.statusCode, next.body)
        assertEquals(6, session.snapshot().requestedResistance)
        assertEquals(1, first.writesSeen.get())
        assertEquals(1, second.writesSeen.get())
        session.stop()
    }

    @Test
    fun exceptionDuringTransmitAfterCallerTimeoutIsRecordedAsUncertain() {
        val first = ScriptedBikeTransport()
        first.hangWriteMs = 200
        first.throwOnWrite = true
        val second = ScriptedBikeTransport()
        val session = reconnectingSession(first, second, queueWaitMs = 40, transmitWaitMs = 40)
        session.start()
        waitUntil(session) { session.snapshot().machine.canSetResistance }
        val result = session.setResistance(5)
        assertEquals(504, result.statusCode, result.body)
        waitUntil(session) { !session.usbWorkerAlive() }
        assertTrue(
            session.lastResistanceOutcome()!!.contains("uncertain: IllegalStateException during transmit"),
            session.lastResistanceOutcome(),
        )
        assertEquals(null, session.snapshot().requestedResistance)
        assertTrue(session.ensureRunning())
        waitUntil(session) { session.snapshot().connected && session.snapshot().machine.canSetResistance }
        val next = session.setResistance(4)
        assertEquals(200, next.statusCode, next.body)
        assertEquals(1, first.writesSeen.get())
        assertEquals(1, second.writesSeen.get())
        session.stop()
    }

    @Test
    fun concurrentResistanceRequestsAreSerialized() {
        val transport = ScriptedBikeTransport()
        transport.hangWriteMs = 200
        val session = sessionFor(transport, TestClock(), queueWaitMs = 1_000, transmitWaitMs = 1_000)
        session.start()
        waitUntil(session) { session.snapshot().machine.canSetResistance }
        val first = AtomicReference<com.fitbaus.bikebridge.protocol.BridgeHttpResult?>(null)
        val thread = Thread { first.set(session.setResistance(5)) }
        thread.start()
        assertTrue(transport.writeEntered.await(2, TimeUnit.SECONDS))
        val second = session.setResistance(6)
        assertEquals(503, second.statusCode, second.body)
        assertTrue(second.body.contains("in flight"), second.body)
        thread.join(3_000)
        assertEquals(200, first.get()!!.statusCode, first.get()!!.body)
        assertEquals(1, transport.writesSeen.get())
        assertEquals(5, session.snapshot().requestedResistance)
        session.stop()
    }

    @Test
    fun stopWithQueuedResistanceReportsNotTransmitted() {
        val transport = ScriptedBikeTransport()
        val session = sessionFor(transport, TestClock(), queueWaitMs = 5_000, transmitWaitMs = 1_000)
        session.start()
        waitUntil(session) { session.snapshot().machine.canSetResistance }
        transport.hangExchangeMs = 300
        assertTrue(transport.hangEntered.await(2, TimeUnit.SECONDS))
        val result = AtomicReference<com.fitbaus.bikebridge.protocol.BridgeHttpResult?>(null)
        val caller = Thread { result.set(session.setResistance(7)) }
        caller.start()
        Thread.sleep(50)
        session.stop()
        caller.join(3_000)
        assertEquals(503, result.get()!!.statusCode, result.get()!!.body)
        assertTrue(result.get()!!.body.contains("not transmitted"), result.get()!!.body)
        assertEquals(0, transport.writesSeen.get())
    }

    @Test
    fun requestedResistanceIsClearedOnDisconnect() {
        val first = ScriptedBikeTransport()
        val second = ScriptedBikeTransport()
        val queue = ArrayDeque(listOf(first, second))
        val gateway = FakeUsbGateway(listOf(matchingBrainboard())) {
            OpenResult.Opened(ValidatedProbeTransport(if (queue.isEmpty()) second else queue.removeFirst()))
        }
        gateway.grant("bike0")
        val session = NativeUsbSession(
            gateway = gateway,
            requestPermission = { false },
            sleeper = {},
            minRequestSpacingMs = 0,
            reconnectDelayMs = 0,
        )
        session.start()
        waitUntil(session) { session.snapshot().machine.canSetResistance }
        assertEquals(200, session.setResistance(3).statusCode)
        assertEquals(3, session.snapshot().requestedResistance)
        first.detach()
        waitUntil(session) { second.sent.isNotEmpty() && session.snapshot().connected }
        assertEquals(null, session.snapshot().requestedResistance)
        session.stop()
    }

    private fun sessionFor(
        transport: ScriptedBikeTransport,
        clock: TestClock,
        hash: SecurityHashCompatibility = SecurityHashCompatibility.Unresolved,
        queueWaitMs: Long = HostConstants.RESISTANCE_QUEUE_WAIT_MS,
        transmitWaitMs: Long = HostConstants.RESISTANCE_TRANSMIT_WAIT_MS,
        plan: ColdStartWritePlan = ColdStartWritePlan.WarmState,
    ): NativeUsbSession =
        NativeUsbSession(
            gateway = gatewayFor(transport),
            requestPermission = { false },
            sleeper = {},
            nowIso = { clock.now() },
            minRequestSpacingMs = 0,
            reconnectDelayMs = 0,
            securityHashCompatibility = hash,
            coldStartWritePlan = plan,
            resistanceQueueWaitMs = queueWaitMs,
            resistanceTransmitWaitMs = transmitWaitMs,
        )

    private fun reconnectingSession(
        first: ScriptedBikeTransport,
        second: ScriptedBikeTransport,
        queueWaitMs: Long = HostConstants.RESISTANCE_QUEUE_WAIT_MS,
        transmitWaitMs: Long = HostConstants.RESISTANCE_TRANSMIT_WAIT_MS,
    ): NativeUsbSession {
        val queue = ArrayDeque(listOf(first, second))
        val gateway = FakeUsbGateway(listOf(matchingBrainboard())) {
            OpenResult.Opened(ValidatedProbeTransport(if (queue.isEmpty()) second else queue.removeFirst()))
        }
        gateway.grant("bike0")
        return NativeUsbSession(
            gateway = gateway,
            requestPermission = { false },
            sleeper = {},
            minRequestSpacingMs = 0,
            reconnectDelayMs = 0,
            resistanceQueueWaitMs = queueWaitMs,
            resistanceTransmitWaitMs = transmitWaitMs,
        )
    }

    private fun gatewayFor(transport: ScriptedBikeTransport): FakeUsbGateway {
        val gateway = FakeUsbGateway(listOf(matchingBrainboard())) {
            OpenResult.Opened(ValidatedProbeTransport(transport))
        }
        gateway.grant("bike0")
        return gateway
    }

    private fun waitUntil(session: NativeUsbSession, timeoutMs: Long = 2000, pred: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (pred()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting: status=${session.statusLine()} snap=${session.snapshot()}")
    }
}

private class TestClock {
    private val n = AtomicInteger(0)
    fun get(): Int = n.get()
    fun now(): String = "2026-11-08T20:00:00.%03dZ".format(n.incrementAndGet())
}

private fun matchingBrainboard(name: String = "bike0"): UsbDeviceSnapshot = UsbDeviceSnapshot(
    deviceName = name,
    vendorId = BikeUsbConstants.VENDOR_ID,
    productId = BikeUsbConstants.PRODUCT_ID,
    interfaces = listOf(
        UsbInterfaceSnapshot(
            id = BikeUsbConstants.INTERFACE_NUMBER,
            interfaceClass = BikeUsbConstants.INTERFACE_CLASS_HID,
            endpoints = listOf(
                UsbEndpointSnapshot(
                    BikeUsbConstants.IN_ENDPOINT_ADDRESS,
                    directionIn = true,
                    type = BikeUsbConstants.ENDPOINT_TYPE_INTERRUPT,
                    maxPacketSize = BikeUsbConstants.PACKET_SIZE,
                ),
                UsbEndpointSnapshot(
                    BikeUsbConstants.OUT_ENDPOINT_ADDRESS,
                    directionIn = false,
                    type = BikeUsbConstants.ENDPOINT_TYPE_INTERRUPT,
                    maxPacketSize = BikeUsbConstants.PACKET_SIZE,
                ),
            ),
        ),
    ),
)

private class FakeUsbGateway(
    private var devices: List<UsbDeviceSnapshot>,
    private val openHandler: (UsbQualificationResult.Qualified) -> OpenResult,
) : UsbHostGateway {
    var openCalls: Int = 0
        private set
    private val permission = HashMap<String, Boolean>()

    override fun listDevices(): List<UsbDeviceSnapshot> = devices
    override fun hasPermission(deviceName: String): Boolean = permission[deviceName] == true
    override fun openQualified(qualified: UsbQualificationResult.Qualified): OpenResult {
        openCalls += 1
        return openHandler(qualified)
    }

    fun grant(deviceName: String) {
        permission[deviceName] = true
    }
}

private enum class IdentityMode {
    None,
    Valid,
    Malformed,
    Missing,
}

private enum class VerifySecurityReply {
    Unlocked,
    StillLocked,
    NotSupported,
    Malformed,
}

private enum class WriteDetach {
    None,
    BeforeOut,
    DuringOut,
    AfterOut,
}

private enum class PostUnlockTelemetry {
    Valid,
    WattsSentinel,
    RpmSentinel,
    Truncated,
    Failed,
}

private class ScriptedBikeTransport(
    private val failAfterSuccessfulPolls: Int = Int.MAX_VALUE,
    private val onExchange: () -> Unit = {},
    private val softwareVersion: Int = 86,
) : ProbeTransport {
    private val sentPackets = CopyOnWriteArrayList<ByteArray>()
    val sent: List<ByteArray> get() = sentPackets.toList()

    fun snapshotSent(): List<ByteArray> = sentPackets.toList()
    val closeLatch = CountDownLatch(1)
    val hangEntered = CountDownLatch(1)
    var closed: Boolean = false
        private set
    private val allowlist = TransmitAllowlist()
    private var attached = true
    private var successfulPolls = 0
    private val bikeInfo = fitnessBikeDeviceInfo(softwareVersion)

    override fun transmitAllowlist() = allowlist
    override fun isAttached(): Boolean = attached && !closed
    override fun close() {
        closed = true
        attached = false
        allowlist.resetToMainOnly()
        closeLatch.countDown()
    }

    fun detach() {
        attached = false
    }

    override fun exchange(request: ByteArray): TransportResult {
        sentPackets += request.copyOf()
        onExchange()
        val hangMs = hangExchangeMs
        if (hangMs > 0L) {
            hangEntered.countDown()
            val deadline = System.currentTimeMillis() + hangMs
            while (System.currentTimeMillis() < deadline) {
                try {
                    Thread.sleep(20)
                } catch (_: InterruptedException) {
                    // Ignore so stop() join timeout can be observed.
                }
            }
        }
        if (!attached) return TransportResult.Failed(TransportFailureClass.DETACHED_BEFORE_OUT)
        val cmd = request[2].toInt() and 0xFF
        val device = request[0]
        if (cmd == EquipmentCommand.DEVICE_INFO.id) {
            if (failDeviceInfo) return TransportResult.Failed(TransportFailureClass.IN_TIMEOUT_OR_FAILURE)
            return TransportResult.Ok(bikeInfo)
        }
        if (cmd == EquipmentCommand.SYSTEM_INFO.id) {
            return identityReply(device, EquipmentCommand.SYSTEM_INFO.id)
        }
        if (cmd == EquipmentCommand.VERSION_INFO.id) {
            return identityReply(device, EquipmentCommand.VERSION_INFO.id)
        }
        if (cmd == EquipmentCommand.VERIFY_SECURITY.id) {
            return verifySecurity(device)
        }
        if (cmd == EquipmentCommand.READ_WRITE_DATA.id) {
            val writeMaskBytes = request[3].toInt() and 0xFF
            if (writeMaskBytes != 0) {
                if (locked || securityBlockResistanceWrite) {
                    return TransportResult.Ok(
                        statusFrame(device, EquipmentCommand.READ_WRITE_DATA.id, EquipmentStatus.SECURITY_BLOCK.code!!),
                    )
                }
                if (writeDetach == WriteDetach.BeforeOut) {
                    attached = false
                    return TransportResult.Failed(TransportFailureClass.DETACHED_BEFORE_OUT)
                }
                writesSeen.incrementAndGet()
                rejectResistanceWriteWith?.let { status ->
                    return TransportResult.Ok(statusFrame(device, EquipmentCommand.READ_WRITE_DATA.id, status.code!!))
                }
                val writeHang = hangWriteMs
                if (writeHang > 0L) {
                    writeEntered.countDown()
                    sleepIgnoringInterrupts(writeHang)
                }
                if (throwOnWrite) {
                    throw IllegalStateException("bulkTransfer threw")
                }
                when (writeDetach) {
                    WriteDetach.DuringOut -> {
                        attached = false
                        return TransportResult.Failed(TransportFailureClass.OUT_TRANSFER_FAILED)
                    }
                    WriteDetach.AfterOut -> {
                        attached = false
                        return TransportResult.Failed(TransportFailureClass.IN_TIMEOUT_OR_FAILURE)
                    }
                    else -> Unit
                }
                if (failResistanceWrite) {
                    return TransportResult.Failed(TransportFailureClass.IN_TIMEOUT_OR_FAILURE)
                }
                return TransportResult.Ok(
                    statusFrame(device, EquipmentCommand.READ_WRITE_DATA.id, EquipmentStatus.DONE.code!!),
                )
            }
            val fields = readFieldIds(request)
            if (locked) return TransportResult.Ok(statusFrame(device, EquipmentCommand.READ_WRITE_DATA.id, EquipmentStatus.SECURITY_BLOCK.code!!))
            if (fields == listOf(42)) return TransportResult.Ok(rw(byteArrayOf(22)))
            val isPoll = fields.contains(3) || fields.contains(5) || fields == listOf(2) || fields == listOf(18)
            if (isPoll) {
                if (failRemaining || successfulPolls >= failAfterSuccessfulPolls) {
                    return TransportResult.Failed(TransportFailureClass.IN_TIMEOUT_OR_FAILURE)
                }
                successfulPolls += 1
            }
            if (fields.contains(3) && fields.contains(5)) {
                return when (postUnlockTelemetry) {
                    PostUnlockTelemetry.Valid -> TransportResult.Ok(rw(byteArrayOf(0x64, 0x00, 0x3C, 0x00)))
                    PostUnlockTelemetry.WattsSentinel -> TransportResult.Ok(rw(byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0x3C, 0x00)))
                    PostUnlockTelemetry.RpmSentinel -> TransportResult.Ok(rw(byteArrayOf(0x64, 0x00, 0xFF.toByte(), 0xFF.toByte())))
                    PostUnlockTelemetry.Truncated -> TransportResult.Ok(rw(byteArrayOf(0x64, 0x00)))
                    PostUnlockTelemetry.Failed -> TransportResult.Failed(TransportFailureClass.IN_TIMEOUT_OR_FAILURE)
                }
            }
            if (fields == listOf(2)) return TransportResult.Ok(rw(byteArrayOf(0x5F, 0x03)))
            if (fields == listOf(18)) return TransportResult.Ok(rw(byteArrayOf(0x98.toByte(), 0x08)))
        }
        return TransportResult.Failed(TransportFailureClass.IN_TIMEOUT_OR_FAILURE)
    }

    private fun identityReply(device: Byte, command: Int): TransportResult {
        return when (identityMode) {
            IdentityMode.None -> TransportResult.Failed(TransportFailureClass.IN_TIMEOUT_OR_FAILURE)
            IdentityMode.Malformed ->
                TransportResult.Ok(statusFrame(device, EquipmentCommand.READ_WRITE_DATA.id, EquipmentStatus.SECURITY_BLOCK.code!!))
            IdentityMode.Missing ->
                if (command == EquipmentCommand.SYSTEM_INFO.id) {
                    TransportResult.Ok(retarget(hexBytes("02 10 82 02 00 00 00 00 00 00 00 52 1F 06 00 58"), device.toInt() and 0xFF))
                } else {
                    TransportResult.Ok(retarget(hexBytes("02 06 84 02 54 E2"), device.toInt() and 0xFF))
                }
            IdentityMode.Valid -> {
                val deviceId = device.toInt() and 0xFF
                // Live Smart Power 10 answers MAIN identity reads with device 7.
                val replyDevice =
                    if (deviceId == EquipmentDeviceIds.MAIN) EquipmentDeviceIds.FITNESS_BIKE else deviceId
                if (divergentPrimaryIdentity && deviceId != EquipmentDeviceIds.MAIN) {
                    if (command == EquipmentCommand.SYSTEM_INFO.id) {
                        TransportResult.Ok(systemInfoFrame(replyDevice, 99991L, 88882L))
                    } else {
                        TransportResult.Ok(versionInfoFrame(replyDevice, 1))
                    }
                } else if (command == EquipmentCommand.SYSTEM_INFO.id) {
                    TransportResult.Ok(retarget(hexBytes("02 10 82 02 00 00 00 AF 9C 00 00 52 1F 06 00 58"), replyDevice))
                } else {
                    TransportResult.Ok(retarget(hexBytes("02 06 84 02 54 E2"), replyDevice))
                }
            }
        }
    }

    private fun verifySecurity(device: Byte): TransportResult {
        return when (verifySecurityReply) {
            VerifySecurityReply.Unlocked -> {
                if (!stayLockedAfterVerify) locked = false
                TransportResult.Ok(retarget(hexBytes("02 06 90 02 5A F4"), device.toInt() and 0xFF))
            }
            VerifySecurityReply.StillLocked ->
                TransportResult.Ok(statusFrame(device, EquipmentCommand.VERIFY_SECURITY.id, EquipmentStatus.SECURITY_BLOCK.code!!))
            VerifySecurityReply.NotSupported ->
                TransportResult.Ok(
                    statusFrame(device, EquipmentCommand.VERIFY_SECURITY.id, EquipmentStatus.COMMAND_NOT_SUPPORTED.code!!),
                )
            VerifySecurityReply.Malformed ->
                TransportResult.Ok(statusFrame(device, EquipmentCommand.READ_WRITE_DATA.id, EquipmentStatus.DONE.code!!))
        }
    }

    @Volatile
    var failRemaining: Boolean = false

    @Volatile
    var failDeviceInfo: Boolean = false

    @Volatile
    var locked: Boolean = false

    @Volatile
    var stayLockedAfterVerify: Boolean = false

    @Volatile
    var identityMode: IdentityMode = IdentityMode.None

    @Volatile
    var divergentPrimaryIdentity: Boolean = false

    @Volatile
    var verifySecurityReply: VerifySecurityReply = VerifySecurityReply.Unlocked

    @Volatile
    var postUnlockTelemetry: PostUnlockTelemetry = PostUnlockTelemetry.Valid

    @Volatile
    var hangExchangeMs: Long = 0

    @Volatile
    var failResistanceWrite: Boolean = false

    @Volatile
    var securityBlockResistanceWrite: Boolean = false

    @Volatile
    var hangWriteMs: Long = 0

    @Volatile
    var writeDetach: WriteDetach = WriteDetach.None

    @Volatile
    var throwOnWrite: Boolean = false

    @Volatile
    var rejectResistanceWriteWith: EquipmentStatus? = null

    val writeEntered = CountDownLatch(1)
    val writesSeen = AtomicInteger(0)

    private fun sleepIgnoringInterrupts(ms: Long) {
        val deadline = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(10)
            } catch (_: InterruptedException) {
            }
        }
    }
}

private fun readFieldIds(request: ByteArray): List<Int> {
    var i = 3
    val writeMaskBytes = request[i].toInt() and 0xFF
    i += 1 + writeMaskBytes
    val readMaskBytes = request[i].toInt() and 0xFF
    i += 1
    val ids = ArrayList<Int>()
    for (b in 0 until readMaskBytes) {
        val bits = request[i + b].toInt() and 0xFF
        for (bit in 0..7) {
            if ((bits and (1 shl bit)) != 0) ids += b * 8 + bit
        }
    }
    return ids
}

private fun sentCommands(transport: ScriptedBikeTransport): List<Int> =
    transport.snapshotSent().map { it[2].toInt() and 0xFF }

private fun commandCount(transport: ScriptedBikeTransport, command: EquipmentCommand): Int =
    sentCommands(transport).count { it == command.id }

private fun devicesFor(transport: ScriptedBikeTransport, command: EquipmentCommand): Set<Int> =
    transport.snapshotSent()
        .filter { (it[2].toInt() and 0xFF) == command.id }
        .map { it[0].toInt() and 0xFF }
        .toSet()

private fun expectedAuthOnlyVerifySecurity(): ByteArray {
    val deviceInfo = parsedIdentity(
        EquipmentRequests.deviceInfo(EquipmentDevice.FITNESS_BIKE).parse(fitnessBikeDeviceInfo()),
    )
    val systemInfo = parsedIdentity(
        EquipmentRequests.systemInfo().parse(hexBytes("02 10 82 02 00 00 00 AF 9C 00 00 52 1F 06 00 58")),
    )
    val versionInfo = parsedIdentity(
        EquipmentRequests.versionInfo().parse(hexBytes("02 06 84 02 54 E2")),
    )
    return EquipmentRequests.verifySecurity(
        MachineIdentity.of(deviceInfo, systemInfo, versionInfo),
        EquipmentDevice.FITNESS_BIKE,
    ).encode()
}

private fun decoyPrimaryVerifySecurity(): ByteArray {
    val deviceInfo = parsedIdentity(
        EquipmentRequests.deviceInfo(EquipmentDevice.FITNESS_BIKE).parse(fitnessBikeDeviceInfo()),
    )
    val systemInfo = parsedIdentity(
        EquipmentRequests.systemInfo(EquipmentDevice.FITNESS_BIKE).parse(systemInfoFrame(7, 99991L, 88882L)),
    )
    val versionInfo = parsedIdentity(
        EquipmentRequests.versionInfo(EquipmentDevice.FITNESS_BIKE).parse(versionInfoFrame(7, 1)),
    )
    return EquipmentRequests.verifySecurity(
        MachineIdentity.of(deviceInfo, systemInfo, versionInfo),
        EquipmentDevice.FITNESS_BIKE,
    ).encode()
}

private fun <T> parsedIdentity(result: IdentityResult<T>): T {
    val parsed = result as IdentityResult.Parsed<T>
    return parsed.value
}

private fun systemInfoFrame(deviceId: Int, model: Long, part: Long): ByteArray {
    val data = intArrayOf(0x00, 0x00, 0x00) + le32(model) + le32(part)
    return identityFrame(deviceId, EquipmentCommand.SYSTEM_INFO.id, 0x02, *data)
}

private fun versionInfoFrame(deviceId: Int, masterLibraryVersion: Int): ByteArray =
    identityFrame(deviceId, EquipmentCommand.VERSION_INFO.id, 0x02, masterLibraryVersion)

private fun identityFrame(deviceId: Int, command: Int, status: Int, vararg data: Int): ByteArray {
    val length = 4 + data.size + 1
    val out = ByteArray(length)
    out[0] = deviceId.toByte()
    out[1] = length.toByte()
    out[2] = command.toByte()
    out[3] = status.toByte()
    data.forEachIndexed { i, b -> out[4 + i] = b.toByte() }
    out[length - 1] = EquipmentFrameCodec.checksum(out, length).toByte()
    return out
}

private fun le32(v: Long): IntArray = IntArray(4) { ((v ushr (8 * it)) and 0xFF).toInt() }

private fun nonemptyWritePackets(transport: ScriptedBikeTransport): List<ByteArray> =
    transport.snapshotSent().filter {
        it.size > 4 &&
            (it[2].toInt() and 0xFF) == EquipmentCommand.READ_WRITE_DATA.id &&
            (it[3].toInt() and 0xFF) != 0
    }

private fun field2WriteCount(transport: ScriptedBikeTransport): Int =
    nonemptyWritePackets(transport).count { (it[3].toInt() and 0xFF) == 1 }

private fun idleModeLockoutWriteCount(transport: ScriptedBikeTransport): Int =
    nonemptyWritePackets(transport).count { (it[3].toInt() and 0xFF) == 12 }

private fun statusLeaksIdentity(status: String): Boolean {
    val lowered = status.lowercase()
    return status.contains("123456789") ||
        status.contains("0A0B0C0D", ignoreCase = true) ||
        status.contains("40111") ||
        status.contains("401234") ||
        lowered.contains("serial=") ||
        lowered.contains("hash=") ||
        status.contains("076202CC", ignoreCase = true)
}

private fun hexBytes(hex: String): ByteArray {
    val clean = hex.replace(" ", "")
    return ByteArray(clean.length / 2) { clean.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

private fun retarget(frame: ByteArray, deviceId: Int): ByteArray {
    val copy = frame.copyOf()
    copy[0] = deviceId.toByte()
    copy[copy.lastIndex] = EquipmentFrameCodec.checksum(copy, copy.size).toByte()
    return copy
}

private fun fitnessBikeDeviceInfo(softwareVersion: Int = 86): ByteArray {
    val sectionCount = 15
    val dataLen = 1 + 1 + 4 + 2 + 1 + sectionCount
    val length = EquipmentFrameCodec.RESPONSE_HEADER_LENGTH + dataLen + 1
    val frame = ByteArray(length)
    frame[0] = 7
    frame[1] = length.toByte()
    frame[2] = EquipmentCommand.DEVICE_INFO.id.toByte()
    frame[3] = EquipmentStatus.DONE.code!!.toByte()
    var i = 4
    frame[i++] = softwareVersion.toByte()
    frame[i++] = 1
    frame[i++] = 0x0D
    frame[i++] = 0x0C
    frame[i++] = 0x0B
    frame[i++] = 0x0A
    frame[i++] = 1
    frame[i++] = 0
    frame[i++] = sectionCount.toByte()
    repeat(sectionCount) { frame[i++] = 0x01 }
    frame[length - 1] = EquipmentFrameCodec.checksum(frame, length).toByte()
    return frame
}

private fun statusFrame(deviceId: Byte, command: Int, status: Int): ByteArray {
    val length = EquipmentFrameCodec.RESPONSE_HEADER_LENGTH + 1
    val frame = ByteArray(length)
    frame[0] = deviceId
    frame[1] = length.toByte()
    frame[2] = command.toByte()
    frame[3] = status.toByte()
    frame[length - 1] = EquipmentFrameCodec.checksum(frame, length).toByte()
    return frame
}

private fun rw(data: ByteArray): ByteArray {
    val length = EquipmentFrameCodec.RESPONSE_HEADER_LENGTH + data.size + 1
    val frame = ByteArray(length)
    frame[0] = 7
    frame[1] = length.toByte()
    frame[2] = EquipmentCommand.READ_WRITE_DATA.id.toByte()
    frame[3] = EquipmentStatus.DONE.code!!.toByte()
    data.copyInto(frame, 4)
    frame[length - 1] = EquipmentFrameCodec.checksum(frame, length).toByte()
    return frame
}
