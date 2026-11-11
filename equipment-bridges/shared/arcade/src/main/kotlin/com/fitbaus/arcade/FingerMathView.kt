// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.view.MotionEvent
import android.view.View
import java.util.Locale
import kotlin.math.PI
import kotlin.math.sin

internal object FingerMathText {
    const val RATE_CAPTION: String = "CORRECT / MIN"

    /** Below this much gameplay time a per-minute rate is noise, so the HUD shows a placeholder. */
    const val MIN_RATE_NANOS: Long = 1_000_000_000L

    /**
     * Whether the player can answer right now, which is when the gameplay clock runs: the camera is
     * ready, or it has failed and touch is the input. Camera start-up never counts as play.
     */
    fun inputReady(camera: CameraState): Boolean =
        camera == CameraState.Ready || camera == CameraState.Unavailable || camera == CameraState.PermissionDenied

    fun rate(game: FingerMathGame): String =
        if (game.elapsedNanos < MIN_RATE_NANOS) "--.-" else String.format(Locale.US, "%.1f", game.correctPerMinute)

    fun elapsed(nanos: Long): String {
        val total = (nanos / 1_000_000_000L).coerceAtLeast(0L)
        val h = total / 3600
        val m = total / 60 % 60
        val s = total % 60
        return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s) else String.format(Locale.US, "%d:%02d", m, s)
    }

    fun detail(game: FingerMathGame): String {
        val source = when (game.lastAnswer?.source) {
            AnswerSource.Touch -> "   last: touch"
            AnswerSource.Camera -> "   last: camera"
            null -> ""
        }
        return "CORRECT ${game.correct}   TIME ${elapsed(game.elapsedNanos)}$source"
    }

    fun status(game: FingerMathGame, reading: FingerCountReading, camera: CameraState): String {
        if (game.phase == MathPhase.Correct) return "CORRECT!"
        if (game.feedback == MathFeedback.Wrong) return "NOT ${game.lastAnswer?.value ?: "?"} - TRY AGAIN"
        when (camera) {
            CameraState.PermissionDenied -> return "CAMERA PERMISSION DENIED - TAP AN ANSWER BELOW"
            CameraState.Unavailable -> return "CAMERA UNAVAILABLE - TAP AN ANSWER BELOW"
            CameraState.Off, CameraState.Requesting, CameraState.Starting -> return "STARTING CAMERA..."
            CameraState.Ready -> Unit
        }
        if (!game.armed) return "CHANGE YOUR HANDS FOR THE NEXT ANSWER"
        return when (reading.state) {
            FingerInputState.NoSignal -> "LOOKING FOR HANDS..."
            FingerInputState.NoHands -> "SHOW BOTH HANDS"
            FingerInputState.OneHand -> {
                val seen = reading.hands.firstOrNull()?.count?.let { "ONE HAND SEEN: $it" } ?: "ONE HAND SEEN"
                if (farCandidate(reading)) "$seen - BRING THE OTHER HAND CLOSER" else "$seen - SHOW BOTH HANDS"
            }
            FingerInputState.Uncertain -> "STRAIGHTEN OR CURL EACH FINGER CLEARLY"
            FingerInputState.Rejected -> when (reading.rejection) {
                FingerRejection.Duplicate -> "KEEP YOUR HANDS APART"
                FingerRejection.Incomplete -> "KEEP BOTH HANDS FULLY IN VIEW"
                FingerRejection.LowPresence -> if (farCandidate(reading)) "BRING YOUR HANDS CLOSER TO THE CAMERA" else "HANDS NOT CLEAR - TRY BETTER LIGHT"
                FingerRejection.TooSmall -> "MOVE CLOSER TO THE CAMERA"
                FingerRejection.BackendError -> "HAND TRACKING ERROR"
                else -> "SHOW BOTH HANDS"
            }
            FingerInputState.Stale -> "CAMERA IS SLOW - HOLD STILL"
            FingerInputState.Unstable -> "HOLD IT..."
            FingerInputState.Stable -> "GOT IT"
        }
    }

    fun farCandidate(reading: FingerCountReading): Boolean =
        reading.observation?.candidates?.any {
            it.verdict == CandidateVerdict.LowPresence && !it.fromRegion && it.palmPixels < FAR_PALM_PIXELS
        } == true

    const val FAR_PALM_PIXELS: Float = 70f

    fun handValue(hand: ObservedHand?): String = when {
        hand == null -> "-"
        hand.count == null -> "?"
        else -> hand.count.toString()
    }

    fun ordered(hands: List<ObservedHand>, mirrored: Boolean): List<ObservedHand> = if (mirrored) hands else hands.asReversed()

    fun keyAt(x: Float, y: Float, left: Float, top: Float, keyWidth: Float, keyHeight: Float, gap: Float): Int {
        if (y < top || y > top + keyHeight || x < left) return -1
        val stride = keyWidth + gap
        val index = ((x - left) / stride).toInt()
        if (index !in 0..10) return -1
        return if (x - left - index * stride <= keyWidth) index else -1
    }
}

