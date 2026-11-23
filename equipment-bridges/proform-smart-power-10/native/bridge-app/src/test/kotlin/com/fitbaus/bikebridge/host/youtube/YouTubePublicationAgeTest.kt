// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import java.time.Instant
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class YouTubePublicationAgeTest {
    private val now = Instant.parse("2026-11-23T12:00:00Z").epochSecond

    @Test
    fun ageUsesMinutesHoursAndDaysWithSingularForms() {
        assertEquals("just now", YouTubeFormat.age(now - 59, now))
        assertEquals("1 min ago", YouTubeFormat.age(now - 60, now))
        assertEquals("59 mins ago", YouTubeFormat.age(now - 3599, now))
        assertEquals("1 hr ago", YouTubeFormat.age(now - 3600, now))
        assertEquals("2 hrs ago", YouTubeFormat.age(now - 7200, now))
        assertEquals("23 hrs ago", YouTubeFormat.age(now - 86_399, now))
        assertEquals("1 day ago", YouTubeFormat.age(now - 86_400, now))
        assertEquals("2 days ago", YouTubeFormat.age(now - 172_800, now))
    }

    @Test
    fun monthsAndYearsAreCalendarBased() {
        assertEquals("1 month ago", YouTubeFormat.age(Instant.parse("2026-10-23T12:00:00Z").epochSecond, now))
        assertEquals("2 months ago", YouTubeFormat.age(Instant.parse("2026-09-23T12:00:00Z").epochSecond, now))
        assertEquals("1 yr ago", YouTubeFormat.age(Instant.parse("2025-11-23T12:00:00Z").epochSecond, now))
        assertEquals("3 yrs ago", YouTubeFormat.age(Instant.parse("2023-11-23T12:00:00Z").epochSecond, now))
        assertEquals("30 days ago", YouTubeFormat.age(Instant.parse("2026-01-15T12:00:00Z").epochSecond, Instant.parse("2026-02-14T12:00:00Z").epochSecond))
    }

    @Test
    fun invalidMissingAndFutureDatesAreNotDisplayed() {
        assertEquals("", YouTubeFormat.age(null, now))
        assertEquals("", YouTubeFormat.age(0, now))
        assertEquals("", YouTubeFormat.age(now + 30, now))
        assertEquals(null, YouTubeFormat.publicationTimestamp("not-a-date"))
        assertEquals(null, YouTubeFormat.publicationTimestamp(""))
        assertEquals(null, YouTubeFormat.publicationTimestamp("x".repeat(500)))
        assertEquals(Instant.parse("2026-11-22T12:00:00Z").epochSecond, YouTubeFormat.publicationTimestamp("2026-11-22T12:00:00Z"))
        assertEquals(Instant.parse("2026-11-22T12:00:00Z").epochSecond, YouTubeFormat.publicationTimestamp("2026-11-22T07:00:00-05:00"))
    }

    @Test
    fun previewShowsChannelViewsAndAgeWithoutInventingMissingValues() {
        val video = VideoSummary(
            id = "jNQXAC9IVRw",
            title = "Test",
            channel = "Cycling",
            durationSeconds = 200,
            viewCount = 12_345,
            thumbnailUrl = YouTubeIds.thumbnail("jNQXAC9IVRw"),
            live = false,
            publishedAtEpochSeconds = now - 2 * 86_400,
        )
        assertEquals("Cycling  ·  12.3K views  ·  2 days ago", YouTubeFormat.previewMeta(video, now))
        assertEquals("Cycling  ·  12.3K views", YouTubeFormat.previewMeta(video.copy(publishedAtEpochSeconds = null), now))
        assertEquals("Cycling  ·  2 days ago", YouTubeFormat.previewMeta(video.copy(viewCount = -1), now))
        assertEquals("Cycling  ·  12.3K views", YouTubeFormat.previewMeta(video.copy(live = true), now))
        assertEquals("Cycling  ·  12.3K views", YouTubeFormat.previewMeta(video.copy(publishedAtEpochSeconds = now + 100), now))
    }
}
