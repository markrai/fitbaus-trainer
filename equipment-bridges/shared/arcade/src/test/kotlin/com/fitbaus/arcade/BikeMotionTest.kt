// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class BikeMotionTest {
    private val s = 1_000_000_000L
    private val monitor = BikeMotionMonitor()

    @Test
    fun onlyFreshCurrentZeroRpmIsStationary() {
        assertEquals(BikeMotion.Stationary, monitor.update(true, true, 0, true, "t1", 0))
        assertEquals(BikeMotion.Moving, monitor.update(true, true, 42, true, "t2", s))
        assertEquals(BikeMotion.Stationary, monitor.update(true, true, 0, true, "t3", 2 * s))
    }

    @Test
    fun missingOrInvalidTelemetryIsUnknownNotStationary() {
        assertEquals(BikeMotion.Unknown, monitor.update(false, true, 0, true, "a", 0))
        assertEquals(BikeMotion.Unknown, monitor.update(true, false, 0, true, "b", 0))
        assertEquals(BikeMotion.Unknown, monitor.update(true, true, 0, false, "c", 0))
        assertEquals(BikeMotion.Unknown, monitor.update(true, true, null, true, "d", 0))
        assertEquals(BikeMotion.Unknown, monitor.update(true, true, 0, true, null, 0))
        assertEquals(BikeMotion.Unknown, monitor.update(false, false, null, false, null, 0))
    }

    @Test
    fun telemetryThatStopsUpdatingBecomesUnknown() {
        assertEquals(BikeMotion.Stationary, monitor.update(true, true, 0, true, "t1", 0))
        assertEquals(BikeMotion.Stationary, monitor.update(true, true, 0, true, "t1", 3 * s))
        assertEquals(BikeMotion.Unknown, monitor.update(true, true, 0, true, "t1", 3 * s + 1))
        assertEquals(BikeMotion.Stationary, monitor.update(true, true, 0, true, "t2", 4 * s))
    }

    @Test
    fun resetForgetsPreviousTelemetry() {
        monitor.update(true, true, 0, true, "t1", 0)
        monitor.reset()
        assertEquals(BikeMotion.Unknown, monitor.motion)
        assertEquals(BikeMotion.Stationary, monitor.update(true, true, 0, true, "t1", 10 * s))
    }
}
