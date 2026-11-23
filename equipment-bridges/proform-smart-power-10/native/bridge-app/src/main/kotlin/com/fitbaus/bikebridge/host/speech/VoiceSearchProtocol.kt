package com.fitbaus.bikebridge.host.speech

internal object VoiceSearchProtocol {
    const val START = 1
    const val CANCEL = 2
    const val STATUS = 3
    const val RESULT = 4
    const val ERROR = 5
    const val TEXT = "text"
    const val SAMPLE_RATE = 16_000f
    const val LISTEN_MS = 9_000
    const val INIT_TIMEOUT_MS = 75_000L
    const val MAX_TEXT = 200
}
