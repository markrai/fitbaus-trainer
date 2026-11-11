// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.random.Random

class FingerMathGameTest {
    private val ms = 1_000_000L
    private val sec = 1_000_000_000L
    private val game = FingerMathGame(Random(7))
    private var now = 0L

    private fun reading(state: FingerInputState, total: Int?): FingerCountReading =
        FingerCountReading(state, emptyList(), total, if (state == FingerInputState.Stable) 1f else 0.5f, 0L, 0L, null, now)

    private fun stable(total: Int) = reading(FingerInputState.Stable, total)

    private val noHands get() = reading(FingerInputState.NoHands, null)

    private fun step(r: FingerCountReading, advanceMs: Long = 100, ready: Boolean = true) {
        now += advanceMs * ms
        game.update(now, r, ready)
    }

    private fun wrongFor(question: MathQuestion): Int = (question.answer + 1) % 11

    /** Release, show the answer, then wait out the celebration so the next question is up. */
    private fun answerByCamera() {
        step(noHands)
        step(stable(game.question.answer))
        step(noHands, advanceMs = 700)
    }

    // ---- question generation -------------------------------------------------------------

    @Test
    fun allFourOperationsAppearWithExactWholeAnswersFromZeroToTen() {
        val generator = QuestionGenerator(Random(42))
        var previous: MathQuestion? = null
        val perOp = IntArray(MathOp.values().size)
        val answers = HashSet<Int>()
        var bigDividend = false
        repeat(4000) {
            val q = generator.next(previous)
            assertTrue(q.answer in 0..10, "answer in 0..10: ${q.text}")
            assertTrue(q.left >= 0 && q.right >= 0, q.text)
            when (q.op) {
                MathOp.Add -> assertEquals(q.left + q.right, q.answer)
                MathOp.Subtract -> assertTrue(q.left >= q.right, "never negative: ${q.text}")
                MathOp.Multiply -> assertEquals(q.left * q.right, q.answer)
                MathOp.Divide -> {
                    assertNotEquals(0, q.right, "no division by zero")
                    assertEquals(0, q.left % q.right, "exact division: ${q.text}")
                    assertEquals(q.left, q.answer * q.right)
                    if (q.left > 10) bigDividend = true
                }
            }
            assertNotEquals(previous, q, "no immediate repeat")
            assertNotEquals(previous?.op, q.op, "operations rotate")
            perOp[q.op.ordinal] += 1
            answers += q.answer
            previous = q
        }
        for (op in MathOp.values()) assertEquals(1000, perOp[op.ordinal], "every block of four deals each operation once: $op")
        assertEquals((0..10).toSet(), answers, "every finger total including zero appears")
        assertTrue(bigDividend, "dividends may exceed 10")
    }

    @Test
    fun everyPooledQuestionIsValid() {
        for (op in MathOp.values()) for (trivial in listOf(false, true)) {
            val pool = QuestionGenerator.pool(op, trivial)
            assertTrue(pool.size >= 2, "$op trivial=$trivial has room to avoid a repeat")
            assertEquals(pool.size, pool.toSet().size)
            for (q in pool) {
                assertTrue(q.answer in 0..10, q.text)
                if (op == MathOp.Divide) assertTrue(q.right != 0 && q.left % q.right == 0, q.text)
                if (op == MathOp.Subtract) assertTrue(q.left >= q.right, q.text)
            }
        }
        val regularMul = QuestionGenerator.pool(MathOp.Multiply, trivial = false)
        assertTrue(regularMul.none { it.left < 2 || it.right < 2 }, "regular multiplication never uses 0 or 1")
        assertTrue(QuestionGenerator.pool(MathOp.Divide, trivial = false).none { it.right == 1 || it.answer < 2 }, "regular division never divides by 1")
        assertTrue(MathQuestion(24, MathOp.Divide, 4) in QuestionGenerator.pool(MathOp.Divide, trivial = false))
    }

