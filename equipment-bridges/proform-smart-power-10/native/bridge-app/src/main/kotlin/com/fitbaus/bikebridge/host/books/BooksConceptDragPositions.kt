package com.fitbaus.bikebridge.host.books

internal class BooksConceptDragPositions {
    private data class Position(val left: Int, val top: Int)
    private val overrides = LinkedHashMap<Int, Position>()

    fun clear() = overrides.clear()

    fun move(card: ConceptPlacement, left: Int, top: Int, width: Int, height: Int) {
        val position = clamp(card.copy(left = left, top = top), width, height)
        overrides.remove(card.index)
        overrides[card.index] = Position(position.left, position.top)
    }

    fun resolve(
        automatic: List<ConceptPlacement>,
        offsetX: Int,
        offsetY: Int,
        width: Int,
        height: Int,
    ): List<ConceptPlacement> {
        val byIndex = automatic.associateBy { it.index }
        val unmoved = automatic.filterNot { it.index in overrides }.map {
            it.copy(left = it.left + offsetX, top = it.top + offsetY)
        }
        val moved = overrides.mapNotNull { (index, position) ->
            byIndex[index]?.let { clamp(it.copy(left = position.left, top = position.top), width, height) }
        }
        return unmoved + moved
    }

    fun hitTest(cards: List<ConceptPlacement>, x: Float, y: Float): ConceptPlacement? =
        cards.asReversed().firstOrNull {
            x >= it.left && x < it.left + it.width && y >= it.top && y < it.top + it.height
        }

    private fun clamp(card: ConceptPlacement, width: Int, height: Int): ConceptPlacement =
        card.copy(left = card.left.coerceIn(0, (width - card.width).coerceAtLeast(0)),
            top = card.top.coerceIn(0, (height - card.height).coerceAtLeast(0)))
}
