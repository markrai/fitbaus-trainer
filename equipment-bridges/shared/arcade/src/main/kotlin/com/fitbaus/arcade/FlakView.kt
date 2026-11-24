// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.view.MotionEvent
import android.view.View
import java.util.Locale
import kotlin.math.ceil

internal enum class FlakHold { None, CameraStarting, CameraUnavailable, ControllerUnavailable, Calibrating, NoTelemetry, NotPedaling, Resuming }

/**
 * Decides whether the simulation may run. Any missing controller holds the game; nothing is lost while held.
 * Losing the face after calibration is not a hold: the game keeps running and the jet keeps its last steering.
 * Game over is not a hold: its 3-2-1 restart countdown runs in game time, so it pauses with any other hold.
 */
internal class FlakSupervisor(private val resumeStableMs: Long = 600L) {
    private var running = false

    fun hold(
        camera: CameraState,
        face: FaceControlReading,
        cadence: CadenceReading,
        source: FlakInputSource = FlakInputSource.Webcam,
        controllerReady: Boolean = false,
    ): FlakHold {
        val hold = when {
            source == FlakInputSource.Controller && !controllerReady -> FlakHold.ControllerUnavailable
            source == FlakInputSource.Webcam &&
                (camera == CameraState.Unavailable || camera == CameraState.PermissionDenied) -> FlakHold.CameraUnavailable
            source == FlakInputSource.Webcam && camera != CameraState.Ready -> FlakHold.CameraStarting
            source == FlakInputSource.Webcam &&
                (face.state == FaceControlState.Calibrating ||
                    (face.state == FaceControlState.Lost && face.neutralY.isNaN())) -> FlakHold.Calibrating
            cadence.state == CadenceState.NoTelemetry || cadence.state == CadenceState.Stale -> FlakHold.NoTelemetry
            cadence.state == CadenceState.Stopped -> FlakHold.NotPedaling
            source == FlakInputSource.Webcam && !running &&
                face.state == FaceControlState.Tracking && face.stableMs < resumeStableMs -> FlakHold.Resuming
            else -> FlakHold.None
        }
        running = hold == FlakHold.None
        return hold
    }

    fun message(hold: FlakHold, cadence: CadenceReading): String? = when (hold) {
        FlakHold.None -> null
        FlakHold.CameraUnavailable -> "CAMERA UNAVAILABLE - FLAK RUN NEEDS FACE STEERING"
        FlakHold.CameraStarting -> "STARTING CAMERA..."
        FlakHold.ControllerUnavailable -> "CONTROLLER UNAVAILABLE - CHECK CONNECTION"
        FlakHold.Calibrating -> null
        FlakHold.NoTelemetry -> if (cadence.state == CadenceState.Stale) "BIKE DATA STALE - WAITING FOR RPM" else "NO BIKE DATA - WAITING FOR RPM"
        FlakHold.NotPedaling -> "PEDAL TO FLY"
        FlakHold.Resuming -> "GET READY..."
    }
}

/**
 * FLAK RUN: steer a fighter jet with small head movements (Face tracking) and escape flak by
 * briefly pedaling faster (read-only RPM). The 256x144 simulation is drawn with
 * antialiased original art into a 512x288 framebuffer. Never sends anything to the bike.
 */
public class FlakView(context: Context) : View(context) {
    public var diagnosticsOverlay: Boolean = false
    public var controllerAvailable: Boolean = false
        set(value) {
            if (field == value) return
            val prior = inputSource
            field = value
            if (prior != inputSource) onSourceChanged()
            invalidate()
        }

    private val density = resources.displayMetrics.density
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val face = VerticalFaceControl()
    private val cadence = CadenceBoost()
    private val supervisor = FlakSupervisor()
    private val game = FlakGame(random = kotlin.random.Random(1203)).also { g -> g.onEvent = { android.util.Log.i(LandmarkFrameSink.LOG_TAG, it) } }
    private val controllerSteering = FlakControllerSteering(game.config).apply { syncToJet(game.jetX, game.jetY) }
    private var selectedInput = prefs?.getString(FlakInputSelection.PREF_KEY, null)

    public val inputSource: FlakInputSource
        get() = FlakInputSelection.effective(selectedInput, controllerAvailable)

    public var onInputSourceChanged: ((FlakInputSource) -> Unit)? = null

    public fun selectInputSource(source: FlakInputSource) {
        if (source == FlakInputSource.Controller && !controllerAvailable) return
        val previous = inputSource
        selectedInput = source.name
        prefs?.edit()?.putString(FlakInputSelection.PREF_KEY, source.name)?.apply()
        if (inputSource != previous) onSourceChanged()
        invalidate()
    }

