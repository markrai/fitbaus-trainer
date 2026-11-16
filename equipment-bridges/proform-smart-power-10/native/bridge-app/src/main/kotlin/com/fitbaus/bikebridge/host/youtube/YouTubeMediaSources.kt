// SPDX-License-Identifier: GPL-3.0-only
/*
 * Adapted from SkyTube at tag v3.003 (commit bf559833ec3ddcc8d10cea38a7e15a5487318563),
 * https://github.com/SkyTubeTeam/SkyTube :
 *   app/src/main/java/free/rm/skytube/gui/businessobjects/DatasourceBuilder.java
 *     (SkyTube, Copyright (C) 2020  Zsombor Gegesy)
 *   app/src/main/java/free/rm/skytube/gui/businessobjects/PlayerDataSource.java
 *     (no file header; distributed under the SkyTube GPL-3.0 LICENSE, derived from NewPipe)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation (version 3 of the License).
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * Modified for FitBaus in 2026: rewritten in Kotlin and reduced to YouTube
 * progressive, OTF DASH, post-live DVR and HLS sources; removes the ExoPlayer
 * SimpleCache disk cache, subtitles, SmoothStreaming and non-YouTube services;
 * bounds the NewPipe manifest-creator caches to a few entries and clears them
 * before each preparation; preparation runs off the UI thread because the OTF
 * and post-live manifest creators perform network requests; passes the
 * maximum video height to the player so HLS never exceeds it. See
 * bridge-app/third-party/YOUTUBE-NOTICE.
 */

@file:Suppress("DEPRECATION")

package com.fitbaus.bikebridge.host.youtube

import android.net.Uri
import com.fitbaus.bikebridge.host.youtube.media.YoutubeHttpDataSource
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.source.MediaSource
import com.google.android.exoplayer2.source.MergingMediaSource
import com.google.android.exoplayer2.source.ProgressiveMediaSource
import com.google.android.exoplayer2.source.dash.DashMediaSource
import com.google.android.exoplayer2.source.dash.DefaultDashChunkSource
import com.google.android.exoplayer2.source.dash.manifest.DashManifestParser
import com.google.android.exoplayer2.source.hls.HlsMediaSource
import org.schabi.newpipe.extractor.services.youtube.dashmanifestcreators.YoutubeOtfDashManifestCreator
import org.schabi.newpipe.extractor.services.youtube.dashmanifestcreators.YoutubePostLiveStreamDvrDashManifestCreator
import org.schabi.newpipe.extractor.services.youtube.dashmanifestcreators.YoutubeProgressiveDashManifestCreator
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.DeliveryMethod
import org.schabi.newpipe.extractor.stream.Stream
import org.schabi.newpipe.extractor.stream.StreamType
import org.schabi.newpipe.extractor.stream.VideoStream
import java.io.ByteArrayInputStream
import java.io.IOException

internal class YouTubeMediaSources : MediaPreparer {
    private val dashData = YoutubeHttpDataSource.Factory()
        .setConnectTimeoutMs(CONNECT_TIMEOUT_MS)
        .setReadTimeoutMs(READ_TIMEOUT_MS)
        .setRangeParameterEnabled(true)
        .setRnParameterEnabled(true)
    private val progressiveData = YoutubeHttpDataSource.Factory()
        .setConnectTimeoutMs(CONNECT_TIMEOUT_MS)
        .setReadTimeoutMs(READ_TIMEOUT_MS)
        .setRangeParameterEnabled(false)
        .setRnParameterEnabled(true)
    private val hlsData = YoutubeHttpDataSource.Factory()
        .setConnectTimeoutMs(CONNECT_TIMEOUT_MS)
        .setReadTimeoutMs(READ_TIMEOUT_MS)
        .setRangeParameterEnabled(false)
        .setRnParameterEnabled(false)

    init {
        YoutubeProgressiveDashManifestCreator.getCache().setMaximumSize(MANIFEST_CACHE_ENTRIES)
        YoutubeOtfDashManifestCreator.getCache().setMaximumSize(MANIFEST_CACHE_ENTRIES)
        YoutubePostLiveStreamDvrDashManifestCreator.getCache().setMaximumSize(MANIFEST_CACHE_ENTRIES)
    }

