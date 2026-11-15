// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.PI
import kotlin.math.sin
import kotlin.random.Random

/**
 * Synthetic rider scene in raw camera space: a static textured background, a face with a torso
 * below it, an optional hand, global brightness offset/gain and per-pixel noise.
 */
internal class MotionScene(val width: Int = 160, val height: Int = 120, seed: Long = 11L) {
    val frame = ByteArray(width * height * 3 / 2)
    private val texture = IntArray(width * height)
    private val random = Random(seed)
    var faceX = 0.5f
    var faceY = 0.4f
    var faceSize = 0.18f
    var handX = Float.NaN
    var handY = 0.3f
    var handW = 0.08f
    var handH = 0.1f
    var offset = 0
    var gain = 1f
    var noise = 0

    init {
        for (y in 0 until height) {
            for (x in 0 until width) texture[y * width + x] = 50 + ((x / 7 + y / 5) % 4) * 15 + ((x * 13 + y * 7) % 11)
        }
        frame.fill(128.toByte(), width * height, frame.size)
    }

    fun render(): ByteArray {
        val fw = faceSize * width
        val fx0 = (faceX * width - fw / 2f).toInt()
        val fy0 = (faceY * height - fw * 0.55f).toInt()
        val fy1 = (faceY * height + fw * 0.45f).toInt()
        val torsoHalf = 1.25f * fw
        val torsoTop = fy1 + (0.15f * fw).toInt()
        val hx0 = if (handX.isNaN()) -1 else ((handX - handW / 2f) * width).toInt()
        val hx1 = if (handX.isNaN()) -1 else ((handX + handW / 2f) * width).toInt()
        val hy0 = ((handY - handH / 2f) * height).toInt()
        val hy1 = ((handY + handH / 2f) * height).toInt()
        for (y in 0 until height) {
            for (x in 0 until width) {
                var v = texture[y * width + x]
                if (y >= torsoTop && x >= faceX * width - torsoHalf && x <= faceX * width + torsoHalf) v = 120 + (y % 3) * 4
                if (x >= fx0 && x < fx0 + fw && y in fy0 until fy1) v = 175 + ((x + y) % 5) * 3
                if (x in hx0 until hx1 && y in hy0 until hy1) v = 215
                var out = (v * gain).toInt() + offset
                if (noise > 0) out += random.nextInt(-noise, noise + 1)
                frame[y * width + x] = out.coerceIn(0, 255).toByte()
            }
        }
        return frame
    }

    fun faceSample(atNanos: Long): FaceSample = FaceSample(faceX, faceY, faceSize, atNanos)
}

/** Drives a detector at 30 fps camera timing with 10 Hz face samples. */
internal class WaveRig(val mirror: Boolean = false, config: WaveConfig = WaveConfig(), private val detect: WaveDetect? = null) {
    val scene = MotionScene()
    val detector = WaveSwipeDetector(config)
    var nanos = 1_000_000_000L
    var events = 0
    val eventTimes = ArrayList<Long>()
    var faceVisible = true
    private var face: FaceSample? = null
    private var nextFaceAt = Long.MIN_VALUE

    fun frame(advanceMs: Long = 33L) {
        nanos += advanceMs * 1_000_000L
        if (faceVisible && (nextFaceAt == Long.MIN_VALUE || nanos >= nextFaceAt)) {
            face = scene.faceSample(nanos)
            nextFaceAt = nanos + 100_000_000L
        }
        if (!faceVisible) face = null
        val hit = detect?.invoke(scene.render(), scene.width, scene.height, mirror, nanos, face) ?: detector.observe(scene.render(), scene.width, scene.height, mirror, nanos, face)
        if (hit) {
            events += 1
            eventTimes += nanos
        }
    }

    fun hold(ms: Long) {
        var left = ms
        while (left > 0) {
            frame()
            left -= 33
        }
    }

