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
import kotlin.math.sin

internal enum class FlakHold { None, CameraStarting, CameraUnavailable, FaceLost, Calibrating, NoTelemetry, NotPedaling, Resuming }

/**
 * Decides whether the simulation may run. Any missing controller holds the game; nothing is lost while held.
 * Game over is not a hold: its 3-2-1 restart countdown runs in game time, so it pauses with any other hold.
 */
internal class FlakSupervisor(private val resumeStableMs: Long = 600L) {
    private var running = false

    fun hold(camera: CameraState, face: FaceControlReading, cadence: CadenceReading): FlakHold {
        val hold = when {
            camera == CameraState.Unavailable || camera == CameraState.PermissionDenied -> FlakHold.CameraUnavailable
            camera != CameraState.Ready -> FlakHold.CameraStarting
            face.state == FaceControlState.Lost -> FlakHold.FaceLost
            face.state == FaceControlState.Calibrating -> FlakHold.Calibrating
            cadence.state == CadenceState.NoTelemetry || cadence.state == CadenceState.Stale -> FlakHold.NoTelemetry
            cadence.state == CadenceState.Stopped -> FlakHold.NotPedaling
            !running && face.stableMs < resumeStableMs -> FlakHold.Resuming
            else -> FlakHold.None
        }
        running = hold == FlakHold.None
        return hold
    }

    fun message(hold: FlakHold, cadence: CadenceReading): String? = when (hold) {
        FlakHold.None -> null
        FlakHold.CameraUnavailable -> "CAMERA UNAVAILABLE - FLAK RUN NEEDS FACE STEERING"
        FlakHold.CameraStarting -> "STARTING CAMERA..."
        FlakHold.FaceLost -> "FACE LOST - LOOK AT THE SCREEN"
        FlakHold.Calibrating -> "HOLD YOUR HEAD STILL - CALIBRATING"
        FlakHold.NoTelemetry -> if (cadence.state == CadenceState.Stale) "BIKE DATA STALE - WAITING FOR RPM" else "NO BIKE DATA - WAITING FOR RPM"
        FlakHold.NotPedaling -> "PEDAL TO FLY"
        FlakHold.Resuming -> "GET READY..."
    }
}

internal object FlakSprites {
    val JET = arrayOf(
        "..GG............",
        "..GGG...........",
        "GGWWWWWWWW......",
        "RWWWWWWWWWWBBW..",
        "GGWWWWWWWWWWWWWW",
        "..GGG...........",
        "..GG............",
    )
    val FLAME = arrayOf("..YO", "YYOO", "..YO")
    val MISSILE = arrayOf(
        ".WWWWWWRR..",
        "GWWWWWWWRYO",
        ".WWWWWWRR..",
    )
    val TURRET = arrayOf(
        "......DD....",
        ".....DD.....",
        "....DD......",
        "..KKKKKK....",
        ".KKKKKKKK...",
        "KKKKKKKKKK..",
        "KKKKKKKKKK..",
    )
    val PUFF = arrayOf(
        "..WWWW..",
        ".WWGGWW.",
        "WWGGGGWW",
        "WGGDDGGW",
        "WGGDDGGW",
        "WWGGGGWW",
        ".WWGGWW.",
        "..WWWW..",
    )
    val BLAST = arrayOf(
        "Y..O..Y.",
        ".YOOOY..",
        "..OWWO.O",
        "OOWWWWOO",
        "O.OWWO..",
        "..YOOOY.",
        ".Y..O..Y",
        "O.......",
    )
    val BOMBER = arrayOf(
        "NN................",
        "NNN......NN.......",
        "NNNNNNNNNNNNNNN...",
        "DNNNNNNNNNNNNNNRN.",
        "NNNNNNNNNNNNNNNNNN",
        "NNN......NN.......",
        "NN................",
    )
    val BOMB = arrayOf(
        ".NN.",
        "NNNN",
        "NRRN",
        ".NN.",
    )
    val COLORS = mapOf(
        'N' to Color.rgb(16, 16, 20),
        'W' to Color.rgb(252, 252, 252),
        'G' to Color.rgb(188, 188, 188),
        'D' to Color.rgb(116, 116, 116),
        'R' to Color.rgb(248, 56, 0),
        'B' to Color.rgb(60, 188, 252),
        'Y' to Color.rgb(252, 224, 168),
        'O' to Color.rgb(252, 160, 68),
        'K' to Color.rgb(80, 48, 0),
    )

