// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class GhoulRunWorldTest {
    @Test
    fun sameSeedProducesSameMazeAndDifferentSeedChangesIt() {
        assertEquals(GhoulRunWorld(seed = 42L).signature(), GhoulRunWorld(seed = 42L).signature())
        assertNotEquals(GhoulRunWorld(seed = 42L).signature(), GhoulRunWorld(seed = 43L).signature())
    }

    @Test
    fun everyCellAndObjectiveIsReachable() {
        for (seed in 1L..20L) {
            val world = GhoulRunWorld(seed = seed)
            val reachable = world.distancesFrom(world.start)
            assertEquals(world.config.width * world.config.height, reachable.size, "seed $seed")
            assertTrue(world.exit in reachable)
            assertTrue(world.keys.all { it in reachable })
            assertTrue(world.shrines.all { it in reachable })
            assertEquals(world.config.keyCount, world.keys.distinct().size)
            assertTrue(world.shrines.size in world.config.shrineMin..world.config.shrineMax)
        }
    }

    @Test
    fun monsterSpawnsAreFarEnoughFromStart() {
        for (seed in 1L..20L) {
            val world = GhoulRunWorld(seed = seed)
            val distance = world.distancesFrom(world.start)
            assertEquals(world.config.monsterSpawnCount, world.monsterSpawns.size)
            assertTrue(world.monsterSpawns.all { distance.getValue(it.cell) >= world.config.monsterSpawnMinDistance })
        }
    }

    @Test
    fun fixedProjectionDefinesScreenLeftForEveryHeading() {
        val world = GhoulRunWorld(seed = 7L)
        for (heading in MazeDirection.entries) {
            val left = world.screenTurn(heading, ScreenSide.Left)
            val right = world.screenTurn(heading, ScreenSide.Right)
            assertTrue(left.screenDx < 0, "$heading screen-left was $left")
            assertTrue(right.screenDx > 0, "$heading screen-right was $right")
            assertEquals(setOf(heading.relativeLeft, heading.relativeRight), setOf(left, right))
        }
    }
}
