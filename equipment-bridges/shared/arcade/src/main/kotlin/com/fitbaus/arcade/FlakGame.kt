// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.abs
import kotlin.math.min
import kotlin.random.Random

internal data class FlakConfig(
    val width: Float = 256f,
    val height: Float = 144f,
    val groundTop: Float = 124f,
    val bandTop: Float = 14f,
    val bandBottom: Float = 112f,
    val jetMinX: Float = 20f,
    val jetMaxX: Float = 150f,
    val sideSpeed: Float = 80f,
    val boostOffset: Float = 16f,
    val jetHalfWidth: Float = 7f,
    val jetHalfHeight: Float = 3f,
    val climbSpeed: Float = 110f,
    val scrollSpeed: Float = 40f,
    val boostScrollSpeed: Float = 90f,
    val missileHalfWidth: Float = 5f,
    val missileHalfHeight: Float = 2f,
    val missileWarnSeconds: Float = 1.4f,
    val missileSpeed: Float = 85f,
    val missileSpeedPerLevel: Float = 8f,
    val maxMissileSpeed: Float = 125f,
    val pairGapMin: Float = 34f,
    val pairGapMax: Float = 48f,
    val turretFireSeconds: Float = 2.6f,
    val turretWarnSeconds: Float = 1.2f,
    val shellFlightSeconds: Float = 1.6f,
    val burstHalfWidth: Float = 12f,
    val burstHalfHeight: Float = 8f,
    val invulnerableSeconds: Float = 2f,
    val lives: Int = 3,
    val levelSeconds: Float = 40f,
    val maxLevel: Int = 5,
    val firstMissileAt: Float = 4f,
    val firstTurretAt: Float = 6f,
    val conflictSeconds: Float = 1.0f,
    val step: Float = 1f / 60f,
    val maxFrame: Float = 0.1f,
)

internal enum class FlakPhase { Playing, GameOver }

internal class Missile(var x: Float, val y: Float, val speed: Float, var warn: Float) {
    var resolved = false
}

internal class Turret(var x: Float, var fireIn: Float) {
    var fired = false
}

/**
 * A tracking flak shell. It homes on the jet's current screen position, so steering cannot shake
 * it, but it is aimed for normal flight speed: [debt] is the extra distance the jet has flown on
 * the dash since launch, and the shell's aim point trails the jet by exactly that much. It
 * bursts when its flight time runs out.
 */
internal class Shell(val startX: Float, val startY: Float, val flight: Float) {
    var x = startX
    var y = startY
    var age = 0f
    var debt = 0f
    var resolved = false
}

internal class Blast(val x: Float, val y: Float, var age: Float, val flak: Boolean = false)

internal class FlakEvent(val atSeconds: Float, val text: String)

/**
 * FLAK RUN simulation in a 256x144 logical playfield, advanced in fixed steps. Missiles arrive
 * from the right, sometimes in pairs with a gap between them: change altitude to dodge. Ground
 * turrets fire tracking shells: only a timed dash's extra speed makes a shell fall behind.
 * Head position steers the jet up/down and left/right.
 */
