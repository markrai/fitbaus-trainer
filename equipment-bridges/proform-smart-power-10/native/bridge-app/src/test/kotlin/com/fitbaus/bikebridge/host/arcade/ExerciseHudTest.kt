// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.arcade

import com.fitbaus.bikebridge.host.BridgeUiStateMapper
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ExerciseHudTest {
    @Test
    fun hudFormatsMissingValues() {
        assertEquals(BridgeUiStateMapper.GRID_UNKNOWN, ExerciseHudFormat.UNKNOWN)
        assertEquals(1, ExerciseHudFormat.UNKNOWN.length)
        assertEquals(0x2014, ExerciseHudFormat.UNKNOWN[0].code)
        assertEquals(ExerciseHudFormat.UNKNOWN, ExerciseHudFormat.value(null))
        assertEquals("87", ExerciseHudFormat.value(87))
    }
}
