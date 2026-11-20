// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class BiketrisControllerTest {
    private val initialNanos = 10_000_000_000L

    @Test
    fun controllerDefaultsOnConnectionButWebcamPreferenceAlwaysWins() {
        assertEquals(BiketrisInputSource.Webcam, BiketrisInputSelection.effective(null, false))
        assertEquals(BiketrisInputSource.Controller, BiketrisInputSelection.effective(null, true))
        assertEquals(BiketrisInputSource.Webcam, BiketrisInputSelection.effective("Webcam", true))
        assertEquals(BiketrisInputSource.Webcam, BiketrisInputSelection.effective("Webcam", false))
        assertEquals(BiketrisInputSource.Controller, BiketrisInputSelection.effective("Controller", true))
        assertEquals(BiketrisInputSource.Webcam, BiketrisInputSelection.effective("Controller", false))
        assertEquals(BiketrisInputSource.Controller, BiketrisInputSelection.effective("Controller", true))
        assertEquals("biketris_input_source", BiketrisInputSelection.PREF_KEY)
        assertFalse(BiketrisInputSelection.PREF_KEY == BricksInputSelection.PREF_KEY)
    }

    @Test
    fun controllerStartsPlayingWithCameraUnavailableAndIgnoresFace() {
        val game = BiketrisGame(seed = 9L)
        val session = BiketrisSession(game)
        val x0 = game.pieceLeft
        var now = initialNanos
        repeat(8) {
            now += 33_000_000L
            session.update(
                HandPosition(0.99f, 0.5f, 1f, now, HandSource.Camera),
                CameraState.Unavailable, Float.NaN, null, now,
                controller = BiketrisControllerInput(left = true),
            )
        }
        assertEquals(BiketrisHold.None, session.hold)
        assertEquals(BiketrisControl.Controller, session.reading.control)
        assertTrue(session.live)
        assertTrue(game.pieceLeft < x0, "left key moves without needing camera")
        assertFalse(session.touchSession)
        assertEquals(0, session.waveRotations)
    }

    @Test
    fun rightKeyMovesAndNeutralDoesNotContinueToSlide() {
        val game = BiketrisGame(seed = 9L)
        val session = BiketrisSession(game)
        val start = game.pieceLeft
        var now = initialNanos
        repeat(12) {
            now += 33_000_000L
            session.update(
                HandPosition(0f, 0.5f, 0f, now, HandSource.Lost),
                CameraState.Off, Float.NaN, null, now,
                controller = BiketrisControllerInput(right = true),
            )
        }
        assertTrue(game.pieceLeft > start)
        val stopped = game.pieceLeft
        repeat(8) {
            now += 33_000_000L
            session.update(
                HandPosition(0f, 0.5f, 0f, now, HandSource.Lost),
                CameraState.Off, Float.NaN, null, now,
                controller = BiketrisControllerInput(),
            )
        }
        assertEquals(stopped, game.pieceLeft)
        assertEquals(-1, game.targetLeft)
    }

    @Test
    fun rotationRequiresAnExplicitControllerPressAndDoesNotUseWave() {
        val game = BiketrisGame(seed = 7L)
        val session = BiketrisSession(game)
        var now = initialNanos
        val sample = HandPosition(0.5f, 0.5f, 0f, now, HandSource.Lost)
        now += 33_000_000L
        session.update(sample, CameraState.Off, Float.NaN, null, now,
            controller = BiketrisControllerInput(rotate = true))
        assertEquals(1, game.rotations)
        val rotation = game.rotation
        repeat(10) {
            now += 33_000_000L
            session.update(sample, CameraState.Off, Float.NaN, null, now,
                controller = BiketrisControllerInput())
        }
        assertEquals(rotation, game.rotation)
        assertEquals(1, game.rotations)
        assertEquals(0, session.waveRotations)
    }

    @Test
    fun softDropIsIndependentOfActualCadenceAndReleasesCleanly() {
        val game = BiketrisGame(seed = 7L)
        val session = BiketrisSession(game)
        val sample = HandPosition(0.5f, 0.5f, 0f, initialNanos, HandSource.Lost)
        val originalGravity = game.effectiveGravitySeconds
        val originalScale = game.gravityScale
        val startingY = game.pieceY
        var now = initialNanos
        repeat(12) {
            now += 33_000_000L
            session.update(sample, CameraState.Off, Float.NaN, null, now,
                controller = BiketrisControllerInput(softDrop = true))
        }
        assertTrue(game.softDropActive)
        assertTrue(game.effectiveGravitySeconds < originalGravity)
        assertTrue(game.pieceY > startingY, "holding down moves the piece toward the floor")
        assertEquals(originalScale, game.gravityScale)
        now += 33_000_000L
        session.update(sample, CameraState.Off, Float.NaN, null, now,
            controller = BiketrisControllerInput())
        assertFalse(game.softDropActive)
        assertEquals(originalGravity, game.effectiveGravitySeconds, 0.0001f)
        session.pause()
        assertFalse(game.softDropActive)
        session.restart(12L)
        assertFalse(game.softDropActive)
    }

    @Test
    fun cameraModeStillSupportsHeadSteeringAndWaveRotation() {
        val game = BiketrisGame(seed = 9L)
        val session = BiketrisSession(game)
        var now = initialNanos
        repeat(28) {
            now += 33_000_000L
            session.update(
                HandPosition(0f, 0.5f, 0.95f, now, HandSource.Camera),
                CameraState.Ready, Float.NaN, null, now,
            )
        }
        assertEquals(BiketrisControl.Face, session.reading.control)
        assertTrue(session.live)
        assertEquals(0, game.pieceLeft)
    }

    @Test
    fun toggleAndControllerActionIntegrationIsScopedToBiketris() {
        val source = File("src/main/kotlin/com/fitbaus/arcade/BiketrisView.kt").readText()
        assertTrue(source.contains("prefs?.edit()?.putString(BiketrisInputSelection.PREF_KEY, source.name)?.apply()"))
        assertTrue(source.contains("onInputSourceChanged?.invoke(inputSource)"))
        assertTrue(source.contains("drawInputSourceSelector(canvas)"))
        assertTrue(source.contains("controller = if (inputSource == BiketrisInputSource.Controller) controller else null"))
        assertTrue(source.contains("if (inputSource == BiketrisInputSource.Webcam) wave?.latest() else null"))
        assertTrue(source.contains("webcamRect.contains(x, y)"))
        assertTrue(source.contains("controllerRect.contains(x, y)"))
    }
}
