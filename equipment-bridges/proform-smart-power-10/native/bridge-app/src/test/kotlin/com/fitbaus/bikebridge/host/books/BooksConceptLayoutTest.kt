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
    fun longCardsUseSideBySideSpaceAndIndependentVerticalPositions() {
        val sizes = listOf(ConceptSize(280, 150), ConceptSize(280, 70),
            ConceptSize(280, 70), ConceptSize(180, 90))
        val result = BooksConceptLayout.place(sizes, 600, 16, stagger = 20, seed = 54)
        assertEquals(result, BooksConceptLayout.place(sizes, 600, 16, stagger = 20, seed = 54))
        val first = result.placements.first { it.index == 0 }
        val second = result.placements.first { it.index == 1 }
        val third = result.placements.first { it.index == 2 }
        assertTrue(first.left + first.width + 16 <= second.left ||
            second.left + second.width + 16 <= first.left)
        assertTrue(second.top < first.top + first.height)
        assertTrue(third.top < first.top + first.height + 16)
        assertTrue(result.height < sizes.sumOf { it.height } + 48)
    }

    @Test
    fun wideCardsAlternateHorizontalOffsetsEvenWhenTheyMustStack() {
        val sizes = List(4) { ConceptSize(420, 80) }
        val result = BooksConceptLayout.place(sizes, 600, 16, stagger = 20, seed = 54)
        for ((a, b) in result.placements.zipWithNext()) {
            assertTrue(kotlin.math.abs(a.left - b.left) >= 70)
            assertTrue(a.top + a.height + 16 <= b.top)
        }
        assertEquals(sizes.indices.toSet(), result.placements.map { it.index }.toSet())
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
            val result = BooksConceptLayout.place(sizes, width, gap, stagger = 20, seed = it)
            assertEquals(result, BooksConceptLayout.place(sizes, width, gap, stagger = 20, seed = it))
            assertEquals(sizes.indices.toSet(), result.placements.map { it.index }.toSet())
            assertEquals(sizes.size, result.placements.size)
            for ((i, a) in result.placements.withIndex()) {
                assertEquals(sizes[a.index], ConceptSize(a.width, a.height))
                assertTrue(a.left >= 0 && a.top >= 0 && a.left + a.width <= width &&
                    a.top + a.height <= result.height)
                for (b in result.placements.drop(i + 1)) {
                    assertTrue(a.left + a.width + gap <= b.left || b.left + b.width + gap <= a.left ||
                        a.top + a.height + gap <= b.top || b.top + b.height + gap <= a.top)
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
