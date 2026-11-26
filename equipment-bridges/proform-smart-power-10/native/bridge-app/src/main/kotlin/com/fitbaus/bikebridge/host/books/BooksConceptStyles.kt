package com.fitbaus.bikebridge.host.books

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

internal data class ConceptPalette(val fill: Int, val border: Int, val accent: Int)

internal data class ConceptCardStyle(
    val palette: ConceptPalette,
    val fontSp: Float,
    val horizontalPaddingDp: Int,
    val verticalPaddingDp: Int,
    val radiusDp: Int,
    val rotationDegrees: Float,
    val outlined: Boolean,
)

internal data class ConceptCardMetrics(
    val body: ConceptSize,
    val footprint: ConceptSize,
    val rotationDegrees: Float,
)

internal object BooksConceptStyles {
    val palettes = listOf(
        ConceptPalette(0xff302719.toInt(), 0xffa18738.toInt(), 0xffffce1b.toInt()),
        ConceptPalette(0xff252f21.toInt(), 0xff788d59.toInt(), 0xffd4e2ac.toInt()),
        ConceptPalette(0xff242e39.toInt(), 0xff607e9e.toInt(), 0xffbcdaf5.toInt()),
        ConceptPalette(0xff352524.toInt(), 0xff986b61.toInt(), 0xfff0c5af.toInt()),
        ConceptPalette(0xff2d2738.toInt(), 0xff8b76a5.toInt(), 0xffdfc7f6.toInt()),
        ConceptPalette(0xff203332.toInt(), 0xff568d85.toInt(), 0xffb4e2d7.toInt()),
    )

    fun assign(snippets: List<String>): List<ConceptCardStyle> {
        val random = Random(snippets.hashCode())
        val paletteOrder = palettes.shuffled(random)
        val outlineIndex = if (snippets.size >= 5 && random.nextBoolean()) random.nextInt(snippets.size) else -1
        return snippets.mapIndexed { index, snippet ->
            val length = snippet.codePointCount(0, snippet.length)
            val base = when {
                length <= 24 -> 28f
                length <= 65 -> 24f
                else -> 20f
            }
            ConceptCardStyle(
                paletteOrder[index % paletteOrder.size],
                base + random.nextInt(0, 3) - 1f,
                random.nextInt(30, 41),
                random.nextInt(24, 35),
                random.nextInt(13, 22),
                random.nextInt(-3, 4) * 0.5f,
                index == outlineIndex,
            )
        }
    }

    fun metrics(body: ConceptSize, rotationDegrees: Float, availableWidth: Int, stroke: Int): ConceptCardMetrics {
        require(body.width > 0 && body.height > 0 && stroke >= 0 && body.width + stroke <= availableWidth)
        require(rotationDegrees.isFinite() && abs(rotationDegrees) <= 2f)
        val w = body.width + stroke
        val h = body.height + stroke
        val radians = Math.toRadians(rotationDegrees.toDouble())
        val c = abs(cos(radians))
        val s = abs(sin(radians))
        val rotated = ConceptSize(ceil(w * c + h * s).toInt(), ceil(w * s + h * c).toInt())
        return if (rotated.width <= availableWidth && rotated.height <= 100_000) {
            ConceptCardMetrics(body, rotated, rotationDegrees)
        } else {
            ConceptCardMetrics(body, ConceptSize(w, h), 0f)
        }
    }
}
