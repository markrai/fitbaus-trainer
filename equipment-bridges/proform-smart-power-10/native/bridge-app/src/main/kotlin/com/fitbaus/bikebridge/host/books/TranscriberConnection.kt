package com.fitbaus.bikebridge.host.books

import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.util.Locale

internal class TranscriberConnection(val address: String, val token: String) {
    init {
        val uri = URI(address)
        BooksServer.requireTransport(uri)
        require(uri.rawPath.orEmpty().isEmpty() && uri.rawQuery == null)
        require(token.length in 32..256 && token.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' || it == '_' })
    }

    fun test(http: BooksHttp = BooksUrlConnectionHttp()): TranscriberCapabilities {
        val response = http.get("$address/v1/capabilities", token)
        if (response.status == 401) throw IOException("Transcriber token rejected")
        if (response.status !in 200..299) throw IOException("Transcriber HTTP ${response.status}")
        val json = JSONObject(response.body)
        require(json.getInt("api_version") == 1 && json.getString("transcript_schema") == "fitbaus.transcript/v1")
        require(json.getBoolean("job_api"))
        val source = json.optString("source_id", "")
        val configured = json.getBoolean("source_configured")
        require(!configured || BooksIdentifier.isValid(source))
        val window = json.getInt("max_window_ms")
        require(window in 1..300_000)
        return TranscriberCapabilities(if (configured) source else null,
            json.getBoolean("transcription") && json.getBoolean("engine_ready") && configured, window,
            json.optString("source_url", "").takeIf { it.isNotBlank() && !json.isNull("source_url") },
            SummaryProviderCapability.parse(json.optJSONObject("summary_provider")), json.opt("summary_api") == true,
            json.opt("section_plan_api") == true, json.opt("recap_api") == true,
            cumulativeRecapLimit(json), diagramSupported(json), json.opt("summary_concept_api") == true,
            json.opt("concept_elaboration_api") == true)
    }

    companion object {
        const val MAX_CUMULATIVE_RECAP_MS = 86_400_000L

        private fun diagramSupported(json: JSONObject): Boolean {
            if (json.opt("summary_diagram_api") != true) return false
            val formats = json.optJSONArray("summary_diagram_formats") ?: return false
            return formats.length() in 1..16 && (0 until formats.length()).all { formats.opt(it) is String } &&
                (0 until formats.length()).any { formats.opt(it) == "flowchart" }
        }

        private fun cumulativeRecapLimit(json: JSONObject): Long? {
            if (json.opt("cumulative_recap_api") != true) return null
            val limit = json.opt("cumulative_recap_max_position_ms")
            if (limit !is Int && limit !is Long) return null
            return (limit as Number).toLong().takeIf { it in 1..MAX_CUMULATIVE_RECAP_MS }
        }

        fun normalizeCode(value: String): String {
            val code = value.trim().uppercase(Locale.US)
            require(code.matches(Regex("[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}")))
            val raw = code.replace("-", "")
            return raw.take(4) + "-" + raw.drop(4)
        }

        fun pair(address: String, code: String, http: BooksAuthHttp = BooksUrlConnectionHttp()): TranscriberConnection {
            val uri = URI(address)
            BooksServer.requireTransport(uri)
            require(uri.rawPath.orEmpty().isEmpty() && uri.rawQuery == null)
            val payload = JSONObject().put("code", normalizeCode(code)).toString()
            val response = http.post("$address/v1/pairing/redeem", emptyMap(), payload)
            if (response.status == 401) throw IOException("Invalid or expired pairing code")
            if (response.status !in 200..299) throw IOException("Pairing HTTP ${response.status}")
            val token = JSONObject(response.body).getString("token")
            require(token.matches(Regex("[A-Za-z0-9_-]{43}")))
            return TranscriberConnection(address, token)
        }

        fun fromFields(protocol: String, host: String, port: String, token: String): TranscriberConnection {
            return TranscriberConnection(BooksServer.address(protocol, host, port, false), token.trim())
        }
    }
}

internal data class TranscriberCapabilities(
    val sourceId: String?,
    val ready: Boolean,
    val maxWindowMs: Int,
    val sourceUrl: String? = null,
    val summaryProvider: SummaryProviderCapability? = null,
    val summaryApi: Boolean = false,
    val sectionPlanApi: Boolean = false,
    val recapApi: Boolean = false,
    val cumulativeRecapMaxPositionMs: Long? = null,
    val summaryDiagramApi: Boolean = false,
    val summaryConceptApi: Boolean = false,
    val conceptElaborationApi: Boolean = false,
)

internal data class SummaryProviderCapability(val model: String) {
    companion object {
        private val modelPattern = Regex("[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}")

        fun parse(json: JSONObject?): SummaryProviderCapability? {
            if (json == null || json.opt("configured") != true || json.opt("protocol") != "openai-chat/v1") return null
            val model = json.opt("model") as? String ?: return null
            if (!modelPattern.matches(model)) return null
            return SummaryProviderCapability(model)
        }
    }
}