    fun sweep(from: Float, to: Float, ms: Long, y: Float = scene.handY) {
        val frames = (ms / 33).toInt().coerceAtLeast(1)
        scene.handY = y
        for (i in 1..frames) {
            scene.handX = from + (to - from) * i / frames
            frame()
        }
    }

    fun settle() {
        hold(500)
    }
}

class BiketrisSwipeDetectorTest {
    private fun rig(mirror: Boolean = false, config: WaveConfig = WaveConfig()): WaveRig = WaveRig(mirror, config).also { it.settle() }

    @Test
    fun leftToRightWaveRotatesOnce() {
        val r = rig()
        r.scene.handX = 0.74f
        r.hold(300)
        r.sweep(0.74f, 0.94f, 300)
        r.hold(700)
        assertEquals(1, r.events)
        assertEquals(1, r.detector.accepted)
    }

    @Test
    fun rightToLeftWaveRotatesOnce() {
        val r = rig()
        r.scene.handX = 0.26f
        r.hold(300)
        r.sweep(0.26f, 0.06f, 300)
        r.hold(700)
        assertEquals(1, r.events)
    }

    @Test
    fun aWaveAcrossTheFaceCountsOnceEitherWay() {
        val a = rig()
        a.sweep(0.12f, 0.9f, 500)
        a.scene.handX = Float.NaN
        a.hold(700)
        assertEquals(1, a.events)
        val b = rig()
        b.sweep(0.9f, 0.12f, 500)
        b.scene.handX = Float.NaN
        b.hold(700)
        assertEquals(1, b.events)
    }

    @Test
    fun mirroredCameraDetectsTheSamePlayerSpaceWave() {
        val r = rig(mirror = true)
        r.scene.handX = 0.26f
        r.hold(300)
        r.sweep(0.26f, 0.06f, 300)
        r.hold(500)
        assertEquals(1, r.events)
        assertTrue(r.detector.maskLeft < 0.5f && r.detector.maskRight > 0.5f && r.detector.maskBottom < 0.9f)
        val mapped = HandMapping.fromCamera(0.16f, 0.3f, mirror = true)
        assertTrue(mapped.x > 0.5f, "raw left is the player's right when mirrored, like the face x")
    }

    @Test
    fun aStationaryArmNeverRotates() {
        val r = rig()
        r.scene.handX = 0.82f
        r.hold(3000)
        assertEquals(0, r.events)
    }

    @Test
    fun ordinaryHeadMovementDoesNotRotate() {
        val r = rig()
        for (pass in 0 until 3) {
            for (i in 0..15) {
                r.scene.faceX = 0.4f + 0.2f * i / 15f
                r.frame()
            }
            for (i in 0..15) {
                r.scene.faceX = 0.6f - 0.2f * i / 15f
                r.frame()
            }
        }
        for (i in 0..8) {
            r.scene.faceX = 0.5f + 0.25f * i / 8f
            r.frame()
        }
        r.hold(600)
        assertEquals(0, r.events)
    }

    @Test
    fun pedalingStyleVerticalBounceDoesNotRotate() {
        val r = rig()
        r.scene.handX = 0.8f
        val start = r.nanos
        repeat(150) {
            val t = (r.nanos - start) / 1e9
            val bounce = (0.03 * sin(2 * PI * 1.3 * t)).toFloat()
            r.scene.faceY = 0.4f + bounce
            r.scene.handY = 0.3f + bounce * 1.5f
            r.frame()
        }
        assertEquals(0, r.events)
    }

    @Test
    fun aVerticalHandWaveBesideTheHeadDoesNotRotate() {
        val r = rig()
        r.scene.handX = 0.82f
        repeat(4) {
            for (i in 0..8) {
                r.scene.handY = 0.12f + 0.4f * i / 8f
                r.frame()
            }
            for (i in 0..8) {
                r.scene.handY = 0.52f - 0.4f * i / 8f
                r.frame()
            }
        }
        assertEquals(0, r.events)
    }

