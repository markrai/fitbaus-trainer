package com.fitbaus.bikebridge.host.books

import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.net.URI
import java.util.Locale

internal data class SummaryProviderStatus(
    val configured: Boolean,
    val baseUrl: String?,
    val model: String?,
    val hasKey: Boolean,
    val customCa: Boolean,
    val allowHttp: Boolean,
    val storageError: Boolean,
    val trustedLoboEndpoints: List<String> = emptyList(),
    val loboTofuSupported: Boolean = false,
    val adminRequired: Boolean = true,
    val administrator: Boolean = true,
) {
    fun sameEndpointAndTrust(other: SummaryProviderStatus): Boolean =
        configured && other.configured && !storageError && !other.storageError &&
            baseUrl?.trimEnd('/') == other.baseUrl?.trimEnd('/') &&
            hasKey == other.hasKey && customCa == other.customCa && allowHttp == other.allowHttp

    fun matchesTrustedLobo(endpoint: String?): Boolean {
        if (!configured || storageError || !customCa || hasKey || allowHttp || endpoint == null ||
            baseUrl?.trimEnd('/') != endpoint.trimEnd('/')) return false
        return SummaryProviderManagement.canonicalLoboEndpoint(endpoint) != null
    }

    fun remembersLobo(endpoint: String?): Boolean =
        !storageError && SummaryProviderManagement.canonicalLoboEndpoint(endpoint)?.let { it in trustedLoboEndpoints } == true

    companion object {
        fun parse(json: JSONObject): SummaryProviderStatus {
            val configured = json.opt("configured") as? Boolean ?: error("Invalid provider status")
            val url = json.opt("base_url") as? String
            val model = json.opt("model") as? String
            require(if (configured) url != null && model != null else url == null && model == null)
            if (url != null) SummaryProviderManagement.validateUrl(url)
            if (model != null) require(SummaryProviderManagement.MODEL.matches(model))
            val trusted = if (!json.has("trusted_lobo_endpoints")) emptyList() else {
                val values = json.getJSONArray("trusted_lobo_endpoints")
                require(values.length() <= 16)
                (0 until values.length()).map { index ->
                    val value = values.get(index) as? String ?: error("Invalid remembered LOBO endpoint")
                    require(SummaryProviderManagement.canonicalLoboEndpoint(value) == value)
                    value
                }.also { require(it.distinct().size == it.size) }
            }
            return SummaryProviderStatus(configured, url, model,
                json.opt("has_api_key") == true, json.opt("custom_ca") == true,
                json.opt("allow_http") == true, json.opt("storage_error") == true, trusted, json.opt("lobo_tofu_supported") == true,
                json.opt("admin_required") != false, json.opt("administrator") != false)
        }
    }
}

internal data class SummaryProviderCapabilities(
    val supported: Boolean,
    val model: String?,
    val selection: SummaryProviderStatus? = null,
    val adminRequired: Boolean = true,
)

internal data class SummaryProviderDiscovery(val models: List<String>, val candidate: SummaryProviderStatus)
internal class SummaryManagementFailure(val status: Int, val code: String?) : IOException("Provider management request failed")

