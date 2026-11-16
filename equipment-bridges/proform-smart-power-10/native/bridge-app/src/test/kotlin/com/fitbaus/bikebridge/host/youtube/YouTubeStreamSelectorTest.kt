// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class YouTubeStreamSelectorTest {
    private val selector = YouTubeStreamSelector()

    @Test
    fun combinedH264StreamIsChosenWithoutSeparateAudio() {
        val muxed = muxed(0, Container.Mp4, "avc1.42001E, mp4a.40.2", 360)
        val plan = selector.select(options(muxed, videoOnly(1, Container.WebM, "vp9", 360), audio(2, Container.WebMAudio, "opus", 128_000)), 360)
        assertEquals(StreamPlan.Streams(muxed, null), plan)
    }

    @Test
    fun separateVideoIsPairedWithAudioWhenNoCombinedStreamExists() {
        val avc = videoOnly(0, Container.Mp4, "avc1.4d401e", 360)
        val vp9 = videoOnly(1, Container.WebM, "vp9", 360)
        val aac = audio(2, Container.M4a, "mp4a.40.2", 129_000)
        val opus = audio(3, Container.WebMAudio, "opus", 135_000)
        val plan = selector.select(options(vp9, avc, opus, aac), 360) as StreamPlan.Streams
        assertEquals(avc, plan.video, "H.264 preferred over VP9 at the same height")
        assertEquals(aac, plan.audio, "AAC preferred over Opus")
    }

    @Test
    fun skyTubeQualifiedVp9OpusPairStillPlaysWhenItIsAllThereIs() {
        val vp9 = videoOnly(0, Container.WebM, "vp9", 360)
        val opus = audio(1, Container.WebMAudio, "opus", 135_000)
        assertEquals(StreamPlan.Streams(vp9, opus), selector.select(options(vp9, opus), 360))
    }

    @Test
    fun videoOnlyStreamsAreNeverChosenWithoutAudio() {
        val avc480 = videoOnly(0, Container.Mp4, "avc1.4d401f", 480)
        val muxed = muxed(1, Container.Mp4, "avc1.42001E, mp4a.40.2", 360)
        assertEquals(StreamPlan.Streams(muxed, null), selector.select(options(avc480, muxed), 480))
        assertNull(selector.select(options(avc480), 480))
    }

    @Test
    fun hlsIsTheFallbackWhenNoProgressiveOrAdaptivePairExists() {
        val avc = videoOnly(0, Container.Mp4, "avc1.4d401e", 360)
        assertEquals(StreamPlan.Hls("https://example.invalid/master.m3u8", 360), selector.select(StreamOptions(listOf(avc), "https://example.invalid/master.m3u8", false), 360))
    }

    @Test
    fun liveStreamsUseHls() {
        val muxed = muxed(0, Container.Mp4, "avc1.42001E, mp4a.40.2", 360)
        assertEquals(StreamPlan.Hls("https://example.invalid/live.m3u8", 360), selector.select(StreamOptions(listOf(muxed), "https://example.invalid/live.m3u8", true), 360))
        assertEquals(StreamPlan.Hls("https://example.invalid/live.m3u8", 240), selector.select(StreamOptions(listOf(muxed), "https://example.invalid/live.m3u8", true), 240), "HLS carries the cap to the player")
    }

    @Test
    fun unsupportedCodecsAndDeliveriesAreRejected() {
        val av1 = videoOnly(0, Container.Mp4, "av01.0.05M.08", 360)
        val hdr = videoOnly(1, Container.WebM, "vp09.02.30.10", 360)
        val surround = audio(2, Container.M4a, "ec-3", 384_000)
        val manifestOnly = videoOnly(3, Container.Mp4, "avc1.4d401e", 360).copy(isUrl = false)
        val torrent = muxed(4, Container.Mp4, "avc1.42001E, mp4a.40.2", 360).copy(delivery = Delivery.Other)
        val dubbed = audio(5, Container.M4a, "mp4a.40.2", 128_000).copy(originalAudio = false)
        assertNull(selector.select(options(av1, hdr, surround, manifestOnly, torrent, dubbed), 360))
        val fallback = videoOnly(6, Container.Mp4, "avc1.4d4015", 240)
        val aac = audio(7, Container.M4a, "mp4a.40.2", 128_000)
        assertEquals(StreamPlan.Streams(fallback, aac), selector.select(options(av1, hdr, surround, fallback, aac, dubbed), 360))
    }

    @Test
    fun capPicksTheBestHeightAtOrBelowTheLimit() {
        val streams = listOf(144, 240, 360, 480, 720, 1080).mapIndexed { i, h -> videoOnly(i, Container.Mp4, "avc1.4d401e", h) } + audio(6, Container.M4a, "mp4a.40.2", 128_000)
        assertEquals(360, (selector.select(options(*streams.toTypedArray()), 360) as StreamPlan.Streams).height)
        assertEquals(480, (selector.select(options(*streams.toTypedArray()), 480) as StreamPlan.Streams).height)
        assertEquals(240, (selector.select(options(*streams.toTypedArray()), 240) as StreamPlan.Streams).height)
        assertEquals(720, (selector.select(options(*streams.toTypedArray()), 4320) as StreamPlan.Streams).height, "hard 720p ceiling")
    }

    @Test
    fun theSelectedMaximumIsNeverExceeded() {
        val aac = audio(0, Container.M4a, "mp4a.40.2", 128_000)
        val v480 = videoOnly(1, Container.Mp4, "avc1.4d401f", 480)
        val v720 = videoOnly(2, Container.Mp4, "avc1.4d401f", 720)
        assertNull(selector.select(options(aac, v720, v480), 240), "no silent upgrade from 240p to 480p")
        assertNull(selector.select(options(aac, v720), 360), "a 720p-only video is not played at a 360p limit")
        assertEquals(480, selector.lowestPlayableHeight(options(aac, v720, v480)), "the lowest playable height is reported for the error")
        assertNull(selector.lowestPlayableHeight(options(v480)), "nothing playable without audio")
        val viaHls = selector.select(StreamOptions(listOf(aac, v720, v480), "https://example.invalid/master.m3u8", false), 240)
        assertEquals(StreamPlan.Hls("https://example.invalid/master.m3u8", 240), viaHls, "HLS is tried with the same limit")
        assertNull(selector.select(options(aac, videoOnly(3, Container.Mp4, "avc1.640028", 1080)), 480))
        for (cap in listOf(240, 360, 480)) {
            val streams = listOf(144, 240, 360, 480, 720).mapIndexed { i, h -> videoOnly(i + 10, Container.Mp4, "avc1.4d401e", h) } + aac
            assertTrue((selector.select(options(*streams.toTypedArray()), cap) as StreamPlan.Streams).height <= cap)
        }
    }

    @Test
    fun combinedBeatsSplitAtTheSameHeight() {
        val split = videoOnly(0, Container.Mp4, "avc1.4d401e", 360)
        val aac = audio(1, Container.M4a, "mp4a.40.2", 128_000)
        val muxed = muxed(2, Container.Mp4, "avc1.42001E, mp4a.40.2", 360)
        assertEquals(StreamPlan.Streams(muxed, null), selector.select(options(split, aac, muxed), 360))
    }

    @Test
    fun audioPrefersBoundedBitrate() {
        val v = videoOnly(0, Container.Mp4, "avc1.4d401e", 360)
        val low = audio(1, Container.M4a, "mp4a.40.5", 48_000)
        val mid = audio(2, Container.M4a, "mp4a.40.2", 129_000)
        val high = audio(3, Container.M4a, "mp4a.40.2", 256_000)
        assertEquals(mid, (selector.select(options(v, low, high, mid), 360) as StreamPlan.Streams).audio)
        assertEquals(high, (selector.select(options(v, high), 360) as StreamPlan.Streams).audio)
    }

    @Test
    fun excludingACodecFamilyFallsBackToTheNextOne() {
        val avc = videoOnly(0, Container.Mp4, "avc1.4d401e", 360)
        val vp9 = videoOnly(1, Container.WebM, "vp9", 360)
        val aac = audio(2, Container.M4a, "mp4a.40.2", 128_000)
        val plan = selector.withExcluded(CodecFamily.Avc).select(options(avc, vp9, aac), 360) as StreamPlan.Streams
        assertEquals(vp9, plan.video)
        assertNull(selector.withExcluded(CodecFamily.Avc).withExcluded(CodecFamily.Vp9).select(options(avc, vp9, aac), 360))
    }

    @Test
    fun availableHeightsListOnlyPlayableHeights() {
        val streams = options(
            videoOnly(0, Container.Mp4, "avc1.4d401e", 360),
            videoOnly(1, Container.Mp4, "avc1.4d401f", 480),
            videoOnly(2, Container.Mp4, "av01.0.08M.08", 1080),
            videoOnly(3, Container.Mp4, "avc1.640028", 1080),
            muxed(4, Container.Mp4, "avc1.42001E, mp4a.40.2", 240),
        )
        assertEquals(listOf(240), selector.availableHeights(streams), "no audio means only combined streams count")
        val withAudio = StreamOptions(streams.candidates + audio(5, Container.M4a, "mp4a.40.2", 128_000), null, false)
        assertEquals(listOf(480, 360, 240), selector.availableHeights(withAudio))
    }

    @Test
    fun codecFamilyFallsBackToContainerWhenCodecIsMissing() {
        assertEquals(CodecFamily.Avc, videoOnly(0, Container.Mp4, null, 360).family)
        assertEquals(CodecFamily.Vp9, videoOnly(0, Container.WebM, "", 360).family)
        assertEquals(CodecFamily.Aac, audio(0, Container.M4a, null, 128_000).family)
        assertEquals(CodecFamily.Unsupported, videoOnly(0, Container.Mp4, "hev1.1.6.L93.B0", 360).family)
        assertTrue(YouTubeStreamSelector.QUALITY_CHOICES.containsAll(listOf(360, 480)))
        assertEquals(360, YouTubeStreamSelector.DEFAULT_MAX_HEIGHT)
    }

    private fun options(vararg candidates: StreamCandidate) = StreamOptions(candidates.toList(), null, false)

    companion object {
        internal fun muxed(index: Int, container: Container, codec: String?, height: Int) =
            StreamCandidate(index, CandidateKind.Muxed, container, codec, height, 500_000, Delivery.Progressive, true)

        internal fun videoOnly(index: Int, container: Container, codec: String?, height: Int) =
            StreamCandidate(index, CandidateKind.VideoOnly, container, codec, height, height * 2_000, Delivery.Progressive, true)

        internal fun audio(index: Int, container: Container, codec: String?, bitrate: Int) =
            StreamCandidate(index, CandidateKind.Audio, container, codec, 0, bitrate, Delivery.Progressive, true)
    }
}
