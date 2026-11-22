// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

internal fun interface Cancellable {
    fun cancel()
}

internal interface BackgroundRunner {
    fun submit(task: () -> Unit): Cancellable

    fun shutdown()
}

internal fun interface MainThread {
    fun post(block: () -> Unit)
}

internal class ExecutorRunner(private val name: String) : BackgroundRunner {
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, name).apply {
            isDaemon = true
            priority = Thread.NORM_PRIORITY - 1
        }
    }

    override fun submit(task: () -> Unit): Cancellable = try {
        val future = executor.submit(task)
        Cancellable { future.cancel(true) }
    } catch (_: RejectedExecutionException) {
        Cancellable {}
    }

    override fun shutdown() {
        executor.shutdownNow()
    }
}

internal enum class Screen { Results, Player }

internal enum class ListStatus { Idle, Loading, Ready, Empty, Error }

internal enum class PlaybackPhase { Idle, Resolving, Buffering, Playing, Paused, Ended, Error }

internal data class BrowseState(
    val query: String? = null,
    val feedTitle: String = "Trending",
    val items: List<VideoSummary> = emptyList(),
    val status: ListStatus = ListStatus.Idle,
    val message: String? = null,
    val canLoadMore: Boolean = false,
    val loadingMore: Boolean = false,
    val moreFailed: Boolean = false,
) {
    val title: String
        get() = if (query == null) feedTitle else "Results for “$query”"
}

internal data class PlaybackState(
    val video: VideoSummary? = null,
    val phase: PlaybackPhase = PlaybackPhase.Idle,
    val message: String? = null,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val bufferedMs: Long = 0,
    val maxHeight: Int = YouTubeStreamSelector.DEFAULT_MAX_HEIGHT,
    val activeHeight: Int = 0,
    val live: Boolean = false,
    val videoAspect: Float = 16f / 9f,
    val captionsAvailable: Boolean = false,
    val captionsEnabled: Boolean = false,
    val captionText: String = "",
)

internal data class RecommendationState(
    val items: List<VideoSummary> = emptyList(),
    val status: ListStatus = ListStatus.Idle,
    val message: String? = null,
    val canLoadMore: Boolean = false,
    val loadingMore: Boolean = false,
    val moreFailed: Boolean = false,
)

internal data class YouTubeState(
    val active: Boolean,
    val screen: Screen,
    val browse: BrowseState,
    val playback: PlaybackState,
    val recommendations: RecommendationState = RecommendationState(),
)