/**
 * Finger Math: endless "a + b", "a - b", "a × b" and "a ÷ b" questions answered 0-10 by holding up
 * fingers on both hands. Reads the typed [FingerCountInput]; the 0-10 keys are a touch fallback
 * recorded separately from camera answers. The headline score is correct answers per minute of
 * gameplay time (see [FingerMathGame]).
 */
public class FingerMathView(context: Context) : View(context) {
    public var fingers: FingerCountInput? = null
    public var preview: ArcadePreview? = null
    public var diagnosticsOverlay: Boolean = false

    private val game = FingerMathGame().also { g -> g.events = { android.util.Log.i(LandmarkFrameSink.LOG_TAG, it) } }
    private var reading = FingerCountReading.NONE
    private var camera = CameraState.Off
    private var motion = BikeMotion.Unknown
    private var mirrored = true
    private var frameWidth = 640f
    private var frameHeight = 480f
    private var nowNanos = 0L
    private var statusText = ""
    private var diagnosticsText = ""
    private var memoryText = ""
    private var memoryAtNanos = Long.MIN_VALUE
    private var summaryAtNanos = Long.MIN_VALUE
    private var wrappedSource = ""
    private var wrappedLines: List<String> = emptyList()
    private var handsSequence = Long.MIN_VALUE
    private var handsState: FingerInputState? = null
    private var handTexts = arrayOf("-", "-", "-")
    private var rateText = "--.-"
    private var detailText = ""
    private var hudCorrect = -1
    private var hudSecond = -1L
    private var hudSource: AnswerSource? = null
    private val density = resources.displayMetrics.density
    private val previewSnapshot = PreviewSnapshot()
    private var previewBitmap: Bitmap? = null
    private var previewVisible = false
    private val previewRect = RectF()
    private val keyRect = RectF()
    private var keysLeft = 0f
    private var keysTop = 0f
    private var keyWidth = 0f
    private var keyHeight = 0f
    private var keyGap = 0f
    private val restartRect = RectF()
    private val keyLabels = Array(11) { it.toString() }

