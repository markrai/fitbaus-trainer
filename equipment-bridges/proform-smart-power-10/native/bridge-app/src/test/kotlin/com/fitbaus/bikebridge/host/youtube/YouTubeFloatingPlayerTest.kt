// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class YouTubeFloatingPlayerTest {
    private val video = VideoSummary(
        "abcdefghijk",
        "Sample",
        "Channel",
        120,
        -1,
        YouTubeIds.thumbnail("abcdefghijk"),
        false,
    )

    private fun state(
        phase: PlaybackPhase,
        active: Boolean = true,
        screen: Screen = Screen.Player,
        hasVideo: Boolean = true,
    ) = YouTubeState(
        active = active,
        screen = screen,
        browse = BrowseState(),
        playback = PlaybackState(
            video = video.takeIf { hasVideo },
            phase = phase,
        ),
    )

    @Test
    fun playbackContinuityIncludesLoadingPlayingAndPausedStates() {
        for (phase in listOf(
            PlaybackPhase.Resolving,
            PlaybackPhase.Buffering,
            PlaybackPhase.Playing,
            PlaybackPhase.Paused,
        )) {
            assertTrue(YouTubeFloatingPlayer.canFloat(state(phase)), phase.toString())
        }
    }

    @Test
    fun inactiveFailedEndedAndBrowseOnlySessionsDoNotFloat() {
        assertFalse(YouTubeFloatingPlayer.canFloat(state(PlaybackPhase.Playing, active = false)))
        assertFalse(YouTubeFloatingPlayer.canFloat(state(PlaybackPhase.Playing, screen = Screen.Results)))
        assertFalse(YouTubeFloatingPlayer.canFloat(state(PlaybackPhase.Playing, hasVideo = false)))
        assertFalse(YouTubeFloatingPlayer.canFloat(state(PlaybackPhase.Idle)))
        assertFalse(YouTubeFloatingPlayer.canFloat(state(PlaybackPhase.Error)))
        assertFalse(YouTubeFloatingPlayer.canFloat(state(PlaybackPhase.Ended)))
    }

    @Test
    fun switchingTabsRetainsVideoButHostPauseAndCloseReleaseIt() {
        val activity = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        val content = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/YouTubeContent.kt").readText()
        val modeSwitch = activity.substringAfter("override fun stopMedia(reason: ArcadeStopReason)")
            .substringBefore("private val modeController")
        assertTrue(modeSwitch.contains("reason == ArcadeStopReason.ExitArcade && youtubeContent.minimizeInto(floatingVideoSlot)"))
        assertTrue(modeSwitch.contains("floatingPlayer.visibility = View.VISIBLE"))
        val hostPause = activity.substringAfter("override fun onPause()").substringBefore("private fun queueYouTubeImport")
        assertTrue(hostPause.contains("youtubeContent.stop()"))
        assertTrue(hostPause.contains("floatingPlayer.visibility = View.GONE"))
        assertTrue(activity.contains("close.contentDescription = \"Close YouTube floating player\""))
        assertTrue(activity.contains("onRestoreRequested = { modeController.select(ArcadeMode.YouTube) }"))
        assertTrue(content.contains("fun minimizeInto(floatingSlot: FrameLayout): Boolean"))
        assertTrue(content.contains("restoreFullPlayer()"))
        assertTrue(content.contains("if (floating) onRestoreRequested() else onPlaybackToggle()"))
    }

    @Test
    fun floatingPreviewHasNoHeaderAndCloseOverlaysTheVideoCorner() {
        val activity = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        val builder = activity.substringAfter("private fun buildFloatingPlayer(): FrameLayout {")
            .substringBefore("private fun buildTitleRow(): View {")
        assertFalse(builder.contains("val header ="))
        assertFalse(builder.contains("val title ="))
        assertTrue(builder.contains("floating.addView("))
        assertTrue(builder.contains("floatingVideoSlot,"))
        assertTrue(builder.contains("FrameLayout.LayoutParams(dp(48), dp(48), Gravity.TOP or Gravity.END)"))
        assertTrue(builder.contains("close.background = GradientDrawable().apply"))
        assertTrue(builder.contains("youtubeContent.stop()"))
        assertTrue(activity.contains("FrameLayout.LayoutParams(dp(296), dp(167), Gravity.TOP or Gravity.END)"))
    }

    @Test
    fun floatingCaptionsShrinkAndFullPlayerCaptionsRemainUnchanged() {
        val content = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/YouTubeContent.kt").readText()
        val minimize = content.substringAfter("fun minimizeInto(floatingSlot: FrameLayout)")
            .substringBefore("private fun restoreFullPlayer()")
        val restore = content.substringAfter("private fun restoreFullPlayer()")
            .substringBefore("private fun styleCaptionsForVideoSize()")
        val style = content.substringAfter("private fun styleCaptionsForVideoSize()")
            .substringBefore("fun stop()")
        val fullPlayer = content.substringAfter("private fun buildPlayer()")
            .substringBefore("private fun buildVolumeColumn()")
        assertTrue(minimize.contains("floating = true\\n        styleCaptionsForVideoSize()".replace("\\n", "\n")))
        assertTrue(restore.contains("floating = false\\n        styleCaptionsForVideoSize()".replace("\\n", "\n")))
        assertTrue(style.contains("captionsView.textSize = if (floating) 12f else 22f"))
        assertTrue(style.contains("captionsView.maxLines = if (floating) 8 else 3"))
        assertTrue(style.contains("val horizontal = dp(if (floating) 6 else 12)"))
        assertTrue(style.contains("val vertical = dp(if (floating) 2 else 5)"))
        assertTrue(fullPlayer.contains("private") == false || fullPlayer.contains("captionsView.setPadding(dp(12), dp(5), dp(12), dp(5))"))
        assertTrue(fullPlayer.contains("captionsView.maxLines = 3"))
    }

    @Test
    fun miniPlayerReusesOneSurfaceAndOneEngine() {
        val content = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/YouTubeContent.kt").readText()
        assertTrue(content.contains("private val surface = SurfaceView(context)"))
        assertTrue(content.contains("engineFactory = PlayerEngineFactory { listener -> ExoPlayerEngine(context, surface, listener) }"))
        assertTrue(content.contains("(videoFrame.parent as? ViewGroup)?.removeView(videoFrame)"))
        assertTrue(content.contains("floatingSlot.addView("))
        assertTrue(content.contains("fullScreenVideoArea.addView("))
    }
}
