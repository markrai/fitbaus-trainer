// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock
import kotlin.math.abs

internal data class WaveConfig(
    val gridCols: Int = 64,
    val gridRows: Int = 48,
    val minIntervalNanos: Long = 40_000_000L,
    val maxFrameGapNanos: Long = 250_000_000L,
    val cellThreshold: Int = 20,
    val linkRadius: Int = 2,
    val minRegionCells: Int = 12,
    val matchCellCap: Int = 160,
    val blockCells: Int = 8,
    val wholeRegionCells: Int = 64,
    val minBlockCells: Int = 10,
    val maxShiftX: Int = 10,
    val maxShiftY: Int = 8,
    val matchGain: Float = 0.7f,
    val rivalRatio: Float = 1.1f,
    val shiftPenalty: Int = 224,
    val globalFraction: Float = 0.45f,
    val maxGainChange: Float = 0.25f,
    val maxRegionWidth: Float = 0.6f,
    val onsetSpeed: Float = 1.5f,
    val continueSpeed: Float = 1.2f,
    val releaseSpeed: Float = 1f,
    val baselineFactor: Float = 2f,
    val baselineCap: Float = 2.5f,
    val baselineTauNanos: Long = 1_500_000_000L,
    val minDisplacement: Float = 0.14f,
    val horizontalRatio: Float = 1.3f,
    val minObservations: Int = 2,
    val maxDurationNanos: Long = 650_000_000L,
    val maxGapNanos: Long = 220_000_000L,
    val maxJump: Float = 0.3f,
    val cooldownNanos: Long = 650_000_000L,
    val releaseNanos: Long = 180_000_000L,
    val faceMinExtent: Float = 0.12f,
    val faceHalfWidth: Float = 0.85f,
    val faceAbove: Float = 1.0f,
    val faceBelow: Float = 0.9f,
    val faceHoldNanos: Long = 600_000_000L,
    val defaultFaceX: Float = 0.5f,
    val defaultFaceY: Float = 0.35f,
    val defaultFaceExtent: Float = 0.2f,
    val headCompensation: Float = 0.95f,
    val headSampleWindowNanos: Long = 400_000_000L,
) {
    init {
        require(gridCols in 16..160 && gridRows in 12..120) { "invalid motion grid" }
        require(linkRadius in 1..3 && minRegionCells >= 2 && matchCellCap >= 16) { "invalid region settings" }
        require(blockCells >= 4 && gridCols % blockCells == 0 && gridRows % blockCells == 0 && minBlockCells >= 4) { "blocks must divide the grid" }
        require(minObservations >= 2 && maxDurationNanos > minIntervalNanos) { "invalid gesture window" }
        require(cellThreshold in 1..255 && minDisplacement > 0f && minDisplacement < 1f) { "invalid motion thresholds" }
        require(onsetSpeed >= continueSpeed && releaseSpeed > 0f && maxShiftX >= 2 && maxShiftY >= 2) { "invalid speed thresholds" }
    }

    companion object {
        val SENSITIVITY_LABELS: Array<String> = arrayOf("Low", "Medium", "High")
        const val DEFAULT_SENSITIVITY: Int = 1

        fun forSensitivity(index: Int, cooldownNanos: Long): WaveConfig = when (index.coerceIn(0, 2)) {
            0 -> WaveConfig(cellThreshold = 26, minDisplacement = 0.16f, onsetSpeed = 2f, cooldownNanos = cooldownNanos)
            2 -> WaveConfig(minDisplacement = 0.11f, onsetSpeed = 1.2f, cooldownNanos = cooldownNanos)
            else -> WaveConfig(cooldownNanos = cooldownNanos)
        }
    }
}

internal enum class WaveState { Disabled, Idle, Candidate, Confirmed, Cooldown, Unsettled }

internal enum class WaveReject { None, Weak, Slow, Vertical, Reversal, Broad, Global, Stale }

internal enum class WaveSignal { None, Unexplained, Lateral, WithHead, Vertical, Broad, Global, Stale }

internal class WaveEvent(val sequence: Long, val atNanos: Long, val simulated: Boolean)

internal class FaceSample(val x: Float, val y: Float, val extent: Float, val atNanos: Long)

/**
 * Detects one deliberate sideways wave from luminance motion. It never decides that a hand is
 * present; it recognises a coherent moving region whose content shifts sideways, relative to the
 * head, far enough and fast enough within a short window.
 *
 * Each observation samples the Y plane into a [WaveConfig.gridCols]x[WaveConfig.gridRows] grid in
 * player space (mirrored like the face position) and normalises the previous grid for a global
 * gain change. Cells inside a compact box around the tracked head (face box plus margins, widened
 * by the head's recent sideways travel) are ignored; everything beside and below the head counts.
 * Changed cells are joined into regions (cells within [WaveConfig.linkRadius] of each other), and
 * each region is block-matched against the previous grid over its changed cells only. A cell
 * counts as explained by a shift if either the current cell matches the previous grid moved by
 * that shift (where the object arrived) or the previous cell matches the current grid moved the
 * other way (where it left), so static background never votes. A small cost per cell of shift
 * resolves the ambiguity of plain surfaces toward the smallest consistent motion, and matching a
 * cell against unchanged background costs extra, so repeating backgrounds cannot fake a shift.
 * Large regions are matched in [WaveConfig.blockCells]-cell blocks and regrouped by adjacent blocks
 * with similar shifts, so a hand crossing a torso that moves with the head, or the tip of a
 * forearm rotating about the elbow, forms its own moving group. Each region's
 * sideways shift is then taken relative to the head: motion that goes along with the head is
 * discounted, motion against it is not.
 *
 * A wave is a region that keeps moving one way, mostly sideways, until its accumulated travel
 * reaches [WaveConfig.minDisplacement] of the frame width within [WaveConfig.maxDurationNanos].
 * Arming uses onset / release hysteresis on the strongest sideways motion, measured against a slow
 * baseline of background sideways motion: a candidate starts above the onset level, and after an
 * event (or a whole-frame change) the detector rearms only once sideways motion has stayed below
 * the release level for [WaveConfig.releaseNanos] and the cooldown has passed. Pedaling, clothing
 * and lighting flicker barely move content sideways, so they do not keep the detector unarmed;
 * one continuously waving arm does.
 *
 * Not thread-safe: one camera thread calls [observe]. Buffers are allocated once per frame size.
 */
