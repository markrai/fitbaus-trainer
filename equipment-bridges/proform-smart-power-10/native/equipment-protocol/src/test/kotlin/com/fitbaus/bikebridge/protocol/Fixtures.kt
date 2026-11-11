// SPDX-License-Identifier: AGPL-3.0-only
// Fixtures labelled STRIDE_* are quoted from STRIDE's published protocol notes.
// Upstream path retained for provenance: protocol/FITPRO_PROTOCOL.md
// (https://github.com/keranm/strideApp, commit d9e1b53), Copyright 2026 The Idea Works, Apache License 2.0.

package com.fitbaus.bikebridge.protocol

enum class Provenance {
    STRIDE_HARDWARE_TREADMILL,
    STRIDE_SPEC_WORKED_EXAMPLE,
    SYNTHETIC_FROM_SPEC,
    INDEPENDENT_REFERENCE_COMPUTATION,
    HAND_DERIVED,
}

class Fixture(val name: String, val provenance: Provenance, hex: String) {
    private val raw: ByteArray = bytes(hex)

    fun bytes(): ByteArray = raw.copyOf()

    override fun toString(): String = "$name [$provenance]"

    companion object {
        fun bytes(hex: String): ByteArray {
            val clean = hex.replace(" ", "")
            require(clean.length % 2 == 0) { "odd hex length: $hex" }
            return ByteArray(clean.length / 2) { clean.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        }
    }
}

object StrideFixtures {
    val workedExampleReadActualKphActualIncline =
        Fixture("ReadWriteData ActualKph+ActualIncline, device 4", Provenance.STRIDE_SPEC_WORKED_EXAMPLE, "04 09 02 00 03 00 00 03 15")
    val treadmillReadActualKphRequest =
        Fixture("ReadWriteData ActualKph request, device 4", Provenance.STRIDE_HARDWARE_TREADMILL, "04 09 02 00 03 00 00 01 13")
    val treadmillReadActualKphReply =
        Fixture("ReadWriteData ActualKph reply, device 4", Provenance.STRIDE_HARDWARE_TREADMILL, "04 07 02 02 00 00 0F")
    val treadmillSecurityBlock =
        Fixture("ReadWriteData SecurityBlock, device 4", Provenance.STRIDE_HARDWARE_TREADMILL, "04 05 02 08 13")
    val prohibitedBrainboardReset =
        Fixture("Update command frame documented as brainboard reset", Provenance.STRIDE_SPEC_WORKED_EXAMPLE, "02 04 09 0F")
}

object BikeFixtures {
    val readWattsRpmRequest =
        Fixture("Read Watts+Rpm on MAIN", Provenance.SYNTHETIC_FROM_SPEC, "02 07 02 00 01 28 34")
    val readWattsRpmReply =
        Fixture("Watts=150 Rpm=72 on MAIN", Provenance.SYNTHETIC_FROM_SPEC, "02 09 02 02 96 00 48 00 ED")
    val readResistanceRequest =
        Fixture("Read Resistance alone on MAIN", Provenance.SYNTHETIC_FROM_SPEC, "02 07 02 00 01 04 10")
    val readMaxResistanceLevelRequest =
        Fixture("Read MaxResistanceLevel on MAIN", Provenance.SYNTHETIC_FROM_SPEC, "02 0C 02 00 06 00 00 00 00 00 04 1A")
    val readTelemetryAndStateRequest =
        Fixture(
            "Read Watts, Rpm, WorkoutMode, MaxResistanceLevel, IdleModeLockout on MAIN",
            Provenance.SYNTHETIC_FROM_SPEC,
            "02 12 02 00 0C 28 10 00 00 00 04 00 00 00 00 00 80 DE",
        )
    val readTelemetryAndStateReply =
        Fixture(
            "Watts=200 Rpm=90 Mode=Running Max=24 Lockout=true",
            Provenance.SYNTHETIC_FROM_SPEC,
            "02 0C 02 02 C8 00 5A 00 02 18 01 4F",
        )
    val securityBlock = Fixture("SecurityBlock on MAIN", Provenance.SYNTHETIC_FROM_SPEC, "02 05 02 08 11")
    val failedWithFill = Fixture("Failed status with 0xFF fill", Provenance.SYNTHETIC_FROM_SPEC, "02 09 02 04 FF FF FF FF 0D")
    val wattsSentinel = Fixture("Watts sentinel, Rpm=72", Provenance.SYNTHETIC_FROM_SPEC, "02 09 02 02 FF FF 48 00 55")
    val doneWithoutData = Fixture("Done with no field data", Provenance.SYNTHETIC_FROM_SPEC, "02 05 02 02 0B")
    val truncatedFieldData = Fixture("Watts+Rpm reply missing one byte", Provenance.SYNTHETIC_FROM_SPEC, "02 08 02 02 96 00 48 EC")
    val excessFieldData = Fixture("Watts+Rpm reply with an extra byte", Provenance.SYNTHETIC_FROM_SPEC, "02 0A 02 02 96 00 48 00 01 EF")
    val wrongDevice = Fixture("Watts+Rpm reply from device 4", Provenance.SYNTHETIC_FROM_SPEC, "04 09 02 02 96 00 48 00 EF")
    val wrongCommand = Fixture("Watts+Rpm data under DeviceInfo command", Provenance.SYNTHETIC_FROM_SPEC, "02 09 81 02 96 00 48 00 6C")
    val lockoutInvalid = Fixture("IdleModeLockout = 2", Provenance.SYNTHETIC_FROM_SPEC, "02 06 02 02 02 0E")
    val lockoutSentinel = Fixture("IdleModeLockout = 0xFF", Provenance.SYNTHETIC_FROM_SPEC, "02 06 02 02 FF 0B")
    val modeSleep = Fixture("WorkoutMode = 12", Provenance.SYNTHETIC_FROM_SPEC, "02 06 02 02 0C 18")
    val modeUnlisted = Fixture("WorkoutMode = 50", Provenance.SYNTHETIC_FROM_SPEC, "02 06 02 02 32 3E")
    val resistanceOneByte = Fixture("Resistance reply, one data byte", Provenance.SYNTHETIC_FROM_SPEC, "02 06 02 02 05 11")
    val resistanceTwoBytes = Fixture("Resistance reply, two data bytes", Provenance.SYNTHETIC_FROM_SPEC, "02 07 02 02 05 00 12")
}

object IdentityFixtures {
    val deviceInfoRequest = Fixture("DeviceInfo request on MAIN", Provenance.SYNTHETIC_FROM_SPEC, "02 04 81 87")
    val systemInfoRequest = Fixture("SystemInfo request on MAIN", Provenance.SYNTHETIC_FROM_SPEC, "02 06 82 00 00 8A")
    val versionInfoRequest = Fixture("VersionInfo request on MAIN", Provenance.SYNTHETIC_FROM_SPEC, "02 06 84 00 00 8C")
    val deviceInfo = Fixture("DeviceInfo sw=86 serial=123456789", Provenance.SYNTHETIC_FROM_SPEC, "02 0B 81 02 56 00 15 CD 5B 07 2A")
    val systemInfo =
        Fixture("SystemInfo model=40111 part=401234", Provenance.SYNTHETIC_FROM_SPEC, "02 10 82 02 00 00 00 AF 9C 00 00 52 1F 06 00 58")
    val versionInfo = Fixture("VersionInfo mlv=84", Provenance.SYNTHETIC_FROM_SPEC, "02 06 84 02 54 E2")
    val deviceInfoForFixup =
        Fixture("DeviceInfo sw=86 serial=0x0F0F1234", Provenance.SYNTHETIC_FROM_SPEC, "02 0B 81 02 56 00 34 12 0F 0F 4A")
    val systemInfoMisreportedPart =
        Fixture(
            "SystemInfo model=39915 part=370357 (documented fix-up case)",
            Provenance.SYNTHETIC_FROM_SPEC,
            "02 10 82 02 00 00 00 EB 9B 00 00 B5 A6 05 00 7C",
        )
    val verifySecurityRequest =
        Fixture(
            "VerifySecurity for serial=123456789 part=401234 model=40111 mlv=84",
            Provenance.INDEPENDENT_REFERENCE_COMPUTATION,
            "02 28 90 07 62 02 CC 05 3E F4 B8 09 3A 8B 4C 72 46 47 B4 17 11 40 14 15 CE 17 88 19 1A 1B 04 E2 F6 CC E0 A0 02 00 00 23",
        )
    val verifySecurityRequestFitnessBike =
        Fixture(
            "VerifySecurity FitnessBike=7 same identity as Shire.Core 1.0.6451.31616 CalculateSecurityHash",
            Provenance.INDEPENDENT_REFERENCE_COMPUTATION,
            "07 28 90 07 62 02 CC 05 3E F4 B8 09 3A 8B 4C 72 46 47 B4 17 11 40 14 15 CE 17 88 19 1A 1B 04 E2 F6 CC E0 A0 02 00 00 28",
        )
    val verifyUnlockedWithKey = Fixture("VerifySecurity Done key=0x5A", Provenance.SYNTHETIC_FROM_SPEC, "02 06 90 02 5A F4")
    val verifyUnlockedNoKey = Fixture("VerifySecurity Done without data", Provenance.SYNTHETIC_FROM_SPEC, "02 05 90 02 99")
    val verifySecurityBlock = Fixture("VerifySecurity SecurityBlock", Provenance.SYNTHETIC_FROM_SPEC, "02 05 90 08 9F")
    val verifyCommandNotSupported = Fixture("VerifySecurity CmdNotSupported", Provenance.SYNTHETIC_FROM_SPEC, "02 05 90 01 98")
    val verifyFailed = Fixture("VerifySecurity Failed", Provenance.SYNTHETIC_FROM_SPEC, "02 05 90 04 9B")

