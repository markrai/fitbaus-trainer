// SPDX-License-Identifier: GPL-3.0-only
/*
 * Adapted from SkyTube at tag v3.003 (commit bf559833ec3ddcc8d10cea38a7e15a5487318563),
 * https://github.com/SkyTubeTeam/SkyTube :
 *   app/src/main/java/free/rm/skytube/businessobjects/YouTube/newpipe/NewPipeService.java
 *   app/src/main/java/free/rm/skytube/businessobjects/YouTube/newpipe/VideoPager.java
 *   app/src/main/java/free/rm/skytube/businessobjects/YouTube/NewPipeVideoBySearch.java
 *
 * SkyTube
 * Copyright (C) 2019  Zsombor Gegesy
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
 * Modified for FitBaus in 2026: reduced to the default kiosk, search,
 * paging and stream lookup; rewritten in Kotlin; maps results to FitBaus
 * metadata and stream descriptors; skips upcoming, members-only and paid
 * items; classifies extractor failures into recoverable categories; uses
 * a FitBaus HttpURLConnection downloader instead of the SkyTube OkHttp
 * component; each page request deduplicates against an immutable copy of the
 * IDs already shown so a discarded response cannot hide items on retry. See bridge-app/third-party/YOUTUBE-NOTICE.
 */

package com.fitbaus.bikebridge.host.youtube

import org.schabi.newpipe.extractor.InfoItem
import org.schabi.newpipe.extractor.ListExtractor
import org.schabi.newpipe.extractor.MediaFormat
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.Page
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.exceptions.AccountTerminatedException
import org.schabi.newpipe.extractor.exceptions.AgeRestrictedContentException
import org.schabi.newpipe.extractor.exceptions.ContentNotAvailableException
import org.schabi.newpipe.extractor.exceptions.ContentNotSupportedException
import org.schabi.newpipe.extractor.exceptions.GeographicRestrictionException
import org.schabi.newpipe.extractor.exceptions.HttpResponseException
import org.schabi.newpipe.extractor.exceptions.PaidContentException
import org.schabi.newpipe.extractor.exceptions.PrivateContentException
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.exceptions.SignInConfirmNotBotException
import org.schabi.newpipe.extractor.exceptions.UnsupportedContentInCountryException
import org.schabi.newpipe.extractor.exceptions.YoutubeMusicPremiumContentException
import org.schabi.newpipe.extractor.localization.ContentCountry
import org.schabi.newpipe.extractor.localization.Localization
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.AudioTrackType
import org.schabi.newpipe.extractor.stream.ContentAvailability
import org.schabi.newpipe.extractor.stream.DeliveryMethod
import org.schabi.newpipe.extractor.stream.Stream
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.SubtitlesStream
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import org.schabi.newpipe.extractor.stream.StreamType
import org.schabi.newpipe.extractor.stream.VideoStream
import java.io.IOException

internal class NewPipeHandle(val info: StreamInfo, val streams: List<Stream>, val caption: CaptionTrack? = null) : ResolvedHandle

internal class NewPipeYouTubeCatalog(downloader: Downloader = HttpUrlDownloader()) : YouTubeCatalog {
    init {
        NewPipeRuntime.ensure(downloader)
    }

    private val service = ServiceList.YouTube

    override fun discover(): FeedPage = guard {
        firstPage(service.kioskList.defaultKioskExtractor)
    }

    override fun search(query: String): FeedPage = guard {
        firstPage(service.getSearchExtractor(query))
    }

    override fun related(seeds: List<VideoSummary>): FeedPage = guard {
        val batches = ArrayList<List<VideoSummary>>()
        var firstFailure: Throwable? = null
        for (seed in RelatedVideoSuggestions.selectSeeds(seeds)) {
            if (Thread.currentThread().isInterrupted) throw InterruptedException("Discovery cancelled")
            try {
                val extractor = service.getStreamExtractor(service.streamLHFactory.fromId(seed.id))
                val info = StreamInfo.getInfo(extractor)
                batches += info.relatedItems.orEmpty()
                    .asSequence()
                    .take(RelatedVideoSuggestions.MAX_ITEMS_PER_SEED)
                    .mapNotNull { summarize(it) }
                    .toList()
            } catch (e: Throwable) {
                if (Thread.currentThread().isInterrupted) throw e
                if (firstFailure == null) firstFailure = e
                batches += emptyList()
            }
        }
        if (batches.all { it.isEmpty() }) firstFailure?.let { throw it }
        FeedPage(RelatedVideoSuggestions.merge(seeds, batches), null)
    }