internal class WaveSwipeDetector(config: WaveConfig = WaveConfig()) {
    var config: WaveConfig = config
    var wantGrid: Boolean = false
    val cols: Int = config.gridCols
    val rows: Int = config.gridRows
    private val cellCount = cols * rows
    private var current = IntArray(cellCount)
    private var previous = IntArray(cellCount)
    private val predicted = IntArray(cellCount)
    private val cellState = ByteArray(cellCount)
    private val label = IntArray(cellCount)
    private val queue = IntArray(cellCount)
    private val members = IntArray(cellCount)
    private val blockMembers = IntArray(cellCount)
    private val blocksX = cols / config.blockCells
    private val blocksY = rows / config.blockCells
    private val blockStart = IntArray(blocksX * blocksY + 1)
    private val blockFill = IntArray(blocksX * blocksY)
    private val blockShiftX = IntArray(blocksX * blocksY)
    private val blockShiftY = IntArray(blocksX * blocksY)
    private val blockMoving = BooleanArray(blocksX * blocksY)
    private val blockSeen = BooleanArray(blocksX * blocksY)
    private val blockGroup = IntArray(blocksX * blocksY)
    private val blockStack = IntArray(blocksX * blocksY * 2)
    private val blockSumC = IntArray(blocksX * blocksY)
    private val blockSumR = IntArray(blocksX * blocksY)
    private val blockMinC = IntArray(blocksX * blocksY)
    private val blockMaxC = IntArray(blocksX * blocksY)
    private val blockMinR = IntArray(blocksX * blocksY)
    private val blockMaxR = IntArray(blocksX * blocksY)
    private val rgSplit = BooleanArray(MAX_REGIONS)
    val grid: ByteArray = ByteArray(cellCount)
    private val rgStart = IntArray(MAX_REGIONS)
    private val rgCount = IntArray(MAX_REGIONS)
    private val rgShiftX = FloatArray(MAX_REGIONS)
    private val rgShiftY = FloatArray(MAX_REGIONS)
    private val rgX = FloatArray(MAX_REGIONS)
    private val rgY = FloatArray(MAX_REGIONS)
    private val rgMinC = IntArray(MAX_REGIONS)
    private val rgMaxC = IntArray(MAX_REGIONS)
    private val rgMinR = IntArray(MAX_REGIONS)
    private val rgMaxR = IntArray(MAX_REGIONS)
    private val rgMoving = BooleanArray(MAX_REGIONS)
    private val rgRel = FloatArray(MAX_REGIONS)
    private var regionCount = 0
    private val coarseX = coarse(config.maxShiftX)
    private val coarseY = coarse(config.maxShiftY)
    private val coarseCost = LongArray(coarseX.size * coarseY.size)
    private var sampleX = IntArray(0)
    private var sampleY = IntArray(0)
    private var sampledWidth = 0
    private var sampledHeight = 0
    private var sampledMirror = false
    private var hasPrevious = false
    private var lastObservation = Long.MIN_VALUE
    private var cooldownUntil = Long.MIN_VALUE
    private var releasedSince = Long.MIN_VALUE
    private var prevFaceX = Float.NaN
    private var prevFaceAt = Long.MIN_VALUE
    private var lastFaceX = Float.NaN
    private var lastFaceY = Float.NaN
    private var lastFaceExtent = Float.NaN
    private var lastFaceAt = Long.MIN_VALUE
    private var maskC0 = 0
    private var maskC1 = -1
    private var maskR0 = 0
    private var maskR1 = -1
    private val pointDx = FloatArray(MAX_POINTS)
    private val pointDy = FloatArray(MAX_POINTS)
    private val pointX = FloatArray(MAX_POINTS)
    private val pointT = LongArray(MAX_POINTS)
    private var points = 0
    private var path = 0f
    private var pathStart = 0L
    private var lastMassAt = Long.MIN_VALUE
    private var contrary = 0

    var state: WaveState = WaveState.Idle
        private set
    var signal: WaveSignal = WaveSignal.None
        private set
    var observations: Long = 0L
        private set
    var accepted: Int = 0
        private set
    var rejected: Int = 0
        private set
    var suppressed: Int = 0
        private set
    var lastReject: WaveReject = WaveReject.None
        private set
    var lastEventNanos: Long = Long.MIN_VALUE
        private set
    var mass: Float = 0f
        private set
    var globalMass: Float = 0f
        private set
    var evidence: Float = 0f
        private set
    var baseline: Float = 0f
        private set
    var releaseLevel: Float = 0f
        private set
    var onsetLevel: Float = 0f
        private set
    var direction: Int = 0
        private set
    var travel: Float = 0f
        private set
    var headVelocity: Float = 0f
        private set
    var regionX: Float = Float.NaN
        private set
    var regionY: Float = Float.NaN
        private set
    var regionShiftX: Float = 0f
        private set
    var regionShiftY: Float = 0f
        private set
    var regionLeft: Float = Float.NaN
        private set
    var regionTop: Float = Float.NaN
        private set
    var regionRight: Float = Float.NaN
        private set
    var regionBottom: Float = Float.NaN
        private set
    var maskLeft: Float = 0f
        private set
    var maskTop: Float = 0f
        private set
    var maskRight: Float = 0f
        private set
    var maskBottom: Float = 0f
        private set

    fun reset() {
        hasPrevious = false
        lastObservation = Long.MIN_VALUE
        cooldownUntil = Long.MIN_VALUE
        releasedSince = Long.MIN_VALUE
        prevFaceX = Float.NaN
        prevFaceAt = Long.MIN_VALUE
        lastFaceX = Float.NaN
        lastFaceY = Float.NaN
        lastFaceExtent = Float.NaN
        lastFaceAt = Long.MIN_VALUE
        clearCandidate()
        state = WaveState.Idle
        signal = WaveSignal.None
        mass = 0f
        globalMass = 0f
        evidence = 0f
        baseline = 0f
        headVelocity = 0f
        clearRegion()
    }

