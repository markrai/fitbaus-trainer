// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.policy

import com.fitbaus.bikebridge.protocol.EquipmentCommand
import com.fitbaus.bikebridge.protocol.EquipmentDeviceIds
import com.fitbaus.bikebridge.protocol.EquipmentFrameCodec
import com.fitbaus.bikebridge.protocol.EquipmentSecurity

internal sealed class TransmitDecision {
    object Allow : TransmitDecision()
    data class Reject(val reason: String) : TransmitDecision()
}

internal object ReadOnlyTransmitGate {
    fun validateOutgoing(
        packet: ByteArray,
        authorization: SessionTransmitAuthorization = SessionTransmitAuthorization.MainOnly,
    ): TransmitDecision {
        if (packet.size < EquipmentFrameCodec.REQUEST_OVERHEAD) {
            return TransmitDecision.Reject("frame shorter than request overhead")
        }
        if (packet.size > EquipmentFrameCodec.MAX_MESSAGE_LENGTH) {
            return TransmitDecision.Reject("frame exceeds ${EquipmentFrameCodec.MAX_MESSAGE_LENGTH} bytes")
        }

        val declared = packet[1].toInt() and 0xFF
        if (declared < EquipmentFrameCodec.REQUEST_OVERHEAD) {
            return TransmitDecision.Reject("declared length $declared too small")
        }
        if (declared > packet.size) {
            return TransmitDecision.Reject("declared length $declared exceeds packet size ${packet.size}")
        }
        if (declared != packet.size) {
            return TransmitDecision.Reject("declared length $declared does not match packet size ${packet.size}")
        }

        val expectedChecksum = EquipmentFrameCodec.checksum(packet, declared)
        val actualChecksum = packet[declared - 1].toInt() and 0xFF
        if (expectedChecksum != actualChecksum) {
            return TransmitDecision.Reject("checksum mismatch")
        }

        val deviceId = packet[0].toInt() and 0xFF
        val commandId = packet[2].toInt() and 0xFF
        val content = packet.copyOfRange(3, declared - 1)

        when (val auth = authorization) {
            SessionTransmitAuthorization.MainOnly -> {
                if (deviceId != EquipmentDeviceIds.MAIN) {
                    return TransmitDecision.Reject(
                        "MAIN_ONLY permits DeviceInfo(MAIN) only; got device $deviceId",
                    )
                }
                if (commandId != EquipmentCommand.DEVICE_INFO.id) {
                    return TransmitDecision.Reject(
                        "MAIN_ONLY permits DeviceInfo(MAIN) only; got command $commandId",
                    )
                }
                return validateIdentityContent(content, expectedEmpty = true, label = "DeviceInfo")
            }
            is SessionTransmitAuthorization.AwaitingConfirmation -> {
                if (deviceId != auth.candidateDeviceId) {
                    return TransmitDecision.Reject(
                        "AWAITING_CONFIRMATION permits DeviceInfo(${auth.candidateDeviceId}) only; got device $deviceId",
                    )
                }
                if (commandId != EquipmentCommand.DEVICE_INFO.id) {
                    return TransmitDecision.Reject(
                        "AWAITING_CONFIRMATION permits DeviceInfo only; got command $commandId",
                    )
                }
                return validateIdentityContent(content, expectedEmpty = true, label = "DeviceInfo")
            }
            is SessionTransmitAuthorization.Confirmed -> {
                if (deviceId == EquipmentDeviceIds.MAIN && auth.primaryDeviceId != EquipmentDeviceIds.MAIN) {
                    return validateMainIdentityWhilePrimaryConfirmed(commandId, content)
                }
                if (deviceId != auth.primaryDeviceId) {
                    return TransmitDecision.Reject(
                        "CONFIRMED permits device ${auth.primaryDeviceId} only; got $deviceId",
                    )
                }
                return validateConfirmedCommand(
                    commandId,
                    content,
                    auth.allowVerifySecurity,
                    auth.allowResistanceWrite,
                    auth.allowIdleModeLockout,
                )
            }
        }
    }

    /**
     * After PrimaryDevice confirm, Legacy still reads SystemInfo/VersionInfo on
     * MAIN. VerifySecurity and field writes stay on the confirmed primary.
     */
    private fun validateMainIdentityWhilePrimaryConfirmed(
        commandId: Int,
        content: ByteArray,
    ): TransmitDecision {
        return when (commandId) {
            EquipmentCommand.DEVICE_INFO.id ->
                validateIdentityContent(content, expectedEmpty = true, label = "DeviceInfo")
            EquipmentCommand.SYSTEM_INFO.id ->
                validateIdentityContent(content, expectedEmpty = false, label = "SystemInfo")
            EquipmentCommand.VERSION_INFO.id ->
                validateIdentityContent(content, expectedEmpty = false, label = "VersionInfo")
            else ->
                TransmitDecision.Reject(
                    "CONFIRMED permits MAIN only for identity reads; got command $commandId",
                )
        }
    }

    private fun validateConfirmedCommand(
        commandId: Int,
        content: ByteArray,
        allowVerifySecurity: Boolean,
        allowResistanceWrite: Boolean,
        allowIdleModeLockout: Boolean,
    ): TransmitDecision {
        return when (commandId) {
            EquipmentCommand.DEVICE_INFO.id ->
                validateIdentityContent(content, expectedEmpty = true, label = "DeviceInfo")
            EquipmentCommand.SYSTEM_INFO.id ->
                validateIdentityContent(content, expectedEmpty = false, label = "SystemInfo")
            EquipmentCommand.VERSION_INFO.id ->
                validateIdentityContent(content, expectedEmpty = false, label = "VersionInfo")
            EquipmentCommand.VERIFY_SECURITY.id ->
                if (!allowVerifySecurity) {
                    TransmitDecision.Reject("VerifySecurity is prohibited until N1 authorizes a single attempt")
                } else {
                    validateVerifySecurity(content)
                }
            EquipmentCommand.READ_WRITE_DATA.id ->
                validateReadWriteData(content, allowResistanceWrite, allowIdleModeLockout)
            else -> TransmitDecision.Reject("command id $commandId is not approved for native transmission")
        }
    }

