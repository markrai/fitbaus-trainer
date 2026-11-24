package com.fitbaus.bikebridge.host

import java.io.File
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ShowcaseIsolationTest {
    private val host = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
    private val manifest = File("src/main/AndroidManifest.xml").readText()
    private val build = File("build.gradle.kts").readText()

    @Test
    fun showcaseCannotReplaceOrStartTheProductionBridge() {
        assertEquals("com.fitbaus.bikebridge.showcase", BuildConfig.APPLICATION_ID)
        assertFalse(BuildConfig.PRODUCTION_IDENTITY)
        assertTrue(build.contains("Temporary showcase branch cannot build production APKs"))
        for (token in listOf(".NativeBridgeService", ".BootReceiver", "USB_DEVICE_ATTACHED")) {
            assertFalse(manifest.contains(token), token)
        }
        assertTrue(manifest.contains(".speech.OfflineVoiceSearchService"))
        assertFalse(host.contains("startBridgeService()"))
        assertFalse(host.contains("startForegroundService("))
    }

    @Test
    fun showcaseTickUsesSyntheticInputsAndAllRealGameViews() {
        val tick = host.substringAfter("private fun arcadeTick()").substringBefore("private fun arcadeDiagnosticsText")
        assertTrue(tick.contains("showcase.telemetry()"))
        assertTrue(tick.contains("showcase.position("))
        for (view in listOf("math", "playground", "flak", "trail", "ghoul", "biketris")) {
            assertTrue(tick.contains("arcadeContent.$view.render"), view)
        }
        for (token in listOf("NativeBridgeService", "requestResistance", "setResistance", "UsbManager", "cameraSession", "exclusiveHid", "gameController")) {
            assertFalse(tick.contains(token), token)
        }
        val activation = host.substringAfter("override fun activateArcade").substringBefore("override fun deactivateArcade")
        assertTrue(activation.contains("arcadeClock.start()"))
        assertFalse(activation.contains("cameraSession.start()"))
    }

    @Test
    fun captureChecksPlaybackAndStopsOnPause() {
        assertTrue(host.contains("youtubeContent.showcasePlayed()"))
        assertTrue(host.contains("booksContent.showcasePlayed()"))
        assertTrue(host.contains("showcase.abort(\"activity paused\")"))
        assertTrue(host.contains("handler.removeCallbacks(showcaseStep)"))
    }
}
