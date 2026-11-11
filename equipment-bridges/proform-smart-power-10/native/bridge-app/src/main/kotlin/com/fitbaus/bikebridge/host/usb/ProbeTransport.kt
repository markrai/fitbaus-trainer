// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.usb

internal enum class TransportFailureClass(val reportToken: String) {
    OUT_TRANSFER_FAILED("out_transfer_failed"),
    PARTIAL_OUT_WRITE("partial_out_write"),
    IN_TIMEOUT_OR_FAILURE("in_timeout_or_failure"),
    DETACHED_BEFORE_OUT("detached_before_out"),
    POLICY_REJECTED("policy_rejected"),
}

internal sealed class TransportResult {
    data class Ok(val response: ByteArray?) : TransportResult()
    data class Failed(val classification: TransportFailureClass) : TransportResult()
}

internal interface ProbeTransport {
    fun exchange(request: ByteArray): TransportResult
    fun isAttached(): Boolean
    fun close()

    /** Session TX allowlist; default MAIN-only for transports that do not participate. */
    fun transmitAllowlist(): com.fitbaus.bikebridge.host.policy.TransmitAllowlist? = null
}

internal interface UsbHostGateway {
    fun listDevices(): List<UsbDeviceSnapshot>
    fun hasPermission(deviceName: String): Boolean
    fun openQualified(qualified: UsbQualificationResult.Qualified): OpenResult
}

internal sealed class OpenResult {
    data class Opened(val transport: ProbeTransport) : OpenResult()
    data class Failed(val reason: String, val retryable: Boolean = true) : OpenResult()
}
