// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.session.BasicProbeSequence
import com.fitbaus.bikebridge.equipmentprobe.session.ProbeEvent
import com.fitbaus.bikebridge.equipmentprobe.session.StopKind
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportResult
import com.fitbaus.bikebridge.protocol.EquipmentCommand
import com.fitbaus.bikebridge.protocol.EquipmentStatus
import com.fitbaus.bikebridge.protocol.EquipmentDeviceIds
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.atomic.AtomicBoolean

class BasicProbeSequenceTest {
    private val deviceInfo = hex("02 0B 81 02 56 00 15 CD 5B 07 2A")
    private val systemInfo = hex("02 10 82 02 00 00 00 AF 9C 00 00 52 1F 06 00 58")
    private val versionInfo = hex("02 06 84 02 54 E2")
    private val wattsRpm = hex("02 09 02 02 96 00 48 00 ED")
    private val maxResistance = response(command = EquipmentCommand.READ_WRITE_DATA, status = EquipmentStatus.DONE, data = byteArrayOf(24))
    private val workoutMode = response(command = EquipmentCommand.READ_WRITE_DATA, status = EquipmentStatus.DONE, data = byteArrayOf(2))
    private val lockout = response(command = EquipmentCommand.READ_WRITE_DATA, status = EquipmentStatus.DONE, data = byteArrayOf(1))
    private val resistance = response(command = EquipmentCommand.READ_WRITE_DATA, status = EquipmentStatus.DONE, data = byteArrayOf(5))
    private val actualResistance = response(command = EquipmentCommand.READ_WRITE_DATA, status = EquipmentStatus.DONE, data = byteArrayOf(5))

    private fun mainIdentityThen(vararg more: ByteArray): List<TransportResult> =
        (listOf(deviceInfo, deviceInfo, systemInfo, versionInfo) + more.toList()).map { TransportResult.Ok(it) }

