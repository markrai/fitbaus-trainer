// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

/**
 * Trainer-facing HTTP JSON for the native bridge.
 *
 * Shapes match Legacy `TelemetryHttpContract` / `bikeBridgeClient.ts`.
 */
public data class BridgeMetricJson(
    public val value: Int?,
    public val observedAt: String?,
    public val current: Boolean,
)

public data class BridgeMachineJson(
    public val type: String = "Bike",
    public val modelNumber: String? = null,
    public val partNumber: String? = null,
    public val serialNumber: String? = null,
    public val canSetResistance: Boolean = false,
    public val maxResistanceLevel: Double = 0.0,
)

public data class NativeTelemetrySnapshot(
    public val connected: Boolean,
    public val initialized: Boolean,
    public val snapshotAt: String,
    public val resistance: BridgeMetricJson,
    public val rpm: BridgeMetricJson,
    public val watts: BridgeMetricJson,
    public val machine: BridgeMachineJson = BridgeMachineJson(),
    public val actualResistance: BridgeMetricJson = BridgeMetricJson(null, null, false),
    public val requestedResistance: Int? = null,
    public val requestedAt: String? = null,
    /** Sanitized write outcome for diagnostics; never carries credentials or identity secrets. */
    public val lastResistanceOutcome: String? = null,
)

public data class BridgeHttpResult(
    public val statusCode: Int,
    public val reason: String,
    public val body: String,
    public val contentType: String = "application/json; charset=utf-8",
    public val headers: Map<String, String> = emptyMap(),
)

public object BridgeHttpJson {
    public const val VERSION: String = "0.2.0"
    public const val DEFAULT_BIND: String = "0.0.0.0"
    public const val DEFAULT_PORT: Int = 8765
    public const val MAX_REQUEST_BODY_BYTES: Int = 4096
    public const val MAX_HEADER_BYTES: Int = 8192
    public const val MAX_CONCURRENT_CONNECTIONS: Int = 4
    public const val ACCEPT_BACKLOG: Int = 8
    public const val SOCKET_TIMEOUT_MS: Int = 4000

    public fun health(snapshot: NativeTelemetrySnapshot): String =
        """{"status":"ok","bridgeVersion":"$VERSION","connected":${snapshot.connected},"initialized":${snapshot.initialized}}"""

    public fun telemetry(snapshot: NativeTelemetrySnapshot): String {
        val sb = StringBuilder()
        sb.append('{')
        writeBool(sb, "connected", snapshot.connected)
        sb.append(',')
        writeBool(sb, "initialized", snapshot.initialized)
        sb.append(',')
        writeString(sb, "snapshotAt", snapshot.snapshotAt)
        sb.append(',')
        writeMetric(sb, "resistance", snapshot.resistance)
        sb.append(',')
        writeMetric(sb, "rpm", snapshot.rpm)
        sb.append(',')
        writeMetric(sb, "watts", snapshot.watts)
        sb.append(',')
        writeMachine(sb, snapshot.machine)
        sb.append('}')
        return sb.toString()
    }

    public fun status(snapshot: NativeTelemetrySnapshot): String {
        val sb = StringBuilder()
        sb.append('{')
        writeString(sb, "status", "ok")
        sb.append(',')
        writeString(sb, "bridgeVersion", VERSION)
        sb.append(',')
        writeBool(sb, "connected", snapshot.connected)
        sb.append(',')
        writeBool(sb, "initialized", snapshot.initialized)
        sb.append(',')
        writeBool(
            sb,
            "resistanceControlAvailable",
            snapshot.connected && snapshot.initialized && snapshot.machine.canSetResistance,
        )
        sb.append(',')
        sb.append("\"resistance\":{")
        writeNullableInt(sb, "requested", snapshot.requestedResistance)
        sb.append(',')
        writeNullableString(sb, "requestedAt", snapshot.requestedAt)
        sb.append(',')
        writeNullableInt(sb, "observed", snapshot.resistance.value)
        sb.append(',')
        writeNullableString(sb, "observedAt", snapshot.resistance.observedAt)
        sb.append('}')
        sb.append(',')
        writeNullableString(sb, "lastResistanceOutcome", snapshot.lastResistanceOutcome)
        sb.append('}')
        return sb.toString()
    }

    public fun error(message: String): String {
        val sb = StringBuilder()
        sb.append('{')
        writeString(sb, "error", message)
        sb.append('}')
        return sb.toString()
    }

    public fun accepted(requested: Int): String = "{\"requested\":$requested}"

    public fun emptySnapshot(nowIso: String): NativeTelemetrySnapshot =
        NativeTelemetrySnapshot(
            connected = false,
            initialized = false,
            snapshotAt = nowIso,
            resistance = BridgeMetricJson(null, null, false),
            rpm = BridgeMetricJson(null, null, false),
            watts = BridgeMetricJson(null, null, false),
        )

    private fun writeBool(sb: StringBuilder, name: String, value: Boolean) {
        sb.append('"').append(name).append("\":").append(value)
    }

    private fun writeString(sb: StringBuilder, name: String, value: String) {
        sb.append('"').append(name).append("\":\"")
        escape(sb, value)
        sb.append('"')
    }

    private fun writeNullableString(sb: StringBuilder, name: String, value: String?) {
        sb.append('"').append(name).append("\":")
        if (value == null) {
            sb.append("null")
        } else {
            sb.append('"')
            escape(sb, value)
            sb.append('"')
        }
    }

    private fun writeNullableInt(sb: StringBuilder, name: String, value: Int?) {
        sb.append('"').append(name).append("\":")
        if (value == null) sb.append("null") else sb.append(value)
    }

