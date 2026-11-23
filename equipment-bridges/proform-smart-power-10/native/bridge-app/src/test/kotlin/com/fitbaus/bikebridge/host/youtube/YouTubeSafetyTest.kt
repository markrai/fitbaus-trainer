// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class YouTubeSafetyTest {
    private val youtubeSources: List<File> = listOf(
        File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube"),
        File("src/main/java/com/fitbaus/bikebridge/host/youtube"),
    ).flatMap { dir -> dir.walkTopDown().filter { it.isFile && (it.name.endsWith(".kt") || it.name.endsWith(".java")) }.toList() }

    @Test
    fun youTubeCodeNeverReachesEquipmentControlCameraOrServices() {
        assertTrue(youtubeSources.size >= 9, "found ${youtubeSources.map { it.name }}")
        val forbidden = listOf(
            "NativeBridgeService", "NativeUsbSession", "NativeHttpServer", "BridgeProcess", "UsbManager", "UsbDevice",
            "Resistance", "resistance", "equipment-protocol", "com.fitbaus.bikebridge.protocol", "com.fitbaus.arcade",
            "ArcadeCameraSession", "android.hardware.Camera", "CAMERA", "requestPermissions", "startService",
            "startForegroundService", "stopService", "bindService", "UvcProcess", "PairingActivity",
        )
        for (file in youtubeSources) {
            val text = file.readText()
            for (token in forbidden) assertFalse(text.contains(token), "${file.name} references $token")
        }
    }

    @Test
    fun youTubeCodeHasNoInlineComments() {
        for (file in youtubeSources.filter { it.name.endsWith(".kt") }) {
            val body = file.readText().substringAfter("\npackage ")
            assertFalse(Regex("""(^|\s)//""").containsMatchIn(body.replace("https://", "").replace("http://", "")), "${file.name} has an inline comment")
            assertFalse(body.contains("/*"), "${file.name} has a block comment after the header")
        }
    }

    @Test
    fun adaptedUpstreamFilesKeepTheirAttribution() {
        val adapted = mapOf(
            "YouTubeStreamSelector.kt" to listOf("SPDX-License-Identifier: GPL-3.0-only", "StreamSelectionPolicy.java", "Copyright (C) 2020  Zsombor Gegesy", "Modified for FitBaus"),
            "NewPipeYouTubeCatalog.kt" to listOf("SPDX-License-Identifier: GPL-3.0-only", "NewPipeService.java", "VideoPager.java", "Copyright (C) 2019  Zsombor Gegesy", "Modified for FitBaus"),
            "YouTubeMediaSources.kt" to listOf("SPDX-License-Identifier: GPL-3.0-only", "DatasourceBuilder.java", "PlayerDataSource.java", "Modified for FitBaus"),
            "YoutubeHttpDataSource.java" to listOf("Apache License, Version 2.0", "GPL-3.0-only AND Apache-2.0", "The Android Open Source Project", "NewPipe", "Modified for FitBaus"),
        )
        for ((name, markers) in adapted) {
            val file = youtubeSources.single { it.name == name }
            val text = file.readText()
            for (marker in markers) assertTrue(text.contains(marker), "$name keeps $marker")
            assertTrue(text.contains("bf559833ec3ddcc8d10cea38a7e15a5487318563"), "$name pins the SkyTube revision")
        }
        for (file in youtubeSources.filter { it.name !in adapted.keys }) {
            assertTrue(file.readText().startsWith("// SPDX-License-Identifier: AGPL-3.0-only"), "${file.name} is FitBaus-owned")
        }
    }

    @Test
    fun manifestPermissionsIncludeOnDemandVoiceButPreserveBridgeIdentity() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val permissions = Regex("""<uses-permission\s+android:name="([^"]+)"\s*/>""").findAll(manifest).map { it.groupValues[1] }.toList()
        assertEquals(
            listOf(
                "android.permission.INTERNET",
                "android.permission.RECORD_AUDIO",
                "android.permission.RECEIVE_BOOT_COMPLETED",
                "android.permission.FOREGROUND_SERVICE",
                "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE",
            ),
            permissions,
        )
        assertFalse(manifest.contains("YouTube"), "no separate YouTube activity or launcher")
        assertTrue(manifest.contains("android:process=\":speech\""))
        assertTrue(manifest.contains("android:exported=\"false\""))
        assertTrue(
            Regex("""<uses-permission\s+android:name="android.permission.ACCESS_NETWORK_STATE"\s+tools:node="remove"\s*/>""").containsMatchIn(manifest),
            "ExoPlayer's network-state permission is stripped; NetworkTypeObserver tolerates its absence",
        )
        val build = File("build.gradle.kts").readText()
        assertTrue(build.contains("minSdk = 22"))
        assertTrue(build.contains("applicationId = if (isProduction) \"com.fitbaus.bikebridge\" else \"com.fitbaus.bikebridge.native\""))
    }

    @Test
    fun youTubeDependenciesArePinnedAndJitPackIsScopedToTwoModules() {
        val build = File("build.gradle.kts").readText()
        for (dependency in listOf(
            "com.github.SkyTubeTeam:NewPipeExtractor:skytube-2026-10-24",
            "com.google.android.exoplayer:exoplayer-core:2.19.1",
            "com.google.android.exoplayer:exoplayer-dash:2.19.1",
            "com.google.android.exoplayer:exoplayer-hls:2.19.1",
            "com.android.tools:desugar_jdk_libs:2.0.2",
        )) assertTrue(build.contains("\"$dependency\""), dependency)
        assertFalse(Regex("""implementation\("[^"]*:\+"\)|:latest\.|\[\d""").containsMatchIn(build), "no floating versions")
        assertFalse(build.contains("exoplayer-ui"))
        assertFalse(build.contains("okhttp"))
        val settings = File("../settings.gradle.kts").readText()
        assertTrue(settings.contains("exclusiveContent"))
        assertTrue(settings.contains("includeModule(\"com.github.SkyTubeTeam\", \"NewPipeExtractor\")"))
        assertTrue(settings.contains("includeModule(\"com.github.TeamNewPipe\", \"nanojson\")"))
        assertEquals(1, Regex("""jitpack\.io""").findAll(settings).count())
    }

    @Test
    fun noticeShipsWithTheApplication() {
        val build = File("build.gradle.kts").readText()
        assertTrue(build.contains("third-party/YOUTUBE-NOTICE"))
        val notice = File("third-party/YOUTUBE-NOTICE").readText()
        for (marker in listOf("SkyTube", "v3.003", "bf559833ec3ddcc8d10cea38a7e15a5487318563", "NewPipeExtractor", "skytube-2026-10-24", "ExoPlayer", "2.19.1", "Rhino", "jsoup", "nanojson", "protobuf", "desugar_jdk_libs", "Classpath Exception", "GNU General Public License")) {
            assertTrue(notice.contains(marker), marker)
        }
        for (license in listOf("GPL-3.0.txt", "Apache-2.0.txt", "MPL-2.0.txt", "MIT-jsoup.txt", "BSD-3-Clause-protobuf.txt", "GPL-2.0-with-classpath-exception.txt")) {
            assertTrue(File("third-party/licenses/$license").isFile, license)
        }
    }
}