    @Test
    fun completesHappyPathWithinBudget() {
        val transport = ScriptedTransport(
            mainIdentityThen(wattsRpm, maxResistance, workoutMode, lockout, resistance, actualResistance),
        )
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.NONE, outcome.stopKind)
        assertTrue(outcome.identityQualified)
        assertTrue(outcome.telemetryQualified)
        assertEquals(EquipmentDeviceIds.MAIN, outcome.primaryDeviceId)
        assertTrue(outcome.requestsUsed <= ProbeConstants.BASIC_REQUEST_BUDGET)
        assertTrue(transport.closed.not())
        assertTrue(outcome.events.any { it is ProbeEvent.PrimaryDeviceAdopted && it.confirmed })
    }

    @Test
    fun adoptsFitnessBikePrimaryDeviceAndConfirmsWithinBudget() {
        val bikeInfo = legacyFitnessBikeDeviceInfo().copyOf(64).also { it[50] = 0x22 }
        val bikeSystem = retargetFrame(systemInfo, EquipmentDeviceIds.FITNESS_BIKE)
        val bikeVersion = retargetFrame(versionInfo, EquipmentDeviceIds.FITNESS_BIKE)
        val bikeWatts = retargetFrame(wattsRpm, EquipmentDeviceIds.FITNESS_BIKE)
        val transport = ScriptedTransport(
            listOf(
                TransportResult.Ok(bikeInfo),
                TransportResult.Ok(legacyFitnessBikeDeviceInfo()),
                TransportResult.Ok(bikeSystem),
                TransportResult.Ok(bikeVersion),
                TransportResult.Ok(bikeWatts),
                TransportResult.Ok(retargetFrame(maxResistance, EquipmentDeviceIds.FITNESS_BIKE)),
                TransportResult.Ok(retargetFrame(workoutMode, EquipmentDeviceIds.FITNESS_BIKE)),
                TransportResult.Ok(retargetFrame(lockout, EquipmentDeviceIds.FITNESS_BIKE)),
                TransportResult.Ok(retargetFrame(resistance, EquipmentDeviceIds.FITNESS_BIKE)),
                TransportResult.Ok(retargetFrame(actualResistance, EquipmentDeviceIds.FITNESS_BIKE)),
            ),
        )
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.NONE, outcome.stopKind)
        assertEquals(EquipmentDeviceIds.FITNESS_BIKE, outcome.primaryDeviceId)
        assertTrue(outcome.identityQualified)
        assertTrue(outcome.telemetryQualified)
        assertTrue(outcome.requestsUsed <= ProbeConstants.BASIC_REQUEST_BUDGET)
        assertEquals(EquipmentDeviceIds.MAIN, transport.sent[0][0].toInt() and 0xFF)
        assertEquals(EquipmentDeviceIds.FITNESS_BIKE, transport.sent[1][0].toInt() and 0xFF)
        assertTrue(
            outcome.events.any {
                it is ProbeEvent.PrimaryDeviceAdopted &&
                    it.primaryDeviceId == EquipmentDeviceIds.FITNESS_BIKE &&
                    it.adoptedFromResponseDeviceMismatch &&
                    it.confirmed
            },
        )
        assertTrue(
            outcome.events.any {
                it is ProbeEvent.ResponseObserved && it.parseSummary.startsWith("BootstrapAdopted(MAIN->")
            },
        )
    }

    @Test
    fun rejectsConfirmationIdentityMismatch() {
        val bikeInfo = legacyFitnessBikeDeviceInfo(serial = 100L)
        val otherSerial = legacyFitnessBikeDeviceInfo(serial = 200L)
        val transport = ScriptedTransport(
            listOf(TransportResult.Ok(bikeInfo), TransportResult.Ok(otherSerial)),
        )
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.MALFORMED, outcome.stopKind)
        assertTrue(outcome.summary.contains("CONFIRM_IDENTITY_MISMATCH"))
        assertFalse(outcome.identityQualified)
        assertEquals(null, outcome.primaryDeviceId)
        assertFalse(outcome.events.any { it is ProbeEvent.PrimaryDeviceAdopted && it.confirmed })
        assertTrue(
            transport.transmitAllowlist()!!.state() is
                com.fitbaus.bikebridge.equipmentprobe.policy.SessionTransmitAuthorization.MainOnly,
        )
    }

    @Test
    fun ordinaryDeviceMismatchIsDistinguishedFromBootstrapAdoption() {
        val treadmill = retargetFrame(deviceInfo, EquipmentDeviceIds.TREADMILL)
        val transport = ScriptedTransport(listOf(TransportResult.Ok(treadmill)))
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.MALFORMED, outcome.stopKind)
        assertTrue(outcome.summary.contains("ordinary device mismatch"))
        assertTrue(
            outcome.events.any {
                it is ProbeEvent.ResponseObserved && it.parseSummary.startsWith("OrdinaryDeviceMismatch")
            },
        )
    }

    @Test
    fun stopsImmediatelyOnSecurityBlock() {
        val transport = ScriptedTransport(
            listOf(TransportResult.Ok(hex("02 05 81 08 90"))),
        )
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.SECURITY_BLOCK, outcome.stopKind)
        assertEquals(1, transport.sent.size)
    }

    @Test
    fun recordsDeviceNotSupportedWithoutScanning() {
        val deviceNotSupported = response(
            command = EquipmentCommand.READ_WRITE_DATA,
            status = EquipmentStatus.DEVICE_NOT_SUPPORTED,
        )
        val transport = ScriptedTransport(
            mainIdentityThen(deviceNotSupported),
        )
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.DEVICE_NOT_SUPPORTED, outcome.stopKind)
        assertEquals(5, transport.sent.size)
        assertTrue(
            outcome.events.any {
                it is ProbeEvent.Info && it.message.contains("no device-id scan")
            },
        )
    }

    @Test
    fun stopsOnRepeatedTimeouts() {
        val transport = ScriptedTransport(
            listOf(
                TransportResult.Ok(deviceInfo),
                TransportResult.Failed(com.fitbaus.bikebridge.equipmentprobe.usb.TransportFailureClass.IN_TIMEOUT_OR_FAILURE),
                TransportResult.Failed(com.fitbaus.bikebridge.equipmentprobe.usb.TransportFailureClass.IN_TIMEOUT_OR_FAILURE),
            ),
        )
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.TRANSPORT_FAILURE, outcome.stopKind)
    }

    @Test
    fun stopsOnChecksumFailurePath() {
        val bad = deviceInfo.copyOf().also { it[it.lastIndex] = (it[it.lastIndex] + 1).toByte() }
        val transport = ScriptedTransport(listOf(TransportResult.Ok(bad)))
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.MALFORMED, outcome.stopKind)
        assertFalse(outcome.identityQualified)
    }

    @Test
    fun cancellationStopsWithoutExtraRequests() {
        val cancel = AtomicBoolean(false)
        val transport = ScriptedTransport(
            mainIdentityThen(wattsRpm),
        )
        cancel.set(true)
        val outcome = BasicProbeSequence(transport, sleeper = {}, isCancelled = { cancel.get() }).run()
        assertEquals(StopKind.CANCELLED, outcome.stopKind)
        assertEquals(0, transport.sent.size)
    }

    @Test
    fun detachDuringExchangeStops() {
        val transport = ScriptedTransport(
            listOf(
                TransportResult.Ok(deviceInfo),
                TransportResult.Ok(systemInfo),
            ),
        )
        transport.detach()
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.DETACH, outcome.stopKind)
    }

    @Test
    fun oneByteResistanceRawIsNotDecodedByCodec() {
        val transport = ScriptedTransport(
            mainIdentityThen(wattsRpm, maxResistance, workoutMode, lockout, resistance, actualResistance),
        )
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertTrue(
            outcome.events.any {
                it is ProbeEvent.FieldReading &&
                    it.field == com.fitbaus.bikebridge.protocol.BikeField.RESISTANCE &&
                    it.summary.contains("expected 2 for codec")
            },
        )
    }

    @Test
    fun twoByteResistanceIsDecodedWithMaxResistanceLevel() {
        val max = response(command = EquipmentCommand.READ_WRITE_DATA, status = EquipmentStatus.DONE, data = byteArrayOf(22))
        val resistance2 = response(
            command = EquipmentCommand.READ_WRITE_DATA,
            status = EquipmentStatus.DONE,
            data = byteArrayOf(0x5F, 0x03),
        )
        val actual2 = response(
            command = EquipmentCommand.READ_WRITE_DATA,
            status = EquipmentStatus.DONE,
            data = byteArrayOf(0x98.toByte(), 0x08),
        )
        val transport = ScriptedTransport(
            mainIdentityThen(wattsRpm, max, workoutMode, lockout, resistance2, actual2),
        )
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertTrue(
            outcome.events.any {
                it is ProbeEvent.FieldReading &&
                    it.field == com.fitbaus.bikebridge.protocol.BikeField.RESISTANCE &&
                    it.summary.contains("level=2")
            },
        )
        assertTrue(
            outcome.events.any {
                it is ProbeEvent.FieldReading &&
                    it.field == com.fitbaus.bikebridge.protocol.BikeField.ACTUAL_RESISTANCE &&
                    it.summary.contains("level=5")
            },
        )
    }
}
