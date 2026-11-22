// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

internal class GhoulRunLevelsTest {
    private fun playing(game: GhoulRunGame) {
        game.markLeanCheckPassed()
        game.step(1f / 60f, GhoulLane.Center, 0f, 90f, 90f)
        assertEquals(GhoulPhase.Playing, game.phase)
    }

    private fun escape(game: GhoulRunGame) {
        playing(game)
        game.visitForTest(game.world.exit)
        assertEquals(GhoulPhase.Results, game.phase)
        game.step(game.config.resultsSeconds + 0.1f, GhoulLane.Center, 0f, 90f, 90f)
        assertEquals(GhoulPhase.Countdown, game.phase)
        game.step(game.config.restartCountdownSeconds + 0.1f, GhoulLane.Center, 0f, 90f, 90f)
        assertEquals(GhoulPhase.WarmUp, game.phase)
    }

    @Test
    fun eachCompletedMazeAddsExactlyOneGhoulWithoutRecalibration() {
        val game = GhoulRunGame(seed = 4321L)
        assertEquals(1, game.level)
        assertEquals(1, game.ghouls.size)
        assertEquals(game.world.monsterSpawn, game.ghoul.spawn)
        for (next in 2..6) {
            escape(game)
            assertEquals(next, game.level)
            assertEquals(next, game.ghouls.size)
            assertEquals(next, game.ghouls.map { it.spawn }.distinct().size)
            assertTrue(game.ghouls.all { it.state == GhoulState.Inactive })
            assertTrue(game.leanCheckPassed)
        }
        playing(game)
        assertTrue(game.ghouls.all { it.state == GhoulState.Wandering })
    }

    @Test
    fun aManualRestartResetsToOneGhoul() {
        val game = GhoulRunGame(seed = 129L)
        escape(game)
        assertEquals(2, game.ghouls.size)
        game.restart(913L)
        assertEquals(1, game.level)
        assertEquals(1, game.ghouls.size)
        assertEquals(game.world.monsterSpawn, game.ghoul.spawn)
    }

    @Test
    fun spawnsAreDeterministicAndKeepAwayFromRiderAndObjectives() {
        val a = GhoulRunWorld(seed = 515L)
        val b = GhoulRunWorld(seed = 515L)
        val first = a.monsterSpawns(8)
        assertEquals(first, b.monsterSpawns(8))
        assertEquals(8, first.distinct().size)
        assertEquals(a.monsterSpawn, first.first())
        for (cell in first) {
            assertNotEquals(a.start, cell)
            assertNotEquals(a.exit, cell)
            assertFalse(cell in a.keys)
            assertFalse(cell in a.shrines)
        }
        assertEquals(listOf(a.monsterSpawn), a.monsterSpawns(1))
    }

    @Test
    fun eachGhoulHasIndependentStunAndWanderState() {
        val game = GhoulRunGame(seed = 77L)
        escape(game)
        playing(game)
        val second = game.ghouls[1]
        game.forceGhoul(second.spawn, state = GhoulState.Stunned, index = 1)
        second.stunLeft = 2f
        assertEquals(GhoulState.Wandering, game.ghoul.state)
        game.step(0.1f, GhoulLane.Center, 0f, 0f, 90f)
        assertEquals(GhoulState.Stunned, second.state)
        assertTrue(second.stunLeft in 1.8f..2f)
        assertNotEquals(GhoulState.Stunned, game.ghoul.state)
    }

    @Test
    fun shrineStunsOnlyCreaturesInsideItsRadius() {
        val game = GhoulRunGame(seed = 812L)
        escape(game)
        playing(game)
        val shrine = game.world.shrines.first()
        val heading = game.world.exits(shrine).first()
        game.placeRider(shrine, heading)
        game.forceGhoul(shrine, heading, state = GhoulState.Wandering, index = 0)
        val distant = game.world.distancesFrom(shrine).maxByOrNull { it.value }!!.key
        assertTrue(game.world.pathDistance(shrine, distant)!! > game.config.shrinePulseRadius)
        game.forceGhoul(distant, game.world.exits(distant).first(), state = GhoulState.Wandering, index = 1)
        game.visitForTest(shrine)
        assertEquals(GhoulState.Stunned, game.ghouls[0].state)
        assertEquals(GhoulState.Wandering, game.ghouls[1].state)
    }

    @Test
    fun simultaneousContactCostsOnlyOneHeartAndStunsTheCatchingGhoul() {
        val game = GhoulRunGame(seed = 19L)
        escape(game)
        playing(game)
        val heading = game.world.exits(game.world.start).first()
        game.placeRider(game.world.start, heading)
        game.forceGhoul(game.world.start, heading, state = GhoulState.Hunting, index = 0)
        game.forceGhoul(game.world.start, heading, state = GhoulState.Hunting, index = 1)
        game.step(0.02f, GhoulLane.Center, 0f, 0f, 90f)
        assertEquals(game.config.startingHearts - 1, game.hearts)
        assertEquals(1, game.catches)
        assertEquals(1, game.ghouls.count { it.state == GhoulState.Stunned })
        game.step(0.02f, GhoulLane.Center, 0f, 0f, 90f)
        assertEquals(1, game.catches)
    }
}
