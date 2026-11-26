package com.fitbaus.bikebridge.host.books

internal data class ConceptSize(val width: Int, val height: Int)
internal data class ConceptPlacement(val index: Int, val left: Int, val top: Int, val width: Int, val height: Int)
internal data class ConceptLayout(val height: Int, val placements: List<ConceptPlacement>)

internal object BooksConceptLayout {
    private class Row {
        val indices = mutableListOf<Int>()
        var width = 0
        var height = 0
    }

    fun place(sizes: List<ConceptSize>, width: Int, gap: Int): ConceptLayout {
        require(width in 1..100_000 && gap in 0..width && sizes.size <= BooksConceptValidation.MAX_CONCEPTS)
        require(sizes.all { it.width in 1..width && it.height in 1..100_000 })
        val rows = mutableListOf<Row>()
        val order = sizes.indices.sortedWith(compareByDescending<Int> { sizes[it].width }.thenBy { it })
        for (index in order) {
            val size = sizes[index]
            val row = rows.firstOrNull { it.width + gap + size.width <= width } ?: Row().also { rows.add(it) }
            if (row.indices.isNotEmpty()) row.width += gap
            row.indices.add(index)
            row.width += size.width
            row.height = maxOf(row.height, size.height)
        }
        val placed = mutableListOf<ConceptPlacement>()
        var top = 0
        for (row in rows) {
            var left = (width - row.width) / 2
            for (index in row.indices) {
                val size = sizes[index]
                placed.add(ConceptPlacement(index, left, top + (row.height - size.height) / 2, size.width, size.height))
                left += size.width + gap
            }
            top += row.height + gap
        }
        return ConceptLayout(if (rows.isEmpty()) 0 else top - gap, placed)
    }
}
