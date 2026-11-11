// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import android.util.Log
import com.fitbaus.bikebridge.host.usb.OpenResult
import com.fitbaus.bikebridge.host.usb.ProbeTransport
import com.fitbaus.bikebridge.host.usb.TransportFailureClass
import com.fitbaus.bikebridge.host.usb.TransportResult
import com.fitbaus.bikebridge.host.usb.UsbHostGateway
import com.fitbaus.bikebridge.host.usb.UsbQualification
import com.fitbaus.bikebridge.host.usb.UsbQualificationResult
import com.fitbaus.bikebridge.host.policy.TransmitAllowlist
import com.fitbaus.bikebridge.protocol.AuthorizationOutcome
import com.fitbaus.bikebridge.protocol.BikeField
import com.fitbaus.bikebridge.protocol.BridgeHttpJson
import com.fitbaus.bikebridge.protocol.BridgeHttpResult
import com.fitbaus.bikebridge.protocol.BridgeMachineJson
import com.fitbaus.bikebridge.protocol.ContinuousReadPlan
import com.fitbaus.bikebridge.protocol.DeviceInfo
import com.fitbaus.bikebridge.protocol.EquipmentAuthorizationSequence
import com.fitbaus.bikebridge.protocol.EquipmentDevice
import com.fitbaus.bikebridge.protocol.EquipmentExchange
import com.fitbaus.bikebridge.protocol.EquipmentRequest
import com.fitbaus.bikebridge.protocol.EquipmentRequests
import com.fitbaus.bikebridge.protocol.FieldValue
import com.fitbaus.bikebridge.protocol.IdentityCollectionResult
import com.fitbaus.bikebridge.protocol.IdleModeLockoutWriteResult
import com.fitbaus.bikebridge.protocol.NativeTelemetrySnapshot
import com.fitbaus.bikebridge.protocol.PrimaryDeviceBootstrap
import com.fitbaus.bikebridge.protocol.PrimaryDeviceBootstrapResult
import com.fitbaus.bikebridge.protocol.ReadWriteDataResult
import com.fitbaus.bikebridge.protocol.ResistanceLimits
import com.fitbaus.bikebridge.protocol.ResistanceWriteResult
import com.fitbaus.bikebridge.protocol.VerifySecurityOutcome
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal enum class SessionStopResult {
    Released,
    TimedOut,
}

internal enum class UsbPhase {
    Starting,
    DeviceNotFound,
    PermissionRequired,
    UsbConnected,
    Initializing,
    InitializationFailed,
    Initialized,
    Streaming,
    Disconnected,
}

/**
 * Continuous USB session. Production identity authenticates once per USB
 * session when DeviceInfo requires unlock (the qualified AuthOnly sequence).
 * Staging WarmState still skips VerifySecurity. Write-time SECURITY_BLOCK
 * never retries unlock.
 */
