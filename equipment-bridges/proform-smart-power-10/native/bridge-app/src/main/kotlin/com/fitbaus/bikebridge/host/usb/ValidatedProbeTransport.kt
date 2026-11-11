// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.usb

import android.util.Log
import com.fitbaus.bikebridge.host.HostConstants
import com.fitbaus.bikebridge.host.policy.ReadOnlyTransmitGate
import com.fitbaus.bikebridge.host.policy.TransmitAllowlist
import com.fitbaus.bikebridge.host.policy.TransmitDecision
import com.fitbaus.bikebridge.protocol.EquipmentCommand

internal class ValidatedProbeTransport(
    private val inner: ProbeTransport,
    private val allowlist: TransmitAllowlist = inner.transmitAllowlist() ?: TransmitAllowlist(),
) : ProbeTransport {
    var outAttempts: Int = 0
        private set
    var rejectedBeforeOut: Int = 0
        private set

    override fun transmitAllowlist(): TransmitAllowlist = allowlist

    override fun exchange(request: ByteArray): TransportResult {
        val commandId = commandId(request)
        when (val decision = ReadOnlyTransmitGate.validateOutgoing(request, allowlist.state())) {
            is TransmitDecision.Reject -> {
                rejectedBeforeOut += 1
                Log.i(HostConstants.LOG_TAG, "usb tx rejected cmd=$commandId")
                return TransportResult.Failed(TransportFailureClass.POLICY_REJECTED)
            }
            TransmitDecision.Allow -> Unit
        }
        outAttempts += 1
        // Before inner.exchange: a permitted attempt, not a confirmed USB OUT.
        // Command id only — never log packet bytes or authentication inputs.
        if (!isRoutineRead(request)) {
            Log.i(HostConstants.LOG_TAG, "usb tx attempt cmd=$commandId")
        }
        return inner.exchange(request)
    }

    override fun isAttached(): Boolean = inner.isAttached()

    override fun close() {
        allowlist.resetToMainOnly()
        inner.close()
    }

    private companion object {
        fun commandId(request: ByteArray): Int =
            if (request.size > 2) request[2].toInt() and 0xFF else -1

        fun isRoutineRead(request: ByteArray): Boolean =
            request.size > 3 &&
                commandId(request) == EquipmentCommand.READ_WRITE_DATA.id &&
                (request[3].toInt() and 0xFF) == 0
    }
}
