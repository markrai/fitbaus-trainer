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

val noticeAssets = tasks.register<NoticeAssetsTask>("noticeAssets") {
    sources.from(rootProject.file("equipment-protocol/NOTICE"))
    sources.from(rootProject.fileTree("equipment-protocol/licenses"))
    sources.from(rootProject.file("../../../LICENSE"))
    outputDir.set(layout.buildDirectory.dir("generated/notice-assets"))
}

android {
    namespace = "com.fitbaus.bikebridge.host"
    compileSdk = 34

    defaultConfig {
        applicationId = if (isProduction) "com.fitbaus.bikebridge" else "com.fitbaus.bikebridge.native"
        minSdk = 22
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"
        resValue("string", "app_name", if (isProduction) "FitBaus Bike Bridge" else "FitBaus Bike Bridge Native")
        buildConfigField("String", "UNLOCK_QUALIFICATION", "\"$unlockQualification\"")
        buildConfigField("boolean", "PRODUCTION_IDENTITY", "$isProduction")
        val qualificationApplicationId =
            if (isProduction) "com.fitbaus.bikebridge" else "com.fitbaus.bikebridge.native"
        buildConfigField(
            "String",
            "QUALIFICATION_IDENTITY",
            "\"fitbaus.applicationId=$qualificationApplicationId;fitbaus.unlockQualification=$unlockQualification\"",
        )
    }

    buildFeatures {
        buildConfig = true
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
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
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
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_1_8)
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    implementation(project(":equipment-protocol"))
    implementation(project(":arcade"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.1")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.10.1")
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}
