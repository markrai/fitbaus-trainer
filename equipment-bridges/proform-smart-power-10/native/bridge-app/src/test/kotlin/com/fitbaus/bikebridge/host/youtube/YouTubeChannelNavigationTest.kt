// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class YouTubeChannelNavigationTest {
    @Test
    fun onlyActualYouTubeChannelUrlsAreNavigable() {
        val accepted = listOf(
            "https://www.youtube.com/channel/UC0000000000000000000000",
            "https://youtube.com/@example",
            "https://m.youtube.com/user/example",
            "https://www.youtube.com/c/example",
        )
        for (url in accepted) assertEquals(url, YouTubeChannelLinks.normalize(url))
        val rejected = listOf(
            "http://www.youtube.com/@example",
            "https://www.youtube.com.evil.test/@example",
            "https://www.youtube.com@evil.test/@example",
            "https://www.youtube.com/watch?v=abcdefghijk",
            "https://www.youtube.com/@example?redirect=http://127.0.0.1",
            "https://www.youtube.com:8443/@example",
            "https://127.0.0.1/@example",
            "",
        )
        for (url in rejected) assertNull(YouTubeChannelLinks.normalize(url), url)
    }

    @Test
    fun avatarsAreConstrainedToHttpsYouTubeImageHosts() {
        assertEquals("https://yt3.ggpht.com/a", YouTubeChannelLinks.avatar("https://yt3.ggpht.com/a"))
        assertEquals("https://yt3.googleusercontent.com/a", YouTubeChannelLinks.avatar("https://yt3.googleusercontent.com/a"))
        assertNull(YouTubeChannelLinks.avatar("https://ggpht.com.evil.test/a"))
        assertNull(YouTubeChannelLinks.avatar("http://yt3.ggpht.com/a"))
        assertNull(YouTubeChannelLinks.avatar("https://192.168.1.1/a"))
    }

    @Test
    fun channelAvatarIsBeforeTheQualitySelectorAndUsesExistingThumbnailLoader() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/YouTubeContent.kt").readText()
        val header = source.substringAfter("private fun buildPlayer()").substringBefore("private fun buildVolumeColumn()")
        val render = source.substringAfter("private fun renderPlayback(playback: PlaybackState)")
            .substringBefore("private fun onPlaybackToggle()")
        assertTrue(header.indexOf("top.addView(channelButton") < header.indexOf("top.addView(qualityButton"))
        assertTrue(header.contains("session.openChannel(video)"))
        assertTrue(header.contains("channelButton.clipToOutline = true"))
        assertTrue(render.contains("loader.bind(channelAvatar, avatar)"))
        assertTrue(render.contains("renderedChannelAvatarUrl"))
    }

    @Test
    fun channelResultsAreRealPaginatedVideosNotChannelNameSearch() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/NewPipeYouTubeCatalog.kt").readText()
        val function = source.substringAfter("override fun channelVideos(channelUrl: String)")
            .substringBefore("override fun more(cursor: FeedCursor)")
        assertTrue(function.contains("ChannelInfo.getInfo(service, url)"))
        assertTrue(function.contains("ChannelTabs.VIDEOS"))
        assertTrue(function.contains("firstPage(service.getChannelTabExtractor(videosTab))"))
    }
}