    fun due(nowNanos: Long): Boolean = lastObservation == Long.MIN_VALUE || nowNanos - lastObservation >= config.minIntervalNanos

    /** Returns true exactly once per accepted wave. [face] is camera-space (unmirrored), may be null. */
    fun observe(nv21: ByteArray, width: Int, height: Int, mirror: Boolean, nowNanos: Long, face: FaceSample?): Boolean {
        if (width < cols || height < rows || nv21.size < width * height) return false
        if (!due(nowNanos)) return false
        val gap = if (lastObservation == Long.MIN_VALUE) Long.MAX_VALUE else nowNanos - lastObservation
        lastObservation = nowNanos
        observations += 1
        sample(nv21, width, height, mirror)
        trackFace(face, mirror, nowNanos)
        if (!hasPrevious || gap > config.maxFrameGapNanos) {
            swap()
            hasPrevious = true
            if (points >= 2) reject(WaveReject.Stale)
            clearCandidate()
            clearRegion()
            signal = WaveSignal.Stale
            evidence = 0f
            settle()
            if (wantGrid) grid.fill(0)
            return false
        }
        val event = analyse(nowNanos, gap)
        swap()
        return event
    }

    private fun analyse(now: Long, gap: Long): Boolean {
        val cfg = config
        var sumCur = 0L
        var sumPrev = 0L
        for (i in 0 until cellCount) {
            sumCur += current[i]
            sumPrev += previous[i]
        }
        val gainQ = if (sumPrev < cellCount * 4L) 256L else (sumCur * 256L / sumPrev).coerceIn(64L, 1024L)
        if (abs(gainQ - 256L) > (cfg.maxGainChange * 256f).toLong()) {
            mass = 0f
            globalMass = 1f
            return wholeFrame(now)
        }
        for (i in 0 until cellCount) predicted[i] = ((previous[i] * gainQ) shr 8).toInt()
        maskFor(now)
        val threshold = cfg.cellThreshold
        var moving = 0
        var open = 0
        var changedOpen = 0
        for (r in 0 until rows) {
            val base = r * cols
            val inMaskRows = r in maskR0..maskR1
            for (c in 0 until cols) {
                val i = base + c
                val hit = abs(current[i] - predicted[i]) > threshold
                if (hit) moving += 1
                if (inMaskRows && c in maskC0..maskC1) {
                    cellState[i] = CELL_MASKED
                    continue
                }
                open += 1
                if (hit) {
                    cellState[i] = CELL_CHANGED
                    changedOpen += 1
                } else {
                    cellState[i] = CELL_STATIC
                }
            }
        }
        globalMass = moving.toFloat() / cellCount
        mass = if (open == 0) 0f else changedOpen.toFloat() / open
        if (globalMass > cfg.globalFraction) return wholeFrame(now)
        findRegions()
        var anyUnexplained = false
        blockGroup.fill(-1)
        val found = regionCount
        for (k in 0 until found) {
            match(k)
            if (!rgMoving[k] && !rgSplit[k]) anyUnexplained = true
        }
        val headCells = headVelocity * (gap / 1e9f) * cols * cfg.headCompensation
        var best = -1
        var bestAbs = 0f
        var broad = false
        var withHead = false
        var vertical = false
        for (k in 0 until regionCount) {
            if (!rgMoving[k]) continue
            rgRel[k] = relative(rgShiftX[k], headCells)
            if (wide(k)) {
                broad = true
                continue
            }
            val rel = abs(rgRel[k])
            if (abs(rgShiftX[k]) >= cfg.continueSpeed && rel < cfg.continueSpeed) withHead = true
            if (!sideways(k)) {
                vertical = true
                continue
            }
            if (rel > bestAbs) {
                bestAbs = rel
                best = k
            }
        }
        evidence = bestAbs
        signal = when {
            regionCount == 0 -> WaveSignal.None
            best >= 0 && bestAbs >= cfg.continueSpeed -> WaveSignal.Lateral
            broad -> WaveSignal.Broad
            withHead -> WaveSignal.WithHead
            vertical || best >= 0 -> WaveSignal.Vertical
            anyUnexplained -> WaveSignal.Unexplained
            else -> WaveSignal.None
        }
        showRegion(best)
        val event = step(now, best, gap)
        if (wantGrid) fillGrid(best)
        return event
    }

    private fun relative(shift: Float, head: Float): Float {
        if (shift * head <= 0f) return shift
        val rest = abs(shift) - abs(head)
        return if (rest <= 0f) 0f else rest * (if (shift > 0f) 1f else -1f)
    }

    private fun wide(k: Int): Boolean = (rgMaxC[k] - rgMinC[k] + 1).toFloat() / cols > config.maxRegionWidth

    private fun sideways(k: Int): Boolean = abs(rgRel[k]) >= config.horizontalRatio * abs(rgShiftY[k])

    private fun step(now: Long, best: Int, gap: Long): Boolean {
        val cfg = config
        updateBaseline(gap)
        onsetLevel = maxOf(cfg.onsetSpeed, baseline * cfg.baselineFactor)
        releaseLevel = maxOf(cfg.releaseSpeed, baseline * 1.5f)
        releasedSince = if (evidence < releaseLevel) (if (releasedSince == Long.MIN_VALUE) now else releasedSince) else Long.MIN_VALUE
        if (state == WaveState.Confirmed) state = WaveState.Cooldown
        if (state == WaveState.Cooldown || state == WaveState.Unsettled || state == WaveState.Disabled) {
            val released = releasedSince != Long.MIN_VALUE && now - releasedSince >= cfg.releaseNanos
            if (now >= cooldownUntil && released) {
                state = WaveState.Idle
            } else {
                if (evidence >= onsetLevel) suppressed += 1
                return false
            }
        }
        if (state == WaveState.Idle) {
            if (best >= 0 && evidence >= onsetLevel) begin(best, now)
            return false
        }
        val match = follow(now)
        if (match >= 0) {
            contrary = 0
            append(match, now)
        } else if (best >= 0 && evidence >= onsetLevel && sign(rgRel[best]) != direction && !tolerate(evidence)) {
            if (points >= 2) reject(WaveReject.Reversal)
            begin(best, now)
            return false
        } else {
            if (now - lastMassAt > cfg.maxGapNanos) endCandidate()
            return false
        }
        while (points > 1 && pointT[points - 1] - pointT[0] > cfg.maxDurationNanos) dropFirst()
        var dx = 0f
        var dy = 0f
        for (i in 0 until points) {
            dx += pointDx[i]
            dy += abs(pointDy[i])
        }
        travel = abs(dx) / cols
        if (points >= cfg.minObservations && travel >= cfg.minDisplacement && abs(dx) >= cfg.horizontalRatio * dy) {
            accepted += 1
            lastEventNanos = now
            lastReject = WaveReject.None
            clearCandidate()
            state = WaveState.Confirmed
            cooldownUntil = now + cfg.cooldownNanos
            releasedSince = Long.MIN_VALUE
            return true
        }
        return false
    }

