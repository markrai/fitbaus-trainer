// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.random.Random

/** Every realistic and simple scenario, run against each sensitivity preset. */
class BiketrisWaveMatrixTest {
    private class Scenario(val name: String, val expected: Int, val run: (WaveDetect) -> Int)

    private fun real(d: WaveDetect, body: (GestureRig) -> Unit): Int {
        val r = GestureRig(d)
        r.warmUp()
        body(r)
        return r.events
    }

    private fun simple(d: WaveDetect, body: (WaveRig) -> Unit): Int {
        val r = WaveRig(detect = d)
        r.settle()
        body(r)
        return r.events
    }

    private val scenarios = listOf(
        Scenario("besideR", 1) { d -> real(d) { it.wave(0.70f, 0.95f, y = 0.34f, anchorX = 0.75f, anchorY = 0.62f); it.idle(600) } },
        Scenario("besideL", 1) { d -> real(d) { it.wave(0.30f, 0.05f, y = 0.34f, anchorX = 0.25f, anchorY = 0.62f); it.idle(600) } },
        Scenario("shoulder", 1) { d -> real(d) { it.wave(0.88f, 0.52f, y = 0.6f, anchorX = 0.8f, anchorY = 0.78f); it.idle(600) } },
        Scenario("chestR", 1) { d -> real(d) { it.wave(0.74f, 0.28f, y = 0.72f, anchorX = 0.78f, anchorY = 0.86f); it.idle(600) } },
        Scenario("chestL", 1) { d -> real(d) { it.wave(0.26f, 0.72f, y = 0.72f, anchorX = 0.22f, anchorY = 0.86f); it.idle(600) } },
        Scenario("d250+", 1) { d -> real(d) { it.wave(0.66f, 0.95f, y = 0.4f, ms = 250, drift = 0.06f, anchorX = 0.78f, anchorY = 0.7f); it.idle(600) } },
        Scenario("d350-", 1) { d -> real(d) { it.wave(0.66f, 0.95f, y = 0.4f, ms = 350, drift = -0.08f, anchorX = 0.78f, anchorY = 0.7f); it.idle(600) } },
        Scenario("d600", 1) { d -> real(d) { it.wave(0.66f, 0.95f, y = 0.4f, ms = 600, drift = 0.05f, anchorX = 0.78f, anchorY = 0.7f); it.idle(600) } },
        Scenario("headWith", 1) { d -> real(d) { r -> headWave(r, 0.76f, -0.46f) } },
        Scenario("headAgainst", 1) { d -> real(d) { r -> headWave(r, 0.3f, 0.46f) } },
        Scenario("entering", 1) { d -> real(d) { r ->
            r.scene.anchorX = 0.95f; r.scene.anchorY = 0.75f; r.scene.handY = 0.45f
            r.sweep(1.15f, 0.62f, 450); r.idle(200); r.lower(); r.idle(600)
        } },
        Scenario("crossFace", 1) { d -> real(d) { r ->
            r.scene.anchorX = 0.8f; r.scene.anchorY = 0.7f; r.raise(0.85f, 0.36f); r.idle(150)
            r.faceVisible = false; r.sweep(0.85f, 0.15f, 450); r.faceVisible = true; r.idle(200); r.lower(); r.idle(600)
        } },
        Scenario("twoWaves", 2) { d -> real(d) { r ->
            r.scene.flickerPatches = 3; r.scene.noise = 4
            r.wave(0.68f, 0.95f, y = 0.38f, anchorX = 0.78f, anchorY = 0.66f); r.idle(700)
            r.wave(0.95f, 0.68f, y = 0.38f, anchorX = 0.78f, anchorY = 0.66f); r.idle(600)
        } },
        Scenario("background", 2) { d -> real(d) { r ->
            r.scene.flickerPatches = 3; r.scene.flickerAmp = 35; r.scene.flickerX0 = 0f; r.scene.flickerX1 = 0.25f; r.scene.flickerY0 = 0.1f; r.scene.flickerY1 = 0.5f
            r.idle(1500)
            r.wave(0.68f, 0.95f, y = 0.38f, anchorX = 0.78f, anchorY = 0.66f); r.idle(800)
            r.wave(0.95f, 0.68f, y = 0.38f, anchorX = 0.78f, anchorY = 0.66f); r.idle(600)
        } },
        Scenario("continuous", 1) { d -> real(d) { r ->
            r.scene.anchorX = 0.78f; r.scene.anchorY = 0.7f; r.raise(0.66f, 0.4f)
            repeat(6) { r.sweep(0.66f, 0.95f, 300); r.sweep(0.95f, 0.66f, 300) }
        } },
        Scenario("headOnly", 0) { d -> real(d) { r -> headOnly(r) } },
        Scenario("sway", 0) { d -> real(d) { r -> r.swayAmp = 0.03f; r.bobAmp = 0.02f; r.cadenceHz = 1.5; r.scene.flickerPatches = 4; r.idle(10_000) } },
        Scenario("pedal30s", 0) { d -> real(d) { r -> r.scene.noise = 6; r.scene.flickerPatches = 3; r.idle(30_000) } },
        Scenario("exposureShake", 0) { d -> real(d) { r ->
            r.scene.offset = 40; r.idle(400); r.scene.gain = 1.3f; r.idle(400); r.scene.offset = 0; r.scene.gain = 1f
            val shake = Random(3L)
            repeat(150) { r.scene.shakeX = shake.nextInt(-3, 4); r.scene.shakeY = shake.nextInt(-2, 3); r.frame() }
        } },
        Scenario("raisedVertical", 0) { d -> real(d) { r ->
            r.scene.anchorX = 0.78f; r.scene.anchorY = 0.66f; r.raise(0.84f, 0.36f); r.idle(3000)
            repeat(4) { r.sweep(0.84f, 0.84f, 300, 0.36f, 0.62f); r.sweep(0.84f, 0.84f, 300, 0.62f, 0.36f) }
            r.lower()
        } },
        Scenario("sLR", 1) { d -> simple(d) { r -> r.scene.handX = 0.74f; r.hold(300); r.sweep(0.74f, 0.94f, 300); r.hold(700) } },
        Scenario("sRL", 1) { d -> simple(d) { r -> r.scene.handX = 0.26f; r.hold(300); r.sweep(0.26f, 0.06f, 300); r.hold(700) } },
        Scenario("sAcross", 1) { d -> simple(d) { r -> r.sweep(0.12f, 0.9f, 500); r.scene.handX = Float.NaN; r.hold(700) } },
        Scenario("sHead", 0) { d -> simple(d) { r ->
            for (pass in 0 until 3) {
                for (i in 0..15) { r.scene.faceX = 0.4f + 0.2f * i / 15f; r.frame() }
                for (i in 0..15) { r.scene.faceX = 0.6f - 0.2f * i / 15f; r.frame() }
            }
            for (i in 0..8) { r.scene.faceX = 0.5f + 0.25f * i / 8f; r.frame() }
            r.hold(600)
        } },
        Scenario("sBounce", 0) { d -> simple(d) { r ->
            r.scene.handX = 0.8f
            val start = r.nanos
            repeat(150) {
                val t = (r.nanos - start) / 1e9
                val b = (0.03 * Math.sin(2 * PI * 1.3 * t)).toFloat()
                r.scene.faceY = 0.4f + b; r.scene.handY = 0.3f + b * 1.5f; r.frame()
            }
        } },
        Scenario("sVertical", 0) { d -> simple(d) { r ->
            r.scene.handX = 0.82f
            repeat(4) {
                for (i in 0..8) { r.scene.handY = 0.12f + 0.4f * i / 8f; r.frame() }
                for (i in 0..8) { r.scene.handY = 0.52f - 0.4f * i / 8f; r.frame() }
            }
        } },
        Scenario("sWeak", 0) { d -> simple(d) { r -> r.scene.handX = 0.78f; r.hold(300); r.sweep(0.78f, 0.86f, 250); r.hold(600) } },
        Scenario("sSlow", 0) { d -> simple(d) { r -> r.scene.handX = 0.74f; r.hold(300); r.sweep(0.74f, 0.94f, 1800); r.hold(600) } },
        Scenario("sNoise", 0) { d -> simple(d) { r -> r.scene.noise = 8; r.hold(5000) } },
        Scenario("sRapid3", 3) { d -> simple(d) { r ->
            r.scene.handX = 0.74f; r.hold(300)
            repeat(3) { i -> if (i % 2 == 0) r.sweep(0.74f, 0.94f, 260) else r.sweep(0.94f, 0.74f, 260); r.hold(700) }
        } },
    )

