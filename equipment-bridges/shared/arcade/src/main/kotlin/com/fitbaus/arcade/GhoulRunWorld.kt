// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.abs
import kotlin.random.Random

/** Every gameplay tuning value for GHOUL RUN lives here. */
internal data class GhoulRunConfig(
    val width: Int = 11,
    val height: Int = 11,
    val extraWallRemoval: Float = 0.25f,
    val keyCount: Int = 0,
    val shrineMin: Int = 2,
    val shrineMax: Int = 3,
    val monsterSpawnMinDistance: Int = 7,
    val leanEnter: Float = 0.35f,
    val leanExit: Float = 0.20f,
    val junctionLockDistance: Float = 0.5f,
    val deadEndTurnSeconds: Float = 0.6f,
    val leanCheckHoldSeconds: Float = 0.5f,
    val leanCheckConfirmSeconds: Float = 0.4f,
    val leanCheckGoSeconds: Float = 1f,
    val warmupSeconds: Float = 25f,
    val baselineWindowSeconds: Float = 15f,
    val stoppedBelowRpm: Float = 20f,
    val baselineCreepDelta: Float = 15f,
    val creepSpeed: Float = 0.5f,
    val cruiseSpeed: Float = 1.25f,
    val sprintSpeed: Float = 2f,
    val sprintDelta: Float = 20f,
    val speedResponse: Float = 4f,
    val creepLightRadius: Float = 3f,
    val sprintLightRadius: Float = 6f,
    val creepNoiseRadius: Float = 2f,
    val sprintNoiseRadius: Float = 8f,
    val wanderSpeedRatio: Float = 0.6f,
    val huntSpeedRatio: Float = 1.15f,
    val searchSpeedRatio: Float = 0.9f,
    val loseContactSeconds: Float = 2f,
    val searchWaitSeconds: Float = 3f,
    val catchDistance: Float = 0.35f,
    val catchKnockbackTiles: Int = 4,
    val catchStunSeconds: Float = 3f,
    val invulnerabilitySeconds: Float = 3f,
    val respawnSeconds: Float = 1.6f,
    val startingHearts: Int = 3,
    val shrinePulseRadius: Float = 5f,
    val shrineStunSeconds: Float = 6f,
    val shrineRechargeSeconds: Float = 45f,
    val resultsSeconds: Float = 2.5f,
    val restartCountdownSeconds: Float = 3f,
    val step: Float = 1f / 60f,
    val maxFrame: Float = 0.1f,
) {
    init {
        require(width >= 5 && height >= 5 && width % 2 == 1 && height % 2 == 1)
        require(extraWallRemoval in 0f..0.5f)
        require(keyCount >= 0 && shrineMin > 0 && shrineMax >= shrineMin)
        require(monsterSpawnMinDistance > 0)
        require(leanExit > 0f && leanEnter > leanExit && leanEnter < 1f && junctionLockDistance in 0f..1f)
        require(deadEndTurnSeconds > 0f && leanCheckHoldSeconds > 0f && leanCheckConfirmSeconds >= 0f && leanCheckGoSeconds > 0f)
        require(warmupSeconds > baselineWindowSeconds && baselineWindowSeconds > 0f && stoppedBelowRpm > 0f)
        require(baselineCreepDelta > 0f && creepSpeed > 0f && cruiseSpeed > creepSpeed && sprintSpeed > cruiseSpeed)
        require(sprintDelta > 0f && speedResponse > 0f)
        require(creepLightRadius > 0f && sprintLightRadius >= creepLightRadius)
        require(creepNoiseRadius > 0f && sprintNoiseRadius >= creepNoiseRadius)
        require(wanderSpeedRatio > 0f && searchSpeedRatio > wanderSpeedRatio && huntSpeedRatio > 1f)
        require(cruiseSpeed * huntSpeedRatio < sprintSpeed) { "sprinting must outrun the Ghoul" }
        require(loseContactSeconds > 0f && searchWaitSeconds > 0f && catchDistance in 0f..1f)
        require(catchKnockbackTiles > 0 && catchStunSeconds > 0f && invulnerabilitySeconds >= catchStunSeconds)
        require(respawnSeconds >= 0f && respawnSeconds < invulnerabilitySeconds)
        require(startingHearts > 0 && shrinePulseRadius > 0f && shrineStunSeconds > 0f && shrineRechargeSeconds > 0f)
        require(resultsSeconds > 0f && restartCountdownSeconds > 0f)
        require(step > 0f && maxFrame >= step)
    }
}

