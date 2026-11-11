// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

internal enum class FingerState { Extended, Folded, Uncertain }

internal class HandClassification(
    val states: Array<FingerState>,
    val quality: Float,
    val palmSize: Float,
    val measures: FloatArray = FloatArray(0),
) {
    val count: Int?
        get() = if (states.any { it == FingerState.Uncertain }) null else states.count { it == FingerState.Extended }

    fun describe(): String {
        val sb = StringBuilder(5)
        for (s in states) sb.append(if (s == FingerState.Extended) 'E' else if (s == FingerState.Folded) 'f' else '?')
        return sb.toString()
    }
}

/**
 * Per-finger state from 21 image-space landmarks. Distances are normalized by the hand's own
 * size, so the result does not depend on distance to the camera, image mirroring, palm/back
 * orientation or which hand it is. The thumb is judged by its reach away from the palm.
 */
internal object FingerClassifier {
    const val THUMB: Int = 0
    private val MCP = intArrayOf(5, 9, 13, 17)
    private val PIP = intArrayOf(6, 10, 14, 18)
    private val TIP = intArrayOf(8, 12, 16, 20)
    const val EXTENDED_COS: Float = 0.75f
    const val EXTENDED_REACH: Float = 1.15f
    const val FOLDED_REACH: Float = 0.95f
    const val FOLDED_COS: Float = 0.0f
    const val FOLDED_COS_REACH: Float = 1.1f
    const val THUMB_EXTENDED_SPREAD: Float = 1.1f
    const val THUMB_EXTENDED_TIP: Float = 0.8f
    const val THUMB_EXTENDED_COS: Float = 0.6f
    const val THUMB_FOLDED_SPREAD: Float = 0.9f
    const val THUMB_FOLDED_TIP: Float = 0.5f
    const val MIN_PALM: Float = 1f

    fun classify(xy: FloatArray, offset: Int = 0): HandClassification {
        val palm = max(dist(xy, offset, 0, 9), 1e-3f)
        val states = Array(5) { FingerState.Uncertain }
        if (palm < MIN_PALM) return HandClassification(states, 0f, palm)
        val measures = FloatArray(11)
        val spread = dist(xy, offset, 4, 17) / max(dist(xy, offset, 2, 17), 1e-3f)
        val tip = dist(xy, offset, 4, 9) / palm
        val thumbCos = cos(xy, offset, 2, 3, 4)
        states[THUMB] = when {
            spread >= THUMB_EXTENDED_SPREAD && tip >= THUMB_EXTENDED_TIP && thumbCos >= THUMB_EXTENDED_COS -> FingerState.Extended
            spread <= THUMB_FOLDED_SPREAD || tip <= THUMB_FOLDED_TIP -> FingerState.Folded
            else -> FingerState.Uncertain
        }
        measures[0] = spread
        measures[1] = tip
        measures[2] = thumbCos
        var quality = margin(states[THUMB], spread, THUMB_FOLDED_SPREAD, THUMB_EXTENDED_SPREAD)
        for (f in 0 until 4) {
            val straight = cos(xy, offset, MCP[f], PIP[f], TIP[f])
            val reach = dist(xy, offset, 0, TIP[f]) / max(dist(xy, offset, 0, PIP[f]), 1e-3f)
            val state = when {
                straight >= EXTENDED_COS && reach >= EXTENDED_REACH -> FingerState.Extended
                reach <= FOLDED_REACH || (straight <= FOLDED_COS && reach <= FOLDED_COS_REACH) -> FingerState.Folded
                else -> FingerState.Uncertain
            }
            states[f + 1] = state
            measures[3 + f * 2] = straight
            measures[4 + f * 2] = reach
            quality = min(quality, margin(state, reach, FOLDED_REACH, EXTENDED_REACH))
        }
        return HandClassification(states, quality, palm, measures)
    }

    private fun dist(xy: FloatArray, o: Int, a: Int, b: Int): Float =
        hypot(xy[o + a * 2] - xy[o + b * 2], xy[o + a * 2 + 1] - xy[o + b * 2 + 1])

