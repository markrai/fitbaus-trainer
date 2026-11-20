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

internal data class GhoulCadenceReading(
    val status: CadenceStatus,
    val rawRpm: Int,
    val filteredRpm: Float,
    val baseline: Float,
    val warmupRemaining: Float,
) {
    val calibrated: Boolean get() = baseline.isFinite()
}

/** Absolute-RPM smoothing plus a one-shot median warm-up baseline that never drifts. */
internal class GhoulPace(
    private val gameConfig: GhoulRunConfig,
    val filter: CadenceGravity = CadenceGravity(),
) {
    private val warmupSamples = ArrayDeque<Pair<Long, Float>>()
    private var lastUpdateNanos = Long.MIN_VALUE
    private var warmupElapsed = 0f
    private var pendingWarmupNanos = 0L
    private var pendingSampleNanos = Long.MIN_VALUE

    var baseline: Float = Float.NaN
        private set

    var reading: GhoulCadenceReading = GhoulCadenceReading(
        CadenceStatus.NoTelemetry,
        -1,
        filter.filteredRpm,
        Float.NaN,
        gameConfig.warmupSeconds,
    )
        private set

    fun update(
        connected: Boolean,
        initialized: Boolean,
        rpm: Int?,
        rpmCurrent: Boolean,
        rpmObservedAt: String?,
        nowNanos: Long,
    ): GhoulCadenceReading {
        val dtNanos = if (lastUpdateNanos == Long.MIN_VALUE) 0L else
            (nowNanos - lastUpdateNanos).coerceIn(0L, filter.config.maxStepNanos)
        lastUpdateNanos = nowNanos
        filter.update(connected, initialized, rpm, rpmCurrent, rpmObservedAt, nowNanos)
        pendingWarmupNanos = dtNanos
        pendingSampleNanos = nowNanos
        refreshReading()
        return reading
    }

    /** Commits warm-up time only after the supervisor confirms the game is not held. */
    fun advanceWarmup(): GhoulCadenceReading {
        if (filter.status == CadenceStatus.Live && baseline.isNaN() && pendingSampleNanos != Long.MIN_VALUE) {
            warmupElapsed += pendingWarmupNanos / 1_000_000_000f
            warmupSamples.addLast(pendingSampleNanos to filter.filteredRpm)
            val cutoff = pendingSampleNanos - (gameConfig.baselineWindowSeconds * 1_000_000_000L).toLong()
            while (warmupSamples.firstOrNull()?.first?.let { it < cutoff } == true) warmupSamples.removeFirst()
            if (warmupElapsed >= gameConfig.warmupSeconds && warmupSamples.isNotEmpty()) {
                val values = warmupSamples.map { it.second }.sorted()
                val middle = values.size / 2
                baseline = if (values.size % 2 == 0) (values[middle - 1] + values[middle]) / 2f else values[middle]
            }
        }
        pendingWarmupNanos = 0L
        pendingSampleNanos = Long.MIN_VALUE
        refreshReading()
        return reading
    }

    private fun refreshReading() {
        reading = GhoulCadenceReading(
            filter.status,
            filter.rawRpm,
            filter.filteredRpm,
            baseline,
            (gameConfig.warmupSeconds - warmupElapsed).coerceAtLeast(0f),
        )
    }

    fun pauseClock() {
        lastUpdateNanos = Long.MIN_VALUE
        pendingWarmupNanos = 0L
        pendingSampleNanos = Long.MIN_VALUE
        filter.pauseClock()
    }

    fun recalibrate() {
        filter.reset()
        warmupSamples.clear()
        lastUpdateNanos = Long.MIN_VALUE
        warmupElapsed = 0f
        pendingWarmupNanos = 0L
        pendingSampleNanos = Long.MIN_VALUE
        baseline = Float.NaN
        reading = GhoulCadenceReading(
            CadenceStatus.NoTelemetry,
            -1,
            filter.filteredRpm,
            Float.NaN,
            gameConfig.warmupSeconds,
        )
    }
}

/**
 * Rider-relative lean zones with hysteresis. Steer < 0 is the rider's left (mirrored face x and
 * stick x are already player-relative). A side is entered at |steer| >= [enter] and left again
 * only when |steer| drops below [exit], so tracker jitter at the boundary cannot flicker.
 */
internal class GhoulLeanZones(private val enter: Float, private val exit: Float) {
    var lane: GhoulLane = GhoulLane.Center
        private set

    fun reset() {
        lane = GhoulLane.Center
    }

    fun update(steer: Float): GhoulLane {
        lane = when {
            steer <= -enter -> GhoulLane.Left
            steer >= enter -> GhoulLane.Right
            lane == GhoulLane.Left && steer < -exit -> GhoulLane.Left
            lane == GhoulLane.Right && steer > exit -> GhoulLane.Right
            else -> GhoulLane.Center
        }
        return lane
    }
}

internal enum class GhoulHold { None, CameraStarting, CameraUnavailable, FaceLost, Calibrating, NoTelemetry, Resuming }

internal class GhoulRunSupervisor(private val resumeStableMs: Long = 600L) {
    private var running = false

    fun invalidate() { running = false }

