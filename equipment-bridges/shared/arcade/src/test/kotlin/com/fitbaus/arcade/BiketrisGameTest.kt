// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class BiketrisGameTest {
    private fun cellsOf(piece: BlockPiece, state: Int): Set<Pair<Int, Int>> {
        val c = piece.states[state]
        return (0 until 4).map { c[it * 2] to c[it * 2 + 1] }.toSet()
    }

    private fun emptyRows(n: Int): List<String> = List(n) { ".........." }

    private fun settle(game: BiketrisGame, maxSeconds: Float = 30f): Int {
        val start = game.piecesSpawned
        var t = 0f
        while (game.piecesSpawned == start && game.phase == BiketrisPhase.Playing && t < maxSeconds) {
            game.advance(0.05f)
            t += 0.05f
        }
        return game.piecesSpawned - start
    }

    @Test
    fun allSevenPiecesHaveFourCellsInFourRotationStates() {
        assertEquals(listOf("I", "O", "T", "S", "Z", "J", "L"), BlockPiece.values().map { it.name })
        for (piece in BlockPiece.values()) {
            for (state in 0 until 4) {
                val cells = cellsOf(piece, state)
                assertEquals(4, cells.size, "$piece/$state")
                assertTrue(cells.all { (x, y) -> x in 0 until piece.size && y in 0 until piece.size }, "$piece/$state inside box")
            }
        }
        assertEquals(1, (0 until 4).map { cellsOf(BlockPiece.O, it) }.toSet().size, "O never changes shape")
        for (piece in listOf(BlockPiece.I, BlockPiece.T, BlockPiece.S, BlockPiece.Z, BlockPiece.J, BlockPiece.L)) {
            assertEquals(4, (0 until 4).map { cellsOf(piece, it) }.toSet().size, "$piece has four distinct states")
        }
        assertEquals(setOf(2 to 1, 1 to 0, 1 to 1, 1 to 2), cellsOf(BlockPiece.T, 1), "T state R points right")
        assertEquals(setOf(2 to 0, 2 to 1, 2 to 2, 2 to 3), cellsOf(BlockPiece.I, 1), "I state R is the third column")
        assertEquals((1..7).toSet(), BlockPiece.values().map { it.color }.toSet(), "one colour slot per piece")
    }

    @Test
    fun piecesSpawnCentredWithTopCellsOnTheFirstVisibleRow() {
        val game = BiketrisGame(seed = 3L)
        val expectedLeft = mapOf(BlockPiece.I to 3, BlockPiece.O to 4, BlockPiece.T to 3, BlockPiece.S to 3, BlockPiece.Z to 3, BlockPiece.J to 3, BlockPiece.L to 3)
        val seen = HashSet<BlockPiece>()
        repeat(14) {
            seen += game.piece
            assertEquals(expectedLeft[game.piece], game.pieceLeft, "${game.piece}")
            assertEquals(game.config.hiddenRows, game.pieceY + game.piece.top(0), "${game.piece} top row")
            assertEquals(0, game.rotation)
            game.loadRowsForTest(emptyRows(1))
            game.placeForTest(game.piece, 0, game.pieceX, game.rows - 2 - game.piece.top(0) - (if (game.piece == BlockPiece.I) 0 else 1))
            settle(game)
        }
        assertEquals(BlockPiece.values().toSet(), seen)
    }

    @Test
    fun rotationCyclesThroughFourStatesAndBack() {
        val game = BiketrisGame(seed = 1L)
        game.placeForTest(BlockPiece.T, 0, 3, 8)
        repeat(4) { assertTrue(game.rotate()) }
        assertEquals(0, game.rotation)
        assertEquals(3, game.pieceX)
        assertEquals(8, game.pieceY)
        assertTrue(game.rotate(clockwise = false))
        assertEquals(3, game.rotation)
    }

    @Test
    fun wallKicksMoveIAndTAwayFromTheLeftWall() {
        val game = BiketrisGame(seed = 1L)
        game.placeForTest(BlockPiece.I, 1, -2, 8)
        assertEquals(0, game.pieceLeft)
        assertTrue(game.rotate())
        assertEquals(2, game.rotation)
        assertEquals(0, game.pieceX, "kicked +2 so the horizontal I fits")
        game.placeForTest(BlockPiece.T, 1, -1, 8)
        assertEquals(0, game.pieceLeft)
        assertTrue(game.rotate())
        assertEquals(2, game.rotation)
        assertEquals(0, game.pieceX, "kicked +1 off the wall")
        game.placeForTest(BlockPiece.J, 3, 8, 8)
        assertEquals(9, game.pieceLeft + game.pieceWidth - 1)
        assertTrue(game.rotate())
        assertTrue(game.pieceLeft + game.pieceWidth - 1 <= 9, "kicked off the right wall")
    }

    @Test
    fun wallKickLiftsAPieceRotatingOnTheFloor() {
        val game = BiketrisGame(seed = 1L)
        game.loadRowsForTest(emptyRows(1))
        game.placeForTest(BlockPiece.T, 0, 3, game.rows - 2)
        assertTrue(game.collides(BlockPiece.T, 1, 3, game.rows - 2), "plain rotation would leave the board")
        assertTrue(game.collides(BlockPiece.T, 1, 2, game.rows - 2), "second test also fails")
        assertTrue(game.rotate())
        assertEquals(1, game.rotation)
        assertEquals(2, game.pieceX)
        assertEquals(game.rows - 3, game.pieceY, "third test kicks one row up")
    }

    @Test
    fun blockedRotationLeavesThePieceUnchanged() {
        val game = BiketrisGame(seed = 1L)
        game.loadRowsForTest(listOf("##########", "##########", "##########", "###....###", "##########", "##########"))
        assertFalse(game.collides(BlockPiece.I, 0, 3, game.rows - 4))
        game.placeForTest(BlockPiece.I, 0, 3, game.rows - 4)
        assertFalse(game.rotate())
        assertEquals(0, game.rotation)
        assertEquals(3, game.pieceX)
        assertEquals(1, game.blockedRotations)
    }

    @Test
    fun boundaryCollisionStopsAtBothWalls() {
        val game = BiketrisGame(seed = 1L)
        game.placeForTest(BlockPiece.I, 0, 3, 4)
        game.setTarget(99)
        repeat(30) { game.advance(0.05f) }
        assertEquals(game.columns - 4, game.pieceLeft)
        game.setTarget(0)
        repeat(30) { game.advance(0.05f) }
        assertEquals(0, game.pieceLeft)
        game.placeForTest(BlockPiece.O, 0, 4, 4)
        game.setTarget(99)
        repeat(30) { game.advance(0.05f) }
        assertEquals(8, game.pieceLeft, "O is two wide")
    }

    @Test
    fun aFarTargetNeverCarriesThePieceThroughSettledCells() {
        val game = BiketrisGame(seed = 1L)
        val rows = List(14) { ".....#...." }
        game.loadRowsForTest(rows)
        game.placeForTest(BlockPiece.O, 0, 1, 8)
        game.setTarget(8)
        repeat(4) { game.advance(0.05f) }
        assertEquals(3, game.pieceLeft, "stops against the column at x=5")
        repeat(20) { game.advance(0.05f) }
        assertEquals(3, game.pieceLeft)
        assertFalse(game.collides(game.piece, game.rotation, game.pieceX, game.pieceY))
    }

    @Test
    fun movementIsRateLimitedToOneColumnPerInterval() {
        val game = BiketrisGame(seed = 1L)
        game.placeForTest(BlockPiece.O, 0, 0, 4)
        game.setTarget(8)
        repeat(7) { game.advance(0.03f) }
        assertTrue(game.pieceLeft in 3..4, "about one column per interval, got ${game.pieceLeft}")
    }

    @Test
    fun gravityDropsOneRowPerIntervalAndSpeedsUpWithLevel() {
        val game = BiketrisGame(seed = 1L)
        val y0 = game.pieceY
        repeat(8) { game.advance(0.05f) }
        assertEquals(y0, game.pieceY, "0.40 s is below the new 0.42 s level-1 interval")
        repeat(2) { game.advance(0.05f) }
        assertEquals(y0 + 1, game.pieceY)
        repeat(8) { game.advance(0.05f) }
        assertEquals(y0 + 2, game.pieceY)
        assertEquals(0.42f, game.config.gravitySeconds(1), 1e-4f)
        assertEquals(0.42f, game.effectiveGravitySeconds, 1e-4f, "neutral cadence scale")
        var previous = game.config.gravitySeconds(1)
        for (level in 2..30) {
            val next = game.config.gravitySeconds(level)
            assertTrue(next <= previous, "level $level")
            previous = next
        }
        assertTrue(game.config.gravitySeconds(2) in 0.36f..0.38f, "level 2 retains 12% acceleration")
        assertEquals(game.config.minGravitySeconds, game.config.gravitySeconds(60), 1e-4f)
    }

    @Test
    fun changingTheGravityScaleKeepsFallProgressContinuous() {
        val game = BiketrisGame(seed = 1L)
        val y0 = game.pieceY
        repeat(5) { game.advance(0.04f) }
        val halfway = game.fallProgress
        assertEquals(0.5f, halfway, 0.03f)
        game.gravityScale = 0.75f
        game.advance(0.0f)
        assertEquals(halfway, game.fallProgress, 1e-6f, "a new interval never resets or jumps the progress")
        assertEquals(y0, game.pieceY, "no immediate drop just because the interval shortened")
        var t = 0f
        while (game.pieceY == y0) {
            game.advance(0.01f)
            t += 0.01f
        }
        assertEquals((1f - halfway) * 0.42f * 0.75f, t, 0.03f, "gravity responds without resetting existing fall progress")
        assertTrue(game.fallProgress < 0.1f)
        game.gravityScale = 1.25f
        repeat(20) { game.advance(0.05f) }
        assertEquals(y0 + 2, game.pieceY, "one row per 0.525 s after returning to slower gravity")
    }

    @Test
    fun gravityScaleIsBoundedAndLevelsKeepTheCadenceEffect() {
        val game = BiketrisGame(seed = 1L)
        game.gravityScale = 10f
        assertEquals(BiketrisGame.MAX_GRAVITY_SCALE, game.gravityScale)
        game.gravityScale = 0f
        assertEquals(BiketrisGame.MIN_GRAVITY_SCALE, game.gravityScale)
        game.gravityScale = Float.NaN
        assertEquals(1f, game.gravityScale)
        val cfg = game.config
        val fast = maxOf(cfg.minEffectiveGravitySeconds, cfg.gravitySeconds(60) * 0.75f)
        val slow = maxOf(cfg.minEffectiveGravitySeconds, cfg.gravitySeconds(60) * 1.25f)
        assertTrue(slow > fast, "the level floor does not erase the cadence modes at top speed")
        assertTrue(fast >= cfg.minEffectiveGravitySeconds)
    }

    @Test
    fun lockDelayIgnoresTheGravityScale() {
        for (scale in floatArrayOf(0.5f, 1f, 2f)) {
            val game = BiketrisGame(seed = 1L)
            game.gravityScale = scale
            game.loadRowsForTest(emptyRows(1))
            game.placeForTest(BlockPiece.O, 0, 4, game.rows - 2)
            val spawned = game.piecesSpawned
            repeat(9) { game.advance(0.05f) }
            assertEquals(spawned, game.piecesSpawned, "scale $scale: still inside the 0.5 s lock delay")
            repeat(2) { game.advance(0.05f) }
            assertEquals(spawned + 1, game.piecesSpawned, "scale $scale: locked at 0.5 s")
        }
    }

    @Test
    fun levelsProgressTheSameWayAtAnyGravityScale() {
        for (scale in floatArrayOf(0.75f, 1.25f)) {
            val game = BiketrisGame(seed = 1L)
            game.gravityScale = scale
            repeat(3) {
                game.loadRowsForTest(List(4) { "#########." })
                game.placeForTest(BlockPiece.I, 1, 7, 4)
                settle(game)
            }
            assertEquals(2, game.level, "scale $scale")
            assertEquals(2400, game.score, "scale $scale")
            assertEquals(game.config.gravitySeconds(2) * scale, game.effectiveGravitySeconds, 1e-4f)
        }
    }

    @Test
    fun lockDelayHoldsALandedPieceThenLocks() {
        val game = BiketrisGame(seed = 1L)
        game.loadRowsForTest(emptyRows(1))
        game.placeForTest(BlockPiece.O, 0, 4, game.rows - 2)
        assertTrue(game.grounded)
        val spawned = game.piecesSpawned
        repeat(9) { game.advance(0.05f) }
        assertEquals(spawned, game.piecesSpawned, "still sliding inside the 0.5 s lock delay")
        repeat(2) { game.advance(0.05f) }
        assertEquals(spawned + 1, game.piecesSpawned)
        assertEquals(BlockPiece.O.color, game.cell(4, game.rows - 1))
    }

    @Test
    fun lockDelayResetsAreBounded() {
        val game = BiketrisGame(seed = 1L)
        game.loadRowsForTest(emptyRows(1))
        game.placeForTest(BlockPiece.O, 0, 4, game.rows - 2)
        val spawned = game.piecesSpawned
        var t = 0f
        var target = 0
        while (game.piecesSpawned == spawned && t < 20f) {
            game.setTarget(if (target % 2 == 0) 3 else 5)
            target += 1
            game.advance(0.1f)
            t += 0.1f
        }
        assertEquals(spawned + 1, game.piecesSpawned, "an endlessly sliding piece still locks")
        assertTrue(t < game.config.maxLockResets * 0.5f + 1.5f, "locked after the reset budget, took $t s")
        assertTrue(t > game.config.lockDelaySeconds + 0.3f, "moves did extend the lock delay")
    }

    @Test
    fun singleDoubleTripleAndQuadClearsScoreConsistently() {
        for (n in 1..4) {
            val game = BiketrisGame(seed = 1L)
            game.loadRowsForTest(List(n) { "#########." })
            game.placeForTest(BlockPiece.I, 1, 7, 4)
            settle(game)
            assertEquals(n, game.lines, "$n lines")
            assertEquals(game.config.linePoints(n), game.score)
            assertEquals(1, game.clearsBySize[n])
            assertEquals(n, game.lastClearCount)
            val rows = game.rowsForTest()
            for (r in 0 until game.rows - (4 - n)) assertEquals("..........", rows[r], "row $r after $n clears")
            for (r in game.rows - (4 - n) until game.rows) assertEquals(".........#", rows[r])
        }
        assertEquals(listOf(100, 300, 500, 800), (1..4).map { BiketrisConfig().linePoints(it) })
    }

    @Test
    fun nonAdjacentRowsClearTogetherAndTheRestCompacts() {
        val game = BiketrisGame(seed = 1L)
        game.loadRowsForTest(listOf("#########.", "#########.", "#.........", "#########."))
        game.placeForTest(BlockPiece.I, 1, 7, 4)
        settle(game)
        assertEquals(3, game.lines)
        assertEquals(1, game.clearsBySize[3])
        val rows = game.rowsForTest()
        assertEquals("#........#", rows[game.rows - 1])
        for (r in 0 until game.rows - 1) assertEquals("..........", rows[r])
    }

    @Test
    fun aPieceThatCannotSpawnEndsTheGame() {
        val game = BiketrisGame(seed = 1L)
        val rows = ArrayList<String>()
        repeat(game.rows - 4) { rows += "###.######" }
        rows.add(0, "...####...")
        rows.add(0, "...####...")
        game.loadRowsForTest(rows)
        game.placeForTest(BlockPiece.O, 0, 0, 0)
        assertFalse(game.collides(BlockPiece.O, 0, 0, 0))
        var t = 0f
        while (game.phase == BiketrisPhase.Playing && t < 10f) {
            game.advance(0.05f)
            t += 0.05f
        }
        assertEquals(BiketrisPhase.GameOver, game.phase)
        val before = game.pieceY
        game.advance(1f)
        assertEquals(before, game.pieceY, "nothing moves after game over")
        assertFalse(game.rotate())
    }

    @Test
    fun sevenBagDealsEveryPieceOncePerSeven() {
        val game = BiketrisGame(seed = 42L)
        val dealt = ArrayList<BlockPiece>()
        dealt += game.piece
        dealt += game.next
        repeat(68) {
            game.loadRowsForTest(emptyRows(1))
            game.placeForTest(game.piece, 0, 3, game.rows - 3)
            settle(game)
            dealt += game.next
        }
        for (chunk in dealt.chunked(7).filter { it.size == 7 }) assertEquals(BlockPiece.values().toSet(), chunk.toSet(), "$chunk")
        assertTrue(dealt.groupingBy { it }.eachCount().values.all { it == 10 })
    }

    @Test
    fun seedsAreDeterministic() {
        fun sequence(seed: Long): List<BlockPiece> {
            val game = BiketrisGame(seed = seed)
            val out = arrayListOf(game.piece, game.next)
            repeat(12) {
                game.loadRowsForTest(emptyRows(1))
                game.placeForTest(game.piece, 0, 3, game.rows - 3)
                settle(game)
                out += game.next
            }
            return out
        }
        assertEquals(sequence(7L), sequence(7L))
        assertNotEquals(sequence(7L), sequence(8L))
    }

    @Test
    fun scoreUsesTheLevelAtClearTimeAndLevelsFollowLines() {
        val game = BiketrisGame(seed = 1L)
        repeat(3) {
            game.loadRowsForTest(List(4) { "#########." })
            game.placeForTest(BlockPiece.I, 1, 7, 4)
            settle(game)
        }
        assertEquals(12, game.lines)
        assertEquals(2, game.level)
        assertEquals(2400, game.score)
        game.loadRowsForTest(List(4) { "#########." })
        game.placeForTest(BlockPiece.I, 1, 7, 4)
        settle(game)
        assertEquals(2400 + 1600, game.score)
        assertEquals(16, game.lines)
    }

    @Test
    fun restartClearsEverythingAndRepeatsTheSeed() {
        val fresh = BiketrisGame(seed = 99L)
        val game = BiketrisGame(seed = 5L)
        game.loadRowsForTest(List(4) { "#########." })
        game.placeForTest(BlockPiece.I, 1, 7, 4)
        settle(game)
        game.setTarget(2)
        game.rotate()
        game.restart(99L)
        assertEquals(0, game.score)
        assertEquals(0, game.lines)
        assertEquals(1, game.level)
        assertEquals(BiketrisPhase.Playing, game.phase)
        assertEquals(-1, game.targetLeft)
        assertEquals(1, game.piecesSpawned)
        assertTrue(game.rowsForTest().all { it == ".........." })
        assertEquals(fresh.piece, game.piece)
        assertEquals(fresh.next, game.next)
        assertEquals(fresh.pieceX, game.pieceX)
        assertEquals(fresh.pieceY, game.pieceY)
    }

    @Test
    fun aLargeTimeGapAdvancesAtMostOneBoundedFrame() {
        val game = BiketrisGame(seed = 1L)
        val y0 = game.pieceY
        val t0 = 5_000_000_000L
        game.update(t0)
        val steps = game.update(t0 + 30_000_000_000L)
        assertTrue(steps <= 7, "bounded to maxFrameSeconds, ran $steps steps")
        assertEquals(y0, game.pieceY)
        game.resetClock()
        assertEquals(0, game.update(t0 + 60_000_000_000L), "first update after a reset only arms the clock")
    }
    @Test
    fun difficultyHasFiveDistinctSpeedsAndDefaultPreservesExistingGravity() {
        val game = BiketrisGame(seed = 12L)
        assertEquals(3, game.difficultyLevel)
        assertEquals(0.42f, game.effectiveGravitySeconds, 1e-4f)
        val expected = floatArrayOf(0.84f, 0.63f, 0.42f, 0.315f, 0.21f)
        for (level in 1..5) {
            game.difficultyLevel = level
            assertEquals(expected[level - 1], game.effectiveGravitySeconds, 1e-4f)
            assertEquals(level, BiketrisDifficulty.fromFraction((level - 1) / 4f))
        }
        game.difficultyLevel = -100
        assertEquals(1, game.difficultyLevel)
        game.difficultyLevel = 999
        assertEquals(5, game.difficultyLevel)
        assertEquals(1, BiketrisDifficulty.fromFraction(-1f))
        assertEquals(5, BiketrisDifficulty.fromFraction(2f))
    }

    @Test
    fun cadenceStillRewardsPedalingAtEveryDifficulty() {
        val game = BiketrisGame(seed = 12L)
        for (level in 1..5) {
            game.difficultyLevel = level
            game.gravityScale = 0.75f
            val fast = game.effectiveGravitySeconds
            game.gravityScale = 1f
            val neutral = game.effectiveGravitySeconds
            game.gravityScale = 1.25f
            val slow = game.effectiveGravitySeconds
            assertTrue(fast < neutral, "difficulty $level must speed up below neutral cadence")
            assertTrue(slow > neutral, "difficulty $level must slow down above neutral cadence")
        }
    }

    @Test
    fun difficultyChangesDoNotResetAnActivePieceOrRevertOnRestart() {
        val game = BiketrisGame(seed = 12L)
        game.advance(0.2f)
        val row = game.pieceY
        val progress = game.fallProgress
        game.difficultyLevel = 5
        game.advance(0f)
        assertEquals(row, game.pieceY)
        assertEquals(progress, game.fallProgress, 1e-5f)
        assertEquals(0.21f, game.effectiveGravitySeconds, 1e-4f)
        game.restart(13L)
        assertEquals(5, game.difficultyLevel)
    }

    @Test
    fun difficultyPreferenceIsReadAndSavedIndependentlyFromPedalMode() {
        val source = File("src/main/kotlin/com/fitbaus/arcade/BiketrisView.kt").readText()
        assertTrue(source.contains("prefs.getInt(BiketrisDifficulty.KEY, BiketrisDifficulty.DEFAULT_LEVEL)"))
        assertTrue(source.contains("prefs.edit().putInt(BiketrisDifficulty.KEY, difficultyLevel).apply()"))
        assertTrue(source.contains("session.cadence.enabled = pedalToSlowEnabled"))
        assertEquals("biketris_difficulty", BiketrisDifficulty.KEY)
    }

}
