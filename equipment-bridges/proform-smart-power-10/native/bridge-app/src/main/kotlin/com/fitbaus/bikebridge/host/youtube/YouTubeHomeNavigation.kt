// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

internal object YouTubeHomeNavigation {
    fun shouldReload(wasConnected: Boolean?, connected: Boolean, browse: BrowseState): Boolean {
        val expectedTitle = if (connected) "From your channels" else "Trending"
        return wasConnected != connected || browse.query != null || browse.feedTitle != expectedTitle
    }
}
