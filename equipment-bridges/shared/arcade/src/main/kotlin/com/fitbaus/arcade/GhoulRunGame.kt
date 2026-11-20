// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

internal enum class GhoulLane { ScreenLeft, Center, ScreenRight }
internal enum class GhoulPhase { WarmUp, Playing, Results, Countdown }
internal enum class GhoulState { Inactive, Wandering, Hunting, Searching, Stunned }

internal data class GhoulResults(val seconds: Float, val catches: Int, val keys: Int)

internal class GhoulMonster(val spawn: MazeCell) {
    var cell: MazeCell = spawn
    var heading: MazeDirection = MazeDirection.East
    var progress: Float = 0f
    var state: GhoulState = GhoulState.Inactive
    var speed: Float = 0f
    var contactLostFor: Float = 0f
    var searchWaitLeft: Float = 0f
    var stunLeft: Float = 0f
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

    private var accumulator = 0f
    private var lastFrameNanos = Long.MIN_VALUE
    private var hardLeanFor = 0f
    private var rng = Random(seed xor GHOUL_RANDOM_SALT)

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
            return lockedChoice ?: choiceFor(junction, heading, lane) ?: compassChoice(junction, heading)
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
            phase = GhoulPhase.WarmUp
            ghoul.state = GhoulState.Inactive
            ghoul.speed = 0f
            val cruiseFactor = config.baselineCreepDelta / (config.baselineCreepDelta + config.sprintDelta)
            lightRadius = lerp(config.creepLightRadius, config.sprintLightRadius, cruiseFactor)
            noiseRadius = lerp(config.creepNoiseRadius, config.sprintNoiseRadius, cruiseFactor)
            targetSpeed = config.cruiseSpeed
            speed += (targetSpeed - speed) * min(1f, config.speedResponse * dt)
            handleHardLean(dt)
            moveRider(dt)
            reveal()
            return
        }

        if (phase == GhoulPhase.WarmUp) {
            beginCalibratedRun()
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
        handleHardLean(dt)
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
        if (phase == GhoulPhase.Playing) updateGhoul(dt)
    }

    /** Direction selected at [cell] for a screen-side selection while arriving along [arrivalHeading]. */
    fun choiceFor(cell: MazeCell, arrivalHeading: MazeDirection, lane: GhoulLane): MazeDirection? {
        val allowed = world.exits(cell).filter { it != arrivalHeading.opposite }
        if (allowed.isEmpty()) return arrivalHeading.opposite
        if (allowed.size == 1) return allowed[0]
        val straight = arrivalHeading.takeIf { it in allowed }
        if (lane == GhoulLane.Center) return straight
        val side = if (lane == GhoulLane.ScreenLeft) ScreenSide.Left else ScreenSide.Right
        val turn = world.screenTurn(arrivalHeading, side)
        if (turn in allowed) return turn
        return straight
    }

    fun compassChoice(cell: MazeCell, arrivalHeading: MazeDirection): MazeDirection {
        val allowed = world.exits(cell).filter { it != arrivalHeading.opposite }.ifEmpty { listOf(arrivalHeading.opposite) }
        return allowed.minWith(
            compareBy<MazeDirection> { direction ->
                val next = cell.moved(direction)
                val dr = next.row - world.exit.row
                val dc = next.col - world.exit.col
                dr * dr + dc * dc
            }.thenBy { if (it == arrivalHeading) 0 else 1 }.thenBy { it.ordinal },
        )
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
    }

    internal fun placeRider(cell: MazeCell, direction: MazeDirection, edgeProgress: Float = 0f) {
        require(world.contains(cell))
        riderCell = cell
        heading = direction
        progress = edgeProgress.coerceIn(0f, 0.999f)
        lockedChoice = null
        brakingForChoice = false
        turningLeft = 0f
    }

    internal fun visitForTest(cell: MazeCell) = visitCell(cell)

    fun restart(newSeed: Long = seed + 1L) = resetMaze(newSeed, resetCatches = true)

    private fun moveRider(dt: Float) {
        if (!world.isOpen(riderCell, heading)) {
            beginDeadEndTurn()
            return
        }
        val junction = riderCell.moved(heading)
        if (progress >= 1f - config.junctionLockDistance && lockedChoice == null && !brakingForChoice) {
            val next = choiceFor(junction, heading, lane)
            if (next == null) {
                brakingForChoice = true
            } else {
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
        val choice = lockedChoice ?: choiceFor(riderCell, heading, lane) ?: compassChoice(riderCell, heading)
        lockedChoice = null
        brakingForChoice = false
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

    private fun handleHardLean(dt: Float) {
        if (abs(lean) >= config.hardLeanThreshold) hardLeanFor += dt else hardLeanFor = 0f
        if (hardLeanFor >= config.hardLeanSeconds) {
            hardLeanFor = 0f
            reverseOnSegment()
        }
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

        val gap = pathGap
        val riderTarget = currentNearestCell()
        val heard = gap <= noiseRadius
        val seen = gap <= lightRadius + 1f && world.hasLineOfSight(ghoulNearestCell(), riderTarget)
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
        if (ghoul.state != GhoulState.Stunned && invulnerableLeft <= 0f && pathGap <= config.catchDistance) catchRider()
    }

    private fun beginHunt(target: MazeCell) {
        ghoul.state = GhoulState.Hunting
        ghoul.lastKnown = target
        ghoul.contactLostFor = 0f
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
            hearts = config.startingHearts
            riderCell = checkpoint
            progress = 0f
            heading = headingTowardExit(riderCell)
            lockedChoice = null
            brakingForChoice = false
            resetGhoul(active = true)
            return
        }
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

    private fun stunGhoul(seconds: Float) {
        ghoul.state = GhoulState.Stunned
        ghoul.speed = 0f
        ghoul.stunLeft = max(ghoul.stunLeft, seconds)
        ghoul.contactLostFor = 0f
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

    private fun reveal() {
        if (lightRadius <= 0f) return
        for (row in 0 until world.tileRows) for (col in 0 until world.tileCols) {
            val tile = MazeTile(row, col)
            if (tileDistance(tile) <= lightRadius) exploredTiles += tile
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
        shrineCooldowns.clear()
        world.shrines.forEach { shrineCooldowns[it] = 0f }
        riderCell = world.start
        heading = headingTowardExit(riderCell)
        progress = 0f
        lane = GhoulLane.Center
        lean = 0f
        lockedChoice = null
        brakingForChoice = false
        turningLeft = 0f
        speed = 0f
        targetSpeed = 0f
        lightRadius = 0f
        noiseRadius = 0f
        elapsed = 0f
        hearts = config.startingHearts
        invulnerableLeft = 0f
        checkpoint = world.start
        phase = GhoulPhase.WarmUp
        phaseLeft = 0f
        results = null
        hardLeanFor = 0f
        if (resetCatches) catches = 0
        ghoul = GhoulMonster(world.monsterSpawn)
        resetGhoul(active = false)
        exploredTiles += MazeTile(1, 1)
        resetClock()
    }

    private fun resetGhoul(active: Boolean) {
        val first = world.exits(ghoul.spawn).firstOrNull() ?: MazeDirection.East
        ghoul.reset(first, active)
    }

    private fun beginCalibratedRun() {
        phase = GhoulPhase.Playing
        collectedKeys.clear()
        exploredTiles.clear()
        riderCell = world.start
        heading = headingTowardExit(riderCell)
        progress = 0f
        lockedChoice = null
        brakingForChoice = false
        turningLeft = 0f
        elapsed = 0f
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
    }
}
