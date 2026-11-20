// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

internal enum class GhoulLane { ScreenLeft, Center, ScreenRight }
internal enum class GhoulPhase { Playing, BreakFree, Results, Countdown }
internal enum class HoundState { Sleeping, Warning, Burst, Tired, Patrol }
internal enum class MonsterState { Inactive, Tracking, Warning, Burst, Tired, Patrol, Lunging }

internal data class GhoulResults(val seconds: Float, val catches: Int, val keys: Int)

internal class GhoulMonster(
    val kind: GhoulMonsterKind,
    val spawn: MazeCell,
) {
    var cell: MazeCell = spawn
    var row: Float = spawn.row.toFloat()
    var col: Float = spawn.col.toFloat()
    var state: MonsterState = MonsterState.Inactive
    var houndState: HoundState = HoundState.Sleeping
    var stateLeft: Float = 0f
    var loseFor: Float = 0f
    var moveCredit: Float = 0f
    var speed: Float = 0f
    var lungeLeft: Float = 0f
    var lungeCooldown: Float = 0f
    var lungeLane: GhoulLane = GhoulLane.Center
    var trackIndex: Int = 0
    var lungeDodges: Int = 0
    var lungeHits: Int = 0

    fun reset() {
        cell = spawn
        row = spawn.row.toFloat()
        col = spawn.col.toFloat()
        state = MonsterState.Inactive
        houndState = HoundState.Sleeping
        stateLeft = 0f
        loseFor = 0f
        moveCredit = 0f
        speed = 0f
        lungeLeft = 0f
        lungeCooldown = 0f
        lungeLane = GhoulLane.Center
        trackIndex = 0
        lungeDodges = 0
        lungeHits = 0
    }
}