    private val borderPaint = stroke(ArcadePalette.BORDER, 2f)
    private val questionPaint = text(ArcadePalette.PRIMARY, 92f, Typeface.DEFAULT_BOLD).apply { textAlign = Paint.Align.CENTER }
    private val handsPaint = text(ArcadePalette.PRIMARY, 30f, Typeface.MONOSPACE).apply { textAlign = Paint.Align.CENTER }
    private val statusPaint = text(ArcadePalette.PRIMARY, 22f, Typeface.DEFAULT_BOLD).apply { textAlign = Paint.Align.CENTER }
    private val hudPaint = text(ArcadePalette.PRIMARY, 18f, Typeface.MONOSPACE)
    private val ratePaint = text(ArcadePalette.CAMERA_HAND, 32f, Typeface.DEFAULT_BOLD)
    private val rateCaptionPaint = text(ArcadePalette.PRIMARY, 14f, Typeface.DEFAULT_BOLD)
    private val keyPaint = text(ArcadePalette.PRIMARY, 22f, Typeface.MONOSPACE).apply { textAlign = Paint.Align.CENTER }
    private val captionPaint = text(ArcadePalette.MUTE, 12f, Typeface.DEFAULT_BOLD)
    private val diagnosticsPaint = text(ArcadePalette.PRIMARY, 11f, Typeface.MONOSPACE)
    private val keyFramePaint = stroke(ArcadePalette.TOUCH_HAND, 1.5f)
    private val barFramePaint = stroke(ArcadePalette.MUTE, 1.5f)
    private val barFillPaint = fill(ArcadePalette.CAMERA_HAND)
    private val ringPaint = stroke(ArcadePalette.CAMERA_HAND, 6f).apply { isAntiAlias = true }
    private val overlayPaint = fill(ArcadePalette.OVERLAY)
    private val previewPaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val previewFramePaint = stroke(ArcadePalette.MUTE, 1f)
    private val palmBonePaint = stroke(Color.WHITE, 2f).apply { isAntiAlias = true }
    private val fingerBonePaints = arrayOf(
        stroke(ArcadePalette.CAMERA_HAND, 3f).apply { isAntiAlias = true },
        stroke(Color.rgb(120, 120, 120), 2f).apply { isAntiAlias = true },
        stroke(ArcadePalette.TOUCH_HAND, 3f).apply { isAntiAlias = true },
    )
    private val tipPaints = arrayOf(
        fill(ArcadePalette.CAMERA_HAND).apply { isAntiAlias = true },
        fill(Color.rgb(120, 120, 120)).apply { isAntiAlias = true },
        fill(ArcadePalette.TOUCH_HAND).apply { isAntiAlias = true },
    )
    private val candidatePaint = stroke(ArcadePalette.FAILURE, 2f)
    private val labelPaint = text(ArcadePalette.PRIMARY, 26f, Typeface.DEFAULT_BOLD).apply { textAlign = Paint.Align.CENTER }
    private val labelBackPaint = fill(Color.argb(200, 0, 0, 0))
    private val panelCaptionPaint = text(ArcadePalette.MUTE, 12f, Typeface.DEFAULT_BOLD)
    private val palmChain = intArrayOf(0, 1, 0, 5, 5, 9, 9, 13, 13, 17, 0, 17)
    private val fingerChains = arrayOf(intArrayOf(1, 2, 3, 4), intArrayOf(5, 6, 7, 8), intArrayOf(9, 10, 11, 12), intArrayOf(13, 14, 15, 16), intArrayOf(17, 18, 19, 20))

    init {
        setBackgroundColor(ArcadePalette.PLAYFIELD)
        isClickable = true
    }

    public fun render(camera: CameraState, failure: String?, motion: BikeMotion, diagnostics: String, cameraInfo: ArcadeCameraInfo?) {
        val now = System.nanoTime()
        nowNanos = now
        this.camera = camera
        this.motion = motion
        mirrored = cameraInfo?.frontFacing ?: true
        if (cameraInfo != null && cameraInfo.width > 0 && cameraInfo.height > 0) {
            frameWidth = cameraInfo.width.toFloat()
            frameHeight = cameraInfo.height.toFloat()
        }
        reading = fingers?.read(now) ?: FingerCountReading.NONE
        game.update(now, reading, FingerMathText.inputReady(camera))
        statusText = FingerMathText.status(game, reading, camera)
        refreshHudText()
        logSummary(now, cameraInfo)
        if (reading.sequence != handsSequence || reading.state != handsState) {
            handsSequence = reading.sequence
            handsState = reading.state
            val ordered = FingerMathText.ordered(reading.hands, mirrored)
            handTexts = arrayOf(
                FingerMathText.handValue(ordered.getOrNull(0)),
                FingerMathText.handValue(ordered.getOrNull(1)),
                reading.total?.toString() ?: "-",
            )
        }
        diagnosticsText = if (failure != null && (camera == CameraState.Unavailable || camera == CameraState.PermissionDenied)) failure else diagnostics
        refreshPreview()
        invalidate()
    }

    public fun restartGame() {
        game.restart()
        refreshHudText()
        invalidate()
    }

    /** Rebuilds the HUD strings only when a shown value changes (once a second while playing). */
    private fun refreshHudText() {
        val second = game.elapsedNanos / 1_000_000_000L
        val source = game.lastAnswer?.source
        if (game.correct == hudCorrect && second == hudSecond && source == hudSource) return
        hudCorrect = game.correct
        hudSecond = second
        hudSource = source
        rateText = FingerMathText.rate(game)
        detailText = FingerMathText.detail(game)
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (visibility != VISIBLE) game.suspendClock()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        if (visibility != VISIBLE) game.suspendClock()
    }

