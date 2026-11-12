// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

/**
 * TRAIL RIDE world tuning, in metres along (distance) and across (x) the forest. The trail centre
 * is a smooth function of distance; the rider's x is independent of it.
 */
internal data class TrailWorldConfig(
    val segmentLength: Float = 16f,
    val halfWidth: Float = 1.4f,
    val maxOffset: Float = 2.0f,
    val straightStartPoints: Int = 4,
    val baseSlope: Float = 0.05f,
    val slopePerLevel: Float = 0.014f,
    val levelDistance: Float = 450f,
    val maxLevel: Int = 5,
    val lookAhead: Float = 95f,
    val keepBehind: Float = 8f,
    val firstObstacleAt: Float = 70f,
    val obstacleSpacing: Float = 16f,
    val obstacleSpacingPerLevel: Float = 1f,
    val minObstacleSpacing: Float = 11f,
    val obstacleSpacingJitter: Float = 12f,
    val slalomGapMin: Float = 9f,
    val slalomGapMax: Float = 12f,
    val trunkRadius: Float = 0.32f,
    val rockRadius: Float = 0.28f,
    val minGap: Float = 1.0f,
    val firstDitchAt: Float = 230f,
    val ditchSpacing: Float = 175f,
    val ditchSpacingPerLevel: Float = 5f,
    val minDitchSpacing: Float = 150f,
    val ditchSpacingJitter: Float = 50f,
    val ditchLength: Float = 1.6f,
    val ditchClearBefore: Float = 32f,
    val ditchClearAfter: Float = 26f,
)

internal enum class ObstacleKind { Trunk, Rock }

/** A collision-capable hazard. [x] is its fixed world position; [offset] is relative to the trail centre at [distance]. */
internal class TrailObstacle(
    val id: Int,
    val group: Int,
    val distance: Float,
    val offset: Float,
    val x: Float,
    val radius: Float,
    val kind: ObstacleKind,
) {
    var resolved: Boolean = false
    var hit: Boolean = false
}

/** A ditch across the whole trail and its shoulders, from [start] to [end]. Only a timed jump crosses it. */
internal class TrailDitch(val id: Int, val start: Float, val length: Float) {
    val end: Float
        get() = start + length
    var resolved: Boolean = false
    var cleared: Boolean = false
}

private enum class PathMode { Straight, Bend, Sweep, SBend }

private enum class GroupKind { Edge, Rock, Gate, Slalom }

/**
 * Deterministic, seeded, distance-based TRAIL RIDE world.
 *
 * The centreline is a Catmull-Rom spline through control points every [TrailWorldConfig.segmentLength]
 * metres. Points come from a small pattern generator (straights, bends, long sweeps and S-bends)
 * whose per-point lateral step is capped by the level's slope limit, and the centre never leaves
 * +/- [TrailWorldConfig.maxOffset]. Hazards come from a second, independent generator, so neither
 * stream depends on how often or in which order the game asks for geometry: the world is the same
 * at any frame rate. Only a bounded window around the rider is kept.
 */
internal class TrailRideWorld(val config: TrailWorldConfig = TrailWorldConfig(), seed: Long = 1L) {
    var seed: Long = seed
        private set
    val obstacles: ArrayList<TrailObstacle> = ArrayList()
    val ditches: ArrayList<TrailDitch> = ArrayList()
    var generatedObstacles: Int = 0
        private set
    var generatedDitches: Int = 0
        private set

    private val points = FloatArray(POINT_CAPACITY)
    private var firstIndex = 0
    private var pointCount = 0
    private var pathRng = Random(seed)
    private var hazardRng = Random(seed xor HAZARD_SALT)
    private var mode = PathMode.Straight
    private var modeLeft = 0
    private var modeIndex = 0
    private var modeLength = 0
    private var modeStep = 0f
    private var modeDir = 1f
    private var genOffset = 0f
    private var nextGroupAt = config.firstObstacleAt
    private var nextDitchAt = config.firstDitchAt
    private var nextId = 0
    private var nextGroup = 0

    val pointsHeld: Int
        get() = pointCount

