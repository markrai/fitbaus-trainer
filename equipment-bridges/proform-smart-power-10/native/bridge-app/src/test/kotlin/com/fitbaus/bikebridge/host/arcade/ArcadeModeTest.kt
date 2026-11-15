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
    fun switchingToTrailRideStopsTheFlakPipelineFirstAndBack() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        controller.select(ArcadeMode.Flak)
        controller.select(ArcadeMode.TrailRide)
        controller.onHostPause()
        controller.onHostResume()
        controller.select(ArcadeMode.Dashboard)
        assertEquals(
            listOf(
                "show:Flak", "activate:Flak", "deactivate:ExitArcade", "show:TrailRide", "activate:TrailRide",
                "deactivate:HostPaused", "activate:TrailRide", "deactivate:ExitArcade", "show:Dashboard",
            ),
            hooks.events(),
        )
        assertFalse(controller.isActive)
    }

    @Test
    fun onlyOnePipelineIsEverActiveAcrossAllGames() {
        var active = 0
        var maxActive = 0
        val hooks = RecordingHooks()
        hooks.onActivate = {
            active += 1
            maxActive = maxOf(maxActive, active)
        }
        hooks.onDeactivate = { active -= 1 }
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        for (mode in listOf(ArcadeMode.TrailRide, ArcadeMode.Bricks, ArcadeMode.Biketris, ArcadeMode.TrailRide, ArcadeMode.Math, ArcadeMode.Biketris, ArcadeMode.Flak, ArcadeMode.TrailRide)) {
            controller.select(mode)
        }
        controller.onHostDestroy()
        assertEquals(1, maxActive)
        assertEquals(0, active)
    }

    @Test
    fun trailRideHasItsOwnFaceTrackerPreferenceAndStaysReadOnly() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        assertTrue(source.contains("ArcadeMode.TrailRide -> savedTrailSettings()"))
        assertTrue(source.contains("ArcadeMode.TrailRide -> ARCADE_TRAIL_TRACKER_KEY"))
        assertTrue(source.contains("const val ARCADE_TRAIL_TRACKER_KEY = \"trail_tracker\""))
        assertTrue(source.contains("ArcadeTrackerSettings.faceFromKey(getSharedPreferences(ARCADE_DEV_PREFS, Context.MODE_PRIVATE).getString(ARCADE_TRAIL_TRACKER_KEY, null))"))
        val start = source.indexOf("if (modeController.mode == ArcadeMode.TrailRide) {")
        assertTrue(start > 0)
        val trailBranch = source.substring(start, source.indexOf("val position = handInput.latest(now)", start))
        assertTrue(trailBranch.contains("arcadeContent.trail.render("))
        for (forbidden in listOf("Resistance", "requestResistance", "setResistance", "UsbManager", "session()", "startService")) {
            assertFalse(trailBranch.contains(forbidden), forbidden)
        }
        val content = File("src/main/kotlin/com/fitbaus/bikebridge/host/arcade/ExerciseHud.kt").readText()
        assertTrue(content.contains("trail.visibility = if (game == ArcadeMode.TrailRide) VISIBLE else GONE"))
    }

    @Test
    fun switchingToBiketrisStopsThePreviousPipelineFirstAndBack() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        controller.select(ArcadeMode.TrailRide)
        controller.select(ArcadeMode.Biketris)
        controller.onHostPause()
        controller.onHostResume()
        controller.select(ArcadeMode.Bricks)
        assertEquals(
            listOf(
                "show:TrailRide", "activate:TrailRide", "deactivate:ExitArcade", "show:Biketris", "activate:Biketris",
                "deactivate:HostPaused", "activate:Biketris", "deactivate:ExitArcade", "show:Bricks", "activate:Bricks",
            ),
            hooks.events(),
        )
    }

    @Test
    fun biketrisUsesItsOwnFaceTrackerAndWaveDetectionOnlyWhileSelected() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        assertTrue(source.contains("ArcadeMode.Biketris -> savedBiketrisSettings()"))
        assertTrue(source.contains("ArcadeMode.Biketris -> ARCADE_BIKETRIS_TRACKER_KEY"))
        assertTrue(source.contains("const val ARCADE_BIKETRIS_TRACKER_KEY = \"biketris_tracker\""))
        assertTrue(source.contains("ArcadeTrackerSettings.faceFromKey(getSharedPreferences(ARCADE_DEV_PREFS, Context.MODE_PRIVATE).getString(ARCADE_BIKETRIS_TRACKER_KEY, null))"))
        for (other in listOf("ArcadeMode.Math -> savedMathSettings()", "ArcadeMode.Flak -> savedFlakSettings()", "ArcadeMode.TrailRide -> savedTrailSettings()", "else -> savedTrackerSettings()")) {
            assertTrue(source.contains(other), other)
        }
        val hooksStart = source.indexOf("object : ArcadeModeHooks")
        val hooksBody = source.substring(hooksStart, source.indexOf("private val modeController", hooksStart))
        assertTrue(hooksBody.contains("cameraSession.enableWaveGestures(game == ArcadeMode.Biketris)"))
        assertTrue(hooksBody.indexOf("enableWaveGestures") < hooksBody.indexOf("cameraSession.start()"), "configured before the session starts")
        assertTrue(hooksBody.contains("arcadeContent.biketris.pause()"))
        assertEquals(1, Regex("""ArcadeCameraSession\.forActivity\(""").findAll(source).count(), "one camera session for every game")
        assertTrue(source.contains("arcadeContent.biketris.gestures = cameraSession.gestures"))
        assertTrue(source.contains("game == ArcadeMode.Flak || game == ArcadeMode.TrailRide || game == ArcadeMode.Biketris"), "long-press opens the face-game developer menu")
    }

    @Test
    fun biketrisBranchComesBeforeTheBricksFallbackAndStaysReadOnly() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        val start = source.indexOf("if (modeController.mode == ArcadeMode.Biketris) {")
        val fallback = source.indexOf("val position = handInput.latest(now)")
        assertTrue(start > 0 && start < fallback)
        val branch = source.substring(start, fallback)
        assertTrue(branch.contains("arcadeContent.biketris.render("))
        for (field in listOf(
            "connected = telemetry?.connected == true",
            "initialized = telemetry?.initialized == true",
            "rpm = telemetry?.rpm?.value",
            "rpmCurrent = telemetry?.rpm?.current == true",
            "rpmObservedAt = telemetry?.rpm?.observedAt",
        )) {
            assertTrue(branch.contains(field), "cadence comes from the existing snapshot: $field")
        }
        assertFalse(branch.contains("NativeBridgeService"), "no second telemetry lookup in the branch")
        for (forbidden in listOf("Resistance", "requestResistance", "setResistance", "UsbManager", "session()", "startService")) {
            assertFalse(branch.contains(forbidden), forbidden)
        }
        val content = File("src/main/kotlin/com/fitbaus/bikebridge/host/arcade/ExerciseHud.kt").readText()
        assertTrue(content.contains("biketris.visibility = if (game == ArcadeMode.Biketris) VISIBLE else GONE"))
        assertTrue(content.contains("addView(hud, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))"), "HUD strip unchanged above every game")
    }

    @Test
    fun gameTabsScrollWhileTheSettingsGearStaysFixed() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        val row = source.substring(source.indexOf("private fun buildTitleRow()"), source.indexOf("private fun settingsButton()"))
        assertTrue(row.contains("HorizontalScrollView(this)"))
        assertTrue(row.contains("tabScroller.isFillViewport = true"))
        assertTrue(row.contains("LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)"), "tabs take only the space left between brand and gear")
        assertTrue(row.indexOf("row.addView(tabScroller") < row.indexOf("row.addView(settingsButton()"), "gear is a direct row child after the tabs")
        assertTrue(row.contains("LinearLayout.LayoutParams(dp(SETTINGS_TOUCH_DP), dp(SETTINGS_TOUCH_DP))"), "fixed 48 dp gear target")
    }

    @Test
    fun onlyGameModesActivate() {
        assertFalse(ArcadeMode.Dashboard.isGame)
        assertTrue(ArcadeMode.Bricks.isGame)
        assertTrue(ArcadeMode.Math.isGame)
        assertTrue(ArcadeMode.Flak.isGame)
        assertTrue(ArcadeMode.TrailRide.isGame)
        assertTrue(ArcadeMode.Biketris.isGame)
        assertEquals(listOf("DASHBOARD", "BRICKS", "MATH", "FLAK RUN", "TRAIL RIDE", "BIKETRIS"), ArcadeMode.values().map { it.caption })
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
        assertTrue(source.contains("tabGroup(ArcadeMode.Bricks, ArcadeMode.Math, ArcadeMode.Flak, ArcadeMode.TrailRide, ArcadeMode.Biketris)"))
        assertFalse(source.contains("\"ARCADE\""))
        assertNotNull(Regex("""setOnLongClickListener""").find(source), "long-press FITBAUS still opens pairing")
        assertTrue(source.contains("PairingActivity::class.java"))
        assertTrue(source.contains("openPairingSettings()"), "settings entry points share PairingActivity launch")
        assertTrue(source.contains("BuildConfig.VERSION_NAME"), "header version comes from installed BuildConfig")
        assertTrue(source.contains("BridgeUiStateMapper.versionLabel"), "header formats BuildConfig with a single v prefix")
        assertTrue(source.contains("R.drawable.ic_settings"), "visible settings gear uses vector icon")
        assertTrue(source.contains("R.string.open_bike_bridge_settings"), "settings gear has accessible content description")
        assertTrue(source.contains("settingsButton()"), "header exposes a dedicated settings control")
        assertTrue(
            source.indexOf("settingsButton()") > source.indexOf("tabGroup(ArcadeMode.Bricks, ArcadeMode.Math, ArcadeMode.Flak, ArcadeMode.TrailRide, ArcadeMode.Biketris)"),
            "settings gear stays after navigation tabs",
        )
    }
}
