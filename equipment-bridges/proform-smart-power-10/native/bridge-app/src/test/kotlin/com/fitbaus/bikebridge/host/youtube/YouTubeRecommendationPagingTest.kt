// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.IOException

class YouTubeRecommendationPagingTest {
    private val catalog = FakeCatalog()
    private val listWorker = QueueRunner()
    private val recommendationWorker = QueueRunner()
    private val session = YouTubeSession(
        catalogFactory = { catalog },
        runner = listWorker,
        recommendationRunner = recommendationWorker,
        main = MainThread { it() },
        engineFactory = FakeEngines(),
        preparer = FakePreparer(),
        feedTitle = { "From your channels" },
    )

    private fun startWithRecommendations(first: List<VideoSummary>, cursor: FeedCursor? = FakeCursor(2)) {
        catalog.discoverPage = { FeedPage(FakeCatalog.videos("home", 6), null) }
        catalog.relatedPage = { FeedPage(first, cursor) }
        session.start()
        listWorker.runAll()
        session.loadRecommendations()
        recommendationWorker.runAll()
    }

    @Test
    fun scrollingLoadsOneMoreBatchAndDeduplicatesAcrossPages() {
        val first = FakeCatalog.videos("related", 24)
        val second = FakeCatalog.videos("page2", 24)
        startWithRecommendations(first)
        assertTrue(session.state.recommendations.canLoadMore)
        catalog.morePage = { FeedPage(listOf(first[0]) + second, null) }
        session.loadMoreRecommendations(false)
        session.loadMoreRecommendations(false)
        assertTrue(session.state.recommendations.loadingMore)
        assertEquals(1, recommendationWorker.pending)
        recommendationWorker.runAll()
        val recommendations = session.state.recommendations
        assertEquals(48, recommendations.items.size)
        assertEquals(48, recommendations.items.map { it.id }.toSet().size)
        assertFalse(recommendations.canLoadMore)
        session.loadMoreRecommendations(false)
        assertEquals(0, recommendationWorker.pending)
        assertEquals(1, catalog.calls.count { it == "more:2" })
    }

    @Test
    fun failedContinuationWaitsForTapAndPreservesExistingResults() {
        val first = FakeCatalog.videos("related", 8)
        startWithRecommendations(first)
        catalog.morePage = { throw IOException("offline") }
        session.loadMoreRecommendations(false)
        recommendationWorker.runAll()
        assertTrue(session.state.recommendations.moreFailed)
        assertEquals(first, session.state.recommendations.items)
        session.loadMoreRecommendations(false)
        assertEquals(0, recommendationWorker.pending)
        catalog.morePage = { FeedPage(FakeCatalog.videos("page2", 6), null) }
        session.loadMoreRecommendations(true)
        recommendationWorker.runAll()
        assertEquals(14, session.state.recommendations.items.size)
        assertFalse(session.state.recommendations.moreFailed)
    }

    @Test
    fun emptyBatchCanAdvanceManuallyWithoutDiscardingEarlierVideos() {
        val first = FakeCatalog.videos("related", 5)
        startWithRecommendations(first)
        catalog.morePage = { FeedPage(emptyList(), FakeCursor(3)) }
        session.loadMoreRecommendations(false)
        recommendationWorker.runAll()
        assertEquals(first, session.state.recommendations.items)
        assertTrue(session.state.recommendations.canLoadMore)
        assertTrue(session.state.recommendations.message != null)
        session.loadMoreRecommendations(false)
        assertEquals(0, recommendationWorker.pending)
        catalog.morePage = { FeedPage(FakeCatalog.videos("page3", 2), null) }
        session.loadMoreRecommendations(true)
        recommendationWorker.runAll()
        assertEquals(7, session.state.recommendations.items.size)
        assertEquals(null, session.state.recommendations.message)
    }

    @Test
    fun openingPlayerCancelsPendingPageWithoutLosingContinuation() {
        val first = FakeCatalog.videos("related", 4)
        startWithRecommendations(first)
        catalog.morePage = { FeedPage(FakeCatalog.videos("page2", 4), null) }
        session.loadMoreRecommendations(false)
        session.open(first[0])
        assertFalse(session.state.recommendations.loadingMore)
        recommendationWorker.runAll()
        assertEquals(first, session.state.recommendations.items)
        session.back()
        session.loadMoreRecommendations(false)
        recommendationWorker.runAll()
        assertEquals(8, session.state.recommendations.items.size)
    }

    @Test
    fun staleContinuationCannotPopulateResultsAfterNewSearch() {
        startWithRecommendations(FakeCatalog.videos("related", 4))
        catalog.morePage = { FeedPage(FakeCatalog.videos("page2", 4), null) }
        session.loadMoreRecommendations(false)
        session.search("new query")
        listWorker.runAll()
        recommendationWorker.runAll()
        assertEquals("new query", session.state.browse.query)
        assertEquals(ListStatus.Idle, session.state.recommendations.status)
        assertTrue(session.state.recommendations.items.isEmpty())
    }

    @Test
    fun stoppingDuringContinuationPreservesExistingResultsAndAllowsRetry() {
        val first = FakeCatalog.videos("related", 4)
        startWithRecommendations(first)
        catalog.morePage = { FeedPage(FakeCatalog.videos("page2", 4), null) }
        session.loadMoreRecommendations(false)
        session.stop()
        recommendationWorker.runAll()
        assertEquals(first, session.state.recommendations.items)
        assertFalse(session.state.recommendations.loadingMore)
        session.start(loadDefault = false)
        session.loadMoreRecommendations(false)
        recommendationWorker.runAll()
        assertEquals(8, session.state.recommendations.items.size)
    }

    @Test
    fun emptyFirstBatchWithCursorCanBeAdvancedInsteadOfRepeated() {
        startWithRecommendations(emptyList(), FakeCursor(2))
        assertEquals(ListStatus.Empty, session.state.recommendations.status)
        assertTrue(session.state.recommendations.canLoadMore)
        catalog.morePage = { FeedPage(FakeCatalog.videos("page2", 3), null) }
        session.loadMoreRecommendations(true)
        recommendationWorker.runAll()
        assertEquals(ListStatus.Ready, session.state.recommendations.status)
        assertEquals(3, session.state.recommendations.items.size)
    }
}