internal class FlakGame(
    val config: FlakConfig = FlakConfig(),
    random: Random = Random.Default,
    private val autoSpawn: Boolean = true,
) {
    private val rng = random
    val missiles = ArrayList<Missile>()
    val turrets = ArrayList<Turret>()
    val shells = ArrayList<Shell>()
    val blasts = ArrayList<Blast>()
    val events = ArrayList<FlakEvent>()

    var onEvent: ((String) -> Unit)? = null

    var phase: FlakPhase = FlakPhase.Playing
        private set
    var jetX: Float = startX()
        private set
    var jetY: Float = (config.bandTop + config.bandBottom) / 2f
        private set
    var lives: Int = config.lives
        private set
    var score: Int = 0
        private set
    var elapsed: Float = 0f
        private set
    var scroll: Float = 0f
        private set
    var invulnerable: Float = 0f
        private set
    var boosting: Boolean = false
        private set
    var missilesDodged: Int = 0
        private set
    var shellsDodged: Int = 0
        private set
    var hits: Int = 0
        private set
    private var scoreFraction = 0f
    private var nextMissile = config.firstMissileAt
    private var nextTurret = config.firstTurretAt
    private var accumulator = 0f
    private var lastFrameNanos = Long.MIN_VALUE

    val level: Int
        get() = min(config.maxLevel, (elapsed / config.levelSeconds).toInt())

    val missileSpeed: Float
        get() = min(config.maxMissileSpeed, config.missileSpeed + config.missileSpeedPerLevel * level)

    val pairChance: Float
        get() = min(0.7f, 0.3f + 0.1f * level)

    private fun startX(): Float = config.jetMinX + 0.3f * (config.jetMaxX - config.jetMinX)

    fun resetClock() {
        lastFrameNanos = Long.MIN_VALUE
        accumulator = 0f
    }

    fun advance(nowNanos: Long, targetY: Float, boost: Boolean, targetX: Float = 0.3f): Int {
        if (lastFrameNanos == Long.MIN_VALUE) {
            lastFrameNanos = nowNanos
            return 0
        }
        val frame = ((nowNanos - lastFrameNanos) / 1_000_000_000f).coerceIn(0f, config.maxFrame)
        lastFrameNanos = nowNanos
        accumulator += frame
        var steps = 0
        while (accumulator >= config.step) {
            step(config.step, targetY, boost, targetX)
            accumulator -= config.step
            steps += 1
        }
        return steps
    }

    fun step(dt: Float, targetY: Float, boost: Boolean, targetX: Float = 0.3f) {
        if (phase != FlakPhase.Playing) return
        elapsed += dt
        boosting = boost
        moveJet(dt, targetY, targetX, boost)
        val speed = if (boost) config.boostScrollSpeed else config.scrollSpeed
        scroll += speed * dt
        invulnerable = (invulnerable - dt).coerceAtLeast(0f)
        scoreFraction += 10f * dt
        val whole = scoreFraction.toInt()
        if (whole > 0) {
            score += whole
            scoreFraction -= whole
        }
        if (autoSpawn) schedule()
        updateMissiles(dt)
        updateTurrets(dt, speed)
        updateShells(dt, speed)
        val iterator = blasts.iterator()
        while (iterator.hasNext()) {
            val b = iterator.next()
            b.age += dt
            if (b.age > BLAST_SECONDS) iterator.remove()
        }
    }

    fun spawnMissile(y: Float, speed: Float = missileSpeed, warn: Float = config.missileWarnSeconds) {
        missiles += Missile(config.width + config.missileHalfWidth + 2f, y.coerceIn(config.bandTop, config.bandBottom), speed, warn)
    }

    fun spawnMissilePair(y: Float, gap: Float, speed: Float = missileSpeed) {
        val first = y.coerceIn(config.bandTop, config.bandBottom)
        val up = first - gap
        val second = if (up >= config.bandTop) up else first + gap
        spawnMissile(first, speed)
        spawnMissile(second.coerceIn(config.bandTop, config.bandBottom), speed)
    }

    fun spawnTurret(fireIn: Float = config.turretFireSeconds) {
        turrets += Turret(config.width + 8f, fireIn)
    }

    fun restart() {
        missiles.clear()
        turrets.clear()
        shells.clear()
        blasts.clear()
        events.clear()
        phase = FlakPhase.Playing
        jetX = startX()
        jetY = (config.bandTop + config.bandBottom) / 2f
        lives = config.lives
        score = 0
        scoreFraction = 0f
        elapsed = 0f
        scroll = 0f
        invulnerable = 0f
        missilesDodged = 0
        shellsDodged = 0
        hits = 0
        nextMissile = config.firstMissileAt
        nextTurret = config.firstTurretAt
        resetClock()
        log("restart")
    }

    fun bandY(target: Float): Float = config.bandTop + target.coerceIn(0f, 1f) * (config.bandBottom - config.bandTop)

    fun laneX(target: Float): Float = config.jetMinX + target.coerceIn(0f, 1f) * (config.jetMaxX - config.jetMinX)

    fun missileArrival(m: Missile): Float = m.warn.coerceAtLeast(0f) + ((m.x - jetX) / m.speed).coerceAtLeast(0f)

    private fun moveJet(dt: Float, targetY: Float, targetX: Float, boost: Boolean) {
        val goalY = bandY(targetY)
        val maxDy = config.climbSpeed * dt
        jetY += (goalY - jetY).coerceIn(-maxDy, maxDy)
        val goalX = (laneX(targetX) + if (boost) config.boostOffset else 0f).coerceAtMost(config.width - config.jetHalfWidth - 4f)
        val maxDx = config.sideSpeed * dt
        jetX += (goalX - jetX).coerceIn(-maxDx, maxDx)
    }

    private fun pendingImpacts(): List<Float> {
        val out = ArrayList<Float>(turrets.size + shells.size)
        for (t in turrets) if (!t.fired) out += t.fireIn + config.shellFlightSeconds
        for (s in shells) if (!s.resolved) out += s.flight - s.age
        return out
    }

    private fun schedule() {
        if (elapsed >= nextTurret) {
            val impact = config.turretFireSeconds + config.shellFlightSeconds
            if (missiles.any { !it.resolved && abs(missileArrival(it) - impact) < config.conflictSeconds }) {
                nextTurret = elapsed + 0.5f
            } else {
                spawnTurret()
                nextTurret = elapsed + (5.5f - 0.4f * level).coerceAtLeast(3.5f) + rng.nextFloat() * 1.5f
            }
        }
        if (elapsed >= nextMissile) {
            val speed = missileSpeed
            val arrival = config.missileWarnSeconds + (config.width + config.missileHalfWidth + 2f - jetX) / speed
            if (pendingImpacts().any { abs(it - arrival) < config.conflictSeconds }) {
                nextMissile = elapsed + 0.5f
            } else {
                val y = jetY + (rng.nextFloat() - 0.5f) * 20f
                if (rng.nextFloat() < pairChance) {
                    spawnMissilePair(y, config.pairGapMin + rng.nextFloat() * (config.pairGapMax - config.pairGapMin), speed)
                } else {
                    spawnMissile(y, speed)
                }
                nextMissile = elapsed + (3.2f - 0.3f * level).coerceAtLeast(1.8f) + rng.nextFloat()
            }
        }
    }

    private fun updateMissiles(dt: Float) {
        val iterator = missiles.iterator()
        while (iterator.hasNext()) {
            val m = iterator.next()
            if (m.warn > 0f) {
                m.warn -= dt
                continue
            }
            m.x -= m.speed * dt
            if (!m.resolved && abs(m.x - jetX) < config.missileHalfWidth + config.jetHalfWidth && abs(m.y - jetY) < config.missileHalfHeight + config.jetHalfHeight) {
                m.resolved = true
                blasts += Blast(m.x, m.y, 0f)
                iterator.remove()
                hit("missile")
                continue
            }
            if (!m.resolved && m.x + config.missileHalfWidth < jetX - config.jetHalfWidth) {
                m.resolved = true
                missilesDodged += 1
                score += MISSILE_POINTS
            }
            if (m.x < -20f) iterator.remove()
        }
    }

    private fun updateTurrets(dt: Float, scrollSpeed: Float) {
        val iterator = turrets.iterator()
        while (iterator.hasNext()) {
            val t = iterator.next()
            t.x -= scrollSpeed * dt
            if (!t.fired) {
                t.fireIn -= dt
                if (t.fireIn <= 0f) {
                    t.fired = true
                    shells += Shell(t.x - 4f, config.groundTop - 8f, config.shellFlightSeconds)
                }
            }
            if (t.x < -20f) iterator.remove()
        }
    }

    private fun updateShells(dt: Float, scrollSpeed: Float) {
        val iterator = shells.iterator()
        while (iterator.hasNext()) {
            val s = iterator.next()
            s.age += dt
            s.debt += (scrollSpeed - config.scrollSpeed) * dt
            val p = (s.age / s.flight).coerceAtMost(1f)
            s.x = s.startX + (jetX - s.debt - s.startX) * p
            s.y = s.startY + (jetY - s.startY) * p
            if (s.age < s.flight) continue
            s.resolved = true
            blasts += Blast(s.x, s.y, 0f, flak = true)
            iterator.remove()
            if (abs(s.x - jetX) < config.burstHalfWidth + config.jetHalfWidth && abs(s.y - jetY) < config.burstHalfHeight + config.jetHalfHeight) {
                hit("flak")
            } else {
                shellsDodged += 1
                score += SHELL_POINTS
            }
        }
    }

    private fun hit(what: String) {
        if (invulnerable > 0f) return
        lives -= 1
        hits += 1
        invulnerable = config.invulnerableSeconds
        blasts += Blast(jetX, jetY, 0f)
        log("hit by $what, lives $lives")
        if (lives <= 0) {
            phase = FlakPhase.GameOver
            log("game over, score $score")
        }
    }

    private fun log(text: String) {
        if (events.size >= MAX_EVENTS) events.removeAt(0)
        events += FlakEvent(elapsed, text)
        onEvent?.invoke("flak: $text")
    }

    companion object {
        const val MISSILE_POINTS = 25
        const val SHELL_POINTS = 40
        const val BLAST_SECONDS = 0.4f
        const val MAX_EVENTS = 6
    }
}
