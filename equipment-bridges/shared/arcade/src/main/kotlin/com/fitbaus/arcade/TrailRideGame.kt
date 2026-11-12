// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

internal data class TrailRideConfig(
    val world: TrailWorldConfig = TrailWorldConfig(),
    val riderHalfWidth: Float = 0.22f,
    val steerRange: Float = 3.4f,
    val steerSpeed: Float = 3.2f,
    val steerResponse: Float = 7f,
    val minSpeed: Float = 5.6f,
    val maxSpeed: Float = 8.6f,
    val minSpeedRpm: Float = 40f,
    val maxSpeedRpm: Float = 100f,
    val startSpeed: Float = 3f,
    val acceleration: Float = 3f,
    val edgeTolerance: Float = 0.15f,
    val edgeWarning: Float = 0.35f,
    val offTrailSeconds: Float = 0.3f,
    val jumpEarlySeconds: Float = 1.25f,
    val jumpLateSeconds: Float = 0.12f,
    /** The "SURGE NOW" cue shows this long before the window opens, covering the detector's 0.5-0.75 s confirmation. */
    val surgeCueLead: Float = 0.45f,
    val jumpAirSeconds: Float = 1.6f,
    val hopAirSeconds: Float = 0.45f,
    val landingMargin: Float = 0.3f,
    val jumpHeight: Float = 0.55f,
    val hopHeight: Float = 0.18f,
    val crashSeconds: Float = 1.2f,
    val invulnerableSeconds: Float = 2f,
    val readySeconds: Float = 2f,
    val step: Float = 1f / 60f,
    val maxFrame: Float = 0.1f,
)

internal enum class TrailPhase { Ready, Riding, Crashed }

internal enum class TrailCrash { None, Obstacle, OffTrail, Ditch }

internal enum class JumpResult { None, Clean, Early, Late, Hop }

internal class TrailEvent(val atSeconds: Float, val text: String)

/**
 * TRAIL RIDE simulation, advanced in fixed steps from distance-based world geometry.
 *
 * The rider's lateral position chases an absolute world-x target from head steering at a bounded
 * speed; the trail centre bends independently, so following a curve takes real steering. Forward
 * progress comes from read-only cadence. A jump starts only from [requestJump], which the view
 * calls once per new confirmed cadence surge. It clears a ditch only when it started inside that
 * ditch's takeoff window ([TrailRideConfig.jumpLateSeconds]..[TrailRideConfig.jumpEarlySeconds]
 * before the near edge at the current speed) and the rider stays airborne over the whole ditch.
 * Hazards are resolved by sweeping the distance covered in each step, so no step can skip one.
 * The ride is endless: a crash costs a short recovery and momentum, never the game.
 */