    private fun cos(xy: FloatArray, o: Int, a: Int, b: Int, c: Int): Float {
        val v1x = xy[o + b * 2] - xy[o + a * 2]
        val v1y = xy[o + b * 2 + 1] - xy[o + a * 2 + 1]
        val v2x = xy[o + c * 2] - xy[o + b * 2]
        val v2y = xy[o + c * 2 + 1] - xy[o + b * 2 + 1]
        val n = hypot(v1x, v1y) * hypot(v2x, v2y)
        return if (n <= 1e-6f) 0f else (v1x * v2x + v1y * v2y) / n
    }

    private fun margin(state: FingerState, value: Float, folded: Float, extended: Float): Float {
        val band = extended - folded
        return when (state) {
            FingerState.Extended -> (0.5f + (value - extended) / band).coerceIn(0f, 1f)
            FingerState.Folded -> (0.5f + (folded - value) / band).coerceIn(0f, 1f)
            FingerState.Uncertain -> 0f
        }
    }
}

internal enum class FingerRejection { NoHands, OneHand, Uncertain, LowPresence, TooSmall, Duplicate, Incomplete, BackendError }

internal class ObservedHand(
    val id: Int,
    val classification: HandClassification,
    val presence: Float,
    val wristX: Float,
    val wristY: Float,
    val landmarks: FloatArray,
) {
    val count: Int?
        get() = classification.count
}

/** One recognition update. [hands] is ordered left to right as the player sees the mirrored preview. */
internal enum class CandidateVerdict { Hand, LowPresence, Incomplete, TooSmall, SameHand, NotRun }

internal class CandidateReport(
    val palmScore: Float,
    val presence: Float,
    val outsideBase: Int,
    val outsideAny: Int,
    val palmPixels: Float,
    val states: String,
    val count: Int?,
    val verdict: CandidateVerdict,
    val fromRegion: Boolean = false,
    val roiCx: Float = Float.NaN,
    val roiCy: Float = Float.NaN,
    val roiSize: Float = Float.NaN,
) {
    val strictEdgeWouldReject: Boolean
        get() = outsideAny > 0
}

internal class FingerObservation(
    val sequence: Long,
    val timestampNanos: Long,
    val frameWidth: Int,
    val frameHeight: Int,
    val hands: List<ObservedHand>,
    val rejection: FingerRejection?,
    val rejectedCandidates: Int,
    val rawPalms: Int = 0,
    val candidates: List<CandidateReport> = emptyList(),
    val bestBelowThreshold: Float = Float.NaN,
) {
    val accepted: Boolean
        get() = rejection == null && hands.size == 2 && hands.all { it.count != null }

    val total: Int?
        get() = if (accepted) hands.sumOf { it.count ?: 0 } else null
}

internal data class FingerConfig(
    val minPalmScore: Float = 0.35f,
    val diagnosticPalmFloor: Float = 0.25f,
    val minPresence: Float = 0.5f,
    val minPalmPixels: Float = 16f,
    val maxCandidates: Int = 4,
    val duplicatePalmFraction: Float = 0.6f,
    val duplicateWristFraction: Float = 0.5f,
    val identityMatchFraction: Float = 0.25f,
    val maxLandmarkRuns: Int = 3,
    val baseMarginFraction: Float = 0.02f,
    val fingerMarginFraction: Float = 0.12f,
    val strictMarginFraction: Float = 0.01f,
    val diagnosticEveryIdleUpdates: Int = 20,
)

/**
 * Two-hand recognizer. Every update runs a fresh palm detection over the whole frame. A hand
 * accepted in the previous update keeps its landmark-derived region: when no fresh palm covers
 * it, the landmark model is run there instead, and the hand survives only if the model is again
 * confident. Landmark runs are sequential on one interpreter and bounded per update. Ambiguous,
 * overlapping, low-presence or partly out-of-frame hands are rejected rather than counted.
 * Results are published through [publish]; [process] never returns a control point.
 */