/** Pure fixed-step GHOUL RUN simulation. Coordinates are maze-cell centres and one edge is one tile. */
internal class GhoulRunGame(
    val config: GhoulRunConfig = GhoulRunConfig(),
    seed: Long = 1L,
) {
    val world = GhoulRunWorld(config, seed)
    val monsters = ArrayList<GhoulMonster>()
    val collectedKeys = LinkedHashSet<MazeCell>()
    val explored = LinkedHashSet<MazeCell>()
    val riderTrail = ArrayList<MazeCell>()

    var phase: GhoulPhase = GhoulPhase.Playing
        private set
    var riderCell: MazeCell = world.start
        private set
    var heading: MazeDirection = MazeDirection.East
        private set
    var progress: Float = 0f
        private set
    var lane: GhoulLane = GhoulLane.Center
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
    var breakFreeProgress: Float = 0f
        private set
    var invulnerableLeft: Float = 0f
        private set
    var shrineProtectionLeft: Float = 0f
        private set
    var activeShrine: MazeCell? = null
        private set
    var checkpoint: MazeCell = world.start
        private set
    var results: GhoulResults? = null
        private set
    var phaseLeft: Float = 0f
        private set
    var lastLungeDodged: Boolean = false
        private set
    var seed: Long = seed
        private set

    private var accumulator = 0f
    private var lastFrameNanos = Long.MIN_VALUE
    private var hardLeanFor = 0f

    init { resetMaze(seed, keepStats = false) }

    val keysFound: Int get() = collectedKeys.size
    val exitOpen: Boolean get() = keysFound == config.keyCount
    val riderRow: Float get() = riderCell.row + heading.dr * progress
    val riderCol: Float get() = riderCell.col + heading.dc * progress
    val lampLevel: Float get() = if (config.sprintLightRadius == 0f) 0f else lightRadius / config.sprintLightRadius
    val inShrine: Boolean get() = activeShrine == currentNearestCell() && shrineProtectionLeft > 0f

    fun speedFor(rpm: Float, baseline: Float): Float {
        if (rpm <= 0f || baseline.isNaN()) return 0f
        if (rpm <= baseline) {
            val t = ((rpm - (baseline - config.baselineCreepDelta)) / config.baselineCreepDelta).coerceIn(0f, 1f)
            return lerp(config.creepSpeed, config.cruiseSpeed, t)
        }
        val t = ((rpm - baseline) / config.sprintDelta).coerceIn(0f, 1f)
        return lerp(config.cruiseSpeed, config.sprintSpeed, t)
    }

    fun radiiFor(rpm: Float, baseline: Float): Pair<Float, Float> {
        if (rpm <= 0f || baseline.isNaN()) return 0f to 0f
        val t = ((rpm - (baseline - config.baselineCreepDelta)) / (config.baselineCreepDelta + config.sprintDelta)).coerceIn(0f, 1f)
        return lerp(config.creepLightRadius, config.sprintLightRadius, t) to
            lerp(config.creepNoiseRadius, config.sprintNoiseRadius, t)
    }

    fun resetClock() {
        lastFrameNanos = Long.MIN_VALUE
        accumulator = 0f
    }

    fun advance(nowNanos: Long, lane: GhoulLane, lean: Float, rpm: Float, baseline: Float): Int {
        if (lastFrameNanos == Long.MIN_VALUE) {
            lastFrameNanos = nowNanos
            return 0
        }
        val frame = ((nowNanos - lastFrameNanos) / 1_000_000_000f).coerceIn(0f, config.maxFrame)
        lastFrameNanos = nowNanos
        accumulator += frame
        var steps = 0
        while (accumulator >= config.step) {
            step(config.step, lane, lean, rpm, baseline)
            accumulator -= config.step
            steps += 1
        }
        return steps
    }

    fun step(dt: Float, requestedLane: GhoulLane, lean: Float, rpm: Float, baseline: Float) {
        lane = requestedLane
        when (phase) {
            GhoulPhase.Results -> {
                phaseLeft -= dt
                if (phaseLeft <= 0f) { phase = GhoulPhase.Countdown; phaseLeft = config.restartCountdownSeconds }
                return
            }
            GhoulPhase.Countdown -> {
                phaseLeft -= dt
                if (phaseLeft <= 0f) resetMaze(seed + 1L, keepStats = false)
                return
            }
            else -> Unit
        }
        elapsed += dt
        invulnerableLeft = (invulnerableLeft - dt).coerceAtLeast(0f)
        shrineProtectionLeft = (shrineProtectionLeft - dt).coerceAtLeast(0f)
        val radii = radiiFor(rpm, baseline)
        lightRadius = radii.first
        noiseRadius = radii.second
        reveal()
        if (phase == GhoulPhase.BreakFree) {
            speed = 0f
            if (!baseline.isNaN() && rpm > baseline) breakFreeProgress += dt
            if (breakFreeProgress >= config.breakFreeSeconds) {
                phase = GhoulPhase.Playing
                invulnerableLeft = config.invulnerabilitySeconds
                breakFreeProgress = config.breakFreeSeconds
            }
            return
        }
        handleHardLean(dt, lean)
        if (turningLeft > 0f) {
            turningLeft -= dt
            speed = 0f
            if (turningLeft <= 0f) reverseOnSegment()
        } else {
            targetSpeed = speedFor(rpm, baseline)
            speed += (targetSpeed - speed) * min(1f, config.speedResponse * dt)
            moveRider(dt)
        }
        if (!baseline.isNaN()) updateMonsters(dt)
    }

    /** Direction selected at [cell] for a lane while arriving along [arrivalHeading]. */
    fun choiceFor(cell: MazeCell, arrivalHeading: MazeDirection, lane: GhoulLane): MazeDirection? {
        val allowed = world.exits(cell).filter { it != arrivalHeading.opposite }
        if (allowed.isEmpty()) return arrivalHeading.opposite
        if (allowed.size == 1) return allowed[0]
        val straight = arrivalHeading.takeIf { it in allowed }
        if (lane == GhoulLane.Center) return straight
        val side = if (lane == GhoulLane.ScreenLeft) ScreenSide.Left else ScreenSide.Right
        val turn = world.screenTurn(arrivalHeading, side)
        if (turn in allowed) return turn
        // At a T with one turn, leaning away from that turn is an explicit straight selection.
        return straight
    }

    fun choiceLocked(): Boolean = lockedChoice != null || brakingForChoice

    fun nearestPursuerGap(): Float? = monsters.filter { it.state != MonsterState.Inactive && it.state != MonsterState.Patrol }
        .minOfOrNull { monsterDistance(it) }

    fun forceCatch() = catchRider()

    fun forceMonsterCell(index: Int, cell: MazeCell, state: MonsterState = MonsterState.Tracking) {
        val monster = monsters[index]
        monster.cell = cell
        monster.row = cell.row.toFloat()
        monster.col = cell.col.toFloat()
        monster.state = state
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

    fun restart(newSeed: Long = seed + 1L) = resetMaze(newSeed, keepStats = false)

    private fun moveRider(dt: Float) {
        if (!world.isOpen(riderCell, heading)) {
            beginDeadEndTurn()
            return
        }
        val junction = riderCell.moved(heading)
        if (progress >= 1f - config.junctionLockDistance && lockedChoice == null) {
            val next = choiceFor(junction, heading, lane)
            if (next == null) {
                brakingForChoice = true
                speed = 0f
                return
            }
            lockedChoice = next
            brakingForChoice = false
        }
        if (brakingForChoice) {
            val next = choiceFor(junction, heading, lane)
            if (next == null) { speed = 0f; return }
            lockedChoice = next
            brakingForChoice = false
        }
        progress += speed * dt
        while (progress >= 1f && phase == GhoulPhase.Playing) {
            progress -= 1f
            riderCell = junction
            if (riderTrail.lastOrNull() != riderCell) riderTrail += riderCell
            visitCell(riderCell)
            if (phase != GhoulPhase.Playing) return
            val choice = lockedChoice ?: choiceFor(riderCell, heading, lane)
            lockedChoice = null
            brakingForChoice = false
            if (choice == null) {
                progress = 0f
                speed = 0f
                brakingForChoice = true
                return
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
                return
            }
        }
    }

    private fun visitCell(cell: MazeCell) {
        if (cell in world.keys) collectedKeys += cell
        if (cell in world.shrines && cell != activeShrine) {
            activeShrine = cell
            checkpoint = cell
            shrineProtectionLeft = config.shrineProtectionSeconds
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

    private fun handleHardLean(dt: Float, lean: Float) {
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

    private fun updateMonsters(dt: Float) {
        for ((index, monster) in monsters.withIndex()) {
            when (monster.kind) {
                GhoulMonsterKind.Ghoul -> updateGhoul(monster, dt)
                GhoulMonsterKind.Hound -> updateHound(monster, dt)
                GhoulMonsterKind.Wraith -> updateWraith(monster, dt)
            }
            updateLunge(monster, index, dt)
        }
    }

    private fun updateGhoul(monster: GhoulMonster, dt: Float) {
        monster.state = MonsterState.Tracking
        monster.speed = config.cruiseSpeed * config.ghoulSpeedRatio
        val target = riderTrail.getOrNull(monster.trackIndex) ?: riderCell
        moveGraphMonster(monster, target, dt)
        if (monster.cell == target && monster.trackIndex < riderTrail.lastIndex) monster.trackIndex += 1
    }

    private fun updateHound(monster: GhoulMonster, dt: Float) {
        val distance = monsterDistance(monster)
        val sees = world.hasLineOfSight(monster.cell, currentNearestCell())
        when (monster.houndState) {
            HoundState.Sleeping, HoundState.Patrol -> if (!inShrine && (distance <= noiseRadius || sees)) {
                monster.houndState = HoundState.Warning
                monster.state = MonsterState.Warning
                monster.stateLeft = config.houndWarningSeconds
            }
            HoundState.Warning -> {
                monster.state = MonsterState.Warning
                monster.stateLeft -= dt
                if (monster.stateLeft <= 0f) {
                    monster.houndState = HoundState.Burst
                    monster.state = MonsterState.Burst
                    monster.stateLeft = config.houndBurstSeconds
                }
            }
            HoundState.Burst -> {
                monster.state = MonsterState.Burst
                monster.stateLeft -= dt
                if (!sees && distance > config.loseTrackGap) monster.loseFor += dt else monster.loseFor = 0f
                if (monster.loseFor >= config.loseTrackSeconds || monster.stateLeft <= 0f) {
                    monster.houndState = HoundState.Tired
                    monster.state = MonsterState.Tired
                    monster.stateLeft = config.houndTiredSeconds
                }
            }
            HoundState.Tired -> {
                monster.state = MonsterState.Tired
                monster.stateLeft -= dt
                if (monster.stateLeft <= 0f) {
                    monster.houndState = HoundState.Patrol
                    monster.state = MonsterState.Patrol
                }
            }
        }
        monster.speed = when (monster.houndState) {
            HoundState.Burst -> config.cruiseSpeed * config.houndBurstRatio
            HoundState.Tired -> config.cruiseSpeed * config.houndTiredRatio
            HoundState.Patrol -> config.cruiseSpeed * config.houndPatrolRatio
            else -> 0f
        }
        if (monster.speed > 0f) moveGraphMonster(monster, currentNearestCell(), dt)
    }

    private fun updateWraith(monster: GhoulMonster, dt: Float) {
        monster.state = MonsterState.Tracking
        monster.speed = config.cruiseSpeed * config.wraithSpeedRatio
        if (inShrine) {
            monster.speed = 0f
            return
        }
        val dr = riderRow - monster.row
        val dc = riderCol - monster.col
        val distance = hypot(dr, dc)
        if (distance > 0.0001f) {
            val move = min(distance, monster.speed * dt)
            val nextRow = monster.row + dr / distance * move
            val nextCol = monster.col + dc / distance * move
            if (world.shrines.any { hypot(it.row - nextRow, it.col - nextCol) < 0.45f }) return
            monster.row = nextRow
            monster.col = nextCol
            monster.cell = MazeCell(monster.row.toInt().coerceIn(0, config.height - 1), monster.col.toInt().coerceIn(0, config.width - 1))
        }
    }

    private fun moveGraphMonster(monster: GhoulMonster, target: MazeCell, dt: Float) {
        monster.moveCredit += monster.speed * dt
        while (monster.moveCredit >= 1f && monster.cell != target) {
            val path = world.shortestPath(monster.cell, target)
            if (path.size < 2) break
            val next = path[1]
            if (next in world.shrines) break
            monster.cell = next
            monster.row = next.row.toFloat()
            monster.col = next.col.toFloat()
            monster.moveCredit -= 1f
        }
    }

    private fun updateLunge(monster: GhoulMonster, index: Int, dt: Float) {
        monster.lungeCooldown = (monster.lungeCooldown - dt).coerceAtLeast(0f)
        if (inShrine || invulnerableLeft > 0f || phase != GhoulPhase.Playing) {
            monster.lungeLeft = 0f
            return
        }
        if (monster.lungeLeft > 0f) {
            monster.lungeLeft -= dt
            monster.state = MonsterState.Lunging
            if (monster.lungeLeft <= 0f) {
                if (lane == monster.lungeLane) {
                    monster.lungeHits += 1
                    catchRider()
                } else {
                    monster.lungeDodges += 1
                    lastLungeDodged = true
                }
                monster.lungeCooldown = config.lungeCooldownSeconds
            }
            return
        }
        if (monster.lungeCooldown <= 0f && monster.state != MonsterState.Inactive && monster.state != MonsterState.Warning && monsterDistance(monster) <= config.lungeDistance) {
            monster.lungeLane = GhoulLane.entries[(index + catches) % GhoulLane.entries.size]
            monster.lungeLeft = config.lungeWarningSeconds
            lastLungeDodged = false
        }
    }

    private fun catchRider() {
        if (phase != GhoulPhase.Playing || invulnerableLeft > 0f || inShrine) return
        catches += 1
        hearts -= 1
        speed = 0f
        if (hearts <= 0) {
            hearts = config.startingHearts
            riderCell = checkpoint
            progress = 0f
            heading = world.exits(riderCell).firstOrNull() ?: MazeDirection.East
            resetMonsters()
            invulnerableLeft = config.invulnerabilitySeconds
            phase = GhoulPhase.Playing
        } else {
            phase = GhoulPhase.BreakFree
            breakFreeProgress = 0f
        }
    }

    private fun reveal() {
        if (lightRadius <= 0f) return
        val r = lightRadius.toInt() + 1
        val centre = currentNearestCell()
        for (row in max(0, centre.row - r)..min(config.height - 1, centre.row + r)) {
            for (col in max(0, centre.col - r)..min(config.width - 1, centre.col + r)) {
                if (hypot((row - riderRow), (col - riderCol)) <= lightRadius) explored += MazeCell(row, col)
            }
        }
    }

    private fun monsterDistance(monster: GhoulMonster): Float = hypot(monster.row - riderRow, monster.col - riderCol)

    private fun currentNearestCell(): MazeCell = if (progress < 0.5f) riderCell else riderCell.moved(heading)

    private fun resetMaze(newSeed: Long, keepStats: Boolean) {
        seed = newSeed
        world.reset(seed)
        collectedKeys.clear()
        explored.clear()
        riderTrail.clear()
        riderCell = world.start
        heading = world.exits(riderCell).firstOrNull() ?: MazeDirection.East
        progress = 0f
        lane = GhoulLane.Center
        lockedChoice = null
        brakingForChoice = false
        turningLeft = 0f
        speed = 0f
        targetSpeed = 0f
        lightRadius = 0f
        noiseRadius = 0f
        elapsed = 0f
        hearts = config.startingHearts
        breakFreeProgress = 0f
        invulnerableLeft = 0f
        shrineProtectionLeft = 0f
        activeShrine = null
        checkpoint = world.start
        phase = GhoulPhase.Playing
        phaseLeft = 0f
        results = null
        lastLungeDodged = false
        hardLeanFor = 0f
        if (!keepStats) catches = 0
        riderTrail += riderCell
        monsters.clear()
        world.monsterSpawns.forEach { monsters += GhoulMonster(it.kind, it.cell) }
        explored += riderCell
        resetClock()
    }

    private fun resetMonsters() = monsters.forEach { it.reset() }

    private fun lerp(a: Float, b: Float, t: Float): Float = a + (b - a) * t
}