    private fun follow(now: Long): Int {
        val cfg = config
        val expected = pointX[points - 1] + pointDx[points - 1] / cols
        var match = -1
        var strength = 0f
        for (k in 0 until regionCount) {
            if (!rgMoving[k] || wide(k)) continue
            val rel = rgRel[k]
            if (sign(rel) != direction || abs(rel) < cfg.continueSpeed || !sideways(k)) continue
            if (abs(rgX[k] - expected) > cfg.maxJump + (now - lastMassAt) / 1e9f * 1.5f) continue
            if (abs(rel) > strength) {
                strength = abs(rel)
                match = k
            }
        }
        return match
    }

    private fun tolerate(opposite: Float): Boolean {
        if (points < 2 || contrary >= 1) return false
        var sum = 0f
        for (i in 0 until points) sum += abs(pointDx[i])
        if (opposite >= 1.5f * sum / points) return false
        contrary += 1
        return true
    }

    private fun updateBaseline(gap: Long) {
        val cfg = config
        if (state != WaveState.Idle && state != WaveState.Unsettled) return
        if (evidence >= maxOf(cfg.onsetSpeed, baseline * cfg.baselineFactor)) return
        val alpha = (gap.toFloat() / cfg.baselineTauNanos).coerceIn(0.001f, 1f)
        baseline += (minOf(evidence, cfg.baselineCap) - baseline) * alpha
    }

    private fun begin(k: Int, now: Long) {
        clearCandidate()
        state = WaveState.Candidate
        direction = sign(rgRel[k])
        pathStart = now
        append(k, now)
    }

    private fun append(k: Int, now: Long) {
        if (points == MAX_POINTS) dropFirst()
        pointDx[points] = rgRel[k]
        pointDy[points] = rgShiftY[k]
        pointX[points] = rgX[k]
        pointT[points] = now
        points += 1
        path += abs(rgRel[k]) / cols
        lastMassAt = now
    }

    private fun endCandidate() {
        if (points >= 2) {
            val cfg = config
            var dx = 0f
            var dy = 0f
            for (i in 0 until points) {
                dx += pointDx[i]
                dy += abs(pointDy[i])
            }
            val reason = when {
                abs(dx) / cols >= cfg.minDisplacement && abs(dx) < cfg.horizontalRatio * dy -> WaveReject.Vertical
                path >= cfg.minDisplacement && pointT[points - 1] - pathStart > cfg.maxDurationNanos -> WaveReject.Slow
                else -> WaveReject.Weak
            }
            reject(reason)
        } else if (points == 1) {
            reject(WaveReject.Weak)
        }
        clearCandidate()
        state = WaveState.Idle
    }

    private fun wholeFrame(now: Long): Boolean {
        signal = WaveSignal.Global
        evidence = 0f
        clearRegion()
        if (points >= 2) reject(WaveReject.Global) else lastReject = WaveReject.Global
        clearCandidate()
        settle()
        if (now >= cooldownUntil) cooldownUntil = now
        if (wantGrid) grid.fill(0)
        return false
    }

    private fun settle() {
        releasedSince = Long.MIN_VALUE
        if (state == WaveState.Confirmed) state = WaveState.Cooldown
        if (state != WaveState.Cooldown) state = WaveState.Unsettled
    }

    private fun reject(reason: WaveReject) {
        rejected += 1
        lastReject = reason
    }

    private fun dropFirst() {
        for (i in 1 until points) {
            pointDx[i - 1] = pointDx[i]
            pointDy[i - 1] = pointDy[i]
            pointX[i - 1] = pointX[i]
            pointT[i - 1] = pointT[i]
        }
        points -= 1
    }

    private fun clearCandidate() {
        contrary = 0
        points = 0
        direction = 0
        path = 0f
        travel = 0f
        if (state == WaveState.Candidate) state = WaveState.Idle
    }

    private fun clearRegion() {
        regionX = Float.NaN
        regionY = Float.NaN
        regionShiftX = 0f
        regionShiftY = 0f
        regionLeft = Float.NaN
        regionTop = Float.NaN
        regionRight = Float.NaN
        regionBottom = Float.NaN
    }

    private fun showRegion(k: Int) {
        if (k < 0) {
            clearRegion()
            return
        }
        regionX = rgX[k]
        regionY = rgY[k]
        regionShiftX = rgShiftX[k]
        regionShiftY = rgShiftY[k]
        regionLeft = rgMinC[k].toFloat() / cols
        regionRight = (rgMaxC[k] + 1).toFloat() / cols
        regionTop = rgMinR[k].toFloat() / rows
        regionBottom = (rgMaxR[k] + 1).toFloat() / rows
    }

