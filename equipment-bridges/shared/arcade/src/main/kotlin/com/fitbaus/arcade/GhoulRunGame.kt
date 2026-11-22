// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

/** Rider-relative selection: [Left] is the rider's own left, whatever the map orientation. */
internal enum class GhoulLane { Left, Center, Right }
internal enum class GhoulPhase { WarmUp, LeanCheck, Playing, Results, Countdown }
internal enum class GhoulState { Inactive, Wandering, Hunting, Searching, Inspecting, Stunned }
internal enum class GhoulHint { ChooseTurn, PedalPastGhoul, StayQuiet, HoldStill, LeanToChoose, RideThroughShrine }

internal data class GhoulResults(val seconds: Float, val catches: Int, val keys: Int)

/** Set exactly once per catch; [serial] equals [GhoulRunGame.catches] at the moment of the catch. */
internal data class GhoulCatchEvent(val serial: Int, val atSeconds: Float, val heartsLeft: Int, val respawned: Boolean)

/** Turn slots for the next junction, shown only when it is a real choice (2+ exits besides the way back). */
internal data class GhoulTurnSlots(val left: Boolean, val straight: Boolean, val right: Boolean, val selected: GhoulLane?) {
    fun open(lane: GhoulLane): Boolean = when (lane) {
        GhoulLane.Left -> left
        GhoulLane.Center -> straight
        GhoulLane.Right -> right
    }
}

/**
 * Speed-gauge markers derived from [GhoulRunConfig] by inverting [GhoulRunGame.radiiFor] and
 * [GhoulRunGame.speedFor]. [earRpm] is null when the ear is hidden (the gap is beyond the sprint
 * noise radius); when pinned it equals [lowRpm] because even creeping is heard.
 */
internal data class GhoulGaugeMarks(
    val lowRpm: Float,
    val highRpm: Float,
    val earRpm: Float?,
    val earPinned: Boolean,
    val outrunRpm: Float,
) {
    val earHidden: Boolean get() = earRpm == null
}

internal class GhoulMonster(val spawn: MazeCell) {
    var cell: MazeCell = spawn
    var heading: MazeDirection = MazeDirection.East
    var progress: Float = 0f
    var state: GhoulState = GhoulState.Inactive
    var speed: Float = 0f
    var contactLostFor: Float = 0f
    var searchWaitLeft: Float = 0f
    var stunLeft: Float = 0f
    var inspectLeft: Float = 0f
    var retreating: Boolean = false
    var sparedRiderAt: MazeCell? = null
    var lastKnown: MazeCell = spawn

    val row: Float get() = cell.row + heading.dr * progress
    val col: Float get() = cell.col + heading.dc * progress

    fun reset(firstHeading: MazeDirection, active: Boolean) {
        cell = spawn
        heading = firstHeading
        progress = 0f
        state = if (active) GhoulState.Wandering else GhoulState.Inactive
        speed = 0f
        contactLostFor = 0f
        searchWaitLeft = 0f
        stunLeft = 0f
        inspectLeft = 0f
        retreating = false
        sparedRiderAt = null
        lastKnown = spawn
    }
}