internal class YouTubeSession(
    private val catalogFactory: () -> YouTubeCatalog,
    private val runner: BackgroundRunner,
    private val main: MainThread,
    private val engineFactory: PlayerEngineFactory,
    private val preparer: MediaPreparer,
    initialMaxHeight: Int = YouTubeStreamSelector.DEFAULT_MAX_HEIGHT,
    private val onMaxHeightChanged: (Int) -> Unit = {},
    private val feedTitle: () -> String = { "Trending" },
    private val recommendationRunner: BackgroundRunner = ExecutorRunner("fitbaus-youtube-related"),
) {
    var listener: ((YouTubeState) -> Unit)? = null

    var state: YouTubeState = YouTubeState(false, Screen.Results, BrowseState(), PlaybackState(maxHeight = sanitizeHeight(initialMaxHeight)))
        private set

    private var catalog: YouTubeCatalog? = null
    private var destroyed = false
    private var listGeneration = 0L
    private var playGeneration = 0L
    private var listTask: Cancellable? = null
    private var playTask: Cancellable? = null
    private var recommendationGeneration = 0L
    private var recommendationTask: Cancellable? = null
    private var recommendationCursor: FeedCursor? = null
    private var cursor: FeedCursor? = null
    private var engine: PlayerEngine? = null
    private var resolved: ResolvedVideo? = null
    private var plan: StreamPlan? = null
    private var selector = YouTubeStreamSelector()
    private var expiredRetryUsed = false
    private var decoderFallbackUsed = false
    private var wantPlaying = true
    private var resumeVideoId: String? = null
    private var resumePositionMs = 0L

    val enginesCreated: Int
        get() = createdEngines

    private var createdEngines = 0

    val hasEngine: Boolean
        get() = engine != null

    val playRequested: Boolean
        get() = wantPlaying

    fun start(loadDefault: Boolean = true) {
        if (destroyed || state.active) return
        update(state.copy(active = true))
        val browse = state.browse
        if (loadDefault && browse.items.isEmpty() && browse.status != ListStatus.Loading) loadList(browse.query)
    }

    fun stop() {
        if (destroyed) return
        listGeneration += 1
        listTask?.cancel()
        listTask = null
        cancelRecommendation()
        stopPlayback()
        val browse = state.browse
        val settled = when {
            browse.status == ListStatus.Loading -> browse.copy(status = ListStatus.Idle, loadingMore = false)
            browse.loadingMore -> browse.copy(loadingMore = false)
            else -> browse
        }
        val recommendations = if (state.recommendations.status == ListStatus.Loading) {
            RecommendationState()
        } else state.recommendations.copy(loadingMore = false)
        update(state.copy(active = false, screen = Screen.Results, browse = settled, playback = idlePlayback(), recommendations = recommendations))
    }

    fun destroy() {
        if (destroyed) return
        stop()
        destroyed = true
        listener = null
        runner.shutdown()
        recommendationRunner.shutdown()
    }

    fun showTrending() {
        if (!ready()) return
        loadList(null)
    }

    fun search(raw: String) {
        if (!ready()) return
        val query = raw.trim().take(MAX_QUERY_LENGTH)
        loadList(query.ifEmpty { null })
    }

    fun loadRecommendations(force: Boolean = false) {
        if (!ready() || state.screen != Screen.Results) return
        val browse = state.browse
        if (browse.query != null || browse.feedTitle != "From your channels" || browse.status != ListStatus.Ready) return
        if (!force && state.recommendations.status in setOf(ListStatus.Loading, ListStatus.Ready, ListStatus.Empty)) return
        cancelRecommendation()
        recommendationCursor = null
        val feed = browse.items
        if (RelatedVideoSuggestions.selectSeeds(feed).isEmpty()) {
            update(state.copy(recommendations = RecommendationState(
                status = ListStatus.Empty, message = "No subscription videos available for discovery.",
            )))
            return
        }
        val generation = recommendationGeneration
        update(state.copy(recommendations = RecommendationState(status = ListStatus.Loading)))
        recommendationTask = recommendationRunner.submit {
            val result = attempt { catalog().related(feed) }
            main.post {
                if (generation == recommendationGeneration && !destroyed && state.active &&
                    state.screen == Screen.Results && state.browse.query == null &&
                    state.browse.feedTitle == "From your channels") {
                    applyRecommendationPage(result, append = false)
                }
            }
        }
    }

    fun loadMoreRecommendations(userInitiated: Boolean) {
        if (!ready() || state.screen != Screen.Results) return
        val browse = state.browse
        if (browse.query != null || browse.feedTitle != "From your channels") return
        val recommendation = state.recommendations
        val next = recommendationCursor ?: return
        if (recommendation.status !in setOf(ListStatus.Ready, ListStatus.Empty) || recommendation.loadingMore) return
        if (!userInitiated && (recommendation.moreFailed || recommendation.message != null)) return
        val generation = recommendationGeneration
        update(state.copy(recommendations = recommendation.copy(loadingMore = true, moreFailed = false, message = null)))
        recommendationTask = recommendationRunner.submit {
            val result = attempt { catalog().more(next) }
            main.post {
                if (generation == recommendationGeneration && !destroyed && state.active &&
                    state.screen == Screen.Results && state.browse.query == null &&
                    state.browse.feedTitle == "From your channels") {
                    applyRecommendationPage(result, append = true)
                }
            }
        }
    }

    private fun applyRecommendationPage(result: Outcome<FeedPage>, append: Boolean) {
        recommendationTask = null
        val previous = state.recommendations
        val next = when (result) {
            is Outcome.Success -> {
                recommendationCursor = result.value.cursor
                val seen = HashSet<String>()
                if (append) previous.items.forEach { seen.add(it.id) }
                val newItems = result.value.items.filter { seen.add(it.id) }
                val items = if (append) previous.items + newItems else newItems
                val more = recommendationCursor != null
                val message = when {
                    items.isEmpty() && more -> "No suggestions in this batch. Tap RETRY to keep looking."
                    items.isEmpty() -> "No related videos found. Tap RETRY to try again."
                    append && newItems.isEmpty() && more -> "No new suggestions in this batch. Tap to keep looking."
                    else -> null
                }
                RecommendationState(
                    items = items,
                    status = if (items.isEmpty()) ListStatus.Empty else ListStatus.Ready,
                    message = message,
                    canLoadMore = more,
                )
            }
            is Outcome.Failure -> if (append) {
                previous.copy(loadingMore = false, moreFailed = true, message = null)
            } else RecommendationState(status = ListStatus.Error, message = YouTubeFormat.failure(result.kind))
        }
        update(state.copy(recommendations = next))
    }

    fun loadMore(userInitiated: Boolean) {
        if (!ready()) return
        val browse = state.browse
        val next = cursor ?: return
        if (browse.status != ListStatus.Ready && browse.status != ListStatus.Empty || browse.loadingMore) return
        if (browse.moreFailed && !userInitiated) return
        val generation = listGeneration
        update(state.copy(browse = browse.copy(loadingMore = true, moreFailed = false)))
        listTask = runner.submit {
            val result = attempt { catalog().more(next) }
            main.post { if (generation == listGeneration && !destroyed) applyMore(result) }
        }
    }

    fun retry() {
        if (!ready()) return
        val video = state.playback.video
        if (state.screen == Screen.Player && video != null) {
            open(video)
            return
        }
        val browse = state.browse
        when {
            browse.status == ListStatus.Empty && browse.canLoadMore -> loadMore(true)
            browse.status == ListStatus.Error || browse.status == ListStatus.Empty || browse.status == ListStatus.Idle -> loadList(browse.query)
            browse.moreFailed -> loadMore(true)
        }
    }

    fun open(video: VideoSummary) {
        if (!ready()) return
        if (state.recommendations.status == ListStatus.Loading || state.recommendations.loadingMore) {
            cancelRecommendation()
            val recommendations = if (state.recommendations.status == ListStatus.Loading) {
                RecommendationState()
            } else state.recommendations.copy(loadingMore = false)
            update(state.copy(recommendations = recommendations))
        }
        rememberPosition()
        playGeneration += 1
        playTask?.cancel()
        playTask = null
        releaseEngine()
        resolved = null
        plan = null
        selector = YouTubeStreamSelector()
        expiredRetryUsed = false
        decoderFallbackUsed = false
        wantPlaying = true
        val startMs = if (resumeVideoId == video.id) resumePositionMs else 0L
        update(
            state.copy(
                screen = Screen.Player,
                playback = PlaybackState(
                    video = video,
                    phase = PlaybackPhase.Resolving,
                    positionMs = startMs,
                    durationMs = video.durationSeconds.coerceAtLeast(0) * 1000,
                    maxHeight = state.playback.maxHeight,
                    live = video.live,
                ),
            ),
        )
        resolve(playGeneration, video.id, startMs)
    }

    fun back() {
        if (destroyed) return
        stopPlayback()
        update(state.copy(screen = Screen.Results, playback = idlePlayback()))
    }

    fun togglePlay() {
        val active = engine ?: return
        val playback = state.playback
        if (playback.phase == PlaybackPhase.Ended) {
            active.seekTo(0)
            wantPlaying = true
            active.setPlaying(true)
            update(state.copy(playback = playback.copy(phase = PlaybackPhase.Buffering, positionMs = 0)))
            return
        }
        wantPlaying = !wantPlaying
        active.setPlaying(wantPlaying)
        val phase = when {
            playback.phase == PlaybackPhase.Playing && !wantPlaying -> PlaybackPhase.Paused
            playback.phase == PlaybackPhase.Paused && wantPlaying -> PlaybackPhase.Playing
            else -> playback.phase
        }
        update(state.copy(playback = playback.copy(phase = phase)))
    }

    fun toggleCaptions() {
        if (!ready() || state.screen != Screen.Player) return
        val playback = state.playback
        if (!playback.captionsAvailable) return
        val enabled = !playback.captionsEnabled
        engine?.setCaptionsEnabled(enabled)
        update(state.copy(playback = playback.copy(captionsEnabled = enabled, captionText = "")))
    }

    fun seekTo(positionMs: Long) {
        val active = engine ?: return
        val playback = state.playback
        if (playback.live) return
        val duration = if (playback.durationMs > 0) playback.durationMs else Long.MAX_VALUE
        val target = positionMs.coerceIn(0, duration)
        active.seekTo(target)
        update(state.copy(playback = playback.copy(positionMs = target)))
    }

    fun setMaxHeight(height: Int) {
        val sanitized = sanitizeHeight(height)
        val playback = state.playback
        if (sanitized == playback.maxHeight) return
        onMaxHeightChanged(sanitized)
        update(state.copy(playback = playback.copy(maxHeight = sanitized)))
        val current = resolved ?: return
        if (destroyed || !state.active || state.screen != Screen.Player || playback.live || playback.phase !in REPLANNABLE) return
        val position = engine?.positionMs ?: playback.positionMs
        playGeneration += 1
        playTask?.cancel()
        releaseEngine()
        startPlan(playGeneration, current, position)
    }

    fun tick() {
        val active = engine ?: return
        if (state.screen != Screen.Player) return
        val playback = state.playback
        val duration = active.durationMs.takeIf { it > 0 } ?: playback.durationMs
        val next = playback.copy(positionMs = active.positionMs, durationMs = duration, bufferedMs = active.bufferedMs)
        if (next != playback) update(state.copy(playback = next))
    }

    private fun cancelRecommendation() {
        recommendationGeneration += 1
        recommendationTask?.cancel()
        recommendationTask = null
    }

    private fun ready(): Boolean = !destroyed && state.active

    private fun loadList(query: String?) {
        cancelRecommendation()
        recommendationCursor = null
        listGeneration += 1
        listTask?.cancel()
        cursor = null
        val generation = listGeneration
        update(state.copy(
            recommendations = RecommendationState(),
            browse = BrowseState(
                query = query,
                feedTitle = if (query == null) feedTitle() else "Trending",
                status = ListStatus.Loading,
            ),
        ))
        listTask = runner.submit {
            val result = attempt { if (query == null) catalog().discover() else catalog().search(query) }
            main.post { if (generation == listGeneration && !destroyed) applyFirstPage(result) }
        }
    }

    private fun applyFirstPage(result: Outcome<FeedPage>) {
        listTask = null
        val browse = state.browse
        val next = when (result) {
            is Outcome.Success -> {
                cursor = result.value.cursor
                val items = result.value.items
                browse.copy(
                    items = items,
                    status = if (items.isEmpty()) ListStatus.Empty else ListStatus.Ready,
                    message = if (items.isEmpty()) when {
                        browse.query != null -> "No videos found."
                        browse.feedTitle == "From your channels" && cursor != null -> "No videos in this group. Tap RETRY to check more channels."
                        browse.feedTitle == "From your channels" -> "No recent videos found in your subscribed channels."
                        else -> "Nothing to show right now."
                    } else null,
                    canLoadMore = cursor != null,
                )
            }
            is Outcome.Failure -> {
                cursor = null
                browse.copy(items = emptyList(), status = ListStatus.Error, message = YouTubeFormat.failure(result.kind), canLoadMore = false)
            }
        }
        update(state.copy(browse = next))
    }

    private fun applyMore(result: Outcome<FeedPage>) {
        listTask = null
        val browse = state.browse
        val next = when (result) {
            is Outcome.Success -> {
                cursor = result.value.cursor
                val known = HashSet<String>(browse.items.size * 2)
                browse.items.forEach { known.add(it.id) }
                val appended = browse.items + result.value.items.filter { known.add(it.id) }
                browse.copy(items = appended, loadingMore = false, canLoadMore = cursor != null)
            }
            is Outcome.Failure -> browse.copy(loadingMore = false, moreFailed = true)
        }
        update(state.copy(browse = next))
    }

    private fun resolve(generation: Long, videoId: String, startMs: Long) {
        playTask = runner.submit {
            val result = attempt { catalog().resolve(videoId) }
            main.post { if (generation == playGeneration && !destroyed && state.active) onResolved(generation, result, startMs) }
        }
    }

    private fun onResolved(generation: Long, result: Outcome<ResolvedVideo>, startMs: Long) {
        playTask = null
        when (result) {
            is Outcome.Success -> {
                resolved = result.value
                val playback = state.playback
                val summary = result.value.summary
                update(
                    state.copy(
                        playback = playback.copy(
                            video = playback.video?.let { it.copy(title = summary.title.ifBlank { it.title }, channel = summary.channel ?: it.channel) },
                            live = summary.live,
                            durationMs = if (summary.durationSeconds > 0) summary.durationSeconds * 1000 else playback.durationMs,
                            captionsAvailable = result.value.caption != null,
                            captionsEnabled = result.value.caption != null && (!playback.captionsAvailable || playback.captionsEnabled),
                            captionText = "",
                        ),
                    ),
                )
                startPlan(generation, result.value, startMs)
            }
            is Outcome.Failure -> fail(result.kind)
        }
    }

    private fun startPlan(generation: Long, video: ResolvedVideo, startMs: Long) {
        val playback = state.playback
        val chosen = selector.select(video.options, playback.maxHeight)
        if (chosen == null) {
            val lowest = selector.lowestPlayableHeight(video.options)
            if (lowest != null && lowest > playback.maxHeight) failWith(YouTubeFormat.qualityUnavailable(playback.maxHeight, lowest)) else fail(FailureKind.Unsupported)
            return
        }
        plan = chosen
        val height = (chosen as? StreamPlan.Streams)?.height ?: 0
        update(state.copy(playback = playback.copy(phase = PlaybackPhase.Buffering, message = null, activeHeight = height, positionMs = startMs, captionText = "")))
        playTask = runner.submit {
            val media = attempt { preparer.prepare(video.handle, chosen) }
            main.post { if (generation == playGeneration && !destroyed && state.active) attachEngine(generation, media, startMs) }
        }
    }

    private fun attachEngine(generation: Long, media: Outcome<PreparedMedia>, startMs: Long) {
        playTask = null
        val prepared = when (media) {
            is Outcome.Success -> media.value
            is Outcome.Failure -> {
                fail(media.kind)
                return
            }
        }
        val created = try {
            engineFactory.create(listenerFor(generation)).also { createdEngines += 1 }
        } catch (_: Throwable) {
            fail(FailureKind.Extraction)
            return
        }
        engine = created
        try {
            created.setCaptionsEnabled(state.playback.captionsEnabled)
            created.prepare(prepared, startMs)
            if (!wantPlaying) created.setPlaying(false)
        } catch (e: Throwable) {
            releaseEngine()
            fail((e as? YouTubeException)?.kind ?: FailureKind.Unsupported)
        }
    }

    private fun listenerFor(generation: Long): PlayerEngineListener = object : PlayerEngineListener {
        private fun current(): Boolean = generation == playGeneration && engine != null && !destroyed

        override fun onBuffering() {
            if (!current()) return
            val playback = state.playback
            if (playback.phase != PlaybackPhase.Buffering) update(state.copy(playback = playback.copy(phase = PlaybackPhase.Buffering)))
        }

        override fun onReady(playing: Boolean) {
            if (!current()) return
            val playback = state.playback
            update(state.copy(playback = playback.copy(phase = if (playing) PlaybackPhase.Playing else PlaybackPhase.Paused, message = null)))
        }

        override fun onEnded() {
            if (!current()) return
            if (resumeVideoId == state.playback.video?.id) {
                resumeVideoId = null
                resumePositionMs = 0
            }
            update(state.copy(playback = state.playback.copy(phase = PlaybackPhase.Ended)))
        }

        override fun onFailure(failure: PlaybackFailure, detail: String) {
            if (!current()) return
            onPlaybackFailure(generation, failure)
        }

        override fun onVideoSize(width: Int, height: Int, pixelRatio: Float) {
            if (!current() || width <= 0 || height <= 0) return
            val aspect = width * (if (pixelRatio > 0f) pixelRatio else 1f) / height
            val playback = state.playback
            if (aspect != playback.videoAspect) update(state.copy(playback = playback.copy(videoAspect = aspect)))
        }

        override fun onCaptionsChanged(text: String) {
            if (!current() || !state.playback.captionsEnabled) return
            val playback = state.playback
            val next = text.take(500)
            if (next != playback.captionText) update(state.copy(playback = playback.copy(captionText = next)))
        }
    }

    private fun onPlaybackFailure(generation: Long, failure: PlaybackFailure) {
        val position = engine?.positionMs ?: state.playback.positionMs
        val video = resolved
        val current = plan
        when {
            failure == PlaybackFailure.Expired && !expiredRetryUsed && video != null -> {
                expiredRetryUsed = true
                releaseEngine()
                playGeneration += 1
                update(state.copy(playback = state.playback.copy(phase = PlaybackPhase.Resolving, message = "Refreshing stream…", positionMs = position)))
                resolve(playGeneration, video.summary.id, position)
            }
            failure == PlaybackFailure.QualityUnavailable -> {
                releaseEngine()
                failWith(YouTubeFormat.qualityUnavailable(state.playback.maxHeight, null))
            }
            failure == PlaybackFailure.Decoder && !decoderFallbackUsed && video != null && current is StreamPlan.Streams -> {
                decoderFallbackUsed = true
                selector = selector.withExcluded(current.video.family)
                releaseEngine()
                playGeneration += 1
                startPlan(playGeneration, video, position)
            }
            else -> {
                rememberPosition()
                if (generation == playGeneration) releaseEngine()
                fail(
                    when (failure) {
                        PlaybackFailure.Network, PlaybackFailure.Expired -> FailureKind.Network
                        PlaybackFailure.Decoder, PlaybackFailure.Unsupported, PlaybackFailure.QualityUnavailable -> FailureKind.Unsupported
                        PlaybackFailure.Other -> FailureKind.Extraction
                    },
                )
            }
        }
    }

    private fun fail(kind: FailureKind) {
        failWith(YouTubeFormat.failure(kind))
    }

    private fun failWith(message: String) {
        update(state.copy(playback = state.playback.copy(phase = PlaybackPhase.Error, message = message, captionText = "")))
    }

    private fun stopPlayback() {
        rememberPosition()
        playGeneration += 1
        playTask?.cancel()
        playTask = null
        releaseEngine()
        resolved = null
        plan = null
    }

    private fun rememberPosition() {
        val playback = state.playback
        val video = playback.video ?: return
        val position = engine?.positionMs ?: return
        if (playback.live || playback.phase == PlaybackPhase.Ended || position < RESUME_MIN_MS) return
        resumeVideoId = video.id
        resumePositionMs = position
    }

    private fun releaseEngine() {
        val active = engine ?: return
        engine = null
        try {
            active.release()
        } catch (_: RuntimeException) {
        }
    }

    private fun idlePlayback(): PlaybackState = PlaybackState(maxHeight = state.playback.maxHeight)

    private fun catalog(): YouTubeCatalog = catalog ?: catalogFactory().also { catalog = it }

    private fun update(next: YouTubeState) {
        if (next == state) return
        state = next
        listener?.invoke(next)
    }

    private inline fun <T> attempt(block: () -> T): Outcome<T> = try {
        Outcome.Success(block())
    } catch (e: YouTubeException) {
        Outcome.Failure(e.kind)
    } catch (_: InterruptedException) {
        Outcome.Failure(FailureKind.Network)
    } catch (_: IOException) {
        Outcome.Failure(FailureKind.Network)
    } catch (_: Throwable) {
        Outcome.Failure(FailureKind.Extraction)
    }

    private sealed class Outcome<out T> {
        class Success<T>(val value: T) : Outcome<T>()

        class Failure(val kind: FailureKind) : Outcome<Nothing>()
    }

    companion object {
        const val MAX_QUERY_LENGTH: Int = 200
        const val RESUME_MIN_MS: Long = 5_000
        private val REPLANNABLE = setOf(PlaybackPhase.Buffering, PlaybackPhase.Playing, PlaybackPhase.Paused, PlaybackPhase.Ended)

        fun sanitizeHeight(height: Int): Int =
            if (height in YouTubeStreamSelector.QUALITY_CHOICES) height else YouTubeStreamSelector.DEFAULT_MAX_HEIGHT
    }
}