    private fun findRegions() {
        regionCount = 0
        label.fill(-1)
        val radius = config.linkRadius
        var used = 0
        for (seed in 0 until cellCount) {
            if (cellState[seed] != CELL_CHANGED || label[seed] != -1) continue
            val id = if (regionCount < MAX_REGIONS) regionCount else MAX_REGIONS
            var head = 0
            var tail = 0
            queue[tail++] = seed
            label[seed] = id
            val start = used
            var minC = Int.MAX_VALUE
            var maxC = Int.MIN_VALUE
            var minR = Int.MAX_VALUE
            var maxR = Int.MIN_VALUE
            var sx = 0L
            var sy = 0L
            while (head < tail) {
                val i = queue[head++]
                val r = i / cols
                val c = i - r * cols
                members[used++] = i
                sx += c
                sy += r
                if (c < minC) minC = c
                if (c > maxC) maxC = c
                if (r < minR) minR = r
                if (r > maxR) maxR = r
                val r0 = maxOf(0, r - radius)
                val r1 = minOf(rows - 1, r + radius)
                val c0 = maxOf(0, c - radius)
                val c1 = minOf(cols - 1, c + radius)
                for (nr in r0..r1) {
                    val base = nr * cols
                    for (nc in c0..c1) {
                        val n = base + nc
                        if (cellState[n] != CELL_CHANGED || label[n] != -1) continue
                        label[n] = id
                        queue[tail++] = n
                    }
                }
            }
            val count = used - start
            if (id == MAX_REGIONS || count < config.minRegionCells) {
                used = start
                continue
            }
            rgStart[id] = start
            rgCount[id] = count
            rgX[id] = (sx.toFloat() / count + 0.5f) / cols
            rgY[id] = (sy.toFloat() / count + 0.5f) / rows
            rgMinC[id] = minC
            rgMaxC[id] = maxC
            rgMinR[id] = minR
            rgMaxR[id] = maxR
            regionCount += 1
        }
    }

    private fun match(k: Int) {
        rgMoving[k] = false
        rgSplit[k] = false
        rgShiftX[k] = 0f
        rgShiftY[k] = 0f
        if (rgCount[k] <= config.wholeRegionCells) {
            val packed = matchCells(members, rgStart[k], rgCount[k])
            if (packed == NO_MATCH) return
            rgMoving[k] = true
            rgShiftX[k] = unpackX(packed).toFloat()
            rgShiftY[k] = unpackY(packed).toFloat()
            return
        }
        val bs = config.blockCells
        val blocks = blocksX * blocksY
        blockFill.fill(0)
        val start = rgStart[k]
        val end = start + rgCount[k]
        for (m in start until end) {
            val i = members[m]
            blockFill[(i / cols / bs) * blocksX + (i % cols) / bs] += 1
        }
        var offset = 0
        for (b in 0 until blocks) {
            blockStart[b] = offset
            offset += blockFill[b]
            blockFill[b] = 0
            blockSumC[b] = 0
            blockSumR[b] = 0
            blockMinC[b] = Int.MAX_VALUE
            blockMaxC[b] = Int.MIN_VALUE
            blockMinR[b] = Int.MAX_VALUE
            blockMaxR[b] = Int.MIN_VALUE
        }
        blockStart[blocks] = offset
        for (m in start until end) {
            val i = members[m]
            val r = i / cols
            val c = i - r * cols
            val b = (r / bs) * blocksX + c / bs
            blockMembers[blockStart[b] + blockFill[b]] = i
            blockFill[b] += 1
            blockSumC[b] += c
            blockSumR[b] += r
            if (c < blockMinC[b]) blockMinC[b] = c
            if (c > blockMaxC[b]) blockMaxC[b] = c
            if (r < blockMinR[b]) blockMinR[b] = r
            if (r > blockMaxR[b]) blockMaxR[b] = r
        }
        for (b in 0 until blocks) {
            blockMoving[b] = false
            blockSeen[b] = false
            val n = blockFill[b]
            if (n < config.minBlockCells) continue
            val packed = matchCells(blockMembers, blockStart[b], n)
            if (packed == NO_MATCH) continue
            blockMoving[b] = true
            blockShiftX[b] = unpackX(packed)
            blockShiftY[b] = unpackY(packed)
        }
        for (seed in 0 until blocks) {
            if (!blockMoving[seed] || blockSeen[seed]) continue
            var top = 0
            blockStack[top++] = seed
            blockSeen[seed] = true
            var w = 0
            var wx = 0f
            var wy = 0f
            var sc = 0L
            var sr = 0L
            var minC = Int.MAX_VALUE
            var maxC = Int.MIN_VALUE
            var minR = Int.MAX_VALUE
            var maxR = Int.MIN_VALUE
            var used = 0
            while (top > 0) {
                val b = blockStack[--top]
                blockStack[blocks + used] = b
                used += 1
                val n = blockFill[b]
                w += n
                wx += n * blockShiftX[b]
                wy += n * blockShiftY[b]
                sc += blockSumC[b]
                sr += blockSumR[b]
                minC = minOf(minC, blockMinC[b])
                maxC = maxOf(maxC, blockMaxC[b])
                minR = minOf(minR, blockMinR[b])
                maxR = maxOf(maxR, blockMaxR[b])
                val bx = b % blocksX
                val by = b / blocksX
                for (dy in -1..1) {
                    for (dx in -1..1) {
                        if (dx == 0 && dy == 0) continue
                        val nx = bx + dx
                        val ny = by + dy
                        if (nx < 0 || ny < 0 || nx >= blocksX || ny >= blocksY) continue
                        val nb = ny * blocksX + nx
                        if (!blockMoving[nb] || blockSeen[nb]) continue
                        if (abs(blockShiftX[nb] - blockShiftX[b]) > 1 || abs(blockShiftY[nb] - blockShiftY[b]) > 2) continue
                        blockSeen[nb] = true
                        blockStack[top++] = nb
                    }
                }
            }
            if (w < config.minRegionCells || regionCount >= MAX_REGIONS) continue
            val id = regionCount++
            rgStart[id] = -1
            rgCount[id] = w
            rgX[id] = (sc.toFloat() / w + 0.5f) / cols
            rgY[id] = (sr.toFloat() / w + 0.5f) / rows
            rgMinC[id] = minC
            rgMaxC[id] = maxC
            rgMinR[id] = minR
            rgMaxR[id] = maxR
            rgMoving[id] = true
            rgSplit[id] = false
            rgShiftX[id] = wx / w
            rgShiftY[id] = wy / w
            for (u in 0 until used) blockGroup[blockStack[blocks + u]] = id
            rgSplit[k] = true
        }
    }