internal class TrailRideGame(
    val config: TrailRideConfig = TrailRideConfig(),
    seed: Long = 1L,
) {
    val world: TrailRideWorld = TrailRideWorld(config.world, seed)
    val events: ArrayList<TrailEvent> = ArrayList()
    var onEvent: ((String) -> Unit)? = null

    var phase: TrailPhase = TrailPhase.Ready
        private set
    var distance: Float = 0f
        private set
    var riderX: Float = 0f
        private set
    var riderVx: Float = 0f
        private set
    var targetX: Float = 0f
        private set
    var speed: Float = 0f
        private set
    var crashes: Int = 0
        private set
    var score: Int = 0
        private set
    var elapsed: Float = 0f
        private set
    var invulnerable: Float = 0f
        private set
    var readyLeft: Float = config.readySeconds
        private set
    var crashLeft: Float = 0f
        private set
    var lastCrash: TrailCrash = TrailCrash.None
        private set
    var lastJump: JumpResult = JumpResult.None
        private set
    var lastJumpAt: Float = -100f
        private set
    var lastCrashAt: Float = -100f
        private set
    var lastClearAt: Float = -100f
        private set
    var airLeft: Float = 0f
        private set
    var airTotal: Float = 0f
        private set
    var offTrailFor: Float = 0f
        private set
    var dodged: Int = 0
        private set
    var jumpsCleared: Int = 0
        private set
    var ditchesMissed: Int = 0
        private set
    var obstacleHits: Int = 0
        private set
    var offTrails: Int = 0
        private set
    var jumpTimeToDitch: Float = Float.NaN
        private set
    var levelReached: Int = 0
        private set
    private var jumpDitchId = -1
    private var crashDitch: TrailDitch? = null
    private var pendingJump = false
    private var scoreFraction = 0f
    private var accumulator = 0f
    private var lastFrameNanos = Long.MIN_VALUE

    init {
        world.ensure(0f)
    }

    val airborne: Boolean
        get() = airLeft > 0f

    /** Visual lift in metres: a smooth arc over the current jump. */
    val airHeight: Float
        get() {
            if (!airborne || airTotal <= 0f) return 0f
            val peak = if (jumpDitchId >= 0) config.jumpHeight else config.hopHeight
            return peak * sin(Math.PI.toFloat() * (1f - airLeft / airTotal))
        }

    val level: Int
        get() = world.level(distance)

    val lateralError: Float
        get() = riderX - world.center(distance)

    /** True while the rider is close to (or past) a trail edge. */
    val nearEdge: Boolean
        get() = abs(lateralError) > config.world.halfWidth - config.edgeWarning

    val jumpQualified: Boolean
        get() = airborne && jumpDitchId >= 0

    fun speedFor(rpm: Float): Float {
        val t = ((rpm - config.minSpeedRpm) / (config.maxSpeedRpm - config.minSpeedRpm)).coerceIn(0f, 1f)
        return config.minSpeed + (config.maxSpeed - config.minSpeed) * t
    }

    /** Seconds until the rider reaches [ditch]'s near edge at the current speed. */
    fun timeTo(ditch: TrailDitch): Float = (ditch.start - distance) / max(speed, MIN_TIMING_SPEED)

    fun nextDitch(): TrailDitch? = world.nextDitch(distance)

    fun resetClock() {
        lastFrameNanos = Long.MIN_VALUE
        accumulator = 0f
        pendingJump = false
    }

    /** One new confirmed cadence surge. Consumed by the next simulation step; discarded unless riding. */
    fun requestJump() {
        if (phase == TrailPhase.Riding) pendingJump = true
    }

    fun restart(seed: Long) {
        world.reset(seed)
        world.ensure(0f)
        events.clear()
        phase = TrailPhase.Ready
        distance = 0f
        riderX = 0f
        riderVx = 0f
        targetX = 0f
        speed = 0f
        crashes = 0
        score = 0
        scoreFraction = 0f
        elapsed = 0f
        invulnerable = 0f
        readyLeft = config.readySeconds
        crashLeft = 0f
        lastCrash = TrailCrash.None
        lastJump = JumpResult.None
        lastJumpAt = -100f
        lastCrashAt = -100f
        lastClearAt = -100f
        airLeft = 0f
        airTotal = 0f
        offTrailFor = 0f
        dodged = 0
        jumpsCleared = 0
        ditchesMissed = 0
        obstacleHits = 0
        offTrails = 0
        jumpTimeToDitch = Float.NaN
        levelReached = 0
        jumpDitchId = -1
        crashDitch = null
        resetClock()
        log("restart seed $seed")
    }

    fun advance(nowNanos: Long, steer: Float, rpm: Float): Int {
        if (lastFrameNanos == Long.MIN_VALUE) {
            lastFrameNanos = nowNanos
            return 0
        }
        val frame = ((nowNanos - lastFrameNanos) / 1_000_000_000f).coerceIn(0f, config.maxFrame)
        lastFrameNanos = nowNanos
        accumulator += frame
        var steps = 0
        while (accumulator >= config.step) {
            step(config.step, steer, rpm)
            accumulator -= config.step
            steps += 1
        }
        return steps
    }

    fun step(dt: Float, steer: Float, rpm: Float) {
        elapsed += dt
        targetX = steer.coerceIn(-1f, 1f) * config.steerRange
        when (phase) {
            TrailPhase.Ready -> {
                pendingJump = false
                moveRider(dt)
                readyLeft -= dt
                if (readyLeft <= 0f) {
                    phase = TrailPhase.Riding
                    speed = config.startSpeed
                    log("go")
                }
            }
            TrailPhase.Crashed -> {
                pendingJump = false
                riderVx = 0f
                crashLeft -= dt
                if (crashLeft <= 0f) recover()
            }
            TrailPhase.Riding -> ride(dt, rpm)
        }
    }

    private fun ride(dt: Float, rpm: Float) {
        if (!airborne) {
            val goal = speedFor(rpm)
            val maxDv = config.acceleration * dt
            speed += (goal - speed).coerceIn(-maxDv, maxDv)
        }
        if (pendingJump) {
            pendingJump = false
            startJump()
        }
        moveRider(dt)
        val previous = distance
        distance += speed * dt
        if (airborne) {
            airLeft = (airLeft - dt).coerceAtLeast(0f)
            if (!airborne) jumpDitchId = -1
        }
        world.ensure(distance)
        invulnerable = (invulnerable - dt).coerceAtLeast(0f)
        if (resolveDitches(previous)) return
        if (resolveObstacles(previous)) return
        if (checkTrail(dt)) return
        addScore(dt * speed * DISTANCE_POINTS)
        val reached = world.level(distance)
        if (reached > levelReached) {
            levelReached = reached
            score += LEVEL_POINTS * reached
            log("level $reached")
        }
        world.trim(distance)
    }

    /** First-order approach to the steering target, capped at [TrailRideConfig.steerSpeed]; stable for any step. */
    private fun moveRider(dt: Float) {
        if (dt <= 0f) return
        val maxMove = config.steerSpeed * dt
        val move = ((targetX - riderX) * min(1f, config.steerResponse * dt)).coerceIn(-maxMove, maxMove)
        riderX += move
        riderVx = move / dt
    }

    private fun startJump() {
        if (airborne) return
        val ditch = world.nextDitch(distance)?.takeIf { it.start > distance }
        val toDitch = ditch?.let { timeTo(it) } ?: Float.NaN
        jumpTimeToDitch = toDitch
        val qualified = ditch != null && toDitch >= config.jumpLateSeconds && toDitch <= config.jumpEarlySeconds
        lastJumpAt = elapsed
        if (ditch != null && qualified) {
            jumpDitchId = ditch.id
            airTotal = max(config.jumpAirSeconds, (ditch.end + config.landingMargin - distance) / max(speed, MIN_TIMING_SPEED) + config.step)
            lastJump = JumpResult.Clean
        } else {
            jumpDitchId = -1
            airTotal = config.hopAirSeconds
            lastJump = when {
                ditch == null -> JumpResult.Hop
                toDitch > config.jumpEarlySeconds -> if (toDitch <= EARLY_REPORT_SECONDS) JumpResult.Early else JumpResult.Hop
                else -> JumpResult.Late
            }
        }
        airLeft = airTotal
        log(String.format(Locale.US, "jump %s (%.2f s to ditch)", lastJump, toDitch))
    }

    /** Returns true if the rider crashed. */
    private fun resolveDitches(previous: Float): Boolean {
        val ditches = world.ditches
        for (k in 0 until ditches.size) {
            val ditch = ditches[k]
            if (ditch.resolved) continue
            if (ditch.start >= distance) break
            if (previous >= ditch.end) {
                ditch.resolved = true
                continue
            }
            val qualified = jumpDitchId == ditch.id && airborne
            if (qualified) {
                if (distance >= ditch.end) {
                    ditch.resolved = true
                    ditch.cleared = true
                    jumpsCleared += 1
                    lastClearAt = elapsed
                    score += JUMP_POINTS
                    log("cleared ditch at ${ditch.start.toInt()} m")
                }
                continue
            }
            if (invulnerable > 0f) {
                ditch.resolved = true
                continue
            }
            ditch.resolved = true
            ditchesMissed += 1
            crashDitch = ditch
            crash(TrailCrash.Ditch, "fell into ditch at ${ditch.start.toInt()} m (${if (airborne) "jump not timed for it" else "on the ground"})")
            return true
        }
        return false
    }

    private fun resolveObstacles(previous: Float): Boolean {
        val reach = config.riderHalfWidth
        val obstacles = world.obstacles
        for (k in 0 until obstacles.size) {
            val o = obstacles[k]
            if (o.resolved) continue
            if (o.distance > distance) break
            o.resolved = true
            if (o.distance <= previous - SWEEP_SLOP) continue
            if (abs(riderX - o.x) < o.radius + reach && invulnerable <= 0f) {
                o.hit = true
                obstacleHits += 1
                crash(TrailCrash.Obstacle, "hit ${o.kind.name.lowercase(Locale.US)} at ${o.distance.toInt()} m (dx ${String.format(Locale.US, "%.2f", riderX - o.x)})")
                return true
            }
            if (invulnerable <= 0f) {
                dodged += 1
                score += DODGE_POINTS
            }
        }
        return false
    }

    private fun checkTrail(dt: Float): Boolean {
        val limit = config.world.halfWidth + config.edgeTolerance
        if (abs(lateralError) <= limit || airborne) {
            offTrailFor = 0f
            return false
        }
        offTrailFor += dt
        if (offTrailFor < config.offTrailSeconds || invulnerable > 0f) return false
        offTrails += 1
        crash(TrailCrash.OffTrail, String.format(Locale.US, "rode off the trail (error %.2f m)", lateralError))
        return true
    }

    private fun crash(reason: TrailCrash, detail: String) {
        crashes += 1
        lastCrash = reason
        lastCrashAt = elapsed
        airLeft = 0f
        jumpDitchId = -1
        pendingJump = false
        offTrailFor = 0f
        riderVx = 0f
        log("$detail (crash $crashes)")
        phase = TrailPhase.Crashed
        crashLeft = config.crashSeconds
    }

    private fun recover() {
        val ditch = crashDitch
        if (ditch != null) distance = max(distance, ditch.end + RECOVER_PAST_DITCH)
        crashDitch = null
        val centre = world.center(distance)
        val w = config.world.halfWidth - config.riderHalfWidth
        if (lastCrash == TrailCrash.OffTrail || abs(riderX - centre) > w) riderX = centre + (riderX - centre).coerceIn(-w * 0.5f, w * 0.5f)
        for (o in world.obstacles) if (!o.resolved && o.distance <= distance + RECOVER_CLEARANCE) o.resolved = true
        invulnerable = config.invulnerableSeconds
        speed = config.startSpeed
        phase = TrailPhase.Riding
        log("recovered")
    }

    private fun addScore(points: Float) {
        scoreFraction += points
        val whole = scoreFraction.toInt()
        if (whole > 0) {
            score += whole
            scoreFraction -= whole
        }
    }

    private fun log(text: String) {
        if (events.size >= MAX_EVENTS) events.removeAt(0)
        events += TrailEvent(elapsed, text)
        onEvent?.invoke("trail: $text")
    }

    companion object {
        const val DISTANCE_POINTS = 1f
        const val DODGE_POINTS = 20
        const val JUMP_POINTS = 150
        const val LEVEL_POINTS = 100
        const val MAX_EVENTS = 8
        const val MIN_TIMING_SPEED = 0.5f
        const val EARLY_REPORT_SECONDS = 4f
        const val RECOVER_PAST_DITCH = 0.6f
        const val RECOVER_CLEARANCE = 1.5f
        const val SWEEP_SLOP = 0.0001f
    }
}
