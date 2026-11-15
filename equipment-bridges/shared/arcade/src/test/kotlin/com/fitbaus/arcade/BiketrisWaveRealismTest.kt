// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

internal typealias WaveDetect = (ByteArray, Int, Int, Boolean, Long, FaceSample?) -> Boolean

/**
 * A seated cyclist in raw camera space at 320x240: textured wall, head with hair and features,
 * neck, rounded shoulders and a shirt whose folds move with the pedaling bob, knees moving at the
 * bottom of the frame, a forearm drawn from a shoulder/elbow anchor to an irregular hand (palm,
 * four fingers, thumb), plus optional noise, exposure change, local clothing flicker and shake.
 */
internal class RiderScene(val width: Int = 320, val height: Int = 240, seed: Long = 5L) {
    val frame = ByteArray(width * height * 3 / 2)
    private val wall = IntArray(width * height)
    private val random = Random(seed)
    var faceX = 0.5f
    var faceY = 0.36f
    var faceSize = 0.18f
    var torsoX = 0.5f
    var bob = 0f
    var sway = 0f
    var kneePhase = 0f
    var handX = Float.NaN
    var handY = 0.4f
    var anchorX = 0.75f
    var anchorY = 0.7f
    var noise = 0
    var offset = 0
    var gain = 1f
    var shakeX = 0
    var shakeY = 0
    var flickerPatches = 0
    var flickerAmp = 18
    var flickerX0 = 0f
    var flickerX1 = 1f
    var flickerY0 = 0.6f
    var flickerY1 = 0.95f
    private val flickerX = IntArray(8)
    private val flickerY = IntArray(8)
    private val flickerD = IntArray(8)

    init {
        for (y in 0 until height) {
            for (x in 0 until width) {
                val board = ((x / 23 + y / 17) % 3) * 9
                val grain = ((x * 7919 + y * 104729) % 23)
                wall[y * width + x] = 52 + board + grain + (y * 20 / height)
            }
        }
        frame.fill(128.toByte(), width * height, frame.size)
    }

    fun faceSample(atNanos: Long): FaceSample = FaceSample(faceX + sway, faceY + bob, faceSize, atNanos)

    fun stepFlicker() {
        for (i in 0 until flickerPatches) {
            flickerX[i] = (flickerX0 * width).toInt() + random.nextInt(maxOf(1, ((flickerX1 - flickerX0) * width).toInt()))
            flickerY[i] = (flickerY0 * height).toInt() + random.nextInt(maxOf(1, ((flickerY1 - flickerY0) * height).toInt()))
            flickerD[i] = if (random.nextBoolean()) random.nextInt(flickerAmp / 2, flickerAmp + 1) else -random.nextInt(flickerAmp / 2, flickerAmp + 1)
        }
    }

