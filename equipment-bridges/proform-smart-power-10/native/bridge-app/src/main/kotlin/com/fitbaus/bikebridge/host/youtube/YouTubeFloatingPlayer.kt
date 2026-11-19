// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

internal object YouTubeFloatingPlayer {
    fun canFloat(state: YouTubeState): Boolean =
        state.active &&
            state.screen == Screen.Player &&
            state.playback.video != null &&
            state.playback.phase in setOf(
                PlaybackPhase.Resolving,
                PlaybackPhase.Buffering,
                PlaybackPhase.Playing,
                PlaybackPhase.Paused,
            )
}
