// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe.session

import com.fitbaus.bikebridge.equipmentprobe.policy.DiagnosticBudget
import com.fitbaus.bikebridge.equipmentprobe.policy.ReadOnlyTransmitGate
import com.fitbaus.bikebridge.equipmentprobe.policy.SessionTransmitAuthorization
import com.fitbaus.bikebridge.equipmentprobe.policy.TransmitDecision
import com.fitbaus.bikebridge.equipmentprobe.usb.ProbeTransport
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportFailureClass
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportResult
import com.fitbaus.bikebridge.protocol.EquipmentRequest

internal class BudgetExhaustedException : RuntimeException("diagnostic request budget exhausted")

internal sealed class ProbeExchangeResult {
    data class Response(val bytes: ByteArray?) : ProbeExchangeResult()
    data class Failed(val classification: TransportFailureClass) : ProbeExchangeResult()
}

internal class GatedEquipmentExchange(
    private val transport: ProbeTransport,
    private val budget: DiagnosticBudget,
    private val authorization: () -> SessionTransmitAuthorization = {
        transport.transmitAllowlist()?.state() ?: SessionTransmitAuthorization.MainOnly
    },
    private val onRejected: (TransportFailureClass) -> Unit = {},
) {
    fun exchange(request: EquipmentRequest): ProbeExchangeResult {
        if (!budget.tryConsume()) {
            throw BudgetExhaustedException()
        }
        val encoded = request.encode()
        when (val decision = ReadOnlyTransmitGate.validateOutgoing(encoded, authorization())) {
            is TransmitDecision.Reject -> {
                onRejected(TransportFailureClass.POLICY_REJECTED)
                return ProbeExchangeResult.Failed(TransportFailureClass.POLICY_REJECTED)
            }
            TransmitDecision.Allow -> Unit
        }
        return when (val result = transport.exchange(encoded)) {
            is TransportResult.Ok -> ProbeExchangeResult.Response(result.response)
            is TransportResult.Failed -> ProbeExchangeResult.Failed(result.classification)
        }
    }
}
