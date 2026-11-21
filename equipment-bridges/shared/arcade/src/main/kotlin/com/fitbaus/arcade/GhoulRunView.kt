// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.LightingColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.opengl.GLSurfaceView
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import java.util.Locale
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.random.Random

/**
 * GHOUL RUN split screen: a first-person raycast view (the steering view) on the left and the
 * fixed-orientation isometric map on the right. Input selectors stay across the top.
 */
public class GhoulRunView(context: Context) : FrameLayout(context) {
    public var diagnosticsOverlay: Boolean = false
        set(value) {
            field = value
            overlay.invalidate()
        }
    public var controllerAvailable: Boolean = false
        set(value) {
            field = value
            overlay.invalidate()
        }

    private val density = resources.displayMetrics.density
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private var selectedInput = prefs?.getString(GhoulRunInputSelection.PREF_KEY, null)
    private var difficultyIndex = (prefs?.getInt(DIFFICULTY_KEY, 1) ?: 1).coerceIn(0, SPRINT_DELTAS.lastIndex)
    private var seed = System.nanoTime()
    private var game = newGame(seed)
    private var session = GhoulRunSession(game)
    private var lastRenderNanos = Long.MIN_VALUE
    private var cameraRow = 0f
    private var cameraCol = 0f
    private var diagnosticsText = ""

    // GPU first-person surface and its allocation-free UI -> GL handoff.
    private val glSelection = GhoulRendererSelection()
    private val glSnapshots = GhoulGlSnapshotBuffer()
    private var glSurface: GLSurfaceView? = null
    private var glRenderer: GhoulRunGlRenderer? = null
    private var glMaze: GhoulGlMaze? = null
    private var glMazeGame: GhoulRunGame? = null
    private var glMazeSeed = Long.MIN_VALUE
    private val lightCandidateX = FloatArray(GhoulGlSnapshot.MAX_LIGHTS)
    private val lightCandidateY = FloatArray(GhoulGlSnapshot.MAX_LIGHTS)
    private val lightCandidateKind = IntArray(GhoulGlSnapshot.MAX_LIGHTS)
    private var glAttached = false
    private var glHostPaused = true
    private var glPaused = false

    // First person.
    private val rig = GhoulCameraRig()
    private var grid: GhoulRayGrid? = null
    private var gridGame: GhoulRunGame? = null
    private var gridSeed = Long.MIN_VALUE
    private var renderer: GhoulFirstPersonRenderer? = null
    private var frameBitmap: Bitmap? = null
    private val frameMatrix = Matrix()
    private val frameValues = FloatArray(9)
    private val spriteBitmaps = HashMap<GhoulSpriteKind, Bitmap>()
    private var conceptGhoulBitmap: Bitmap? = null
    private val lightFilters = Array(LIGHT_STEPS + 1) { step ->
        val v = 255 * step / LIGHT_STEPS
        LightingColorFilter(Color.rgb(v, v, v), 0)
    }
    private val ghoulLightFilters = Array(LIGHT_STEPS + 1) { step ->
        val v = 255 * step / LIGHT_STEPS
        LightingColorFilter(
            Color.rgb(
                (v * GhoulConceptArt.TINT_RED).roundToInt(),
                (v * GhoulConceptArt.TINT_GREEN).roundToInt(),
                (v * GhoulConceptArt.TINT_BLUE).roundToInt(),
            ),
            0,
        )
    }
    private val spritePaint = Paint().apply { isFilterBitmap = true }
    private val spriteDst = RectF()
    private var tileArtWidth = -1
    private var floorLitTile: Bitmap? = null
    private var noiseTile: Bitmap? = null
    private var wallLitTile: Bitmap? = null
    private var wallTileTop = 0f

    // Map layer: explored tiles pre-drawn once into one bitmap, extended incrementally.
    private var mapLayer: Bitmap? = null
    private var mapLayerCanvas: Canvas? = null
    private var mapLayerGame: GhoulRunGame? = null
    private var mapLayerSeed = Long.MIN_VALUE
    private var mapLayerCount = 0
    private var mapOriginX = 0f
    private var mapOriginY = 0f
    private val newTiles = ArrayList<MazeTile>()
    private val layerPaint = Paint().apply { isFilterBitmap = true }
    private val darkPaint = Paint()
    private val darkMatrix = Matrix()
    private val sprites = ArrayList<GhoulSprite>()
    private val spritePool = ArrayList<GhoulSprite>()
    private var bobPhase = 0f
    private val shaderPhases = GhoulShaderPhases()
    private val ghoulMotion = GhoulConceptMotion()
    private val shakeRandom = Random(7)

    // Feedback tracking.
    private var trackedGame: GhoulRunGame? = null
    private var shownCatch: GhoulCatchEvent? = null
    private var catchAtNanos = Long.MIN_VALUE
    private var seenRespawns = 0
    private var respawnAtNanos = Long.MIN_VALUE
    private var respawnAtStart = false
    private val cellPathDistance = FloatArray(game.config.width * game.config.height)

    // Timing (exponential moving averages, milliseconds).
    private var fpRenderMs = 0f
    private var updateMs = 0f
    private var fpUploadMs = 0f
    private var drawMs = 0f
    private var frameIntervalMs = 0f
    private var lastTimingLogNanos = 0L
    private var diagnosticsBuiltAt = 0L
    private var diagnosticsLines: List<String> = emptyList()

    public val inputSource: GhoulRunInputSource
        get() = GhoulRunInputSelection.effective(selectedInput, controllerAvailable)

