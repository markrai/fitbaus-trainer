// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class ThumbnailRequestsTest {
    @Test
    fun aStaleCallbackCannotRemoveTheRecycledViewsNewRequest() {
        val requests = ThumbnailRequests<String>()
        val cancelled = ArrayList<String>()
        val old = requests.begin("card", "https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg").also { it.onCancel = { cancelled += "old" } }
        val fresh = requests.begin("card", "https://i.ytimg.com/vi/bbbbbbbbbbb/mqdefault.jpg")
        assertEquals(listOf("old"), cancelled, "rebinding cancels the previous download")
        assertFalse(requests.finish("card", old), "the old completion is ignored")
        assertTrue(requests.isCurrent("card", fresh), "and does not untrack the new request")
        assertTrue(requests.finish("card", fresh))
        assertEquals(0, requests.size)
    }

    @Test
    fun pausingCancelsEveryPendingDownloadAndReportsTheViewsToReset() {
        val requests = ThumbnailRequests<String>()
        var cancels = 0
        val a = requests.begin("a", "ua").also { it.onCancel = { cancels += 1 } }
        requests.begin("b", "ub").onCancel = { cancels += 1 }
        assertEquals(setOf("a", "b"), requests.cancelAll().toSet())
        assertEquals(2, cancels)
        assertFalse(requests.finish("a", a), "completions after pause are dropped")
        assertTrue(requests.begin("a", "ua") !== a, "a later bind starts a new request")
    }

    @Test
    fun failedOrCancelledThumbnailsAreRetriedAndTheGridRebindsOnReturn() {
        val loader = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/ThumbnailLoader.kt").readText()
        val complete = loader.substring(loader.indexOf("private fun complete("), loader.indexOf("val cachedBytes"))
        assertTrue(complete.contains("if (!requests.finish(view, ticket)) return"))
        assertTrue(complete.contains("view.tag = null"), "a failed download clears the tag so the next bind retries")
        val pause = loader.substring(loader.indexOf("fun pause()"), loader.indexOf("fun shutdown()"))
        assertTrue(pause.contains("for (view in requests.cancelAll()) view.tag = null"))
        val content = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/YouTubeContent.kt").readText()
        val start = content.substring(content.indexOf("fun start()"), content.indexOf("fun stop()"))
        assertTrue(start.contains("adapter.notifyDataSetChanged()"), "returning to the tab rebinds visible thumbnails")
    }
}
