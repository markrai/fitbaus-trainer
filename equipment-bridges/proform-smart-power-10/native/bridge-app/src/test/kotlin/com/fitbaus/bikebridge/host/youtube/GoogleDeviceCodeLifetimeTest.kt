// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class GoogleDeviceCodeLifetimeTest {
    @Test
    fun googleExampleCodeIsValidForThirtyMinutesNotTheFollowingDay() {
        val issuedAt = 1_000_000L
        val deadline = GoogleDeviceCodeLifetime.deadline(issuedAt, 1800)
        assertEquals(issuedAt + 1_800_000L, deadline)
        assertTrue(GoogleDeviceCodeLifetime.isValid(deadline, deadline - 1))
        assertFalse(GoogleDeviceCodeLifetime.isValid(deadline, deadline))
        assertFalse(GoogleDeviceCodeLifetime.isValid(deadline, issuedAt + 86_400_000L))
        assertEquals(0L, GoogleDeviceCodeLifetime.remainingMs(deadline, issuedAt + 86_400_000L))
    }

    @Test
    fun respectsActualServerIssuedTtlNotFixedThirtyMinutes() {
        val issuedAt = 100L
        val shortDeadline = GoogleDeviceCodeLifetime.deadline(issuedAt, 75)
        assertEquals(75_000L, GoogleDeviceCodeLifetime.remainingMs(shortDeadline, issuedAt))
        assertFalse(GoogleDeviceCodeLifetime.isValid(shortDeadline, issuedAt + 75_000L))
        val longerDeadline = GoogleDeviceCodeLifetime.deadline(issuedAt, 3600)
        assertTrue(GoogleDeviceCodeLifetime.isValid(longerDeadline, issuedAt + 1_800_000L))
        assertEquals(3_600_000L, GoogleDeviceCodeLifetime.remainingMs(longerDeadline, issuedAt))
    }

    @Test
    fun invalidLifetimesCannotCreateAStaleOrUnboundedCode() {
        assertThrows(IllegalArgumentException::class.java) { GoogleDeviceCodeLifetime.deadline(0, 0) }
        assertThrows(IllegalArgumentException::class.java) { GoogleDeviceCodeLifetime.deadline(0, -1) }
        assertThrows(IllegalArgumentException::class.java) { GoogleDeviceCodeLifetime.deadline(0, 86_401) }
        assertEquals(0L, GoogleDeviceCodeLifetime.remainingMs(90, 100))
    }

    @Test
    fun reauthorizationIsDemandDrivenAndDoesNotReimportOrRotateKeys() {
        val dir = "src/main/kotlin/com/fitbaus/bikebridge/host/youtube/"
        val controller = File(dir + "GoogleAccountController.kt").readText()
        val store = File(dir + "GoogleAccountStore.kt").readText()
        val view = File(dir + "GoogleAccountView.kt").readText()
        val content = File(dir + "YouTubeContent.kt").readText()

        val start = controller.substringAfter("fun start() {").substringBefore("fun stop() {")
        assertFalse(start.contains("requestStoredAuthorization("))
        assertFalse(start.contains("api.requestCode("))
        assertTrue(start.contains("val pending = ticket"))
        assertTrue(start.contains("GoogleDeviceCodeLifetime.isValid(deadlineMs"))
        val stop = controller.substringAfter("fun stop() {").substringBefore("fun destroy() {")
        assertFalse(stop.contains("ticket = null"))
        assertTrue(stop.contains("handler.removeCallbacks(pollRunnable)"))
        val expiry = controller.substringAfter("private fun expireIfNeeded() {")
            .substringBefore("private fun cancelPending() {")
        assertFalse(expiry.contains("requestStoredAuthorization("))
        assertTrue(expiry.contains("cancelPending()"))
        assertTrue(expiry.contains("GoogleAccountPhase.Error"))

        val savedRequest = controller.substringAfter("fun requestStoredAuthorization() {")
            .substringBefore("fun start() {")
        assertTrue(savedRequest.contains("store.client()"))
        assertTrue(savedRequest.contains("api.requestCode(client)"))
        assertFalse(savedRequest.contains("store.saveClient("))
        assertFalse(savedRequest.contains("store.clearRefreshToken("))

        assertTrue(store.contains("override fun hasStoredClient(): Boolean"))
        assertTrue(view.contains("if (autoAuthorize) account.ensureAuthorizationOnOpen()"))
        assertTrue(view.contains("account.requestStoredAuthorization()"))
        assertTrue(controller.contains("fun checkAuthorizationExpiry()"))
        assertTrue(view.contains("override fun onWindowFocusChanged(hasWindowFocus: Boolean)"))
        assertTrue(view.contains("if (hasWindowFocus) account.checkAuthorizationExpiry()"))
        assertTrue(view.contains("button(\"CHANGE CLIENT\")"))
        assertTrue(content.contains("accountView.open(autoAuthorize = false)"))
    }
}
