// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import java.io.File
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class UnlockQualificationTest {
    @Test
    fun stagingOffStaysWarmState() {
        assertEquals("off", BuildConfig.UNLOCK_QUALIFICATION)
        assertEquals(false, BuildConfig.PRODUCTION_IDENTITY)
        assertEquals(ColdStartWritePlan.WarmState, UnlockQualification.plan())
        assertTrue(
            BuildConfig.QUALIFICATION_IDENTITY.contains("fitbaus.unlockQualification=off"),
            BuildConfig.QUALIFICATION_IDENTITY,
        )
        assertTrue(
            BuildConfig.QUALIFICATION_IDENTITY.contains("fitbaus.applicationId=com.fitbaus.bikebridge.native"),
            BuildConfig.QUALIFICATION_IDENTITY,
        )
    }

    @Test
    fun productionOffUsesQualifiedAuthOnly() {
        assertEquals(
            ColdStartWritePlan.AuthOnly,
            UnlockQualification.plan(qualification = "off", productionIdentity = true),
        )
        assertEquals(
            ColdStartWritePlan.WarmState,
            UnlockQualification.plan(qualification = "off", productionIdentity = false),
        )
        assertEquals(
            ColdStartWritePlan.AuthOnly,
            UnlockQualification.plan(qualification = "auth", productionIdentity = false),
        )
        assertEquals(
            ColdStartWritePlan.AuthPlusIdleLockout,
            UnlockQualification.plan(qualification = "lockout", productionIdentity = false),
        )
    }

    @Test
    fun gradleForbidsProductionUnlockQualificationFlags() {
        val gradle = File("build.gradle.kts").readText()
        assertTrue(gradle.contains("require(!isProduction || unlockQualification == \"off\")"), gradle)
        assertTrue(
            gradle.contains("\$unlockQualification cannot be combined with bridgeIdentity=production"),
            gradle,
        )
        assertTrue(gradle.contains("production authenticates when DeviceInfo requires unlock"), gradle)
        assertTrue(gradle.contains("QUALIFICATION_IDENTITY"), gradle)
        assertTrue(gradle.contains("PRODUCTION_IDENTITY"), gradle)
    }
}
