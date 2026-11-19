// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class YouTubeRecommendationsTest {
    private companion object {
        fun video(id: String, channel: String) =
            VideoSummary(id, id, channel, 120, 10, YouTubeIds.thumbnail(id), false)
    }

    private class Catalog : YouTubeCatalog {
        val seeds = ArrayList<List<VideoSummary>>()
        var fail = false

        override fun discover(): FeedPage = FeedPage(
            listOf(video("aaaaaaaaaaa", "One"), video("bbbbbbbbbbb", "Two")),
            null,
        )

        override fun search(query: String): FeedPage = FeedPage(emptyList(), null)
        override fun more(cursor: FeedCursor): FeedPage = FeedPage(emptyList(), null)
        override fun resolve(videoId: String): ResolvedVideo = error("Not required")

        override fun related(seeds: List<VideoSummary>): FeedPage {
            this.seeds += seeds
            if (fail) throw YouTubeException(FailureKind.RateLimited, "limited")
            return FeedPage(listOf(video("ccccccccccc", "Another")), null)
        }
    }

    @Test
    fun discoveryIsExplicitAndUsesSeparateWorkerWithoutChangingHome() {
        val catalog = Catalog()
        val browseRunner = QueueRunner()
        val relatedRunner = QueueRunner()
        val session = YouTubeSession(
            catalogFactory = { catalog },
            runner = browseRunner,
            recommendationRunner = relatedRunner,
            main = MainThread { it() },
            engineFactory = FakeEngines(),
            preparer = FakePreparer(),
            feedTitle = { "From your channels" },
        )
        session.start()
        browseRunner.runAll()
        assertEquals(ListStatus.Idle, session.state.recommendations.status)
        assertEquals(0, relatedRunner.pending)
        val home = session.state.browse.items
        session.loadRecommendations()
        assertEquals(ListStatus.Loading, session.state.recommendations.status)
        assertEquals(0, browseRunner.pending)
        relatedRunner.runAll()
        assertEquals(ListStatus.Ready, session.state.recommendations.status)
        assertEquals("ccccccccccc", session.state.recommendations.items.single().id)
        assertEquals(home, session.state.browse.items)
        assertEquals(listOf("aaaaaaaaaaa", "bbbbbbbbbbb"), catalog.seeds.single().map { it.id })
        session.loadRecommendations()
        assertEquals(0, relatedRunner.pending)
        session.destroy()
        assertTrue(relatedRunner.shutdown)
    }

    @Test
    fun staleDiscoveryCannotReplaceSearchAndUserMustRetryFailures() {
        val catalog = Catalog()
        val browseRunner = QueueRunner()
        val relatedRunner = QueueRunner()
        val session = YouTubeSession(
            catalogFactory = { catalog },
            runner = browseRunner,
            recommendationRunner = relatedRunner,
            main = MainThread { it() },
            engineFactory = FakeEngines(),
            preparer = FakePreparer(),
            feedTitle = { "From your channels" },
        )
        session.start()
        browseRunner.runAll()
        session.loadRecommendations()
        session.search("something")
        relatedRunner.runAll()
        assertEquals(ListStatus.Idle, session.state.recommendations.status)
        browseRunner.runAll()
        session.showTrending()
        browseRunner.runAll()
        catalog.fail = true
        session.loadRecommendations()
        relatedRunner.runAll()
        assertEquals(ListStatus.Error, session.state.recommendations.status)
        assertEquals(YouTubeFormat.failure(FailureKind.RateLimited), session.state.recommendations.message)
        catalog.fail = false
        session.loadRecommendations(force = true)
        relatedRunner.runAll()
        assertEquals(ListStatus.Ready, session.state.recommendations.status)
        session.destroy()
    }
}
