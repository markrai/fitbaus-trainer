package com.fitbaus.bikebridge.host.speech

import com.fitbaus.bikebridge.host.youtube.YouTubeSession
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class VoiceTranscriptTest {
    @Test
    fun onlyFinalNonemptyTextIsAccepted() {
        assertEquals("mountain biking", VoiceTranscript.fromResult("""{"text":" mountain biking "}"""))
        assertNull(VoiceTranscript.fromResult("""{"partial":"mountain"}"""))
        assertNull(VoiceTranscript.fromResult("""{"text":"  "}"""))
        assertNull(VoiceTranscript.fromResult("""{"text":null}"""))
        assertNull(VoiceTranscript.fromResult("{invalid"))
    }

    @Test
    fun outputIsBoundedToYouTubeSearchLimit() {
        assertEquals(YouTubeSession.MAX_QUERY_LENGTH, VoiceSearchProtocol.MAX_TEXT)
        assertEquals("x".repeat(VoiceSearchProtocol.MAX_TEXT),
            VoiceTranscript.fromResult("""{"text":"${"x".repeat(VoiceSearchProtocol.MAX_TEXT + 50)}"}"""))
    }
}
