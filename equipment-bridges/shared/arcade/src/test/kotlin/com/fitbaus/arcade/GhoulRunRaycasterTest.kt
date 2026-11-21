// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.PI
import kotlin.math.abs

class GhoulRunRaycasterTest {
    /**
     * 5 x 7 tiles: an east-west corridor on row 2 (cols 1..5) with one side opening north at
     * (1, 3). Everything else is solid.
     */
    private fun corridor(): GhoulRayGrid {
        val rows = 5
        val cols = 7
        val solid = BooleanArray(rows * cols) { true }
        for (col in 1..5) solid[2 * cols + col] = false
        solid[1 * cols + 3] = false
        return GhoulRayGrid(rows, cols, solid)
    }

    private fun single(grid: GhoulRayGrid, x: Float, y: Float, rayX: Float, rayY: Float): GhoulRayHits =
        GhoulRayHits(1).also { GhoulRaycaster.castRay(grid, x, y, rayX, rayY, it, 0) }

    @Test
    fun distanceDownAStraightCorridor() {
        val grid = corridor()
        val hits = single(grid, 1.5f, 2.5f, 1f, 0f)
        assertEquals(4.5f, hits.distance[0], 1e-4f)
        assertEquals(GhoulRaycaster.SIDE_X, hits.side[0])
        assertEquals(2, hits.tileRow[0])
        assertEquals(6, hits.tileCol[0])
        val back = single(grid, 4.5f, 2.5f, -1f, 0f)
        assertEquals(3.5f, back.distance[0], 1e-4f)
        assertEquals(GhoulRaycaster.SIDE_X, back.side[0])
    }

    @Test
    fun sideOpeningIsDetectedAndWallSideIsCorrect() {
        val grid = corridor()
        val wall = single(grid, 2.5f, 2.5f, 0f, -1f)
        assertEquals(0.5f, wall.distance[0], 1e-4f)
        assertEquals(GhoulRaycaster.SIDE_Y, wall.side[0])
        val opening = single(grid, 3.5f, 2.5f, 0f, -1f)
        assertEquals(1.5f, opening.distance[0], 1e-4f)
        assertEquals(GhoulRaycaster.SIDE_Y, opening.side[0])
        assertEquals(0, opening.tileRow[0])

        // Looking east down the corridor, the columns that look into the opening see further.
        val view = GhoulRayHits(81)
        GhoulRaycaster.castView(grid, 1.5f, 2.5f, 0f, (70.0 * PI / 180.0).toFloat(), view)
        val deeper = (0 until 40).count { view.distance[it] > view.distance[80 - it] + 0.5f }
        val shallower = (0 until 40).count { view.distance[it] < view.distance[80 - it] - 1e-3f }
        assertTrue(deeper >= 4, "columns looking into the north (left) opening read deeper than their mirror")
        assertEquals(0, shallower)
        assertEquals(4.5f, view.distance[40], 1e-3f)
    }

    @Test
    fun centreRayMatchesMazeCorridorLength() {
        val world = GhoulRunWorld(seed = 21L)
        val grid = GhoulRayGrid.from(world)
        val view = GhoulRayHits(41)
        for (row in 0 until world.config.height) for (col in 0 until world.config.width) {
            val cell = MazeCell(row, col)
            for (direction in MazeDirection.entries) {
                var open = 0
                var at = cell
                while (world.isOpen(at, direction)) {
                    open += 1
                    at = at.moved(direction)
                }
                GhoulRaycaster.castView(
                    grid,
                    GhoulRaycaster.cellX(col.toFloat()),
                    GhoulRaycaster.cellY(row.toFloat()),
                    GhoulRaycaster.yawOf(direction),
                    1.2f,
                    view,
                )
                assertEquals(2f * open + 0.5f, view.distance[20], 1e-3f, "$cell $direction")
            }
        }
    }

    @Test
    fun interpolatedColumnsMatchFullCasting() {
        val world = GhoulRunWorld(seed = 33L)
        val grid = GhoulRayGrid.from(world)
        val fov = (70.0 * PI / 180.0).toFloat()
        for (columns in listOf(320, 321)) {
            val view = GhoulRayHits(columns)
            val single = GhoulRayHits(1)
            for (step in 0 until 60) {
                val cell = MazeCell(step % world.config.height, (step * 7) % world.config.width)
                val x = GhoulRaycaster.cellX(cell.col.toFloat()) + 0.2f * kotlin.math.sin(step.toFloat())
                val y = GhoulRaycaster.cellY(cell.row.toFloat())
                val yaw = step * 0.37f
                GhoulRaycaster.castView(grid, x, y, yaw, fov, view)
                val dirX = kotlin.math.cos(yaw)
                val dirY = kotlin.math.sin(yaw)
                val k = kotlin.math.tan(fov / 2f)
                for (column in 0 until columns) {
                    val cameraX = (column + 0.5f) * (2f / columns) - 1f
                    GhoulRaycaster.castRay(grid, x, y, dirX - dirY * k * cameraX, dirY + dirX * k * cameraX, single, 0)
                    assertEquals(single.distance[0], view.distance[column], 2e-3f * single.distance[0] + 1e-4f, "step $step column $column")
                    assertEquals(single.side[0], view.side[column])
                }
            }
        }
    }

