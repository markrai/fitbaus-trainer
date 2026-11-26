package com.fitbaus.bikebridge.host.books

import kotlin.random.Random

internal data class ConceptPalette(val fill: Int, val border: Int, val accent: Int)

internal data class ConceptCardStyle(
    val palette: ConceptPalette,
    val fontSp: Float,
    val horizontalPaddingDp: Int,
    val verticalPaddingDp: Int,
    val radiusDp: Int,
)

internal data class ConceptCardMetrics(
    val body: ConceptSize,
    val footprint: ConceptSize,
)

internal object BooksConceptStyles {
    val palettes = listOf(
        ConceptPalette(0xff493b22.toInt(), 0xffa18738.toInt(), 0xffffce1b.toInt()),
        ConceptPalette(0xff35472c.toInt(), 0xff788d59.toInt(), 0xffd4e2ac.toInt()),
        ConceptPalette(0xff31475d.toInt(), 0xff607e9e.toInt(), 0xffbcdaf5.toInt()),
        ConceptPalette(0xff51332f.toInt(), 0xff986b61.toInt(), 0xfff0c5af.toInt()),
        ConceptPalette(0xff41344e.toInt(), 0xff8b76a5.toInt(), 0xffdfc7f6.toInt()),
        ConceptPalette(0xff2e4946.toInt(), 0xff568d85.toInt(), 0xffb4e2d7.toInt()),
    )

    fun assign(snippets: List<String>): List<ConceptCardStyle> {
        val random = Random(snippets.hashCode())
        val paletteOrder = palettes.shuffled(random)
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
            )
        }
    }

    fun metrics(body: ConceptSize, availableWidth: Int, stroke: Int): ConceptCardMetrics {
        require(body.width > 0 && body.height > 0 && stroke >= 0 && body.width + stroke <= availableWidth)
        return ConceptCardMetrics(body, ConceptSize(body.width + stroke, body.height + stroke))
    }
}
