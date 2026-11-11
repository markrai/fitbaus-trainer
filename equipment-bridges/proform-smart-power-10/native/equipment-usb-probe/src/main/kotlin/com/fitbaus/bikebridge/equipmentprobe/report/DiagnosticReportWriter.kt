// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe.report

import com.fitbaus.bikebridge.equipmentprobe.session.ProbeEvent
import com.fitbaus.bikebridge.equipmentprobe.session.ProbePhase
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal class DiagnosticReportWriter(
    private val directory: File,
    private val maxChars: Int = 200_000,
) {
    fun write(phase: ProbePhase, events: List<ProbeEvent>, outcome: String): File {
        directory.mkdirs()
        val stamp = utcStamp()
        val file = File(directory, "equipment-probe-${phase.name.lowercase()}-$stamp.txt")
        val body = buildString {
            appendLine("Fitbaus Equipment USB Probe diagnostic report")
            appendLine("phase=$phase")
            appendLine("generatedUtc=$stamp")
            appendLine("outcome=$outcome")
            appendLine("---")
            for (event in events) {
                appendLine(formatEvent(event))
                if (length > maxChars) {
                    appendLine("... truncated at $maxChars characters")
                    break
                }
            }
        }
        file.writeText(body)
        return file
    }

    private fun formatEvent(event: ProbeEvent): String = when (event) {
        is ProbeEvent.Info -> "INFO ${event.message}"
        is ProbeEvent.UsbQualified -> "USB_QUALIFIED device=${event.deviceName}"
        is ProbeEvent.UsbRejected -> "USB_REJECTED ${event.reason}"
        is ProbeEvent.Permission -> "PERMISSION granted=${event.granted}"
        is ProbeEvent.ClaimResult -> "CLAIM success=${event.success} ${event.detail}"
        is ProbeEvent.PrimaryDeviceAdopted ->
            "PRIMARY_DEVICE_ADOPTED requested=${event.requestedDeviceId} " +
                "primary=${event.primaryDeviceId} name=${event.primaryDeviceName} " +
                "fromResponseDeviceMismatch=${event.adoptedFromResponseDeviceMismatch} " +
                "confirmed=${event.confirmed} softwareVersion=${event.softwareVersion}"
        is ProbeEvent.RequestSent ->
            "TX command=${event.command} device=${event.deviceId} bytes=${event.requestBytes} " +
                "durationMs=${event.durationMs} sensitive=${event.sensitive}"
        is ProbeEvent.ResponseObserved -> buildString {
            append("RX command=${event.command}")
            append(" status=${event.status}")
            append(" statusCode=${event.statusCode}")
            append(" transferLength=${event.frameLength}")
            append(" declaredLength=${event.declaredLength}")
            append(" checksumEvaluated=${event.checksumEvaluated}")
            append(" checksumValid=${event.checksumValid}")
            append(" frameRejection=${event.frameRejection}")
            event.frameRejectionDetail?.let { append(" frameRejectionDetail=$it") }
            append(" headerDeviceId=${event.headerDeviceId}")
            append(" headerDeviceName=${event.headerDeviceName}")
            append(" headerCommandId=${event.headerCommandId}")
            append(" headerStatusCode=${event.headerStatusCode}")
            append(" trailingPaddingBytes=${event.trailingPaddingBytes}")
            append(" trailingPaddingAllZero=${event.trailingPaddingAllZero}")
            append(" parse=${event.parseSummary}")
            event.softwareVersion?.let { append(" softwareVersion=$it") }
            event.identityComponentsPresent?.let { append(" identityComponentsPresent=$it") }
            event.telemetryHex?.let { append(" telemetryHex=$it") }
            append(" durationMs=${event.durationMs}")
        }
        is ProbeEvent.FieldReading ->
            "FIELD ${event.field} ${event.summary}" +
                (event.rawHex?.let { " raw=$it" } ?: "") +
                (event.elapsedMs?.let { " elapsedMs=$it" } ?: "") +
                (event.stage?.let { " stage=$it" } ?: "") +
                (if (event.inStabilize) " inStabilize=true" else "")
        is ProbeEvent.StageBoundary ->
            "STAGE_${event.kind.name} stage=${event.stage} elapsedMs=${event.elapsedMs}"
        is ProbeEvent.Stopped -> "STOPPED ${event.reason}"
        is ProbeEvent.Completed -> "COMPLETED ${event.outcome} requestsUsed=${event.requestsUsed}"
        is ProbeEvent.TransmitRejected -> "TX_REJECTED ${event.reason}"
    }

    private fun utcStamp(): String {
        val format = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        return format.format(Date())
    }
}
