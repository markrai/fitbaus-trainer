package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
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
        assertTrue(styles.count { it.outlined } <= 1)
        assertTrue((0 until 20).map { BooksConceptStyles.assign(listOf("Section $it")) }.distinct().size > 1)
        assertTrue(styles.all { it.fontSp in 27f..29f && abs(it.rotationDegrees) <= 1.5f &&
            it.horizontalPaddingDp in 30..40 && it.verticalPaddingDp in 24..34 && it.radiusDp in 13..21 })
        assertTrue(BooksConceptStyles.assign(listOf("x".repeat(140))).single().fontSp in 19f..21f)
    }

    @Test
    fun textPaletteMaintainsReadableContrastOnFilledAndOutlinedCards() {
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
            for (text in listOf(palette.accent, 0xffeeeeee.toInt())) {
                assertTrue(contrast(text, palette.fill) >= 4.5)
                assertTrue(contrast(text, 0xff000000.toInt()) >= 4.5)
            }
        }
    }

    @Test
    fun rotationThatDoesNotFitFallsBackToAnUnrotatedFootprint() {
        val size = ConceptSize(99, 300)
        val card = BooksConceptStyles.metrics(size, 1.5f, 100, 1)
        assertEquals(0f, card.rotationDegrees)
        assertEquals(ConceptSize(100, 301), card.footprint)
        assertEquals(size, card.body)
    }

    @Test
    fun rotatedCardsAndStaggeredRowsStayInsideTheirAllocatedSpace() {
        val random = Random(54)
        repeat(256) {
            val width = random.nextInt(100, 1400)
            val gap = random.nextInt(0, 25)
            val cards = List(random.nextInt(1, 11)) {
                val size = ConceptSize(random.nextInt(1, width), random.nextInt(1, 400))
                BooksConceptStyles.metrics(size, random.nextInt(-3, 4) * 0.5f, width, 1)
            }
            val sizes = cards.map { it.footprint }
            val layout = BooksConceptLayout.place(sizes, width, gap, 12, it)
            assertEquals(layout, BooksConceptLayout.place(sizes, width, gap, 12, it))
            assertEquals(cards.indices.toSet(), layout.placements.map { it.index }.toSet())
            assertEquals(cards.size, layout.placements.size)
            for ((index, a) in layout.placements.withIndex()) {
                assertTrue(a.left >= 0 && a.top >= 0 && a.left + a.width <= width &&
                    a.top + a.height <= layout.height)
                for (b in layout.placements.drop(index + 1)) {
                    assertTrue(a.left + a.width <= b.left || b.left + b.width <= a.left ||
                        a.top + a.height <= b.top || b.top + b.height <= a.top)
                }
                val card = cards[a.index]
                val angle = Math.toRadians(card.rotationDegrees.toDouble())
                val halfW = (card.body.width + 1) / 2.0
                val halfH = (card.body.height + 1) / 2.0
                for (x in listOf(-halfW, halfW)) for (y in listOf(-halfH, halfH)) {
                    assertTrue(abs(x * cos(angle) - y * sin(angle)) <= a.width / 2.0 + 0.0001)
                    assertTrue(abs(x * sin(angle) + y * cos(angle)) <= a.height / 2.0 + 0.0001)
                }
            }
        }
    }
}
