// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Log
import java.time.LocalDate
import java.time.ZoneId
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

internal class CyclingAnalyticsDatabase(context: Context) :
    SQLiteOpenHelper(context.applicationContext, "fitbaus-cycling-analytics.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE cycling_daily (" +
                "day TEXT PRIMARY KEY NOT NULL, " +
                "spinning_ms INTEGER NOT NULL, " +
                "rpm_ms INTEGER NOT NULL)"
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        error("Unsupported cycling analytics schema migration $oldVersion to $newVersion")
    }

    fun add(totals: Collection<CyclingDailyTotal>) {
        if (totals.isEmpty()) return
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (total in totals) {
                db.execSQL(
                    "INSERT OR IGNORE INTO cycling_daily (day, spinning_ms, rpm_ms) VALUES (?, 0, 0)",
                    arrayOf(total.date.toString()),
                )
                db.execSQL(
                    "UPDATE cycling_daily SET spinning_ms = spinning_ms + ?, rpm_ms = rpm_ms + ? WHERE day = ?",
                    arrayOf<Any>(total.spinningMs, total.rpmMs, total.date.toString()),
                )
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun read(): CyclingAnalyticsSnapshot {
        val data = LinkedHashMap<LocalDate, CyclingDailyTotal>()
        readableDatabase.rawQuery(
            "SELECT day, spinning_ms, rpm_ms FROM cycling_daily ORDER BY day",
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val date = LocalDate.parse(cursor.getString(0))
                data[date] = CyclingDailyTotal(date, cursor.getLong(1), cursor.getLong(2))
            }
        }
        return CyclingAnalyticsSnapshot(data)
    }
}

internal class CyclingAnalyticsStore(context: Context) {
    private val database = CyclingAnalyticsDatabase(context)
    private val accumulator = CyclingSpinAccumulator()
    private val lock = Any()
    private val pending = LinkedHashMap<LocalDate, CyclingDailyTotal>()
    private var flushScheduled = false
    private val worker = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "fitbaus-cycling-analytics").apply {
            isDaemon = true
            priority = Thread.MIN_PRIORITY
        }
    }

    fun observe(rpm: Int?, elapsedMs: Long, wallMs: Long) {
        synchronized(lock) {
            val increments = accumulator.observe(rpm, elapsedMs, wallMs, ZoneId.systemDefault())
            for (total in increments) {
                pending[total.date] = pending[total.date]?.plus(total) ?: total
            }
            if (increments.isNotEmpty()) scheduleFlushLocked()
        }
    }

    fun breakContinuity() {
        synchronized(lock) { accumulator.reset() }
    }

    fun flushAsync() {
        worker.execute { flushPending() }
    }

    fun readSnapshot(onResult: (Result<CyclingAnalyticsSnapshot>) -> Unit) {
        worker.execute {
            flushPending()
            onResult(runCatching { database.read() })
        }
    }

    private fun scheduleFlushLocked() {
        if (flushScheduled) return
        flushScheduled = true
        worker.schedule({ flushPending() }, 30L, TimeUnit.SECONDS)
    }

    private fun flushPending() {
        val batch = synchronized(lock) {
            flushScheduled = false
            val items = pending.values.toList()
            pending.clear()
            items
        }
        if (batch.isEmpty()) return
        try {
            database.add(batch)
        } catch (ex: Exception) {
            Log.e(HostConstants.LOG_TAG, "cycling analytics persistence failed", ex)
            synchronized(lock) {
                for (total in batch) pending[total.date] = pending[total.date]?.plus(total) ?: total
                scheduleFlushLocked()
            }
            return
        }
        synchronized(lock) {
            if (pending.isNotEmpty()) scheduleFlushLocked()
        }
    }
}