    @Test
    fun trivialQuestionsAreTheExceptionNotTheRule() {
        val generator = QuestionGenerator(Random(5))
        var mul = 0
        var mulTrivial = 0
        var div = 0
        var divByOne = 0
        var previous: MathQuestion? = null
        repeat(8000) {
            val q = generator.next(previous)
            if (q.op == MathOp.Multiply) {
                mul += 1
                if (q.left <= 1 || q.right <= 1) mulTrivial += 1
            }
            if (q.op == MathOp.Divide) {
                div += 1
                if (q.right == 1) divByOne += 1
            }
            previous = q
        }
        assertTrue(mulTrivial in 1 until mul / 4, "x0/x1 appear but rarely: $mulTrivial of $mul")
        assertTrue(divByOne in 1 until div / 8, "/1 appears but rarely: $divByOne of $div")
    }

    @Test
    fun seededGenerationIsDeterministicAndNeverRepeatsAcrossSeeds() {
        val a = QuestionGenerator(Random(99))
        val b = QuestionGenerator(Random(99))
        var prevA: MathQuestion? = null
        var prevB: MathQuestion? = null
        repeat(200) {
            prevA = a.next(prevA)
            prevB = b.next(prevB)
            assertEquals(prevA, prevB)
        }
        for (seed in 0 until 50) {
            val g = QuestionGenerator(Random(seed))
            var prev: MathQuestion? = null
            repeat(200) {
                val q = g.next(prev)
                assertNotEquals(prev, q, "seed $seed")
                prev = q
            }
        }
    }

    @Test
    fun questionTextUsesTheFourSymbols() {
        assertEquals("5 + 2 = ?", MathQuestion(5, MathOp.Add, 2).text)
        assertEquals("9 - 4 = ?", MathQuestion(9, MathOp.Subtract, 4).text)
        assertEquals("3 × 3 = ?", MathQuestion(3, MathOp.Multiply, 3).text)
        assertEquals("24 ÷ 4 = ?", MathQuestion(24, MathOp.Divide, 4).text)
        assertEquals(6, MathQuestion(24, MathOp.Divide, 4).answer)
        assertEquals(0, MathQuestion(0, MathOp.Divide, 7).answer)
    }

    // ---- answering, endless play, scoring ------------------------------------------------

    @Test
    fun aStableCorrectAnswerScoresCelebratesAndAdvances() {
        val first = game.question
        step(reading(FingerInputState.Unstable, first.answer))
        assertEquals(0, game.correct, "unconfirmed totals never score")
        step(stable(first.answer))
        assertEquals(1, game.correct)
        assertEquals(MathPhase.Correct, game.phase)
        assertEquals(AnswerSource.Camera, game.lastAnswer!!.source)
        step(stable(first.answer), advanceMs = 500)
        assertEquals(MathPhase.Correct, game.phase, "brief celebration")
        step(stable(first.answer), advanceMs = 100)
        assertEquals(MathPhase.Asking, game.phase, "celebration is short so it does not throttle the rate")
        assertNotEquals(first, game.question)
    }

    @Test
    fun gameplayIsEndlessWellPastTenAndAHundredQuestions() {
        repeat(250) { i ->
            if (i % 2 == 0) {
                answerByCamera()
            } else {
                assertTrue(game.submitTouch(game.question.answer, now, FingerCountReading.NONE), "question ${i + 1} still accepts answers")
                step(noHands, advanceMs = 700)
            }
            assertEquals(MathPhase.Asking, game.phase)
            if (i + 1 == 10 || i + 1 == 100) assertEquals(i + 1, game.correct)
        }
        assertEquals(250, game.correct)
        assertEquals(125, game.cameraAnswers, "counters are running totals, not a capped history")
        assertEquals(125, game.touchAnswers)
        assertEquals(0, game.wrongAnswers)
    }

    @Test
    fun holdingTheSameGestureCannotScoreAgainUntilReleased() {
        val first = game.question
        step(stable(first.answer))
        step(stable(first.answer), advanceMs = 700)
        val held = first.answer
        repeat(20) { step(stable(held)) }
        assertEquals(1, game.correct, "held gesture is not resubmitted")
        assertEquals(0, game.wrongAnswers, "held gesture is not resubmitted against the next question either")
        assertFalse(game.armed)
        step(noHands)
        assertTrue(game.armed, "lowering the hands re-arms")
        step(stable(game.question.answer))
        assertEquals(2, game.correct)
    }

