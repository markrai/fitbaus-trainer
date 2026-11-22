// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import java.io.IOException

internal class QueueRunner : BackgroundRunner {
    private class Job(val task: () -> Unit) {
        var cancelled = false
    }

    private val jobs = ArrayDeque<Job>()
    var shutdown = false
        private set
    var cancellations = 0
        private set

    val pending: Int
        get() = jobs.count { !it.cancelled }

    override fun submit(task: () -> Unit): Cancellable {
        val job = Job(task)
        if (!shutdown) jobs.addLast(job)
        return Cancellable {
            if (!job.cancelled) cancellations += 1
            job.cancelled = true
        }
    }

    fun runNext() {
        val job = jobs.removeFirst()
        job.task()
    }

    fun runLast() {
        val job = jobs.removeLast()
        job.task()
    }

    fun runAll() {
        while (jobs.isNotEmpty()) runNext()
    }

    override fun shutdown() {
        shutdown = true
    }
}

internal class FakeHandle(val id: String) : ResolvedHandle

internal class FakeCursor(val page: Int) : FeedCursor

internal class FakeCatalog : YouTubeCatalog {
    var discoverPage: () -> FeedPage = { FeedPage(videos("trend", 3), FakeCursor(2)) }
    var relatedPage: (List<VideoSummary>) -> FeedPage = { FeedPage(emptyList(), null) }
    val searchPages = HashMap<String, () -> FeedPage>()
    var morePage: (FakeCursor) -> FeedPage = { FeedPage(videos("more${it.page}", 2), null) }
    val resolutions = HashMap<String, () -> ResolvedVideo>()
    val calls = ArrayList<String>()

    override fun discover(): FeedPage {
        calls += "discover"
        return discoverPage()
    }

    override fun search(query: String): FeedPage {
        calls += "search:$query"
        return (searchPages[query] ?: { FeedPage(videos(query, 2), null) })()
    }

    override fun related(seeds: List<VideoSummary>): FeedPage {
        calls += "related"
        return relatedPage(seeds)
    }

    override fun more(cursor: FeedCursor): FeedPage {
        calls += "more:${(cursor as FakeCursor).page}"
        return morePage(cursor)
    }

    override fun resolve(videoId: String): ResolvedVideo {
        calls += "resolve:$videoId"
        return (resolutions[videoId] ?: { playable(videoId) })()
    }

    companion object {
        fun video(id: String, title: String = "Video $id", live: Boolean = false) =
            VideoSummary(id, title, "Channel", 125, 1_234, YouTubeIds.thumbnail(id), live)

        fun videos(prefix: String, count: Int): List<VideoSummary> =
            (1..count).map { video("${prefix.take(6).padEnd(6, 'x')}${it.toString().padStart(5, '0')}") }

        fun playable(id: String, live: Boolean = false): ResolvedVideo {
            val candidates = listOf(
                YouTubeStreamSelectorTest.videoOnly(0, Container.Mp4, "avc1.4d401e", 360),
                YouTubeStreamSelectorTest.videoOnly(1, Container.Mp4, "avc1.4d401f", 480),
                YouTubeStreamSelectorTest.videoOnly(2, Container.WebM, "vp9", 360),
                YouTubeStreamSelectorTest.audio(3, Container.M4a, "mp4a.40.2", 129_000),
            )
            return ResolvedVideo(video(id, live = live), StreamOptions(candidates, if (live) "https://example.invalid/live.m3u8" else null, live), FakeHandle(id))
        }

        fun network(): () -> Nothing = { throw IOException("offline") }
    }
}

internal class FakeEngine(val listener: PlayerEngineListener) : PlayerEngine {
    val prepared = ArrayList<Pair<StreamPlan, Long>>()
    val playing = ArrayList<Boolean>()
    val seeks = ArrayList<Long>()
    val captionsEnabled = ArrayList<Boolean>()
    var released = false
        private set
    var failPrepare: Exception? = null
    override var positionMs: Long = 0
    override var durationMs: Long = 0
    override var bufferedMs: Long = 0

    override fun prepare(media: PreparedMedia, startMs: Long) {
        failPrepare?.let { throw it }
        prepared += (media as FakeMedia).plan to startMs
        positionMs = startMs
    }

    override fun setPlaying(playing: Boolean) {
        this.playing += playing
    }

    override fun setCaptionsEnabled(enabled: Boolean) {
        captionsEnabled += enabled
    }

    override fun seekTo(positionMs: Long) {
        seeks += positionMs
        this.positionMs = positionMs
    }

    override fun release() {
        check(!released) { "released twice" }
        released = true
    }
}

internal class FakeMedia(val plan: StreamPlan) : PreparedMedia

internal class FakePreparer : MediaPreparer {
    val plans = ArrayList<StreamPlan>()
    var failNext: Exception? = null

    override fun prepare(handle: ResolvedHandle, plan: StreamPlan): PreparedMedia {
        failNext?.let {
            failNext = null
            throw it
        }
        plans += plan
        return FakeMedia(plan)
    }
}

internal class FakeEngines : PlayerEngineFactory {
    val created = ArrayList<FakeEngine>()
    var failNextPrepare: Exception? = null

    val live: List<FakeEngine>
        get() = created.filter { !it.released }

    val last: FakeEngine
        get() = created.last()

    override fun create(listener: PlayerEngineListener): PlayerEngine {
        val engine = FakeEngine(listener)
        failNextPrepare?.let {
            engine.failPrepare = it
            failNextPrepare = null
        }
        created += engine
        return engine
    }
}
