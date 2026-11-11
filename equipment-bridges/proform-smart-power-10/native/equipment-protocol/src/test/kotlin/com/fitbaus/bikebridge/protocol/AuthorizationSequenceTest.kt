// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertSame
import kotlin.test.assertTrue

class AuthorizationSequenceTest {
    private class ScriptedExchange(
        private val replies: Map<EquipmentCommand, ByteArray?> = emptyMap(),
        private val repliesByDevice: Map<Pair<Int, EquipmentCommand>, ByteArray?> = emptyMap(),
    ) : EquipmentExchange {
        val sent = mutableListOf<String>()

        override fun exchange(request: EquipmentRequest): ByteArray? {
            sent.add(hex(request.encode()))
            val keyed = request.device.id to request.command
            if (repliesByDevice.containsKey(keyed)) return repliesByDevice[keyed]?.copyOf()
            return replies[request.command]?.copyOf()
        }
    }

    private val happyReplies: Map<EquipmentCommand, ByteArray?> = mapOf(
        EquipmentCommand.DEVICE_INFO to IdentityFixtures.deviceInfo.bytes(),
        EquipmentCommand.SYSTEM_INFO to IdentityFixtures.systemInfo.bytes(),
        EquipmentCommand.VERSION_INFO to IdentityFixtures.versionInfo.bytes(),
        EquipmentCommand.VERIFY_SECURITY to IdentityFixtures.verifyUnlockedWithKey.bytes(),
    )

    @Test
    fun unlocksWithIdentityReadFromTheBoard() {
        val exchange = ScriptedExchange(happyReplies)
        val outcome = assertIs<AuthorizationOutcome.Unlocked>(EquipmentAuthorizationSequence(exchange).run())
        assertEquals(0x5A, outcome.unlockKey)
        assertEquals(123456789L, outcome.identity.serialNumber)
        assertEquals(
            listOf(
                hex(IdentityFixtures.deviceInfoRequest.bytes()),
                hex(IdentityFixtures.systemInfoRequest.bytes()),
                hex(IdentityFixtures.versionInfoRequest.bytes()),
                hex(IdentityFixtures.verifySecurityRequest.bytes()),
            ),
            exchange.sent,
        )
    }

    @Test
    fun stopsAfterDeviceInfoWhenSecurityIsNotUsed() {
        val exchange = ScriptedExchange(happyReplies + (EquipmentCommand.DEVICE_INFO to IdentityFixtures.deviceInfo(75, 123456789L)))
        val outcome = assertIs<AuthorizationOutcome.NotRequired>(EquipmentAuthorizationSequence(exchange).run())
        assertEquals(75, outcome.deviceInfo.softwareVersion)
        assertEquals(1, exchange.sent.size)
    }

    @Test
    fun abortsWithoutVerifyingWhenIdentityIsMissing() {
        val noSystem = ScriptedExchange(happyReplies + (EquipmentCommand.SYSTEM_INFO to null))
        val aborted = assertIs<AuthorizationOutcome.Aborted>(EquipmentAuthorizationSequence(noSystem).run())
        assertEquals(AuthorizationStep.SYSTEM_INFO, aborted.step)
        assertEquals(IdentityRejection.NO_RESPONSE, aborted.reason)
        assertEquals(2, noSystem.sent.size)

        val zeroSerial = ScriptedExchange(happyReplies + (EquipmentCommand.DEVICE_INFO to IdentityFixtures.deviceInfo(86, 0L)))
        val zero = assertIs<AuthorizationOutcome.Aborted>(EquipmentAuthorizationSequence(zeroSerial).run())
        assertEquals(AuthorizationStep.DEVICE_INFO, zero.step)
        assertEquals(IdentityRejection.MISSING_IDENTITY, zero.reason)
        assertEquals(1, zeroSerial.sent.size)

        val badVersion = ScriptedExchange(happyReplies + (EquipmentCommand.VERSION_INFO to BikeFixtures.securityBlock.bytes()))
        val version = assertIs<AuthorizationOutcome.Aborted>(EquipmentAuthorizationSequence(badVersion).run())
        assertEquals(AuthorizationStep.VERSION_INFO, version.step)
        assertEquals(IdentityRejection.MALFORMED_FRAME, version.reason)
        assertEquals(3, badVersion.sent.size)
    }