internal data class MazeCell(val row: Int, val col: Int) {
    fun moved(direction: MazeDirection): MazeCell = MazeCell(row + direction.dr, col + direction.dc)
    fun manhattan(other: MazeCell): Int = abs(row - other.row) + abs(col - other.col)
}

internal data class MazeTile(val row: Int, val col: Int)

internal enum class MazeDirection(val dr: Int, val dc: Int, val bit: Int) {
    North(-1, 0, 1), East(0, 1, 2), South(1, 0, 4), West(0, -1, 8);

    val opposite: MazeDirection get() = entries[(ordinal + 2) % 4]
    val relativeLeft: MazeDirection get() = entries[(ordinal + 3) % 4]
    val relativeRight: MazeDirection get() = entries[(ordinal + 1) % 4]
}

/** Seeded perfect maze with deterministic loop opening and objective placement. */
internal class GhoulRunWorld(val config: GhoulRunConfig = GhoulRunConfig(), seed: Long = 1L) {
    var seed: Long = seed
        private set
    private var openings = IntArray(config.width * config.height)
    private var allDistances: Array<IntArray>? = null
    var start: MazeCell = MazeCell(0, 0)
        private set
    var exit: MazeCell = start
        private set
    var keys: List<MazeCell> = emptyList()
        private set
    var shrines: List<MazeCell> = emptyList()
        private set
    var monsterSpawn: MazeCell = start
        private set

    val tileRows: Int get() = config.height * 2 + 1
    val tileCols: Int get() = config.width * 2 + 1

    init { generate(seed) }

    fun reset(seed: Long) = generate(seed)

    fun contains(cell: MazeCell): Boolean = cell.row in 0 until config.height && cell.col in 0 until config.width

    fun isOpen(cell: MazeCell, direction: MazeDirection): Boolean = contains(cell) && openings[index(cell)] and direction.bit != 0

    fun exits(cell: MazeCell): List<MazeDirection> = MazeDirection.entries.filter { isOpen(cell, it) }

    fun neighbor(cell: MazeCell, direction: MazeDirection): MazeCell? = cell.moved(direction).takeIf(::contains)

    fun distancesFrom(origin: MazeCell): Map<MazeCell, Int> {
        val distance = LinkedHashMap<MazeCell, Int>()
        val queue = ArrayDeque<MazeCell>()
        distance[origin] = 0
        queue.add(origin)
        while (queue.isNotEmpty()) {
            val cell = queue.removeFirst()
            val nextDistance = distance.getValue(cell) + 1
            for (direction in exits(cell)) {
                val next = cell.moved(direction)
                if (distance.putIfAbsent(next, nextDistance) == null) queue.add(next)
            }
        }
        return distance
    }

    fun pathDistance(from: MazeCell, to: MazeCell): Int? {
        if (!contains(from) || !contains(to)) return null
        val cached = allDistances ?: return distancesFrom(from)[to]
        return cached[index(from)][index(to)].takeIf { it >= 0 }
    }

    /** Cached path distance between cell indices (row * width + col); -1 when unreachable. */
    fun pathDistanceIndex(from: Int, to: Int): Int {
        val cached = allDistances ?: return pathDistance(
            MazeCell(from / config.width, from % config.width),
            MazeCell(to / config.width, to % config.width),
        ) ?: -1
        return cached[from][to]
    }

    fun shortestPath(from: MazeCell, to: MazeCell): List<MazeCell> {
        if (from == to) return listOf(from)
        val previous = HashMap<MazeCell, MazeCell>()
        val queue = ArrayDeque<MazeCell>()
        previous[from] = from
        queue.add(from)
        while (queue.isNotEmpty()) {
            val cell = queue.removeFirst()
            for (direction in exits(cell)) {
                val next = cell.moved(direction)
                if (previous.putIfAbsent(next, cell) != null) continue
                if (next == to) {
                    val path = ArrayList<MazeCell>()
                    var at = to
                    while (at != from) {
                        path += at
                        at = previous.getValue(at)
                    }
                    path += from
                    path.reverse()
                    return path
                }
                queue.add(next)
            }
        }
        return emptyList()
    }

    fun hasLineOfSight(from: MazeCell, to: MazeCell): Boolean {
        if (from.row != to.row && from.col != to.col) return false
        if (from == to) return true
        val direction = when {
            from.row == to.row && to.col > from.col -> MazeDirection.East
            from.row == to.row -> MazeDirection.West
            to.row > from.row -> MazeDirection.South
            else -> MazeDirection.North
        }
        var at = from
        while (at != to) {
            if (!isOpen(at, direction)) return false
            at = at.moved(direction)
        }
        return true
    }

