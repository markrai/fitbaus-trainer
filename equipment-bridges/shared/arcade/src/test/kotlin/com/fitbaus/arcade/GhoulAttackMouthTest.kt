// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.PI
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

internal class GhoulAttackMouthTest {
    private fun target(
        x: Float = 0.7f,
        y: Float = 0f,
        cameraYaw: Float = 0f,
        monsterHeading: MazeDirection = MazeDirection.West,
        state: GhoulState = GhoulState.Hunting,
        visible: Boolean = true,
    ): Float = GhoulAttackMouth.target(
        0f, 0f, cameraYaw, x, y, monsterHeading, state, visible,
    )

    @Test
    fun opensOnlyDuringCloseHeadOnMutualGaze() {
        assertTrue(target() > 0f)
        assertEquals(1f, target(x = 0.45f), 0.0001f)
        assertEquals(0f, target(x = 1.5f))
        assertEquals(0f, target(x = 1f))
        assertEquals(0f, target(x = 0.95f))
        assertEquals(0f, target(x = 0.0f))
        assertEquals(0f, target(x = 1f, y = 1f))
        assertTrue(target(x = 0.85f, y = 0.2f) > 0f)
        assertTrue(target(x = 0.6f) > target(x = 0.8f))
        assertEquals(0.5f, target(x = 0.7f), 0.0001f)
        assertEquals(0.2f, target(x = 0.85f), 0.0001f)
    }

    @Test
    fun lookingAwayOrGhoulFacingAwayPreventsExpression() {
        assertEquals(0f, target(cameraYaw = PI.toFloat() / 2f))
        assertEquals(0f, target(cameraYaw = PI.toFloat()))
        assertEquals(0f, target(monsterHeading = MazeDirection.East))
        assertEquals(0f, target(monsterHeading = MazeDirection.North))
        assertTrue(target(monsterHeading = MazeDirection.West) > 0f)
        assertTrue(target(
            x = 0f, y = 0.7f, cameraYaw = PI.toFloat() / 2f,
            monsterHeading = MazeDirection.North,
        ) > 0f)
    }

    @Test
    fun searchingInspectingWanderingAndStunnedGhoulsNeverOpen() {
        for (state in GhoulState.entries) {
            val expected = if (state == GhoulState.Hunting) target() else 0f
            assertEquals(expected, target(state = state))
        }
        assertEquals(0f, target(visible = false))
        assertEquals(0f, target(cameraYaw = Float.NaN))
    }

    @Test
    fun opensAndClosesSmoothlyWithoutFrameRateDependence() {
        var opening = 0f
        repeat(14) { opening = GhoulAttackMouth.advance(opening, 1f, 0.02f) }
        assertEquals(1f, opening, 0.0001f)
        var closing = opening
        repeat(12) { closing = GhoulAttackMouth.advance(closing, 0f, 0.02f) }
        assertEquals(0f, closing, 0.0001f)
        assertEquals(0.6f, GhoulAttackMouth.advance(0.6f, 1f, 0f))
        assertEquals(0.6f, GhoulAttackMouth.advance(0.6f, 1f, Float.NaN))
        assertEquals(0f, GhoulAttackMouth.advance(-5f, 0f, 0.1f))
        assertEquals(1f, GhoulAttackMouth.advance(10f, 1f, 0.1f))
    }

    @Test
    fun mouthStartsAsTinyCircleAndGrowsAcrossEveryFrame() {
        val startingWidth = GhoulAttackMouth.halfWidth(0f)
        val startingHeight = GhoulAttackMouth.halfHeight(0f)
        assertEquals(startingHeight, startingWidth * GhoulConceptArt.ASPECT, 0.000001f)
        var previousWidth = 0f
        var previousHeight = 0f
        for (step in 0..20) {
            val open = step / 20f
            val width = GhoulAttackMouth.halfWidth(open)
            val height = GhoulAttackMouth.halfHeight(open)
            assertTrue(width > previousWidth)
            assertTrue(height > previousHeight)
            previousWidth = width
            previousHeight = height
        }
        assertEquals(GhoulAttackMouth.OPEN_HALF_WIDTH, previousWidth, 0.000001f)
        assertEquals(GhoulAttackMouth.OPEN_HALF_HEIGHT, previousHeight, 0.000001f)
        assertTrue(previousWidth > startingWidth * 6f)
        assertTrue(previousHeight > startingHeight * 8f)
        val firstFrame = GhoulAttackMouth.advance(0f, 1f, 1f / 60f)
        assertTrue(firstFrame > 0f && firstFrame < 0.1f)
        assertTrue(GhoulAttackMouth.halfWidth(firstFrame) > startingWidth)
        assertTrue(GhoulAttackMouth.halfWidth(firstFrame) < GhoulAttackMouth.halfWidth(0.1f))
    }

    @Test
    fun worldLineOfSightAndGameplayStateGateTheMouth() {
        val game = GhoulRunGame(seed = 54321L)
        game.markLeanCheckPassed()
        game.step(game.config.step, GhoulLane.Center, 0f, 90f, 90f)
        val start = game.world.start
        val direction = game.world.exits(start).first()
        game.placeRider(start, direction)
        val adjacent = start.moved(direction)
        game.forceGhoul(adjacent, direction.opposite, progress = 0.3f, state = GhoulState.Hunting)
        val yaw = GhoulRaycaster.yawOf(direction)
        assertTrue(GhoulAttackMouth.target(game, game.ghoul, yaw) > 0f)

        var blocked: Pair<MazeCell, MazeDirection>? = null
        for (row in 0 until game.config.height) for (col in 0 until game.config.width) {
            val cell = MazeCell(row, col)
            if (blocked != null) continue
            blocked = MazeDirection.entries.firstOrNull {
                game.world.contains(cell.moved(it)) && !game.world.isOpen(cell, it)
            }?.let { cell to it }
        }
        val wall = requireNotNull(blocked)
        game.placeRider(wall.first, wall.second, edgeProgress = 0.3f)
        game.forceGhoul(
            wall.first.moved(wall.second), wall.second.opposite,
            progress = 0.3f, state = GhoulState.Hunting,
        )
        assertTrue(
            GhoulAttackMouth.target(
                game.riderCol, game.riderRow, GhoulRaycaster.yawOf(wall.second),
                game.ghoul.col, game.ghoul.row, game.ghoul.heading, game.ghoul.state, true,
            ) > 0f,
        )
        assertEquals(0f, GhoulAttackMouth.target(game, game.ghoul, GhoulRaycaster.yawOf(wall.second)))
    }

    @Test
    fun independentMonsterPoseResetsWithoutChangingItsGameState() {
        val first = GhoulMonster(MazeCell(0, 0))
        val second = GhoulMonster(MazeCell(1, 1))
        first.mouthOpen = 0.9f
        second.mouthOpen = 0.4f
        first.reset(MazeDirection.East, true)
        assertEquals(0f, first.mouthOpen)
        assertEquals(0.4f, second.mouthOpen)
        val snapshot = GhoulGlSnapshot()
        snapshot.spriteCount = 2
        snapshot.spriteMouth[0] = first.mouthOpen
        snapshot.spriteMouth[1] = second.mouthOpen
        val copied = GhoulGlSnapshot()
        copied.copyFrom(snapshot)
        assertEquals(0f, copied.spriteMouth[0])
        assertEquals(0.4f, copied.spriteMouth[1])
    }
}
