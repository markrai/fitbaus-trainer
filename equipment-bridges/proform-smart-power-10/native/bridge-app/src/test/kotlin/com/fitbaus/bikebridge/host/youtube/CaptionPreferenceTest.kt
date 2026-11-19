// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class CaptionPreferenceTest {
    private fun track(language: String, automatic: Boolean, format: String = "text/vtt") =
        CaptionTrack("https://www.youtube.com/api/timedtext?lang=$language", language, format, automatic)

    @Test
    fun englishIsPreferredAndManualBeatsAutomatic() {
        val tracks = listOf(track("es", false), track("en-US", true), track("en", true), track("en", false))
        assertEquals(tracks.last(), CaptionPreference.preferred(tracks))
    }

    @Test
    fun regionalEnglishBeatsOtherLanguages() {
        val tracks = listOf(track("fr", false), track("en-GB", true), track("de", false))
        assertEquals(tracks[1], CaptionPreference.preferred(tracks))
    }

    @Test
    fun otherLanguageAndNoCaptionsAreHandled() {
        assertEquals(track("fr", false), CaptionPreference.preferred(listOf(track("fr", true), track("fr", false))))
        assertNull(CaptionPreference.preferred(emptyList()))
    }
}
