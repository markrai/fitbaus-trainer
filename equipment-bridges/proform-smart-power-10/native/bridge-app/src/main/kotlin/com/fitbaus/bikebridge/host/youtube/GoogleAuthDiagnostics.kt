// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.json.JSONException
import org.json.JSONObject
import java.io.IOException

internal enum class GoogleAuthStage(val label: String) {
    DeviceCode("device-code request"),
    TokenPoll("token polling"),
    TokenRefresh("token refresh"),
    AccountBrowse("account browsing"),
}

internal class GoogleOAuthHttpFailure(
    val stage: GoogleAuthStage,
    val httpStatus: Int,
    rawCode: String,
) : IOException() {
    val oauthError: String = GoogleAuthDiagnostics.allowedCode(rawCode)
}

internal enum class GoogleCredentialFailurePoint(val label: String) {
    Missing("stored credentials missing"),
    Keystore("Android Keystore key access"),
    RsaUnwrap("RSA key unwrapping"),
    RsaWrap("RSA key wrapping"),
    AesDecrypt("AES-GCM decryption"),
    AesEncrypt("AES-GCM encryption"),
    Persistence("credential persistence"),
    Verification("credential round-trip verification"),
    Unknown("credential retrieval"),
}

internal class GoogleCredentialStorageFailure(
    val point: GoogleCredentialFailurePoint = GoogleCredentialFailurePoint.Unknown,
) : IOException()

internal class GoogleResponseFormatFailure : IOException()

internal object GoogleAuthDiagnostics {
    private val knownErrors = setOf(
        "authorization_pending", "slow_down",
        "invalid_client", "invalid_request", "invalid_grant", "invalid_scope",
        "unauthorized_client", "unsupported_grant_type", "access_denied",
        "expired_token", "admin_policy_enforced", "org_internal",
        "rate_limit_exceeded", "quota_exceeded", "temporarily_unavailable",
    )

    fun allowedCode(value: String): String =
        if (value in knownErrors) value else "unrecognized_error"

    fun oauthCode(body: String): String {
        val json = runCatching { JSONObject(body) }.getOrNull() ?: return "unrecognized_error"
        val code = json.optString("error").takeIf { it.isNotBlank() }
            ?: json.optString("error_code")
        return allowedCode(code)
    }

    fun message(stage: GoogleAuthStage, failure: Throwable): String = when (failure) {
        is GoogleOAuthHttpFailure -> {
            val status = failure.httpStatus.coerceIn(0, 599)
            "Google rejected ${stage.label}: ${failure.oauthError} (HTTP $status). ${advice(failure.oauthError)}"
        }
        is GoogleCredentialStorageFailure ->
            "FitBaus credential storage failed at ${failure.point.label}. Google sign-in was not completed. Re-import the same TV OAuth JSON without clearing app data."
        is GoogleResponseFormatFailure, is JSONException ->
            "Google returned an unexpected response during ${stage.label}. The app could not parse it."
        is GoogleReauthorizationRequired ->
            "Google authorization is no longer available. Start sign-in again."
        is IOException ->
            "Network or TLS error during ${stage.label}. Check the bike's internet connection and date/time."
        else ->
            "FitBaus encountered a local error during ${stage.label}. Retry sign-in."
    }

    private fun advice(code: String): String = when (code) {
        "invalid_client" ->
            "Verify that your TV OAuth client ID and secret match the same Google Cloud client."
        "invalid_grant", "expired_token" ->
            "Start sign-in again to obtain a fresh device code."
        "unauthorized_client" ->
            "Use an OAuth client of type TVs and Limited Input devices."
        "unsupported_grant_type" ->
            "The token request was rejected; check the OAuth device-flow implementation."
        "invalid_scope" ->
            "Verify YouTube Data API v3 and the youtube.readonly scope in Google Cloud."
        "org_internal", "admin_policy_enforced" ->
            "Check your Google Auth Platform audience and Workspace access policies."
        "access_denied" ->
            "Confirm that the selected Google account is allowed to authorize the app."
        "rate_limit_exceeded", "quota_exceeded", "temporarily_unavailable" ->
            "Retry later, without repeatedly restarting authorization."
        else -> "Check the Google Cloud OAuth client configuration and try again."
    }
}
