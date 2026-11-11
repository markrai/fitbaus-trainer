// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe.session

import com.fitbaus.bikebridge.equipmentprobe.ProbeConstants
import com.fitbaus.bikebridge.equipmentprobe.policy.ApprovedReadFields
import com.fitbaus.bikebridge.equipmentprobe.policy.DiagnosticBudget
import com.fitbaus.bikebridge.equipmentprobe.report.IdentityRedaction
import com.fitbaus.bikebridge.equipmentprobe.usb.ProbeTransport
import com.fitbaus.bikebridge.protocol.BikeField
import com.fitbaus.bikebridge.protocol.DeviceInfo
import com.fitbaus.bikebridge.protocol.EquipmentDevice
import com.fitbaus.bikebridge.protocol.EquipmentRequests
import com.fitbaus.bikebridge.protocol.EquipmentStatus
import com.fitbaus.bikebridge.protocol.FieldValue
import com.fitbaus.bikebridge.protocol.EquipmentDeviceIds
import com.fitbaus.bikebridge.protocol.FrameDiagnostics
import com.fitbaus.bikebridge.protocol.FrameParseResult
import com.fitbaus.bikebridge.protocol.FrameStructureSummary
import com.fitbaus.bikebridge.protocol.Hex
import com.fitbaus.bikebridge.protocol.IdentityRejection
import com.fitbaus.bikebridge.protocol.IdentityResult
import com.fitbaus.bikebridge.protocol.PrimaryDeviceBootstrap
import com.fitbaus.bikebridge.protocol.PrimaryDeviceBootstrapResult
import com.fitbaus.bikebridge.protocol.ReadWriteDataRequest
import com.fitbaus.bikebridge.protocol.ReadWriteDataResult
import com.fitbaus.bikebridge.protocol.ResistanceCodec

internal data class BasicProbeOutcome(
    val stopKind: StopKind,
    val summary: String,
    val identityQualified: Boolean,
    val telemetryQualified: Boolean,
    val softwareVersion: Int?,
    val requiresUnlock: Boolean?,
    val primaryDeviceId: Int?,
    val events: List<ProbeEvent>,
    val requestsUsed: Int,
)

