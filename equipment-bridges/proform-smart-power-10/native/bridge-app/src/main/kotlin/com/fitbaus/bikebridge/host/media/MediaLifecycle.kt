// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.media

import android.view.View
import android.widget.FrameLayout
import com.fitbaus.arcade.ArcadeStopReason
import com.fitbaus.bikebridge.host.arcade.ArcadeMode
import com.fitbaus.bikebridge.host.books.BooksContent
import com.fitbaus.bikebridge.host.youtube.YouTubeContent

internal interface MediaLifecycleEffects {
    val youtubeFloating: Boolean
    val booksFloating: Boolean
    fun setYoutubeFloating(visible: Boolean)
    fun startYouTube()
    fun stopYouTube()
    fun minimizeYouTube(): Boolean
    fun destroyYouTube()
    fun startBooks()
    fun stopBooks()
    fun minimizeBooks(): Boolean
    fun destroyBooks()
    fun cancelVoiceSearch()
}

internal class MediaLifecycle(private val effects: MediaLifecycleEffects) {
    fun start(mode: ArcadeMode) {
        require(mode.isMedia)
        if (mode == ArcadeMode.Books) {
            if (effects.youtubeFloating) effects.stopYouTube()
            effects.setYoutubeFloating(false)
            effects.startBooks()
        } else {
            if (effects.booksFloating) effects.stopBooks()
            effects.startYouTube()
            effects.setYoutubeFloating(false)
        }
    }

    fun stop(mode: ArcadeMode, reason: ArcadeStopReason) {
        require(mode.isMedia)
        if (mode == ArcadeMode.Books) {
            if (reason != ArcadeStopReason.ExitArcade || !effects.minimizeBooks()) effects.stopBooks()
            return
        }
        effects.cancelVoiceSearch()
        if (reason == ArcadeStopReason.ExitArcade && effects.minimizeYouTube()) {
            effects.setYoutubeFloating(true)
        } else {
            closeYouTubeFloating()
        }
    }

    fun closeYouTubeFloating() {
        effects.stopYouTube()
        effects.setYoutubeFloating(false)
    }

    fun afterHostPause() {
        closeYouTubeFloating()
        if (effects.booksFloating) effects.stopBooks()
    }

    fun afterHostDestroy() {
        effects.destroyYouTube()
        effects.destroyBooks()
    }
}

internal class AndroidMediaLifecycleEffects(
    private val youtubeContent: YouTubeContent,
    private val booksContent: BooksContent,
    private val floatingPlayer: FrameLayout,
    private val floatingVideoSlot: FrameLayout,
    private val cancelVoice: () -> Unit,
) : MediaLifecycleEffects {
    override val youtubeFloating: Boolean get() = floatingPlayer.visibility == View.VISIBLE
    override val booksFloating: Boolean get() = booksContent.floatingPlayer.visibility == View.VISIBLE

    override fun setYoutubeFloating(visible: Boolean) {
        floatingPlayer.visibility = if (visible) View.VISIBLE else View.GONE
    }

    override fun startYouTube() = youtubeContent.start()
    override fun stopYouTube() = youtubeContent.stop()
    override fun minimizeYouTube(): Boolean = youtubeContent.minimizeInto(floatingVideoSlot)
    override fun destroyYouTube() = youtubeContent.destroy()
    override fun startBooks() = booksContent.start()
    override fun stopBooks() = booksContent.stop()
    override fun minimizeBooks(): Boolean = booksContent.minimize()
    override fun destroyBooks() = booksContent.destroy()
    override fun cancelVoiceSearch() = cancelVoice()
}