    @Test
    fun reportsRefusedVerification() {
        val stillLocked = ScriptedExchange(happyReplies + (EquipmentCommand.VERIFY_SECURITY to IdentityFixtures.verifySecurityBlock.bytes()))
        assertSame(VerifySecurityOutcome.StillLocked, assertIs<AuthorizationOutcome.Refused>(EquipmentAuthorizationSequence(stillLocked).run()).outcome)

        val silent = ScriptedExchange(happyReplies + (EquipmentCommand.VERIFY_SECURITY to null))
        assertSame(VerifySecurityOutcome.NoResponse, assertIs<AuthorizationOutcome.Refused>(EquipmentAuthorizationSequence(silent).run()).outcome)

        val unsupported = ScriptedExchange(happyReplies + (EquipmentCommand.VERIFY_SECURITY to IdentityFixtures.verifyCommandNotSupported.bytes()))
        assertIs<VerifySecurityOutcome.NotSupported>(assertIs<AuthorizationOutcome.Refused>(EquipmentAuthorizationSequence(unsupported).run()).outcome)
    }

    @Test
    fun respectsTheConfiguredDevice() {
        val other = EquipmentDevice.of(4)
        val exchange = ScriptedExchange(happyReplies)
        val aborted = assertIs<AuthorizationOutcome.Aborted>(EquipmentAuthorizationSequence(exchange, other).run())
        assertEquals(AuthorizationStep.DEVICE_INFO, aborted.step)
        assertEquals(IdentityRejection.MALFORMED_FRAME, aborted.reason)
        assertEquals("04 04 81 89", exchange.sent.single())
    }

    @Test
    fun collectIdentityDoesNotResendDeviceInfoOrVerifySecurity() {
        val exchange = ScriptedExchange(happyReplies)
        val deviceInfo = parsedDeviceInfo()
        val collected = assertIs<IdentityCollectionResult.Complete>(
            EquipmentAuthorizationSequence(exchange).collectIdentity(deviceInfo),
        )
        assertEquals(123456789L, collected.identity.serialNumber)
        assertEquals(
            listOf(
                hex(IdentityFixtures.systemInfoRequest.bytes()),
                hex(IdentityFixtures.versionInfoRequest.bytes()),
            ),
            exchange.sent,
        )
    }

    @Test
    fun continueAfterDeviceInfoVerifiesWithoutResendingDeviceInfo() {
        val exchange = ScriptedExchange(happyReplies)
        val outcome = assertIs<AuthorizationOutcome.Unlocked>(
            EquipmentAuthorizationSequence(exchange).continueAfterDeviceInfo(parsedDeviceInfo()),
        )
        assertEquals(0x5A, outcome.unlockKey)
        assertEquals(
            listOf(
                hex(IdentityFixtures.systemInfoRequest.bytes()),
                hex(IdentityFixtures.versionInfoRequest.bytes()),
                hex(IdentityFixtures.verifySecurityRequest.bytes()),
            ),
            exchange.sent,
        )
    }

    @Test
    fun collectIdentityStopsWithoutGuessingWhenSystemInfoIsMissingOrMalformed() {
        val missing = ScriptedExchange(happyReplies + (EquipmentCommand.SYSTEM_INFO to null))
        val aborted = assertIs<IdentityCollectionResult.Aborted>(
            EquipmentAuthorizationSequence(missing).collectIdentity(parsedDeviceInfo()),
        )
        assertEquals(AuthorizationStep.SYSTEM_INFO, aborted.step)
        assertEquals(IdentityRejection.NO_RESPONSE, aborted.reason)
        assertEquals(1, missing.sent.size)

        val malformed = ScriptedExchange(happyReplies + (EquipmentCommand.VERSION_INFO to BikeFixtures.securityBlock.bytes()))
        val version = assertIs<IdentityCollectionResult.Aborted>(
            EquipmentAuthorizationSequence(malformed).collectIdentity(parsedDeviceInfo()),
        )
        assertEquals(AuthorizationStep.VERSION_INFO, version.step)
        assertEquals(IdentityRejection.MALFORMED_FRAME, version.reason)
        assertEquals(2, malformed.sent.size)
        assertFalse(malformed.sent.any { it.startsWith("02 28 90") })
    }

    @Test
    fun collectIdentityDoesNotUnlockWhenSoftwareDoesNotRequireIt() {
        val exchange = ScriptedExchange(happyReplies)
        val notRequired = assertIs<IdentityCollectionResult.NotRequired>(
            EquipmentAuthorizationSequence(exchange).collectIdentity(parsedDeviceInfo(IdentityFixtures.deviceInfo(75, 123456789L))),
        )
        assertEquals(75, notRequired.deviceInfo.softwareVersion)
        assertEquals(emptyList<String>(), exchange.sent)
    }

