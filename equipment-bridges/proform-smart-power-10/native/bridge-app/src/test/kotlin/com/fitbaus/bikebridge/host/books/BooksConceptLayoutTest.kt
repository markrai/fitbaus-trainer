package com.fitbaus.bikebridge.host.books

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import kotlin.random.Random

class BooksConceptLayoutTest {
    @Test
    fun greedyPackingFillsAvailableRowsDeterministically() {
        val sizes = listOf(ConceptSize(120, 30), ConceptSize(40, 20), ConceptSize(60, 50),
            ConceptSize(50, 15))
        val result = BooksConceptLayout.place(sizes, 200, 10)
        assertEquals(result, BooksConceptLayout.place(sizes, 200, 10))
        assertEquals(listOf(0, 2, 3, 1), result.placements.map { it.index })
        assertEquals(80, result.height)
        assertEquals(5, result.placements.first().left)
        assertEquals(10, result.placements.first().top)
    }

    @Test
    fun seededLayoutsKeepEverySnippetInsideBoundsWithoutOverlap() {
        val random = Random(42)
        repeat(256) {
            val width = random.nextInt(1, 1200)
            val gap = random.nextInt(0, width + 1)
            val sizes = List(random.nextInt(1, 11)) {
                ConceptSize(random.nextInt(1, width + 1), random.nextInt(1, 250))
            }
            val result = BooksConceptLayout.place(sizes, width, gap)
            assertEquals(sizes.indices.toSet(), result.placements.map { it.index }.toSet())
            assertEquals(sizes.size, result.placements.size)
            for ((i, a) in result.placements.withIndex()) {
                assertEquals(sizes[a.index], ConceptSize(a.width, a.height))
                assertTrue(a.left >= 0 && a.top >= 0 && a.left + a.width <= width &&
                    a.top + a.height <= result.height)
                for (b in result.placements.drop(i + 1)) {
                    assertTrue(a.left + a.width <= b.left || b.left + b.width <= a.left ||
                        a.top + a.height <= b.top || b.top + b.height <= a.top)
                }
            }
        }
    }

    @Test
    fun plainTextValidationAcceptsIndependentUnicodeIdeasButRejectsUnsafeOrOversizedResponses() {
        fun response(values: List<Any>) = JSONObject().put("cache_hit", false).put("concepts", JSONArray(values))
        val phrases = listOf("Dopamine", "Desire can exceed pleasure", "未来の選択", "الرغبة والمتعة")
        assertEquals(phrases, BooksConceptValidation.parse(response(phrases)))
        for (values in listOf(emptyList(), listOf("<script>"), listOf("a\u202eb"),
            listOf("x".repeat(141)), listOf("One", "One"), List(11) { "Idea $it" }, listOf("---"))) {
            assertThrows(IllegalArgumentException::class.java) { BooksConceptValidation.parse(response(values)) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            BooksConceptValidation.parse(response(phrases).put("graph", JSONObject()))
        }
    }
}
