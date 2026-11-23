package com.fitbaus.bikebridge.host.speech

import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.os.RemoteException
import android.util.Log
import java.io.IOException
import java.util.concurrent.Executors
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService

class OfflineVoiceSearchService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "fitbaus-offline-voice") }
    private val incoming = Messenger(Handler(Looper.getMainLooper()) { message ->
        when (message.what) {
            VoiceSearchProtocol.START -> begin(message)
            VoiceSearchProtocol.CANCEL -> cancel()
        }
        true
    })
    private val forceExit = Runnable { Process.killProcess(Process.myPid()) }
    @Volatile private var generation = 0
    @Volatile private var resources: VoiceResources? = null
    private var client: Messenger? = null
    private var requestId = 0
    private var bound = false

    override fun onBind(intent: Intent?): IBinder {
        bound = true
        handler.removeCallbacks(forceExit)
        return incoming.binder
    }

    override fun onUnbind(intent: Intent?): Boolean {
        bound = false
        cancel()
        handler.postDelayed(forceExit, 15_000)
        return false
    }

    override fun onDestroy() {
        handler.removeCallbacks(forceExit)
        worker.shutdownNow()
        super.onDestroy()
        Process.killProcess(Process.myPid())
    }

    private fun begin(message: Message) {
        cancel()
        client = message.replyTo
        requestId = message.arg1
        generation++
        val ticket = generation
        send(ticket, VoiceSearchProtocol.STATUS, "Preparing offline voice search…")
        worker.execute { prepare(ticket) }
    }

    private fun prepare(ticket: Int) {
        var model: Model? = null
        var recognizer: Recognizer? = null
        var speech: SpeechService? = null
        try {
            val directory = OfflineVoiceModel.ensure(this)
            if (ticket != generation) return
            model = Model(directory.absolutePath)
            if (ticket != generation) return
            recognizer = Recognizer(model, VoiceSearchProtocol.SAMPLE_RATE)
            if (ticket != generation) return
            speech = SpeechService(recognizer, VoiceSearchProtocol.SAMPLE_RATE)
            if (ticket != generation) return
            val active = VoiceResources(model, recognizer, speech)
            resources = active
            model = null
            recognizer = null
            speech = null
            if (!active.speech.startListening(listener(ticket), VoiceSearchProtocol.LISTEN_MS)) {
                throw IOException("Unable to start speech capture")
            }
            handler.post { send(ticket, VoiceSearchProtocol.STATUS, "Listening… tap the mic to cancel") }
        } catch (error: Exception) {
            Log.w("FitBausVoice", "Unable to start offline speech recognition", error)
            handler.post { complete(ticket, VoiceSearchProtocol.ERROR, "Offline voice search could not start. Try again.") }
        } finally {
            runCatching { speech?.cancel() }
            runCatching { speech?.shutdown() }
            runCatching { recognizer?.close() }
            runCatching { model?.close() }
        }
    }

    private fun listener(ticket: Int): RecognitionListener = object : RecognitionListener {
        override fun onPartialResult(hypothesis: String) = Unit

        override fun onResult(hypothesis: String) {
            val text = VoiceTranscript.fromResult(hypothesis)
            if (text != null) complete(ticket, VoiceSearchProtocol.RESULT, text)
        }

        override fun onFinalResult(hypothesis: String) {
            val text = VoiceTranscript.fromResult(hypothesis)
            if (text == null) complete(ticket, VoiceSearchProtocol.ERROR, "No speech detected. Try again.")
            else complete(ticket, VoiceSearchProtocol.RESULT, text)
        }

        override fun onError(exception: Exception) {
            Log.w("FitBausVoice", "Offline microphone capture failed", exception)
            complete(ticket, VoiceSearchProtocol.ERROR, "Microphone unavailable. Check that another app is not recording.")
        }

        override fun onTimeout() {
            worker.execute {
                val finalResult = runCatching { resources?.recognizer?.finalResult }.getOrNull()
                val text = finalResult?.let(VoiceTranscript::fromResult)
                handler.post {
                    if (text == null) complete(ticket, VoiceSearchProtocol.ERROR, "No speech detected. Try again.")
                    else complete(ticket, VoiceSearchProtocol.RESULT, text)
                }
            }
        }
    }

    private fun complete(ticket: Int, event: Int, text: String) {
        if (generation != ticket) return
        send(ticket, event, text)
        cancel()
    }

    private fun send(ticket: Int, event: Int, text: String) {
        if (generation != ticket) return
        val response = Message.obtain(null, event, requestId, 0)
        response.data = Bundle().apply { putString(VoiceSearchProtocol.TEXT, text) }
        try {
            client?.send(response)
        } catch (_: RemoteException) {
            cancel()
        }
    }

    private fun cancel() {
        generation++
        client = null
        worker.execute {
            val old = resources
            resources = null
            old?.close()
            handler.post { if (!bound) stopSelf() }
        }
    }

    private class VoiceResources(
        val model: Model,
        val recognizer: Recognizer,
        val speech: SpeechService,
    ) {
        fun close() {
            runCatching { speech.cancel() }
            runCatching { speech.shutdown() }
            runCatching { recognizer.close() }
            runCatching { model.close() }
        }
    }
}
