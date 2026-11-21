// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.abs
import kotlin.math.min

internal data class CyclingDailyTotal(
    val date: LocalDate,
    val spinningMs: Long,
    val rpmMs: Long,
) {
    val averageRpm: Double get() = if (spinningMs > 0L) rpmMs.toDouble() / spinningMs else 0.0
    val revolutions: Double get() = rpmMs.toDouble() / 60_000.0

    operator fun plus(other: CyclingDailyTotal): CyclingDailyTotal {
        require(date == other.date)
        return copy(spinningMs = Math.addExact(spinningMs, other.spinningMs), rpmMs = Math.addExact(rpmMs, other.rpmMs))
    }
}

internal data class CyclingAnalyticsSnapshot(val days: Map<LocalDate, CyclingDailyTotal>) {
    val spinningMs: Long get() = days.values.sumOf { it.spinningMs }
    val rpmMs: Long get() = days.values.sumOf { it.rpmMs }
    val revolutions: Double get() = rpmMs.toDouble() / 60_000.0
    val averageRpm: Double get() = if (spinningMs > 0L) rpmMs.toDouble() / spinningMs else 0.0
    val activeDays: Int get() = days.values.count { it.spinningMs > 0L }
    val trackingSince: LocalDate? get() = days.values.filter { it.spinningMs > 0L }.minByOrNull { it.date }?.date

    fun week(monday: LocalDate): List<CyclingDailyTotal> =
        (0L..6L).map { offset ->
            val date = monday.plusDays(offset)
            days[date] ?: CyclingDailyTotal(date, 0L, 0L)
        }
}

internal class CyclingSpinAccumulator(
    private val minimumRpm: Int = 5,
    private val maximumRpm: Int = 250,
    private val maxSampleGapMs: Long = 2_500L,
) {
    private data class Sample(val rpm: Int, val elapsedMs: Long, val wallMs: Long, val zone: ZoneId)
    private var previous: Sample? = null

    fun reset() {
        previous = null
    }

    fun observe(rpm: Int?, elapsedMs: Long, wallMs: Long, zone: ZoneId): List<CyclingDailyTotal> {
        if (rpm == null || rpm !in 0..maximumRpm) {
            reset()
            return emptyList()
        }
        val last = previous
        previous = Sample(rpm, elapsedMs, wallMs, zone)
        if (last == null || last.rpm < minimumRpm || zone != last.zone) return emptyList()
        val interval = elapsedMs - last.elapsedMs
        val wallInterval = wallMs - last.wallMs
        if (interval !in 1..maxSampleGapMs || abs(wallInterval - interval) > maxSampleGapMs) return emptyList()

        val totals = ArrayList<CyclingDailyTotal>(2)
        var cursor = wallMs - interval
        while (cursor < wallMs) {
            val date = Instant.ofEpochMilli(cursor).atZone(zone).toLocalDate()
            val nextMidnight = date.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
            val stop = min(wallMs, nextMidnight)
            if (stop <= cursor) break
            val duration = stop - cursor
            totals.add(CyclingDailyTotal(date, duration, duration * last.rpm))
            cursor = stop
        }
        return totals
    }
}
