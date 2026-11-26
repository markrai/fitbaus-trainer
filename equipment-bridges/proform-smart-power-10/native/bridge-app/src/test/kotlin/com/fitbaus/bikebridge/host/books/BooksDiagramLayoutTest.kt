// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.random.Random

class BooksDiagramLayoutTest {
    private fun graph(direction: String) = BooksDiagramGraph(direction,
        listOf("A", "B", "C", "D", "E").map { BooksDiagramNode(it, it) },
        listOf(BooksDiagramEdge("A", "B", "cause"), BooksDiagramEdge("A", "C", "effect"),
            BooksDiagramEdge("B", "D", null), BooksDiagramEdge("C", "D", null),
            BooksDiagramEdge("A", "E", "long route"), BooksDiagramEdge("D", "E", null)))

    private fun place(graph: BooksDiagramGraph): DiagramLayout {
        val sizes = graph.nodes.mapIndexed { index, node ->
            node.id to DiagramSize(112f + 8f * index, 56f + 4f * index)
        }.toMap()
        val labels = graph.edges.mapIndexedNotNull { index, edge ->
            edge.label?.let { index to DiagramSize(72f, 24f) }
        }.toMap()
        return BooksDiagramLayout.place(graph, sizes, labels)
    }

    private fun overlaps(a: DiagramRect, b: DiagramRect): Boolean =
        a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

    private fun crossesInterior(a: DiagramPoint, b: DiagramPoint, rect: DiagramRect): Boolean =
        if (a.x == b.x) a.x > rect.left && a.x < rect.right &&
            minOf(a.y, b.y) < rect.bottom && maxOf(a.y, b.y) > rect.top
        else a.y > rect.top && a.y < rect.bottom &&
            minOf(a.x, b.x) < rect.right && maxOf(a.x, b.x) > rect.left

    private fun assertGeometry(layout: DiagramLayout, graph: BooksDiagramGraph) {
        val nodes = layout.nodes.map { it.bounds }
        val labels = layout.edges.mapNotNull { it.labelBounds }
        val boxes = nodes + labels
        for ((index, box) in boxes.withIndex()) {
            assertTrue(box.left >= 0f && box.top >= 0f)
            assertTrue(box.right <= layout.size.width && box.bottom <= layout.size.height)
            assertTrue(box.width > 0f && box.height > 0f)
            for (other in boxes.drop(index + 1)) assertFalse(overlaps(box, other))
        }
        assertEquals(graph.nodes.size, layout.nodes.size)
        assertEquals(graph.edges.size, layout.edges.size)
        val byId = layout.nodes.associateBy { it.node.id }
        for (edge in layout.edges) {
            val from = byId.getValue(edge.edge.from).bounds
            val to = byId.getValue(edge.edge.to).bounds
            val start = edge.points.first()
            val end = edge.points.last()
            if (graph.direction == "TD") {
                assertEquals(from.bottom, start.y)
                assertEquals(to.top, end.y)
                assertTrue(start.x in from.left..from.right && end.x in to.left..to.right)
                assertTrue(from.bottom < to.top)
            } else {
                assertEquals(from.right, start.x)
                assertEquals(to.left, end.x)
                assertTrue(start.y in from.top..from.bottom && end.y in to.top..to.bottom)
                assertTrue(from.right < to.left)
            }
            for ((a, b) in edge.points.zipWithNext()) {
                assertTrue(a.x == b.x || a.y == b.y)
                assertFalse(a == b)
                for (node in nodes) assertFalse(crossesInterior(a, b, node))
            }
        }
    }

    @Test
    fun branchMergeAndLongEdgesAreDeterministicInBothDirections() {
        for (direction in listOf("TD", "LR")) {
            val graph = graph(direction)
            val first = place(graph)
            assertEquals(first, place(graph))
            assertGeometry(first, graph)
            assertEquals(setOf("A", "E"), first.nodes.filter { it.terminal }.map { it.node.id }.toSet())
            assertTrue(first.edges.single { it.edge.from == "A" && it.edge.to == "E" }.points.size > 4)
        }
    }