    private fun writeMetric(sb: StringBuilder, name: String, metric: BridgeMetricJson) {
        sb.append('"').append(name).append("\":{")
        writeNullableInt(sb, "value", metric.value)
        sb.append(',')
        writeNullableString(sb, "observedAt", metric.observedAt)
        sb.append(',')
        writeBool(sb, "current", metric.current)
        sb.append('}')
    }

    private fun writeMachine(sb: StringBuilder, machine: BridgeMachineJson) {
        sb.append("\"machine\":{")
        writeString(sb, "type", machine.type)
        sb.append(',')
        writeNullableString(sb, "modelNumber", machine.modelNumber)
        sb.append(',')
        writeNullableString(sb, "partNumber", machine.partNumber)
        sb.append(',')
        writeNullableString(sb, "serialNumber", machine.serialNumber)
        sb.append(',')
        writeBool(sb, "canSetResistance", machine.canSetResistance)
        sb.append(',')
        sb.append("\"maxResistanceLevel\":").append(machine.maxResistanceLevel)
        sb.append('}')
    }

    private fun escape(sb: StringBuilder, value: String) {
        for (ch in value) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                else -> sb.append(ch)
            }
        }
    }
}

public object BridgeHttpRouter {
    public const val PAIRING_HEADER: String = "X-Fitbaus-Token"

    public val PREFLIGHT_HEADERS: Map<String, String> = linkedMapOf(
        "Access-Control-Allow-Methods" to "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers" to "Content-Type, $PAIRING_HEADER",
        "Access-Control-Max-Age" to "600",
    )

    public fun handle(
        method: String,
        path: String,
        body: String,
        snapshot: NativeTelemetrySnapshot,
        onHeartRate: ((Int) -> Unit)? = null,
        onBrightness: ((Int) -> Unit)? = null,
        onResistance: ((Int) -> BridgeHttpResult)? = null,
        pairingToken: String? = null,
        presentedToken: String? = null,
    ): BridgeHttpResult {
        val verb = method.uppercase()
        val route = normalize(path)
        val controlRoute = route == "/api/v1/resistance" || route == "/api/v1/heartrate" || route == "/api/v1/brightness"
        if (verb == "OPTIONS") {
            return BridgeHttpResult(204, "No Content", "", "text/plain; charset=utf-8", PREFLIGHT_HEADERS)
        }
        if (verb == "POST" && controlRoute && !PairingToken.matches(pairingToken, presentedToken)) {
            return BridgeHttpResult(401, "Unauthorized", BridgeHttpJson.error("pairing required"))
        }
        return when {
            verb == "GET" && (route == "/health" || route == "/api/v1/health") ->
                BridgeHttpResult(200, "OK", BridgeHttpJson.health(snapshot))
            verb == "GET" && route == "/api/v1/telemetry" ->
                BridgeHttpResult(200, "OK", BridgeHttpJson.telemetry(snapshot))
            verb == "GET" && route == "/api/v1/status" ->
                BridgeHttpResult(200, "OK", BridgeHttpJson.status(snapshot))
            route == "/resistance" ->
                BridgeHttpResult(404, "Not Found", BridgeHttpJson.error("use POST /api/v1/resistance"))
            verb == "POST" && route == "/api/v1/resistance" ->
                handleResistance(body, onResistance)
            verb == "POST" && route == "/api/v1/heartrate" ->
                ingestInteger(body, 30, 250, onHeartRate, "heart-rate")
            verb == "POST" && route == "/api/v1/brightness" ->
                ingestInteger(body, 0, 100, onBrightness, "brightness")
            verb != "GET" ->
                BridgeHttpResult(405, "Method Not Allowed", BridgeHttpJson.error("method not allowed"))
            else ->
                BridgeHttpResult(404, "Not Found", BridgeHttpJson.error("not found"))
        }
    }

    private fun normalize(path: String): String {
        val route = path.trim().substringBefore('?')
        return if (route.length > 1 && route.endsWith("/")) route.dropLast(1) else route
    }

    private fun handleResistance(
        body: String,
        onResistance: ((Int) -> BridgeHttpResult)?,
    ): BridgeHttpResult {
        if (onResistance == null) {
            return BridgeHttpResult(
                503,
                "Service Unavailable",
                BridgeHttpJson.error("resistance control unavailable"),
            )
        }
        val value = parseRequestedInt(body)
            ?: return BridgeHttpResult(400, "Bad Request", BridgeHttpJson.error("malformed resistance"))
        ResistanceLimits.validate(value)?.let { error ->
            return BridgeHttpResult(400, "Bad Request", BridgeHttpJson.error(error))
        }
        return onResistance.invoke(value)
    }

    private fun ingestInteger(
        body: String,
        min: Int,
        max: Int,
        sink: ((Int) -> Unit)?,
        label: String,
    ): BridgeHttpResult {
        val value = parseRequestedInt(body)
            ?: return BridgeHttpResult(400, "Bad Request", BridgeHttpJson.error("malformed $label"))
        if (value < min || value > max) {
            return BridgeHttpResult(400, "Bad Request", BridgeHttpJson.error("$label out of range"))
        }
        if (sink == null) {
            return BridgeHttpResult(
                501,
                "Not Implemented",
                BridgeHttpJson.error("$label is not supported"),
            )
        }
        sink.invoke(value)
        return BridgeHttpResult(200, "OK", BridgeHttpJson.accepted(value))
    }

    private fun parseRequestedInt(body: String): Int? {
        val match = Regex("\"value\"\\s*:\\s*(-?\\d+)").find(body) ?: return null
        return match.groupValues[1].toIntOrNull()
    }
}
