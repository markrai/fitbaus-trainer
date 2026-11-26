package com.fitbaus.bikebridge.host.books

internal data class ReadAlongWindowRequest(val startMs: Long, val retry: Boolean)

internal class ReadAlongWindowBuffer {
    private val windows = mutableMapOf<Long, RemoteBooksWindow>()
    private val failures = mutableMapOf<Long, Boolean>()
    var pendingStart: Long? = null
        private set
    var revision: String? = null
        private set
    var diagramAvailable = false
        private set
    var summaryAvailable = false
        private set
    var sectionPlanAvailable = false
        private set
    var recapAvailable = false
        private set
    var cumulativeRecapMaxPositionMs: Long? = null
        private set

    fun current(positionMs: Long, durationMs: Long): RemoteBooksWindow? =
        windows[RemoteBooksTranscript.windowStart(positionMs, durationMs)]

    fun sectionTranscript(section: BooksSection): BooksSectionTranscript =
        BooksSectionResolver.remote(section, windows, revision)

    fun failed(positionMs: Long, durationMs: Long): Boolean =
        failures[RemoteBooksTranscript.windowStart(positionMs, durationMs)] == true

    fun plan(positionMs: Long, durationMs: Long, wantsPlay: Boolean): ReadAlongWindowRequest? {
        val current = RemoteBooksTranscript.windowStart(positionMs, durationMs)
        retain(current)
        if (!windows.containsKey(current)) {
            if (pendingStart == current || failures[current] == true) return null
            return ReadAlongWindowRequest(current, failures.containsKey(current))
        }
        val next = current + RemoteBooksTranscript.WINDOW_MS
        if (!wantsPlay || next >= durationMs || pendingStart != null ||
            windows.containsKey(next) || failures.containsKey(next)) return null
        return ReadAlongWindowRequest(next, false)
    }

    fun begin(request: ReadAlongWindowRequest) {
        pendingStart = request.startMs
    }

    fun complete(window: RemoteBooksWindow, positionMs: Long, durationMs: Long) {
        require(pendingStart == window.startMs)
        require(revision == null || revision == window.revision)
        revision = window.revision
        summaryAvailable = window.summaryAvailable
        diagramAvailable = window.diagramAvailable
        sectionPlanAvailable = window.sectionPlanAvailable
        recapAvailable = window.recapAvailable
        cumulativeRecapMaxPositionMs = window.cumulativeRecapMaxPositionMs
        pendingStart = null
        windows[window.startMs] = window
        failures.remove(window.startMs)
        retain(RemoteBooksTranscript.windowStart(positionMs, durationMs))
    }

    fun fail(positionMs: Long, durationMs: Long) {
        val start = pendingStart ?: return
        val current = RemoteBooksTranscript.windowStart(positionMs, durationMs)
        pendingStart = null
        failures[start] = start == current
        retain(current)
    }

    fun reload(positionMs: Long, durationMs: Long): ReadAlongWindowRequest {
        val start = RemoteBooksTranscript.windowStart(positionMs, durationMs)
        pendingStart = null
        windows.remove(start)
        failures.remove(start)
        retain(start)
        return ReadAlongWindowRequest(start, true)
    }

    fun clear() {
        windows.clear()
        failures.clear()
        pendingStart = null
        revision = null
        summaryAvailable = false
        diagramAvailable = false
        sectionPlanAvailable = false
        recapAvailable = false
        cumulativeRecapMaxPositionMs = null
    }

    private fun retain(current: Long) {
        val span = RemoteBooksTranscript.WINDOW_MS
        val keep = setOf(current - span, current, current + span)
        windows.keys.retainAll(keep)
        failures.keys.retainAll(keep)
    }
}
