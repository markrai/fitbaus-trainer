// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

internal class GhoulEyeArtTest {
    @Test
    fun glowingEyesRemainVisibleWithoutLampIllumination() {
        assertEquals(0f, GhoulDarkness.ambient(0f))
        assertEquals(0f, GhoulDarkness.ambient(-5f))
        assertEquals(0.5f, GhoulDarkness.ambient(3f))
        assertEquals(1f, GhoulDarkness.ambient(6f))
        assertEquals(1f, GhoulDarkness.ambient(14f))
        assertTrue(GhoulEyeArt.glowAt(GhoulEyeArt.LEFT_U, GhoulEyeArt.EYE_V) > 0.95f)
        assertTrue(GhoulEyeArt.glowAt(GhoulEyeArt.RIGHT_U, GhoulEyeArt.EYE_V) > 0.95f)
    }

    @Test
    fun eyeLightIsLocalToFaceAndDisabledWhenStunned() {
        assertTrue(GhoulEyeArt.LEFT_U < GhoulEyeArt.RIGHT_U)
        assertTrue(GhoulEyeArt.glowAt(GhoulEyeArt.LEFT_U + 0.08f, GhoulEyeArt.EYE_V) < 0.01f)
        assertTrue(GhoulEyeArt.glowAt(GhoulEyeArt.RIGHT_U, GhoulEyeArt.EYE_V + 0.10f) < 0.01f)
        assertEquals(0f, GhoulEyeArt.glowAt(GhoulEyeArt.LEFT_U, GhoulEyeArt.EYE_V, stunned = true))
        assertEquals(0f, GhoulEyeArt.glowAt(GhoulEyeArt.RIGHT_U, GhoulEyeArt.EYE_V, stunned = true))
    }
}
