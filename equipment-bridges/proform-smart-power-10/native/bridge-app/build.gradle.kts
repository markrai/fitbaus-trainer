import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val bridgeIdentity: String = (findProperty("bridgeIdentity") as String?) ?: "staging"
require(bridgeIdentity == "staging" || bridgeIdentity == "production") {
    "bridgeIdentity must be staging or production, was $bridgeIdentity"
}
val isProduction = bridgeIdentity == "production"

val unlockQualification = (findProperty("unlockQualification") as String?) ?: "off"
require(unlockQualification == "off" || unlockQualification == "auth" || unlockQualification == "lockout") {
    "unlockQualification must be off, auth, or lockout, was $unlockQualification"
}
require(!isProduction || unlockQualification == "off") {
    "unlockQualification=$unlockQualification cannot be combined with bridgeIdentity=production. " +
        "Staging-only qualification flags cannot be combined with production; " +
        "production authenticates when DeviceInfo requires unlock."
}

require(!isProduction) { "Temporary showcase branch cannot build production APKs" }

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun signingValue(key: String): String? =
    (findProperty(key) as String?) ?: localProperties.getProperty(key)

abstract class NoticeAssetsTask : DefaultTask() {
    @get:InputFiles
    abstract val sources: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val out = outputDir.get().asFile
        out.deleteRecursively()
        val licenses = File(out, "licenses")
        licenses.mkdirs()
        sources.files.forEach { file ->
            val target = if (file.name == "NOTICE") File(out, "NOTICE") else File(licenses, file.name)
            file.copyTo(target, overwrite = true)
        }
    }
}

abstract class OfflineVoiceModelTask : DefaultTask() {
    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    private fun checksum(file: File): String {
        val hash = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                hash.update(buffer, 0, count)
            }
        }
        return hash.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    @TaskAction
    fun prepare() {
        val model = outputDir.get().asFile.resolve("speech/vosk-model-small-en-us-0.15.zip")
        val expected = "30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498"
        if (model.isFile && checksum(model) == expected) return
        model.parentFile.mkdirs()
        val partial = File(model.parentFile, model.name + ".part")
        partial.delete()
        try {
            val connection = URI("https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip").toURL().openConnection()
            connection.connectTimeout = 30_000
            connection.readTimeout = 120_000
            connection.getInputStream().use { input ->
                partial.outputStream().buffered().use { output -> input.copyTo(output) }
            }
            check(checksum(partial) == expected) { "Pinned Vosk English model checksum mismatch" }
            Files.move(partial.toPath(), model.toPath(), StandardCopyOption.REPLACE_EXISTING)
        } finally {
            partial.delete()
        }
    }
}

val offlineVoiceModel = tasks.register<OfflineVoiceModelTask>("offlineVoiceModel") {
    outputDir.set(layout.buildDirectory.dir("generated/offline-voice-assets"))
}

val noticeAssets = tasks.register<NoticeAssetsTask>("noticeAssets") {
    sources.from(rootProject.file("equipment-protocol/NOTICE"))
    sources.from(rootProject.fileTree("equipment-protocol/licenses"))
    sources.from(rootProject.file("../../../LICENSE"))
    sources.from(file("third-party/YOUTUBE-NOTICE"))
    sources.from(file("third-party/SPEECH-NOTICE"))
    sources.from(fileTree("third-party/licenses"))
    outputDir.set(layout.buildDirectory.dir("generated/notice-assets"))
}

android {
    namespace = "com.fitbaus.bikebridge.host"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.fitbaus.bikebridge.showcase"
        minSdk = 22
        targetSdk = 34
        ndk { abiFilters += setOf("x86") }
        versionCode = rootProject.extra["fitbausVersionCode"] as Int
        versionName = rootProject.extra["fitbausVersionName"] as String
        resValue("string", "app_name", "FitBaus Showcase")
        buildConfigField("String", "UNLOCK_QUALIFICATION", "\"$unlockQualification\"")
        buildConfigField("boolean", "PRODUCTION_IDENTITY", "$isProduction")
        val qualificationApplicationId =
            "com.fitbaus.bikebridge.showcase"
        buildConfigField(
            "String",
            "QUALIFICATION_IDENTITY",
            "\"fitbaus.applicationId=$qualificationApplicationId;fitbaus.unlockQualification=$unlockQualification\"",
        )
    }

    buildFeatures {
        buildConfig = true
    }

    androidResources {
        noCompress += "zip"
    }

    signingConfigs {
        getByName("debug") {
            enableV1Signing = true
            enableV2Signing = true
        }
        if (isProduction) {
            create("production") {
                val storePath = signingValue("bikebridge.signing.storeFile")
                    ?: error("bikebridge.signing.storeFile is required for bridgeIdentity=production")
                storeFile = file(storePath)
                storePassword = signingValue("bikebridge.signing.storePassword")
                    ?: error("bikebridge.signing.storePassword is required for bridgeIdentity=production")
                keyAlias = signingValue("bikebridge.signing.keyAlias")
                    ?: error("bikebridge.signing.keyAlias is required for bridgeIdentity=production")
                keyPassword = signingValue("bikebridge.signing.keyPassword")
                    ?: error("bikebridge.signing.keyPassword is required for bridgeIdentity=production")
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            if (isProduction) signingConfig = signingConfigs.getByName("production")
        }
        getByName("release") {
            isMinifyEnabled = false
            if (isProduction) signingConfig = signingConfigs.getByName("production")
        }
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
        variant.sources.assets?.addGeneratedSourceDirectory(noticeAssets, NoticeAssetsTask::outputDir)
        variant.sources.assets?.addGeneratedSourceDirectory(offlineVoiceModel, OfflineVoiceModelTask::outputDir)
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    implementation(project(":equipment-protocol"))
    implementation(project(":arcade"))
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.0.2")
    implementation("com.github.SkyTubeTeam:NewPipeExtractor:skytube-2026-10-24")
    implementation("com.google.android.exoplayer:exoplayer-core:2.19.1")
    implementation("com.google.android.exoplayer:exoplayer-dash:2.19.1")
    implementation("com.google.android.exoplayer:exoplayer-hls:2.19.1")
    implementation("androidx.annotation:annotation:1.3.0")
    implementation("com.google.guava:guava:31.1-android")
    implementation("com.google.zxing:core:3.5.3")
    implementation("net.java.dev.jna:jna:5.18.1@aar")
    implementation("com.alphacephei:vosk-android:0.3.75@aar")
    testImplementation("org.json:json:20240303")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.1")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.10.1")
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}

tasks.register("printFitbausVersion") {
    doLast {
        println("FITBAUS_VERSION_NAME=${android.defaultConfig.versionName}")
        println("FITBAUS_VERSION_CODE=${android.defaultConfig.versionCode}")
        println("FITBAUS_APPLICATION_ID=${android.defaultConfig.applicationId}")
        println("FITBAUS_MIN_SDK=${android.defaultConfig.minSdk}")
        println("FITBAUS_TARGET_SDK=${android.defaultConfig.targetSdk}")
    }
}
