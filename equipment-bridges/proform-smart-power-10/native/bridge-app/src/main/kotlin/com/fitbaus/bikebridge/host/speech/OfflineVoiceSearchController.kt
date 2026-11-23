package com.fitbaus.bikebridge.host.speech

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.RemoteException
import android.content.ServiceConnection

internal class OfflineVoiceSearchController(
    private val activity: Activity,
    private val onStatus: (String?, Boolean) -> Unit,
    private val onTranscript: (String) -> Unit,
    private val onFailure: (String) -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private var connection: ServiceConnection? = null
    private var service: Messenger? = null
    private var requestId = 0
    private var active = false
    private var watchdog: Runnable? = null
    private val receiver = Messenger(Handler(Looper.getMainLooper()) { message ->
        if (active && message.arg1 == requestId) {
            when (message.what) {
                VoiceSearchProtocol.STATUS -> onStatus(message.data.getString(VoiceSearchProtocol.TEXT), message.arg2 == 1)
                VoiceSearchProtocol.RESULT -> {
                    val transcript = message.data.getString(VoiceSearchProtocol.TEXT)
                    cancel()
                    if (!transcript.isNullOrBlank()) onTranscript(transcript)
                }
                VoiceSearchProtocol.ERROR -> {
                    val detail = message.data.getString(VoiceSearchProtocol.TEXT) ?: "Voice search failed"
                    cancel()
                    onFailure(detail)
                }
            }
        }
        true
    })

    fun toggle() {
        if (active) {
            cancel()
            return
        }
        active = true
        requestId++
        val requested = requestId
        onStatus("Preparing offline voice search…", false)
        val timeout = Runnable {
            if (active && requestId == requested) {
                cancel()
                onFailure("Voice recognition took too long to start.")
            }
        }
        watchdog = timeout
        handler.postDelayed(timeout, VoiceSearchProtocol.INIT_TIMEOUT_MS)
        val hook = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
                if (!active || requestId != requested || binder == null) return
                service = Messenger(binder)
                val message = Message.obtain(null, VoiceSearchProtocol.START, requested, 0)
                message.replyTo = receiver
                try {
                    service?.send(message)
                } catch (_: RemoteException) {
                    fail("Offline voice recognition service disconnected.")
                }
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                service = null
                if (active && requestId == requested) fail("Offline voice recognition stopped unexpectedly.")
            }
        }
        connection = hook
        try {
            if (!activity.bindService(Intent(activity, OfflineVoiceSearchService::class.java), hook, Context.BIND_AUTO_CREATE)) {
                fail("Offline voice recognition service is unavailable.")
            }
        } catch (_: RuntimeException) {
            fail("Could not start offline voice recognition.")
        }
    }

    fun cancel() {
        if (!active) return
        active = false
        requestId++
        watchdog?.let { handler.removeCallbacks(it) }
        watchdog = null
        try {
            service?.send(Message.obtain(null, VoiceSearchProtocol.CANCEL))
        } catch (_: RemoteException) {
        }
        service = null
        connection?.let {
            runCatching { activity.unbindService(it) }
        }
        connection = null
        onStatus(null, false)
    }

    private fun fail(message: String) {
        cancel()
        onFailure(message)
    }
}
