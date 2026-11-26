// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

internal data class DiagramSize(val width: Float, val height: Float)
internal data class DiagramPoint(val x: Float, val y: Float)
internal data class DiagramRect(val left: Float, val top: Float, val width: Float, val height: Float) {
    val right: Float get() = left + width
    val bottom: Float get() = top + height
}
internal data class DiagramPlacedNode(val node: BooksDiagramNode, val bounds: DiagramRect, val terminal: Boolean)
internal data class DiagramPlacedEdge(val edge: BooksDiagramEdge, val points: List<DiagramPoint>, val labelBounds: DiagramRect?)
internal data class DiagramLayout(val size: DiagramSize, val nodes: List<DiagramPlacedNode>, val edges: List<DiagramPlacedEdge>)

internal object BooksDiagramLayout {
    private data class Slot(val id: String, val rank: Int, val size: DiagramSize)
    private data class Segment(val edge: Int, val from: String, val to: String, val rank: Int, val first: Boolean)
    private data class AxisRect(val main: Float, val cross: Float, val length: Float, val breadth: Float) {
        val end: Float get() = main + length
        val center: Float get() = cross + breadth / 2f
    }

    fun place(graph: BooksDiagramGraph, nodeSize: Map<String, DiagramSize>, labelSizes: Map<Int, DiagramSize>,
              unit: Float = 1f): DiagramLayout {
        require(unit.isFinite() && unit > 0f)
        require(graph.direction in setOf("TD", "LR") && graph.nodes.size in 2..10 && graph.edges.size in 1..16)
        val ids = graph.nodes.map { it.id }.toSet()
        require(ids.size == graph.nodes.size && graph.edges.all { it.from in ids && it.to in ids && it.from != it.to })
        require(graph.edges.map { it.from to it.to }.distinct().size == graph.edges.size)
        require(nodeSize.keys == ids && nodeSize.values.all { validSize(it, unit) })
        require(labelSizes.keys == graph.edges.indices.filter { graph.edges[it].label != null }.toSet() &&
            labelSizes.values.all { validSize(it, unit) })
        val vertical = graph.direction == "TD"
        fun main(size: DiagramSize) = if (vertical) size.height else size.width
        fun cross(size: DiagramSize) = if (vertical) size.width else size.height
        fun point(main: Float, cross: Float) = if (vertical) DiagramPoint(cross, main) else DiagramPoint(main, cross)
        fun rect(r: AxisRect) = if (vertical) DiagramRect(r.cross, r.main, r.breadth, r.length)
            else DiagramRect(r.main, r.cross, r.length, r.breadth)

        val ranks = linkedMapOf<String, Int>()
        val remaining = graph.nodes.map { it.id }.toMutableList()
        while (remaining.isNotEmpty()) {
            val roots = remaining.filter { id -> graph.edges.none { it.to == id && it.from !in ranks } }
            require(roots.isNotEmpty())
            for (id in roots) ranks[id] = graph.edges.filter { it.to == id }.maxOfOrNull { ranks.getValue(it.from) + 1 } ?: 0
            remaining.removeAll(roots.toSet())
        }
        val layers = List(ranks.values.maxOrNull()!! + 1) { mutableListOf<Slot>() }
        graph.nodes.forEach { node ->
            val rank = ranks.getValue(node.id)
            layers[rank].add(Slot(node.id, rank, nodeSize.getValue(node.id)))
        }
        val segments = mutableListOf<Segment>()
        for ((index, edge) in graph.edges.withIndex()) {
            val start = ranks.getValue(edge.from)
            val end = ranks.getValue(edge.to)
            var previous = edge.from
            for (rank in start + 1..end) {
                val next = if (rank == end) edge.to else "_${index}_$rank"
                if (rank < end) layers[rank].add(Slot(next, rank, DiagramSize(12f * unit, 12f * unit)))
                segments.add(Segment(index, previous, next, rank - 1, rank == start + 1))
                previous = next
            }
        }
        repeat(3) {
            for (rank in 1 until layers.size) reorder(layers[rank], layers[rank - 1], segments, true)
            for (rank in layers.lastIndex - 1 downTo 0) reorder(layers[rank], layers[rank + 1], segments, false)
        }

        val gap = 28f * unit
        val margin = 24f * unit + (labelSizes.values.maxOfOrNull { cross(it) } ?: 0f) / 2f
        val layerBreadths = layers.map { layer -> layer.sumOf { cross(it.size).toDouble() }.toFloat() + gap * (layer.size - 1) }
        val breadth = layerBreadths.maxOrNull()!! + 2f * margin
        val positions = mutableMapOf<String, AxisRect>()
        val bandCenters = mutableMapOf<Segment, Float>()
        var cursor = 24f * unit
        for ((rank, layer) in layers.withIndex()) {
            val thickness = layer.maxOf { main(it.size) }
            var offset = (breadth - layerBreadths[rank]) / 2f
            for (slot in layer) {
                val real = slot.id in ids
                val length = if (real) main(slot.size) else thickness
                positions[slot.id] = AxisRect(cursor + (thickness - length) / 2f, offset, length, cross(slot.size))
                offset += cross(slot.size) + gap
            }
            cursor += thickness
            if (rank == layers.lastIndex) continue
            cursor += 18f * unit
            val band = segments.filter { it.rank == rank }.sortedWith(compareBy<Segment> {
                positions.getValue(it.from).center
            }.thenBy { it.edge })
            for (segment in band) {
                val label = labelSizes[segment.edge].takeIf { segment.first }
                val lane = maxOf(14f * unit, (label?.let(::main) ?: 0f) + 12f * unit)
                bandCenters[segment] = cursor + lane / 2f
                cursor += lane
            }
            cursor += 18f * unit
        }
        val length = cursor + 24f * unit
        fun port(slot: String, segment: Segment, outgoing: Boolean): Float {
            val bounds = positions.getValue(slot)
            if (slot !in ids) return bounds.center
            val peers = segments.filter { if (outgoing) it.from == slot else it.to == slot }
                .sortedWith(compareBy<Segment> { positions.getValue(if (outgoing) it.to else it.from).center }.thenBy { it.edge })
            return bounds.cross + bounds.breadth * (peers.indexOf(segment) + 1f) / (peers.size + 1f)
        }
        val placedEdges = graph.edges.mapIndexed { index, edge ->
            val points = mutableListOf<DiagramPoint>()
            var labelBounds: DiagramRect? = null
            for (segment in segments.filter { it.edge == index }) {
                val from = positions.getValue(segment.from)
                val to = positions.getValue(segment.to)
                val firstCross = port(segment.from, segment, true)
                val lastCross = port(segment.to, segment, false)
                val lane = bandCenters.getValue(segment)
                points.add(point(from.end, firstCross))
                points.add(point(lane, firstCross))
                points.add(point(lane, lastCross))
                points.add(point(to.main, lastCross))
                if (segment.first) labelSizes[index]?.let { label ->
                    labelBounds = rect(AxisRect(lane - main(label) / 2f,
                        (firstCross + lastCross - cross(label)) / 2f, main(label), cross(label)))
                }
            }
            DiagramPlacedEdge(edge, points.fold(mutableListOf<DiagramPoint>()) { result, p ->
                if (result.lastOrNull() != p) result.add(p)
                result
            }, labelBounds)
        }
        val placedNodes = graph.nodes.map { node ->
            DiagramPlacedNode(node, rect(positions.getValue(node.id)),
                graph.edges.none { it.to == node.id } || graph.edges.none { it.from == node.id })
        }
        return DiagramLayout(if (vertical) DiagramSize(breadth, length) else DiagramSize(length, breadth),
            placedNodes, placedEdges)
    }

