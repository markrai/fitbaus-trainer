// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe.session

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicReference

/**
 * Operator-driven stage transitions for a single Dynamic Observation USB session.
 *
 * Stage changes never generate USB traffic. Signals are queued from the UI thread
 * or broadcast receiver and consumed on the observation worker thread.
 */
internal enum class StageSignalKind {
    START,
    END,
    FINISH_SESSION,
}

internal data class StageSignal(
    val kind: StageSignalKind,
    val stage: String,
)

internal class StageCoordinator {
    private val queue = ConcurrentLinkedQueue<StageSignal>()
    private val active = AtomicReference<String?>(null)

    fun activeStage(): String? = active.get()

    fun requestStart(stage: String) {
        val name = normalize(stage) ?: return
        queue.offer(StageSignal(StageSignalKind.START, name))
    }

    fun requestEnd() {
        val current = active.get() ?: return
        queue.offer(StageSignal(StageSignalKind.END, current))
    }

    fun requestFinishSession() {
        queue.offer(StageSignal(StageSignalKind.FINISH_SESSION, active.get() ?: "session"))
    }

    fun poll(): StageSignal? = queue.poll()

    fun markActive(stage: String?) {
        active.set(stage)
    }

    companion object {
        fun normalize(raw: String?): String? {
            if (raw == null) return null
            val cleaned = raw.trim().lowercase().replace(' ', '-')
            if (cleaned.isEmpty() || cleaned == "unspecified") return null
            if (!cleaned.matches(Regex("^[a-z0-9][a-z0-9_\\-]{0,63}$"))) return null
            return cleaned
        }
    }
}
