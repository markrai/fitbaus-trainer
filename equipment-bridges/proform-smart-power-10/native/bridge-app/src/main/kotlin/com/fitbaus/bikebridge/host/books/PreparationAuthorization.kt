package com.fitbaus.bikebridge.host.books

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

internal class PreparationAuthorization(
    private val current: (TranscriberManagement) -> Boolean,
) {
    private val lock = Any()
    private val jobs = LinkedHashMap<String, TranscriberManagement>()
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private var closed = false

    init {
        worker.scheduleWithFixedDelay(::tick, 30, 30, TimeUnit.SECONDS)
    }

    fun track(api: TranscriberManagement, id: String) = synchronized(lock) {
        if (!closed && (id in jobs || jobs.size < 32)) jobs[id] = api
    }

    fun clear() = synchronized(lock) { jobs.clear() }

    private fun tick() {
        val entries = synchronized(lock) { jobs.toMap() }
        for ((id, api) in entries) {
            fun valid(): Boolean = synchronized(lock) { !closed && jobs[id] === api } && current(api)
            val keep = try {
                if (!valid()) false else api.maintain(id, ::valid)
            } catch (error: BooksHttpFailure) {
                error.status !in setOf(401, 403, 404, 409)
            } catch (_: IllegalArgumentException) {
                false
            } catch (_: Exception) {
                true
            }
            if (!keep) synchronized(lock) {
                if (jobs[id] === api) jobs.remove(id)
            }
        }
    }

    fun close() {
        synchronized(lock) {
            closed = true
            jobs.clear()
        }
        worker.shutdownNow()
    }
}
