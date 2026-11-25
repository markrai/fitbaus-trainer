// SPDX-License-Identifier: AGPL-3.0-only

@file:Suppress("DEPRECATION")

package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.DefaultLoadControl
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.PlaybackException
import com.google.android.exoplayer2.Player
import com.google.android.exoplayer2.audio.AudioAttributes
import com.google.android.exoplayer2.source.ProgressiveMediaSource
import com.google.android.exoplayer2.upstream.DataSource
import java.util.UUID
import java.util.concurrent.Executors

internal data class BooksPlayerState(
    val item: BooksItem? = null,
    val session: BooksPlaybackSession? = null,
    val positionMs: Long = 0,
    val playing: Boolean = false,
    val wantsPlay: Boolean = false,
    val speed: Float = 1f,
    val status: String = "",
    val failed: Boolean = false,
    val seekGeneration: Long = 0,
)

internal class BooksPlayback(context: Context, private val render: (BooksPlayerState) -> Unit) {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val deviceId by lazy {
        val prefs = app.getSharedPreferences("fitbaus_books_player", Context.MODE_PRIVATE)
        prefs.getString("device_id", null) ?: UUID.randomUUID().toString().also {
            check(prefs.edit().putString("device_id", it).commit())
        }
    }
    private var state = BooksPlayerState()
    private var player: ExoPlayer? = null
    private var api: BooksPlaybackApi? = null
    private var generation = 0L
    private var opening = 0
    private var destroyed = false
    private var syncInFlight = false
    private var listened = 0L
    private var lastClock = 0L
    private var wasPlaying = false
    private var lastSync = 0L
    private var touched = false
    private var dirty = false
    private var speed = 1f
    private var syncFailed = false

    private val ticker = object : Runnable {
        override fun run() {
            val engine = player ?: return
            sample()
            publish()
            if (state.session != null && touched && SystemClock.elapsedRealtime() - lastSync >= 15_000) sync()
            if (player === engine) main.postDelayed(this, 500)
        }
    }

    fun open(connection: BooksConnection, item: BooksItem) {
        if (destroyed) return
        stop()
        val ticket = generation
        val client = BooksPlaybackApi(connection)
        state = BooksPlayerState(item = item, speed = speed, status = "Opening audiobook…")
        render(state)
        opening++
        worker.submit {
            val result = runCatching { client.start(item.id, deviceId) }
            main.post {
                opening--
                if (destroyed || ticket != generation) {
                    result.getOrNull()?.let { session ->
                        worker.submit { runCatching { client.update(session, session.resumeMs, 0, true, false) } }
                    }
                    shutdownIfDone()
                } else {
                    result.fold(
                        onSuccess = { session -> prepare(connection, client, session) },
                        onFailure = {
                            state = state.copy(status = "Could not open audiobook. Check the server and try again.", failed = true)
                            render(state)
                        },
                    )
                }
            }
        }
    }