/** Pure fixed-step GHOUL RUN simulation. One graph edge is one gameplay tile. */
internal class GhoulRunGame(
    val config: GhoulRunConfig = GhoulRunConfig(),
    seed: Long = 1L,
) {
    val world = GhoulRunWorld(config, seed)
    val collectedKeys = LinkedHashSet<MazeCell>()
    val exploredTiles = LinkedHashSet<MazeTile>()
    private val exploredGrid = BooleanArray(world.tileRows * world.tileCols)
    private var revealRow = Float.NaN
    private var revealCol = Float.NaN
    private var revealRadius = 0f
    val shrineCooldowns = LinkedHashMap<MazeCell, Float>()

    var ghoul: GhoulMonster = GhoulMonster(world.monsterSpawn)
        private set
    var phase: GhoulPhase = GhoulPhase.WarmUp
        private set
    var riderCell: MazeCell = world.start
        private set
    var heading: MazeDirection = MazeDirection.East
        private set
    var progress: Float = 0f
        private set
    var lane: GhoulLane = GhoulLane.Center
        private set
    var lean: Float = 0f
        private set
    var lockedChoice: MazeDirection? = null
        private set
    var brakingForChoice: Boolean = false
        private set

    /** Stopped at a junction whose straight is blocked until the player leans; the game never picks a turn. */
    var waitingForChoice: Boolean = false
        private set
    var turningLeft: Float = 0f
        private set
    var speed: Float = 0f
        private set
    var targetSpeed: Float = 0f
        private set
    var lightRadius: Float = 0f
        private set
    var noiseRadius: Float = 0f
        private set
    var elapsed: Float = 0f
        private set
    var hearts: Int = config.startingHearts
        private set
    var catches: Int = 0
        private set
    var invulnerableLeft: Float = 0f
        private set
    var checkpoint: MazeCell = world.start
        private set
    var results: GhoulResults? = null
        private set
    var phaseLeft: Float = 0f
        private set
    var seed: Long = seed
        private set

    var catchEvent: GhoulCatchEvent? = null
        private set
    var respawnLeft: Float = 0f
        private set
    var respawns: Int = 0
        private set
    var warmupTime: Float = 0f
        private set
    var leanCheckStep: Int = 0
        private set
    var leanCheckHeld: Float = 0f
        private set
    var leanCheckConfirmLeft: Float = 0f
        private set

    /** The lean check runs once per session; later mazes skip it (it survives maze resets). */
    var leanCheckPassed: Boolean = false
        private set

    /** Counts actual direction changes at optional junctions. */
    var choiceTurns: Int = 0

    var choiceDecisions: Int = 0
        private set

    private var accumulator = 0f
    private var lastFrameNanos = Long.MIN_VALUE
    private var rng = Random(seed xor GHOUL_RANDOM_SALT)
    private var quietFor = 0f

    init { resetMaze(seed, resetCatches = true) }

    val keysFound: Int get() = collectedKeys.size
    val exitOpen: Boolean get() = keysFound == config.keyCount
    val riderRow: Float get() = riderCell.row + heading.dr * progress
    val riderCol: Float get() = riderCell.col + heading.dc * progress
    val lampLevel: Float get() = lightRadius / config.sprintLightRadius
    val pathGap: Float get() = continuousPathDistance()
    val activeChoice: MazeDirection?
        get() {
            val junction = riderCell.moved(heading)
            if (!world.contains(junction)) return null
            if (waitingForChoice) return choiceFor(riderCell, heading, lane)
            return lockedChoice ?: choiceFor(junction, heading, lane)
        }
    val ghoulHuntSpeed: Float get() = config.cruiseSpeed * config.huntSpeedRatio

    /** Lane the lean check is waiting for; null once it shows GO (or outside the check). */
    val leanCheckTarget: GhoulLane?
        get() = if (phase == GhoulPhase.LeanCheck) LEAN_CHECK_ORDER.getOrNull(leanCheckStep) else null

    /** The next junction's slots when it is a real choice; null on corridors, corners and dead ends. */
    fun turnSlots(): GhoulTurnSlots? {
        if (turningLeft > 0f) return null
        if (!waitingForChoice && !world.isOpen(riderCell, heading)) return null
        val junction = if (waitingForChoice) riderCell else riderCell.moved(heading)
        val allowed = world.exits(junction).filter { it != heading.opposite }
        if (allowed.size < 2) return null
        val selected = when (activeChoice) {
            heading.relativeLeft -> GhoulLane.Left
            heading -> GhoulLane.Center
            heading.relativeRight -> GhoulLane.Right
            else -> null
        }
        return GhoulTurnSlots(heading.relativeLeft in allowed, heading in allowed, heading.relativeRight in allowed, selected)
    }

    /** Continuous maze-path distance (cells) from the rider to [cell]'s centre. */
    fun riderPathDistanceTo(cell: MazeCell): Float {
        var best = Float.POSITIVE_INFINITY
        for ((end, cost) in edgeEndpoints(riderCell, heading, progress)) {
            val cells = world.pathDistance(end, cell) ?: continue
            best = min(best, cost + cells)
        }
        return best
    }

    /** Fills [out] (indexed row * width + col) with [riderPathDistanceTo] for every cell, without allocating. */
    fun fillRiderPathDistances(out: FloatArray) {
        val width = config.width
        val here = riderCell.row * width + riderCell.col
        val next = riderCell.moved(heading)
        val moving = world.contains(next) && world.isOpen(riderCell, heading)
        val there = next.row * width + next.col
        for (index in out.indices) {
            val a = world.pathDistanceIndex(here, index)
            var best = if (a < 0) Float.POSITIVE_INFINITY else if (moving) progress + a else a.toFloat()
            if (moving) {
                val b = world.pathDistanceIndex(there, index)
                if (b >= 0 && 1f - progress + b < best) best = 1f - progress + b
            }
            out[index] = best
        }
    }

    /** One hint at a time, in priority order. */
    fun hint(): GhoulHint? {
        if (phase != GhoulPhase.Playing || respawnLeft > 0f) return null
        return when {
            ghoul.state == GhoulState.Inspecting -> GhoulHint.HoldStill
            waitingForChoice || brakingForChoice -> GhoulHint.ChooseTurn
            ghoul.state == GhoulState.Hunting -> GhoulHint.PedalPastGhoul
            ghoul.state == GhoulState.Searching -> GhoulHint.StayQuiet
            turnSlots() != null -> GhoulHint.LeanToChoose
            world.shrines.any { (shrineCooldowns[it] ?: 0f) <= 0f && riderPathDistanceTo(it) <= SHRINE_HINT_CELLS } ->
                GhoulHint.RideThroughShrine
            else -> null
        }
    }

    /** RPM at which [speedFor] returns [target]; clamps to the creep/sprint ends. */
    fun rpmForSpeed(target: Float, baseline: Float): Float {
        val low = baseline - config.baselineCreepDelta
        return when {
            target <= config.creepSpeed -> low
            target <= config.cruiseSpeed ->
                low + config.baselineCreepDelta * (target - config.creepSpeed) / (config.cruiseSpeed - config.creepSpeed)
            else -> baseline + config.sprintDelta *
                ((target - config.cruiseSpeed) / (config.sprintSpeed - config.cruiseSpeed)).coerceAtMost(1f)
        }
    }

    /** Ear and outrun markers for a [gap] (cells) to the Ghoul, or null before the pace baseline exists. */
    fun gaugeMarks(baseline: Float, gap: Float): GhoulGaugeMarks? {
        if (!baseline.isFinite()) return null
        val low = baseline - config.baselineCreepDelta
        val high = baseline + config.sprintDelta
        val pinned = gap < config.creepNoiseRadius
        val ear = when {
            pinned -> low
            !gap.isFinite() || gap > config.sprintNoiseRadius -> null
            config.sprintNoiseRadius <= config.creepNoiseRadius -> low
            else -> {
                val t = (gap - config.creepNoiseRadius) / (config.sprintNoiseRadius - config.creepNoiseRadius)
                max(low + t * (config.baselineCreepDelta + config.sprintDelta), config.stoppedBelowRpm)
            }
        }
        return GhoulGaugeMarks(low, high, ear, pinned, rpmForSpeed(ghoulHuntSpeed, baseline))
    }

    fun speedFor(filteredRpm: Float, baseline: Float): Float {
        if (filteredRpm < config.stoppedBelowRpm || baseline.isNaN()) return 0f
        if (filteredRpm <= baseline) {
            val t = ((filteredRpm - (baseline - config.baselineCreepDelta)) / config.baselineCreepDelta).coerceIn(0f, 1f)
            return lerp(config.creepSpeed, config.cruiseSpeed, t)
        }
        val t = ((filteredRpm - baseline) / config.sprintDelta).coerceIn(0f, 1f)
        return lerp(config.cruiseSpeed, config.sprintSpeed, t)
    }

    fun radiiFor(filteredRpm: Float, baseline: Float): Pair<Float, Float> {
        if (filteredRpm < config.stoppedBelowRpm || baseline.isNaN()) return 0f to 0f
        val t = ((filteredRpm - (baseline - config.baselineCreepDelta)) /
            (config.baselineCreepDelta + config.sprintDelta)).coerceIn(0f, 1f)
        return lerp(config.creepLightRadius, config.sprintLightRadius, t) to
            lerp(config.creepNoiseRadius, config.sprintNoiseRadius, t)
    }

    fun resetClock() {
        lastFrameNanos = Long.MIN_VALUE
        accumulator = 0f
    }

    fun advance(nowNanos: Long, lane: GhoulLane, lean: Float, filteredRpm: Float, baseline: Float): Int {
        if (lastFrameNanos == Long.MIN_VALUE) {
            lastFrameNanos = nowNanos
            return 0
        }
        val frame = ((nowNanos - lastFrameNanos) / 1_000_000_000f).coerceIn(0f, config.maxFrame)
        lastFrameNanos = nowNanos
        accumulator += frame
        var steps = 0
        while (accumulator >= config.step) {
            step(config.step, lane, lean, filteredRpm, baseline)
            accumulator -= config.step
            steps += 1
        }
        return steps
    }

    fun step(dt: Float, requestedLane: GhoulLane, requestedLean: Float, filteredRpm: Float, baseline: Float) {
        lane = requestedLane
        lean = requestedLean
        when (phase) {
            GhoulPhase.Results -> {
                phaseLeft -= dt
                if (phaseLeft <= 0f) {
                    phase = GhoulPhase.Countdown
                    phaseLeft = config.restartCountdownSeconds
                }
                return
            }
            GhoulPhase.Countdown -> {
                phaseLeft -= dt
                if (phaseLeft <= 0f) resetMaze(seed + 1L, resetCatches = true)
                return
            }
            else -> Unit
        }

        if (baseline.isNaN()) {
            if (phase != GhoulPhase.WarmUp) warmupTime = 0f
            phase = GhoulPhase.WarmUp
            warmupTime += dt
            ghoul.state = GhoulState.Inactive
            ghoul.speed = 0f
            holdStill()
            return
        }

        if (phase == GhoulPhase.WarmUp) {
            if (leanCheckPassed) beginCalibratedRun() else beginLeanCheck()
        }
        if (phase == GhoulPhase.LeanCheck) {
            stepLeanCheck(dt)
            return
        }
        if (respawnLeft > 0f) {
            respawnLeft -= dt
            speed = 0f
            targetSpeed = 0f
            if (respawnLeft <= 0f) completeRespawn()
            return
        }
        elapsed += dt
        invulnerableLeft = (invulnerableLeft - dt).coerceAtLeast(0f)
        for ((shrine, cooldown) in shrineCooldowns.toMap()) {
            shrineCooldowns[shrine] = (cooldown - dt).coerceAtLeast(0f)
        }
        val radii = radiiFor(filteredRpm, baseline)
        lightRadius = radii.first
        noiseRadius = radii.second
        reveal()
        if (turningLeft > 0f) {
            turningLeft -= dt
            speed = 0f
            if (turningLeft <= 0f) reverseOnSegment()
        } else {
            val cadenceSpeed = speedFor(filteredRpm, baseline)
            targetSpeed = if (brakingForChoice && cadenceSpeed > 0f) min(cadenceSpeed, config.creepSpeed) else cadenceSpeed
            speed += (targetSpeed - speed) * min(1f, config.speedResponse * dt)
            moveRider(dt)
        }
        quietFor = if (filteredRpm < config.stoppedBelowRpm) {
            (quietFor + dt).coerceAtMost(config.stealthSettleSeconds + 1f)
        } else 0f
        if (phase == GhoulPhase.Playing) updateGhoul(dt)
    }

    /** Direction selected at [cell] for a rider-relative lane while arriving along [arrivalHeading]. */
    fun choiceFor(cell: MazeCell, arrivalHeading: MazeDirection, lane: GhoulLane): MazeDirection? {
        val allowed = world.exits(cell).filter { it != arrivalHeading.opposite }
        if (allowed.isEmpty()) return arrivalHeading.opposite
        if (allowed.size == 1) return allowed[0]
        val straight = arrivalHeading.takeIf { it in allowed }
        val turn = when (lane) {
            GhoulLane.Center -> return straight
            GhoulLane.Left -> arrivalHeading.relativeLeft
            GhoulLane.Right -> arrivalHeading.relativeRight
        }
        if (turn in allowed) return turn
        return straight
    }

    fun selectionFor(direction: MazeDirection, cell: MazeCell, arrivalHeading: MazeDirection): GhoulLane {
        return GhoulLane.entries.firstOrNull { choiceFor(cell, arrivalHeading, it) == direction } ?: GhoulLane.Center
    }

    fun choiceLocked(): Boolean = lockedChoice != null || brakingForChoice

    fun forceGhoul(
        cell: MazeCell,
        heading: MazeDirection = world.exits(cell).first(),
        progress: Float = 0f,
        state: GhoulState = GhoulState.Wandering,
    ) {
        ghoul.cell = cell
        ghoul.heading = heading
        ghoul.progress = progress.coerceIn(0f, 0.999f)
        ghoul.state = state
        ghoul.lastKnown = currentNearestCell()
        ghoul.contactLostFor = 0f
        ghoul.searchWaitLeft = 0f
        ghoul.stunLeft = 0f
        ghoul.inspectLeft = 0f
        ghoul.retreating = false
        ghoul.sparedRiderAt = null
    }

    internal fun placeRider(cell: MazeCell, direction: MazeDirection, edgeProgress: Float = 0f) {
        require(world.contains(cell))
        riderCell = cell
        heading = direction
        progress = edgeProgress.coerceIn(0f, 0.999f)
        lockedChoice = null
        brakingForChoice = false
        waitingForChoice = false
        turningLeft = 0f
    }

    internal fun visitForTest(cell: MazeCell) = visitCell(cell)

    /** Test hook: completes the lean check immediately (the ghoul wakes as after GO). */
    internal fun skipLeanCheck() {
        if (phase == GhoulPhase.LeanCheck) beginCalibratedRun()
    }

    fun restart(newSeed: Long = seed + 1L) = resetMaze(newSeed, resetCatches = true)

    fun reverseDirection(): Boolean {
        if (phase != GhoulPhase.Playing || respawnLeft > 0f) return false
        reverseOnSegment()
        return true
    }

    private fun moveRider(dt: Float) {
        if (waitingForChoice) {
            speed = 0f
            val selected = choiceFor(riderCell, heading, lane) ?: return
            waitingForChoice = false
            takeChoice(selected)
            return
        }
        if (!world.isOpen(riderCell, heading)) {
            beginDeadEndTurn()
            return
        }
        val junction = riderCell.moved(heading)
        if (progress >= 1f - config.junctionLockDistance && !brakingForChoice) {
            val next = choiceFor(junction, heading, lane)
            if (next == null && lockedChoice == null) {
                brakingForChoice = true
            } else if (next != null) {
                lockedChoice = next
            }
        }
        if (brakingForChoice) {
            val selected = choiceFor(junction, heading, lane)
            if (selected != null) {
                lockedChoice = selected
                brakingForChoice = false
            }
        }
        progress += speed * dt
        if (progress < 1f || phase != GhoulPhase.Playing && phase != GhoulPhase.WarmUp) return
        progress -= 1f
        riderCell = junction
        visitCell(riderCell)
        if (phase != GhoulPhase.Playing && phase != GhoulPhase.WarmUp) return
        val choice = lockedChoice ?: choiceFor(riderCell, heading, lane)
        lockedChoice = null
        brakingForChoice = false
        if (choice == null) {
            // Straight is blocked and no side is selected: stop here, facing the wall, until the player leans.
            progress = 0f
            speed = 0f
            targetSpeed = 0f
            waitingForChoice = true
            return
        }
        takeChoice(choice)
    }

    private fun takeChoice(choice: MazeDirection) {
        if (world.exits(riderCell).count { it != heading.opposite } >= 2) {
            choiceDecisions += 1
            if (choice != heading && choice != heading.opposite) choiceTurns += 1
        }
        if (choice == heading.opposite) {
            progress = 0f
            beginDeadEndTurn()
            return
        }
        heading = choice
        if (!world.isOpen(riderCell, heading)) {
            progress = 0f
            beginDeadEndTurn()
        }
    }

    private fun visitCell(cell: MazeCell) {
        if (phase == GhoulPhase.WarmUp) return
        if (cell in world.keys) collectedKeys += cell
        if (cell in world.shrines) {
            checkpoint = cell
            val cooldown = shrineCooldowns[cell] ?: 0f
            if (cooldown <= 0f) {
                shrineCooldowns[cell] = config.shrineRechargeSeconds
                if (ghoul.state != GhoulState.Inactive && pathGap <= config.shrinePulseRadius) {
                    stunGhoul(config.shrineStunSeconds)
                }
            }
        }
        if (cell == world.exit && exitOpen) {
            results = GhoulResults(elapsed, catches, keysFound)
            phase = GhoulPhase.Results
            phaseLeft = config.resultsSeconds
            speed = 0f
        }
    }

    private fun beginDeadEndTurn() {
        if (turningLeft <= 0f) turningLeft = config.deadEndTurnSeconds
        speed = 0f
    }

    /** Warm-up and lean check: the rider stays exactly where it is, lit at cruise level. */
    private fun holdStill() {
        val cruiseFactor = config.baselineCreepDelta / (config.baselineCreepDelta + config.sprintDelta)
        lightRadius = lerp(config.creepLightRadius, config.sprintLightRadius, cruiseFactor)
        noiseRadius = lerp(config.creepNoiseRadius, config.sprintNoiseRadius, cruiseFactor)
        targetSpeed = 0f
        speed = 0f
        reveal()
    }

    private fun beginLeanCheck() {
        phase = GhoulPhase.LeanCheck
        leanCheckStep = 0
        leanCheckHeld = 0f
        leanCheckConfirmLeft = 0f
        phaseLeft = 0f
    }

    private fun stepLeanCheck(dt: Float) {
        holdStill()
        if (leanCheckStep >= LEAN_CHECK_ORDER.size) {
            phaseLeft -= dt
            if (phaseLeft <= 0f) beginCalibratedRun()
            return
        }
        if (leanCheckConfirmLeft > 0f) {
            leanCheckConfirmLeft -= dt
            if (leanCheckConfirmLeft <= 0f) nextLeanCheckStep()
            return
        }
        leanCheckHeld = if (lane == LEAN_CHECK_ORDER[leanCheckStep]) leanCheckHeld + dt else 0f
        if (leanCheckHeld >= config.leanCheckHoldSeconds) {
            leanCheckConfirmLeft = config.leanCheckConfirmSeconds
            if (leanCheckConfirmLeft <= 0f) nextLeanCheckStep()
        }
    }

    private fun nextLeanCheckStep() {
        leanCheckConfirmLeft = 0f
        leanCheckHeld = 0f
        leanCheckStep += 1
        if (leanCheckStep >= LEAN_CHECK_ORDER.size) phaseLeft = config.leanCheckGoSeconds
    }

    private fun reverseOnSegment() {
        val destination = riderCell.moved(heading)
        if (world.contains(destination) && world.isOpen(riderCell, heading)) {
            riderCell = destination
            progress = 1f - progress
        }
        heading = heading.opposite
        lockedChoice = null
        brakingForChoice = false
        waitingForChoice = false
        turningLeft = 0f
    }

    private fun updateGhoul(dt: Float) {
        if (ghoul.state == GhoulState.Inactive) return
        if (ghoul.state == GhoulState.Stunned) {
            ghoul.speed = 0f
            ghoul.stunLeft = (ghoul.stunLeft - dt).coerceAtLeast(0f)
            if (ghoul.stunLeft <= 0f) ghoul.state = GhoulState.Wandering
            return
        }

        val riderTarget = currentNearestCell()
        val gap = pathGap
        val quiet = quietFor >= config.stealthSettleSeconds && speed <= STEALTH_MAX_SPEED
        if (!quiet || ghoul.sparedRiderAt != null && ghoul.sparedRiderAt != riderTarget) {
            ghoul.sparedRiderAt = null
            ghoul.retreating = false
        }
        if (ghoul.retreating && gap >= config.stealthInspectDistance + config.stealthRetreatClearance) {
            ghoul.retreating = false
        }
        val heard = noiseRadius > 0f && gap <= noiseRadius
        val trackedUpClose = ghoul.state == GhoulState.Hunting &&
            ghoul.contactLostFor <= 0f && gap <= config.stealthTrackedSightDistance
        val seen = (!quiet || trackedUpClose) && gap <= lightRadius + 1f &&
            world.hasLineOfSight(ghoulNearestCell(), riderTarget)

        if (ghoul.state == GhoulState.Inspecting) {
            if (heard || !quiet) {
                beginHunt(riderTarget)
            } else {
                ghoul.speed = 0f
                ghoul.inspectLeft -= dt
                if (ghoul.inspectLeft <= 0f) turnAwayFromRider(riderTarget)
                return
            }
        }

        if (maybeInspectQuietRider(quiet, riderTarget, gap)) return
        when (ghoul.state) {
            GhoulState.Wandering -> {
                if (heard || seen) beginHunt(riderTarget) else {
                    ghoul.speed = config.cruiseSpeed * config.wanderSpeedRatio
                    advanceGhoul(dt) { cell, arrival -> wanderDirection(cell, arrival) }
                }
            }
            GhoulState.Hunting -> {
                val chaseTarget: MazeCell
                if (heard || seen) {
                    ghoul.lastKnown = riderTarget
                    ghoul.contactLostFor = 0f
                    chaseTarget = riderTarget
                } else {
                    ghoul.contactLostFor += dt
                    chaseTarget = ghoul.lastKnown
                    if (ghoul.contactLostFor >= config.loseContactSeconds) {
                        ghoul.state = GhoulState.Searching
                        ghoul.searchWaitLeft = config.searchWaitSeconds
                    }
                }
                ghoul.speed = config.cruiseSpeed * config.huntSpeedRatio
                advanceGhoulToward(dt, chaseTarget)
            }
            GhoulState.Searching -> {
                if (heard || seen) {
                    beginHunt(riderTarget)
                } else if (ghoulNearestCell() != ghoul.lastKnown || ghoul.progress > 0.01f) {
                    ghoul.speed = config.cruiseSpeed * config.searchSpeedRatio
                    advanceGhoulToward(dt, ghoul.lastKnown)
                } else {
                    ghoul.speed = 0f
                    ghoul.searchWaitLeft -= dt
                    if (ghoul.searchWaitLeft <= 0f) ghoul.state = GhoulState.Wandering
                }
            }
            else -> Unit
        }
        if (maybeInspectQuietRider(quiet, riderTarget, pathGap)) return
        if (ghoul.state != GhoulState.Stunned && ghoul.state != GhoulState.Inspecting &&
            invulnerableLeft <= 0f && pathGap <= config.catchDistance) catchRider()
    }

    private fun maybeInspectQuietRider(quiet: Boolean, riderTarget: MazeCell, gap: Float): Boolean {
        if (!quiet || ghoul.retreating || gap <= config.catchDistance || gap > config.stealthInspectDistance) return false
        if (ghoul.state != GhoulState.Searching && ghoul.state != GhoulState.Wandering) return false
        if (ghoul.sparedRiderAt == riderTarget) {
            turnAwayFromRider(riderTarget)
        } else {
            ghoul.state = GhoulState.Inspecting
            ghoul.speed = 0f
            ghoul.inspectLeft = config.stealthInspectSeconds
            ghoul.sparedRiderAt = riderTarget
        }
        return true
    }

    private fun turnAwayFromRider(riderTarget: MazeCell) {
        val at = ghoul.cell
        val ahead = at.moved(ghoul.heading)
        if (ghoul.progress > 0.001f && world.isOpen(at, ghoul.heading)) {
            val distanceBack = world.pathDistance(at, riderTarget) ?: -1
            val distanceAhead = world.pathDistance(ahead, riderTarget) ?: -1
            if (distanceBack >= distanceAhead) {
                ghoul.cell = ahead
                ghoul.heading = ghoul.heading.opposite
                ghoul.progress = 1f - ghoul.progress
                ghoul.lastKnown = at
            } else {
                ghoul.lastKnown = ahead
            }
        } else {
            ghoul.progress = 0f
            val away = world.exits(at).maxWithOrNull(
                compareBy<MazeDirection> { world.pathDistance(at.moved(it), riderTarget) ?: -1 }
                    .thenBy { -it.ordinal },
            )
            if (away != null) {
                ghoul.heading = away
                ghoul.lastKnown = at.moved(away)
            } else ghoul.lastKnown = at
        }
        ghoul.state = GhoulState.Searching
        ghoul.searchWaitLeft = config.searchWaitSeconds
        ghoul.inspectLeft = 0f
        ghoul.retreating = true
    }

    private fun beginHunt(target: MazeCell) {
        ghoul.state = GhoulState.Hunting
        ghoul.lastKnown = target
        ghoul.contactLostFor = 0f
        ghoul.inspectLeft = 0f
        ghoul.retreating = false
    }

    private fun wanderDirection(cell: MazeCell, arrivalHeading: MazeDirection): MazeDirection? {
        val exits = world.exits(cell)
        val forward = exits.filter { it != arrivalHeading.opposite }
        val choices = forward.ifEmpty { exits }
        return choices.takeIf { it.isNotEmpty() }?.get(rng.nextInt(choices.size))
    }

    private fun advanceGhoulToward(dt: Float, target: MazeCell) {
        advanceGhoul(dt) { cell, _ ->
            val path = world.shortestPath(cell, target)
            if (path.size >= 2) directionBetween(path[0], path[1]) else null
        }
    }

    private fun advanceGhoul(dt: Float, directionAtCell: (MazeCell, MazeDirection) -> MazeDirection?) {
        var remaining = ghoul.speed * dt
        while (remaining > 0f) {
            if (!world.isOpen(ghoul.cell, ghoul.heading)) {
                ghoul.heading = directionAtCell(ghoul.cell, ghoul.heading) ?: return
            }
            val edgeLeft = 1f - ghoul.progress
            if (remaining < edgeLeft) {
                ghoul.progress += remaining
                return
            }
            remaining -= edgeLeft
            ghoul.cell = ghoul.cell.moved(ghoul.heading)
            ghoul.progress = 0f
            ghoul.heading = directionAtCell(ghoul.cell, ghoul.heading) ?: return
        }
    }

    private fun catchRider() {
        if (phase != GhoulPhase.Playing || invulnerableLeft > 0f) return
        catches += 1
        hearts -= 1
        invulnerableLeft = config.invulnerabilitySeconds
        if (hearts <= 0) {
            hearts = 0
            speed = 0f
            targetSpeed = 0f
            catchEvent = GhoulCatchEvent(catches, elapsed, 0, respawned = true)
            respawnLeft = config.respawnSeconds
            if (respawnLeft <= 0f) completeRespawn()
            return
        }
        catchEvent = GhoulCatchEvent(catches, elapsed, hearts, respawned = false)
        val riderCentre = currentNearestCell()
        val distances = world.distancesFrom(riderCentre)
        val pushed = distances.entries
            .filter { it.value >= config.catchKnockbackTiles }
            .minWithOrNull(
                compareBy<Map.Entry<MazeCell, Int>> { it.value }
                    .thenBy { world.pathDistance(it.key, ghoul.spawn) ?: Int.MAX_VALUE },
            )
            ?.key ?: ghoul.spawn
        ghoul.cell = pushed
        ghoul.progress = 0f
        ghoul.heading = world.exits(pushed).firstOrNull() ?: MazeDirection.East
        stunGhoul(config.catchStunSeconds)
    }

    /** Runs after the out-of-hearts delay so the view can fade to black before the move. */
    private fun completeRespawn() {
        respawnLeft = 0f
        hearts = config.startingHearts
        riderCell = checkpoint
        progress = 0f
        heading = headingTowardExit(riderCell)
        lockedChoice = null
        brakingForChoice = false
        waitingForChoice = false
        turningLeft = 0f
        speed = 0f
        quietFor = 0f
        invulnerableLeft = config.invulnerabilitySeconds
        resetGhoul(active = true)
        respawns += 1
    }

    private fun stunGhoul(seconds: Float) {
        ghoul.state = GhoulState.Stunned
        ghoul.speed = 0f
        ghoul.stunLeft = max(ghoul.stunLeft, seconds)
        ghoul.contactLostFor = 0f
        ghoul.inspectLeft = 0f
        ghoul.retreating = false
        ghoul.sparedRiderAt = null
    }

    private fun continuousPathDistance(): Float {
        val sameEdge = sameEdgeDistance()
        if (sameEdge != null) return sameEdge
        val riderEnds = edgeEndpoints(riderCell, heading, progress)
        val ghoulEnds = edgeEndpoints(ghoul.cell, ghoul.heading, ghoul.progress)
        var best = Float.POSITIVE_INFINITY
        for ((riderEnd, riderCost) in riderEnds) for ((ghoulEnd, ghoulCost) in ghoulEnds) {
            val cells = world.pathDistance(riderEnd, ghoulEnd) ?: continue
            best = min(best, riderCost + cells + ghoulCost)
        }
        return best
    }

    private fun sameEdgeDistance(): Float? {
        if (riderCell == ghoul.cell && heading == ghoul.heading) return abs(progress - ghoul.progress)
        if (riderCell == ghoul.cell.moved(ghoul.heading) && heading == ghoul.heading.opposite) {
            return abs(progress - (1f - ghoul.progress))
        }
        return null
    }

    private fun edgeEndpoints(cell: MazeCell, direction: MazeDirection, edgeProgress: Float): List<Pair<MazeCell, Float>> {
        val next = cell.moved(direction)
        return if (world.contains(next) && world.isOpen(cell, direction)) {
            listOf(cell to edgeProgress, next to 1f - edgeProgress)
        } else {
            listOf(cell to 0f)
        }
    }

    fun isExplored(row: Int, col: Int): Boolean =
        row in 0 until world.tileRows && col in 0 until world.tileCols && exploredGrid[row * world.tileCols + col]

    /** Marks tiles within the lamp radius explored; allocation-free unless a tile is new (the console runs interpreted). */
    private fun reveal() {
        val radius = lightRadius
        if (radius <= 0f) return
        val rr = riderRow
        val rc = riderCol
        if (rr == revealRow && rc == revealCol && radius <= revealRadius) return
        revealRow = rr
        revealCol = rc
        revealRadius = radius
        val rows = world.tileRows
        val cols = world.tileCols
        val r2 = radius * radius
        val minRow = max(0, (2f * (rr - radius) + 1f).toInt() - 1)
        val maxRow = min(rows - 1, (2f * (rr + radius) + 1f).toInt() + 1)
        val minCol = max(0, (2f * (rc - radius) + 1f).toInt() - 1)
        val maxCol = min(cols - 1, (2f * (rc + radius) + 1f).toInt() + 1)
        for (row in minRow..maxRow) {
            val dr = (row - 1) / 2f - rr
            val dr2 = dr * dr
            if (dr2 > r2) continue
            for (col in minCol..maxCol) {
                val dc = (col - 1) / 2f - rc
                if (dr2 + dc * dc > r2) continue
                val index = row * cols + col
                if (!exploredGrid[index]) {
                    exploredGrid[index] = true
                    exploredTiles += MazeTile(row, col)
                }
            }
        }
    }

    fun tileDistance(tile: MazeTile): Float = hypot((tile.row - 1) / 2f - riderRow, (tile.col - 1) / 2f - riderCol)

    private fun currentNearestCell(): MazeCell = if (progress < 0.5f) riderCell else riderCell.moved(heading)

    private fun ghoulNearestCell(): MazeCell = if (ghoul.progress < 0.5f) ghoul.cell else ghoul.cell.moved(ghoul.heading)

    private fun directionBetween(from: MazeCell, to: MazeCell): MazeDirection =
        MazeDirection.entries.first { from.moved(it) == to }

    private fun resetMaze(newSeed: Long, resetCatches: Boolean) {
        seed = newSeed
        world.reset(seed)
        rng = Random(seed xor GHOUL_RANDOM_SALT)
        collectedKeys.clear()
        exploredTiles.clear()
        exploredGrid.fill(false)
        revealRow = Float.NaN
        shrineCooldowns.clear()
        world.shrines.forEach { shrineCooldowns[it] = 0f }
        riderCell = world.start
        heading = headingTowardExit(riderCell)
        progress = 0f
        lane = GhoulLane.Center
        lean = 0f
        lockedChoice = null
        brakingForChoice = false
        waitingForChoice = false
        turningLeft = 0f
        speed = 0f
        targetSpeed = 0f
        lightRadius = 0f
        noiseRadius = 0f
        quietFor = 0f
        elapsed = 0f
        hearts = config.startingHearts
        invulnerableLeft = 0f
        checkpoint = world.start
        phase = GhoulPhase.WarmUp
        phaseLeft = 0f
        results = null
        catchEvent = null
        respawnLeft = 0f
        warmupTime = 0f
        leanCheckStep = 0
        leanCheckHeld = 0f
        leanCheckConfirmLeft = 0f
        if (resetCatches) catches = 0
        ghoul = GhoulMonster(world.monsterSpawn)
        resetGhoul(active = false)
        exploredTiles += MazeTile(1, 1)
        exploredGrid[world.tileCols + 1] = true
        resetClock()
    }

    private fun resetGhoul(active: Boolean) {
        val first = world.exits(ghoul.spawn).firstOrNull() ?: MazeDirection.East
        ghoul.reset(first, active)
    }

    /** Carries a passed lean check over to a replacement game (e.g. a difficulty change). */
    fun markLeanCheckPassed() {
        leanCheckPassed = true
    }

    private fun beginCalibratedRun() {
        leanCheckPassed = true
        phase = GhoulPhase.Playing
        phaseLeft = 0f
        collectedKeys.clear()
        respawnLeft = 0f
        riderCell = world.start
        heading = headingTowardExit(riderCell)
        progress = 0f
        lockedChoice = null
        brakingForChoice = false
        waitingForChoice = false
        turningLeft = 0f
        elapsed = 0f
        quietFor = 0f
        checkpoint = world.start
        shrineCooldowns.keys.forEach { shrineCooldowns[it] = 0f }
        resetGhoul(active = true)
    }

    private fun headingTowardExit(cell: MazeCell): MazeDirection {
        val path = world.shortestPath(cell, world.exit)
        return if (path.size >= 2) directionBetween(path[0], path[1]) else world.exits(cell).firstOrNull() ?: MazeDirection.East
    }

    private fun lerp(a: Float, b: Float, t: Float): Float = a + (b - a) * t

    private companion object {
        const val GHOUL_RANDOM_SALT: Long = 0x47484F554CL
        const val SHRINE_HINT_CELLS = 3f
        const val STEALTH_MAX_SPEED = 0.06f
        val LEAN_CHECK_ORDER = listOf(GhoulLane.Left, GhoulLane.Right, GhoulLane.Center)
    }
}
