// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe.session

import com.fitbaus.bikebridge.equipmentprobe.ProbeConstants
import com.fitbaus.bikebridge.equipmentprobe.policy.ApprovedReadFields
import com.fitbaus.bikebridge.equipmentprobe.policy.DiagnosticBudget
import com.fitbaus.bikebridge.equipmentprobe.usb.ProbeTransport
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportFailureClass
import com.fitbaus.bikebridge.protocol.BikeField
import com.fitbaus.bikebridge.protocol.EquipmentDevice
import com.fitbaus.bikebridge.protocol.EquipmentRequests
import com.fitbaus.bikebridge.protocol.EquipmentStatus
import com.fitbaus.bikebridge.protocol.FieldValue
import com.fitbaus.bikebridge.protocol.EquipmentDeviceIds
import com.fitbaus.bikebridge.protocol.FrameDiagnostics
import com.fitbaus.bikebridge.protocol.FrameParseResult
import com.fitbaus.bikebridge.protocol.FrameStructureSummary
import com.fitbaus.bikebridge.protocol.Hex
import com.fitbaus.bikebridge.protocol.PrimaryDeviceBootstrap
import com.fitbaus.bikebridge.protocol.PrimaryDeviceBootstrapResult
import com.fitbaus.bikebridge.protocol.ReadWriteDataRequest
import com.fitbaus.bikebridge.protocol.ReadWriteDataResult
import com.fitbaus.bikebridge.protocol.ResistanceCodec

/**
 * F2.4 bounded read-only dynamic telemetry observation.
 *
 * Performs a **fresh** DeviceInfo(MAIN) bootstrap + DeviceInfo(primary) confirm in
 * this USB session, then rotates Watts+Rpm / Resistance / ActualResistance for a
 * bounded duration. Never reuses Basic-session authorization.
 *
 * Distinguishes board [ProbeConstants.BOARD_MAX_RESISTANCE_LEVEL_OBSERVED] from the
 * Fitbaus application write window
 * [ProbeConstants.APPLICATION_RESISTANCE_MIN]..[ProbeConstants.APPLICATION_RESISTANCE_MAX].
 */
internal data class DynamicObservationOutcome(
    val stopKind: StopKind,
    val summary: String,
    val primaryDeviceId: Int?,
    val maxResistanceLevel: Int?,
    val sampleCount: Int,
    val events: List<ProbeEvent>,
    val requestsUsed: Int,
)

