// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.random.Random

/**
 * The seven four-cell pieces. [spawn] lists the state-0 cells as (x, y) pairs inside a
 * [size]x[size] box, y growing downward. The other three states are clockwise box rotations,
 * which match the standard rotation-system states for 3x3 and 4x4 boxes; O never changes.
 */
internal enum class BlockPiece(val size: Int, spawn: IntArray) {
    I(4, intArrayOf(0, 1, 1, 1, 2, 1, 3, 1)),
    O(2, intArrayOf(0, 0, 1, 0, 0, 1, 1, 1)),
    T(3, intArrayOf(1, 0, 0, 1, 1, 1, 2, 1)),
    S(3, intArrayOf(1, 0, 2, 0, 0, 1, 1, 1)),
    Z(3, intArrayOf(0, 0, 1, 0, 1, 1, 2, 1)),
    J(3, intArrayOf(0, 0, 0, 1, 1, 1, 2, 1)),
    L(3, intArrayOf(2, 0, 0, 1, 1, 1, 2, 1)),
    ;

    val states: Array<IntArray> = Array(4) { IntArray(8) }
    private val minX = IntArray(4)
    private val maxX = IntArray(4)
    private val minY = IntArray(4)

    init {
        System.arraycopy(spawn, 0, states[0], 0, 8)
        for (s in 1 until 4) {
            val from = states[s - 1]
            val to = states[s]
            for (i in 0 until 4) {
                to[i * 2] = size - 1 - from[i * 2 + 1]
                to[i * 2 + 1] = from[i * 2]
            }
        }
        for (s in 0 until 4) {
            val cells = states[s]
            var lx = Int.MAX_VALUE
            var hx = Int.MIN_VALUE
            var ly = Int.MAX_VALUE
            for (i in 0 until 4) {
                lx = minOf(lx, cells[i * 2])
                hx = maxOf(hx, cells[i * 2])
                ly = minOf(ly, cells[i * 2 + 1])
            }
            minX[s] = lx
            maxX[s] = hx
            minY[s] = ly
        }
    }

    fun left(state: Int): Int = minX[state and 3]

    fun width(state: Int): Int = maxX[state and 3] - minX[state and 3] + 1

    fun top(state: Int): Int = minY[state and 3]

    val color: Int
        get() = ordinal + 1
}

/**
 * Wall kicks for a clockwise or counter-clockwise turn, from the standard rotation system. The
 * tables are written with y growing upward, as published, and flipped when applied to the
 * y-down board. O has a single, empty test.
 */
internal object BlockKicks {
    private val JLSTZ_CW = arrayOf(
        intArrayOf(0, 0, -1, 0, -1, 1, 0, -2, -1, -2),
        intArrayOf(0, 0, 1, 0, 1, -1, 0, 2, 1, 2),
        intArrayOf(0, 0, 1, 0, 1, 1, 0, -2, 1, -2),
        intArrayOf(0, 0, -1, 0, -1, -1, 0, 2, -1, 2),
    )
    private val I_CW = arrayOf(
        intArrayOf(0, 0, -2, 0, 1, 0, -2, -1, 1, 2),
        intArrayOf(0, 0, -1, 0, 2, 0, -1, 2, 2, -1),
        intArrayOf(0, 0, 2, 0, -1, 0, 2, 1, -1, -2),
        intArrayOf(0, 0, 1, 0, -2, 0, 1, -2, -2, 1),
    )
    private val JLSTZ_CCW = Array(4) { from -> negate(JLSTZ_CW[(from + 3) and 3]) }
    private val I_CCW = Array(4) { from -> negate(I_CW[(from + 3) and 3]) }
    private val NONE = intArrayOf(0, 0)

    fun tests(piece: BlockPiece, from: Int, clockwise: Boolean): IntArray = when {
        piece == BlockPiece.O -> NONE
        piece == BlockPiece.I -> if (clockwise) I_CW[from and 3] else I_CCW[from and 3]
        else -> if (clockwise) JLSTZ_CW[from and 3] else JLSTZ_CCW[from and 3]
    }

    private fun negate(source: IntArray): IntArray = IntArray(source.size) { -source[it] }
}