    private fun onSourceChanged() {
        game.resetClock()
        controllerSteering.syncToJet(game.jetX, game.jetY)
        face.recalibrate()
        onInputSourceChanged?.invoke(inputSource)
    }
    private var sensitivityIndex = prefs?.getInt(SENSITIVITY_KEY, DEFAULT_SENSITIVITY) ?: DEFAULT_SENSITIVITY
    private var deltaIndex = prefs?.getInt(DELTA_KEY, DEFAULT_DELTA) ?: DEFAULT_DELTA
    private var simulatedCadence = false
    private var simulatedPress = false
    private var simulatedSample = 0L
    private var hold = FlakHold.CameraStarting
    private var faceReading = FaceControlReading(FaceControlState.Lost, 0.5f, Float.NaN, 0.5f, -1L, 0L)
    private var steerY = 0.5f
    private var steerX = 0.5f
    private var cadenceReading = CadenceReading(CadenceState.NoTelemetry, null, -1L, Float.NaN, Float.NaN, 0L, 0, false)
    private var diagnosticsText = ""
    private var info: ArcadeCameraInfo? = null
    private var lastRenderNanos = Long.MIN_VALUE
    private val frameWindow = DurationWindow(60)
    private val updateWindow = DurationWindow(60)
    private var lastSteps = 0
    private var memoryText = ""
    private var memoryAtNanos = Long.MIN_VALUE

