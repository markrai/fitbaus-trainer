package com.fitbaus.bikebridge.host.books

internal enum class BooksNarrationModel(val label: String) {
    LARGE_V3("Large-v3 · GPU"),
    SMALL("Small"),
    BASE("Base"),
    TINY("Tiny"),
    LOCAL("Local transcript"),
    UNKNOWN("Model unknown");

    companion object {
        private val cpuProfile = Regex("faster-whisper-[0-9]+\\.[0-9]+\\.[0-9]+-(tiny|base|small)-int8-[0-9a-f]{40}-segments-v1:(auto|[a-z]{2})")
        private val heavyProfile = Regex("faster-whisper-[0-9]+\\.[0-9]+\\.[0-9]+-large-v3-fp16-[0-9a-f]{40}-beam5-segments-v1:(auto|[a-z]{2})")

        fun fromProfile(profile: String?, prepared: Boolean): BooksNarrationModel {
            if (profile == null || profile.length > 256) return UNKNOWN
            if (prepared && heavyProfile.matches(profile)) return LARGE_V3
            return when (cpuProfile.matchEntire(profile)?.groupValues?.get(1)) {
                "tiny" -> TINY
                "base" -> BASE
                "small" -> SMALL
                else -> UNKNOWN
            }
        }
    }
}