    private fun headWave(r: GestureRig, from: Float, travel: Float) {
        r.scene.anchorX = 0.78f
        r.scene.anchorY = 0.86f
        r.raise(from, 0.72f)
        r.idle(150)
        for (i in 1..12) {
            val p = (1 - cos(PI * i / 12)).toFloat() / 2f
            r.scene.faceX = 0.5f - 0.08f * p
            r.scene.torsoX = 0.5f - 0.05f * p
            r.scene.handX = from + travel * p
            r.frame()
        }
        r.idle(200)
        r.lower()
        r.idle(600)
    }

    private fun headOnly(r: GestureRig) {
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
    }

    private fun failures(config: WaveConfig): List<String> {
        val fails = ArrayList<String>()
        for (s in scenarios) {
            val got = s.run(WaveDetectors.current(config))
            if (got != s.expected) fails += "${s.name}: $got events, expected ${s.expected}"
        }
        return fails
    }

    @Test
    fun mediumSensitivityPassesEveryScenario() {
        assertEquals(emptyList<String>(), failures(WaveConfig.forSensitivity(1, 650_000_000L)))
    }

    @Test
    fun lowSensitivityPassesEveryScenario() {
        assertEquals(emptyList<String>(), failures(WaveConfig.forSensitivity(0, 650_000_000L)))
    }

    @Test
    fun highSensitivityPassesEveryScenario() {
        assertEquals(emptyList<String>(), failures(WaveConfig.forSensitivity(2, 650_000_000L)))
    }
}
