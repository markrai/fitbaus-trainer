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
import com.fitbaus.bikebridge.protocol.FrameDiagnostics
import com.fitbaus.bikebridge.protocol.FrameParseResult
import com.fitbaus.bikebridge.protocol.FrameStructureSummary
import com.fitbaus.bikebridge.protocol.Hex
import com.fitbaus.bikebridge.protocol.ReadWriteDataResult

internal data class ExtendedObservationOutcome(
    val stopKind: StopKind,
    val summary: String,
    val events: List<ProbeEvent>,
    val requestsUsed: Int,
)

internal class ExtendedObservationSequence(
    private val transport: ProbeTransport,
    private val device: EquipmentDevice = EquipmentDevice.MAIN,
    private val budget: DiagnosticBudget = DiagnosticBudget(ProbeConstants.EXTENDED_REQUEST_BUDGET),
    private val durationMs: Long = ProbeConstants.EXTENDED_DURATION_MS,
    private val requestSpacingMs: Long = ProbeConstants.EXTENDED_REQUEST_SPACING_MS,
    private val monoElapsedMs: () -> Long = { System.nanoTime() / 1_000_000L },
    private val sleeper: (Long) -> Unit = { Thread.sleep(it) },
    private val isCancelled: () -> Boolean = { false },
) {
    private val events = ArrayList<ProbeEvent>()
    private var consecutiveFailures = 0
    private var lastExchangeAt: Long? = null
    private var rotationIndex = 0
    private var deadlineElapsedMs = 0L

    private val rotation: List<List<BikeField>> = listOf(
        listOf(BikeField.WATTS, BikeField.RPM),
        listOf(BikeField.RESISTANCE),
        listOf(BikeField.ACTUAL_RESISTANCE),
    )

    fun run(): ExtendedObservationOutcome {
        events += ProbeEvent.Info(
            "extended observation start durationMs=$durationMs budget=${ProbeConstants.EXTENDED_REQUEST_BUDGET} " +
                "maxOverallHz=2 rotation=WattsRpm,Resistance,ActualResistance " +
                "failurePolicy=globalConsecutive",
        )
        val started = monoElapsedMs()
        deadlineElapsedMs = started + durationMs
        while (monoElapsedMs() < deadlineElapsedMs) {
            if (isCancelled()) return finish(StopKind.CANCELLED, "cancelled")
            if (!transport.isAttached()) return finish(StopKind.DETACH, "device detached")
            if (budget.exhausted) return finish(StopKind.BUDGET_EXHAUSTED, "extended budget exhausted")

            val fields = rotation[rotationIndex % rotation.size]
            rotationIndex += 1
            when (val outcome = readFields(fields)) {
                null -> return finish(currentStop(), currentStopMessage())
                ReadOutcome.DurationExpired -> return finish(StopKind.NONE, "extended observation duration elapsed")
                ReadOutcome.SecurityBlock ->
                    return finish(StopKind.SECURITY_BLOCK, "extended SecurityBlock on ${fields.joinToString("+")}")
                ReadOutcome.HardFail ->
                    return finish(currentStop(), "terminal failure on ${fields.joinToString("+")}")
                ReadOutcome.Ok -> Unit
            }
        }
        return finish(StopKind.NONE, "extended observation completed")
    }

    private fun readFields(fields: List<BikeField>): ReadOutcome? {
        val request = EquipmentRequests.read(device, fields)
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

        val gated = GatedEquipmentExchange(transport, budget) { classification ->
            events += ProbeEvent.TransmitRejected(classification.reportToken)
        }
        events += ProbeEvent.RequestSent(
            command = request.command,
            deviceId = request.device.id,
            requestBytes = request.encode().size,
            durationMs = 0,
            sensitive = false,
        )
        val exchangeResult = try {
            gated.exchange(request)
        } catch (_: BudgetExhaustedException) {
            return null
        }
        lastExchangeAt = monoElapsedMs()
        when (exchangeResult) {
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
                    return ReadOutcome.HardFail
                }
                return if (consecutiveFailures >= ProbeConstants.CONSECUTIVE_TRANSPORT_FAILURE_LIMIT) {
                    ReadOutcome.HardFail
                } else {
                    ReadOutcome.Ok
                }
            }
            is ProbeExchangeResult.Response -> {
                val raw = exchangeResult.bytes
                if (raw == null) {
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
                    return if (consecutiveFailures >= ProbeConstants.CONSECUTIVE_TRANSPORT_FAILURE_LIMIT) {
                        ReadOutcome.HardFail
                    } else {
                        ReadOutcome.Ok
                    }
                }
                return decodeTelemetry(request, fields, raw)
            }
        }
    }

    private fun decodeTelemetry(
        request: com.fitbaus.bikebridge.protocol.ReadWriteDataRequest,
        fields: List<BikeField>,
        raw: ByteArray,
    ): ReadOutcome {
        val structure = FrameDiagnostics.summarize(raw, request.device, request.command)
        val accepted = structure.parseResult as? FrameParseResult.Accepted
        when (val decoded = request.decode(raw)) {
            ReadWriteDataResult.SecurityBlocked -> {
                events += observedFromStructure(
                    structure = structure,
                    command = request.command,
                    status = EquipmentStatus.SECURITY_BLOCK,
                    statusCode = EquipmentStatus.SECURITY_BLOCK.code,
                    parseSummary = "SecurityBlocked",
                )
                return ReadOutcome.SecurityBlock
            }
            is ReadWriteDataResult.Values -> {
                consecutiveFailures = 0
                val hex = if (accepted != null && fields.all { it.id in ApprovedReadFields.TELEMETRY_NON_SENSITIVE }) {
                    Hex.format(accepted.frame.data())
                } else {
                    null
                }
                events += observedFromStructure(
                    structure = structure,
                    command = request.command,
                    status = EquipmentStatus.DONE,
                    statusCode = EquipmentStatus.DONE.code,
                    parseSummary = "Values",
                    telemetryHex = hex,
                )
                for ((field, value) in decoded.readings) {
                    val rawHex = when (value) {
                        is FieldValue.Undecoded -> Hex.format(value.bytes())
                        is FieldValue.InvalidEncoding -> Hex.format(value.bytes())
                        else -> null
                    }
                    val summary = when (field) {
                        BikeField.RESISTANCE, BikeField.ACTUAL_RESISTANCE ->
                            "unresolved encoding; raw only; not numerically decoded"
                        else -> value.toString()
                    }
                    events += ProbeEvent.FieldReading(field, summary, rawHex)
                }
                return ReadOutcome.Ok
            }
            else -> {
                consecutiveFailures += 1
                events += observedFromStructure(
                    structure = structure,
                    command = request.command,
                    status = accepted?.frame?.status,
                    statusCode = accepted?.frame?.statusCode,
                    parseSummary = decoded.toString(),
                )
                return if (consecutiveFailures >= ProbeConstants.CONSECUTIVE_TRANSPORT_FAILURE_LIMIT) {
                    ReadOutcome.HardFail
                } else {
                    ReadOutcome.Ok
                }
            }
        }
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

    private fun finish(stopKind: StopKind, summary: String): ExtendedObservationOutcome {
        if (stopKind == StopKind.NONE) {
            events += ProbeEvent.Completed(summary, budget.usedCount())
        } else {
            events += ProbeEvent.Stopped(summary)
        }
        return ExtendedObservationOutcome(stopKind, summary, events.toList(), budget.usedCount())
    }

    private enum class ReadOutcome {
        Ok,
        SecurityBlock,
        HardFail,
        DurationExpired,
    }
}