    private fun matchCells(list: IntArray, start: Int, count: Int): Int {
        val cfg = config
        val stride = maxOf(1, (count + cfg.matchCellCap - 1) / cfg.matchCellCap)
        val zero = sad(list, start, count, 0, 0, stride)
        if (zero <= 0L) return NO_MATCH
        var best = zero
        var bestX = 0
        var bestY = 0
        var slot = 0
        for (sy in coarseY) {
            for (sx in coarseX) {
                val s = if (sx == 0 && sy == 0) zero else cost(list, start, count, sx, sy, stride)
                coarseCost[slot++] = s
                if (s < 0 || (sx == 0 && sy == 0)) continue
                if (s * 50L < best * 49L) {
                    best = s
                    bestX = sx
                    bestY = sy
                }
            }
        }
        val centerX = bestX
        val centerY = bestY
        for (dy in -1..1) {
            for (dx in -1..1) {
                if (dx == 0 && dy == 0) continue
                val sx = centerX + dx
                val sy = centerY + dy
                if (abs(sx) > cfg.maxShiftX || abs(sy) > cfg.maxShiftY || (sx == 0 && sy == 0)) continue
                val s = cost(list, start, count, sx, sy, stride)
                if (s < 0) continue
                if (s * 50L < best * 49L) {
                    best = s
                    bestX = sx
                    bestY = sy
                }
            }
        }
        if (bestX == 0 && bestY == 0) return NO_MATCH
        if (abs(bestX) == cfg.maxShiftX || abs(bestY) == cfg.maxShiftY) return NO_MATCH
        if (best > (zero * cfg.matchGain).toLong()) return NO_MATCH
        var rival = Long.MAX_VALUE
        slot = 0
        for (sy in coarseY) {
            for (sx in coarseX) {
                val s = coarseCost[slot++]
                if (s >= 0 && sx * bestX < 0 && s < rival) rival = s
            }
        }
        if (rival != Long.MAX_VALUE && best * cfg.rivalRatio > rival) return NO_MATCH
        return pack(bestX, bestY)
    }

    private fun cost(list: IntArray, start: Int, count: Int, sx: Int, sy: Int, stride: Int): Long {
        val s = sad(list, start, count, sx, sy, stride)
        return if (s < 0) s else s + (abs(sx) + abs(sy)).toLong() * config.shiftPenalty
    }

    private fun sad(list: IntArray, start: Int, count: Int, sx: Int, sy: Int, stride: Int): Long {
        val moved = sx != 0 || sy != 0
        val staticCost = config.cellThreshold
        var sum = 0L
        var n = 0
        var seen = 0
        val end = start + count
        var m = start
        while (m < end) {
            val i = list[m]
            m += stride
            seen += 1
            val r = i / cols
            val c = i - r * cols
            val fr = r - sy
            val fc = c - sx
            val br = r + sy
            val bc = c + sx
            val forward = if (fr in 0 until rows && fc in 0 until cols) {
                val j = fr * cols + fc
                abs(current[i] - predicted[j]) + (if (moved && cellState[j] == CELL_STATIC) staticCost else 0)
            } else {
                Int.MAX_VALUE
            }
            val backward = if (br in 0 until rows && bc in 0 until cols) {
                val j = br * cols + bc
                abs(predicted[i] - current[j]) + (if (moved && cellState[j] == CELL_STATIC) staticCost else 0)
            } else {
                Int.MAX_VALUE
            }
            val d = minOf(forward, backward)
            if (d == Int.MAX_VALUE) continue
            sum += d
            n += 1
        }
        if (n == 0 || n * 3 < seen * 2) return -1L
        return sum * 256L / n
    }

    private fun fillGrid(best: Int) {
        for (i in 0 until cellCount) {
            val st = cellState[i]
            grid[i] = when {
                st == CELL_MASKED -> GRID_MASKED
                st != CELL_CHANGED -> GRID_STATIC
                else -> {
                    var id = label[i]
                    if (id in 0 until regionCount && rgSplit[id]) id = blockGroup[(i / cols / config.blockCells) * blocksX + (i % cols) / config.blockCells]
                    when {
                        best >= 0 && id == best -> GRID_REGION
                        id in 0 until regionCount && rgMoving[id] -> GRID_MOVING
                        else -> GRID_CHANGED
                    }
                }
            }
        }
    }

    private fun trackFace(face: FaceSample?, mirror: Boolean, now: Long) {
        if (face != null && face.atNanos != lastFaceAt && now - face.atNanos <= config.faceHoldNanos) {
            val x = if (mirror) 1f - face.x else face.x
            prevFaceX = lastFaceX
            prevFaceAt = lastFaceAt
            lastFaceX = x
            lastFaceY = face.y
            lastFaceExtent = if (face.extent.isNaN() || face.extent <= 0f) Float.NaN else face.extent
            lastFaceAt = face.atNanos
        }
        val dt = lastFaceAt - prevFaceAt
        headVelocity = if (!prevFaceX.isNaN() && prevFaceAt != Long.MIN_VALUE && dt in 1..config.headSampleWindowNanos && now - lastFaceAt <= config.headSampleWindowNanos) {
            (lastFaceX - prevFaceX) * 1e9f / dt
        } else {
            0f
        }
    }

    private fun maskFor(now: Long) {
        val cfg = config
        val recent = lastFaceAt != Long.MIN_VALUE && now - lastFaceAt <= cfg.faceHoldNanos
        val fx = if (recent) lastFaceX else cfg.defaultFaceX
        val fy = if (recent) lastFaceY else cfg.defaultFaceY
        val extent = if (recent && !lastFaceExtent.isNaN()) lastFaceExtent else cfg.defaultFaceExtent
        val fw = maxOf(cfg.faceMinExtent, extent)
        val aspect = if (sampledHeight > 0) sampledWidth.toFloat() / sampledHeight else 4f / 3f
        val fh = fw * aspect
        val sweep = recent && !prevFaceX.isNaN() && now - prevFaceAt <= cfg.headSampleWindowNanos
        val sweptLeft = if (sweep) minOf(fx, prevFaceX) else fx
        val sweptRight = if (sweep) maxOf(fx, prevFaceX) else fx
        maskLeft = (sweptLeft - cfg.faceHalfWidth * fw).coerceIn(0f, 1f)
        maskRight = (sweptRight + cfg.faceHalfWidth * fw).coerceIn(0f, 1f)
        maskTop = (fy - cfg.faceAbove * fh).coerceIn(0f, 1f)
        maskBottom = (fy + cfg.faceBelow * fh).coerceIn(0f, 1f)
        maskC0 = (maskLeft * cols).toInt()
        maskC1 = (maskRight * cols).toInt().coerceAtMost(cols - 1)
        maskR0 = (maskTop * rows).toInt()
        maskR1 = (maskBottom * rows).toInt().coerceAtMost(rows - 1)
    }

