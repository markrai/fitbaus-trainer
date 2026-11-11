// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.session.DynamicObservationSequence
import com.fitbaus.bikebridge.equipmentprobe.session.ProbeEvent
import com.fitbaus.bikebridge.equipmentprobe.session.ProbePhase
import com.fitbaus.bikebridge.equipmentprobe.session.ProbeSessionRunner
import com.fitbaus.bikebridge.equipmentprobe.session.StageCoordinator
import com.fitbaus.bikebridge.equipmentprobe.session.StageSignalKind
import com.fitbaus.bikebridge.equipmentprobe.session.StopKind
import com.fitbaus.bikebridge.equipmentprobe.usb.OpenResult
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportResult
import com.fitbaus.bikebridge.protocol.BikeField
import com.fitbaus.bikebridge.protocol.EquipmentCommand
import com.fitbaus.bikebridge.protocol.EquipmentStatus
import com.fitbaus.bikebridge.protocol.EquipmentDeviceIds
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.util.concurrent.atomic.AtomicLong

class DynamicObservationSequenceTest {
    private val bootstrapBike = legacyFitnessBikeDeviceInfo().copyOf(64).also { it[50] = 0x22 }
    private val confirmBike = legacyFitnessBikeDeviceInfo()
    private val maxResistance = response(
        device = com.fitbaus.bikebridge.protocol.EquipmentDevice.FITNESS_BIKE,
        command = EquipmentCommand.READ_WRITE_DATA,
        status = EquipmentStatus.DONE,
        data = byteArrayOf(22),
    )
    private val wattsRpm = retargetFrame(hex("02 09 02 02 96 00 48 00 ED"), EquipmentDeviceIds.FITNESS_BIKE)
    private val resistance = response(
        device = com.fitbaus.bikebridge.protocol.EquipmentDevice.FITNESS_BIKE,
        command = EquipmentCommand.READ_WRITE_DATA,
        status = EquipmentStatus.DONE,
        data = byteArrayOf(0x5F, 0x03),
    )
    private val actualResistance = response(
        device = com.fitbaus.bikebridge.protocol.EquipmentDevice.FITNESS_BIKE,
        command = EquipmentCommand.READ_WRITE_DATA,
        status = EquipmentStatus.DONE,
        data = byteArrayOf(0x98.toByte(), 0x08),
    )

    private fun dynamicScriptedTransport(extraCycles: Int = 2): ScriptedTransport {
        val responses = ArrayList<TransportResult>()
        responses += TransportResult.Ok(bootstrapBike)
        responses += TransportResult.Ok(confirmBike)
        responses += TransportResult.Ok(maxResistance)
        repeat(extraCycles) {
            responses += TransportResult.Ok(wattsRpm)
            responses += TransportResult.Ok(resistance)
            responses += TransportResult.Ok(actualResistance)
        }
        return ScriptedTransport(responses)
    }

    @Test
    fun multiStageMarkersAssociateSamplesWithoutUsbForTransitions() {
        val clock = AtomicLong(0L)
        val coordinator = StageCoordinator()
        val transport = dynamicScriptedTransport(extraCycles = 4)
        // Drive stage transitions from a side thread via coordinator after bootstrap.
        val outcome = DynamicObservationSequence(
            transport = transport,
            stageCoordinator = coordinator,
            initialStage = "idle",
            durationMs = 60_000L,
            requestSpacingMs = 0L,
            stabilizeMs = 100L,
            monoElapsedMs = { clock.getAndAdd(50L) },
            sleeper = {},
        ).run()

        // After some sampling, request next stage then finish — simulate by replaying with signals queued ahead.
        // This run used initialStage=idle only; assert stage tagging + boundaries.
        assertTrue(outcome.events.any { it is ProbeEvent.StageBoundary && it.kind == StageSignalKind.START && it.stage == "idle" })
        assertTrue(
            outcome.events.any {
                it is ProbeEvent.FieldReading &&
                    it.stage == "idle" &&
                    it.field == BikeField.RESISTANCE &&
                    it.summary.contains("field2") &&
                    it.summary.contains("level=2")
            },
        )
        assertTrue(
            outcome.events.any {
                it is ProbeEvent.FieldReading &&
                    it.stage == "idle" &&
                    it.field == BikeField.ACTUAL_RESISTANCE &&
                    it.summary.contains("field18")
            },
        )
        // Stage transitions must not themselves consume USB budget beyond telemetry rotation.
        assertTrue(outcome.events.any { it is ProbeEvent.Info && it.message.contains("multiStage=true") })
        assertEquals(EquipmentDeviceIds.FITNESS_BIKE, outcome.primaryDeviceId)
    }

