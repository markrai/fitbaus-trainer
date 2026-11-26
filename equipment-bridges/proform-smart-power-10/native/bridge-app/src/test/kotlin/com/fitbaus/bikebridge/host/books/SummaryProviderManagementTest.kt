package com.fitbaus.bikebridge.host.books

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
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
    private var discoveryCandidate: JSONObject = configured
    private var failure: BooksHttpResponse? = null
    private var forgetResult: JSONObject = configured

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
            path.endsWith("/discover") -> JSONObject().put("candidate", discoveryCandidate).put("models", discoveryModels)
            path.endsWith("/test-candidate") -> JSONObject().put("ok", true).put("model", "lobo-nano").put("elapsed_ms", 3260)
            path.endsWith("/save") -> configured
            path.endsWith("/disable") -> disabled
            path.endsWith("/forget-lobo") -> forgetResult
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

    private fun <T> runAction(actions: SummaryProviderActions, action: SummaryProviderAction<T>): T {
        val ticket = requireNotNull(actions.begin(action))
        val result = action.execute()
        assertTrue(actions.complete(action, ticket, result))
        return result
    }

    @Test
    fun dialogActionAdapterUsesWorkflowToGateActualManagementCalls() {
        val flow = SummaryProviderWorkflow()
        val actions = SummaryProviderActions(flow, client())
        runAction(actions, actions.capabilities())
        assertNull(actions.begin(actions.discover("https://example.test/v1", false, "", "")))
        assertEquals(1, requests.size)
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited("https://192.168.1.200:7869/v1"))
        runAction(actions, actions.authorize("ABCD-EFGH"))
        assertEquals(SummaryProviderChoice.LOBO, flow.state.choice)
        runAction(actions, actions.discover("https://192.168.1.200:7869/v1", false, "", "FMV3-14SR"))
        assertEquals("lobo-nano", flow.state.model)
        assertEquals("FMV3-14SR", requests.last().third!!.getString("lobo_auth"))
        assertNull(actions.begin(actions.save()))
        runAction(actions, actions.test())
        assertFalse(flow.state.canSave)
        assertTrue(flow.setConsent(true))
        runAction(actions, actions.save())
        assertEquals(SummaryProviderScreen.FINISHED, flow.state.screen)
        assertFalse(flow.state.authorized)
        assertTrue(requests.last().third!!.getBoolean("confirm_egress"))
        assertNull(actions.begin(actions.save()))
    }

    @Test
    fun currentLoboEndpointDiscoveryReusesOnlyServerStoredTrust() {
        val flow = SummaryProviderWorkflow()
        val actions = SummaryProviderActions(flow, client())
        runAction(actions, actions.capabilities())
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited("https://192.168.1.200:7869/v1"))
        runAction(actions, actions.authorize("ABCD-EFGH"))
        assertTrue(flow.state.reusesCurrentLobo)
        runAction(actions, actions.discover("https://192.168.1.200:7869/v1", false, "", ""))
        val body = requests.last().third!!
        assertEquals(1, body.length())
        assertTrue(body.getBoolean("use_current"))
        assertFalse(body.has("lobo_auth"))
        assertFalse(flow.state.canSave)
        assertTrue(flow.addressEdited("https://192.168.1.201:7869/v1"))
        val count = requests.size
        val newDevice = actions.discover("https://192.168.1.201:7869/v1", false, "", "")
        assertNotNull(actions.begin(newDevice))
        assertThrows(IllegalArgumentException::class.java) { newDevice.execute() }
        assertEquals(count, requests.size)
    }

    @Test
    fun currentProviderDiscoveryRejectsUnexpectedEndpointAndCannotTestOrSave() {
        val flow = SummaryProviderWorkflow()
        val actions = SummaryProviderActions(flow, client())
        runAction(actions, actions.capabilities())
        runAction(actions, actions.authorize("ABCD-EFGH"))
        discoveryCandidate = JSONObject(configured.toString()).put("base_url", "https://192.168.1.201:7869/v1")
        val action = actions.discover("", false, "", "")
        val ticket = requireNotNull(actions.begin(action))
        val error = assertThrows(IllegalArgumentException::class.java) { action.execute() }
        assertTrue(actions.fail(ticket, error))
        assertFalse(flow.state.canTest)
        assertFalse(flow.state.canSave)
        assertEquals("https://192.168.1.200:7869/v1", flow.state.activeProvider?.baseUrl)
    }

    @Test
    fun rememberedInactiveLoboDiscoveryOmitsAuthButExplicitReverificationSendsIt() {
        val inactive = "https://192.168.1.201:7869/v1"
        configured.put("trusted_lobo_endpoints", JSONArray().put(inactive))
        discoveryCandidate = JSONObject(configured.toString()).put("base_url", inactive)
        val flow = SummaryProviderWorkflow()
        val actions = SummaryProviderActions(flow, client())
        runAction(actions, actions.capabilities())
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited(inactive))
        runAction(actions, actions.authorize("ABCD-EFGH"))
        assertTrue(flow.state.reusesRememberedLobo)
        runAction(actions, actions.discover(inactive, false, "", ""))
        val body = requests.last().third!!
        assertEquals("lobo", body.getString("kind"))
        assertEquals(inactive, body.getString("base_url"))
        assertFalse(body.has("lobo_auth"))
        assertFalse(body.has("use_current"))
        assertFalse(body.getBoolean("allow_http"))
        assertFalse(flow.state.canSave)
        assertTrue(flow.setVerifyLoboAgain(true))
        runAction(actions, actions.discover(inactive, false, "", "FMV3-14SR"))
        assertEquals("FMV3-14SR", requests.last().third!!.getString("lobo_auth"))
        assertFalse(flow.state.canSave)
    }

    @Test
    fun registryMetadataIsStrictAndOlderServersRemainCompatible() {
        assertTrue(SummaryProviderStatus.parse(configured).trustedLoboEndpoints.isEmpty())
        for (bad in listOf("https://8.8.8.8:7869/v1", "http://192.168.1.200:7869/v1",
                "https://192.168.1.200:7869/v1/", "https://user@192.168.1.200:7869/v1")) {
            val value = JSONObject(configured.toString()).put("trusted_lobo_endpoints", JSONArray().put(bad))
            assertThrows(IllegalArgumentException::class.java) { SummaryProviderStatus.parse(value) }
        }
        val duplicate = JSONObject(configured.toString()).put("trusted_lobo_endpoints",
            JSONArray().put("https://192.168.1.200:7869/v1").put("https://192.168.1.200:7869/v1"))
        assertThrows(IllegalArgumentException::class.java) { SummaryProviderStatus.parse(duplicate) }
        val tooMany = JSONArray()
        for (i in 1..17) tooMany.put("https://192.168.1.$i:7869/v1")
        assertThrows(IllegalArgumentException::class.java) {
            SummaryProviderStatus.parse(JSONObject(configured.toString()).put("trusted_lobo_endpoints", tooMany))
        }
    }

    @Test
    fun rememberedDiscoveryCannotAcceptUnpinnedCandidate() {
        val inactive = "https://192.168.1.201:7869/v1"
        configured.put("trusted_lobo_endpoints", JSONArray().put(inactive))
        discoveryCandidate = JSONObject(configured.toString()).put("base_url", inactive).put("custom_ca", false)
        val flow = SummaryProviderWorkflow()
        val actions = SummaryProviderActions(flow, client())
        runAction(actions, actions.capabilities())
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited(inactive))
        runAction(actions, actions.authorize("ABCD-EFGH"))
        val request = actions.discover(inactive, false, "", "")
        val ticket = requireNotNull(actions.begin(request))
        val error = assertThrows(IllegalArgumentException::class.java) { request.execute() }
        assertTrue(actions.fail(ticket, error))
        assertFalse(flow.state.canTest)
        assertFalse(flow.state.canSave)
    }

    @Test
    fun forgetLoboUsesScopedGrantConfirmedExactEndpointAndRejectsStaleAction() {
        val inactive = "https://192.168.1.201:7869/v1"
        val other = "https://192.168.1.202:7869/v1"
        configured.put("trusted_lobo_endpoints", JSONArray().put(inactive).put(other))
        forgetResult = JSONObject(configured.toString()).put("trusted_lobo_endpoints", JSONArray().put(other))
        val flow = SummaryProviderWorkflow()
        val api = client()
        val actions = SummaryProviderActions(flow, api)
        runAction(actions, actions.capabilities())
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited(inactive))
        assertNull(actions.begin(actions.forgetLobo()))
        runAction(actions, actions.authorize("ABCD-EFGH"))
        val stale = actions.forgetLobo()
        assertTrue(flow.addressEdited(other))
        assertNull(actions.begin(stale))
        assertTrue(flow.addressEdited(inactive))
        runAction(actions, actions.forgetLobo())
        val (path, headers, body) = requests.last()
        assertTrue(path.endsWith("/forget-lobo"))
        assertEquals(grant, headers["X-FitBaus-Summary-Admin"])
        assertEquals(inactive, body!!.getString("base_url"))
        assertTrue(body.getBoolean("confirm"))
        assertEquals(2, body.length())
        assertEquals(listOf(other), flow.state.authorization?.trustedLoboEndpoints)
        assertFalse(flow.state.canSave)
    }

    @Test
    fun ambiguousForgetDiscardsGrantAndCannotRetryBlindly() {
        val inactive = "https://192.168.1.201:7869/v1"
        configured.put("trusted_lobo_endpoints", JSONArray().put(inactive))
        val flow = SummaryProviderWorkflow()
        val api = client()
        val actions = SummaryProviderActions(flow, api)
        runAction(actions, actions.capabilities())
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited(inactive))
        runAction(actions, actions.authorize("ABCD-EFGH"))
        runAction(actions, actions.forgetLobo())
        assertEquals(SummaryProviderScreen.RELOAD_REQUIRED, flow.state.screen)
        assertThrows(IllegalArgumentException::class.java) { api.status() }
        assertNull(actions.begin(actions.forgetLobo()))
    }

    @Test
    fun loboAuthNormalizationRejectsPartialAndMisplacedSeparators() {
        assertEquals("FMV3-14SR", SummaryProviderManagement.normalizeLoboAuth("fmv314sr"))
        assertEquals("FMV3-14SR", SummaryProviderManagement.normalizeLoboAuth("fmv3-14sr"))
        for (invalid in listOf("", "FMV3", "F-MV314SR", "FMV3--14SR", "FMV3-14SU")) {
            assertNull(SummaryProviderManagement.normalizeLoboAuth(invalid))
        }
    }

    @Test
    fun expiredGrantAndClosedAuthorizationCompletionClearClientGrant() {
        val api = client()
        val flow = SummaryProviderWorkflow()
        val actions = SummaryProviderActions(flow, api)
        runAction(actions, actions.capabilities())
        runAction(actions, actions.authorize("ABCD-EFGH"))
        val discover = actions.discover("", false, "", "")
        val ticket = requireNotNull(actions.begin(discover))
        failure = BooksHttpResponse(401, """{"error":"summary_admin_unavailable"}""")
        val error = assertThrows(SummaryManagementFailure::class.java) { discover.execute() }
        assertTrue(actions.fail(ticket, error))
        assertTrue(flow.state.canAuthorize)
        assertFalse(flow.state.canSave)
        assertThrows(IllegalArgumentException::class.java) { api.status() }
        failure = null
        val authorize = actions.authorize("ABCD-EFGH")
        val pending = requireNotNull(actions.begin(authorize))
        actions.close()
        val late = authorize.execute()
        assertFalse(actions.complete(authorize, pending, late))
        assertEquals(SummaryProviderScreen.CLOSED, flow.state.screen)
        assertThrows(IllegalArgumentException::class.java) { api.status() }
    }

    @Test
    fun adapterDoesNotAcceptAnOldCompletionForNewOperation() {
        val flow = SummaryProviderWorkflow()
        val actions = SummaryProviderActions(flow, client())
        runAction(actions, actions.capabilities())
        runAction(actions, actions.authorize("ABCD-EFGH"))
        val first = actions.discover("", false, "", "")
        val old = requireNotNull(actions.begin(first))
        val result = first.execute()
        assertTrue(actions.fail(old, IllegalStateException("test")))
        val second = actions.discover("", false, "", "")
        val current = requireNotNull(actions.begin(second))
        assertFalse(actions.complete(first, old, result))
        assertFalse(actions.fail(old, SummaryManagementFailure(401, "summary_admin_unavailable")))
        assertTrue(flow.state.pending === current)
        assertTrue(actions.complete(second, current, second.execute()))
        assertEquals("lobo-nano", flow.state.model)
        assertTrue(flow.state.canTest)
    }

    @Test
    fun staleDiscoveryAndTestActionsCannotExecuteAgainstNewDraft() {
        val flow = SummaryProviderWorkflow()
        val actions = SummaryProviderActions(flow, client())
        runAction(actions, actions.capabilities())
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited("https://192.168.1.200:7869/v1"))
        runAction(actions, actions.authorize("ABCD-EFGH"))
        val stale = actions.discover("https://192.168.1.200:7869/v1", false, "", "")
        assertTrue(flow.addressEdited("https://192.168.1.201:7869/v1"))
        val count = requests.size
        assertNull(actions.begin(stale))
        val mismatched = actions.discover("https://192.168.1.200:7869/v1", false, "", "FMV3-14SR")
        val ticket = requireNotNull(actions.begin(mismatched))
        val error = assertThrows(IllegalArgumentException::class.java) { mismatched.execute() }
        assertTrue(actions.fail(ticket, error))
        assertEquals(count, requests.size)
        assertTrue(flow.addressEdited("https://192.168.1.200:7869/v1"))
        discoveryModels = JSONArray().put("lobo-nano").put("other")
        runAction(actions, actions.discover("https://192.168.1.200:7869/v1", false, "", ""))
        val test = actions.test()
        assertTrue(flow.selectModel("other"))
        assertNull(actions.begin(test))
        assertFalse(flow.state.canSave)
    }

    @Test
    fun firstTimeLoboDiscoveryRequiresMatchingPinnedTlsMetadata() {
        val endpoint = "https://192.168.1.202:7869/v1"
        for (field in listOf("custom_ca", "allow_http", "has_api_key")) {
            val flow = SummaryProviderWorkflow()
            val actions = SummaryProviderActions(flow, client())
            runAction(actions, actions.capabilities())
            assertTrue(flow.choose(SummaryProviderChoice.LOBO))
            assertTrue(flow.addressEdited(endpoint))
            runAction(actions, actions.authorize("ABCD-EFGH"))
            discoveryCandidate = JSONObject(configured.toString()).put("base_url", endpoint)
                .put(field, field != "custom_ca")
            val action = actions.discover(endpoint, false, "", "FMV3-14SR")
            val ticket = requireNotNull(actions.begin(action))
            val error = assertThrows(IllegalArgumentException::class.java) { action.execute() }
            assertTrue(actions.fail(ticket, error))
            assertFalse(flow.state.canTest)
            assertFalse(summaryProviderPresentation(flow.state).candidateDetail.contains("verified ·"))
        }
    }

}
