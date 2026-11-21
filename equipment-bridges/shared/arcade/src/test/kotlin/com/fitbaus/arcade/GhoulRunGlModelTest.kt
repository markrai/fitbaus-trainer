// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.math.PI
import kotlin.math.hypot

internal class GhoulRunGlModelTest {
    @Test
    fun meshHasFloorsCeilingsAndOnlyBoundaryWallFaces() {
        val maze = GhoulGlMaze(1L, 2, 2, booleanArrayOf(true, true, false, true))
        val mesh = GhoulMazeMesher.build(maze)
        assertEquals(18, mesh.floorVertices)
        assertEquals(18, mesh.ceilingVertices)
        // Three joined floor tiles have eight exterior boundary edges; shared floor edges emit no wall.
        assertEquals(48, mesh.wallVertices)
        assertEquals(84, mesh.vertexCount)
        assertEquals(0f, mesh.vertices[2])
        val ceilingStart = mesh.floorVertices * GhoulMazeMesh.FLOATS_PER_VERTEX
        assertEquals(1f, mesh.vertices[ceilingStart + 2])
    }

    @Test
    fun generatedWorldGeometryUsesExpandedTileCoordinates() {
        val world = GhoulRunWorld(seed = 9L)
        val maze = GhoulGlMaze.from(world)
        val mesh = GhoulMazeMesher.build(maze)
        assertTrue(mesh.vertexCount > 0)
        var index = 0
        while (index < mesh.floorVertices * GhoulMazeMesh.FLOATS_PER_VERTEX) {
            val x = mesh.vertices[index]
            val y = mesh.vertices[index + 1]
            assertTrue(x in 0f..maze.cols.toFloat())
            assertTrue(y in 0f..maze.rows.toFloat())
            assertEquals(0f, mesh.vertices[index + 2])
            index += GhoulMazeMesh.FLOATS_PER_VERTEX
        }
    }

    @Test
    fun lightSelectionKeepsNearestAndCopiesMeaningfulColourAndRadius() {
        val x = floatArrayOf(9f, 2f, 4f, 1f)
        val y = floatArrayOf(0f, 0f, 0f, 0f)
        val kind = intArrayOf(GhoulGlLightColor.EXIT_GREEN, GhoulGlLightColor.SHRINE_CYAN, GhoulGlLightColor.GHOUL_RED, GhoulGlLightColor.EXIT_GREEN)
        val xyr = FloatArray(9)
        val rgb = FloatArray(9)
        val count = GhoulLightSelector.select(0f, 0f, x, y, kind, 4, xyr, rgb, 3)
        assertEquals(3, count)
        assertEquals(listOf(1f, 2f, 4f), listOf(xyr[0], xyr[3], xyr[6]))
        assertEquals(GhoulGlLightColor.radius[GhoulGlLightColor.EXIT_GREEN], xyr[2])
        assertEquals(GhoulGlLightColor.rgb[GhoulGlLightColor.EXIT_GREEN * 3 + 1], rgb[1])
        assertEquals(GhoulGlLightColor.radius[GhoulGlLightColor.GHOUL_RED], xyr[8])

        val farther = GhoulLightSelector.select(
            0f, 0f, floatArrayOf(1f, 2f, 3f, 20f), FloatArray(4),
            intArrayOf(0, 0, 0, 0), 4, xyr, rgb, 3,
        )
        assertEquals(3, farther)
        assertEquals(listOf(1f, 2f, 3f), listOf(xyr[0], xyr[3], xyr[6]))
    }

    @Test
    fun snapshotPublicationAlternatesPreallocatedFrames() {
        val buffer = GhoulGlSnapshotBuffer()
        val first = buffer.writable()
        first.cameraX = 3f
        first.lampPhase = 1.25f
        first.glowPhase = 2.5f
        buffer.publish(first)
        assertSame(first, buffer.readable())
        val second = buffer.writable()
        assertFalse(second === first)
        second.copyFrom(first)
        second.cameraX = 7f
        buffer.publish(second)
        assertEquals(7f, buffer.readable().cameraX)
        assertEquals(1.25f, buffer.readable().lampPhase)
        assertEquals(2.5f, buffer.readable().glowPhase)
        assertEquals(3f, first.cameraX)
    }

    @Test
    fun shaderPhasesRemainBoundedAcrossTwentyFourHours() {
        val phases = GhoulShaderPhases()
        repeat(24 * 60 * 60) {
            phases.advance(1f, 2.5f)
            assertTrue(phases.lamp in 0f..GhoulShaderPhases.TWO_PI, "lamp phase ${phases.lamp}")
            assertTrue(phases.glow in 0f..GhoulShaderPhases.TWO_PI, "glow phase ${phases.glow}")
        }
    }