    override fun more(cursor: FeedCursor): FeedPage = guard {
        val next = cursor as NewPipeCursor
        page(next.extractor, next.extractor.getPage(next.page), next.seen)
    }

    override fun resolve(videoId: String): ResolvedVideo = guard {
        if (!YouTubeIds.isValid(videoId)) throw YouTubeException(FailureKind.Unavailable, "invalid video id")
        val extractor = service.getStreamExtractor(service.streamLHFactory.fromId(videoId))
        val info = StreamInfo.getInfo(extractor)
        when (info.contentAvailability) {
            ContentAvailability.MEMBERSHIP, ContentAvailability.PAID -> throw YouTubeException(FailureKind.Restricted, "members-only or paid")
            ContentAvailability.UPCOMING -> throw YouTubeException(FailureKind.Unavailable, "upcoming")
            else -> Unit
        }
        val (streams, candidates) = NewPipeStreams.map(info)
        val live = NewPipeStreams.isLive(info.streamType)
        val summary = VideoSummary(
            id = videoId,
            title = info.name ?: videoId,
            channel = info.uploaderName,
            durationSeconds = info.duration,
            viewCount = info.viewCount,
            thumbnailUrl = YouTubeIds.thumbnail(videoId),
            live = live,
        )
        val caption = try {
            CaptionPreference.preferred(NewPipeCaptions.supported(info.subtitles ?: emptyList()))
        } catch (_: Exception) {
            null
        }
        ResolvedVideo(summary, StreamOptions(candidates, info.hlsUrl, live), NewPipeHandle(info, streams, caption), caption)
    }

    internal fun firstPage(extractor: ListExtractor<*>): FeedPage = guard {
        extractor.fetchPage()
        page(extractor, extractor.initialPage, emptySet())
    }

    private fun page(extractor: ListExtractor<*>, page: ListExtractor.InfoItemsPage<*>, previouslySeen: Set<String>): FeedPage {
        val seen = HashSet(previouslySeen)
        val items = ArrayList<VideoSummary>(page.items.size)
        for (item in page.items) {
            val summary = summarize(item as InfoItem) ?: continue
            if (seen.add(summary.id)) items += summary
        }
        val next = if (page.hasNextPage()) page.nextPage?.let { NewPipeCursor(extractor, it, seen) } else null
        return FeedPage(items, next)
    }

    internal fun summarize(item: InfoItem): VideoSummary? {
        if (item !is StreamInfoItem) return null
        val availability = item.contentAvailability
        if (availability == ContentAvailability.UPCOMING || availability == ContentAvailability.MEMBERSHIP || availability == ContentAvailability.PAID) return null
        val id = try {
            service.streamLHFactory.getId(item.url)
        } catch (_: Exception) {
            return null
        }
        if (!YouTubeIds.isValid(id)) return null
        return VideoSummary(
            id = id,
            title = item.name ?: id,
            channel = item.uploaderName,
            durationSeconds = item.duration,
            viewCount = item.viewCount,
            thumbnailUrl = YouTubeIds.thumbnail(id),
            live = NewPipeStreams.isLive(item.streamType),
        )
    }

    private inline fun <T> guard(block: () -> T): T = try {
        block()
    } catch (e: Throwable) {
        throw NewPipeFailures.classify(e)
    }

    private class NewPipeCursor(val extractor: ListExtractor<*>, val page: Page, val seen: Set<String>) : FeedCursor
}

internal object NewPipeRuntime {
    @Volatile
    private var initialized = false

    @Synchronized
    fun ensure(downloader: Downloader) {
        if (initialized) return
        NewPipe.init(downloader, Localization.DEFAULT, ContentCountry.DEFAULT)
        initialized = true
    }
}

internal object NewPipeCaptions {
    fun supported(streams: List<SubtitlesStream>): List<CaptionTrack> =
        streams.asSequence().take(MAX_TRACKS).mapNotNull { stream ->
            val url = stream.content?.trim() ?: return@mapNotNull null
            if (!stream.isUrl || url.length !in 1..MAX_URL_LENGTH || !url.startsWith("https://", ignoreCase = true)) return@mapNotNull null
            val mimeType = when (stream.format) {
                MediaFormat.VTT -> "text/vtt"
                MediaFormat.TTML -> "application/ttml+xml"
                MediaFormat.SRT -> "application/x-subrip"
                else -> return@mapNotNull null
            }
            CaptionTrack(url, stream.languageTag?.take(32) ?: "", mimeType, stream.isAutoGenerated)
        }.toList()

