// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.random.Random

public enum class BikeMotion { Stationary, Moving, Unknown }

/**
 * Read-only pedaling state for diagnostics. Only a current, fresh, initialized RPM reading of zero
 * counts as stationary. Missing, stale, disconnected or unchanged-for-too-long telemetry is
 * [BikeMotion.Unknown]. Finger Math does not gate answers on it.
 */
public class BikeMotionMonitor(private val staleNanos: Long = 3_000_000_000L) {
    private var lastObservedAt: String? = null
    private var observedChangedAt = Long.MIN_VALUE

    public var motion: BikeMotion = BikeMotion.Unknown
        private set

    public fun update(
        connected: Boolean,
        initialized: Boolean,
        rpm: Int?,
        rpmCurrent: Boolean,
        rpmObservedAt: String?,
        nowNanos: Long,
    ): BikeMotion {
        if (rpmObservedAt != lastObservedAt) {
            lastObservedAt = rpmObservedAt
            observedChangedAt = nowNanos
        }
        val fresh = rpmObservedAt != null && observedChangedAt != Long.MIN_VALUE && nowNanos - observedChangedAt <= staleNanos
        motion = when {
            !connected || !initialized || !rpmCurrent || rpm == null || !fresh -> BikeMotion.Unknown
            rpm > 0 -> BikeMotion.Moving
            else -> BikeMotion.Stationary
        }
        return motion
    }

    public fun reset() {
        lastObservedAt = null
        observedChangedAt = Long.MIN_VALUE
        motion = BikeMotion.Unknown
    }
}

/** The four Finger Math operations. Every generated question has an exact whole answer in 0..10. */
internal enum class MathOp(val symbol: String) {
    Add("+"),
    Subtract("-"),
    Multiply("×"),
    Divide("÷"),
    ;

    fun apply(left: Int, right: Int): Int = when (this) {
        Add -> left + right
        Subtract -> left - right
        Multiply -> left * right
        Divide -> left / right
    }
}

internal data class MathQuestion(val left: Int, val op: MathOp, val right: Int) {
    /** Computed once per question so the 30 Hz draw path does not rebuild strings. */
    val answer: Int = op.apply(left, right)
    val text: String = "$left ${op.symbol} $right = ?"
}

/**
 * Seeded question source covering all four operations. Operations are dealt from a shuffled bag
 * of four, so every run of four questions contains each operation once and the same operation
 * never appears twice in a row (which also rules out an immediate identical repeat). Each
 * operation draws from a precomputed pool of valid questions: no rejection loops, no negative or
 * fractional answers, no division by zero. Trivial forms (x0, x1, /1, +0, -0, n/n, 0/n) live in a
 * separate pool drawn about one time in [TRIVIAL_ONE_IN].
 */
internal class QuestionGenerator(private val random: Random) {
    private val bag = MathOp.values()
    private var bagIndex = bag.size
    private var lastOp: MathOp? = null

    fun next(previous: MathQuestion?): MathQuestion {
        val op = nextOp(previous?.op ?: lastOp)
        lastOp = op
        val pool = if (random.nextInt(TRIVIAL_ONE_IN) == 0) TRIVIAL[op.ordinal] else REGULAR[op.ordinal]
        var index = random.nextInt(pool.size)
        if (pool[index] == previous) index = (index + 1) % pool.size
        return pool[index]
    }

    private fun nextOp(avoid: MathOp?): MathOp {
        if (bagIndex >= bag.size) {
            for (i in bag.size - 1 downTo 1) swap(i, random.nextInt(i + 1))
            if (bag[0] == avoid) swap(0, 1 + random.nextInt(bag.size - 1))
            bagIndex = 0
        }
        return bag[bagIndex++]
    }

    private fun swap(i: Int, j: Int) {
        val t = bag[i]
        bag[i] = bag[j]
        bag[j] = t
    }

    companion object {
        const val MAX_ANSWER: Int = 10
        const val TRIVIAL_ONE_IN: Int = 6

        /** Largest subtrahend / divisor in regular questions: minuends reach 20, dividends 100. */
        private const val MAX_OPERAND = 10

        private val REGULAR: Array<List<MathQuestion>> = Array(MathOp.values().size) { pool(MathOp.values()[it], trivial = false) }
        private val TRIVIAL: Array<List<MathQuestion>> = Array(MathOp.values().size) { pool(MathOp.values()[it], trivial = true) }

        internal fun pool(op: MathOp, trivial: Boolean): List<MathQuestion> {
            val out = LinkedHashSet<MathQuestion>()
            when (op) {
                MathOp.Add -> if (trivial) {
                    for (n in 0..MAX_ANSWER) {
                        out += MathQuestion(n, op, 0)
                        out += MathQuestion(0, op, n)
                    }
                } else {
                    for (a in 1 until MAX_ANSWER) for (b in 1..MAX_ANSWER - a) out += MathQuestion(a, op, b)
                }
                MathOp.Subtract -> if (trivial) {
                    for (n in 1..MAX_ANSWER) out += MathQuestion(n, op, 0)
                } else {
                    for (b in 1..MAX_OPERAND) for (answer in 0..MAX_ANSWER) out += MathQuestion(b + answer, op, b)
                }
                MathOp.Multiply -> if (trivial) {
                    for (n in 0..MAX_ANSWER) {
                        out += MathQuestion(n, op, 1)
                        out += MathQuestion(1, op, n)
                        out += MathQuestion(n, op, 0)
                        out += MathQuestion(0, op, n)
                    }
                } else {
                    for (a in 2..MAX_ANSWER) for (b in 2..MAX_ANSWER) if (a * b <= MAX_ANSWER) out += MathQuestion(a, op, b)
                }
                MathOp.Divide -> if (trivial) {
                    for (n in 0..MAX_ANSWER) out += MathQuestion(n, op, 1)
                    for (d in 2..MAX_OPERAND) {
                        out += MathQuestion(0, op, d)
                        out += MathQuestion(d, op, d)
                    }
                } else {
                    for (d in 2..MAX_OPERAND) for (q in 2..MAX_ANSWER) out += MathQuestion(q * d, op, d)
                }
            }
            return out.toList()
        }
    }
}