    @Test
    fun conceptGhoulPhasesRemainBoundedAcrossTwentyFourHoursAndFreezeStunned() {
        val motion = GhoulConceptMotion()
        repeat(24 * 60 * 60) {
            motion.advance(1f, GhoulState.Hunting)
            assertTrue(motion.phaseA in 0f..GhoulShaderPhases.TWO_PI)
            assertTrue(motion.phaseB in 0f..GhoulShaderPhases.TWO_PI)
        }
        val phaseA = motion.phaseA
        val phaseB = motion.phaseB
        motion.advance(10f, GhoulState.Stunned)
        assertEquals(phaseA, motion.phaseA)
        assertEquals(phaseB, motion.phaseB)
        assertEquals(0.8f, motion.desaturation(GhoulState.Stunned))
    }

    @Test
    fun haloWarpIsAnchoredAtChestAndGrowsTowardTips() {
        val chest = GhoulConceptArt.CHEST
        assertEquals(chest, haloWarp(chest, 1.1f, 0.7f, 1f))
        val near = GhoulUv(chest.u + 0.2f * GhoulConceptArt.HALO_RADIUS / GhoulConceptArt.ASPECT, chest.v)
        val far = GhoulUv(chest.u + 0.9f * GhoulConceptArt.HALO_RADIUS / GhoulConceptArt.ASPECT, chest.v)
        val nearWarp = haloWarp(near, 1.1f, 0.7f, 0f)
        val farWarp = haloWarp(far, 1.1f, 0.7f, 0f)
        val nearDisplacement = hypot(nearWarp.u - near.u, nearWarp.v - near.v)
        val farDisplacement = hypot(farWarp.u - far.u, farWarp.v - far.v)
        assertTrue(farDisplacement > nearDisplacement, "$farDisplacement must exceed $nearDisplacement")
        assertEquals(haloWarp(near, 1.1f, 0.7f, 0f), haloWarp(near, 1.1f, 0.7f, 1f))
    }

    @Test
    fun committedGhoulAnchorParses() {
        val file = File("src/main/assets/arcade/ghoul/ghoul_anchor.json")
        val anchor = GhoulAnchorParser.parse(file.readText())
        assertEquals(1024, anchor.canvasWidth)
        assertEquals(512, anchor.canvasHeight)
        assertEquals(GhoulUv(0.5094f, 0.3173f), anchor.chest)
        assertEquals(0.9901f, anchor.feet.v)
    }

    @Test
    fun leftHandedMazeProjectsRiderRightToScreenRight() {
        val matrix = FloatArray(16)
        val projection = FloatArray(16)
        val view = FloatArray(16)
        val fov = (70.0 * PI / 180.0).toFloat()
        GhoulGlMatrices.buildViewProjection(matrix, projection, view, 0f, 0f, 0.5f, 0f, fov, 1f, 0.08f, 60f)
        assertTrue(GhoulGlMatrices.clipX(matrix, 2f, 1f, 0.5f) > 0f, "south must be right while facing east")
        assertEquals(0f, GhoulGlMatrices.billboardRightX(0f), 1e-5f)
        assertEquals(1f, GhoulGlMatrices.billboardRightY(0f), 1e-5f)

        val south = (PI / 2.0).toFloat()
        GhoulGlMatrices.buildViewProjection(matrix, projection, view, 0f, 0f, 0.5f, south, fov, 1f, 0.08f, 60f)
        assertTrue(GhoulGlMatrices.clipX(matrix, -1f, 2f, 0.5f) > 0f, "west must be right while facing south")
        assertEquals(-1f, GhoulGlMatrices.billboardRightX(south), 1e-5f)
        assertEquals(0f, GhoulGlMatrices.billboardRightY(south), 1e-5f)
    }

    @Test
    fun rendererFailurePermanentlySelectsFallbackAndKeepsFirstReason() {
        val selection = GhoulRendererSelection()
        assertEquals(GhoulRendererType.Gl, selection.type)
        selection.fail("shader link failed")
        selection.fail("later context error")
        assertEquals(GhoulRendererType.Fallback, selection.type)
        assertEquals("shader link failed", selection.reason)
        assertEquals(GhoulRendererType.Fallback, GhoulRendererSelection(false).type)
    }
}