    @Test
    fun maximumGraphAndMultilingualMeasuredSizesRemainBounded() {
        for (direction in listOf("TD", "LR")) {
            val nodes = (0..9).map { BooksDiagramNode("N$it", if (it % 2 == 0) "現実の理解" else "المستقبل") }
            val edges = (0..8).map { BooksDiagramEdge("N$it", "N${it + 1}", "关系") } +
                (0..6).map { BooksDiagramEdge("N$it", "N${it + 3}", null) }
            val graph = BooksDiagramGraph(direction, nodes, edges)
            val layout = place(graph)
            assertGeometry(layout, graph)
            assertTrue(layout.size.width < 6000f && layout.size.height < 6000f)
        }
    }

    @Test
    fun seededConnectedDagsWithMixedDimensionsRemainDeterministicAndUnobstructed() {
        val random = Random(42022)
        repeat(128) {
            val count = random.nextInt(2, 11)
            val ids = (0 until count).map { "N$it" }
            val pairs = mutableSetOf<Pair<String, String>>()
            for (index in 1 until count) {
                val parent = random.nextInt(index)
                pairs.add(ids[parent] to ids[index])
            }
            val candidates = ids.flatMapIndexed { index, from ->
                ids.drop(index + 1).map { to -> from to to }
            }.filterNot { it in pairs }.shuffled(random)
            pairs.addAll(candidates.take(random.nextInt(0, minOf(16 - pairs.size, candidates.size) + 1)))
            val nodes = ids.shuffled(random).map { BooksDiagramNode(it, "Concept $it") }
            val edges = pairs.shuffled(random).map { (from, to) ->
                BooksDiagramEdge(from, to, if (random.nextBoolean()) "Relationship" else null)
            }
            val sizes = nodes.associate { node ->
                node.id to DiagramSize(random.nextInt(112, 233).toFloat(), random.nextInt(56, 180).toFloat())
            }
            val labels = edges.mapIndexedNotNull { index, edge ->
                edge.label?.let { index to DiagramSize(random.nextInt(32, 158).toFloat(), random.nextInt(24, 80).toFloat()) }
            }.toMap()
            for (direction in listOf("TD", "LR")) {
                val graph = BooksDiagramGraph(direction, nodes, edges)
                val layout = BooksDiagramLayout.place(graph, sizes, labels)
                assertEquals(layout, BooksDiagramLayout.place(graph, sizes, labels))
                assertGeometry(layout, graph)
            }
        }
    }

    @Test
    fun multipleRootsAndOneMergeDoNotRequireArtificialNodesInTheRenderedGraph() {
        val nodes = listOf("A", "B", "C", "D").map { BooksDiagramNode(it, it) }
        val edges = listOf(BooksDiagramEdge("A", "C", "first"), BooksDiagramEdge("B", "C", "second"),
            BooksDiagramEdge("C", "D", null))
        for (direction in listOf("TD", "LR")) {
            val graph = BooksDiagramGraph(direction, nodes, edges)
            val layout = place(graph)
            assertGeometry(layout, graph)
            assertEquals(setOf("A", "B", "D"), layout.nodes.filter { it.terminal }.map { it.node.id }.toSet())
        }
    }

    @Test
    fun invalidGeometryAndCyclesAreRejected() {
        val graph = graph("TD")
        assertThrows(IllegalArgumentException::class.java) {
            BooksDiagramLayout.place(graph, emptyMap(), emptyMap())
        }
        assertThrows(IllegalArgumentException::class.java) {
            place(graph.copy(edges = graph.edges + BooksDiagramEdge("E", "A", null)))
        }
    }

    @Test
    fun viewportFitsSmallGraphsAndPreservesReadableScaleForLargerOnes() {
        assertEquals(1f, BooksDiagramViewport.initialScale(DiagramSize(300f, 200f), 600f, 400f))
        assertEquals(0.8f, BooksDiagramViewport.initialScale(DiagramSize(3000f, 2000f), 600f, 400f))
        assertEquals(100f, BooksDiagramViewport.clampOffset(0f, 200f, 400f))
        assertEquals(0f, BooksDiagramViewport.clampOffset(500f, 600f, 400f))
        assertEquals(-200f, BooksDiagramViewport.clampOffset(-500f, 600f, 400f))
        assertEquals(-100f, BooksDiagramViewport.clampOffset(-100f, 600f, 400f))
    }
}
