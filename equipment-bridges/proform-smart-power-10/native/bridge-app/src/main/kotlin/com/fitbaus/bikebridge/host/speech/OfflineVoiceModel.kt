package com.fitbaus.bikebridge.host.speech

import android.content.Context
import android.os.StatFs
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.zip.ZipInputStream

internal object OfflineVoiceModel {
    private const val SOURCE = "speech/vosk-model-small-en-us-0.15.zip"
    private const val PREFIX = "vosk-model-small-en-us-0.15/"
    private const val DIRECTORY = "speech-model-vosk-en-0.15"
    private const val MAX_ENTRIES = 512
    private const val MAX_EXPANDED = 256L * 1024L * 1024L
    private const val MIN_FREE_BYTES = 200L * 1024L * 1024L

    fun ensure(context: Context): File {
        val model = File(context.filesDir, DIRECTORY)
        if (isComplete(model)) return model
        val available = StatFs(context.filesDir.absolutePath).availableBytes
        if (available < MIN_FREE_BYTES) throw IOException("Insufficient device storage for offline speech model")
        val staged = File(context.filesDir, "$DIRECTORY.partial")
        staged.deleteRecursively()
        if (!staged.mkdirs()) throw IOException("Cannot prepare speech model storage")
        try {
            ZipInputStream(context.assets.open(SOURCE).buffered()).use { archive ->
                var count = 0
                var expanded = 0L
                val root = staged.canonicalPath + File.separator
                while (true) {
                    val entry = archive.nextEntry ?: break
                    count++
                    if (count > MAX_ENTRIES) throw IOException("Speech model archive contains too many entries")
                    if (entry.name == PREFIX.removeSuffix("/") && entry.isDirectory) continue
                    if (!entry.name.startsWith(PREFIX)) throw IOException("Unexpected speech model archive structure")
                    val relative = entry.name.removePrefix(PREFIX)
                    if (relative.isBlank()) continue
                    val target = File(staged, relative)
                    if (!target.canonicalPath.startsWith(root)) throw IOException("Unsafe speech model archive path")
                    if (entry.isDirectory) {
                        if (!target.isDirectory && !target.mkdirs()) throw IOException("Cannot create speech model directory")
                    } else {
                        val parent = target.parentFile ?: throw IOException("Invalid speech model path")
                        if (!parent.isDirectory && !parent.mkdirs()) throw IOException("Cannot create speech model path")
                        FileOutputStream(target).use { output ->
                            val buffer = ByteArray(32 * 1024)
                            while (true) {
                                val read = archive.read(buffer)
                                if (read < 0) break
                                expanded += read
                                if (expanded > MAX_EXPANDED) throw IOException("Speech model archive exceeds size limit")
                                output.write(buffer, 0, read)
                            }
                        }
                    }
                    archive.closeEntry()
                }
            }
            if (!File(staged, "am/final.mdl").isFile || !File(staged, "conf/model.conf").isFile) {
                throw IOException("Speech model is missing required files")
            }
            if (!File(staged, ".ready").createNewFile()) throw IOException("Cannot mark speech model ready")
            model.deleteRecursively()
            if (!staged.renameTo(model)) throw IOException("Cannot activate speech model")
            return model
        } finally {
            staged.deleteRecursively()
        }
    }

    private fun isComplete(path: File): Boolean =
        File(path, ".ready").isFile &&
        File(path, "am/final.mdl").isFile &&
        File(path, "conf/model.conf").isFile
}