    @Test
    fun verifyCollectedSendsOnlyVerifySecurity() {
        val exchange = ScriptedExchange(happyReplies)
        val identity = assertIs<IdentityCollectionResult.Complete>(
            EquipmentAuthorizationSequence(ScriptedExchange(happyReplies)).collectIdentity(parsedDeviceInfo()),
        ).identity
        val outcome = assertIs<AuthorizationOutcome.Unlocked>(
            EquipmentAuthorizationSequence(exchange).verifyCollected(identity),
        )
        assertEquals(0x5A, outcome.unlockKey)
        assertEquals(listOf(hex(IdentityFixtures.verifySecurityRequest.bytes())), exchange.sent)
    }

    @Test
    fun collectIdentityReadsSystemAndVersionFromMainWhenVerifyDeviceIsFitnessBike() {
        val bike = EquipmentDevice.FITNESS_BIKE
        val exchange = ScriptedExchange(
            replies = mapOf(
                EquipmentCommand.SYSTEM_INFO to IdentityFixtures.systemInfo.bytes(),
                EquipmentCommand.VERSION_INFO to IdentityFixtures.versionInfo.bytes(),
            ),
            repliesByDevice = mapOf(
                (bike.id to EquipmentCommand.SYSTEM_INFO) to
                    retarget(IdentityFixtures.systemInfo(99991L, 88882L), bike.id),
                (bike.id to EquipmentCommand.VERSION_INFO) to
                    IdentityFixtures.frame(bike.id, 0x84, 0x02, 0x01),
            ),
        )
        val collected = assertIs<IdentityCollectionResult.Complete>(
            EquipmentAuthorizationSequence(
                exchange,
                identityDevice = EquipmentDevice.MAIN,
                verifyDevice = bike,
            ).collectIdentity(parsedDeviceInfo()),
        )
        assertEquals(123456789L, collected.identity.serialNumber)
        assertEquals(401234L, collected.identity.partNumber)
        assertEquals(40111L, collected.identity.modelNumber)
        assertEquals(84, collected.identity.masterLibraryVersion)
        assertEquals(2, exchange.sent.size)
        assertTrue(exchange.sent.all { it.startsWith("02 ") })
        assertEquals("82", exchange.sent[0].split(" ")[2])
        assertEquals("84", exchange.sent[1].split(" ")[2])
        assertTrue(exchange.sent.none { it.split(" ")[2] == "90" })
    }

    @Test
    fun collectIdentityAcceptsMainReadsAnsweredAsFitnessBike() {
        val bike = EquipmentDevice.FITNESS_BIKE
        val exchange = ScriptedExchange(
            replies = mapOf(
                EquipmentCommand.SYSTEM_INFO to retarget(IdentityFixtures.systemInfo.bytes(), bike.id),
                EquipmentCommand.VERSION_INFO to retarget(IdentityFixtures.versionInfo.bytes(), bike.id),
                EquipmentCommand.VERIFY_SECURITY to retarget(IdentityFixtures.verifyUnlockedWithKey.bytes(), bike.id),
            ),
        )
        val outcome = assertIs<AuthorizationOutcome.Unlocked>(
            EquipmentAuthorizationSequence(
                exchange,
                identityDevice = EquipmentDevice.MAIN,
                verifyDevice = bike,
            ).continueAfterDeviceInfo(parsedDeviceInfo()),
        )
        assertEquals(40111L, outcome.identity.modelNumber)
        assertEquals(84, outcome.identity.masterLibraryVersion)
        assertEquals(hex(IdentityFixtures.systemInfoRequest.bytes()), exchange.sent[0])
        assertEquals(hex(IdentityFixtures.verifySecurityRequestFitnessBike.bytes()), exchange.sent[2])
    }

    @Test
    fun verifyCollectedTargetsPrimaryWhenIdentityCameFromMain() {
        val bike = EquipmentDevice.FITNESS_BIKE
        val identity = assertIs<IdentityCollectionResult.Complete>(
            EquipmentAuthorizationSequence(ScriptedExchange(happyReplies)).collectIdentity(parsedDeviceInfo()),
        ).identity
        val exchange = ScriptedExchange(
            repliesByDevice = mapOf(
                (bike.id to EquipmentCommand.VERIFY_SECURITY) to
                    retarget(IdentityFixtures.verifyUnlockedWithKey.bytes(), bike.id),
                (EquipmentDeviceIds.MAIN to EquipmentCommand.VERIFY_SECURITY) to
                    IdentityFixtures.verifySecurityBlock.bytes(),
            ),
        )
        val outcome = assertIs<AuthorizationOutcome.Unlocked>(
            EquipmentAuthorizationSequence(
                exchange,
                identityDevice = EquipmentDevice.MAIN,
                verifyDevice = bike,
            ).verifyCollected(identity),
        )
        assertEquals(0x5A, outcome.unlockKey)
        assertEquals(listOf(hex(IdentityFixtures.verifySecurityRequestFitnessBike.bytes())), exchange.sent)
        assertEquals(123456789L, outcome.identity.serialNumber)
        assertEquals(401234L, outcome.identity.partNumber)
        assertEquals(84, outcome.identity.masterLibraryVersion)
    }

