// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TrailRideControlsTest {
    private val ms = 1_000_000L

    private fun face(x: Float, atMs: Long, source: HandSource = HandSource.Camera) = HandPosition(x, 0.5f, 0.9f, atMs * ms, source)

    private fun calibrated(neutral: Float = 0.5f, gain: Float = 4f): Pair<HorizontalFaceSteering, Long> {
        val s = HorizontalFaceSteering()
        s.setGain(gain)
        var t = 0L
        while (!s.calibrated) {
            s.update(face(neutral, t), t * ms)
            t += 100
        }
        return s to t
    }

    private fun reading(state: CadenceState, activations: Int = 0) = CadenceReading(state, 70, 100, 70f, 82f, 0, activations, false)

    private fun steerReading(state: FaceControlState, stableMs: Long = 5000) = SteerReading(state, 0.5f, 0.5f, 0f, 30, stableMs)

    private fun steadySession(config: TrailRideConfig = TrailRideConfig(world = TrailWorlds.straight(firstDitch = TrailWorlds.NEVER))): SessionDriver {
        val d = SessionDriver(TrailRideSession(TrailRideGame(config, 3L)))
        d.untilRiding()
        d.run(2f)
        return d
    }

    @Test
    fun calibrationNeedsOneSecondOfFreshTracking() {
        val s = HorizontalFaceSteering()
        for (t in 0L..900L step 100) assertEquals(FaceControlState.Calibrating, s.update(face(0.46f, t), t * ms).state)
        val done = s.update(face(0.46f, 1000), 1000 * ms)
        assertEquals(FaceControlState.Tracking, done.state)
        assertEquals(0.46f, done.neutralX, 1e-4f)
        assertEquals(0f, done.steer, 1e-6f, "neutral head = straight ahead")
    }

    @Test
    fun headToThePlayersLeftSteersLeftLikeBricks() {
        val (s, t) = calibrated(0.5f)
        val left = s.update(face(0.4f, t), t * ms).steer
        val right = s.update(face(0.6f, t + 100), (t + 100) * ms).steer
        assertTrue(left < 0f, "mirrored x below neutral is the player's left (Bricks moves the paddle left there)")
        assertTrue(right > 0f)
        assertEquals(-left, right, 1e-5f)
        val g = TrailWorlds.riding(TrailRideConfig(world = TrailWorlds.straight(firstDitch = TrailWorlds.NEVER)))
        TrailPilots.run(g, 1f, steer = { left })
        assertTrue(g.riderX < -0.5f, "the rider moves left in the world (${g.riderX})")
        assertTrue(TrailProjection().screenX(g.riderX, 3f) < 128f, "and world-left is screen-left")
    }

    @Test
    fun deadZoneGainAndClamping() {
        val (s, t) = calibrated(0.5f, gain = 4f)
        assertEquals(0f, s.update(face(0.51f, t), t * ms).steer, 1e-6f, "small jitter inside the dead zone")
        assertEquals((0.05f - 0.012f) * 4f, s.update(face(0.55f, t + 100), (t + 100) * ms).steer, 1e-5f)
        s.setGain(7f)
        assertEquals((0.05f - 0.012f) * 7f, s.update(face(0.55f, t + 200), (t + 200) * ms).steer, 1e-5f, "sensitivity scales the response")
        assertEquals(1f, s.update(face(0.95f, t + 300), (t + 300) * ms).steer)
        assertEquals(-1f, s.update(face(0.05f, t + 400), (t + 400) * ms).steer)
        assertTrue(s.update(face(0.62f, t + 500), (t + 500) * ms).steer > 0.6f, "a modest head move (~0.12 of the control range) is a big steer")
    }

    @Test
    fun staleOrLostFacesNeverSteer() {
        val (s, t) = calibrated(0.5f)
        val stale = s.update(face(0.2f, t), (t + 500) * ms)
        assertEquals(FaceControlState.Lost, stale.state)
        assertEquals(0f, stale.steer)
        assertEquals(FaceControlState.Lost, s.update(face(0.2f, t + 600, HandSource.Touch), (t + 600) * ms).state, "touch is not a face")
        assertEquals(FaceControlState.Lost, s.update(face(0.2f, t + 700, HandSource.Lost), (t + 700) * ms).state)
        assertTrue(s.calibrated, "a loss after calibration keeps the neutral")
        val back = s.update(face(0.5f, t + 800), (t + 800) * ms)
        assertEquals(FaceControlState.Tracking, back.state)
        assertEquals(0L, back.stableMs, "the stable interval restarts after a loss")
    }

    @Test
    fun recalibrateCentresOnTheCurrentHead() {
        val (s, t0) = calibrated(0.5f)
        s.recalibrate()
        var t = t0
        while (!s.calibrated) {
            s.update(face(0.4f, t), t * ms)
            t += 100
        }
        assertEquals(0f, s.update(face(0.4f, t), t * ms).steer, 1e-6f)
    }

    private fun riseAndLoseFace(d: SessionDriver) {
        d.face = HandSource.Camera
        d.faceY = 0.62f
        d.run(0.5f)
        for (y in floatArrayOf(0.60f, 0.57f, 0.54f, 0.50f, 0.46f)) {
            d.faceY = y
            d.frame()
        }
        d.face = HandSource.Lost
        d.frame()
    }

    @Test
    fun onlyBikeTelemetryCanHoldTheRide() {
        val sup = TrailRideSupervisor()
        val live = reading(CadenceState.Cruising)
        assertEquals(TrailHold.None, sup.hold(live))
        assertEquals(TrailHold.None, sup.hold(reading(CadenceState.Establishing)))
        assertEquals(TrailHold.None, sup.hold(reading(CadenceState.Boosting)))
        assertEquals(TrailHold.None, sup.hold(reading(CadenceState.Recovering)))
        assertEquals(TrailHold.NoTelemetry, sup.hold(reading(CadenceState.NoTelemetry)))
        assertEquals(TrailHold.NoTelemetry, sup.hold(reading(CadenceState.Stale)))
        assertEquals(TrailHold.NotPedaling, sup.hold(reading(CadenceState.Stopped)))
        assertEquals("PEDAL TO RIDE", sup.message(TrailHold.NotPedaling, live))
        assertEquals(null, sup.message(TrailHold.None, live))
    }

    @Test
    fun trailRideStartsWithoutFaceCalibrationOrCadenceBaseline() {
        val d = SessionDriver(TrailRideSession(TrailRideGame(
            TrailRideConfig(world = TrailWorlds.straight(firstDitch = TrailWorlds.NEVER)), 3L,
        )))
        d.face = HandSource.Lost
        d.camera = CameraState.Unavailable
        d.frame()
        assertEquals(TrailHold.None, d.session.hold)
        assertEquals(CadenceState.Establishing, d.session.cadenceReading.state)
        d.untilRiding()
        d.run(1f)
        assertTrue(d.game.distance > 2f)
        assertEquals(TrailHold.None, d.session.hold)
        assertEquals(0, d.session.jumpRequests)
    }

    @Test
    fun trackingLossAndCameraFailureNeverFreezeTheWorld() {
        val d = steadySession()
        d.faceX = 0.62f
        d.frame()
        val oldDirection = d.session.steer.steer
        val distance = d.game.distance
        d.face = HandSource.Lost
        d.run(2f)
        assertEquals(TrailHold.None, d.session.hold)
        assertTrue(d.game.distance > distance + 8f)
        assertEquals(oldDirection, d.game.targetX / d.game.config.steerRange, 0.0001f)
        d.camera = CameraState.Unavailable
        val moving = d.game.distance
        d.run(1f)
        assertTrue(d.game.distance > moving + 3f)
        assertEquals(TrailHold.None, d.session.hold)
        assertEquals(0, d.session.jumpRequests)
    }

    @Test
    fun stableUpwardFaceExitCausesExactlyOneJumpAndDoesNotPause() {
        val d = steadySession()
        d.faceY = 0.62f
        d.run(0.5f)
        for (y in floatArrayOf(0.60f, 0.57f, 0.54f, 0.50f, 0.46f)) {
            d.faceY = y
            d.frame()
        }
        assertEquals(0, d.session.jumpRequests)
        assertTrue(d.session.standing.armed)
        d.face = HandSource.Lost
        d.frame()
        assertEquals(1, d.session.jumpRequests)
        assertEquals(1, d.session.standing.jumps)
        assertEquals("stand jump", d.session.standing.lastEvent)
        assertTrue(d.game.airborne)
        assertEquals(TrailHold.None, d.session.hold)
        val distance = d.game.distance
        d.run(2f)
        assertEquals(1, d.session.jumpRequests)
        assertTrue(d.game.distance > distance + 8f)
    }

    @Test
    fun sittingDownAndReacquiringTrackingRearmsAnotherJump() {
        val d = steadySession()
        riseAndLoseFace(d)
        assertEquals(1, d.session.jumpRequests)
        d.face = HandSource.Camera
        d.faceY = 0.62f
        d.run(0.6f)
        assertTrue(d.session.standing.armed)
        d.run(0.4f)
        riseAndLoseFace(d)
        assertEquals(2, d.session.jumpRequests)
        assertEquals(2, d.session.standing.jumps)
    }

    @Test
    fun smallFaceMovementOrLossWithoutUpwardExitDoesNotJump() {
        val d = steadySession()
        d.faceY = 0.50f
        d.run(0.5f)
        d.faceY = 0.47f
        d.frame()
        d.face = HandSource.Lost
        d.run(2f)
        assertEquals(0, d.session.jumpRequests)
        assertEquals(0, d.session.standing.jumps)
        assertTrue(d.session.live)
        assertEquals("face lost without upward movement", d.session.standing.lastEvent)
    }

    @Test
    fun movingDownwardBeforeFaceLossCancelsAStandCandidate() {
        val d = steadySession()
        d.faceY = 0.62f
        d.run(0.5f)
        for (y in floatArrayOf(0.58f, 0.54f, 0.49f, 0.45f)) {
            d.faceY = y
            d.frame()
        }
        d.faceY = 0.55f
        d.frame()
        d.face = HandSource.Lost
        d.frame()
        assertEquals(0, d.session.jumpRequests)
        assertEquals(TrailHold.None, d.session.hold)
    }

    @Test
    fun unpluggedOrUnreadyCameraCannotTriggerAJumpButRideContinues() {
        val d = steadySession()
        d.faceY = 0.62f
        d.run(0.5f)
        for (y in floatArrayOf(0.57f, 0.52f, 0.46f)) {
            d.faceY = y
            d.frame()
        }
        d.face = HandSource.Lost
        d.camera = CameraState.Unavailable
        d.frame()
        assertEquals(0, d.session.jumpRequests)
        assertEquals(TrailHold.None, d.session.hold)
        d.run(1f)
        assertTrue(d.session.live)
    }

    @Test
    fun speedChangeAloneDoesNotInitiateAnyJump() {
        val d = steadySession()
        d.rpm = 100
        d.run(4f)
        assertEquals(0, d.session.jumpRequests)
        assertEquals(0, d.session.standing.jumps)
        assertFalse(d.game.airborne)
    }

    @Test
    fun missingOrStaleTelemetryStillStopsTheWorld() {
        val d = steadySession()
        d.connected = false
        d.frame()
        assertEquals(TrailHold.NoTelemetry, d.session.hold)
        val distance = d.game.distance
        d.run(2f)
        assertEquals(distance, d.game.distance)
        d.connected = true
        d.run(1f)
        assertTrue(d.game.distance > distance)
        d.telemetryFrozen = true
        d.run(3f)
        assertEquals(TrailHold.NoTelemetry, d.session.hold)
        assertEquals(CadenceState.Stale, d.session.cadenceReading.state)
        val frozen = d.game.distance
        d.run(2f)
        assertEquals(frozen, d.game.distance)
    }

    @Test
    fun standingWhileStoppedOrWithoutBikeDataCannotQueueAJump() {
        val d = steadySession()
        d.rpm = 0
        d.run(1f)
        assertEquals(TrailHold.NotPedaling, d.session.hold)
        val distance = d.game.distance
        riseAndLoseFace(d)
        assertEquals(0, d.session.jumpRequests)
        assertEquals(distance, d.game.distance)
        d.rpm = 70
        d.run(2f)
        assertEquals(0, d.session.jumpRequests)
    }

    @Test
    fun pauseAndRestartDiscardPartialStandingGestures() {
        val d = steadySession()
        d.faceY = 0.62f
        d.run(0.5f)
        for (y in floatArrayOf(0.58f, 0.54f, 0.49f, 0.45f)) {
            d.faceY = y
            d.frame()
        }
        d.session.pause()
        d.face = HandSource.Lost
        d.frame()
        assertEquals(0, d.session.jumpRequests)
        d.session.restart(6L)
        d.frame()
        assertEquals(0, d.session.jumpRequests)
        assertFalse(d.session.standing.armed)
    }

    @Test
    fun duplicateAndStaleFaceSamplesDoNotCreateUpwardMotion() {
        val detector = StandJumpDetector()
        val msNanos = 1_000_000L
        val start = 1_000_000_000L
        repeat(12) { i ->
            val at = start + i * 50 * msNanos
            detector.update(HandPosition(0.5f, 0.55f, 0.9f, at, HandSource.Camera), CameraState.Ready, at, true)
        }
        assertTrue(detector.armed)
        val repeated = start + 550 * msNanos
        repeat(12) { i ->
            detector.update(
                HandPosition(0.5f, 0.40f, 0.9f, repeated, HandSource.Camera),
                CameraState.Ready, repeated + i * 10 * msNanos, true,
            )
        }
        assertFalse(detector.update(
            HandPosition(0.5f, 0.40f, 0f, repeated + 600 * msNanos, HandSource.Lost),
            CameraState.Ready, repeated + 600 * msNanos, true,
        ))
        assertEquals(0, detector.jumps)
    }
    @Test
    fun faceRisingAndLeavingFrameTriggersWithoutFinalStepThreshold() {
        val detector = StandJumpDetector()
        val base = 1_000_000_000L
        val msNanos = 1_000_000L
        val ys = floatArrayOf(0.59f, 0.56f, 0.54f)
        ys.forEachIndexed { index, y ->
            val at = base + index * 85 * msNanos
            assertFalse(detector.update(
                HandPosition(0.5f, y, 0.9f, at, HandSource.Camera),
                CameraState.Ready, at, true,
            ))
        }
        assertTrue(detector.armed)
        assertTrue(detector.lastRise >= 0.04f)
        val lostAt = base + 2 * 85 * msNanos + 550 * msNanos
        assertTrue(detector.update(
            HandPosition(0.5f, 0.54f, 0f, lostAt, HandSource.Lost),
            CameraState.Ready, lostAt, true,
        ))
        assertEquals(1, detector.jumps)
        assertFalse(detector.update(
            HandPosition(0.5f, 0.54f, 0f, lostAt + 100 * msNanos, HandSource.Lost),
            CameraState.Ready, lostAt + 100 * msNanos, true,
        ))
        assertEquals(1, detector.jumps)
    }

    @Test
    fun lookingUpWithoutLosingTrackingIsNotAJump() {
        val d = steadySession()
        d.faceY = 0.60f
        d.run(0.4f)
        for (y in floatArrayOf(0.58f, 0.55f, 0.51f, 0.46f, 0.41f)) {
            d.faceY = y
            d.frame()
        }
        assertTrue(d.session.standing.armed)
        val distance = d.game.distance
        d.run(1f)
        assertEquals(0, d.session.jumpRequests)
        assertFalse(d.game.airborne)
        assertTrue(d.game.distance > distance)
    }

    @Test
    fun lostFaceAfterAnOldUpwardGestureDoesNotJump() {
        val detector = StandJumpDetector()
        val base = 1_000_000_000L
        for ((index, y) in floatArrayOf(0.62f, 0.58f, 0.52f).withIndex()) {
            val at = base + index * 100_000_000L
            detector.update(HandPosition(0.5f, y, 0.9f, at, HandSource.Camera),
                CameraState.Ready, at, true)
        }
        val lostAt = base + 2_000_000_000L
        assertFalse(detector.update(
            HandPosition(0.5f, 0.52f, 0f, lostAt, HandSource.Lost),
            CameraState.Ready, lostAt, true,
        ))
        assertEquals("stale face loss", detector.lastEvent)
    }

}
