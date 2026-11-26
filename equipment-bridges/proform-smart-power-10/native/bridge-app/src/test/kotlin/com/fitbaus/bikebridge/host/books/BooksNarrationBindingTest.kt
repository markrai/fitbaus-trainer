package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BooksNarrationBindingTest {
    private val address = "http://192.168.1.193:13378"
    private val book = "a45e88ef-b9d3-4ec9-8ef1-a728c901aaa1"

    @Test
    fun repeatedPlaybackAndSeekCallbacksDoNotRevalidateTheSameBook() {
        var constructions = 0
        var opens = 0
        var updates = 0
        var request: BooksTranscriptRequest? = null
        val binding = BooksNarrationBinding { server, id ->
            constructions++
            BooksTranscriptRequest(server, id)
        }
        val positions = listOf(0L, 300_000L, 600_000L, 12_000L, 0L, 299_999L, 300_000L)
        repeat(200) {
            for (position in positions) {
                assertTrue(binding.render(address, book,
                    open = { opens++; request = it },
                    update = { updates++; assertEquals(book, request?.itemId); assertTrue(position >= 0) },
                    unavailable = { throw AssertionError(it) }))
            }
        }
        assertEquals(1, constructions)
        assertEquals(1, opens)
        assertEquals(1399, updates)
        val original = request
        assertTrue(binding.render(address, book, { throw AssertionError("Reopened") },
            { assertSame(original, request) }, { throw AssertionError(it) }))
        assertTrue(binding.clear())
        assertFalse(binding.clear())
        assertTrue(binding.render(address, book, { opens++ }, {}, { throw AssertionError(it) }))
        assertEquals(2, constructions)
        assertEquals(2, opens)
    }

    @Test
    fun rejectedIdentityIsNotRetriedOnEveryCallbackAndNewBookRecovers() {
        var constructions = 0
        var failures = 0
        val binding = BooksNarrationBinding { server, id ->
            constructions++
            BooksTranscriptRequest(server, id)
        }
        repeat(100) {
            assertFalse(binding.render(address, "../book",
                { throw AssertionError("Opened invalid identity") },
                { throw AssertionError("Rendered invalid identity") },
                { failures++; assertTrue(it is IllegalArgumentException) }))
        }
        assertEquals(1, failures)
        assertEquals(1, constructions)
        assertTrue(binding.render(address, book, {}, {}, { throw AssertionError(it) }))
        assertTrue(binding.render("http://192.168.1.194:13378", book, {}, {}, { throw AssertionError(it) }))
        assertEquals(3, constructions)
    }

    @Test
    fun synchronousOpenAndUpdateFailuresDisableOnlyNarrationUntilReset() {
        val binding = BooksNarrationBinding()
        var failures = 0
        val unavailable: (Exception) -> Unit = { failures++ }
        assertFalse(binding.render(address, book, { throw IllegalArgumentException() }, {}, unavailable))
        assertFalse(binding.render(address, book, {}, { throw AssertionError("Updated failed narration") }, unavailable))
        assertEquals(1, failures)
        binding.clear()
        assertTrue(binding.render(address, book, {}, {}, unavailable))
        assertFalse(binding.render(address, book, {}, { throw IllegalStateException() }, unavailable))
        assertFalse(binding.render(address, book, {}, { throw AssertionError("Updated failed narration") }, unavailable))
        assertEquals(2, failures)
        assertTrue(binding.render(address, "another-book", {}, {}, unavailable))
    }

    @Test
    fun asciiValidationKeepsTheExactIdentifierContract() {
        val valid = listOf("a", "_", "-", "A0_z-9", book, "x".repeat(128))
        val invalid = listOf("", "x".repeat(129), "../book", "a/b", "a\\b", "a%2fb", "a b",
            "a\n", "a\u0000", "é", "Ａ", "١", "😀")
        val server = BooksServer(address)
        for (id in valid) {
            assertTrue(BooksIdentifier.isValid(id))
            assertTrue(server.coverUrl(id).contains("/items/$id/"))
            assertTrue(BooksTranscriptRequest(address, id).relativePath().endsWith("/$id"))
        }
        for (id in invalid) {
            assertFalse(BooksIdentifier.isValid(id))
            assertThrows(IllegalArgumentException::class.java) { server.coverUrl(id) }
            assertThrows(IllegalArgumentException::class.java) { BooksTranscriptRequest(address, id) }
        }
        val expected = Regex("[A-Za-z0-9_-]{1,128}")
        for (code in 0..65535) {
            val value = code.toChar().toString()
            assertEquals(expected.matches(value), BooksIdentifier.isValid(value))
        }
    }
}