internal class FingerTracker(
    private val backend: HandModelBackend,
    private val publish: (FingerObservation) -> Unit,
    private val config: FingerConfig = FingerConfig(),
    private val events: ((String) -> Unit)? = null,
) : NativeFrameTracker {
    private val palms = FloatArray(HandModelLayout.PALM_STRIDE * config.maxCandidates)
    private val landmarks = FloatArray(HandModelLayout.LANDMARK_STRIDE)
    private val times = FloatArray(3)
    private val lossReasons = IntArray(LossReason.values().size)
    private val kept = IntArray(config.maxCandidates)
    private val baseLandmarks = intArrayOf(0, 1, 2, 5, 9, 13, 17)
    private var previous: List<ObservedHand> = emptyList()

    private class Probe(val roi: HandRoi, val palmScore: Float, val fromRegion: Boolean)

    private var nextId = 1
    private var sequence = 0L

    override var isTracking: Boolean = false
        private set
    override var lastInferenceMs: Float = 0f
        private set
    override val lastUpdateSearched: Boolean = true
    override var lossCount: Int = 0
        private set
    override var reacquisitions: Int = 0
        private set
    override var backendErrors: Int = 0
        private set
    override var consecutiveBackendErrors: Int = 0
        private set
    override var lastBackendStatus: Int = 0
        private set
    var lastPalmMs: Float = 0f
        private set
    var lastLandmarkMs: Float = 0f
        private set

    override fun losses(reason: LossReason): Int = lossReasons[reason.ordinal]

    override fun process(frame: ByteArray, width: Int, height: Int, nowNanos: Long): LandmarkPoint? {
        sequence += 1
        times.fill(0f)
        val detected = backend.detectPalms(frame, width, height, config.diagnosticPalmFloor, palms, config.maxCandidates, times)
        val count = keepConfidentPalms(detected)
        lastPalmMs = times[1]
        lastLandmarkMs = 0f
        lastInferenceMs = lastPalmMs
        if (!backendOk(count)) return emit(nowNanos, width, height, emptyList(), FingerRejection.BackendError, 0)
        val raw = count
        val probes = probes(distinctPalms(raw))
        val hands = ArrayList<ObservedHand>(2)
        val reports = ArrayList<CandidateReport>(probes.size)
        var rejected = 0
        var runs = 0
        var reason: FingerRejection? = null
        var sameHand = false
        for (probe in probes) {
            val palmScore = probe.palmScore
            if (hands.size == 2 || runs >= config.maxLandmarkRuns) {
                reports += CandidateReport(palmScore, Float.NaN, 0, 0, 0f, "", null, CandidateVerdict.NotRun, probe.fromRegion)
                continue
            }
            val roi = probe.roi
            times.fill(0f)
            val status = backend.landmarks(frame, width, height, roi, landmarks, times)
            runs += 1
            lastLandmarkMs += times[1]
            lastInferenceMs = lastPalmMs + lastLandmarkMs
            if (!backendOk(status)) return emit(nowNanos, width, height, emptyList(), FingerRejection.BackendError, rejected, raw, reports)
            val presence = landmarks[0]
            val outsideBase = outside(width, height, config.baseMarginFraction, true)
            val outsideFingers = outside(width, height, config.fingerMarginFraction, false)
            val outsideAny = outside(width, height, config.strictMarginFraction, false)
            val xy = landmarks.copyOfRange(2, 2 + HandModelLayout.LANDMARKS * 2)
            val classification = FingerClassifier.classify(xy)
            val verdict = when {
                presence < config.minPresence -> CandidateVerdict.LowPresence
                outsideBase > 0 || outsideFingers > 0 -> CandidateVerdict.Incomplete
                classification.palmSize < config.minPalmPixels -> CandidateVerdict.TooSmall
                else -> {
                    val candidate = ObservedHand(0, classification, presence, xy[0], xy[1], xy)
                    if (hands.any { overlapping(it, candidate) }) {
                        CandidateVerdict.SameHand
                    } else {
                        hands += candidate
                        CandidateVerdict.Hand
                    }
                }
            }
            reports += CandidateReport(presence = presence, palmScore = palmScore, outsideBase = outsideBase, outsideAny = outsideAny,
                palmPixels = classification.palmSize, states = classification.describe(), count = classification.count, verdict = verdict,
                fromRegion = probe.fromRegion, roiCx = roi.cx, roiCy = roi.cy, roiSize = roi.size)
            if (probe.fromRegion && verdict != CandidateVerdict.Hand) continue
            when (verdict) {
                CandidateVerdict.Hand, CandidateVerdict.NotRun -> Unit
                CandidateVerdict.SameHand -> sameHand = true
                CandidateVerdict.LowPresence -> {
                    rejected += 1
                    if (reason == null) reason = FingerRejection.LowPresence
                }
                CandidateVerdict.TooSmall -> {
                    rejected += 1
                    reason = FingerRejection.TooSmall
                }
                CandidateVerdict.Incomplete -> {
                    rejected += 1
                    reason = FingerRejection.Incomplete
                }
            }
        }
        val identified = assignIdentities(hands, width)
        val rejection = when {
            identified.isEmpty() -> reason ?: FingerRejection.NoHands
            identified.size == 1 -> when {
                sameHand -> FingerRejection.Duplicate
                reason == FingerRejection.Incomplete || reason == FingerRejection.TooSmall -> reason
                else -> FingerRejection.OneHand
            }
            identified.any { it.count == null } -> FingerRejection.Uncertain
            else -> null
        }
        return emit(nowNanos, width, height, identified, rejection, rejected, raw, reports)
    }

    private fun probes(distinct: Int): List<Probe> {
        val covered = BooleanArray(previous.size)
        val covering = ArrayList<Probe>(distinct)
        val others = ArrayList<Probe>(distinct)
        for (k in 0 until distinct) {
            val base = kept[k] * HandModelLayout.PALM_STRIDE
            val probe = Probe(RoiMath.fromPalm(palms, base), palms[base], false)
            var hit = -1
            for ((i, old) in previous.withIndex()) {
                val cx = (old.landmarks[0] + old.landmarks[HandModelLayout.MIDDLE_MCP * 2]) / 2f
                val cy = (old.landmarks[1] + old.landmarks[HandModelLayout.MIDDLE_MCP * 2 + 1]) / 2f
                if (hypot(palms[base + 1] - cx, palms[base + 2] - cy) < old.classification.palmSize) hit = i
            }
            if (hit >= 0) {
                covered[hit] = true
                covering += probe
            } else {
                others += probe
            }
        }
        val out = ArrayList<Probe>(distinct + previous.size)
        out += covering
        for ((i, old) in previous.withIndex()) {
            if (!covered[i]) out += Probe(RoiMath.fromLandmarks(old.landmarks, 0), Float.NaN, true)
        }
        out += others
        return out
    }

    private fun emit(
        now: Long,
        width: Int,
        height: Int,
        hands: List<ObservedHand>,
        rejection: FingerRejection?,
        rejected: Int,
        raw: Int = 0,
        reports: List<CandidateReport> = emptyList(),
    ): LandmarkPoint? {
        val lost = previous.count { old -> hands.none { it.id == old.id } }
        if (lost > 0) {
            lossCount += lost
            val reason = if (rejection == FingerRejection.BackendError) LossReason.BackendError else LossReason.Presence
            lossReasons[reason.ordinal] += lost
            events?.invoke("finger: lost $lost of ${previous.size} hand(s) (${rejection ?: "replaced"})")
        }
        if (rejection != FingerRejection.BackendError) consecutiveBackendErrors = 0
        if (previous.isEmpty() && hands.isNotEmpty() && lossCount > 0) reacquisitions += 1
        previous = hands
        isTracking = hands.isNotEmpty()
        val observation = FingerObservation(sequence, now, width, height, hands, rejection, rejected, raw, reports, bestBelow)
        if (raw > 0 || !bestBelow.isNaN() || sequence % config.diagnosticEveryIdleUpdates == 1L) {
            events?.invoke(FingerDiagnostics.line(observation, lastPalmMs, lastLandmarkMs))
        }
        publish(observation)
        return null
    }

    private fun backendOk(status: Int): Boolean {
        lastBackendStatus = status
        if (status < 0) {
            backendErrors += 1
            consecutiveBackendErrors += 1
            events?.invoke("finger inference failed (status $status)")
            return false
        }
        return true
    }

    private var bestBelow = Float.NaN

    private fun keepConfidentPalms(detected: Int): Int {
        bestBelow = Float.NaN
        if (detected <= 0) return detected
        var n = 0
        for (i in 0 until detected.coerceAtMost(config.maxCandidates)) {
            val base = i * HandModelLayout.PALM_STRIDE
            val score = palms[base]
            if (score >= config.minPalmScore) {
                if (n != i) System.arraycopy(palms, base, palms, n * HandModelLayout.PALM_STRIDE, HandModelLayout.PALM_STRIDE)
                n += 1
            } else if (bestBelow.isNaN() || score > bestBelow) {
                bestBelow = score
            }
        }
        return n
    }

    private fun distinctPalms(count: Int): Int {
        var n = 0
        for (i in 0 until count) {
            val base = i * HandModelLayout.PALM_STRIDE
            var duplicate = false
            for (k in 0 until n) {
                val kb = kept[k] * HandModelLayout.PALM_STRIDE
                val size = max(max(palms[base + 3], palms[base + 4]), max(palms[kb + 3], palms[kb + 4]))
                if (hypot(palms[base + 1] - palms[kb + 1], palms[base + 2] - palms[kb + 2]) < config.duplicatePalmFraction * size) duplicate = true
            }
            if (!duplicate) kept[n++] = i
        }
        return n
    }

    private fun outside(width: Int, height: Int, margin: Float, baseOnly: Boolean): Int {
        val mx = width * margin
        val my = height * margin
        var n = 0
        for (i in 0 until HandModelLayout.LANDMARKS) {
            if (baseOnly && i !in baseLandmarks) continue
            val x = landmarks[2 + i * 2]
            val y = landmarks[3 + i * 2]
            if (x < -mx || y < -my || x > width + mx || y > height + my) n += 1
        }
        return n
    }

    private fun overlapping(a: ObservedHand, b: ObservedHand): Boolean {
        val limit = config.duplicateWristFraction * max(a.classification.palmSize, b.classification.palmSize)
        if (hypot(a.wristX - b.wristX, a.wristY - b.wristY) < limit) return true
        return hypot(centroid(a, 0) - centroid(b, 0), centroid(a, 1) - centroid(b, 1)) < limit
    }

    private fun centroid(h: ObservedHand, axis: Int): Float {
        var s = 0f
        for (i in 0 until HandModelLayout.LANDMARKS) s += h.landmarks[i * 2 + axis]
        return s / HandModelLayout.LANDMARKS
    }

    private fun assignIdentities(hands: List<ObservedHand>, width: Int): List<ObservedHand> {
        if (hands.isEmpty()) return hands
        val limit = config.identityMatchFraction * width
        val used = HashSet<Int>()
        val out = ArrayList<ObservedHand>(hands.size)
        for (hand in hands.sortedByDescending { it.presence }) {
            var best: ObservedHand? = null
            var bestDistance = Float.MAX_VALUE
            for (old in previous) {
                if (old.id in used) continue
                val d = hypot(old.wristX - hand.wristX, old.wristY - hand.wristY)
                if (d < bestDistance) {
                    bestDistance = d
                    best = old
                }
            }
            val id = if (best != null && bestDistance <= limit) best.id else nextId++
            used += id
            out += ObservedHand(id, hand.classification, hand.presence, hand.wristX, hand.wristY, hand.landmarks)
        }
        out.sortByDescending { it.wristX }
        return out
    }
}

