// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

public class ReauthenticationPolicy(
    public val minAttemptSpacingMillis: Long = 2_000L,
    public val maxConsecutiveFailures: Int = 3,
    public val maxUnlocksPerWindow: Int = 5,
    public val unlockWindowMillis: Long = 10 * 60_000L,
) {
    init {
        require(minAttemptSpacingMillis > 0) { "minAttemptSpacingMillis must be positive" }
        require(maxConsecutiveFailures > 0) { "maxConsecutiveFailures must be positive" }
        require(maxUnlocksPerWindow > 0) { "maxUnlocksPerWindow must be positive" }
        require(unlockWindowMillis > 0) { "unlockWindowMillis must be positive" }
    }
}

public enum class ReauthenticationState {
    UNAUTHENTICATED,
    AUTHENTICATING,
    AUTHENTICATED,
    COOLING_DOWN,
    EXHAUSTED,
}

public enum class ExhaustionCause {
    CONSECUTIVE_FAILURES,
    RELOCK_CHURN,
}

public sealed class ReauthenticationDecision {
    public object AttemptNow : ReauthenticationDecision() {
        override fun toString(): String = "AttemptNow"
    }

    public object AlreadyAuthenticating : ReauthenticationDecision() {
        override fun toString(): String = "AlreadyAuthenticating"
    }

    public class WaitUntil internal constructor(public val atMillis: Long) : ReauthenticationDecision() {
        override fun toString(): String = "WaitUntil($atMillis)"
    }

    public class Stop internal constructor(public val cause: ExhaustionCause) : ReauthenticationDecision() {
        override fun toString(): String = "Stop($cause)"
    }
}

public class ReauthenticationGate(private val policy: ReauthenticationPolicy = ReauthenticationPolicy()) {
    private var lastAttemptAtMillis: Long? = null
    private val recentUnlocks = ArrayDeque<Long>()

    public var state: ReauthenticationState = ReauthenticationState.UNAUTHENTICATED
        private set

    public var consecutiveFailures: Int = 0
        private set

    public var exhaustionCause: ExhaustionCause? = null
        private set

    public fun onSessionStart(nowMillis: Long): ReauthenticationDecision = requestAttempt(nowMillis)

    public fun onSecurityBlock(nowMillis: Long): ReauthenticationDecision {
        if (state == ReauthenticationState.AUTHENTICATED) {
            state = ReauthenticationState.UNAUTHENTICATED
        }
        return requestAttempt(nowMillis)
    }

    public fun onAttemptSucceeded(nowMillis: Long) {
        check(state == ReauthenticationState.AUTHENTICATING) { "no authentication attempt in progress" }
        consecutiveFailures = 0
        recentUnlocks.addLast(nowMillis)
        state = ReauthenticationState.AUTHENTICATED
    }

    public fun onAttemptFailed(nowMillis: Long) {
        check(state == ReauthenticationState.AUTHENTICATING) { "no authentication attempt in progress" }
        consecutiveFailures++
        if (consecutiveFailures >= policy.maxConsecutiveFailures) {
            exhaust(ExhaustionCause.CONSECUTIVE_FAILURES)
        } else {
            state = ReauthenticationState.COOLING_DOWN
        }
    }

    public fun reset() {
        lastAttemptAtMillis = null
        recentUnlocks.clear()
        consecutiveFailures = 0
        exhaustionCause = null
        state = ReauthenticationState.UNAUTHENTICATED
    }

    private fun requestAttempt(nowMillis: Long): ReauthenticationDecision {
        when (state) {
            ReauthenticationState.EXHAUSTED -> return ReauthenticationDecision.Stop(exhaustionCause!!)
            ReauthenticationState.AUTHENTICATING -> return ReauthenticationDecision.AlreadyAuthenticating
            else -> Unit
        }
        pruneUnlocks(nowMillis)
        if (recentUnlocks.size >= policy.maxUnlocksPerWindow) {
            exhaust(ExhaustionCause.RELOCK_CHURN)
            return ReauthenticationDecision.Stop(ExhaustionCause.RELOCK_CHURN)
        }
        val last = lastAttemptAtMillis
        if (last != null) {
            val readyAt = last + policy.minAttemptSpacingMillis
            if (nowMillis < readyAt) return ReauthenticationDecision.WaitUntil(readyAt)
        }
        lastAttemptAtMillis = nowMillis
        state = ReauthenticationState.AUTHENTICATING
        return ReauthenticationDecision.AttemptNow
    }

    private fun pruneUnlocks(nowMillis: Long) {
        while (recentUnlocks.isNotEmpty() && nowMillis - recentUnlocks.first() >= policy.unlockWindowMillis) {
            recentUnlocks.removeFirst()
        }
    }

    private fun exhaust(cause: ExhaustionCause) {
        exhaustionCause = cause
        state = ReauthenticationState.EXHAUSTED
    }
}
