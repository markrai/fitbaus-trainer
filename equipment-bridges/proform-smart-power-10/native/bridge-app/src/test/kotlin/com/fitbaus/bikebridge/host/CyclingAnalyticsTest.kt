// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CyclingAnalyticsTest {
    private val zone = ZoneId.of("America/New_York")
    private val monday = LocalDate.of(2026, 11, 16)
    private val start = LocalDateTime.of(2026, 11, 16, 12, 0).atZone(zone).toInstant().toEpochMilli()

    @Test
    fun spinningTimeAndRevolutionsUseMonotonicSampleIntervals() {
        val tracker = CyclingSpinAccumulator()
        assertTrue(tracker.observe(60, 1_000L, start, zone).isEmpty())
        val first = tracker.observe(60, 2_000L, start + 1_000L, zone).single()
        assertEquals(1_000L, first.spinningMs)
        assertEquals(60_000L, first.rpmMs)
        assertEquals(1.0, first.revolutions, 0.00001)
        val second = tracker.observe(120, 3_000L, start + 2_000L, zone).single()
        assertEquals(60_000L, second.rpmMs)
        val third = tracker.observe(0, 4_000L, start + 3_000L, zone).single()
        assertEquals(120_000L, third.rpmMs)
        assertTrue(tracker.observe(0, 5_000L, start + 4_000L, zone).isEmpty())
        val summary = CyclingAnalyticsSnapshot(
            mapOf(monday to (first + second + third)),
        )
        assertEquals(3_000L, summary.spinningMs)
        assertEquals(80.0, summary.averageRpm, 0.00001)
        assertEquals(4.0, summary.revolutions, 0.00001)
        assertEquals(1, summary.activeDays)
        assertEquals(monday, summary.trackingSince)
    }

    @Test
    fun stationaryAndInvalidReadingsCannotCreatePhantomActivity() {
        val tracker = CyclingSpinAccumulator()
        tracker.observe(0, 1_000L, start, zone)
        assertTrue(tracker.observe(4, 2_000L, start + 1_000L, zone).isEmpty())
        assertTrue(tracker.observe(100, 3_000L, start + 2_000L, zone).isEmpty())
        assertEquals(1_000L, tracker.observe(100, 4_000L, start + 3_000L, zone).single().spinningMs)
        assertTrue(tracker.observe(null, 5_000L, start + 4_000L, zone).isEmpty())
        assertTrue(tracker.observe(100, 6_000L, start + 5_000L, zone).isEmpty())
        assertTrue(tracker.observe(251, 7_000L, start + 6_000L, zone).isEmpty())
        assertTrue(tracker.observe(100, 8_000L, start + 7_000L, zone).isEmpty())
        assertTrue(tracker.observe(-1, 9_000L, start + 8_000L, zone).isEmpty())
    }

    @Test
    fun usbStallsClockEditsAndRestartsCannotOvercountMinutes() {
        val tracker = CyclingSpinAccumulator()
        tracker.observe(90, 1_000L, start, zone)
        assertTrue(tracker.observe(90, 21_000L, start + 20_000L, zone).isEmpty())
        assertEquals(1_000L, tracker.observe(90, 22_000L, start + 21_000L, zone).single().spinningMs)
        assertTrue(tracker.observe(90, 23_000L, start - 10_000L, zone).isEmpty())
        tracker.reset()
        assertTrue(tracker.observe(90, 24_000L, start + 23_000L, zone).isEmpty())
        assertTrue(tracker.observe(90, 24_000L, start + 23_000L, zone).isEmpty())
    }

    @Test
    fun midnightCrossingIsSplitBetweenCorrectLocalCalendarDays() {
        val tracker = CyclingSpinAccumulator()
        val midnight = LocalDate.of(2026, 11, 22).atStartOfDay(zone).toInstant().toEpochMilli()
        tracker.observe(100, 1_000L, midnight - 500L, zone)
        val intervals = tracker.observe(100, 2_000L, midnight + 500L, zone)
        assertEquals(2, intervals.size)
        assertEquals(LocalDate.of(2026, 11, 21), intervals[0].date)
        assertEquals(LocalDate.of(2026, 11, 22), intervals[1].date)
        assertEquals(500L, intervals[0].spinningMs)
        assertEquals(500L, intervals[1].spinningMs)
        assertEquals(100_000L, intervals.sumOf { it.rpmMs })
    }

    @Test
    fun daylightSavingClockChangesDoNotInventAnExtraHour() {
        val tracker = CyclingSpinAccumulator()
        val spring = LocalDateTime.of(2026, 3, 8, 1, 59, 59).atZone(zone).toInstant().toEpochMilli()
        tracker.observe(75, 1_000L, spring, zone)
        val day = tracker.observe(75, 3_000L, spring + 2_000L, zone).single()
        assertEquals(LocalDate.of(2026, 3, 8), day.date)
        assertEquals(2_000L, day.spinningMs)
        val fall = LocalDateTime.of(2026, 11, 1, 1, 59, 59).atZone(zone).toInstant().toEpochMilli()
        tracker.reset()
        tracker.observe(75, 4_000L, fall, zone)
        assertEquals(2_000L, tracker.observe(75, 6_000L, fall + 2_000L, zone).single().spinningMs)
    }

    @Test
    fun weeklyBucketsCoverMondayThroughSundayAndSupportPreviousWeeks() {
        val sunday = monday.plusDays(6)
        val earlier = monday.minusDays(7)
        val next = monday.plusDays(7)
        val history = CyclingAnalyticsSnapshot(
            mapOf(
                earlier to CyclingDailyTotal(earlier, 60_000L, 3_600_000L),
                monday to CyclingDailyTotal(monday, 120_000L, 7_200_000L),
                sunday to CyclingDailyTotal(sunday, 180_000L, 10_800_000L),
                next to CyclingDailyTotal(next, 240_000L, 14_400_000L),
            )
        )
        val week = history.week(monday)
        assertEquals(7, week.size)
        assertEquals(monday, week.first().date)
        assertEquals(sunday, week.last().date)
        assertEquals(0L, week[1].spinningMs)
        assertEquals(300_000L, week.sumOf { it.spinningMs })
        assertEquals(60_000L, history.week(earlier).sumOf { it.spinningMs })
        assertEquals(240_000L, history.week(next).sumOf { it.spinningMs })
        assertEquals(4, history.activeDays)
        assertEquals(earlier, history.trackingSince)
        assertFalse(history.week(monday).any { it.date == next })
    }
}
