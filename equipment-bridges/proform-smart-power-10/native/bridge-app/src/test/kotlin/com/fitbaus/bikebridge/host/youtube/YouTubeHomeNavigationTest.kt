// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class YouTubeHomeNavigationTest {
    @Test
    fun reopeningTabAfterSearchReturnsToDefaultFeed() {
        val search = BrowseState(query = "cycling", feedTitle = "From your channels")
        assertTrue(YouTubeHomeNavigation.shouldReload(true, true, search))
        assertTrue(YouTubeHomeNavigation.shouldReload(false, false, BrowseState(query = "music")))
    }

    @Test
    fun accountChangesRefreshHomeWithoutShowingPreviousUsersVideos() {
        val signedOut = BrowseState(feedTitle = "Trending")
        val signedIn = BrowseState(feedTitle = "From your channels")
        assertTrue(YouTubeHomeNavigation.shouldReload(false, true, signedOut))
        assertTrue(YouTubeHomeNavigation.shouldReload(true, false, signedIn))
        assertTrue(YouTubeHomeNavigation.shouldReload(null, false, signedOut))
    }

    @Test
    fun returningFromAccountBrowserPreservesCurrentHomeResults() {
        val guest = BrowseState(feedTitle = "Trending", status = ListStatus.Ready)
        val subscribed = BrowseState(feedTitle = "From your channels", status = ListStatus.Ready)
        assertFalse(YouTubeHomeNavigation.shouldReload(false, false, guest))
        assertFalse(YouTubeHomeNavigation.shouldReload(true, true, subscribed))
        assertTrue(YouTubeHomeNavigation.shouldReload(true, true, guest))
        assertTrue(YouTubeHomeNavigation.shouldReload(false, false, subscribed))
    }

    @Test
    fun mainYouTubeToolbarHasSearchFieldButNoRedundantButtons() {
        val content = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/YouTubeContent.kt").readText()
        assertTrue(content.contains("searchField.imeOptions = EditorInfo.IME_ACTION_SEARCH"))
        assertTrue(content.contains("searchClear.setOnClickListener { returnToHome() }"))
        assertTrue(content.contains("val myYouTube = button(\"MY YOUTUBE\")"))
        assertFalse(content.contains("button(\"SEARCH\")"))
        assertFalse(content.contains("feedButton"))
    }

    @Test
    fun accountHeaderHasBackToHomeWithoutBrowseOrMyYouTubeHeading() {
        val content = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/GoogleAccountView.kt").readText()
        assertTrue(content.contains("private val homeBack = button(\"‹\")"))
        assertTrue(content.contains("homeBack.setOnClickListener { onHomeRequested() }"))
        assertTrue(content.contains("private val back = button(\"BACK\")"))
        assertFalse(content.contains("button(\"BROWSE\")"))
        assertFalse(content.contains("text(\"MY YOUTUBE\", 20f)"))
    }
}