internal data class BiketrisConfig(
    val columns: Int = 10,
    val visibleRows: Int = 20,
    val hiddenRows: Int = 2,
    val stepSeconds: Float = 1f / 60f,
    val maxFrameSeconds: Float = 0.1f,
    val baseGravitySeconds: Float = 0.72f,
    val gravityFactor: Float = 0.88f,
    val minGravitySeconds: Float = 0.15f,
    val minEffectiveGravitySeconds: Float = 0.1f,
    val linesPerLevel: Int = 10,
    val lockDelaySeconds: Float = 0.5f,
    val maxLockResets: Int = 12,
    val moveIntervalSeconds: Float = 0.06f,
) {
    init {
        require(columns in 4..20 && visibleRows in 4..40 && hiddenRows in 0..4) { "invalid board" }
        require(stepSeconds > 0f && maxFrameSeconds >= stepSeconds) { "invalid timing" }
        require(baseGravitySeconds >= minGravitySeconds && minGravitySeconds > 0f && minEffectiveGravitySeconds > 0f) { "invalid gravity" }
        require(gravityFactor > 0f && gravityFactor <= 1f) { "invalid gravity factor" }
        require(linesPerLevel >= 1 && maxLockResets >= 0 && lockDelaySeconds > 0f && moveIntervalSeconds >= 0f) { "invalid rules" }
    }

    val rows: Int
        get() = visibleRows + hiddenRows

    fun gravitySeconds(level: Int): Float {
        var seconds = baseGravitySeconds
        repeat((level - 1).coerceIn(0, 60)) { seconds *= gravityFactor }
        return maxOf(minGravitySeconds, seconds)
    }

    fun linePoints(lines: Int): Int = when (lines) {
        1 -> 100
        2 -> 300
        3 -> 500
        4 -> 800
        else -> 0
    }
}

internal enum class BiketrisPhase { Playing, GameOver }

/**
 * Falling-block simulation on a 10x20 board with two hidden rows above it. Pieces come from a
 * seeded seven-piece bag and spawn with their top cells on the first visible row; a piece that
 * cannot spawn ends the game. The active piece slides one column at a time toward [targetLeft]
 * (its desired leftmost occupied column) at most every [BiketrisConfig.moveIntervalSeconds],
 * stopping at walls and settled cells, so a far target can never carry it through the stack.
 * Gravity, lock delay and line clears run in fixed steps independent of the draw rate.
 */
internal class BiketrisGame(val config: BiketrisConfig = BiketrisConfig(), seed: Long = 1L) {
    private val board = IntArray(config.columns * config.rows)
    private val bag = IntArray(PIECES.size)
    private var bagIndex = PIECES.size
    private var random = Random(seed)
    private var accumulator = 0f
    private var lastNanos = Long.MIN_VALUE
    private var lockTimer = 0f
    private var moveTimer = 0f
    private val clearedRows = IntArray(4)

    var seed: Long = seed
        private set
    var phase: BiketrisPhase = BiketrisPhase.Playing
        private set
    var piece: BlockPiece = BlockPiece.T
        private set
    var rotation: Int = 0
        private set
    var pieceX: Int = 0
        private set
    var pieceY: Int = 0
        private set
    var next: BlockPiece = BlockPiece.T
        private set
    var score: Int = 0
        private set
    var lines: Int = 0
        private set
    var level: Int = 1
        private set
    var lockResets: Int = 0
        private set
    var targetLeft: Int = -1
        private set
    var piecesSpawned: Int = 0
        private set
    var rotations: Int = 0
        private set
    var blockedRotations: Int = 0
        private set
    var elapsed: Float = 0f
        private set
    var lastClearCount: Int = 0
        private set
    var lastClearAt: Float = -10f
        private set
    val clearsBySize: IntArray = IntArray(5)

    init {
        restart(seed)
    }

    val columns: Int
        get() = config.columns

    val rows: Int
        get() = config.rows

    val gravitySeconds: Float
        get() = config.gravitySeconds(level)