    private fun reorder(layer: MutableList<Slot>, neighbor: List<Slot>, segments: List<Segment>, down: Boolean) {
        val order = neighbor.mapIndexed { index, slot -> slot.id to index }.toMap()
        val previous = layer.mapIndexed { index, slot -> slot.id to index }.toMap()
        val barycenter = layer.associate { slot ->
            val adjacent = segments.mapNotNull {
                if (down && it.to == slot.id) order[it.from] else if (!down && it.from == slot.id) order[it.to] else null
            }
            slot.id to (if (adjacent.isEmpty()) previous.getValue(slot.id).toDouble() else adjacent.average())
        }
        layer.sortWith(compareBy<Slot> { barycenter.getValue(it.id) }.thenBy { previous.getValue(it.id) })
    }

    private fun validSize(size: DiagramSize, unit: Float): Boolean =
        size.width.isFinite() && size.height.isFinite() && size.width in unit..(2048f * unit) &&
            size.height in unit..(2048f * unit)
}

internal object BooksDiagramViewport {
    fun initialScale(content: DiagramSize, width: Float, height: Float): Float =
        minOf(1f, width / content.width, height / content.height).coerceAtLeast(0.8f)

    fun clampOffset(offset: Float, content: Float, viewport: Float): Float =
        if (content <= viewport) (viewport - content) / 2f else offset.coerceIn(viewport - content, 0f)
}
