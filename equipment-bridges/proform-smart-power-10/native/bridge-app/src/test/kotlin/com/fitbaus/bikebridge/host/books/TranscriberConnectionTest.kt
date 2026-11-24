package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.IOException

class TranscriberConnectionTest {
    private val token = "a".repeat(64)
    private val connection = TranscriberConnection.fromFields("http", "192.168.1.193", "8765", token)
    private val response = """{"api_version":1,"transcript_schema":"fitbaus.transcript/v1","job_api":true,"source_configured":true,"source_id":"home-library","transcription":true,"engine_ready":true,"max_window_ms":300000}"""

    @Test
    fun capabilityDiscoveryUsesOnlyTranscriberCredential() {
        val capabilities = connection.test(BooksHttp { url, sent ->
            assertEquals("http://192.168.1.193:8765/v1/capabilities", url)
            assertEquals(token, sent)
            BooksHttpResponse(200, response)
        })
        assertTrue(capabilities.ready)
        assertEquals("home-library", capabilities.sourceId)
        assertEquals(300000, capabilities.maxWindowMs)
    }

    @Test
    fun validButUnreadyServiceIsDistinguished() {
        val capabilities = connection.test(BooksHttp { _, _ ->
            BooksHttpResponse(200, response.replace("\"engine_ready\":true", "\"engine_ready\":false"))
        })
        assertFalse(capabilities.ready)
    }

    @Test
    fun rejectedTokenAndIncompatibleServiceFail() {
        assertThrows(IOException::class.java) {
            connection.test(BooksHttp { _, _ -> BooksHttpResponse(401, "") })
        }
        assertThrows(IllegalArgumentException::class.java) {
            connection.test(BooksHttp { _, _ -> BooksHttpResponse(200, response.replace("\"api_version\":1", "\"api_version\":2")) })
        }
        assertThrows(IllegalArgumentException::class.java) {
            connection.test(BooksHttp { _, _ -> BooksHttpResponse(200, response.replace("\"job_api\":true", "\"job_api\":false")) })
        }
    }

    @Test
    fun rejectsUnsafeAddressAndInvalidToken() {
        for (address in listOf("http://public.example", "http://8.8.8.8:8765", "https://host/path", "https://host?query=1", "https://user@host", "https://host#fragment")) {
            assertThrows(IllegalArgumentException::class.java) { TranscriberConnection(address, token) }
        }
        assertThrows(IllegalArgumentException::class.java) { TranscriberConnection("https://host", "short") }
        assertThrows(IllegalArgumentException::class.java) { TranscriberConnection("https://host", token + "\n") }
    }
}
