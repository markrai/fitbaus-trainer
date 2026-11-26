// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

internal class NativeUsbWorkerOwnership {
    private var owner: Thread? = null

    @Synchronized
    fun tryStart(thread: Thread, prepare: () -> Unit): Boolean {
        if (owner?.isAlive == true) return false
        prepare()
        thread.start()
        owner = thread
        return true
    }

    companion object {
        val process = NativeUsbWorkerOwnership()
    }
}
