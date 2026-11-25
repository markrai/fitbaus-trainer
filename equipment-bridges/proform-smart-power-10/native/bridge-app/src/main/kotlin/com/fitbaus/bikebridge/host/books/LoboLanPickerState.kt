package com.fitbaus.bikebridge.host.books

internal class LoboLanPickerState {
    private val advertised = linkedMapOf<String, LoboLanDevice>()
    val devices: List<LoboLanDevice> get() = advertised.values.toList()
    var selected: LoboLanDevice? = null
        private set

    fun update(devices: List<LoboLanDevice>) {
        advertised.clear()
        devices.forEach { if (it.address !in advertised) advertised[it.address] = it }
    }

    fun isAvailable(address: String): Boolean = address in advertised

    fun rows(): List<LoboLanDevice> {
        val picked = selected ?: return devices
        return if (isAvailable(picked.address)) devices else devices + picked
    }

    fun select(address: String): LoboLanDevice? {
        val candidate = advertised[address] ?: selected?.takeIf { it.address == address } ?: return null
        selected = candidate
        return candidate
    }

    fun clearSelection() { selected = null }

    fun reset() {
        advertised.clear()
        clearSelection()
    }
}
