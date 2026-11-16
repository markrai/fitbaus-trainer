// SPDX-License-Identifier: GPL-3.0-only
/*
 * Adapted from SkyTube app/src/main/java/free/rm/skytube/app/StreamSelectionPolicy.java
 * at tag v3.003 (commit bf559833ec3ddcc8d10cea38a7e15a5487318563),
 * https://github.com/SkyTubeTeam/SkyTube
 *
 * SkyTube
 * Copyright (C) 2020  Zsombor Gegesy
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
 * Modified for FitBaus in 2026: rewritten in Kotlin over plain stream
 * descriptors instead of NewPipe objects; adds an H.264/AAC preference,
 * rejects AV1, high-bit-depth VP9 and surround audio for the API 22 console,
 * keeps combined streams ahead of split streams at the same height, retries
 * with combined streams when no audio track exists, prefers HLS for live
 * streams, treats the quality setting as a strict maximum (no stream above it is
 * ever chosen; HLS carries the cap for the player's track selector), applies a
 * hard 720p ceiling and supports codec exclusion after a decoder failure. See bridge-app/third-party/YOUTUBE-NOTICE.
 */

package com.fitbaus.bikebridge.host.youtube

internal enum class CandidateKind { Muxed, VideoOnly, Audio }

internal enum class Container { Mp4, WebM, ThreeGpp, M4a, WebMAudio, Other }

internal enum class Delivery { Progressive, Dash, Hls, Other }

internal enum class CodecFamily { Avc, Vp9, Mpeg4, Vp8, Aac, Opus, Vorbis, Unsupported }

internal data class StreamCandidate(
    val index: Int,
    val kind: CandidateKind,
    val container: Container,
    val codec: String?,
    val height: Int,
    val bitrate: Int,
    val delivery: Delivery,
    val isUrl: Boolean,
    val originalAudio: Boolean = true,
) {
    val family: CodecFamily
        get() = StreamCodecs.family(this)
}

internal class StreamOptions(
    val candidates: List<StreamCandidate>,
    val hlsUrl: String?,
    val live: Boolean,
)

internal sealed class StreamPlan {
    data class Streams(val video: StreamCandidate, val audio: StreamCandidate?) : StreamPlan() {
        val height: Int
            get() = video.height
    }

    data class Hls(val url: String, val maxHeight: Int) : StreamPlan()
}

internal object StreamCodecs {
    fun family(candidate: StreamCandidate): CodecFamily {
        val codec = candidate.codec?.lowercase()
        if (codec.isNullOrEmpty()) {
            return when (candidate.container) {
                Container.Mp4 -> CodecFamily.Avc
                Container.WebM -> CodecFamily.Vp9
                Container.ThreeGpp -> CodecFamily.Mpeg4
                Container.M4a -> CodecFamily.Aac
                Container.WebMAudio -> CodecFamily.Opus
                Container.Other -> CodecFamily.Unsupported
            }
        }
        return when {
            codec.startsWith("avc1") || codec.startsWith("avc3") -> CodecFamily.Avc
            codec == "vp9" || codec.startsWith("vp09.00") -> CodecFamily.Vp9
            codec.startsWith("vp8") -> CodecFamily.Vp8
            codec.startsWith("mp4v") -> CodecFamily.Mpeg4
            codec.startsWith("mp4a.40") || codec == "aac" -> CodecFamily.Aac
            codec == "opus" -> CodecFamily.Opus
            codec == "vorbis" -> CodecFamily.Vorbis
            else -> CodecFamily.Unsupported
        }
    }
}

