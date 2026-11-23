// SPDX-License-Identifier: AGPL-3.0-only

@file:Suppress("DEPRECATION")

package com.fitbaus.bikebridge.host.youtube

import android.content.Context
import android.os.Build
import android.os.Looper
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.DefaultLoadControl
import com.google.android.exoplayer2.DefaultRenderersFactory
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.PlaybackException
import com.google.android.exoplayer2.Player
import com.google.android.exoplayer2.Tracks
import com.google.android.exoplayer2.audio.AudioAttributes
import com.google.android.exoplayer2.source.MediaSource
import com.google.android.exoplayer2.text.CueGroup
import com.google.android.exoplayer2.trackselection.DefaultTrackSelector
import com.google.android.exoplayer2.upstream.HttpDataSource
import com.google.android.exoplayer2.video.VideoSize

internal enum class PlaybackFailure { Expired, Network, Decoder, Unsupported, QualityUnavailable, Other }

internal interface PlayerEngineListener {
    fun onBuffering()

    fun onReady(playing: Boolean)

    fun onEnded()

    fun onFailure(failure: PlaybackFailure, detail: String)

    fun onVideoSize(width: Int, height: Int, pixelRatio: Float)

    fun onCaptionsChanged(text: String) {}
}

internal interface PreparedMedia

internal fun interface MediaPreparer {
    fun prepare(handle: ResolvedHandle, plan: StreamPlan): PreparedMedia
}

internal interface PlayerEngine {
    val positionMs: Long
    val durationMs: Long
    val bufferedMs: Long

    fun prepare(media: PreparedMedia, startMs: Long)

    fun setPlaying(playing: Boolean)

    fun setCaptionsEnabled(enabled: Boolean) {}

    fun seekTo(positionMs: Long)

    fun release()
}

internal fun interface PlayerEngineFactory {
    fun create(listener: PlayerEngineListener): PlayerEngine
}

internal object PlaybackFailures {
    private val EXPIRED_CODES = setOf(403, 404, 410)

    fun classify(errorCode: Int, cause: Throwable?): PlaybackFailure = classify(errorCode, httpStatus(cause))

    fun httpStatus(cause: Throwable?): Int? {
        var current = cause
        var depth = 0
        while (current != null && depth < 8) {
            if (current is HttpDataSource.InvalidResponseCodeException) return current.responseCode
            current = current.cause
            depth += 1
        }
        return null
    }

    fun classify(errorCode: Int, httpStatus: Int?): PlaybackFailure {
        if (httpStatus != null) return if (httpStatus in EXPIRED_CODES) PlaybackFailure.Expired else PlaybackFailure.Network
        return when (errorCode) {
            in 2000..2999 -> PlaybackFailure.Network
            in 3000..3999 -> PlaybackFailure.Unsupported
            in 4000..4999 -> PlaybackFailure.Decoder
            else -> PlaybackFailure.Other
        }
    }
}

internal class ExoMedia(val source: MediaSource, val maxVideoHeight: Int) : PreparedMedia

internal object YouTubeVideoOutput {
    fun useTextureView(sdkInt: Int): Boolean = sdkInt < Build.VERSION_CODES.N
}

