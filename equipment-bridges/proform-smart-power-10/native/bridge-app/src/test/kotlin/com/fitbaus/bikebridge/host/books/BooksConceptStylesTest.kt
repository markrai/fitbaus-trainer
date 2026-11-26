package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.pow
import kotlin.random.Random

class BooksConceptStylesTest {
    @Test
    fun sameConceptsKeepTheSameStylesAndDifferentSectionsVary() {
        val snippets = List(10) { "Concept $it" }
        val styles = BooksConceptStyles.assign(snippets)
        assertEquals(styles, BooksConceptStyles.assign(snippets.toList()))
        assertEquals(snippets.size, styles.size)
        assertEquals(6, styles.take(6).map { it.palette }.toSet().size)
        assertTrue(styles.zipWithNext().all { (a, b) -> a.palette != b.palette })
        assertTrue((0 until 20).map { BooksConceptStyles.assign(listOf("Section $it")) }.distinct().size > 1)
        assertTrue(styles.all { it.fontSp in 27f..29f &&
            it.horizontalPaddingDp in 30..40 && it.verticalPaddingDp in 24..34 && it.radiusDp in 13..21 })
        assertTrue(BooksConceptStyles.assign(listOf("x".repeat(140))).single().fontSp in 19f..21f)
    }

    @Test
    fun everyPaletteHasAnOpaqueNonBlackFillAndReadableText() {
        fun luminance(color: Int): Double {
            fun channel(shift: Int): Double {
                val value = ((color ushr shift) and 255) / 255.0
                return if (value <= 0.04045) value / 12.92 else ((value + 0.055) / 1.055).pow(2.4)
            }
            return channel(16) * 0.2126 + channel(8) * 0.7152 + channel(0) * 0.0722
        }
        fun contrast(a: Int, b: Int): Double {
            val first = luminance(a)
            val second = luminance(b)
            return (maxOf(first, second) + 0.05) / (minOf(first, second) + 0.05)
        }
        for (palette in BooksConceptStyles.palettes) {
            assertEquals(255, palette.fill ushr 24)
            assertTrue((palette.fill and 0xffffff) != 0)
            assertTrue(luminance(palette.fill) >= 0.025)
            for (text in listOf(palette.accent, 0xffeeeeee.toInt())) {
                assertTrue(contrast(text, palette.fill) >= 4.5)
            }
        }
    }

    @Test
    fun footprintsAccountForBordersWithoutRotationOrExtraPadding() {
        val body = ConceptSize(99, 300)
        val card = BooksConceptStyles.metrics(body, 100, 1)
        assertEquals(ConceptSize(100, 301), card.footprint)
        assertEquals(body, card.body)
        assertEquals(body, BooksConceptStyles.metrics(body, 99, 0).footprint)
    }

    @Test
    fun filledCardFootprintsRemainInsideTheCollageWithoutOverlap() {
        val random = Random(54)
        repeat(256) {
            val width = random.nextInt(100, 1400)
            val gap = random.nextInt(0, 25)
            val cards = List(random.nextInt(1, 11)) {
                val size = ConceptSize(random.nextInt(1, width), random.nextInt(1, 400))
                BooksConceptStyles.metrics(size, width, 1)
            }
            val sizes = cards.map { it.footprint }
            val layout = BooksConceptLayout.place(sizes, width, gap, 20, it)
            assertEquals(layout, BooksConceptLayout.place(sizes, width, gap, 20, it))
            assertEquals(cards.indices.toSet(), layout.placements.map { it.index }.toSet())
            assertEquals(cards.size, layout.placements.size)
            for ((index, a) in layout.placements.withIndex()) {
                assertTrue(a.left >= 0 && a.top >= 0 && a.left + a.width <= width &&
                    a.top + a.height <= layout.height)
                assertEquals(cards[a.index].footprint, ConceptSize(a.width, a.height))
                for (b in layout.placements.drop(index + 1)) {
                    assertTrue(a.left + a.width + gap <= b.left || b.left + b.width + gap <= a.left ||
                        a.top + a.height + gap <= b.top || b.top + b.height + gap <= a.top)
                }
            }
        }
    }
}
