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
        assertEquals(setOf("ArcadeMode.kt", "ExerciseHud.kt", "ArcadeConfiguration.kt", "ArcadeTrackerPicker.kt"), files.map { it.name }.toSet())
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
        assertTrue(activity.contains("UvcProcess.acquire(this, this)"))
        assertTrue(activity.contains("zoomHook = UvcProcess.zoomHook(this)"))
        assertTrue(activity.contains("UvcProcess.release(this)"), "Activity must release shared UVC host on destroy")
        for (hidden in listOf(
            "Camera1Driver", "ArcadeCameraThread", "SerialCameraFrameSource", "ClassicalHandTracker", "TrackingFrameSink",
            "LandmarkHandTracker", "LandmarkFrameSink", "NativeHandModels", "NativeHandBridge", "HandModelBackend",
            "PreferExternalCameraFrameSource", "UvcNative",
        )) {
            assertFalse(activity.contains(hidden), hidden)
        }
    }

    @Test
    fun trackerSelectionIsDeveloperOnlyAndUsesSavedConfiguration() {
        val activity = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        assertTrue(activity.contains("settings = arcadeConfiguration.settingsFor(ArcadeMode.Bricks)"))
        assertTrue(activity.contains("cameraSession.updateSettings(arcadeConfiguration.settingsFor(game))"))
        val header = File("src/main/kotlin/com/fitbaus/bikebridge/host/BridgeNavigationHeader.kt").readText()
        val longPress = Regex("""if \(mode\.isGame\) \{\s+tab\.setOnLongClickListener \{\s+onTrackerPicker\(mode\)""")
        assertTrue(longPress.containsMatchIn(header), "picker only behind a long-press on a game tab")
        val picker = File("src/main/kotlin/com/fitbaus/bikebridge/host/arcade/ArcadeTrackerPicker.kt").readText()
        assertTrue(picker.contains("if (!game.isGame) return"))
        assertTrue(picker.contains("configuration.presetsFor(game)"))
        assertTrue(activity.contains("arcadeConfiguration.saveTracker(game, next)"))
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
        assertEquals(2, Regex("""<service""").findAll(manifest).count(), "bridge service and on-demand speech service")
        assertTrue(manifest.contains("android:name=\".NativeBridgeService\""))
        assertTrue(manifest.contains("android:name=\".speech.OfflineVoiceSearchService\""))
        assertTrue(manifest.contains("android:process=\":speech\""))
        assertTrue(Regex("""android:name="\.speech\.OfflineVoiceSearchService"\s+android:exported="false"\s+android:process=":speech" """.trim()).containsMatchIn(manifest))
        assertFalse(manifest.contains("arcade", ignoreCase = true), "no arcade activity, service or launcher")
    }
}