    @Test
    fun globalIlluminationChangesDoNotRotate() {
        val r = rig()
        r.scene.handX = 0.8f
        r.hold(300)
        r.scene.offset = 45
        r.hold(300)
        r.scene.gain = 1.35f
        r.hold(300)
        r.scene.offset = 0
        r.scene.gain = 0.7f
        r.hold(300)
        for (i in 0..40) {
            r.scene.gain = 0.7f + 0.6f * i / 40f
            r.frame()
        }
        assertEquals(0, r.events)
        assertTrue(r.detector.lastReject == WaveReject.Global || r.detector.lastReject == WaveReject.None)
    }

    @Test
    fun cameraNoiseDoesNotRotate() {
        val r = rig()
        r.scene.noise = 8
        r.hold(5000)
        assertEquals(0, r.events)
    }

    @Test
    fun aWeakOrSlowWaveIsRejected() {
        val weak = rig()
        weak.scene.handX = 0.78f
        weak.hold(300)
        weak.sweep(0.78f, 0.86f, 250)
        weak.hold(600)
        assertEquals(0, weak.events)
        val slow = rig()
        slow.scene.handX = 0.74f
        slow.hold(300)
        slow.sweep(0.74f, 0.94f, 1800)
        slow.hold(600)
        assertEquals(0, slow.events)
        assertEquals(0, slow.detector.accepted, "too slow to ever start or finish a wave")
    }

    @Test
    fun aShortEntryOrExitAtTheFrameEdgeDoesNotRotate() {
        val r = rig()
        r.sweep(1.06f, 0.93f, 200)
        r.hold(800)
        r.sweep(0.93f, 1.08f, 200)
        r.scene.handX = Float.NaN
        r.hold(800)
        assertEquals(0, r.events)
    }

    @Test
    fun continuousWavingRotatesOnceUntilRearmed() {
        val r = rig()
        r.scene.handX = 0.74f
        r.hold(300)
        repeat(8) {
            r.sweep(0.74f, 0.94f, 260)
            r.sweep(0.94f, 0.74f, 260)
        }
        assertEquals(1, r.events, "no repeats while motion continues")
        r.hold(400)
        r.sweep(0.74f, 0.94f, 300)
        r.hold(400)
        assertEquals(2, r.events, "a real second wave counts after a release")
    }

    @Test
    fun cooldownBlocksAQuickSecondWave() {
        val config = WaveConfig(cooldownNanos = 900_000_000L)
        val r = rig(config = config)
        r.scene.handX = 0.74f
        r.hold(300)
        r.sweep(0.74f, 0.94f, 300)
        r.hold(250)
        r.sweep(0.94f, 0.74f, 300)
        assertEquals(1, r.events)
        r.hold(700)
        r.sweep(0.74f, 0.94f, 300)
        r.hold(300)
        assertEquals(2, r.events)
        assertTrue(r.eventTimes[1] - r.eventTimes[0] >= config.cooldownNanos)
    }

    @Test
    fun rapidRealGesturesAreDistinguishedAfterRearm() {
        val r = rig()
        r.scene.handX = 0.74f
        r.hold(300)
        repeat(3) { i ->
            if (i % 2 == 0) r.sweep(0.74f, 0.94f, 260) else r.sweep(0.94f, 0.74f, 260)
            r.hold(700)
        }
        assertEquals(3, r.events)
    }

    @Test
    fun aCameraGapNeverDiffsAgainstAStaleFrame() {
        val r = rig()
        r.scene.handX = 0.74f
        r.hold(300)
        r.sweep(0.74f, 0.82f, 130)
        r.scene.handX = 0.94f
        r.frame(advanceMs = 600)
        r.hold(150)
        assertEquals(0, r.events, "the jump across the gap is not motion")
        r.hold(500)
        r.sweep(0.94f, 0.74f, 300)
        r.hold(300)
        assertEquals(1, r.events, "detection recovers after the gap")
    }

