// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.schabi.newpipe.extractor.ListExtractor
import org.schabi.newpipe.extractor.Page
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.linkhandler.ListLinkHandler
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import org.schabi.newpipe.extractor.stream.StreamType

class NewPipePagingTest {
    private val offline = object : Downloader() {
        override fun execute(request: Request): Response = throw AssertionError("unit tests never reach the network: ${request.url()}")
    }
    private val catalog = NewPipeYouTubeCatalog(offline)
    private val firstIds = listOf("firstvid001", "firstvid002", "firstvid003")
    private val secondIds = listOf("firstvid002", "secondvid01", "secondvid02")

    @Test
    fun aDiscardedPageRequestDoesNotHideItemsFromTheRetry() {
        val extractor = TwoPageExtractor(firstIds, secondIds)
        val first = catalog.firstPage(extractor)
        assertEquals(firstIds, first.items.map { it.id })
        val cursor = first.cursor ?: throw AssertionError("the first page has a next-page cursor")
        val discarded = catalog.more(cursor)
        val retried = catalog.more(cursor)
        assertEquals(listOf("secondvid01", "secondvid02"), discarded.items.map { it.id }, "duplicates of shown items are still removed")
        assertEquals(discarded.items, retried.items, "retrying the same cursor returns the same new items")
        assertNull(retried.cursor)
        assertEquals(2, extractor.secondPageRequests)
    }

    @Test
    fun switchingTabsDuringAPageLoadThenRetryingShowsEveryNewVideo() {
        val extractor = TwoPageExtractor(firstIds, secondIds)
        val adapter = object : YouTubeCatalog {
            override fun discover(): FeedPage = catalog.firstPage(extractor)

            override fun search(query: String): FeedPage = throw AssertionError()

            override fun more(cursor: FeedCursor): FeedPage = catalog.more(cursor)

            override fun resolve(videoId: String): ResolvedVideo = throw AssertionError()
        }
        val runner = QueueRunner()
        val session = YouTubeSession({ adapter }, runner, MainThread { it() }, FakeEngines(), FakePreparer())
        session.start()
        runner.runAll()
        session.loadMore(false)
        session.stop()
        runner.runAll()
        assertEquals(firstIds, session.state.browse.items.map { it.id }, "the response that finished after leaving is discarded")
        session.start()
        session.loadMore(false)
        runner.runAll()
        assertEquals(firstIds + listOf("secondvid01", "secondvid02"), session.state.browse.items.map { it.id })
        assertEquals(2, extractor.secondPageRequests)
    }

    private class TwoPageExtractor(private val first: List<String>, private val second: List<String>) :
        ListExtractor<StreamInfoItem>(
            ServiceList.YouTube,
            ListLinkHandler("https://www.youtube.com/feed/trending", "https://www.youtube.com/feed/trending", "trending", emptyList(), ""),
        ) {
        var secondPageRequests = 0

        override fun onFetchPage(downloader: Downloader) {}

        override fun getName(): String = "two pages"

        override fun getInitialPage(): InfoItemsPage<StreamInfoItem> =
            InfoItemsPage(items(first), Page("https://example.invalid/page2"), emptyList())

        override fun getPage(page: Page?): InfoItemsPage<StreamInfoItem> {
            secondPageRequests += 1
            return InfoItemsPage(items(second), null, emptyList())
        }

        private fun items(ids: List<String>): List<StreamInfoItem> = ids.map {
            StreamInfoItem(ServiceList.YouTube.serviceId, "https://www.youtube.com/watch?v=$it", "Video $it", StreamType.VIDEO_STREAM)
        }
    }
}