    fun render(): ByteArray {
        val fw = faceSize * width
        val fcx = (faceX + sway) * width
        val fcy = (faceY + bob) * height
        val tcx = (torsoX + sway) * width
        val shoulderY = fcy + 0.95f * fw
        val bobPx = bob * height
        val hx = if (handX.isNaN()) Float.NaN else handX * width
        val hy = handY * height
        val ax = anchorX * width
        val ay = anchorY * height
        val armR = 0.13f * fw
        val kneeY0 = height * (0.93f + 0.04f * sin(kneePhase))
        val kneeY1 = height * (0.93f - 0.04f * sin(kneePhase))
        for (y in 0 until height) {
            val wy = (y + shakeY).coerceIn(0, height - 1)
            for (x in 0 until width) {
                val wx = (x + shakeX).coerceIn(0, width - 1)
                var v = wall[wy * width + wx]
                if (y >= shoulderY) {
                    val depth = (y - shoulderY) / (height - shoulderY + 1f)
                    var half = fw * (1.1f + 0.35f * depth)
                    val round = 0.35f * fw
                    if (y < shoulderY + round) {
                        val k = (shoulderY + round - y) / round
                        half *= sqrt(maxOf(0f, 1f - k * k)).coerceAtLeast(0.55f)
                    }
                    if (abs(x - tcx) <= half) v = 92 + (10 * sin((x - tcx) / 6f + (y - bobPx * 1.5f) / 9f)).toInt() + (y % 4)
                }
                if (y >= fcy + 0.45f * fw && y < shoulderY + 4 && abs(x - (fcx + tcx) / 2f) < 0.22f * fw) v = 150
                val dx = (x - fcx) / (0.5f * fw)
                val dy = (y - fcy) / (0.62f * fw)
                if (dx * dx + dy * dy <= 1f) {
                    v = if (dy < -0.45f) 58 + (x % 3) * 3 else 168 + ((x + y) % 5) * 2
                    if (abs(dy + 0.15f) < 0.09f && abs(abs(dx) - 0.38f) < 0.11f) v = 60
                    if (abs(dy - 0.45f) < 0.06f && abs(dx) < 0.3f) v = 95
                }
                if (abs(x - (tcx - 0.55f * fw)) < 0.25f * fw && abs(y - kneeY0) < 0.09f * height) v = 70
                if (abs(x - (tcx + 0.55f * fw)) < 0.25f * fw && abs(y - kneeY1) < 0.09f * height) v = 70
                if (!hx.isNaN()) {
                    val sx = hx - ax
                    val sy = hy - ay
                    val len2 = sx * sx + sy * sy
                    val tt = if (len2 <= 0f) 0f else (((x - ax) * sx + (y - ay) * sy) / len2).coerceIn(0f, 1f)
                    val px = ax + tt * sx - x
                    val py = ay + tt * sy - y
                    if (px * px + py * py <= armR * armR) v = 140 + ((x + 2 * y) % 6) * 2
                    val pdx = (x - hx) / (0.22f * fw)
                    val pdy = (y - hy) / (0.26f * fw)
                    var hand = pdx * pdx + pdy * pdy <= 1f
                    if (!hand && y < hy && y > hy - 0.55f * fw) {
                        for (f in 0 until 4) {
                            val fx = hx + (-0.15f + 0.1f * f) * fw
                            val top = hy - (0.45f + (if (f == 1 || f == 2) 0.1f else 0f)) * fw
                            if (abs(x - fx) < 0.035f * fw && y > top) hand = true
                        }
                        if (abs(x - (hx + 0.25f * fw)) < 0.04f * fw && y > hy - 0.25f * fw) hand = true
                    }
                    if (hand) v = 196 + ((x * 3 + y) % 7) * 3
                }
                var out = (v * gain).toInt() + offset
                if (noise > 0) out += random.nextInt(-noise, noise + 1)
                frame[y * width + x] = out.coerceIn(0, 255).toByte()
            }
        }
        for (i in 0 until flickerPatches) {
            for (y in flickerY[i] until minOf(height, flickerY[i] + 10)) {
                for (x in flickerX[i] until minOf(width, flickerX[i] + 10)) {
                    val p = y * width + x
                    frame[p] = ((frame[p].toInt() and 0xFF) + flickerD[i]).coerceIn(0, 255).toByte()
                }
            }
        }
        return frame
    }
}

/** Drives a detector at 30 fps with 10 Hz face samples and continuous pedaling unless told otherwise. */
internal class GestureRig(val detect: WaveDetect, val mirror: Boolean = false) {
    val scene = RiderScene()
    var nanos = 2_000_000_000L
    var seconds = 0.0
    var events = 0
    val eventTimes = ArrayList<Long>()
    var pedaling = true
    var cadenceHz = 1.33
    var bobAmp = 0.012f
    var swayAmp = 0.006f
    var faceVisible = true
    var cameraOn = true
    private var face: FaceSample? = null
    private var nextFaceAt = Long.MIN_VALUE

    fun frame(advanceMs: Long = 33L) {
        nanos += advanceMs * 1_000_000L
        seconds += advanceMs / 1000.0
        if (pedaling) {
            scene.bob = (bobAmp * sin(2 * PI * cadenceHz * seconds)).toFloat()
            scene.sway = (swayAmp * sin(PI * cadenceHz * seconds)).toFloat()
            scene.kneePhase = (2 * PI * cadenceHz * seconds).toFloat()
        }
        scene.stepFlicker()
        if (faceVisible && (nextFaceAt == Long.MIN_VALUE || nanos >= nextFaceAt)) {
            face = scene.faceSample(nanos)
            nextFaceAt = nanos + 100_000_000L
        }
        if (!faceVisible) face = null
        if (!cameraOn) return
        if (detect(scene.render(), scene.width, scene.height, mirror, nanos, face)) {
            events += 1
            eventTimes += nanos
        }
    }

