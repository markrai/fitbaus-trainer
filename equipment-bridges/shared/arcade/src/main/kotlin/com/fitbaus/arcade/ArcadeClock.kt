// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.os.Handler
import android.os.SystemClock

/** ~30 FPS UI loop, independent of the 200 ms dashboard telemetry refresh. */
public class ArcadeClock(
    private val handler: Handler,
    private val intervalMs: Long = FRAME_MS,
    private val onTick: () -> Unit,
) {
    private var running = false
    private var nextAt = 0L

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            onTick()
            if (!running) return
            val now = SystemClock.uptimeMillis()
            nextAt += intervalMs
            if (nextAt <= now) nextAt = now + intervalMs
            handler.postAtTime(this, nextAt)
        }
    }

    public fun start() {
        if (running) return
        running = true
        nextAt = SystemClock.uptimeMillis()
        handler.post(tick)
    }

    public fun stop() {
        running = false
        handler.removeCallbacks(tick)
    }

    public companion object {
        public const val FRAME_MS: Long = 33L
    }
}
