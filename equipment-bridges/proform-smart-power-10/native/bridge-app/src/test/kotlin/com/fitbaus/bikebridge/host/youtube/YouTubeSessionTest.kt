// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import com.fitbaus.bikebridge.host.youtube.FakeCatalog.Companion.network
import com.fitbaus.bikebridge.host.youtube.FakeCatalog.Companion.playable
import com.fitbaus.bikebridge.host.youtube.FakeCatalog.Companion.video
import com.fitbaus.bikebridge.host.youtube.FakeCatalog.Companion.videos
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class YouTubeSessionTest {
    private val catalog = FakeCatalog()
    private val runner = QueueRunner()
    private val engines = FakeEngines()
    private val preparer = FakePreparer()
    private val savedHeights = ArrayList<Int>()
    private var catalogsCreated = 0
    private val session = YouTubeSession(
        catalogFactory = {
            catalogsCreated += 1
            catalog
        },
        runner = runner,
        main = MainThread { it() },
        engineFactory = engines,
        preparer = preparer,
        onMaxHeightChanged = { savedHeights += it },
    )

    @Test
    fun startingLoadsADiscoveryFeedOffTheUiThread() {
        assertEquals(ListStatus.Idle, session.state.browse.status)
        session.start()
        assertEquals(ListStatus.Loading, session.state.browse.status)
        assertEquals(0, catalogsCreated, "no extractor work before the background task runs")
        runner.runAll()
        val browse = session.state.browse
        assertEquals(ListStatus.Ready, browse.status)
        assertEquals("Trending", browse.title)
        assertEquals(3, browse.items.size)
        assertTrue(browse.canLoadMore)
        assertEquals(listOf("discover"), catalog.calls)
    }

    @Test
    fun searchResultsReplaceTheListAndEmptyQueryReturnsToDiscovery() {
        session.start()
        runner.runAll()
        session.search("  cycling music  ")
        runner.runAll()
        assertEquals("cycling music", session.state.browse.query)
        assertEquals(2, session.state.browse.items.size)
        assertEquals(ListStatus.Ready, session.state.browse.status)
        session.search("   ")
        runner.runAll()
        assertNull(session.state.browse.query)
        assertEquals(listOf("discover", "search:cycling music", "discover"), catalog.calls)
    }

    @Test
    fun emptySearchIsARecoverableEmptyState() {
        catalog.searchPages["zzzz"] = { FeedPage(emptyList(), null) }
        session.start()
        runner.runAll()
        session.search("zzzz")
        runner.runAll()
        val browse = session.state.browse
        assertEquals(ListStatus.Empty, browse.status)
        assertEquals("No videos found.", browse.message)
        assertFalse(browse.canLoadMore)
        catalog.searchPages["zzzz"] = { FeedPage(videos("zzzz", 1), null) }
        session.retry()
        runner.runAll()
        assertEquals(ListStatus.Ready, session.state.browse.status)
    }

    @Test
    fun failedSearchShowsAnErrorAndRetriesOnlyWhenAsked() {
        catalog.searchPages["bikes"] = network()
        session.start()
        runner.runAll()
        session.search("bikes")
        runner.runAll()
        assertEquals(ListStatus.Error, session.state.browse.status)
        assertEquals(YouTubeFormat.failure(FailureKind.Network), session.state.browse.message)
        assertEquals(0, runner.pending, "no automatic retry")
        catalog.searchPages.remove("bikes")
        session.retry()
        runner.runAll()
        assertEquals(ListStatus.Ready, session.state.browse.status)
        assertEquals(2, catalog.calls.count { it == "search:bikes" })
    }

    @Test
    fun rateLimitAndExtractionFailuresAreClassified() {
        catalog.discoverPage = { throw YouTubeException(FailureKind.RateLimited, "429") }
        session.start()
        runner.runAll()
        assertEquals(YouTubeFormat.failure(FailureKind.RateLimited), session.state.browse.message)
        catalog.discoverPage = { throw IllegalStateException("parser drift") }
        session.retry()
        runner.runAll()
        assertEquals(YouTubeFormat.failure(FailureKind.Extraction), session.state.browse.message)
    }

    @Test
    fun staleListResponsesNeverOverwriteANewerQuery() {
        session.start()
        runner.runAll()
        session.search("first")
        session.search("second")
        runner.runLast()
        assertEquals("second", session.state.browse.query)
        val secondItems = session.state.browse.items
        runner.runAll()
        assertEquals(secondItems, session.state.browse.items, "the slower first response is dropped")
        assertEquals("second", session.state.browse.query)
        assertTrue(runner.cancellations >= 1)
    }

    @Test
    fun loadMoreAppendsDeduplicatesAndStopsAtTheEnd() {
        val first = videos("trend", 3)
        catalog.discoverPage = { FeedPage(first, FakeCursor(2)) }
        catalog.morePage = { FeedPage(listOf(first[0]) + videos("page2", 2), null) }
        session.start()
        runner.runAll()
        session.loadMore(false)
        assertTrue(session.state.browse.loadingMore)
        session.loadMore(false)
        assertEquals(1, runner.pending, "only one page request at a time")
        runner.runAll()
        val browse = session.state.browse
        assertEquals(5, browse.items.size)
        assertEquals(5, browse.items.map { it.id }.toSet().size)
        assertFalse(browse.canLoadMore)
        session.loadMore(false)
        assertEquals(0, runner.pending)
    }

    @Test
    fun failedPageLoadWaitsForTheUserBeforeTryingAgain() {
        catalog.morePage = { throw IOException() }
        session.start()
        runner.runAll()
        session.loadMore(false)
        runner.runAll()
        assertTrue(session.state.browse.moreFailed)
        session.loadMore(false)
        assertEquals(0, runner.pending, "scrolling does not retry a failed page")
        catalog.morePage = { FeedPage(videos("page2", 2), null) }
        session.loadMore(true)
        runner.runAll()
        assertFalse(session.state.browse.moreFailed)
        assertEquals(5, session.state.browse.items.size)
    }

    @Test
    fun loadMoreFromAnOlderQueryIsDropped() {
        session.start()
        runner.runAll()
        session.loadMore(false)
        session.search("new")
        runner.runNext()
        runner.runNext()
        assertEquals("new", session.state.browse.query)
        assertEquals(2, session.state.browse.items.size)
        assertFalse(session.state.browse.loadingMore)
    }

    @Test
    fun selectingAVideoResolvesAndPlaysInsideTheTab() {
        session.start()
        runner.runAll()
        val target = session.state.browse.items[1]
        session.open(target)
        assertEquals(Screen.Player, session.state.screen)
        assertEquals(PlaybackPhase.Resolving, session.state.playback.phase)
        assertTrue(engines.created.isEmpty(), "no player until the stream is resolved")
        runner.runAll()
        val engine = engines.last
        val plan = engine.prepared.single().first as StreamPlan.Streams
        assertEquals(360, plan.height)
        assertNotNull(plan.audio, "separate audio is attached to a video-only stream")
        assertEquals(PlaybackPhase.Buffering, session.state.playback.phase)
        engine.listener.onReady(true)
        assertEquals(PlaybackPhase.Playing, session.state.playback.phase)
        assertEquals(360, session.state.playback.activeHeight)
    }

    @Test
    fun switchingVideosReleasesThePreviousPlayerAndIgnoresItsLateCallbacks() {
        session.start()
        runner.runAll()
        val (a, b) = session.state.browse.items
        session.open(a)
        runner.runAll()
        val first = engines.last
        first.listener.onReady(true)
        session.open(b)
        assertTrue(first.released)
        first.listener.onFailure(PlaybackFailure.Network, "late")
        first.listener.onEnded()
        assertEquals(PlaybackPhase.Resolving, session.state.playback.phase)
        assertEquals(b.id, session.state.playback.video?.id)
        runner.runAll()
        assertEquals(1, engines.live.size, "never more than one player")
        assertEquals(b.id, session.state.playback.video?.id)
    }

    @Test
    fun rapidVideoChangesCannotApplyAStaleResolution() {
        session.start()
        runner.runAll()
        val (a, b) = session.state.browse.items
        session.open(a)
        session.open(b)
        runner.runLast()
        assertEquals(0, engines.created.size, "the player is attached only after the stream is prepared off the UI thread")
        runner.runLast()
        assertEquals(1, engines.created.size)
        runner.runAll()
        assertEquals(1, engines.created.size, "the late resolution of the first video creates no player")
        assertEquals(b.id, session.state.playback.video?.id)
        assertEquals(listOf("discover", "resolve:${b.id}"), catalog.calls.filter { it != "resolve:${a.id}" })
    }

    @Test
    fun backReleasesThePlayerAndKeepsTheResults() {
        session.start()
        runner.runAll()
        val items = session.state.browse.items
        session.open(items[0])
        runner.runAll()
        session.back()
        assertTrue(engines.last.released)
        assertEquals(Screen.Results, session.state.screen)
        assertEquals(items, session.state.browse.items)
        assertEquals(PlaybackPhase.Idle, session.state.playback.phase)
    }

    @Test
    fun leavingTheTabStopsPlaybackCancelsWorkAndDropsLateResults() {
        session.start()
        runner.runAll()
        session.open(session.state.browse.items[0])
        runner.runAll()
        session.search("late")
        session.stop()
        assertTrue(engines.last.released)
        assertFalse(session.state.active)
        assertEquals(Screen.Results, session.state.screen)
        assertEquals(ListStatus.Idle, session.state.browse.status, "an interrupted load is not left spinning")
        runner.runAll()
        assertEquals(ListStatus.Idle, session.state.browse.status)
        session.start()
        assertEquals(ListStatus.Loading, session.state.browse.status, "returning reloads what was interrupted")
        runner.runAll()
        assertEquals("late", session.state.browse.query)
        assertEquals(ListStatus.Ready, session.state.browse.status)
    }

    @Test
    fun stoppingDuringResolutionNeverCreatesAPlayer() {
        session.start()
        runner.runAll()
        session.open(session.state.browse.items[0])
        session.stop()
        runner.runAll()
        assertTrue(engines.created.isEmpty())
        assertFalse(session.hasEngine)
    }

    @Test
    fun returningToTheTabKeepsResultsAndResumesTheLastVideoPosition() {
        session.start()
        runner.runAll()
        val target = session.state.browse.items[0]
        session.open(target)
        runner.runAll()
        engines.last.positionMs = 42_000
        session.stop()
        session.start()
        assertEquals(Screen.Results, session.state.screen)
        assertEquals(3, session.state.browse.items.size)
        assertEquals(1, catalog.calls.count { it == "discover" }, "results are not refetched")
        session.open(target)
        runner.runAll()
        assertEquals(42_000, engines.last.prepared.single().second)
    }

    @Test
    fun destroyReleasesEverythingAndIgnoresLaterCalls() {
        session.start()
        runner.runAll()
        session.open(session.state.browse.items[0])
        runner.runAll()
        session.destroy()
        assertTrue(engines.last.released)
        assertTrue(runner.shutdown)
        session.start()
        session.search("after")
        session.open(video("abcdefghijk"))
        assertEquals(0, runner.pending)
        assertEquals(1, engines.created.size)
    }

    @Test
    fun expiredStreamUrlsAreRefreshedOnceAtTheSamePosition() {
        session.start()
        runner.runAll()
        val target = session.state.browse.items[0]
        session.open(target)
        runner.runAll()
        engines.last.positionMs = 90_000
        engines.last.listener.onFailure(PlaybackFailure.Expired, "403")
        assertEquals(PlaybackPhase.Resolving, session.state.playback.phase)
        runner.runAll()
        assertEquals(2, engines.created.size)
        assertEquals(90_000, engines.last.prepared.single().second)
        engines.last.listener.onFailure(PlaybackFailure.Expired, "403 again")
        assertEquals(PlaybackPhase.Error, session.state.playback.phase)
        assertEquals(0, runner.pending, "the second expiry does not retry")
        assertEquals(2, catalog.calls.count { it == "resolve:${target.id}" })
    }

    @Test
    fun decoderFailureFallsBackToAnotherCodecOnce() {
        session.start()
        runner.runAll()
        session.open(session.state.browse.items[0])
        runner.runAll()
        assertEquals(CodecFamily.Avc, (engines.last.prepared.single().first as StreamPlan.Streams).video.family)
        engines.last.listener.onFailure(PlaybackFailure.Decoder, "decoder init")
        assertEquals(0, engines.live.size, "the failed player is released before the fallback is prepared")
        runner.runAll()
        assertEquals(CodecFamily.Vp9, (engines.last.prepared.single().first as StreamPlan.Streams).video.family)
        assertEquals(1, engines.live.size)
        engines.last.listener.onFailure(PlaybackFailure.Decoder, "decoder init")
        assertEquals(PlaybackPhase.Error, session.state.playback.phase)
        assertEquals(YouTubeFormat.failure(FailureKind.Unsupported), session.state.playback.message)
        assertEquals(0, engines.live.size)
    }

    @Test
    fun playbackErrorsStopUntilTheUserRetries() {
        session.start()
        runner.runAll()
        session.open(session.state.browse.items[0])
        runner.runAll()
        engines.last.listener.onFailure(PlaybackFailure.Network, "timeout")
        assertEquals(PlaybackPhase.Error, session.state.playback.phase)
        assertEquals(0, runner.pending)
        assertEquals(0, engines.live.size)
        session.retry()
        runner.runAll()
        assertEquals(2, engines.created.size)
        assertEquals(PlaybackPhase.Buffering, session.state.playback.phase)
    }

    @Test
    fun unavailableAndUnplayableVideosShowRecoverableErrors() {
        catalog.resolutions["restricted1"] = { throw YouTubeException(FailureKind.Restricted, "age") }
        catalog.resolutions["nostreams11"] = { ResolvedVideo(video("nostreams11"), StreamOptions(emptyList(), null, false), FakeHandle("x")) }
        session.start()
        runner.runAll()
        session.open(video("restricted1"))
        runner.runAll()
        assertEquals(YouTubeFormat.failure(FailureKind.Restricted), session.state.playback.message)
        session.open(video("nostreams11"))
        runner.runAll()
        assertEquals(YouTubeFormat.failure(FailureKind.Unsupported), session.state.playback.message)
        assertTrue(engines.created.isEmpty())
        session.back()
        assertEquals(Screen.Results, session.state.screen)
    }

    @Test
    fun mediaPreparationFailureShowsAnErrorWithoutAPlayer() {
        session.start()
        runner.runAll()
        preparer.failNext = YouTubeException(FailureKind.Network, "otf manifest fetch failed")
        session.open(session.state.browse.items[0])
        runner.runAll()
        assertEquals(PlaybackPhase.Error, session.state.playback.phase)
        assertEquals(YouTubeFormat.failure(FailureKind.Network), session.state.playback.message)
        assertTrue(engines.created.isEmpty())
        session.retry()
        runner.runAll()
        assertEquals(1, engines.live.size)
    }

    @Test
    fun leavingWhileTheStreamIsBeingPreparedNeverCreatesAPlayer() {
        session.start()
        runner.runAll()
        session.open(session.state.browse.items[0])
        runner.runNext()
        assertEquals(1, runner.pending, "media preparation is queued on the background thread")
        session.back()
        runner.runAll()
        assertTrue(engines.created.isEmpty())
        assertEquals(1, preparer.plans.size)
    }

    @Test
    fun aVideoOnlyAvailableAboveTheLimitShowsAQualityErrorInsteadOfUpscaling() {
        catalog.resolutions["onlyhigh480"] = {
            ResolvedVideo(
                video("onlyhigh480"),
                StreamOptions(
                    listOf(
                        YouTubeStreamSelectorTest.videoOnly(0, Container.Mp4, "avc1.4d401f", 480),
                        YouTubeStreamSelectorTest.videoOnly(1, Container.Mp4, "avc1.4d401f", 720),
                        YouTubeStreamSelectorTest.audio(2, Container.M4a, "mp4a.40.2", 128_000),
                    ),
                    null,
                    false,
                ),
                FakeHandle("onlyhigh480"),
            )
        }
        session.start()
        runner.runAll()
        session.open(video("onlyhigh480"))
        runner.runAll()
        assertEquals(PlaybackPhase.Error, session.state.playback.phase)
        assertEquals(YouTubeFormat.qualityUnavailable(360, 480), session.state.playback.message)
        assertTrue(preparer.plans.isEmpty())
        assertTrue(engines.created.isEmpty())
        session.back()
        session.setMaxHeight(480)
        session.open(video("onlyhigh480"))
        runner.runAll()
        assertEquals(480, (engines.last.prepared.single().first as StreamPlan.Streams).height, "raising the limit plays it")
    }

    @Test
    fun hlsWithNoVariantWithinTheLimitStopsWithAQualityError() {
        catalog.resolutions["livestream1"] = { playable("livestream1", live = true) }
        session.start()
        runner.runAll()
        session.open(video("livestream1", live = true))
        runner.runAll()
        assertEquals(StreamPlan.Hls("https://example.invalid/live.m3u8", 360), engines.last.prepared.single().first)
        engines.last.listener.onFailure(PlaybackFailure.QualityUnavailable, "no video track within the height limit")
        assertEquals(YouTubeFormat.qualityUnavailable(360, null), session.state.playback.message)
        assertEquals(0, engines.live.size)
        assertEquals(0, runner.pending)
    }

    @Test
    fun prepareFailureReleasesThePlayer() {
        session.start()
        runner.runAll()
        engines.failNextPrepare = YouTubeException(FailureKind.Unsupported, "no itag")
        session.open(session.state.browse.items[0])
        runner.runAll()
        assertEquals(PlaybackPhase.Error, session.state.playback.phase)
        assertTrue(engines.last.released)
    }

    @Test
    fun qualityChangeReplansWithASinglePlayerAndPersists() {
        session.start()
        runner.runAll()
        session.open(session.state.browse.items[0])
        runner.runAll()
        engines.last.positionMs = 30_000
        session.setMaxHeight(480)
        assertEquals(listOf(480), savedHeights)
        assertEquals(0, engines.live.size)
        runner.runAll()
        assertEquals(2, engines.created.size)
        assertEquals(1, engines.live.size)
        val plan = engines.last.prepared.single()
        assertEquals(480, (plan.first as StreamPlan.Streams).height)
        assertEquals(30_000, plan.second)
        assertEquals(1, catalog.calls.count { it.startsWith("resolve:") }, "no new extraction for a quality change")
        session.setMaxHeight(1080)
        assertEquals(360, session.state.playback.maxHeight, "unsupported choices fall back to the default")
    }

    @Test
    fun pauseResumeSeekAndReplayDriveTheEngine() {
        session.start()
        runner.runAll()
        session.open(session.state.browse.items[0])
        runner.runAll()
        val engine = engines.last
        engine.listener.onReady(true)
        assertTrue(session.playRequested)
        session.togglePlay()
        assertEquals(PlaybackPhase.Paused, session.state.playback.phase)
        assertFalse(session.playRequested)
        session.togglePlay()
        assertEquals(PlaybackPhase.Playing, session.state.playback.phase)
        assertTrue(session.playRequested)
        session.seekTo(60_000)
        session.seekTo(-5)
        session.seekTo(10_000_000)
        assertEquals(listOf(60_000L, 0L, 125_000L), engine.seeks)
        engine.listener.onEnded()
        session.togglePlay()
        assertEquals(listOf(false, true, true), engine.playing)
        assertEquals(0L, engine.seeks.last())
        engine.positionMs = 5_000
        engine.durationMs = 125_000
        session.tick()
        assertEquals(5_000, session.state.playback.positionMs)
    }

    @Test
    fun liveVideosPlayFromHlsAndCannotSeek() {
        catalog.resolutions["livestream1"] = { playable("livestream1", live = true) }
        session.start()
        runner.runAll()
        session.open(video("livestream1", live = true))
        runner.runAll()
        assertTrue(engines.last.prepared.single().first is StreamPlan.Hls)
        session.seekTo(1_000)
        assertTrue(engines.last.seeks.isEmpty())
    }

    @Test
    fun nothingRunsWhileTheTabIsInactive() {
        session.search("hidden")
        session.loadMore(true)
        session.open(video("abcdefghijk"))
        session.retry()
        assertEquals(0, runner.pending)
        assertTrue(engines.created.isEmpty())
        assertEquals(0, catalogsCreated)
    }

    private class IOException : java.io.IOException()
}