    @Test
    fun showingADifferentTotalAlsoRearms() {
        val first = game.question
        step(stable(first.answer))
        step(stable(first.answer), advanceMs = 700)
        step(reading(FingerInputState.Unstable, (first.answer + 3) % 11))
        assertTrue(game.armed)
    }

    @Test
    fun uncertainReadingsDoNotRearm() {
        val first = game.question
        step(stable(first.answer))
        step(stable(first.answer), advanceMs = 700)
        step(reading(FingerInputState.Uncertain, null))
        assertFalse(game.armed, "a flicker of uncertainty is not a release")
    }

    @Test
    fun wrongThenCorrectCountsTheQuestionOnceAndCostsOnlyTime() {
        val q = game.question
        val wrong = wrongFor(q)
        step(stable(wrong))
        assertEquals(MathFeedback.Wrong, game.feedback)
        assertEquals(q, game.question, "a wrong answer does not advance")
        assertEquals(1, game.wrongAnswers)
        assertEquals(0, game.correct, "a wrong answer costs no points")
        repeat(30) { step(stable(wrong)) }
        assertEquals(1, game.wrongAnswers, "holding the wrong answer is reported once")
        assertEquals(MathFeedback.None, game.feedback)
        step(noHands)
        step(stable(q.answer))
        assertEquals(MathPhase.Correct, game.phase)
        assertEquals(1, game.correct, "the completed question counts even after a miss")
        repeat(5) { step(stable(q.answer)) }
        assertEquals(MathPhase.Correct, game.phase)
        assertEquals(1, game.correct, "and counts exactly once")
        assertFalse(game.submitTouch(q.answer, now, FingerCountReading.NONE), "no second submission during the celebration")
        assertEquals(1, game.correct)
    }

    @Test
    fun ratePerMinuteFollowsCompletedQuestionsOverGameplayTime() {
        assertEquals(0.0, FingerMathGame.perMinute(0, 0L))
        assertEquals(0.0, FingerMathGame.perMinute(5, 0L), "zero elapsed time is safe")
        assertEquals(6.0, FingerMathGame.perMinute(3, 30 * sec), 1e-9)
        assertEquals(1.5, FingerMathGame.perMinute(1, 40 * sec), 1e-9)

        step(noHands) // start point
        repeat(12) {
            repeat(49) { step(noHands) }
            step(stable(game.question.answer))
        }
        assertEquals(60 * sec, game.elapsedNanos, "600 ticks of 100 ms")
        assertEquals(12, game.correct)
        assertEquals(12.0, game.correctPerMinute, 1e-9)
        repeat(600) { step(noHands) }
        assertEquals(6.0, game.correctPerMinute, 1e-9, "the rate decays while no answer is submitted")
    }

    @Test
    fun clockSkipsCameraStartupSuspensionAndLongGaps() {
        repeat(30) { step(noHands, ready = false) }
        assertEquals(0L, game.elapsedNanos, "camera start-up is not gameplay")
        step(noHands)
        assertEquals(0L, game.elapsedNanos, "the first ready tick is the start point")
        repeat(10) { step(noHands) }
        assertEquals(1 * sec, game.elapsedNanos)
        step(noHands, advanceMs = 5 * 60 * 1000)
        assertEquals(1 * sec, game.elapsedNanos, "a backgrounded or paused host gap is not counted")
        step(noHands)
        assertEquals(1100 * ms, game.elapsedNanos)
        game.suspendClock()
        step(noHands, advanceMs = 900)
        assertEquals(1100 * ms, game.elapsedNanos, "a hidden view does not count")
        step(noHands)
        assertEquals(1200 * ms, game.elapsedNanos)
        repeat(5) { step(noHands, ready = false) }
        step(noHands)
        assertEquals(1200 * ms, game.elapsedNanos, "camera restart is not counted")
        now -= 50 * ms
        step(noHands, advanceMs = 0)
        assertEquals(1200 * ms, game.elapsedNanos, "time never runs backwards")
    }

