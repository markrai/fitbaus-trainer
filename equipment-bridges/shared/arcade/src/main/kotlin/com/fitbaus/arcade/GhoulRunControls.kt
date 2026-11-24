// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.abs

public enum class GhoulRunInputSource { Webcam, Controller, Both }

public data class GhoulRunControllerInput(
    val leftPressed: Boolean = false,
    val rightPressed: Boolean = false,
    val stickX: Float = 0f,
    val reversePressed: Boolean = false,
    val leftPressCount: Int = if (leftPressed) 1 else 0,
    val rightPressCount: Int = if (rightPressed) 1 else 0,
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

internal object GhoulPaceProfile {
    const val DEFAULT_RPM = 70f
    private const val MIN_RPM = 35f
    private const val MAX_RPM = 140f
    private const val MAX_AGE_MS = 30L * 24L * 60L * 60L * 1000L

    fun valid(rpm: Float): Boolean = rpm.isFinite() && rpm in MIN_RPM..MAX_RPM

    fun restore(rpm: Float, recordedAtMs: Long, nowMs: Long): Float =
        if (valid(rpm) && recordedAtMs > 0L && nowMs >= recordedAtMs &&
            nowMs - recordedAtMs <= MAX_AGE_MS
        ) rpm else Float.NaN
}

internal class GhoulPace(
    private val gameConfig: GhoulRunConfig,
    val filter: CadenceGravity = CadenceGravity(),
    initialBaseline: Float = Float.NaN,
) {
    private val warmupSamples = ArrayDeque<Pair<Long, Float>>()
    private var lastUpdateNanos = Long.MIN_VALUE
    private var warmupElapsed = 0f
    private var pendingWarmupNanos = 0L
    private var pendingSampleNanos = Long.MIN_VALUE
    private var trained = GhoulPaceProfile.valid(initialBaseline)
    private var targetBaseline = Float.NaN

    var baseline: Float = if (trained) initialBaseline else GhoulPaceProfile.DEFAULT_RPM
        private set
    var learnedBaseline: Float = Float.NaN
        private set

    var reading: GhoulCadenceReading = GhoulCadenceReading(
        CadenceStatus.NoTelemetry,
        -1,
        filter.filteredRpm,
        baseline,
        if (trained) 0f else gameConfig.warmupSeconds,
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

    fun advanceWarmup(): GhoulCadenceReading {
        val dt = pendingWarmupNanos / 1_000_000_000f
        if (!trained && filter.status == CadenceStatus.Live &&
            pendingSampleNanos != Long.MIN_VALUE && GhoulPaceProfile.valid(filter.filteredRpm)
        ) {
            warmupElapsed += dt
            warmupSamples.addLast(pendingSampleNanos to filter.filteredRpm)
            val cutoff = pendingSampleNanos - (gameConfig.baselineWindowSeconds * 1_000_000_000L).toLong()
            while (warmupSamples.firstOrNull()?.first?.let { it < cutoff } == true) warmupSamples.removeFirst()
            if (warmupElapsed >= gameConfig.warmupSeconds && warmupSamples.size >= 5) {
                val samples = warmupSamples.map { it.second }.sorted()
                val median = if (samples.size % 2 == 0) {
                    (samples[samples.size / 2 - 1] + samples[samples.size / 2]) / 2f
                } else samples[samples.size / 2]
                val spread = samples[samples.size * 3 / 4] - samples[samples.size / 4]
                val sampleSpan = warmupSamples.last().first - warmupSamples.first().first
                if (spread <= 12f && sampleSpan >= (gameConfig.baselineWindowSeconds * 500_000_000L).toLong()) {
                    trained = true
                    targetBaseline = median
                    learnedBaseline = median
                    warmupSamples.clear()
                }
            }
        }
        if (targetBaseline.isFinite()) {
            val maximumShift = 1.5f * dt
            baseline += (targetBaseline - baseline).coerceIn(-maximumShift, maximumShift)
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
            if (trained) 0f else (gameConfig.warmupSeconds - warmupElapsed).coerceAtLeast(0f),
        )
    }

    fun pauseClock() {
        lastUpdateNanos = Long.MIN_VALUE
        pendingWarmupNanos = 0L
        pendingSampleNanos = Long.MIN_VALUE
        filter.pauseClock()
    }

    fun recalibrate() {
        warmupSamples.clear()
        warmupElapsed = 0f
        pendingWarmupNanos = 0L
        pendingSampleNanos = Long.MIN_VALUE
        trained = false
        targetBaseline = Float.NaN
        learnedBaseline = Float.NaN
        refreshReading()
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

internal class GhoulTurnIntentBuffer(private val capacity: Int = 2) {
    private data class Intent(
        val lane: GhoulLane,
        val junction: MazeCell,
        val incoming: MazeDirection,
        val deadlineNanos: Long,
    )

    private val commands = ArrayList<Intent>(capacity)
    val size: Int get() = commands.size
    val current: GhoulLane? get() = commands.firstOrNull()?.lane

    fun refresh(game: GhoulRunGame, nowNanos: Long) {
        val first = commands.firstOrNull() ?: return
        val approaching = nextJunction(game)
        if (nowNanos >= first.deadlineNanos ||
            approaching?.first != first.junction || approaching?.second != first.incoming
        ) {
            clear()
        }
    }

    fun offer(game: GhoulRunGame, direction: GhoulLane, nowNanos: Long) {
        if (direction == GhoulLane.Center) return
        refresh(game, nowNanos)
        val approaching = nextJunction(game) ?: return
        val first = commands.firstOrNull()
        if (first != null) {
            val nextHeading = chosenDirection(game, first.junction, first.incoming, first.lane)
            if (nextHeading != null) {
                val nextJunction = first.junction.moved(nextHeading)
                if (game.world.isOpen(first.junction, nextHeading) &&
                    chosenDirection(game, nextJunction, nextHeading, direction) != null
                ) {
                    val second = Intent(direction, nextJunction, nextHeading, nowNanos + TURN_WINDOW_NANOS)
                    if (commands.size < capacity) commands.add(second)
                    else commands[commands.lastIndex] = second
                    return
                }
            }
        }
        if (chosenDirection(game, approaching.first, approaching.second, direction) != null) {
            commands.clear()
            commands.add(Intent(direction, approaching.first, approaching.second, nowNanos + TURN_WINDOW_NANOS))
        }
    }

    fun consume() {
        if (commands.isNotEmpty()) commands.removeAt(0)
    }

    fun clear() {
        commands.clear()
    }

    private fun nextJunction(game: GhoulRunGame): Pair<MazeCell, MazeDirection>? {
        if (game.phase != GhoulPhase.Playing || game.respawnLeft > 0f || game.turningLeft > 0f) return null
        if (!game.waitingForChoice && !game.world.isOpen(game.riderCell, game.heading)) return null
        return (if (game.waitingForChoice) game.riderCell else game.riderCell.moved(game.heading)) to game.heading
    }

    private fun chosenDirection(
        game: GhoulRunGame,
        junction: MazeCell,
        incoming: MazeDirection,
        lane: GhoulLane,
    ): MazeDirection? {
        if (!game.world.contains(junction)) return null
        if (game.world.exits(junction).count { it != incoming.opposite } < 2) return null
        val expected = if (lane == GhoulLane.Left) incoming.relativeLeft else incoming.relativeRight
        return expected.takeIf { it == game.choiceFor(junction, incoming, lane) }
    }

    private companion object {
        const val TURN_WINDOW_NANOS = 2_500_000_000L
    }
}

/** Pure input/session bridge: fresh absolute cadence and selected steering gate the game clock. */
internal class GhoulRunSession(
    val game: GhoulRunGame,
    val steering: HorizontalFaceSteering = HorizontalFaceSteering(
        SteerConfig(deadZone = 0.03f, gain = 2.4f, smoothingSeconds = 0.18f),
    ),
    val pace: GhoulPace = GhoulPace(game.config),
    private val supervisor: GhoulRunSupervisor = GhoulRunSupervisor(),
    private val readySeconds: Float = 3f,
) {
    private val headLanes = GhoulLeanZones(game.config.leanEnter, game.config.leanExit)
    private val stickLanes = GhoulLeanZones(game.config.leanEnter, game.config.leanExit)
    private val controllerTurns = GhoulTurnIntentBuffer()
    private var previousStickLane = GhoulLane.Center
    private var seenChoiceDecisions = game.choiceDecisions
    private var readyActive = false
    private var lastReadyNanos = Long.MIN_VALUE
    var readyRemaining: Float = readySeconds.coerceAtLeast(0f)
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
            lastReadyNanos = Long.MIN_VALUE
            controllerTurns.clear()
            stickLanes.reset()
            previousStickLane = GhoulLane.Center
            lastSteps = 0
            return hold
        }
        cadenceReading = pace.advanceWarmup()
        val useController = controller != null && source != GhoulRunInputSource.Webcam
        if (game.phase == GhoulPhase.WarmUp && game.level == 1 && readySeconds > 0f) {
            if (!readyActive) {
                readyActive = true
                readyRemaining = readySeconds
                lastReadyNanos = nowNanos
            } else {
                if (lastReadyNanos != Long.MIN_VALUE) {
                    val dt = ((nowNanos - lastReadyNanos) / 1_000_000_000f).coerceIn(0f, 0.5f)
                    readyRemaining = (readyRemaining - dt).coerceAtLeast(0f)
                }
                lastReadyNanos = nowNanos
            }
            if (readyRemaining > 0f) {
                game.resetClock()
                lastSteps = 0
                return hold
            }
        } else {
            readyActive = false
            readyRemaining = 0f
            lastReadyNanos = Long.MIN_VALUE
        }
        if (cadenceReading.calibrated) {
            if (source == GhoulRunInputSource.Controller && useController && controllerAvailable) {
                if (readySeconds > 0f && game.phase == GhoulPhase.WarmUp) game.markLeanCheckPassed()
                else game.skipLeanCheckWithGo()
            } else if (source != GhoulRunInputSource.Controller) {
                game.restoreLeanCheckIfSkipped()
            }
        }
        val reversed = useController && controller.reversePressed && game.reverseDirection()
        controllerTurns.refresh(game, nowNanos)
        if (game.choiceDecisions != seenChoiceDecisions) {
            if (game.choiceDecisions < seenChoiceDecisions) controllerTurns.clear()
            else repeat((game.choiceDecisions - seenChoiceDecisions).coerceAtMost(2)) { controllerTurns.consume() }
            seenChoiceDecisions = game.choiceDecisions
        }
        if (!useController) {
            controllerTurns.clear()
            stickLanes.reset()
            previousStickLane = GhoulLane.Center
        }
        if (reversed) {
            controllerTurns.clear()
            headLanes.reset()
            stickLanes.reset()
            previousStickLane = stickLanes.update(controller?.stickX ?: 0f)
        } else if (useController) {
            val stickLane = stickLanes.update(controller.stickX.coerceIn(-1f, 1f))
            val leftPulses = controller.leftPressCount.coerceIn(0, 2)
            val rightPulses = controller.rightPressCount.coerceIn(0, 2)
            val buttonLane = when {
                leftPulses > 0 && rightPulses == 0 -> GhoulLane.Left
                rightPulses > 0 && leftPulses == 0 -> GhoulLane.Right
                else -> GhoulLane.Center
            }
            if (stickLane != previousStickLane && stickLane != GhoulLane.Center && buttonLane == GhoulLane.Center) {
                controllerTurns.offer(game, stickLane, nowNanos)
            }
            previousStickLane = stickLane
            val count = if (buttonLane == GhoulLane.Left) leftPulses else rightPulses
            repeat(if (buttonLane == GhoulLane.Center) 0 else count) {
                controllerTurns.offer(game, buttonLane, nowNanos)
            }
        }
        val webcamLane = if (source != GhoulRunInputSource.Controller && steer.state == FaceControlState.Tracking) {
            headLanes.update(steer.steer)
        } else GhoulLane.Center
        lane = if (reversed) GhoulLane.Center else controllerTurns.current ?: webcamLane
        val appliedLean = when {
            reversed -> 0f
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
        if (game.choiceDecisions != seenChoiceDecisions) {
            repeat((game.choiceDecisions - seenChoiceDecisions).coerceAtMost(2)) { controllerTurns.consume() }
            seenChoiceDecisions = game.choiceDecisions
            controllerTurns.refresh(game, nowNanos)
            lane = controllerTurns.current ?: webcamLane
        }
        return hold
    }

    fun message(): String? = supervisor.message(hold, cadenceReading)

    fun pause() {
        game.resetClock()
        pace.pauseClock()
        lastReadyNanos = Long.MIN_VALUE
        steering.invalidate()
        supervisor.invalidate()
        headLanes.reset()
        stickLanes.reset()
        controllerTurns.clear()
        previousStickLane = GhoulLane.Center
        lane = GhoulLane.Center
    }

    fun restart(seed: Long) {
        game.restart(seed)
        readyActive = false
        readyRemaining = readySeconds.coerceAtLeast(0f)
        lastReadyNanos = Long.MIN_VALUE
        steering.recalibrate()
        supervisor.invalidate()
        headLanes.reset()
        stickLanes.reset()
        controllerTurns.clear()
        previousStickLane = GhoulLane.Center
        seenChoiceDecisions = game.choiceDecisions
        lane = GhoulLane.Center
    }

    fun recenter() {
        steering.recalibrate()
        supervisor.invalidate()
        headLanes.reset()
    }

    fun recalibratePace() {
        pace.recalibrate()
    }

}