    private fun swap() {
        val t = previous
        previous = current
        current = t
    }

    private fun sample(nv21: ByteArray, width: Int, height: Int, mirror: Boolean) {
        if (width != sampledWidth || height != sampledHeight || mirror != sampledMirror || sampleX.isEmpty()) {
            sampledWidth = width
            sampledHeight = height
            sampledMirror = mirror
            hasPrevious = false
            sampleX = IntArray(cols * 2)
            sampleY = IntArray(rows * 2)
            for (c in 0 until cols) {
                val source = if (mirror) cols - 1 - c else c
                val left = source * width / cols
                val cw = maxOf(1, (source + 1) * width / cols - left)
                sampleX[c * 2] = (left + cw / 4).coerceAtMost(width - 1)
                sampleX[c * 2 + 1] = (left + cw * 3 / 4).coerceAtMost(width - 1)
            }
            for (r in 0 until rows) {
                val top = r * height / rows
                val ch = maxOf(1, (r + 1) * height / rows - top)
                sampleY[r * 2] = (top + ch / 4).coerceAtMost(height - 1) * width
                sampleY[r * 2 + 1] = (top + ch * 3 / 4).coerceAtMost(height - 1) * width
            }
        }
        val sx = sampleX
        val sy = sampleY
        val out = current
        for (r in 0 until rows) {
            val r0 = sy[r * 2]
            val r1 = sy[r * 2 + 1]
            val base = r * cols
            for (c in 0 until cols) {
                val x0 = sx[c * 2]
                val x1 = sx[c * 2 + 1]
                out[base + c] = ((nv21[r0 + x0].toInt() and 0xFF) + (nv21[r0 + x1].toInt() and 0xFF) +
                    (nv21[r1 + x0].toInt() and 0xFF) + (nv21[r1 + x1].toInt() and 0xFF)) shr 2
            }
        }
    }

    internal companion object {
        const val MAX_POINTS = 24
        const val MAX_REGIONS = 32
        const val CELL_STATIC: Byte = 0
        const val CELL_CHANGED: Byte = 1
        const val CELL_MASKED: Byte = 2
        const val GRID_STATIC: Byte = 0
        const val GRID_CHANGED: Byte = 1
        const val GRID_MASKED: Byte = 2
        const val GRID_MOVING: Byte = 3
        const val GRID_REGION: Byte = 4

        const val NO_MATCH: Int = Int.MIN_VALUE

        fun sign(v: Float): Int = if (v > 0f) 1 else if (v < 0f) -1 else 0

        fun pack(x: Int, y: Int): Int = ((x + 128) shl 8) or (y + 128)

        fun unpackX(p: Int): Int = (p shr 8) - 128

        fun unpackY(p: Int): Int = (p and 0xFF) - 128

        fun coarse(max: Int): IntArray {
            val values = ArrayList<Int>()
            values += 0
            var m = 2
            while (m <= max) {
                values += m
                values += -m
                m += 2
            }
            if (max % 2 == 1) {
                values += max
                values += -max
            }
            return values.toIntArray()
        }
    }
}

internal interface MotionFrameProcessor {
    fun onFrame(nv21: ByteArray, width: Int, height: Int, mirror: Boolean, nowNanos: Long)

    fun onFace(x: Float, y: Float, extent: Float, nowNanos: Long)

    fun onFaceLost(nowNanos: Long)
}

/**
 * Glue between the camera consumer and [WaveSwipeDetector] for one camera session. It runs on the
 * camera callback thread, never waits: a frame that arrives while the previous one is still being
 * analysed is skipped. Events are published only while the session generation is current.
 */
internal class WaveMotionProcessor(
    private val input: WaveGestureInput,
    private val generation: Int,
    private val clock: () -> Long = { System.nanoTime() },
) : MotionFrameProcessor {
    private val detector = WaveSwipeDetector(input.config)
    private val busy = AtomicBoolean(false)
    private val face = AtomicReference<FaceSample?>(null)
    private var disabled = false

    override fun onFrame(nv21: ByteArray, width: Int, height: Int, mirror: Boolean, nowNanos: Long) {
        if (!busy.compareAndSet(false, true)) {
            input.skipped.incrementAndGet()
            return
        }
        try {
            if (!input.enabled) {
                if (!disabled) {
                    disabled = true
                    detector.reset()
                    input.state = WaveState.Disabled
                }
                return
            }
            disabled = false
            if (!detector.due(nowNanos)) return
            val cfg = input.config
            if (cfg !== detector.config) detector.config = cfg
            detector.wantGrid = input.gridRequested
            val start = clock()
            val event = detector.observe(nv21, width, height, mirror, nowNanos, face.get())
            input.processing.record((clock() - start) / 1_000_000f)
            input.report(detector, generation)
            if (event) {
                if (input.publish(generation, nowNanos)) input.published += 1 else input.publishRefused += 1
            }
        } finally {
            busy.set(false)
        }
    }

    override fun onFace(x: Float, y: Float, extent: Float, nowNanos: Long) {
        face.set(FaceSample(x, y, extent, nowNanos))
    }

    override fun onFaceLost(nowNanos: Long) {
        face.set(null)
    }
}

internal class WaveSlot(val generation: Int, val event: WaveEvent?)