    var gravityScale: Float = 1f
        set(value) {
            field = if (value.isNaN()) 1f else value.coerceIn(MIN_GRAVITY_SCALE, MAX_GRAVITY_SCALE)
        }

    val effectiveGravitySeconds: Float
        get() = maxOf(config.minEffectiveGravitySeconds, gravitySeconds * gravityScale)

    var fallProgress: Float = 0f
        private set

    val pieceLeft: Int
        get() = pieceX + piece.left(rotation)

    val pieceWidth: Int
        get() = piece.width(rotation)

    val maxLeft: Int
        get() = config.columns - pieceWidth

    val grounded: Boolean
        get() = phase == BiketrisPhase.Playing && collides(piece, rotation, pieceX, pieceY + 1)

    fun cell(column: Int, row: Int): Int = board[row * config.columns + column]

    fun clearedRow(index: Int): Int = clearedRows[index]

    fun restart(seed: Long) {
        this.seed = seed
        random = Random(seed)
        board.fill(0)
        bagIndex = PIECES.size
        score = 0
        lines = 0
        level = 1
        piecesSpawned = 0
        rotations = 0
        blockedRotations = 0
        elapsed = 0f
        lastClearCount = 0
        lastClearAt = -10f
        clearsBySize.fill(0)
        targetLeft = -1
        phase = BiketrisPhase.Playing
        resetClock()
        next = draw()
        spawn()
    }

    fun resetClock() {
        lastNanos = Long.MIN_VALUE
        accumulator = 0f
    }

    fun setTarget(left: Int) {
        targetLeft = if (left < 0) -1 else left.coerceIn(0, maxLeft)
    }

    fun clearTarget() {
        targetLeft = -1
    }

    fun update(nowNanos: Long): Int {
        val dt = if (lastNanos == Long.MIN_VALUE) 0f else (nowNanos - lastNanos) / 1e9f
        lastNanos = nowNanos
        return advance(dt)
    }

    fun advance(frameSeconds: Float): Int {
        accumulator += frameSeconds.coerceIn(0f, config.maxFrameSeconds)
        val step = config.stepSeconds
        var steps = 0
        while (accumulator >= step - 1e-6f) {
            accumulator -= step
            step(step)
            steps += 1
        }
        return steps
    }

    fun rotate(clockwise: Boolean = true): Boolean {
        if (phase != BiketrisPhase.Playing) return false
        val to = (rotation + if (clockwise) 1 else 3) and 3
        val tests = BlockKicks.tests(piece, rotation, clockwise)
        val wasGrounded = grounded
        var i = 0
        while (i < tests.size) {
            val nx = pieceX + tests[i]
            val ny = pieceY - tests[i + 1]
            if (!collides(piece, to, nx, ny)) {
                rotation = to
                pieceX = nx
                pieceY = ny
                rotations += 1
                if (targetLeft >= 0) targetLeft = targetLeft.coerceIn(0, maxLeft)
                onShifted(wasGrounded)
                return true
            }
            i += 2
        }
        blockedRotations += 1
        return false
    }

    fun ghostY(): Int {
        var y = pieceY
        while (!collides(piece, rotation, pieceX, y + 1)) y += 1
        return y
    }

    fun collides(type: BlockPiece, state: Int, x: Int, y: Int): Boolean {
        val cells = type.states[state and 3]
        for (i in 0 until 4) {
            val cx = x + cells[i * 2]
            val cy = y + cells[i * 2 + 1]
            if (cx < 0 || cx >= config.columns || cy < 0 || cy >= config.rows) return true
            if (board[cy * config.columns + cx] != 0) return true
        }
        return false
    }

    private fun step(dt: Float) {
        if (phase != BiketrisPhase.Playing) return
        elapsed += dt
        slide(dt)
        if (grounded) {
            fallProgress = 0f
            lockTimer += dt
            if (lockTimer >= config.lockDelaySeconds - 1e-6f) lock()
            return
        }
        lockTimer = 0f
        fallProgress += dt / effectiveGravitySeconds
        if (fallProgress >= 1f - 1e-5f) {
            fallProgress = maxOf(0f, fallProgress - 1f)
            pieceY += 1
            if (grounded) fallProgress = 0f
        }
    }

