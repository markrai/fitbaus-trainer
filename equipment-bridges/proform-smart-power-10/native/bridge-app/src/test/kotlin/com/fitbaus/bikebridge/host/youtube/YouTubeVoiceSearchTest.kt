// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import java.io.File
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class YouTubeVoiceSearchTest {
    @Test
    fun returnsFirstNonBlankRecognitionAndTrimsIt() {
        assertEquals("cycling workouts", YouTubeVoiceSearch.bestMatch(listOf("", "  ", "  cycling workouts  ", "ignored")))
        assertNull(YouTubeVoiceSearch.bestMatch(null))
        assertNull(YouTubeVoiceSearch.bestMatch(emptyList()))
        assertNull(YouTubeVoiceSearch.bestMatch(listOf(" ", "\t")))
    }

    @Test
    fun capsRecognizedTextAtTheSameLimitAsTypedSearch() {
        val long = "x".repeat(YouTubeSession.MAX_QUERY_LENGTH + 50)
        assertEquals("x".repeat(YouTubeSession.MAX_QUERY_LENGTH), YouTubeVoiceSearch.bestMatch(listOf(long)))
    }

    @Test
    fun micAndClearAreSeparateTouchTargetsInTheSearchField() {
        val ui = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/YouTubeContent.kt").readText()
        val controls = ui.substringAfter("private fun buildResults()").substringBefore("private fun buildPlayer()")
        assertTrue(controls.contains("searchClear.setOnClickListener { returnToHome() }"))
        assertTrue(controls.contains("clearLp.rightMargin = dp(TOUCH_DP)"))
        assertTrue(controls.contains("searchMic.setImageResource(R.drawable.ic_mic)"))
        assertTrue(controls.contains("searchMic.contentDescription = \"Search YouTube by voice\""))
        assertTrue(controls.contains("searchMic.setOnClickListener { onVoiceSearchRequested() }"))
        assertTrue(controls.contains("fieldSlot.addView(searchMic, FrameLayout.LayoutParams(dp(TOUCH_DP), dp(TOUCH_DP), Gravity.END or Gravity.CENTER_VERTICAL))"))
        assertTrue(ui.contains("searchField.setText(recognized)"))
        assertTrue(ui.contains("submitSearch()"))
    }

    @Test
    fun externalSpeechResultIsDeliveredOnlyAfterYouTubeResumes() {
        val host = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        assertTrue(host.contains("Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)"))
        assertTrue(host.contains("putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)"))
        assertTrue(host.contains("startActivityForResult(intent, YOUTUBE_VOICE_SEARCH_REQUEST)"))
        assertTrue(host.contains("catch (_: ActivityNotFoundException)"))
        assertTrue(host.contains("resultCode != Activity.RESULT_OK"))
        assertTrue(host.contains("YouTubeVoiceSearch.bestMatch(matches)"))
        assertTrue(host.contains("if (!resumed || modeController.mode != ArcadeMode.YouTube) return"))
        assertTrue(host.contains("youtubeContent.acceptVoiceSearchResult(query)"))
        assertTrue(host.contains("onVoiceSearchRequested = { requestYouTubeVoiceSearch() }"))
    }
}
