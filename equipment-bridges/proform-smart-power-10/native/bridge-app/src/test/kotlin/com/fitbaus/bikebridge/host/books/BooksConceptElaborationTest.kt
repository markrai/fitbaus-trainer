package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BooksConceptElaborationTest {
    @Test
    fun doubleTapRequiresSameCardAndNearbyTimelyTouch() {
        val tap = BooksConceptDoubleTap(300, 20f)
        assertFalse(tap.tap(0, 100, 10f, 10f))
        assertTrue(tap.tap(0, 200, 12f, 10f))
        assertFalse(tap.tap(0, 250, 12f, 10f))
        assertFalse(tap.tap(1, 300, 12f, 10f))
        assertFalse(tap.tap(1, 700, 12f, 10f))
        assertFalse(tap.tap(1, 750, 60f, 10f))
        tap.clear()
        assertFalse(tap.tap(1, 800, 60f, 10f))
        assertTrue(tap.tap(1, 900, 60f, 10f))
    }

    @Test
    fun dismissedPendingRequestFinishesAndReopeningUsesCache() {
        val scope = BooksConceptElaboration()
        val ticket = requireNotNull(scope.open(1))
        assertEquals(ConceptExplanation.Loading, scope.state(1))
        scope.dismiss()
        assertNull(scope.selected)
        assertNull(scope.open(1))
        scope.dismiss()
        assertTrue(scope.complete(ticket, ConceptExplanation.Ready("Details")))
        assertNull(scope.open(1))
        assertEquals(ConceptExplanation.Ready("Details"), scope.state(1))
        assertEquals(1, scope.selected)
    }

    @Test
    fun replacementClearsEveryCardAndRejectsStaleResults() {
        val scope = BooksConceptElaboration()
        val first = requireNotNull(scope.open(0))
        assertTrue(scope.complete(first, ConceptExplanation.Ready("Old")))
        val pending = requireNotNull(scope.open(1))
        scope.clear()
        assertNull(scope.selected)
        assertEquals(ConceptExplanation.Unavailable, scope.state(0))
        val next = requireNotNull(scope.open(1))
        assertFalse(scope.complete(pending, ConceptExplanation.Ready("Stale")))
        assertEquals(ConceptExplanation.Loading, scope.state(1))
        assertTrue(scope.complete(next, ConceptExplanation.Unavailable))
        assertNotNull(scope.open(1))
    }
}