    private const val MAX_TRACKS = 256
    private const val MAX_URL_LENGTH = 8192
}

internal object NewPipeStreams {
    fun isLive(type: StreamType?): Boolean = type == StreamType.LIVE_STREAM || type == StreamType.AUDIO_LIVE_STREAM

    fun map(info: StreamInfo): Pair<List<Stream>, List<StreamCandidate>> {
        val streams = ArrayList<Stream>()
        val candidates = ArrayList<StreamCandidate>()
        for (stream in info.videoStreams) add(stream, CandidateKind.Muxed, streams, candidates)
        for (stream in info.videoOnlyStreams) add(stream, CandidateKind.VideoOnly, streams, candidates)
        for (stream in info.audioStreams) add(stream, CandidateKind.Audio, streams, candidates)
        return Pair(streams, candidates)
    }

    private fun add(stream: Stream, kind: CandidateKind, streams: MutableList<Stream>, candidates: MutableList<StreamCandidate>) {
        val height: Int
        val bitrate: Int
        val codec: String?
        var original = true
        when (stream) {
            is VideoStream -> {
                height = if (stream.height > 0) stream.height else parseHeight(stream.getResolution())
                bitrate = stream.bitrate
                codec = stream.codec
            }
            is AudioStream -> {
                height = 0
                bitrate = if (stream.bitrate > 0) stream.bitrate else stream.averageBitrate.coerceAtLeast(0) * 1000
                codec = stream.codec
                val track = stream.audioTrackType
                original = track == null || track == AudioTrackType.ORIGINAL
            }
            else -> return
        }
        candidates += StreamCandidate(
            index = streams.size,
            kind = kind,
            container = container(stream.format),
            codec = codec,
            height = height,
            bitrate = bitrate,
            delivery = delivery(stream.deliveryMethod),
            isUrl = stream.isUrl,
            originalAudio = original,
        )
        streams += stream
    }

    private val HEIGHT = Regex("(\\d{2,4})p")

    fun parseHeight(resolution: String?): Int = resolution?.let { HEIGHT.find(it)?.groupValues?.get(1)?.toIntOrNull() } ?: 0

    fun container(format: MediaFormat?): Container = when (format) {
        MediaFormat.MPEG_4 -> Container.Mp4
        MediaFormat.WEBM -> Container.WebM
        MediaFormat.v3GPP -> Container.ThreeGpp
        MediaFormat.M4A -> Container.M4a
        MediaFormat.WEBMA, MediaFormat.WEBMA_OPUS -> Container.WebMAudio
        else -> Container.Other
    }

    fun delivery(method: DeliveryMethod?): Delivery = when (method) {
        DeliveryMethod.PROGRESSIVE_HTTP -> Delivery.Progressive
        DeliveryMethod.DASH -> Delivery.Dash
        DeliveryMethod.HLS -> Delivery.Hls
        else -> Delivery.Other
    }
}

internal object NewPipeFailures {
    fun classify(e: Throwable): YouTubeException = when (e) {
        is YouTubeException -> e
        is ReCaptchaException, is SignInConfirmNotBotException -> YouTubeException(FailureKind.RateLimited, e.message ?: "rate limited", e)
        is PrivateContentException, is AccountTerminatedException -> YouTubeException(FailureKind.Unavailable, e.message ?: "unavailable", e)
        is AgeRestrictedContentException, is GeographicRestrictionException, is UnsupportedContentInCountryException,
        is PaidContentException, is YoutubeMusicPremiumContentException -> YouTubeException(FailureKind.Restricted, e.message ?: "restricted", e)
        is ContentNotAvailableException -> YouTubeException(FailureKind.Unavailable, e.message ?: "unavailable", e)
        is ContentNotSupportedException -> YouTubeException(FailureKind.Unsupported, e.message ?: "unsupported", e)
        is IOException, is HttpResponseException -> YouTubeException(FailureKind.Network, e.message ?: "network", e)
        else -> YouTubeException(FailureKind.Extraction, e.message ?: e.javaClass.simpleName, e)
    }
}
