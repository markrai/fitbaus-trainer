// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class PassiveArcadeTest {
    private val hostArcadeDir = File("src/main/kotlin/com/fitbaus/bikebridge/host/arcade")
    private val sharedArcadeDir = File("../../../shared/arcade")

    private val forbidden = listOf(
        "setResistance",
        "ResistanceLimits",
        "ResistanceWrite",
        "ResistanceCommand",
        "NativeUsbSession",
        "NativeBridgeService",
        "NativeHttpServer",
        "BridgeProcess",
        "PairingToken",
        "api/v1/",
        "X-Fitbaus-Token",
        "HttpURLConnection",
        "java.net",
        "android.hardware.usb",
        "UsbManager",
        "bikebridge.protocol",
        "bikebridge.host.usb",
        "bikebridge.host.policy",
    )

    @Test
    fun hostArcadeSourcesNeverReferenceControlApis() {
        assertTrue(hostArcadeDir.isDirectory, "run from the bridge-app module directory")
        val files = hostArcadeDir.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertEquals(setOf("ArcadeMode.kt", "ExerciseHud.kt"), files.map { it.name }.toSet())
        val offenders = ArrayList<String>()
        for (file in files) {
            val text = file.readText()
            for (token in forbidden) {
                if (text.contains(token)) offenders += "${file.name}: $token"
            }
        }
        assertEquals(emptyList<String>(), offenders)
    }

    @Test
    fun hostUsesSharedArcadeOnlyThroughItsPublicFactory() {
        val activity = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        assertTrue(activity.contains("ArcadeCameraSession.forActivity("))
        assertTrue(activity.contains("externalCamera = ensureUvcCameraHost()"))
        assertTrue(activity.contains("UvcCameraHost("))
        assertTrue(activity.contains("uvcCameraHost?.close()"), "Activity must release UVC USB receiver on destroy")
        for (hidden in listOf(
            "Camera1Driver", "ArcadeCameraThread", "SerialCameraFrameSource", "ClassicalHandTracker", "TrackingFrameSink",
            "LandmarkHandTracker", "LandmarkFrameSink", "NativeHandModels", "NativeHandBridge", "HandModelBackend",
            "PreferExternalCameraFrameSource", "UvcNative",
        )) {
            assertFalse(activity.contains(hidden), hidden)
        }
    }

    @Test
    fun trackerSelectionIsDeveloperOnlyAndDefaultsToClassical() {
        val activity = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        assertTrue(activity.contains("settings = savedTrackerSettings()"))
        assertTrue(activity.contains("ArcadeTrackerSettings.fromKey("), "unknown or missing preference falls back to Classical")
        val longPress = Regex("""if \(mode\.isGame\) \{\s+tab\.setOnLongClickListener \{\s+showTrackerPicker\(mode\)""")
        assertTrue(longPress.containsMatchIn(activity), "picker only behind a long-press on a game tab")
        assertTrue(activity.contains("ArcadeTrackerSettings.FINGER_PRESETS"))
        assertTrue(activity.contains("ArcadeTrackerSettings.fingersFromKey("))
        assertTrue(activity.contains("ArcadeTrackerSettings.PRESETS"))
        assertFalse(activity.contains("tflite", ignoreCase = true), "no model or runtime details in the host")
    }

    @Test
    fun dependencyPointsFromBridgeToSharedArcadeOnly() {
        val settings = File("../settings.gradle.kts").readText()
        assertTrue(settings.contains("include(\":arcade\")"))
        assertTrue(settings.contains("project(\":arcade\").projectDir = file(\"../../shared/arcade\")"))
        assertTrue(sharedArcadeDir.resolve("build.gradle.kts").isFile, "shared arcade module at equipment-bridges/shared/arcade")
        val bridgeBuild = File("build.gradle.kts").readText()
        assertTrue(bridgeBuild.contains("implementation(project(\":arcade\"))"))
        val sharedBuild = sharedArcadeDir.resolve("build.gradle.kts").readText()
        assertFalse(sharedBuild.contains("project("))
        assertTrue(sharedBuild.contains("id(\"com.android.library\")"))
    }

    @Test
    fun bridgeIdentityAndUsbRequirementUnchanged() {
        val bridgeBuild = File("build.gradle.kts").readText()
        assertTrue(bridgeBuild.contains("id(\"com.android.application\")"))
        assertTrue(bridgeBuild.contains("applicationId = if (isProduction) \"com.fitbaus.bikebridge\" else \"com.fitbaus.bikebridge.native\""))
        assertTrue(bridgeBuild.contains("create(\"production\")"))
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val usb = Regex("""android:name="android\.hardware\.usb\.host"\s+android:required="true"""")
        assertTrue(usb.containsMatchIn(manifest), "bridge USB host requirement unchanged")
        assertEquals(1, Regex("""<service""").findAll(manifest).count(), "only the existing bridge service")
        assertFalse(manifest.contains("arcade", ignoreCase = true), "no arcade activity, service or launcher")
    }
}