    fun reset(seed: Long) {
        this.seed = seed
        obstacles.clear()
        ditches.clear()
        generatedObstacles = 0
        generatedDitches = 0
        firstIndex = 0
        pointCount = 0
        pathRng = Random(seed)
        hazardRng = Random(seed xor HAZARD_SALT)
        mode = PathMode.Straight
        modeLeft = 0
        modeIndex = 0
        modeLength = 0
        modeStep = 0f
        modeDir = 1f
        genOffset = 0f
        nextGroupAt = config.firstObstacleAt
        nextDitchAt = config.firstDitchAt
        nextId = 0
        nextGroup = 0
    }

    fun level(distance: Float): Int = min(config.maxLevel, (max(0f, distance) / config.levelDistance).toInt())

    fun maxSlope(level: Int): Float = config.baseSlope + config.slopePerLevel * level.coerceIn(0, config.maxLevel)

    /** Trail centre x at [distance]. */
    fun center(distance: Float): Float {
        val u = max(0f, distance) / config.segmentLength
        val k = floor(u).toInt()
        val t = u - k
        val p0 = pointAt(k - 1)
        val p1 = pointAt(k)
        val p2 = pointAt(k + 1)
        val p3 = pointAt(k + 2)
        return 0.5f * (2f * p1 + (-p0 + p2) * t + (2f * p0 - 5f * p1 + 4f * p2 - p3) * t * t + (-p0 + 3f * p1 - 3f * p2 + p3) * t * t * t)
    }

    /** d(centre)/d(distance) at [distance]: the trail's heading relative to straight ahead. */
    fun slope(distance: Float): Float {
        val u = max(0f, distance) / config.segmentLength
        val k = floor(u).toInt()
        val t = u - k
        val p0 = pointAt(k - 1)
        val p1 = pointAt(k)
        val p2 = pointAt(k + 1)
        val p3 = pointAt(k + 2)
        val dt = 0.5f * ((-p0 + p2) + 2f * (2f * p0 - 5f * p1 + 4f * p2 - p3) * t + 3f * (-p0 + 3f * p1 - 3f * p2 + p3) * t * t)
        return dt / config.segmentLength
    }

    /** Generates hazards up to [TrailWorldConfig.lookAhead] metres beyond [riderDistance]. */
    fun ensure(riderDistance: Float) {
        val upTo = riderDistance + config.lookAhead
        while (min(nextGroupAt, nextDitchAt) <= upTo) {
            if (nextDitchAt <= nextGroupAt) placeDitch() else placeGroup()
        }
    }

    /** Drops geometry and hazards that are safely behind the rider. */
    fun trim(riderDistance: Float) {
        val cutoff = riderDistance - config.keepBehind
        while (obstacles.isNotEmpty() && obstacles[0].distance < cutoff) obstacles.removeAt(0)
        while (ditches.isNotEmpty() && ditches[0].end < cutoff) ditches.removeAt(0)
        val keepFrom = floor(max(0f, cutoff) / config.segmentLength).toInt() - 2
        val drop = (keepFrom - firstIndex).coerceIn(0, pointCount)
        firstIndex += drop
        pointCount -= drop
    }

    /** First unresolved ditch whose far edge is still ahead of [distance]. */
    fun nextDitch(distance: Float): TrailDitch? {
        for (d in ditches) if (!d.resolved && d.end > distance) return d
        return null
    }

    /** Widest obstacle-free interval across the rideable trail at [distance] (+/- [window] metres). */
    fun widestGap(distance: Float, window: Float = 0.5f): Float {
        val w = config.halfWidth
        val blocks = obstacles.filter { abs(it.distance - distance) <= window }.sortedBy { it.offset - it.radius }
        var cursor = -w
        var best = 0f
        for (o in blocks) {
            val lo = o.offset - o.radius
            if (lo > cursor) best = max(best, min(lo, w) - cursor)
            cursor = max(cursor, o.offset + o.radius)
        }
        return max(best, w - cursor)
    }

    /** Stable pseudo-random value in [0, 1) for scenery slot [slot]; costs nothing to store. */
    fun scenery(slot: Int, salt: Int): Float = trailHash(seed, slot, salt)

