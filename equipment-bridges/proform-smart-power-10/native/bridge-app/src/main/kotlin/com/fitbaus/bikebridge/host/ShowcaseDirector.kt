package com.fitbaus.bikebridge.host

import android.os.SystemClock
import android.util.Log
import com.fitbaus.arcade.HandPosition
import com.fitbaus.arcade.HandSource
import com.fitbaus.bikebridge.host.arcade.ArcadeMode
import kotlin.math.sin
import kotlin.math.roundToInt

internal data class ShowcaseScene(val mode: ArcadeMode, val seconds: Int)
internal data class ShowcaseMetrics(val rpm: Int, val watts: Int, val resistance: Int, val hr: Int)

internal class ShowcaseDirector {
    private val scenes = listOf(
        ShowcaseScene(ArcadeMode.Dashboard, 12),
        ShowcaseScene(ArcadeMode.TrailRide, 17),
        ShowcaseScene(ArcadeMode.Flak, 20),
        ShowcaseScene(ArcadeMode.GhoulRun, 24),
        ShowcaseScene(ArcadeMode.Bricks, 17),
        ShowcaseScene(ArcadeMode.Biketris, 17),
        ShowcaseScene(ArcadeMode.Math, 10),
        ShowcaseScene(ArcadeMode.YouTube, 25),
        ShowcaseScene(ArcadeMode.Books, 28),
    )
    private var began = 0L
    private var runId = ""
    var running = false
        private set
    var video = ""
        private set
    var book = ""
        private set
    fun start(id: String?, videoTitle: String?, bookTitle: String?): Boolean {
        if (id.isNullOrBlank() || videoTitle.isNullOrBlank() || bookTitle.isNullOrBlank()) return false
        runId = id
        video = videoTitle
        book = bookTitle
        began = SystemClock.elapsedRealtime()
        running = true
        Log.i(TAG, "START $runId")
        return true
    }
    private fun elapsed(): Double = if (began == 0L) 0.0 else (SystemClock.elapsedRealtime() - began) / 1000.0
    fun scene(): ShowcaseScene? {
        if (!running) return null
        var t = elapsed()
        for (scene in scenes) {
            if (t < scene.seconds) return scene
            t -= scene.seconds
        }
        return scenes.last()
    }
    fun sceneSeconds(): Double {
        var t = elapsed()
        for (scene in scenes) {
            if (t < scene.seconds) return t
            t -= scene.seconds
        }
        return scenes.last().seconds.toDouble()
    }
    fun finished(): Boolean = elapsed() >= scenes.sumOf { it.seconds }
    fun abort(reason: String) {
        running = false
        Log.e(TAG, "ABORT $runId $reason")
    }
    fun complete() {
        running = false
        Log.i(TAG, "DONE $runId")
    }
    fun telemetry(): ShowcaseMetrics {
        val t = elapsed()
        val stage = scene()
        val local = sceneSeconds()
        val burst = if (stage?.mode == ArcadeMode.Flak && local % 7.0 > 5.0) 23 else 0
        val quiet = stage?.mode == ArcadeMode.GhoulRun && local in 12.0..16.0
        val rpm = if (quiet) 0 else (77 + 5 * sin(t / 5) + 2 * sin(t * 1.4)).roundToInt() + burst
        val resistance = if (t < 30) 6 else 7
        return ShowcaseMetrics(rpm, (rpm * (1.25 + resistance * 0.04)).roundToInt(), resistance,
            (113 + 22 * (1 - kotlin.math.exp(-t / 38)) + 2 * sin(t / 12)).roundToInt())
    }
    fun position(now: Long, mode: ArcadeMode): HandPosition {
        val t = sceneSeconds()
        val x = when (mode) {
            ArcadeMode.TrailRide -> 0.5 + 0.10 * sin(t / 1.9)
            ArcadeMode.GhoulRun -> if (t < 2) 0.5 else if (t < 4) 0.18 else if (t < 6) 0.82 else 0.5 + 0.32 * sin(t / 2.4)
            ArcadeMode.Flak -> 0.46 + 0.27 * sin(t / 1.8)
            ArcadeMode.Biketris -> 0.5 + 0.35 * sin(t / 1.3)
            else -> 0.5
        }
        val y = if (mode == ArcadeMode.Flak) 0.5 + 0.33 * sin(t / 1.1) else 0.5
        return HandPosition(x.toFloat(), y.toFloat(), 1f, now, HandSource.Camera)
    }
    companion object {
        const val ACTION = "com.fitbaus.bikebridge.showcase.RUN"
        const val TAG = "FitBausShowcase"
    }
}
