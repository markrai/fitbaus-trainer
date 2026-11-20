// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.abs

class GhoulRunGameTest {
    private fun run(game: GhoulRunGame, seconds: Float, lane: GhoulLane = GhoulLane.Center, lean: Float = 0f, rpm: Float = 70f, baseline: Float = 70f) {
        repeat((seconds / game.config.step).toInt()) { game.step(game.config.step, lane, lean, rpm, baseline) }
    }

    private fun findArrival(game: GhoulRunGame, predicate: (MazeCell, MazeDirection, List<MazeDirection>) -> Boolean): Pair<MazeCell, MazeDirection> {
        for (row in 0 until game.config.height) for (col in 0 until game.config.width) {
            val cell = MazeCell(row, col)
            for (arrival in MazeDirection.entries) {
                if (!game.world.isOpen(cell, arrival.opposite)) continue
                val allowed = game.world.exits(cell).filter { it != arrival.opposite }
                if (predicate(cell, arrival, allowed)) return cell to arrival
            }
        }
        error("no matching junction")
    }

    @Test
    fun cadenceMapsSpeedAndLampContinuously() {
        val game = GhoulRunGame(seed = 3L)
        assertEquals(0f, game.speedFor(0f, 70f))
        assertEquals(game.config.creepSpeed, game.speedFor(55f, 70f), 1e-5f)
        assertEquals(game.config.cruiseSpeed, game.speedFor(70f, 70f), 1e-5f)
        assertEquals(game.config.sprintSpeed, game.speedFor(90f, 70f), 1e-5f)
        assertEquals(0f to 0f, game.radiiFor(0f, 70f))
        assertEquals(game.config.creepLightRadius, game.radiiFor(55f, 70f).first, 1e-5f)
        assertEquals(game.config.sprintNoiseRadius, game.radiiFor(90f, 70f).second, 1e-5f)
    }

    @Test
    fun laneChoiceUsesScreenSidesAndCenterStraight() {
        val game = GhoulRunGame(seed = 11L)
        for (heading in MazeDirection.entries) {
            val left = game.world.screenTurn(heading, ScreenSide.Left)
            val right = game.world.screenTurn(heading, ScreenSide.Right)
            val found = findArrival(game) { _, arrival, allowed -> arrival == heading && heading in allowed && left in allowed && right in allowed }
            assertEquals(left, game.choiceFor(found.first, heading, GhoulLane.ScreenLeft))
            assertEquals(heading, game.choiceFor(found.first, heading, GhoulLane.Center))
            assertEquals(right, game.choiceFor(found.first, heading, GhoulLane.ScreenRight))
        }
        val (tee, arrival) = findArrival(game) { _, a, allowed -> a in allowed && allowed.size == 2 }
        val onlyTurn = game.world.exits(tee).filter { it != arrival.opposite && it != arrival }.single()
        val turnSide = if (onlyTurn.screenDx < 0) GhoulLane.ScreenLeft else GhoulLane.ScreenRight
        val oppositeSide = if (turnSide == GhoulLane.ScreenLeft) GhoulLane.ScreenRight else GhoulLane.ScreenLeft
        assertEquals(arrival, game.choiceFor(tee, arrival, oppositeSide), "leaning away from the only turn keeps straight")
    }

    @Test
    fun lockPointAndBlockedStraightBraking() {
        val game = GhoulRunGame(seed = 18L)
        val (junction, arrival) = findArrival(game) { _, a, allowed -> a !in allowed && allowed.size >= 2 }
        val before = junction.moved(arrival.opposite)
        game.placeRider(before, arrival, 0.49f)
        game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
        assertFalse(game.choiceLocked())
        game.placeRider(before, arrival, 0.51f)
        game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
        assertTrue(game.brakingForChoice)
        assertNull(game.lockedChoice)
        assertEquals(0f, game.speed)
        game.step(game.config.step, GhoulLane.ScreenLeft, 0f, 70f, 70f)
        assertTrue(game.lockedChoice != null)
    }