    @Test
    fun restartClearsScoreTimeAndAnswerState() {
        step(noHands)
        answerByCamera()
        step(stable(wrongFor(game.question)))
        repeat(20) { step(noHands) }
        assertTrue(game.elapsedNanos > 0L)
        step(stable(game.question.answer))
        assertFalse(game.armed)
        game.restart()
        assertEquals(0, game.correct)
        assertEquals(0, game.wrongAnswers)
        assertEquals(0, game.cameraAnswers)
        assertEquals(0, game.touchAnswers)
        assertEquals(0L, game.elapsedNanos)
        assertEquals(0.0, game.correctPerMinute)
        assertNull(game.lastAnswer)
        assertTrue(game.armed)
        assertEquals(MathPhase.Asking, game.phase)
        assertEquals(MathFeedback.None, game.feedback)
        step(noHands, advanceMs = 3000)
        assertEquals(0L, game.elapsedNanos, "the first tick after restart is a fresh start point")
        step(noHands)
        assertEquals(100 * ms, game.elapsedNanos)
    }

    @Test
    fun pedalingNeverBlocksAnswers() {
        val q = game.question
        step(stable(q.answer))
        assertEquals(1, game.correct, "answers count while pedaling: the game takes no bike state at all")
        step(noHands, advanceMs = 700)
        assertTrue(game.submitTouch(game.question.answer, now, FingerCountReading.NONE))
        assertEquals(2, game.correct)
    }

    @Test
    fun touchFallbackCoversZeroToTenAndIsRecordedSeparately() {
        val q = game.question
        assertTrue(game.submitTouch(q.answer, now, FingerCountReading.NONE))
        assertEquals(AnswerSource.Touch, game.lastAnswer!!.source)
        assertEquals(1, game.touchAnswers)
        assertEquals(0, game.cameraAnswers)
        assertFalse(game.submitTouch(11, now, FingerCountReading.NONE))
        assertFalse(game.submitTouch(-1, now, FingerCountReading.NONE))
        step(FingerCountReading.NONE, advanceMs = 700)
        step(stable(game.question.answer))
        assertEquals(1, game.cameraAnswers)

        val touchOnly = FingerMathGame(Random(11))
        val seen = HashSet<Int>()
        var t = 0L
        while (seen.size < 11) {
            val answer = touchOnly.question.answer
            for (v in 0..10) if (v != answer) assertTrue(touchOnly.submitTouch(v, t, FingerCountReading.NONE), "key $v accepted")
            assertTrue(touchOnly.submitTouch(answer, t, FingerCountReading.NONE))
            seen += answer
            t += 700 * ms
            touchOnly.update(t, FingerCountReading.NONE, inputReady = true)
            assertTrue(t < 10_000 * sec, "every answer 0..10 reachable by touch")
        }
    }

    // ---- two-hand recognition through the real FingerCountInput --------------------------

    private inner class Hands {
        val input = FingerCountInput().also { it.configure(500 * ms) }
        private val gen = input.generation()
        private var seq = 0L

        fun show(vararg counts: Pair<Int, Int?>) {
            input.publish(observation(++seq, now / ms, *counts), gen)
            now += 250 * ms
            game.update(now, input.read(now), inputReady = true)
        }

        fun hold(steps: Int, vararg counts: Pair<Int, Int?>) = repeat(steps) { show(*counts) }

        fun split(total: Int): Array<Pair<Int, Int?>> = arrayOf(1 to minOf(5, total), 2 to total - minOf(5, total))
    }

    @Test
    fun aSingleRecognizedHandIsNeverEnoughToAnswer() {
        val hands = Hands()
        val answer = game.question.answer
        val one = minOf(5, answer)
        hands.hold(10, 1 to one)
        assertEquals(0, game.correct + game.wrongAnswers, "one hand never submits, even showing a plausible answer")
        hands.hold(10, 1 to 5, 2 to null)
        assertEquals(0, game.correct + game.wrongAnswers, "an uncertain second hand never submits")
    }