    private fun prepare(connection: BooksConnection, client: BooksPlaybackApi, session: BooksPlaybackSession) {
        api = client
        state = state.copy(session = session, positionMs = session.resumeMs, status = "Buffering…")
        try {
            val urls = session.tracks.map { it.url }.toSet()
            val sourceFactory = ProgressiveMediaSource.Factory(DataSource.Factory { BooksAudioDataSource(connection.session, urls) })
            val sources = session.tracks.map { sourceFactory.createMediaSource(MediaItem.fromUri(it.url)) }
            val engine = ExoPlayer.Builder(app)
                .setLooper(Looper.getMainLooper())
                .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(), true)
                .setHandleAudioBecomingNoisy(true)
                .setLoadControl(DefaultLoadControl.Builder().setBufferDurationsMs(15_000, 30_000, 1_500, 3_000)
                    .setTargetBufferBytes(4 * 1024 * 1024).build())
                .build()
            player = engine
            engine.addListener(object : Player.Listener {
                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    if (player !== engine) return
                    sample()
                    if (!isPlaying && touched) sync()
                    publish()
                }

                override fun onPlaybackStateChanged(playbackState: Int) {
                    if (player !== engine) return
                    if (playbackState == Player.STATE_ENDED) {
                        sample()
                        touched = true
                        dirty = true
                        sync()
                    }
                    publish()
                }

                override fun onPlayerError(error: PlaybackException) {
                    if (player !== engine) return
                    sample()
                    state = state.copy(failed = true, status = "Audio playback failed. Try again.")
                    sync()
                    publish()
                }
            })
            val start = session.locate(session.resumeMs)
            engine.setMediaSources(sources, start.index, start.positionMs)
            engine.setPlaybackSpeed(speed)
            lastClock = SystemClock.elapsedRealtime()
            lastSync = lastClock
            engine.prepare()
            engine.play()
            main.post(ticker)
            publish()
        } catch (_: Exception) {
            player?.release()
            player = null
            state = state.copy(failed = true, status = "Could not prepare audiobook audio.")
            render(state)
        }
    }

    fun toggle() {
        val engine = player ?: return
        if (state.failed) return
        sample()
        if (engine.playbackState == Player.STATE_ENDED) {
            seek(0)
            engine.play()
        } else if (engine.playWhenReady) engine.pause() else engine.play()
        publish()
    }

    fun seek(positionMs: Long) {
        val engine = player ?: return
        val session = state.session ?: return
        if (state.failed) return
        sample()
        val target = session.locate(positionMs)
        state = state.copy(seekGeneration = state.seekGeneration + 1)
        engine.seekTo(target.index, target.positionMs)
        touched = true
        dirty = true
        publish()
        sync()
    }

    fun speed(value: Float) {
        if (value !in 0.5f..2.5f) return
        speed = value
        player?.setPlaybackSpeed(value)
        publish()
    }

    fun stop() {
        generation++
        main.removeCallbacks(ticker)
        sample()
        val session = state.session
        val client = api
        val position = currentPosition()
        val delta = listened
        val includeProgress = touched
        val engine = player
        player = null
        engine?.release()
        api = null
        listened = 0
        lastClock = 0
        wasPlaying = false
        syncInFlight = false
        syncFailed = false
        touched = false
        dirty = false
        state = BooksPlayerState(speed = speed)
        if (session != null && client != null) {
            worker.submit { runCatching { client.update(session, position, delta, true, includeProgress) } }
        }
        render(state)
    }

    fun destroy() {
        stop()
        destroyed = true
        shutdownIfDone()
    }

    private fun shutdownIfDone() {
        if (destroyed && opening == 0) worker.shutdown()
    }

    private fun sample() {
        val engine = player ?: return
        val now = SystemClock.elapsedRealtime()
        if (wasPlaying && lastClock > 0) {
            listened += (now - lastClock).coerceIn(0, 2_000)
            touched = true
            dirty = true
        }
        lastClock = now
        wasPlaying = engine.isPlaying
    }

    fun currentPosition(): Long {
        val engine = player ?: return state.positionMs
        val session = state.session ?: return 0
        if (engine.playbackState == Player.STATE_ENDED) return session.durationMs
        return session.position(engine.currentMediaItemIndex, engine.currentPosition)
    }

    private fun sync() {
        val session = state.session ?: return
        val client = api ?: return
        if (!dirty || syncInFlight) return
        val ticket = generation
        val position = currentPosition()
        val delta = listened
        listened = 0
        lastSync = SystemClock.elapsedRealtime()
        syncInFlight = true
        dirty = false
        worker.submit {
            val result = runCatching { client.update(session, position, delta, false) }
            main.post {
                if (generation == ticket && !destroyed) {
                    syncInFlight = false
                    syncFailed = result.isFailure
                    if (syncFailed) dirty = true
                    publish()
                }
            }
        }
    }

    private fun publish() {
        val engine = player
        val label = when {
            state.failed -> state.status
            engine == null -> state.status
            engine.playbackState == Player.STATE_BUFFERING -> "Buffering…"
            engine.playbackState == Player.STATE_ENDED -> "Finished"
            engine.isPlaying -> "Playing"
            else -> "Paused"
        }
        state = state.copy(
            positionMs = currentPosition(),
            playing = engine?.isPlaying == true,
            wantsPlay = engine?.playWhenReady == true && engine.playbackState != Player.STATE_ENDED,
            speed = speed,
            status = label,
        )
        render(if (syncFailed) state.copy(status = "$label · Progress sync unavailable") else state)
    }
}