    fun idle(ms: Long) {
        var left = ms
        while (left > 0) {
            frame()
            left -= 33
        }
    }

    fun raise(x: Float, y: Float, ms: Long = 300L) {
        scene.handX = x
        val frames = (ms / 33).toInt().coerceAtLeast(1)
        for (i in 1..frames) {
            scene.handY = 1.05f + (y - 1.05f) * i / frames
            frame()
        }
    }

    fun lower(ms: Long = 300L) {
        if (scene.handX.isNaN()) return
        val y0 = scene.handY
        val frames = (ms / 33).toInt().coerceAtLeast(1)
        for (i in 1..frames) {
            scene.handY = y0 + (1.1f - y0) * i / frames
            frame()
        }
        scene.handX = Float.NaN
    }

    fun sweep(fromX: Float, toX: Float, ms: Long, y0: Float = scene.handY, y1: Float = y0) {
        val frames = (ms / 33).toInt().coerceAtLeast(2)
        for (i in 1..frames) {
            val p = (1 - cos(PI * i / frames)).toFloat() / 2f
            scene.handX = fromX + (toX - fromX) * p
            scene.handY = y0 + (y1 - y0) * p
            frame()
        }
    }

    fun wave(fromX: Float, toX: Float, y: Float, ms: Long = 350L, drift: Float = 0f, anchorX: Float = if (fromX + toX > 1f) 0.72f else 0.28f, anchorY: Float = 0.68f) {
        scene.anchorX = anchorX
        scene.anchorY = anchorY
        raise(fromX, y)
        idle(150)
        sweep(fromX, toX, ms, y, y + drift)
        idle(200)
        lower()
    }

    fun warmUp() {
        idle(1500)
    }
}

internal object WaveDetectors {
    fun current(config: WaveConfig = WaveConfig()): WaveDetect {
        val d = WaveSwipeDetector(config)
        return { f, w, h, m, t, face -> d.observe(f, w, h, m, t, face) }
    }
}

class BiketrisWaveRealismTest {
    private fun rig(mirror: Boolean = false): GestureRig = GestureRig(WaveDetectors.current(), mirror).also { it.warmUp() }

    @Test
    fun aWaveBesideTheFaceWithEitherHandRotatesOnce() {
        val right = rig()
        right.wave(0.70f, 0.95f, y = 0.34f, anchorX = 0.75f, anchorY = 0.62f)
        right.idle(600)
        assertEquals(1, right.events, "right hand beside the face")
        val left = rig()
        left.wave(0.30f, 0.05f, y = 0.34f, anchorX = 0.25f, anchorY = 0.62f)
        left.idle(600)
        assertEquals(1, left.events, "left hand beside the face")
    }

    @Test
    fun aWaveAtShoulderHeightRotatesOnce() {
        val r = rig()
        r.wave(0.88f, 0.52f, y = 0.6f, anchorX = 0.8f, anchorY = 0.78f)
        r.idle(600)
        assertEquals(1, r.events)
    }

    @Test
    fun aWaveAcrossTheUpperChestRotatesOnceEitherWay() {
        val a = rig()
        a.wave(0.74f, 0.28f, y = 0.72f, anchorX = 0.78f, anchorY = 0.86f)
        a.idle(600)
        assertEquals(1, a.events, "right hand across the chest")
        val b = rig()
        b.wave(0.26f, 0.72f, y = 0.72f, anchorX = 0.22f, anchorY = 0.86f)
        b.idle(600)
        assertEquals(1, b.events, "left hand across the chest")
    }

    @Test
    fun aWaveCrossingInFrontOfTheFaceStillCountsWhileTheFaceIsBrieflyLost() {
        val r = rig()
        r.scene.anchorX = 0.8f
        r.scene.anchorY = 0.7f
        r.raise(0.85f, 0.36f)
        r.idle(150)
        r.faceVisible = false
        r.sweep(0.85f, 0.15f, 450)
        r.faceVisible = true
        r.idle(200)
        r.lower()
        r.idle(600)
        assertEquals(1, r.events)
    }

