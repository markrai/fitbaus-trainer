// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import kotlin.math.sin

internal object TrailRideArtwork {
    const val SOURCE_SCALE = 4
    const val PRESENTATION_SCALE = 2
    const val PRESENTATION_WIDTH = 512
    const val PRESENTATION_HEIGHT = 288

    enum class Kind { Pine, Fir, Broad, HazardTree, Bush, Grass, Flowers, Rock, Stone, Flag, Tortoise }

    fun create(kind: Kind, width: Int, height: Int, stride: Int = 0, facingRight: Boolean = true): Bitmap {
        val bitmap = Bitmap.createBitmap(width * SOURCE_SCALE, height * SOURCE_SCALE, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.scale(SOURCE_SCALE.toFloat(), SOURCE_SCALE.toFloat())
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { isDither = true }
        val w = width.toFloat()
        val h = height.toFloat()
        when (kind) {
            Kind.Pine -> conifer(canvas, paint, w, h, false, false)
            Kind.Fir -> conifer(canvas, paint, w, h, true, false)
            Kind.HazardTree -> conifer(canvas, paint, w, h, false, true)
            Kind.Broad -> broadleaf(canvas, paint, w, h)
            Kind.Bush -> bush(canvas, paint, w, h)
            Kind.Grass -> grass(canvas, paint, w, h, false)
            Kind.Flowers -> grass(canvas, paint, w, h, true)
            Kind.Rock -> rock(canvas, paint, w, h, false)
            Kind.Stone -> rock(canvas, paint, w, h, true)
            Kind.Flag -> flag(canvas, paint, w, h)
            Kind.Tortoise -> {
                val saved = canvas.save()
                if (!facingRight) canvas.scale(-1f, 1f, w * 0.5f, h * 0.5f)
                tortoise(canvas, paint, w, h, stride)
                canvas.restoreToCount(saved)
            }
        }
        return bitmap
    }

    fun hazed(source: Bitmap, amount: Float): Bitmap {
        val width = source.width
        val height = source.height
        val colors = IntArray(width * height)
        source.getPixels(colors, 0, width, 0, 0, width, height)
        val haze = Color.rgb(176, 191, 178)
        for (i in colors.indices) {
            val c = colors[i]
            val alpha = c ushr 24
            if (alpha != 0) {
                val softened = TrailSprites.blend(c, haze, amount)
                colors[i] = (alpha shl 24) or (softened and 0x00FFFFFF)
            }
        }
        return Bitmap.createBitmap(colors, width, height, Bitmap.Config.ARGB_8888)
    }

    private fun conifer(c: Canvas, p: Paint, w: Float, h: Float, fir: Boolean, hazard: Boolean) {
        val trunkTop = if (hazard) h * 0.43f else h * 0.76f
        val trunkWidth = if (hazard) w * 0.26f else w * 0.105f
        p.shader = LinearGradient(w * 0.37f, 0f, w * 0.68f, 0f,
            Color.rgb(46, 43, 35), Color.rgb(141, 112, 79), Shader.TileMode.CLAMP)
        c.drawRoundRect(w * 0.5f - trunkWidth, trunkTop, w * 0.5f + trunkWidth, h,
            trunkWidth * 0.35f, trunkWidth * 0.35f, p)
        p.shader = null
        p.color = Color.rgb(55, 48, 36)
        p.strokeWidth = 0.3f
        c.drawLine(w * 0.49f, trunkTop, w * 0.45f, h * 0.96f, p)
        val layers = if (hazard) 5 else 7
        val heightBase = if (hazard) h * 0.59f else h * 0.84f
        for (tier in layers - 1 downTo 0) {
            val f = tier.toFloat() / (layers - 1).coerceAtLeast(1)
            val top = h * 0.04f + f * heightBase * 0.65f
            val bottom = h * 0.20f + f * heightBase * 0.85f
            val half = w * (0.13f + f * 0.37f)
            val path = Path()
            path.moveTo(w * 0.5f, top)
            path.lineTo(w * 0.5f + half * 0.46f, bottom * 0.69f + top * 0.31f)
            path.lineTo(w * 0.5f + half * 0.78f, bottom * 0.89f + top * 0.11f)
            path.lineTo(w * 0.5f + half, bottom)
            path.lineTo(w * 0.5f, bottom - h * 0.035f)
            path.lineTo(w * 0.5f - half, bottom)
            path.lineTo(w * 0.5f - half * 0.71f, bottom * 0.84f + top * 0.16f)
            path.lineTo(w * 0.5f - half * 0.49f, bottom * 0.69f + top * 0.31f)
            path.close()
            val dark = if (fir) Color.rgb(22, 57, 57) else Color.rgb(28, 63, 44)
            val light = if (fir) Color.rgb(89, 139, 112) else Color.rgb(108, 146, 83)
            p.shader = LinearGradient(w * 0.15f, top, w * 0.89f, bottom, dark, light, Shader.TileMode.CLAMP)
            c.drawPath(path, p)
            p.shader = null
            p.color = if (fir) Color.rgb(133, 169, 139) else Color.rgb(154, 170, 115)
            p.alpha = 132
            p.strokeWidth = 0.45f
            c.drawLine(w * 0.54f, top + h * 0.035f,
                w * 0.5f + half * 0.68f, bottom - h * 0.035f, p)
            p.alpha = 255
        }
    }

    private fun broadleaf(c: Canvas, p: Paint, w: Float, h: Float) {
        p.shader = LinearGradient(w * 0.40f, 0f, w * 0.60f, 0f,
            Color.rgb(60, 49, 38), Color.rgb(147, 111, 78), Shader.TileMode.CLAMP)
        c.drawRoundRect(w * 0.42f, h * 0.43f, w * 0.60f, h, w * 0.06f, w * 0.06f, p)
        p.shader = null
        val lobes = arrayOf(
            floatArrayOf(0.27f, 0.44f, 0.25f, 0.30f),
            floatArrayOf(0.69f, 0.40f, 0.26f, 0.30f),
            floatArrayOf(0.47f, 0.23f, 0.33f, 0.28f),
            floatArrayOf(0.37f, 0.54f, 0.29f, 0.21f),
            floatArrayOf(0.65f, 0.53f, 0.24f, 0.23f),
        )
        for ((i, v) in lobes.withIndex()) {
            val cx = w * v[0]
            val cy = h * v[1]
            val rx = w * v[2]
            val ry = h * v[3]
            p.shader = LinearGradient(cx - rx, cy - ry, cx + rx, cy + ry,
                if (i % 2 == 0) Color.rgb(52, 94, 56) else Color.rgb(42, 80, 49),
                if (i % 2 == 0) Color.rgb(125, 162, 88) else Color.rgb(99, 146, 78),
                Shader.TileMode.CLAMP)
            c.drawOval(cx - rx, cy - ry, cx + rx, cy + ry, p)
        }
        p.shader = null
        p.color = Color.argb(146, 188, 197, 127)
        for (i in 0..7) {
            val t = i * 2.39996f
            val x = w * (0.50f + 0.30f * kotlin.math.sin(t))
            val y = h * (0.35f + 0.19f * kotlin.math.sin(t * 0.64f + 1f))
            c.drawOval(x - w * 0.055f, y - h * 0.028f, x + w * 0.055f, y + h * 0.028f, p)
        }
    }

    private fun bush(c: Canvas, p: Paint, w: Float, h: Float) {
        p.color = Color.argb(110, 33, 53, 34)
        c.drawOval(0f, h * 0.74f, w, h, p)
        val sizes = floatArrayOf(0.27f, 0.36f, 0.48f, 0.65f, 0.77f)
        for (i in sizes.indices) {
            val x = w * sizes[i]
            val cy = h * (0.53f + 0.07f * (i % 2))
            val radius = h * (0.35f + 0.025f * (i % 3))
            p.shader = LinearGradient(x - radius, cy - radius, x + radius, cy + radius,
                Color.rgb(44, 88, 49), Color.rgb(113, 158, 77), Shader.TileMode.CLAMP)
            c.drawCircle(x, cy, radius, p)
        }
        p.shader = null
    }

    private fun grass(c: Canvas, p: Paint, w: Float, h: Float, flowers: Boolean) {
        p.style = Paint.Style.STROKE
        p.strokeCap = Paint.Cap.ROUND
        for (i in 0..7) {
            val x = w * (i + 0.5f) / 8f
            val sway = if (i % 2 == 0) -1f else 1f
            p.color = if (i % 3 == 0) Color.rgb(104, 151, 69) else Color.rgb(54, 104, 56)
            p.strokeWidth = 0.65f
            c.drawLine(x, h * 0.95f, x + sway * w * 0.10f, h * (0.12f + 0.08f * (i % 4)), p)
        }
        p.style = Paint.Style.FILL
        if (flowers) {
            for (i in 0..2) {
                val x = w * (0.25f + i * 0.25f)
                val y = h * (0.18f + (i % 2) * 0.14f)
                p.color = if (i == 1) Color.rgb(243, 225, 176) else Color.rgb(236, 183, 100)
                c.drawCircle(x, y, 0.77f, p)
                p.color = Color.rgb(175, 111, 44)
                c.drawCircle(x, y, 0.25f, p)
            }
        }
    }

    private fun rock(c: Canvas, p: Paint, w: Float, h: Float, stone: Boolean) {
        p.color = Color.argb(105, 42, 42, 39)
        c.drawOval(w * 0.05f, h * 0.72f, w * 0.95f, h * 0.98f, p)
        val path = Path()
        path.moveTo(w * 0.07f, h * 0.74f)
        path.lineTo(w * 0.20f, h * 0.31f)
        path.lineTo(w * 0.51f, h * 0.08f)
        path.lineTo(w * 0.83f, h * 0.38f)
        path.lineTo(w * 0.95f, h * 0.79f)
        path.close()
        p.shader = LinearGradient(0f, 0f, w, h,
            if (stone) Color.rgb(178, 161, 137) else Color.rgb(184, 182, 167),
            if (stone) Color.rgb(84, 75, 64) else Color.rgb(75, 86, 81),
            Shader.TileMode.CLAMP)
        c.drawPath(path, p)
        p.shader = null
        val facet = Path()
        facet.moveTo(w * 0.20f, h * 0.31f)
        facet.lineTo(w * 0.51f, h * 0.08f)
        facet.lineTo(w * 0.55f, h * 0.65f)
        facet.lineTo(w * 0.08f, h * 0.75f)
        facet.close()
        p.color = Color.argb(110, 237, 228, 199)
        c.drawPath(facet, p)
        p.color = Color.argb(85, 47, 53, 50)
        p.strokeWidth = 0.44f
        c.drawLine(w * 0.55f, h * 0.65f, w * 0.83f, h * 0.38f, p)
    }

    private fun tortoise(c: Canvas, p: Paint, w: Float, h: Float, stride: Int) {
        val walk = if (stride == 0) -1f else 1f
        p.color = Color.argb(85, 36, 42, 30)
        c.drawOval(w * 0.08f, h * 0.86f, w * 0.96f, h * 0.99f, p)

        p.color = Color.rgb(67, 101, 57)
        c.drawOval(w * 0.16f, h * 0.67f + walk * h * 0.035f, w * 0.31f, h * 0.91f, p)
        c.drawOval(w * 0.61f, h * 0.66f - walk * h * 0.035f, w * 0.75f, h * 0.91f, p)

        p.color = Color.rgb(106, 138, 68)
        val tail = Path()
        tail.moveTo(w * 0.16f, h * 0.58f)
        tail.lineTo(w * 0.025f, h * 0.66f)
        tail.lineTo(w * 0.17f, h * 0.73f)
        tail.close()
        c.drawPath(tail, p)
        c.drawOval(w * 0.69f, h * 0.37f, w * 0.95f, h * 0.74f, p)
        c.drawOval(w * 0.85f, h * 0.47f, w * 0.98f, h * 0.68f, p)

        p.color = Color.rgb(70, 67, 43)
        c.drawRoundRect(w * 0.12f, h * 0.60f, w * 0.77f, h * 0.80f, h * 0.10f, h * 0.10f, p)
        p.shader = LinearGradient(
            w * 0.20f, h * 0.05f, w * 0.76f, h * 0.78f,
            Color.rgb(177, 192, 96), Color.rgb(53, 94, 51), Shader.TileMode.CLAMP,
        )
        val shell = Path()
        shell.moveTo(w * 0.14f, h * 0.69f)
        shell.cubicTo(w * 0.14f, h * 0.24f, w * 0.33f, h * 0.12f, w * 0.49f, h * 0.12f)
        shell.cubicTo(w * 0.66f, h * 0.12f, w * 0.77f, h * 0.37f, w * 0.78f, h * 0.69f)
        shell.close()
        c.drawPath(shell, p)
        p.shader = null
        p.style = Paint.Style.STROKE
        p.strokeWidth = 0.55f
        p.strokeJoin = Paint.Join.ROUND
        p.color = Color.rgb(55, 85, 47)
        val seams = Path()
        seams.moveTo(w * 0.35f, h * 0.18f)
        seams.lineTo(w * 0.27f, h * 0.43f)
        seams.lineTo(w * 0.34f, h * 0.69f)
        seams.moveTo(w * 0.58f, h * 0.18f)
        seams.lineTo(w * 0.66f, h * 0.43f)
        seams.lineTo(w * 0.60f, h * 0.69f)
        seams.moveTo(w * 0.27f, h * 0.43f)
        seams.lineTo(w * 0.46f, h * 0.34f)
        seams.lineTo(w * 0.66f, h * 0.43f)
        seams.moveTo(w * 0.46f, h * 0.34f)
        seams.lineTo(w * 0.47f, h * 0.66f)
        c.drawPath(seams, p)
        p.style = Paint.Style.FILL

        p.color = Color.rgb(108, 145, 70)
        c.drawOval(w * 0.19f, h * (0.70f + walk * 0.04f), w * 0.33f, h * (0.98f + walk * 0.02f), p)
        c.drawOval(w * 0.58f, h * (0.70f - walk * 0.04f), w * 0.75f, h * (0.98f - walk * 0.02f), p)
        p.color = Color.rgb(48, 66, 40)
        c.drawOval(w * 0.855f, h * 0.42f, w * 0.898f, h * 0.48f, p)
        p.color = Color.rgb(238, 237, 188)
        c.drawCircle(w * 0.87f, h * 0.437f, w * 0.009f, p)
        p.color = Color.rgb(69, 83, 47)
        p.strokeWidth = 0.36f
        c.drawLine(w * 0.90f, h * 0.635f, w * 0.95f, h * 0.623f, p)
    }

    private fun flag(c: Canvas, p: Paint, w: Float, h: Float) {
        p.color = Color.rgb(46, 52, 51)
        c.drawRoundRect(w * 0.14f, h * 0.94f, w * 0.62f, h, 0.5f, 0.5f, p)
        p.shader = LinearGradient(w * 0.24f, 0f, w * 0.46f, 0f,
            Color.rgb(97, 104, 106), Color.rgb(229, 225, 208), Shader.TileMode.CLAMP)
        c.drawRect(w * 0.24f, h * 0.05f, w * 0.38f, h * 0.95f, p)
        p.shader = null
        p.color = Color.rgb(233, 119, 58)
        val banner = Path()
        banner.moveTo(w * 0.39f, h * 0.08f)
        banner.lineTo(w, h * 0.16f)
        banner.lineTo(w * 0.39f, h * 0.45f)
        banner.close()
        c.drawPath(banner, p)
        p.color = Color.rgb(255, 215, 146)
        p.strokeWidth = 0.55f
        c.drawLine(w * 0.45f, h * 0.14f, w * 0.81f, h * 0.19f, p)
    }
}

internal class TrailRideCockpit {
    private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { isDither = true }
    private val stroke = Path()
    private val screen = RectF(120f, 115f, 136f, 127f)