    @Test
    fun twoConfirmedHandsAnswerOnceAndMustChangeToRearm() {
        val hands = Hands()
        val first = game.question.answer
        hands.hold(2, *hands.split(first))
        assertEquals(0, game.correct, "two observations are not yet confirmation")
        hands.hold(8, *hands.split(first))
        assertEquals(1, game.correct)
        assertEquals(0, game.wrongAnswers, "the held gesture is not resubmitted to the next question")
        assertFalse(game.armed)
        hands.hold(1, 1 to 5)
        assertTrue(game.armed, "dropping to one hand releases")
        val second = game.question.answer
        hands.hold(6, *hands.split(second))
        assertEquals(2, game.correct)
        assertEquals(2, game.cameraAnswers)
    }

    @Test
    fun zeroIsAnsweredWithTwoClosedFists() {
        val zero = FingerMathGame(Random(1))
        var t = 0L
        var guard = 0
        while (zero.question.answer != 0) {
            assertTrue(zero.submitTouch(zero.question.answer, t, FingerCountReading.NONE))
            t += 700 * ms
            zero.update(t, FingerCountReading.NONE, inputReady = true)
            assertTrue(++guard < 1000, "a zero answer comes up")
        }
        val input = FingerCountInput().also { it.configure(500 * ms) }
        val gen = input.generation()
        repeat(6) { i ->
            input.publish(observation(i + 1L, t / ms, 1 to 0, 2 to 0), gen)
            t += 250 * ms
            zero.update(t, input.read(t), inputReady = true)
        }
        assertEquals(AnswerSource.Camera, zero.lastAnswer!!.source)
        assertEquals(0, zero.lastAnswer!!.value)
        assertTrue(zero.lastAnswer!!.correct)
    }

    // ---- UI text -------------------------------------------------------------------------

    @Test
    fun hudShowsRateCorrectCountAndTime() {
        assertEquals("--.-", FingerMathText.rate(game), "no rate before a second of play")
        assertEquals("CORRECT 0   TIME 0:00", FingerMathText.detail(game))
        step(noHands)
        repeat(299) { step(noHands) }
        step(stable(game.question.answer))
        assertEquals(30 * sec, game.elapsedNanos)
        assertEquals("2.0", FingerMathText.rate(game))
        assertEquals("CORRECT 1   TIME 0:30   last: camera", FingerMathText.detail(game))
        step(noHands, advanceMs = 700)
        game.submitTouch(game.question.answer, now, FingerCountReading.NONE)
        assertTrue(FingerMathText.detail(game).endsWith("last: touch"))
        assertEquals("CORRECT / MIN", FingerMathText.RATE_CAPTION)
        assertEquals("0:00", FingerMathText.elapsed(0L))
        assertEquals("1:05", FingerMathText.elapsed(65 * sec + 999 * ms))
        assertEquals("1:00:00", FingerMathText.elapsed(3600 * sec))
        assertEquals("--.-", FingerMathText.rate(FingerMathGame(Random(2))))
    }

    @Test
    fun clockRunsOnlyWhenInputIsReady() {
        assertTrue(FingerMathText.inputReady(CameraState.Ready))
        assertTrue(FingerMathText.inputReady(CameraState.Unavailable), "touch-only play is still play")
        assertTrue(FingerMathText.inputReady(CameraState.PermissionDenied))
        assertFalse(FingerMathText.inputReady(CameraState.Off))
        assertFalse(FingerMathText.inputReady(CameraState.Requesting))
        assertFalse(FingerMathText.inputReady(CameraState.Starting))
    }

