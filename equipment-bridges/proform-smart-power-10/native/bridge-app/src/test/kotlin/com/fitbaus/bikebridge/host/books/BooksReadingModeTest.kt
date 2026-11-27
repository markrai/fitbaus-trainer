// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BooksReadingModeTest {
    private val unavailable = BooksReadingAvailability(false, false)
    private val summaryOnly = BooksReadingAvailability(true, false)
    private val ready = BooksReadingAvailability(true, true)

    @Test
    fun unavailableModesCannotBeSelected() {
        val selection = BooksReadingSelection()
        assertEquals(BooksReadingMode.NARRATION, selection.visibleMode(true))
        assertFalse(selection.select(BooksReadingMode.SUMMARY, unavailable))
        assertFalse(selection.select(BooksReadingMode.CONCEPTS, summaryOnly))
        assertTrue(selection.select(BooksReadingMode.SUMMARY, summaryOnly))
        assertEquals(BooksReadingMode.SUMMARY, selection.visibleMode(true))
        assertTrue(selection.select(BooksReadingMode.CONCEPTS, ready))
    }

    @Test
    fun unavailableNewSectionsDoNotChangeTheSelectedMode() {
        val selection = BooksReadingSelection()
        assertTrue(selection.select(BooksReadingMode.CONCEPTS, ready))
        repeat(1000) {
            assertFalse(unavailable.allows(BooksReadingMode.CONCEPTS))
            assertEquals(BooksReadingMode.CONCEPTS, selection.visibleMode(true))
            assertFalse(selection.select(BooksReadingMode.SUMMARY, unavailable))
        }
        assertEquals(BooksReadingMode.CONCEPTS, selection.visibleMode(true))
        assertTrue(selection.select(BooksReadingMode.NARRATION, unavailable))
    }

    @Test
    fun eachFullscreenEntryStartsWithNarrationRegardlessOfReadiness() {
        val selection = BooksReadingSelection()
        for (previousMode in listOf(BooksReadingMode.SUMMARY, BooksReadingMode.CONCEPTS)) {
            for (availability in listOf(unavailable, summaryOnly, ready)) {
                assertTrue(selection.select(previousMode, ready))
                assertEquals(BooksReadingMode.NARRATION, selection.visibleMode(false))
                selection.reset()
                assertEquals(BooksReadingMode.NARRATION, selection.visibleMode(true))
                assertEquals(BooksReadingMode.NARRATION, selection.selected)
                assertTrue(availability.allows(selection.selected))
            }
        }
    }
}