internal enum class AnswerSource { Camera, Touch }

internal enum class MathPhase { Asking, Correct }

internal enum class MathFeedback { None, Correct, Wrong }

internal class MathAnswer(val value: Int, val source: AnswerSource, val correct: Boolean, val atNanos: Long, val question: MathQuestion)

/**
 * Endless Finger Math. A camera answer is submitted only from a [FingerInputState.Stable] reading
 * while the game is armed; every submission disarms it until the player releases (hands down,
 * one hand, stale input) or shows a different total. Pedaling never blocks answers.
 *
 * Scoring: [correct] counts each completed question once, whether or not it was missed first.
 * A wrong answer keeps the question and costs only time. The headline score is
 * [correctPerMinute] = correct x 60 / elapsed gameplay seconds.
 *
 * Gameplay clock: [elapsedNanos] is the sum of monotonic deltas between consecutive [update]
 * calls made with `inputReady = true` (camera ready, or camera failed so touch is the input).
 * The first ready update after construction or [restart] is the start point and adds nothing.
 * Camera start-up ticks, [suspendClock] (view hidden or detached), and any gap longer than
 * [maxTickGapNanos] (host paused, app backgrounded, UI stall) are never counted.
 */
internal class FingerMathGame(
    random: Random = Random.Default,
    val correctHoldNanos: Long = 600_000_000L,
    private val wrongHoldNanos: Long = 1_600_000_000L,
    private val maxTickGapNanos: Long = 1_000_000_000L,
) {
    private val generator = QuestionGenerator(random)

    var events: ((String) -> Unit)? = null

    var question: MathQuestion = generator.next(null)
        private set
    var phase: MathPhase = MathPhase.Asking
        private set
    var feedback: MathFeedback = MathFeedback.None
        private set
    var feedbackAtNanos: Long = 0L
        private set
    var correct: Int = 0
        private set
    var wrongAnswers: Int = 0
        private set
    var cameraAnswers: Int = 0
        private set
    var touchAnswers: Int = 0
        private set
    var elapsedNanos: Long = 0L
        private set
    var armed: Boolean = true
        private set
    var lastAnswer: MathAnswer? = null
        private set
    private var heldTotal: Int? = null
    private var lastTickNanos = NO_TICK

    val correctPerMinute: Double
        get() = perMinute(correct, elapsedNanos)

    fun update(nowNanos: Long, reading: FingerCountReading, inputReady: Boolean) {
        tickClock(nowNanos, inputReady)
        if (!armed && (reading.released || (reading.total != null && reading.total != heldTotal))) {
            armed = true
            heldTotal = null
        }
        when (phase) {
            MathPhase.Correct -> if (nowNanos - feedbackAtNanos >= correctHoldNanos) advance()
            MathPhase.Asking -> {
                if (feedback == MathFeedback.Wrong && nowNanos - feedbackAtNanos >= wrongHoldNanos) feedback = MathFeedback.None
                val total = reading.stableTotal
                if (total != null && armed) submit(total, AnswerSource.Camera, nowNanos, total)
            }
        }
    }

    fun submitTouch(value: Int, nowNanos: Long, reading: FingerCountReading): Boolean {
        if (phase != MathPhase.Asking || value !in 0..QuestionGenerator.MAX_ANSWER) return false
        submit(value, AnswerSource.Touch, nowNanos, reading.total)
        return true
    }

    /** Stops the gameplay clock until the next ready [update]; the gap in between is not counted. */
    fun suspendClock() {
        lastTickNanos = NO_TICK
    }

    fun restart() {
        correct = 0
        wrongAnswers = 0
        cameraAnswers = 0
        touchAnswers = 0
        elapsedNanos = 0L
        lastTickNanos = NO_TICK
        phase = MathPhase.Asking
        feedback = MathFeedback.None
        lastAnswer = null
        question = generator.next(question)
        armed = true
        heldTotal = null
        events?.invoke("math: restart")
    }

    private fun tickClock(now: Long, running: Boolean) {
        if (!running) {
            lastTickNanos = NO_TICK
            return
        }
        val last = lastTickNanos
        lastTickNanos = now
        if (last == NO_TICK) return
        val delta = now - last
        if (delta in 1..maxTickGapNanos) elapsedNanos += delta
    }

    private fun submit(value: Int, source: AnswerSource, now: Long, currentTotal: Int?) {
        val right = value == question.answer
        lastAnswer = MathAnswer(value, source, right, now, question)
        if (source == AnswerSource.Camera) cameraAnswers += 1 else touchAnswers += 1
        armed = currentTotal == null
        heldTotal = currentTotal
        feedbackAtNanos = now
        events?.invoke("math: ${question.text} answered $value by $source -> ${if (right) "correct" else "wrong"}")
        if (right) {
            correct += 1
            feedback = MathFeedback.Correct
            phase = MathPhase.Correct
        } else {
            wrongAnswers += 1
            feedback = MathFeedback.Wrong
        }
    }

    private fun advance() {
        feedback = MathFeedback.None
        question = generator.next(question)
        phase = MathPhase.Asking
    }

    companion object {
        private const val NO_TICK = Long.MIN_VALUE

        fun perMinute(correct: Int, elapsedNanos: Long): Double =
            if (elapsedNanos <= 0L) 0.0 else correct * 60_000_000_000.0 / elapsedNanos
    }
}
