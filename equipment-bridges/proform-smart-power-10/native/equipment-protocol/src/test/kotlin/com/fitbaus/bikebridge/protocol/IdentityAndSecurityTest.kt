// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class IdentityAndSecurityTest {
    private val deviceRequest = EquipmentRequests.deviceInfo()
    private val systemRequest = EquipmentRequests.systemInfo()
    private val versionRequest = EquipmentRequests.versionInfo()

    private fun <T> parsed(result: IdentityResult<T>): T = assertIs<IdentityResult.Parsed<T>>(result).value

    private fun rejected(result: IdentityResult<*>): IdentityRejection = assertIs<IdentityResult.Rejected>(result).reason

    private fun identity(
        device: ByteArray = IdentityFixtures.deviceInfo.bytes(),
        system: ByteArray = IdentityFixtures.systemInfo.bytes(),
        version: ByteArray = IdentityFixtures.versionInfo.bytes(),
    ): MachineIdentity = MachineIdentity.of(
        parsed(deviceRequest.parse(device)),
        parsed(systemRequest.parse(system)),
        parsed(versionRequest.parse(version)),
    )

    @Test
    fun encodesIdentityRequests() {
        assertEquals(hex(IdentityFixtures.deviceInfoRequest.bytes()), hex(deviceRequest.encode()))
        assertEquals(hex(IdentityFixtures.systemInfoRequest.bytes()), hex(systemRequest.encode()))
        assertEquals(hex(IdentityFixtures.versionInfoRequest.bytes()), hex(versionRequest.encode()))
    }

    @Test
    fun parsesIdentityResponses() {
        val device = parsed(deviceRequest.parse(IdentityFixtures.deviceInfo.bytes()))
        assertEquals(86, device.softwareVersion)
        assertEquals(123456789L, device.serialNumber)
        assertTrue(device.requiresUnlock)

        val system = parsed(systemRequest.parse(IdentityFixtures.systemInfo.bytes()))
        assertEquals(40111L, system.modelNumber)
        assertEquals(401234L, system.partNumber)
        assertEquals(401234L, system.reportedPartNumber)

        assertEquals(84, parsed(versionRequest.parse(IdentityFixtures.versionInfo.bytes())).masterLibraryVersion)
    }

    @Test
    fun mainSystemAndVersionInfoAcceptFitnessBikeResponseDevice() {
        fun retarget(frame: ByteArray, deviceId: Int): ByteArray {
            val copy = frame.copyOf()
            copy[0] = deviceId.toByte()
            copy[copy.lastIndex] = EquipmentFrameCodec.checksum(copy, copy.size).toByte()
            return copy
        }
        val system = parsed(systemRequest.parse(retarget(IdentityFixtures.systemInfo.bytes(), EquipmentDeviceIds.FITNESS_BIKE)))
        assertEquals(40111L, system.modelNumber)
        assertEquals(401234L, system.partNumber)
        val version = parsed(versionRequest.parse(retarget(IdentityFixtures.versionInfo.bytes(), EquipmentDeviceIds.FITNESS_BIKE)))
        assertEquals(84, version.masterLibraryVersion)
        assertEquals(
            IdentityRejection.MALFORMED_FRAME,
            rejected(systemRequest.parse(retarget(IdentityFixtures.systemInfo.bytes(), 4))),
        )
    }

    @Test
    fun parsesSerialAboveSignedRangeAsUnsigned() {
        val device = parsed(deviceRequest.parse(IdentityFixtures.deviceInfo(90, 0x80000001L)))
        assertEquals(0x80000001L, device.serialNumber)
    }

    @Test
    fun appliesDocumentedPartNumberFixUp() {
        val system = parsed(systemRequest.parse(IdentityFixtures.systemInfoMisreportedPart.bytes()))
        assertEquals(370357L, system.reportedPartNumber)
        assertEquals(374677L, system.partNumber)

        val otherModel = parsed(systemRequest.parse(IdentityFixtures.systemInfo(40000L, 370357L)))
        assertEquals(370357L, otherModel.partNumber)
    }

    @Test
    fun rejectsMissingOrInvalidIdentity() {
        assertEquals(IdentityRejection.NO_RESPONSE, rejected(deviceRequest.parse(null)))
        assertEquals(IdentityRejection.MISSING_IDENTITY, rejected(deviceRequest.parse(IdentityFixtures.deviceInfo(86, 0L))))
        assertEquals(IdentityRejection.SENTINEL_IDENTITY, rejected(deviceRequest.parse(IdentityFixtures.deviceInfo(86, 0xFFFFFFFFL))))
        assertEquals(IdentityRejection.MISSING_IDENTITY, rejected(systemRequest.parse(IdentityFixtures.systemInfo(0L, 401234L))))
        assertEquals(IdentityRejection.MISSING_IDENTITY, rejected(systemRequest.parse(IdentityFixtures.systemInfo(40111L, 0L))))
        assertEquals(IdentityRejection.SENTINEL_IDENTITY, rejected(systemRequest.parse(IdentityFixtures.systemInfo(0xFFFFFFFFL, 1L))))
    }

    @Test
    fun rejectsShortMalformedAndNonDoneIdentityFrames() {
        assertEquals(
            IdentityRejection.PAYLOAD_TOO_SHORT,
            rejected(deviceRequest.parse(IdentityFixtures.frame(0x02, 0x81, 0x02, 86, 0, 1, 2, 3))),
        )
        assertEquals(
            IdentityRejection.PAYLOAD_TOO_SHORT,
            rejected(systemRequest.parse(IdentityFixtures.frame(0x02, 0x82, 0x02, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7))),
        )
        assertEquals(IdentityRejection.PAYLOAD_TOO_SHORT, rejected(versionRequest.parse(IdentityFixtures.frame(0x02, 0x84, 0x02))))

        val corrupt = IdentityFixtures.deviceInfo.bytes()
        corrupt[6] = 0
        assertEquals(IdentityRejection.MALFORMED_FRAME, rejected(deviceRequest.parse(corrupt)))
        assertEquals(IdentityRejection.MALFORMED_FRAME, rejected(deviceRequest.parse(IdentityFixtures.systemInfo.bytes())))
        assertEquals(IdentityRejection.MALFORMED_FRAME, rejected(deviceRequest.parse(StrideFixtures.treadmillReadActualKphReply.bytes())))

        assertEquals(IdentityRejection.STATUS_NOT_DONE, rejected(deviceRequest.parse(IdentityFixtures.frame(0x02, 0x81, 0x01))))
        assertEquals(IdentityRejection.SECURITY_BLOCKED, rejected(deviceRequest.parse(IdentityFixtures.frame(0x02, 0x81, 0x08))))
    }

    @Test
    fun unlockIsRequiredOnlyAboveSoftwareVersion75() {
        assertFalse(EquipmentSecurity.requiresUnlock(0))
        assertFalse(EquipmentSecurity.requiresUnlock(75))
        assertTrue(EquipmentSecurity.requiresUnlock(76))
    }

    @Test
    fun hashMatchesHandDerivedLeadingBytes() {
        val hash = EquipmentSecurity.hash(0L, 0L, 0L)
        assertEquals(hex(SecurityVectors.zeroIdentityLeadingBytes.bytes()), hex(hash.copyOf(4)))
    }

    @Test
    fun hashMatchesIndependentReferenceVectors() {
        for (v in SecurityVectors.all) {
            val hash = EquipmentSecurity.hash(v.serial, v.part, v.model)
            assertEquals(32, hash.size)
            assertEquals(v.hash, hash.joinToString("") { "%02X".format(it.toInt() and 0xFF) }, "vector ${v.serial} [${v.provenance}]")
        }
    }

    @Test
    fun publishedHashVectorsAreIndependentLiterals() {
        assertEquals(10, SecurityVectors.all.size)
        for (v in SecurityVectors.all) {
            assertEquals(Provenance.INDEPENDENT_REFERENCE_COMPUTATION, v.provenance)
            assertEquals(64, v.hash.length)
            assertTrue(v.hash.matches(Regex("[0-9A-F]{64}")))
        }
        val zero = SecurityVectors.all[0]
        assertEquals(0L, zero.serial)
        assertEquals(0L, zero.part)
        assertEquals(0L, zero.model)
        assertEquals(Provenance.HAND_DERIVED, SecurityVectors.zeroIdentityLeadingBytes.provenance)
        assertEquals(
            hex(SecurityVectors.zeroIdentityLeadingBytes.bytes()).replace(" ", ""),
            zero.hash.substring(0, 8),
        )
        val pythonSource = listOf(
            File("tools/security_hash_reference.py"),
            File("equipment-protocol/tools/security_hash_reference.py"),
        ).first { it.isFile }
        val pythonCases = Regex("""\((0x[0-9A-Fa-f]+|\d+),\s*(0x[0-9A-Fa-f]+|\d+),\s*(0x[0-9A-Fa-f]+|\d+)\)""")
            .findAll(pythonSource.readText())
            .map { match ->
                fun num(raw: String): Long =
                    if (raw.startsWith("0x") || raw.startsWith("0X")) raw.substring(2).toLong(16) else raw.toLong()
                Triple(num(match.groupValues[1]), num(match.groupValues[2]), num(match.groupValues[3]))
            }
            .toList()
        assertEquals(SecurityVectors.all.map { Triple(it.serial, it.part, it.model) }, pythonCases)
    }

    @Test
    fun hashUsesArithmeticPartShiftOnNegativeOperands() {
        val serialBit31 = 0x80000000L
        val partPositive = 0x12345678L
        val partSignBit = 0x80000000L
        val positive = EquipmentSecurity.hash(serialBit31, partPositive, 0L)
        val negative = EquipmentSecurity.hash(serialBit31, partSignBit, 0L)
        val expectedNegative = 0x20 xor ((partSignBit.toInt() shr 31) and 0xFF)
        assertEquals(0x20, positive[31].toInt() and 0xFF)
        assertEquals(expectedNegative, negative[31].toInt() and 0xFF)
        val publishedHigh = SecurityVectors.all.single { it.serial == 0x80000001L }
        assertEquals(0x80000000L, publishedHigh.part and 0x80000000L)
        val publishedAllOnesSerial = SecurityVectors.all.first { it.serial == 0xFFFFFFFFL && it.part == 0x12345678L }
        assertEquals(0L, publishedAllOnesSerial.part and 0x80000000L)
        val lowSerialMinPart = SecurityVectors.all.single { it.serial == 0x0000FFFFL }
        assertEquals(0x80000000L, lowSerialMinPart.part)
        val highSerialMinPart = SecurityVectors.all.single { it.serial == 0xFFFF0000L }
        assertEquals(0x80000000L, highSerialMinPart.part)
    }

    @Test
    fun identityHashUsesCorrectedPartNumber() {
        val id = identity(
            device = IdentityFixtures.deviceInfoForFixup.bytes(),
            system = IdentityFixtures.systemInfoMisreportedPart.bytes(),
        )
        val expected = SecurityVectors.all.single { it.serial == 0x0F0F1234L }.hash
        assertEquals(expected, EquipmentSecurity.hash(id).joinToString("") { "%02X".format(it.toInt() and 0xFF) })
    }

    @Test
    fun encodesVerifySecurityRequest() {
        val request = EquipmentRequests.verifySecurity(identity())
        val encoded = request.encode()
        assertEquals(40, encoded.size)
        assertEquals(0x90, encoded[2].toInt() and 0xFF)
        assertEquals(hex(IdentityFixtures.verifySecurityRequest.bytes()), hex(encoded))
    }

    @Test
    fun encodesVerifySecurityOnFitnessBikeMatchesShirePayload() {
        val encoded = EquipmentRequests.verifySecurity(identity(), EquipmentDevice.FITNESS_BIKE).encode()
        val expected = IdentityFixtures.verifySecurityRequestFitnessBike.bytes()
        assertEquals(hex(expected), hex(encoded))
        val shireHashAndKey = expected.copyOfRange(3, 39)
        val kotlinContent = encoded.copyOfRange(3, encoded.size - 1)
        assertEquals(hex(shireHashAndKey), hex(kotlinContent))
        assertEquals(
            SecurityVectors.all.single { it.serial == 123456789L }.hash,
            encoded.copyOfRange(3, 35).joinToString("") { "%02X".format(it.toInt() and 0xFF) },
        )
        assertEquals(0xA0, encoded[35].toInt() and 0xFF)
        assertEquals(0x02, encoded[36].toInt() and 0xFF)
        assertEquals(0x00, encoded[37].toInt() and 0xFF)
        assertEquals(0x00, encoded[38].toInt() and 0xFF)
        val mainEncoded = EquipmentRequests.verifySecurity(identity()).encode()
        assertEquals(hex(mainEncoded.copyOfRange(3, mainEncoded.size - 1)), hex(kotlinContent))
        assertTrue(encoded[0] == 7.toByte())
        assertTrue(mainEncoded[0] == 2.toByte())
    }

    @Test
    fun refusesVerifySecurityForBoardsWithoutSecurity() {
        val legacy = identity(device = IdentityFixtures.deviceInfo(75, 123456789L))
        assertFailsWith<IllegalArgumentException> { EquipmentRequests.verifySecurity(legacy) }
    }

    @Test
    fun classifiesVerifySecurityResponses() {
        val request = EquipmentRequests.verifySecurity(identity())
        assertEquals(0x5A, assertIs<VerifySecurityOutcome.Unlocked>(request.classify(IdentityFixtures.verifyUnlockedWithKey.bytes())).unlockKey)
        assertNull(assertIs<VerifySecurityOutcome.Unlocked>(request.classify(IdentityFixtures.verifyUnlockedNoKey.bytes())).unlockKey)
        assertSame(VerifySecurityOutcome.StillLocked, request.classify(IdentityFixtures.verifySecurityBlock.bytes()))
        assertEquals(
            EquipmentStatus.COMMAND_NOT_SUPPORTED,
            assertIs<VerifySecurityOutcome.NotSupported>(request.classify(IdentityFixtures.verifyCommandNotSupported.bytes())).status,
        )
        assertEquals(EquipmentStatus.FAILED, assertIs<VerifySecurityOutcome.Failed>(request.classify(IdentityFixtures.verifyFailed.bytes())).status)
        assertSame(VerifySecurityOutcome.NoResponse, request.classify(null))
        assertEquals(
            FrameRejection.COMMAND_MISMATCH,
            assertIs<VerifySecurityOutcome.Malformed>(request.classify(BikeFixtures.securityBlock.bytes())).rejection,
        )
    }
}
