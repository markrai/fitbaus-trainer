package com.fitbaus.bikebridge.host.books

import org.json.JSONObject
import java.io.IOException
import java.net.URI

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
        require(!configured || source.matches(Regex("[A-Za-z0-9_-]{1,128}")))
        val window = json.getInt("max_window_ms")
        require(window in 1..300_000)
        return TranscriberCapabilities(if (configured) source else null,
            json.getBoolean("transcription") && json.getBoolean("engine_ready") && configured, window)
    }

    companion object {
        fun fromFields(protocol: String, host: String, port: String, token: String): TranscriberConnection {
            return TranscriberConnection(BooksServer.address(protocol, host, port, false), token.trim())
        }
    }
}

internal data class TranscriberCapabilities(val sourceId: String?, val ready: Boolean, val maxWindowMs: Int)