    private fun pointAt(k: Int): Float {
        if (k < 0) return 0f
        while (k >= firstIndex + pointCount) generatePoint()
        if (k < firstIndex) return points[firstIndex % POINT_CAPACITY]
        return points[k % POINT_CAPACITY]
    }

    private fun generatePoint() {
        val k = firstIndex + pointCount
        val value = nextOffset(k)
        if (pointCount == POINT_CAPACITY) {
            firstIndex += 1
            pointCount -= 1
        }
        points[k % POINT_CAPACITY] = value
        pointCount += 1
    }

    private fun nextOffset(k: Int): Float {
        if (k < config.straightStartPoints) return 0f
        if (modeLeft <= 0) chooseMode(k)
        val step = when (mode) {
            PathMode.Straight -> 0f
            PathMode.Bend, PathMode.Sweep -> modeDir * modeStep
            PathMode.SBend -> if (modeIndex < modeLength / 2) modeDir * modeStep else -modeDir * modeStep
        }
        modeIndex += 1
        modeLeft -= 1
        val limit = config.maxOffset
        var next = genOffset + step
        if (abs(next) > limit) {
            modeDir = -modeDir
            next = (genOffset - step).coerceIn(-limit, limit)
        }
        genOffset = next
        return next
    }

    private fun chooseMode(k: Int) {
        val level = level(k * config.segmentLength)
        val maxStep = maxSlope(level) * config.segmentLength * SLOPE_MARGIN
        val straightChance = (0.38f - 0.05f * level).coerceAtLeast(0.14f)
        val sBendChance = if (level >= 1) 0.14f + 0.03f * level else 0f
        val ended = mode
        if (ended != PathMode.Straight && (ended == PathMode.SBend || pathRng.nextFloat() < straightChance)) {
            start(PathMode.Straight, 1 + pathRng.nextInt(if (level < 2) 3 else 2), 0f)
            return
        }
        val roll = pathRng.nextFloat()
        when {
            roll < sBendChance -> start(PathMode.SBend, 4, maxStep * (0.6f + 0.35f * pathRng.nextFloat()))
            roll < sBendChance + (1f - sBendChance) * 0.5f -> start(PathMode.Bend, 2 + pathRng.nextInt(2), maxStep * (0.55f + 0.45f * pathRng.nextFloat()))
            else -> start(PathMode.Sweep, 3 + pathRng.nextInt(3), maxStep * (0.3f + 0.25f * pathRng.nextFloat()))
        }
        val towardCentre = abs(genOffset) > config.maxOffset * 0.4f && pathRng.nextFloat() < 0.75f
        modeDir = if (towardCentre) (if (genOffset > 0f) -1f else 1f) else (if (pathRng.nextBoolean()) 1f else -1f)
    }

    private fun start(next: PathMode, length: Int, step: Float) {
        mode = next
        modeLength = length
        modeLeft = length
        modeIndex = 0
        modeStep = step
    }

    private fun placeDitch() {
        val ditch = TrailDitch(nextId++, nextDitchAt, config.ditchLength)
        ditches += ditch
        generatedDitches += 1
        val level = level(ditch.start)
        val spacing = max(config.minDitchSpacing, config.ditchSpacing - level * config.ditchSpacingPerLevel)
        nextDitchAt = ditch.start + spacing + hazardRng.nextFloat() * config.ditchSpacingJitter
        if (nextGroupAt < ditch.end + config.ditchClearAfter) nextGroupAt = ditch.end + config.ditchClearAfter
    }

