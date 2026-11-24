package com.fitbaus.arcade

import kotlin.math.abs

internal object TrailShowcasePilot {
    val config = TrailRideConfig(world = TrailWorldConfig(
        firstObstacleAt = 15f,
        obstacleSpacing = 19f,
        obstacleSpacingJitter = 4f,
        firstDitchAt = 70f,
        ditchClearBefore = 12f,
        ditchClearAfter = 14f,
        straightStartPoints = 2,
    ))

    fun steer(game: TrailRideGame): Float {
        val world = game.world
        val distance = game.distance
        val center = world.center(distance + 2f)
        val hazard = world.obstacles.firstOrNull { !it.resolved && it.distance >= distance && it.distance - distance <= 15f }
        if (hazard == null) return (center / game.config.steerRange).coerceIn(-1f, 1f)
        val hazardCenter = world.center(hazard.distance)
        val group = world.obstacles.filter { !it.resolved && abs(it.distance - hazard.distance) < 0.6f }
        val room = world.config.halfWidth - game.config.riderHalfWidth - 0.14f
        val minX = maxOf(-game.config.steerRange, center - room, hazardCenter - room)
        val maxX = minOf(game.config.steerRange, center + room, hazardCenter + room)
        if (minX > maxX) return (center / game.config.steerRange).coerceIn(-1f, 1f)
        var best = center.coerceIn(minX, maxX)
        var bestScore = -Float.MAX_VALUE
        for (i in 0..24) {
            val x = minX + (maxX - minX) * i / 24f
            val clearance = group.minOf { abs(x - it.positionAt(it.distance, world.config.halfWidth)) - it.radius - game.config.riderHalfWidth }
            val score = minOf(clearance, 0.42f) * 6f - abs(x - hazardCenter) * 0.4f - abs(x - game.riderX) * 0.2f
            if (score > bestScore) {
                bestScore = score
                best = x
            }
        }
        return (best / game.config.steerRange).coerceIn(-1f, 1f)
    }

    fun jumpIfReady(game: TrailRideGame) {
        val ditch = game.nextDitch() ?: return
        if (game.phase == TrailPhase.Riding && !game.airborne && game.timeTo(ditch) in 0.55f..0.95f) game.requestJump()
    }
}
