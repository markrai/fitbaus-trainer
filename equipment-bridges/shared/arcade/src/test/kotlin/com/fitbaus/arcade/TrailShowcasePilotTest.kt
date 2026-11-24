package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TrailShowcasePilotTest {
    @Test
    fun seededCaptureDodgesHazardsAndJumpsWithoutCrashing() {
        val game = TrailRideGame(TrailShowcasePilot.config, 1001L)
        repeat(17 * 60) {
            TrailShowcasePilot.jumpIfReady(game)
            game.step(game.config.step, TrailShowcasePilot.steer(game), 77f)
        }
        assertEquals(0, game.obstacleHits)
        assertEquals(0, game.crashes)
        assertTrue(game.dodged >= 2)
        assertTrue(game.jumpsCleared >= 1)
    }
}
