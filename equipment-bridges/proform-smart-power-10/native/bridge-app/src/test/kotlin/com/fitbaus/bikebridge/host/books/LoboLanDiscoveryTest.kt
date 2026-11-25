package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class LoboLanDiscoveryTest {
    @Test
    fun acceptsCompatiblePrivateIpv4Advertisements() {
        val device = LoboLanDevice.fromRecord("LOBO-17AE84", "_lobo._tcp.", "192.168.1.200", 7869, "1", "/v1")
        assertEquals("LOBO-17AE84", device?.name)
        assertEquals("192.168.1.200:7869", device?.address)
        assertEquals("https://192.168.1.200:7869/v1", device?.endpoint)
        assertEquals("https://10.0.0.2:7869/v1",
            LoboLanDevice.fromRecord("LOBO-8207D3 (2)", "_lobo._tcp", "10.0.0.2", 7869, null, null)?.endpoint)
    }

    @Test
    fun rejectsWrongServiceAndIncompatibleEndpoints() {
        fun record(name: String = "LOBO-AFA1AE", type: String = "_lobo._tcp.", ip: String = "172.16.0.2",
                   port: Int = 7869, proto: String? = "1", path: String? = "/v1") =
            LoboLanDevice.fromRecord(name, type, ip, port, proto, path)
        assertNull(record(name = "Other"))
        assertNull(record(type = "_http._tcp."))
        assertNull(record(port = 443))
        assertNull(record(proto = "2"))
        assertNull(record(path = "/other"))
        for (ip in listOf("127.0.0.1", "169.254.1.2", "8.8.8.8", "172.32.1.2", "192.168.01.1",
            "192.168.1.256", "::1", "host.local")) assertNull(record(ip = ip))
    }
}