    override fun onDetachedFromWindow() {
        game.suspendClock()
        super.onDetachedFromWindow()
    }

    private fun refreshPreview() {
        val source = preview
        if (source == null || camera != CameraState.Ready) {
            previewVisible = false
            return
        }
        if (!source.copyTo(previewSnapshot)) return
        val w = previewSnapshot.width
        val h = previewSnapshot.height
        if (w <= 0 || h <= 0) {
            previewVisible = false
            return
        }
        var bitmap = previewBitmap
        if (bitmap == null || bitmap.width != w || bitmap.height != h) {
            bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            previewBitmap = bitmap
        }
        bitmap.setPixels(previewSnapshot.pixels, 0, w, 0, 0, w, h)
        previewVisible = true
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return
        val inset = borderPaint.strokeWidth / 2f
        canvas.drawRect(inset, inset, w - inset, h - inset, borderPaint)
        drawHud(canvas, w)
        keyGap = 6f * density
        keyHeight = 52f * density
        keysLeft = 12f * density
        keyWidth = (w - 2f * keysLeft - 10f * keyGap) / 11f
        keysTop = h - keyHeight - 12f * density
        val previewWidth = PREVIEW_WIDTH_DP * density
        val leftWidth = w - previewWidth - 36f * density
        val centerX = leftWidth / 2f + 12f * density
        val bodyTop = 48f * density
        val bodyHeight = keysTop - bodyTop - 24f * density
        drawQuestion(canvas, centerX, bodyTop + bodyHeight * 0.36f)
        canvas.drawText(
            "Hand 1: ${handTexts[0]}   Hand 2: ${handTexts[1]}   Total: ${handTexts[2]}",
            centerX,
            bodyTop + bodyHeight * 0.58f,
            handsPaint,
        )
        drawProgress(canvas, centerX, bodyTop + bodyHeight * 0.66f, leftWidth * 0.7f)
        statusPaint.color = statusColor()
        canvas.drawText(statusText, centerX, bodyTop + bodyHeight * 0.86f, statusPaint)
        drawKeys(canvas)
        drawPreview(canvas, w, bodyTop + 18f * density)
        if (diagnosticsOverlay) drawOverlay(canvas, w, bodyTop)
    }

    private fun drawHud(canvas: Canvas, w: Float) {
        val baseline = 34f * density
        var x = 14f * density
        canvas.drawText(rateText, x, baseline, ratePaint)
        x += ratePaint.measureText(rateText) + 8f * density
        canvas.drawText(FingerMathText.RATE_CAPTION, x, baseline, rateCaptionPaint)
        x += rateCaptionPaint.measureText(FingerMathText.RATE_CAPTION) + 28f * density
        canvas.drawText(detailText, x, baseline, hudPaint)
        val rw = 110f * density
        val rh = 30f * density
        restartRect.set(w - rw - 12f * density, 8f * density, w - 12f * density, 8f * density + rh)
        canvas.drawRect(restartRect, keyFramePaint)
        keyPaint.textSize = 15f * density
        canvas.drawText("RESTART", restartRect.centerX(), restartRect.centerY() + keyPaint.textSize / 2.8f, keyPaint)
        keyPaint.textSize = 22f * density
    }

    private fun drawQuestion(canvas: Canvas, cx: Float, baseline: Float) {
        val text = game.question.text
        if (game.phase == MathPhase.Correct) {
            val t = ((nowNanos - game.feedbackAtNanos).toFloat() / game.correctHoldNanos).coerceIn(0f, 1f)
            val scale = 1f + 0.15f * sin(PI.toFloat() * (t * 2f).coerceAtMost(1f))
            questionPaint.color = ArcadePalette.CAMERA_HAND
            canvas.save()
            canvas.scale(scale, scale, cx, baseline - questionPaint.textSize / 3f)
            canvas.drawText(text.replace("?", game.question.answer.toString()), cx, baseline, questionPaint)
            canvas.restore()
            ringPaint.alpha = (255 * (1f - t)).toInt().coerceIn(0, 255)
            canvas.drawCircle(cx, baseline - questionPaint.textSize / 3f, (120f + 260f * t) * density, ringPaint)
            questionPaint.color = ArcadePalette.PRIMARY
            return
        }
        questionPaint.color = if (game.feedback == MathFeedback.Wrong) ArcadePalette.FAILURE else ArcadePalette.PRIMARY
        canvas.drawText(text, cx, baseline, questionPaint)
        questionPaint.color = ArcadePalette.PRIMARY
    }

