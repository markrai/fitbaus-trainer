// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.URLDecoder

class GoogleSubscriptionFeedCatalogTest {
    private class Store : GoogleAccountStore {
        var connected = true
        override fun hasAccount(): Boolean = connected
        override fun client(): GoogleClient? = if (connected) GoogleClient("test.apps.googleusercontent.com", "secret") else null
        override fun refreshToken(): String? = if (connected) "refresh" else null
        override fun saveClient(client: GoogleClient) {}
        override fun saveRefreshToken(token: String) {}
        override fun clearRefreshToken() { connected = false }
    }

    private class Guest : YouTubeCatalog {
        var discoverCount = 0
        var searchCount = 0
        var channelCount = 0
        var releaseCount = 0
        override fun discover(): FeedPage {
            discoverCount += 1
            return FeedPage(listOf(video("abcdefghijk", "Guest trending")), null)
        }
        override fun search(query: String): FeedPage {
            searchCount += 1
            return FeedPage(listOf(video("abcdefghijk", "Global search")), null)
        }
        override fun channelVideos(channelUrl: String): FeedPage {
            channelCount += 1
            return FeedPage(listOf(video("abcdefghijk", "Channel videos")), null)
        }
        override fun more(cursor: FeedCursor): FeedPage = FeedPage(emptyList(), null)
        override fun resolve(videoId: String): ResolvedVideo = error("Not needed")
        override fun release() { releaseCount += 1 }
    }

    private class Http : GoogleHttp {
        val calls = ArrayList<String>()
        var rejected = false
        val channels = (1..10).map { "UC" + it.toString().padStart(22, '0') }

        override fun post(url: String, fields: Map<String, String>): GoogleHttpResponse {
            calls.add(url)
            return GoogleHttpResponse(200, """{"access_token":"access","token_type":"Bearer","expires_in":3600}""")
        }

        override fun get(url: String, token: String): GoogleHttpResponse {
            calls.add(url)
            if (rejected) return GoogleHttpResponse(403, """{"error":"quota_exceeded"}""")
            assertEquals("access", token)
            val params = url.substringAfter("?").split("&").associate { entry ->
                val parts = entry.split("=", limit = 2)
                URLDecoder.decode(parts[0], "UTF-8") to URLDecoder.decode(parts[1], "UTF-8")
            }
            return when {
                url.contains("/subscriptions?") -> {
                    assertEquals("unread", params["order"])
                    val items = channels.map { id ->
                        JSONObject().put("snippet", JSONObject()
                            .put("resourceId", JSONObject().put("channelId", id))
                            .put("title", "Channel " + id.takeLast(2)))
                    }
                    GoogleHttpResponse(200, JSONObject().put("items", JSONArray(items)).toString())
                }
                url.contains("/channels?") -> {
                    val ids = params.getValue("id").split(",")
                    assertTrue(ids.size <= 8)
                    val items = ids.map { id ->
                        JSONObject().put("id", id).put("contentDetails", JSONObject()
                            .put("relatedPlaylists", JSONObject().put("uploads", "UU" + id.takeLast(22))))
                    }
                    GoogleHttpResponse(200, JSONObject().put("items", JSONArray(items)).toString())
                }
                url.contains("/playlistItems?") -> {
                    assertEquals("4", params["maxResults"])
                    val channelNumber = params.getValue("playlistId").takeLast(2).toInt()
                    val id = "V" + channelNumber.toString().padStart(10, '0')
                    val item = JSONObject().put("snippet", JSONObject()
                        .put("title", "Upload " + channelNumber)
                        .put("channelTitle", "Channel " + channelNumber)
                        .put("publishedAt", "2026-11-01T00:00:00Z"))
                        .put("contentDetails", JSONObject()
                            .put("videoId", id)
                            .put("videoPublishedAt", "2026-11-" + channelNumber.toString().padStart(2, '0') + "T12:00:00Z"))
                    GoogleHttpResponse(200, JSONObject().put("items", JSONArray().put(item)).toString())
                }
                else -> error("unexpected API resource")
            }
        }
    }