    private fun placeGroup() {
        val start = nextGroupAt
        val level = level(start)
        val roll = hazardRng.nextFloat()
        val kind = when {
            level >= 2 && roll < 0.22f -> GroupKind.Slalom
            level >= 1 && roll < 0.42f -> GroupKind.Gate
            roll < 0.7f -> GroupKind.Edge
            else -> GroupKind.Rock
        }
        val length = if (kind == GroupKind.Slalom) config.slalomGapMin + hazardRng.nextFloat() * (config.slalomGapMax - config.slalomGapMin) else 0f
        if (start + length > nextDitchAt - config.ditchClearBefore) {
            nextGroupAt = nextDitchAt + config.ditchLength + config.ditchClearAfter
            return
        }
        val group = nextGroup++
        val w = config.halfWidth
        val trunk = config.trunkRadius
        val side = if (hazardRng.nextBoolean()) 1f else -1f
        when (kind) {
            GroupKind.Edge -> {
                val intrude = 0.45f + hazardRng.nextFloat() * (0.4f + 0.04f * level)
                add(group, start, side * (w - intrude + trunk), trunk, ObstacleKind.Trunk)
            }
            GroupKind.Rock -> add(group, start, (hazardRng.nextFloat() * 2f - 1f) * 0.55f, config.rockRadius, ObstacleKind.Rock)
            GroupKind.Gate -> {
                val a = 0.35f + hazardRng.nextFloat() * 0.35f
                val bMax = min(0.7f, 2f * w - a - (config.minGap + 0.2f))
                val b = 0.35f + hazardRng.nextFloat() * (bMax - 0.35f).coerceAtLeast(0f)
                add(group, start, -(w - a + trunk), trunk, ObstacleKind.Trunk)
                add(group, start, w - b + trunk, trunk, ObstacleKind.Trunk)
            }
            GroupKind.Slalom -> {
                val first = 0.6f + hazardRng.nextFloat() * 0.45f
                val second = 0.6f + hazardRng.nextFloat() * 0.45f
                add(group, start, side * (w - first + trunk), trunk, ObstacleKind.Trunk)
                add(group, start + length, -side * (w - second + trunk), trunk, ObstacleKind.Trunk)
            }
        }
        val spacing = max(config.minObstacleSpacing, config.obstacleSpacing - level * config.obstacleSpacingPerLevel)
        nextGroupAt = start + length + spacing + hazardRng.nextFloat() * config.obstacleSpacingJitter
    }

    private fun add(group: Int, distance: Float, offset: Float, radius: Float, kind: ObstacleKind) {
        obstacles += TrailObstacle(nextId++, group, distance, offset, center(distance) + offset, radius, kind)
        generatedObstacles += 1
    }

    companion object {
        const val POINT_CAPACITY = 32
        const val SLOPE_MARGIN = 0.8f
        const val HAZARD_SALT = 0x5DEECE66DL
    }
}

/** SplitMix-style hash of (seed, slot, salt) to [0, 1). */
internal fun trailHash(seed: Long, slot: Int, salt: Int): Float {
    var h = seed xor (slot.toLong() * -0x61c8864680b583ebL) xor (salt.toLong() * 0x632BE59BD9B4E019L)
    h = (h xor (h ushr 30)) * -0x40a7b892e31b1a47L
    h = (h xor (h ushr 27)) * -0x6b2fb644ecceee15L
    h = h xor (h ushr 31)
    return (h ushr 40).toFloat() / (1L shl 24).toFloat()
}

/**
 * First-person pinhole projection onto the 256x144 framebuffer. Depth [z] is metres ahead of the
 * near plane; `scale = focal / (z + focal)`. A ground point projects to [groundY]; an object's
 * lateral world offset from the camera projects through [screenX]. The camera yaw follows the
 * trail heading, applied as the small-angle shear in [lateral].
 */
internal class TrailProjection(
    val width: Float = 256f,
    val horizonY: Float = 50f,
    val focal: Float = 4f,
    val pxPerMeter: Float = 62f,
    var eyeHeight: Float = 1.52f,
) {
    fun scale(z: Float): Float = focal / (max(0f, z) + focal)

    fun groundY(z: Float): Float = horizonY + eyeHeight * pxPerMeter * scale(z)

    /** Inverse of [groundY]: depth of the ground seen at screen row [y]. Infinite at or above the horizon. */
    fun depthAt(y: Float): Float {
        val dy = y - horizonY
        if (dy <= 0f) return Float.POSITIVE_INFINITY
        return focal * eyeHeight * pxPerMeter / dy - focal
    }

    fun lateral(worldX: Float, z: Float, cameraX: Float, yaw: Float): Float = worldX - cameraX - z * yaw

    fun screenX(lateral: Float, z: Float): Float = width / 2f + lateral * pxPerMeter * scale(z)

    fun size(meters: Float, z: Float): Float = meters * pxPerMeter * scale(z)
}