internal enum class FingerInputState { NoSignal, NoHands, OneHand, Uncertain, Rejected, Stale, Unstable, Stable }

internal class FingerCountReading(
    val state: FingerInputState,
    val hands: List<ObservedHand>,
    val total: Int?,
    val progress: Float,
    val heldMs: Long,
    val ageMs: Long,
    val rejection: FingerRejection?,
    val sequence: Long,
    val observation: FingerObservation? = null,
) {
    val stableTotal: Int?
        get() = if (state == FingerInputState.Stable) total else null

    val released: Boolean
        get() = when (state) {
            FingerInputState.NoSignal, FingerInputState.NoHands, FingerInputState.OneHand, FingerInputState.Stale -> true
            else -> false
        }

    companion object {
        val NONE: FingerCountReading = FingerCountReading(FingerInputState.NoSignal, emptyList(), null, 0f, 0L, 0L, null, -1L)
    }
}

internal class FingerInputStats(
    val observations: Long,
    val accepted: Long,
    val stableRuns: Long,
    val rejections: IntArray,
    val palmUpdates: Long = 0L,
    val verdicts: IntArray = IntArray(CandidateVerdict.values().size),
    val regionHands: Long = 0L,
) {
    val recognitionRate: Float
        get() = if (observations == 0L) Float.NaN else accepted.toFloat() / observations
}

