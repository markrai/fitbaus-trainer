import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.ZipFile
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val arcadeAbis: List<String> = ((findProperty("arcade.abis") as String?) ?: "x86").split(",").map { it.trim() }.filter { it.isNotEmpty() }
val tfliteVersion: String = (findProperty("arcade.tfliteVersion") as String?) ?: "2.16.1"
val maxRuntimeApi = 22

abstract class TfliteNativeTask : DefaultTask() {
    @get:InputFiles
    abstract val aar: ConfigurableFileCollection

    @get:Input
    abstract val abis: ListProperty<String>

    @get:Input
    abstract val maxApi: Property<Int>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun extract() {
        val out = outputDir.get().asFile
        out.deleteRecursively()
        val archive = ZipFile(aar.singleFile)
        archive.use { zip ->
            for (abi in abis.get()) {
                val entry = zip.getEntry("jni/$abi/libtensorflowlite_jni.so")
                    ?: throw GradleException("TFLite AAR has no $abi runtime")
                val bytes = zip.getInputStream(entry).use { it.readBytes() }
                verify(abi, bytes)
                val target = File(out, "$abi/libtensorflowlite_jni.so")
                target.parentFile.mkdirs()
                target.writeBytes(bytes)
            }
        }
    }

    private fun verify(abi: String, bytes: ByteArray) {
        val text = String(bytes, Charsets.ISO_8859_1)
        for (newer in listOf("LIBC_N\u0000", "LIBC_O\u0000", "LIBC_P\u0000", "LIBC_Q\u0000", "LIBC_R\u0000")) {
            if (text.contains(newer)) throw GradleException("$abi TFLite runtime needs ${newer.trim('\u0000')} symbols newer than API ${maxApi.get()}")
        }
        val marker = text.indexOf("Android\u0000")
        if (marker < 12) throw GradleException("$abi TFLite runtime has no Android API note")
        val buffer = ByteBuffer.wrap(bytes, marker + 8, 4).order(ByteOrder.LITTLE_ENDIAN)
        val api = buffer.int
        if (api > maxApi.get()) throw GradleException("$abi TFLite runtime targets API $api, above ${maxApi.get()}")
    }
}

val tfliteAar: Configuration by configurations.creating {
    isCanBeConsumed = false
    isTransitive = false
}

dependencies {
    tfliteAar("org.tensorflow:tensorflow-lite:$tfliteVersion@aar")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.1")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.10.1")
}

val tfliteNative = tasks.register<TfliteNativeTask>("tfliteNative") {
    aar.from(tfliteAar)
    abis.set(arcadeAbis)
    maxApi.set(maxRuntimeApi)
    outputDir.set(layout.buildDirectory.dir("generated/tflite-jni"))
}

android {
    namespace = "com.fitbaus.arcade"
    compileSdk = 34
    ndkVersion = "26.1.10909125"

    defaultConfig {
        minSdk = 22
        ndk {
            abiFilters += arcadeAbis
        }
        externalNativeBuild {
            cmake {
                arguments += "-DANDROID_STL=none"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = false
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.jniLibs?.addGeneratedSourceDirectory(tfliteNative, TfliteNativeTask::outputDir)
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_1_8)
        allWarningsAsErrors.set(true)
    }
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}

// Host-side deterministic fixtures for YUYV→NV21 (no Android device required).
val yuyvNv21HostTest by tasks.registering {
    val outDir = layout.buildDirectory.dir("yuyv-nv21-host-test")
    val isWindows = System.getProperty("os.name").startsWith("Windows", ignoreCase = true)
    val exeName = if (isWindows) "yuyv_nv21_test.exe" else "yuyv_nv21_test"
    val exe = outDir.map { it.file(exeName) }
    inputs.files(
        "src/main/cpp/yuyv_nv21.c",
        "src/main/cpp/yuyv_nv21.h",
        "src/test/cpp/yuyv_nv21_test.c",
    )
    outputs.file(exe)
    doLast {
        val out = outDir.get().asFile
        out.mkdirs()
        val binary = File(out, exeName)
        fun resolveCc(name: String): String? {
            val probe = if (isWindows) listOf("where.exe", name) else listOf("which", name)
            val proc = ProcessBuilder(probe).redirectErrorStream(true).start()
            val text = proc.inputStream.bufferedReader().readText().trim()
            return if (proc.waitFor() == 0 && text.isNotEmpty()) text.lineSequence().first() else null
        }
        val cc = sequenceOf("clang", "gcc", "cl").mapNotNull(::resolveCc).firstOrNull()
            ?: throw GradleException("No host C compiler (clang/gcc/cl) found for yuyv_nv21_test")
        val include = file("src/main/cpp").absolutePath
        val srcs = listOf(
            file("src/main/cpp/yuyv_nv21.c").absolutePath,
            file("src/test/cpp/yuyv_nv21_test.c").absolutePath,
        )
        val compile = if (File(cc).name.startsWith("cl")) {
            listOf(cc, "/nologo", "/W3", "/Fe${binary.absolutePath}", "/I$include") + srcs
        } else {
            listOf(cc, "-O2", "-Wall", "-Wextra", "-Werror", "-o", binary.absolutePath, "-I$include") + srcs
        }
        exec {
            commandLine(compile)
        }
        exec {
            commandLine(binary.absolutePath)
        }
    }
}

val uvcNegotiateHostTest by tasks.registering {
    val outDir = layout.buildDirectory.dir("uvc-negotiate-host-test")
    val isWindows = System.getProperty("os.name").startsWith("Windows", ignoreCase = true)
    val exeName = if (isWindows) "uvc_negotiate_test.exe" else "uvc_negotiate_test"
    val exe = outDir.map { it.file(exeName) }
    inputs.files(
        "src/main/cpp/uvc_negotiate.c",
        "src/main/cpp/uvc_negotiate.h",
        "src/test/cpp/uvc_negotiate_test.c",
    )
    outputs.file(exe)
    doLast {
        val out = outDir.get().asFile
        out.mkdirs()
        val binary = File(out, exeName)
        fun resolveCc(name: String): String? {
            val probe = if (isWindows) listOf("where.exe", name) else listOf("which", name)
            val proc = ProcessBuilder(probe).redirectErrorStream(true).start()
            val text = proc.inputStream.bufferedReader().readText().trim()
            return if (proc.waitFor() == 0 && text.isNotEmpty()) text.lineSequence().first() else null
        }
        val cc = sequenceOf("clang", "gcc", "cl").mapNotNull(::resolveCc).firstOrNull()
            ?: throw GradleException("No host C compiler found for uvc_negotiate_test")
        val include = file("src/main/cpp").absolutePath
        val srcs = listOf(
            file("src/main/cpp/uvc_negotiate.c").absolutePath,
            file("src/test/cpp/uvc_negotiate_test.c").absolutePath,
        )
        val compile = if (File(cc).name.startsWith("cl")) {
            listOf(cc, "/nologo", "/W3", "/Fe${binary.absolutePath}", "/I$include") + srcs
        } else {
            listOf(cc, "-O2", "-Wall", "-Wextra", "-Werror", "-o", binary.absolutePath, "-I$include") + srcs
        }
        exec {
            commandLine(compile)
        }
        exec {
            commandLine(binary.absolutePath)
        }
    }
}

tasks.named("check") {
    dependsOn(yuyvNv21HostTest)
    dependsOn(uvcNegotiateHostTest)
}
