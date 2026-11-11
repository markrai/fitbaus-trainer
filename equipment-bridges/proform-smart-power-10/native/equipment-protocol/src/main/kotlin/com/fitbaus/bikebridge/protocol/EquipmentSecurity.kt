// SPDX-License-Identifier: AGPL-3.0-only
// Portions adapted from STRIDE (https://github.com/keranm/strideApp, commit d9e1b53),
// Copyright 2026 The Idea Works, Apache License 2.0. Modified by Fitbaus. See NOTICE.

package com.fitbaus.bikebridge.protocol

public object EquipmentSecurity {
    public const val HASH_LENGTH: Int = 32
    public const val VERIFY_SECURITY_CONTENT_LENGTH: Int = HASH_LENGTH + 4
    /**
     * Last softwareVersion in the STRIDE-derived protocol notes that does not
     * use VerifySecurity. This is a protocol eligibility rule reconstructed from
     * those notes, not a flag the board independently declares.
     */
    public const val LAST_SOFTWARE_VERSION_WITHOUT_SECURITY: Int = 75

    /**
     * Whether the documented v1 identity/unlock sequence selects VerifySecurity
     * for this softwareVersion (`softwareVersion > 75`). Not an explicit
     * unlock-required declaration from DeviceInfo.
     */
    public fun requiresUnlock(softwareVersion: Int): Boolean =
        softwareVersion > LAST_SOFTWARE_VERSION_WITHOUT_SECURITY

    public fun hash(serialNumber: Long, partNumber: Long, modelNumber: Long): ByteArray {
        val serial = serialNumber.toInt()
        val part = partNumber.toInt()
        val model = modelNumber.toInt()
        // STRIDE's published mix uses unsigned 32-bit shifts (`ushr`) on the
        // part operand. The locally observed Legacy helper matches Int32
        // arithmetic right-shift (`shr`) for the 16-bit rotate and the
        // per-bit part source. Serial bit tests stay unsigned; they are
        // equivalent at `& 1`.
        val rotatedPart = (part shl 16) or (part shr 16)
        val out = ByteArray(HASH_LENGTH)
        for (bit in 0 until HASH_LENGTH) {
            var value = (bit + 1) and 0xFF
            value = if ((serial ushr bit) and 1 == 1) {
                val source = if (bit < 16) rotatedPart shr bit else part shr bit
                value xor (source and 0xFF)
            } else {
                value xor ((value * (bit + model)) and 0xFF)
            }
            out[bit] = value.toByte()
        }
        return out
    }

    public fun hash(identity: MachineIdentity): ByteArray =
        hash(identity.serialNumber, identity.partNumber, identity.modelNumber)
}

public class VerifySecurityRequest private constructor(
    device: EquipmentDevice,
    public val identity: MachineIdentity,
) : EquipmentRequest(device, EquipmentCommand.VERIFY_SECURITY) {

    override fun content(): ByteArray {
        val out = ByteArray(EquipmentSecurity.VERIFY_SECURITY_CONTENT_LENGTH)
        EquipmentSecurity.hash(identity).copyInto(out, 0)
        val key = 8 * identity.masterLibraryVersion
        for (i in 0 until 4) {
            out[EquipmentSecurity.HASH_LENGTH + i] = ((key ushr (8 * i)) and 0xFF).toByte()
        }
        return out
    }

    public fun classify(raw: ByteArray?): VerifySecurityOutcome {
        if (raw == null) return VerifySecurityOutcome.NoResponse
        val frame = when (val parsed = EquipmentFrameCodec.parseResponse(raw, device, command)) {
            is FrameParseResult.Rejected -> return VerifySecurityOutcome.Malformed(parsed.rejection, parsed.detail)
            is FrameParseResult.Accepted -> parsed.frame
        }
        return when (frame.status) {
            EquipmentStatus.DONE ->
                VerifySecurityOutcome.Unlocked(if (frame.dataLength > 0) frame.dataByte(0) else null)
            EquipmentStatus.SECURITY_BLOCK -> VerifySecurityOutcome.StillLocked
            EquipmentStatus.COMMAND_NOT_SUPPORTED, EquipmentStatus.DEVICE_NOT_SUPPORTED ->
                VerifySecurityOutcome.NotSupported(frame.status)
            else -> VerifySecurityOutcome.Failed(frame.status, frame.statusCode)
        }
    }

    internal companion object {
        fun create(device: EquipmentDevice, identity: MachineIdentity): VerifySecurityRequest {
            require(identity.deviceInfo.requiresUnlock) {
                "software version ${identity.softwareVersion} does not use VerifySecurity"
            }
            return VerifySecurityRequest(device, identity)
        }
    }
}

public sealed class VerifySecurityOutcome {
    public class Unlocked internal constructor(public val unlockKey: Int?) : VerifySecurityOutcome() {
        override fun toString(): String = "Unlocked"
    }

    public object StillLocked : VerifySecurityOutcome() {
        override fun toString(): String = "StillLocked"
    }

    public class NotSupported internal constructor(public val status: EquipmentStatus) : VerifySecurityOutcome() {
        override fun toString(): String = "NotSupported($status)"
    }

    public class Failed internal constructor(
        public val status: EquipmentStatus,
        public val statusCode: Int,
    ) : VerifySecurityOutcome() {
        override fun toString(): String = "Failed($status/$statusCode)"
    }

    public object NoResponse : VerifySecurityOutcome() {
        override fun toString(): String = "NoResponse"
    }

    public class Malformed internal constructor(
        public val rejection: FrameRejection,
        public val detail: String,
    ) : VerifySecurityOutcome() {
        override fun toString(): String = "Malformed($rejection: $detail)"
    }
}
