package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.IOException

class TranscriberConnectionTest {
    private val token = "a".repeat(64)
    private val connection = TranscriberConnection.fromFields("http", "192.168.1.193", "8765", token)
    private val response = """{"api_version":1,"transcript_schema":"fitbaus.transcript/v1","job_api":true,"source_configured":true,"source_id":"home-library","transcription":true,"engine_ready":true,"max_window_ms":300000}"""

    @Test
    fun pairingNormalizesCodeAndExchangesWithoutOperatorToken() {
        val deviceToken = "Z".repeat(43)
        val paired = TranscriberConnection.pair("http://192.168.1.193:8765", "a5gc5gbx", BooksAuthHttp { url, headers, body ->
            assertEquals("http://192.168.1.193:8765/v1/pairing/redeem", url)
            assertTrue(headers.isEmpty())
            assertEquals("A5GC-5GBX", org.json.JSONObject(body).getString("code"))
            BooksHttpResponse(200, org.json.JSONObject().put("token", deviceToken).toString())
        })
        assertEquals(deviceToken, paired.token)
        assertThrows(IllegalArgumentException::class.java) { TranscriberConnection.normalizeCode("ABCD-0123") }
        assertThrows(IOException::class.java) {
            TranscriberConnection.pair("https://host", "A5GC-5GBX", BooksAuthHttp { _, _, _ -> BooksHttpResponse(401, "") })
        }
        assertThrows(IllegalArgumentException::class.java) {
            TranscriberConnection.pair("http://public.example", "A5GC-5GBX", BooksAuthHttp { _, _, _ -> error("Unsafe request") })
        }
    }

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
    fun summaryProviderCapabilityIsOptionalAndUsesExistingCredential() {
        val provider = JSONObject().put("configured", true).put("protocol", "openai-chat/v1").put("model", "qwen3:14b")
        val configured = connection.test(BooksHttp { url, sent ->
            assertEquals("http://192.168.1.193:8765/v1/capabilities", url)
            assertEquals(token, sent)
            BooksHttpResponse(200, JSONObject(response).put("summary_provider", provider).toString())
        })
        assertEquals(SummaryProviderCapability("qwen3:14b"), configured.summaryProvider)
        assertTrue(configured.ready)
        val legacy = connection.test(BooksHttp { _, _ -> BooksHttpResponse(200, response) })
        assertNull(legacy.summaryProvider)
        assertTrue(legacy.ready)
    }

    @Test
    fun disabledMalformedAndUnknownSummaryProvidersDoNotBreakTranscription() {
        val valid = """{"configured":true,"protocol":"openai-chat/v1","model":"model"}"""
        val values = listOf(
            JSONObject.NULL,
            true,
            JSONObject().put("configured", false),
            JSONObject(valid).put("configured", "true"),
            JSONObject(valid).put("protocol", "future/v2"),
            JSONObject(valid).put("model", "bad model"),
            JSONObject(valid).put("model", 123),
            JSONObject(valid).put("model", "m".repeat(161)),
        )
        for (value in values) {
            val result = connection.test(BooksHttp { _, _ ->
                BooksHttpResponse(200, JSONObject(response).put("summary_provider", value).toString())
            })
            assertNull(result.summaryProvider)
            assertTrue(result.ready)
        }
    }

    @Test
    fun configuredSummaryProviderDoesNotImplyEngineReadiness() {
        val body = JSONObject(response).put("engine_ready", false).put("summary_provider",
            JSONObject().put("configured", true).put("protocol", "openai-chat/v1").put("model", "model"))
        val result = connection.test(BooksHttp { _, _ -> BooksHttpResponse(200, body.toString()) })
        assertFalse(result.ready)
        assertEquals(SummaryProviderCapability("model"), result.summaryProvider)
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