    fun hold(
        camera: CameraState,
        steer: SteerReading,
        cadence: GhoulCadenceReading,
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
            cadence.status == CadenceStatus.NoTelemetry || cadence.status == CadenceStatus.Stale -> GhoulHold.NoTelemetry
            needsFace && !running && steer.stableMs < resumeStableMs -> GhoulHold.Resuming
            else -> GhoulHold.None
        }
        running = hold == GhoulHold.None
        return hold
    }

    fun message(hold: GhoulHold, cadence: GhoulCadenceReading): String? = when (hold) {
        GhoulHold.None -> null
        GhoulHold.CameraStarting -> "STARTING CAMERA..."
        GhoulHold.CameraUnavailable -> "CAMERA UNAVAILABLE - SELECT CONTROLLER"
        GhoulHold.FaceLost -> "FACE LOST - LOOK AT THE SCREEN"
        GhoulHold.Calibrating -> "LOOK STRAIGHT AHEAD - CENTERING"
        GhoulHold.NoTelemetry -> if (cadence.status == CadenceStatus.Stale) {
            "BIKE DATA STALE - WAITING FOR RPM"
        } else {
            "NO BIKE DATA - WAITING FOR RPM"
        }
        GhoulHold.Resuming -> "GET READY..."
    }
}

/** Pure input/session bridge: fresh absolute cadence and selected steering gate the game clock. */
internal class GhoulRunSession(
    val game: GhoulRunGame,
    val steering: HorizontalFaceSteering = HorizontalFaceSteering(),
    val pace: GhoulPace = GhoulPace(game.config),
    private val supervisor: GhoulRunSupervisor = GhoulRunSupervisor(),
) {
    private val headLanes = GhoulLeanZones(game.config.leanEnter, game.config.leanExit)
    private val stickLanes = GhoulLeanZones(game.config.leanEnter, game.config.leanExit)
    private var stickActive = false
    private var seenChoiceTurns = game.choiceTurns

    /** True after a turn used up the side selection, until lean/stick returns to center. */
    var rearming: Boolean = false
        private set
    var hold: GhoulHold = GhoulHold.CameraStarting
        private set
    var steer: SteerReading = SteerReading(FaceControlState.Lost, 0.5f, Float.NaN, 0f, -1L, 0L)
        private set
    var cadenceReading: GhoulCadenceReading = pace.reading
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
        @Suppress("UNUSED_PARAMETER") simulated: Boolean = false,
    ): GhoulHold {
        steer = steering.update(position, nowNanos)
        cadenceReading = pace.update(connected, initialized, rpm, rpmCurrent, rpmObservedAt, nowNanos)
        hold = supervisor.hold(camera, steer, cadenceReading, source, controllerAvailable)
        if (!live) {
            game.resetClock()
            pace.pauseClock()
            lastSteps = 0
            return hold
        }
        cadenceReading = pace.advanceWarmup()
        val useController = controller != null && source != GhoulRunInputSource.Webcam
        if (game.choiceTurns != seenChoiceTurns) {
            // A turn taken at a real choice uses up the selection: no chained turns from a lean held
            // through the last junction, and a button press arms only the next turn.
            seenChoiceTurns = game.choiceTurns
            if (lane != GhoulLane.Center) {
                lane = GhoulLane.Center
                rearming = true
            }
        }
        if (useController && controller.leftPressed != controller.rightPressed) {
            // Press a side to arm the next turn, press it again to cancel, the other side to switch.
            val side = if (controller.leftPressed) GhoulLane.Left else GhoulLane.Right
            lane = if (lane == side) GhoulLane.Center else side
            rearming = false
            stickLanes.reset()
            stickActive = false
        } else if (useController && abs(controller.stickX) > STICK_DEAD_ZONE) {
            lane = rearmed(stickLanes.update(controller.stickX.coerceIn(-1f, 1f)))
            stickActive = true
        } else if (stickActive) {
            // A released stick (or D-pad hat) recentres instead of leaving the last side selected.
            stickActive = false
            stickLanes.reset()
            rearming = false
            lane = GhoulLane.Center
        } else if (source != GhoulRunInputSource.Controller && steer.state == FaceControlState.Tracking) {
            lane = rearmed(headLanes.update(steer.steer))
        }
        val appliedLean = when {
            useController && abs(controller.stickX) > abs(steer.steer) -> controller.stickX
            source == GhoulRunInputSource.Controller -> controller?.stickX ?: 0f
            else -> steer.steer
        }
        lastSteps = game.advance(
            nowNanos,
            lane,
            appliedLean,
            cadenceReading.filteredRpm,
            cadenceReading.baseline,
        )
        return hold
    }

    /** While re-arming, a side reading counts as center until the input has passed back through center. */
    private fun rearmed(zone: GhoulLane): GhoulLane {
        if (!rearming) return zone
        if (game.brakingForChoice || game.waitingForChoice) {
            // A fork with no way straight: a lean still held from the last turn is clearly the
            // rider's intent, so it counts at once (re-arming only guards against chained turns
            // where going straight was possible).
            rearming = false
            return zone
        }
        if (zone == GhoulLane.Center) rearming = false
        return GhoulLane.Center
    }

    fun message(): String? = supervisor.message(hold, cadenceReading)

    fun pause() {
        game.resetClock()
        pace.pauseClock()
        steering.invalidate()
        supervisor.invalidate()
        headLanes.reset()
        stickLanes.reset()
    }

    fun restart(seed: Long) {
        game.restart(seed)
        steering.recalibrate()
        supervisor.invalidate()
        headLanes.reset()
        stickLanes.reset()
        stickActive = false
        rearming = false
        seenChoiceTurns = game.choiceTurns
        lane = GhoulLane.Center
    }

    fun recenter() {
        steering.recalibrate()
        supervisor.invalidate()
        headLanes.reset()
    }

    fun recalibratePace() {
        pace.recalibrate()
        game.resetClock()
        supervisor.invalidate()
    }

    private companion object {
        const val STICK_DEAD_ZONE = 0.08f
    }
}