    @Test
    fun autoCornerAndDeadEndTurn() {
        val cornerGame = GhoulRunGame(seed = 5L)
        val (corner, arrival) = findArrival(cornerGame) { _, _, allowed -> allowed.size == 1 }
        assertEquals(cornerGame.world.exits(corner).filter { it != arrival.opposite }.single(), cornerGame.choiceFor(corner, arrival, GhoulLane.Center))

        val deadGame = GhoulRunGame(seed = 5L)
        val (dead, deadArrival) = findArrival(deadGame) { _, _, allowed -> allowed.isEmpty() }
        assertEquals(deadArrival.opposite, deadGame.choiceFor(dead, deadArrival, GhoulLane.Center))
        deadGame.placeRider(dead.moved(deadArrival.opposite), deadArrival, 0.99f)
        run(deadGame, 0.5f)
        assertTrue(deadGame.turningLeft > 0f)
        run(deadGame, deadGame.config.deadEndTurnSeconds + 0.1f)
        assertEquals(deadArrival.opposite, deadGame.heading)
    }

    @Test
    fun hardLeanNeedsThresholdAndHoldTime() {
        val game = GhoulRunGame(seed = 9L)
        val initial = game.heading
        run(game, game.config.hardLeanSeconds + 0.2f, lean = game.config.hardLeanThreshold - 0.01f, rpm = 0f)
        assertEquals(initial, game.heading)
        run(game, game.config.hardLeanSeconds - 0.1f, lean = 1f, rpm = 0f)
        assertEquals(initial, game.heading)
        run(game, 0.15f, lean = 1f, rpm = 0f)
        assertEquals(initial.opposite, game.heading)
    }

    @Test
    fun monstersWaitForBaselineAndFollowTheirRules() {
        val game = GhoulRunGame(seed = 4L)
        val initial = game.monsters.map { it.cell }
        run(game, 3f, baseline = Float.NaN)
        assertEquals(initial, game.monsters.map { it.cell })
        assertTrue(game.monsters.all { it.state == MonsterState.Inactive })

        val wraith = game.monsters.first { it.kind == GhoulMonsterKind.Wraith }
        val wr = wraith.row
        val wc = wraith.col
        run(game, 1f)
        assertTrue(abs(wraith.row - wr) + abs(wraith.col - wc) > 0.1f, "wraith advances directly, independent of walls")
        val ghoul = game.monsters.first { it.kind == GhoulMonsterKind.Ghoul }
        assertEquals(MonsterState.Tracking, ghoul.state)
        assertTrue(ghoul.trackIndex <= game.riderTrail.lastIndex.coerceAtLeast(0))
    }

    @Test
    fun ghoulUsesTireTrackHistoryAndHoundCanLoseTrack() {
        val game = GhoulRunGame(seed = 21L)
        val ghoulIndex = game.monsters.indexOfFirst { it.kind == GhoulMonsterKind.Ghoul }
        game.forceMonsterCell(ghoulIndex, game.riderCell)
        game.monsters[ghoulIndex].lungeCooldown = 100f
        run(game, 3f)
        val ghoul = game.monsters[ghoulIndex]
        assertTrue(game.riderTrail.size > 2)
        assertTrue(ghoul.trackIndex > 0)
        assertTrue(ghoul.cell in game.riderTrail, "ghoul stays on recorded rider cells")

        val houndIndex = game.monsters.indexOfFirst { it.kind == GhoulMonsterKind.Hound }
        val far = (0 until game.config.height).flatMap { row -> (0 until game.config.width).map { col -> MazeCell(row, col) } }
            .first { it.row != game.riderCell.row && it.col != game.riderCell.col && it.manhattan(game.riderCell) > game.config.loseTrackGap + 2f }
        game.forceMonsterCell(houndIndex, far, MonsterState.Burst)
        val hound = game.monsters[houndIndex]
        hound.houndState = HoundState.Burst
        hound.stateLeft = game.config.houndBurstSeconds
        hound.loseFor = game.config.loseTrackSeconds - game.config.step
        run(game, game.config.step * 2f, rpm = 0f)
        assertEquals(HoundState.Tired, hound.houndState, "broken sight plus a safe gap makes the hound lose the trail")
    }

