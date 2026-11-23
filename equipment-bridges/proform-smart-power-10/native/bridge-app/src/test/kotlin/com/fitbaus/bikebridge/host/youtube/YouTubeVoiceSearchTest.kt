// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import java.io.File
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
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
    fun microphoneOnlyShowsRedRecordingCircleWhileListening() {
        val ui = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/YouTubeContent.kt").readText()
        val controller = File("src/main/kotlin/com/fitbaus/bikebridge/host/speech/OfflineVoiceSearchController.kt").readText()
        val service = File("src/main/kotlin/com/fitbaus/bikebridge/host/speech/OfflineVoiceSearchService.kt").readText()
        val activity = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        val drawable = File("src/main/res/drawable/ic_recording_dot.xml").readText()
        assertTrue(ui.contains("setVoiceSearchStatus(status: String?, listening: Boolean = false)"))
        assertTrue(ui.contains("if (listening) R.drawable.ic_recording_dot else R.drawable.ic_mic"))
        assertTrue(ui.contains("if (listening) \"Stop voice search\" else \"Search YouTube by voice\""))
        assertTrue(controller.contains("onStatus(\"Preparing offline voice search…\", false)"))
        assertTrue(controller.contains("onStatus(null, false)"))
        assertTrue(controller.contains("message.arg2 == 1"))
        assertTrue(service.contains("\"Listening… tap the mic to cancel\", listening = true"))
        assertTrue(activity.contains("onStatus = { status, listening -> youtubeContent.setVoiceSearchStatus(status, listening) }"))
        assertTrue(drawable.contains("android:shape=\"oval\""))
        assertTrue(drawable.contains("android:color=\"#F44336\""))
    }

    @Test
    fun voiceSearchUsesAnInAppSpeechProcessWithoutAnExternalActivity() {
        val host = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        val service = File("src/main/kotlin/com/fitbaus/bikebridge/host/speech/OfflineVoiceSearchService.kt").readText()
        val controller = File("src/main/kotlin/com/fitbaus/bikebridge/host/speech/OfflineVoiceSearchController.kt").readText()
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(host.contains("voiceSearch.toggle()"))
        assertTrue(host.contains("voiceSearch.cancel()"))
        assertTrue(host.contains("youtubeContent.session.state.screen != Screen.Results"))
        assertTrue(host.contains("youtubeContent.session.hasEngine"))
        assertTrue(host.contains("onVoiceSearchRequested = { requestYouTubeVoiceSearch() }"))
        assertTrue(host.contains("onVoiceSearchCancelled = { voiceSearch.cancel() }"))
        assertFalse(host.contains("RecognizerIntent.ACTION_RECOGNIZE_SPEECH"))
        assertFalse(host.contains("startActivityForResult"))
        assertTrue(service.contains("OfflineVoiceModel.ensure(this)"))
        assertTrue(service.contains("SpeechService(recognizer, VoiceSearchProtocol.SAMPLE_RATE)"))
        assertTrue(service.contains("Process.killProcess(Process.myPid())"))
        assertTrue(controller.contains("Context.BIND_AUTO_CREATE"))
        assertTrue(manifest.contains("android.permission.RECORD_AUDIO"))
        assertTrue(manifest.contains("android:process="))
    }

    @Test
    fun offlineModelIsPackagedWithPinnedHashAndTheCorrectAbi() {
        val gradle = File("build.gradle.kts").readText()
        val content = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/YouTubeContent.kt").readText()
        assertTrue(gradle.contains("vosk-android:0.3.75@aar"))
        assertTrue(gradle.contains("jna:5.18.1@aar"))
        assertTrue(gradle.contains("30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498"))
        assertTrue(gradle.contains("abiFilters += setOf(\"x86\")"))
        assertTrue(content.contains("private val voiceStatus"))
        assertTrue(content.contains("voiceStatus.visibility = if (status.isNullOrBlank()) GONE else VISIBLE"))
        assertTrue(content.contains("onVoiceSearchCancelled()"))
    }
}
