package com.fitbaus.bikebridge.host.books

import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.IOException

class BooksElaborationEventsTest {
    private val session = BooksPlaybackSession("session", listOf(
        BooksAudioTrack("http://192.168.1.193:13378/api/items/book/file/123", 0, 900_000)
    ), emptyList(), 0)
    private val identity = BooksDiagramIdentity(
        BooksSummarySelection("book", session, BooksSection(0, 300_000, null, 1, 3), "a".repeat(64)),
        BooksSummaryState.Ready("a".repeat(64), "Summary", "test-model", "section-v1", "b".repeat(64), true, "home")
    )
    private fun event(state: String) = identity.body().put("schema", "fitbaus.section-concepts/v1")
        .put("concept_prompt_version", "concepts-v2").put("concept_input_version", "plain-lines-v1")
        .put("index", 0).put("concept", "Calculus").put("state", state)
    private fun delta(value: String) = JSONObject().put("state", "delta").put("text", value)

    @Test
    fun partialTextIsPublishedBeforeValidatedFinal() {
        val events = BooksElaborationEvents(identity, 0, "Calculus")
        val partial = mutableListOf<String>()
        assertNull(events.accept(event("streaming")) { partial.add(it) })
        assertNull(events.accept(delta("Integral")) { partial.add(it) })
        assertNull(events.accept(delta(" calculus")) { partial.add(it) })
        assertEquals(listOf("Integral", "Integral calculus"), partial)
        assertEquals("Integral calculus", events.accept(event("ready").put("explanation", "Integral calculus")) {
            partial.add(it)
        })
    }

    @Test
    fun rejectUnexpectedIdentityAndFinalText() {
        val events = BooksElaborationEvents(identity, 0, "Calculus")
        assertThrows(IllegalArgumentException::class.java) { events.accept(delta("Unverified")) {} }
        assertThrows(IllegalArgumentException::class.java) { events.accept(event("streaming").put("index", 1)) {} }
        events.accept(event("streaming")) {}
        events.accept(delta("Partial")) {}
        assertThrows(IllegalArgumentException::class.java) {
            events.accept(event("ready").put("explanation", "Different")) {}
        }
    }

    @Test
    fun boundedReaderReadsOneEventAtATimeAndRejectsLongLines() {
        val reader = BoundedElaborationReader(ByteArrayInputStream("first\nsecond\n".toByteArray())) {}
        assertEquals("first", reader.line())
        assertEquals("second", reader.line())
        assertNull(reader.line())
        assertThrows(IOException::class.java) {
            BoundedElaborationReader(ByteArrayInputStream(ByteArray(33 * 1024) { 65 })) {}.line()
        }
    }
}