    private fun validateVerifySecurity(content: ByteArray): TransmitDecision {
        val expected = EquipmentSecurity.VERIFY_SECURITY_CONTENT_LENGTH
        if (content.size != expected) {
            return TransmitDecision.Reject("VerifySecurity content length ${content.size} != $expected")
        }
        return TransmitDecision.Allow
    }

    private fun validateIdentityContent(content: ByteArray, expectedEmpty: Boolean, label: String): TransmitDecision {
        return if (expectedEmpty) {
            if (content.isEmpty()) TransmitDecision.Allow
            else TransmitDecision.Reject("$label content must be empty")
        } else {
            if (content.size == 2 && content[0] == 0.toByte() && content[1] == 0.toByte()) TransmitDecision.Allow
            else TransmitDecision.Reject("$label content must be 00 00")
        }
    }

    private fun validateReadWriteData(
        content: ByteArray,
        allowResistanceWrite: Boolean,
        allowIdleModeLockout: Boolean,
    ): TransmitDecision {
        if (content.isEmpty()) {
            return TransmitDecision.Reject("ReadWriteData content missing")
        }
        val writeMaskCount = content[0].toInt() and 0xFF
        if (writeMaskCount != 0) {
            if (allowResistanceWrite) {
                val field2 = validateResistanceField2Write(content)
                if (field2 is TransmitDecision.Allow) return field2
                if (!allowIdleModeLockout) return field2
            }
            if (allowIdleModeLockout) {
                return validateIdleModeLockoutWrite(content)
            }
            return TransmitDecision.Reject(
                "ReadWriteData write section must be empty (mask count $writeMaskCount)",
            )
        }
        if (content.size < 2) {
            return TransmitDecision.Reject("ReadWriteData read section missing")
        }
        val readMaskCount = content[1].toInt() and 0xFF
        if (readMaskCount == 0) {
            return TransmitDecision.Reject("ReadWriteData read section is empty")
        }
        if (content.size != 2 + readMaskCount) {
            return TransmitDecision.Reject(
                "ReadWriteData content length ${content.size} does not match empty-write plus read mask ($readMaskCount)",
            )
        }
        val fieldIds = decodeFieldIds(content, maskOffset = 2, maskCount = readMaskCount)
            ?: return TransmitDecision.Reject("ReadWriteData read mask malformed")
        if (fieldIds.isEmpty()) {
            return TransmitDecision.Reject("ReadWriteData read mask selects no fields")
        }
        val disallowed = fieldIds.filterNot { it in ApprovedReadFields.ALL }
        if (disallowed.isNotEmpty()) {
            return TransmitDecision.Reject("ReadWriteData read fields not approved: $disallowed")
        }
        return TransmitDecision.Allow
    }

    /** Field 95 Flag(true) only, empty read section. */
    private fun validateIdleModeLockoutWrite(content: ByteArray): TransmitDecision {
        if (content.size != 15) {
            return TransmitDecision.Reject("IdleModeLockout write content length ${content.size} != 15")
        }
        if ((content[0].toInt() and 0xFF) != 12) {
            return TransmitDecision.Reject("IdleModeLockout write mask count must be 12")
        }
        for (i in 1..11) {
            if ((content[i].toInt() and 0xFF) != 0) {
                return TransmitDecision.Reject("IdleModeLockout write must target field 95 only")
            }
        }
        if ((content[12].toInt() and 0xFF) != 0x80) {
            return TransmitDecision.Reject("IdleModeLockout write must target field 95 only")
        }
        if ((content[13].toInt() and 0xFF) != 0x01) {
            return TransmitDecision.Reject("IdleModeLockout write value must be true")
        }
        if ((content[14].toInt() and 0xFF) != 0) {
            return TransmitDecision.Reject("IdleModeLockout write must use an empty read section")
        }
        return TransmitDecision.Allow
    }

    /** Field 2 only, two-byte ResistanceCodec payload, empty read section. */
    private fun validateResistanceField2Write(content: ByteArray): TransmitDecision {
        if (content.size != 5) {
            return TransmitDecision.Reject("resistance write content length ${content.size} != 5")
        }
        if ((content[0].toInt() and 0xFF) != 1) {
            return TransmitDecision.Reject("resistance write mask count must be 1")
        }
        if ((content[1].toInt() and 0xFF) != (1 shl 2)) {
            return TransmitDecision.Reject("resistance write must target field 2 only")
        }
        if ((content[2].toInt() and 0xFF) == 0 && (content[3].toInt() and 0xFF) == 0) {
            return TransmitDecision.Reject("resistance write value must be non-zero")
        }
        if ((content[4].toInt() and 0xFF) != 0) {
            return TransmitDecision.Reject("resistance write must use an empty read section")
        }
        return TransmitDecision.Allow
    }

    private fun decodeFieldIds(content: ByteArray, maskOffset: Int, maskCount: Int): List<Int>? {
        if (maskOffset + maskCount > content.size) return null
        val ids = ArrayList<Int>()
        for (byteIndex in 0 until maskCount) {
            val mask = content[maskOffset + byteIndex].toInt() and 0xFF
            for (bit in 0 until 8) {
                if ((mask and (1 shl bit)) != 0) {
                    ids.add(byteIndex * 8 + bit)
                }
            }
        }
        return ids
    }
}
