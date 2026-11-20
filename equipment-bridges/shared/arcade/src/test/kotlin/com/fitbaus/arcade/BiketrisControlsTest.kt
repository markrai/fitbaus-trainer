// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BiketrisControlsTest {
    private val frameNanos = 33_000_000L

    private class Rig(seed: Long = 7L) {
        val game = BiketrisGame(seed = seed)
        val session = BiketrisSession(game)
        val gestures = WaveGestureInput()
        var nanos = 10_000_000_000L
        var faceX = 0.5f
        var faceAt = nanos
        var faceOn = true
        var camera = CameraState.Ready
        var touch = Float.NaN
        var bike = false
        var rpm: Int? = null
        var sampleEveryMs = 250L
        private var sampleSerial = 0
        private var lastSampleAt = Long.MIN_VALUE
        private var observedAt: String? = null

        fun position(): HandPosition = if (faceOn) {
            faceAt = nanos
            HandPosition(faceX, 0.5f, 0.9f, faceAt, HandSource.Camera)
        } else {
            HandPosition(faceX, 0.5f, 0f, nanos, HandSource.Lost)
        }

        fun tick(ms: Long = 33L): BiketrisHold {
            nanos += ms * 1_000_000L
            if (bike && rpm != null && (lastSampleAt == Long.MIN_VALUE || nanos - lastSampleAt >= sampleEveryMs * 1_000_000L)) {
                lastSampleAt = nanos
                sampleSerial += 1
                observedAt = "sample-$sampleSerial"
            }
            return session.update(position(), camera, touch, gestures.latest(), nanos, bike, bike, rpm, bike && rpm != null, observedAt)
        }

        fun run(ms: Long) {
            var left = ms
            while (left > 0) {
                tick()
                left -= 33
            }
        }

        fun goLive() {
            run(700)
            check(session.live) { "expected live, was ${session.hold}" }
        }
    }

    @Test
    fun mapperSpansThePieceWidthLeftToRight() {
        val m = HeadColumnMapper()
        assertEquals(0, m.map(0f, 7))
        m.reset()
        assertEquals(7, m.map(1f, 7))
        m.reset()
        assertEquals(6, m.map(1f, 6), "a horizontal I stops with its right cell on the last column")
        m.reset()
        assertEquals(8, m.map(1f, 8), "O is two wide")
        m.reset()
        var last = -1
        for (i in 0..100) {
            val c = m.map(i / 100f, 7)
            assertTrue(c >= last, "monotonic at $i")
            last = c
        }
        assertEquals(7, last)
    }

    @Test
    fun mapperHysteresisIgnoresJitterNearABoundary() {
        val m = HeadColumnMapper(hysteresis = 0.2f)
        val maxLeft = 7
        fun x(u: Float) = u / maxLeft
        assertEquals(3, m.map(x(3.0f), maxLeft))
        for (i in 0 until 40) assertEquals(3, m.map(x(if (i % 2 == 0) 3.62f else 3.38f), maxLeft), "jitter $i")
        assertEquals(4, m.map(x(3.75f), maxLeft))
        assertEquals(4, m.map(x(3.35f), maxLeft), "needs to pass the midpoint by the hysteresis to go back")
        assertEquals(3, m.map(x(3.25f), maxLeft))
        assertEquals(6, m.map(x(6.0f), maxLeft), "a large move still lands on the nearest column")
    }

    @Test
    fun gainWidensTheReachOfTheHead() {
        val normal = HeadColumnMapper(gain = 1f)
        val high = HeadColumnMapper(gain = 1.5f)
        assertEquals(6, normal.map(0.85f, 7))
        assertEquals(7, high.map(0.85f, 7))
        normal.reset()
        high.reset()
        assertEquals(1, normal.map(0.15f, 7))
        assertEquals(0, high.map(0.15f, 7))
    }

    @Test
    fun headLeftMovesThePieceLeftAndHeadRightMovesItRight() {
        val r = Rig()
        r.goLive()
        r.faceX = 0f
        r.run(600)
        assertEquals(0, r.game.pieceLeft)
        r.faceX = 1f
        r.run(800)
        assertEquals(r.game.maxLeft, r.game.pieceLeft)
        r.faceX = 0.5f
        r.run(600)
        assertTrue(r.game.pieceLeft in 3..4)
    }

    @Test
    fun aRapidHeadShiftSlidesColumnByColumn() {
        val r = Rig()
        r.goLive()
        r.faceX = 0f
        r.run(600)
        r.faceX = 1f
        r.tick()
        assertTrue(r.game.pieceLeft <= 1, "one column per move interval, not a teleport")
    }

    @Test
    fun staleFaceSamplesNeverMoveThePiece() {
        val r = Rig()
        r.goLive()
        val x0 = r.game.pieceX
        r.nanos += 1_000_000L
        val old = HandPosition(0f, 0.5f, 0.9f, r.nanos - 450_000_000L, HandSource.Camera)
        repeat(10) {
            r.nanos += frameNanos
            r.session.update(old, CameraState.Ready, Float.NaN, null, r.nanos)
        }
        assertEquals(BiketrisControl.Lost, r.session.reading.control)
        assertEquals(x0, r.game.pieceX)
        assertEquals(-1, r.game.targetLeft)
    }

    @Test
    fun faceLossKeepsFallingBrieflyThenHolds() {
        val r = Rig()
        r.goLive()
        r.faceX = 0.1f
        r.faceOn = false
        r.tick()
        assertEquals(BiketrisHold.None, r.session.hold, "short grace")
        assertEquals(-1, r.game.targetLeft, "no sideways movement without a fresh face")
        r.run(700)
        assertEquals(BiketrisHold.FaceLost, r.session.hold)
        val elapsed = r.game.elapsed
        val y = r.game.pieceY
        r.run(3000)
        assertEquals(elapsed, r.game.elapsed, "gravity paused while the face is lost")
        assertEquals(y, r.game.pieceY)
        assertEquals("FACE LOST - LOOK AT THE SCREEN", r.session.message())
    }

    @Test
    fun rapidReacquisitionResumesWithoutRestarting() {
        val r = Rig()
        r.goLive()
        val pieces = r.game.piecesSpawned
        val seed = r.game.seed
        r.faceOn = false
        r.run(1000)
        assertEquals(BiketrisHold.FaceLost, r.session.hold)
        r.faceOn = true
        r.tick()
        assertEquals(BiketrisHold.Resuming, r.session.hold)
        r.run(650)
        assertEquals(BiketrisHold.None, r.session.hold)
        assertEquals(pieces, r.game.piecesSpawned)
        assertEquals(seed, r.game.seed)
        assertEquals(BiketrisPhase.Playing, r.game.phase)
    }

    @Test
    fun cameraStatesHoldUntilTouchOrFace() {
        val r = Rig()
        r.camera = CameraState.Starting
        r.faceOn = false
        assertEquals(BiketrisHold.CameraStarting, r.tick())
        r.camera = CameraState.Ready
        assertEquals(BiketrisHold.LookToStart, r.tick())
        r.camera = CameraState.Unavailable
        assertEquals(BiketrisHold.CameraUnavailable, r.tick())
        r.touch = 0.9f
        assertEquals(BiketrisHold.None, r.tick())
        r.touch = Float.NaN
        r.run(2000)
        assertEquals(BiketrisHold.None, r.session.hold, "touch play keeps running while the camera is unavailable")
        assertTrue(r.game.elapsed > 1.5f)
    }

    @Test
    fun touchDragMovesThePieceAndAWaveStillRotatesDuringTouchPlay() {
        val r = Rig()
        r.faceOn = false
        r.camera = CameraState.Unavailable
        r.touch = 0f
        r.run(600)
        assertEquals(0, r.game.pieceLeft)
        r.touch = Float.NaN
        val rotation = r.game.rotation
        r.gestures.simulate(r.nanos)
        r.tick()
        assertEquals((rotation + 1) and 3, r.game.rotation)
        assertEquals(1, r.session.waveRotations)
    }

    private fun tapBoard(r: Rig, x: Float = 0.5f) {
        r.touch = x
        r.tick()
        r.touch = Float.NaN
    }

    @Test
    fun touchOnlyGravityRunsUnattendedForMoreThanTenSeconds() {
        for (camera in listOf(CameraState.Unavailable, CameraState.PermissionDenied, CameraState.Starting, CameraState.Ready)) {
            val r = Rig()
            r.faceOn = false
            r.camera = camera
            r.tick()
            assertFalse(r.session.live, "$camera: held before any touch")
            tapBoard(r)
            assertTrue(r.session.touchSession, "$camera: one tap starts touch play")
            val y0 = r.game.pieceY
            val spawned = r.game.piecesSpawned
            var t = 0L
            while (t < 12_000L) {
                assertEquals(BiketrisHold.None, r.tick(), "$camera: still live after $t ms with no finger down")
                t += 33L
            }
            assertTrue(r.game.elapsed > 11.5f, "$camera: gravity ran ${r.game.elapsed} s")
            assertTrue(r.game.pieceY - y0 >= 12 || r.game.piecesSpawned > spawned, "$camera: the piece kept falling")
            assertTrue(r.session.touchSession)
        }
    }

    @Test
    fun aSingleTapOnTheBoardStartsTouchPlayWithoutRotating() {
        for (setup in listOf("unavailable", "lookToStart", "faceLost")) {
            val r = Rig()
            if (setup == "faceLost") r.goLive()
            r.faceOn = false
            r.camera = if (setup == "unavailable") CameraState.Unavailable else CameraState.Ready
            r.run(800)
            assertFalse(r.session.live, "$setup: held")
            val rotation = r.game.rotation
            r.session.noteTouchIntent()
            r.tick()
            assertEquals(rotation, r.game.rotation, "$setup: a tap never rotates")
            assertTrue(r.session.touchSession, "$setup: the tap established touch play")
            r.run(5000)
            assertTrue(r.session.live, "$setup: keeps running")
        }
    }

    @Test
    fun cameraRecoveryHandsControlBackToAStableFaceWithoutAPause() {
        val r = Rig()
        r.faceOn = false
        r.camera = CameraState.Unavailable
        tapBoard(r, 0.9f)
        r.run(500)
        val column = r.game.pieceLeft
        r.camera = CameraState.Ready
        r.faceOn = true
        r.faceX = 0f
        r.run(400)
        assertTrue(r.session.touchSession, "face not yet stable")
        assertEquals(column, r.game.pieceLeft, "an unstable face does not steer during touch play")
        var t = 0L
        while (t < 800L) {
            assertEquals(BiketrisHold.None, r.tick(), "no pause during the handover at $t ms")
            t += 33L
        }
        assertFalse(r.session.touchSession)
        assertEquals(BiketrisControl.Face, r.session.reading.control)
        r.run(400)
        assertEquals(0, r.game.pieceLeft, "the head steers again")
        r.faceOn = false
        r.run(1000)
        assertEquals(BiketrisHold.FaceLost, r.session.hold, "after the handover a lost face holds again")
    }

    @Test
    fun aHealthyFaceKeepsTouchAsATemporaryOverrideOnly() {
        val r = Rig()
        r.goLive()
        r.touch = 0f
        r.run(600)
        assertEquals(0, r.game.pieceLeft, "the finger overrides the head while down")
        assertFalse(r.session.touchSession, "no touch-play session while the face is healthy")
        r.touch = Float.NaN
        r.faceX = 1f
        r.run(800)
        assertEquals(r.game.maxLeft, r.game.pieceLeft, "the head steers again after release")
        val rotation = r.game.rotation
        r.gestures.publish(r.gestures.generation(), r.nanos)
        r.tick()
        assertEquals((rotation + 1) and 3, r.game.rotation)
        assertFalse(r.session.touchSession)
        r.faceOn = false
        r.run(1000)
        assertEquals(BiketrisHold.FaceLost, r.session.hold)
    }

    @Test
    fun restartEndsTouchPlayUntilTheNextIntentionalTouch() {
        val r = Rig()
        r.faceOn = false
        r.camera = CameraState.Unavailable
        tapBoard(r)
        r.run(1000)
        assertTrue(r.session.live)
        r.session.restart(55L)
        assertFalse(r.session.touchSession)
        assertEquals(BiketrisHold.CameraUnavailable, r.tick())
        r.session.noteTouchIntent()
        assertEquals(BiketrisHold.None, r.tick())
        assertTrue(r.session.touchSession)
        r.run(3000)
        assertTrue(r.session.live)
    }

    @Test
    fun gameOverEndsTouchPlay() {
        val r = Rig()
        r.faceOn = false
        r.camera = CameraState.Unavailable
        tapBoard(r)
        val rows = ArrayList<String>()
        repeat(r.game.rows - 4) { rows += "###.######" }
        rows.add(0, "...####...")
        rows.add(0, "...####...")
        r.game.loadRowsForTest(rows)
        r.game.placeForTest(BlockPiece.O, 0, 0, 0)
        r.run(4000)
        assertEquals(BiketrisPhase.GameOver, r.game.phase)
        assertEquals(BiketrisHold.GameOver, r.session.hold)
        assertFalse(r.session.touchSession)
        r.session.noteTouchIntent()
        r.tick()
        assertFalse(r.session.touchSession, "a touch cannot revive a finished game")
    }

    @Test
    fun modeExitEndsTouchPlayButARenderStallDoesNot() {
        val r = Rig()
        r.faceOn = false
        r.camera = CameraState.Unavailable
        tapBoard(r)
        r.run(500)
        r.session.pause(endTouchSession = false)
        assertEquals(BiketrisHold.None, r.tick(), "touch play survives a render stall")
        r.session.pause()
        assertFalse(r.session.touchSession)
        assertEquals(BiketrisHold.CameraUnavailable, r.tick(), "leaving the mode ends touch play")
        r.session.noteTouchIntent()
        assertEquals(BiketrisHold.None, r.tick())
    }

    @Test
    fun aWaveRotatesClockwiseExactlyOnce() {
        val r = Rig()
        r.goLive()
        val rotation = r.game.rotation
        r.gestures.publish(r.gestures.generation(), r.nanos)
        r.run(500)
        assertEquals((rotation + 1) and 3, r.game.rotation)
        assertEquals(1, r.session.waveRotations)
        r.gestures.publish(r.gestures.generation(), r.nanos)
        r.run(200)
        assertEquals((rotation + 2) and 3, r.game.rotation)
        assertEquals(2, r.session.waveRotations)
    }

    @Test
    fun wavesWhileHeldOrStaleAreDiscardedAndNeverReplayed() {
        val r = Rig()
        r.goLive()
        r.faceOn = false
        r.run(800)
        val rotation = r.game.rotation
        r.gestures.publish(r.gestures.generation(), r.nanos)
        r.tick()
        assertEquals(1, r.session.discardedWaves)
        r.faceOn = true
        r.run(800)
        assertTrue(r.session.live)
        assertEquals(rotation, r.game.rotation, "a wave made while held is not applied later")
        r.gestures.publish(r.gestures.generation(), r.nanos - 500_000_000L)
        r.tick()
        assertEquals(2, r.session.discardedWaves, "older than the observation window")
        assertEquals(rotation, r.game.rotation)
    }

    @Test
    fun aQueuedWaveNeverRotatesARestartedGame() {
        val r = Rig()
        r.goLive()
        r.gestures.publish(r.gestures.generation(), r.nanos)
        r.session.restart(99L)
        val fresh = BiketrisGame(seed = 99L)
        r.run(800)
        assertEquals(0, r.session.waveRotations)
        assertEquals(fresh.piece, r.game.piece)
        assertEquals(0, r.game.rotation)
    }

    @Test
    fun pauseAbsorbsAPendingWave() {
        val r = Rig()
        r.goLive()
        r.gestures.publish(r.gestures.generation(), r.nanos)
        r.session.pause()
        r.run(800)
        assertEquals(0, r.session.waveRotations)
        assertEquals(0, r.game.rotation)
    }

    @Test
    fun pedalToSlowIsTheOnlyCadenceRewardAndCanBeDisabled() {
        val r = Rig()
        r.goLive()
        r.bike = true
        r.rpm = 100
        r.run(4000)
        assertTrue(r.session.cadence.enabled, "Pedal to Slow Mode defaults to on")
        assertEquals(0.525f, r.game.effectiveGravitySeconds, 0.02f)
        val previousProgress = r.game.fallProgress
        val previousPieces = r.game.piecesSpawned
        r.session.cadence.enabled = false
        r.tick()
        assertTrue(r.game.effectiveGravitySeconds > 0.42f, "switching off eases back to normal speed")
        r.run(3000)
        assertEquals(0.42f, r.game.effectiveGravitySeconds, 0.02f, "off ignores RPM")
        assertTrue(r.game.piecesSpawned >= previousPieces, "mode change never restarts a board")
        r.session.cadence.enabled = true
        r.run(3000)
        assertEquals(0.525f, r.game.effectiveGravitySeconds, 0.02f, "on restores pedal-based slowdown")
        assertTrue(previousProgress >= 0f)
    }

    @Test
    fun singlePedalModePreferenceMigratesAndOverridesLegacyChoice() {
        assertEquals(PedalToSlowPreference.LABEL, "PEDAL TO SLOW MODE")
        assertTrue(PedalToSlowPreference.enabled(false, false, null))
        assertTrue(PedalToSlowPreference.enabled(false, false, "slow"))
        assertFalse(PedalToSlowPreference.enabled(false, true, "speed"))
        assertTrue(PedalToSlowPreference.enabled(true, true, "speed"))
        assertFalse(PedalToSlowPreference.enabled(true, false, "slow"))
        val toggle = CadenceToggleLayout()
        toggle.set(12f, 20f, 140f, 52f)
        assertTrue(toggle.visible)
        assertTrue(toggle.hit(12f, 20f))
        assertTrue(toggle.hit(151f, 71f))
        assertFalse(toggle.hit(152f, 50f))
        assertFalse(toggle.hit(100f, 72f))
        toggle.set(0f, 0f, 0f, 52f)
        assertFalse(toggle.visible)
    }

    @Test
    fun theGameKeepsFallingWithZeroRpmAndWithoutTelemetry() {
        val r = Rig()
        r.goLive()
        r.bike = true
        r.rpm = 0
        val y0 = r.game.pieceY
        r.run(4000)
        assertTrue(r.session.cadence.live, "zero rpm is a valid sample")
        assertEquals(0.315f, r.game.effectiveGravitySeconds, 0.02f, "without pedaling the pieces fall faster")
        assertTrue(r.game.pieceY > y0 || r.game.piecesSpawned > 1)
        r.bike = false
        r.run(6000)
        assertEquals(CadenceStatus.NoTelemetry, r.session.cadence.status)
        assertEquals(0.42f, r.game.effectiveGravitySeconds, 0.02f, "missing telemetry returns to normal baseline")
        assertTrue(r.session.live, "telemetry never holds the game")
    }

    @Test
    fun eventEdgeRules() {
        val edge = WaveEventEdge(350_000_000L)
        val first = WaveEvent(5L, 1_000L, false)
        assertEquals(WaveOutcome.None, edge.update(first, 2_000L, true, 0L), "first read after invalidate only records")
        assertEquals(WaveOutcome.None, edge.update(first, 3_000L, true, 0L))
        val second = WaveEvent(6L, 4_000L, false)
        assertEquals(WaveOutcome.Accepted, edge.update(second, 5_000L, true, 0L))
        assertEquals(WaveOutcome.None, edge.update(second, 6_000L, true, 0L), "consumed once")
        assertEquals(WaveOutcome.Discarded, edge.update(WaveEvent(7L, 7_000L, false), 8_000L, false, 0L), "not live")
        assertEquals(WaveOutcome.Discarded, edge.update(WaveEvent(8L, 9_000L, false), 10_000L, true, 9_500L), "before the current piece spawned")
        assertEquals(WaveOutcome.Discarded, edge.update(WaveEvent(9L, 0L, false), 400_000_000L, true, 0L), "expired")
        assertEquals(WaveOutcome.None, edge.update(null, 500_000_000L, true, 0L), "camera stop cleared the event")
        assertEquals(WaveOutcome.Accepted, edge.update(WaveEvent(10L, 500_000_000L, false), 510_000_000L, true, 0L))
        edge.invalidate()
        assertEquals(WaveOutcome.None, edge.update(WaveEvent(11L, 600_000_000L, false), 610_000_000L, true, 0L))
    }

    @Test
    fun aWaveFromBeforeAPieceSpawnedDoesNotRotateTheNewPiece() {
        val r = Rig()
        r.goLive()
        r.game.loadRowsForTest(listOf(".........."))
        r.game.placeForTest(BlockPiece.O, 0, 4, r.game.rows - 2)
        val pieces = r.game.piecesSpawned
        var before = r.nanos
        while (r.game.piecesSpawned == pieces) {
            before = r.nanos
            r.tick()
        }
        val eventAt = before + 20_000_000L
        assertTrue(r.nanos - eventAt < 350_000_000L, "young enough to pass the age check")
        r.gestures.publish(r.gestures.generation(), eventAt)
        r.tick()
        assertEquals(0, r.session.waveRotations)
        assertEquals(1, r.session.discardedWaves)
    }

    @Test
    fun aLongStallDoesNotJumpTheGame() {
        val r = Rig()
        r.goLive()
        val y = r.game.pieceY
        r.tick(30_000L)
        assertTrue(r.game.pieceY - y <= 1, "bounded frame after a stall")
        r.session.pause()
        r.tick()
        assertEquals(BiketrisHold.Resuming, r.session.hold, "after a pause the face must be stable again")
    }

    @Test
    fun restartsAreDeterministic() {
        val a = Rig()
        val b = Rig()
        a.session.restart(1234L)
        b.session.restart(1234L)
        assertEquals(a.game.piece, b.game.piece)
        assertEquals(a.game.next, b.game.next)
        assertFalse(a.session.live)
    }
}
