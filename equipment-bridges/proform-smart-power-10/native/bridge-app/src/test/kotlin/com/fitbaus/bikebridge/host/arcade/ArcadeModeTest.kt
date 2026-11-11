// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class ArcadeModeTest {
    @Test
    fun startsInDashboardAndStaysInactiveOnResume() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        assertEquals(ArcadeMode.Dashboard, controller.mode)
        controller.onHostResume()
        controller.onHostPause()
        assertEquals(emptyList<String>(), hooks.events())
        assertFalse(controller.isActive)
    }

    @Test
    fun enterAndExitArcadeWhileResumed() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        controller.select(ArcadeMode.Bricks)
        assertEquals(listOf("show:Bricks", "activate:Bricks"), hooks.events())
        assertTrue(controller.isActive)
        hooks.clear()
        controller.select(ArcadeMode.Dashboard)
        assertEquals(listOf("deactivate:ExitArcade", "show:Dashboard"), hooks.events())
        assertFalse(controller.isActive)
    }

    @Test
    fun reselectingCurrentModeIsNoOp() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        controller.select(ArcadeMode.Dashboard)
        controller.select(ArcadeMode.Bricks)
        controller.select(ArcadeMode.Bricks)
        assertEquals(listOf("show:Bricks", "activate:Bricks"), hooks.events())
    }

    @Test
    fun switchingGamesStopsThePreviousPipelineFirst() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        controller.select(ArcadeMode.Bricks)
        controller.select(ArcadeMode.Math)
        assertEquals(ArcadeMode.Math, controller.mode)
        assertTrue(controller.isActive)
        controller.select(ArcadeMode.Dashboard)
        assertEquals(
            listOf("show:Bricks", "activate:Bricks", "deactivate:ExitArcade", "show:Math", "activate:Math", "deactivate:ExitArcade", "show:Dashboard"),
            hooks.events(),
        )
    }

    @Test
    fun switchingToFlakRunStopsTheFingerPipelineFirst() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        controller.select(ArcadeMode.Math)
        controller.select(ArcadeMode.Flak)
        controller.select(ArcadeMode.Bricks)
        assertEquals(
            listOf(
                "show:Math", "activate:Math", "deactivate:ExitArcade", "show:Flak", "activate:Flak",
                "deactivate:ExitArcade", "show:Bricks", "activate:Bricks",
            ),
            hooks.events(),
        )
    }

    @Test
    fun flakRunHasItsOwnFaceTrackerPreference() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        assertTrue(source.contains("ArcadeMode.Flak -> savedFlakSettings()"))
        assertTrue(source.contains("ArcadeTrackerSettings.faceFromKey("))
        assertTrue(source.contains("const val ARCADE_FLAK_TRACKER_KEY = \"flak_tracker\""))
        val flakBranch = source.substring(source.indexOf("if (modeController.mode == ArcadeMode.Flak) {"), source.indexOf("val position = handInput.latest(now)"))
        for (forbidden in listOf("Resistance", "requestResistance", "setResistance", "UsbManager")) assertFalse(flakBranch.contains(forbidden), forbidden)
    }

    @Test
    fun onlyGameModesActivate() {
        assertFalse(ArcadeMode.Dashboard.isGame)
        assertTrue(ArcadeMode.Bricks.isGame)
        assertTrue(ArcadeMode.Math.isGame)
        assertTrue(ArcadeMode.Flak.isGame)
        assertEquals(listOf("DASHBOARD", "BRICKS", "MATH", "FLAK RUN"), ArcadeMode.values().map { it.caption })
    }

    @Test
    fun pauseAndResumeStopAndRestartArcadeOnly() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        controller.select(ArcadeMode.Bricks)
        hooks.clear()
        controller.onHostPause()
        controller.onHostPause()
        controller.onHostResume()
        controller.onHostResume()
        assertEquals(listOf("deactivate:HostPaused", "activate:Bricks"), hooks.events())
        assertEquals(ArcadeMode.Bricks, controller.mode)
    }

    @Test
    fun selectingArcadeWhilePausedActivatesOnResume() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        controller.select(ArcadeMode.Bricks)
        assertEquals(listOf("show:Bricks"), hooks.events())
        controller.onHostResume()
        assertEquals(listOf("show:Bricks", "activate:Bricks"), hooks.events())
    }

    @Test
    fun destroyReleasesAndIgnoresLaterCalls() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        controller.select(ArcadeMode.Bricks)
        hooks.clear()
        controller.onHostDestroy()
        controller.onHostResume()
        controller.select(ArcadeMode.Dashboard)
        assertEquals(listOf("deactivate:HostDestroyed"), hooks.events())
    }

    @Test
    fun activityModeSwitchDoesNotTouchBridgeService() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        assertEquals(3, Regex("""startBridgeService\(\)""").findAll(source).count(), "definition + onCreate + onNewIntent only")
        assertFalse(source.contains("stopService"))
        val hooksStart = source.indexOf("object : ArcadeModeHooks")
        assertTrue(hooksStart > 0)
        val hooksBody = source.substring(hooksStart, source.indexOf("private val modeController", hooksStart))
        for (forbidden in listOf("startBridgeService", "NativeBridgeService", "startService", "startForegroundService", "session()")) {
            assertFalse(hooksBody.contains(forbidden), forbidden)
        }
        assertTrue(source.contains("tabGroup(ArcadeMode.Dashboard)"))
        assertTrue(source.contains("tabGroup(ArcadeMode.Bricks, ArcadeMode.Math, ArcadeMode.Flak)"))
        assertFalse(source.contains("\"ARCADE\""))
        assertNotNull(Regex("""setOnLongClickListener""").find(source), "long-press FITBAUS still opens pairing")
        assertTrue(source.contains("PairingActivity::class.java"))
    }
}
