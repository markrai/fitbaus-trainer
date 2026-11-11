// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SafetyBoundaryTest {
    @Test
    fun commandSetIsExactlyTheReadOnlyAndAuthenticationAllowlist() {
        assertEquals(setOf(2, 129, 130, 132, 144), EquipmentCommand.entries.map { it.id }.toSet())
    }

    @Test
    fun firmwareCalibrationTestAndRawCommandsAreUnrepresentable() {
        for (prohibited in listOf(3, 4, 5, 6, 9, 56, 112, 113, 128, 136, 137, 146, 255)) {
            assertNull(EquipmentCommand.fromId(prohibited), "command $prohibited")
        }
    }

    @Test
    fun resistanceFieldsCannotBeEncodedOrDecodedNumerically() {
        assertFalse(BikeField.RESISTANCE.isResolved)
        assertFalse(BikeField.ACTUAL_RESISTANCE.isResolved)
        assertTrue(FieldDecoder.decode(BikeField.RESISTANCE, byteArrayOf(5)) is FieldValue.Undecoded)
    }

    @Test
    fun publicRequestTypesHaveNoPublicConstructors() {
        for (type in listOf(
            ReadWriteDataRequest::class.java,
            DeviceInfoRequest::class.java,
            SystemInfoRequest::class.java,
            VersionInfoRequest::class.java,
            VerifySecurityRequest::class.java,
        )) {
            assertEquals(emptyList(), type.constructors.filter { !it.isSynthetic }, type.simpleName)
        }
    }

    @Test
    fun mainSourcesHaveNoPlatformTransportOrNetworkDependencies() {
        val root = File("src/main/kotlin")
        assertTrue(root.isDirectory, "run from the module directory")
        val forbidden = listOf("import android.", "import java.net", "import java.nio.channels", "import javax.", "UsbManager", "Shire", "FitPro", "Xamarin")
        val offenders = root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .flatMap { file -> forbidden.filter { file.readText().contains(it) }.map { "${file.name}: $it" } }
            .toList()
        assertEquals(emptyList(), offenders)
    }
}