    fun draw(c: Canvas, speedFraction: Float) {
        p.shader = null
        p.color = Color.rgb(19, 27, 33)
        c.drawOval(117f, 134f, 139f, 154f, p)
        p.color = Color.rgb(56, 65, 68)
        c.drawRoundRect(122f, 127f, 134f, 148f, 3f, 3f, p)
        p.shader = LinearGradient(123f, 126f, 134f, 147f, Color.rgb(101, 119, 125),
            Color.rgb(29, 38, 47), Shader.TileMode.CLAMP)
        c.drawRoundRect(124f, 128f, 132f, 148f, 2.5f, 2.5f, p)
        p.shader = null
        stroke.rewind()
        stroke.moveTo(128f, 129f)
        stroke.lineTo(94f, 123f)
        stroke.lineTo(46f, 117f)
        stroke.moveTo(128f, 129f)
        stroke.lineTo(162f, 123f)
        stroke.lineTo(210f, 117f)
        p.style = Paint.Style.STROKE
        p.strokeCap = Paint.Cap.ROUND
        p.strokeJoin = Paint.Join.ROUND
        p.strokeWidth = 7f
        p.color = Color.rgb(16, 22, 25)
        c.drawPath(stroke, p)
        p.strokeWidth = 4.4f
        p.shader = LinearGradient(0f, 117f, 0f, 128f,
            Color.rgb(120, 140, 148), Color.rgb(40, 51, 59), Shader.TileMode.CLAMP)
        c.drawPath(stroke, p)
        p.shader = null
        p.strokeWidth = 0.72f
        p.color = Color.argb(155, 196, 211, 215)
        c.drawLine(48f, 115.7f, 94f, 121.8f, p)
        c.drawLine(162f, 121.8f, 208f, 115.7f, p)
        c.drawLine(95f, 121.8f, 127f, 127.6f, p)
        c.drawLine(129f, 127.6f, 161f, 121.8f, p)
        p.style = Paint.Style.FILL
        p.color = Color.rgb(38, 42, 43)
        c.drawRoundRect(21f, 113f, 54f, 126f, 4f, 4f, p)
        c.drawRoundRect(202f, 113f, 235f, 126f, 4f, 4f, p)
        p.shader = LinearGradient(0f, 113f, 0f, 126f,
            Color.rgb(83, 90, 88), Color.rgb(16, 23, 24), Shader.TileMode.CLAMP)
        c.drawRoundRect(24f, 115f, 51f, 124f, 3f, 3f, p)
        c.drawRoundRect(205f, 115f, 232f, 124f, 3f, 3f, p)
        p.shader = null
        p.strokeWidth = 0.5f
        p.color = Color.argb(112, 159, 169, 163)
        for (i in 0..7) {
            val x = 26f + i * 3.05f
            c.drawLine(x, 116f, x + 1f, 123f, p)
            c.drawLine(230f - i * 3.05f, 116f, 229f - i * 3.05f, 123f, p)
        }
        p.color = Color.rgb(39, 45, 49)
        c.drawRoundRect(58f, 118f, 86f, 122f, 1f, 1f, p)
        c.drawRoundRect(170f, 118f, 198f, 122f, 1f, 1f, p)
        p.color = Color.rgb(162, 174, 174)
        c.drawLine(67f, 120f, 82f, 127f, p)
        c.drawLine(189f, 120f, 174f, 127f, p)
        p.color = Color.rgb(23, 30, 32)
        c.drawRoundRect(116f, 114f, 140f, 129f, 3f, 3f, p)
        p.color = Color.rgb(123, 141, 139)
        c.drawRoundRect(119f, 115f, 137f, 127f, 2f, 2f, p)
        p.color = Color.rgb(28, 49, 46)
        c.drawRoundRect(screen, 1f, 1f, p)
        p.color = Color.rgb(76, 204, 151)
        val length = 12f * speedFraction.coerceIn(0f, 1f)
        c.drawRoundRect(122f, 121f, 122f + length, 124f, 0.8f, 0.8f, p)
        p.color = Color.argb(120, 206, 252, 199)
        c.drawLine(122f, 118f, 134f, 118f, p)
    }
}
