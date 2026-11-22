// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class GhoulRunStealthTest {
    private fun activate(game: GhoulRunGame) {
        game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
        game.skipLeanCheck()
        assertEquals(GhoulPhase.Playing, game.phase)
    }

    private fun step(game: GhoulRunGame, rpm: Float = 0f) {
        game.step(game.config.step, GhoulLane.Center, 0f, rpm, 70f)
    }

    private fun run(game: GhoulRunGame, seconds: Float, rpm: Float = 0f) {
        repeat((seconds / game.config.step).toInt()) { step(game, rpm) }
    }

    private fun settledEncounter(seed: Long = 62L): GhoulRunGame {
        val game = GhoulRunGame(seed = seed)
        activate(game)
        val cell = game.world.start
        val direction = game.world.exits(cell).first()
        game.placeRider(cell, direction, 0.95f)
        game.forceGhoul(game.world.monsterSpawn, state = GhoulState.Stunned)
        game.ghoul.stunLeft = 5f
        run(game, game.config.stealthSettleSeconds + 0.4f)
        game.forceGhoul(cell, direction, 0.15f, GhoulState.Searching)
        return game
    }

    @Test
    fun quietRiderGetsAnInspectionAndGhoulTurnsAwayWithoutContact() {
        val game = settledEncounter()
        val initialGap = game.pathGap
        run(game, 0.35f)
        assertEquals(GhoulState.Inspecting, game.ghoul.state)
        assertTrue(game.pathGap < initialGap)
        assertTrue(game.pathGap > game.config.catchDistance)
        assertEquals(GhoulHint.HoldStill, game.hint())
        assertEquals(0, game.catches)
        val row = game.ghoul.row
        val col = game.ghoul.col
        val heading = game.ghoul.heading
        run(game, game.config.stealthInspectSeconds * 0.5f)
        assertEquals(GhoulState.Inspecting, game.ghoul.state)
        assertEquals(row, game.ghoul.row, 0.0001f)
        assertEquals(col, game.ghoul.col, 0.0001f)
        repeat((game.config.stealthInspectSeconds / game.config.step).toInt() + 2) {
            if (game.ghoul.state == GhoulState.Inspecting) step(game)
        }
        assertEquals(GhoulState.Searching, game.ghoul.state)
        assertEquals(heading.opposite, game.ghoul.heading)
        assertEquals(row, game.ghoul.row, 0.0001f)
        assertEquals(col, game.ghoul.col, 0.0001f)
        val nearMissGap = game.pathGap
        run(game, 0.35f)
        assertTrue(game.pathGap > nearMissGap)
        assertEquals(0, game.catches)
        assertEquals(game.config.startingHearts, game.hearts)
        assertNotEquals(GhoulState.Inspecting, game.ghoul.state)
    }

    @Test
    fun pedalingDuringInspectionImmediatelyRestartsTheHunt() {
        val game = settledEncounter()
        run(game, 0.35f)
        assertEquals(GhoulState.Inspecting, game.ghoul.state)
        step(game, rpm = 70f)
        assertEquals(GhoulState.Hunting, game.ghoul.state)
        assertNull(game.ghoul.sparedRiderAt)
        assertFalse(game.ghoul.retreating)
    }

    @Test
    fun pedalingAfterNearMissImmediatelyRestartsTheHunt() {
        val game = settledEncounter()
        run(game, 0.35f)
        repeat((game.config.stealthInspectSeconds / game.config.step).toInt() + 2) {
            if (game.ghoul.state == GhoulState.Inspecting) step(game)
        }
        assertEquals(GhoulState.Searching, game.ghoul.state)
        run(game, 0.2f)
        step(game, rpm = 70f)
        assertEquals(GhoulState.Hunting, game.ghoul.state)
        assertNull(game.ghoul.sparedRiderAt)
    }

    @Test
    fun stoppingAtTheLastMomentDoesNotSaveAnAlreadyTrackedRider() {
        val game = settledEncounter()
        val cell = game.world.start
        val direction = game.world.exits(cell).first()
        game.forceGhoul(cell, direction, 0.49f, GhoulState.Hunting)
        run(game, 0.2f)
        assertEquals(1, game.catches)
        assertEquals(game.config.startingHearts - 1, game.hearts)
        assertNotEquals(GhoulState.Inspecting, game.ghoul.state)
    }

    @Test
    fun anOverlappingCreatureStillCatchesAQuietRider() {
        val game = settledEncounter()
        val cell = game.world.start
        val direction = game.world.exits(cell).first()
        game.forceGhoul(cell, direction, 0.75f, GhoulState.Searching)
        assertTrue(game.pathGap < game.config.catchDistance)
        step(game)
        assertEquals(1, game.catches)
        assertNotEquals(GhoulState.Inspecting, game.ghoul.state)
    }

    @Test
    fun quietPeriodMustFinishBeforeAnUntrackedGhoulCanInspect() {
        val game = GhoulRunGame(seed = 66L)
        activate(game)
        val cell = game.world.start
        val direction = game.world.exits(cell).first()
        game.placeRider(cell, direction, 0.95f)
        game.forceGhoul(cell, direction, 0.15f, GhoulState.Searching)
        step(game)
        assertEquals(GhoulState.Hunting, game.ghoul.state)
        assertNotEquals(GhoulState.Inspecting, game.ghoul.state)
    }

    @Test
    fun previouslySparedQuietRiderDoesNotTriggerAnImmediateSecondInspection() {
        val game = settledEncounter()
        run(game, 0.35f)
        repeat((game.config.stealthInspectSeconds / game.config.step).toInt() + 2) {
            if (game.ghoul.state == GhoulState.Inspecting) step(game)
        }
        assertTrue(game.ghoul.retreating)
        assertEquals(game.world.start.moved(game.heading), game.ghoul.sparedRiderAt)
        run(game, 0.25f)
        assertNotEquals(GhoulState.Inspecting, game.ghoul.state)
        assertEquals(0, game.catches)
    }
}
