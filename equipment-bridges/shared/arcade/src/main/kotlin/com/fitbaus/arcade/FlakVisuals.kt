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
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

internal object FlakVisualGeometry {
    const val WIDTH = 256
    const val HEIGHT = 144
    const val RENDER_SCALE = 2
    const val BITMAP_WIDTH = WIDTH * RENDER_SCALE
    const val BITMAP_HEIGHT = HEIGHT * RENDER_SCALE
    const val SPRITE_SCALE = 4

    fun progress(age: Float, duration: Float): Float =
        if (duration <= 0f) 1f else (age / duration).coerceIn(0f, 1f)

    fun index(x: Int, scroll: Int, length: Int): Int {
        val remainder = (x + scroll) % length
        return if (remainder < 0) remainder + length else remainder
    }

    fun opacity(progress: Float): Int {
        val rest = 1f - progress.coerceIn(0f, 1f)
        return (rest * rest * 255f).toInt().coerceIn(0, 255)
    }
}

internal class FlakVisuals {
    private val sky = Paint().apply {
        shader = LinearGradient(
            0f, 0f, 0f, 124f,
            intArrayOf(
                Color.rgb(28, 51, 75),
                Color.rgb(64, 92, 111),
                Color.rgb(134, 143, 139),
                Color.rgb(200, 163, 124),
            ),
            floatArrayOf(0f, 0.42f, 0.8f, 1f),
            Shader.TileMode.CLAMP,
        )
    }
    private val horizon = Paint().apply {
        shader = LinearGradient(
            0f, 87f, 0f, 125f,
            Color.TRANSPARENT, Color.argb(72, 248, 196, 132),
            Shader.TileMode.CLAMP,
        )
    }
    private val sand = Paint().apply {
        shader = LinearGradient(
            0f, 124f, 0f, 144f,
            Color.rgb(156, 119, 86), Color.rgb(86, 65, 53),
            Shader.TileMode.CLAMP,
        )
    }
    private val farRidge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(125, 124, 119)
    }
    private val middleRidge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(109, 100, 91)
    }
    private val nearRidge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(95, 83, 75)
    }
    private val cloud = Paint(Paint.ANTI_ALIAS_FLAG)
    private val detail = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(105, 64, 57, 53)
        strokeWidth = 0.45f
    }
    private val ridge = Path()
    private val spark = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }
    private val effect = Paint(Paint.ANTI_ALIAS_FLAG)
    private val spritePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
        isDither = true
    }
    private val destination = RectF()
    private val farHeights = FloatArray(512) { i ->
        10f + 4f * sin(i * 0.035f) + 3.2f * sin(i * 0.091f + 1.3f) +
            1.4f * sin(i * 0.19f)
    }
    private val midHeights = FloatArray(512) { i ->
        15f + 6.8f * sin(i * 0.029f + 0.4f) + 4f * sin(i * 0.087f + 2.4f)
    }
    private val nearHeights = FloatArray(512) { i ->
        5f + 2.8f * sin(i * 0.05f + 1.3f) + 1.1f * sin(i * 0.17f)
    }

    val jet = sprite(19, 10) { c, p ->
        fill(c, p, Color.rgb(25, 34, 42),
            0.1f, 4.2f, 1.4f, 3.8f, 2.1f, 0.6f, 3.4f, 0.4f,
            5.3f, 3.6f, 11.5f, 3.7f, 15.8f, 4f, 18.7f, 4.9f,
            15.7f, 5.8f, 10.1f, 6.6f, 4.9f, 7f, 2f, 6.3f, 0.5f, 6f)
        fill(c, p, Color.rgb(101, 120, 129),
            1.1f, 4.1f, 5f, 4f, 11.8f, 4.1f, 17.8f, 4.9f,
            14.6f, 5.3f, 8f, 5.5f, 2f, 5.5f)
        fill(c, p, Color.rgb(58, 77, 88),
            4.5f, 5.5f, 9.1f, 5.3f, 13.1f, 5.5f, 9.3f, 8.8f, 6.1f, 8.2f)
        fill(c, p, Color.rgb(157, 176, 178),
            2.2f, 3.8f, 4.8f, 3.7f, 11.1f, 3.8f, 14.9f, 4.1f,
            11.5f, 4.3f, 5.2f, 4.3f)
        fill(c, p, Color.rgb(21, 43, 56),
            11.2f, 3.7f, 12.1f, 2.5f, 14f, 2.4f, 15.8f, 3.9f, 15f, 4f)
        fill(c, p, Color.rgb(111, 160, 174),
            12f, 3.4f, 12.5f, 2.8f, 14f, 2.7f, 15.1f, 3.7f)
        p.color = Color.rgb(38, 47, 54)
        c.drawRect(1.3f, 4.5f, 3f, 5.5f, p)
        p.color = Color.argb(170, 228, 231, 224)
        p.strokeWidth = 0.28f
        c.drawLine(5f, 5.25f, 10f, 5.25f, p)
    }
    val bomber = sprite(21, 10) { c, p ->
        fill(c, p, Color.rgb(19, 25, 31),
            0.2f, 4f, 1.2f, 3.6f, 1.9f, 0.5f, 3f, 0.5f,
            5f, 3.4f, 12.1f, 3.5f, 17.2f, 4f, 20.7f, 4.9f,
            19f, 5.8f, 12.5f, 6.4f, 5f, 6.5f, 2.7f, 7.3f, 1.3f, 6.6f)
        fill(c, p, Color.rgb(59, 67, 73),
            1.5f, 4f, 12.8f, 4f, 19.6f, 4.9f, 17.2f, 5.5f,
            4.2f, 5.8f, 1.5f, 5.4f)
        fill(c, p, Color.rgb(41, 48, 53),
            6.2f, 5.1f, 12.6f, 4.7f, 16f, 5.1f, 11.5f, 9f, 8.7f, 8.3f)
        fill(c, p, Color.rgb(100, 112, 115),
            3.1f, 3.9f, 11.9f, 3.8f, 16.6f, 4.3f,
            13.2f, 4.5f, 4.8f, 4.5f)
        fill(c, p, Color.rgb(30, 57, 66),
            16.2f, 4.2f, 17.8f, 3.8f, 19.5f, 4.7f, 17f, 4.8f)
        for (x in floatArrayOf(6.2f, 10.1f)) {
            p.color = Color.rgb(22, 27, 30)
            c.drawOval(x, 5.5f, x + 2.7f, 7.2f, p)
        }
    }
    val missile = sprite(12, 5) { c, p ->
        fill(c, p, Color.rgb(36, 45, 50),
            0.1f, 2.5f, 2f, 1.4f, 9.3f, 1.4f, 11.7f, 2.5f,
            9.3f, 3.6f, 2f, 3.6f)
        fill(c, p, Color.rgb(165, 172, 168),
            1.8f, 2f, 9f, 2f, 10.8f, 2.5f, 9f, 2.75f, 1.8f, 2.75f)
        fill(c, p, Color.rgb(53, 64, 68),
            8.7f, 1.5f, 10.5f, 0f, 10.2f, 2f, 8.7f, 2.1f)
        fill(c, p, Color.rgb(44, 54, 59),
            8.7f, 3.4f, 10.5f, 5f, 10.2f, 3.1f)
        p.color = Color.rgb(156, 62, 50)
        c.drawRect(10.5f, 2f, 11.6f, 3f, p)
    }
    val turret = sprite(13, 10) { c, p ->
        fill(c, p, Color.rgb(42, 42, 38),
            1f, 7.4f, 2.1f, 5.4f, 9.9f, 5.4f, 12f, 7.3f,
            11.3f, 9.8f, 0.7f, 9.8f)
        fill(c, p, Color.rgb(91, 88, 79),
            2.1f, 6.3f, 9.6f, 6.2f, 10.8f, 7.4f, 9.9f, 8.6f, 2f, 8.5f)
        fill(c, p, Color.rgb(28, 36, 36),
            5.2f, 6.3f, 5.9f, 4.2f, 8.2f, 1f, 9f, 1.5f,
            7f, 5f, 7f, 6.5f)
        fill(c, p, Color.rgb(153, 149, 129),
            6.3f, 4.3f, 8.2f, 1.6f, 8.55f, 1.8f, 6.8f, 4.7f)
        p.color = Color.rgb(35, 39, 35)
        c.drawOval(4.1f, 4.5f, 8.5f, 7.1f, p)
        p.color = Color.rgb(111, 111, 99)
        c.drawOval(4.7f, 4.9f, 7.9f, 6.5f, p)
    }
    val bomb = sprite(6, 7) { c, p ->
        fill(c, p, Color.rgb(32, 37, 40),
            2.2f, 0.2f, 3.8f, 0.2f, 4.4f, 1.8f, 4.1f, 4.8f,
            3f, 6.8f, 1.9f, 4.8f, 1.6f, 1.8f)
        fill(c, p, Color.rgb(136, 144, 139),
            2.2f, 1.8f, 3.1f, 1.1f, 3.5f, 5f, 2.9f, 5.8f)
        p.color = Color.rgb(73, 82, 81)
        c.drawRect(1f, 0.9f, 5f, 1.4f, p)
    }

    fun drawBackground(c: Canvas, scroll: Float, groundTop: Float) {
        c.drawRect(0f, 0f, FlakVisualGeometry.WIDTH.toFloat(), groundTop, sky)
        for (i in 0..5) {
            val x = ((i * 77f + 31f - scroll * 0.045f) % 350f + 350f) % 350f - 34f
            val y = 12f + (i * 19) % 67
            cloud.color = Color.argb(13, 243, 236, 223)
            c.drawOval(x - 24f, y - 3.3f, x + 34f, y + 3.1f, cloud)
            cloud.color = Color.argb(12, 231, 226, 212)
            c.drawOval(x - 16f, y - 5f, x + 18f, y + 2.4f, cloud)
        }
        c.drawRect(0f, 87f, FlakVisualGeometry.WIDTH.toFloat(), groundTop, horizon)
        drawRidge(c, farHeights, (scroll * 0.15f).toInt(), groundTop, farRidge)
        drawRidge(c, midHeights, (scroll * 0.37f).toInt(), groundTop, middleRidge)
        drawRidge(c, nearHeights, (scroll * 0.62f).toInt(), groundTop, nearRidge)
        c.drawRect(0f, groundTop, FlakVisualGeometry.WIDTH.toFloat(), FlakVisualGeometry.HEIGHT.toFloat(), sand)
        val offset = scroll % 26f
        for (i in -1..11) {
            val x = i * 26f - offset
            detail.color = Color.argb(96, 56, 49, 45)
            c.drawLine(x, groundTop + 6f, x + 9f, groundTop + 7.2f, detail)
            detail.color = Color.argb(58, 220, 188, 141)
            c.drawLine(x + 7f, groundTop + 14f, x + 17f, groundTop + 14.5f, detail)
        }
        for (i in 0..14) {
            val x = ((i * 21f - scroll * 0.85f) % 302f + 302f) % 302f - 20f
            val y = groundTop + 3f + (i * 7 % 15)
            detail.color = Color.argb(94, 62, 60, 50)
            c.drawLine(x - 1f, y + 0.4f, x, y - 0.8f, detail)
            c.drawLine(x, y - 0.8f, x + 1f, y + 0.4f, detail)
        }
    }

    private fun drawRidge(c: Canvas, heights: FloatArray, offset: Int, groundTop: Float, paint: Paint) {
        ridge.rewind()
        ridge.moveTo(0f, groundTop)
        for (x in 0..FlakVisualGeometry.WIDTH step 3) {
            val height = heights[FlakVisualGeometry.index(x, offset, heights.size)]
            ridge.lineTo(x.toFloat(), groundTop - height)
        }
        ridge.lineTo(FlakVisualGeometry.WIDTH.toFloat(), groundTop)
        ridge.close()
        c.drawPath(ridge, paint)
    }

    fun drawJet(c: Canvas, x: Float, y: Float, boosting: Boolean, time: Float) {
        if (boosting) {
            val pulse = 0.7f + 0.3f * sin(time * 24f)
            effect.color = Color.argb(80, 255, 154, 56)
            c.drawOval(x - 16f, y - 3f, x - 6f, y + 3f, effect)
            effect.color = Color.rgb(247, 143, 60)
            c.drawOval(x - 13f - 2.5f * pulse, y - 1.7f, x - 7.5f, y + 1.7f, effect)
            effect.color = Color.rgb(255, 226, 160)
            c.drawOval(x - 11f - 1.8f * pulse, y - 0.65f, x - 8f, y + 0.65f, effect)
        }
        sprite(c, jet, x, y, 19f, 10f)
    }

    fun drawBomber(c: Canvas, x: Float, y: Float) = sprite(c, bomber, x, y, 21f, 10f)

    fun drawMissile(c: Canvas, x: Float, y: Float, time: Float) {
        val pulse = 0.7f + 0.3f * sin(time * 19f)
        effect.color = Color.argb(76, 54, 55, 56)
        c.drawOval(x + 4f, y - 1.8f, x + 13f, y + 1.8f, effect)
        effect.color = Color.rgb(251, 139, 57)
        c.drawOval(x + 5f, y - 0.85f, x + 7f + pulse * 2f, y + 0.85f, effect)
        sprite(c, missile, x, y, 12f, 5f)
    }

    fun drawTurret(c: Canvas, x: Float, groundTop: Float) =
        sprite(c, turret, x, groundTop - 5f, 13f, 10f)

    fun drawBomb(c: Canvas, x: Float, y: Float) = sprite(c, bomb, x, y, 6f, 7f)

    fun drawShell(c: Canvas, x: Float, y: Float, terminal: Boolean, flash: Boolean) {
        val radius = if (terminal) 3.5f else 2.1f
        effect.color = Color.argb(if (flash) 110 else 60, 255, 153, 63)
        c.drawCircle(x, y, radius + 2.2f, effect)
        effect.color = if (terminal) Color.rgb(254, 116, 54) else Color.rgb(254, 184, 96)
        c.drawCircle(x, y, radius, effect)
        effect.color = Color.rgb(255, 239, 196)
        c.drawCircle(x, y, radius * 0.38f, effect)
    }

    fun drawExplosion(c: Canvas, x: Float, y: Float, age: Float, duration: Float, flak: Boolean) {
        val t = FlakVisualGeometry.progress(age, duration)
        val fade = FlakVisualGeometry.opacity(t)
        val radius = (if (flak) 5.5f else 4.5f) + 4.6f * t
        if (t < 0.38f) {
            effect.color = Color.argb(((1f - t / 0.38f) * 190f).toInt(), 255, 181, 84)
            c.drawCircle(x, y, radius * (1f - 0.23f * t), effect)
            effect.color = Color.argb(((1f - t / 0.38f) * 220f).toInt(), 255, 239, 199)
            c.drawCircle(x, y, radius * (0.42f - 0.28f * t), effect)
        }
        for (i in 0..6) {
            val angle = i * (PI.toFloat() * 2f / 7f) + x * 0.033f + y * 0.017f
            val radial = radius * (0.35f + 0.16f * (i % 3))
            val sx = x + cos(angle) * radial
            val sy = y + sin(angle) * radial * 0.75f
            effect.color = Color.argb((fade * 0.73f).toInt(), 66 + i * 4, 62 + i * 3, 60 + i * 3)
            c.drawCircle(sx, sy, radius * (0.27f + (i % 3) * 0.035f), effect)
        }
        spark.strokeWidth = 0.7f
        spark.color = Color.argb((fade * 0.85f).toInt(), 255, 173, 95)
        for (i in 0..5) {
            val angle = i * (PI.toFloat() / 3f) + y * 0.051f
            val inner = radius * 0.62f
            val outer = radius * (0.96f + 0.12f * (i % 2))
            c.drawLine(
                x + cos(angle) * inner, y + sin(angle) * inner,
                x + cos(angle) * outer, y + sin(angle) * outer, spark,
            )
        }
    }

    fun drawTrail(c: Canvas, x: Float, y: Float, radius: Float, alpha: Int) {
        effect.color = Color.argb(alpha.coerceIn(0, 255), 169, 161, 149)
        c.drawCircle(x, y, radius, effect)
    }

    private fun sprite(c: Canvas, bitmap: Bitmap, x: Float, y: Float, w: Float, h: Float) {
        destination.set(x - w * 0.5f, y - h * 0.5f, x + w * 0.5f, y + h * 0.5f)
        c.drawBitmap(bitmap, null, destination, spritePaint)
    }

    private fun sprite(w: Int, h: Int, draw: (Canvas, Paint) -> Unit): Bitmap {
        val bitmap = Bitmap.createBitmap(
            w * FlakVisualGeometry.SPRITE_SCALE,
            h * FlakVisualGeometry.SPRITE_SCALE,
            Bitmap.Config.ARGB_8888,
        )
        val c = Canvas(bitmap)
        c.scale(FlakVisualGeometry.SPRITE_SCALE.toFloat(), FlakVisualGeometry.SPRITE_SCALE.toFloat())
        draw(c, Paint(Paint.ANTI_ALIAS_FLAG).apply { isDither = true })
        return bitmap
    }

    private fun fill(c: Canvas, p: Paint, color: Int, vararg points: Float) {
        val polygon = Path()
        polygon.moveTo(points[0], points[1])
        var i = 2
        while (i < points.size) {
            polygon.lineTo(points[i], points[i + 1])
            i += 2
        }
        polygon.close()
        p.color = color
        c.drawPath(polygon, p)
    }
}
