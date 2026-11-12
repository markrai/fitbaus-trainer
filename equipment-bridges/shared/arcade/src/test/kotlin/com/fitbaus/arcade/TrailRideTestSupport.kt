// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

internal object TrailWorlds {
    const val NEVER = 1e9f

    /** Dead-straight trail; obstacles and ditches only when asked. */
    fun straight(firstDitch: Float = 90f, obstacles: Boolean = false, ditchSpacing: Float = 175f): TrailWorldConfig = TrailWorldConfig(
        straightStartPoints = 1_000_000,
        firstObstacleAt = if (obstacles) 60f else NEVER,
        firstDitchAt = firstDitch,
        ditchSpacing = ditchSpacing,
        minDitchSpacing = minOf(150f, ditchSpacing),
        ditchSpacingJitter = 0f,
    )

    /** The normal winding trail with no hazards at all. */
    fun curvyEmpty(): TrailWorldConfig = TrailWorldConfig(firstObstacleAt = NEVER, firstDitchAt = NEVER)

    fun riding(config: TrailRideConfig, seed: Long = 7L): TrailRideGame {
        val g = TrailRideGame(config, seed)
        while (g.phase == TrailPhase.Ready) g.step(config.step, 0f, 70f)
        return g
    }
}

/** Fixed-step pilots used by the tests. */
internal object TrailPilots {
    /** Follow the trail centre a little ahead, like an attentive rider. */
    fun follow(g: TrailRideGame, lateral: Float = 0f): Float =
        (g.world.center(g.distance + g.speed * 0.35f) + lateral) / g.config.steerRange

    /** Aim at the middle of the widest gap of the next obstacle row; otherwise follow the trail. */
    fun avoid(g: TrailRideGame): Float {
        val next = g.world.obstacles.firstOrNull { !it.resolved && it.distance > g.distance - 0.5f && it.distance < g.distance + 30f }
            ?: return follow(g)
        val w = g.config.world.halfWidth
        val row = g.world.obstacles.filter { kotlin.math.abs(it.distance - next.distance) < 0.5f }.sortedBy { it.offset - it.radius }
        var cursor = -w
        var bestMid = 0f
        var best = -1f
        for (o in row) {
            val lo = o.offset - o.radius
            if (lo - cursor > best) {
                best = lo - cursor
                bestMid = (cursor + lo) / 2f
            }
            cursor = maxOf(cursor, o.offset + o.radius)
        }
        if (w - cursor > best) bestMid = (cursor + w) / 2f
        return (g.world.center(g.distance + g.speed * 0.35f) + bestMid) / g.config.steerRange
    }

    /** Aim straight at the next obstacle. */
    fun aim(g: TrailRideGame): Float {
        val next = g.world.obstacles.firstOrNull { !it.resolved && it.distance > g.distance } ?: return follow(g)
        return next.x / g.config.steerRange
    }

    fun run(g: TrailRideGame, seconds: Float, rpm: Float = 70f, dt: Float = g.config.step, steer: (TrailRideGame) -> Float = { 0f }, before: (TrailRideGame) -> Unit = {}) {
        val steps = (seconds / dt).toInt()
        repeat(steps) {
            before(g)
            g.step(dt, steer(g), rpm)
        }
    }
}

/**
 * Drives a [TrailRideSession] with explicit timestamps: ~30 FPS frames, a fresh face sample every
 * frame and a new bike RPM sample every [sampleEveryMs], exactly as the host feeds the view.
 */
internal class SessionDriver(val session: TrailRideSession) {
    var nowNanos = 1_000_000_000L
    var frameMs = 33L
    var sampleEveryMs = 250L
    var faceX = 0.5f
    var face = HandSource.Camera
    var camera = CameraState.Ready
    var connected = true
    var rpm: Int? = 70
    var telemetryFrozen = false
    private var lastSampleAt = Long.MIN_VALUE
    private var sampleSeq = 0

    val game: TrailRideGame
        get() = session.game

    fun frame(): TrailHold {
        nowNanos += frameMs * MS
        if (!telemetryFrozen && (lastSampleAt == Long.MIN_VALUE || nowNanos - lastSampleAt >= sampleEveryMs * MS)) {
            lastSampleAt = nowNanos
            sampleSeq += 1
        }
        val position = HandPosition(faceX, 0.5f, if (face == HandSource.Lost) 0f else 0.9f, nowNanos, face)
        return session.update(position, camera, connected, true, rpm, true, "rpm-$sampleSeq", nowNanos)
    }

    fun run(seconds: Float, each: (SessionDriver) -> Unit = {}) {
        repeat((seconds * 1000f / frameMs).toInt()) {
            each(this)
            frame()
        }
    }

    fun untilRiding(maxSeconds: Float = 20f) {
        var waited = 0f
        while (game.phase != TrailPhase.Riding) {
            frame()
            waited += frameMs / 1000f
            check(waited < maxSeconds) { "never started riding: hold ${session.hold}" }
        }
    }

    companion object {
        const val MS = 1_000_000L
    }
}
