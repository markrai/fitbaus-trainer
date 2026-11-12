// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class PassiveArcadeTest {
    private val sourceDir = File("src/main/kotlin/com/fitbaus/arcade")

    private fun sources(): List<File> {
        assertTrue(sourceDir.isDirectory, "run from the shared arcade module directory")
        return sourceDir.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
    }

    private val forbidden = listOf(
        "com.fitbaus.bikebridge",
        "BridgeUiStateMapper",
        "setResistance",
        "Resistance",
        "NativeUsbSession",
        "NativeBridgeService",
        "NativeHttpServer",
        "PairingToken",
        "api/v1/",
        "X-Fitbaus-Token",
        "HttpURLConnection",
        "java.net",
        "android.hardware.usb",
        "UsbManager",
    )

    @Test
    fun sharedSourcesNeverReferenceEquipmentHostOrControlApis() {
        val files = sources()
        assertTrue(files.size >= 8, "expected arcade sources, found ${files.map { it.name }}")
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
    fun sharedSourcesImportOnlyPlatformAndOwnPackage() {
        val allowedPrefixes = listOf(
            "import android.",
            "import java.io.IOException",
            "import java.io.File",
            "import java.util.Locale",
            "import java.util.concurrent.Semaphore",
            "import java.util.concurrent.TimeUnit",
            "import java.util.concurrent.atomic.",
            "import java.util.concurrent.locks.",
            "import kotlin.",
            "import com.fitbaus.arcade.",
        )
        val offenders = sources()
            .flatMap { file -> file.readLines().filter { it.startsWith("import ") }.map { file.name to it } }
            .filter { (_, line) -> allowedPrefixes.none { line.startsWith(it) } }
            .map { (name, line) -> "$name: $line" }
        assertEquals(emptyList<String>(), offenders)
    }

    @Test
    fun publicApiIsLimitedToHostIntegrationTypes() {
        val declaration = Regex("""^public\s+(?:data\s+|enum\s+|sealed\s+|fun\s+)?(?:class|object|interface)\s+(\w+)""", RegexOption.MULTILINE)
        val exposed = sources().flatMap { file -> declaration.findAll(file.readText()).map { it.groupValues[1] }.toList() }.toSortedSet()
        assertEquals(
            sortedSetOf(
                "ArcadeCameraInfo",
                "ArcadeCameraSession",
                "ArcadePreview",
                "ArcadeClock",
                "ArcadeStatus",
                "ArcadeStatusResolver",
                "ArcadeStopReason",
                "ArcadeTrackerDiagnostics",
                "ArcadeTrackerMode",
                "ArcadeTrackerSettings",
                "AuthorizedCameraFd",
                "BikeMotion",
                "BikeMotionMonitor",
                "CameraRegion",
                "CameraState",
                "ExternalCameraProvider",
                "FingerCountInput",
                "FingerMathView",
                "FlakView",
                "HandPosition",
                "HandPositionInput",
                "HandSource",
                "PlaygroundView",
                "RateMeter",
                "TrailRideView",
            ),
            exposed,
        )
        val topLevel = Regex("""^(?:internal\s+|private\s+|public\s+)?(?:data\s+|enum\s+|sealed\s+)?(?:class|object|interface)\s+(\w+)""", RegexOption.MULTILINE)
        val unmarked = sources().flatMap { file ->
            topLevel.findAll(file.readText()).filter { !it.value.startsWith("internal") && !it.value.startsWith("public") && !it.value.startsWith("private") }
                .map { "${file.name}: ${it.groupValues[1]}" }.toList()
        }
        assertEquals(emptyList<String>(), unmarked, "every top-level type states its visibility")
        for (hidden in listOf(
                "Camera1Driver", "ArcadeCameraThread", "SerialCameraFrameSource", "ClassicalHandTracker", "TrackerConfig",
                "TrackingFrameSink", "ActivityCameraPermission", "LandmarkHandTracker", "LandmarkFrameSink", "NativeHandModels",
                "NativeHandBridge", "HandModelBackend", "FaceTracker", "NativeFrameTracker",
                "FingerTracker", "FingerClassifier", "FingerMathGame", "FingerObservation", "FingerCountReading",
            )) {
            assertFalse(hidden in exposed, hidden)
        }
    }

    @Test
    fun sessionConstructorIsNotPublic() {
        val text = File(sourceDir, "ArcadeCameraSession.kt").readText()
        assertTrue(text.contains("public class ArcadeCameraSession internal constructor("))
        assertTrue(text.contains("public fun forActivity("))
    }

    @Test
    fun internalTypesExposeNoResistanceSeam() {
        val classes = listOf(
            ArcadeCameraSession::class.java,
            HandPositionInput::class.java,
            ClassicalHandTracker::class.java,
            TrackingFrameSink::class.java,
            SerialCameraFrameSource::class.java,
            LandmarkHandTracker::class.java,
            LandmarkFrameSink::class.java,
        )
        for (type in classes) {
            for (method in type.declaredMethods) {
                assertFalse(method.name.contains("resistance", ignoreCase = true), "${type.simpleName}.${method.name}")
                for (param in method.parameterTypes) {
                    assertFalse(param.name.contains("Resistance") || param.name.contains("bikebridge"), "${type.simpleName}.${method.name}($param)")
                }
            }
            for (ctor in type.declaredConstructors) {
                for (param in ctor.parameterTypes) {
                    assertFalse(param.name.contains("Resistance") || param.name.contains("bikebridge"), "${type.simpleName}($param)")
                }
            }
        }
    }

    @Test
    fun libraryManifestOwnsOptionalCamera() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android.permission.CAMERA"))
        val camera = Regex("""android:name="android\.hardware\.camera"\s+android:required="false"""")
        assertTrue(camera.containsMatchIn(manifest), "camera feature must be optional")
        assertFalse(manifest.contains("<application"), "library declares no components")
        assertFalse(manifest.contains("usb"))
    }

    @Test
    fun buildIsAnApi22LibraryWithNoProjectDependencies() {
        val build = File("build.gradle.kts").readText()
        assertTrue(build.contains("id(\"com.android.library\")"))
        assertFalse(build.contains("com.android.application"))
        assertTrue(build.contains("namespace = \"com.fitbaus.arcade\""))
        assertTrue(build.contains("minSdk = 22"))
        assertFalse(build.contains("project("), "shared arcade must not depend on any equipment module")
    }

    @Test
    fun nativeSourcesStayEquipmentIndependent() {
        val cpp = File("src/main/cpp")
        val files = cpp.walkTopDown().filter { it.isFile && (it.extension == "c" || it.extension == "h" || it.name == "CMakeLists.txt") }.toList()
        assertEquals(
            setOf(
                "CMakeLists.txt",
                "arcade_jni.c",
                "hand_pipeline.c",
                "hand_pipeline.h",
                "uvc_jni.c",
                "yuyv_nv21.c",
                "yuyv_nv21.h",
            ),
            files.map { it.name }.toSet(),
        )
        val offenders = files.flatMap { f -> forbidden.filter { f.readText().contains(it) }.map { "${f.name}: $it" } }
        assertEquals(emptyList<String>(), offenders)
        val jni = File(cpp, "arcade_jni.c").readText()
        assertEquals(7, Regex("""JNICALL Java_com_fitbaus_arcade_NativeHandBridge_native\w+""").findAll(jni).count())
        val uvc = File(cpp, "uvc_jni.c").readText()
        assertTrue(uvc.contains("Java_com_fitbaus_arcade_UvcNative_open"))
        assertTrue(uvc.contains("Java_com_fitbaus_arcade_UvcNative_close"))
        assertTrue(uvc.contains("LIBUSB_OPTION_NO_DEVICE_DISCOVERY"))
        assertTrue(File(cpp, "yuyv_nv21.c").readText().contains("yuyv_to_nv21"))
    }

    @Test
    fun bundledModelsMatchTheBenchmarkedFiles() {
        val expected = mapOf(
            "palm_detection_lite.tflite" to "e9a4aaddf90dda56a87235303cf00e4c2d3fb28725f68fd88772997dac905c18",
            "hand_landmark_lite.tflite" to "d7fde8ac11f8ce03f8663775bfc323f4fc9f2a38062b4f4efa142874ef5b2a48",
            "face_detection_short_range.tflite" to "3bc182eb9f33925d9e58b5c8d59308a760f4adea8f282370e428c51212c26633",
        )
        for ((name, sha) in expected) {
            val bytes = File("src/main/assets/arcade/$name").readBytes()
            val digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            assertEquals(sha, digest, name)
        }
        val notice = File("src/main/assets/licenses/arcade/NOTICE.txt").readText()
        assertTrue(notice.contains("Apache License, Version 2.0"))
        expected.values.forEach { assertTrue(notice.contains(it)) }
        assertTrue(File("src/main/assets/licenses/arcade/Apache-2.0.txt").readText().contains("END OF TERMS AND CONDITIONS"))
        assertTrue(notice.contains("libusb 1.0.30"))
        assertTrue(notice.contains("libuvc"))
        assertTrue(notice.contains("LGPL-2.1"))
        assertTrue(File("src/main/assets/licenses/arcade/LGPL-2.1.txt").readText().contains("GNU LESSER GENERAL PUBLIC LICENSE"))
        assertTrue(File("src/main/assets/licenses/arcade/BSD-libuvc.txt").readText().contains("BSD License"))
    }

    @Test
    fun nativeBuildPinsTheVerifiedRuntime() {
        val build = File("build.gradle.kts").readText()
        assertTrue(build.contains("?: \"2.16.1\""), "TFLite 2.16.1 is the verified API-22 x86 runtime")
        assertTrue(build.contains("ndkVersion = \"26.1.10909125\""))
        assertTrue(build.contains("?: \"x86\")"), "default ABI is the console's x86")
        assertTrue(build.contains("val maxRuntimeApi = 22"))
        assertTrue(build.contains("LIBC_O"))
        assertFalse(build.contains("implementation(\"org.tensorflow"), "only the native runtime is bundled, not the Java API")
    }
}