    @Test
    fun modestVerticalDriftAndVariableSpeedsStillCount() {
        for ((ms, drift) in listOf(250L to 0.06f, 350L to -0.08f, 600L to 0.05f)) {
            val r = rig()
            r.wave(0.66f, 0.95f, y = 0.4f, ms = ms, drift = drift, anchorX = 0.78f, anchorY = 0.7f)
            r.idle(600)
            assertEquals(1, r.events, "duration $ms ms, drift $drift")
        }
    }

    @Test
    fun aHandEnteringTheFrameMidWaveCountsWhenEnoughOfItIsSeen() {
        val r = rig()
        r.scene.anchorX = 0.95f
        r.scene.anchorY = 0.75f
        r.scene.handY = 0.45f
        r.sweep(1.15f, 0.62f, 450)
        r.idle(200)
        r.lower()
        r.idle(600)
        assertEquals(1, r.events)
    }

    @Test
    fun theHeadMovingDuringAWaveDoesNotCancelIt() {
        val r = rig()
        r.scene.anchorX = 0.78f
        r.scene.anchorY = 0.86f
        r.raise(0.76f, 0.72f)
        r.idle(150)
        val frames = 12
        for (i in 1..frames) {
            val p = (1 - cos(PI * i / frames)).toFloat() / 2f
            r.scene.faceX = 0.5f - 0.08f * p
            r.scene.torsoX = 0.5f - 0.05f * p
            r.scene.handX = 0.76f - 0.46f * p
            r.frame()
        }
        r.idle(200)
        r.lower()
        r.idle(600)
        assertEquals(1, r.events, "head moving the same way as the arm")
        val s = rig()
        s.scene.anchorX = 0.78f
        s.scene.anchorY = 0.86f
        s.raise(0.3f, 0.72f)
        s.idle(150)
        for (i in 1..frames) {
            val p = (1 - cos(PI * i / frames)).toFloat() / 2f
            s.scene.faceX = 0.5f - 0.08f * p
            s.scene.torsoX = 0.5f - 0.05f * p
            s.scene.handX = 0.3f + 0.46f * p
            s.frame()
        }
        s.idle(200)
        s.lower()
        s.idle(600)
        assertEquals(1, s.events, "head moving against the arm")
    }

    @Test
    fun twoSeparateWavesWithANormalRecoveryBothCountWhilePedaling() {
        val r = rig()
        r.scene.flickerPatches = 3
        r.scene.noise = 4
        r.wave(0.68f, 0.95f, y = 0.38f, anchorX = 0.78f, anchorY = 0.66f)
        r.idle(700)
        r.wave(0.95f, 0.68f, y = 0.38f, anchorX = 0.78f, anchorY = 0.66f)
        r.idle(600)
        assertEquals(2, r.events)
    }

    @Test
    fun ongoingBackgroundActivityDoesNotStopRearming() {
        val r = rig()
        r.scene.flickerPatches = 3
        r.scene.flickerAmp = 35
        r.scene.flickerX0 = 0.0f
        r.scene.flickerX1 = 0.25f
        r.scene.flickerY0 = 0.1f
        r.scene.flickerY1 = 0.5f
        r.idle(1500)
        r.wave(0.68f, 0.95f, y = 0.38f, anchorX = 0.78f, anchorY = 0.66f)
        r.idle(800)
        r.wave(0.95f, 0.68f, y = 0.38f, anchorX = 0.78f, anchorY = 0.66f)
        r.idle(600)
        assertEquals(2, r.events, "flicker beside the rider never moves sideways coherently, so it cannot hold the detector unarmed")
    }

    @Test
    fun continuousArmMovementRotatesOnceUntilReleased() {
        val r = rig()
        r.scene.anchorX = 0.78f
        r.scene.anchorY = 0.7f
        r.raise(0.66f, 0.4f)
        repeat(6) {
            r.sweep(0.66f, 0.95f, 300)
            r.sweep(0.95f, 0.66f, 300)
        }
        assertEquals(1, r.events, "no repeats while the arm keeps moving")
        r.idle(600)
        r.sweep(0.66f, 0.95f, 350)
        r.idle(400)
        assertEquals(2, r.events, "a new wave after a pause counts")
    }

