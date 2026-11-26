// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import kotlin.math.hypot

internal class BooksDiagramView(context: Context) : View(context) {
    private val density = resources.displayMetrics.density
    private val scaledDensity = resources.displayMetrics.scaledDensity
    private val accent = 0xffffce1b.toInt()
    private val nodePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val edgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xffbfa34d.toInt()
        strokeWidth = 1.8f * density
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
    }
    private val nodeText = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xfff5f5f5.toInt()
        textSize = 20f * scaledDensity
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }
    private val edgeText = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xffd1c6a1.toInt()
        textSize = 16f * scaledDensity
    }
    private var graph: BooksDiagramGraph? = null
    private var geometry: DiagramLayout? = null
    private var nodeLabels = emptyMap<String, StaticLayout>()
    private var edgeLabels = emptyMap<Int, StaticLayout>()
    private var zoom = 1f
    private var offsetX = 0f
    private var offsetY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var activePointer = -1
    private val path = Path()
    private val zoomDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            val previous = zoom
            zoom = (zoom * detector.scaleFactor).coerceIn(0.8f, 2.5f)
            val ratio = zoom / previous
            offsetX = detector.focusX - (detector.focusX - offsetX) * ratio
            offsetY = detector.focusY - (detector.focusY - offsetY) * ratio
            clamp()
            invalidate()
            return true
        }
    })

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        isFocusable = true
        setBackgroundColor(Color.BLACK)
    }

    fun showGraph(value: BooksDiagramGraph) {
        if (graph == value && geometry != null) return
        graph = value
        val nodes = value.nodes.associate { it.id to textLayout(it.label, nodeText, 200) }
        val edges = value.edges.mapIndexedNotNull { index, edge ->
            edge.label?.let { index to textLayout(it, edgeText, 140) }
        }.toMap()
        nodeLabels = nodes
        edgeLabels = edges
        geometry = BooksDiagramLayout.place(value, nodes.mapValues { (_, layout) ->
            DiagramSize(maxOf(112f * density, layout.width + 32f * density),
                maxOf(56f * density, layout.height + 24f * density))
        }, edges.mapValues { (_, layout) ->
            DiagramSize(layout.width + 16f * density, layout.height + 8f * density)
        }, density)
        contentDescription = buildString {
            append("Visual explanation. ")
            append(value.nodes.joinToString(". ") { it.label })
            append(". Relationships: ")
            val names = value.nodes.associate { it.id to it.label }
            append(value.edges.joinToString(". ") {
                names.getValue(it.from) + " → " + names.getValue(it.to) +
                    (it.label?.let { label -> " ($label)" } ?: "")
            })
        }
        resetViewport()
        invalidate()
    }

    fun clearGraph() {
        graph = null
        geometry = null
        nodeLabels = emptyMap()
        edgeLabels = emptyMap()
        contentDescription = null
        activePointer = -1
        invalidate()
    }

    @Suppress("DEPRECATION")
    private fun textLayout(text: String, paint: TextPaint, maximumDp: Int): StaticLayout {
        val maxWidth = (maximumDp * density).toInt().coerceAtLeast(1)
        val width = kotlin.math.ceil(paint.measureText(text)).toInt().coerceIn(1, maxWidth)
        return StaticLayout(text, paint, width, Layout.Alignment.ALIGN_CENTER, 1.08f, 0f, true)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        resetViewport()
    }

    private fun resetViewport() {
        val size = geometry?.size ?: return
        if (width <= 0 || height <= 0) return
        zoom = BooksDiagramViewport.initialScale(size, width.toFloat(), height.toFloat())
        offsetX = (width - size.width * zoom) / 2f
        offsetY = (height - size.height * zoom) / 2f
        clamp()
    }

    private fun clamp() {
        val size = geometry?.size ?: return
        offsetX = BooksDiagramViewport.clampOffset(offsetX, size.width * zoom, width.toFloat())
        offsetY = BooksDiagramViewport.clampOffset(offsetY, size.height * zoom, height.toFloat())
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val layout = geometry ?: return
        canvas.save()
        canvas.translate(offsetX, offsetY)
        canvas.scale(zoom, zoom)
        for (edge in layout.edges) drawEdge(canvas, edge)
        for ((index, edge) in layout.edges.withIndex()) {
            val bounds = edge.labelBounds ?: continue
            val text = edgeLabels.getValue(index)
            nodePaint.style = Paint.Style.FILL
            nodePaint.color = 0xff111111.toInt()
            canvas.drawRoundRect(bounds.rect(), 6f * density, 6f * density, nodePaint)
            drawText(canvas, text, bounds)
        }
        for (node in layout.nodes) {
            val rect = node.bounds.rect()
            nodePaint.style = Paint.Style.FILL
            nodePaint.color = if (node.terminal) 0xff302819.toInt() else 0xff202020.toInt()
            canvas.drawRoundRect(rect, 10f * density, 10f * density, nodePaint)
            nodePaint.style = Paint.Style.STROKE
            nodePaint.strokeWidth = if (node.terminal) 1.5f * density else density
            nodePaint.color = if (node.terminal) accent else 0xff595959.toInt()
            canvas.drawRoundRect(rect, 10f * density, 10f * density, nodePaint)
            drawText(canvas, nodeLabels.getValue(node.node.id), node.bounds)
        }
        canvas.restore()
    }

    private fun drawEdge(canvas: Canvas, edge: DiagramPlacedEdge) {
        val points = edge.points
        if (points.size < 2) return
        path.reset()
        path.moveTo(points.first().x, points.first().y)
        for (point in points.drop(1)) path.lineTo(point.x, point.y)
        edgePaint.style = Paint.Style.STROKE
        canvas.drawPath(path, edgePaint)
        val end = points.last()
        val before = points[points.lastIndex - 1]
        val distance = hypot(end.x - before.x, end.y - before.y)
        if (distance <= 0f) return
        val dx = (end.x - before.x) / distance
        val dy = (end.y - before.y) / distance
        val tip = 9f * density
        val half = 4f * density
        path.reset()
        path.moveTo(end.x, end.y)
        path.lineTo(end.x - dx * tip - dy * half, end.y - dy * tip + dx * half)
        path.lineTo(end.x - dx * tip + dy * half, end.y - dy * tip - dx * half)
        path.close()
        edgePaint.style = Paint.Style.FILL
        canvas.drawPath(path, edgePaint)
    }

    private fun drawText(canvas: Canvas, text: StaticLayout, bounds: DiagramRect) {
        canvas.save()
        canvas.translate(bounds.left + (bounds.width - text.width) / 2f,
            bounds.top + (bounds.height - text.height) / 2f)
        text.draw(canvas)
        canvas.restore()
    }

    private fun DiagramRect.rect() = RectF(left, top, right, bottom)

    override fun performClick(): Boolean = super.performClick()

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (geometry == null) return false
        zoomDetector.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                activePointer = event.getPointerId(0)
                lastX = event.x
                lastY = event.y
                parent?.requestDisallowInterceptTouchEvent(true)
            }
            MotionEvent.ACTION_MOVE -> {
                val index = event.findPointerIndex(activePointer)
                if (index >= 0) {
                    val x = event.getX(index)
                    val y = event.getY(index)
                    if (!zoomDetector.isInProgress && event.pointerCount == 1) {
                        offsetX += x - lastX
                        offsetY += y - lastY
                        clamp()
                        invalidate()
                    }
                    lastX = x
                    lastY = y
                }
            }
            MotionEvent.ACTION_POINTER_UP -> {
                val index = if (event.actionIndex == 0) 1 else 0
                activePointer = event.getPointerId(index)
                lastX = event.getX(index)
                lastY = event.getY(index)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                activePointer = -1
                parent?.requestDisallowInterceptTouchEvent(false)
            }
        }
        return true
    }
}