    public var onInputSourceChanged: ((GhoulRunInputSource) -> Unit)? = null

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val dashed = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val bitmapPaint = Paint().apply { isFilterBitmap = false; isDither = false }
    private val vignettePaint = Paint()
    private val glowPaint = Paint()
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        typeface = Typeface.MONOSPACE
        isFakeBoldText = true
    }
    private val path = Path()
    private val webcamRect = RectF()
    private val controllerRect = RectF()
    private val bothRect = RectF()
    private val difficultyRect = RectF()
    private val fpRect = RectF()
    private val mapRect = RectF()
    private val slotRect = RectF()
    private var shaderKey = 0L

    private val overlay = object : View(context) {
        init {
            setBackgroundColor(Color.TRANSPARENT)
            isClickable = true
        }

        override fun onDraw(canvas: Canvas) {
            drawOverlay(canvas)
        }

        override fun onTouchEvent(event: MotionEvent): Boolean = handleTouch(event)

        override fun performClick(): Boolean {
            super.performClick()
            return true
        }
    }

    init {
        setBackgroundColor(BACKGROUND)
        dashed.pathEffect = DashPathEffect(floatArrayOf(5f * density, 4f * density), 0f)
        try {
            val surface = GLSurfaceView(context)
            val gpu = GhoulRunGlRenderer(context.assets, glSnapshots, ::onGlFailure)
            surface.setEGLContextClientVersion(2)
            surface.setEGLContextFactory(GhoulEglContextFactory(::onGlFailure))
            surface.preserveEGLContextOnPause = true
            surface.setRenderer(gpu)
            surface.renderMode = GLSurfaceView.RENDERMODE_WHEN_DIRTY
            glSurface = surface
            glRenderer = gpu
            addView(surface, LayoutParams(1, 1))
        } catch (error: RuntimeException) {
            glSelection.fail("GLES2 surface failed: ${error.message ?: error.javaClass.simpleName}")
            Log.e(TAG, glSelection.reason ?: "GLES2 surface failed")
        }
        addView(overlay, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    public fun selectInputSource(source: GhoulRunInputSource) {
        if (source != GhoulRunInputSource.Webcam && !controllerAvailable) return
        val prior = inputSource
        selectedInput = source.name
        prefs?.edit()?.putString(GhoulRunInputSelection.PREF_KEY, source.name)?.apply()
        session.pause()
        if (prior != inputSource) onInputSourceChanged?.invoke(inputSource)
        overlay.invalidate()
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
        @Suppress("UNUSED_PARAMETER") cameraInfo: ArcadeCameraInfo?,
        controller: GhoulRunControllerInput? = null,
    ) {
        glHostPaused = false
        updateGlLifecycle()
        val now = System.nanoTime()
        val interval = if (lastRenderNanos == Long.MIN_VALUE) 0L else now - lastRenderNanos
        try {
            update(now, interval, position, camera, failure, connected, initialized, rpm, rpmCurrent, rpmObservedAt, diagnostics, controller)
        } finally {
            updateMs = ema(updateMs, (System.nanoTime() - now) / 1_000_000f)
        }
        publishGlFrame(now)
        overlay.invalidate()
    }

    private fun update(
        now: Long,
        interval: Long,
        position: HandPosition,
        camera: CameraState,
        failure: String?,
        connected: Boolean,
        initialized: Boolean,
        rpm: Int?,
        rpmCurrent: Boolean,
        rpmObservedAt: String?,
        diagnostics: String,
        controller: GhoulRunControllerInput?,
    ) {
        if (lastRenderNanos != Long.MIN_VALUE && interval > STALL_NANOS) session.pause()
        if (interval in 1 until STALL_NANOS) frameIntervalMs = ema(frameIntervalMs, interval / 1_000_000f)
        lastRenderNanos = now
        diagnosticsText = failure ?: diagnostics
        val source = inputSource
        session.update(
            position, camera, connected, initialized, rpm, rpmCurrent, rpmObservedAt, now,
            source = source,
            controllerAvailable = controllerAvailable,
            controller = if (source == GhoulRunInputSource.Webcam) null else controller,
        )
        val dt = if (session.live && interval in 1 until STALL_NANOS) interval / 1_000_000_000f else 0f
        trackFeedback(now)
        rig.update(game, dt)
        val cadenceHz = session.cadenceReading.filteredRpm.coerceAtLeast(0f) / 60f
        shaderPhases.advance(dt, cadenceHz)
        ghoulMotion.advance(dt, game.ghoul.state)
        if (game.speed > 0.05f) bobPhase = (bobPhase + dt * cadenceHz * 2f * TWO_PI) % TWO_PI
        val hunt = game.ghoul.state == GhoulState.Hunting
        val shift = if (hunt) 0.28f else 0f
        val targetRow = game.riderRow + (game.ghoul.row - game.riderRow) * shift
        val targetCol = game.riderCol + (game.ghoul.col - game.riderCol) * shift
        val jumped = kotlin.math.abs(targetRow - cameraRow) + kotlin.math.abs(targetCol - cameraCol) > 3f
        if (jumped && game.respawns != 0 && respawnAtNanos != Long.MIN_VALUE && now - respawnAtNanos < FADE_NANOS) {
            cameraRow = targetRow
            cameraCol = targetCol
        } else {
            cameraRow += (targetRow - cameraRow) * 0.12f
            cameraCol += (targetCol - cameraCol) * 0.12f
        }
    }

    private fun trackFeedback(now: Long) {
        if (trackedGame !== game) {
            trackedGame = game
            shownCatch = game.catchEvent
            seenRespawns = game.respawns
            catchAtNanos = Long.MIN_VALUE
            respawnAtNanos = Long.MIN_VALUE
            rig.reset()
        }
        val event = game.catchEvent
        if (event != null && event !== shownCatch) {
            shownCatch = event
            catchAtNanos = now
            ghoulMotion.spikeCatch()
        }
        if (event == null) shownCatch = null
        if (game.respawns != seenRespawns) {
            seenRespawns = game.respawns
            respawnAtNanos = now
            respawnAtStart = game.checkpoint == game.world.start
        }
    }

    public fun pause() {
        session.pause()
        lastRenderNanos = Long.MIN_VALUE
        glHostPaused = true
        updateGlLifecycle()
    }

    public fun restartGame() {
        seed += 1L
        session.restart(seed)
        session.pause()
        rig.reset()
        overlay.invalidate()
    }

    public fun developerOptions(): List<String> = listOf(
        "Sprint difficulty: +${SPRINT_DELTAS[difficultyIndex]} RPM (tap to change)",
        "Input source: ${inputSource.name} (use in-game selector)",
        "Recenter head now (look straight ahead)",
        "Recalibrate pace (25 second warm-up)",
        "Restart maze now",
    )

    public fun selectDeveloperOption(index: Int) {
        when (index) {
            0 -> {
                difficultyIndex = (difficultyIndex + 1) % SPRINT_DELTAS.size
                prefs?.edit()?.putInt(DIFFICULTY_KEY, difficultyIndex)?.apply()
                seed += 1L
                val lockedPace = session.pace
                val checked = game.leanCheckPassed
                game = newGame(seed)
                if (checked) game.markLeanCheckPassed()
                session = GhoulRunSession(game, pace = lockedPace)
            }
            2 -> session.recenter()
            3 -> session.recalibratePace()
            4 -> restartGame()
        }
        overlay.invalidate()
    }

    private fun drawOverlay(canvas: Canvas) {
        if (width <= 0 || height <= 0) return
        val started = System.nanoTime()
        drawSelectors(canvas)
        val top = TOP_UI * density
        val splitX = (width * SPLIT_RATIO).roundToInt().toFloat()
        fpRect.set(0f, top, splitX, height.toFloat())
        mapRect.set(splitX, top, width.toFloat(), height.toFloat())
        val now = System.nanoTime()

        canvas.save()
        canvas.clipRect(mapRect)
        drawMapHalf(canvas, now)
        canvas.restore()

        canvas.save()
        canvas.clipRect(fpRect)
        if (glSelection.type == GhoulRendererType.Fallback) drawFirstPerson(canvas, now) else drawFirstPersonHud(canvas, now)
        canvas.restore()

        stroke.color = DIVIDER
        stroke.strokeWidth = 2f * density
        canvas.drawLine(splitX, top, splitX, height.toFloat(), stroke)

        drawScreenFeedback(canvas, now, top)
        session.message()?.let { banner(canvas, it, width / 2f, height * 0.35f, width * 0.47f, Color.WHITE) }
        if (diagnosticsOverlay) drawDiagnostics(canvas)
        drawMs = ema(drawMs, (System.nanoTime() - started) / 1_000_000f)
        if (diagnosticsOverlay && now - lastTimingLogNanos > TIMING_LOG_NANOS) {
            lastTimingLogNanos = now
            Log.i(TAG, timingLine())
        }
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val measuredWidth = View.MeasureSpec.getSize(widthMeasureSpec)
        val measuredHeight = View.MeasureSpec.getSize(heightMeasureSpec)
        val surface = glSurface
        if (surface != null) {
            val params = surface.layoutParams as LayoutParams
            params.width = (measuredWidth * SPLIT_RATIO * GL_RENDER_SCALE).roundToInt().coerceAtLeast(1)
            params.height = (measuredHeight - TOP_UI * density).roundToInt().coerceAtLeast(1)
            params.topMargin = (TOP_UI * density).roundToInt()
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        glAttached = true
        updateGlLifecycle()
    }

    override fun onDetachedFromWindow() {
        glAttached = false
        updateGlLifecycle()
        super.onDetachedFromWindow()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        updateGlLifecycle()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (changedView === this) updateGlLifecycle()
    }

    private fun updateGlLifecycle() {
        val surface = glSurface ?: return
        val shouldRun = glAttached && !glHostPaused && windowVisibility == View.VISIBLE && visibility == View.VISIBLE &&
            glSelection.type == GhoulRendererType.Gl
        if (shouldRun && glPaused) {
            glPaused = false
            surface.onResume()
        } else if (!shouldRun && !glPaused) {
            glPaused = true
            surface.onPause()
        }
    }

    private fun onGlFailure(reason: String) {
        post {
            glSelection.fail(reason)
            Log.e(TAG, reason)
            glSurface?.visibility = View.GONE
            updateGlLifecycle()
            overlay.invalidate()
        }
    }

    private fun publishGlFrame(now: Long) {
        if (glSelection.type != GhoulRendererType.Gl) return
        val world = game.world
        if (glMaze == null || glMazeGame !== game || glMazeSeed != world.seed) {
            glMaze = GhoulGlMaze.from(world)
            glMazeGame = game
            glMazeSeed = world.seed
        }
        val frame = glSnapshots.writable()
        frame.maze = glMaze
        frame.cameraX = rig.x
        frame.cameraY = rig.y
        val shake = shakeAmount(now)
        frame.yaw = rig.yaw + if (shake > 0f) (shakeRandom.nextFloat() - 0.5f) * 0.09f * shake else 0f
        val speedShare = (game.speed / game.config.sprintSpeed).coerceIn(0f, 1f)
        frame.eye = 0.5f + sin(bobPhase) * BOB_AMPLITUDE * speedShare +
            if (shake > 0f) (shakeRandom.nextFloat() - 0.5f) * 0.06f * shake else 0f
        frame.lampRadius = game.lightRadius * 2f
        frame.lampPhase = shaderPhases.lamp
        frame.glowPhase = shaderPhases.glow
        frame.diagnostics = diagnosticsOverlay
        frame.ghoulPhaseA = ghoulMotion.phaseA
        frame.ghoulPhaseB = ghoulMotion.phaseB
        frame.ghoulFlare = ghoulMotion.flare
        frame.ghoulBob = ghoulMotion.bob
        frame.ghoulSway = ghoulMotion.sway
        frame.ghoulDesaturation = ghoulMotion.desaturation(game.ghoul.state)

        var candidates = 0
        for (shrine in world.shrines) if ((game.shrineCooldowns[shrine] ?: 0f) <= 0f) {
            if (candidates < lightCandidateX.size) {
                lightCandidateX[candidates] = GhoulRaycaster.cellX(shrine.col.toFloat())
                lightCandidateY[candidates] = GhoulRaycaster.cellY(shrine.row.toFloat())
                lightCandidateKind[candidates] = GhoulGlLightColor.SHRINE_CYAN
                candidates += 1
            }
        }
        if (game.exitOpen && candidates < lightCandidateX.size) {
            lightCandidateX[candidates] = GhoulRaycaster.cellX(world.exit.col.toFloat())
            lightCandidateY[candidates] = GhoulRaycaster.cellY(world.exit.row.toFloat())
            lightCandidateKind[candidates] = GhoulGlLightColor.EXIT_GREEN
            candidates += 1
        }
        if (game.ghoul.state != GhoulState.Inactive && game.ghoul.state != GhoulState.Stunned && candidates < lightCandidateX.size) {
            lightCandidateX[candidates] = GhoulRaycaster.cellX(game.ghoul.col)
            lightCandidateY[candidates] = GhoulRaycaster.cellY(game.ghoul.row)
            lightCandidateKind[candidates] = GhoulGlLightColor.GHOUL_RED
            candidates += 1
        }
        frame.lightCount = GhoulLightSelector.select(
            frame.cameraX, frame.cameraY, lightCandidateX, lightCandidateY, lightCandidateKind, candidates,
            frame.lightXyr, frame.lightRgb, GhoulGlSnapshot.MAX_LIGHTS,
        )
        var spriteCount = 0
        var at = spriteCount * 3
        frame.spriteXyk[at] = GhoulRaycaster.cellX(world.exit.col.toFloat())
        frame.spriteXyk[at + 1] = GhoulRaycaster.cellY(world.exit.row.toFloat())
        frame.spriteXyk[at + 2] = (if (game.exitOpen) GhoulSpriteKind.Exit else GhoulSpriteKind.ExitLocked).ordinal.toFloat()
        spriteCount += 1
        for (shrine in world.shrines) if (spriteCount < GhoulGlSnapshot.MAX_SPRITES) {
            at = spriteCount * 3
            frame.spriteXyk[at] = GhoulRaycaster.cellX(shrine.col.toFloat())
            frame.spriteXyk[at + 1] = GhoulRaycaster.cellY(shrine.row.toFloat())
            frame.spriteXyk[at + 2] = (
                if ((game.shrineCooldowns[shrine] ?: 0f) <= 0f) GhoulSpriteKind.ShrineReady else GhoulSpriteKind.ShrineSpent
            ).ordinal.toFloat()
            spriteCount += 1
        }
        if (game.ghoul.state != GhoulState.Inactive && spriteCount < GhoulGlSnapshot.MAX_SPRITES) {
            at = spriteCount * 3
            frame.spriteXyk[at] = GhoulRaycaster.cellX(game.ghoul.col)
            frame.spriteXyk[at + 1] = GhoulRaycaster.cellY(game.ghoul.row)
            frame.spriteXyk[at + 2] = (
                if (game.ghoul.state == GhoulState.Stunned) GhoulSpriteKind.GhoulStunned else GhoulSpriteKind.Ghoul
            ).ordinal.toFloat()
            spriteCount += 1
        }
        frame.spriteCount = spriteCount
        glSnapshots.publish(frame)
        glSurface?.requestRender()
    }

    // ---------------------------------------------------------------- first person

    private fun drawFirstPerson(canvas: Canvas, now: Long) {
        val halfW = fpRect.width()
        val halfH = fpRect.height()
        if (halfW < 8f || halfH < 8f) return
        val pixelsWide = FP_PIXELS_WIDE
        val pixelsHigh = (pixelsWide * halfH / halfW).roundToInt().coerceIn(60, 600)
        var fp = renderer
        if (fp == null || fp.width != pixelsWide || fp.height != pixelsHigh) {
            fp = GhoulFirstPersonRenderer(pixelsWide, pixelsHigh, FOV_DEGREES)
            renderer = fp
            frameBitmap?.recycle()
            // Transposed: the renderer fills columns contiguously, so bitmap rows are frame columns.
            frameBitmap = Bitmap.createBitmap(pixelsHigh, pixelsWide, Bitmap.Config.ARGB_8888)
            // Decode the fallback artwork now (warm-up), not mid-ride when it first comes into view.
            spriteBitmap(GhoulSpriteKind.Ghoul)
        }
        val bitmap = frameBitmap ?: return
        val rayGrid = currentGrid()
        val time = (now / 1_000_000L % 10_000_000L) / 1000f
        buildSprites()
        val shake = shakeAmount(now)
        val yaw = rig.yaw + if (shake > 0f) (shakeRandom.nextFloat() - 0.5f) * 0.09f * shake else 0f
        val speedShare = (game.speed / game.config.sprintSpeed).coerceIn(0f, 1f)
        val bob = sin(bobPhase) * BOB_AMPLITUDE * speedShare +
            if (shake > 0f) (shakeRandom.nextFloat() - 0.5f) * 0.06f * shake else 0f
        val renderStart = System.nanoTime()
        fp.render(rayGrid, rig.x, rig.y, yaw, 0.5f + bob, game.lightRadius * 2f, sprites, time)
        val uploadStart = System.nanoTime()
        bitmap.setPixels(fp.pixels, 0, pixelsHigh, 0, 0, pixelsHigh, pixelsWide)
        val sx = halfW / pixelsWide
        val sy = halfH / pixelsHigh
        // Transpose back: screen x follows bitmap rows (frame columns), screen y follows bitmap columns.
        frameValues[Matrix.MSCALE_X] = 0f
        frameValues[Matrix.MSKEW_X] = sx
        frameValues[Matrix.MTRANS_X] = fpRect.left
        frameValues[Matrix.MSKEW_Y] = sy
        frameValues[Matrix.MSCALE_Y] = 0f
        frameValues[Matrix.MTRANS_Y] = fpRect.top
        frameValues[Matrix.MPERSP_0] = 0f
        frameValues[Matrix.MPERSP_1] = 0f
        frameValues[Matrix.MPERSP_2] = 1f
        frameMatrix.setValues(frameValues)
        canvas.drawBitmap(bitmap, frameMatrix, bitmapPaint)
        drawSprites(canvas, fp, sx, sy)
        val uploadEnd = System.nanoTime()
        fpRenderMs = ema(fpRenderMs, (uploadStart - renderStart) / 1_000_000f)
        fpUploadMs = ema(fpUploadMs, (uploadEnd - uploadStart) / 1_000_000f)

        drawFpOverlays(canvas, now)
        val gaugeTop = fpRect.bottom - GAUGE_HEIGHT * density
        drawCompass(canvas)
        drawHearts(canvas, now)
        drawSteering(canvas, now)
        drawHint(canvas, gaugeTop)
        drawSpeedGauge(canvas, gaugeTop, now)
        drawPhase(canvas, gaugeTop)
    }

    private fun drawFirstPersonHud(canvas: Canvas, now: Long) {
        drawFpOverlays(canvas, now)
        val gaugeTop = fpRect.bottom - GAUGE_HEIGHT * density
        drawCompass(canvas)
        drawHearts(canvas, now)
        drawSteering(canvas, now)
        drawHint(canvas, gaugeTop)
        drawSpeedGauge(canvas, gaugeTop, now)
        drawPhase(canvas, gaugeTop)
    }

    /** Billboards: prebuilt textures scaled by Canvas, clipped to the columns where they beat the walls. */
    private fun drawSprites(canvas: Canvas, fp: GhoulFirstPersonRenderer, sx: Float, sy: Float) {
        for (index in 0 until fp.drawCount) {
            val draw = fp.draws[index]
            val art = spriteBitmap(draw.kind)
            spriteDst.set(
                fpRect.left + draw.left * sx,
                fpRect.top + draw.top * sy,
                fpRect.left + (draw.left + draw.width) * sx,
                fpRect.top + (draw.top + draw.height) * sy,
            )
            val lightStep = (draw.light.coerceIn(0f, 1f) * LIGHT_STEPS + 0.5f).toInt()
            spritePaint.colorFilter = if (
                draw.kind == GhoulSpriteKind.Ghoul || draw.kind == GhoulSpriteKind.GhoulStunned
            ) ghoulLightFilters[lightStep] else lightFilters[lightStep]
            for (run in 0 until draw.runCount) {
                canvas.save()
                canvas.clipRect(
                    fpRect.left + draw.runs[run * 2] * sx,
                    fpRect.top,
                    fpRect.left + (draw.runs[run * 2 + 1] + 1) * sx,
                    fpRect.bottom,
                )
                canvas.drawBitmap(art, null, spriteDst, spritePaint)
                canvas.restore()
            }
        }
    }

    private fun spriteBitmap(kind: GhoulSpriteKind): Bitmap {
        if (kind == GhoulSpriteKind.Ghoul || kind == GhoulSpriteKind.GhoulStunned) {
            val cached = conceptGhoulBitmap
            if (cached != null) return cached
            return requireNotNull(
                context.assets.open(GHOUL_FULL_ASSET).use { input ->
                    BitmapFactory.decodeStream(input, null, BitmapFactory.Options().apply {
                        inPreferredConfig = Bitmap.Config.ARGB_8888
                        inScaled = false
                    })
                },
            ) { "missing $GHOUL_FULL_ASSET" }.also { conceptGhoulBitmap = it }
        }
        return spriteBitmaps.getOrPut(kind) {
            val (w, h) = textureSize(kind)
            textureBitmap(GhoulSpriteArt.texture(kind, w, h), w, h)
        }
    }

    private fun textureSize(kind: GhoulSpriteKind): Pair<Int, Int> {
        val h = GhoulSpriteArt.textureHeight(kind)
        val w = max(8, (h * GhoulFirstPersonRenderer.spriteWidth(kind) / GhoulFirstPersonRenderer.spriteHeight(kind)).roundToInt())
        return w to h
    }

    private fun textureBitmap(pixels: IntArray, w: Int, h: Int): Bitmap =
        Bitmap.createBitmap(pixels, w, h, Bitmap.Config.ARGB_8888)

    private fun currentGrid(): GhoulRayGrid {
        val cached = grid
        if (cached != null && gridGame === game && gridSeed == game.world.seed) return cached
        return GhoulRayGrid.from(game.world).also {
            grid = it
            gridGame = game
            gridSeed = game.world.seed
        }
    }

    private fun buildSprites() {
        sprites.clear()
        var used = 0
        fun add(x: Float, y: Float, kind: GhoulSpriteKind, lift: Float = 0f) {
            if (used == spritePool.size) spritePool += GhoulSprite(0f, 0f, kind)
            val sprite = spritePool[used++]
            sprite.x = x
            sprite.y = y
            sprite.kind = kind
            sprite.lift = lift
            sprites += sprite
        }
        val world = game.world
        add(
            GhoulRaycaster.cellX(world.exit.col.toFloat()),
            GhoulRaycaster.cellY(world.exit.row.toFloat()),
            if (game.exitOpen) GhoulSpriteKind.Exit else GhoulSpriteKind.ExitLocked,
        )
        for (shrine in world.shrines) {
            val ready = (game.shrineCooldowns[shrine] ?: 0f) <= 0f
            add(
                GhoulRaycaster.cellX(shrine.col.toFloat()),
                GhoulRaycaster.cellY(shrine.row.toFloat()),
                if (ready) GhoulSpriteKind.ShrineReady else GhoulSpriteKind.ShrineSpent,
            )
        }
        if (game.ghoul.state != GhoulState.Inactive) {
            add(
                GhoulRaycaster.cellX(game.ghoul.col),
                GhoulRaycaster.cellY(game.ghoul.row),
                if (game.ghoul.state == GhoulState.Stunned) GhoulSpriteKind.GhoulStunned else GhoulSpriteKind.Ghoul,
            )
        }
    }

    private fun shakeAmount(now: Long): Float {
        if (catchAtNanos == Long.MIN_VALUE) return 0f
        val age = now - catchAtNanos
        return if (age in 0 until SHAKE_NANOS) 1f - age.toFloat() / SHAKE_NANOS else 0f
    }

    private fun drawFpOverlays(canvas: Canvas, now: Long) {
        ensureShaders()
        val ghoulThreat = game.phase == GhoulPhase.Playing &&
            game.ghoul.state != GhoulState.Inactive && game.ghoul.state != GhoulState.Stunned
        val gap = game.pathGap
        if (ghoulThreat && gap < PROXIMITY_TILES) {
            val intensity = ((PROXIMITY_TILES - gap) / PROXIMITY_TILES).coerceIn(0f, 1f)
            vignettePaint.alpha = (intensity * 235).toInt()
            canvas.drawRect(fpRect, vignettePaint)
        }
        if (game.invulnerableLeft > 0f && game.respawnLeft <= 0f) {
            val pulse = ((sin(now / 90_000_000.0) + 1.0) * 0.5).toFloat()
            glowPaint.alpha = (110 + 90 * pulse).toInt()
            canvas.drawRect(fpRect, glowPaint)
        }
    }

    private fun ensureShaders() {
        val key = (fpRect.width().toLong() shl 32) or fpRect.height().toLong() or (fpRect.top.toLong() shl 48)
        if (key == shaderKey) return
        shaderKey = key
        val cx = fpRect.centerX()
        val cy = fpRect.centerY()
        val radius = max(fpRect.width(), fpRect.height()) * 0.72f
        vignettePaint.shader = RadialGradient(
            cx, cy, radius,
            intArrayOf(Color.TRANSPARENT, Color.TRANSPARENT, Color.argb(255, 210, 0, 0)),
            floatArrayOf(0f, 0.45f, 1f),
            Shader.TileMode.CLAMP,
        )
        glowPaint.shader = RadialGradient(
            cx, cy, radius,
            intArrayOf(Color.TRANSPARENT, Color.TRANSPARENT, Color.WHITE),
            floatArrayOf(0f, 0.62f, 1f),
            Shader.TileMode.CLAMP,
        )
    }

    private fun drawCompass(canvas: Canvas) {
        val exit = game.world.exit
        val dx = GhoulRaycaster.cellX(exit.col.toFloat()) - rig.x
        val dy = GhoulRaycaster.cellY(exit.row.toFloat()) - rig.y
        val radius = 20f * density
        val cx = fpRect.left + 14f * density + radius
        val cy = fpRect.top + 12f * density + radius
        paint.color = PANEL
        canvas.drawCircle(cx, cy, radius + 4f * density, paint)
        if (dx * dx + dy * dy > 0.01f) {
            val relative = atan2(dy, dx) - rig.yaw
            drawArrow(canvas, cx, cy, sin(relative), -cos(relative), COMPASS, radius * 0.85f)
        }
        val distance = game.riderPathDistanceTo(exit)
        text.textSize = 12f * density
        text.textAlign = Paint.Align.CENTER
        text.color = COMPASS
        val label = if (distance.isFinite()) "EXIT ${ceil(distance).toInt()}" else "EXIT"
        canvas.drawText(label, cx, cy + radius + 20f * density, text)
        text.textAlign = Paint.Align.LEFT
    }

    private fun drawHearts(canvas: Canvas, now: Long) {
        text.textSize = 22f * density
        text.textAlign = Paint.Align.RIGHT
        val step = 24f * density
        val right = fpRect.right - 12f * density
        val y = fpRect.top + 34f * density
        val total = game.config.startingHearts
        val event = shownCatch
        val popAge = if (event != null && catchAtNanos != Long.MIN_VALUE) now - catchAtNanos else Long.MAX_VALUE
        for (index in 0 until total) {
            val x = right - (total - 1 - index) * step
            val alive = index < game.hearts
            val popping = event != null && popAge in 0 until HEART_POP_NANOS && index == event.heartsLeft
            if (popping) {
                val p = popAge.toFloat() / HEART_POP_NANOS
                canvas.save()
                val scale = 1f + 0.9f * p
                canvas.scale(scale, scale, x - step * 0.4f, y - 8f * density)
                text.color = Color.argb(((1f - p) * 255).toInt(), 255, 60, 60)
                canvas.drawText("♥", x, y, text)
                canvas.restore()
            } else {
                text.color = if (alive) HEART else HEART_EMPTY
                canvas.drawText("♥", x, y, text)
            }
        }
        text.textAlign = Paint.Align.LEFT
    }

    /** Turn slots (real choices and the lean check) plus the always-visible lean bar. */
    private fun drawSteering(canvas: Canvas, now: Long) {
        val size = 38f * density
        val gap = 8f * density
        val totalW = size * 3 + gap * 2
        val left = fpRect.centerX() - totalW / 2f
        val top = fpRect.top + 10f * density
        val checkTarget = game.leanCheckTarget
        val inCheck = game.phase == GhoulPhase.LeanCheck
        val slots = if (game.phase == GhoulPhase.Playing && game.respawnLeft <= 0f) game.turnSlots() else null
        if (inCheck || slots != null) {
            for (lane in GhoulLane.entries) {
                val x = left + lane.ordinal * (size + gap)
                slotRect.set(x, top, x + size, top + size)
                val open = slots?.open(lane) ?: true
                val selected = if (inCheck) session.lane == lane && checkTarget != null else slots?.selected == lane
                val target = inCheck && checkTarget == lane
                drawSlot(canvas, lane, open, selected, target, now)
            }
        }
        val barTop = top + size + 8f * density
        val barH = 8f * density
        val half = totalW / 2f
        val cx = fpRect.centerX()
        paint.color = PANEL
        canvas.drawRect(cx - half - 4f * density, barTop - 4f * density, cx + half + 4f * density, barTop + barH + 4f * density, paint)
        paint.color = Color.rgb(60, 62, 70)
        canvas.drawRect(cx - half, barTop, cx + half, barTop + barH, paint)
        val enter = game.config.leanEnter
        val exit = game.config.leanExit
        paint.color = Color.rgb(90, 92, 100)
        canvas.drawRect(cx - half, barTop, cx - half * enter, barTop + barH, paint)
        canvas.drawRect(cx + half * enter, barTop, cx + half, barTop + barH, paint)
        stroke.strokeWidth = 1.5f * density
        stroke.color = Color.rgb(130, 132, 140)
        for (mark in floatArrayOf(-exit, exit)) canvas.drawLine(cx + half * mark, barTop, cx + half * mark, barTop + barH, stroke)
        val lean = game.lean.coerceIn(-1f, 1f)
        paint.color = when {
            session.rearming -> Color.rgb(120, 122, 130)
            session.lane == GhoulLane.Center -> Color.WHITE
            else -> HIGHLIGHT
        }
        canvas.drawCircle(cx + half * lean, barTop + barH / 2f, 7f * density, paint)
    }

    private fun drawSlot(canvas: Canvas, lane: GhoulLane, open: Boolean, selected: Boolean, target: Boolean, now: Long) {
        val confirming = target && game.leanCheckConfirmLeft > 0f
        if (selected || confirming) {
            paint.color = if (confirming) EXIT_OPEN else HIGHLIGHT
            canvas.drawRoundRect(slotRect, 6f * density, 6f * density, paint)
        } else {
            paint.color = PANEL
            canvas.drawRoundRect(slotRect, 6f * density, 6f * density, paint)
        }
        if (target && !confirming && game.leanCheckHeld > 0f) {
            val share = (game.leanCheckHeld / game.config.leanCheckHoldSeconds).coerceIn(0f, 1f)
            paint.color = Color.argb(150, 255, 225, 70)
            canvas.drawRect(slotRect.left, slotRect.bottom - slotRect.height() * share, slotRect.right, slotRect.bottom, paint)
        }
        when {
            !open -> {
                dashed.color = Color.rgb(120, 122, 130)
                dashed.strokeWidth = 2f * density
                canvas.drawRoundRect(slotRect, 6f * density, 6f * density, dashed)
            }
            else -> {
                val pulse = if (target && !confirming) ((sin(now / 120_000_000.0) + 1.0) * 0.5).toFloat() else 0f
                stroke.color = if (target) HIGHLIGHT else Color.WHITE
                stroke.strokeWidth = (2.5f + pulse * 2f) * density
                canvas.drawRoundRect(slotRect, 6f * density, 6f * density, stroke)
            }
        }
        val glyph = when {
            !open -> Color.rgb(110, 112, 120)
            selected || confirming -> Color.rgb(20, 20, 24)
            else -> Color.WHITE
        }
        val cx = slotRect.centerX()
        val cy = slotRect.centerY()
        val len = slotRect.width() * 0.32f
        if (confirming) {
            stroke.color = glyph
            stroke.strokeWidth = 4f * density
            canvas.drawLine(cx - len * 0.8f, cy, cx - len * 0.2f, cy + len * 0.6f, stroke)
            canvas.drawLine(cx - len * 0.2f, cy + len * 0.6f, cx + len, cy - len * 0.7f, stroke)
            return
        }
        when (lane) {
            GhoulLane.Left -> drawArrow(canvas, cx, cy, -1f, 0f, glyph, len * 2f)
            GhoulLane.Center -> drawArrow(canvas, cx, cy, 0f, -1f, glyph, len * 2f)
            GhoulLane.Right -> drawArrow(canvas, cx, cy, 1f, 0f, glyph, len * 2f)
        }
    }

    private fun drawHint(canvas: Canvas, gaugeTop: Float) {
        val hint = game.hint() ?: return
        val controllerOnly = inputSource == GhoulRunInputSource.Controller
        val value = when (hint) {
            GhoulHint.ChooseTurn -> if (controllerOnly) "PRESS LEFT OR RIGHT TO TURN" else "LEAN LEFT OR RIGHT TO TURN"
            GhoulHint.PedalPastGhoul -> "PEDAL PAST THE GHOUL MARK"
            GhoulHint.StayQuiet -> "EASE OFF - STAY QUIET"
            GhoulHint.LeanToChoose -> if (controllerOnly) "PRESS LEFT/RIGHT TO CHOOSE" else "LEAN TO CHOOSE"
            GhoulHint.RideThroughShrine -> "RIDE THROUGH THE SHRINE"
        }
        val color = when (hint) {
            GhoulHint.ChooseTurn -> HIGHLIGHT
            GhoulHint.PedalPastGhoul -> Color.rgb(255, 90, 80)
            GhoulHint.StayQuiet -> SEARCHING
            GhoulHint.LeanToChoose -> HIGHLIGHT
            GhoulHint.RideThroughShrine -> SHRINE_READY
        }
        banner(canvas, value, fpRect.centerX(), gaugeTop - 12f * density, fpRect.width() * 0.47f, color, 15f)
    }

    /** Bike-computer gauge: live RPM, filtered-RPM needle, ear and outrun markers from config. */
    private fun drawSpeedGauge(canvas: Canvas, gaugeTop: Float, now: Long) {
        val reading = session.cadenceReading
        val panelL = fpRect.left + 10f * density
        val panelR = fpRect.right - 10f * density
        val panelT = gaugeTop
        val panelB = fpRect.bottom - 8f * density
        paint.color = PANEL_STRONG
        canvas.drawRoundRect(panelL, panelT, panelR, panelB, 8f * density, 8f * density, paint)

        text.textAlign = Paint.Align.LEFT
        text.textSize = 40f * density
        text.color = Color.WHITE
        val rpmText = if (reading.rawRpm >= 0) reading.rawRpm.toString() else "--"
        val rpmX = panelL + 14f * density
        val rpmY = panelT + 44f * density
        canvas.drawText(rpmText, rpmX, rpmY, text)
        val rpmWidth = text.measureText(rpmText)
        text.textSize = 13f * density
        text.color = LABEL
        canvas.drawText("RPM", rpmX + rpmWidth + 6f * density, rpmY, text)

        val hunted = game.ghoul.state == GhoulState.Hunting
        val (status, statusColor) = when {
            game.phase == GhoulPhase.WarmUp -> "WARM UP" to Color.WHITE
            hunted && game.speed > game.ghoulHuntSpeed -> "PULLING AWAY" to RIDER
            hunted -> "IT'S GAINING" to GHOUL
            game.ghoul.state == GhoulState.Searching -> "STAY QUIET" to SEARCHING
            else -> "QUIET" to QUIET_TEXT
        }
        text.textAlign = Paint.Align.RIGHT
        text.textSize = 20f * density
        text.color = statusColor
        canvas.drawText(status, panelR - 14f * density, rpmY - 4f * density, text)
        text.textAlign = Paint.Align.LEFT

        val marks = game.gaugeMarks(reading.baseline, game.pathGap) ?: return
        val barL = panelL + 16f * density
        val barR = panelR - 16f * density
        val barT = panelT + 70f * density
        val barB = barT + 14f * density
        fun xFor(rpm: Float): Float = barL + (barR - barL) * ((rpm - marks.lowRpm) / (marks.highRpm - marks.lowRpm)).coerceIn(0f, 1f)
        val earX = marks.earRpm?.let(::xFor)
        paint.color = GAUGE_QUIET
        canvas.drawRect(barL, barT, earX ?: barR, barB, paint)
        if (earX != null) {
            paint.color = GAUGE_HEARD
            canvas.drawRect(earX, barT, barR, barB, paint)
        }

        text.textSize = 11f * density
        if (earX != null) {
            stroke.color = Color.WHITE
            stroke.strokeWidth = 2.5f * density
            canvas.drawLine(earX, barT - 12f * density, earX, barB, stroke)
            drawEar(canvas, earX, barT - 18f * density)
            text.color = Color.WHITE
            labelAt(canvas, "IT HEARS YOU", earX + 12f * density, barT - 13f * density, panelL, panelR, alignLeft = true)
        } else {
            text.color = QUIET_TEXT
            labelAt(canvas, "CAN'T HEAR YOU", barL, barT - 8f * density, panelL, panelR, alignLeft = true)
        }

        val outX = xFor(marks.outrunRpm)
        val pulse = if (hunted) ((sin(now / 110_000_000.0) + 1.0) * 0.5).toFloat() else 0f
        stroke.color = GHOUL
        stroke.strokeWidth = (if (hunted) 4f + pulse * 2f else 2.5f) * density
        canvas.drawLine(outX, barT, outX, barB + 10f * density, stroke)
        paint.color = GHOUL
        canvas.drawCircle(outX, barB + 13f * density, (if (hunted) 5f + pulse * 1.5f else 4f) * density, paint)
        text.textSize = (if (hunted) 13f else 11f) * density
        text.color = if (hunted) GHOUL else Color.rgb(220, 120, 115)
        labelAt(canvas, "YOU OUTRUN IT", outX + 10f * density, barB + 18f * density, panelL, panelR, alignLeft = true)

        val needleX = xFor(reading.filteredRpm)
        stroke.color = Color.WHITE
        stroke.strokeWidth = 3f * density
        canvas.drawLine(needleX, barT - 3f * density, needleX, barB + 3f * density, stroke)
        paint.color = Color.WHITE
        path.reset()
        path.moveTo(needleX, barT - 2f * density)
        path.lineTo(needleX - 6f * density, barT - 11f * density)
        path.lineTo(needleX + 6f * density, barT - 11f * density)
        path.close()
        canvas.drawPath(path, paint)
    }

    private fun drawEar(canvas: Canvas, x: Float, y: Float) {
        stroke.color = Color.WHITE
        stroke.strokeWidth = 2f * density
        val r = 5f * density
        slotRect.set(x - r, y - r * 1.3f, x + r, y + r * 1.3f)
        canvas.drawArc(slotRect, 160f, 250f, false, stroke)
    }

    private fun labelAt(canvas: Canvas, value: String, x: Float, y: Float, minX: Float, maxX: Float, alignLeft: Boolean) {
        val width = text.measureText(value)
        var start = if (alignLeft) x else x - width
        if (start + width > maxX - 6f * density) start = x - width - 24f * density
        start = start.coerceIn(minX + 6f * density, maxX - width - 6f * density)
        canvas.drawText(value, start, y, text)
    }

    private fun drawPhase(canvas: Canvas, gaugeTop: Float) {
        val cx = fpRect.centerX()
        val maxHalf = fpRect.width() * 0.47f
        val midY = fpRect.top + (gaugeTop - fpRect.top) * 0.5f
        when (game.phase) {
            GhoulPhase.WarmUp -> {
                val card = WARMUP_CARDS[(game.warmupTime / WARMUP_CARD_SECONDS).toInt() % WARMUP_CARDS.size]
                val parts = card.split(" - ")
                banner(
                    canvas,
                    "WARM UP - PEDAL AT YOUR NORMAL PACE  ${ceil(session.cadenceReading.warmupRemaining).toInt()}",
                    cx, midY - 50f * density, maxHalf, LABEL, 13f,
                )
                banner(canvas, parts[0], cx, midY, maxHalf, Color.WHITE, 18f)
                if (parts.size > 1) banner(canvas, parts[1], cx, midY + 34f * density, maxHalf, HIGHLIGHT, 16f)
            }
            GhoulPhase.LeanCheck -> {
                val press = inputSource == GhoulRunInputSource.Controller
                val label = when (game.leanCheckTarget) {
                    GhoulLane.Left -> if (press) "PRESS LEFT" else "LEAN LEFT"
                    GhoulLane.Right -> if (press) "PRESS RIGHT" else "LEAN RIGHT"
                    GhoulLane.Center -> if (press) "CENTER - PRESS RIGHT AGAIN" else "CENTER"
                    null -> "GO"
                }
                val done = game.leanCheckConfirmLeft > 0f
                banner(canvas, if (done) "$label ✓" else label, cx, midY, maxHalf, if (done) EXIT_OPEN else Color.WHITE, 30f)
            }
            GhoulPhase.Results -> game.results?.let {
                banner(canvas, "ESCAPED  ${it.seconds.toInt()}s  CATCHES ${it.catches}", cx, midY, maxHalf, EXIT_OPEN)
            }
            GhoulPhase.Countdown -> banner(
                canvas,
                "NEW MAZE IN ${ceil(game.phaseLeft).toInt().coerceAtLeast(1)}",
                cx, midY, maxHalf, Color.WHITE,
            )
            GhoulPhase.Playing -> Unit
        }
    }

    /** Catch flash, CAUGHT! text, out-of-hearts fade and the checkpoint fade-in, across both halves. */
    private fun drawScreenFeedback(canvas: Canvas, now: Long, top: Float) {
        val event = shownCatch
        val age = if (event != null && catchAtNanos != Long.MIN_VALUE) now - catchAtNanos else Long.MAX_VALUE
        if (age in 0 until FLASH_NANOS) {
            paint.color = Color.argb(((1f - age.toFloat() / FLASH_NANOS) * 170).toInt(), 255, 20, 20)
            canvas.drawRect(0f, top, width.toFloat(), height.toFloat(), paint)
        }
        if (game.respawnLeft > 0f) {
            val fade = (1f - game.respawnLeft / FADE_SECONDS).coerceIn(0f, 1f)
            if (fade > 0f) {
                paint.color = Color.argb((fade * 255).toInt(), 0, 0, 0)
                canvas.drawRect(0f, top, width.toFloat(), height.toFloat(), paint)
            }
        }
        val respawnAge = if (respawnAtNanos != Long.MIN_VALUE) now - respawnAtNanos else Long.MAX_VALUE
        if (respawnAge in 0 until FADE_NANOS) {
            paint.color = Color.argb(((1f - respawnAge.toFloat() / FADE_NANOS) * 255).toInt(), 0, 0, 0)
            canvas.drawRect(0f, top, width.toFloat(), height.toFloat(), paint)
        }
        val cx = fpRect.centerX()
        val y = fpRect.top + fpRect.height() * 0.38f
        if (event != null && (age in 0 until CAUGHT_NANOS || game.respawnLeft > 0f)) {
            bigText(canvas, "CAUGHT!", cx, y, 46f, Color.rgb(255, 60, 55))
            val sub = when {
                event.respawned -> "OUT OF HEARTS"
                event.heartsLeft == 1 -> "1 HEART LEFT"
                else -> "${event.heartsLeft} HEARTS LEFT"
            }
            bigText(canvas, sub, cx, y + 36f * density, 20f, Color.WHITE)
        } else if (respawnAge in 0 until BACK_AT_NANOS) {
            bigText(canvas, if (respawnAtStart) "BACK AT START" else "BACK AT CHECKPOINT", cx, y, 24f, Color.WHITE)
        }
    }

    private fun bigText(canvas: Canvas, value: String, cx: Float, y: Float, sizeDp: Float, color: Int) {
        text.textSize = sizeDp * density
        text.textAlign = Paint.Align.CENTER
        text.color = Color.BLACK
        canvas.drawText(value, cx + 2f * density, y + 2f * density, text)
        text.color = color
        canvas.drawText(value, cx, y, text)
        text.textAlign = Paint.Align.LEFT
    }

    // ---------------------------------------------------------------- map half

    private fun drawMapHalf(canvas: Canvas, now: Long) {
        val hunted = game.ghoul.state == GhoulState.Hunting
        val zoom = if (hunted) 0.80f else 1f
        val baseW = min(mapRect.width() / 10f, mapRect.height() / 7f).roundToInt().toFloat()
        val tileW = baseW * zoom
        val tileH = tileW / 2f
        val ox = mapRect.centerX()
        val oy = mapRect.centerY()
        refreshNoiseDistances()
        canvas.save()
        canvas.scale(zoom, zoom, ox, oy)
        drawMaze(canvas, ox, oy, baseW, baseW / 2f)
        canvas.restore()
        drawLampShade(canvas, ox, oy, tileW, tileH)
        drawEntities(canvas, ox, oy, tileW, tileH, now)
        drawThreat(canvas, ox, oy, tileW, tileH, now)
        if (game.config.keyCount > 0) {
            text.textSize = 14f * density
            text.color = Color.WHITE
            canvas.drawText("KEYS ${game.keysFound}/${game.config.keyCount}", mapRect.left + 12f * density, mapRect.bottom - 14f * density, text)
        }
        text.textSize = 11f * density
        text.color = LABEL
        text.textAlign = Paint.Align.RIGHT
        canvas.drawText("MAP", mapRect.right - 10f * density, mapRect.bottom - 10f * density, text)
        text.textAlign = Paint.Align.LEFT
    }

    private fun refreshNoiseDistances() {
        val width = game.config.width
        if (game.phase != GhoulPhase.Playing || game.noiseRadius <= 0f) {
            cellPathDistance.fill(Float.POSITIVE_INFINITY)
            return
        }
        game.fillRiderPathDistances(cellPathDistance)
    }

    /**
     * Explored tiles come from a cached layer bitmap that only gains the newly revealed tiles (plus
     * a redraw of their front neighbours to keep isometric overlap right); per frame the map is one
     * bitmap, the noise tint and the objectives. Rebuilding paths or tiles every frame costs far
     * too much on the console's interpreted runtime.
     */
    private fun drawMaze(canvas: Canvas, ox: Float, oy: Float, tw: Float, th: Float) {
        ensureTileArt(tw, th)
        updateMapLayer(tw, th)
        val layer = mapLayer ?: return
        val camR = cameraRow * 2f + 1f
        val camC = cameraCol * 2f + 1f
        canvas.drawBitmap(
            layer,
            ox - mapOriginX - (camC - camR) * tw / 2f,
            oy - mapOriginY - (camC + camR) * th / 2f,
            layerPaint,
        )
        drawNoiseTint(canvas, ox, oy, tw, th, camR, camC)
        val light = game.lightRadius
        for (cell in game.world.shrines) drawObjectiveAt(canvas, cell, ox, oy, tw, th, camR, camC, light)
        drawObjectiveAt(canvas, game.world.exit, ox, oy, tw, th, camR, camC, light)
        for (cell in game.world.keys) if (cell !in game.collectedKeys) drawObjectiveAt(canvas, cell, ox, oy, tw, th, camR, camC, light)
    }

    private fun drawObjectiveAt(
        canvas: Canvas,
        cell: MazeCell,
        ox: Float,
        oy: Float,
        tw: Float,
        th: Float,
        camR: Float,
        camC: Float,
        light: Float,
    ) {
        val row = 2 * cell.row + 1
        val col = 2 * cell.col + 1
        if (!game.isExplored(row, col)) return
        val dr = row - camR
        val dc = col - camC
        val x = ox + (dc - dr) * tw / 2f
        val y = oy + (dc + dr) * th / 2f
        if (x < mapRect.left - tw * 2 || x > mapRect.right + tw * 2 || y < mapRect.top - tw * 2 || y > mapRect.bottom + tw * 2) return
        val lr = cell.row - game.riderRow
        val lc = cell.col - game.riderCol
        drawObjective(canvas, MazeTile(row, col), x to y, tw, th, lr * lr + lc * lc <= light * light)
    }

    /** Faint tint over floor within the current noise radius, by maze-path distance. */
    private fun drawNoiseTint(canvas: Canvas, ox: Float, oy: Float, tw: Float, th: Float, camR: Float, camC: Float) {
        val noise = game.noiseRadius
        val art = noiseTile ?: return
        if (noise <= 0f || game.phase != GhoulPhase.Playing) return
        val width = game.config.width
        val height = game.config.height
        val halfW = art.width / 2f
        val halfH = art.height / 2f
        for (index in cellPathDistance.indices) {
            val d = cellPathDistance[index]
            if (d > noise) continue
            val r = index / width
            val c = index % width
            tintTile(canvas, art, 2 * r + 1, 2 * c + 1, ox, oy, tw, th, camR, camC, halfW, halfH)
            if (c + 1 < width && game.world.isOpen(MazeCell(r, c), MazeDirection.East) &&
                min(d, cellPathDistance[index + 1]) + 0.5f <= noise
            ) tintTile(canvas, art, 2 * r + 1, 2 * c + 2, ox, oy, tw, th, camR, camC, halfW, halfH)
            if (r + 1 < height && game.world.isOpen(MazeCell(r, c), MazeDirection.South) &&
                min(d, cellPathDistance[index + width]) + 0.5f <= noise
            ) tintTile(canvas, art, 2 * r + 2, 2 * c + 1, ox, oy, tw, th, camR, camC, halfW, halfH)
        }
    }

    private fun tintTile(
        canvas: Canvas,
        art: Bitmap,
        row: Int,
        col: Int,
        ox: Float,
        oy: Float,
        tw: Float,
        th: Float,
        camR: Float,
        camC: Float,
        halfW: Float,
        halfH: Float,
    ) {
        if (!game.isExplored(row, col)) return
        val dr = row - camR
        val dc = col - camC
        canvas.drawBitmap(art, ox + (dc - dr) * tw / 2f - halfW, oy + (dc + dr) * th / 2f - halfH, null)
    }

    /** Dims everything outside the lamp: an elliptical (isometric circle) gradient centred on the rider. */
    private fun drawLampShade(canvas: Canvas, ox: Float, oy: Float, tw: Float, th: Float) {
        if (darkPaint.shader == null) {
            darkPaint.shader = RadialGradient(
                0f, 0f, 1f,
                intArrayOf(Color.TRANSPARENT, Color.TRANSPARENT, Color.argb(170, 0, 0, 0)),
                floatArrayOf(0f, 0.72f, 1f),
                Shader.TileMode.CLAMP,
            )
        }
        val camR = cameraRow * 2f + 1f
        val camC = cameraCol * 2f + 1f
        val dr = game.riderRow * 2f + 1f - camR
        val dc = game.riderCol * 2f + 1f - camC
        val x = ox + (dc - dr) * tw / 2f
        val y = oy + (dc + dr) * th / 2f
        val radius = max(game.lightRadius, 0.05f) * SQRT2
        darkMatrix.reset()
        darkMatrix.setScale(radius * tw, radius * th)
        darkMatrix.postTranslate(x, y)
        darkPaint.shader.setLocalMatrix(darkMatrix)
        canvas.drawRect(mapRect, darkPaint)
    }

    private fun updateMapLayer(tw: Float, th: Float) {
        val rows = game.world.tileRows
        val cols = game.world.tileCols
        val explored = game.exploredTiles
        val stale = mapLayer == null || mapLayerGame !== game || mapLayerSeed != game.world.seed ||
            explored.size < mapLayerCount || mapLayer?.width != layerWidth(tw, rows, cols)
        if (stale) {
            mapLayer?.recycle()
            val pad = 2f
            mapOriginX = rows * tw / 2f + pad
            mapOriginY = th * 0.55f + th / 2f + pad
            val bitmap = Bitmap.createBitmap(layerWidth(tw, rows, cols), ceil((rows + cols) * th / 2f + th * 0.55f + 2 * pad + th).toInt(), Bitmap.Config.ARGB_8888)
            mapLayer = bitmap
            mapLayerCanvas = Canvas(bitmap)
            mapLayerGame = game
            mapLayerSeed = game.world.seed
            mapLayerCount = 0
        }
        if (explored.size == mapLayerCount) return
        val layerCanvas = mapLayerCanvas ?: return
        newTiles.clear()
        var index = 0
        for (tile in explored) {
            if (index++ < mapLayerCount) continue
            newTiles += tile
        }
        mapLayerCount = explored.size
        val fresh = newTiles.size
        for (i in 0 until fresh) {
            val tile = newTiles[i]
            for ((r, c) in arrayOf(tile.row + 1 to tile.col, tile.row to tile.col + 1, tile.row + 1 to tile.col + 1)) {
                if (game.isExplored(r, c)) newTiles += MazeTile(r, c)
            }
        }
        newTiles.sortWith(compareBy<MazeTile> { it.row + it.col }.thenBy { it.row })
        var previous: MazeTile? = null
        for (tile in newTiles) {
            if (tile == previous) continue
            previous = tile
            drawLayerTile(layerCanvas, tile, tw, th)
        }
    }

    private fun layerWidth(tw: Float, rows: Int, cols: Int): Int = ceil((rows + cols) * tw / 2f + 4f + tw).toInt()

    private fun drawLayerTile(layerCanvas: Canvas, tile: MazeTile, tw: Float, th: Float) {
        val floor = floorLitTile ?: return
        val wall = wallLitTile ?: return
        val x = mapOriginX + (tile.col - tile.row) * tw / 2f
        val y = mapOriginY + (tile.col + tile.row) * th / 2f
        if (game.world.isFloorTile(tile)) {
            layerCanvas.drawBitmap(floor, x - floor.width / 2f, y - floor.height / 2f, null)
        } else {
            layerCanvas.drawBitmap(wall, x - floor.width / 2f, y - wallTileTop, null)
        }
    }

    private fun ensureTileArt(tw: Float, th: Float) {
        val key = tw.roundToInt()
        if (key == tileArtWidth && floorLitTile != null) return
        tileArtWidth = key
        listOf(floorLitTile, noiseTile, wallLitTile).forEach { it?.recycle() }
        val w = ceil(tw).toInt() + 2
        val h = ceil(th).toInt() + 2
        fun floor(color: Int): Bitmap {
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            paint.color = color
            diamond(Canvas(bitmap), w / 2f, h / 2f, tw / 2f, th / 2f, paint)
            return bitmap
        }
        floorLitTile = floor(FLOOR_LIT)
        noiseTile = floor(NOISE_TINT)
        val rise = th * 0.55f
        wallTileTop = h / 2f + rise
        val bitmap = Bitmap.createBitmap(w, ceil(wallTileTop + th / 2f).toInt() + 2, Bitmap.Config.ARGB_8888)
        drawWallBlock(Canvas(bitmap), w / 2f, wallTileTop, tw, th, true)
        wallLitTile = bitmap
        mapLayer?.recycle()
        mapLayer = null
    }

    private fun drawWallBlock(canvas: Canvas, cx: Float, cy: Float, tw: Float, th: Float, lit: Boolean) {
        val rise = th * 0.55f
        val topColor = if (lit) WALL_TOP else dim(WALL_TOP)
        val leftColor = if (lit) WALL_LEFT else dim(WALL_LEFT)
        val rightColor = if (lit) WALL_RIGHT else dim(WALL_RIGHT)
        paint.color = leftColor
        path.reset()
        path.moveTo(cx - tw / 2f, cy)
        path.lineTo(cx, cy + th / 2f)
        path.lineTo(cx, cy + th / 2f - rise)
        path.lineTo(cx - tw / 2f, cy - rise)
        path.close()
        canvas.drawPath(path, paint)
        paint.color = rightColor
        path.reset()
        path.moveTo(cx + tw / 2f, cy)
        path.lineTo(cx, cy + th / 2f)
        path.lineTo(cx, cy + th / 2f - rise)
        path.lineTo(cx + tw / 2f, cy - rise)
        path.close()
        canvas.drawPath(path, paint)
        paint.color = topColor
        diamond(canvas, cx, cy - rise, tw / 2f, th / 2f, paint)
    }

    private fun drawObjective(
        canvas: Canvas,
        tile: MazeTile,
        centre: Pair<Float, Float>,
        tw: Float,
        th: Float,
        lit: Boolean,
    ) {
        if (tile.row % 2 == 0 || tile.col % 2 == 0) return
        val cell = MazeCell((tile.row - 1) / 2, (tile.col - 1) / 2)
        when {
            cell in game.world.keys && cell !in game.collectedKeys -> {
                paint.color = if (lit) KEY else dim(KEY)
                canvas.drawCircle(centre.first, centre.second - th * 0.18f, tw * 0.08f, paint)
            }
            cell in game.world.shrines -> {
                val ready = (game.shrineCooldowns[cell] ?: 0f) <= 0f
                paint.color = if (ready && lit) SHRINE_READY else SHRINE_DIM
                diamond(canvas, centre.first, centre.second - th * 0.08f, tw * 0.18f, th * 0.18f, paint)
            }
            cell == game.world.exit -> {
                paint.color = if (game.exitOpen) EXIT_OPEN else EXIT_LOCKED
                canvas.drawRect(
                    centre.first - tw * 0.14f,
                    centre.second - th * 0.58f,
                    centre.first + tw * 0.14f,
                    centre.second,
                    paint,
                )
            }
        }
    }

    private fun drawEntities(canvas: Canvas, ox: Float, oy: Float, tw: Float, th: Float, now: Long) {
        if (game.ghoul.state != GhoulState.Inactive) {
            val ghoulPoint = projectWorld(game.ghoul.row, game.ghoul.col, ox, oy, tw, th)
            paint.color = if (game.ghoul.state == GhoulState.Stunned) GHOUL_STUNNED else GHOUL
            canvas.drawRect(
                ghoulPoint.first - tw * 0.16f,
                ghoulPoint.second - th * 0.78f,
                ghoulPoint.first + tw * 0.16f,
                ghoulPoint.second,
                paint,
            )
        }
        val riderRow = (rig.y - 1.5f) / 2f
        val riderCol = (rig.x - 1.5f) / 2f
        val rider = projectWorld(riderRow, riderCol, ox, oy, tw, th)
        // View cone matching the first-person facing.
        path.reset()
        path.moveTo(rider.first, rider.second)
        val half = (FOV_DEGREES / 2f) * PI.toFloat() / 180f
        for (step in 0..8) {
            val angle = rig.yaw - half + 2f * half * step / 8f
            val p = projectWorld(riderRow + sin(angle) * CONE_CELLS, riderCol + cos(angle) * CONE_CELLS, ox, oy, tw, th)
            path.lineTo(p.first, p.second)
        }
        path.close()
        paint.color = CONE
        canvas.drawPath(path, paint)

        val blinkOff = game.invulnerableLeft > 0f && (now / BLINK_NANOS) % 2L == 1L
        if (!blinkOff) {
            paint.color = RIDER
            path.reset()
            path.moveTo(rider.first, rider.second - th * 0.72f)
            path.lineTo(rider.first - tw * 0.14f, rider.second)
            path.lineTo(rider.first + tw * 0.14f, rider.second)
            path.close()
            canvas.drawPath(path, paint)
        }
    }

    /** Arrow of [length] centred on (x, y), pointing along (dx, dy). */
    private fun drawArrow(canvas: Canvas, x: Float, y: Float, dx: Float, dy: Float, color: Int, length: Float) {
        val magnitude = kotlin.math.hypot(dx, dy).coerceAtLeast(0.001f)
        val ux = dx / magnitude
        val uy = dy / magnitude
        val ex = x + ux * length * 0.5f
        val ey = y + uy * length * 0.5f
        stroke.color = color
        stroke.strokeWidth = max(3f, length * 0.14f)
        canvas.drawLine(x - ux * length * 0.5f, y - uy * length * 0.5f, ex - ux * length * 0.2f, ey - uy * length * 0.2f, stroke)
        paint.color = color
        path.reset()
        path.moveTo(ex, ey)
        path.lineTo(ex - ux * length * 0.4f - uy * length * 0.26f, ey - uy * length * 0.4f + ux * length * 0.26f)
        path.lineTo(ex - ux * length * 0.4f + uy * length * 0.26f, ey - uy * length * 0.4f - ux * length * 0.26f)
        path.close()
        canvas.drawPath(path, paint)
    }

    private fun drawThreat(canvas: Canvas, ox: Float, oy: Float, tw: Float, th: Float, now: Long) {
        val state = game.ghoul.state
        if (state != GhoulState.Hunting && state != GhoulState.Searching) return
        val hunted = state == GhoulState.Hunting
        val pulse = ((sin(now / 160_000_000.0) + 1.0) * 0.5).toFloat()
        if (hunted) {
            stroke.strokeWidth = (5f + pulse * 6f) * density
            stroke.color = Color.argb((130 + pulse * 100).toInt(), 255, 35, 35)
            canvas.drawRect(mapRect.left + 3f * density, mapRect.top + 3f * density, mapRect.right - 3f * density, mapRect.bottom - 3f * density, stroke)
        }
        val label = if (hunted) "HUNTED" else "SEARCHING"
        banner(
            canvas,
            "$label  GAP ${String.format(Locale.US, "%.1f", game.pathGap)}",
            mapRect.centerX(),
            mapRect.top + 32f * density,
            mapRect.width() * 0.47f,
            if (hunted) Color.rgb(255, 75, 60) else SEARCHING,
        )
        val p = projectWorld(game.ghoul.row, game.ghoul.col, ox, oy, tw, th)
        if (p.first !in mapRect.left..mapRect.right || p.second !in mapRect.top..mapRect.bottom) {
            paint.color = if (hunted) GHOUL else SEARCHING
            canvas.drawCircle(
                p.first.coerceIn(mapRect.left + 14f * density, mapRect.right - 14f * density),
                p.second.coerceIn(mapRect.top + 14f * density, mapRect.bottom - 14f * density),
                9f * density,
                paint,
            )
        }
    }

    // ---------------------------------------------------------------- shared chrome

    private fun drawSelectors(canvas: Canvas) {
        val h = 32f * density
        val y = 6f * density
        val w = 94f * density
        webcamRect.set(8f * density, y, 8f * density + w, y + h)
        controllerRect.set(webcamRect.right + 6f * density, y, webcamRect.right + 6f * density + w, y + h)
        bothRect.set(controllerRect.right + 6f * density, y, controllerRect.right + 6f * density + 70f * density, y + h)
        difficultyRect.set(width - 150f * density, y, width - 8f * density, y + h)
        selector(canvas, webcamRect, "WEBCAM", inputSource == GhoulRunInputSource.Webcam, true)
        selector(canvas, controllerRect, "CONTROLLER", inputSource == GhoulRunInputSource.Controller, controllerAvailable)
        selector(canvas, bothRect, "BOTH", inputSource == GhoulRunInputSource.Both, controllerAvailable)
        selector(canvas, difficultyRect, "+${SPRINT_DELTAS[difficultyIndex]} RPM", true, true)
    }

    private fun selector(canvas: Canvas, rect: RectF, label: String, selected: Boolean, enabled: Boolean) {
        paint.color = when {
            !enabled -> Color.rgb(35, 35, 38)
            selected -> Color.rgb(40, 118, 76)
            else -> Color.rgb(68, 68, 74)
        }
        canvas.drawRect(rect, paint)
        text.textSize = 11f * density
        text.textAlign = Paint.Align.CENTER
        text.color = if (enabled) Color.WHITE else Color.GRAY
        canvas.drawText(label, rect.centerX(), rect.centerY() + text.textSize * 0.35f, text)
        text.textAlign = Paint.Align.LEFT
    }

    private fun timingLine(): String {
        val gpu = glRenderer
        if (glSelection.type == GhoulRendererType.Gl) return String.format(
            Locale.US,
            "renderer GL %dx%d frames %d error 0x%04x | gl %.1f ms gl-frame %.1f ms | canvas %.1f ms | update %.1f ms | host-frame %.1f ms (%.0f fps)",
            gpu?.surfaceWidth ?: 0,
            gpu?.surfaceHeight ?: 0,
            gpu?.framesDrawn ?: 0L,
            gpu?.lastGlError ?: 0,
            (gpu?.frameNanos ?: 0L) / 1_000_000f,
            (gpu?.frameIntervalNanos ?: 0L) / 1_000_000f,
            drawMs,
            updateMs,
            frameIntervalMs,
            if (frameIntervalMs > 0f) 1000f / frameIntervalMs else 0f,
        )
        val fp = renderer
        return String.format(
            Locale.US,
            "renderer fallback gl %dx%d frames %d error 0x%04x | fp %dx%d render %.1f ms (cast %.1f cols %.1f sprites %.1f) upload+blit %.1f ms | canvas %.1f ms | update %.1f ms | host-frame %.1f ms (%.0f fps)",
            gpu?.surfaceWidth ?: 0,
            gpu?.surfaceHeight ?: 0,
            gpu?.framesDrawn ?: 0L,
            gpu?.lastGlError ?: 0,
            fp?.width ?: 0,
            fp?.height ?: 0,
            fpRenderMs,
            (fp?.castNanos ?: 0L) / 1_000_000f,
            (fp?.columnNanos ?: 0L) / 1_000_000f,
            (fp?.spriteNanos ?: 0L) / 1_000_000f,
            fpUploadMs,
            drawMs,
            updateMs,
            frameIntervalMs,
            if (frameIntervalMs > 0f) 1000f / frameIntervalMs else 0f,
        )
    }

    private fun buildDiagnostics(): List<String> {
        val cadence = session.cadenceReading
        return listOf(
            timingLine(),
            String.format(
                Locale.US,
                "baseline %s filtered %.1f speed %.2f light %.1f noise %.1f",
                if (cadence.baseline.isNaN()) "-" else "%.1f".format(Locale.US, cadence.baseline),
                cadence.filteredRpm,
                game.speed,
                game.lightRadius,
                game.noiseRadius,
            ),
            "lean ${String.format(Locale.US, "%.2f", game.lean)} lane ${session.lane} locked ${game.lockedChoice ?: "-"} " +
                "brake ${game.brakingForChoice} hold ${session.hold}",
            String.format(
                Locale.US,
                "ghoul %s gap %.2f stun %.1f inv %.1f phase %s",
                game.ghoul.state,
                game.pathGap,
                game.ghoul.stunLeft,
                game.invulnerableLeft,
                game.phase,
            ),
            diagnosticsText,
        )
    }

    /** Formatting is slow on the interpreted console runtime, so the overlay text refreshes 4x a second. */
    private fun drawDiagnostics(canvas: Canvas) {
        val now = System.nanoTime()
        if (now - diagnosticsBuiltAt > DIAGNOSTICS_REFRESH_NANOS) {
            diagnosticsBuiltAt = now
            diagnosticsLines = buildDiagnostics()
        }
        val lines = diagnosticsLines
        text.textSize = 10f * density
        val lineHeight = 14f * density
        val left = mapRect.left + 8f * density
        val top = mapRect.top + 52f * density
        paint.color = Color.argb(210, 0, 0, 0)
        canvas.drawRect(left, top, width - 8f * density, top + lines.size * lineHeight + 8f * density, paint)
        text.color = Color.WHITE
        lines.forEachIndexed { index, line ->
            canvas.drawText(line, left + 4f * density, top + (index + 1) * lineHeight, text)
        }
    }

    private fun banner(canvas: Canvas, value: String, cx: Float, y: Float, maxHalf: Float, color: Int, sizeDp: Float = 19f) {
        text.textSize = sizeDp * density
        text.textAlign = Paint.Align.CENTER
        paint.color = Color.argb(220, 0, 0, 0)
        val half = min(maxHalf, text.measureText(value) / 2f + 14f * density)
        canvas.drawRect(cx - half, y - text.textSize * 1.35f, cx + half, y + text.textSize * 0.6f, paint)
        text.color = color
        canvas.drawText(value, cx, y, text)
        text.textAlign = Paint.Align.LEFT
    }

    private fun projectWorld(row: Float, col: Float, ox: Float, oy: Float, tw: Float, th: Float): Pair<Float, Float> =
        projectTile(row * 2f + 1f, col * 2f + 1f, ox, oy, tw, th)

    private fun projectTile(row: Float, col: Float, ox: Float, oy: Float, tw: Float, th: Float): Pair<Float, Float> {
        val dr = row - (cameraRow * 2f + 1f)
        val dc = col - (cameraCol * 2f + 1f)
        return ox + (dc - dr) * tw / 2f to oy + (dc + dr) * th / 2f
    }

    private fun diamond(canvas: Canvas, cx: Float, cy: Float, hw: Float, hh: Float, source: Paint) {
        path.reset()
        path.moveTo(cx, cy - hh)
        path.lineTo(cx + hw, cy)
        path.lineTo(cx, cy + hh)
        path.lineTo(cx - hw, cy)
        path.close()
        canvas.drawPath(path, source)
    }

    private fun dim(color: Int): Int = Color.rgb(Color.red(color) / 3, Color.green(color) / 3, Color.blue(color) / 3)

    private fun ema(previous: Float, sample: Float): Float = if (previous <= 0f) sample else previous + (sample - previous) * 0.1f

    private fun handleTouch(event: MotionEvent): Boolean {
        if (event.actionMasked != MotionEvent.ACTION_UP) return true
        when {
            webcamRect.contains(event.x, event.y) -> selectInputSource(GhoulRunInputSource.Webcam)
            controllerRect.contains(event.x, event.y) -> selectInputSource(GhoulRunInputSource.Controller)
            bothRect.contains(event.x, event.y) -> selectInputSource(GhoulRunInputSource.Both)
            difficultyRect.contains(event.x, event.y) -> selectDeveloperOption(0)
        }
        overlay.performClick()
        return true
    }

    private fun newGame(seed: Long): GhoulRunGame =
        GhoulRunGame(GhoulRunConfig(sprintDelta = SPRINT_DELTAS[difficultyIndex].toFloat()), seed)

    private companion object {
        const val TAG = "GhoulRun"
        const val PREFS = "fitbaus_arcade"
        const val DIFFICULTY_KEY = "ghoul_run_sprint_delta"
        const val STALL_NANOS = 500_000_000L
        const val TIMING_LOG_NANOS = 5_000_000_000L
        const val DIAGNOSTICS_REFRESH_NANOS = 250_000_000L
        const val TOP_UI = 54f

        /** Share of the width given to the first-person (left) half. */
        const val SPLIT_RATIO = 0.5f
        const val FP_PIXELS_WIDE = 320
        const val GL_RENDER_SCALE = 1f
        const val LIGHT_STEPS = 32
        val SQRT2 = kotlin.math.sqrt(2f)
        const val FOV_DEGREES = 70f
        const val BOB_AMPLITUDE = 0.012f
        const val CONE_CELLS = 1.6f
        const val GAUGE_HEIGHT = 120f
        const val PROXIMITY_TILES = 3f
        const val WARMUP_CARD_SECONDS = 4f
        const val TWO_PI = (2.0 * PI).toFloat()

        const val FLASH_NANOS = 150_000_000L
        const val CAUGHT_NANOS = 1_200_000_000L
        const val SHAKE_NANOS = 300_000_000L
        const val HEART_POP_NANOS = 500_000_000L
        const val FADE_SECONDS = 0.4f
        const val FADE_NANOS = 400_000_000L
        const val BACK_AT_NANOS = 1_800_000_000L
        const val BLINK_NANOS = 150_000_000L
        const val GHOUL_FULL_ASSET = "arcade/ghoul/ghoul_full.png"

        val WARMUP_CARDS = listOf(
            "REACH THE EXIT - FOLLOW THE COMPASS",
            "LEAN TO TURN - THE BIKE NEVER TURNS FOR YOU",
            "KEEP THE NEEDLE LEFT OF THE EAR - TO STAY QUIET",
            "HUNTED? - PEDAL PAST THE GHOUL MARK",
            "RIDE THROUGH SHRINES - TO STUN IT",
            "THE MAP SHOWS - WHAT'S BEHIND YOU",
        )
        val SPRINT_DELTAS = intArrayOf(10, 20, 30)

        // One color, one meaning.
        val RIDER = Color.rgb(70, 155, 255)
        val GHOUL = Color.rgb(235, 50, 50)
        val GHOUL_STUNNED = Color.rgb(140, 140, 146)
        val EXIT_OPEN = Color.rgb(70, 220, 105)
        val EXIT_LOCKED = Color.rgb(115, 45, 48)
        val SHRINE_READY = Color.rgb(70, 225, 230)
        val SHRINE_DIM = Color.rgb(35, 67, 72)
        val COMPASS = Color.WHITE
        val HIGHLIGHT = Color.rgb(255, 225, 70)
        val KEY = Color.rgb(250, 210, 65)

        val BACKGROUND = Color.rgb(7, 8, 12)
        val DIVIDER = Color.rgb(40, 42, 50)
        val PANEL = Color.argb(170, 0, 0, 0)
        val PANEL_STRONG = Color.argb(205, 0, 0, 0)
        val LABEL = Color.rgb(170, 172, 180)
        val QUIET_TEXT = Color.rgb(150, 190, 225)
        val SEARCHING = Color.rgb(225, 150, 55)
        val HEART = Color.rgb(255, 70, 80)
        val HEART_EMPTY = Color.rgb(70, 40, 44)
        val CONE = Color.argb(70, 70, 155, 255)
        val NOISE_TINT = Color.argb(46, 255, 120, 30)
        val GAUGE_QUIET = Color.rgb(48, 78, 110)
        val GAUGE_HEARD = Color.rgb(200, 105, 35)
        val FLOOR_LIT = Color.rgb(78, 82, 88)
        val WALL_TOP = Color.rgb(118, 122, 130)
        val WALL_LEFT = Color.rgb(72, 75, 82)
        val WALL_RIGHT = Color.rgb(54, 57, 64)
    }
}
