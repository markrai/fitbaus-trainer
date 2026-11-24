package com.fitbaus.arcade

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.RadialGradient
import android.graphics.Shader
import java.io.File
import kotlin.random.Random

internal class ShowcaseFingerPreview(private val context: Context) {
    private val source = ArcadePreview()
    private var prior = Int.MIN_VALUE
    private val bitmap = Bitmap.createBitmap(160, 120, Bitmap.Config.ARGB_8888)
    private val pixels = IntArray(160 * 120)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val random = Random(23)

    fun preview(count: Int): ArcadePreview {
        if (count == prior) return source
        prior = count
        val canvas = Canvas(bitmap)
        val external = context.getExternalFilesDir(null)
        val fixture = external?.let { File(it, "showcase-math/${if (count < 0) "rest" else count.toString()}.jpg") }
        val photo = fixture?.takeIf { it.isFile && it.length() <= 2_000_000 }?.let {
            val options = BitmapFactory.Options().apply { inSampleSize = 4 }
            BitmapFactory.decodeFile(it.absolutePath, options)
        }
        if (photo != null) {
            canvas.drawBitmap(photo, null, RectF(0f, 0f, 160f, 120f), paint)
            photo.recycle()
        } else {
            drawFigure(canvas, count)
        }
        bitmap.getPixels(pixels, 0, 160, 0, 0, 160, 120)
        for (i in pixels.indices) {
            val c = pixels[i]
            val gray = ((Color.red(c) * 30 + Color.green(c) * 59 + Color.blue(c) * 11) / 100 + random.nextInt(-4, 5)).coerceIn(0, 255)
            pixels[i] = Color.rgb(gray, gray, gray)
        }
        source.publish(pixels, 160, 120, Float.NaN, Float.NaN, 0f, 0f, 1f, 1f, source.currentGeneration())
        return source
    }

    private fun shade(v: Int) = Color.rgb(v, v, v)
    private fun oval(canvas: Canvas, l: Float, t: Float, r: Float, b: Float, light: Int, dark: Int) {
        paint.shader = RadialGradient((l + r) / 2 - 3, (t + b) / 2 - 4, maxOf(r - l, b - t) * 0.65f, shade(light), shade(dark), Shader.TileMode.CLAMP)
        canvas.drawOval(RectF(l, t, r, b), paint)
        paint.shader = null
    }
    private fun drawFigure(c: Canvas, count: Int) {
        c.drawColor(shade(69))
        paint.color = shade(80)
        c.drawRect(7f, 0f, 10f, 120f, paint)
        c.drawRect(145f, 0f, 148f, 120f, paint)
        oval(c, 34f, 61f, 126f, 150f, 76, 28)
        oval(c, 72f, 52f, 88f, 79f, 151, 81)
        oval(c, 57f, 10f, 103f, 65f, 181, 83)
        oval(c, 55f, 7f, 103f, 29f, 58, 21)
        oval(c, 66f, 34f, 75f, 38f, 65, 40)
        oval(c, 85f, 34f, 94f, 38f, 65, 40)
        oval(c, 78f, 36f, 84f, 49f, 172, 102)
        paint.color = shade(78)
        c.drawOval(RectF(74f, 53f, 87f, 55f), paint)
        if (count < 0) return
        hand(c, 38f, minOf(5, count), false)
        hand(c, 122f, maxOf(0, count - 5), true)
    }
    private fun hand(c: Canvas, x: Float, count: Int, mirrored: Boolean) {
        oval(c, x - 10, 76f, x + 10, 122f, 156, 85)
        oval(c, x - 14, 56f, x + 14, 86f, 190, 98)
        for (i in 0..3) {
            val fx = x + (i - 1.5f) * 6f
            val extended = i < minOf(count, 4)
            val top = if (extended) 33f - (if (i == 1 || i == 2) 6f else 0f) else 57f
            oval(c, fx - 3f, top, fx + 3f, 69f, 195, 106)
        }
        val tx = x + if (mirrored) -13f else 13f
        oval(c, tx - 4f, if (count == 5) 47f else 65f, tx + 4f, 78f, 183, 97)
    }
}
