// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.report.DiagnosticReportWriter
import com.fitbaus.bikebridge.equipmentprobe.report.IdentityRedaction
import com.fitbaus.bikebridge.equipmentprobe.session.BasicProbeSequence
import com.fitbaus.bikebridge.equipmentprobe.session.ProbeEvent
import com.fitbaus.bikebridge.equipmentprobe.session.ProbePhase
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportResult
import com.fitbaus.bikebridge.protocol.EquipmentCommand
import com.fitbaus.bikebridge.protocol.EquipmentStatus
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class PrivacyAndSafetyTest {
    @TempDir
    lateinit var tempDir: File

    @Test
    fun reportRedactsIdentityValues() {
        val events = listOf(
            ProbeEvent.ResponseObserved(
                command = EquipmentCommand.DEVICE_INFO,
                status = EquipmentStatus.DONE,
                statusCode = 2,
                frameLength = 11,
                checksumValid = true,
                parseSummary = "Parsed",
                softwareVersion = 86,
                identityComponentsPresent = true,
                telemetryHex = null,
                durationMs = 12,
            ),
            ProbeEvent.Info(
                IdentityRedaction.summarizeIdentityPresence(
                    softwareVersion = 86,
                    serialPresent = true,
                    modelPresent = true,
                    partPresent = true,
                    masterLibraryPresent = true,
                ),
            ),
        )
        val file = DiagnosticReportWriter(tempDir).write(ProbePhase.BASIC, events, "ok")
        val text = file.readText()
        assertFalse(text.contains("123456789"))
        assertFalse(text.contains("serial="))
        assertTrue(text.contains("serialPresent=true"))
        assertTrue(text.contains("softwareVersion=86"))
    }

    @Test
    fun softwareVersionPresenceDoesNotHideSensitiveTokens() {
        assertTrue(IdentityRedaction.containsSensitiveToken("softwareVersion=86 serial=123456789"))
        assertTrue(IdentityRedaction.containsSensitiveToken("model=40111 softwareVersion=86"))
        assertTrue(IdentityRedaction.containsSensitiveToken("hash=abcd"))
        assertFalse(IdentityRedaction.containsSensitiveToken("softwareVersion=86 frameLength=11"))
    }

    @Test
    fun prefersFixedDiagnosticCategories() {
        assertEqualsSafe("usb_permission_denied", IdentityRedaction.safeDiagnosticMessage("usb_permission_denied"))
    }

    @Test
    fun malformedIdentityFrameDoesNotReportVerifiedChecksum() {
        val bad = hex("02 0B 81 02 56 00 15 CD 5B 07 2B")
        val transport = ScriptedTransport(listOf(TransportResult.Ok(bad)))
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        val observed = outcome.events.filterIsInstance<ProbeEvent.ResponseObserved>()
        assertTrue(observed.isNotEmpty())
        assertFalse(observed.first().checksumValid)
        assertTrue(observed.first().checksumEvaluated)
        assertEqualsSafe("CHECKSUM_MISMATCH", observed.first().frameRejection!!)
    }

    @Test
    fun probeSourcesDoNotReferenceAuthorizationSequenceOrVerifySecurityFactory() {
        val roots = listOf(File("src/main/kotlin"))
        val forbidden = listOf(
            "EquipmentRequests.verifySecurity",
            "EquipmentAuthorizationSequence",
            "import com.fitbaus.bikebridge.protocol.EquipmentAuthorization",
            "permitVerifySecurity",
            "allowVerifySecurity",
        )
        val files = roots.filter { it.exists() }.flatMap { it.walkTopDown().filter { f -> f.isFile && f.extension == "kt" }.toList() }
        assertTrue(files.isNotEmpty(), "expected probe kotlin sources")
        for (file in files) {
            val text = file.readText()
            for (token in forbidden) {
                assertFalse(text.contains(token), "${file.path} contains $token")
            }
        }
    }

    @Test
    fun probeSourcesDoNotImportProprietaryRuntimeNames() {
        val files = File("src/main/kotlin").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        for (file in files) {
            val text = file.readText()
            assertFalse(text.contains("Xamarin"))
            assertFalse(text.contains("Shire."))
            assertFalse(text.contains("FitPro"))
            assertFalse(text.contains("com.ifit"))
        }
    }

    private fun assertEqualsSafe(expected: String, actual: String) {
        assertTrue(expected == actual)
    }
}