    @Test
    fun signedInHomeCombinesAndSortsUploadsAcrossEightSubscribedChannels() {
        val http = Http()
        val guest = Guest()
        val catalog = GoogleSubscriptionFeedCatalog(guest, Store(), GoogleYouTubeApi(http))
        val page = catalog.discover()
        assertEquals(8, page.items.size)
        assertEquals("Upload 8", page.items[0].title)
        assertEquals(java.time.Instant.parse("2026-11-08T12:00:00Z").epochSecond, page.items[0].publishedAtEpochSeconds)
        assertEquals("Upload 1", page.items[7].title)
        assertNotNull(page.cursor)
        assertEquals(0, guest.discoverCount)
        assertEquals(1, http.calls.count { it.contains("/subscriptions?") })
        assertEquals(1, http.calls.count { it.contains("/channels?") })
        assertEquals(8, http.calls.count { it.contains("/playlistItems?") })
        assertTrue(page.items.all { YouTubeIds.isValid(it.id) })
        val more = catalog.more(page.cursor!!)
        assertEquals(2, more.items.size)
        assertEquals("Upload 10", more.items[0].title)
        assertEquals(null, more.cursor)
        assertEquals(10, http.calls.count { it.contains("/playlistItems?") })
    }

    @Test
    fun refreshingHomeFetchesFreshUploadsWithoutRefreshingTheAccessToken() {
        val http = Http()
        val catalog = GoogleSubscriptionFeedCatalog(Guest(), Store(), GoogleYouTubeApi(http))
        assertEquals(8, catalog.discover().items.size)
        assertEquals(8, catalog.discover().items.size)
        assertEquals(2, http.calls.count { it.contains("/subscriptions?") })
        assertEquals(1, http.calls.count { it.contains("/token") })
    }

    @Test
    fun globalSearchDoesNotUsePrivateGoogleChannelFeed() {
        val http = Http()
        val guest = Guest()
        val catalog = GoogleSubscriptionFeedCatalog(guest, Store(), GoogleYouTubeApi(http))
        assertEquals("Global search", catalog.search("science").items.single().title)
        assertEquals(1, guest.searchCount)
        assertTrue(http.calls.isEmpty())
    }

    @Test
    fun channelVideosUsePublicExtractorWithoutGoogleQuota() {
        val http = Http()
        val guest = Guest()
        val catalog = GoogleSubscriptionFeedCatalog(guest, Store(), GoogleYouTubeApi(http))
        assertEquals("Channel videos", catalog.channelVideos("https://www.youtube.com/@test").items.single().title)
        assertEquals(1, guest.channelCount)
        assertTrue(http.calls.isEmpty())
    }

    @Test
    fun loggedOutHomeFallsBackToGuestTrendingAndNeverUsesGoogle() {
        val http = Http()
        val guest = Guest()
        val store = Store().apply { connected = false }
        val catalog = GoogleSubscriptionFeedCatalog(guest, store, GoogleYouTubeApi(http))
        assertEquals("Guest trending", catalog.discover().items.single().title)
        assertEquals(1, guest.discoverCount)
        assertTrue(http.calls.isEmpty())
    }

    @Test
    fun disconnectingAccountPreventsMoreAuthenticatedRequests() {
        val http = Http()
        val store = Store()
        val catalog = GoogleSubscriptionFeedCatalog(Guest(), store, GoogleYouTubeApi(http))
        val page = catalog.discover()
        store.connected = false
        val before = http.calls.size
        val failure = assertThrows(YouTubeException::class.java) {
            catalog.more(page.cursor!!)
        }
        assertEquals(FailureKind.Authentication, failure.kind)
        assertEquals(before, http.calls.size)
    }

    @Test
    fun quotaFailuresRemainVisibleAndAreNotSilentlyReplacedWithTrending() {
        val http = Http().apply { rejected = true }
        val guest = Guest()
        val catalog = GoogleSubscriptionFeedCatalog(guest, Store(), GoogleYouTubeApi(http))
        val failure = assertThrows(YouTubeException::class.java) { catalog.discover() }
        assertEquals(FailureKind.RateLimited, failure.kind)
        assertEquals(0, guest.discoverCount)
    }

    private companion object {
        fun video(id: String, name: String): VideoSummary =
            VideoSummary(id, name, null, 0, -1, YouTubeIds.thumbnail(id), false)
    }
}
