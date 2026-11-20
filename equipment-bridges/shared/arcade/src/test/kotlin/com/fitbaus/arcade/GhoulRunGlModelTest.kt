// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

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
        first.cadenceHz = 1.25f
        buffer.publish(first)
        assertSame(first, buffer.readable())
        val second = buffer.writable()
        assertFalse(second === first)
        second.copyFrom(first)
        second.cameraX = 7f
        buffer.publish(second)
        assertEquals(7f, buffer.readable().cameraX)
        assertEquals(1.25f, buffer.readable().cadenceHz)
        assertEquals(3f, first.cameraX)
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