internal class DynamicObservationSequence(
    private val transport: ProbeTransport,
    private val stageCoordinator: StageCoordinator = StageCoordinator(),
    /** Optional initial stage auto-started after bootstrap (tests / single-stage runs). */
    private val initialStage: String? = null,
    private val bootstrapDevice: EquipmentDevice = EquipmentDevice.MAIN,
    private val budget: DiagnosticBudget = DiagnosticBudget(ProbeConstants.DYNAMIC_REQUEST_BUDGET),
    private val durationMs: Long = ProbeConstants.DYNAMIC_DURATION_MS,
    private val requestSpacingMs: Long = ProbeConstants.DYNAMIC_REQUEST_SPACING_MS,
    private val stabilizeMs: Long = ProbeConstants.DYNAMIC_STAGE_STABILIZE_MS,
    private val monoElapsedMs: () -> Long = { System.nanoTime() / 1_000_000L },
    private val sleeper: (Long) -> Unit = { Thread.sleep(it) },
    private val isCancelled: () -> Boolean = { false },
) {
    private val events = ArrayList<ProbeEvent>()
    private var consecutiveFailures = 0
    private var lastExchangeAt: Long? = null
    private var sessionPrimary: EquipmentDevice? = null
    private var sessionMaxResistanceLevel: Int? = null
    private var sampleCount = 0
    private var sessionStartMono = 0L
    private var deadlineElapsedMs = 0L
    private var rotationIndex = 0
    private var currentStage: String? = null
    private var stageStabilizeUntilElapsed: Long = 0L
    private var finishRequested = false

    private val rotation: List<List<BikeField>> = listOf(
        listOf(BikeField.WATTS, BikeField.RPM),
        listOf(BikeField.RESISTANCE),
        listOf(BikeField.ACTUAL_RESISTANCE),
    )

    fun run(): DynamicObservationOutcome {
        sessionStartMono = monoElapsedMs()
        val boundedDurationMs = ProbeConstants.clampDynamicDurationMs(durationMs)
        events += ProbeEvent.Info(
            "dynamic observation start multiStage=true durationMs=$boundedDurationMs " +
                "(requestedMs=$durationMs) stabilizeMs=$stabilizeMs " +
                "budget=${ProbeConstants.DYNAMIC_REQUEST_BUDGET} spacingMs=$requestSpacingMs " +
                "boardMaxObserved=${ProbeConstants.BOARD_MAX_RESISTANCE_LEVEL_OBSERVED} " +
                "appResistanceWindow=" +
                "${ProbeConstants.APPLICATION_RESISTANCE_MIN}..${ProbeConstants.APPLICATION_RESISTANCE_MAX} " +
                "rotation=WattsRpm,Resistance(field2),ActualResistance(field18) " +
                "initialStage=${initialStage ?: "none"}",
        )
        transport.transmitAllowlist()?.resetToMainOnly()

        when (val boot = bootstrapAndConfirm()) {
            is BootResult.Stopped -> return finish(boot.stopKind, boot.summary)
            is BootResult.Ok -> Unit
        }

        when (val max = readMaxResistanceLevel()) {
            is BootResult.Stopped -> return finish(max.stopKind, max.summary)
            is BootResult.Ok -> Unit
        }

        events += ProbeEvent.Info(
            "dynamic sampling ready primary=${sessionPrimary?.id} " +
                "maxResistanceLevel=${sessionMaxResistanceLevel}; awaiting operator STAGE_START",
        )
        StageCoordinator.normalize(initialStage)?.let { stageCoordinator.requestStart(it) }

        deadlineElapsedMs = monoElapsedMs() + boundedDurationMs
        while (monoElapsedMs() < deadlineElapsedMs && !finishRequested) {
            if (isCancelled()) return finish(StopKind.CANCELLED, "cancelled")
            if (!transport.isAttached()) return finish(StopKind.DETACH, "device detached")
            if (budget.exhausted) return finish(StopKind.BUDGET_EXHAUSTED, "dynamic budget exhausted")

            drainStageSignals()
            if (finishRequested) break

            // Outside an active stage: idle-wait without USB traffic.
            if (currentStage == null) {
                sleeper(50L)
                continue
            }

            val fields = rotation[rotationIndex % rotation.size]
            rotationIndex += 1
            when (val outcome = readFields(fields)) {
                null -> return finish(currentStop(), currentStopMessage())
                ReadOutcome.DurationExpired ->
                    return finish(StopKind.NONE, "dynamic observation duration elapsed samples=$sampleCount")
                ReadOutcome.SecurityBlock ->
                    return finish(StopKind.SECURITY_BLOCK, "dynamic SecurityBlock on ${fields.joinToString("+")}")
                ReadOutcome.HardFail ->
                    return finish(currentStop(), "terminal failure on ${fields.joinToString("+")}")
                ReadOutcome.Ok -> Unit
            }
        }
        if (currentStage != null) {
            endCurrentStage(elapsedNow())
        }
        return finish(StopKind.NONE, "dynamic observation completed samples=$sampleCount")
    }

    private fun drainStageSignals() {
        while (true) {
            val signal = stageCoordinator.poll() ?: return
            val elapsed = elapsedNow()
            when (signal.kind) {
                StageSignalKind.START -> {
                    if (currentStage != null) {
                        endCurrentStage(elapsed)
                    }
                    currentStage = signal.stage
                    stageCoordinator.markActive(signal.stage)
                    stageStabilizeUntilElapsed = elapsed + stabilizeMs
                    events += ProbeEvent.StageBoundary(StageSignalKind.START, signal.stage, elapsed)
                }
                StageSignalKind.END -> {
                    if (currentStage != null) {
                        endCurrentStage(elapsed)
                    }
                }
                StageSignalKind.FINISH_SESSION -> {
                    if (currentStage != null) {
                        endCurrentStage(elapsed)
                    }
                    finishRequested = true
                    events += ProbeEvent.Info("operator requested FINISH_SESSION at elapsedMs=$elapsed")
                    return
                }
            }
        }
    }

    private fun endCurrentStage(elapsed: Long) {
        val stage = currentStage ?: return
        events += ProbeEvent.StageBoundary(StageSignalKind.END, stage, elapsed)
        currentStage = null
        stageCoordinator.markActive(null)
        stageStabilizeUntilElapsed = 0L
    }

    private fun bootstrapAndConfirm(): BootResult {
        val bootstrapRequest = EquipmentRequests.deviceInfo(bootstrapDevice)
        val bootstrapRaw = exchangeOrNull(bootstrapRequest, sensitive = true, useMinSpacing = true)
            ?: return BootResult.Stopped(currentStop(), currentStopMessage())

        when (val bootstrap = PrimaryDeviceBootstrap.evaluate(bootstrapDevice, bootstrapRaw)) {
            is PrimaryDeviceBootstrapResult.Rejected -> {
                recordStructure(bootstrapRequest, bootstrapRaw, "BootstrapRejected(${bootstrap.reason})")
                if (bootstrap.detail.contains("SECURITY_BLOCK", ignoreCase = true) ||
                    bootstrap.detail.startsWith("SECURITY_BLOCKED")
                ) {
                    return BootResult.Stopped(StopKind.SECURITY_BLOCK, "DeviceInfo SecurityBlock")
                }
                return BootResult.Stopped(
                    StopKind.MALFORMED,
                    "DeviceInfo bootstrap rejected: ${bootstrap.reason}: ${bootstrap.detail}",
                )
            }
            is PrimaryDeviceBootstrapResult.Adopted -> {
                recordStructure(bootstrapRequest, bootstrapRaw, "BootstrapAdopted")
                transport.transmitAllowlist()?.beginAwaitingConfirmation(bootstrap.primaryDevice.id)
                val confirmRequest = EquipmentRequests.deviceInfo(bootstrap.primaryDevice)
                val confirmRaw = exchangeOrNull(confirmRequest, sensitive = true, useMinSpacing = true)
                if (confirmRaw == null) {
                    transport.transmitAllowlist()?.resetToMainOnly()
                    return BootResult.Stopped(currentStop(), currentStopMessage())
                }
                when (
                    val confirmed = PrimaryDeviceBootstrap.confirm(
                        bootstrap.primaryDevice,
                        bootstrap.deviceInfo,
                        confirmRaw,
                    )
                ) {
                    is PrimaryDeviceBootstrapResult.Rejected -> {
                        transport.transmitAllowlist()?.resetToMainOnly()
                        recordStructure(
                            confirmRequest,
                            confirmRaw,
                            "ConfirmRejected(${confirmed.reason}: ${confirmed.detail})",
                        )
                        return BootResult.Stopped(
                            StopKind.MALFORMED,
                            "PrimaryDevice confirmation failed: ${confirmed.reason}: ${confirmed.detail}",
                        )
                    }
                    is PrimaryDeviceBootstrapResult.Adopted -> {
                        transport.transmitAllowlist()?.confirmSessionPrimary(bootstrap.primaryDevice.id)
                        sessionPrimary = bootstrap.primaryDevice
                        recordStructure(confirmRequest, confirmRaw, "ConfirmParsed")
                        events += ProbeEvent.PrimaryDeviceAdopted(
                            requestedDeviceId = bootstrap.requestedDevice.id,
                            primaryDeviceId = bootstrap.primaryDevice.id,
                            primaryDeviceName = EquipmentDeviceIds.nameOrNull(bootstrap.primaryDevice.id),
                            adoptedFromResponseDeviceMismatch = bootstrap.adoptedFromResponseDeviceMismatch,
                            confirmed = true,
                            softwareVersion = confirmed.deviceInfo.softwareVersion,
                        )
                        return BootResult.Ok
                    }
                }
            }
        }
    }

    private fun readMaxResistanceLevel(): BootResult {
        val primary = sessionPrimary
            ?: return BootResult.Stopped(StopKind.MALFORMED, "PrimaryDevice missing before MaxResistanceLevel")
        val request = EquipmentRequests.read(primary, listOf(BikeField.MAX_RESISTANCE_LEVEL))
        val raw = exchangeOrNull(request, sensitive = false, useMinSpacing = true)
            ?: return BootResult.Stopped(currentStop(), currentStopMessage())
        when (val decoded = request.decode(raw)) {
            ReadWriteDataResult.SecurityBlocked -> {
                recordStructure(request, raw, "SecurityBlocked")
                return BootResult.Stopped(StopKind.SECURITY_BLOCK, "MaxResistanceLevel SecurityBlock")
            }
            is ReadWriteDataResult.Values -> {
                recordStructure(request, raw, "Values")
                emitFieldReadings(decoded.readings, elapsed = elapsedNow())
                val max = sessionMaxResistanceLevel
                if (max == null || max <= 0) {
                    return BootResult.Stopped(StopKind.MALFORMED, "MaxResistanceLevel missing or invalid")
                }
                if (max != ProbeConstants.BOARD_MAX_RESISTANCE_LEVEL_OBSERVED) {
                    events += ProbeEvent.Info(
                        "note MaxResistanceLevel=$max differs from documented board observed " +
                            "${ProbeConstants.BOARD_MAX_RESISTANCE_LEVEL_OBSERVED}; codec uses live value",
                    )
                }
                return BootResult.Ok
            }
            else -> {
                recordStructure(request, raw, decoded.toString())
                return BootResult.Stopped(StopKind.MALFORMED, "MaxResistanceLevel not decoded: $decoded")
            }
        }
    }

    private fun readFields(fields: List<BikeField>): ReadOutcome? {
        val primary = sessionPrimary ?: return ReadOutcome.HardFail
        val request = EquipmentRequests.read(primary, fields)
        val now = monoElapsedMs()
        val previous = lastExchangeAt
        if (previous != null) {
            val wait = requestSpacingMs - (now - previous)
            if (wait > 0) sleeper(wait)
        }
        if (monoElapsedMs() >= deadlineElapsedMs) return ReadOutcome.DurationExpired
        if (isCancelled()) return null
        if (!transport.isAttached()) return null
        if (budget.exhausted) return null

        val raw = exchangeOrNull(request, sensitive = false, useMinSpacing = false) ?: return when {
            isCancelled() -> null
            !transport.isAttached() -> null
            budget.exhausted -> null
            consecutiveFailures >= ProbeConstants.CONSECUTIVE_TRANSPORT_FAILURE_LIMIT -> ReadOutcome.HardFail
            else -> ReadOutcome.Ok
        }
        return decodeTelemetry(request, fields, raw)
    }

    private fun decodeTelemetry(
        request: ReadWriteDataRequest,
        fields: List<BikeField>,
        raw: ByteArray,
    ): ReadOutcome {
        when (val decoded = request.decode(raw)) {
            ReadWriteDataResult.SecurityBlocked -> {
                recordStructure(request, raw, "SecurityBlocked")
                return ReadOutcome.SecurityBlock
            }
            is ReadWriteDataResult.Values -> {
                consecutiveFailures = 0
                recordStructure(request, raw, "Values", includeTelemetryHex = fields.all {
                    it.id in ApprovedReadFields.TELEMETRY_NON_SENSITIVE
                })
                emitFieldReadings(decoded.readings, elapsed = elapsedNow())
                sampleCount += decoded.readings.size
                return ReadOutcome.Ok
            }
            else -> {
                consecutiveFailures += 1
                recordStructure(request, raw, decoded.toString())
                return if (consecutiveFailures >= ProbeConstants.CONSECUTIVE_TRANSPORT_FAILURE_LIMIT) {
                    ReadOutcome.HardFail
                } else {
                    ReadOutcome.Ok
                }
            }
        }
    }

    private fun emitFieldReadings(
        readings: Map<BikeField, FieldValue>,
        elapsed: Long,
    ) {
        for ((field, value) in readings) {
            if (field == BikeField.MAX_RESISTANCE_LEVEL && value is FieldValue.Number) {
                sessionMaxResistanceLevel = value.value.toInt()
            }
            val rawHex = when (value) {
                is FieldValue.Undecoded -> Hex.format(value.bytes())
                is FieldValue.InvalidEncoding -> Hex.format(value.bytes())
                else -> null
            }
            val summary = when {
                (field == BikeField.RESISTANCE || field == BikeField.ACTUAL_RESISTANCE) &&
                    value is FieldValue.Undecoded -> {
                    val max = sessionMaxResistanceLevel
                    val fieldTag = if (field == BikeField.RESISTANCE) "field2" else "field18"
                    when {
                        max != null && value.width == ResistanceCodec.WIRE_WIDTH -> {
                            val level = ResistanceCodec.decodeLevel(value.bytes(), max)
                            "ResistanceCodec $fieldTag level=$level " +
                                "(maxResistanceLevel=$max appWindow=" +
                                "${ProbeConstants.APPLICATION_RESISTANCE_MIN}.." +
                                "${ProbeConstants.APPLICATION_RESISTANCE_MAX} " +
                                "raw=${Hex.format(value.bytes())})"
                        }
                        max == null ->
                            "resistance $fieldTag raw only; maxResistanceLevel unavailable for codec"
                        else ->
                            "resistance $fieldTag raw width=${value.width}; " +
                                "expected ${ResistanceCodec.WIRE_WIDTH} for codec"
                    }
                }
                else -> value.toString()
            }
            val stage = currentStage
            val stabilizing = stage != null && elapsed < stageStabilizeUntilElapsed
            events += ProbeEvent.FieldReading(
                field = field,
                summary = summary,
                rawHex = rawHex,
                elapsedMs = elapsed,
                stage = stage,
                inStabilize = stabilizing,
            )
        }
    }

    private fun exchangeOrNull(
        request: com.fitbaus.bikebridge.protocol.EquipmentRequest,
        sensitive: Boolean,
        useMinSpacing: Boolean,
    ): ByteArray? {
        if (isCancelled()) return null
        if (!transport.isAttached()) return null
        if (budget.exhausted) return null

        val spacing = if (useMinSpacing) ProbeConstants.MIN_REQUEST_SPACING_MS else requestSpacingMs
        val previous = lastExchangeAt
        if (previous != null) {
            val wait = spacing - (monoElapsedMs() - previous)
            if (wait > 0) sleeper(wait)
        }

        val gated = GatedEquipmentExchange(transport, budget) { classification ->
            events += ProbeEvent.TransmitRejected(classification.reportToken)
        }
        val encoded = request.encode()
        events += ProbeEvent.RequestSent(
            command = request.command,
            deviceId = request.device.id,
            requestBytes = encoded.size,
            durationMs = 0,
            sensitive = sensitive,
        )
        val exchangeResult = try {
            gated.exchange(request)
        } catch (_: BudgetExhaustedException) {
            return null
        }
        lastExchangeAt = monoElapsedMs()
        return when (exchangeResult) {
            is ProbeExchangeResult.Failed -> {
                consecutiveFailures += 1
                events += ProbeEvent.ResponseObserved(
                    command = request.command,
                    status = null,
                    statusCode = null,
                    frameLength = 0,
                    checksumValid = false,
                    parseSummary = exchangeResult.classification.reportToken,
                    durationMs = 0,
                )
                if (exchangeResult.classification == TransportFailureClass.DEVICE_DETACHED) {
                    return null
                }
                if (exchangeResult.classification == TransportFailureClass.POLICY_REJECTED) {
                    return null
                }
                null
            }
            is ProbeExchangeResult.Response -> {
                val bytes = exchangeResult.bytes
                if (bytes == null) {
                    consecutiveFailures += 1
                    events += ProbeEvent.ResponseObserved(
                        command = request.command,
                        status = null,
                        statusCode = null,
                        frameLength = 0,
                        checksumValid = false,
                        parseSummary = TransportFailureClass.IN_TIMEOUT_OR_FAILURE.reportToken,
                        durationMs = 0,
                    )
                    null
                } else {
                    consecutiveFailures = 0
                    bytes
                }
            }
        }
    }

    private fun recordStructure(
        request: com.fitbaus.bikebridge.protocol.EquipmentRequest,
        raw: ByteArray,
        parseSummary: String,
        includeTelemetryHex: Boolean = false,
    ) {
        val structure = FrameDiagnostics.summarize(raw, request.device, request.command)
        val accepted = structure.parseResult as? FrameParseResult.Accepted
        events += observedFromStructure(
            structure = structure,
            command = request.command,
            status = accepted?.frame?.status,
            statusCode = accepted?.frame?.statusCode,
            parseSummary = parseSummary,
            telemetryHex = if (includeTelemetryHex && accepted != null) {
                Hex.format(accepted.frame.data())
            } else {
                null
            },
        )
    }

    private fun observedFromStructure(
        structure: FrameStructureSummary,
        command: com.fitbaus.bikebridge.protocol.EquipmentCommand,
        status: EquipmentStatus?,
        statusCode: Int?,
        parseSummary: String,
        telemetryHex: String? = null,
    ): ProbeEvent.ResponseObserved = ProbeEvent.ResponseObserved(
        command = command,
        status = status,
        statusCode = statusCode,
        frameLength = structure.transferLength,
        checksumValid = structure.checksumValid == true,
        checksumEvaluated = structure.checksumEvaluated,
        declaredLength = structure.declaredLength,
        frameRejection = structure.frameRejection?.name,
        frameRejectionDetail = structure.frameRejectionDetail,
        headerDeviceId = structure.headerDeviceId,
        headerDeviceName = structure.headerDeviceName,
        headerCommandId = structure.headerCommandId,
        headerStatusCode = structure.headerStatusCode,
        trailingPaddingBytes = structure.trailingPaddingBytes,
        trailingPaddingAllZero = structure.trailingPaddingAllZero,
        parseSummary = parseSummary,
        telemetryHex = telemetryHex,
        durationMs = 0,
    )

    private fun elapsedNow(): Long = monoElapsedMs() - sessionStartMono

    private fun currentStop(): StopKind = when {
        isCancelled() -> StopKind.CANCELLED
        !transport.isAttached() -> StopKind.DETACH
        budget.exhausted -> StopKind.BUDGET_EXHAUSTED
        else -> StopKind.TRANSPORT_FAILURE
    }

    private fun currentStopMessage(): String = when (currentStop()) {
        StopKind.CANCELLED -> "cancelled"
        StopKind.DETACH -> "device detached"
        StopKind.BUDGET_EXHAUSTED -> "budget exhausted"
        else -> "excessive errors"
    }

    private fun finish(stopKind: StopKind, summary: String): DynamicObservationOutcome {
        if (stopKind == StopKind.NONE) {
            events += ProbeEvent.Completed(summary, budget.usedCount())
        } else {
            events += ProbeEvent.Stopped(summary)
        }
        return DynamicObservationOutcome(
            stopKind = stopKind,
            summary = summary,
            primaryDeviceId = sessionPrimary?.id,
            maxResistanceLevel = sessionMaxResistanceLevel,
            sampleCount = sampleCount,
            events = events.toList(),
            requestsUsed = budget.usedCount(),
        )
    }

    private sealed class BootResult {
        object Ok : BootResult()
        data class Stopped(val stopKind: StopKind, val summary: String) : BootResult()
    }

    private enum class ReadOutcome {
        Ok,
        SecurityBlock,
        HardFail,
        DurationExpired,
    }
}