    @Test
    fun splitDevicesDoNotHashPrimarySystemInfoOrVersionInfo() {
        val bike = EquipmentDevice.FITNESS_BIKE
        val exchange = ScriptedExchange(
            replies = mapOf(
                EquipmentCommand.SYSTEM_INFO to IdentityFixtures.systemInfo.bytes(),
                EquipmentCommand.VERSION_INFO to IdentityFixtures.versionInfo.bytes(),
                EquipmentCommand.VERIFY_SECURITY to retarget(IdentityFixtures.verifyUnlockedWithKey.bytes(), bike.id),
            ),
            repliesByDevice = mapOf(
                (bike.id to EquipmentCommand.SYSTEM_INFO) to
                    retarget(IdentityFixtures.systemInfo(99991L, 88882L), bike.id),
                (bike.id to EquipmentCommand.VERSION_INFO) to
                    IdentityFixtures.frame(bike.id, 0x84, 0x02, 0x01),
            ),
        )
        val outcome = assertIs<AuthorizationOutcome.Unlocked>(
            EquipmentAuthorizationSequence(
                exchange,
                identityDevice = EquipmentDevice.MAIN,
                verifyDevice = bike,
            ).continueAfterDeviceInfo(parsedDeviceInfo()),
        )
        assertEquals(
            listOf(
                hex(IdentityFixtures.systemInfoRequest.bytes()),
                hex(IdentityFixtures.versionInfoRequest.bytes()),
                hex(IdentityFixtures.verifySecurityRequestFitnessBike.bytes()),
            ),
            exchange.sent,
        )
        val wrong = EquipmentRequests.verifySecurity(
            MachineIdentity.of(
                parsedDeviceInfo(),
                assertIs<IdentityResult.Parsed<SystemInfo>>(
                    EquipmentRequests.systemInfo(bike).parse(
                        retarget(IdentityFixtures.systemInfo(99991L, 88882L), bike.id),
                    ),
                ).value,
                VersionInfo(1),
            ),
            bike,
        )
        assertEquals(hex(IdentityFixtures.verifySecurityRequestFitnessBike.bytes()), exchange.sent.last())
        assertTrue(exchange.sent.last() != hex(wrong.encode()))
        assertEquals(40111L, outcome.identity.modelNumber)
        assertEquals(84, outcome.identity.masterLibraryVersion)
    }

    @Test
    fun verifyCollectedReportsIncorrectAndUnsupportedResponses() {
        val identity = assertIs<IdentityCollectionResult.Complete>(
            EquipmentAuthorizationSequence(ScriptedExchange(happyReplies)).collectIdentity(parsedDeviceInfo()),
        ).identity

        val locked = ScriptedExchange(happyReplies + (EquipmentCommand.VERIFY_SECURITY to IdentityFixtures.verifySecurityBlock.bytes()))
        assertSame(
            VerifySecurityOutcome.StillLocked,
            assertIs<AuthorizationOutcome.Refused>(EquipmentAuthorizationSequence(locked).verifyCollected(identity)).outcome,
        )

        val unsupported = ScriptedExchange(
            happyReplies + (EquipmentCommand.VERIFY_SECURITY to IdentityFixtures.verifyCommandNotSupported.bytes()),
        )
        assertIs<VerifySecurityOutcome.NotSupported>(
            assertIs<AuthorizationOutcome.Refused>(EquipmentAuthorizationSequence(unsupported).verifyCollected(identity)).outcome,
        )

        val malformed = ScriptedExchange(happyReplies + (EquipmentCommand.VERIFY_SECURITY to BikeFixtures.securityBlock.bytes()))
        assertIs<VerifySecurityOutcome.Malformed>(
            assertIs<AuthorizationOutcome.Refused>(EquipmentAuthorizationSequence(malformed).verifyCollected(identity)).outcome,
        )
    }

    private fun parsedDeviceInfo(raw: ByteArray = IdentityFixtures.deviceInfo.bytes()): DeviceInfo =
        assertIs<IdentityResult.Parsed<DeviceInfo>>(EquipmentRequests.deviceInfo().parse(raw)).value

    private fun retarget(frame: ByteArray, deviceId: Int): ByteArray {
        val copy = frame.copyOf()
        copy[0] = deviceId.toByte()
        copy[copy.lastIndex] = EquipmentFrameCodec.checksum(copy, copy.size).toByte()
        return copy
    }
}
