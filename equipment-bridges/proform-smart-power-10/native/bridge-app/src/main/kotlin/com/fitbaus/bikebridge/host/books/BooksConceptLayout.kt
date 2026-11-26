package com.fitbaus.bikebridge.host.books

import kotlin.math.abs
import kotlin.random.Random

internal data class ConceptSize(val width: Int, val height: Int)
internal data class ConceptPlacement(val index: Int, val left: Int, val top: Int, val width: Int, val height: Int)
internal data class ConceptLayout(val height: Int, val placements: List<ConceptPlacement>)

internal object BooksConceptLayout {
    fun place(sizes: List<ConceptSize>, width: Int, gap: Int, stagger: Int = 0, seed: Int = 0): ConceptLayout {
        require(width in 1..100_000 && gap in 0..width && sizes.size <= BooksConceptValidation.MAX_CONCEPTS)
        require(stagger in 0..100_000)
        require(sizes.all { it.width in 1..width && it.height in 1..100_000 })
        val placed = mutableListOf<ConceptPlacement>()
        val random = Random(seed)
        val startRight = random.nextBoolean()
        val order = sizes.indices.sortedWith(compareByDescending<Int> { sizes[it].width }.thenBy { it })
        for ((rank, index) in order.withIndex()) {
            val size = sizes[index]
            val free = width - size.width
            val bias = if (stagger == 0 || sizes.size == 1) 0.5 else {
                val edge = random.nextDouble(0.10, 0.28)
                if ((rank % 2 == 0) == startRight) 1.0 - edge else edge
            }
            val preferred = (free * bias).toInt()
            val offset = if (stagger > 0 && sizes.size > 1) random.nextInt(0, stagger + 1) else 0
            val candidates = linkedSetOf(preferred, 0, free, free / 2, free / 4, free * 3 / 4)
            for (other in placed) {
                candidates.add((other.left - size.width - gap).coerceIn(0, free))
                candidates.add((other.left + other.width + gap).coerceIn(0, free))
                candidates.add(other.left.coerceIn(0, free))
            }
            val obstacles = placed.sortedBy { it.top }
            val positions = candidates.map { left ->
                var top = offset
                for (other in obstacles) {
                    if (left + size.width + gap <= other.left || other.left + other.width + gap <= left) continue
                    if (top + size.height + gap <= other.top) break
                    top = maxOf(top, other.top + other.height + gap)
                }
                ConceptPlacement(index, left, top, size.width, size.height)
            }
            val earliest = positions.minOf { it.top }
            val best = positions.filter { it.top <= earliest + stagger }
                .minWithOrNull(compareBy<ConceptPlacement> { abs(it.left - preferred) }.thenBy { it.top })!!
            placed.add(best)
        }
        return ConceptLayout(placed.maxOfOrNull { it.top + it.height } ?: 0, placed)
    }
}