/**
 * Typed two-hand counting input. The recognizer publishes from its worker thread; the game
 * reads on the UI thread. A total becomes [FingerInputState.Stable] only after
 * [requiredObservations] consecutive accepted observations with the same per-hand counts
 * spanning at least [minHoldNanos]. Any rejected, uncertain, identity-changed or late
 * observation restarts confirmation, and a reading older than the stale limit never confirms.
 */
public class FingerCountInput internal constructor(
    private val requiredObservations: Int,
    private val minHoldNanos: Long,
) {
    private val lock = Any()
    private var generation = 0
    private var latest: FingerObservation? = null
    private var maxGapNanos = 1_250_000_000L
    private var staleNanos = 1_500_000_000L
    private val runKey = IntArray(4)
    private var runCount = 0
    private var runStart = 0L
    private var lastAt = Long.MIN_VALUE
    private var observations = 0L
    private var accepted = 0L
    private var stableRuns = 0L
    private val rejections = IntArray(FingerRejection.values().size)
    private val verdicts = IntArray(CandidateVerdict.values().size)
    private var palmUpdates = 0L
    private var regionHands = 0L

    public constructor() : this(DEFAULT_REQUIRED_OBSERVATIONS, DEFAULT_MIN_HOLD_NANOS)

    internal fun configure(periodNanos: Long) {
        synchronized(lock) {
            maxGapNanos = periodNanos * 5 / 2
            staleNanos = max(periodNanos * 3, 1_200_000_000L)
        }
    }

    internal fun generation(): Int = synchronized(lock) { generation }

    internal fun clear() {
        synchronized(lock) {
            generation += 1
            latest = null
            resetRun()
            lastAt = Long.MIN_VALUE
        }
    }

    internal fun publish(observation: FingerObservation, generation: Int) {
        synchronized(lock) {
            if (generation != this.generation) return
            latest = observation
            observations += 1
            observation.rejection?.let { rejections[it.ordinal] += 1 }
            if (observation.rawPalms > 0) palmUpdates += 1
            for (c in observation.candidates) {
                verdicts[c.verdict.ordinal] += 1
                if (c.fromRegion && c.verdict == CandidateVerdict.Hand) regionHands += 1
            }
            val gap = observation.timestampNanos - lastAt
            val gapOk = lastAt != Long.MIN_VALUE && gap >= 0L && gap <= maxGapNanos
            lastAt = observation.timestampNanos
            if (!observation.accepted) {
                resetRun()
                return
            }
            accepted += 1
            val a = observation.hands[0]
            val b = observation.hands[1]
            val same = gapOk && runCount > 0 &&
                runKey[0] == a.id && runKey[1] == a.count && runKey[2] == b.id && runKey[3] == b.count
            if (same) {
                runCount += 1
                if (runCount == requiredObservations && observation.timestampNanos - runStart >= minHoldNanos) stableRuns += 1
            } else {
                runKey[0] = a.id
                runKey[1] = a.count ?: -1
                runKey[2] = b.id
                runKey[3] = b.count ?: -1
                runCount = 1
                runStart = observation.timestampNanos
            }
        }
    }

    internal fun read(nowNanos: Long): FingerCountReading = synchronized(lock) {
        val obs = latest ?: return FingerCountReading.NONE
        val age = (nowNanos - obs.timestampNanos).coerceAtLeast(0L)
        val ageMs = age / 1_000_000L
        if (age > staleNanos) {
            return FingerCountReading(FingerInputState.Stale, obs.hands, null, 0f, 0L, ageMs, obs.rejection, obs.sequence, obs)
        }
        if (!obs.accepted) {
            val state = when (obs.rejection) {
                FingerRejection.NoHands -> FingerInputState.NoHands
                FingerRejection.OneHand -> FingerInputState.OneHand
                FingerRejection.Uncertain -> FingerInputState.Uncertain
                else -> FingerInputState.Rejected
            }
            return FingerCountReading(state, obs.hands, null, 0f, 0L, ageMs, obs.rejection, obs.sequence, obs)
        }
        val held = obs.timestampNanos - runStart
        val stable = runCount >= requiredObservations && held >= minHoldNanos
        val progress = if (stable) 1f else min(runCount.toFloat() / requiredObservations, held.toFloat() / minHoldNanos).coerceIn(0f, 0.99f)
        FingerCountReading(
            if (stable) FingerInputState.Stable else FingerInputState.Unstable,
            obs.hands,
            obs.total,
            progress,
            held / 1_000_000L,
            ageMs,
            null,
            obs.sequence,
            obs,
        )
    }

    internal fun stats(): FingerInputStats = synchronized(lock) { FingerInputStats(observations, accepted, stableRuns, rejections.copyOf(), palmUpdates, verdicts.copyOf(), regionHands) }

    private fun resetRun() {
        runCount = 0
        runKey.fill(-1)
    }

    internal companion object {
        const val DEFAULT_REQUIRED_OBSERVATIONS: Int = 3
        const val DEFAULT_MIN_HOLD_NANOS: Long = 750_000_000L
    }
}

