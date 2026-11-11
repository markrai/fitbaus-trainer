// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import com.fitbaus.bikebridge.protocol.BridgeMachineJson
import com.fitbaus.bikebridge.protocol.BridgeMetricJson
import com.fitbaus.bikebridge.protocol.NativeTelemetrySnapshot
import com.fitbaus.bikebridge.protocol.PairingToken
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import java.util.concurrent.atomic.AtomicLong

class BridgeUiStateTest {
    private val streaming = NativeTelemetrySnapshot(
        connected = true,
        initialized = true,
        snapshotAt = "2026-11-09T20:00:00.000Z",
        resistance = BridgeMetricJson(0, "2026-11-09T20:00:00.000Z", true),
        rpm = BridgeMetricJson(0, "2026-11-09T20:00:00.000Z", true),
        watts = BridgeMetricJson(0, "2026-11-09T20:00:00.000Z", true),
        machine = BridgeMachineJson(type = "Bike", canSetResistance = true, maxResistanceLevel = 22.0),
    )

    @Test
    fun streamingMatchesLegacyReferenceScreen() {
        val state = BridgeUiStateMapper.map(UsbPhase.Streaming, "polling warm-state primary=7 maxR=22", streaming)
        assertEquals("Streaming telemetry", BridgeUiStateMapper.statusRow(state))
        assertEquals("Connected (VID 8508 PID 2)", state.usbText)
        assertEquals("Initialized", state.initText)
        assertEquals("Bike", state.machineText)
        assertEquals("Connected / Initialized", BridgeUiStateMapper.bikeRow(streaming))
        assertEquals("Available", BridgeUiStateMapper.controlRow(streaming))
        assertEquals("0", BridgeUiStateMapper.formatGrid(BridgeUiStateMapper.currentValue(streaming.resistance)))
        assertEquals("—", BridgeUiStateMapper.formatGrid(streaming.requestedResistance))
    }

    @Test
    fun startingMatchesLegacyStartingState() {
        val state = BridgeUiStateMapper.starting()
        assertEquals("Starting - Application starting", BridgeUiStateMapper.statusRow(state))
        assertEquals("Disconnected", state.usbText)
        assertEquals("Not initialized", state.initText)
        assertEquals("Unknown", state.machineText)
        assertEquals("Not connected / Not initialized", BridgeUiStateMapper.bikeRow(null))
        assertEquals("Unavailable", BridgeUiStateMapper.controlRow(null))
    }

    @Test
    fun noOperatorStringMentionsShire() {
        for (phase in UsbPhase.values()) {
            val state = BridgeUiStateMapper.map(phase, "usb rejected: no normal-mode brainboard device found", streaming)
            val all = listOf(state.statusText, state.usbText, state.initText, state.machineText, state.detail)
            assertFalse(all.any { it.contains("shire", ignoreCase = true) }, "$phase $all")
        }
    }

    @Test
    fun permissionAndNotFoundUseLegacyWording() {
        val offline = streaming.copy(connected = false)
        val permission = BridgeUiStateMapper.map(UsbPhase.PermissionRequired, "usb permission required", offline)
        assertEquals("USB permission required - USB permission required", BridgeUiStateMapper.statusRow(permission))
        assertEquals("Permission required (VID 8508 PID 2)", permission.usbText)
        val missing = BridgeUiStateMapper.map(
            UsbPhase.DeviceNotFound,
            "usb rejected: no normal-mode brainboard device found",
            offline,
        )
        assertEquals("USB device not found - no normal-mode brainboard device found", BridgeUiStateMapper.statusRow(missing))
        assertEquals("Not found", missing.usbText)
        val bootloader = BridgeUiStateMapper.map(
            UsbPhase.DeviceNotFound,
            "usb rejected: bootloader PID 0x99 for VID 0x213c present; opening refused",
            offline,
        )
        assertEquals("Bootloader VID 8508 PID 153", bootloader.usbText)
        val disconnected = BridgeUiStateMapper.map(UsbPhase.Disconnected, "usb detached", offline)
        assertEquals("Console disconnected - usb detached", BridgeUiStateMapper.statusRow(disconnected))
        assertEquals("Disconnected", disconnected.usbText)
        assertEquals("Disconnected", disconnected.initText)
    }

    @Test
    fun staleMetricsRenderAsUnknownLikeLegacyDisconnect() {
        val stale = streaming.copy(
            connected = false,
            rpm = BridgeMetricJson(55, "2026-11-09T20:00:00.000Z", false),
        )
        assertNull(BridgeUiStateMapper.currentValue(stale.rpm))
        assertEquals("—", BridgeUiStateMapper.formatGrid(BridgeUiStateMapper.currentValue(stale.rpm)))
        assertEquals("Unavailable", BridgeUiStateMapper.controlRow(stale))
    }

    @Test
    fun gridValueSizeMatchesLegacyFormulaOnConsole() {
        val sp = BridgeUiStateMapper.gridValueSp(1280, 800, 1f, 1f)
        assertEquals(159.083f, sp, 0.01f)
        assertEquals(sp, BridgeUiStateMapper.gridValueSp(1280, 752, 1f, 1f), 0.001f)
        assertEquals(56f, BridgeUiStateMapper.gridValueSp(1280, 100, 1f, 1f), 0.001f)
        assertEquals(168f, BridgeUiStateMapper.gridValueSp(10_000, 2_000, 1f, 1f), 0.001f)
        assertEquals(24f, BridgeUiStateMapper.gridValueSp(100, 800, 1f, 1f), 0.001f)
    }