/**
 * One-shot wave events for BIKETRIS. The camera session owns it; the game reads [latest] and
 * consumes each sequence number once. The camera generation and the latest event live in one
 * immutable [WaveSlot] that is only replaced by compare-and-set: [publish] commits only if the
 * slot it checked is still current, and [clear] (camera stop) always installs a new slot with the
 * next generation and no event. A publish that read the old generation therefore can never make
 * its event visible after [clear], and no caller ever waits on a lock.
 */
public class WaveGestureInput internal constructor() {
    private val sequence = AtomicLong(0L)
    private val slot = AtomicReference(WaveSlot(0, null))
    private val gridLock = ReentrantLock()
    private var gridCells = ByteArray(0)
    private var gridVersion = 0L

    @Volatile
    internal var publishCommitHook: (() -> Unit)? = null

    @Volatile
    internal var config: WaveConfig = WaveConfig()

    @Volatile
    internal var enabled: Boolean = true

    @Volatile
    internal var gridRequested: Boolean = false

    internal var gridCols: Int = 0
        private set
    internal var gridRows: Int = 0
        private set

    internal val processing: DurationWindow = DurationWindow(64)
    internal val skipped: AtomicLong = AtomicLong(0L)

    @Volatile
    internal var state: WaveState = WaveState.Idle

    @Volatile
    internal var signal: WaveSignal = WaveSignal.None

    @Volatile
    internal var observations: Long = 0L

    @Volatile
    internal var accepted: Int = 0

    @Volatile
    internal var rejected: Int = 0

    @Volatile
    internal var suppressed: Int = 0

    @Volatile
    internal var published: Int = 0

    @Volatile
    internal var publishRefused: Int = 0

    @Volatile
    internal var lastReject: WaveReject = WaveReject.None

    @Volatile
    internal var mass: Float = 0f

    @Volatile
    internal var globalMass: Float = 0f

    @Volatile
    internal var evidence: Float = 0f

    @Volatile
    internal var baseline: Float = 0f

    @Volatile
    internal var onsetLevel: Float = 0f

    @Volatile
    internal var releaseLevel: Float = 0f

    @Volatile
    internal var direction: Int = 0

    @Volatile
    internal var displacement: Float = 0f

    @Volatile
    internal var headSpeed: Float = 0f

    @Volatile
    internal var regionX: Float = Float.NaN

    @Volatile
    internal var regionY: Float = Float.NaN

    @Volatile
    internal var regionLeft: Float = Float.NaN

    @Volatile
    internal var regionTop: Float = Float.NaN

    @Volatile
    internal var regionRight: Float = Float.NaN

    @Volatile
    internal var regionBottom: Float = Float.NaN

    @Volatile
    internal var maskLeft: Float = 0f

    @Volatile
    internal var maskTop: Float = 0f

    @Volatile
    internal var maskRight: Float = 0f

    @Volatile
    internal var maskBottom: Float = 0f

    @Volatile
    internal var simulatedEvents: Int = 0

    internal fun generation(): Int = slot.get().generation

    internal fun latest(): WaveEvent? = slot.get().event

    internal fun publish(generation: Int, atNanos: Long): Boolean {
        while (true) {
            val current = slot.get()
            if (current.generation != generation) return false
            val next = WaveSlot(generation, WaveEvent(sequence.incrementAndGet(), atNanos, simulated = false))
            publishCommitHook?.invoke()
            if (slot.compareAndSet(current, next)) return true
        }
    }

    internal fun simulate(atNanos: Long) {
        simulatedEvents += 1
        while (true) {
            val current = slot.get()
            if (slot.compareAndSet(current, WaveSlot(current.generation, WaveEvent(sequence.incrementAndGet(), atNanos, simulated = true)))) return
        }
    }

    internal fun report(detector: WaveSwipeDetector, generation: Int) {
        if (generation != slot.get().generation) return
        state = detector.state
        signal = detector.signal
        observations = detector.observations
        accepted = detector.accepted
        rejected = detector.rejected
        suppressed = detector.suppressed
        lastReject = detector.lastReject
        mass = detector.mass
        globalMass = detector.globalMass
        evidence = detector.evidence
        baseline = detector.baseline
        onsetLevel = detector.onsetLevel
        releaseLevel = detector.releaseLevel
        direction = detector.direction
        displacement = detector.travel
        headSpeed = detector.headVelocity
        regionX = detector.regionX
        regionY = detector.regionY
        regionLeft = detector.regionLeft
        regionTop = detector.regionTop
        regionRight = detector.regionRight
        regionBottom = detector.regionBottom
        maskLeft = detector.maskLeft
        maskTop = detector.maskTop
        maskRight = detector.maskRight
        maskBottom = detector.maskBottom
        if (detector.wantGrid && gridLock.tryLock()) {
            try {
                if (gridCells.size != detector.grid.size) gridCells = ByteArray(detector.grid.size)
                System.arraycopy(detector.grid, 0, gridCells, 0, gridCells.size)
                gridCols = detector.cols
                gridRows = detector.rows
                gridVersion += 1
            } finally {
                gridLock.unlock()
            }
        }
    }

    /** Copies the latest diagnostic grid into [out] if it changed since [seenVersion]; returns the version held. */
    internal fun copyGrid(out: ByteArray, seenVersion: Long): Long {
        gridLock.lock()
        try {
            if (gridVersion == seenVersion || gridCells.size != out.size) return gridVersion
            System.arraycopy(gridCells, 0, out, 0, out.size)
            return gridVersion
        } finally {
            gridLock.unlock()
        }
    }

    internal fun clear() {
        while (true) {
            val current = slot.get()
            if (slot.compareAndSet(current, WaveSlot(current.generation + 1, null))) break
        }
        state = WaveState.Idle
        signal = WaveSignal.None
        observations = 0L
        accepted = 0
        rejected = 0
        suppressed = 0
        lastReject = WaveReject.None
        mass = 0f
        globalMass = 0f
        evidence = 0f
        baseline = 0f
        direction = 0
        displacement = 0f
        headSpeed = 0f
        regionX = Float.NaN
        regionY = Float.NaN
        regionLeft = Float.NaN
        regionTop = Float.NaN
        regionRight = Float.NaN
        regionBottom = Float.NaN
        skipped.set(0L)
    }
}