internal class NativeUsbSession(
    private val gateway: UsbHostGateway,
    private val requestPermission: (deviceName: String) -> Boolean,
    private val sleeper: (Long) -> Unit = { ms ->
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    },
    private val nowIso: () -> String = { isoNow() },
    private val minRequestSpacingMs: Long = HostConstants.MIN_REQUEST_SPACING_MS,
    private val maxReconnectAttempts: Int = HostConstants.UNLIMITED_USB_RECONNECT,
    private val reconnectDelayMs: Long = 500L,
    private val stopJoinMs: Long = HostConstants.STOP_JOIN_MS,
    /**
     * Production construction must keep the default [SecurityHashCompatibility.Unresolved].
     * There is no HTTP, Intent, or preference path that can change this.
     * Offline tests may pass [SecurityHashCompatibility.IndependentlyEstablished].
     */
    private val securityHashCompatibility: SecurityHashCompatibility = SecurityHashCompatibility.Unresolved,
    /**
     * Production construction uses [UnlockQualification.plan] (AuthOnly on
     * production identity). Offline tests and staging qualification APKs may pass
     * WarmState / AuthOnly / AuthPlusIdleLockout without assigning
     * IndependentlyEstablished.
     */
    private val coldStartWritePlan: ColdStartWritePlan = ColdStartWritePlan.WarmState,
    private val maxConsecutiveExchangeFailures: Int = HostConstants.MAX_CONSECUTIVE_EXCHANGE_FAILURES,
    private val permissionPollMs: Long = HostConstants.PERMISSION_POLL_MS,
    private val resistanceQueueWaitMs: Long = HostConstants.RESISTANCE_QUEUE_WAIT_MS,
    private val resistanceTransmitWaitMs: Long = HostConstants.RESISTANCE_TRANSMIT_WAIT_MS,
) {
    private val running = AtomicBoolean(false)
    private val snapshot = AtomicReference(BridgeHttpJson.emptySnapshot(nowIso()))
    private val diagnostic = AtomicReference("stopped")
    private val phase = AtomicReference(UsbPhase.Starting)
    private val lifecycle = AtomicReference(SessionLifecycle.Idle)
    private val terminalFailure = AtomicBoolean(false)
    private val verifySecurityAttempted = AtomicBoolean(false)
    private val controllerUnlocked = AtomicBoolean(false)
    private val permissionPromptAllowed = AtomicBoolean(true)
    private val pendingResistance = AtomicReference<PendingResistanceWrite?>(null)
    private val lastResistanceOutcome = AtomicReference<String?>(null)
    /**
     * Set when a field-2 write returns SECURITY_BLOCK. Readable max resistance alone does not
     * prove write authorization; this keeps [canSetResistance] false for the rest of the USB
     * session so HTTP readiness cannot overclaim after a rejected write.
     */
    private val writeSecurityBlocked = AtomicBoolean(false)
    private val workerLock = Any()
    private var worker: Thread? = null

    @Volatile
    private var lastExchangeAtMs: Long = 0L

    fun snapshot(): NativeTelemetrySnapshot = snapshot.get()

    fun phase(): UsbPhase = phase.get()

    fun lastResistanceOutcome(): String? = lastResistanceOutcome.get()

    fun statusLine(): String {
        val reason = diagnostic.get()
        return when (lifecycle.get()) {
            SessionLifecycle.StopTimedOut -> "stop timed out; USB may still be held ($reason)"
            else -> reason
        }
    }

    fun usbWorkerAlive(): Boolean {
        val thread = synchronized(workerLock) { worker }
        return thread?.isAlive == true
    }

    fun requestPermissionAgain() {
        permissionPromptAllowed.set(true)
    }

    fun ensureRunning(): Boolean {
        val state = lifecycle.get()
        if (state == SessionLifecycle.Stopping || state == SessionLifecycle.StopTimedOut) return false
        if (usbWorkerAlive()) return false
        start()
        return true
    }

    /**
     * Queues a Legacy-equivalent field-2 write on the USB worker.
     * HTTP 200 only after the bike returns Done. Does not send VerifySecurity.
     */
    fun setResistance(level: Int): BridgeHttpResult {
        ResistanceLimits.validate(level)?.let { error ->
            return BridgeHttpResult(400, "Bad Request", BridgeHttpJson.error(error))
        }
        if (!running.get() || lifecycle.get() != SessionLifecycle.Running) {
            return unavailable("usb session not running")
        }
        val snap = snapshot.get()
        if (!snap.connected || !snap.initialized || !snap.machine.canSetResistance) {
            return unavailable("resistance control unavailable")
        }
        val maxLevel = snap.machine.maxResistanceLevel.toInt()
        if (maxLevel <= 0) {
            return unavailable("max resistance unknown")
        }
        val pending = PendingResistanceWrite(level)
        if (!pendingResistance.compareAndSet(null, pending)) {
            return unavailable("resistance command in flight")
        }
        if (awaitDone(pending, resistanceQueueWaitMs)) {
            return pending.result.get() ?: uncertain()
        }
        if (pending.state.compareAndSet(WriteState.Queued, WriteState.Cancelled)) {
            pendingResistance.compareAndSet(pending, null)
            return unavailable("resistance command timed out before transmit")
        }
        if (awaitDone(pending, resistanceTransmitWaitMs)) {
            return pending.result.get() ?: uncertain()
        }
        pending.abandoned.set(true)
        if (pending.done.count == 0L) {
            return pending.result.get() ?: uncertain()
        }
        Log.w(HostConstants.LOG_TAG, "resistance command level=$level outcome uncertain at caller timeout")
        return uncertain()
    }

    fun start() {
        if (!running.compareAndSet(false, true)) return
        terminalFailure.set(false)
        lifecycle.set(SessionLifecycle.Running)
        phase.set(UsbPhase.Starting)
        note("starting")
        val thread = Thread({
            try {
                runLoop()
            } catch (ex: Exception) {
                terminal("failed: ${ex.message}")
                Log.e(HostConstants.LOG_TAG, "native session failed", ex)
                publishOffline()
            } finally {
                running.set(false)
                failPendingResistance("usb session stopped")
                if (!terminalFailure.get()) {
                    note("stopped")
                    phase.set(UsbPhase.Disconnected)
                }
                lifecycle.set(SessionLifecycle.Stopped)
            }
        }, "fitbaus-native-usb")
        synchronized(workerLock) { worker = thread }
        thread.start()
    }

    /**
     * Requests the worker to exit and waits up to [stopJoinMs].
     * A completed join is not treated as USB release unless the worker is dead.
     */
    fun stop(): SessionStopResult {
        running.set(false)
        val thread = synchronized(workerLock) { worker } ?: return SessionStopResult.Released
        if (!thread.isAlive) return SessionStopResult.Released
        lifecycle.set(SessionLifecycle.Stopping)
        thread.interrupt()
        thread.join(stopJoinMs)
        if (thread.isAlive) {
            lifecycle.set(SessionLifecycle.StopTimedOut)
            Log.e(
                HostConstants.LOG_TAG,
                "USB worker still alive after ${stopJoinMs}ms stop join; do not assume USB released",
            )
            return SessionStopResult.TimedOut
        }
        return SessionStopResult.Released
    }

    private enum class SessionOutcome {
        Stopped,
        Reconnect,
    }

    private enum class SessionLifecycle {
        Idle,
        Running,
        Stopping,
        Stopped,
        StopTimedOut,
    }

    private enum class WriteState {
        Queued,
        Transmitting,
        Cancelled,
        Completed,
    }

    private fun note(reason: String) {
        val previous = diagnostic.getAndSet(reason)
        if (previous == reason) return
        if (
            reason.startsWith("n1:") ||
            reason.startsWith("polling ") ||
            reason.startsWith("usb ") ||
            reason.startsWith("cold-start:") ||
            reason.startsWith("bootstrap ")
        ) {
            Log.i(HostConstants.LOG_TAG, reason)
        }
    }

    private fun terminal(reason: String, terminalPhase: UsbPhase = UsbPhase.InitializationFailed) {
        terminalFailure.set(true)
        diagnostic.set(reason)
        phase.set(terminalPhase)
        Log.e(HostConstants.LOG_TAG, reason)
    }

    private fun reconnectBudgetExhausted(attempts: Int): Boolean =
        maxReconnectAttempts >= 0 && attempts > maxReconnectAttempts

    private fun publishOffline() {
        snapshot.set(ContinuousReadPlan.afterUnsuccessfulRead(snapshot.get(), connected = false))
    }

    private fun publishDisconnected(reason: String, newPhase: UsbPhase) {
        note(reason)
        phase.set(newPhase)
        publishOffline()
    }

    private fun clearRequested() {
        val current = snapshot.get()
        snapshot.set(current.copy(requestedResistance = null, requestedAt = null))
    }

    private fun runLoop() {
        var attempts = 0
        while (running.get()) {
            if (reconnectBudgetExhausted(attempts)) {
                terminal("usb reconnect exhausted", UsbPhase.Disconnected)
                publishOffline()
                return
            }
            note("qualifying USB")
            val devices = gateway.listDevices()
            val qualified = when (val q = UsbQualification.qualify(devices)) {
                is UsbQualificationResult.Rejected -> {
                    publishDisconnected("usb rejected: ${q.reason}", UsbPhase.DeviceNotFound)
                    attempts += 1
                    if (running.get()) sleeper(reconnectDelayMs)
                    continue
                }
                is UsbQualificationResult.Qualified -> q
            }
            val deviceName = qualified.device.deviceName
            if (!gateway.hasPermission(deviceName)) {
                val prompted = permissionPromptAllowed.getAndSet(false)
                val granted = prompted && requestPermission(deviceName)
                if (!granted && !gateway.hasPermission(deviceName)) {
                    publishDisconnected("usb permission required", UsbPhase.PermissionRequired)
                    if (running.get()) sleeper(permissionPollMs)
                    continue
                }
            }
            when (val opened = gateway.openQualified(qualified)) {
                is OpenResult.Failed -> {
                    if (!opened.retryable) {
                        terminal("usb open failed: ${opened.reason}")
                        publishOffline()
                        return
                    }
                    publishDisconnected("usb open failed: ${opened.reason}", UsbPhase.Disconnected)
                    attempts += 1
                    if (running.get()) sleeper(reconnectDelayMs)
                }
                is OpenResult.Opened -> {
                    lastExchangeAtMs = 0L
                    attempts = 0
                    phase.set(UsbPhase.UsbConnected)
                    try {
                        when (session(opened.transport)) {
                            SessionOutcome.Stopped -> {
                                failPendingResistance("usb session stopped")
                                publishOffline()
                                clearRequested()
                                return
                            }
                            SessionOutcome.Reconnect -> {
                                failPendingResistance("bike disconnected")
                                attempts += 1
                                phase.set(UsbPhase.Disconnected)
                                publishOffline()
                                clearRequested()
                                if (running.get()) sleeper(reconnectDelayMs)
                            }
                        }
                    } finally {
                        opened.transport.close()
                    }
                }
            }
        }
    }

    private fun session(transport: ProbeTransport): SessionOutcome {
        note("bootstrap ${coldStartWritePlan.bootstrapLabel}")
        phase.set(UsbPhase.Initializing)
        val allowlist = transport.transmitAllowlist() ?: run {
            terminal("transport missing TX allowlist")
            return SessionOutcome.Stopped
        }
        val bootstrapRaw = exchange(transport, EquipmentRequests.deviceInfo(EquipmentDevice.MAIN))
            ?: run {
                if (!running.get()) return SessionOutcome.Stopped
                if (!transport.isAttached()) {
                    note("bootstrap DeviceInfo(MAIN) failed")
                    return SessionOutcome.Reconnect
                }
                terminal("bootstrap DeviceInfo(MAIN) failed")
                return SessionOutcome.Stopped
            }
        val adopted = when (val result = PrimaryDeviceBootstrap.evaluate(EquipmentDevice.MAIN, bootstrapRaw)) {
            is PrimaryDeviceBootstrapResult.Rejected -> {
                terminal("bootstrap rejected: ${result.reason} ${result.detail}")
                return SessionOutcome.Stopped
            }
            is PrimaryDeviceBootstrapResult.Adopted -> result
        }
        allowlist.beginAwaitingConfirmation(adopted.primaryDevice.id)
        val confirmRaw = exchange(transport, EquipmentRequests.deviceInfo(adopted.primaryDevice))
            ?: run {
                allowlist.resetToMainOnly()
                if (!running.get()) return SessionOutcome.Stopped
                if (!transport.isAttached()) {
                    note("confirm DeviceInfo failed")
                    return SessionOutcome.Reconnect
                }
                terminal("confirm DeviceInfo failed")
                return SessionOutcome.Stopped
            }
        when (val confirmed = PrimaryDeviceBootstrap.confirm(adopted.primaryDevice, adopted.deviceInfo, confirmRaw)) {
            is PrimaryDeviceBootstrapResult.Rejected -> {
                allowlist.resetToMainOnly()
                terminal("confirm rejected: ${confirmed.reason}")
                return SessionOutcome.Stopped
            }
            is PrimaryDeviceBootstrapResult.Adopted -> {
                allowlist.confirmSessionPrimary(adopted.primaryDevice.id)
            }
        }
        val primary = adopted.primaryDevice
        var maxLevel: Int? = null
        writeSecurityBlocked.set(false)
        controllerUnlocked.set(false)
        verifySecurityAttempted.set(false)
        val unlockRequired = adopted.deviceInfo.requiresUnlock
        if (coldStartWritePlan.allowsVerifySecurity && unlockRequired) {
            when (runColdStartAuthorization(transport, allowlist, primary, adopted.deviceInfo)) {
                N1Resume.Stop -> return SessionOutcome.Stopped
                N1Resume.Continue -> Unit
            }
        }
        when (val firstMax = readMaxResistance(transport, primary)) {
            MaxRead.Security -> {
                when (handleSecurityBlock(transport, allowlist, primary, adopted.deviceInfo)) {
                    N1Resume.Stop -> return SessionOutcome.Stopped
                    N1Resume.Continue -> when (val secondMax = readMaxResistance(transport, primary)) {
                        MaxRead.Security -> {
                            terminal("n1: post-unlock telemetry failed (SecurityBlock)")
                            snapshot.set(BridgeHttpJson.emptySnapshot(nowIso()))
                            return SessionOutcome.Stopped
                        }
                        is MaxRead.Value -> maxLevel = secondMax.level
                    }
                }
            }
            is MaxRead.Value -> maxLevel = firstMax.level
        }
        var machine = BridgeMachineJson(
            type = "Bike",
            canSetResistance = writeReady(unlockRequired, maxLevel),
            maxResistanceLevel = (maxLevel ?: 0).toDouble(),
        )
        note("polling ${coldStartWritePlan.bootstrapLabel} primary=${primary.id} maxR=$maxLevel")
        phase.set(UsbPhase.Initialized)
        var cycle = 0
        var consecutiveFailures = 0
        while (running.get() && transport.isAttached()) {
            drainResistanceWrite(transport, allowlist, primary, maxLevel) {
                machine = it
            }
            val fields = ContinuousReadPlan.fieldsForCycle(cycle)
            val poll = readCycle(transport, primary, fields) ?: run {
                if (!running.get()) return SessionOutcome.Stopped
                publishOffline()
                if (!transport.isAttached()) {
                    note("usb detached")
                    return SessionOutcome.Reconnect
                }
                consecutiveFailures += 1
                if (consecutiveFailures >= maxConsecutiveExchangeFailures) {
                    note("usb exchange failed $consecutiveFailures times; reopening")
                    return SessionOutcome.Reconnect
                }
                note("exchange failed")
                cycle += 1
                continue
            }
            consecutiveFailures = 0
            if (poll.securityBlocked) {
                when (handleSecurityBlock(transport, allowlist, primary, adopted.deviceInfo)) {
                    N1Resume.Stop -> return SessionOutcome.Stopped
                    N1Resume.Continue -> {
                        cycle += 1
                        continue
                    }
                }
            }
            val identity = machine.copy(
                canSetResistance = machine.canSetResistance && !writeSecurityBlocked.get(),
            )
            snapshot.set(
                ContinuousReadPlan.applyReadings(
                    previous = snapshot.get(),
                    readings = poll.readings,
                    nowIso = nowIso(),
                    maxResistanceLevel = maxLevel,
                    identity = identity,
                    requested = fields,
                ),
            )
            phase.set(UsbPhase.Streaming)
            cycle += 1
        }
        if (!running.get()) return SessionOutcome.Stopped
        return SessionOutcome.Reconnect
    }

    private enum class N1Resume {
        Stop,
        Continue,
    }

    private sealed class MaxRead {
        data class Value(val level: Int?) : MaxRead()
        object Security : MaxRead()
    }

    /**
     * Readable max resistance is not write authorization. AuthOnly/production
     * advertise writes only after this USB session's controller Unlocked.
     * WarmState still uses maxLevel, then fail-closed on SECURITY_BLOCK.
     */
    private fun writeReady(unlockRequired: Boolean, maxLevel: Int?): Boolean {
        if (maxLevel == null || maxLevel <= 0) return false
        if (writeSecurityBlocked.get()) return false
        if (coldStartWritePlan.allowsVerifySecurity && unlockRequired) return controllerUnlocked.get()
        return true
    }

    private fun readMaxResistance(transport: ProbeTransport, primary: EquipmentDevice): MaxRead {
        val request = EquipmentRequests.read(primary, listOf(BikeField.MAX_RESISTANCE_LEVEL))
        val raw = exchange(transport, request) ?: return MaxRead.Value(null)
        return when (val decoded = request.decode(raw)) {
            ReadWriteDataResult.SecurityBlocked -> MaxRead.Security
            is ReadWriteDataResult.Values ->
                MaxRead.Value(
                    (decoded.readings[BikeField.MAX_RESISTANCE_LEVEL] as? FieldValue.Number)?.value?.toInt(),
                )
            else -> MaxRead.Value(null)
        }
    }

    private fun authorizationSequence(
        exchange: EquipmentExchange,
        primary: EquipmentDevice,
    ): EquipmentAuthorizationSequence =
        EquipmentAuthorizationSequence(
            exchange = exchange,
            identityDevice = EquipmentDevice.MAIN,
            verifyDevice = primary,
        )

    private fun runColdStartAuthorization(
        transport: ProbeTransport,
        allowlist: TransmitAllowlist,
        primary: EquipmentDevice,
        deviceInfo: DeviceInfo,
    ): N1Resume {
        if (verifySecurityAttempted.get()) {
            terminal("cold-start: authentication already attempted this process")
            return N1Resume.Stop
        }
        val equipmentExchange = EquipmentExchange { request -> exchange(transport, request) }
        val sequence = authorizationSequence(equipmentExchange, primary)
        val identity = when (val collected = sequence.collectIdentity(deviceInfo)) {
            is IdentityCollectionResult.NotRequired -> {
                terminal("cold-start: unlock not required")
                return N1Resume.Stop
            }
            is IdentityCollectionResult.Aborted -> {
                terminal("cold-start: identity incomplete (${collected.step} ${collected.reason})")
                return N1Resume.Stop
            }
            is IdentityCollectionResult.Complete -> collected.identity
        }
        if (!verifySecurityAttempted.compareAndSet(false, true)) {
            terminal("cold-start: authentication already attempted this process")
            return N1Resume.Stop
        }
        allowlist.permitVerifySecurity()
        val outcome = try {
            sequence.verifyCollected(identity)
        } finally {
            allowlist.revokeVerifySecurity()
        }
        when (outcome) {
            is AuthorizationOutcome.Unlocked -> {
                // Controller Done on cmd=144. A usb tx attempt is not this outcome.
                controllerUnlocked.set(true)
                note("cold-start: VerifySecurity controller Unlocked")
            }
            is AuthorizationOutcome.NotRequired -> {
                terminal("cold-start: unlock not required")
                return N1Resume.Stop
            }
            is AuthorizationOutcome.Aborted -> {
                terminal("cold-start: identity incomplete (${outcome.step} ${outcome.reason})")
                return N1Resume.Stop
            }
            is AuthorizationOutcome.Refused -> {
                val vs = outcome.outcome
                when (vs) {
                    is VerifySecurityOutcome.NoResponse ->
                        terminal("cold-start: VerifySecurity no response")
                    is VerifySecurityOutcome.NotSupported ->
                        terminal("cold-start: authentication unsupported")
                    else ->
                        terminal("cold-start: VerifySecurity rejected ($vs)")
                }
                return N1Resume.Stop
            }
        }
        if (!coldStartWritePlan.writesIdleModeLockout) return N1Resume.Continue
        val lockout = EquipmentRequests.writeIdleModeLockout(primary)
        allowlist.permitIdleModeLockout()
        val raw = try {
            exchange(transport, lockout)
        } finally {
            allowlist.revokeIdleModeLockout()
        } ?: run {
            terminal("cold-start: IdleModeLockout rejected")
            return N1Resume.Stop
        }
        return when (val decoded = lockout.decode(raw)) {
            IdleModeLockoutWriteResult.Accepted -> {
                note("cold-start: IdleModeLockout written")
                N1Resume.Continue
            }
            else -> {
                terminal("cold-start: IdleModeLockout rejected ($decoded)")
                N1Resume.Stop
            }
        }
    }

    private fun handleSecurityBlock(
        transport: ProbeTransport,
        allowlist: TransmitAllowlist,
        primary: EquipmentDevice,
        deviceInfo: DeviceInfo,
    ): N1Resume {
        note("n1: SecurityBlock encountered")
        snapshot.set(BridgeHttpJson.emptySnapshot(nowIso()))
        if (!deviceInfo.requiresUnlock) {
            terminal("n1: unlock not required")
            return N1Resume.Stop
        }
        if (verifySecurityAttempted.get()) {
            terminal("n1: authentication already attempted this process")
            return N1Resume.Stop
        }

        val equipmentExchange = EquipmentExchange { request -> exchange(transport, request) }
        val sequence = authorizationSequence(equipmentExchange, primary)
        val identity = when (val collected = sequence.collectIdentity(deviceInfo)) {
            is IdentityCollectionResult.NotRequired -> {
                terminal("n1: unlock not required")
                return N1Resume.Stop
            }
            is IdentityCollectionResult.Aborted -> {
                terminal("n1: identity incomplete (${collected.step} ${collected.reason})")
                return N1Resume.Stop
            }
            is IdentityCollectionResult.Complete -> collected.identity
        }

        if (securityHashCompatibility != SecurityHashCompatibility.IndependentlyEstablished) {
            terminal("n1: security hash unverified")
            return N1Resume.Stop
        }
        if (!verifySecurityAttempted.compareAndSet(false, true)) {
            terminal("n1: authentication already attempted this process")
            return N1Resume.Stop
        }

        allowlist.permitVerifySecurity()
        val outcome = try {
            sequence.verifyCollected(identity)
        } finally {
            allowlist.revokeVerifySecurity()
        }
        return when (outcome) {
            is AuthorizationOutcome.Unlocked -> {
                controllerUnlocked.set(true)
                note("n1: authentication succeeded")
                val probe = readCycle(transport, primary, listOf(BikeField.WATTS, BikeField.RPM))
                if (
                    probe == null ||
                    probe.securityBlocked ||
                    !ContinuousReadPlan.hasFreshWattsAndRpm(probe.readings)
                ) {
                    terminal("n1: post-unlock telemetry failed")
                    snapshot.set(BridgeHttpJson.emptySnapshot(nowIso()))
                    return N1Resume.Stop
                }
                snapshot.set(
                    ContinuousReadPlan.applyReadings(
                        previous = snapshot.get(),
                        readings = probe.readings,
                        nowIso = nowIso(),
                        maxResistanceLevel = 0,
                        identity = BridgeMachineJson(type = "Bike", canSetResistance = false, maxResistanceLevel = 0.0),
                        requested = listOf(BikeField.WATTS, BikeField.RPM),
                    ),
                )
                N1Resume.Continue
            }
            is AuthorizationOutcome.NotRequired -> {
                terminal("n1: unlock not required")
                N1Resume.Stop
            }
            is AuthorizationOutcome.Aborted -> {
                terminal("n1: identity incomplete (${outcome.step} ${outcome.reason})")
                N1Resume.Stop
            }
            is AuthorizationOutcome.Refused -> {
                val vs = outcome.outcome
                if (vs is VerifySecurityOutcome.NotSupported) {
                    terminal("n1: authentication unsupported")
                } else {
                    terminal("n1: VerifySecurity rejected ($vs)")
                }
                N1Resume.Stop
            }
        }
    }

    private class CycleRead(
        val readings: Map<BikeField, FieldValue>,
        val securityBlocked: Boolean,
    )

    private sealed class FieldRead {
        class Values(val readings: Map<BikeField, FieldValue>) : FieldRead()
        object Security : FieldRead()
        object Failed : FieldRead()
    }

    private fun readCycle(
        transport: ProbeTransport,
        primary: EquipmentDevice,
        fields: List<BikeField>,
    ): CycleRead? {
        val resolved = fields.filter { it.isResolved }
        val unresolved = fields.filter { !it.isResolved }
        val merged = LinkedHashMap<BikeField, FieldValue>()
        if (resolved.isNotEmpty()) {
            when (val part = readFields(transport, primary, resolved)) {
                FieldRead.Failed -> return null
                FieldRead.Security -> return CycleRead(emptyMap(), securityBlocked = true)
                is FieldRead.Values -> merged.putAll(part.readings)
            }
        }
        for (field in unresolved) {
            when (val part = readFields(transport, primary, listOf(field))) {
                FieldRead.Failed ->
                    return if (merged.isEmpty()) null else CycleRead(merged, securityBlocked = false)
                FieldRead.Security -> return CycleRead(emptyMap(), securityBlocked = true)
                is FieldRead.Values -> merged.putAll(part.readings)
            }
        }
        return CycleRead(merged, securityBlocked = false)
    }

    private fun readFields(
        transport: ProbeTransport,
        primary: EquipmentDevice,
        fields: List<BikeField>,
    ): FieldRead {
        val request = EquipmentRequests.read(primary, fields)
        val raw = exchange(transport, request) ?: return FieldRead.Failed
        return when (val decoded = request.decode(raw)) {
            ReadWriteDataResult.SecurityBlocked -> FieldRead.Security
            is ReadWriteDataResult.Values -> FieldRead.Values(decoded.readings)
            else -> FieldRead.Failed
        }
    }

    private fun drainResistanceWrite(
        transport: ProbeTransport,
        allowlist: TransmitAllowlist,
        primary: EquipmentDevice,
        maxLevel: Int?,
        onMachine: (BridgeMachineJson) -> Unit,
    ) {
        val pending = pendingResistance.get() ?: return
        if (!pending.state.compareAndSet(WriteState.Queued, WriteState.Transmitting)) {
            pendingResistance.compareAndSet(pending, null)
            return
        }
        try {
            transmitResistance(pending, transport, allowlist, primary, maxLevel, onMachine)
        } catch (ex: Exception) {
            completePending(pending, uncertain(), "uncertain: ${ex.javaClass.simpleName} during transmit")
            throw ex
        } finally {
            if (pending.state.get() != WriteState.Completed) {
                completePending(pending, uncertain(), "uncertain: transmit did not complete")
            }
        }
    }

    private fun transmitResistance(
        pending: PendingResistanceWrite,
        transport: ProbeTransport,
        allowlist: TransmitAllowlist,
        primary: EquipmentDevice,
        maxLevel: Int?,
        onMachine: (BridgeMachineJson) -> Unit,
    ) {
        if (maxLevel == null || maxLevel <= 0) {
            completePending(pending, unavailable("max resistance unknown"), "not transmitted: max resistance unknown")
            return
        }
        val request = try {
            EquipmentRequests.writeResistance(primary, pending.level, maxLevel)
        } catch (ex: IllegalArgumentException) {
            completePending(
                pending,
                BridgeHttpResult(400, "Bad Request", BridgeHttpJson.error(ex.message ?: "invalid resistance")),
                "not transmitted: invalid resistance",
            )
            return
        }
        allowlist.permitResistanceWrite()
        val outcome = try {
            exchangeOutcome(transport, request)
        } finally {
            allowlist.revokeResistanceWrite()
        }
        val raw = when (outcome) {
            ExchangeOutcome.NotSent -> {
                completePending(
                    pending,
                    unavailable("resistance write not transmitted"),
                    "not transmitted: session stopping",
                )
                return
            }
            is ExchangeOutcome.Failed -> {
                if (outcome.classification.definitelyNotTransmitted()) {
                    completePending(
                        pending,
                        unavailable("resistance write not transmitted (${outcome.classification.reportToken})"),
                        "not transmitted: ${outcome.classification.reportToken}",
                    )
                } else {
                    completePending(
                        pending,
                        uncertain(),
                        "uncertain: ${outcome.classification.reportToken}",
                    )
                }
                return
            }
            is ExchangeOutcome.Response -> outcome.bytes
        }
        if (raw == null) {
            completePending(pending, uncertain(), "uncertain: empty response")
            return
        }
        when (val decoded = request.decode(raw)) {
            is ResistanceWriteResult.Accepted -> {
                val now = nowIso()
                val current = snapshot.get()
                writeSecurityBlocked.set(false)
                val acceptedMachine = current.machine.copy(canSetResistance = true)
                onMachine(acceptedMachine)
                snapshot.set(
                    current.copy(
                        machine = acceptedMachine,
                        requestedResistance = decoded.level,
                        requestedAt = now,
                    ),
                )
                completePending(
                    pending,
                    BridgeHttpResult(200, "OK", BridgeHttpJson.accepted(decoded.level)),
                    "accepted level=${decoded.level}",
                )
            }
            ResistanceWriteResult.SecurityBlocked -> {
                // Intentional: do not invoke handleSecurityBlock here. Production hash
                // compatibility is Unresolved, so N1 auth would terminal the session and kill
                // readable telemetry. Gate 1 also proved writes can succeed without VerifySecurity
                // on this bike; a write SECURITY_BLOCK is treated as session write-auth failure.
                writeSecurityBlocked.set(true)
                val current = snapshot.get()
                val blockedMachine = current.machine.copy(canSetResistance = false)
                onMachine(blockedMachine)
                snapshot.set(
                    current.copy(
                        machine = blockedMachine,
                        requestedResistance = null,
                        requestedAt = null,
                    ),
                )
                note("write security block; control unavailable")
                completePending(
                    pending,
                    rejectedAfterTransmit(
                        "security block after transmit; write authorization blocked",
                    ),
                    "rejected after transmit: security block",
                )
            }
            is ResistanceWriteResult.StatusRejected ->
                completePending(
                    pending,
                    rejectedAfterTransmit(
                        "resistance write rejected after transmit (${decoded.status}/${decoded.statusCode})",
                    ),
                    "rejected after transmit: ${decoded.status}",
                )
            is ResistanceWriteResult.Malformed ->
                completePending(pending, uncertain(), "uncertain: malformed response")
        }
    }

    private fun completePending(pending: PendingResistanceWrite, result: BridgeHttpResult, summary: String) {
        if (pending.state.get() == WriteState.Completed) return
        pending.result.set(result)
        pending.state.set(WriteState.Completed)
        pendingResistance.compareAndSet(pending, null)
        val outcome = "level=${pending.level} $summary"
        lastResistanceOutcome.set(outcome)
        val current = snapshot.get()
        snapshot.set(current.copy(lastResistanceOutcome = outcome))
        if (pending.abandoned.get()) {
            Log.w(HostConstants.LOG_TAG, "late resistance outcome after caller timeout: level=${pending.level} $summary")
        }
        pending.done.countDown()
    }

    private fun failPendingResistance(message: String) {
        val pending = pendingResistance.get() ?: return
        if (pending.state.compareAndSet(WriteState.Queued, WriteState.Cancelled)) {
            pendingResistance.compareAndSet(pending, null)
            pending.result.set(unavailable("$message; resistance write not transmitted"))
            pending.done.countDown()
            return
        }
        if (pending.state.get() == WriteState.Transmitting) {
            completePending(pending, uncertain(), "uncertain: $message during transmit")
        }
    }

    private fun awaitDone(pending: PendingResistanceWrite, timeoutMs: Long): Boolean =
        try {
            pending.done.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }

    private fun unavailable(message: String): BridgeHttpResult =
        BridgeHttpResult(503, "Service Unavailable", BridgeHttpJson.error(message))

    private fun rejectedAfterTransmit(message: String): BridgeHttpResult =
        BridgeHttpResult(502, "Bad Gateway", BridgeHttpJson.error(message))

    private fun uncertain(): BridgeHttpResult =
        BridgeHttpResult(504, "Gateway Timeout", BridgeHttpJson.error("resistance command outcome uncertain"))

    private class PendingResistanceWrite(
        val level: Int,
        val state: AtomicReference<WriteState> = AtomicReference(WriteState.Queued),
        val result: AtomicReference<BridgeHttpResult?> = AtomicReference(),
        val done: CountDownLatch = CountDownLatch(1),
        val abandoned: AtomicBoolean = AtomicBoolean(false),
    )

    private sealed class ExchangeOutcome {
        object NotSent : ExchangeOutcome()
        class Failed(val classification: TransportFailureClass) : ExchangeOutcome()
        class Response(val bytes: ByteArray?) : ExchangeOutcome()
    }

    private fun exchange(transport: ProbeTransport, request: EquipmentRequest): ByteArray? =
        when (val outcome = exchangeOutcome(transport, request)) {
            is ExchangeOutcome.Response -> outcome.bytes
            else -> null
        }

    private fun exchangeOutcome(transport: ProbeTransport, request: EquipmentRequest): ExchangeOutcome {
        val spacing = minRequestSpacingMs
        if (spacing > 0L && lastExchangeAtMs != 0L) {
            val wait = spacing - (System.currentTimeMillis() - lastExchangeAtMs)
            if (wait > 0L) sleeper(wait)
        }
        if (!running.get()) return ExchangeOutcome.NotSent
        val result = transport.exchange(request.encode())
        lastExchangeAtMs = System.currentTimeMillis()
        return when (result) {
            is TransportResult.Ok -> ExchangeOutcome.Response(result.response)
            is TransportResult.Failed -> ExchangeOutcome.Failed(result.classification)
        }
    }

    companion object {
        private fun isoNow(): String {
            val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            format.timeZone = TimeZone.getTimeZone("UTC")
            return format.format(Date())
        }
    }
}

internal fun TransportFailureClass.definitelyNotTransmitted(): Boolean =
    this == TransportFailureClass.POLICY_REJECTED || this == TransportFailureClass.DETACHED_BEFORE_OUT