    fun bitmap(rows: Array<String>): Bitmap {
        val w = rows.maxOf { it.length }
        val bmp = Bitmap.createBitmap(w, rows.size, Bitmap.Config.ARGB_8888)
        for ((y, row) in rows.withIndex()) {
            for ((x, ch) in row.withIndex()) bmp.setPixel(x, y, COLORS[ch] ?: Color.TRANSPARENT)
        }
        return bmp
    }
}

/**
 * FLAK RUN: steer a fighter jet with small head movements (Face tracking) and escape flak by
 * briefly pedaling faster (read-only RPM). Rendered into a 256x144 framebuffer that is scaled
 * up with nearest-neighbour filtering. Never sends anything to the bike.
 */
public class FlakView(context: Context) : View(context) {
    public var diagnosticsOverlay: Boolean = false

    private val density = resources.displayMetrics.density
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val face = VerticalFaceControl()
    private val cadence = CadenceBoost()
    private val supervisor = FlakSupervisor()
    private val game = FlakGame().also { g -> g.onEvent = { android.util.Log.i(LandmarkFrameSink.LOG_TAG, it) } }
    private var sensitivityIndex = prefs?.getInt(SENSITIVITY_KEY, DEFAULT_SENSITIVITY) ?: DEFAULT_SENSITIVITY
    private var deltaIndex = prefs?.getInt(DELTA_KEY, DEFAULT_DELTA) ?: DEFAULT_DELTA
    private var simulatedCadence = false
    private var simulatedPress = false
    private var simulatedSample = 0L
    private var hold = FlakHold.CameraStarting
    private var faceReading = FaceControlReading(FaceControlState.Lost, 0.5f, Float.NaN, 0.5f, -1L, 0L)
    private var cadenceReading = CadenceReading(CadenceState.NoTelemetry, null, -1L, Float.NaN, Float.NaN, 0L, 0, false)
    private var diagnosticsText = ""
    private var info: ArcadeCameraInfo? = null
    private var lastRenderNanos = Long.MIN_VALUE
    private val frameWindow = DurationWindow(60)
    private val updateWindow = DurationWindow(60)
    private var lastSteps = 0
    private var memoryText = ""
    private var memoryAtNanos = Long.MIN_VALUE

