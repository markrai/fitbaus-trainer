// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.max

internal class CyclingAnalyticsPanel(context: Context) : LinearLayout(context) {
    private val lifetimeTime = value("SPINNING TIME")
    private val lifetimeRevolutions = value("PEDAL REVOLUTIONS")
    private val lifetimeRpm = value("AVERAGE RPM")
    private val lifetimeDays = value("ACTIVE DAYS")
    private val lifetimePower = value("AVERAGE POWER", WATTS_COLOR)
    private val lifetimeWork = value("RECORDED WORK", WATTS_COLOR)
    private val weeklyTime = value("WEEKLY TIME", MINUTES_COLOR)
    private val weeklyRpm = value("AVG. RPM", RPM_COLOR)
    private val weeklyPower = value("AVG. WATTS", WATTS_COLOR)
    private val powerCoverage = text("", 11f, MUTED)
    private val since = text("Tracking starts with your first recorded ride", 11f, MUTED)
    private val previous = Button(context)
    private val next = Button(context)
    private val weekLabel = text("", 13f, Color.WHITE)
    private val chart = CyclingWeekChart(context)
    private val status = text("Loading cycling history…", 12f, MUTED)
    private var snapshot: CyclingAnalyticsSnapshot? = null
    private var monday: LocalDate = currentMonday()