    @Test
    fun headOnlySteeringNeverRotates() {
        val r = rig()
        repeat(4) {
            for (target in listOf(0.38f, 0.62f, 0.5f)) {
                val from = r.scene.faceX
                val fromTorso = r.scene.torsoX
                for (i in 1..12) {
                    val p = (1 - cos(PI * i / 12)).toFloat() / 2f
                    r.scene.faceX = from + (target - from) * p
                    r.scene.torsoX = fromTorso + (0.5f + (target - 0.5f) * 0.7f - fromTorso) * p
                    r.frame()
                }
                r.idle(400)
            }
        }
        assertEquals(0, r.events)
    }

    @Test
    fun routineUpperBodySwayAndBounceNeverRotate() {
        val r = rig()
        r.swayAmp = 0.03f
        r.bobAmp = 0.02f
        r.cadenceHz = 1.5
        r.scene.flickerPatches = 4
        r.idle(10_000)
        assertEquals(0, r.events)
    }

    @Test
    fun aMinuteOfNormalPedalingWithNoiseAndClothingNeverRotates() {
        val r = rig()
        r.scene.noise = 6
        r.scene.flickerPatches = 3
        r.idle(60_000)
        assertEquals(0, r.events)
    }

    @Test
    fun exposureChangesAndCameraShakeNeverRotate() {
        val r = rig()
        r.idle(500)
        r.scene.offset = 40
        r.idle(400)
        r.scene.gain = 1.3f
        r.idle(400)
        r.scene.offset = 0
        r.scene.gain = 1f
        for (i in 0..60) {
            r.scene.gain = 0.75f + 0.5f * i / 60f
            r.frame()
        }
        r.scene.gain = 1f
        val shake = Random(3L)
        repeat(150) {
            r.scene.shakeX = shake.nextInt(-3, 4)
            r.scene.shakeY = shake.nextInt(-2, 3)
            r.frame()
        }
        assertEquals(0, r.events)
    }

    @Test
    fun aRaisedStationaryOrVerticallyMovingHandNeverRotates() {
        val r = rig()
        r.scene.anchorX = 0.78f
        r.scene.anchorY = 0.66f
        r.raise(0.84f, 0.36f)
        r.idle(3000)
        repeat(4) {
            r.sweep(0.84f, 0.84f, 300, 0.36f, 0.62f)
            r.sweep(0.84f, 0.84f, 300, 0.62f, 0.36f)
        }
        r.lower()
        r.idle(500)
        assertEquals(0, r.events)
    }

    @Test
    fun aWaveSplitByACameraStopDoesNotRotate() {
        val r = rig()
        r.scene.anchorX = 0.78f
        r.scene.anchorY = 0.66f
        r.raise(0.66f, 0.38f)
        r.idle(150)
        r.sweep(0.66f, 0.74f, 120)
        r.cameraOn = false
        r.idle(700)
        r.scene.handX = 0.95f
        r.cameraOn = true
        r.idle(300)
        assertEquals(0, r.events)
    }

    @Test
    fun mirroredCamerasProduceTheSameResult() {
        val r = rig(mirror = true)
        r.wave(0.30f, 0.05f, y = 0.34f, anchorX = 0.25f, anchorY = 0.62f)
        r.idle(600)
        assertEquals(1, r.events)
    }

    @Test
    fun detectionStaysCheapOnTheRealisticScene() {
        val d = WaveSwipeDetector()
        val scene = RiderScene()
        val frames = Array(6) { i ->
            scene.handX = 0.6f + 0.05f * i
            scene.handY = 0.6f
            scene.bob = 0.01f * (i % 3)
            scene.render().copyOf()
        }
        val face = scene.faceSample(0L)
        var t = 1_000_000_000L
        repeat(300) { i ->
            t += 66_000_000L
            d.observe(frames[i % frames.size], scene.width, scene.height, false, t, FaceSample(face.x, face.y, face.extent, t))
        }
        val window = DurationWindow(512)
        repeat(1000) { i ->
            t += 66_000_000L
            val f = FaceSample(face.x, face.y, face.extent, t)
            val start = System.nanoTime()
            d.observe(frames[i % frames.size], scene.width, scene.height, false, t, f)
            window.record((System.nanoTime() - start) / 1_000_000f)
        }
        println(String.format(java.util.Locale.US, "BIKETRIS_REALISTIC_MOTION_HOST_MS p50=%.3f p90=%.3f", window.percentile(0.5f), window.percentile(0.9f)))
        assertTrue(window.percentile(0.9f) < 5f)
    }
}