    @Test
    fun statusMessagesExplainWhatToDo() {
        val asking = FingerMathGame(Random(1))
        val ready = CameraState.Ready
        assertEquals("SHOW BOTH HANDS", FingerMathText.status(asking, reading(FingerInputState.NoHands, null), ready))
        assertEquals("ONE HAND SEEN - SHOW BOTH HANDS", FingerMathText.status(asking, reading(FingerInputState.OneHand, null), ready))
        val pts = SyntheticHands.points(SyntheticHands.showing(5), 300f, 400f)
        val single = ObservedHand(1, FingerClassifier.classify(pts), 0.9f, pts[0], pts[1], pts)
        val one = FingerCountReading(FingerInputState.OneHand, listOf(single), null, 0f, 0L, 0L, FingerRejection.OneHand, 1L)
        assertEquals("ONE HAND SEEN: 5 - SHOW BOTH HANDS", FingerMathText.status(asking, one, ready), "a single hand still reports its count")
        assertTrue(FingerMathText.status(asking, FingerCountReading.NONE, CameraState.Unavailable).startsWith("CAMERA UNAVAILABLE"))
        assertTrue(FingerMathText.status(asking, FingerCountReading.NONE, CameraState.PermissionDenied).contains("TAP AN ANSWER"))
        val dup = FingerCountReading(FingerInputState.Rejected, emptyList(), null, 0f, 0L, 0L, FingerRejection.Duplicate, 1L)
        assertEquals("KEEP YOUR HANDS APART", FingerMathText.status(asking, dup, ready))
        assertEquals("HOLD IT...", FingerMathText.status(asking, reading(FingerInputState.Unstable, 3), ready))
        assertEquals("STARTING CAMERA...", FingerMathText.status(asking, FingerCountReading.NONE, CameraState.Starting))
        asking.submitTouch(wrongFor(asking.question), 0L, FingerCountReading.NONE)
        assertEquals("NOT ${wrongFor(asking.question)} - TRY AGAIN", FingerMathText.status(asking, FingerCountReading.NONE, ready))
        asking.submitTouch(asking.question.answer, 0L, FingerCountReading.NONE)
        assertEquals("CORRECT!", FingerMathText.status(asking, FingerCountReading.NONE, ready))
    }

    @Test
    fun smallUnreadableHandsAskThePlayerToComeCloser() {
        val game = FingerMathGame(Random(3))
        val far = CandidateReport(0.6f, 0.02f, 0, 0, 30f, "?????", null, CandidateVerdict.LowPresence)
        val obs = FingerObservation(1L, 0L, 640, 480, emptyList(), FingerRejection.LowPresence, 1, 1, listOf(far))
        val rejected = FingerCountReading(FingerInputState.Rejected, emptyList(), null, 0f, 0L, 0L, FingerRejection.LowPresence, 1L, obs)
        assertEquals("BRING YOUR HANDS CLOSER TO THE CAMERA", FingerMathText.status(game, rejected, CameraState.Ready))
        val pts = SyntheticHands.points(SyntheticHands.showing(4), 300f, 400f)
        val near = ObservedHand(1, FingerClassifier.classify(pts), 0.95f, pts[0], pts[1], pts)
        val oneObs = FingerObservation(2L, 0L, 640, 480, listOf(near), FingerRejection.OneHand, 1, 2, listOf(far))
        val one = FingerCountReading(FingerInputState.OneHand, listOf(near), null, 0f, 0L, 0L, FingerRejection.OneHand, 2L, oneObs)
        assertEquals("ONE HAND SEEN: 4 - BRING THE OTHER HAND CLOSER", FingerMathText.status(game, one, CameraState.Ready))
    }

    @Test
    fun touchKeysMapToValuesZeroToTen() {
        assertEquals(0, FingerMathText.keyAt(5f, 105f, 0f, 100f, 40f, 50f, 10f))
        assertEquals(1, FingerMathText.keyAt(55f, 105f, 0f, 100f, 40f, 50f, 10f))
        assertEquals(-1, FingerMathText.keyAt(45f, 105f, 0f, 100f, 40f, 50f, 10f), "gap between keys")
        for (v in 0..10) assertEquals(v, FingerMathText.keyAt(v * 50f + 20f, 125f, 0f, 100f, 40f, 50f, 10f), "key $v")
        assertEquals(10, FingerMathText.keyAt(505f, 105f, 0f, 100f, 40f, 50f, 10f))
        assertEquals(-1, FingerMathText.keyAt(555f, 105f, 0f, 100f, 40f, 50f, 10f))
        assertEquals(-1, FingerMathText.keyAt(5f, 90f, 0f, 100f, 40f, 50f, 10f))
    }
}
