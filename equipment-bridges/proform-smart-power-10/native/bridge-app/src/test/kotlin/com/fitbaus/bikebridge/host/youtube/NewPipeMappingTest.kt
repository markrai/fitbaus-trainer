// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.schabi.newpipe.extractor.MediaFormat
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.AgeRestrictedContentException
import org.schabi.newpipe.extractor.exceptions.ContentNotAvailableException
import org.schabi.newpipe.extractor.exceptions.GeographicRestrictionException
import org.schabi.newpipe.extractor.exceptions.ParsingException
import org.schabi.newpipe.extractor.exceptions.PrivateContentException
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.exceptions.SignInConfirmNotBotException
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.AudioTrackType
import org.schabi.newpipe.extractor.stream.ContentAvailability
import org.schabi.newpipe.extractor.stream.DeliveryMethod
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import org.schabi.newpipe.extractor.stream.StreamType
import org.schabi.newpipe.extractor.stream.VideoStream
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class NewPipeMappingTest {
    private val offline = object : Downloader() {
        override fun execute(request: Request): Response = throw AssertionError("unit tests never reach the network: ${request.url()}")
    }
    private val catalog = NewPipeYouTubeCatalog(offline)
    private val service = ServiceList.YouTube.serviceId

    @Test
    fun searchItemsMapToValidInternalMetadata() {
        val item = StreamInfoItem(service, "https://www.youtube.com/watch?v=aqz-KE-bpKQ", "Big Buck Bunny", StreamType.VIDEO_STREAM)
        item.uploaderName = "Blender"
        item.duration = 635
        item.viewCount = 12_345_678
        val summary = catalog.summarize(item)
        assertNotNull(summary)
        summary!!
        assertEquals("aqz-KE-bpKQ", summary.id)
        assertEquals("Big Buck Bunny", summary.title)
        assertEquals("Blender", summary.channel)
        assertEquals(635, summary.durationSeconds)
        assertEquals("https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg", summary.thumbnailUrl)
        assertFalse(summary.live)
        assertEquals("Blender  ·  10:35  ·  12.3M views", YouTubeFormat.meta(summary))
    }

    @Test
    fun liveShortAndUnusableItemsAreHandled() {
        val live = StreamInfoItem(service, "https://www.youtube.com/watch?v=jNQXAC9IVRw", "Live", StreamType.LIVE_STREAM)
        live.duration = -1
        assertTrue(catalog.summarize(live)!!.live)
        val short = StreamInfoItem(service, "https://www.youtube.com/shorts/jNQXAC9IVRw", "Short", StreamType.VIDEO_STREAM)
        assertEquals("jNQXAC9IVRw", catalog.summarize(short)?.id)
        val upcoming = StreamInfoItem(service, "https://www.youtube.com/watch?v=jNQXAC9IVRw", "Soon", StreamType.VIDEO_STREAM)
        upcoming.contentAvailability = ContentAvailability.UPCOMING
        assertNull(catalog.summarize(upcoming))
        val members = StreamInfoItem(service, "https://www.youtube.com/watch?v=jNQXAC9IVRw", "Members", StreamType.VIDEO_STREAM)
        members.contentAvailability = ContentAvailability.MEMBERSHIP
        assertNull(catalog.summarize(members))
        val broken = StreamInfoItem(service, "https://example.invalid/nothing", "Broken", StreamType.VIDEO_STREAM)
        assertNull(catalog.summarize(broken))
    }

    @Test
    fun streamInfoMapsToCandidatesAlignedWithTheirStreams() {
        val info = StreamInfo(service, "https://www.youtube.com/watch?v=aqz-KE-bpKQ", "https://www.youtube.com/watch?v=aqz-KE-bpKQ", StreamType.VIDEO_STREAM, "aqz-KE-bpKQ", "Big Buck Bunny", 0)
        val muxed = VideoStream.Builder().setId("18").setContent("https://example.invalid/18", true).setMediaFormat(MediaFormat.MPEG_4)
            .setDeliveryMethod(DeliveryMethod.PROGRESSIVE_HTTP).setIsVideoOnly(false).setResolution("360p").build()
        val vp9 = VideoStream.Builder().setId("243").setContent("https://example.invalid/243", true).setMediaFormat(MediaFormat.WEBM)
            .setDeliveryMethod(DeliveryMethod.PROGRESSIVE_HTTP).setIsVideoOnly(true).setResolution("360p").build()
        val otf = VideoStream.Builder().setId("134").setContent("https://example.invalid/134", true).setMediaFormat(MediaFormat.MPEG_4)
            .setDeliveryMethod(DeliveryMethod.DASH).setIsVideoOnly(true).setResolution("480p60").build()
        val aac = AudioStream.Builder().setId("140").setContent("https://example.invalid/140", true).setMediaFormat(MediaFormat.M4A)
            .setDeliveryMethod(DeliveryMethod.PROGRESSIVE_HTTP).setAverageBitrate(129).build()
        val dub = AudioStream.Builder().setId("251-dub").setContent("https://example.invalid/251", true).setMediaFormat(MediaFormat.WEBMA_OPUS)
            .setDeliveryMethod(DeliveryMethod.PROGRESSIVE_HTTP).setAudioTrackType(AudioTrackType.DUBBED).build()
        info.videoStreams = listOf(muxed)
        info.videoOnlyStreams = listOf(vp9, otf)
        info.audioStreams = listOf(aac, dub)
        val (streams, candidates) = NewPipeStreams.map(info)
        assertEquals(listOf<Any>(muxed, vp9, otf, aac, dub), streams)
        assertEquals(listOf(0, 1, 2, 3, 4), candidates.map { it.index })
        assertEquals(listOf(CandidateKind.Muxed, CandidateKind.VideoOnly, CandidateKind.VideoOnly, CandidateKind.Audio, CandidateKind.Audio), candidates.map { it.kind })
        assertEquals(listOf(360, 360, 480, 0, 0), candidates.map { it.height })
        assertEquals(listOf(Container.Mp4, Container.WebM, Container.Mp4, Container.M4a, Container.WebMAudio), candidates.map { it.container })
        assertEquals(Delivery.Dash, candidates[2].delivery)
        assertFalse(candidates[4].originalAudio)
        assertEquals(129_000, candidates[3].bitrate, "NewPipe average bitrates are kbps and are normalised to bps")
        assertTrue(candidates.all { it.isUrl })
        val plan = YouTubeStreamSelector().select(StreamOptions(candidates, null, false), 360)
        assertEquals(StreamPlan.Streams(candidates[0], null), plan)
    }

    @Test
    fun heightParsingAndEnumMappingCoverYouTubeLabels() {
        assertEquals(1080, NewPipeStreams.parseHeight("1080p60"))
        assertEquals(144, NewPipeStreams.parseHeight("144p"))
        assertEquals(0, NewPipeStreams.parseHeight(null))
        assertEquals(0, NewPipeStreams.parseHeight("audio"))
        assertEquals(Container.ThreeGpp, NewPipeStreams.container(MediaFormat.v3GPP))
        assertEquals(Container.Other, NewPipeStreams.container(MediaFormat.MP3))
        assertEquals(Container.Other, NewPipeStreams.container(null))
        assertEquals(Delivery.Hls, NewPipeStreams.delivery(DeliveryMethod.HLS))
        assertEquals(Delivery.Other, NewPipeStreams.delivery(DeliveryMethod.TORRENT))
        assertTrue(NewPipeStreams.isLive(StreamType.AUDIO_LIVE_STREAM))
        assertFalse(NewPipeStreams.isLive(StreamType.POST_LIVE_STREAM))
    }

    @Test
    fun extractorFailuresBecomeRecoverableCategories() {
        assertEquals(FailureKind.RateLimited, NewPipeFailures.classify(ReCaptchaException("captcha", "https://www.youtube.com")).kind)
        assertEquals(FailureKind.RateLimited, NewPipeFailures.classify(SignInConfirmNotBotException("bot")).kind)
        assertEquals(FailureKind.Restricted, NewPipeFailures.classify(AgeRestrictedContentException("age")).kind)
        assertEquals(FailureKind.Restricted, NewPipeFailures.classify(GeographicRestrictionException("geo")).kind)
        assertEquals(FailureKind.Unavailable, NewPipeFailures.classify(PrivateContentException("private")).kind)
        assertEquals(FailureKind.Unavailable, NewPipeFailures.classify(ContentNotAvailableException("gone")).kind)
        assertEquals(FailureKind.Network, NewPipeFailures.classify(UnknownHostException("www.youtube.com")).kind)
        assertEquals(FailureKind.Network, NewPipeFailures.classify(SocketTimeoutException()).kind)
        assertEquals(FailureKind.Extraction, NewPipeFailures.classify(ParsingException("drift")).kind)
        assertEquals(FailureKind.Extraction, NewPipeFailures.classify(IllegalStateException()).kind)
        val already = YouTubeException(FailureKind.Unsupported, "x")
        assertTrue(NewPipeFailures.classify(already) === already)
    }

    @Test
    fun invalidIdsAreRejectedBeforeAnyRequest() {
        val failure = runCatching { catalog.resolve("not-an-id") }.exceptionOrNull()
        assertEquals(FailureKind.Unavailable, (failure as YouTubeException).kind)
        assertTrue(YouTubeIds.isValid("aqz-KE-bpKQ"))
        assertFalse(YouTubeIds.isValid("aqz-KE-bpKQ?x"))
        assertFalse(YouTubeIds.isValid(null))
    }

    @Test
    fun formattingHelpersStayCompact() {
        assertEquals("0:00", YouTubeFormat.clock(0))
        assertEquals("1:05", YouTubeFormat.clock(65_400))
        assertEquals("1:01:01", YouTubeFormat.duration(3661))
        assertEquals("", YouTubeFormat.duration(-1))
        assertEquals("999 views", YouTubeFormat.views(999))
        assertEquals("1.5K views", YouTubeFormat.views(1_500))
        assertEquals("2.0B views", YouTubeFormat.views(2_000_000_000))
        assertEquals("", YouTubeFormat.views(-1))
        assertEquals("Channel  ·  LIVE", YouTubeFormat.meta(FakeCatalog.video("abcdefghijk", live = true).copy(viewCount = -1)))
    }
}
