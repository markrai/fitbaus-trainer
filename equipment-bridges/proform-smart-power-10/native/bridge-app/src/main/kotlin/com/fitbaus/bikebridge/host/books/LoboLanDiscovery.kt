package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import java.net.Inet4Address
import java.util.Locale

internal data class LoboLanDevice(val name: String, val address: String) {
    val endpoint: String get() = "https://$address/v1"

    companion object {
        const val SERVICE_TYPE = "_lobo._tcp."
        private val namePattern = Regex("LOBO-[0-9A-F]{6}(?: \\([0-9]{1,5}\\))?")

        fun fromRecord(name: String, type: String, ipv4: String, port: Int,
                       protocol: String?, path: String?): LoboLanDevice? {
            if (!namePattern.matches(name) ||
                type.trimEnd('.').lowercase(Locale.US) != SERVICE_TYPE.trimEnd('.') ||
                port != 7869 || (protocol != null && protocol != "1") ||
                (path != null && path != "/v1")) return null
            val parts = ipv4.split('.')
            if (parts.size != 4 || parts.any { it.isEmpty() || it.length > 3 || it.any { c -> c !in '0'..'9' } }) return null
            val octets = parts.map { it.toInt() }
            if (octets.any { it !in 0..255 } || ipv4 != octets.joinToString(".")) return null
            if (!(octets[0] == 10 || octets[0] == 172 && octets[1] in 16..31 ||
                    octets[0] == 192 && octets[1] == 168)) return null
            return LoboLanDevice(name, "$ipv4:$port")
        }
    }
}

@Suppress("DEPRECATION")
internal class LoboLanDiscovery(context: Context) {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager
    private val main = Handler(Looper.getMainLooper())
    private var scan: Scan? = null
    private var resolving = false

    private class Scan(val update: (List<LoboLanDevice>, Boolean, Boolean) -> Unit) {
        lateinit var listener: NsdManager.DiscoveryListener
        val pending = linkedMapOf<String, NsdServiceInfo>()
        val devices = linkedMapOf<String, LoboLanDevice>()
        val seen = mutableSetOf<String>()
        var started = false
        var stopped = false
        lateinit var timeout: Runnable
    }

    fun start(update: (List<LoboLanDevice>, Boolean, Boolean) -> Unit) {
        stop()
        val manager = nsd
        if (manager == null) {
            update(emptyList(), false, true)
            return
        }
        val session = Scan(update)
        scan = session
        session.timeout = Runnable { finish(session, false) }
        session.listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                main.post {
                    session.started = true
                    if (session.stopped) stopListener(session)
                }
            }

            override fun onServiceFound(service: NsdServiceInfo) {
                main.post {
                    if (scan !== session || session.stopped || session.seen.size >= 32) return@post
                    val name = service.serviceName ?: return@post
                    if (!name.startsWith("LOBO-") || !session.seen.add(name)) return@post
                    session.pending[name] = service
                    resolveNext()
                }
            }

            override fun onServiceLost(service: NsdServiceInfo) {
                main.post {
                    if (scan !== session || session.stopped) return@post
                    val name = service.serviceName ?: return@post
                    session.pending.remove(name)
                    session.devices.remove(name)
                    session.seen.remove(name)
                    publish(session, true, false)
                }
            }

            override fun onDiscoveryStopped(serviceType: String) {
                main.post { if (scan === session && !session.stopped) finish(session, false) }
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                main.post { finish(session, true) }
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                main.post { if (scan === session && !session.stopped) finish(session, true) }
            }
        }
        main.postDelayed(session.timeout, 8_000)
        publish(session, true, false)
        try {
            manager.discoverServices(LoboLanDevice.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, session.listener)
        } catch (_: RuntimeException) {
            finish(session, true)
        }
    }

    private fun resolveNext() {
        val manager = nsd ?: return
        val session = scan ?: return
        if (session.stopped || resolving) return
        val entry = session.pending.entries.firstOrNull() ?: return
        val name = entry.key
        val service = entry.value
        session.pending.remove(name)
        resolving = true
        fun complete(device: LoboLanDevice?) {
            main.post {
                resolving = false
                if (scan === session && !session.stopped && name in session.seen && device != null) {
                    session.devices[name] = device
                    publish(session, true, false)
                }
                resolveNext()
            }
        }
        try {
            manager.resolveService(service, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = complete(null)

                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    val host = serviceInfo.host as? Inet4Address
                    val attributes = serviceInfo.attributes
                    val device = host?.hostAddress?.let {
                        LoboLanDevice.fromRecord(name, serviceInfo.serviceType ?: LoboLanDevice.SERVICE_TYPE,
                            it, serviceInfo.port, attributes["proto"]?.toString(Charsets.UTF_8),
                            attributes["path"]?.toString(Charsets.UTF_8))
                    }
                    complete(device)
                }
            })
        } catch (_: RuntimeException) {
            complete(null)
        }
    }

    private fun publish(session: Scan, scanning: Boolean, failed: Boolean) {
        session.update(session.devices.values.distinctBy { it.address }.sortedBy { it.name }, scanning, failed)
    }

    private fun finish(session: Scan, failed: Boolean) {
        if (scan !== session || session.stopped) return
        session.stopped = true
        main.removeCallbacks(session.timeout)
        session.pending.clear()
        if (session.started) stopListener(session)
        publish(session, false, failed)
    }

    private fun stopListener(session: Scan) {
        try {
            nsd?.stopServiceDiscovery(session.listener)
        } catch (_: RuntimeException) {
            Unit
        }
    }

    fun stop() {
        val session = scan ?: return
        scan = null
        main.removeCallbacks(session.timeout)
        session.pending.clear()
        if (!session.stopped) {
            session.stopped = true
            if (session.started) stopListener(session)
        }
    }
}
