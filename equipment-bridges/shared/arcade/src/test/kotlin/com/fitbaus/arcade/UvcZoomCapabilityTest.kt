// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class UvcZoomCapabilityTest {
    @Test
    fun supportedRangeParsesAndClamps() {
        val caps = UvcZoomCapability.fromQuery(intArrayOf(1, 100, 400, 10, 200, 250))
        assertTrue(caps.supported)
        assertEquals(100, caps.min)
        assertEquals(400, caps.max)
        assertEquals(10, caps.step)
        assertEquals(200, caps.default)
        assertEquals(250, caps.current)
        assertEquals(100, caps.widest())
        assertEquals(100, caps.clamp(50))
        assertEquals(400, caps.clamp(999))
        assertEquals(250, caps.clamp(255))
    }

    @Test
    fun unsupportedAndMalformedQueries() {
        assertFalse(UvcZoomCapability.fromQuery(null).supported)
        assertFalse(UvcZoomCapability.fromQuery(intArrayOf(0, 1, 2, 1, 1, 1)).supported)
        assertFalse(UvcZoomCapability.fromQuery(intArrayOf(1, 10, 10, 1, 10, 10)).supported)
        assertFalse(UvcZoomCapability.fromQuery(intArrayOf(1, 20, 10, 1, 15, 15)).supported)
        assertFalse(UvcZoomCapability.fromQuery(intArrayOf(1, 0, 100, 0, 50, 50)).supported)
        assertFalse(UvcZoomCapability.fromQuery(intArrayOf(1, 0, 100, 7, 50, 50)).supported)
        assertFalse(UvcZoomCapability.fromQuery(intArrayOf(1, 0, 100, 10, 5, 50)).supported)
        assertFalse(UvcZoomCapability.fromQuery(intArrayOf(1, 0, 100, 10, 50, 7)).supported)
        assertFalse(UvcZoomCapability.fromQuery(intArrayOf(1)).supported)
    }

    @Test
    fun preferencesResolveAgainstCapability() {
        val caps = UvcZoomCapability.fromQuery(intArrayOf(1, 100, 400, 10, 200, 250))
        assertEquals(100, UvcZoomPreference.Widest.resolve(caps))
        assertEquals(200, UvcZoomPreference.CameraDefault.resolve(caps))
        assertEquals(300, UvcZoomPreference.Absolute(303).resolve(caps))
        assertNull(UvcZoomPreference.Widest.resolve(UvcZoomCapability.UNSUPPORTED))
    }
}