internal class ExoPlayerEngine(
    context: Context,
    private val videoOutput: View,
    private val listener: PlayerEngineListener,
) : PlayerEngine {
    private var released = false
    private var captionsEnabled = true
    private val trackSelector = DefaultTrackSelector(context)
    private val player: ExoPlayer = ExoPlayer.Builder(context, DefaultRenderersFactory(context).setEnableDecoderFallback(true))
        .setTrackSelector(trackSelector)
        .setLoadControl(
            DefaultLoadControl.Builder()
                .setBufferDurationsMs(MIN_BUFFER_MS, MAX_BUFFER_MS, START_BUFFER_MS, REBUFFER_MS)
                .setTargetBufferBytes(TARGET_BUFFER_BYTES)
                .setPrioritizeTimeOverSizeThresholds(false)
                .build(),
        )
        .setAudioAttributes(
            AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
            true,
        )
        .setHandleAudioBecomingNoisy(true)
        .setLooper(Looper.getMainLooper())
        .build()

    private val events = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            if (released) return
            when (playbackState) {
                Player.STATE_BUFFERING -> listener.onBuffering()
                Player.STATE_READY -> listener.onReady(player.playWhenReady)
                Player.STATE_ENDED -> listener.onEnded()
                else -> Unit
            }
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            if (released) return
            if (player.playbackState == Player.STATE_READY) listener.onReady(playWhenReady)
        }

        override fun onTracksChanged(tracks: Tracks) {
            if (released) return
            if (tracks.containsType(C.TRACK_TYPE_VIDEO) && !tracks.isTypeSelected(C.TRACK_TYPE_VIDEO)) {
                listener.onFailure(PlaybackFailure.QualityUnavailable, "no video track within the height limit")
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            if (released) return
            listener.onFailure(PlaybackFailures.classify(error.errorCode, error.cause), error.errorCodeName)
        }

        override fun onVideoSizeChanged(videoSize: VideoSize) {
            if (released) return
            listener.onVideoSize(videoSize.width, videoSize.height, videoSize.pixelWidthHeightRatio)
        }

        override fun onCues(cueGroup: CueGroup) {
            if (released || !captionsEnabled) return
            val text = cueGroup.cues.mapNotNull { it.text?.toString()?.trim() }
                .filter { it.isNotEmpty() }
                .joinToString("\n")
                .take(MAX_CAPTION_CHARS)
            listener.onCaptionsChanged(text)
        }
    }

    init {
        player.addListener(events)
        when (videoOutput) {
            is TextureView -> player.setVideoTextureView(videoOutput)
            is SurfaceView -> player.setVideoSurfaceView(videoOutput)
            else -> throw IllegalArgumentException("Unsupported YouTube video output")
        }
        player.videoScalingMode = C.VIDEO_SCALING_MODE_SCALE_TO_FIT
    }

    override val positionMs: Long
        get() = if (released) 0 else player.currentPosition

    override val durationMs: Long
        get() = if (released) 0 else player.duration.takeIf { it != C.TIME_UNSET } ?: 0

    override val bufferedMs: Long
        get() = if (released) 0 else player.bufferedPosition

    override fun prepare(media: PreparedMedia, startMs: Long) {
        if (released) return
        val exo = media as? ExoMedia ?: throw YouTubeException(FailureKind.Unsupported, "unknown media")
        trackSelector.setParameters(
            trackSelector.buildUponParameters()
                .setMaxVideoSize(Int.MAX_VALUE, exo.maxVideoHeight)
                .setExceedVideoConstraintsIfNecessary(false)
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, !captionsEnabled),
        )
        player.setMediaSource(exo.source, startMs.coerceAtLeast(0))
        player.playWhenReady = true
        player.prepare()
    }

    override fun setPlaying(playing: Boolean) {
        if (!released) player.playWhenReady = playing
    }

    override fun setCaptionsEnabled(enabled: Boolean) {
        if (released || captionsEnabled == enabled) return
        captionsEnabled = enabled
        trackSelector.setParameters(
            trackSelector.buildUponParameters()
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, !enabled),
        )
        if (!enabled) listener.onCaptionsChanged("")
    }

    override fun seekTo(positionMs: Long) {
        if (!released) player.seekTo(positionMs.coerceAtLeast(0))
    }

    override fun release() {
        if (released) return
        released = true
        player.removeListener(events)
        when (videoOutput) {
            is TextureView -> player.clearVideoTextureView(videoOutput)
            is SurfaceView -> player.clearVideoSurfaceView(videoOutput)
        }
        player.release()
    }

    private companion object {
        const val MIN_BUFFER_MS = 15_000
        const val MAX_BUFFER_MS = 30_000
        const val START_BUFFER_MS = 1_500
        const val REBUFFER_MS = 3_000
        const val TARGET_BUFFER_BYTES = 16 * 1024 * 1024
        const val MAX_CAPTION_CHARS = 500
    }
}