internal object FingerDiagnostics {
    fun line(o: FingerObservation, palmMs: Float, landmarkMs: Float): String {
        val sb = StringBuilder(160)
        sb.append("finger #").append(o.sequence).append(" palms ").append(o.rawPalms)
        if (!o.bestBelowThreshold.isNaN()) sb.append(" (best below cutoff ").append(two(o.bestBelowThreshold)).append(')')
        sb.append(" result ").append(o.rejection?.name ?: "Accepted")
        o.total?.let { sb.append(" total ").append(it) }
        sb.append(" ms ").append(palmMs.toInt()).append('+').append(landmarkMs.toInt())
        for ((i, c) in o.candidates.withIndex()) {
            sb.append(" | c").append(i + 1).append(' ').append(candidate(c))
        }
        return sb.toString()
    }

    fun candidate(c: CandidateReport): String {
        val source = if (c.fromRegion) "region" else "palm ${two(c.palmScore)}"
        if (c.verdict == CandidateVerdict.NotRun) return "$source not run"
        return "$source pres ${two(c.presence)} size ${c.palmPixels.toInt()}px edge ${c.outsideBase}/${c.outsideAny} " +
            "${c.states}=${c.count ?: "?"} ${c.verdict}${if (c.strictEdgeWouldReject && c.verdict == CandidateVerdict.Hand) " (old edge rule: reject)" else ""}"
    }

    fun measures(h: HandClassification): String {
        val m = h.measures
        if (m.size < 11) return "-"
        val sb = StringBuilder("T ${two(m[0])}/${two(m[1])}/${two(m[2])}")
        for (f in 0 until 4) sb.append(" ").append("IMRP"[f]).append(' ').append(two(m[3 + f * 2])).append('/').append(two(m[4 + f * 2]))
        return sb.toString()
    }

    private fun two(v: Float): String = if (v.isNaN()) "-" else ((v * 100f).toInt() / 100f).toString()
}
