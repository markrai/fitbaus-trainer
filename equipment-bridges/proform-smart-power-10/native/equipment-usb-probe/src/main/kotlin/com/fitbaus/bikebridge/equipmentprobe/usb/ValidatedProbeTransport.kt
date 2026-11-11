// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe.usb

import com.fitbaus.bikebridge.equipmentprobe.policy.ReadOnlyTransmitGate
import com.fitbaus.bikebridge.equipmentprobe.policy.TransmitAllowlist
import com.fitbaus.bikebridge.equipmentprobe.policy.TransmitDecision

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
        when (val decision = ReadOnlyTransmitGate.validateOutgoing(request, allowlist.state())) {
            is TransmitDecision.Reject -> {
                rejectedBeforeOut += 1
                return TransportResult.Failed(TransportFailureClass.POLICY_REJECTED)
            }
            TransmitDecision.Allow -> Unit
        }
        outAttempts += 1
        return inner.exchange(request)
    }

    override fun isAttached(): Boolean = inner.isAttached()

    override fun close() {
        allowlist.resetToMainOnly()
        inner.close()
    }
}