    @Test
    fun theFirstFramesAfterAResetAreNeverAnEvent() {
        val r = WaveRig()
        r.scene.handX = 0.74f
        r.frame()
        r.scene.handX = 0.94f
        r.frame()
        r.scene.handX = 0.74f
        r.frame()
        assertEquals(0, r.events)
        assertEquals(WaveState.Unsettled, r.detector.state)
    }

    @Test
    fun headMaskIsACompactBoxThatFollowsTheFaceAndFallsBackWhenLost() {
        val r = rig()
        r.scene.faceX = 0.3f
        r.hold(300)
        val d = r.detector
        assertTrue(d.maskLeft < 0.3f && d.maskRight > 0.3f && d.maskRight < 0.5f, "${d.maskLeft}..${d.maskRight}")
        assertTrue(d.maskTop < 0.4f && d.maskBottom > 0.4f, "covers the face rows")
        assertTrue(d.maskBottom < 0.75f, "rows below the head stay analysed: bottom ${d.maskBottom}")
        assertTrue(d.maskTop > 0f, "rows above the head stay analysed: top ${d.maskTop}")
        r.faceVisible = false
        r.hold(300)
        assertEquals(0.3f, (d.maskLeft + d.maskRight) / 2f, 0.03f, "held at the last face during a brief loss")
        r.hold(600)
        assertEquals(0.5f, (d.maskLeft + d.maskRight) / 2f, 0.01f, "falls back to a default head box")
        assertTrue(d.maskBottom < 0.75f)
    }

    @Test
    fun rateLimitProcessesAboutFifteenObservationsPerSecond() {
        val r = rig()
        val before = r.detector.observations
        r.hold(1000)
        val processed = r.detector.observations - before
        assertTrue(processed in 13..17, "processed $processed")
    }

    @Test
    fun sensitivityPresetsAreOrdered() {
        val low = WaveConfig.forSensitivity(0, 650_000_000L)
        val mid = WaveConfig.forSensitivity(1, 650_000_000L)
        val high = WaveConfig.forSensitivity(2, 650_000_000L)
        assertTrue(low.cellThreshold > mid.cellThreshold && mid.cellThreshold >= high.cellThreshold)
        assertTrue(low.minDisplacement > mid.minDisplacement && mid.minDisplacement > high.minDisplacement)
        assertTrue(low.onsetSpeed > mid.onsetSpeed && mid.onsetSpeed > high.onsetSpeed)
        assertEquals(800_000_000L, WaveConfig.forSensitivity(1, 800_000_000L).cooldownNanos)
    }

    @Test
    fun steadyStateObservationAllocatesNothing() {
        val r = rig()
        r.scene.handX = 0.74f
        val frames = Array(8) { i ->
            r.scene.handX = 0.74f + 0.025f * i
            r.scene.render().copyOf()
        }
        val face = r.scene.faceSample(r.nanos)
        var t = r.nanos
        repeat(200) { i ->
            t += 66_000_000L
            r.detector.observe(frames[i % frames.size], r.scene.width, r.scene.height, false, t, face)
        }
        val before = threadAllocatedBytes() ?: return
        repeat(300) { i ->
            t += 66_000_000L
            r.detector.observe(frames[i % frames.size], r.scene.width, r.scene.height, false, t, face)
        }
        val after = threadAllocatedBytes() ?: return
        val perFrame = (after - before) / 300.0
        println("BIKETRIS_MOTION_ALLOC_BYTES_PER_OBSERVATION=" + String.format(java.util.Locale.US, "%.1f", perFrame))
        assertTrue(perFrame < 64.0, "allocated $perFrame bytes per observation")
    }

    private fun threadAllocatedBytes(): Long? = try {
        val bean = Class.forName("java.lang.management.ManagementFactory").getMethod("getThreadMXBean").invoke(null)
        val api = Class.forName("com.sun.management.ThreadMXBean")
        api.getMethod("getThreadAllocatedBytes", Long::class.javaPrimitiveType).invoke(bean, Thread.currentThread().id) as Long
    } catch (e: ReflectiveOperationException) {
        null
    }

