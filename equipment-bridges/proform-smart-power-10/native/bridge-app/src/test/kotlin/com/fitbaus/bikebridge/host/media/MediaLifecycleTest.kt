// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.media

import com.fitbaus.arcade.ArcadeStopReason
import com.fitbaus.bikebridge.host.arcade.ArcadeMode
import com.fitbaus.bikebridge.host.arcade.ArcadeModeController
import com.fitbaus.bikebridge.host.arcade.ArcadeModeHooks
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class MediaLifecycleTest {
    private class Effects : MediaLifecycleEffects {
        val events = mutableListOf<String>()
        override var youtubeFloating = false
            private set
        override var booksFloating = false
            private set
        var youtubeCanFloat = true
        var booksCanFloat = true

        override fun setYoutubeFloating(visible: Boolean) {
            youtubeFloating = visible
            events += "youtubeFloating:$visible"
        }
        override fun startYouTube() { events += "startYouTube" }
        override fun stopYouTube() { events += "stopYouTube" }
        override fun minimizeYouTube(): Boolean {
            events += "minimizeYouTube"
            return youtubeCanFloat
        }
        override fun destroyYouTube() { events += "destroyYouTube" }
        override fun startBooks() {
            booksFloating = false
            events += "startBooks"
        }
        override fun stopBooks() {
            booksFloating = false
            events += "stopBooks"
        }
        override fun minimizeBooks(): Boolean {
            events += "minimizeBooks"
            booksFloating = booksCanFloat
            return booksCanFloat
        }
        override fun destroyBooks() {
            booksFloating = false
            events += "destroyBooks"
        }
        override fun cancelVoiceSearch() { events += "cancelVoice" }
    }

    private val effects = Effects()
    private val lifecycle = MediaLifecycle(effects)

    @Test
    fun youtubeExitKeepsEligiblePlaybackFloatingAndRestoreDoesNotStopIt() {
        lifecycle.start(ArcadeMode.YouTube)
        effects.events.clear()
        lifecycle.stop(ArcadeMode.YouTube, ArcadeStopReason.ExitArcade)
        assertEquals(listOf("cancelVoice", "minimizeYouTube", "youtubeFloating:true"), effects.events)
        assertTrue(effects.youtubeFloating)
        effects.events.clear()
        lifecycle.start(ArcadeMode.YouTube)
        assertEquals(listOf("startYouTube", "youtubeFloating:false"), effects.events)
        assertFalse(effects.youtubeFloating)
    }

    @Test
    fun booksExitKeepsEligiblePlaybackFloatingAndRestoreDoesNotStopIt() {
        lifecycle.start(ArcadeMode.Books)
        effects.events.clear()
        lifecycle.stop(ArcadeMode.Books, ArcadeStopReason.ExitArcade)
        assertEquals(listOf("minimizeBooks"), effects.events)
        assertTrue(effects.booksFloating)
        effects.events.clear()
        lifecycle.start(ArcadeMode.Books)
        assertEquals(listOf("youtubeFloating:false", "startBooks"), effects.events)
        assertFalse(effects.booksFloating)
    }

    @Test
    fun ineligiblePlaybackStopsOnTabExit() {
        effects.youtubeCanFloat = false
        effects.booksCanFloat = false
        lifecycle.stop(ArcadeMode.YouTube, ArcadeStopReason.ExitArcade)
        assertEquals(listOf("cancelVoice", "minimizeYouTube", "stopYouTube", "youtubeFloating:false"), effects.events)
        effects.events.clear()
        lifecycle.stop(ArcadeMode.Books, ArcadeStopReason.ExitArcade)
        assertEquals(listOf("minimizeBooks", "stopBooks"), effects.events)
        assertFalse(effects.booksFloating)
    }

    @Test
    fun openingOtherMediaStopsFloatingPlaybackBeforeStartingNewProvider() {
        lifecycle.stop(ArcadeMode.YouTube, ArcadeStopReason.ExitArcade)
        effects.events.clear()
        lifecycle.start(ArcadeMode.Books)
        assertEquals(listOf("stopYouTube", "youtubeFloating:false", "startBooks"), effects.events)
        lifecycle.stop(ArcadeMode.Books, ArcadeStopReason.ExitArcade)
        effects.events.clear()
        lifecycle.start(ArcadeMode.YouTube)
        assertEquals(listOf("stopBooks", "startYouTube", "youtubeFloating:false"), effects.events)
        assertFalse(effects.booksFloating)
        assertFalse(effects.youtubeFloating)
    }

    @Test
    fun pauseAndDestroyReasonsNeverMinimizeActiveMedia() {
        for (reason in listOf(ArcadeStopReason.HostPaused, ArcadeStopReason.HostDestroyed)) {
            effects.events.clear()
            lifecycle.stop(ArcadeMode.YouTube, reason)
            assertEquals(listOf("cancelVoice", "stopYouTube", "youtubeFloating:false"), effects.events)
            effects.events.clear()
            lifecycle.stop(ArcadeMode.Books, reason)
            assertEquals(listOf("stopBooks"), effects.events)
        }
    }

    @Test
    fun floatingCloseAndHostPauseReleasePlaybackWithoutSelectingAnotherMode() {
        lifecycle.stop(ArcadeMode.YouTube, ArcadeStopReason.ExitArcade)
        effects.events.clear()
        lifecycle.closeYouTubeFloating()
        assertEquals(listOf("stopYouTube", "youtubeFloating:false"), effects.events)
        assertFalse(effects.youtubeFloating)
        lifecycle.stop(ArcadeMode.Books, ArcadeStopReason.ExitArcade)
        effects.events.clear()
        lifecycle.afterHostPause()
        assertEquals(listOf("stopYouTube", "youtubeFloating:false", "stopBooks"), effects.events)
        assertFalse(effects.booksFloating)
        effects.events.clear()
        lifecycle.afterHostPause()
        assertEquals(listOf("stopYouTube", "youtubeFloating:false"), effects.events)
        effects.events.clear()
        lifecycle.afterHostDestroy()
        assertEquals(listOf("destroyYouTube", "destroyBooks"), effects.events)
    }

    @Test
    fun modeControllerPreservesFloatingPlaybackDuringGamesAndStopsItOnHostPause() {
        lateinit var controller: ArcadeModeController
        val hooks = object : ArcadeModeHooks {
            override fun showMode(mode: ArcadeMode) { effects.events += "show:$mode" }
            override fun activateArcade(game: ArcadeMode) { effects.events += "activate:$game" }
            override fun deactivateArcade(reason: ArcadeStopReason) { effects.events += "deactivate:$reason" }
            override fun startMedia(mode: ArcadeMode) = lifecycle.start(mode)
            override fun stopMedia(reason: ArcadeStopReason) = lifecycle.stop(controller.mode, reason)
        }
        controller = ArcadeModeController(hooks)
        controller.onHostResume()
        controller.select(ArcadeMode.YouTube)
        effects.events.clear()
        controller.select(ArcadeMode.Bricks)
        assertEquals(listOf("cancelVoice", "minimizeYouTube", "youtubeFloating:true", "show:Bricks", "activate:Bricks"), effects.events)
        assertTrue(effects.youtubeFloating)
        effects.events.clear()
        controller.onHostPause()
        lifecycle.afterHostPause()
        assertEquals(listOf("deactivate:HostPaused", "stopYouTube", "youtubeFloating:false"), effects.events)
        assertFalse(effects.youtubeFloating)
        assertEquals(ArcadeMode.Bricks, controller.mode)
    }
}