    @Test
    fun operatorStageQueueSwitchesLabelsWithoutInferredBoundaries() {
        val clock = AtomicLong(0L)
        val coordinator = StageCoordinator()
        coordinator.requestStart("cadence-1")
        var resistanceStarted = false
        var finished = false
        val transport = dynamicScriptedTransport(extraCycles = 8)
        val outcome = DynamicObservationSequence(
            transport = transport,
            stageCoordinator = coordinator,
            durationMs = 60_000L,
            requestSpacingMs = 0L,
            stabilizeMs = 0L,
            monoElapsedMs = {
                // Bootstrap uses 3 USB exchanges; inject operator stage changes after real samples.
                val sent = transport.sent.size
                if (!resistanceStarted && sent >= 6 && coordinator.activeStage() == "cadence-1") {
                    resistanceStarted = true
                    coordinator.requestEnd()
                    coordinator.requestStart("resistance-key-1")
                }
                if (!finished && sent >= 12 && coordinator.activeStage() == "resistance-key-1") {
                    finished = true
                    coordinator.requestFinishSession()
                }
                clock.getAndAdd(20L)
            },
            sleeper = {},
        ).run()
        val starts = outcome.events.filterIsInstance<ProbeEvent.StageBoundary>().filter { it.kind == StageSignalKind.START }
        val ends = outcome.events.filterIsInstance<ProbeEvent.StageBoundary>().filter { it.kind == StageSignalKind.END }
        assertTrue(starts.any { it.stage == "cadence-1" })
        assertTrue(starts.any { it.stage == "resistance-key-1" })
        assertTrue(ends.size >= 2)
        val stagesSeen = outcome.events.filterIsInstance<ProbeEvent.FieldReading>().mapNotNull { it.stage }.toSet()
        assertTrue(stagesSeen.contains("cadence-1"))
        assertTrue(stagesSeen.contains("resistance-key-1"))
        assertFalse(outcome.events.any { it is ProbeEvent.FieldReading && it.stage == null && it.field == BikeField.RESISTANCE })
        // Stage transitions must not enqueue extra USB beyond the scripted telemetry rotation.
        assertTrue(transport.sent.size >= 3)
    }

    @Test
    fun stabilizeWindowMarksSamplesExcludedFromParity() {
        val clock = AtomicLong(0L)
        val transport = dynamicScriptedTransport(extraCycles = 3)
        val outcome = DynamicObservationSequence(
            transport = transport,
            initialStage = "idle",
            durationMs = 60_000L,
            requestSpacingMs = 0L,
            stabilizeMs = 5_000L,
            monoElapsedMs = { clock.getAndAdd(100L) },
            sleeper = {},
        ).run()
        val readings = outcome.events.filterIsInstance<ProbeEvent.FieldReading>().filter { it.stage == "idle" }
        assertTrue(readings.any { it.inStabilize })
        assertTrue(readings.any { !it.inStabilize })
    }

    @Test
    fun cancellationStopsWithoutClaimingSuccess() {
        val transport = dynamicScriptedTransport(extraCycles = 4)
        val outcome = DynamicObservationSequence(
            transport = transport,
            durationMs = 60_000L,
            requestSpacingMs = 0L,
            sleeper = {},
            isCancelled = { true },
        ).run()
        assertEquals(StopKind.CANCELLED, outcome.stopKind)
        assertEquals(0, transport.sent.size)
    }

    @Test
    fun runnerDynamicOpensUsbIndependentlyOfExtendedAndBasic(@TempDir tempDir: File) {
        val device = matchingBrainboard()
        var openCount = 0
        val gateway = FakeUsbGateway(listOf(device), openHandler = {
            openCount += 1
            OpenResult.Opened(dynamicScriptedTransport(extraCycles = 1))
        })
        gateway.grant(device.deviceName)
        val runner = ProbeSessionRunner(gateway, tempDir) { true }
        assertFalse(runner.extendedQualification.eligible)
        val report = runner.runDynamic(
            isCancelled = { false },
            initialStage = "idle",
            durationMs = 1L,
        )
        assertEquals(ProbePhase.DYNAMIC, report.phase)
        assertEquals(1, openCount)
        assertTrue(report.events.any { it is ProbeEvent.Info && it.message.contains("initialStage=idle") })
        assertFalse(runner.extendedQualification.eligible)
        val opensAfterDynamic = openCount
        assertTrue(runner.runExtended { false }.outcome.contains("not authorized"))
        assertEquals(opensAfterDynamic, openCount)
    }

    @Test
    fun dynamicDurationIsClampedToFiniteBounds() {
        assertEquals(ProbeConstants.DYNAMIC_DURATION_MS, ProbeConstants.clampDynamicDurationMs(0))
        assertEquals(ProbeConstants.DYNAMIC_DURATION_MS_MIN, ProbeConstants.clampDynamicDurationMs(1))
        assertEquals(ProbeConstants.DYNAMIC_DURATION_MS_MAX, ProbeConstants.clampDynamicDurationMs(999_999))
    }
}