    /** Floor/wall lookup for the expanded (2N+1) x (2N+1) rendering grid. */
    fun isFloorTile(tile: MazeTile): Boolean {
        if (tile.row !in 0 until tileRows || tile.col !in 0 until tileCols) return false
        if (tile.row % 2 == 1 && tile.col % 2 == 1) return true
        if (tile.row % 2 == 1 && tile.col % 2 == 0 && tile.col in 2 until tileCols - 1) {
            val left = MazeCell((tile.row - 1) / 2, tile.col / 2 - 1)
            return isOpen(left, MazeDirection.East)
        }
        if (tile.row % 2 == 0 && tile.col % 2 == 1 && tile.row in 2 until tileRows - 1) {
            val top = MazeCell(tile.row / 2 - 1, (tile.col - 1) / 2)
            return isOpen(top, MazeDirection.South)
        }
        return false
    }

    fun signature(): String = buildString {
        append(seed).append('|')
        openings.forEach { append(it.toString(16)).append(',') }
        append('|').append(exit).append('|').append(keys).append('|').append(shrines).append('|').append(monsterSpawn)
    }

    private fun generate(newSeed: Long) {
        seed = newSeed
        openings = IntArray(config.width * config.height)
        allDistances = null
        val rng = Random(seed)
        val visited = BooleanArray(openings.size)
        val stack = ArrayDeque<MazeCell>()
        start = MazeCell(0, 0)
        visited[index(start)] = true
        stack.add(start)
        while (stack.isNotEmpty()) {
            val cell = stack.lastOrNull() ?: break
            val candidates = MazeDirection.entries.filter { direction ->
                val next = cell.moved(direction)
                contains(next) && !visited[index(next)]
            }
            if (candidates.isEmpty()) {
                stack.removeLast()
            } else {
                val direction = candidates[rng.nextInt(candidates.size)]
                val next = cell.moved(direction)
                open(cell, direction)
                visited[index(next)] = true
                stack.add(next)
            }
        }

        val closed = ArrayList<Pair<MazeCell, MazeDirection>>()
        for (row in 0 until config.height) for (col in 0 until config.width) {
            val cell = MazeCell(row, col)
            for (direction in listOf(MazeDirection.East, MazeDirection.South)) {
                if (contains(cell.moved(direction)) && !isOpen(cell, direction)) closed += cell to direction
            }
        }
        closed.shuffle(rng)
        repeat((closed.size * config.extraWallRemoval).toInt()) { index ->
            val (cell, direction) = closed[index]
            open(cell, direction)
        }

        allDistances = Array(openings.size) { originIndex ->
            val origin = MazeCell(originIndex / config.width, originIndex % config.width)
            IntArray(openings.size) { -1 }.also { values ->
                for ((cell, distance) in distancesFrom(origin)) values[index(cell)] = distance
            }
        }

        val distances = distancesFrom(start)
        val ordered = distances.entries.sortedWith(
            compareByDescending<Map.Entry<MazeCell, Int>> { it.value }.thenBy { it.key.row }.thenBy { it.key.col },
        )
        exit = ordered.first().key
        val pool = ordered.map { it.key }.filter { it != start && it != exit }.toMutableList()
        pool.shuffle(rng)
        keys = takeSpread(pool, config.keyCount, emptySet())
        val used = keys.toMutableSet().also { it += exit }
        val shrineCount = config.shrineMin + rng.nextInt(config.shrineMax - config.shrineMin + 1)
        shrines = takeSpread(pool, shrineCount, used)
        used += shrines
        monsterSpawn = pool.firstOrNull {
            distances.getValue(it) >= config.monsterSpawnMinDistance && it !in used
        } ?: ordered.first { it.key !in used }.key
    }

    private fun takeSpread(pool: List<MazeCell>, count: Int, excluded: Set<MazeCell>): List<MazeCell> {
        if (count == 0) return emptyList()
        val selected = ArrayList<MazeCell>()
        for (candidate in pool) {
            if (candidate in excluded || selected.any { it.manhattan(candidate) < 3 }) continue
            selected += candidate
            if (selected.size == count) break
        }
        if (selected.size < count) for (candidate in pool) {
            if (candidate !in excluded && candidate !in selected) selected += candidate
            if (selected.size == count) break
        }
        return selected
    }

    private fun open(cell: MazeCell, direction: MazeDirection) {
        val next = cell.moved(direction)
        openings[index(cell)] = openings[index(cell)] or direction.bit
        openings[index(next)] = openings[index(next)] or direction.opposite.bit
    }

    private fun index(cell: MazeCell): Int = cell.row * config.width + cell.col
}