    private fun drawProgress(canvas: Canvas, cx: Float, top: Float, width: Float) {
        val barHeight = 16f * density
        val left = cx - width / 2f
        val progress = if (game.phase == MathPhase.Asking && game.armed) reading.progress else if (game.phase == MathPhase.Correct) 1f else 0f
        barFillPaint.color = if (progress >= 1f) ArcadePalette.CAMERA_HAND else Color.rgb(0, 150, 90)
        if (progress > 0f) canvas.drawRect(left, top, left + width * progress, top + barHeight, barFillPaint)
        canvas.drawRect(left, top, left + width, top + barHeight, barFramePaint)
    }

    private fun statusColor(): Int = when {
        game.phase == MathPhase.Correct || reading.state == FingerInputState.Stable -> ArcadePalette.CAMERA_HAND
        game.feedback == MathFeedback.Wrong -> ArcadePalette.FAILURE
        camera == CameraState.Unavailable || camera == CameraState.PermissionDenied -> ArcadePalette.FAILURE
        else -> ArcadePalette.PRIMARY
    }

    private fun drawKeys(canvas: Canvas) {
        canvas.drawText("TOUCH ANSWER", keysLeft, keysTop - 6f * density, captionPaint)
        for (i in 0..10) {
            val left = keysLeft + i * (keyWidth + keyGap)
            keyRect.set(left, keysTop, left + keyWidth, keysTop + keyHeight)
            canvas.drawRect(keyRect, keyFramePaint)
            canvas.drawText(keyLabels[i], keyRect.centerX(), keyRect.centerY() + keyPaint.textSize / 2.8f, keyPaint)
        }
    }

    private fun drawPreview(canvas: Canvas, viewWidth: Float, top: Float) {
        val bitmap = previewBitmap
        val pw = PREVIEW_WIDTH_DP * density
        val ph = pw * 3f / 4f
        val right = viewWidth - 12f * density
        previewRect.set(right - pw, top, right, top + ph)
        canvas.drawText("CAMERA - HOLD BOTH HANDS INSIDE THIS VIEW", previewRect.left, top - 6f * density, panelCaptionPaint)
        if (!previewVisible || bitmap == null) {
            canvas.drawRect(previewRect, previewFramePaint)
            return
        }
        canvas.drawBitmap(bitmap, null, previewRect, previewPaint)
        canvas.drawRect(previewRect, previewFramePaint)
        if (reading.state == FingerInputState.Stale) return
        drawCandidates(canvas)
        drawSkeletons(canvas)
    }

    private fun drawCandidates(canvas: Canvas) {
        val obs = reading.observation ?: return
        for (c in obs.candidates) {
            if (c.verdict == CandidateVerdict.Hand || c.verdict == CandidateVerdict.NotRun || c.verdict == CandidateVerdict.SameHand) continue
            if (c.roiCx.isNaN() || c.fromRegion) continue
            val half = c.roiSize / 2f
            val x1 = px(c.roiCx - half)
            val x2 = px(c.roiCx + half)
            canvas.drawRect(minOf(x1, x2), py(c.roiCy - half), maxOf(x1, x2), py(c.roiCy + half), candidatePaint)
        }
    }

