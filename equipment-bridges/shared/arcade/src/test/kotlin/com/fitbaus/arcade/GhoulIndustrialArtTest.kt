// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

internal class GhoulIndustrialArtTest {
    @Test
    fun allMaterialsAreSmallOpaqueAtlasesWithDistinctPanelVariants() {
        for (surface in GhoulIndustrialSurface.entries) {
            val atlas = GhoulIndustrialArt.atlas(surface)
            assertEquals(128 * 128, atlas.size)
            assertTrue(atlas.all { it ushr 24 == 255 }, "$surface must be opaque")
            val middle = (0 until 4).map { variant ->
                val x = (variant % 2) * 64 + 32
                val y = (variant / 2) * 64 + 32
                atlas[y * 128 + x]
            }
            assertTrue(middle.toSet().size >= 3, "$surface must have visually different panel styles")
            assertArrayEquals(atlas, GhoulIndustrialArt.atlas(surface))
        }
    }

    @Test
    fun steelWallHasReinforcedEdgesAndDarkVentSlots() {
        val atlas = GhoulIndustrialArt.atlas(GhoulIndustrialSurface.Wall)
        val plate = atlas[32 * 128 + 32]
        val seam = atlas[32 * 128 + 1]
        val vent = atlas[20 * 128 + 64 + 32]
        assertNotEquals(plate, seam)
        assertTrue((vent and 255) < (plate and 255))
    }

    @Test
    fun panelVariationIsSeededAndPositionStable() {
        val samples = (0 until 200).map { col -> GhoulIndustrialArt.variant(1234L, col / 10, col % 10, col % 6) }
        assertEquals(4, samples.toSet().size)
        assertEquals(samples, (0 until 200).map { col -> GhoulIndustrialArt.variant(1234L, col / 10, col % 10, col % 6) })
        assertTrue(samples.indices.any { i ->
            samples[i] != GhoulIndustrialArt.variant(4321L, i / 10, i % 10, i % 6)
        })
    }

    @Test
    fun meshVariantsRemainInsideTheirAtlasQuadrantsAndDoNotChangeGeometry() {
        val maze = GhoulGlMaze(456L, 2, 2, booleanArrayOf(true, true, false, true))
        val mesh = GhoulMazeMesher.build(maze)
        assertEquals(84, mesh.vertexCount)
        assertEquals(8, GhoulMazeMesh.FLOATS_PER_VERTEX)
        for (quad in 0 until mesh.vertexCount / 6) {
            val base = quad * 6 * GhoulMazeMesh.FLOATS_PER_VERTEX
            val u = mesh.vertices[base + 6]
            val v = mesh.vertices[base + 7]
            val x = (u * 2f).toInt()
            val y = (v * 2f).toInt()
            for (vertex in 0 until 6) {
                val at = base + vertex * GhoulMazeMesh.FLOATS_PER_VERTEX
                val uvX = mesh.vertices[at + 6]
                val uvY = mesh.vertices[at + 7]
                assertTrue(uvX > x * 0.5f && uvX < (x + 1) * 0.5f)
                assertTrue(uvY > y * 0.5f && uvY < (y + 1) * 0.5f)
            }
        }
        assertArrayEquals(mesh.vertices, GhoulMazeMesher.build(maze).vertices)
        val differentSeed = GhoulMazeMesher.build(
            GhoulGlMaze(9999L, 2, 2, booleanArrayOf(true, true, false, true)),
        )
        assertFalse(mesh.vertices.contentEquals(differentSeed.vertices))
    }

    @Test
    fun fogBuildsGraduallyAndIsDenserNearTheFloor() {
        assertEquals(0f, GhoulIndustrialArt.fog(2f, 0.5f))
        val near = GhoulIndustrialArt.fog(5f, 0.5f)
        val middle = GhoulIndustrialArt.fog(9f, 0.5f)
        val far = GhoulIndustrialArt.fog(20f, 0.5f)
        assertTrue(near > 0f)
        assertTrue(middle > near)
        assertTrue(GhoulIndustrialArt.fog(4f, 0f) > 0.1f)
        assertTrue(GhoulIndustrialArt.fog(6f, 0f) > 0.25f)
        assertTrue(far > middle)
        assertTrue(far <= 0.72f)
        assertTrue(GhoulIndustrialArt.fog(10f, 0f) > GhoulIndustrialArt.fog(10f, 1f))
    }

    @Test
    fun cpuFallbackGridCarriesTheSameMazeSeed() {
        val world = GhoulRunWorld(seed = 71L)
        assertEquals(world.seed, GhoulRayGrid.from(world).seed)
    }
}
