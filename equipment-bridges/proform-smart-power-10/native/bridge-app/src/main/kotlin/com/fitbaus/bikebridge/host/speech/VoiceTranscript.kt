package com.fitbaus.bikebridge.host.speech

import org.json.JSONObject

internal object VoiceTranscript {
    fun fromResult(json: String): String? = runCatching {
        val value = JSONObject(json).opt(VoiceSearchProtocol.TEXT) as? String ?: return@runCatching null
        value.trim().take(VoiceSearchProtocol.MAX_TEXT).trim().takeIf { it.isNotEmpty() }
    }.getOrNull()
}