    private fun drawSkeletons(canvas: Canvas) {
        val hands = FingerMathText.ordered(reading.hands, mirrored)
        for (hand in hands) {
            val p = hand.landmarks
            var k = 0
            while (k < palmChain.size) {
                val a = palmChain[k]
                val b = palmChain[k + 1]
                canvas.drawLine(px(p[a * 2]), py(p[a * 2 + 1]), px(p[b * 2]), py(p[b * 2 + 1]), palmBonePaint)
                k += 2
            }
            var topY = Float.MAX_VALUE
            var topX = 0f
            for ((f, chain) in fingerChains.withIndex()) {
                val style = when (hand.classification.states[f]) {
                    FingerState.Extended -> 0
                    FingerState.Folded -> 1
                    FingerState.Uncertain -> 2
                }
                for (j in 0 until chain.size - 1) {
                    canvas.drawLine(px(p[chain[j] * 2]), py(p[chain[j] * 2 + 1]), px(p[chain[j + 1] * 2]), py(p[chain[j + 1] * 2 + 1]), fingerBonePaints[style])
                }
                val tip = chain[chain.size - 1]
                canvas.drawCircle(px(p[tip * 2]), py(p[tip * 2 + 1]), (if (style == 0) 5f else 3.5f) * density, tipPaints[style])
                if (py(p[tip * 2 + 1]) < topY) {
                    topY = py(p[tip * 2 + 1])
                    topX = px(p[tip * 2])
                }
            }
            val label = FingerMathText.handValue(hand)
            val ly = (topY - 10f * density).coerceAtLeast(previewRect.top + labelPaint.textSize)
            val halfWidth = labelPaint.measureText(label) / 2f + 6f * density
            canvas.drawRect(topX - halfWidth, ly - labelPaint.textSize, topX + halfWidth, ly + 6f * density, labelBackPaint)
            labelPaint.color = if (hand.count == null) ArcadePalette.TOUCH_HAND else ArcadePalette.CAMERA_HAND
            canvas.drawText(label, topX, ly, labelPaint)
        }
    }

    private fun px(x: Float): Float {
        val n = (x / frameWidth).coerceIn(0f, 1f)
        return previewRect.left + (if (mirrored) 1f - n else n) * previewRect.width()
    }

    private fun py(y: Float): Float = previewRect.top + (y / frameHeight).coerceIn(0f, 1f) * previewRect.height()

    private fun drawOverlay(canvas: Canvas, w: Float, top: Float) {
        if (wrappedSource != diagnosticsText) {
            wrappedSource = diagnosticsText
            wrappedLines = PlaygroundGeometry.wrap(diagnosticsText, OVERLAY_CHARS)
        }
        if (memoryAtNanos == Long.MIN_VALUE || nowNanos - memoryAtNanos > 1_000_000_000L) {
            memoryAtNanos = nowNanos
            val runtime = Runtime.getRuntime()
            memoryText = String.format(
                Locale.US,
                "mem java %.1f MB  native %.1f MB",
                (runtime.totalMemory() - runtime.freeMemory()) / 1048576f,
                android.os.Debug.getNativeHeapAllocatedSize() / 1048576f,
            )
        }
        val stats = fingers?.stats()
        val ordered = FingerMathText.ordered(reading.hands, mirrored)
        val handsLine = ordered.withIndex().joinToString("   ") { (i, hand) ->
            String.format(
                Locale.US,
                "hand %d id %d %s=%s q %.2f p %.2f",
                i + 1,
                hand.id,
                hand.classification.describe(),
                FingerMathText.handValue(hand),
                hand.classification.quality,
                hand.presence,
            )
        }.ifEmpty { "no hands" }
        val lines = ArrayList<String>(wrappedLines.size + 4)
        lines += wrappedLines
        lines += String.format(
            Locale.US,
            "input %s  held %d ms  age %d ms  rejection %s  recognized %s of %d  stable runs %d  %s",
            reading.state,
            reading.heldMs,
            reading.ageMs,
            reading.rejection ?: "-",
            stats?.recognitionRate?.let { if (it.isNaN()) "-" else String.format(Locale.US, "%.0f%%", it * 100f) } ?: "-",
            stats?.observations ?: 0L,
            stats?.stableRuns ?: 0L,
            memoryText,
        )
        lines += handsLine
        val obs = reading.observation
        lines += if (obs == null) {
            "stage: no observation yet"
        } else {
            "stage: palms raw ${obs.rawPalms}${if (obs.bestBelowThreshold.isNaN()) "" else " (best below cutoff " + String.format(Locale.US, "%.2f", obs.bestBelowThreshold) + ")"} kept ${obs.candidates.size}" +
                obs.candidates.withIndex().joinToString("") { (i, c) -> "  | c${i + 1} ${FingerDiagnostics.candidate(c)}" }
        }
        for ((i, hand) in ordered.withIndex()) lines += "hand ${i + 1} measures ${FingerDiagnostics.measures(hand.classification)}"
        lines += String.format(
            Locale.US,
            "palm found in %s of updates  candidates %s",
            stats?.let { s -> if (s.observations == 0L) "-" else String.format(Locale.US, "%.0f%%", 100f * s.palmUpdates / s.observations) } ?: "-",
            stats?.let { s -> CandidateVerdict.values().joinToString(" ") { "${it.name} ${s.verdicts[it.ordinal]}" } } ?: "-",
        )
        lines += String.format(
            Locale.US,
            "rejections %s",
            stats?.let { s -> FingerRejection.values().joinToString(" ") { "${it.name} ${s.rejections[it.ordinal]}" } } ?: "-",
        )
        lines += String.format(
            Locale.US,
            "question %s  proposed %s  armed %s  bike %s (not gating)  correct %d in %s = %s/min  answers camera %d touch %d wrong %d  last %s",
            game.question.text,
            reading.total?.toString() ?: "-",
            game.armed,
            motion,
            game.correct,
            FingerMathText.elapsed(game.elapsedNanos),
            rateText,
            game.cameraAnswers,
            game.touchAnswers,
            game.wrongAnswers,
            game.lastAnswer?.let { "${it.value} ${it.source} ${if (it.correct) "ok" else "wrong"}" } ?: "-",
        )
        val lineHeight = diagnosticsPaint.textSize + 3f * density
        val boxRight = w - PREVIEW_WIDTH_DP * density - 24f * density
        canvas.drawRect(8f * density, top, boxRight, top + lines.size * lineHeight + 8f * density, overlayPaint)
        var y = top + lineHeight
        for (line in lines) {
            canvas.drawText(line, 14f * density, y, diagnosticsPaint)
            y += lineHeight
        }
    }

