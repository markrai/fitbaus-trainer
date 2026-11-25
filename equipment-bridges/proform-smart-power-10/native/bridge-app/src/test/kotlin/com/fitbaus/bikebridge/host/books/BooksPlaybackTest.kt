// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class BooksPlaybackTest {
    private val address = "http://192.168.1.193:13378/audiobookshelf"
    private val server = BooksServer(address)

    private fun response(): JSONObject = JSONObject("""{
        "id":"session-1","libraryItemId":"book-1","playMethod":0,"currentTime":75.5,
        "audioTracks":[
            {"startOffset":0,"duration":60,"contentUrl":"/api/items/book-1/file/123"},
            {"startOffset":60,"duration":120,"contentUrl":"/api/items/book-1/file/456"}
        ],
        "chapters":[{"title":"First","start":0},{"title":"Second","start":75}]
    }""")

    @Test
    fun serverFormBuildsRootAndSubpathWithoutUserEnteringPunctuation() {
        assertEquals("http://192.168.1.193:13378", BooksServer.address("http", "192.168.1.193", "13378", false))
        assertEquals("https://books.example/audiobookshelf", BooksServer.address("https", "books.example", "", true))
        for (host in listOf("https://books.example", "books.example:443", "books.example/path", "books.example@other.example")) {
            assertThrows(IllegalArgumentException::class.java) { BooksServer.address("https", host, "", false) }
        }
        for (port in listOf("0", "65536", "-1", "abc")) {
            assertThrows(IllegalArgumentException::class.java) { BooksServer.address("https", "books.example", port, false) }
        }
    }

    @Test
    fun multiTrackResumeAndSeekUseBookRelativeTime() {
        val session = BooksPlaybackApi.parse(server, "book-1", response())
        assertEquals(75_500L, session.resumeMs)
        assertEquals(180_000L, session.durationMs)
        assertEquals(BooksTrackPosition(1, 15_500), session.locate(session.resumeMs))
        assertEquals(BooksTrackPosition(1, 0), session.locate(60_000))
        assertEquals(BooksTrackPosition(0, 0), session.locate(-100))
        assertEquals(BooksTrackPosition(1, 120_000), session.locate(999_000))
        assertEquals(75_500L, session.position(1, 15_500))
        assertEquals(1, session.chapterAt(75_500))
        assertEquals("$address/api/items/book-1/file/123", session.tracks.first().url)
    }

    @Test
    fun explicitChapterRangesUseTheBookTimelineAndPreserveGaps() {
        val json = response().put("chapters", JSONArray("""[
            {"id":8,"title":"Second","start":65.25,"end":150},
            {"id":7,"title":"First","start":0,"end":62.5},
            {"id":9,"title":"Third","start":160,"end":181}
        ]"""))
        val session = BooksPlaybackApi.parse(server, "book-1", json)
        assertEquals(listOf(
            BooksChapter("First", 0, 62_500, 7),
            BooksChapter("Second", 65_250, 150_000, 8),
            BooksChapter("Third", 160_000, 180_000, 9),
        ), session.chapters)
        assertEquals(0, session.chapterAt(session.position(1, 1_000)))
        assertEquals(-1, session.chapterAt(62_500))
        assertEquals(1, session.chapterAt(65_250))
        assertEquals(-1, session.chapterAt(150_000))
        assertEquals(2, session.chapterAt(179_999))
        assertEquals(-1, session.chapterAt(180_000))
        assertEquals(-1, session.chapterAt(-1))
        assertEquals(0, session.chapterAt(0))
    }

    @Test
    fun missingEndsUseNextStartAndOverlapsAreClipped() {
        val json = response().put("chapters", JSONArray("""[
            {"title":"First","start":0,"end":100},
            {"title":"Second","start":75},
            {"title":"Third","start":120,"end":null}
        ]"""))
        val session = BooksPlaybackApi.parse(server, "book-1", json)
        assertEquals(listOf(
            BooksChapter("First", 0, 75_000, null),
            BooksChapter("Second", 75_000, 120_000, null),
            BooksChapter("Third", 120_000, 180_000, null),
        ), session.chapters)
        assertEquals(0, session.chapterAt(74_999))
        assertEquals(1, session.chapterAt(75_000))
        assertEquals(2, session.chapterAt(120_000))
    }

    @Test
    fun malformedAndDuplicateChaptersDoNotPreventPlayback() {
        val json = response().put("chapters", JSONArray("""[
            null,
            {"start":-1},
            {"start":"NaN"},
            {"start":180},
            {"start":30,"end":29},
            {"start":40,"end":"invalid"},
            {"start":50,"end":50.0001},
            {"id":0,"title":"  ","start":60,"end":100},
            {"id":2,"title":"Duplicate","start":60,"end":110},
            {"id":3,"title":"Last","start":120}
        ]"""))
        val session = BooksPlaybackApi.parse(server, "book-1", json)
        assertEquals(listOf(
            BooksChapter("Chapter 8", 60_000, 100_000, 0),
            BooksChapter("Last", 120_000, 180_000, 3),
        ), session.chapters)
        assertEquals(-1, session.chapterAt(0))
        assertEquals(-1, session.chapterAt(110_000))
        assertEquals(1, session.chapterAt(session.position(1, 70_000)))
        assertEquals(75_500L, session.resumeMs)
    }

    @Test
    fun singleFileWithEmbeddedChaptersUsesSameTimeline() {
        val json = response()
            .put("audioTracks", JSONArray("""[
                {"startOffset":0,"duration":180,"contentUrl":"/api/items/book-1/file/123"}
            ]"""))
            .put("chapters", JSONArray("""[
                {"id":0,"title":"Introduction","start":0,"end":75},
                {"id":1,"title":"Chapter One","start":75,"end":180}
            ]"""))
        val session = BooksPlaybackApi.parse(server, "book-1", json)
        assertEquals(1, session.tracks.size)
        assertEquals(1, session.chapterAt(session.resumeMs))
        assertEquals(BooksChapter("Chapter One", 75_000, 180_000, 1), session.chapters[1])
    }

    @Test
    fun absentChaptersDoNotInventTrackBasedSections() {
        val json = response()
        json.remove("chapters")
        val multi = BooksPlaybackApi.parse(server, "book-1", json)
        assertTrue(multi.chapters.isEmpty())
        assertEquals(-1, multi.chapterAt(60_000))
        json.put("audioTracks", JSONArray("""[
            {"startOffset":0,"duration":180,"contentUrl":"/api/items/book-1/file/123"}
        ]"""))
        for (chapters in listOf(JSONArray(), JSONArray("[null]"))) {
            val single = BooksPlaybackApi.parse(server, "book-1", json.put("chapters", chapters))
            assertTrue(single.chapters.isEmpty())
            assertEquals(-1, single.chapterAt(single.resumeMs))
        }
    }

    @Test
    fun rejectsTrackUrlsOutsideTheSelectedItemAndServer() {
        for (path in listOf("https://evil.example/audio", "//evil.example/audio", "/api/items/other/file/123", "/api/items/book-1/file/../123", "/api/items/book-1/file/123?token=x")) {
            val json = response()
            json.getJSONArray("audioTracks").getJSONObject(0).put("contentUrl", path)
            assertThrows(IllegalArgumentException::class.java) { BooksPlaybackApi.parse(server, "book-1", json) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            BooksPlaybackApi.parse(server, "book-1", response().put("playMethod", 2))
        }
    }

    @Test
    fun playbackRequestsResumeAndSyncWithBearerAndClosesWithoutOverwritingUntouchedProgress() {
        val requests = mutableListOf<Pair<String, JSONObject>>()
        val api = BooksPlaybackApi(BooksConnection(address, "key"), BooksAuthHttp { url, headers, body ->
            assertEquals(mapOf("Authorization" to "Bearer key"), headers)
            requests.add(url to JSONObject(body))
            BooksHttpResponse(200, if (url.endsWith("/play")) response().toString() else "OK")
        })
        val session = api.start("book-1", "device-1")
        assertEquals("$address/api/items/book-1/play", requests[0].first)
        assertEquals(true, requests[0].second.getBoolean("forceDirectPlay"))
        assertEquals("device-1", requests[0].second.getJSONObject("deviceInfo").getString("deviceId"))
        api.update(session, 80_500, 5_000, false)
        assertEquals("$address/api/session/session-1/sync", requests[1].first)
        assertEquals(80.5, requests[1].second.getDouble("currentTime"))
        assertEquals(5.0, requests[1].second.getDouble("timeListened"))
        assertEquals(180.0, requests[1].second.getDouble("duration"))
        api.update(session, session.resumeMs, 0, true, false)
        assertEquals("$address/api/session/session-1/close", requests[2].first)
        assertEquals(0, requests[2].second.length())
    }

    @Test
    fun malformedSessionIsClosedWithoutUpdatingProgress() {
        val requests = mutableListOf<String>()
        val api = BooksPlaybackApi(BooksConnection(address, "key"), BooksAuthHttp { url, _, body ->
            requests.add(url)
            if (url.endsWith("/close")) assertEquals(0, JSONObject(body).length())
            BooksHttpResponse(200, if (url.endsWith("/play")) response().put("playMethod", 2).toString() else "OK")
        })
        assertThrows(IllegalArgumentException::class.java) { api.start("book-1", "device-1") }
        assertEquals(listOf("$address/api/items/book-1/play", "$address/api/session/session-1/close"), requests)
    }
}
