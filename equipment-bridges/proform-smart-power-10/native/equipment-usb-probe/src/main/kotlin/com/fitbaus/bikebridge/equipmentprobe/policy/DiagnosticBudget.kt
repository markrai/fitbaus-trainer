// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe.policy

internal class DiagnosticBudget(private val limit: Int) {
    private var used: Int = 0

    val remaining: Int get() = (limit - used).coerceAtLeast(0)

    val exhausted: Boolean get() = used >= limit

    fun tryConsume(): Boolean {
        if (exhausted) return false
        used += 1
        return true
    }

    fun usedCount(): Int = used
}