    private fun slide(dt: Float) {
        moveTimer = maxOf(0f, moveTimer - dt)
        if (targetLeft < 0 || moveTimer > 1e-6f) return
        val goal = targetLeft.coerceIn(0, maxLeft) - piece.left(rotation)
        if (goal == pieceX) return
        val dx = if (goal > pieceX) 1 else -1
        if (collides(piece, rotation, pieceX + dx, pieceY)) return
        val wasGrounded = grounded
        pieceX += dx
        moveTimer = config.moveIntervalSeconds
        onShifted(wasGrounded)
    }

    private fun onShifted(wasGrounded: Boolean) {
        if ((wasGrounded || grounded) && lockResets < config.maxLockResets) {
            lockTimer = 0f
            lockResets += 1
        }
    }

    private fun lock() {
        val cells = piece.states[rotation]
        for (i in 0 until 4) {
            val cx = pieceX + cells[i * 2]
            val cy = pieceY + cells[i * 2 + 1]
            board[cy * config.columns + cx] = piece.color
        }
        val cleared = clearFullRows()
        if (cleared > 0) {
            score += config.linePoints(cleared) * level
            lines += cleared
            level = 1 + lines / config.linesPerLevel
            clearsBySize[cleared] += 1
            lastClearCount = cleared
            lastClearAt = elapsed
        }
        spawn()
    }

    private fun clearFullRows(): Int {
        val cols = config.columns
        var count = 0
        var write = config.rows - 1
        var read = config.rows - 1
        while (read >= 0) {
            var full = true
            for (c in 0 until cols) {
                if (board[read * cols + c] == 0) {
                    full = false
                    break
                }
            }
            if (full) {
                if (count < clearedRows.size) clearedRows[count] = read
                count += 1
            } else {
                if (write != read) System.arraycopy(board, read * cols, board, write * cols, cols)
                write -= 1
            }
            read -= 1
        }
        if (write >= 0) board.fill(0, 0, (write + 1) * cols)
        return count
    }

    private fun spawn() {
        val type = next
        next = draw()
        val x = (config.columns - type.size) / 2
        val y = config.hiddenRows - type.top(0)
        piece = type
        rotation = 0
        pieceX = x
        pieceY = y
        fallProgress = 0f
        lockTimer = 0f
        moveTimer = 0f
        lockResets = 0
        if (targetLeft >= 0) targetLeft = targetLeft.coerceIn(0, maxLeft)
        piecesSpawned += 1
        if (collides(type, 0, x, y)) phase = BiketrisPhase.GameOver
    }

    private fun draw(): BlockPiece {
        if (bagIndex >= bag.size) {
            for (i in bag.indices) bag[i] = i
            for (i in bag.size - 1 downTo 1) {
                val j = random.nextInt(i + 1)
                val t = bag[i]
                bag[i] = bag[j]
                bag[j] = t
            }
            bagIndex = 0
        }
        return PIECES[bag[bagIndex++]]
    }

    internal fun loadRowsForTest(bottomRows: List<String>) {
        board.fill(0)
        val cols = config.columns
        for ((i, line) in bottomRows.reversed().withIndex()) {
            val row = config.rows - 1 - i
            for (c in 0 until cols) board[row * cols + c] = if (line.getOrNull(c) == '#') BlockPiece.O.color else 0
        }
    }

    internal fun placeForTest(type: BlockPiece, state: Int, x: Int, y: Int) {
        piece = type
        rotation = state and 3
        pieceX = x
        pieceY = y
        fallProgress = 0f
        lockTimer = 0f
        moveTimer = 0f
        lockResets = 0
        phase = BiketrisPhase.Playing
    }

    internal fun rowsForTest(): List<String> = (0 until config.rows).map { r ->
        String(CharArray(config.columns) { c -> if (board[r * config.columns + c] != 0) '#' else '.' })
    }

    internal companion object {
        val PIECES: Array<BlockPiece> = BlockPiece.values()
        const val MIN_GRAVITY_SCALE: Float = 0.5f
        const val MAX_GRAVITY_SCALE: Float = 2f
    }
}