internal class SummaryProviderManagement(
    private val connection: TranscriberConnection,
    private val http: TranscriberHttp = TranscriberHttp { url, headers, body ->
        val client = BooksUrlConnectionHttp(readTimeoutMs = 240_000, readErrorBody = true)
        if (body == null) client.getWithHeaders(url, headers) else client.post(url, headers, body)
    },
) {
    @Volatile private var grant: String? = null

    fun capabilities(): Pair<Boolean, String?> = providerCapabilities().let { it.supported to it.model }

    fun providerCapabilities(): SummaryProviderCapabilities {
        val caps = call("/v1/capabilities", admin = false)
        require(caps.getInt("api_version") == 1)
        val supported = caps.opt("summary_provider_management_api") == true
        val model = SummaryProviderCapability.parse(caps.optJSONObject("summary_provider"))?.model
        if (!supported || caps.opt("summary_provider_selection_api") != true)
            return SummaryProviderCapabilities(supported, model)
        val selection = SummaryProviderStatus.parse(caps.getJSONObject("summary_provider_selection"))
        val required = caps.opt("summary_provider_admin_required") as? Boolean ?: error("Invalid administrator policy")
        return SummaryProviderCapabilities(supported, model, selection, required)
    }

    fun openSession(): SummaryProviderStatus = establish("$ROOT/open", JSONObject())

    fun authorize(code: String): SummaryProviderStatus {
        return establish("$ROOT/redeem", JSONObject().put("code", TranscriberConnection.normalizeCode(code)))
    }

    private fun establish(path: String, body: JSONObject): SummaryProviderStatus {
        grant = null
        val result = call(path, body, false)
        val token = result.opt("token") as? String ?: error("Invalid administrator grant")
        require(token.matches(Regex("[A-Za-z0-9_-]{43}")))
        grant = token
        return status()
    }

    fun setAdminRequired(required: Boolean): Boolean {
        val result = call("$ROOT/policy", JSONObject().put("admin_required", required))
        grant = null
        return (result.opt("admin_required") as? Boolean ?: error("Invalid administrator policy")).also {
            require(it == required)
        }
    }

    fun status(): SummaryProviderStatus = SummaryProviderStatus.parse(call("$ROOT/session"))

    fun discoverCurrent(): SummaryProviderDiscovery = discover(JSONObject().put("use_current", true))

    fun discoverNew(kind: String, baseUrl: String, allowHttp: Boolean, key: String, auth: String): SummaryProviderDiscovery {
        require(kind in setOf("ollama", "lobo", "custom"))
        val url = baseUrl.trim().trimEnd('/')
        validateUrl(url)
        require(!url.startsWith("http://") || allowHttp)
        require(key.length <= 2048 && key.all { it.code in 33..126 })
        require(key.isEmpty() || (url.startsWith("https://") && connection.address.startsWith("https://")))
        val body = JSONObject().put("kind", kind).put("base_url", url).put("allow_http", allowHttp)
        if (key.isNotEmpty()) body.put("api_key", key)
        if (kind == "lobo") {
            require(!allowHttp && key.isEmpty() && canonicalLoboEndpoint(url) == url)
            body.put("lobo_auth", requireNotNull(normalizeLoboAuth(auth)))
        }
        return discover(body)
    }

    fun discoverFirstUseLobo(baseUrl: String): SummaryProviderDiscovery {
        val endpoint = requireNotNull(canonicalLoboEndpoint(baseUrl))
        return discover(JSONObject().put("kind", "lobo").put("base_url", endpoint).put("allow_http", false)
            .put("lobo_tofu", true))
    }

    fun discoverRememberedLobo(baseUrl: String): SummaryProviderDiscovery {
        val endpoint = requireNotNull(canonicalLoboEndpoint(baseUrl))
        return discover(JSONObject().put("kind", "lobo").put("base_url", endpoint).put("allow_http", false))
    }

    private fun discover(body: JSONObject): SummaryProviderDiscovery {
        val result = call("$ROOT/discover", body)
        val values = result.getJSONArray("models")
        require(values.length() <= 512)
        val models = (0 until values.length()).map {
            (values.get(it) as? String ?: error("Invalid model")).also { id -> require(MODEL.matches(id)) }
        }
        require(models.distinct().size == models.size)
        val candidate = SummaryProviderStatus.parse(result.getJSONObject("candidate"))
        require(candidate.configured)
        return SummaryProviderDiscovery(models, candidate)
    }

    fun test(model: String): Long {
        require(MODEL.matches(model))
        val result = call("$ROOT/test-candidate", JSONObject().put("model", model))
        require(result.opt("ok") == true && result.opt("model") == model)
        return result.getLong("elapsed_ms").also { require(it >= 0) }
    }

    fun save(): SummaryProviderStatus {
        val result = SummaryProviderStatus.parse(call("$ROOT/save", JSONObject().put("confirm_egress", true)))
        grant = null
        require(result.configured)
        return result
    }

    fun disable(): SummaryProviderStatus {
        val result = SummaryProviderStatus.parse(call("$ROOT/disable", JSONObject().put("confirm", true)))
        grant = null
        require(!result.configured)
        return result
    }

    fun forgetLobo(baseUrl: String): SummaryProviderStatus {
        val endpoint = requireNotNull(canonicalLoboEndpoint(baseUrl))
        return SummaryProviderStatus.parse(call("$ROOT/forget-lobo",
            JSONObject().put("base_url", endpoint).put("confirm", true)))
    }

    fun cancel() {
        try {
            if (grant != null) call("$ROOT/cancel", JSONObject())
        } finally {
            grant = null
        }
    }

    fun forgetGrant() { grant = null }

    private fun call(path: String, body: JSONObject? = null, admin: Boolean = true): JSONObject {
        if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Request cancelled")
        val headers = mutableMapOf("Authorization" to "Bearer ${connection.token}")
        if (admin) headers["X-FitBaus-Summary-Admin"] = requireNotNull(grant)
        val payload = body?.toString()
        require(payload == null || payload.toByteArray(Charsets.UTF_8).size <= 4096)
        val response = http.request(connection.address + path, headers, payload)
        if (response.status !in 200..299) {
            val code = runCatching { JSONObject(response.body).opt("error") as? String }.getOrNull()
                ?.takeIf { it.matches(Regex("[a-z_]{1,80}")) }
            throw SummaryManagementFailure(response.status, code)
        }
        return JSONObject(response.body)
    }

    companion object {
        private const val ROOT = "/v1/admin/summary-provider"
        val MODEL = Regex("[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}")

        fun normalizeLoboAuth(value: String): String? {
            val code = value.trim().uppercase(Locale.US)
            if (!code.matches(Regex("[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}"))) return null
            val raw = code.replace("-", "")
            return raw.take(4) + "-" + raw.drop(4)
        }

        fun canonicalLoboEndpoint(value: String?): String? {
            if (value == null) return null
            val endpoint = value.trim().trimEnd('/')
            val uri = runCatching { URI(endpoint) }.getOrNull() ?: return null
            val host = uri.host ?: return null
            if (!BooksServer.isPrivateIpv4(host) || endpoint != "https://$host:7869/v1") return null
            return endpoint
        }

        fun validateUrl(value: String) {
            val uri = URI(value)
            require(value.length <= 2048 && uri.scheme in setOf("http", "https") && uri.host != null &&
                uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
                (uri.port == -1 || uri.port in 1..65535) && uri.path.trimEnd('/').endsWith("/v1") &&
                uri.path.split('/').none { it == "." || it == ".." })
        }
    }
}
