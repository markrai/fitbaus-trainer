// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class GhoulRunWorldTest {
    @Test
    fun defaultsMatchTheSimplifiedMaze() {
        val config = GhoulRunConfig()
        assertEquals(11, config.width)
        assertEquals(11, config.height)
        assertEquals(0.25f, config.extraWallRemoval)
        assertEquals(0, config.keyCount)
        GhoulRunConfig(keyCount = 0)
    }

    @Test
    fun sameSeedProducesSameMazeAndDifferentSeedChangesIt() {
        assertEquals(GhoulRunWorld(seed = 42L).signature(), GhoulRunWorld(seed = 42L).signature())
        assertNotEquals(GhoulRunWorld(seed = 42L).signature(), GhoulRunWorld(seed = 43L).signature())
    }

    @Test
    fun everyCellAndObjectiveIsReachableAndExitIsFarthest() {
        for (seed in 1L..20L) {
            val world = GhoulRunWorld(seed = seed)
            val reachable = world.distancesFrom(world.start)
            assertEquals(world.config.width * world.config.height, reachable.size, "seed $seed")
            assertEquals(reachable.values.max(), reachable.getValue(world.exit), "seed $seed")
            assertTrue(world.keys.all { it in reachable })
            assertTrue(world.shrines.all { it in reachable })
            assertEquals(world.config.keyCount, world.keys.distinct().size)
            assertTrue(world.shrines.size in world.config.shrineMin..world.config.shrineMax)
            assertTrue(reachable.getValue(world.monsterSpawn) >= world.config.monsterSpawnMinDistance)
        }
    }

    @Test
    fun relativeTurnsAreTheRidersOwnLeftAndRight() {
        assertEquals(MazeDirection.West, MazeDirection.North.relativeLeft)
        assertEquals(MazeDirection.East, MazeDirection.North.relativeRight)
        assertEquals(MazeDirection.North, MazeDirection.East.relativeLeft)
        assertEquals(MazeDirection.South, MazeDirection.East.relativeRight)
        assertEquals(MazeDirection.East, MazeDirection.South.relativeLeft)
        assertEquals(MazeDirection.West, MazeDirection.South.relativeRight)
        assertEquals(MazeDirection.South, MazeDirection.West.relativeLeft)
        assertEquals(MazeDirection.North, MazeDirection.West.relativeRight)
    }

    @Test
    fun expandedTileGridMakesOpeningsFloorAndWallsSolid() {
        val world = GhoulRunWorld(seed = 8L)
        assertEquals(23, world.tileRows)
        assertEquals(23, world.tileCols)
        assertTrue(world.isFloorTile(MazeTile(1, 1)))
        assertFalse(world.isFloorTile(MazeTile(0, 0)))
        for (row in 0 until world.config.height) for (col in 0 until world.config.width) {
            val cell = MazeCell(row, col)
            for (direction in listOf(MazeDirection.East, MazeDirection.South)) {
                if (!world.contains(cell.moved(direction))) continue
                val gap = MazeTile(2 * row + 1 + direction.dr, 2 * col + 1 + direction.dc)
                assertEquals(world.isOpen(cell, direction), world.isFloorTile(gap), "$cell $direction")
            }
        }
    }
}
