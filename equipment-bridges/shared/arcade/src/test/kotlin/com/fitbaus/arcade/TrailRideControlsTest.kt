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

    @Test
    fun supervisorHoldsForEveryMissingController() {
        val sup = TrailRideSupervisor()
        val tracking = steerReading(FaceControlState.Tracking)
        val cruising = reading(CadenceState.Cruising)
        assertEquals(TrailHold.GameOver, sup.hold(true, CameraState.Ready, tracking, cruising))
        assertEquals(TrailHold.CameraUnavailable, sup.hold(false, CameraState.Unavailable, tracking, cruising))
        assertEquals(TrailHold.CameraUnavailable, sup.hold(false, CameraState.PermissionDenied, tracking, cruising))
        assertEquals(TrailHold.CameraStarting, sup.hold(false, CameraState.Starting, tracking, cruising))
        assertEquals(TrailHold.FaceLost, sup.hold(false, CameraState.Ready, steerReading(FaceControlState.Lost), cruising))
        assertEquals(TrailHold.Calibrating, sup.hold(false, CameraState.Ready, steerReading(FaceControlState.Calibrating), cruising))
        assertEquals(TrailHold.NoTelemetry, sup.hold(false, CameraState.Ready, tracking, reading(CadenceState.NoTelemetry)))
        assertEquals(TrailHold.NoTelemetry, sup.hold(false, CameraState.Ready, tracking, reading(CadenceState.Stale)))
        assertEquals(TrailHold.NotPedaling, sup.hold(false, CameraState.Ready, tracking, reading(CadenceState.Stopped)))
        assertEquals("PEDAL TO RIDE", sup.message(TrailHold.NotPedaling, reading(CadenceState.Stopped)))
        assertEquals(TrailHold.LearningPace, sup.hold(false, CameraState.Ready, tracking, reading(CadenceState.Establishing)))
        assertEquals(TrailHold.Resuming, sup.hold(false, CameraState.Ready, steerReading(FaceControlState.Tracking, stableMs = 200), cruising))
        assertEquals(TrailHold.None, sup.hold(false, CameraState.Ready, tracking, cruising))
        assertEquals(TrailHold.None, sup.hold(false, CameraState.Ready, steerReading(FaceControlState.Tracking, stableMs = 200), reading(CadenceState.Boosting)), "once running, stays running")
        sup.invalidate()
        assertEquals(TrailHold.Resuming, sup.hold(false, CameraState.Ready, steerReading(FaceControlState.Tracking, stableMs = 200), cruising))
        assertTrue(sup.message(TrailHold.NoTelemetry, reading(CadenceState.Stale))!!.contains("STALE"))
        assertEquals(null, sup.message(TrailHold.None, cruising))
    }

    @Test
    fun activationEdgeFiresOncePerNewSurgeAndOnlyWhileLive() {
        val edge = BoostActivationEdge()
        assertFalse(edge.update(reading(CadenceState.Cruising, 3), live = true), "first reading only syncs")
        assertTrue(edge.update(reading(CadenceState.Boosting, 4), live = true))
        assertFalse(edge.update(reading(CadenceState.Boosting, 4), live = true), "the same surge never fires twice")
        assertFalse(edge.update(reading(CadenceState.Boosting, 5), live = false), "a surge while held is absorbed")
        assertFalse(edge.update(reading(CadenceState.Cruising, 5), live = true), "and not replayed later")
        edge.invalidate()
        assertFalse(edge.update(reading(CadenceState.Boosting, 9), live = true), "after invalidate the counter resyncs")
        assertTrue(edge.update(reading(CadenceState.Boosting, 10), live = true))
    }

    @Test
    fun theRideWaitsForCalibrationAndAPaceBaseline() {
        val d = SessionDriver(TrailRideSession(TrailRideGame(TrailRideConfig(world = TrailWorlds.straight()), 3L)))
        d.run(0.5f)
        assertEquals(TrailHold.Calibrating, d.session.hold)
        d.run(1f)
        assertEquals(TrailHold.LearningPace, d.session.hold, "no riding before the jump detector knows the rider's pace")
        assertEquals(0f, d.game.distance)
        d.untilRiding()
        assertTrue(d.game.elapsed >= d.game.config.readySeconds, "countdown before the world moves")
    }

    @Test
    fun stationaryPedalsFreezeTheWorld() {
        val d = steadySession()
        val distance = d.game.distance
        val elapsed = d.game.elapsed
        d.rpm = 0
        d.run(4f)
        assertEquals(TrailHold.NotPedaling, d.session.hold)
        assertEquals("PEDAL TO RIDE", d.session.message())
        assertTrue(d.game.distance - distance < 1.5f, "at most the frames before the zero sample (${d.game.distance - distance} m)")
        val frozen = d.game.distance
        d.run(3f)
        assertEquals(frozen, d.game.distance)
        assertTrue(d.game.elapsed - elapsed < 0.5f)
        d.rpm = 70
        d.run(2f)
        assertTrue(d.game.distance > frozen + 5f, "pedaling again resumes the ride")
    }

    @Test
    fun missingOrStaleTelemetryFreezesTheWorld() {
        val d = steadySession()
        d.connected = false
        d.frame()
        assertEquals(TrailHold.NoTelemetry, d.session.hold)
        val at = d.game.distance
        d.run(2f)
        assertEquals(at, d.game.distance)
        d.connected = true
        d.run(1f)
        val moving = d.game.distance
        d.telemetryFrozen = true
        d.run(3f)
        assertEquals(TrailHold.NoTelemetry, d.session.hold)
        assertEquals(CadenceState.Stale, d.session.cadenceReading.state)
        val frozen = d.game.distance
        assertTrue(frozen - moving < 20f, "stale data stops the ride within the 2 s freshness limit")
        d.run(2f)
        assertEquals(frozen, d.game.distance)
    }

    @Test
    fun cameraOrFaceLossHoldsHazardsAndTimers() {
        val d = steadySession(TrailRideConfig(world = TrailWorlds.straight(obstacles = true)))
        d.face = HandSource.Lost
        d.frame()
        assertEquals(TrailHold.FaceLost, d.session.hold)
        val distance = d.game.distance
        val elapsed = d.game.elapsed
        val resolved = d.game.world.obstacles.map { it.resolved }
        d.run(5f)
        assertEquals(distance, d.game.distance)
        assertEquals(elapsed, d.game.elapsed)
        assertEquals(resolved, d.game.world.obstacles.map { it.resolved })
        d.face = HandSource.Camera
        d.camera = CameraState.Unavailable
        d.run(2f)
        assertEquals(TrailHold.CameraUnavailable, d.session.hold)
        assertEquals(distance, d.game.distance)
    }

    @Test
    fun reacquiringTheFaceNeedsAShortStableInterval() {
        val d = steadySession()
        d.face = HandSource.Lost
        d.run(1f)
        d.face = HandSource.Camera
        d.frame()
        assertEquals(TrailHold.Resuming, d.session.hold)
        val at = d.game.distance
        d.run(0.4f)
        assertEquals(TrailHold.Resuming, d.session.hold)
        assertEquals(at, d.game.distance)
        d.run(0.4f)
        assertEquals(TrailHold.None, d.session.hold)
    }

    @Test
    fun repeatedTelemetrySamplesCannotCreateASurge() {
        val d = steadySession()
        d.telemetryFrozen = true
        d.rpm = 95
        d.run(1.5f)
        assertEquals(0, d.session.cadenceReading.activations)
        assertEquals(0, d.session.jumpRequests)
    }

    @Test
    fun oneNoisySpikeCannotJump() {
        val d = steadySession()
        d.rpm = 100
        d.run(0.25f)
        d.rpm = 70
        d.run(3f)
        assertEquals(0, d.session.cadenceReading.activations)
        assertEquals(0, d.session.jumpRequests)
        assertFalse(d.game.airborne)
    }

    @Test
    fun holdingAHighCadenceJumpsOnlyOnce() {
        val d = steadySession()
        d.rpm = 90
        d.run(10f)
        assertEquals(1, d.session.jumpRequests, "held cadence cannot retrigger")
        d.rpm = 70
        d.run(2f)
        d.rpm = 90
        d.run(2f)
        assertEquals(2, d.session.jumpRequests, "a genuine drop rearms the next surge")
    }

    @Test
    fun aSurgeDuringAHoldIsNeverReplayed() {
        val d = steadySession()
        d.face = HandSource.Lost
        d.rpm = 90
        d.run(2f)
        assertEquals(1, d.session.cadenceReading.activations, "the detector saw the surge")
        d.face = HandSource.Camera
        d.run(3f)
        assertEquals(TrailHold.None, d.session.hold)
        assertEquals(0, d.session.jumpRequests, "but it was held, so no jump")
        assertFalse(d.game.airborne)
    }

    @Test
    fun hostPauseForgetsTransientInput() {
        val d = steadySession()
        d.session.pause()
        d.rpm = 90
        d.frame()
        assertEquals(TrailHold.Resuming, d.session.hold, "after a pause the face must be stable again")
        d.run(1.2f)
        val surgesBefore = d.session.jumpRequests
        d.session.pause()
        d.run(0.3f)
        assertEquals(surgesBefore, d.session.jumpRequests, "a surge confirmed around the pause is not replayed")
    }

    @Test
    fun telemetryDropoutDoesNotReuseAnOldSurge() {
        val d = steadySession()
        d.rpm = 90
        d.run(1.2f)
        assertEquals(1, d.session.jumpRequests)
        d.telemetryFrozen = true
        d.run(3f)
        assertEquals(TrailHold.NoTelemetry, d.session.hold)
        d.telemetryFrozen = false
        d.run(3f)
        assertEquals(1, d.session.jumpRequests, "the old surge stays used; holding high after a dropout does not jump again")
    }
}
