// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

internal object GoogleDeviceCodeLifetime {
    fun deadline(receivedAtElapsedMs: Long, expiresInSeconds: Int): Long {
        require(expiresInSeconds in 1..86_400)
        return receivedAtElapsedMs + expiresInSeconds * 1000L
    }

    fun remainingMs(deadlineElapsedMs: Long, nowElapsedMs: Long): Long =
        (deadlineElapsedMs - nowElapsedMs).coerceAtLeast(0L)

    fun isValid(deadlineElapsedMs: Long, nowElapsedMs: Long): Boolean =
        deadlineElapsedMs > nowElapsedMs
}