    init {
        orientation = VERTICAL
        setPadding(0, dp(8), 0, 0)
        addView(text("LIFETIME CYCLING", 11f, MUTED), bottom(10))
        val metrics = LinearLayout(context).apply { orientation = HORIZONTAL }
        for (item in listOf(lifetimeTime, lifetimeRevolutions, lifetimeRpm, lifetimeDays)) {
            metrics.addView(item.container, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
        }
        addView(metrics, bottom(8))
        addView(metricRow(lifetimePower, lifetimeWork), bottom(8))
        addView(since, bottom(14))
        addView(text("WEEKLY CYCLING ACTIVITY", 11f, MUTED), bottom(6))

        val navigation = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        previous.text = "‹"
        previous.contentDescription = "Previous week"
        previous.setOnClickListener { setWeek(monday.minusWeeks(1)) }
        next.text = "›"
        next.contentDescription = "Next week"
        next.setOnClickListener { setWeek(monday.plusWeeks(1)) }
        navigation.addView(previous, LayoutParams(dp(52), LayoutParams.WRAP_CONTENT))
        weekLabel.gravity = Gravity.CENTER
        navigation.addView(weekLabel, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
        navigation.addView(next, LayoutParams(dp(52), LayoutParams.WRAP_CONTENT))
        addView(navigation, bottom(4))
        addView(chart, LayoutParams(LayoutParams.MATCH_PARENT, dp(222)))
        val legend = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER
        }
        legend.addView(text("■  Minutes", 11f, MINUTES_COLOR), LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
            rightMargin = dp(18)
        })
        legend.addView(text("■  Avg. RPM", 11f, RPM_COLOR), LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
            rightMargin = dp(18)
        })
        legend.addView(text("■  Avg. watts", 11f, WATTS_COLOR))
        addView(legend, bottom(12))
        addView(metricRow(weeklyTime, weeklyRpm, weeklyPower), bottom(8))
        addView(powerCoverage, bottom(8))
        addView(status, bottom(12))
        addView(text("Measured from fresh bike RPM and watts telemetry during spinning. Power averages use recorded power time only; work is recorded mechanical energy. Earlier history has no power data. Stored locally on this console.", 11f, MUTED))
        showWeek()
    }

    fun showLoading() {
        status.text = "Loading cycling history…"
    }

    fun showError() {
        status.text = "Could not read cycling history. Existing records have not been erased."
    }

    fun showSnapshot(nextSnapshot: CyclingAnalyticsSnapshot) {
        snapshot = nextSnapshot
        lifetimeTime.display.text = formatDuration(nextSnapshot.spinningMs)
        lifetimeRevolutions.display.text = String.format(Locale.US, "%,.0f", nextSnapshot.revolutions)
        lifetimeRpm.display.text = if (nextSnapshot.spinningMs > 0L) String.format(Locale.US, "%.1f", nextSnapshot.averageRpm) else "—"
        lifetimeDays.display.text = nextSnapshot.activeDays.toString()
        lifetimePower.display.text = formatWatts(nextSnapshot.averageWatts)
        lifetimeWork.display.text = nextSnapshot.workKj?.let { String.format(Locale.US, "%,.1f kJ", it) } ?: "—"
        since.text = nextSnapshot.trackingSince?.let { "Tracking since " + it.format(DATE_FORMAT) }
            ?: "Tracking starts with your first recorded ride"
        status.text = if (nextSnapshot.spinningMs == 0L) "No spinning recorded yet." else ""
        showWeek()
    }

    private fun setWeek(target: LocalDate) {
        val current = currentMonday()
        if (target > current) return
        val first = snapshot?.trackingSince?.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
        if (first != null && target < first) return
        monday = target
        showWeek()
    }

    private fun showWeek() {
        val current = currentMonday()
        if (monday > current) monday = current
        val first = snapshot?.trackingSince?.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
        if (first != null && monday < first) monday = first
        val end = monday.plusDays(6)
        weekLabel.text = monday.format(WEEK_FORMAT) + " – " + end.format(DATE_FORMAT)
        previous.isEnabled = first != null && monday > first
        next.isEnabled = monday < current
        val days = snapshot?.week(monday) ?: (0L..6L).map {
            val day = monday.plusDays(it)
            CyclingDailyTotal(day, 0L, 0L)
        }
        chart.showDays(days)
        val week = CyclingAnalyticsSnapshot(days.associateBy { it.date })
        weeklyTime.display.text = formatDuration(week.spinningMs)
        weeklyRpm.display.text = if (week.spinningMs > 0L) String.format(Locale.US, "%.1f", week.averageRpm) else "—"
        weeklyPower.display.text = formatWatts(week.averageWatts)
        powerCoverage.text = when {
            snapshot == null -> ""
            week.spinningMs == 0L -> ""
            week.powerMs == 0L -> "No power recorded for this week."
            week.powerMs < week.spinningMs -> "Power coverage: ${week.powerMs * 100 / week.spinningMs}% of spinning time."
            else -> ""
        }
        powerCoverage.visibility = if (powerCoverage.text.isEmpty()) GONE else VISIBLE
    }

    private fun metricRow(vararg items: Metric) = LinearLayout(context).apply {
        orientation = HORIZONTAL
        for (item in items) addView(item.container, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    }

    private fun value(title: String, color: Int = Color.WHITE): Metric {
        val container = LinearLayout(context).apply {
            orientation = VERTICAL
            setPadding(0, 0, dp(8), 0)
        }
        container.addView(text(title, 10f, MUTED))
        val display = text("—", 20f, color)
        display.typeface = Typeface.DEFAULT_BOLD
        container.addView(display)
        return Metric(container, display)
    }

    private fun text(value: String, size: Float, color: Int): TextView = TextView(context).apply {
        text = value
        textSize = size
        setTextColor(color)
    }

    private fun bottom(pixels: Int): LayoutParams =
        LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(pixels) }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

    private data class Metric(val container: LinearLayout, val display: TextView)

    private companion object {
        val MUTED = Color.rgb(150, 150, 150)
        val MINUTES_COLOR = Color.rgb(82, 151, 249)
        val RPM_COLOR = Color.rgb(62, 194, 159)
        val WATTS_COLOR = Color.rgb(255, 85, 85)

        fun formatWatts(watts: Double?): String = watts?.let { String.format(Locale.US, "%.0f W", it) } ?: "—"
        val DATE_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US)
        val WEEK_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("MMM d", Locale.US)

        fun currentMonday(): LocalDate =
            LocalDate.now().with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))

        fun formatDuration(milliseconds: Long): String {
            val minutes = milliseconds / 60_000L
            val hours = minutes / 60L
            return if (hours > 0L) "${hours}h ${minutes % 60L}m" else "${minutes}m"
        }
    }
}