internal class BasicProbeSequence(
    private val transport: ProbeTransport,
    private val bootstrapDevice: EquipmentDevice = EquipmentDevice.MAIN,
    private val budget: DiagnosticBudget = DiagnosticBudget(ProbeConstants.BASIC_REQUEST_BUDGET),
    private val sleeper: (Long) -> Unit = { Thread.sleep(it) },
    private val isCancelled: () -> Boolean = { false },
) {
    private val events = ArrayList<ProbeEvent>()
    private var consecutiveTransportFailures = 0
    private var consecutiveMalformed = 0
    private var lastExchangeAt = 0L
    /** Session-only PrimaryDevice after bootstrap; null until adopted. */
    private var sessionPrimary: EquipmentDevice? = null
    /** Captured from MaxResistanceLevel read; required by ResistanceCodec. */
    private var sessionMaxResistanceLevel: Int? = null

    fun run(): BasicProbeOutcome {
        events += ProbeEvent.Info(
            "basic diagnostic start bootstrapDevice=${bootstrapDevice.id} budget=${ProbeConstants.BASIC_REQUEST_BUDGET}",
        )
        transport.transmitAllowlist()?.resetToMainOnly()

        val softwareVersion: Int?
        val requiresUnlock: Boolean?
        when (val identity = runIdentity()) {
            is IdentityPhaseResult.Stopped -> {
                return finish(
                    identity.stopKind,
                    identity.summary,
                    false,
                    false,
                    identity.softwareVersion,
                    identity.requiresUnlock,
                )
            }
            is IdentityPhaseResult.Ok -> {
                softwareVersion = identity.softwareVersion
                requiresUnlock = identity.requiresUnlock
            }
        }

        when (val telemetry = runTelemetryReads()) {
            is TelemetryPhaseResult.Stopped -> {
                return finish(
                    telemetry.stopKind,
                    telemetry.summary,
                    identityQualified = true,
                    telemetryQualified = false,
                    softwareVersion = softwareVersion,
                    requiresUnlock = requiresUnlock,
                )
            }
            is TelemetryPhaseResult.Ok -> {
                return finish(
                    StopKind.NONE,
                    "basic diagnostic completed; telemetryQualified=${telemetry.qualified} " +
                        "primaryDevice=${sessionPrimary?.id}",
                    identityQualified = true,
                    telemetryQualified = telemetry.qualified,
                    softwareVersion = softwareVersion,
                    requiresUnlock = requiresUnlock,
                )
            }
        }
    }

    private fun runIdentity(): IdentityPhaseResult {
        val bootstrapRequest = EquipmentRequests.deviceInfo(bootstrapDevice)
        val bootstrapRaw = exchangeOrStop(bootstrapRequest, sensitive = true)
            ?: return IdentityPhaseResult.Stopped(currentStop(), currentStopMessage(), null, null)

        when (val bootstrap = PrimaryDeviceBootstrap.evaluate(bootstrapDevice, bootstrapRaw)) {
            is PrimaryDeviceBootstrapResult.Rejected -> {
                recordBootstrapRejection(bootstrapRequest, bootstrapRaw, bootstrap)
                if (bootstrap.detail.contains("SECURITY_BLOCK", ignoreCase = true) ||
                    bootstrap.reason == "IDENTITY_REJECTED" && bootstrap.detail.startsWith("SECURITY_BLOCKED")
                ) {
                    return IdentityPhaseResult.Stopped(StopKind.SECURITY_BLOCK, "DeviceInfo SecurityBlock", null, null)
                }
                val label = if (bootstrap.ordinaryDeviceMismatch) {
                    "DeviceInfo ordinary device mismatch (not PrimaryDevice bootstrap): ${bootstrap.detail}"
                } else {
                    "DeviceInfo bootstrap rejected: ${bootstrap.reason}: ${bootstrap.detail}"
                }
                return IdentityPhaseResult.Stopped(StopKind.MALFORMED, label, null, null)
            }
            is PrimaryDeviceBootstrapResult.Adopted -> {
                recordBootstrapObservation(bootstrapRequest, bootstrapRaw, bootstrap)
                // Provisional only: DeviceInfo(candidate) until confirmation succeeds.
                // Do not set sessionPrimary or emit confirmed adoption yet.
                beginAwaitingConfirmation(bootstrap.primaryDevice)
                val confirmRequest = EquipmentRequests.deviceInfo(bootstrap.primaryDevice)
                val confirmRaw = exchangeOrStop(confirmRequest, sensitive = true)
                if (confirmRaw == null) {
                    clearProvisionalAuthorization()
                    return IdentityPhaseResult.Stopped(
                        currentStop(),
                        currentStopMessage(),
                        bootstrap.deviceInfo.softwareVersion,
                        bootstrap.deviceInfo.requiresUnlock,
                    )
                }
                when (val confirmed = PrimaryDeviceBootstrap.confirm(bootstrap.primaryDevice, bootstrap.deviceInfo, confirmRaw)) {
                    is PrimaryDeviceBootstrapResult.Rejected -> {
                        clearProvisionalAuthorization()
                        val structure = FrameDiagnostics.summarize(
                            confirmRaw,
                            confirmRequest.device,
                            confirmRequest.command,
                        )
                        events += observedFromStructure(
                            command = confirmRequest.command,
                            structure = structure,
                            parseSummary = "ConfirmRejected(${confirmed.reason}: ${confirmed.detail})",
                            status = (structure.parseResult as? FrameParseResult.Accepted)?.frame?.status,
                            statusCode = (structure.parseResult as? FrameParseResult.Accepted)?.frame?.statusCode,
                        )
                        return IdentityPhaseResult.Stopped(
                            StopKind.MALFORMED,
                            "PrimaryDevice confirmation failed: ${confirmed.reason}: ${confirmed.detail}",
                            bootstrap.deviceInfo.softwareVersion,
                            bootstrap.deviceInfo.requiresUnlock,
                        )
                    }
                    is PrimaryDeviceBootstrapResult.Adopted -> {
                        confirmSessionPrimary(bootstrap.primaryDevice)
                        val structure = FrameDiagnostics.summarize(
                            confirmRaw,
                            confirmRequest.device,
                            confirmRequest.command,
                        )
                        events += observedFromStructure(
                            command = confirmRequest.command,
                            structure = structure,
                            parseSummary = "ConfirmParsed",
                            status = EquipmentStatus.DONE,
                            statusCode = EquipmentStatus.DONE.code,
                            softwareVersion = confirmed.deviceInfo.softwareVersion,
                            identityComponentsPresent = true,
                        )
                        events += ProbeEvent.PrimaryDeviceAdopted(
                            requestedDeviceId = bootstrap.requestedDevice.id,
                            primaryDeviceId = bootstrap.primaryDevice.id,
                            primaryDeviceName = EquipmentDeviceIds.nameOrNull(bootstrap.primaryDevice.id),
                            adoptedFromResponseDeviceMismatch = bootstrap.adoptedFromResponseDeviceMismatch,
                            confirmed = true,
                            softwareVersion = confirmed.deviceInfo.softwareVersion,
                        )
                        return continueIdentityAfterPrimary(confirmed.deviceInfo)
                    }
                }
            }
        }
    }

    private fun continueIdentityAfterPrimary(deviceInfo: DeviceInfo): IdentityPhaseResult {
        val primary = sessionPrimary
            ?: return IdentityPhaseResult.Stopped(StopKind.MALFORMED, "PrimaryDevice missing after adoption", null, null)

        val systemInfoRequest = EquipmentRequests.systemInfo(primary)
        val systemRaw = exchangeOrStop(systemInfoRequest, sensitive = true)
            ?: return IdentityPhaseResult.Stopped(
                currentStop(),
                currentStopMessage(),
                deviceInfo.softwareVersion,
                deviceInfo.requiresUnlock,
            )
        if (!responseMatchesPrimary(systemRaw, systemInfoRequest)) {
            return IdentityPhaseResult.Stopped(
                StopKind.MALFORMED,
                "SystemInfo response device mismatch after PrimaryDevice adoption",
                deviceInfo.softwareVersion,
                deviceInfo.requiresUnlock,
            )
        }
        when (val systemParsed = systemInfoRequest.parse(systemRaw)) {
            is IdentityResult.Rejected -> {
                recordIdentityResponse(systemInfoRequest, systemRaw, systemParsed)
                if (systemParsed.reason == IdentityRejection.SECURITY_BLOCKED) {
                    return IdentityPhaseResult.Stopped(
                        StopKind.SECURITY_BLOCK,
                        "SystemInfo SecurityBlock",
                        deviceInfo.softwareVersion,
                        deviceInfo.requiresUnlock,
                    )
                }
                return IdentityPhaseResult.Stopped(
                    StopKind.MALFORMED,
                    "SystemInfo identity not qualified: ${systemParsed.reason}: ${systemParsed.detail}",
                    deviceInfo.softwareVersion,
                    deviceInfo.requiresUnlock,
                )
            }
            is IdentityResult.Parsed -> {
                recordIdentityResponse(systemInfoRequest, systemRaw, systemParsed, componentsPresent = true)
            }
        }

        val versionInfoRequest = EquipmentRequests.versionInfo(primary)
        val versionRaw = exchangeOrStop(versionInfoRequest, sensitive = true)
            ?: return IdentityPhaseResult.Stopped(
                currentStop(),
                currentStopMessage(),
                deviceInfo.softwareVersion,
                deviceInfo.requiresUnlock,
            )
        if (!responseMatchesPrimary(versionRaw, versionInfoRequest)) {
            return IdentityPhaseResult.Stopped(
                StopKind.MALFORMED,
                "VersionInfo response device mismatch after PrimaryDevice adoption",
                deviceInfo.softwareVersion,
                deviceInfo.requiresUnlock,
            )
        }
        when (val versionParsed = versionInfoRequest.parse(versionRaw)) {
            is IdentityResult.Rejected -> {
                recordIdentityResponse(versionInfoRequest, versionRaw, versionParsed)
                if (versionParsed.reason == IdentityRejection.SECURITY_BLOCKED) {
                    return IdentityPhaseResult.Stopped(
                        StopKind.SECURITY_BLOCK,
                        "VersionInfo SecurityBlock",
                        deviceInfo.softwareVersion,
                        deviceInfo.requiresUnlock,
                    )
                }
                return IdentityPhaseResult.Stopped(
                    StopKind.MALFORMED,
                    "VersionInfo identity not qualified: ${versionParsed.reason}: ${versionParsed.detail}",
                    deviceInfo.softwareVersion,
                    deviceInfo.requiresUnlock,
                )
            }
            is IdentityResult.Parsed -> {
                recordIdentityResponse(versionInfoRequest, versionRaw, versionParsed, componentsPresent = true)
            }
        }

        events += ProbeEvent.Info(
            IdentityRedaction.summarizeIdentityPresence(
                softwareVersion = deviceInfo.softwareVersion,
                serialPresent = true,
                modelPresent = true,
                partPresent = true,
                masterLibraryPresent = true,
            ),
        )
        return IdentityPhaseResult.Ok(deviceInfo.softwareVersion, deviceInfo.requiresUnlock)
    }

    private fun beginAwaitingConfirmation(candidate: EquipmentDevice) {
        transport.transmitAllowlist()?.beginAwaitingConfirmation(candidate.id)
    }

    private fun confirmSessionPrimary(primary: EquipmentDevice) {
        transport.transmitAllowlist()?.confirmSessionPrimary(primary.id)
        sessionPrimary = primary
    }

    private fun clearProvisionalAuthorization() {
        sessionPrimary = null
        transport.transmitAllowlist()?.resetToMainOnly()
    }

    private fun responseMatchesPrimary(
        raw: ByteArray,
        request: com.fitbaus.bikebridge.protocol.EquipmentRequest,
    ): Boolean {
        val primary = sessionPrimary ?: return false
        val structure = FrameDiagnostics.summarize(raw, primary, request.command)
        if (structure.parseResult is FrameParseResult.Accepted) return true
        events += observedFromStructure(
            command = request.command,
            structure = structure,
            parseSummary = "PrimaryDeviceMismatch(${structure.frameRejection}: ${structure.frameRejectionDetail})",
            status = null,
            statusCode = null,
        )
        return false
    }

    private fun recordBootstrapRejection(
        request: com.fitbaus.bikebridge.protocol.EquipmentRequest,
        raw: ByteArray,
        rejected: PrimaryDeviceBootstrapResult.Rejected,
    ) {
        val structure = FrameDiagnostics.summarize(raw, request.device, request.command)
        val summary = if (rejected.ordinaryDeviceMismatch) {
            "OrdinaryDeviceMismatch(${rejected.reason}: ${rejected.detail})"
        } else {
            "BootstrapRejected(${rejected.reason}: ${rejected.detail})"
        }
        events += observedFromStructure(
            command = request.command,
            structure = structure,
            parseSummary = summary,
            status = (structure.parseResult as? FrameParseResult.Accepted)?.frame?.status,
            statusCode = (structure.parseResult as? FrameParseResult.Accepted)?.frame?.statusCode,
        )
    }

    private fun recordBootstrapObservation(
        request: com.fitbaus.bikebridge.protocol.EquipmentRequest,
        raw: ByteArray,
        adopted: PrimaryDeviceBootstrapResult.Adopted,
    ) {
        val structure = FrameDiagnostics.summarize(raw, adopted.primaryDevice, request.command)
        val summary = if (adopted.adoptedFromResponseDeviceMismatch) {
            "BootstrapAdopted(MAIN->${EquipmentDeviceIds.describe(adopted.primaryDevice.id)})"
        } else {
            "BootstrapAdopted(MAIN)"
        }
        events += observedFromStructure(
            command = request.command,
            structure = structure,
            parseSummary = summary,
            status = EquipmentStatus.DONE,
            statusCode = EquipmentStatus.DONE.code,
            softwareVersion = adopted.deviceInfo.softwareVersion,
            identityComponentsPresent = true,
        )
    }

    private fun runTelemetryReads(): TelemetryPhaseResult {
        val primary = sessionPrimary
            ?: return TelemetryPhaseResult.Stopped(StopKind.MALFORMED, "PrimaryDevice missing before telemetry")
        val wattsRpm = EquipmentRequests.read(primary, listOf(BikeField.WATTS, BikeField.RPM))
        val raw = exchangeOrStop(wattsRpm, sensitive = false)
            ?: return TelemetryPhaseResult.Stopped(currentStop(), currentStopMessage())

        if (!responseMatchesPrimary(raw, wattsRpm)) {
            return TelemetryPhaseResult.Stopped(
                StopKind.MALFORMED,
                "Watts/Rpm response device mismatch after PrimaryDevice adoption",
            )
        }
        when (val decoded = wattsRpm.decode(raw)) {
            ReadWriteDataResult.SecurityBlocked -> {
                recordTelemetryResponse(wattsRpm, raw, "SecurityBlocked", EquipmentStatus.SECURITY_BLOCK)
                return TelemetryPhaseResult.Stopped(StopKind.SECURITY_BLOCK, "ReadWriteData SecurityBlock")
            }
            is ReadWriteDataResult.StatusRejected -> {
                recordTelemetryResponse(wattsRpm, raw, decoded.toString(), decoded.status)
                if (decoded.status == EquipmentStatus.DEVICE_NOT_SUPPORTED) {
                    events += ProbeEvent.Info(
                        "DeviceNotSupported on PrimaryDevice=${primary.id} for Watts/Rpm; no device-id scan performed",
                    )
                    return TelemetryPhaseResult.Stopped(
                        StopKind.DEVICE_NOT_SUPPORTED,
                        "ReadWriteData DeviceNotSupported on PrimaryDevice ${primary.id}; subsequent field reads skipped",
                    )
                }
                return TelemetryPhaseResult.Stopped(
                    StopKind.MALFORMED,
                    "Watts/Rpm status rejected: ${decoded.status}",
                )
            }
            is ReadWriteDataResult.Malformed -> {
                recordTelemetryResponse(wattsRpm, raw, decoded.toString(), null)
                return TelemetryPhaseResult.Stopped(StopKind.MALFORMED, "Watts/Rpm malformed: ${decoded.rejection}")
            }
            ReadWriteDataResult.FieldDataMissing -> {
                recordTelemetryResponse(wattsRpm, raw, "FieldDataMissing", EquipmentStatus.DONE)
                return TelemetryPhaseResult.Ok(qualified = false)
            }
            is ReadWriteDataResult.LengthMismatch -> {
                recordTelemetryResponse(wattsRpm, raw, decoded.toString(), EquipmentStatus.DONE)
                return TelemetryPhaseResult.Stopped(StopKind.MALFORMED, decoded.toString())
            }
            is ReadWriteDataResult.Values -> {
                recordTelemetryResponse(wattsRpm, raw, "Values", EquipmentStatus.DONE)
                emitFieldReadings(decoded)
            }
        }

        val optionalFields = listOf(
            listOf(BikeField.MAX_RESISTANCE_LEVEL),
            listOf(BikeField.WORKOUT_MODE),
            listOf(BikeField.IDLE_MODE_LOCKOUT),
            listOf(BikeField.RESISTANCE),
            listOf(BikeField.ACTUAL_RESISTANCE),
        )
        for (fields in optionalFields) {
            if (isCancelled()) {
                return TelemetryPhaseResult.Stopped(StopKind.CANCELLED, "cancelled before optional field read")
            }
            if (!transport.isAttached()) {
                return TelemetryPhaseResult.Stopped(StopKind.DETACH, "device detached")
            }
            if (budget.exhausted) {
                return TelemetryPhaseResult.Stopped(StopKind.BUDGET_EXHAUSTED, "basic budget exhausted")
            }
            val request = EquipmentRequests.read(primary, fields)
            val response = exchangeOrStop(request, sensitive = false)
                ?: return TelemetryPhaseResult.Stopped(currentStop(), currentStopMessage())
            if (!responseMatchesPrimary(response, request)) {
                consecutiveMalformed += 1
                if (consecutiveMalformed >= ProbeConstants.CONSECUTIVE_TRANSPORT_FAILURE_LIMIT) {
                    return TelemetryPhaseResult.Stopped(StopKind.MALFORMED, "repeated PrimaryDevice mismatches")
                }
                continue
            }
            when (val decoded = request.decode(response)) {
                ReadWriteDataResult.SecurityBlocked -> {
                    recordTelemetryResponse(request, response, "SecurityBlocked", EquipmentStatus.SECURITY_BLOCK)
                    return TelemetryPhaseResult.Stopped(StopKind.SECURITY_BLOCK, "optional field SecurityBlock")
                }
                is ReadWriteDataResult.StatusRejected -> {
                    recordTelemetryResponse(request, response, decoded.toString(), decoded.status)
                    if (decoded.status == EquipmentStatus.DEVICE_NOT_SUPPORTED) {
                        events += ProbeEvent.Info("optional ${fields.single()} DeviceNotSupported; recorded, no scan")
                        continue
                    }
                    events += ProbeEvent.Info("optional ${fields.single()} rejected (${decoded.status}); continuing non-dependent reads")
                }
                is ReadWriteDataResult.Malformed -> {
                    recordTelemetryResponse(request, response, decoded.toString(), null)
                    consecutiveMalformed += 1
                    if (consecutiveMalformed >= ProbeConstants.CONSECUTIVE_TRANSPORT_FAILURE_LIMIT) {
                        return TelemetryPhaseResult.Stopped(StopKind.MALFORMED, "repeated malformed optional responses")
                    }
                }
                ReadWriteDataResult.FieldDataMissing -> {
                    consecutiveMalformed = 0
                    recordTelemetryResponse(request, response, "FieldDataMissing", EquipmentStatus.DONE)
                }
                is ReadWriteDataResult.LengthMismatch -> {
                    consecutiveMalformed = 0
                    recordTelemetryResponse(request, response, decoded.toString(), EquipmentStatus.DONE)
                    if (fields.single().encoding.width == null) {
                        events += ProbeEvent.Info(
                            "unresolved resistance-related field ${fields.single()} length=${decoded.actualDataLength}; left undecoded",
                        )
                    }
                }
                is ReadWriteDataResult.Values -> {
                    consecutiveMalformed = 0
                    recordTelemetryResponse(request, response, "Values", EquipmentStatus.DONE)
                    emitFieldReadings(decoded)
                }
            }
        }
        return TelemetryPhaseResult.Ok(qualified = true)
    }

    private fun exchangeOrStop(
        request: com.fitbaus.bikebridge.protocol.EquipmentRequest,
        sensitive: Boolean,
    ): ByteArray? {
        if (isCancelled()) {
            events += ProbeEvent.Stopped("cancelled")
            return null
        }
        if (!transport.isAttached()) {
            events += ProbeEvent.Stopped("device detached")
            return null
        }
        if (budget.exhausted) {
            events += ProbeEvent.Stopped("budget exhausted")
            return null
        }

        val wait = ProbeConstants.MIN_REQUEST_SPACING_MS - (System.currentTimeMillis() - lastExchangeAt)
        if (lastExchangeAt != 0L && wait > 0) {
            sleeper(wait)
        }

        val gated = GatedEquipmentExchange(transport, budget) { classification ->
            events += ProbeEvent.TransmitRejected(classification.reportToken)
        }
        val started = System.currentTimeMillis()
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
            events += ProbeEvent.Stopped("budget exhausted")
            return null
        }
        lastExchangeAt = System.currentTimeMillis()
        val duration = lastExchangeAt - started
        when (exchangeResult) {
            is ProbeExchangeResult.Failed -> {
                consecutiveTransportFailures += 1
                events += ProbeEvent.ResponseObserved(
                    command = request.command,
                    status = null,
                    statusCode = null,
                    frameLength = 0,
                    checksumValid = false,
                    parseSummary = exchangeResult.classification.reportToken,
                    durationMs = duration,
                )
                if (consecutiveTransportFailures >= ProbeConstants.CONSECUTIVE_TRANSPORT_FAILURE_LIMIT) {
                    events += ProbeEvent.Stopped("repeated transport failures")
                }
                return null
            }
            is ProbeExchangeResult.Response -> {
                val response = exchangeResult.bytes
                if (response == null) {
                    consecutiveTransportFailures += 1
                    events += ProbeEvent.ResponseObserved(
                        command = request.command,
                        status = null,
                        statusCode = null,
                        frameLength = 0,
                        checksumValid = false,
                        parseSummary = com.fitbaus.bikebridge.equipmentprobe.usb.TransportFailureClass.IN_TIMEOUT_OR_FAILURE.reportToken,
                        durationMs = duration,
                    )
                    if (consecutiveTransportFailures >= ProbeConstants.CONSECUTIVE_TRANSPORT_FAILURE_LIMIT) {
                        events += ProbeEvent.Stopped("repeated transport failures")
                    }
                    return null
                }
                consecutiveTransportFailures = 0
                return response
            }
        }
    }

    private fun recordIdentityResponse(
        request: com.fitbaus.bikebridge.protocol.EquipmentRequest,
        raw: ByteArray,
        parsed: IdentityResult<*>,
        softwareVersion: Int? = null,
        componentsPresent: Boolean? = null,
    ) {
        val structure = FrameDiagnostics.summarize(raw, request.device, request.command)
        val summary = when (parsed) {
            is IdentityResult.Parsed -> "Parsed"
            is IdentityResult.Rejected -> "Rejected(${parsed.reason}: ${parsed.detail})"
        }
        events += observedFromStructure(
            command = request.command,
            structure = structure,
            parseSummary = summary,
            status = (structure.parseResult as? FrameParseResult.Accepted)?.frame?.status,
            statusCode = (structure.parseResult as? FrameParseResult.Accepted)?.frame?.statusCode,
            softwareVersion = softwareVersion,
            identityComponentsPresent = componentsPresent,
            telemetryHex = null,
        )
    }

    private fun recordTelemetryResponse(
        request: ReadWriteDataRequest,
        raw: ByteArray,
        parseSummary: String,
        status: EquipmentStatus?,
    ) {
        val structure = FrameDiagnostics.summarize(raw, request.device, request.command)
        val accepted = structure.parseResult as? FrameParseResult.Accepted
        val allowHex = request.reads.all { it.id in ApprovedReadFields.TELEMETRY_NON_SENSITIVE }
        events += observedFromStructure(
            command = request.command,
            structure = structure,
            parseSummary = parseSummary,
            status = status ?: accepted?.frame?.status,
            statusCode = accepted?.frame?.statusCode,
            telemetryHex = if (allowHex && accepted != null) Hex.format(accepted.frame.data()) else null,
        )
    }

    private fun observedFromStructure(
        command: com.fitbaus.bikebridge.protocol.EquipmentCommand,
        structure: FrameStructureSummary,
        parseSummary: String,
        status: EquipmentStatus?,
        statusCode: Int?,
        softwareVersion: Int? = null,
        identityComponentsPresent: Boolean? = null,
        telemetryHex: String? = null,
        durationMs: Long = 0,
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
        softwareVersion = softwareVersion,
        identityComponentsPresent = identityComponentsPresent,
        telemetryHex = telemetryHex,
        durationMs = durationMs,
    )

    private fun emitFieldReadings(values: ReadWriteDataResult.Values) {
        for ((field, value) in values.readings) {
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
                    when {
                        max != null && value.width == ResistanceCodec.WIRE_WIDTH -> {
                            val level = ResistanceCodec.decodeLevel(value.bytes(), max)
                            "ResistanceCodec level=$level (maxResistanceLevel=$max raw=${Hex.format(value.bytes())})"
                        }
                        max == null ->
                            "resistance raw only; maxResistanceLevel unavailable for codec"
                        else ->
                            "resistance raw width=${value.width}; expected ${ResistanceCodec.WIRE_WIDTH} for codec"
                    }
                }
                else -> value.toString()
            }
            events += ProbeEvent.FieldReading(field, summary, rawHex)
        }
    }

    private fun currentStop(): StopKind = when {
        isCancelled() -> StopKind.CANCELLED
        !transport.isAttached() -> StopKind.DETACH
        budget.exhausted -> StopKind.BUDGET_EXHAUSTED
        consecutiveTransportFailures >= ProbeConstants.CONSECUTIVE_TRANSPORT_FAILURE_LIMIT -> StopKind.TRANSPORT_FAILURE
        else -> StopKind.TRANSPORT_FAILURE
    }

    private fun currentStopMessage(): String = when (currentStop()) {
        StopKind.CANCELLED -> "cancelled"
        StopKind.DETACH -> "device detached"
        StopKind.BUDGET_EXHAUSTED -> "budget exhausted"
        else -> "transport failure"
    }

    private fun finish(
        stopKind: StopKind,
        summary: String,
        identityQualified: Boolean,
        telemetryQualified: Boolean,
        softwareVersion: Int?,
        requiresUnlock: Boolean?,
    ): BasicProbeOutcome {
        if (stopKind != StopKind.NONE) {
            events += ProbeEvent.Stopped(summary)
        } else {
            events += ProbeEvent.Completed(summary, budget.usedCount())
        }
        return BasicProbeOutcome(
            stopKind = stopKind,
            summary = summary,
            identityQualified = identityQualified,
            telemetryQualified = telemetryQualified,
            softwareVersion = softwareVersion,
            requiresUnlock = requiresUnlock,
            primaryDeviceId = sessionPrimary?.id,
            events = events.toList(),
            requestsUsed = budget.usedCount(),
        )
    }

    private sealed class IdentityPhaseResult {
        data class Ok(val softwareVersion: Int, val requiresUnlock: Boolean) : IdentityPhaseResult()
        data class Stopped(
            val stopKind: StopKind,
            val summary: String,
            val softwareVersion: Int?,
            val requiresUnlock: Boolean?,
        ) : IdentityPhaseResult()
    }

    private sealed class TelemetryPhaseResult {
        data class Ok(val qualified: Boolean) : TelemetryPhaseResult()
        data class Stopped(val stopKind: StopKind, val summary: String) : TelemetryPhaseResult()
    }
}