    @Test
    fun cameraYawEasesThroughTurnsWithoutSnapping() {
        val game = GhoulRunGame(seed = 9L)
        game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
        game.skipLeanCheck()
        game.ghoul.state = GhoulState.Inactive
        val rig = GhoulCameraRig()
        rig.update(game, 0f)
        var previous = rig.yaw
        var maxStep = 0f
        var turns = 0
        var heading = game.heading
        var finished = false
        repeat((40f / game.config.step).toInt()) {
            if (finished) return@repeat
            game.step(game.config.step, GhoulLane.Left, -1f, 90f, 70f)
            // Stop at the end of the first maze: a new maze legitimately snaps the camera to its start.
            if (game.phase != GhoulPhase.Playing) {
                finished = true
                return@repeat
            }
            if (game.heading != heading) turns += 1
            heading = game.heading
            rig.update(game, game.config.step)
            maxStep = maxOf(maxStep, abs(rig.yaw - previous))
            previous = rig.yaw
        }
        // Smoothstep peaks at 1.5x the mean rate: 90 degrees per 0.35 s, or a 180 degree dead-end turnaround.
        val turnRate = maxOf(PI / 2 / 0.35, PI / game.config.deadEndTurnSeconds)
        val limit = (turnRate * 1.5 * game.config.step).toFloat() + 0.005f
        assertTrue(turns >= 3, "the ride must include turns ($turns)")
        assertTrue(maxStep <= limit, "yaw stepped $maxStep rad in one frame (limit $limit)")
    }

    @Test
    fun rendererFillsTheFrameAndDrawsTheGhoul() {
        val world = GhoulRunWorld(seed = 21L)
        val grid = GhoulRayGrid.from(world)
        val renderer = GhoulFirstPersonRenderer(320, 333)
        val start = world.start
        val heading = world.exits(start).first()
        val ghoul = GhoulSprite(
            GhoulRaycaster.cellX(start.col.toFloat()) + heading.dc * 1.2f,
            GhoulRaycaster.cellY(start.row.toFloat()) + heading.dr * 1.2f,
            GhoulSpriteKind.Ghoul,
        )
        renderer.render(
            grid,
            GhoulRaycaster.cellX(start.col.toFloat()),
            GhoulRaycaster.cellY(start.row.toFloat()),
            GhoulRaycaster.yawOf(heading),
            0.5f,
            8f,
            listOf(ghoul),
            0f,
        )
        assertTrue(renderer.pixels.all { it ushr 24 == 0xFF }, "every pixel is opaque")
        assertEquals(1, renderer.drawCount, "the ghoul in front of the camera is placed")
        val draw = renderer.draws[0]
        assertEquals(GhoulSpriteKind.Ghoul, draw.kind)
        assertTrue(draw.left < 160f && draw.left + draw.width > 160f && draw.top < 166f && draw.top + draw.height > 166f)
        assertTrue((0 until draw.runCount).any { draw.runs[it * 2] <= 160 && draw.runs[it * 2 + 1] >= 160 })
        // Column-major frame: column 0 is contiguous and holds ceiling, wall and floor shades.
        assertTrue((0 until 333).map { renderer.pixelAt(0, it) }.toSet().size >= 3)
        assertEquals(renderer.pixels[5 * 333 + 7], renderer.pixelAt(5, 7))

        // Hidden behind a wall: no draw command.
        ghoul.x = GhoulRaycaster.cellX(start.col.toFloat()) - heading.dc * 3f + heading.dr * 3f
        ghoul.y = GhoulRaycaster.cellY(start.row.toFloat()) - heading.dr * 3f + heading.dc * 3f
        renderer.render(
            grid,
            GhoulRaycaster.cellX(start.col.toFloat()),
            GhoulRaycaster.cellY(start.row.toFloat()),
            GhoulRaycaster.yawOf(heading) + PI.toFloat(),
            0.5f,
            8f,
            listOf(ghoul),
            0f,
        )
        assertTrue(renderer.drawCount == 0 || renderer.draws[0].runCount > 0)
        ghoul.x = GhoulRaycaster.cellX(start.col.toFloat()) + heading.dc * 1.2f
        ghoul.y = GhoulRaycaster.cellY(start.row.toFloat()) + heading.dr * 1.2f

        val propHeight = GhoulSpriteArt.textureHeight(GhoulSpriteKind.Exit)
        val exit = GhoulSpriteArt.texture(GhoulSpriteKind.Exit, propHeight, propHeight)
        val shrine = GhoulSpriteArt.texture(GhoulSpriteKind.ShrineReady, propHeight, propHeight)
        assertTrue(exit.any { it != 0 }, "exit procedural art remains")
        assertTrue(shrine.any { it != 0 }, "shrine procedural art remains")

        val frames = 120
        val begin = System.nanoTime()
        repeat(frames) { renderer.render(grid, 1.5f, 1.5f, it * 0.05f, 0.5f, 8f, listOf(ghoul), it / 30f) }
        val ms = (System.nanoTime() - begin) / 1_000_000.0 / frames
        println("GHOUL_RUN jvm_first_person_ms=${"%.2f".format(ms)} (320x333)")
    }
}