    private val fb = Bitmap.createBitmap(LOGICAL_W, LOGICAL_H, Bitmap.Config.ARGB_8888)
    private val fbCanvas = Canvas(fb)
    private val fbSrc = Rect(0, 0, LOGICAL_W, LOGICAL_H)
    private val fbDst = Rect()
    private val jet = FlakSprites.bitmap(FlakSprites.JET)
    private val flame = FlakSprites.bitmap(FlakSprites.FLAME)
    private val missile = FlakSprites.bitmap(FlakSprites.MISSILE)
    private val turret = FlakSprites.bitmap(FlakSprites.TURRET)
    private val puff = FlakSprites.bitmap(FlakSprites.PUFF)
    private val blast = FlakSprites.bitmap(FlakSprites.BLAST)
    private val bomber = FlakSprites.bitmap(FlakSprites.BOMBER)
    private val bomb = FlakSprites.bitmap(FlakSprites.BOMB)
    private val farHeights = IntArray(LOGICAL_W * 2) { i -> (18 + 10 * sin(i * 0.045) + 6 * sin(i * 0.13 + 1.7)).toInt() / 2 * 2 }
    private val px = Paint()
    private val scaledPaint = Paint().apply { isFilterBitmap = false }
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
    ) {
        val now = System.nanoTime()
        if (lastRenderNanos != Long.MIN_VALUE) frameWindow.record((now - lastRenderNanos) / 1_000_000f)
        lastRenderNanos = now
        info = cameraInfo
        diagnosticsText = if (failure != null && camera != CameraState.Ready) failure else diagnostics
        faceReading = face.update(position, now)
        cadenceReading = if (simulatedCadence) simulate(now) else cadence.update(connected, initialized, rpm, rpmCurrent, rpmObservedAt, now)
        hold = supervisor.hold(camera, faceReading, cadenceReading)
        val start = System.nanoTime()
        if (hold == FlakHold.None) {
            lastSteps = game.advance(now, faceReading.target, cadenceReading.boosting, faceReading.targetX)
        } else {
            game.resetClock()
            lastSteps = 0
        }
        updateWindow.record((System.nanoTime() - start) / 1_000_000f)
        drawWorld()
        invalidate()
    }

    public fun restartGame() {
        game.restart()
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
        val base = cadenceReading.baseline.takeIf { !it.isNaN() } ?: SIM_RPM.toFloat()
        val rpm = if (simulatedPress) (base + DELTAS[deltaIndex] + 4).toInt() else SIM_RPM
        return cadence.update(true, true, rpm, true, "sim-$simulatedSample", now, simulated = true)
    }

    private fun drawWorld() {
        val c = fbCanvas
        val cfg = game.config
        c.drawColor(SKY)
        val far = (game.scroll * 0.3f).toInt()
        px.color = MOUNTAIN
        for (x in 0 until LOGICAL_W step 2) {
            val h = farHeights[(x + far) % farHeights.size]
            c.drawRect(x.toFloat(), cfg.groundTop - h, x + 2f, cfg.groundTop, px)
        }
        px.color = SAND
        c.drawRect(0f, cfg.groundTop, cfg.width, cfg.height, px)
        px.color = SAND_DARK
        val stripe = (game.scroll % 16f).toInt()
        for (x in -16 until LOGICAL_W + 16 step 16) c.drawRect((x - stripe).toFloat(), cfg.groundTop + 6f, (x - stripe + 6).toFloat(), cfg.groundTop + 8f, px)
        for (x in -16 until LOGICAL_W + 16 step 24) c.drawRect((x - stripe).toFloat(), cfg.groundTop + 13f, (x - stripe + 4).toFloat(), cfg.groundTop + 15f, px)
        for (t in game.turrets) c.drawBitmap(turret, t.x - turret.width / 2f, cfg.groundTop - turret.height, null)
        val blink = (game.elapsed * 6f).toInt() % 2 == 0
        for (t in game.turrets) {
            if (!t.fired && t.fireIn <= cfg.turretWarnSeconds && blink) {
                px.color = WARN
                c.drawRect(t.x - 1f, cfg.groundTop - turret.height - 9f, t.x + 1f, cfg.groundTop - turret.height - 4f, px)
                c.drawRect(t.x - 1f, cfg.groundTop - turret.height - 2f, t.x + 1f, cfg.groundTop - turret.height - 1f, px)
                px.color = WARN_DIM
                c.drawRect(t.x - 6f, cfg.groundTop - turret.height - 1f, t.x - 3f, cfg.groundTop - turret.height + 2f, px)
            }
        }
        for (sh in game.shells) {
            px.color = SHELL_TRAIL
            val p = (sh.age / sh.flight).coerceIn(0f, 1f)
            for (k in 1..3) {
                val q = (p - k * 0.06f).coerceAtLeast(0f)
                val tx = sh.startX + (sh.x - sh.startX) * (if (p > 0f) q / p else 0f)
                val ty = sh.startY + (sh.y - sh.startY) * (if (p > 0f) q / p else 0f)
                c.drawRect(tx - 1f, ty - 1f, tx + 1f, ty + 1f, px)
            }
            px.color = if (blink) WARN else SHELL
            c.drawRect(sh.x - 2f, sh.y - 2f, sh.x + 2f, sh.y + 2f, px)
        }
        for (m in game.missiles) {
            if (m.warn > 0f) {
                if (blink) {
                    px.color = WARN
                    c.drawRect(cfg.width - 6f, m.y - 3f, cfg.width - 2f, m.y + 3f, px)
                    c.drawRect(cfg.width - 9f, m.y - 1f, cfg.width - 6f, m.y + 1f, px)
                }
            } else {
                c.drawBitmap(missile, m.x - missile.width / 2f, m.y - missile.height / 2f, null)
            }
        }
        for (b in game.bombers) {
            if (b.warn > 0f) {
                if (blink) {
                    px.color = WARN
                    c.drawRect(2f, b.y - 3f, 6f, b.y + 3f, px)
                    c.drawRect(6f, b.y - 1f, 9f, b.y + 1f, px)
                }
            } else {
                c.drawBitmap(bomber, b.x - bomber.width / 2f, b.y - bomber.height / 2f, null)
            }
        }
        for (b in game.bombs) {
            px.color = SHELL_TRAIL
            for (k in 1..3) {
                val tx = b.x - b.vx * 0.05f * k
                val ty = b.y - b.vy * 0.05f * k
                c.drawRect(tx - 0.5f, ty - 0.5f, tx + 0.5f, ty + 0.5f, px)
            }
            c.drawBitmap(bomb, b.x - bomb.width / 2f, b.y - bomb.height / 2f, null)
        }
        val visible = game.invulnerable <= 0f || (game.elapsed * 12f).toInt() % 2 == 0
        if (visible && game.phase == FlakPhase.Playing) {
            val jx = game.jetX - jet.width / 2f
            val jy = game.jetY - jet.height / 2f
            c.drawBitmap(jet, jx, jy, null)
            if (game.boosting && (game.elapsed * 15f).toInt() % 2 == 0) c.drawBitmap(flame, jx - flame.width, jy + 2f, null)
        }
        for (b in game.blasts) {
            val frame = (b.age / FlakGame.BLAST_SECONDS * 3f).toInt().coerceIn(0, 2)
            val size = (if (b.flak) 12f else 8f) + frame * 4f
            blastRect.set(b.x - size / 2f, b.y - size / 2f, b.x + size / 2f, b.y + size / 2f)
            c.drawBitmap(if (b.flak) puff else blast, null, blastRect, null)
        }
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
        canvas.drawText(String.format(Locale.US, "SCORE %06d", game.score), left, baseline, hudPaint)
        val livesX = left + hudPaint.measureText("SCORE 000000  ")
        for (i in 0 until game.config.lives) {
            px.color = if (i < game.lives) Color.rgb(248, 56, 0) else Color.rgb(80, 80, 80)
            canvas.drawRect(livesX + i * 22f * density, baseline - 12f * density, livesX + i * 22f * density + 16f * density, baseline - 2f * density, px)
        }
        val c = cadenceReading
        val meterW = 180f * density
        val meterLeft = left + width - meterW
        meterRect.set(meterLeft, baseline - 14f * density, meterLeft + meterW, baseline)
        px.color = Color.rgb(40, 40, 40)
        canvas.drawRect(meterRect, px)
        val fill = if (c.baseline.isNaN() || c.rpm == null) 0f else ((c.rpm - c.baseline) / (c.threshold - c.baseline)).coerceIn(0f, 1f)
        px.color = when (c.state) {
            CadenceState.Boosting -> Color.rgb(252, 160, 68)
            CadenceState.Cruising -> Color.rgb(0, 200, 90)
            else -> Color.rgb(110, 110, 110)
        }
        val shown = if (c.state == CadenceState.Boosting) 1f else fill
        canvas.drawRect(meterRect.left, meterRect.top, meterRect.left + meterW * shown, meterRect.bottom, px)
        val label = when (c.state) {
            CadenceState.Boosting -> "DASH!"
            CadenceState.Establishing -> "LEARNING PACE"
            CadenceState.Cruising -> if (c.armed) "SURGE TO DASH" else "EASE OFF TO REARM"
            else -> "DASH --"
        }
        hudPaint.textSize = 12f * density
        val labelText = if (c.simulated) "SIM $label" else label
        canvas.drawText(labelText, meterLeft - hudPaint.measureText(labelText) - 8f * density, baseline - 2f * density, hudPaint)
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
            String.format(Locale.US, "rpm %s%s  age %d ms  baseline %s  threshold %s  %s  dash %d ms  dashes %d  armed %s",
                c.rpm?.toString() ?: "-", if (c.simulated) " (SIMULATED)" else "", c.sampleAgeMs,
                if (c.baseline.isNaN()) "-" else String.format(Locale.US, "%.1f", c.baseline),
                if (c.threshold.isNaN()) "-" else String.format(Locale.US, "%.1f", c.threshold),
                c.state, c.boostRemainingMs, c.activations, if (c.armed) "yes" else "no"),
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
        const val LOGICAL_W = 256
        const val LOGICAL_H = 144
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
        val SKY = Color.rgb(104, 136, 252)
        val MOUNTAIN = Color.rgb(136, 20, 0)
        val SAND = Color.rgb(240, 188, 60)
        val SAND_DARK = Color.rgb(228, 92, 16)
        val WARN = Color.rgb(252, 252, 252)
        val WARN_DIM = Color.rgb(248, 56, 0)
        val SHELL = Color.rgb(248, 56, 0)
        val SHELL_TRAIL = Color.rgb(188, 188, 188)
    }
}
