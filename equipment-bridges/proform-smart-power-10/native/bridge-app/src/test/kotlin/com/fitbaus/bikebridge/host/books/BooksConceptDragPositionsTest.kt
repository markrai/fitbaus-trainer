package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class BooksConceptDragPositionsTest {
    private val automatic = BooksConceptLayout.place(
        listOf(ConceptSize(100, 60), ConceptSize(150, 80), ConceptSize(80, 55)),
        400, 16, stagger = 20, seed = 42,
    ).placements

    @Test
    fun manualMoveChangesOnlyTheSelectedCardAndLeavesChronologicalPackingIntact() {
        val positions = BooksConceptDragPositions()
        val original = positions.resolve(automatic, 20, 20, 440, 300)
        val selected = original.first()
        positions.move(selected, 100, 180, 440, 300)
        val moved = positions.resolve(automatic, 20, 20, 440, 300)
        assertEquals(selected.copy(left = 100, top = 180), moved.last())
        assertEquals(original.drop(1), moved.dropLast(1))
        assertEquals(listOf(0, 1, 2), automatic.map { it.index })
        assertTrue(automatic.zipWithNext().all { (a, b) -> a.top < b.top })
        assertEquals(moved, positions.resolve(automatic, 20, 20, 440, 300))
    }

    @Test
    fun overlappingCardsRemainSelectableInTheirVisualLayerOrder() {
        val positions = BooksConceptDragPositions()
        val original = positions.resolve(automatic, 20, 20, 440, 300)
        val first = original.first()
        val second = original[1]
        positions.move(first, second.left, second.top, 440, 300)
        val overlap = positions.resolve(automatic, 20, 20, 440, 300)
        assertEquals(first.index, positions.hitTest(overlap, second.left + 1f, second.top + 1f)?.index)
        assertNull(positions.hitTest(overlap, -1f, -1f))
    }

    @Test
    fun boundsAreClampedAndNewCardSetsStartWithAutomaticPositions() {
        val positions = BooksConceptDragPositions()
        val original = positions.resolve(automatic, 20, 20, 440, 300)
        val card = original.first()
        positions.move(card, -100, 900, 440, 300)
        assertEquals(card.copy(left = 0, top = 300 - card.height),
            positions.resolve(automatic, 20, 20, 440, 300).last())
        val resized = positions.resolve(automatic, 20, 20, 440, 200).last()
        assertEquals(200 - card.height, resized.top)
        positions.clear()
        assertEquals(original, positions.resolve(automatic, 20, 20, 440, 300))
    }

    @Test
    fun fullscreenExitRetainsOnlyCurrentReadyConceptsAndRefreshClearsOverrides() {
        val readAlong = File("src/main/kotlin/com/fitbaus/bikebridge/host/books/BooksReadAlong.kt").readText()
        val view = File("src/main/kotlin/com/fitbaus/bikebridge/host/books/BooksConceptView.kt").readText()
        val panel = File("src/main/kotlin/com/fitbaus/bikebridge/host/books/BooksDiagramPanel.kt").readText()
        val exit = readAlong.substringAfter("fun setFullscreen(value: Boolean)").substringBefore("private fun updateReadingChrome()")
        assertTrue(exit.contains("if (!canRetainConcepts()) dismissSummary()"))
        assertTrue(exit.contains("if (value) readingSelection.reset()"))
        val retain = readAlong.substringAfter("private fun canRetainConcepts()").substringBefore("private fun livePosition()")
        assertTrue(retain.contains("diagramScope.state is BooksDiagramState.Concepts"))
        assertTrue(retain.contains("diagramConnectionMatches()"))
        assertTrue(retain.contains("diagramScope.matches(selection, diagramSummary(selection))"))
        assertTrue(readAlong.contains("!summaryScope.matches(summarySelection()) || !summaryContextAvailable()"))
        val clear = readAlong.substringAfter("private fun clearDiagram()").substringBefore("private fun maybeStartInlineSummary()")
        assertTrue(clear.contains("diagramPanel.clear()"))
        assertTrue(panel.substringAfter("fun clear()").contains("conceptView.clearConcepts()"))
        assertTrue(view.substringAfter("fun clearConcepts()").substringBefore("override fun onMeasure").contains("positions.clear()"))
        assertTrue(view.substringAfter("fun showConcepts(").substringBefore("fun clearConcepts()").contains("positions.clear()"))
    }
}