    override fun prepare(handle: ResolvedHandle, plan: StreamPlan): PreparedMedia {
        clearCaches()
        return try {
            ExoMedia(build(handle, plan), maxVideoHeight(plan))
        } catch (e: YouTubeException) {
            throw e
        } catch (e: IOException) {
            throw YouTubeException(FailureKind.Network, e.message ?: "network", e)
        } catch (e: Exception) {
            throw YouTubeException(FailureKind.Unsupported, e.message ?: e.javaClass.simpleName, e)
        }
    }

    private fun maxVideoHeight(plan: StreamPlan): Int = when (plan) {
        is StreamPlan.Hls -> plan.maxHeight
        is StreamPlan.Streams -> plan.height
    }

    private fun build(handle: ResolvedHandle, plan: StreamPlan): MediaSource {
        val resolved = handle as? NewPipeHandle ?: throw YouTubeException(FailureKind.Unsupported, "unknown stream handle")
        return when (plan) {
            is StreamPlan.Hls -> HlsMediaSource.Factory(hlsData).createMediaSource(MediaItem.fromUri(plan.url))
            is StreamPlan.Streams -> {
                val video = source(resolved, resolved.streams[plan.video.index])
                val audio = plan.audio?.let { source(resolved, resolved.streams[it.index]) }
                if (audio == null) video else MergingMediaSource(true, video, audio)
            }
        }
    }

    private fun clearCaches() {
        YoutubeProgressiveDashManifestCreator.getCache().clear()
        YoutubeOtfDashManifestCreator.getCache().clear()
        YoutubePostLiveStreamDvrDashManifestCreator.getCache().clear()
    }

    private fun source(handle: NewPipeHandle, stream: Stream): MediaSource {
        val url = stream.content
        if (!stream.isUrl || url.isNullOrEmpty()) throw YouTubeException(FailureKind.Unsupported, "stream has no URL")
        val info = handle.info
        val itag = stream.itagItem
        if (info.streamType == StreamType.POST_LIVE_STREAM && itag != null) {
            val manifest = YoutubePostLiveStreamDvrDashManifestCreator.fromPostLiveStreamDvrStreamingUrl(url, itag, itag.targetDurationSec, info.duration)
            return dash(manifest, stream)
        }
        return when (stream.deliveryMethod) {
            DeliveryMethod.PROGRESSIVE_HTTP -> {
                val separate = (stream is VideoStream && stream.isVideoOnly()) || stream is AudioStream
                if (separate && itag != null) {
                    try {
                        dash(YoutubeProgressiveDashManifestCreator.fromProgressiveStreamingUrl(url, itag, info.duration), stream)
                    } catch (_: Exception) {
                        progressive(url)
                    }
                } else {
                    progressive(url)
                }
            }
            DeliveryMethod.DASH -> {
                val otf = itag ?: throw YouTubeException(FailureKind.Unsupported, "DASH stream without itag")
                dash(YoutubeOtfDashManifestCreator.fromOtfStreamingUrl(url, otf, info.duration), stream)
            }
            DeliveryMethod.HLS -> HlsMediaSource.Factory(hlsData).createMediaSource(MediaItem.fromUri(url))
            else -> throw YouTubeException(FailureKind.Unsupported, "unsupported delivery ${stream.deliveryMethod}")
        }
    }

    private fun progressive(url: String): MediaSource =
        ProgressiveMediaSource.Factory(progressiveData)
            .setContinueLoadingCheckIntervalBytes(PROGRESSIVE_CHECK_BYTES)
            .createMediaSource(MediaItem.fromUri(url))

    private fun dash(manifestText: String, stream: Stream): MediaSource {
        val manifestUri = Uri.parse(stream.manifestUrl ?: "")
        val manifest = DashManifestParser().parse(manifestUri, ByteArrayInputStream(manifestText.toByteArray(Charsets.UTF_8)))
        return DashMediaSource.Factory(DefaultDashChunkSource.Factory(dashData), dashData)
            .createMediaSource(manifest, MediaItem.fromUri(stream.content))
    }

    private companion object {
        const val MANIFEST_CACHE_ENTRIES = 4
        const val CONNECT_TIMEOUT_MS = 10_000
        const val READ_TIMEOUT_MS = 15_000
        const val PROGRESSIVE_CHECK_BYTES = 256 * 1024
    }
}
