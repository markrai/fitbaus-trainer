package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.util.Log
import android.os.Handler
import android.os.Looper
import java.net.Inet4Address
import java.util.Locale

internal data class LoboLanDevice(val name: String, val address: String) {
    val endpoint: String get() = "https://$address/v1"

    companion object {
        const val SERVICE_TYPE = "_lobo._tcp."
        private val namePattern = Regex("LOBO-[0-9A-F]{6}(?: \\([0-9]{1,5}\\))?")

        fun compatibleType(type: String): Boolean =
            type.trim('.').lowercase(Locale.US).removeSuffix(".local") == SERVICE_TYPE.trimEnd('.')

        fun fromRecord(name: String, type: String, ipv4: String, port: Int,
                       protocol: String?, path: String?): LoboLanDevice? {
            if (!namePattern.matches(name) ||
                !compatibleType(type) ||
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
    private val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
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
        var multicastLock: WifiManager.MulticastLock? = null
        var found = 0
        var resolved = 0
        var rejected = 0
        var resolveFailures = 0
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
        try {
            session.multicastLock = wifi?.createMulticastLock("FitBausLoboDiscovery")?.apply {
                setReferenceCounted(false)
                acquire()
            }
            Log.d(TAG, "Multicast lock held=${session.multicastLock?.isHeld == true}")
        } catch (_: RuntimeException) {
            Log.w(TAG, "Unable to acquire Wi-Fi multicast lock; continuing with NSD")
        }
        session.listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                main.post {
                    session.started = true
                    Log.d(TAG, "DNS-SD browse started")
                    if (session.stopped) stopListener(session)
                }
            }

            override fun onServiceFound(service: NsdServiceInfo) {
                main.post {
                    if (scan !== session || session.stopped || session.seen.size >= 32) return@post
                    session.found++
                    val name = service.serviceName ?: return@post
                    if (!name.startsWith("LOBO-") || !session.seen.add(name)) return@post
                    session.pending[name] = service
                    Log.d(TAG, "LOBO advertisement found; resolving")
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
                main.post {
                    Log.w(TAG, "DNS-SD start failed: $errorCode")
                    finish(session, true)
                }
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                main.post {
                    Log.w(TAG, "DNS-SD stop failed: $errorCode")
                    if (scan === session && !session.stopped) finish(session, true)
                }
            }
        }
        main.postDelayed(session.timeout, 15_000)
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
        fun complete(device: LoboLanDevice?, failureCode: Int? = null) {
            main.post {
                resolving = false
                if (scan === session && !session.stopped) {
                    if (failureCode != null) {
                        session.resolveFailures++
                        Log.d(TAG, "NSD resolution failed: $failureCode")
                    } else if (device == null) {
                        session.rejected++
                        Log.d(TAG, "Resolved advertisement had incompatible address or service metadata")
                    } else {
                        session.resolved++
                        if (name in session.seen) {
                            session.devices[name] = device
                            publish(session, true, false)
                        }
                    }
                }
                resolveNext()
            }
        }
        try {
            manager.resolveService(service, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = complete(null, errorCode)

                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    val host = serviceInfo.host as? Inet4Address
                    val attributes = serviceInfo.attributes
                    val type = serviceInfo.serviceType ?: LoboLanDevice.SERVICE_TYPE
                    Log.d(TAG, "NSD resolved: compatibleType=${LoboLanDevice.compatibleType(type)}, ipv4=${host != null}, port=${serviceInfo.port}")
                    val device = host?.hostAddress?.let {
                        LoboLanDevice.fromRecord(name, type,
                            it, serviceInfo.port, attributes["proto"]?.toString(Charsets.UTF_8),
                            attributes["path"]?.toString(Charsets.UTF_8))
                    }
                    complete(device)
                }
            })
        } catch (_: RuntimeException) {
            complete(null, -1)
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
        releaseMulticast(session)
        Log.d(TAG, "Browse complete: found=${session.found}, resolved=${session.resolved}, rejected=${session.rejected}, resolveFailures=${session.resolveFailures}, devices=${session.devices.size}")
        publish(session, false, failed)
    }

    private fun stopListener(session: Scan) {
        try {
            nsd?.stopServiceDiscovery(session.listener)
        } catch (_: RuntimeException) {
            Unit
        }
    }

    private fun releaseMulticast(session: Scan) {
        val lock = session.multicastLock
        session.multicastLock = null
        try {
            if (lock?.isHeld == true) lock.release()
        } catch (_: RuntimeException) {
            Log.w(TAG, "Unable to release multicast lock")
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
        releaseMulticast(session)
    }

    private companion object {
        const val TAG = "FitBausLoboDiscovery"
    }
}
