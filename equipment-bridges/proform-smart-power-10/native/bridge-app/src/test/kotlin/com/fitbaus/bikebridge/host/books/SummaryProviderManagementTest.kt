package com.fitbaus.bikebridge.host.books

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SummaryProviderManagementTest {
    private val connection = TranscriberConnection("http://192.168.1.193:8765", "a".repeat(43))
    private val grant = "b".repeat(43)
    private val requests = mutableListOf<Triple<String, Map<String, String>, JSONObject?>>()
    private val configured = JSONObject().put("configured", true)
        .put("base_url", "https://192.168.1.200:7869/v1").put("model", "lobo-nano")
        .put("has_api_key", false).put("custom_ca", true).put("allow_http", false)
    private val disabled = JSONObject().put("configured", false).put("base_url", JSONObject.NULL)
        .put("model", JSONObject.NULL)
    private var supported = true
    private var discoveryModels = JSONArray().put("lobo-nano")
    private var failure: BooksHttpResponse? = null

    private fun client() = SummaryProviderManagement(connection, TranscriberHttp { url, headers, body ->
        assertTrue(url.startsWith(connection.address + "/v1/"))
        assertEquals("Bearer ${connection.token}", headers["Authorization"])
        assertNull(headers["X-Audiobookshelf-Token"])
        val path = url.removePrefix(connection.address)
        requests.add(Triple(path, headers, body?.let { JSONObject(it) }))
        val result = when {
            path == "/v1/capabilities" -> JSONObject().put("api_version", 1)
                .put("summary_provider_management_api", supported)
            path.endsWith("/redeem") -> JSONObject().put("token", grant).put("expires_in", 600)
            path.endsWith("/session") -> configured
            path.endsWith("/discover") -> JSONObject().put("candidate", configured).put("models", discoveryModels)
            path.endsWith("/test-candidate") -> JSONObject().put("ok", true).put("model", "lobo-nano").put("elapsed_ms", 3260)
            path.endsWith("/save") -> configured
            path.endsWith("/disable") -> disabled
            path.endsWith("/cancel") -> JSONObject().put("cancelled", true)
            else -> error("Unexpected request")
        }
        failure ?: BooksHttpResponse(200, result.toString())
    })

    @Test
    fun loboFlowUsesOnlyTranscriberAndScopedGrant() {
        val api = client()
        assertEquals(true to null, api.capabilities())
        assertEquals("lobo-nano", api.authorize("abcd-efgh").model)
        assertNull(requests[0].second["X-FitBaus-Summary-Admin"])
        assertNull(requests[1].second["X-FitBaus-Summary-Admin"])
        assertEquals("ABCD-EFGH", requests[1].third!!.getString("code"))
        assertEquals(grant, requests[2].second["X-FitBaus-Summary-Admin"])
        val discovery = api.discoverNew("lobo", "https://192.168.1.200:7869/v1", false, "", "FMV3-14SR")
        assertEquals(listOf("lobo-nano"), discovery.models)
        assertTrue(discovery.candidate.customCa)
        val body = requests.last().third!!
        assertEquals("FMV3-14SR", body.getString("lobo_auth"))
        assertFalse(body.has("api_key"))
        assertEquals(3260L, api.test("lobo-nano"))
        assertTrue(api.save().configured)
        assertTrue(requests.last().third!!.getBoolean("confirm_egress"))
        assertThrows(IllegalArgumentException::class.java) { api.status() }
    }

    @Test
    fun existingProviderCanBeReusedAndDisabledWithoutSendingStoredSecrets() {
        val api = client()
        api.authorize("ABCD-EFGH")
        api.discoverCurrent()
        assertEquals(1, requests.last().third!!.length())
        assertTrue(requests.last().third!!.getBoolean("use_current"))
        assertFalse(api.disable().configured)
        assertTrue(requests.last().third!!.getBoolean("confirm"))
    }

    @Test
    fun refusesNewKeyOverCleartextBikeConnectionAndMalformedEndpoint() {
        val api = client()
        api.authorize("ABCD-EFGH")
        val count = requests.size
        assertThrows(IllegalArgumentException::class.java) {
            api.discoverNew("custom", "https://example.test/v1", false, "secret", "")
        }
        assertThrows(IllegalArgumentException::class.java) {
            api.discoverNew("custom", "https://user:secret@example.test/v1", false, "", "")
        }
        assertEquals(count, requests.size)
    }

    @Test
    fun capabilityAndErrorsAreStrictAndGrantCanBeCancelled() {
        val api = client()
        supported = false
        assertEquals(false to null, api.capabilities())
        api.authorize("ABCD-EFGH")
        failure = BooksHttpResponse(401, """{"error":"lobo_auth_mismatch"}""")
        val error = assertThrows(SummaryManagementFailure::class.java) { api.discoverCurrent() }
        assertEquals("lobo_auth_mismatch", error.code)
        failure = null
        discoveryModels = JSONArray().put("bad model")
        assertThrows(IllegalArgumentException::class.java) { api.discoverCurrent() }
        api.cancel()
        assertThrows(IllegalArgumentException::class.java) { api.status() }
    }
}
