// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.policy.DiagnosticBudget
import com.fitbaus.bikebridge.equipmentprobe.policy.ReadOnlyTransmitGate
import com.fitbaus.bikebridge.equipmentprobe.policy.SessionTransmitAuthorization
import com.fitbaus.bikebridge.equipmentprobe.policy.TransmitAllowlist
import com.fitbaus.bikebridge.equipmentprobe.policy.TransmitDecision
import com.fitbaus.bikebridge.equipmentprobe.session.BasicProbeSequence
import com.fitbaus.bikebridge.equipmentprobe.session.GatedEquipmentExchange
import com.fitbaus.bikebridge.equipmentprobe.session.ProbeEvent
import com.fitbaus.bikebridge.equipmentprobe.session.ProbeExchangeResult
import com.fitbaus.bikebridge.equipmentprobe.session.StopKind
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportFailureClass
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportResult
import com.fitbaus.bikebridge.equipmentprobe.usb.ValidatedProbeTransport
import com.fitbaus.bikebridge.protocol.BikeField
import com.fitbaus.bikebridge.protocol.EquipmentDevice
import com.fitbaus.bikebridge.protocol.EquipmentRequests
import com.fitbaus.bikebridge.protocol.EquipmentDeviceIds
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TransmitAuthorizationLifecycleTest {
    private val fitness = EquipmentDeviceIds.FITNESS_BIKE
    private val deviceInfoBike = EquipmentRequests.deviceInfo(EquipmentDevice.of(fitness)).encode()
    private val systemInfoBike = EquipmentRequests.systemInfo(EquipmentDevice.of(fitness)).encode()
    private val versionInfoBike = EquipmentRequests.versionInfo(EquipmentDevice.of(fitness)).encode()
    private val readBike = EquipmentRequests.read(EquipmentDevice.of(fitness), listOf(BikeField.WATTS, BikeField.RPM)).encode()

    @Test
    fun mainOnlyPermitsDeviceInfoMainAndRejectsWiderCommands() {
        val auth = SessionTransmitAuthorization.MainOnly
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.deviceInfo().encode(), auth) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.systemInfo().encode(), auth) is TransmitDecision.Reject)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(deviceInfoBike, auth) is TransmitDecision.Reject)
    }

    @Test
    fun awaitingConfirmationPermitsOnlyDeviceInfoCandidate() {
        val auth = SessionTransmitAuthorization.AwaitingConfirmation(fitness)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(deviceInfoBike, auth) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(systemInfoBike, auth) is TransmitDecision.Reject)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(versionInfoBike, auth) is TransmitDecision.Reject)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(readBike, auth) is TransmitDecision.Reject)
        assertTrue(
            ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.deviceInfo().encode(), auth) is TransmitDecision.Reject,
        )
    }

    @Test
    fun confirmedPermitsApprovedReadOnlyOnPrimaryDevice() {
        val auth = SessionTransmitAuthorization.Confirmed(fitness)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(deviceInfoBike, auth) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(systemInfoBike, auth) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(versionInfoBike, auth) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(readBike, auth) is TransmitDecision.Allow)
        assertTrue(
            ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.deviceInfo().encode(), auth) is TransmitDecision.Reject,
        )
    }

    @Test
    fun allowlistLifecycleRejectsSystemInfoUntilConfirmThenAllows() {
        val allowlist = TransmitAllowlist()
        assertTrue(allowlist.state() is SessionTransmitAuthorization.MainOnly)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(systemInfoBike, allowlist.state()) is TransmitDecision.Reject)

        allowlist.beginAwaitingConfirmation(fitness)
        assertEquals(SessionTransmitAuthorization.AwaitingConfirmation(fitness), allowlist.state())
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(deviceInfoBike, allowlist.state()) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(systemInfoBike, allowlist.state()) is TransmitDecision.Reject)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(versionInfoBike, allowlist.state()) is TransmitDecision.Reject)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(readBike, allowlist.state()) is TransmitDecision.Reject)

        allowlist.confirmSessionPrimary(fitness)
        assertEquals(SessionTransmitAuthorization.Confirmed(fitness), allowlist.state())
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(systemInfoBike, allowlist.state()) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(versionInfoBike, allowlist.state()) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(readBike, allowlist.state()) is TransmitDecision.Allow)
    }

    @Test
    fun bothTransportGatesRejectSystemInfoWhileAwaitingConfirmation() {
        val allowlist = TransmitAllowlist()
        allowlist.beginAwaitingConfirmation(fitness)
        val inner = ScriptedTransport(listOf(TransportResult.Ok(ByteArray(0))))
        // Share the provisional allowlist with ValidatedProbeTransport like production open.
        val validated = ValidatedProbeTransport(inner, allowlist)
        val blocked = validated.exchange(systemInfoBike)
        assertTrue(blocked is TransportResult.Failed)
        assertEquals(TransportFailureClass.POLICY_REJECTED, (blocked as TransportResult.Failed).classification)
        assertEquals(0, inner.sent.size)

        val gatedInner = ScriptedTransport(listOf(TransportResult.Ok(ByteArray(0))))
        gatedInner.transmitAllowlist()!!.beginAwaitingConfirmation(fitness)
        val gated = GatedEquipmentExchange(gatedInner, DiagnosticBudget(12))
        val gatedResult = gated.exchange(EquipmentRequests.systemInfo(EquipmentDevice.of(fitness)))
        assertTrue(gatedResult is ProbeExchangeResult.Failed)
        assertEquals(0, gatedInner.sent.size)
    }

    @Test
    fun failedConfirmationDoesNotReportConfirmedPrimaryAndResetsAuthorization() {
        val bikeInfo = legacyFitnessBikeDeviceInfo(serial = 100L)
        val otherSerial = legacyFitnessBikeDeviceInfo(serial = 200L)
        val transport = ScriptedTransport(
            listOf(TransportResult.Ok(bikeInfo), TransportResult.Ok(otherSerial)),
        )
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.MALFORMED, outcome.stopKind)
        assertTrue(outcome.summary.contains("CONFIRM_IDENTITY_MISMATCH"))
        assertNull(outcome.primaryDeviceId)
        assertFalse(outcome.identityQualified)
        assertFalse(
            outcome.events.any { it is ProbeEvent.PrimaryDeviceAdopted && it.confirmed },
        )
        assertTrue(transport.transmitAllowlist()!!.state() is SessionTransmitAuthorization.MainOnly)
    }

    @Test
    fun newUsbSessionAfterCloseStartsMainOnlyEvenAfterPriorConfirm() {
        val transport = ScriptedTransport(
            listOf(
                TransportResult.Ok(legacyFitnessBikeDeviceInfo()),
                TransportResult.Ok(legacyFitnessBikeDeviceInfo()),
                TransportResult.Ok(retargetFrame(hex("02 10 82 02 00 00 00 AF 9C 00 00 52 1F 06 00 58"), fitness)),
                TransportResult.Ok(retargetFrame(hex("02 06 84 02 54 E2"), fitness)),
            ) + telemetryHappyPathResponses.map {
                TransportResult.Ok(retargetFrame(it, fitness))
            },
        )
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.NONE, outcome.stopKind)
        assertEquals(fitness, outcome.primaryDeviceId)
        assertTrue(transport.transmitAllowlist()!!.state() is SessionTransmitAuthorization.Confirmed)

        transport.close()
        assertTrue(transport.transmitAllowlist()!!.state() is SessionTransmitAuthorization.MainOnly)

        val next = ScriptedTransport(listOf(TransportResult.Ok(ByteArray(0))))
        val validated = ValidatedProbeTransport(next, next.transmitAllowlist()!!)
        assertTrue(validated.transmitAllowlist()!!.state() is SessionTransmitAuthorization.MainOnly)
        assertEquals(
            TransportFailureClass.POLICY_REJECTED,
            (validated.exchange(systemInfoBike) as TransportResult.Failed).classification,
        )
        assertEquals(0, next.sent.size)
    }
}
