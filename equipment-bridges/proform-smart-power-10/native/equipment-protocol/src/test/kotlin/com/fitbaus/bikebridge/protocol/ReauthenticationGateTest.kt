// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertSame

class ReauthenticationGateTest {
    private val policy = ReauthenticationPolicy(
        minAttemptSpacingMillis = 2_000L,
        maxConsecutiveFailures = 3,
        maxUnlocksPerWindow = 3,
        unlockWindowMillis = 60_000L,
    )

    @Test
    fun firstAttemptProceedsImmediately() {
        val gate = ReauthenticationGate(policy)
        assertSame(ReauthenticationDecision.AttemptNow, gate.onSessionStart(0L))
        assertEquals(ReauthenticationState.AUTHENTICATING, gate.state)
        assertSame(ReauthenticationDecision.AlreadyAuthenticating, gate.onSecurityBlock(10L))
    }

    @Test
    fun securityBlocksAreRateLimited() {
        val gate = ReauthenticationGate(policy)
        gate.onSessionStart(0L)
        gate.onAttemptFailed(100L)
        assertEquals(ReauthenticationState.COOLING_DOWN, gate.state)
        assertEquals(2_000L, assertIs<ReauthenticationDecision.WaitUntil>(gate.onSecurityBlock(500L)).atMillis)
        assertEquals(2_000L, assertIs<ReauthenticationDecision.WaitUntil>(gate.onSecurityBlock(1_999L)).atMillis)
        assertSame(ReauthenticationDecision.AttemptNow, gate.onSecurityBlock(2_000L))
    }

    @Test
    fun consecutiveFailuresExhaustTheGate() {
        val gate = ReauthenticationGate(policy)
        var now = 0L
        repeat(3) {
            assertSame(ReauthenticationDecision.AttemptNow, gate.onSecurityBlock(now))
            gate.onAttemptFailed(now)
            now += 2_000L
        }
        assertEquals(ReauthenticationState.EXHAUSTED, gate.state)
        assertEquals(ExhaustionCause.CONSECUTIVE_FAILURES, assertIs<ReauthenticationDecision.Stop>(gate.onSecurityBlock(now + 60_000L)).cause)
    }

    @Test
    fun successClearsFailureCount() {
        val gate = ReauthenticationGate(policy)
        gate.onSessionStart(0L)
        gate.onAttemptFailed(0L)
        gate.onSecurityBlock(2_000L)
        gate.onAttemptFailed(2_000L)
        gate.onSecurityBlock(4_000L)
        gate.onAttemptSucceeded(4_000L)
        assertEquals(0, gate.consecutiveFailures)
        assertEquals(ReauthenticationState.AUTHENTICATED, gate.state)
        assertSame(ReauthenticationDecision.AttemptNow, gate.onSecurityBlock(30_000L))
    }

    @Test
    fun repeatedRelockingIsBounded() {
        val gate = ReauthenticationGate(policy)
        var now = 0L
        repeat(3) {
            assertSame(ReauthenticationDecision.AttemptNow, gate.onSecurityBlock(now))
            gate.onAttemptSucceeded(now)
            now += 5_000L
        }
        assertEquals(ExhaustionCause.RELOCK_CHURN, assertIs<ReauthenticationDecision.Stop>(gate.onSecurityBlock(now)).cause)
        assertEquals(ReauthenticationState.EXHAUSTED, gate.state)
    }

    @Test
    fun relockChurnWindowSlides() {
        val gate = ReauthenticationGate(policy)
        var now = 0L
        repeat(3) {
            gate.onSecurityBlock(now)
            gate.onAttemptSucceeded(now)
            now += 25_000L
        }
        assertSame(ReauthenticationDecision.AttemptNow, gate.onSecurityBlock(now))
    }

    @Test
    fun resetRequiresExplicitCallAfterExhaustion() {
        val gate = ReauthenticationGate(policy)
        var now = 0L
        repeat(3) {
            gate.onSecurityBlock(now)
            gate.onAttemptFailed(now)
            now += 2_000L
        }
        assertIs<ReauthenticationDecision.Stop>(gate.onSessionStart(now))
        gate.reset()
        assertEquals(ReauthenticationState.UNAUTHENTICATED, gate.state)
        assertSame(ReauthenticationDecision.AttemptNow, gate.onSessionStart(now))
    }

    @Test
    fun outcomesRequireAnAttemptInProgress() {
        val gate = ReauthenticationGate(policy)
        assertFailsWith<IllegalStateException> { gate.onAttemptSucceeded(0L) }
        assertFailsWith<IllegalStateException> { gate.onAttemptFailed(0L) }
    }

    @Test
    fun policyRejectsUnboundedSettings() {
        assertFailsWith<IllegalArgumentException> { ReauthenticationPolicy(minAttemptSpacingMillis = 0L) }
        assertFailsWith<IllegalArgumentException> { ReauthenticationPolicy(maxConsecutiveFailures = 0) }
        assertFailsWith<IllegalArgumentException> { ReauthenticationPolicy(maxUnlocksPerWindow = 0) }
        assertFailsWith<IllegalArgumentException> { ReauthenticationPolicy(unlockWindowMillis = 0L) }
    }
}
