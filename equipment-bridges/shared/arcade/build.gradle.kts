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
