// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class GoogleAccountSubscriptionsGridTest {
    private val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/GoogleAccountView.kt")
        .readText()

    @Test
    fun subscriptionsUseAFiveColumnGrid() {
        assertTrue(source.contains("private val list = GridView(context)"))
        assertTrue(source.contains("list.numColumns = if (subscriptionsGrid) SUBSCRIPTION_COLUMNS else 1"))
        assertTrue(source.contains("const val SUBSCRIPTION_COLUMNS = 5"))
    }

    @Test
    fun subscriptionCardsRenderChannelArtworkAndNames() {
        assertTrue(source.contains("private inner class ChannelCard"))
        assertTrue(source.contains("name.text = entry.title"))
        assertTrue(source.contains("loader.bind(avatar, thumbnailUrl)"))
        assertTrue(source.contains("loader.clear(avatar)"))
    }
}