    private fun logSummary(now: Long, cameraInfo: ArcadeCameraInfo?) {
        if (summaryAtNanos != Long.MIN_VALUE && now - summaryAtNanos < SUMMARY_NANOS) return
        summaryAtNanos = now
        val stats = fingers?.stats() ?: return
        val d = cameraInfo?.diagnostics
        val runtime = Runtime.getRuntime()
        android.util.Log.i(
            LandmarkFrameSink.LOG_TAG,
            String.format(
                Locale.US,
                "finger summary: %.1f Hz p50 %.0f p90 %.0f ms infer %.0f cpu %.0f%% mem java %.1f native %.1f MB  obs %d palm-updates %d region-hands %d accepted %d stable %d  rejections %s  candidates %s  camera %d touch %d wrong %d  correct %d in %d s",
                d?.processedHz ?: Float.NaN,
                d?.processingP50Ms ?: Float.NaN,
                d?.processingP90Ms ?: Float.NaN,
                d?.inferenceP50Ms ?: Float.NaN,
                d?.processCpuPercent ?: Float.NaN,
                (runtime.totalMemory() - runtime.freeMemory()) / 1048576f,
                android.os.Debug.getNativeHeapAllocatedSize() / 1048576f,
                stats.observations,
                stats.palmUpdates,
                stats.regionHands,
                stats.accepted,
                stats.stableRuns,
                FingerRejection.values().joinToString(",") { "${it.name}=${stats.rejections[it.ordinal]}" },
                CandidateVerdict.values().joinToString(",") { "${it.name}=${stats.verdicts[it.ordinal]}" },
                game.cameraAnswers,
                game.touchAnswers,
                game.wrongAnswers,
                game.correct,
                game.elapsedNanos / 1_000_000_000L,
            ),
        )
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked != MotionEvent.ACTION_UP) return true
        if (restartRect.contains(event.x, event.y)) {
            restartGame()
        } else {
            val key = FingerMathText.keyAt(event.x, event.y, keysLeft, keysTop, keyWidth, keyHeight, keyGap)
            if (key >= 0) game.submitTouch(key, System.nanoTime(), reading)
        }
        performClick()
        invalidate()
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private fun stroke(color: Int, widthDp: Float): Paint = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = widthDp * density
        this.color = color
    }

    private fun fill(color: Int): Paint = Paint().apply {
        style = Paint.Style.FILL
        this.color = color
    }

    private fun text(color: Int, sizeSp: Float, face: Typeface): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color
        textSize = sizeSp * density
        typeface = face
        isFakeBoldText = face == Typeface.MONOSPACE
    }

    private companion object {
        const val PREVIEW_WIDTH_DP = 400f
        const val OVERLAY_CHARS = 100
        const val SUMMARY_NANOS = 10_000_000_000L
    }
}
