// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        Log.i(HostConstants.LOG_TAG, "boot completed; starting bridge service")
        NativeBridgeService.markBootStart()
        val service = Intent(context, NativeBridgeService::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            context.startForegroundService(service)
        } else {
            context.startService(service)
        }
        val activity = Intent(context, NativeBridgeActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(activity)
        } catch (ex: Exception) {
            Log.w(HostConstants.LOG_TAG, "boot activity launch failed: ${ex.message}")
        }
    }
}
