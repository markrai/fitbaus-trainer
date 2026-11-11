// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.arcade

import com.fitbaus.arcade.ArcadeStopReason

internal class RecordingHooks(private val events: MutableList<String> = ArrayList()) : ArcadeModeHooks {
    var onActivate: () -> Unit = {}
    var onDeactivate: (ArcadeStopReason) -> Unit = {}

    fun events(): List<String> = events.toList()

    fun clear() = events.clear()

    override fun showMode(mode: ArcadeMode) {
        events += "show:$mode"
    }

    override fun activateArcade(game: ArcadeMode) {
        events += "activate:$game"
        onActivate()
    }

    override fun deactivateArcade(reason: ArcadeStopReason) {
        events += "deactivate:$reason"
        onDeactivate(reason)
    }
}
