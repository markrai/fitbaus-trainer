package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class LoboLanPickerStateTest {
    private val first = LoboLanDevice("LOBO-17AE84", "192.168.1.200:7869")
    private val second = LoboLanDevice("LOBO-8207D3", "192.168.1.186:7869")

    @Test
    fun discoveryUpdatesDoNotClearOrReplaceTheSelection() {
        val state = LoboLanPickerState()
        state.update(listOf(first))
        assertEquals(first, state.select(first.address))
        state.update(listOf(second, first))
        assertEquals(first, state.selected)
        state.update(listOf(second))
        assertEquals(first, state.selected)
        assertFalse(state.isAvailable(first.address))
        assertEquals(listOf(second, first), state.rows())
        state.update(emptyList())
        assertEquals(listOf(first), state.rows())
        state.update(listOf(first.copy(name = "LOBO-17AE84 (2)"), second))
        assertTrue(state.isAvailable(first.address))
        assertEquals(first, state.selected)
        assertEquals(2, state.rows().size)
        assertEquals("https://192.168.1.200:7869/v1", state.selected?.endpoint)
    }

    @Test
    fun onlyExplicitSelectionOrResetChangesTheChosenEndpoint() {
        val state = LoboLanPickerState()
        state.update(listOf(first, second))
        state.select(first.address)
        assertNull(state.select("192.168.1.99:7869"))
        assertEquals(first, state.selected)
        assertEquals(second, state.select(second.address))
        state.clearSelection()
        assertNull(state.selected)
        assertEquals(2, state.rows().size)
        state.select(first.address)
        state.reset()
        assertNull(state.selected)
        assertTrue(state.rows().isEmpty())
    }
}
