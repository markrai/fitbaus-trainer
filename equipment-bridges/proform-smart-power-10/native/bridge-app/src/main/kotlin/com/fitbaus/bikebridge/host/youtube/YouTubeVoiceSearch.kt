// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

internal object YouTubeVoiceSearch {
    fun bestMatch(matches: List<String>?): String? {
        for (match in matches.orEmpty()) {
            val query = match.trim().take(YouTubeSession.MAX_QUERY_LENGTH).trim()
            if (query.isNotEmpty()) return query
        }
        return null
    }
}