    @Test
    fun legacyDpRounding() {
        assertEquals(16, BridgeUiStateMapper.dp(16, 1f))
        assertEquals(108, BridgeUiStateMapper.dp(108, 1f))
        assertEquals(24, BridgeUiStateMapper.dp(16, 1.5f))
        assertEquals(2, BridgeUiStateMapper.dp(1, 1.5f))
    }

    @Test
    fun lanEndpointPrefersRoutableIpv4() {
        val candidates = listOf(
            LanIpv4Candidate("127.0.0.1", isUp = true, isLoopback = true),
            LanIpv4Candidate("169.254.3.4", isUp = true, isLoopback = false),
            LanIpv4Candidate("10.0.0.9", isUp = false, isLoopback = false),
            LanIpv4Candidate("192.168.1.226", isUp = true, isLoopback = false),
        )
        assertEquals("192.168.1.226:8765", LanEndpointDisplay.format(8765, candidates))
        assertEquals("169.254.3.4:8765", LanEndpointDisplay.format(8765, candidates.take(3)))
        assertEquals("0.0.0.0:8765", LanEndpointDisplay.format(8765, emptyList()))
    }

    @Test
    fun activitySourceKeepsLegacyCaptionsAndPalette() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        for (caption in listOf(
            "\"RPM\"", "\"WATTS\"", "\"RESISTANCE\"", "\"HR\"", "\"DIAGNOSTICS\"", "\"STATUS\"", "\"USB\"",
            "\"INIT\"", "\"BIKE\"", "\"CONTROL\"", "\"REQUESTED\"", "\"OBSERVED\"", "\"MACHINE\"", "\"BRIDGE\"",
            "\"HTTP\"", "\"FITBAUS\"",
        )) {
            assertTrue(source.contains(caption), caption)
        }
        assertFalse(source.contains("\"SHIRE\""))
        for (color in listOf(
            "Color.rgb(180, 180, 180)", "Color.rgb(140, 140, 140)", "Color.rgb(48, 48, 48)",
            "Color.rgb(255, 0, 255)", "Color.rgb(0, 150, 255)", "Color.rgb(255, 140, 0)", "Color.rgb(255, 40, 40)",
        )) {
            assertTrue(source.contains(color), color)
        }
        assertTrue(source.contains("FLAG_KEEP_SCREEN_ON"))
    }
}

class BridgeStoresTest {
    @Test
    fun heartRateIsFreshForThreeSeconds() {
        val now = AtomicLong(1_000_000L)
        val store = HeartRateStore { now.get() }
        assertNull(store.displayBpm())
        store.record(142)
        assertEquals(142, store.displayBpm())
        now.addAndGet(3_000L)
        assertEquals(142, store.displayBpm())
        now.addAndGet(1L)
        assertNull(store.displayBpm())
        assertEquals(HeartRateView(142, false), store.view())
        store.record(150)
        now.addAndGet(-10L)
        assertNull(store.displayBpm())
        assertNull(store.view())
    }

    @Test
    fun brightnessPersistsAndRejectsOutOfRange() {
        val persisted = MemoryInt()
        val store = BrightnessStore(persisted)
        assertNull(store.percent())
        store.record(35)
        assertEquals(35, store.percent())
        assertEquals(35, persisted.value)
        val revision = store.revision
        store.record(101)
        assertEquals(35, store.percent())
        assertEquals(revision, store.revision)
        assertEquals(35, BrightnessStore(persisted).percent())
        persisted.value = 400
        assertNull(BrightnessStore(persisted).percent())
    }

    @Test
    fun brightnessWindowMappingMatchesLegacy() {
        assertEquals(0.01f, BrightnessLimits.toWindowBrightness(0), 0.0001f)
        assertEquals(0.01f, BrightnessLimits.toWindowBrightness(1), 0.0001f)
        assertEquals(0.5f, BrightnessLimits.toWindowBrightness(50), 0.0001f)
        assertEquals(1f, BrightnessLimits.toWindowBrightness(100), 0.0001f)
    }

    @Test
    fun pairingTokenIsCreatedOncePersistedAndRegenerated() {
        val persisted = MemoryString()
        val store = PairingTokenStore(persisted)
        val token = store.token()
        assertEquals(8, token.length)
        assertEquals(token, persisted.value)
        assertEquals(token, PairingTokenStore(persisted).token())
        val fresh = store.regenerate()
        assertNotEquals(token, fresh)
        assertEquals(fresh, persisted.value)
        persisted.value = "corrupt"
        val repaired = PairingTokenStore(persisted).token()
        assertEquals(8, repaired.length)
        assertNotEquals("corrupt", repaired)
    }

    @Test
    fun storedLegacyHexTokenIsReplacedWithShortCode() {
        val persisted = MemoryString()
        persisted.value = "00112233445566778899aabbccddeeff"
        val token = PairingTokenStore(persisted).token()
        assertEquals(8, token.length)
        assertTrue(token.all { it in PairingToken.GENERATED_ALPHABET }, token)
        assertEquals(token, persisted.value)
    }

    @Test
    fun storedShortCodeIsKeptAcrossRestarts() {
        val persisted = MemoryString()
        persisted.value = "XB5G5132"
        assertEquals("XB5G5132", PairingTokenStore(persisted).token())
        assertEquals("XB5G5132", persisted.value)
    }

    private class MemoryInt(var value: Int? = null) : IntPersistence {
        override fun load(): Int? = value
        override fun save(value: Int) {
            this.value = value
        }
    }

    private class MemoryString(var value: String? = null) : StringPersistence {
        override fun load(): String? = value
        override fun save(value: String) {
            this.value = value
        }
    }
}