    fun deviceInfo(softwareVersion: Int, serial: Long): ByteArray =
        frame(0x02, 0x81, 0x02, softwareVersion, 0x00, *le32(serial))

    fun systemInfo(model: Long, part: Long): ByteArray =
        frame(0x02, 0x82, 0x02, 0x00, 0x00, 0x00, *le32(model), *le32(part))

    private fun le32(v: Long): IntArray = IntArray(4) { ((v ushr (8 * it)) and 0xFF).toInt() }

    fun frame(device: Int, command: Int, status: Int, vararg data: Int): ByteArray {
        val length = 4 + data.size + 1
        val out = ByteArray(length)
        out[0] = device.toByte()
        out[1] = length.toByte()
        out[2] = command.toByte()
        out[3] = status.toByte()
        data.forEachIndexed { i, b -> out[4 + i] = b.toByte() }
        out[length - 1] = (out.take(length - 1).sumOf { it.toInt() and 0xFF } and 0xFF).toByte()
        return out
    }
}

object SecurityVectors {
    class Vector(val serial: Long, val part: Long, val model: Long, val hash: String, val provenance: Provenance)

    val all: List<Vector> = listOf(
        Vector(0x00000000L, 0x00000000L, 0x00000000L, "0100050811182D304150658891B8DDE001204568B1D8ED304190A5E83178BDC0", Provenance.INDEPENDENT_REFERENCE_COMPUTATION),
        Vector(0xFFFFFFFFL, 0x12345678L, 0x00000000L, "35188E4226974F2C1B030F0E8CCEEFE025089E5236875F3C0B131F1E1C1E1F20", Provenance.INDEPENDENT_REFERENCE_COMPUTATION),
        Vector(0x0F0F1234L, 374677L, 39915L, "EADA02BC05069098828A8C845D9E98B014101214FE160028191A1B1CD6EE0860", Provenance.INDEPENDENT_REFERENCE_COMPUTATION),
        Vector(123456789L, 401234L, 40111L, "076202CC053EF4B8093A8B4C724647B41711401415CE1788191A1B04E2F6CCE0", Provenance.INDEPENDENT_REFERENCE_COMPUTATION),
        Vector(0x80000001L, 0xDEADBEEFL, 0x7FFFFFFFL, "AC02000C0A1E2438365A687482A6CCF0EE32507C9AAEF408266AB8C412569CDF", Provenance.INDEPENDENT_REFERENCE_COMPUTATION),
        Vector(0x80000000L, 0x80000000L, 0x00000000L, "0100050811182D304150658891B8DDE001204568B1D8ED304190A5E83178BDDF", Provenance.INDEPENDENT_REFERENCE_COMPUTATION),
        Vector(0xFFFFFFFFL, 0xFFFFFFFFL, 0xFFFFFFFFL, "FEFDFCFBFAF9F8F7F6F5F4F3F2F1F0EFEEEDECEBEAE9E8E7E6E5E4E3E2E1E0DF", Provenance.INDEPENDENT_REFERENCE_COMPUTATION),
        Vector(0x0000FFFFL, 0x80000000L, 0x00000000L, "010203040506070889CAEBFCF5F2F1EF01204568B1D8ED304190A5E83178BDC0", Provenance.INDEPENDENT_REFERENCE_COMPUTATION),
        Vector(0xFFFF0000L, 0x80000000L, 0x00000000L, "0100050811182D304150658891B8DDE0111213141516171899DAFBECE5E2E1DF", Provenance.INDEPENDENT_REFERENCE_COMPUTATION),
        Vector(0x00000001L, 0x7FFFFFFFL, 0x80000000L, "FE00050811182D304150658891B8DDE001204568B1D8ED304190A5E83178BDC0", Provenance.INDEPENDENT_REFERENCE_COMPUTATION),
    )

    val zeroIdentityLeadingBytes: Fixture =
        Fixture("hash(0,0,0) bytes 0..3 derived by hand: (b+1) xor ((b+1)*b)", Provenance.HAND_DERIVED, "01 00 05 08")
}

fun hex(bytes: ByteArray): String = Hex.format(bytes)
