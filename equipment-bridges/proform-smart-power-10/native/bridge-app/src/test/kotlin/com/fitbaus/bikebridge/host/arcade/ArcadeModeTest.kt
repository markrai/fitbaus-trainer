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
        val flakBranch = source.substring(source.indexOf("if (modeController.mode == ArcadeMode.Flak) {"), source.indexOf("arcadeContent.playground.controllerAvailable ="))
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
        val trailBranch = source.substring(start, source.indexOf("arcadeContent.playground.controllerAvailable =", start))
        assertTrue(trailBranch.contains("arcadeContent.trail.render("))
        for (forbidden in listOf("Resistance", "requestResistance", "setResistance", "UsbManager", "session()", "startService")) {
            assertFalse(trailBranch.contains(forbidden), forbidden)
        }
        val content = File("src/main/kotlin/com/fitbaus/bikebridge/host/arcade/ExerciseHud.kt").readText()
        assertTrue(content.contains("trail.visibility = if (game == ArcadeMode.TrailRide) VISIBLE else GONE"))
    }

    @Test
    fun ghoulRunIsWiredAsAReadOnlyFaceOrControllerGame() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        assertTrue(source.contains("ArcadeMode.GhoulRun -> savedGhoulSettings()"))
        assertTrue(source.contains("ArcadeMode.GhoulRun -> ARCADE_GHOUL_TRACKER_KEY"))
        assertTrue(source.contains("arcadeContent.ghoul.pause()"))
        val start = source.indexOf("if (modeController.mode == ArcadeMode.GhoulRun) {")
        val end = source.indexOf("if (modeController.mode == ArcadeMode.Biketris) {", start)
        assertTrue(start > 0 && end > start)
        val branch = source.substring(start, end)
        assertTrue(branch.contains("arcadeContent.ghoul.render("))
        assertTrue(branch.contains("gameController.takeGhoulRunInput(reverseFromHat, leftFromHat, rightFromHat)"))
        for ((key, action) in listOf(
            "DOWN" to "reverse",
            "LEFT" to "left",
            "RIGHT" to "right",
        )) {
            assertTrue(branch.contains("gameBindings.action(ArcadeMode.GhoulRun, descriptor, KeyEvent.KEYCODE_DPAD_$key)?.id == \"$action\""))
        }
        for (forbidden in listOf("Resistance", "requestResistance", "setResistance", "UsbManager", "startService")) {
            assertFalse(branch.contains(forbidden), forbidden)
        }
        val content = File("src/main/kotlin/com/fitbaus/bikebridge/host/arcade/ExerciseHud.kt").readText()
        assertTrue(content.contains("ghoul.visibility = if (game == ArcadeMode.GhoulRun) VISIBLE else GONE"))
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
        assertTrue(source.contains("game == ArcadeMode.Flak || game == ArcadeMode.TrailRide || game == ArcadeMode.GhoulRun || game == ArcadeMode.Biketris"), "long-press opens the face-game developer menu")
    }

    @Test
    fun biketrisBranchComesBeforeTheBricksFallbackAndStaysReadOnly() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        val start = source.indexOf("if (modeController.mode == ArcadeMode.Biketris) {")
        val fallback = source.indexOf("arcadeContent.playground.controllerAvailable =")
        assertTrue(start > 0 && start < fallback)
        val branch = source.substring(start, fallback)
        assertTrue(branch.contains("arcadeContent.biketris.render("))
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
        assertTrue(ArcadeMode.GhoulRun.isGame)
        assertTrue(ArcadeMode.Biketris.isGame)
        assertFalse(ArcadeMode.YouTube.isGame)
        assertEquals(listOf("DASHBOARD", "BRICKS", "MATH", "FLAK RUN", "TRAIL RIDE", "GHOUL RUN", "BIKETRIS", "YouTube"), ArcadeMode.values().map { it.caption })
    }

    @Test
    fun youTubeIsAMediaModeAndEveryOtherNonDashboardModeIsAGame() {
        assertEquals(ModeKind.Media, ArcadeMode.YouTube.kind)
        assertTrue(ArcadeMode.YouTube.isMedia)
        assertEquals(ModeKind.Dashboard, ArcadeMode.Dashboard.kind)
        assertFalse(ArcadeMode.Dashboard.isMedia)
        val games = ArcadeMode.values().filter { it.isGame }
        assertEquals(listOf(ArcadeMode.Bricks, ArcadeMode.Math, ArcadeMode.Flak, ArcadeMode.TrailRide, ArcadeMode.GhoulRun, ArcadeMode.Biketris), games)
        for (game in games) assertFalse(game.isMedia, game.name)
    }

    @Test
    fun selectingYouTubeStartsOnlyTheMediaPlayer() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        controller.select(ArcadeMode.YouTube)
        assertEquals(listOf("show:YouTube", "media:YouTube"), hooks.events())
        assertFalse(controller.isActive, "no camera or arcade clock")
        assertTrue(controller.isMediaActive)
    }

    @Test
    fun switchingFromAGameToYouTubeStopsTheCameraPipelineFirst() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        controller.select(ArcadeMode.Biketris)
        controller.select(ArcadeMode.YouTube)
        controller.select(ArcadeMode.Flak)
        controller.select(ArcadeMode.Dashboard)
        assertEquals(
            listOf(
                "show:Biketris", "activate:Biketris",
                "deactivate:ExitArcade", "show:YouTube", "media:YouTube",
                "media-stop:ExitArcade", "show:Flak", "activate:Flak",
                "deactivate:ExitArcade", "show:Dashboard",
            ),
            hooks.events(),
        )
        assertFalse(controller.isActive)
        assertFalse(controller.isMediaActive)
    }

    @Test
    fun youTubeStopsOnPauseResumesOnResumeAndStopsOnDestroy() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        controller.select(ArcadeMode.YouTube)
        assertEquals(listOf("show:YouTube"), hooks.events(), "nothing starts while the host is paused")
        controller.onHostResume()
        controller.onHostResume()
        controller.onHostPause()
        controller.onHostPause()
        controller.onHostResume()
        controller.onHostDestroy()
        controller.select(ArcadeMode.Bricks)
        controller.onHostResume()
        assertEquals(
            listOf("show:YouTube", "media:YouTube", "media-stop:HostPaused", "media:YouTube", "media-stop:HostDestroyed"),
            hooks.events(),
        )
    }

    @Test
    fun dashboardAndYouTubeNeverActivateTheArcadeAcrossManySwitches() {
        var cameraStarts = 0
        var mediaStarts = 0
        var maxConcurrent = 0
        var running = 0
        val hooks = object : ArcadeModeHooks {
            override fun showMode(mode: ArcadeMode) {}

            override fun activateArcade(game: ArcadeMode) {
                assertTrue(game.isGame, game.name)
                cameraStarts += 1
                running += 1
                maxConcurrent = maxOf(maxConcurrent, running)
            }

            override fun deactivateArcade(reason: com.fitbaus.arcade.ArcadeStopReason) {
                running -= 1
            }

            override fun startMedia(mode: ArcadeMode) {
                assertEquals(ArcadeMode.YouTube, mode)
                mediaStarts += 1
                running += 1
                maxConcurrent = maxOf(maxConcurrent, running)
            }

            override fun stopMedia(reason: com.fitbaus.arcade.ArcadeStopReason) {
                running -= 1
            }
        }
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        val sequence = listOf(ArcadeMode.YouTube, ArcadeMode.Dashboard, ArcadeMode.YouTube, ArcadeMode.Bricks, ArcadeMode.YouTube, ArcadeMode.Biketris, ArcadeMode.Dashboard, ArcadeMode.YouTube)
        for (mode in sequence) controller.select(mode)
        controller.onHostDestroy()
        assertEquals(2, cameraStarts)
        assertEquals(4, mediaStarts)
        assertEquals(1, maxConcurrent, "camera and player are never owned at the same time")
        assertEquals(0, running)
    }

    @Test
    fun youTubeTabIsWiredWithoutCameraClockOrBridgeService() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        val hooksStart = source.indexOf("object : ArcadeModeHooks")
        val hooksBody = source.substring(hooksStart, source.indexOf("private val modeController", hooksStart))
        val start = hooksBody.substring(hooksBody.indexOf("override fun startMedia"), hooksBody.indexOf("override fun stopMedia"))
        val stop = hooksBody.substring(hooksBody.indexOf("override fun stopMedia"))
        assertTrue(start.contains("youtubeContent.start()"))
        assertTrue(stop.contains("youtubeContent.stop()"))
        for (forbidden in listOf("cameraSession", "arcadeClock", "requestPermissions", "NativeBridgeService", "startService", "session()", "Usb")) {
            assertFalse(start.contains(forbidden), forbidden)
            assertFalse(stop.contains(forbidden), forbidden)
        }
        assertTrue(source.contains("tabGroup(ArcadeMode.YouTube)"))
        assertTrue(
            source.indexOf("tabGroup(ArcadeMode.YouTube)") > source.indexOf("tabGroup(ArcadeMode.Bricks, ArcadeMode.Math, ArcadeMode.Flak, ArcadeMode.TrailRide, ArcadeMode.GhoulRun, ArcadeMode.Biketris)"),
            "YouTube follows the game tabs",
        )
        assertTrue(source.contains("dashboardContent.visibility = if (mode == ArcadeMode.Dashboard) View.VISIBLE else View.GONE"))
        assertTrue(source.contains("youtubeContent.visibility = if (mode == ArcadeMode.YouTube) View.VISIBLE else View.GONE"))
        assertTrue(source.contains("arcadeContent.visibility = if (mode.isGame) View.VISIBLE else View.GONE"))
        val tab = source.substring(source.indexOf("private fun modeTab("), source.indexOf("private fun savedTrackerSettings()"))
        assertTrue(tab.contains("if (mode.isGame) {"), "only game tabs open the tracker developer menu")
        val destroy = source.substring(source.indexOf("override fun onDestroy()"), source.indexOf("override fun onRequestPermissionsResult"))
        assertTrue(destroy.indexOf("modeController.onHostDestroy()") < destroy.indexOf("youtubeContent.destroy()"))
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
    fun leavingAnyGameResetsOnlyThatGameAndHidesEveryArcadeSurface() {
        val host = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        val arcade = File("src/main/kotlin/com/fitbaus/bikebridge/host/arcade/ExerciseHud.kt").readText()
        val showContent = host.substringAfter("private fun showContent(mode: ArcadeMode) {")
            .substringBefore("private fun styleTab(")
        assertTrue(showContent.contains("arcadeContent.show(mode)"))
        assertFalse(showContent.contains("if (mode.isGame) arcadeContent.show(mode)"))
        assertTrue(arcade.contains("show(ArcadeMode.Dashboard)"))
        val show = arcade.substringAfter("fun show(game: ArcadeMode) {")
        assertTrue(show.contains("if (previousMode.isGame && previousMode != game)"))
        assertTrue(show.contains("previousMode = game"))
        for ((mode, view) in listOf(
            ArcadeMode.Bricks to "playground",
            ArcadeMode.Math to "math",
            ArcadeMode.Flak to "flak",
            ArcadeMode.TrailRide to "trail",
            ArcadeMode.GhoulRun to "ghoul",
            ArcadeMode.Biketris to "biketris",
        )) {
            assertTrue(show.contains("ArcadeMode.${mode.name} -> ${view}.restartGame()"), mode.name)
            assertTrue(show.contains("${view}.visibility = if (game == ArcadeMode.${mode.name}) VISIBLE else GONE"), mode.name)
        }
        assertFalse(show.contains("stopService"))
    }

    @Test
    fun ghoulRunGpuSuspendsWithHiddenAncestorsAndReleasesContextOnPause() {
        val ghoul = File("../../../shared/arcade/src/main/kotlin/com/fitbaus/arcade/GhoulRunView.kt").readText()
        assertTrue(ghoul.contains("surface.preserveEGLContextOnPause = false"))
        val lifecycle = ghoul.substringAfter("private fun updateGlLifecycle() {")
            .substringBefore("private fun onGlFailure(")
        assertTrue(lifecycle.contains("glAttached && !glHostPaused && isShown"))
        assertTrue(lifecycle.contains("surface.onPause()"))
        assertTrue(lifecycle.contains("surface.onResume()"))
        val host = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        assertTrue(host.contains("arcadeContent.ghoul.pause()"))
    }

    @Test
    fun leavingGhoulRunForYouTubeStopsItsPipelineBeforeMediaStarts() {
        val hooks = RecordingHooks()
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        controller.select(ArcadeMode.GhoulRun)
        controller.select(ArcadeMode.YouTube)
        assertEquals(
            listOf(
                "show:GhoulRun", "activate:GhoulRun", "deactivate:ExitArcade",
                "show:YouTube", "media:YouTube",
            ),
            hooks.events(),
        )
        assertFalse(controller.isActive)
        assertTrue(controller.isMediaActive)
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
        assertTrue(source.contains("tabGroup(ArcadeMode.Bricks, ArcadeMode.Math, ArcadeMode.Flak, ArcadeMode.TrailRide, ArcadeMode.GhoulRun, ArcadeMode.Biketris)"))
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
            source.indexOf("settingsButton()") > source.indexOf("tabGroup(ArcadeMode.Bricks, ArcadeMode.Math, ArcadeMode.Flak, ArcadeMode.TrailRide, ArcadeMode.GhoulRun, ArcadeMode.Biketris)"),
            "settings gear stays after navigation tabs",
        )
    }
}