internal class CyclingWeekChart(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var days: List<CyclingDailyTotal> = emptyList()
    private val density = resources.displayMetrics.density

    fun showDays(items: List<CyclingDailyTotal>) {
        days = items
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (days.size != 7) return
        val maxMinutes = max(30.0, ceil(days.maxOf { it.spinningMs / 60_000.0 } / 15.0) * 15.0)
        val maxRpm = max(100.0, ceil(days.maxOf { it.averageRpm } / 20.0) * 20.0)
        val maxWatts = max(100.0, ceil(days.maxOf { it.averageWatts ?: 0.0 } / 50.0) * 50.0)
        val minutesColor = Color.rgb(82, 151, 249)
        val rpmColor = Color.rgb(62, 194, 159)
        val wattsColor = Color.rgb(255, 85, 85)
        paint.textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 10f, resources.displayMetrics)
        paint.typeface = Typeface.DEFAULT
        fun scaleText(value: Double) = String.format(Locale.US, "%.0f", value)
        val minutesWidth = maxOf(paint.measureText("MIN"), paint.measureText(scaleText(maxMinutes)))
        val rpmWidth = maxOf(paint.measureText("RPM"), paint.measureText(scaleText(maxRpm)))
        val wattsWidth = maxOf(paint.measureText("W"), paint.measureText(scaleText(maxWatts)))
        val left = minutesWidth + 16f * density
        val right = width - rpmWidth - wattsWidth - 24f * density
        val top = 29f * density
        val bottom = height - 33f * density
        if (right <= left || bottom <= top) return
        val span = bottom - top
        val rpmX = right + 7f * density
        val wattsX = rpmX + rpmWidth + 10f * density
        for (step in 0..2) {
            val ratio = step / 2f
            val y = bottom - ratio * span
            paint.color = Color.rgb(55, 55, 58)
            paint.strokeWidth = density
            canvas.drawLine(left, y, right, y, paint)
            paint.color = minutesColor
            paint.textAlign = Paint.Align.RIGHT
            canvas.drawText(scaleText(maxMinutes * ratio), left - 7f * density, y + 3f * density, paint)
            paint.textAlign = Paint.Align.LEFT
            paint.color = rpmColor
            canvas.drawText(scaleText(maxRpm * ratio), rpmX, y + 3f * density, paint)
            paint.color = wattsColor
            canvas.drawText(scaleText(maxWatts * ratio), wattsX, y + 3f * density, paint)
        }
        paint.textAlign = Paint.Align.RIGHT
        paint.color = minutesColor
        canvas.drawText("MIN", left - 7f * density, top - 10f * density, paint)
        paint.textAlign = Paint.Align.LEFT
        paint.color = rpmColor
        canvas.drawText("RPM", rpmX, top - 10f * density, paint)
        paint.color = wattsColor
        canvas.drawText("W", wattsX, top - 10f * density, paint)

        val groupWidth = (right - left) / 7f
        val barWidth = minOf(13f * density, groupWidth * 0.22f)
        val gap = minOf(2f * density, groupWidth * 0.06f)
        val labels = arrayOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
        for (index in days.indices) {
            val day = days[index]
            val center = left + groupWidth * (index + 0.5f)
            fun drawBar(value: Double, maximum: Double, color: Int, offset: Int) {
                val x = center + offset * (barWidth + gap)
                val barHeight = (value / maximum * span).toFloat()
                paint.color = color
                canvas.drawRoundRect(x - barWidth / 2f, bottom - barHeight, x + barWidth / 2f, bottom,
                    2f * density, 2f * density, paint)
            }
            drawBar(day.spinningMs / 60_000.0, maxMinutes, minutesColor, -1)
            drawBar(day.averageRpm, maxRpm, rpmColor, 0)
            val watts = day.averageWatts
            if (watts != null) {
                drawBar(watts, maxWatts, wattsColor, 1)
                if (watts == 0.0) {
                    paint.color = wattsColor
                    canvas.drawCircle(center + barWidth + gap, bottom, 2f * density, paint)
                }
            }
            paint.color = Color.rgb(175, 175, 175)
            paint.textAlign = Paint.Align.CENTER
            canvas.drawText(labels[index], center, bottom + 16f * density, paint)
        }
    }
}
