// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.abs

public enum class GhoulRunInputSource { Webcam, Controller, Both }

public data class GhoulRunControllerInput(
    val leftPressed: Boolean = false,
    val rightPressed: Boolean = false,
    val stickX: Float = 0f,
)

internal object GhoulRunInputSelection {
    const val PREF_KEY = "ghoul_run_input_source"

    fun effective(saved: String?, controllerAvailable: Boolean): GhoulRunInputSource = when {
        !controllerAvailable || saved == GhoulRunInputSource.Webcam.name -> GhoulRunInputSource.Webcam
        saved == GhoulRunInputSource.Both.name -> GhoulRunInputSource.Both
        else -> GhoulRunInputSource.Controller
    }
}

internal enum class GhoulHold { None, CameraStarting, CameraUnavailable, FaceLost, Calibrating, NoTelemetry, LearningPace, Resuming }

internal class GhoulRunSupervisor(private val resumeStableMs: Long = 600L) {
    private var running = false

    fun invalidate() { running = false }

    fun hold(
        camera: CameraState,
        steer: SteerReading,
        cadence: CadenceReading,
        source: GhoulRunInputSource,
        controllerAvailable: Boolean,
    ): GhoulHold {
        val controllerCanDrive = controllerAvailable && source != GhoulRunInputSource.Webcam
        val needsFace = source != GhoulRunInputSource.Controller && !controllerCanDrive
        val hold = when {
            needsFace && (camera == CameraState.Unavailable || camera == CameraState.PermissionDenied) -> GhoulHold.CameraUnavailable
            needsFace && camera != CameraState.Ready -> GhoulHold.CameraStarting
            needsFace && steer.state == FaceControlState.Lost -> GhoulHold.FaceLost
            needsFace && steer.state == FaceControlState.Calibrating -> GhoulHold.Calibrating
            cadence.state == CadenceState.NoTelemetry || cadence.state == CadenceState.Stale -> GhoulHold.NoTelemetry
            cadence.state == CadenceState.Establishing -> GhoulHold.LearningPace
            needsFace && !running && steer.stableMs < resumeStableMs -> GhoulHold.Resuming
            else -> GhoulHold.None
        }
        running = hold == GhoulHold.None
        return hold
    }

    fun message(hold: GhoulHold, cadence: CadenceReading): String? = when (hold) {
        GhoulHold.None -> null
        GhoulHold.CameraStarting -> "STARTING CAMERA..."
        GhoulHold.CameraUnavailable -> "CAMERA UNAVAILABLE - SELECT CONTROLLER"
        GhoulHold.FaceLost -> "FACE LOST - LOOK AT THE SCREEN"
        GhoulHold.Calibrating -> "LOOK STRAIGHT AHEAD - CENTERING"
        GhoulHold.NoTelemetry -> if (cadence.state == CadenceState.Stale) "BIKE DATA STALE - WAITING FOR RPM" else "NO BIKE DATA - WAITING FOR RPM"
        GhoulHold.LearningPace -> "KEEP PEDALING - LEARNING YOUR PACE"
        GhoulHold.Resuming -> "GET READY..."
    }
}

/** Pure input/session bridge: fresh telemetry and selected steering source gate the fixed-step game. */
internal class GhoulRunSession(
    val game: GhoulRunGame,
    val steering: HorizontalFaceSteering = HorizontalFaceSteering(),
    val cadence: CadenceBoost = CadenceBoost(CadenceConfig(deltaRpm = game.config.sprintDelta.toInt())),
    private val supervisor: GhoulRunSupervisor = GhoulRunSupervisor(),
) {
    private val headLanes = HeadColumnMapper(gain = 1f, hysteresis = game.config.laneHysteresis)
    private val stickLanes = HeadColumnMapper(gain = 1f, hysteresis = game.config.laneHysteresis)
    var hold: GhoulHold = GhoulHold.CameraStarting
        private set
    var steer: SteerReading = SteerReading(FaceControlState.Lost, 0.5f, Float.NaN, 0f, -1L, 0L)
        private set
    var cadenceReading: CadenceReading = CadenceReading(CadenceState.NoTelemetry, null, -1L, Float.NaN, Float.NaN, 0L, 0, false)
        private set
    var lane: GhoulLane = GhoulLane.Center
        private set
    var lastSteps: Int = 0
        private set

    val live: Boolean get() = hold == GhoulHold.None

    fun update(
        position: HandPosition,
        camera: CameraState,
        connected: Boolean,
        initialized: Boolean,
        rpm: Int?,
        rpmCurrent: Boolean,
        rpmObservedAt: String?,
        nowNanos: Long,
        source: GhoulRunInputSource = GhoulRunInputSource.Webcam,
        controllerAvailable: Boolean = false,
        controller: GhoulRunControllerInput? = null,
        simulated: Boolean = false,
    ): GhoulHold {
        steer = steering.update(position, nowNanos)
        cadenceReading = cadence.update(connected, initialized, rpm, rpmCurrent, rpmObservedAt, nowNanos, simulated)
        hold = supervisor.hold(camera, steer, cadenceReading, source, controllerAvailable)
        if (!live) {
            game.resetClock()
            lastSteps = 0
            return hold
        }
        val useController = controller != null && source != GhoulRunInputSource.Webcam
        if (useController && controller.leftPressed != controller.rightPressed) {
            lane = GhoulLane.entries[(lane.ordinal + if (controller.leftPressed) -1 else 1).coerceIn(0, 2)]
            stickLanes.reset()
        } else if (useController && abs(controller.stickX) > 0.08f) {
            lane = GhoulLane.entries[stickLanes.map((controller.stickX.coerceIn(-1f, 1f) + 1f) / 2f, 2)]
        } else if (source != GhoulRunInputSource.Controller && steer.state == FaceControlState.Tracking) {
            lane = GhoulLane.entries[headLanes.map((steer.steer + 1f) / 2f, 2)]
        }
        val lean = when {
            useController && abs(controller.stickX) > abs(steer.steer) -> controller.stickX
            source == GhoulRunInputSource.Controller -> controller?.stickX ?: 0f
            else -> steer.steer
        }
        lastSteps = game.advance(
            nowNanos,
            lane,
            lean,
            (cadenceReading.rpm ?: 0).toFloat(),
            cadenceReading.baseline,
        )
        return hold
    }

    fun message(): String? = supervisor.message(hold, cadenceReading)

    fun pause() {
        game.resetClock()
        steering.invalidate()
        supervisor.invalidate()
        headLanes.reset()
        stickLanes.reset()
    }

    fun restart(seed: Long) {
        game.restart(seed)
        steering.recalibrate()
        cadence.reset()
        supervisor.invalidate()
        headLanes.reset()
        stickLanes.reset()
        lane = GhoulLane.Center
    }

    fun recenter() {
        steering.recalibrate()
        supervisor.invalidate()
        headLanes.reset()
    }
}