internal class YouTubeStreamSelector(
    private val excluded: Set<CodecFamily> = emptySet(),
) {
    fun withExcluded(family: CodecFamily): YouTubeStreamSelector = YouTubeStreamSelector(excluded + family)

    fun select(options: StreamOptions, maxHeight: Int): StreamPlan? {
        val cap = maxHeight.coerceIn(MIN_HEIGHT, HARD_MAX_HEIGHT)
        val hls = options.hlsUrl?.takeIf { it.isNotBlank() }
        if (options.live && hls != null) return StreamPlan.Hls(hls, cap)
        val audio = pickAudio(options.candidates)
        val videos = options.candidates.filter { usableVideo(it) && (it.kind == CandidateKind.Muxed || audio != null) }
        val video = pickVideo(videos, cap)
        if (video != null) {
            return StreamPlan.Streams(video, if (video.kind == CandidateKind.VideoOnly) audio else null)
        }
        return hls?.let { StreamPlan.Hls(it, cap) }
    }

    fun lowestPlayableHeight(options: StreamOptions): Int? {
        val audio = pickAudio(options.candidates)
        return options.candidates
            .filter { usableVideo(it) && (it.kind == CandidateKind.Muxed || audio != null) }
            .minOfOrNull { it.height }
    }

    fun availableHeights(options: StreamOptions): List<Int> {
        val audio = pickAudio(options.candidates)
        return options.candidates
            .filter { usableVideo(it) && (it.kind == CandidateKind.Muxed || audio != null) && it.height <= HARD_MAX_HEIGHT }
            .map { it.height }
            .distinct()
            .sortedDescending()
    }

    private fun usableVideo(candidate: StreamCandidate): Boolean {
        if (candidate.kind == CandidateKind.Audio || !candidate.isUrl || candidate.height <= 0) return false
        if (candidate.delivery != Delivery.Progressive && candidate.delivery != Delivery.Dash) return false
        if (candidate.container != Container.Mp4 && candidate.container != Container.WebM && candidate.container != Container.ThreeGpp) return false
        val family = candidate.family
        return family in VIDEO_FAMILIES && family !in excluded
    }

    private fun usableAudio(candidate: StreamCandidate): Boolean {
        if (candidate.kind != CandidateKind.Audio || !candidate.isUrl || !candidate.originalAudio) return false
        if (candidate.delivery != Delivery.Progressive && candidate.delivery != Delivery.Dash) return false
        val family = candidate.family
        return family in AUDIO_FAMILIES && family !in excluded
    }

    private fun pickVideo(videos: List<StreamCandidate>, cap: Int): StreamCandidate? {
        val within = videos.filter { it.height <= cap }
        if (within.isEmpty()) return null
        val height = within.maxOf { it.height }
        return within.filter { it.height == height }.minWithOrNull(VIDEO_ORDER)
    }

    private fun pickAudio(candidates: List<StreamCandidate>): StreamCandidate? {
        val audio = candidates.filter { usableAudio(it) }
        if (audio.isEmpty()) return null
        val family = AUDIO_PREFERENCE.firstOrNull { f -> audio.any { it.family == f } } ?: return null
        val preferred = audio.filter { it.family == family }
        val bounded = preferred.filter { it.bitrate in 1..AUDIO_BITRATE_CEILING }
        return if (bounded.isNotEmpty()) bounded.maxByOrNull { it.bitrate } else preferred.minByOrNull { if (it.bitrate <= 0) Int.MAX_VALUE else it.bitrate }
    }

    companion object {
        const val MIN_HEIGHT: Int = 144
        const val HARD_MAX_HEIGHT: Int = 720
        const val DEFAULT_MAX_HEIGHT: Int = 360
        const val AUDIO_BITRATE_CEILING: Int = 160_000
        val QUALITY_CHOICES: List<Int> = listOf(240, 360, 480)
        private val VIDEO_FAMILIES = setOf(CodecFamily.Avc, CodecFamily.Vp9, CodecFamily.Vp8, CodecFamily.Mpeg4)
        private val AUDIO_FAMILIES = setOf(CodecFamily.Aac, CodecFamily.Opus, CodecFamily.Vorbis)
        private val AUDIO_PREFERENCE = listOf(CodecFamily.Aac, CodecFamily.Opus, CodecFamily.Vorbis)
        private val VIDEO_FAMILY_RANK = mapOf(CodecFamily.Avc to 0, CodecFamily.Vp9 to 1, CodecFamily.Vp8 to 2, CodecFamily.Mpeg4 to 3)
        private val VIDEO_ORDER: Comparator<StreamCandidate> = compareBy<StreamCandidate>(
            { if (it.kind == CandidateKind.Muxed) 0 else 1 },
            { VIDEO_FAMILY_RANK[it.family] ?: 9 },
            { if (it.delivery == Delivery.Progressive) 0 else 1 },
            { if (it.bitrate <= 0) Int.MAX_VALUE else it.bitrate },
        )
    }
}