    @Test
    fun houndWarnsBurstsTiresAndGivesUp() {
        val game = GhoulRunGame(seed = 8L)
        val houndIndex = game.monsters.indexOfFirst { it.kind == GhoulMonsterKind.Hound }
        val hound = game.monsters[houndIndex]
        val shrine = game.world.shrines.first()
        game.placeRider(shrine, game.world.exits(shrine).first())
        game.visitForTest(shrine)
        hound.houndState = HoundState.Warning
        hound.state = MonsterState.Warning
        hound.stateLeft = game.config.houndWarningSeconds
        assertEquals(HoundState.Warning, hound.houndState)
        run(game, game.config.houndWarningSeconds + 0.1f, lane = GhoulLane.ScreenLeft, rpm = 0f)
        assertEquals(HoundState.Burst, hound.houndState)
        run(game, game.config.houndBurstSeconds + 0.1f, lane = GhoulLane.ScreenRight, rpm = 0f)
        assertEquals(HoundState.Tired, hound.houndState)
        run(game, game.config.houndTiredSeconds + 0.1f, rpm = 0f)
        assertEquals(HoundState.Patrol, hound.houndState)
    }

    @Test
    fun lungeCanBeDodgedOrHit() {
        val dodge = GhoulRunGame(seed = 12L)
        val ghoulIndex = dodge.monsters.indexOfFirst { it.kind == GhoulMonsterKind.Ghoul }
        dodge.forceMonsterCell(ghoulIndex, dodge.riderCell)
        dodge.step(dodge.config.step, GhoulLane.Center, 0f, 0f, 70f)
        assertTrue(dodge.monsters[ghoulIndex].lungeLeft > 0f, "lunge starts inside one tile")
        val threatened = dodge.monsters[ghoulIndex].lungeLane
        val safe = GhoulLane.entries.first { it != threatened }
        var resolvedAt = -1
        repeat(60) { step ->
            dodge.step(dodge.config.step, safe, 0f, 0f, 70f)
            if (resolvedAt < 0 && dodge.monsters[ghoulIndex].lungeLeft <= 0f) resolvedAt = step
        }
        assertTrue(
            dodge.monsters[ghoulIndex].lungeDodges == 1,
            "resolved=$resolvedAt left=${dodge.monsters[ghoulIndex].lungeLeft} cooldown=${dodge.monsters[ghoulIndex].lungeCooldown} phase=${dodge.phase} inv=${dodge.invulnerableLeft} shrine=${dodge.inShrine} hearts=${dodge.hearts} threatened=$threatened safe=$safe lane=${dodge.lane}",
        )
        assertEquals(dodge.config.startingHearts, dodge.hearts)

        val hit = GhoulRunGame(seed = 12L)
        val hitIndex = hit.monsters.indexOfFirst { it.kind == GhoulMonsterKind.Ghoul }
        hit.forceMonsterCell(hitIndex, hit.riderCell)
        hit.step(hit.config.step, GhoulLane.Center, 0f, 0f, 70f)
        val hitLane = hit.monsters[hitIndex].lungeLane
        run(hit, hit.config.lungeWarningSeconds + 0.1f, lane = hitLane, rpm = 0f)
        assertEquals(GhoulPhase.BreakFree, hit.phase)
        assertEquals(hit.config.startingHearts - 1, hit.hearts)
    }

    @Test
    fun breakFreeInvulnerabilityRespawnKeysAndShrines() {
        val game = GhoulRunGame(seed = 15L)
        game.collectedKeys += game.world.keys.first()
        game.forceCatch()
        assertEquals(GhoulPhase.BreakFree, game.phase)
        run(game, game.config.breakFreeSeconds - 0.2f, rpm = 71f)
        assertEquals(GhoulPhase.BreakFree, game.phase)
        run(game, 0.3f, rpm = 71f)
        assertEquals(GhoulPhase.Playing, game.phase)
        assertTrue(game.invulnerableLeft > 0f)

        repeat(2) {
            run(game, game.config.invulnerabilitySeconds + 0.1f)
            game.forceCatch()
            if (game.phase == GhoulPhase.BreakFree) run(game, game.config.breakFreeSeconds + 0.1f, rpm = 80f)
        }
        assertEquals(game.config.startingHearts, game.hearts)
        assertEquals(1, game.keysFound, "respawn keeps keys")

        val shrine = game.world.shrines.first()
        game.visitForTest(shrine)
        assertEquals(shrine, game.checkpoint)
        val hearts = game.hearts
        game.forceCatch()
        assertEquals(hearts, game.hearts, "active shrine prevents catches")
        run(game, game.config.shrineProtectionSeconds + 0.1f)
        game.forceCatch()
        assertEquals(hearts - 1, game.hearts)
    }
}
