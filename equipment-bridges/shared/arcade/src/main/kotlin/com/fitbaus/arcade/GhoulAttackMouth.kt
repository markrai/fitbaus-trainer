// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

internal object GhoulAttackMouth {
    const val CENTRE_U = 0.513f
    const val CENTRE_V = 0.236f
    const val CLOSED_HALF_WIDTH = 0.003f
    const val OPEN_HALF_WIDTH = 0.022f
    const val CLOSED_HALF_HEIGHT = 0.006f
    const val OPEN_HALF_HEIGHT = 0.052f

    private const val ENTER_DISTANCE = 0.95f
    private const val FULL_OPEN_DISTANCE = 0.45f
    private const val RIDER_FACING_DOT = 0.8660254f
    private const val GHOUL_FACING_DOT = 0.8191521f
    private const val OPEN_SECONDS = 0.28f
    private const val CLOSE_SECONDS = 0.24f

    fun target(
        riderCol: Float,
        riderRow: Float,
        cameraYaw: Float,
        monsterCol: Float,
        monsterRow: Float,
        monsterHeading: MazeDirection,
        monsterState: GhoulState,
        clearSight: Boolean,
    ): Float {
        if (monsterState != GhoulState.Hunting || !clearSight || !cameraYaw.isFinite()) return 0f
        val dx = monsterCol - riderCol
        val dy = monsterRow - riderRow
        val distance = hypot(dx, dy)
        if (distance < 0.001f || distance >= ENTER_DISTANCE) return 0f
        val towardGhoul = (cos(cameraYaw) * dx + sin(cameraYaw) * dy) / distance
        if (towardGhoul < RIDER_FACING_DOT) return 0f
        val towardRider = -(monsterHeading.dc * dx + monsterHeading.dr * dy) / distance
        if (towardRider < GHOUL_FACING_DOT) return 0f
        val closeness = ((ENTER_DISTANCE - distance) / (ENTER_DISTANCE - FULL_OPEN_DISTANCE))
            .coerceIn(0f, 1f)
        return closeness
    }

    fun target(game: GhoulRunGame, monster: GhoulMonster, cameraYaw: Float): Float {
        if (game.phase != GhoulPhase.Playing) return 0f
        val facing = target(
            game.riderCol, game.riderRow, cameraYaw,
            monster.col, monster.row, monster.heading, monster.state, true,
        )
        if (facing <= 0f) return 0f
        val rider = if (game.progress < 0.5f) game.riderCell else game.riderCell.moved(game.heading)
        val ghoul = if (monster.progress < 0.5f) monster.cell else monster.cell.moved(monster.heading)
        return if (game.world.hasLineOfSight(rider, ghoul)) facing else 0f
    }

    fun halfWidth(open: Float): Float {
        val strength = open.coerceIn(0f, 1f)
        return CLOSED_HALF_WIDTH + (OPEN_HALF_WIDTH - CLOSED_HALF_WIDTH) * strength
    }

    fun halfHeight(open: Float): Float {
        val strength = open.coerceIn(0f, 1f)
        return CLOSED_HALF_HEIGHT + (OPEN_HALF_HEIGHT - CLOSED_HALF_HEIGHT) * strength
    }

    fun advance(current: Float, target: Float, dt: Float): Float {
        if (!dt.isFinite() || dt <= 0f) return current.coerceIn(0f, 1f)
        val open = current.coerceIn(0f, 1f)
        val desired = target.coerceIn(0f, 1f)
        return if (desired > open) min(desired, open + dt / OPEN_SECONDS)
        else max(desired, open - dt / CLOSE_SECONDS)
    }

    fun update(game: GhoulRunGame, cameraYaw: Float, dt: Float) {
        if (!dt.isFinite() || dt <= 0f) return
        for (monster in game.ghouls) {
            monster.mouthOpen = advance(monster.mouthOpen, target(game, monster, cameraYaw), dt)
        }
    }
}