    @Test
    fun observationCostIsSmallOnTheHost() {
        val r = rig()
        val frame = MotionScene(320, 240).render()
        val face = FaceSample(0.5f, 0.4f, 0.18f, r.nanos)
        val detector = WaveSwipeDetector()
        var t = 1_000_000_000L
        repeat(500) {
            t += 66_000_000L
            detector.observe(frame, 320, 240, true, t, face)
        }
        val start = System.nanoTime()
        repeat(2000) {
            t += 66_000_000L
            detector.observe(frame, 320, 240, true, t, face)
        }
        val micros = (System.nanoTime() - start) / 2000 / 1000.0
        println("BIKETRIS_MOTION_HOST_MICROS_PER_OBSERVATION=" + String.format(java.util.Locale.US, "%.1f", micros))
        assertTrue(micros < 2000.0, "host cost $micros us per observation")
    }
}

class WaveGestureInputTest {
    @Test
    fun eventsCarryIncreasingSequencesAndStaleGenerationsAreIgnored() {
        val input = WaveGestureInput()
        assertNull(input.latest())
        val gen = input.generation()
        assertTrue(input.publish(gen, 10L))
        val first = requireNotNull(input.latest())
        assertTrue(input.publish(gen, 20L))
        assertTrue(input.latest()!!.sequence > first.sequence)
        input.clear()
        assertNull(input.latest(), "camera stop drops the last event")
        assertFalse(input.publish(gen, 30L), "a detector from the stopped session cannot publish")
        assertNull(input.latest())
        assertTrue(input.publish(input.generation(), 40L))
        assertTrue(input.latest()!!.sequence > first.sequence + 1, "sequences never restart")
    }

    @Test
    fun processorPublishesIntoItsOwnGenerationOnly() {
        val input = WaveGestureInput()
        val processor = WaveMotionProcessor(input, input.generation())
        val scene = MotionScene()
        var t = 1_000_000_000L
        fun feed(ms: Long) {
            var left = ms
            while (left > 0) {
                t += 33_000_000L
                processor.onFace(scene.faceX, scene.faceY, scene.faceSize, t)
                processor.onFrame(scene.render(), scene.width, scene.height, false, t)
                left -= 33
            }
        }
        feed(600)
        scene.handX = 0.74f
        feed(300)
        for (i in 1..9) {
            scene.handX = 0.74f + 0.2f * i / 9f
            feed(33)
        }
        feed(300)
        val event = input.latest()
        assertNotNull(event)
        assertEquals(1, input.accepted)
        assertTrue(input.observations > 0)
        assertTrue(input.processing.percentile(0.5f) >= 0f)
        input.clear()
        scene.handX = 0.74f
        feed(800)
        for (i in 1..9) {
            scene.handX = 0.74f + 0.2f * i / 9f
            feed(33)
        }
        feed(300)
        assertNull(input.latest(), "an old-session processor never publishes after clear")
    }

    @Test
    fun disablingSkipsAnalysisAndReenablingStartsFresh() {
        val input = WaveGestureInput()
        val processor = WaveMotionProcessor(input, input.generation())
        val scene = MotionScene()
        input.enabled = false
        var t = 1_000_000_000L
        repeat(30) {
            t += 33_000_000L
            processor.onFrame(scene.render(), scene.width, scene.height, false, t)
        }
        assertEquals(0L, input.observations)
        assertEquals(WaveState.Disabled, input.state)
        input.enabled = true
        repeat(30) {
            t += 33_000_000L
            processor.onFrame(scene.render(), scene.width, scene.height, false, t)
        }
        assertTrue(input.observations > 0)
    }

    @Test
    fun simulatedEventsUseTheSameChannel() {
        val input = WaveGestureInput()
        input.simulate(5L)
        val event = requireNotNull(input.latest())
        assertTrue(event.simulated)
        assertEquals(1, input.simulatedEvents)
    }
}