    private val fb = Bitmap.createBitmap(
        FlakVisualGeometry.BITMAP_WIDTH,
        FlakVisualGeometry.BITMAP_HEIGHT,
        Bitmap.Config.ARGB_8888,
    )
    private val fbCanvas = Canvas(fb)
    private val fbSrc = Rect(0, 0, FlakVisualGeometry.BITMAP_WIDTH, FlakVisualGeometry.BITMAP_HEIGHT)
    private val fbDst = Rect()
    private val visuals = FlakVisuals()
    private val px = Paint(Paint.ANTI_ALIAS_FLAG)
    private val scaledPaint = Paint(Paint.FILTER_BITMAP_FLAG).apply { isDither = true }
    private val hudPaint = Paint().apply {
        color = Color.WHITE
        typeface = Typeface.MONOSPACE
        isFakeBoldText = true
    }
    private val bannerPaint = Paint().apply {
        color = Color.WHITE
        typeface = Typeface.MONOSPACE
        isFakeBoldText = true
        textAlign = Paint.Align.CENTER
    }
    private val backPaint = Paint().apply { color = Color.argb(200, 0, 0, 0) }
    private val diagPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        typeface = Typeface.MONOSPACE
        textSize = 11f * density
    }
    private val meterRect = RectF()
    private val webcamRect = RectF()
    private val controllerRect = RectF()
    private val sourcePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.MONOSPACE
        isFakeBoldText = true
        textAlign = Paint.Align.CENTER
    }
    private val simRect = RectF()
    private val blastRect = RectF()

    init {
        setBackgroundColor(Color.BLACK)
        isClickable = true
        face.setGain(SENSITIVITIES[sensitivityIndex.coerceIn(0, SENSITIVITIES.size - 1)])
        cadence.setDelta(DELTAS[deltaIndex.coerceIn(0, DELTAS.size - 1)])
    }

    public fun render(
        position: HandPosition,
        camera: CameraState,
        failure: String?,
        connected: Boolean,
        initialized: Boolean,
        rpm: Int?,
        rpmCurrent: Boolean,
        rpmObservedAt: String?,
        diagnostics: String,
        cameraInfo: ArcadeCameraInfo?,
        controller: FlakControllerInput? = null,
    ) {
        val now = System.nanoTime()
        if (lastRenderNanos != Long.MIN_VALUE) frameWindow.record((now - lastRenderNanos) / 1_000_000f)
        lastRenderNanos = now
        info = cameraInfo
        diagnosticsText = if (failure != null && camera != CameraState.Ready) failure else diagnostics
        val source = inputSource
        if (source == FlakInputSource.Webcam) faceReading = face.update(position, now)
        cadenceReading = if (simulatedCadence) simulate(now) else cadence.update(connected, initialized, rpm, rpmCurrent, rpmObservedAt, now)
        hold = supervisor.hold(
            camera, faceReading, cadenceReading, source,
            controllerReady = controllerAvailable && controller != null,
        )
        val start = System.nanoTime()
        if (hold == FlakHold.None) {
            if (source == FlakInputSource.Controller && controller != null) {
                val (x, y) = controllerSteering.advance(controller, now)
                steerX = x
                steerY = y
            } else if (faceReading.state == FaceControlState.Tracking) {
                steerY = faceReading.target
                steerX = faceReading.targetX
            }
            lastSteps = game.advance(now, steerY, cadenceReading.boosting, steerX)
        } else {
            controllerSteering.pause()
            game.resetClock()
            lastSteps = 0
        }
        updateWindow.record((System.nanoTime() - start) / 1_000_000f)
        drawWorld()
        invalidate()
    }

    public fun restartGame() {
        game.restart()
        controllerSteering.syncToJet(game.jetX, game.jetY)
        face.recalibrate()
        invalidate()
    }

    public fun developerOptions(): List<String> = listOf(
        "Head sensitivity: ${SENSITIVITY_LABELS[sensitivityIndex]} (tap to change)",
        "Dash threshold: +${DELTAS[deltaIndex]} RPM above your baseline (tap to change)",
        "Recalibrate head neutral now",
        if (simulatedCadence) "Simulated cadence (dev): ON - not real pedaling" else "Simulated cadence (dev): OFF",
    )

    public fun selectDeveloperOption(index: Int) {
        when (index) {
            0 -> {
                sensitivityIndex = (sensitivityIndex + 1) % SENSITIVITIES.size
                face.setGain(SENSITIVITIES[sensitivityIndex])
                prefs?.edit()?.putInt(SENSITIVITY_KEY, sensitivityIndex)?.apply()
            }
            1 -> {
                deltaIndex = (deltaIndex + 1) % DELTAS.size
                cadence.setDelta(DELTAS[deltaIndex])
                prefs?.edit()?.putInt(DELTA_KEY, deltaIndex)?.apply()
            }
            2 -> face.recalibrate()
            3 -> {
                simulatedCadence = !simulatedCadence
                cadence.reset()
            }
        }
        invalidate()
    }

    private fun simulate(now: Long): CadenceReading {
        if (now - simulatedSample >= SIM_SAMPLE_NANOS) simulatedSample = now
        val rpm = if (simulatedPress) SIM_RPM + DELTAS[deltaIndex] + 4 else SIM_RPM
        return cadence.update(true, true, rpm, true, "sim-$simulatedSample", now, simulated = true)
    }

    private fun drawWorld() {
        val c = fbCanvas
        val cfg = game.config
        val saved = c.save()
        c.scale(FlakVisualGeometry.RENDER_SCALE.toFloat(), FlakVisualGeometry.RENDER_SCALE.toFloat())
        visuals.drawBackground(c, game.scroll, cfg.groundTop)
        for (t in game.turrets) visuals.drawTurret(c, t.x, cfg.groundTop)
        val blink = (game.elapsed * 6f).toInt() % 2 == 0
        for (t in game.turrets) {
            if (!t.fired && t.fireIn <= cfg.turretWarnSeconds && blink) {
                px.color = WARN
                c.drawCircle(t.x + 1f, cfg.groundTop - 13f, 1.7f, px)
                px.color = WARN_DIM
                c.drawLine(t.x + 1f, cfg.groundTop - 17f, t.x + 1f, cfg.groundTop - 15f, px)
            }
        }
        val fastBlink = (game.elapsed * 12f).toInt() % 2 == 0
        for (sh in game.shells) {
            for (k in 0 until Shell.TRAIL_POINTS) {
                val tx = sh.trailX[k] - game.scroll
                val ty = sh.trailY[k]
                if (ty.isNaN()) continue
                visuals.drawTrail(c, tx, ty, 0.9f, 70 + k * 8)
            }
            visuals.drawShell(c, sh.x, sh.y, sh.terminal, if (sh.terminal) fastBlink else blink)
        }
        for (m in game.missiles) {
            if (m.warn > 0f) {
                if (blink) {
                    px.color = WARN
                    c.drawRoundRect(cfg.width - 7f, m.y - 3f, cfg.width - 2f, m.y + 3f, 1f, 1f, px)
                    px.color = WARN_DIM
                    c.drawCircle(cfg.width - 8f, m.y, 1.4f, px)
                }
            } else {
                visuals.drawMissile(c, m.x, m.y, game.elapsed)
            }
        }
        for (b in game.bombers) {
            if (b.warn > 0f) {
                if (blink) {
                    px.color = WARN
                    c.drawRoundRect(2f, b.y - 3f, 7f, b.y + 3f, 1f, 1f, px)
                    px.color = WARN_DIM
                    c.drawCircle(8.2f, b.y, 1.4f, px)
                }
            } else {
                visuals.drawBomber(c, b.x, b.y)
            }
        }
        for (b in game.bombs) {
            for (k in 1..3) {
                val tx = b.x - b.vx * 0.05f * k
                val ty = b.y - b.vy * 0.05f * k
                visuals.drawTrail(c, tx, ty, 0.7f + k * 0.1f, 115 - 25 * k)
            }
            visuals.drawBomb(c, b.x, b.y)
        }
        val visible = game.invulnerable <= 0f || (game.elapsed * 12f).toInt() % 2 == 0
        if (visible && game.phase == FlakPhase.Playing) {
            visuals.drawJet(c, game.jetX, game.jetY, game.boosting, game.elapsed)
        }
        for (b in game.blasts) {
            visuals.drawExplosion(c, b.x, b.y, b.age, FlakGame.BLAST_SECONDS, b.flak)
        }
        c.restoreToCount(saved)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width
        val h = height
        if (w <= 0 || h <= 0) return
        val hud = (30f * density).toInt()
        val scale = maxOf(1, minOf(w / LOGICAL_W, (h - hud) / LOGICAL_H))
        val dw = LOGICAL_W * scale
        val dh = LOGICAL_H * scale
        val left = (w - dw) / 2
        val top = hud + (h - hud - dh) / 2
        fbDst.set(left, top, left + dw, top + dh)
        canvas.drawBitmap(fb, fbSrc, fbDst, scaledPaint)
        drawHud(canvas, left.toFloat(), top.toFloat(), dw.toFloat())
        val holdText = supervisor.message(hold, cadenceReading)
        if (holdText != null) {
            banner(canvas, holdText, w / 2f, top + dh * 0.45f, 7f * scale, scale)
        } else if (inputSource == FlakInputSource.Webcam &&
            faceReading.state == FaceControlState.Lost && game.phase == FlakPhase.Playing) {
            banner(canvas, "FACE LOST - LOOK AT THE SCREEN TO STEER", w / 2f, top + dh * 0.12f, 4f * scale, scale)
        } else if (game.phase == FlakPhase.GameOver) {
            banner(canvas, String.format(Locale.US, "GAME OVER  -  SCORE %06d", game.score), w / 2f, top + dh * 0.32f, 7f * scale, scale)
            val count = ceil(game.restartIn.toDouble()).toInt().coerceIn(1, 3)
            banner(canvas, count.toString(), w / 2f, top + dh * 0.62f, 22f * scale, scale)
        }
        if (simulatedCadence) drawSimButton(canvas, left + dw.toFloat(), top + dh.toFloat(), scale)
        if (diagnosticsOverlay) drawOverlay(canvas, left.toFloat() + 4f * density, top.toFloat() + 14f * scale)
    }

    private fun banner(canvas: Canvas, text: String, cx: Float, cy: Float, size: Float, scale: Int) {
        bannerPaint.textSize = size
        val half = bannerPaint.measureText(text) / 2f + 4f * scale
        canvas.drawRect(cx - half, cy - size, cx + half, cy + size * 0.25f + 2f * scale, backPaint)
        canvas.drawText(text, cx, cy, bannerPaint)
    }

    private fun drawHud(canvas: Canvas, left: Float, top: Float, width: Float) {
        hudPaint.textSize = 16f * density
        hudPaint.color = Color.WHITE
        val baseline = top - 8f * density
        val scoreLeft = drawInputSourceSelector(canvas, left, baseline)
        canvas.drawText(String.format(Locale.US, "SCORE %06d", game.score), scoreLeft, baseline, hudPaint)
        val livesX = scoreLeft + hudPaint.measureText("SCORE 000000  ")
        for (i in 0 until game.config.lives) {
            px.color = if (i < game.lives) Color.rgb(218, 119, 77) else Color.rgb(74, 75, 76)
            canvas.drawRoundRect(
                livesX + i * 22f * density, baseline - 12f * density,
                livesX + i * 22f * density + 16f * density, baseline - 2f * density,
                2f * density, 2f * density, px,
            )
        }
        val c = cadenceReading
        val meterW = 180f * density
        val meterLeft = left + width - meterW
        meterRect.set(meterLeft, baseline - 14f * density, meterLeft + meterW, baseline)
        px.color = Color.rgb(40, 40, 40)
        canvas.drawRoundRect(meterRect, 3f * density, 3f * density, px)
        val shown = when (c.state) {
            CadenceState.Boosting -> 1f
            CadenceState.Cruising -> if (c.baseline.isNaN() || c.rpm == null) 0f else ((c.rpm - c.baseline) / (c.threshold - c.baseline)).coerceIn(0f, 1f)
            CadenceState.Establishing, CadenceState.Recovering -> c.steadyProgress
            else -> 0f
        }
        px.color = when (c.state) {
            CadenceState.Boosting -> Color.rgb(252, 160, 68)
            CadenceState.Cruising -> Color.rgb(0, 200, 90)
            CadenceState.Establishing, CadenceState.Recovering -> Color.rgb(60, 140, 200)
            else -> Color.rgb(110, 110, 110)
        }
        if (shown > 0f) canvas.drawRoundRect(
            meterRect.left, meterRect.top, meterRect.left + meterW * shown, meterRect.bottom,
            3f * density, 3f * density, px,
        )
        val label = when (c.state) {
            CadenceState.Boosting -> "DASH!"
            CadenceState.Establishing -> "LEARNING PACE"
            CadenceState.Cruising -> "SURGE TO DASH"
            CadenceState.Recovering -> "STABILIZE PACE"
            else -> "DASH --"
        }
        hudPaint.textSize = 12f * density
        val labelText = if (c.simulated) "SIM $label" else label
        canvas.drawText(labelText, meterLeft - hudPaint.measureText(labelText) - 8f * density, baseline - 2f * density, hudPaint)
    }

    private fun drawInputSourceSelector(canvas: Canvas, left: Float, baseline: Float): Float {
        val top = baseline - 17f * density
        val height = 23f * density
        val gap = 5f * density
        webcamRect.set(left, top, left + 44f * density, top + height)
        controllerRect.set(webcamRect.right + gap, top, webcamRect.right + gap + 74f * density, top + height)
        for (source in FlakInputSource.entries) {
            val rect = if (source == FlakInputSource.Webcam) webcamRect else controllerRect
            val selected = source == inputSource
            val available = source == FlakInputSource.Webcam || controllerAvailable
            px.color = when {
                selected -> Color.rgb(112, 174, 153)
                available -> Color.rgb(42, 56, 65)
                else -> Color.rgb(32, 35, 38)
            }
            canvas.drawRoundRect(rect, 4f * density, 4f * density, px)
            sourcePaint.textSize = 10f * density
            sourcePaint.color = when {
                selected -> Color.rgb(15, 31, 30)
                available -> Color.rgb(225, 230, 225)
                else -> Color.rgb(111, 118, 117)
            }
            val label = if (source == FlakInputSource.Webcam) "WEBCAM" else "CONTROLLER"
            canvas.drawText(label, rect.centerX(), rect.centerY() + 3.5f * density, sourcePaint)
        }
        return controllerRect.right + 10f * density
    }

    private fun drawSimButton(canvas: Canvas, right: Float, bottom: Float, scale: Int) {
        simRect.set(right - 120f * density, bottom - 50f * density, right - 8f * density, bottom - 8f * density)
        px.color = if (simulatedPress) Color.rgb(252, 160, 68) else Color.argb(200, 60, 60, 60)
        canvas.drawRect(simRect, px)
        bannerPaint.textSize = 4f * scale
        canvas.drawText("SIM DASH", simRect.centerX(), simRect.centerY() + bannerPaint.textSize / 3f, bannerPaint)
    }

    private fun drawOverlay(canvas: Canvas, left: Float, top: Float) {
        val now = System.nanoTime()
        if (memoryAtNanos == Long.MIN_VALUE || now - memoryAtNanos > 1_000_000_000L) {
            memoryAtNanos = now
            val runtime = Runtime.getRuntime()
            memoryText = String.format(
                Locale.US,
                "mem java %.1f MB native %.1f MB",
                (runtime.totalMemory() - runtime.freeMemory()) / 1048576f,
                android.os.Debug.getNativeHeapAllocatedSize() / 1048576f,
            )
        }
        val f = faceReading
        val c = cadenceReading
        val d = info?.diagnostics
        val lines = listOf(
            String.format(Locale.US, "face %.1f Hz  %s  noseY %.3f  neutral %s  age %d ms  stable %d ms  gain %.0f",
                d?.processedHz ?: Float.NaN, f.state, f.noseY, if (f.neutralY.isNaN()) "-" else String.format(Locale.US, "%.3f", f.neutralY),
                f.ageMs, f.stableMs, face.config.gain),
            String.format(Locale.US, "jet y %.1f (target %.2f)  x %.1f (target %.2f)  hold %s", game.jetY, f.target, game.jetX, f.targetX, hold),
            String.format(Locale.US, "rpm %s%s  age %d ms  %s  armed %s  baseline %s  threshold %s  pace %s +/-%s n %d steady %d%%  confirm %d  near-baseline %s ago  dash %d ms  dashes %d",
                c.rpm?.toString() ?: "-", if (c.simulated) " (SIMULATED)" else "", c.sampleAgeMs, c.state, if (c.armed) "yes" else "no",
                if (c.baseline.isNaN()) "-" else String.format(Locale.US, "%.1f", c.baseline),
                if (c.threshold.isNaN()) "-" else String.format(Locale.US, "%.1f", c.threshold),
                if (c.pace.isNaN()) "-" else String.format(Locale.US, "%.1f", c.pace),
                if (c.paceSpread.isNaN()) "-" else String.format(Locale.US, "%.1f", c.paceSpread),
                c.paceSamples, (c.steadyProgress * 100f).toInt(), c.confirming,
                if (c.sinceNearMs < 0) "-" else "${c.sinceNearMs} ms",
                c.boostRemainingMs, c.activations),
            String.format(Locale.US, "frame p50 %.0f / p90 %.0f ms  update p50 %.2f / p90 %.2f ms  steps %d  cpu %s  %s",
                frameWindow.percentile(0.5f), frameWindow.percentile(0.9f), updateWindow.percentile(0.5f), updateWindow.percentile(0.9f), lastSteps,
                d?.processCpuPercent?.let { if (it.isNaN()) "-" else String.format(Locale.US, "%.0f%%", it) } ?: "-", memoryText),
            String.format(Locale.US, "level %d  missiles %d dodged  shells %d dodged  bombs %d dodged  bombers %d passed  hits %d  t %.0f s  on screen: %d missiles %d shells %d bombers %d bombs",
                game.level, game.missilesDodged, game.shellsDodged, game.bombsDodged, game.bombersPassed, game.hits, game.elapsed,
                game.missiles.size, game.shells.size, game.bombers.size, game.bombs.size),
            "events: " + game.events.takeLast(3).joinToString(" | ") { String.format(Locale.US, "%.0fs %s", it.atSeconds, it.text) },
            diagnosticsText,
        )
        val lineHeight = diagPaint.textSize + 3f * density
        val boxW = lines.maxOf { diagPaint.measureText(it) } + 12f * density
        canvas.drawRect(left, top, left + boxW, top + lines.size * lineHeight + 6f * density, backPaint)
        var y = top + lineHeight
        for (line in lines) {
            canvas.drawText(line, left + 6f * density, y, diagPaint)
            y += lineHeight
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_UP) {
            when {
                webcamRect.contains(event.x, event.y) -> {
                    selectInputSource(FlakInputSource.Webcam)
                    performClick()
                    return true
                }
                controllerRect.contains(event.x, event.y) -> {
                    selectInputSource(FlakInputSource.Controller)
                    performClick()
                    return true
                }
            }
        }
        if (simulatedCadence && simRect.contains(event.x, event.y)) {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> simulatedPress = true
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> simulatedPress = false
            }
            if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
            return true
        }
        if (event.actionMasked == MotionEvent.ACTION_CANCEL) simulatedPress = false
        if (event.actionMasked == MotionEvent.ACTION_UP) {
            simulatedPress = false
            performClick()
        }
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private companion object {
        const val LOGICAL_W = FlakVisualGeometry.WIDTH
        const val LOGICAL_H = FlakVisualGeometry.HEIGHT
        const val PREFS = "fitbaus_arcade"
        const val SENSITIVITY_KEY = "flak_sensitivity"
        const val DELTA_KEY = "flak_boost_delta"
        const val DEFAULT_SENSITIVITY = 1
        const val DEFAULT_DELTA = 2
        const val SIM_RPM = 60
        const val SIM_SAMPLE_NANOS = 200_000_000L
        val SENSITIVITIES = floatArrayOf(4f, 6f, 8f, 11f)
        val SENSITIVITY_LABELS = arrayOf("Low", "Medium", "High", "Very high")
        val DELTAS = intArrayOf(8, 10, 12, 15, 18)
        val WARN = Color.rgb(252, 252, 252)
        val WARN_DIM = Color.rgb(248, 56, 0)
    }
}
