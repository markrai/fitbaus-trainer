package com.fitbaus.bikebridge.host.books

internal object BooksPlayerPresentation {
    fun recapPanelVisible(fullscreen: Boolean, showing: Boolean): Boolean = fullscreen && showing

    fun status(value: String): String {
        if (value == "Playing" || value == "Paused" || value == "Finished") return ""
        if (value.startsWith("Playing · ") || value.startsWith("Paused · ") || value.startsWith("Finished · ")) {
            return value.substringAfter(" · ")
        }
        return value
    }

    fun summaryUnavailable(paired: Boolean, local: Boolean, verified: Boolean, supported: Boolean): String = when {
        !paired -> "Pair FitBaus Transcriber in Transcription Models and configure its optional LLM summary provider."
        local -> "This narration is local. Summaries require a verified transcript from FitBaus Transcriber."
        !verified -> "Wait for verified remote narration. If it remains unavailable, check the Transcriber connection in Transcription Models."
        !supported -> "The connected Transcriber has not advertised a configured summary provider. Update Transcriber and configure its LLM provider, then reopen the audiobook."
        else -> "A section is not available at the current playback position. Try again while the audiobook is open."
    }
}
